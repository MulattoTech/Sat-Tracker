#!/usr/bin/env python3
"""Disposable age-format recovery qualification with fully fabricated records.

This script has deliberately NO path or archive arguments. It cannot inspect,
back up, mount, stop, or restore a production service or volume. Its only
inputs are freshly synthesized SQLite, configuration, and fake media bytes.
All encryption identities are temporary and must never be printed to logs.
"""
from __future__ import annotations

import hashlib
import io
import json
import os
from pathlib import Path
import re
import shutil
import sqlite3
import subprocess
import sys
import tarfile
import tempfile

MAX_SYNTHETIC_BYTES = 2 * 1024 * 1024
MAX_SUBPROCESS_SECONDS = 45


class QualificationError(Exception):
    """Describe only a stable, non-sensitive failure code."""


def _run(executable: str, args: list[str], *, data: bytes | None = None,
         expected_success: bool = True) -> subprocess.CompletedProcess[bytes]:
    try:
        result = subprocess.run(
            [executable, *args], input=data, stdout=subprocess.PIPE,
            stderr=subprocess.PIPE, timeout=MAX_SUBPROCESS_SECONDS, check=False,
        )
    except (OSError, subprocess.TimeoutExpired):
        raise QualificationError("TEST_TOOL_UNAVAILABLE_OR_TIMED_OUT") from None
    if bool(result.returncode == 0) != expected_success:
        # Never echo stdin, identities, public recipients, stderr or the
        # resulting command line into logs.
        raise QualificationError("UNEXPECTED_AGE_TOOL_EXIT")
    return result


def _fixture_database(path: Path, table: str) -> bytes:
    # Everything below is fake, and is created under a test-owned directory.
    connection = sqlite3.connect(path)
    try:
        connection.execute("PRAGMA foreign_keys=ON")
        connection.execute(f"CREATE TABLE {table}(id INTEGER PRIMARY KEY, fake_note TEXT)")
        connection.execute(f"INSERT INTO {table} VALUES (1, ?)", ("fabricated-only",))
        connection.commit()
    finally:
        connection.close()
    return path.read_bytes()


def _fake_snapshot(root: Path) -> bytes:
    main = _fixture_database(root / "primary.sqlite", "fabricated_care")
    logs = _fixture_database(root / "logs.sqlite", "fabricated_log")
    members = {
        "db/baby-tracker.db": main,
        "db/baby-tracker-logs.db": logs,
        "env/.env": b"ENC_HASH=NOT_A_REAL_SECRET\nJWT_SECRET=NOT_A_REAL_SECRET\n",
        "files/fake-media.enc": b"FABRICATED_NONREAL_CIPHERTEXT_0123456789",
    }
    output = io.BytesIO()
    with tarfile.open(fileobj=output, mode="w:gz") as tar:
        for folder in ("db/", "env/", "files/"):
            directory = tarfile.TarInfo(folder)
            directory.type = tarfile.DIRTYPE
            directory.mode = 0o700
            tar.addfile(directory)
        for name, content in members.items():
            entry = tarfile.TarInfo(name)
            entry.size = len(content)
            entry.mode = 0o600
            tar.addfile(entry, io.BytesIO(content))
    archive = output.getvalue()
    if not archive or len(archive) > MAX_SYNTHETIC_BYTES:
        raise QualificationError("SYNTHETIC_ARCHIVE_TOO_LARGE")
    return archive


def _check_archive(archive: bytes, root: Path) -> None:
    expected_names = {
        "db/baby-tracker.db", "db/baby-tracker-logs.db",
        "env/.env", "files/fake-media.enc",
    }
    with tarfile.open(fileobj=io.BytesIO(archive), mode="r:gz") as tar:
        actual_names = {member.name for member in tar if member.isfile()}
        if actual_names != expected_names:
            raise QualificationError("RECOVERED_SYNTHETIC_MEMBERS_CHANGED")
        for filename in ("db/baby-tracker.db", "db/baby-tracker-logs.db"):
            extracted = tar.extractfile(filename)
            if extracted is None:
                raise QualificationError("RECOVERED_SYNTHETIC_SQLITE_MISSING")
            copy = root / ("check-" + Path(filename).name)
            copy.write_bytes(extracted.read())
            connection = sqlite3.connect(copy)
            try:
                if connection.execute("PRAGMA integrity_check").fetchone() != ("ok",):
                    raise QualificationError("RECOVERED_SYNTHETIC_SQLITE_DAMAGED")
                if connection.execute("PRAGMA foreign_key_check").fetchone() is not None:
                    raise QualificationError("RECOVERED_SYNTHETIC_FOREIGN_KEYS_BAD")
            finally:
                connection.close()


def _recipient(age_keygen: str, work: Path, name: str) -> tuple[Path, str]:
    identity_path = work / (name + ".txt")
    _run(age_keygen, ["-o", str(identity_path)])
    identity_path.chmod(0o600)
    output = _run(age_keygen, ["-y", str(identity_path)]).stdout.decode("ascii").strip()
    if not re.fullmatch(r"age1[a-z0-9]{40,100}", output):
        raise QualificationError("SYNTHETIC_RECIPIENT_FORMAT_INVALID")
    return identity_path, output


def check() -> dict:
    age_exe = shutil.which("age")
    keygen_exe = shutil.which("age-keygen")
    rage_exe = shutil.which("rage")
    if not age_exe or not keygen_exe:
        raise QualificationError("PINNED_AGE_EXECUTABLES_MISSING")
    if not rage_exe:
        raise QualificationError("PINNED_RAGE_EXECUTABLE_MISSING")
    version = _run(age_exe, ["--version"]).stdout.decode("utf-8", errors="replace")
    other_version = _run(rage_exe, ["--version"]).stdout.decode("utf-8", errors="replace")
    if "v1.3.2" not in version and "1.3.2" not in version:
        raise QualificationError("UNEXPECTED_AGE_VERSION")
    if "0.12.1" not in other_version:
        raise QualificationError("UNEXPECTED_RAGE_VERSION")

    # TemporaryDirectory contains only fake identities and fake care records.
    # The directory is deleted on all paths, including failed tests.
    with tempfile.TemporaryDirectory(prefix="sat-age-fixture-") as temp:
        root = Path(temp)
        root.chmod(0o700)
        snapshot = _fake_snapshot(root)
        original_hash = hashlib.sha256(snapshot).hexdigest()
        owner, owner_recipient = _recipient(keygen_exe, root, "synthetic-owner")
        recovery, recovery_recipient = _recipient(keygen_exe, root, "synthetic-recovery")
        stranger, _ = _recipient(keygen_exe, root, "synthetic-stranger")
        output = root / "fabricated-snapshot.tar.gz.age"

        # Supply the tar.gz as bytes over stdin; no plaintext archive file.
        _run(age_exe, [
            "-r", owner_recipient, "-r", recovery_recipient,
            "-o", str(output),
        ], data=snapshot)
        if not output.is_file() or output.stat().st_size == 0:
            raise QualificationError("AGE_CIPHERTEXT_NOT_CREATED")
        cipher = output.read_bytes()
        if not cipher.startswith(b"age-encryption.org/v1\n"):
            raise QualificationError("NOT_AGE_V1_FORMAT")
        if original_hash == hashlib.sha256(cipher).hexdigest():
            raise QualificationError("CIPHERTEXT_EQUALS_PLAINTEXT")

        # Both separately held identities must recover the exact archive;
        # a third, unrelated identity must not.
        for key in (owner, recovery):
            plaintext = _run(age_exe, [
                "-d", "-i", str(key), "-o", "-", str(output)
            ]).stdout
            if plaintext != snapshot or hashlib.sha256(plaintext).hexdigest() != original_hash:
                raise QualificationError("RECOVERED_BYTES_NOT_IDENTICAL")
            _check_archive(plaintext, root)
        _run(age_exe, [
            "-d", "-i", str(stranger), "-o", "-", str(output)
        ], expected_success=False)

        # Cross-implementation: the *separate Rust rage* decoder must
        # recover the same Go-age ciphertext with both Go-generated identities.
        for key in (owner, recovery):
            plaintext = _run(rage_exe, [
                "-d", "-i", str(key), "-o", "-", str(output)
            ]).stdout
            if plaintext != snapshot:
                raise QualificationError("RUST_DECODER_RECOVERY_MISMATCH")
            _check_archive(plaintext, root)
        _run(rage_exe, [
            "-d", "-i", str(stranger), "-o", "-", str(output)
        ], expected_success=False)

        # Reverse direction: Rust rage encrypts the fabricated archive;
        # Go age must decrypt it with either of the same synthetic identities.
        rage_cipher = root / "fabricated-rage-snapshot.age"
        _run(rage_exe, [
            "-r", owner_recipient, "-r", recovery_recipient,
            "-o", str(rage_cipher),
        ], data=snapshot)
        for key in (owner, recovery):
            plaintext = _run(age_exe, [
                "-d", "-i", str(key), "-o", "-", str(rage_cipher)
            ]).stdout
            if plaintext != snapshot:
                raise QualificationError("GO_DECODER_RECOVERY_MISMATCH")

        # Explicitly alter and truncate a copy of *fabricated* ciphertext;
        # no corrupted output may be accepted as a valid recovery.
        tampered = root / "tampered.age"
        bad = bytearray(cipher)
        bad[-1] ^= 1
        tampered.write_bytes(bad)
        for decoder in (age_exe, rage_exe):
            _run(decoder, ["-d", "-i", str(owner), "-o", "-", str(tampered)],
                 expected_success=False)
        truncated = root / "truncated.age"
        truncated.write_bytes(cipher[:-20])
        for decoder in (age_exe, rage_exe):
            _run(decoder, ["-d", "-i", str(owner), "-o", "-", str(truncated)],
                 expected_success=False)

        return {
            "status": "SYNTHETIC_AGE_RAGE_INTEROP_PASS",
            "age_version_checked": "v1.3.2",
            "rage_version_checked": "v0.12.1",
            "independent_implementations_verified": 2,
            "go_age_to_rust_rage_recovery_verified": True,
            "rust_rage_to_go_age_recovery_verified": True,
            "cross_platform_recovery_verified": False,
            "synthetic_only": True,
            "identity_sources": 3,
            "independent_recovery_identities_verified": 2,
            "unrelated_identity_rejected": True,
            "tampered_and_truncated_ciphertext_rejected": True,
            "synthetic_three_volume_sqlite_integrity_verified": True,
            "plaintext_archive_written_to_disk": False,
            "real_backup_performed": False,
            "live_keys_created_or_read": False,
            "production_modified": False,
            "production_backup_authorized": False,
            "deployment_authorized": False,
        }


def main() -> int:
    if len(sys.argv) != 1:
        # Never echo unexpected argument text (which may include secrets).
        print(json.dumps({"status": "BLOCKED", "reason": "NO_USER_ARCHIVES_OR_ARGUMENTS_ALLOWED"}))
        return 2
    try:
        result = check()
    except QualificationError as error:
        print(json.dumps({
            "status": "FAILED", "reason": str(error),
            "synthetic_only": True, "production_modified": False,
            "production_backup_authorized": False,
        }, sort_keys=True))
        return 2
    print(json.dumps(result, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
