"""Synthetic fail-closed rollback decisions; no Docker or live data."""
import copy
import importlib.util
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "scripts" / "feedback_hotfix_rollback_decision.py"
spec = importlib.util.spec_from_file_location("hotfix_rollback_decision", SCRIPT)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


def good():
    return {
        "schema_version": 1,
        "release": dict(module.RELEASE),
        "evidence": {k: True for k in module.REQUIRED_EVIDENCE},
        "counts": {k: 0 for k in module.COUNTS},
    }


class ReadOnlyDecisionTests(unittest.TestCase):
    def assertBlocked(self, data, contains=None):
        result = module.evaluate(data)
        self.assertNotEqual(result["decision"], "COLD_RESTORE_REQUIRES_NEW_OWNER_APPROVAL")
        self.assertFalse(result["automatic_restore_allowed"])
        self.assertFalse(result["deployment_authorized"])
        self.assertFalse(result["production_restore_authorized"])
        self.assertFalse(result["production_modified"])
        if contains:
            self.assertIn(contains, result["blockers"])

    def test_clean_synthetic_state_requires_new_owner_approval_not_execution(self):
        decision = module.evaluate(good())
        self.assertEqual(decision["decision"], "COLD_RESTORE_REQUIRES_NEW_OWNER_APPROVAL")
        self.assertEqual(decision["blockers"], [])
        self.assertFalse(decision["deployment_authorized"])
        self.assertFalse(decision["production_restore_authorized"])
        self.assertFalse(decision["automatic_restore_allowed"])
        self.assertTrue(decision["evidence_is_self_attested"])

    def test_unknown_evidence(self):
        self.assertBlocked(None, "MALFORMED_EVIDENCE")

    def test_missing_releases(self):
        data = good()
        del data["release"]
        self.assertBlocked(data, "RELEASE_IDENTITY_INCOMPLETE")

    def test_wrong_candidate_digest(self):
        data = good()
        data["release"]["candidate_image"] = "ghcr.io/incorrect@sha256:" + "a"*64
        self.assertBlocked(data, "RELEASE_CANDIDATE_IMAGE_MISMATCH")

    def test_wrong_baseline(self):
        data = good()
        data["release"]["production_baseline"] = "a"*40
        self.assertBlocked(data, "RELEASE_PRODUCTION_BASELINE_MISMATCH")

    def test_schema_bool_is_not_int(self):
        data = good()
        data["schema_version"] = True
        self.assertBlocked(data, "UNSUPPORTED_SCHEMA_VERSION")

    def test_unsupported_schema(self):
        data = good()
        data["schema_version"] = 2
        self.assertBlocked(data, "UNSUPPORTED_SCHEMA_VERSION")

    def test_unknown_extra_fields_fail(self):
        data = good()
        data["permission_to_restore"] = True
        self.assertBlocked(data, "UNEXPECTED_OR_MISSING_FIELDS")

    def test_missing_backup_volume(self):
        data = good()
        data["evidence"]["backup_includes_db_env_files"] = False
        self.assertBlocked(data, "NOT_VERIFIED_BACKUP_INCLUDES_DB_ENV_FILES")

    def test_false_approval_string_never_counts(self):
        data = good()
        data["evidence"]["caregiver_write_freeze_confirmed"] = "true"
        self.assertBlocked(data, "NOT_VERIFIED_CAREGIVER_WRITE_FREEZE_CONFIRMED")

    def test_unverified_key_media(self):
        data = good()
        data["evidence"]["source_key_configuration_identity_verified"] = False
        data["evidence"]["media_ciphertext_and_readability_verified"] = False
        self.assertBlocked(data, "NOT_VERIFIED_SOURCE_KEY_CONFIGURATION_IDENTITY_VERIFIED")

    def test_missing_offline_device_reconciliation(self):
        data = good()
        data["evidence"]["all_disconnected_devices_reconciled"] = False
        self.assertBlocked(data, "NOT_VERIFIED_ALL_DISCONNECTED_DEVICES_RECONCILED")

    def test_missing_post_cutover_coverage(self):
        data = good()
        data["evidence"]["online_write_coverage_complete"] = None
        self.assertBlocked(data, "NOT_VERIFIED_ONLINE_WRITE_COVERAGE_COMPLETE")

    def test_post_cutover_online_write_preserved(self):
        data = good()
        data["counts"]["online_writes_since_backup"] = 1
        result = module.evaluate(data)
        self.assertEqual(result["decision"], "PRESERVE_WRITES_ROLL_FORWARD_OR_RECONCILE")
        self.assertBlocked(data, "UNRECONCILED_ONLINE_WRITES_SINCE_BACKUP")

    def test_queued_offline_write_preserved(self):
        data = good()
        data["counts"]["unreconciled_offline_writes"] = 4
        result = module.evaluate(data)
        self.assertEqual(result["decision"], "PRESERVE_WRITES_ROLL_FORWARD_OR_RECONCILE")
        self.assertBlocked(data, "UNRECONCILED_UNRECONCILED_OFFLINE_WRITES")

    def test_negative_write_count_is_unknown(self):
        data = good()
        data["counts"]["online_writes_since_backup"] = -1
        self.assertBlocked(data, "WRITE_COUNT_UNKNOWN_ONLINE_WRITES_SINCE_BACKUP")

    def test_boolean_count_is_unknown(self):
        data = good()
        data["counts"]["online_writes_since_backup"] = False
        self.assertBlocked(data, "WRITE_COUNT_UNKNOWN_ONLINE_WRITES_SINCE_BACKUP")

    def test_non_numeric_string_count_is_unknown(self):
        data = good()
        data["counts"]["unreconciled_offline_writes"] = "0"
        self.assertBlocked(data, "WRITE_COUNT_UNKNOWN_UNRECONCILED_OFFLINE_WRITES")

    def test_partial_counts_fail(self):
        data = good()
        data["counts"] = {"online_writes_since_backup": 0}
        self.assertBlocked(data, "WRITE_COUNTS_INCOMPLETE")

    def test_missing_backup_checksum_fails(self):
        data = good()
        data["evidence"]["private_backup_sha256_verified"] = False
        self.assertBlocked(data, "NOT_VERIFIED_PRIVATE_BACKUP_SHA256_VERIFIED")

    def test_cli_synthetic_never_authorizes_restore(self):
        with tempfile.TemporaryDirectory(prefix="sat-hotfix-rollback-test-") as folder:
            p = Path(folder)/"fixture.json"
            p.write_text(json.dumps(good()), encoding="utf-8")
            result = subprocess.run([sys.executable, str(SCRIPT), "--synthetic", "--evidence", str(p)],
                                    capture_output=True, text=True, timeout=15)
            self.assertEqual(result.returncode, 0, result.stderr)
            data = json.loads(result.stdout)
            self.assertEqual(data["mode"], "SYNTHETIC_POLICY_CHECK")
            self.assertFalse(data["production_restore_authorized"])
            self.assertFalse(data["automatic_restore_allowed"])

    def test_repository_evidence_template_is_deliberately_blocked(self):
        template = ROOT / "docs" / "feedback-hotfix-rollback-evidence.template.json"
        self.assertTrue(template.is_file())
        data = json.loads(template.read_text(encoding="utf-8"))
        self.assertBlocked(data, "NOT_VERIFIED_PRIVATE_BACKUP_SHA256_VERIFIED")
        result = subprocess.run([sys.executable, str(SCRIPT), "--synthetic", "--evidence", str(template)],
                                capture_output=True, text=True, timeout=15)
        self.assertEqual(result.returncode, 2)
        self.assertFalse(json.loads(result.stdout)["production_restore_authorized"])

    def test_cli_malformed_json_fails_closed(self):
        with tempfile.TemporaryDirectory(prefix="sat-hotfix-rollback-test-") as folder:
            p = Path(folder)/"bad.json"
            p.write_text("{ invalid", encoding="utf-8")
            result = subprocess.run([sys.executable, str(SCRIPT), "--synthetic", "--evidence", str(p)],
                                    capture_output=True, text=True, timeout=15)
            self.assertNotEqual(result.returncode, 0)
            self.assertFalse(json.loads(result.stdout)["production_restore_authorized"])

    def test_cli_rejects_apply_argument(self):
        with tempfile.TemporaryDirectory(prefix="sat-hotfix-rollback-test-") as folder:
            p = Path(folder)/"fixture.json"
            p.write_text(json.dumps(good()), encoding="utf-8")
            result = subprocess.run([sys.executable, str(SCRIPT), "--evidence", str(p), "--apply"],
                                    capture_output=True, text=True, timeout=15)
            self.assertNotEqual(result.returncode, 0)
            self.assertNotIn("production_restore_authorized\": true", result.stdout)


if __name__ == "__main__":
    unittest.main()
