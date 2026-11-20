#!/usr/bin/env python3
"""Offline, checksum-pinned BabyTracker backup archive verifier.

Reads only a path explicitly supplied by the operator. Does not extract to
production, call Docker, read live volumes, deploy or authorize a restore.
All diagnostics are deliberately sanitized; never prints archive entries,
private data or secret values.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import sqlite3
import stat
import sys
import tarfile
import tempfile
from pathlib import Path

EXPECTED_DB = ("baby-tracker.db", "baby-tracker-logs.db")
ROOTS = frozenset(("db", "env", "files"))
HASH_RE = re.compile(r"^[a-f0-9]{64}$")
MAX_ARCHIVE_BYTES = 16 * 1024**3
MAX_UNPACKED_BYTES = 64 * 1024**3
MAX_MEMBER_BYTES = 8 * 1024**3
MAX_MEMBERS = 250_000
MAX_MEMBER_NAME = 1024
CHUNK_BYTES = 1024 * 1024


class Blocked(Exception):
    """Carries only a stable error code, never untrusted content."""


def digest_file(path: Path) -> str:
    result = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(CHUNK_BYTES), b""):
            result.update(chunk)
    return result.hexdigest()


def normalized_name(value: str) -> str:
    if not isinstance(value, str) or not value or len(value) > MAX_MEMBER_NAME:
        raise Blocked("INVALID_MEMBER_NAME")
    # BusyBox/Alpine tar may prefix the root with './'.
    while value.startswith("./"):
        value = value[2:]
    value = value.rstrip("/")
    if not value or value.startswith("/") or "\\" in value or ":" in value:
        raise Blocked("UNSAFE_MEMBER_NAME")
    parts = value.split("/")
    if any(part in ("", ".", "..") or "\x00" in part for part in parts):
        raise Blocked("UNSAFE_MEMBER_NAME")
    if parts[0] not in ROOTS:
        raise Blocked("UNEXPECTED_ARCHIVE_ROOT")
    return value


def validate_env_contents(raw: bytes) -> bool:
    if len(raw) > 2 * 1024**2:
        raise Blocked("ENV_FILE_TOO_LARGE")
    try:
        content = raw.decode("utf-8")
    except UnicodeDecodeError:
        raise Blocked("ENV_NOT_UTF8") from None
    names = {"ENC_HASH": [], "JWT_SECRET": []}
    for line in content.splitlines():
        if not line or line.lstrip().startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        if key in names:
            names[key].append(value.strip().strip('"').strip("'"))
    if any(len(values) != 1 or not values[0] for values in names.values()):
        raise Blocked("PERSISTENT_CONFIG_KEYS_MISSING_OR_DUPLICATE")
    return True


def inspect_sqlite(db_root: Path) -> int:
    table_count = 0
    for filename in EXPECTED_DB:
        file = db_root / filename
        if not file.is_file():
            raise Blocked("REQUIRED_SQLITE_MISSING")
        # Copies were made exclusively inside the private scratch directory.
        uri = file.resolve().as_uri() + "?mode=ro"
        try:
            con = sqlite3.connect(uri, uri=True, timeout=2)
            try:
                if con.execute("PRAGMA integrity_check").fetchone() != ("ok",):
                    raise Blocked("SQLITE_INTEGRITY_FAILED")
                if con.execute("PRAGMA foreign_key_check").fetchone() is not None:
                    raise Blocked("SQLITE_FOREIGN_KEY_FAILED")
                table_count += con.execute(
                    "SELECT count(*) FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
                ).fetchone()[0]
            finally:
                con.close()
        except sqlite3.DatabaseError:
            raise Blocked("SQLITE_INTEGRITY_FAILED") from None
    return table_count


def verify(archive: Path, expected_sha256: str) -> dict:
    if not HASH_RE.fullmatch(expected_sha256):
        raise Blocked("EXPECTED_SHA256_REQUIRED")
    try:
        properties = archive.lstat()
        if not stat.S_ISREG(properties.st_mode) or properties.st_size == 0:
            raise Blocked("ARCHIVE_NOT_REGULAR_FILE")
        if properties.st_size > MAX_ARCHIVE_BYTES:
            raise Blocked("ARCHIVE_SIZE_LIMIT")
    except OSError:
        raise Blocked("ARCHIVE_UNAVAILABLE") from None
    if digest_file(archive) != expected_sha256:
        raise Blocked("PINNED_SHA256_MISMATCH")

    roots_seen: set[str] = set()
    names_seen: set[str] = set()
    lowercase_seen: set[str] = set()
    total_unpacked = 0
    member_count = 0
    media_count = 0
    media_bytes = 0
    contents_digest = hashlib.sha256()
    media_digest = hashlib.sha256()
    env_content = None
    expected_files = {"db/baby-tracker.db", "db/baby-tracker-logs.db", "env/.env"}

    # Scratch storage never uses production paths or Docker volumes.
    with tempfile.TemporaryDirectory(prefix="sat-archive-verify-") as scratch:
        db_dir = Path(scratch) / "db"
        db_dir.mkdir(mode=0o700)
        try:
            with tarfile.open(archive, mode="r:gz") as tar:
                for member in tar:
                    member_count += 1
                    if member_count > MAX_MEMBERS:
                        raise Blocked("MEMBER_COUNT_LIMIT")
                    key = normalized_name(member.name)
                    if key in names_seen or key.casefold() in lowercase_seen:
                        raise Blocked("DUPLICATE_OR_CASE_COLLIDING_MEMBER")
                    names_seen.add(key)
                    lowercase_seen.add(key.casefold())
                    root = key.split("/", 1)[0]
                    roots_seen.add(root)
                    if not (member.isdir() or member.isfile()):
                        raise Blocked("UNSAFE_TAR_MEMBER_TYPE")
                    if member.isdir():
                        continue
                    if "/" not in key:
                        raise Blocked("ROOT_MUST_BE_DIRECTORY")
                    if member.size < 0 or member.size > MAX_MEMBER_BYTES:
                        raise Blocked("MEMBER_SIZE_LIMIT")
                    total_unpacked += member.size
                    if total_unpacked > MAX_UNPACKED_BYTES:
                        raise Blocked("ARCHIVE_EXPANSION_LIMIT")
                    stream = tar.extractfile(member)
                    if stream is None:
                        raise Blocked("TAR_ENTRY_UNREADABLE")
                    content_hash = hashlib.sha256()
                    read = 0
                    is_db_related = root == "db" and (
                        key[3:] in EXPECTED_DB
                        or any(key[3:] == name + ext for name in EXPECTED_DB for ext in ("-wal", "-shm"))
                    )
                    destination = db_dir / key[3:] if is_db_related else None
                    if destination and ("/" in key[3:] or "\\" in key[3:]):
                        raise Blocked("UNSAFE_DATABASE_FILENAME")
                    out = destination.open("xb") if destination else None
                    try:
                        env_chunks = bytearray() if key == "env/.env" else None
                        while True:
                            chunk = stream.read(CHUNK_BYTES)
                            if not chunk:
                                break
                            read += len(chunk)
                            if read > member.size:
                                raise Blocked("TAR_MEMBER_SIZE_MISMATCH")
                            content_hash.update(chunk)
                            if out:
                                out.write(chunk)
                            if env_chunks is not None:
                                if len(env_chunks) + len(chunk) > 2 * 1024**2:
                                    raise Blocked("ENV_FILE_TOO_LARGE")
                                env_chunks.extend(chunk)
                        if read != member.size:
                            raise Blocked("TAR_MEMBER_SIZE_MISMATCH")
                        if env_chunks is not None:
                            env_content = bytes(env_chunks)
                    finally:
                        stream.close()
                        if out:
                            out.close()
                    # Entry names affect the digest, but the report only includes
                    # the final aggregate hash; never print any private filename.
                    entry_fingerprint = (key + "\0" + str(read) + "\0" + content_hash.hexdigest() + "\n").encode()
                    contents_digest.update(entry_fingerprint)
                    if root == "files":
                        media_count += 1
                        media_bytes += read
                        media_digest.update(entry_fingerprint)
            if roots_seen != ROOTS:
                raise Blocked("THREE_VOLUME_ROOTS_INCOMPLETE")
            if not expected_files.issubset(names_seen):
                raise Blocked("REQUIRED_FILES_MISSING")
            if env_content is None:
                raise Blocked("CONFIGURATION_FILE_MISSING")
            validate_env_contents(env_content)
            total_tables = inspect_sqlite(db_dir)
        except (tarfile.TarError, EOFError, OSError):
            raise Blocked("ARCHIVE_CONTENT_INVALID") from None

    return {
        "status": "OFFLINE_ARCHIVE_BYTES_VERIFIED",
        "archive_sha256": expected_sha256,
        "all_three_roots_present": True,
        "both_sqlite_integrity_and_fk_verified": True,
        "required_secret_key_names_present": True,
        "member_count": member_count,
        "unpacked_bytes": total_unpacked,
        "sqlite_table_count": total_tables,
        "media_file_count": media_count,
        "media_bytes": media_bytes,
        "content_manifest_sha256": contents_digest.hexdigest(),
        "media_manifest_sha256": media_digest.hexdigest(),
        "media_decryption_verified": False,
        "live_snapshot_consistency_proven": False,
        "private_backup_restore_approved": False,
        "production_restore_authorized": False,
        "deployment_authorized": False,
        "production_modified": False,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Offline-only SHA256-pinned Sat-Tracker archive integrity check")
    parser.add_argument("--archive", required=True, type=Path)
    parser.add_argument("--sha256", required=True)
    parser.add_argument("--synthetic", action="store_true")
    args = parser.parse_args()
    try:
        result = verify(args.archive, args.sha256)
        result["mode"] = "SYNTHETIC" if args.synthetic else "OFFLINE_OPERATOR_SELECTED"
        print(json.dumps(result, sort_keys=True))
        return 0
    except Blocked as problem:
        print(json.dumps({
            "status": "BLOCKED",
            "reason": str(problem),
            "production_restore_authorized": False,
            "deployment_authorized": False,
            "production_modified": False,
        }, sort_keys=True))
        return 2


if __name__ == "__main__":
    sys.exit(main())
