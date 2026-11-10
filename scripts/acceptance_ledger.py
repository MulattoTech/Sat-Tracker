#!/usr/bin/env python3
"""Validate the public acceptance ledger and report evidence acceptance, not code completion."""
import argparse
import json
import re
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
STATUSES = {"VERIFIED PASS", "IN PROGRESS", "BLOCKED", "NOT IMPLEMENTED"}
KINDS = ("tests", "preview", "production", "device")
PHYSICAL_CONTRACTS = {"SYNC-001", "JRN-001", "SETUP-001"}

def text(value):
    return isinstance(value, str) and bool(value.strip())

def revision(value):
    return isinstance(value, str) and bool(re.fullmatch(r"[a-f0-9]{40}", value))

def string_list(value, nonempty=False):
    return isinstance(value, list) and (bool(value) or not nonempty) and all(text(item) for item in value)

def validate(ledger):
    errors = []
    if not isinstance(ledger, dict):
        return ["Expected a ledger object."], None
    rows = ledger.get("requirements")
    if ledger.get("schemaVersion") != 1 or not isinstance(rows, list) or not rows:
        return ["Expected nonempty version-1 requirements."], None
    if not revision(ledger.get("asOfSourceRevision")):
        errors.append("Ledger must identify a full source revision.")
    if not text(ledger.get("scopeVersion")) or not isinstance(ledger.get("scopeComplete"), bool):
        errors.append("Explicit versioned scope is required.")
    seen = set()
    required = []
    for index, row in enumerate(rows):
        if not isinstance(row, dict):
            errors.append(f"Requirement at index {index} must be an object.")
            continue
        identity = row.get("id", "")
        if not isinstance(identity, str) or not re.fullmatch(r"[A-Z]+-\d{3}", identity):
            errors.append(f"Invalid requirement ID at index {index}.")
            identity = f"index-{index}"
        elif identity in seen:
            errors.append(f"Invalid or duplicate requirement ID: {identity}")
        seen.add(identity)
        if type(row.get("required")) is not bool:
            errors.append(f"{identity}: required must be explicit boolean.")
        elif row["required"]:
            required.append(row)
        if not isinstance(row.get("status"), str) or row["status"] not in STATUSES:
            errors.append(f"{identity}: unsupported status.")
        if row.get("priority") not in ("P0", "P1", "P2", "P3"):
            errors.append(f"{identity}: unsupported priority.")
        if not text(row.get("title")) or not isinstance(row.get("source"), dict) or not row["source"] \
                or not string_list(row.get("acceptanceCriteria"), nonempty=True):
            errors.append(f"{identity}: title, source and acceptance criteria required.")
        if not string_list(row.get("implementationReferences")):
            errors.append(f"{identity}: implementation references must be a string list.")
        if not isinstance(row.get("remainingWork"), str):
            errors.append(f"{identity}: remaining work must be an explicit string.")
        evidence = row.get("evidence", {})
        if not isinstance(evidence, dict):
            errors.append(f"{identity}: evidence must be an object.")
            evidence = {}
        if not all(isinstance(evidence.get(kind), list) for kind in KINDS):
            errors.append(f"{identity}: all evidence categories must be explicit lists.")
        required_evidence = row.get("requiredEvidence")
        if not string_list(required_evidence, nonempty=True) or "tests" not in required_evidence:
            errors.append(f"{identity}: nonempty test evidence requirements must be explicit.")
            required_evidence = ["tests", "preview", "production"]
        elif len(set(required_evidence)) != len(required_evidence) or any(kind not in KINDS for kind in required_evidence):
            errors.append(f"{identity}: evidence requirements must be unique supported categories.")
        physical = identity.startswith("DEV-") or identity in PHYSICAL_CONTRACTS
        if physical and "device" not in required_evidence:
            errors.append(f"{identity}: physical device evidence cannot be omitted.")
        device_models = set()
        synchronized_device_count = 0
        for kind in KINDS:
            items = evidence.get(kind)
            if not isinstance(items, list):
                continue
            for item in items:
                if not isinstance(item, dict) or not text(item.get("reference")) or not text(item.get("scope")):
                    errors.append(f"{identity}: evidence needs reference and explicit scope.")
                    continue
                if not revision(item.get("revision")):
                    errors.append(f"{identity}: evidence needs source revision.")
                if kind == "device":
                    if item.get("environment") != "physical-device" or not string_list(item.get("deviceModels"), nonempty=True):
                        errors.append(f"{identity}: device evidence needs physical-device environment and device models.")
                    else:
                        device_models.update(re.sub(r"[^a-z0-9]", "", model.lower()) for model in item["deviceModels"])
                        count = item.get("physicalDeviceCount")
                        if count is not None and (type(count) is not int or count < 1):
                            errors.append(f"{identity}: physical device count must be a positive integer.")
                        elif type(count) is int:
                            synchronized_device_count = max(synchronized_device_count, count)
        if row.get("status") == "VERIFIED PASS":
            if row.get("remainingWork"):
                errors.append(f"{identity}: PASS cannot retain unresolved work.")
            if not row.get("implementationReferences"):
                errors.append(f"{identity}: PASS needs implementation references.")
            for kind in required_evidence:
                items = evidence.get(kind)
                if kind not in KINDS or not isinstance(items, list) or not items:
                    errors.append(f"{identity}: PASS missing required {kind} evidence.")
            if identity == "SYNC-001" and synchronized_device_count < 2:
                errors.append(f"{identity}: family synchronization needs a test with two physical devices.")
            expected_model = {"DEV-001": "pixel10", "DEV-002": "pixel9", "DEV-003": "ipad"}.get(identity)
            if expected_model and not any(expected_model in model for model in device_models):
                errors.append(f"{identity}: physical evidence must identify its required device model.")
        elif not row.get("remainingWork"):
            errors.append(f"{identity}: unaccepted contract needs remaining work.")
    counts = Counter(row.get("status") for row in required if isinstance(row.get("status"), str))
    total = len(required)
    if total == 0:
        errors.append("Required denominator must not be empty.")
    summary = {
        "scopeVersion": ledger.get("scopeVersion"),
        "asOfRelease": ledger.get("asOfRelease"),
        "asOfSourceRevision": ledger.get("asOfSourceRevision"),
        "totalContracts": len(rows),
        "totalRequired": total,
        "desiredContracts": len(rows) - total,
        "verifiedPass": counts["VERIFIED PASS"] if not errors else None,
        "claimedPass": counts["VERIFIED PASS"],
        "inProgress": counts["IN PROGRESS"],
        "blocked": counts["BLOCKED"],
        "notImplemented": counts["NOT IMPLEMENTED"],
        "acceptancePercent": round(100 * counts["VERIFIED PASS"] / total, 2) if total and ledger.get("scopeComplete") and not errors else None,
        "complete": bool(total and ledger.get("scopeComplete") and counts["VERIFIED PASS"] == total and not errors),
        "meaning": "Evidence acceptance for whole contracts, not percentage of source implemented.",
    }
    return errors, summary

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("ledger", nargs="?", type=Path, default=ROOT / "docs/sat-tracker-acceptance-ledger.json")
    args = parser.parse_args()
    try:
        ledger = json.loads(args.ledger.read_text(encoding="utf-8-sig"))
        errors, summary = validate(ledger)
    except (OSError, ValueError) as exc:
        print(json.dumps({"valid": False, "errorType": type(exc).__name__}))
        return 1
    print(json.dumps({"valid": not errors, "errors": errors, "summary": summary}, indent=2))
    return bool(errors)

if __name__ == "__main__":
    raise SystemExit(main())
