"""Only fake archives and new temporary directories; no real restore inputs."""
import importlib.util
import hashlib
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tarfile
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scripts"))
SPEC = importlib.util.spec_from_file_location(
    "sat_fake_restore", ROOT / "scripts" / "verify_age_isolated_restore_synthetic.py"
)
mod = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(mod)
from verify_age_pipe_synthetic import create_fake_volumes


class FakeIsolatedRestoreTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="sat-fake-isolated-restore-")
        self.root = Path(self.tmp.name)
        self.source = self.root / "fake-source"
        create_fake_volumes(self.source)
        self.stage = self.root / "new-restore"

    def tearDown(self):
        self.tmp.cleanup()

    def snapshot(self, replacement=None, omitted=None, extra=None):
        buf = io.BytesIO()
        with tarfile.open(fileobj=buf, mode="w:gz") as tar:
            for folder in ("db", "env", "files"):
                info = tarfile.TarInfo(folder)
                info.type = tarfile.DIRTYPE
                tar.addfile(info)
            for file in sorted(self.source.rglob("*")):
                if not file.is_file():
                    continue
                key = file.relative_to(self.source).as_posix()
                if key == omitted:
                    continue
                content = replacement[key] if replacement and key in replacement else file.read_bytes()
                info = tarfile.TarInfo(key)
                info.size = len(content)
                tar.addfile(info, io.BytesIO(content))
            if extra:
                for key, content, type_id in extra:
                    info = tarfile.TarInfo(key)
                    info.size = len(content)
                    if type_id:
                        info.type = type_id
                        info.linkname = "../../outside"
                    tar.addfile(info, io.BytesIO(content) if not type_id else None)
        return buf.getvalue()

    def restore(self, archive):
        return mod.isolated_restore_fake_archive(
            archive, self.stage, expected_sha256=hashlib.sha256(archive).hexdigest()
        )

    def assert_reject(self, archive, reason):
        with self.assertRaises(mod.QualificationError) as e:
            self.restore(archive)
        self.assertEqual(str(e.exception), reason)
        self.assertFalse(self.stage.exists())

    def test_fake_three_volume_isolated_recovery_success(self):
        result = self.restore(self.snapshot())
        self.assertEqual(result["status"], "SYNTHETIC_ISOLATED_THREE_VOLUME_RESTORE_PASS")
        self.assertFalse(result["actual_restore_performed"])
        self.assertFalse(result["production_modified"])
        self.assertEqual((self.stage / "env" / ".env").read_bytes(), mod.FAKE_ENV)
        self.assertEqual((self.stage / "files" / "fake-media.enc").read_bytes(), mod.FAKE_MEDIA)

    def test_expected_archive_sha256_is_mandatory(self):
        with self.assertRaises(mod.QualificationError) as e:
            mod.isolated_restore_fake_archive(self.snapshot(), self.stage, expected_sha256="0" * 64)
        self.assertEqual(str(e.exception), "FAKE_ARCHIVE_SHA256_MISMATCH")
        self.assertFalse(self.stage.exists())

    def test_existing_staging_directory_cannot_be_reused(self):
        self.stage.mkdir()
        with self.assertRaises(mod.QualificationError) as e:
            self.restore(self.snapshot())
        self.assertEqual(str(e.exception), "FAKE_RESTORE_DESTINATION_NOT_FRESH")

    def test_missing_any_archive_volume_is_rejected(self):
        for key in ("db/baby-tracker.db", "db/baby-tracker-logs.db", "env/.env",
                    "files/fake-media.enc"):
            with self.subTest(key=key):
                self.assert_reject(self.snapshot(omitted=key), "THREE_FAKE_VOLUMES_INCOMPLETE")

    def test_unknown_file_is_rejected(self):
        self.assert_reject(self.snapshot(extra=[("files/extra", b"x", None)]),
                           "UNEXPECTED_FAKE_ARCHIVE_MEMBER")

    def test_archive_path_traversal_is_rejected(self):
        self.assert_reject(self.snapshot(extra=[("files/../outside", b"x", None)]),
                           "UNEXPECTED_FAKE_ARCHIVE_MEMBER")

    def test_archive_symlink_is_rejected(self):
        self.assert_reject(self.snapshot(extra=[("files/link", b"", tarfile.SYMTYPE)]),
                           "DANGEROUS_FAKE_TAR_MEMBER_TYPE")

    def test_duplicate_file_entries_rejected(self):
        self.assert_reject(
            self.snapshot(extra=[("files/fake-media.enc", mod.FAKE_MEDIA, None)]),
            "UNEXPECTED_FAKE_ARCHIVE_MEMBER"
        )

    def test_modified_fake_persistent_config_blocked(self):
        self.assert_reject(self.snapshot(replacement={
            "env/.env": b"ENC_HASH=CHANGED_TEST_SECRET\nJWT_SECRET=NOT_REAL\n"
        }), "FAKE_KEY_OR_MEDIA_CONTENT_MISMATCH")

    def test_modified_fake_media_blocked(self):
        self.assert_reject(self.snapshot(replacement={
            "files/fake-media.enc": b"FAKE_MEDIA_CHANGED"
        }), "FAKE_KEY_OR_MEDIA_CONTENT_MISMATCH")

    def test_broken_primary_sqlite_fails_and_cleans_restore(self):
        self.assert_reject(self.snapshot(replacement={
            "db/baby-tracker.db": b"FAKE INVALID SQLITE"
        }), "SYNTHETIC_RESTORED_SQLITE_INVALID")

    def test_broken_log_sqlite_fails_and_cleans_restore(self):
        self.assert_reject(self.snapshot(replacement={
            "db/baby-tracker-logs.db": b"FAKE INVALID LOG SQLITE"
        }), "SYNTHETIC_RESTORED_SQLITE_INVALID")

    def test_truncated_tar_rejected_before_writing(self):
        fake = self.snapshot()
        self.assert_reject(fake[:len(fake) // 2], "FAKE_ARCHIVE_INVALID")

    def test_empty_tar_blocked(self):
        self.assert_reject(b"", "FAKE_ARCHIVE_SIZE_INVALID")

    def test_outside_ci_rejected(self):
        with patch.dict(os.environ, {}, clear=True):
            with self.assertRaises(mod.QualificationError) as e:
                mod.check()
        self.assertEqual(str(e.exception), "NAMED_SYNTHETIC_CI_ONLY")

    def test_command_never_accepts_backup_path_or_echoes_it(self):
        secret_like = "NEVER_REAL_BACKUP_OR_PASSWORD"
        process = subprocess.run(
            [sys.executable, str(ROOT / "scripts" / "verify_age_isolated_restore_synthetic.py"),
             "--archive", secret_like],
            capture_output=True, text=True, timeout=10
        )
        self.assertEqual(process.returncode, 2)
        self.assertEqual(json.loads(process.stdout)["reason"], "NO_USER_RESTORE_ARGUMENTS_ALLOWED")
        self.assertNotIn(secret_like, process.stdout + process.stderr)


if __name__ == "__main__":
    unittest.main()
