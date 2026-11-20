#!/usr/bin/env python3
"""Fake three-volume tar -> age via a binary subprocess pipe, fail closed.

This test accepts NO file/path/secret arguments. It creates only disposable
fabricated SQLite/config/media in a private temp directory, never accesses
Docker or existing production volumes, and cannot deploy or perform backups.
"""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import shutil
import sqlite3
import subprocess
import sys
import tempfile

from verify_age_backup_synthetic import QualificationError, _check_archive, _recipient, _run

TIMEOUT_SECONDS = 40
MAX_FAKE_CIPHERTEXT_BYTES = 4 * 1024 * 1024
REQUIRED_MEMBERS = frozenset(("db", "env", "files"))
REPOSITORY = "MulattoTech/Sat-Tracker"


def _fake_db(path: Path, table: str) -> None:
    con = sqlite3.connect(path)
    try:
        con.execute("PRAGMA foreign_keys=ON")
        con.execute(f"CREATE TABLE {table}(id INTEGER PRIMARY KEY, note TEXT)")
        con.execute(f"INSERT INTO {table} VALUES (1, ?)", ("FABRICATED ONLY",))
        con.commit()
    finally:
        con.close()


def create_fake_volumes(root: Path) -> None:
    """All file content and target folders are synthetic and test-owned."""
    if root.exists():
        raise QualificationError("SYNTHETIC_SOURCE_ALREADY_EXISTS")
    for folder in REQUIRED_MEMBERS:
        (root / folder).mkdir(parents=True, mode=0o700)
    _fake_db(root / "db" / "baby-tracker.db", "fake_feeds")
    _fake_db(root / "db" / "baby-tracker-logs.db", "fake_events")
    (root / "env" / ".env").write_bytes(b"ENC_HASH=NOT_REAL\nJWT_SECRET=NOT_REAL\n")
    (root / "files" / "fake-media.enc").write_bytes(b"FAKE_ENCRYPTED_MEDIA_NOT_A_REAL_DOCUMENT")


def _bounded_fake_source(root: Path) -> None:
    """Reject unexpected fixture directories and any unexpected file links."""
    if root.is_symlink() or not root.is_dir():
        raise QualificationError("INVALID_SYNTHETIC_SOURCE_ROOT")
    actual = {x.name for x in root.iterdir()}
    if actual != REQUIRED_MEMBERS:
        raise QualificationError("INVALID_SYNTHETIC_VOLUME_MEMBERS")
    for folder in REQUIRED_MEMBERS:
        node = root / folder
        if node.is_symlink() or not node.is_dir():
            raise QualificationError("INVALID_SYNTHETIC_VOLUME_MEMBERS")
        for item in node.iterdir():
            if item.is_symlink() or not item.is_file() or item.stat().st_size > 1_048_576:
                raise QualificationError("UNSAFE_FAKE_VOLUME_FILE")


def stream_fake_tar_to_age(
    source_root: Path, tmp_cipher: Path, *,
    age_exe: str, tar_exe: str, recipients: tuple[str, str]
) -> None:
    """No shell or PowerShell pipeline: tar stdout is age stdin as raw bytes.

    This is a test internal function only, not a production backup adapter.
    tmp_cipher is in a temporary test-owned directory and is never public.
    """
    _bounded_fake_source(source_root)
    if tmp_cipher.exists():
        raise QualificationError("OUTPUT_ALREADY_EXISTS")
    if not tmp_cipher.parent.is_dir() or tmp_cipher.parent.is_symlink():
        raise QualificationError("INVALID_SYNTHETIC_OUTPUT_DIRECTORY")
    tar = None
    age = None
    try:
        with tmp_cipher.open("xb") as output:
            try:
                tar = subprocess.Popen(
                    [tar_exe, "-czf", "-", "-C", str(source_root), "db", "env", "files"],
                    stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                    stderr=subprocess.DEVNULL, shell=False,
                )
                age = subprocess.Popen(
                    [age_exe, "-r", recipients[0], "-r", recipients[1]],
                    stdin=tar.stdout, stdout=output,
                    stderr=subprocess.DEVNULL, shell=False,
                )
            except OSError:
                raise QualificationError("SYNTHETIC_PIPE_PROCESS_UNAVAILABLE") from None
            assert tar.stdout is not None
            tar.stdout.close()
            try:
                age_status = age.wait(timeout=TIMEOUT_SECONDS)
                tar_status = tar.wait(timeout=TIMEOUT_SECONDS)
            except subprocess.TimeoutExpired:
                raise QualificationError("SYNTHETIC_PIPE_TIMED_OUT") from None
            if age_status != 0 or tar_status != 0:
                # age could exit 0 after receiving only a partial tar if the
                # tar process failed. Both statuses must succeed.
                raise QualificationError("SYNTHETIC_PIPE_STAGE_FAILED")
            output.flush()
            os.fsync(output.fileno())
        if tmp_cipher.stat().st_size == 0 or tmp_cipher.stat().st_size > MAX_FAKE_CIPHERTEXT_BYTES:
            raise QualificationError("INVALID_FAKE_CIPHERTEXT_SIZE")
    except Exception:
        tmp_cipher.unlink(missing_ok=True)
        raise
    finally:
        for proc in (age, tar):
            if proc is not None and proc.poll() is None:
                proc.kill()
                proc.wait(timeout=5)


def fake_recovery_and_commit(
    scratch: Path, source: Path, *,
    age_exe: str, rage_exe: str, tar_exe: str,
    recipients: tuple[str, str], identities: tuple[Path, Path],
    fail_tar: bool = False,
) -> dict:
    """Publish ciphertext only after successful tar AND age AND fake recovery."""
    _bounded_fake_source(source)
    output = scratch / "complete-fake-backup.age"
    temporary = scratch / ".fake-cipher.partial"
    if output.exists() or temporary.exists():
        raise QualificationError("SYNTHETIC_OUTPUT_ALREADY_EXISTS")
    if fail_tar:
        # Controlled fault injection; no live volume can be referenced.
        shutil.rmtree(source / "files")
        # The bounded source verifier will now reject before process launch.
    try:
        stream_fake_tar_to_age(
            source, temporary, age_exe=age_exe, tar_exe=tar_exe,
            recipients=recipients
        )
        hashes = []
        for exe in (age_exe, rage_exe):
            for identity in identities:
                recovered = _run(
                    exe, ["-d", "-i", str(identity), "-o", "-", str(temporary)]
                ).stdout
                if not recovered or len(recovered) > 2 * 1024 * 1024:
                    raise QualificationError("INVALID_SYNTHETIC_DECRYPT_SIZE")
                _check_archive(recovered, scratch)
                hashes.append(hashlib.sha256(recovered).hexdigest())
        if len(set(hashes)) != 1:
            raise QualificationError("SYNTHETIC_RECOVERY_DIGEST_MISMATCH")
        # Hard link cannot overwrite. Only authenticated test ciphertext
        # is published, never partial output.
        os.link(temporary, output)
        return {
            "status": "SYNTHETIC_BINARY_PIPE_TO_AGE_PASS",
            "tar_and_age_exit_checked": True,
            "same_fake_contents_from_four_recoveries": True,
            "encrypted_output_published_after_verification": True,
            "plaintext_tar_written_to_disk": False,
            "actual_backup_performed": False,
            "production_modified": False,
            "deployment_authorized": False,
        }
    except OSError:
        raise QualificationError("SYNTHETIC_CIPHERTEXT_COMMIT_FAILED") from None
    finally:
        temporary.unlink(missing_ok=True)


def check() -> dict:
    if (os.environ.get("GITHUB_ACTIONS") != "true"
            or os.environ.get("GITHUB_REPOSITORY") != REPOSITORY
            or os.environ.get("RUNNER_OS") not in ("Linux", "Windows")):
        raise QualificationError("SYNTHETIC_CI_ENVIRONMENT_REQUIRED")
    age_exe, rage_exe, keygen_exe, tar_exe = (
        shutil.which("age"), shutil.which("rage"),
        shutil.which("age-keygen"), shutil.which("tar"),
    )
    if not all((age_exe, rage_exe, keygen_exe, tar_exe)):
        raise QualificationError("REQUIRED_SYNTHETIC_CI_TOOLS_MISSING")
    with tempfile.TemporaryDirectory(prefix="sat-fake-stream-") as root_text:
        root = Path(root_text)
        root.chmod(0o700)
        fake_volumes = root / "synthetic-input"
        create_fake_volumes(fake_volumes)
        owner, recipient_owner = _recipient(keygen_exe, root, "synthetic-owner")
        recovery, recipient_recovery = _recipient(keygen_exe, root, "synthetic-recovery")
        result = fake_recovery_and_commit(
            root, fake_volumes, age_exe=age_exe, rage_exe=rage_exe,
            tar_exe=tar_exe, recipients=(recipient_owner, recipient_recovery),
            identities=(owner, recovery),
        )
        if not (root / "complete-fake-backup.age").is_file():
            raise QualificationError("SYNTHETIC_CIPHERTEXT_NOT_PUBLISHED")
        if (root / ".fake-cipher.partial").exists():
            raise QualificationError("PARTIAL_TEST_CIPHERTEXT_NOT_CLEANED")
        if list(root.glob("*.tar.gz")):
            raise QualificationError("UNENCRYPTED_SYNTHETIC_ARCHIVE_WRITTEN")
        return {**result, "synthetic_only": True, "no_real_credentials": True}


def main() -> int:
    if len(sys.argv) != 1:
        print(json.dumps({"status": "BLOCKED", "reason": "NO_USER_ARCHIVE_ARGUMENTS_ALLOWED"}))
        return 2
    try:
        result = check()
    except QualificationError as exc:
        print(json.dumps({
            "status": "FAILED", "reason": str(exc),
            "synthetic_only": True, "production_modified": False,
        }, sort_keys=True))
        return 2
    print(json.dumps(result, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
