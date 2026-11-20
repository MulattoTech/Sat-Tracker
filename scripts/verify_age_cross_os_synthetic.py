#!/usr/bin/env python3
"""One-run Linux-to-Windows recovery of the SAME fabricated age ciphertext.

Not a backup adapter. No user-provided paths, archives, keys or credentials.
Only runs inside the approved GitHub Actions synthetic test workflow. All
identity files are explicitly fake, scoped to the current workflow run, and
destroyed with short-lived test artifacts. Never send real keys to Actions.
"""
from __future__ import annotations

import hashlib
import io
import json
import os
from pathlib import Path
import re
import shutil
import stat
import sys
import tempfile

from verify_age_backup_synthetic import (
    MAX_SYNTHETIC_BYTES, QualificationError, _check_archive,
    _fake_snapshot, _recipient, _run,
)

RUNNER_DIRECTORY = "sat-age-cross-os-synthetic"
ARTIFACT_DIRECTORY = "share"
FILE_SET = frozenset((
    "fabricated.age", "owner.txt", "recovery.txt", "stranger.txt",
    "synthetic-manifest.json",
))
MAX_CIPHERTEXT_BYTES = MAX_SYNTHETIC_BYTES + 4096
MAX_IDENTITY_BYTES = 1024
FORMAT_LABEL = "SYNTHETIC_AGE_CROSS_OS_V1"
REPOSITORY = "MulattoTech/Sat-Tracker"


def _sha256(content: bytes) -> str:
    return hashlib.sha256(content).hexdigest()


def workspace(expected_os: str) -> Path:
    """Only allow the precisely named GitHub CI fixture root."""
    if (os.environ.get("GITHUB_ACTIONS") != "true"
            or os.environ.get("GITHUB_REPOSITORY") != REPOSITORY
            or os.environ.get("RUNNER_OS") != expected_os
            or not re.fullmatch(r"[0-9]{1,20}", os.environ.get("GITHUB_RUN_ID", ""))):
        raise QualificationError("ONLY_NAMED_SYNTHETIC_GITHUB_JOB_ALLOWED")
    temp = os.environ.get("RUNNER_TEMP")
    if not temp:
        raise QualificationError("RUNNER_TEMP_UNAVAILABLE")
    parent = Path(temp)
    if not parent.is_dir() or parent.is_symlink():
        raise QualificationError("UNTRUSTED_RUNNER_TEMP")
    return parent / RUNNER_DIRECTORY


def generate() -> dict:
    root = workspace("Linux")
    if os.path.lexists(root):
        raise QualificationError("SYNTHETIC_WORKSPACE_ALREADY_EXISTS")
    tools = (shutil.which("age"), shutil.which("age-keygen"))
    if not all(tools):
        raise QualificationError("PINNED_AGE_EXECUTABLES_MISSING")

    # Only fake materials: private keys are ephemeral and explicitly published
    # in a test artifact for a single workflow run; NEVER reuse in real backups.
    with tempfile.TemporaryDirectory(prefix="sat-age-producer-") as temp:
        scratch = Path(temp)
        scratch.chmod(0o700)
        synthetic = _fake_snapshot(scratch)
        owner, recipient_owner = _recipient(tools[1], scratch, "owner")
        recovery, recipient_recovery = _recipient(tools[1], scratch, "recovery")
        stranger, _ = _recipient(tools[1], scratch, "stranger")
        root.mkdir(mode=0o700)
        shared = root / ARTIFACT_DIRECTORY
        shared.mkdir(mode=0o700)
        try:
            ciphertext = shared / "fabricated.age"
            _run(tools[0], [
                "-r", recipient_owner, "-r", recipient_recovery,
                "-o", str(ciphertext),
            ], data=synthetic)
            if not ciphertext.is_file() or ciphertext.stat().st_size > MAX_CIPHERTEXT_BYTES:
                raise QualificationError("SYNTHETIC_CIPHERTEXT_INVALID")
            for identity in (owner, recovery, stranger):
                value = identity.read_bytes()
                if not value or len(value) > MAX_IDENTITY_BYTES:
                    raise QualificationError("SYNTHETIC_IDENTITY_INVALID")
                (shared / identity.name).write_bytes(value)
            manifest = {
                "format": FORMAT_LABEL,
                "producer_runner_os": "Linux",
                "github_run_id": os.environ["GITHUB_RUN_ID"],
                "synthetic_only": True,
                "archive_bytes": len(synthetic),
                "archive_sha256": _sha256(synthetic),
                "cipher_sha256": _sha256(ciphertext.read_bytes()),
                "cipher_bytes": ciphertext.stat().st_size,
            }
            (shared / "synthetic-manifest.json").write_text(
                json.dumps(manifest, sort_keys=True) + "\n", encoding="utf-8"
            )
        except Exception:
            shutil.rmtree(root, ignore_errors=True)
            raise
    return {
        "status": "SYNTHETIC_LINUX_CIPHERTEXT_GENERATED",
        "origin_linux": True,
        "synthetic_only": True,
        "plaintext_archive_written_to_disk": False,
        "real_keys_used": False,
        "real_backup_performed": False,
        "production_modified": False,
    }


def _read_regular_file(path: Path, limit: int) -> bytes:
    try:
        before = path.lstat()
        if not stat.S_ISREG(before.st_mode) or before.st_size > limit:
            raise QualificationError("UNSAFE_SYNTHETIC_ARTIFACT_FILE")
        # Even though this is fabricated data, do not follow symlinks or print
        # untrusted artifact text. CI supplies a single downloaded directory.
        data = path.read_bytes()
        if len(data) != before.st_size:
            raise QualificationError("SYNTHETIC_FILE_SIZE_CHANGED")
        return data
    except OSError:
        raise QualificationError("SYNTHETIC_ARTIFACT_UNAVAILABLE") from None


def verify_manifest(manifest: object, *, run_id: str, encrypted: bytes) -> None:
    if not isinstance(manifest, dict) or set(manifest) != {
        "format", "producer_runner_os", "github_run_id", "synthetic_only",
        "archive_bytes", "archive_sha256", "cipher_sha256", "cipher_bytes",
    }:
        raise QualificationError("INVALID_SYNTHETIC_MANIFEST")
    if (manifest["format"] != FORMAT_LABEL
            or manifest["producer_runner_os"] != "Linux"
            or manifest["github_run_id"] != run_id
            or manifest["synthetic_only"] is not True):
        raise QualificationError("SYNTHETIC_PROVENANCE_MISMATCH")
    if (type(manifest["archive_bytes"]) is not int
            or not 0 < manifest["archive_bytes"] <= MAX_SYNTHETIC_BYTES
            or type(manifest["cipher_bytes"]) is not int
            or manifest["cipher_bytes"] != len(encrypted)
            or len(encrypted) > MAX_CIPHERTEXT_BYTES):
        raise QualificationError("SYNTHETIC_FILE_LENGTH_MISMATCH")
    for key in ("archive_sha256", "cipher_sha256"):
        if not isinstance(manifest[key], str) or not re.fullmatch(r"[a-f0-9]{64}", manifest[key]):
            raise QualificationError("INVALID_SYNTHETIC_DIGEST")
    if _sha256(encrypted) != manifest["cipher_sha256"]:
        raise QualificationError("SYNTHETIC_CIPHERTEXT_DIGEST_MISMATCH")


def verify() -> dict:
    root = workspace("Windows")
    shared = root / ARTIFACT_DIRECTORY
    if not shared.is_dir() or shared.is_symlink():
        raise QualificationError("SYNTHETIC_DOWNLOAD_MISSING")
    entries = {entry.name for entry in shared.iterdir()}
    if entries != FILE_SET:
        raise QualificationError("UNEXPECTED_SYNTHETIC_ARTIFACT_FILES")
    encrypted = _read_regular_file(shared / "fabricated.age", MAX_CIPHERTEXT_BYTES)
    manifest_data = _read_regular_file(shared / "synthetic-manifest.json", 4096)
    try:
        manifest = json.loads(manifest_data)
    except (ValueError, UnicodeError):
        raise QualificationError("INVALID_SYNTHETIC_MANIFEST") from None
    verify_manifest(manifest, run_id=os.environ["GITHUB_RUN_ID"], encrypted=encrypted)

    age_exe, rage_exe = shutil.which("age"), shutil.which("rage")
    if not age_exe or not rage_exe:
        raise QualificationError("PINNED_AGE_RAGE_EXECUTABLES_MISSING")
    for name in ("owner.txt", "recovery.txt", "stranger.txt"):
        raw = _read_regular_file(shared / name, MAX_IDENTITY_BYTES)
        if not raw.startswith(b"# created:") or b"AGE-SECRET-KEY-" not in raw:
            raise QualificationError("UNEXPECTED_SYNTHETIC_IDENTITY_FORMAT")
    with tempfile.TemporaryDirectory(prefix="sat-age-cross-os-check-") as temp:
        scratch = Path(temp)
        scratch.chmod(0o700)
        for decoder in (age_exe, rage_exe):
            for name in ("owner.txt", "recovery.txt"):
                candidate = _run(decoder, [
                    "-d", "-i", str(shared / name), "-o", "-",
                    str(shared / "fabricated.age"),
                ]).stdout
                if (len(candidate) != manifest["archive_bytes"]
                        or _sha256(candidate) != manifest["archive_sha256"]):
                    raise QualificationError("CROSS_OS_RECOVERED_BYTES_MISMATCH")
                _check_archive(candidate, scratch)
            _run(decoder, [
                "-d", "-i", str(shared / "stranger.txt"), "-o", "-",
                str(shared / "fabricated.age"),
            ], expected_success=False)
    return {
        "status": "SYNTHETIC_SAME_CIPHERTEXT_LINUX_TO_WINDOWS_PASS",
        "synthetic_only": True,
        "same_ciphertext_verified": True,
        "linux_produced_windows_recovered": True,
        "age_and_rage_verified": True,
        "owner_and_recovery_identites_verified": True,
        "unrelated_identity_rejected": True,
        "same_workflow_run_verified": True,
        "real_keys_used": False,
        "real_backup_performed": False,
        "production_modified": False,
        "restoration_approved": False,
        "deployment_authorized": False,
    }


def main() -> int:
    # No path argument exists and no non-CI local/prod invocation is possible.
    if len(sys.argv) != 2 or sys.argv[1] not in ("generate", "verify"):
        print(json.dumps({"status": "BLOCKED", "reason": "SYNTHETIC_MODE_ONLY"}, sort_keys=True))
        return 2
    try:
        receipt = generate() if sys.argv[1] == "generate" else verify()
    except QualificationError as e:
        print(json.dumps({
            "status": "FAILED", "reason": str(e), "synthetic_only": True,
            "real_backup_performed": False, "production_modified": False,
        }, sort_keys=True))
        return 2
    print(json.dumps(receipt, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
