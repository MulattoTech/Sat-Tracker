#!/usr/bin/env python3
"""Passphrase-protected streaming envelope for *offline* Sat-Tracker archives.

Does not call Docker, take backups, access live volumes, extract archives,
restore databases or deploy images. Never accepts a secret on the command line.
Operators must separately verify acquisition, write-freeze, private retention,
and an isolated restore. The format is fixed and authenticated end-to-end.
"""
from __future__ import annotations

import argparse
import getpass
import hashlib
import json
import os
from pathlib import Path
import stat
import struct
import sys
import tempfile
from typing import BinaryIO

from argon2.low_level import Type, hash_secret_raw
from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

MAGIC = b"SATBKUP1"
VERSION = 1
HEADER = struct.Struct(">8sBIII16s4sI")
FRAME = struct.Struct(">cI")
COUNTER = struct.Struct(">Q")
FINAL = struct.Struct(">QQ")
CHUNK_BYTES = 1 << 20
KDF_TIME = 3
KDF_MEMORY_KIB = 65536
KDF_PARALLEL = 1
MAX_PLAINTEXT_BYTES = 16 << 30
MAX_ENCRYPTED_BYTES = MAX_PLAINTEXT_BYTES + 1024 * 1024
MIN_PASSPHRASE_BYTES = 20
TAG_BYTES = 16


class Blocked(Exception):
    """Sanitized refusal: never attach input, path, or passphrase contents."""


def _exact(stream: BinaryIO, size: int) -> bytes:
    output = bytearray()
    while len(output) < size:
        chunk = stream.read(size - len(output))
        if not chunk:
            raise Blocked("TRUNCATED_ENCRYPTED_ARCHIVE")
        output.extend(chunk)
    return bytes(output)


def _key(password: bytes, salt: bytes) -> bytes:
    if not isinstance(password, bytes) or len(password) < MIN_PASSPHRASE_BYTES:
        raise Blocked("STRONG_PRIVATE_PASSPHRASE_REQUIRED")
    return hash_secret_raw(
        secret=password, salt=salt, time_cost=KDF_TIME,
        memory_cost=KDF_MEMORY_KIB, parallelism=KDF_PARALLEL,
        hash_len=32, type=Type.ID
    )


def _aad(header: bytes, kind: bytes, index: int) -> bytes:
    return header + kind + COUNTER.pack(index)


def encrypt_stream(source: BinaryIO, target: BinaryIO, password: bytes) -> dict:
    """Encrypt bytes from the caller-provided stream with authenticated finality.

    All output is ciphertext; callers must not publish the output file until
    verification succeeds. The source stream is not opened or selected here.
    """
    salt, nonce_prefix = os.urandom(16), os.urandom(4)
    header = HEADER.pack(
        MAGIC, VERSION, KDF_TIME, KDF_MEMORY_KIB, KDF_PARALLEL,
        salt, nonce_prefix, CHUNK_BYTES
    )
    aes = AESGCM(_key(password, salt))
    target.write(header)
    total, count = 0, 0
    while True:
        chunk = source.read(CHUNK_BYTES)
        if not chunk:
            break
        if total + len(chunk) > MAX_PLAINTEXT_BYTES or count >= 2**64 - 1:
            raise Blocked("ARCHIVE_SIZE_LIMIT")
        nonce = nonce_prefix + COUNTER.pack(count)
        ciphertext = aes.encrypt(nonce, chunk, _aad(header, b"D", count))
        target.write(FRAME.pack(b"D", len(ciphertext)))
        target.write(ciphertext)
        total += len(chunk)
        count += 1
    if total == 0:
        raise Blocked("EMPTY_BACKUP_STREAM")
    final_ciphertext = aes.encrypt(
        nonce_prefix + COUNTER.pack(count),
        FINAL.pack(count, total), _aad(header, b"F", count)
    )
    target.write(FRAME.pack(b"F", len(final_ciphertext)))
    target.write(final_ciphertext)
    return {"plaintext_bytes": total, "chunk_count": count}


def verify_stream(source: BinaryIO, password: bytes) -> dict:
    """Authenticate every frame and the final marker, without writing plaintext."""
    header = _exact(source, HEADER.size)
    magic, version, time, memory, parallel, salt, prefix, chunk_bytes = HEADER.unpack(header)
    if (magic != MAGIC or version != VERSION or time != KDF_TIME
            or memory != KDF_MEMORY_KIB or parallel != KDF_PARALLEL
            or chunk_bytes != CHUNK_BYTES):
        raise Blocked("UNSUPPORTED_OR_MALFORMED_ENVELOPE")
    aes = AESGCM(_key(password, salt))
    total, count = 0, 0
    while True:
        flag, length = FRAME.unpack(_exact(source, FRAME.size))
        if flag == b"D":
            if not TAG_BYTES < length <= CHUNK_BYTES + TAG_BYTES:
                raise Blocked("INVALID_ENCRYPTED_FRAME")
        elif flag == b"F":
            if length != FINAL.size + TAG_BYTES or total == 0:
                raise Blocked("INVALID_FINAL_FRAME")
        else:
            raise Blocked("INVALID_FRAME_TYPE")
        if count >= 2**64 - 1:
            raise Blocked("CHUNK_COUNTER_LIMIT")
        encrypted = _exact(source, length)
        nonce = prefix + COUNTER.pack(count)
        try:
            plain = aes.decrypt(nonce, encrypted, _aad(header, flag, count))
        except InvalidTag:
            raise Blocked("AUTHENTICATION_FAILED") from None
        if flag == b"F":
            claimed_count, claimed_size = FINAL.unpack(plain)
            if claimed_count != count or claimed_size != total:
                raise Blocked("FINAL_COUNT_MISMATCH")
            if source.read(1):
                raise Blocked("TRAILING_DATA_NOT_ALLOWED")
            return {"plaintext_bytes": total, "chunk_count": count,
                    "fully_authenticated": True}
        total += len(plain)
        count += 1
        if total > MAX_PLAINTEXT_BYTES:
            raise Blocked("ARCHIVE_SIZE_LIMIT")


def _source_file(path: Path) -> BinaryIO:
    """Open only a stable regular file, rejecting replacement after lstat."""
    handle = None
    try:
        before = path.lstat()
        if not stat.S_ISREG(before.st_mode):
            raise Blocked("NOT_A_REGULAR_ENCRYPTED_ARCHIVE")
        if before.st_size > MAX_ENCRYPTED_BYTES:
            raise Blocked("ENCRYPTED_ARCHIVE_SIZE_LIMIT")
        mode = os.O_RDONLY | getattr(os, "O_BINARY", 0) | getattr(os, "O_NOFOLLOW", 0)
        handle = os.open(path, mode)
        after = os.fstat(handle)
        if (not stat.S_ISREG(after.st_mode)
                or (before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns)
                != (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns)):
            raise Blocked("ARCHIVE_CHANGED_DURING_OPEN")
        reader = os.fdopen(handle, "rb")
        handle = None
        return reader
    except OSError:
        raise Blocked("ENCRYPTED_ARCHIVE_UNAVAILABLE") from None
    finally:
        if handle is not None:
            os.close(handle)


class DigestingReader:
    """Hash exactly the same bytes consumed by the authenticated decoder."""

    def __init__(self, source: BinaryIO) -> None:
        self.source = source
        self.sha256 = hashlib.sha256()

    def read(self, size: int = -1) -> bytes:
        data = self.source.read(size)
        self.sha256.update(data)
        return data

    def hexdigest(self) -> str:
        return self.sha256.hexdigest()


def verify_file(path: Path, password: bytes) -> dict:
    with _source_file(path) as source:
        observed = DigestingReader(source)
        result = verify_stream(observed, password)
        authenticated_sha256 = observed.hexdigest()
    return {**result, "status": "CIPHERTEXT_AUTHENTICATED",
            "archive_sha256": authenticated_sha256,
            "plaintext_extracted": False, "restoration_approved": False,
            "production_modified": False}


def encrypt_stdin_atomic(output: Path, password: bytes, source: BinaryIO) -> dict:
    """Write temporary *ciphertext* only, verify, and link without overwrite."""
    if output.suffix != ".satenc":
        raise Blocked("ENCRYPTED_FILENAME_EXTENSION_REQUIRED")
    if os.path.lexists(output):
        raise Blocked("OUTPUT_ALREADY_EXISTS")
    if not output.parent.is_dir() or output.parent.is_symlink():
        raise Blocked("OUTPUT_DIRECTORY_UNAVAILABLE")
    fd = None
    temporary = None
    try:
        fd, tmp = tempfile.mkstemp(prefix=".satbackup-", suffix=".partial", dir=output.parent)
        temporary = Path(tmp)
        with os.fdopen(fd, "wb") as target:
            fd = None
            encryption = encrypt_stream(source, target, password)
            target.flush()
            os.fsync(target.fileno())
        with _source_file(temporary) as candidate:
            observed = DigestingReader(candidate)
            integrity = verify_stream(observed, password)
            sha256 = observed.hexdigest()
        if encryption != {k: integrity[k] for k in ("plaintext_bytes", "chunk_count")}:
            raise Blocked("POST_ENCRYPTION_VERIFY_FAILED")
        # Hard-link is an atomic, no-overwrite commit within the same directory.
        # If unsupported, fail closed; do not silently replace an existing file.
        os.link(temporary, output)
        return {
            "status": "ENCRYPTED_ARCHIVE_VERIFIED",
            "ciphertext_sha256": sha256,
            "plaintext_bytes": encryption["plaintext_bytes"],
            "chunk_count": encryption["chunk_count"],
            "authenticity_verified": True,
            "plaintext_archive_written_to_disk": False,
            "production_modified": False,
            "deployment_authorized": False,
            "restore_authorized": False,
        }
    except Blocked:
        raise
    except OSError:
        raise Blocked("ENCRYPTED_OUTPUT_COMMIT_FAILED") from None
    finally:
        if fd is not None:
            os.close(fd)
        if temporary is not None:
            try:
                temporary.unlink(missing_ok=True)
            except OSError:
                pass


def _prompt(confirm: bool) -> bytes:
    if not sys.stdin.isatty():
        # getpass must never fall back to reading a piped archive or a secret
        # supplied through a shell script. A future streaming acquisition
        # adapter will require an independently reviewed private TTY path.
        raise Blocked("INTERACTIVE_PRIVATE_PASSPHRASE_TERMINAL_REQUIRED")
    first = getpass.getpass("Private archive passphrase (not recorded): ")
    if confirm:
        second = getpass.getpass("Confirm private archive passphrase: ")
        if first != second:
            raise Blocked("PASSPHRASE_CONFIRMATION_FAILED")
    return first.encode("utf-8")


class SafeParser(argparse.ArgumentParser):
    def error(self, message: str) -> None:
        # argparse's default help prints the unexpected argument text, which
        # could echo an accidentally supplied passphrase. Never reflect it.
        print(json.dumps({"status": "BLOCKED", "reason": "INVALID_ARGUMENTS",
                          "deployment_authorized": False,
                          "restore_authorized": False,
                          "production_modified": False}, sort_keys=True))
        raise SystemExit(2)


def main() -> int:
    parser = SafeParser(description="Offline Sat-Tracker encrypted archive preparation; no Docker or restore")
    actions = parser.add_mutually_exclusive_group(required=True)
    actions.add_argument("--encrypt-stdin", action="store_true")
    actions.add_argument("--verify-only", type=Path, metavar="ENCRYPTED_FILE")
    parser.add_argument("--output", type=Path, help="For --encrypt-stdin, a new .satenc path (never overwrites)")
    args = parser.parse_args()
    try:
        if args.encrypt_stdin:
            if args.output is None:
                raise Blocked("OUTPUT_PATH_REQUIRED")
            # Never read a private backup from stdin until private key-entry
            # and encrypted output path are independently approved.
            raise Blocked("PRODUCTION_ACQUISITION_ADAPTER_NOT_APPROVED")
        if args.output is not None:
            raise Blocked("VERIFY_MODE_TAKES_NO_OUTPUT")
        result = verify_file(args.verify_only, _prompt(confirm=False))
        print(json.dumps(result, sort_keys=True))
        return 0
    except Blocked as exc:
        print(json.dumps({
            "status": "BLOCKED", "reason": str(exc),
            "deployment_authorized": False, "restore_authorized": False,
            "production_modified": False,
        }, sort_keys=True))
        return 2


if __name__ == "__main__":
    sys.exit(main())
