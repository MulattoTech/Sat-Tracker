"""Fail-closed, exclusively fabricated cross-OS age artifact checks."""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

SCRIPTS = Path(__file__).resolve().parents[2] / "scripts"
sys.path.insert(0, str(SCRIPTS))
SPEC = importlib.util.spec_from_file_location(
    "sat_synthetic_cross_os", SCRIPTS / "verify_age_cross_os_synthetic.py"
)
mod = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(mod)


def valid(cipher=b"FABRICATED_AGE_CIPHERTEXT"):
    return {
        "format": "SYNTHETIC_AGE_CROSS_OS_V1",
        "producer_runner_os": "Linux",
        "github_run_id": "123456789",
        "synthetic_only": True,
        "archive_bytes": 1000,
        "archive_sha256": "b" * 64,
        "cipher_sha256": hashlib.sha256(cipher).hexdigest(),
        "cipher_bytes": len(cipher),
    }


class SyntheticCrossOSPolicyTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="sat-cross-os-policy-")
        self.root = Path(self.tmp.name)
        self.cipher = b"FABRICATED_AGE_CIPHERTEXT"

    def tearDown(self):
        self.tmp.cleanup()

    def assert_blocked(self, data, reason, cipher=None):
        with self.assertRaises(mod.QualificationError) as result:
            mod.verify_manifest(data, run_id="123456789",
                                encrypted=self.cipher if cipher is None else cipher)
        self.assertEqual(str(result.exception), reason)

    def test_matching_synthetic_only_run_manifest(self):
        mod.verify_manifest(valid(self.cipher), run_id="123456789", encrypted=self.cipher)

    def test_no_cli_args_refused(self):
        r = subprocess.run([sys.executable, str(SCRIPTS / "verify_age_cross_os_synthetic.py")],
                           capture_output=True, text=True, timeout=10)
        self.assertEqual(r.returncode, 2)
        self.assertEqual(json.loads(r.stdout)["reason"], "SYNTHETIC_MODE_ONLY")

    def test_secret_like_unexpected_argument_never_echoed(self):
        suspicious = "NEVER_ENTER_REAL_SECRET"
        r = subprocess.run([sys.executable, str(SCRIPTS / "verify_age_cross_os_synthetic.py"),
                            "verify", "--archive", suspicious],
                           capture_output=True, text=True, timeout=10)
        self.assertEqual(r.returncode, 2)
        self.assertNotIn(suspicious, r.stdout + r.stderr)

    def test_outside_github_runner_rejected(self):
        with patch.dict(os.environ, {}, clear=True):
            for platform in ("Windows", "Linux"):
                with self.subTest(os_name=platform), self.assertRaises(mod.QualificationError):
                    mod.workspace(platform)

    def test_wrong_repo_refused(self):
        with patch.dict(os.environ, {
            "GITHUB_ACTIONS": "true", "GITHUB_REPOSITORY": "not-the-repo",
            "RUNNER_OS": "Linux", "GITHUB_RUN_ID": "123456789",
            "RUNNER_TEMP": str(self.root),
        }, clear=True):
            with self.assertRaises(mod.QualificationError):
                mod.workspace("Linux")

    def test_wrong_platform_refused(self):
        with patch.dict(os.environ, {
            "GITHUB_ACTIONS": "true", "GITHUB_REPOSITORY": mod.REPOSITORY,
            "RUNNER_OS": "Windows", "GITHUB_RUN_ID": "123456789",
            "RUNNER_TEMP": str(self.root),
        }, clear=True):
            with self.assertRaises(mod.QualificationError):
                mod.workspace("Linux")

    def test_malformed_manifest_and_extra_fields(self):
        self.assert_blocked(None, "INVALID_SYNTHETIC_MANIFEST")
        data = valid(self.cipher)
        data["actual_backup_path"] = "/mnt/production"
        self.assert_blocked(data, "INVALID_SYNTHETIC_MANIFEST")

    def test_run_id_mismatch_blocked(self):
        data = valid(self.cipher)
        data["github_run_id"] = "987654321"
        self.assert_blocked(data, "SYNTHETIC_PROVENANCE_MISMATCH")

    def test_producer_os_mismatch_blocked(self):
        data = valid(self.cipher)
        data["producer_runner_os"] = "Windows"
        self.assert_blocked(data, "SYNTHETIC_PROVENANCE_MISMATCH")

    def test_manifest_boolean_must_be_literal_true(self):
        data = valid(self.cipher)
        data["synthetic_only"] = "true"
        self.assert_blocked(data, "SYNTHETIC_PROVENANCE_MISMATCH")

    def test_negative_and_boolean_length_rejected(self):
        for value in (-1, 0, False, "100"):
            data = valid(self.cipher)
            data["archive_bytes"] = value
            self.assert_blocked(data, "SYNTHETIC_FILE_LENGTH_MISMATCH")

    def test_canonical_64_character_digest_required(self):
        for value in ("a" * 63, "G" * 64, "", None):
            data = valid(self.cipher)
            data["archive_sha256"] = value
            self.assert_blocked(data, "INVALID_SYNTHETIC_DIGEST")

    def test_tampered_artifact_hash_rejected_before_decrypt(self):
        self.assert_blocked(valid(self.cipher), "SYNTHETIC_FILE_LENGTH_MISMATCH",
                            cipher=self.cipher + b"!")

    def test_same_length_tamper_rejected_by_digest(self):
        changed = bytearray(self.cipher)
        changed[-1] ^= 1
        self.assert_blocked(valid(self.cipher), "SYNTHETIC_CIPHERTEXT_DIGEST_MISMATCH",
                            cipher=bytes(changed))

    def test_no_symlink_or_directory_file_inputs(self):
        with self.assertRaises(mod.QualificationError):
            mod._read_regular_file(self.root, 100)
        other = self.root / "fixture"
        other.write_bytes(b"FAKE")
        self.assertEqual(mod._read_regular_file(other, 100), b"FAKE")
        with self.assertRaises(mod.QualificationError):
            mod._read_regular_file(other, 1)

    def test_real_data_paths_never_accepted(self):
        with patch.dict(os.environ, {}, clear=True):
            with self.assertRaises(mod.QualificationError):
                mod.generate()
            with self.assertRaises(mod.QualificationError):
                mod.verify()


if __name__ == "__main__":
    unittest.main()
