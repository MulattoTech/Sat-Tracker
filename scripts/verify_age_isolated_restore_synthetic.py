#!/usr/bin/env python3
"""Fabricated-data-only encrypted backup staging and restore acceptance.

No user path/secret arguments. Runs only in the named GitHub Actions
synthetic workflow. Never reads Docker, the live app, or real family files.
"""
from __future__ import annotations

import hashlib
import io
import json
import os
from pathlib import Path
import shutil
import sqlite3
import sys
import tarfile
import tempfile

from verify_age_backup_synthetic import QualificationError, _recipient, _run
from verify_age_pipe_synthetic import create_fake_volumes, stream_fake_tar_to_age

MAX_FAKE_ARCHIVE_BYTES = 2 * 1024 * 1024
MAX_FAKE_FILE_BYTES = 1 * 1024 * 1024
FAKE_ENV = b"ENC_HASH=NOT_REAL\nJWT_SECRET=NOT_REAL\n"
FAKE_MEDIA = b"FAKE_ENCRYPTED_MEDIA_NOT_A_REAL_DOCUMENT"
REQUIRED_FILES = frozenset((
    "db/baby-tracker.db", "db/baby-tracker-logs.db",
    "env/.env", "files/fake-media.enc",
))
REQUIRED_FOLDERS = frozenset(("db", "env", "files"))
REPOSITORY = "MulattoTech/Sat-Tracker"


def _verify_sqlite_file(path: Path, expected_table: str) -> None:
    """Verify actual recovered file, never the source database."""
    try:
        con = sqlite3.connect(path.as_uri() + "?mode=ro", uri=True)
        try:
            if con.execute("PRAGMA integrity_check").fetchone() != ("ok",):
                raise QualificationError("SYNTHETIC_RESTORED_SQLITE_INTEGRITY_FAIL")
            if con.execute("PRAGMA foreign_key_check").fetchone() is not None:
                raise QualificationError("SYNTHETIC_RESTORED_SQLITE_FOREIGN_KEYS_FAIL")
            n = con.execute(
                "SELECT count(*) FROM sqlite_master WHERE type='table' AND name=?",
                (expected_table,),
            ).fetchone()[0]
            if n != 1:
                raise QualificationError("SYNTHETIC_RESTORED_SQLITE_TABLE_MISSING")
            if con.execute(f"SELECT count(*) FROM {expected_table}").fetchone()[0] != 1:
                raise QualificationError("SYNTHETIC_RESTORED_SQLITE_ROW_MISSING")
        finally:
            con.close()
    except sqlite3.DatabaseError:
        raise QualificationError("SYNTHETIC_RESTORED_SQLITE_INVALID") from None


def _validate_members(archive: bytes) -> dict[str, bytes]:
    """Read all named fake archive entries, checking tar safety before writes."""
    if not archive or len(archive) > MAX_FAKE_ARCHIVE_BYTES:
        raise QualificationError("FAKE_ARCHIVE_SIZE_INVALID")
    contents: dict[str, bytes] = {}
    directories: set[str] = set()
    try:
        with tarfile.open(fileobj=io.BytesIO(archive), mode="r:gz") as tar:
            count = 0
            for member in tar:
                count += 1
                if count > 16:
                    raise QualificationError("FAKE_ARCHIVE_MEMBER_LIMIT")
                name = member.name
                # Only literal known names; refuse path traversal, hardlinks,
                # symlinks, devices, absolute paths and unknown family files.
                if member.isdir():
                    if name not in REQUIRED_FOLDERS and name.rstrip("/") not in REQUIRED_FOLDERS:
                        raise QualificationError("UNEXPECTED_FAKE_ARCHIVE_DIRECTORY")
                    root = name.rstrip("/")
                    if root in directories:
                        raise QualificationError("DUPLICATE_FAKE_ARCHIVE_DIRECTORY")
                    directories.add(root)
                elif member.isfile():
                    if name not in REQUIRED_FILES or name in contents:
                        raise QualificationError("UNEXPECTED_FAKE_ARCHIVE_MEMBER")
                    if not (0 < member.size <= MAX_FAKE_FILE_BYTES):
                        raise QualificationError("INVALID_FAKE_MEMBER_SIZE")
                    reader = tar.extractfile(member)
                    if reader is None:
                        raise QualificationError("FAKE_TAR_MEMBER_UNREADABLE")
                    content = reader.read(MAX_FAKE_FILE_BYTES + 1)
                    if len(content) != member.size:
                        raise QualificationError("FAKE_TAR_MEMBER_LENGTH_MISMATCH")
                    contents[name] = content
                else:
                    raise QualificationError("DANGEROUS_FAKE_TAR_MEMBER_TYPE")
    except (OSError, tarfile.TarError, EOFError):
        raise QualificationError("FAKE_ARCHIVE_INVALID") from None
    if set(contents) != REQUIRED_FILES or directories != REQUIRED_FOLDERS:
        raise QualificationError("THREE_FAKE_VOLUMES_INCOMPLETE")
    if contents["env/.env"] != FAKE_ENV or contents["files/fake-media.enc"] != FAKE_MEDIA:
        raise QualificationError("FAKE_KEY_OR_MEDIA_CONTENT_MISMATCH")
    return contents


def isolated_restore_fake_archive(
    archive: bytes, destination: Path, *, expected_sha256: str
) -> dict:
    """Verify ALL contents and SHA before writing new fake staging files.

    Destination must not exist. No file writes to an existing real volume
    are performed by the CLI, which supplies this path only inside a
    synthetic TemporaryDirectory.
    """
    if hashlib.sha256(archive).hexdigest() != expected_sha256:
        raise QualificationError("FAKE_ARCHIVE_SHA256_MISMATCH")
    contents = _validate_members(archive)
    if destination.exists() or destination.is_symlink():
        raise QualificationError("FAKE_RESTORE_DESTINATION_NOT_FRESH")
    destination.mkdir(mode=0o700)
    try:
        for folder in sorted(REQUIRED_FOLDERS):
            (destination / folder).mkdir(mode=0o700)
        for name, content in contents.items():
            # names are exact allowlisted literals before joining
            with (destination / name).open("xb") as stream:
                stream.write(content)
                stream.flush()
                os.fsync(stream.fileno())
        _verify_sqlite_file(destination / "db" / "baby-tracker.db", "fake_feeds")
        _verify_sqlite_file(destination / "db" / "baby-tracker-logs.db", "fake_events")
        if (destination / "env" / ".env").read_bytes() != FAKE_ENV:
            raise QualificationError("FAKE_RESTORED_KEY_IDENTITY_MISMATCH")
        if (destination / "files" / "fake-media.enc").read_bytes() != FAKE_MEDIA:
            raise QualificationError("FAKE_RESTORED_MEDIA_MISMATCH")
        return {
            "status": "SYNTHETIC_ISOLATED_THREE_VOLUME_RESTORE_PASS",
            "archive_sha256": expected_sha256,
            "complete_fake_db_integrity": True,
            "complete_fake_env_key_identity": True,
            "complete_fake_media_identity": True,
            "production_modified": False,
            "actual_restore_performed": False,
        }
    except Exception:
        shutil.rmtree(destination, ignore_errors=True)
        raise


def check() -> dict:
    if (os.environ.get("GITHUB_ACTIONS") != "true"
            or os.environ.get("GITHUB_REPOSITORY") != REPOSITORY
            or os.environ.get("RUNNER_OS") not in ("Linux", "Windows")):
        raise QualificationError("NAMED_SYNTHETIC_CI_ONLY")
    import shutil as tools
    age, rage, keygen, tar = (tools.which(x) for x in ("age", "rage", "age-keygen", "tar"))
    if not all((age, rage, keygen, tar)):
        raise QualificationError("SYNTHETIC_AGE_RESTORE_TOOLS_UNAVAILABLE")
    with tempfile.TemporaryDirectory(prefix="sat-restored-fake-only-") as temp:
        root = Path(temp)
        root.chmod(0o700)
        source = root / "synthetic-volumes"
        create_fake_volumes(source)
        owner, r1 = _recipient(keygen, root, "synthetic-owner")
        recovery, r2 = _recipient(keygen, root, "synthetic-recovery")
        ciphertext = root / "fake-only.age"
        stream_fake_tar_to_age(source, ciphertext, age_exe=age, tar_exe=tar, recipients=(r1, r2))
        hashes = []
        for decoder in (age, rage):
            for identity in (owner, recovery):
                # Require complete CLI success BEFORE any content is staged.
                complete = _run(decoder, [
                    "-d", "-i", str(identity), "-o", "-", str(ciphertext)
                ]).stdout
                digest = hashlib.sha256(complete).hexdigest()
                target = root / ("isolated-" + str(len(hashes)))
                evidence = isolated_restore_fake_archive(
                    complete, target, expected_sha256=digest
                )
                if evidence["status"] != "SYNTHETIC_ISOLATED_THREE_VOLUME_RESTORE_PASS":
                    raise QualificationError("FAKE_RESTORE_POLICY_REJECTED")
                hashes.append(digest)
        if len(set(hashes)) != 1:
            raise QualificationError("INCONSISTENT_SYNTHETIC_RESTORE_DIGESTS")
        return {
            "status": "SYNTHETIC_ENCRYPTED_ISOLATED_RESTORE_PASS",
            "source_volumes": 3,
            "separate_staging_recoveries": 4,
            "go_age_and_rust_rage": True,
            "same_synthetic_archive_sha256": True,
            "all_fake_sqlite_env_media_verified": True,
            "partial_decrypt_never_restored": True,
            "synthetic_only": True,
            "production_modified": False,
            "real_backup_performed": False,
            "real_restore_performed": False,
            "deployment_authorized": False,
        }


def main() -> int:
    if len(sys.argv) != 1:
        print(json.dumps({"status": "BLOCKED", "reason": "NO_USER_RESTORE_ARGUMENTS_ALLOWED"}))
        return 2
    try:
        evidence = check()
        print(json.dumps(evidence, sort_keys=True))
        return 0
    except QualificationError as error:
        print(json.dumps({
            "status": "FAILED", "reason": str(error), "synthetic_only": True,
            "production_modified": False, "real_restore_performed": False,
        }, sort_keys=True))
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
