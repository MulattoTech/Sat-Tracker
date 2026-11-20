"""Safe negative tests: only temporary fake files, never actual Docker volumes."""
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import Mock, patch

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scripts"))
SPEC = importlib.util.spec_from_file_location(
    "synthetic_age_pipe", ROOT / "scripts" / "verify_age_pipe_synthetic.py"
)
mod = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(mod)


class SyntheticAgePipeTests(unittest.TestCase):
    def setUp(self):
        self.owner = tempfile.TemporaryDirectory(prefix="sat-fake-pipe-policy-")
        self.root = Path(self.owner.name)
        self.source = self.root / "synthetic"
        mod.create_fake_volumes(self.source)

    def tearDown(self):
        self.owner.cleanup()

    def fail(self, code: str):
        with self.assertRaises(mod.QualificationError) as exc:
            mod._bounded_fake_source(self.source)
        self.assertEqual(str(exc.exception), code)

    def test_three_generated_fake_volume_roots(self):
        mod._bounded_fake_source(self.source)
        self.assertEqual({x.name for x in self.source.iterdir()}, {"db", "env", "files"})
        self.assertGreater((self.source / "db" / "baby-tracker.db").stat().st_size, 100)

    def test_duplicate_fixture_root_refused(self):
        with self.assertRaises(mod.QualificationError):
            mod.create_fake_volumes(self.source)

    def test_missing_volume_refused(self):
        import shutil
        shutil.rmtree(self.source / "files")
        self.fail("INVALID_SYNTHETIC_VOLUME_MEMBERS")

    def test_extra_volume_refused(self):
        (self.source / "production").mkdir()
        self.fail("INVALID_SYNTHETIC_VOLUME_MEMBERS")

    def test_non_directory_volume_refused(self):
        import shutil
        shutil.rmtree(self.source / "env")
        (self.source / "env").write_bytes(b"fake")
        self.fail("INVALID_SYNTHETIC_VOLUME_MEMBERS")

    def test_symlinked_member_rejected_when_os_supports(self):
        outside = self.root / "fake-outside"
        outside.write_bytes(b"fake not private")
        link = self.source / "files" / "fake-link"
        try:
            link.symlink_to(outside)
        except OSError:
            self.skipTest("Windows symlink creation permission unavailable")
        self.fail("UNSAFE_FAKE_VOLUME_FILE")

    def test_oversize_fake_file_refused(self):
        (self.source / "files" / "oversize").write_bytes(b"F" * (1_048_576 + 1))
        self.fail("UNSAFE_FAKE_VOLUME_FILE")

    def test_command_rejects_real_archive_arguments_without_reflecting_them(self):
        suspicious = "NEVER_SUPPLY_REAL_FAMILY_SECRETS"
        process = subprocess.run([
            sys.executable, str(ROOT / "scripts" / "verify_age_pipe_synthetic.py"),
            "--volume", suspicious,
        ], capture_output=True, text=True, timeout=10)
        self.assertEqual(process.returncode, 2)
        self.assertEqual(json.loads(process.stdout)["reason"], "NO_USER_ARCHIVE_ARGUMENTS_ALLOWED")
        self.assertNotIn(suspicious, process.stdout + process.stderr)

    def test_non_github_environment_refused(self):
        with patch.dict(os.environ, {}, clear=True):
            with self.assertRaises(mod.QualificationError) as error:
                mod.check()
        self.assertEqual(str(error.exception), "SYNTHETIC_CI_ENVIRONMENT_REQUIRED")

    def test_wrong_repository_refused(self):
        with patch.dict(os.environ, {
            "GITHUB_ACTIONS": "true", "GITHUB_REPOSITORY": "wrong/repository",
            "RUNNER_OS": "Linux"
        }, clear=True):
            with self.assertRaises(mod.QualificationError) as error:
                mod.check()
        self.assertEqual(str(error.exception), "SYNTHETIC_CI_ENVIRONMENT_REQUIRED")

    def test_missing_age_producer_binary_cleans_temporary_output(self):
        tmp = self.root / ".fake-cipher.partial"
        with patch.object(mod.subprocess, "Popen", side_effect=OSError("synthetic blocked")):
            with self.assertRaises(mod.QualificationError) as error:
                mod.stream_fake_tar_to_age(
                    self.source, tmp, age_exe="nonexistent-age", tar_exe="synthetic-tar",
                    recipients=("FAKE_RECIPIENT_A", "FAKE_RECIPIENT_B")
                )
        self.assertEqual(str(error.exception), "SYNTHETIC_PIPE_PROCESS_UNAVAILABLE")
        self.assertFalse(tmp.exists())

    def test_bad_tar_exit_cannot_publish_ciphertext(self):
        tmp = self.root / ".fake-cipher.partial"
        tar = Mock()
        tar.stdout = io.BytesIO(b"fake compressed bytes only")
        tar.wait.return_value = 1
        tar.poll.return_value = 1
        age = Mock()
        age.wait.return_value = 0
        age.poll.return_value = 0
        with patch.object(mod.subprocess, "Popen", side_effect=[tar, age]):
            with self.assertRaises(mod.QualificationError) as error:
                mod.stream_fake_tar_to_age(
                    self.source, tmp, age_exe="fake-encrypt",
                    tar_exe="fake-tar",
                    recipients=("FAKE_RECIPIENT_A", "FAKE_RECIPIENT_B")
                )
        self.assertEqual(str(error.exception), "SYNTHETIC_PIPE_STAGE_FAILED")
        self.assertFalse(tmp.exists())
        self.assertEqual(age.wait.call_count, 1)
        self.assertEqual(tar.wait.call_count, 1)

    def test_failing_tar_keeps_published_name_absent(self):
        import shutil
        with self.assertRaises(mod.QualificationError):
            mod.fake_recovery_and_commit(
                self.root, self.source, age_exe="fake", rage_exe="fake",
                tar_exe="fake", recipients=("FAKE_A", "FAKE_B"),
                identities=(self.root / "a", self.root / "b"),
                fail_tar=True,
            )
        self.assertFalse((self.root / "complete-fake-backup.age").exists())
        self.assertFalse((self.root / ".fake-cipher.partial").exists())

    def test_unexpected_existing_cipher_output_refused(self):
        tmp = self.root / "already-there"
        tmp.write_bytes(b"existing-fake-ciphertext")
        with self.assertRaises(mod.QualificationError) as error:
            mod.stream_fake_tar_to_age(
                self.source, tmp, age_exe="fake", tar_exe="fake",
                recipients=("FAKE_A", "FAKE_B"))
        self.assertEqual(str(error.exception), "OUTPUT_ALREADY_EXISTS")
        self.assertEqual(tmp.read_bytes(), b"existing-fake-ciphertext")

    def test_no_actual_backup_or_docker_command_in_test_source(self):
        code = (ROOT / "scripts" / "verify_age_pipe_synthetic.py").read_text(encoding="utf-8")
        self.assertNotIn("docker compose", code)
        self.assertNotIn("docker volume", code)
        self.assertNotIn("babytracker-sprout", code)
        self.assertIn("NO_USER_ARCHIVE_ARGUMENTS_ALLOWED", code)
        self.assertIn("shell=False", code)


if __name__ == "__main__":
    unittest.main()
