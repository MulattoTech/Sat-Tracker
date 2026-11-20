"""Fabricated-data-only tests: no production backup, volumes, Docker, or keys."""
import importlib.util
import io
import json
import os
from pathlib import Path
import struct
import subprocess
import sys
import tarfile
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
SOURCE = ROOT / "scripts" / "feedback_hotfix_encrypted_archive.py"
spec = importlib.util.spec_from_file_location("feedback_hotfix_encrypted_archive", SOURCE)
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)
PASSWORD = b"SYNTHETIC_ONLY_32_CHAR_NOT_REAL_2026"
WRONG = b"SYNTHETIC_ONLY_WRONG_SECRET_2026"


class EncryptedBackupTests(unittest.TestCase):
    def setUp(self):
        self.workspace = tempfile.TemporaryDirectory(prefix="sat-crypto-test-")
        self.root = Path(self.workspace.name)

    def tearDown(self):
        self.workspace.cleanup()

    def envelope(self, plaintext=b"synthetic-only archive bytes / no family data"):
        output = io.BytesIO()
        outcome = mod.encrypt_stream(io.BytesIO(plaintext), output, PASSWORD)
        return output.getvalue(), outcome

    def verify(self, ciphertext, password=PASSWORD):
        return mod.verify_stream(io.BytesIO(ciphertext), password)

    def blocked(self, ciphertext, reason=None, password=PASSWORD):
        with self.assertRaises(mod.Blocked) as ctx:
            self.verify(ciphertext, password)
        if reason:
            self.assertEqual(str(ctx.exception), reason)

    def test_synthetic_three_volume_tar_layout_encrypted_without_plaintext_file(self):
        # Mirrors tar -czf archive -C snapshot db env files using fabricated bytes.
        archive = io.BytesIO()
        with tarfile.open(mode="w:gz", fileobj=archive) as tar:
            for root in ("db", "env", "files"):
                folder = tarfile.TarInfo(root + "/")
                folder.type = tarfile.DIRTYPE
                tar.addfile(folder)
            for name, content in (
                ("db/baby-tracker.db", b"fake sqlite bytes, not production"),
                ("db/baby-tracker-logs.db", b"fake log sqlite bytes"),
                ("env/.env", b"ENC_HASH=FAKE\nJWT_SECRET=FAKE\n"),
                ("files/fake-media.enc", b"nonsecret fake media ciphertext"),
            ):
                item = tarfile.TarInfo(name)
                item.size = len(content)
                tar.addfile(item, io.BytesIO(content))
        archive_bytes = archive.getvalue()
        destination = self.root / "synthetic-three-volume.satenc"
        receipt = mod.encrypt_stdin_atomic(destination, PASSWORD, io.BytesIO(archive_bytes))
        self.assertEqual(receipt["plaintext_bytes"], len(archive_bytes))
        self.assertEqual(mod.verify_file(destination, PASSWORD)["status"], "CIPHERTEXT_AUTHENTICATED")
        self.assertNotIn(b"ENC_HASH=FAKE", destination.read_bytes())
        self.assertFalse(receipt["production_modified"])
        self.assertFalse(receipt["restore_authorized"])

    def test_authenticates_stream_and_finality_with_no_plaintext_output(self):
        plaintext = b"synthetic test envelope" * 500
        ciphertext, written = self.envelope(plaintext)
        receipt = self.verify(ciphertext)
        self.assertEqual(written, {"plaintext_bytes": len(plaintext), "chunk_count": 1})
        self.assertEqual(receipt["plaintext_bytes"], len(plaintext))
        self.assertTrue(receipt["fully_authenticated"])
        self.assertNotIn(plaintext, ciphertext)
        self.assertNotIn(PASSWORD, ciphertext)

    def test_chunks_large_payload_and_verifies_boundaries(self):
        plaintext = b"synthetic synthetic " * (mod.CHUNK_BYTES // 20 + 100)
        encrypted, receipt = self.envelope(plaintext)
        self.assertGreater(len(plaintext), mod.CHUNK_BYTES)
        self.assertEqual(receipt["chunk_count"], 2)
        self.assertEqual(self.verify(encrypted)["plaintext_bytes"], len(plaintext))

    def test_wrong_password_rejected(self):
        ciphertext, _ = self.envelope()
        self.blocked(ciphertext, "AUTHENTICATION_FAILED", WRONG)

    def test_byte_flip_in_first_frame_rejected(self):
        ciphertext, _ = self.envelope()
        changed = bytearray(ciphertext)
        changed[mod.HEADER.size + mod.FRAME.size + 3] ^= 1
        self.blocked(bytes(changed), "AUTHENTICATION_FAILED")

    def test_byte_flip_in_final_tag_rejected(self):
        ciphertext, _ = self.envelope()
        changed = bytearray(ciphertext)
        changed[-1] ^= 1
        self.blocked(bytes(changed), "AUTHENTICATION_FAILED")

    def test_empty_source_never_published(self):
        with self.assertRaises(mod.Blocked) as error:
            mod.encrypt_stream(io.BytesIO(), io.BytesIO(), PASSWORD)
        self.assertEqual(str(error.exception), "EMPTY_BACKUP_STREAM")

    def test_short_password_rejected(self):
        with self.assertRaises(mod.Blocked) as error:
            mod.encrypt_stream(io.BytesIO(b"fake"), io.BytesIO(), b"short")
        self.assertEqual(str(error.exception), "STRONG_PRIVATE_PASSPHRASE_REQUIRED")

    def test_unknown_envelope_version_rejected_before_kdf(self):
        ciphertext, _ = self.envelope()
        changed = bytearray(ciphertext)
        changed[len(mod.MAGIC)] = 77
        self.blocked(bytes(changed), "UNSUPPORTED_OR_MALFORMED_ENVELOPE")

    def test_modified_kdf_costs_refused_before_memory_allocation(self):
        ciphertext, _ = self.envelope()
        changed = bytearray(ciphertext)
        changed[len(mod.MAGIC) + 1] = 255
        self.blocked(bytes(changed), "UNSUPPORTED_OR_MALFORMED_ENVELOPE")

    def test_corrupted_magic_rejected(self):
        ciphertext, _ = self.envelope()
        self.blocked(b"X" + ciphertext[1:], "UNSUPPORTED_OR_MALFORMED_ENVELOPE")

    def test_truncated_header_rejected(self):
        ciphertext, _ = self.envelope()
        self.blocked(ciphertext[:8], "TRUNCATED_ENCRYPTED_ARCHIVE")

    def test_truncated_frame_rejected(self):
        ciphertext, _ = self.envelope()
        self.blocked(ciphertext[:mod.HEADER.size + 3], "TRUNCATED_ENCRYPTED_ARCHIVE")

    def test_truncated_ciphertext_rejected(self):
        ciphertext, _ = self.envelope()
        self.blocked(ciphertext[:mod.HEADER.size + mod.FRAME.size + 7], "TRUNCATED_ENCRYPTED_ARCHIVE")

    def test_final_marker_removed_rejected(self):
        ciphertext, _ = self.envelope()
        size = mod.HEADER.size + mod.FRAME.size
        length = mod.FRAME.unpack(ciphertext[mod.HEADER.size:size])[1]
        self.blocked(ciphertext[:size + length], "TRUNCATED_ENCRYPTED_ARCHIVE")

    def test_appended_bytes_rejected(self):
        ciphertext, _ = self.envelope()
        self.blocked(ciphertext + b"extra", "TRAILING_DATA_NOT_ALLOWED")

    def test_swapped_chunk_order_rejected(self):
        plaintext = b"A" * mod.CHUNK_BYTES + b"B" * 800
        ciphertext, receipt = self.envelope(plaintext)
        self.assertEqual(receipt["chunk_count"], 2)
        first_start = mod.HEADER.size
        size1 = mod.FRAME.unpack(ciphertext[first_start:first_start + mod.FRAME.size])[1]
        first_end = first_start + mod.FRAME.size + size1
        size2 = mod.FRAME.unpack(ciphertext[first_end:first_end + mod.FRAME.size])[1]
        second_end = first_end + mod.FRAME.size + size2
        first, second = ciphertext[first_start:first_end], ciphertext[first_end:second_end]
        self.blocked(ciphertext[:first_start] + second + first + ciphertext[second_end:], "AUTHENTICATION_FAILED")

    def test_invalid_frame_type_rejected(self):
        ciphertext, _ = self.envelope()
        changed = bytearray(ciphertext)
        changed[mod.HEADER.size] = ord("Z")
        self.blocked(bytes(changed), "INVALID_FRAME_TYPE")

    def test_zero_frame_size_rejected(self):
        ciphertext, _ = self.envelope()
        changed = bytearray(ciphertext)
        position = mod.HEADER.size + 1
        changed[position:position + 4] = struct.pack(">I", 0)
        self.blocked(bytes(changed), "INVALID_ENCRYPTED_FRAME")

    def test_resource_bound_on_plaintext(self):
        with patch.object(mod, "MAX_PLAINTEXT_BYTES", 4):
            with self.assertRaises(mod.Blocked) as error:
                mod.encrypt_stream(io.BytesIO(b"large synthetic"), io.BytesIO(), PASSWORD)
            self.assertEqual(str(error.exception), "ARCHIVE_SIZE_LIMIT")

    def test_reject_missing_destination_directory(self):
        with self.assertRaises(mod.Blocked) as error:
            mod.encrypt_stdin_atomic(self.root / "missing" / "fake.satenc", PASSWORD, io.BytesIO(b"fake"))
        self.assertEqual(str(error.exception), "OUTPUT_DIRECTORY_UNAVAILABLE")

    def test_reject_wrong_encrypted_extension(self):
        with self.assertRaises(mod.Blocked) as error:
            mod.encrypt_stdin_atomic(self.root / "backup.tar.gz", PASSWORD, io.BytesIO(b"fake"))
        self.assertEqual(str(error.exception), "ENCRYPTED_FILENAME_EXTENSION_REQUIRED")

    def test_atomic_no_overwrite_and_authenticated_verify(self):
        target = self.root / "synthetic.satenc"
        data = b"synthetic archive data never real family care"
        receipt = mod.encrypt_stdin_atomic(target, PASSWORD, io.BytesIO(data))
        self.assertEqual(receipt["status"], "ENCRYPTED_ARCHIVE_VERIFIED")
        self.assertFalse(receipt["plaintext_archive_written_to_disk"])
        self.assertFalse(receipt["restore_authorized"])
        self.assertFalse(receipt["deployment_authorized"])
        self.assertTrue(target.is_file())
        self.assertNotIn(data, target.read_bytes())
        verified = mod.verify_file(target, PASSWORD)
        self.assertEqual(verified["plaintext_bytes"], len(data))
        self.assertEqual(verified["archive_sha256"], receipt["ciphertext_sha256"])
        self.assertFalse(verified["restoration_approved"])
        self.assertEqual(list(self.root.glob("*.partial")), [])
        with self.assertRaises(mod.Blocked) as error:
            mod.encrypt_stdin_atomic(target, PASSWORD, io.BytesIO(b"replace"))
        self.assertEqual(str(error.exception), "OUTPUT_ALREADY_EXISTS")

    def test_failed_encryption_cleans_temp_and_does_not_publish(self):
        target = self.root / "unpublished.satenc"
        with self.assertRaises(mod.Blocked):
            mod.encrypt_stdin_atomic(target, PASSWORD, io.BytesIO())
        self.assertFalse(target.exists())
        self.assertEqual(list(self.root.glob("*.partial")), [])

    def test_modified_file_fails_authentication(self):
        target = self.root / "tamper.satenc"
        mod.encrypt_stdin_atomic(target, PASSWORD, io.BytesIO(b"synthetic"))
        value = bytearray(target.read_bytes())
        value[-2] ^= 1
        target.write_bytes(value)
        with self.assertRaises(mod.Blocked) as error:
            mod.verify_file(target, PASSWORD)
        self.assertEqual(str(error.exception), "AUTHENTICATION_FAILED")

    def test_nonexistent_and_directory_inputs_blocked(self):
        for path in (self.root / "not-here.satenc", self.root):
            with self.subTest(path=path), self.assertRaises(mod.Blocked):
                mod.verify_file(path, PASSWORD)

    def test_symlink_input_blocked_when_supported(self):
        archive = self.root / "synthetic.satenc"
        mod.encrypt_stdin_atomic(archive, PASSWORD, io.BytesIO(b"synthetic"))
        link = self.root / "symlink.satenc"
        try:
            link.symlink_to(archive)
        except OSError:
            self.skipTest("OS has no symlink creation privilege")
        with self.assertRaises(mod.Blocked) as error:
            mod.verify_file(link, PASSWORD)
        self.assertEqual(str(error.exception), "NOT_A_REGULAR_ENCRYPTED_ARCHIVE")

    def test_cli_never_accepts_secret_as_option(self):
        output = self.root / "cli.satenc"
        proc = subprocess.run([sys.executable, str(SOURCE), "--encrypt-stdin", "--output", str(output),
                               "--password", "NEVER_SHOW_REAL_SECRETS"], input="",
                              capture_output=True, text=True, timeout=10)
        self.assertEqual(proc.returncode, 2)
        self.assertEqual(json.loads(proc.stdout)["reason"], "INVALID_ARGUMENTS")
        self.assertNotIn("NEVER_SHOW_REAL_SECRETS", proc.stdout + proc.stderr)
        self.assertFalse(output.exists())

    def test_cli_synthetic_encrypt_is_explicitly_not_enabled(self):
        output = self.root / "cli.satenc"
        proc = subprocess.run([sys.executable, str(SOURCE), "--encrypt-stdin", "--output", str(output)],
                              input="synthetic only", capture_output=True, text=True, timeout=10)
        self.assertEqual(proc.returncode, 2)
        self.assertEqual(json.loads(proc.stdout)["reason"], "PRODUCTION_ACQUISITION_ADAPTER_NOT_APPROVED")
        self.assertFalse(output.exists())

    def test_cli_verify_requires_interactive_private_password(self):
        target = self.root / "synthetic.satenc"
        mod.encrypt_stdin_atomic(target, PASSWORD, io.BytesIO(b"synthetic"))
        proc = subprocess.run([sys.executable, str(SOURCE), "--verify-only", str(target)],
                              capture_output=True, text=True, timeout=10)
        self.assertEqual(proc.returncode, 2)
        self.assertEqual(json.loads(proc.stdout)["reason"], "INTERACTIVE_PRIVATE_PASSPHRASE_TERMINAL_REQUIRED")
        self.assertNotIn(str(target), proc.stdout)


if __name__ == "__main__":
    unittest.main()
