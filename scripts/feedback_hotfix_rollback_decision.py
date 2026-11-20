#!/usr/bin/env python3
"""Pure, fail-closed rollback evidence triage for one pinned Sat-Tracker hotfix.

This is not a backup tool or a release/restore executor. It never contacts
production, Docker, GitHub, or the network and never authorizes an operation.
Only minimal, sanitized booleans and aggregate counts are accepted.
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

SCHEMA_VERSION = 1
RELEASE = {
    "release_revision": "f3ea00e6161f887d4802f2a41238eb6a36d8103c",
    "production_baseline": "b24ccc9cd70076cb1d8e0fed477e14d0cf533444",
    "candidate_image": "ghcr.io/mulattotech/babytracker-master@sha256:7521979f4e9af6b5c9ee6cbfa1ec1ec8adb812b5ee2ce915e22168343c2f4cad",
    "previous_image_id": "sha256:1b4f57866debda9557d3ef073be61332f4440702daa5e8786245b198ea821756",
}
REQUIRED_EVIDENCE = (
    "private_backup_sha256_verified",
    "backup_includes_db_env_files",
    "fresh_isolated_restore_verified",
    "sqlite_integrity_and_foreign_keys_verified",
    "media_ciphertext_and_readability_verified",
    "source_key_configuration_identity_verified",
    "previous_image_available",
    "caregiver_write_freeze_confirmed",
    "write_freeze_unbroken_since_backup",
    "online_write_coverage_complete",
    "offline_queue_coverage_complete",
    "all_disconnected_devices_reconciled",
)
COUNTS = (
    "online_writes_since_backup",
    "unreconciled_offline_writes",
)
TOP_KEYS = frozenset({"schema_version", "release", "evidence", "counts"})
MAX_BYTES = 65536


def evaluate(data: Any) -> dict[str, Any]:
    """Return only a non-executable policy decision (never authorizes restore)."""
    blockers: list[str] = []
    writes: list[str] = []
    if not isinstance(data, dict):
        blockers.append("MALFORMED_EVIDENCE")
        data = {}

    if set(data) != TOP_KEYS:
        blockers.append("UNEXPECTED_OR_MISSING_FIELDS")
    if type(data.get("schema_version")) is not int or data.get("schema_version") != SCHEMA_VERSION:
        blockers.append("UNSUPPORTED_SCHEMA_VERSION")

    release = data.get("release")
    if not isinstance(release, dict) or set(release) != set(RELEASE):
        blockers.append("RELEASE_IDENTITY_INCOMPLETE")
    else:
        for field, expected in RELEASE.items():
            if type(release.get(field)) is not str or release[field] != expected:
                blockers.append("RELEASE_" + field.upper() + "_MISMATCH")

    evidence = data.get("evidence")
    if not isinstance(evidence, dict) or set(evidence) != set(REQUIRED_EVIDENCE):
        blockers.append("EVIDENCE_COVERAGE_INCOMPLETE")
    else:
        for name in REQUIRED_EVIDENCE:
            if evidence.get(name) is not True:
                blockers.append("NOT_VERIFIED_" + name.upper())

    counts = data.get("counts")
    if not isinstance(counts, dict) or set(counts) != set(COUNTS):
        blockers.append("WRITE_COUNTS_INCOMPLETE")
    else:
        for name in COUNTS:
            value = counts.get(name)
            if type(value) is not int or value < 0:
                blockers.append("WRITE_COUNT_UNKNOWN_" + name.upper())
            elif value > 0:
                writes.append("UNRECONCILED_" + name.upper())

    if writes:
        decision = "PRESERVE_WRITES_ROLL_FORWARD_OR_RECONCILE"
    elif blockers:
        decision = "COLD_RESTORE_BLOCKED_EVIDENCE_INCOMPLETE"
    else:
        decision = "COLD_RESTORE_REQUIRES_NEW_OWNER_APPROVAL"

    return {
        "schema_version": SCHEMA_VERSION,
        "decision": decision,
        "blockers": sorted(set(blockers + writes)),
        "evidence_is_self_attested": True,
        "deployment_authorized": False,
        "production_restore_authorized": False,
        "automatic_restore_allowed": False,
        "production_modified": False,
        "next_action": (
            "Preserve all current and queued care writes; investigate, reconcile, or prepare a reviewed roll-forward."
            if writes else
            "Complete missing evidence without accessing or changing live systems under this tool."
            if blockers else
            "Seek a NEW specifically scoped owner approval and independent operator review; do not execute a restore."
        ),
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Plan-only Sat-Tracker hotfix rollback policy")
    parser.add_argument("--evidence", required=True, type=Path,
                        help="Sanitized JSON summary; never include credentials or family data")
    parser.add_argument("--synthetic", action="store_true",
                        help="Label synthetic fixture checks explicitly; no live effects either way")
    args = parser.parse_args()
    try:
        if not args.evidence.is_file() or args.evidence.stat().st_size > MAX_BYTES:
            raise ValueError("file missing or oversized")
        data = json.loads(args.evidence.read_text(encoding="utf-8"))
    except (OSError, ValueError, UnicodeError, json.JSONDecodeError):
        print(json.dumps({
            "decision": "COLD_RESTORE_BLOCKED_EVIDENCE_INCOMPLETE",
            "blockers": ["EVIDENCE_FILE_INVALID"],
            "deployment_authorized": False,
            "production_restore_authorized": False,
            "automatic_restore_allowed": False,
        }, sort_keys=True))
        return 2
    decision = evaluate(data)
    decision["mode"] = "SYNTHETIC_POLICY_CHECK" if args.synthetic else "UNTRUSTED_MANUAL_EVIDENCE_TRIAGE"
    print(json.dumps(decision, sort_keys=True))
    return 0 if decision["decision"] == "COLD_RESTORE_REQUIRES_NEW_OWNER_APPROVAL" else 2


if __name__ == "__main__":
    sys.exit(main())
