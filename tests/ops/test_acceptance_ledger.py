import copy
import importlib.util
import json
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("acceptance_ledger", ROOT / "scripts/acceptance_ledger.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

class AcceptanceLedgerContracts(unittest.TestCase):
    def setUp(self):
        self.ledger = json.loads((ROOT / "docs/sat-tracker-acceptance-ledger.json").read_text(encoding="utf-8-sig"))

    def test_current_contract_and_original_scope_remain_valid(self):
        errors, summary = module.validate(self.ledger)
        self.assertEqual(errors, [])
        original = [r for r in self.ledger["requirements"] if r["id"].startswith("PAR-")]
        self.assertEqual(len(original), 77)
        self.assertEqual(sum(r["required"] for r in original), 76)
        self.assertEqual(summary["totalRequired"], sum(r["required"] for r in self.ledger["requirements"]))
        self.assertFalse(summary["complete"])

    def test_blocked_and_unimplemented_stay_in_denominator(self):
        self.ledger["scopeComplete"] = True
        _, before = module.validate(self.ledger)
        for row in self.ledger["requirements"]:
            if row["required"] and row["status"] != "VERIFIED PASS":
                row["status"] = "BLOCKED"
        errors, after = module.validate(self.ledger)
        self.assertEqual(errors, [])
        self.assertEqual(before["totalRequired"], after["totalRequired"])
        self.assertEqual(before["acceptancePercent"], after["acceptancePercent"])

    def test_missing_runtime_evidence_cannot_claim_pass(self):
        row = self.ledger["requirements"][0]
        row.update(status="VERIFIED PASS", remainingWork="", implementationReferences=["source"])
        row["evidence"]["tests"] = [{"reference":"synthetic","scope":"tests only","revision":"a"*40}]
        errors, _ = module.validate(self.ledger)
        self.assertTrue(any("preview evidence" in error for error in errors))
        self.assertTrue(any("production evidence" in error for error in errors))

    def test_physical_requirement_rejects_browser_only_evidence(self):
        row = next(r for r in self.ledger["requirements"] if r["id"] == "DEV-001")
        row.update(status="VERIFIED PASS", remainingWork="", implementationReferences=["source"], requiredEvidence=["tests","preview","production","device"])
        item = {"reference":"synthetic","scope":"browser emulation","revision":"a"*40}
        row["evidence"] = {kind: [item] for kind in ("tests","preview","production")}
        row["evidence"]["device"] = []
        errors, _ = module.validate(self.ledger)
        self.assertTrue(any("device evidence" in error for error in errors))

    def test_incomplete_scope_cannot_produce_percentage_or_completion(self):
        self.ledger["scopeComplete"] = False
        errors, summary = module.validate(self.ledger)
        self.assertEqual(errors, [])
        self.assertIsNone(summary["acceptancePercent"])
        self.assertFalse(summary["complete"])

    def test_empty_evidence_requirements_cannot_bypass_proof(self):
        row = self.ledger["requirements"][0]
        row.update(status="VERIFIED PASS", remainingWork="", implementationReferences=["source"], requiredEvidence=[])
        errors, _ = module.validate(self.ledger)
        self.assertTrue(any("nonempty" in error for error in errors))

    def test_duplicates_and_unresolved_pass_are_rejected(self):
        self.ledger["requirements"][1]["id"] = self.ledger["requirements"][0]["id"]
        passed = next(r for r in self.ledger["requirements"] if r["status"] == "VERIFIED PASS")
        passed["remainingWork"] = "Still needs proof"
        errors, _ = module.validate(self.ledger)
        self.assertTrue(any("duplicate" in error for error in errors))
        self.assertTrue(any("unresolved" in error for error in errors))

    def test_invalid_claims_never_emit_verified_count_or_acceptance_percentage(self):
        self.ledger["scopeComplete"] = True
        for row in self.ledger["requirements"]:
            row.update(status="VERIFIED PASS", remainingWork="", implementationReferences=["source"])
        errors, summary = module.validate(self.ledger)
        self.assertTrue(errors)
        self.assertEqual(summary["claimedPass"], summary["totalRequired"])
        self.assertIsNone(summary["verifiedPass"])
        self.assertIsNone(summary["acceptancePercent"])
        self.assertFalse(summary["complete"])

    def test_physical_contracts_cannot_drop_device_requirement_while_still_open(self):
        for identity in ["DEV-001", "DEV-002", "DEV-003", "SYNC-001", "JRN-001", "SETUP-001"]:
            with self.subTest(identity=identity):
                ledger = copy.deepcopy(self.ledger)
                row = next(r for r in ledger["requirements"] if r["id"] == identity)
                row["requiredEvidence"] = ["tests", "preview", "production"]
                errors, summary = module.validate(ledger)
                self.assertTrue(any("physical device evidence cannot be omitted" in e for e in errors))
                self.assertIsNone(summary["verifiedPass"])

    def test_emulation_cannot_be_renamed_device_evidence(self):
        row = next(r for r in self.ledger["requirements"] if r["id"] == "DEV-001")
        row.update(status="VERIFIED PASS", remainingWork="", implementationReferences=["source"])
        item = {"reference":"synthetic","scope":"browser emulation","revision":"a"*40}
        row["evidence"] = {kind: [dict(item)] for kind in module.KINDS}
        row["evidence"]["device"][0].update(environment="browser-emulation", deviceModels=["Pixel 10"])
        errors, _ = module.validate(self.ledger)
        self.assertTrue(any("physical-device environment" in e for e in errors))

    def test_actual_device_evidence_must_name_the_requested_model(self):
        row = next(r for r in self.ledger["requirements"] if r["id"] == "DEV-001")
        row.update(status="VERIFIED PASS", remainingWork="", implementationReferences=["source"])
        item = {"reference":"synthetic","scope":"fixture only","revision":"a"*40}
        row["evidence"] = {kind: [dict(item)] for kind in module.KINDS}
        row["evidence"]["device"][0].update(environment="physical-device", deviceModels=["iPad"])
        errors, _ = module.validate(self.ledger)
        self.assertTrue(any("required device model" in e for e in errors))
        row["evidence"]["device"][0]["deviceModels"] = ["Google Pixel 10"]
        errors, _ = module.validate(self.ledger)
        self.assertEqual(errors, [])

    def test_synchronization_needs_two_devices_but_can_use_same_model(self):
        row = next(r for r in self.ledger["requirements"] if r["id"] == "SYNC-001")
        row.update(status="VERIFIED PASS", remainingWork="", implementationReferences=["source"])
        item = {"reference":"synthetic","scope":"fixture only","revision":"a"*40}
        row["evidence"] = {kind: [dict(item)] for kind in module.KINDS}
        device = row["evidence"]["device"][0]
        device.update(environment="physical-device", deviceModels=["Pixel 10"], physicalDeviceCount=1)
        errors, _ = module.validate(self.ledger)
        self.assertTrue(any("two physical devices" in e for e in errors))
        device["physicalDeviceCount"] = 2
        errors, _ = module.validate(self.ledger)
        self.assertEqual(errors, [])

    def test_malformed_json_types_produce_errors_instead_of_crashing(self):
        for bad in [None, [], "ledger", 3]:
            with self.subTest(root=bad):
                errors, summary = module.validate(bad)
                self.assertTrue(errors)
                self.assertIsNone(summary)
        mutations = [
            lambda d: d["requirements"].append(None),
            lambda d: d.update(asOfSourceRevision=[]),
            lambda d: d["requirements"][0].update(id=[]),
            lambda d: d["requirements"][0].update(status=[]),
            lambda d: d["requirements"][0].update(evidence=[]),
            lambda d: d["requirements"][0].update(requiredEvidence=[[]]),
            lambda d: d["requirements"][0]["evidence"].update(tests=[{"reference": "test", "scope": "test", "revision": []}]),
        ]
        for mutate in mutations:
            ledger = copy.deepcopy(self.ledger)
            mutate(ledger)
            errors, summary = module.validate(ledger)
            self.assertTrue(errors)
            self.assertIsNone(summary["verifiedPass"])
            self.assertIsNone(summary["acceptancePercent"])

if __name__ == "__main__":
    unittest.main()
