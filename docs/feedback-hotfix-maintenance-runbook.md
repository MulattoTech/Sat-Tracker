# Sat-Tracker feedback-attachment security hotfix — maintenance and rollback plan

**Status: PLAN / NOT A LIVE RELEASE.** This runbook describes safeguards to
prepare for later, separately approved maintenance. Reading it or running its
synthetic policy tests does not authorize a production backup, service restart,
preview replacement, routing change, restore, or deployment.

## Exact release scope

- Canonical repository: `MulattoTech/Sat-Tracker`
- Observed deployed source: `b24ccc9cd70076cb1d8e0fed477e14d0cf533444`
- Maintenance branch: `release/feedback-security-b24ccc9`
- Release commit: `f3ea00e6161f887d4802f2a41238eb6a36d8103c`
- Pinned image: `ghcr.io/mulattotech/babytracker-master@sha256:7521979f4e9af6b5c9ee6cbfa1ec1ec8adb812b5ee2ce915e22168343c2f4cad`
- Previously running image ID: `sha256:1b4f57866debda9557d3ef073be61332f4440702daa5e8786245b198ea821756`
- Target production container: `babytracker-sprout`
- Existing protected preview: `babytracker-ocr-staging` (must remain unchanged)
- Three original production volumes: `babytracker-sprout-db`,
  `babytracker-sprout-env`, `babytracker-sprout-files`
- Current host listener as configured in `compose.yaml`: loopback
  `127.0.0.1:${BABYTRACKER_PORT:-3123}:3000`; do not alter existing
  Tailscale/Cloudflare access paths.

The image is built from the original production source plus the narrow family
authorization guard and regression test only. No database schema or migration
changes are bundled in the source diff. Rebuilt image layers and dependencies
can still behave differently; exact-image rehearsal and backup gates matter.

Existing `scripts/promote-release.ps1 -Apply` is **not usable unchanged**: its
checks insist on `main`, then replace the existing protected preview and call
production update/backup. `scripts/update-babytracker.ps1` also verifies
the main checkout's revision and old publishing alias before applying; it is
not a safe shortcut for this branch. Neither is changed by this runbook.

## Verified pre-maintenance evidence (not live release evidence)

1. PR #107 merged on the dedicated release branch. Exact release-branch
   acceptance and operations CI passed; the image was published and verified.
2. The published image passed **7/7 synthetic real HTTP family-isolation
   checks**: owner GET 200, anonymous GET 401, unrelated-family ADMIN GET/DELETE
   404, and ciphertext/database unchanged.
3. A **disposable old-image to published-hotfix startup test** using an isolated
   network and three new synthetic volumes passed: 67 original tables, 493
   seeded records and 85 migration-history entries unchanged; SQLite integrity
   and foreign-key verification passed. No representative historical care or
   retained media were present in that seed.
4. `scripts/feedback-hotfix-release-preflight.ps1` is a read-only check of
   immutable revision, digest, CI/publisher, local OCI provenance, original
   container health and separate volume identities. It never deploys or
   verifies confidential data.
5. Current broad `main` feature changes and their migrations are NOT part of
   this maintenance image. Do not substitute a new `main` image for this
   pinned security hotfix.

## Phase 1 — require a new, explicit maintenance/backup approval

Before touching production, the owner must receive an itemized proposal naming
the exact candidate image/commit, production target, whether the protected
preview will be left alone (it must), expected unavailability, write freeze,
private backup destination, restore verification, and risks. The current
`scripts/backup.ps1` **stops and restarts** the production `sprout` Compose
service. This is a real interruption, not a read-only operation. A generic
source-development approval does not authorize it.

Quiescence requires all caregivers to stop entering new care records, safely
finish/record active timers, reconcile any disconnected devices and pending
offline operations, and maintain the freeze throughout snapshot/cutover.
A device that cannot be checked is an **unknown pending-write risk** and
blocks cold-restore assumptions. Avoid silently losing a feed, sleep, medicine,
diaper, or care entry while the UI is unavailable.

## Phase 2 — acquire and verify one pinned confidential snapshot (later only)

Only after the above itemized approval:

- Record the exact production image/container ID, start identity, health and
  mounts. Do not delete or replace any of the original three volumes.
- Under the announced write freeze and service-stop allowance, produce a
  consistent backup of **all three volumes**: SQLite DB (including related
  logging database/WAL consistency), environment/encryption configuration, and
  retained encrypted media. Treat the archive as highly sensitive; use an
  access-restricted private location, no GitHub artifact, public cloud link,
  conversation attachment, or synthetic-preview copy.
- Pin the **exact** archive filename, size and SHA-256 digest in a private
  maintenance receipt. Preserve the old immutable image and stop/restart
  receipts. Check that the backup was created during the intended service
  quiescence and contains only the expected volume roots. Refuse suspicious
  tar paths, symlinks, or extras before restoration.
- Restore that **same pinned archive** to fresh, isolated, access-restricted
  volumes without mounting existing production or protected preview volumes.
  Check SQLite `integrity_check` and foreign keys for every database,
  environment/key identity by hash without exposing secrets, retained
  ciphertext counts/digests, and decryption/readability where authorized.
- Do not call unmodified `scripts/test-restore.ps1` as proof of this exact
  snapshot: it chooses the *newest* `babytracker-snapshot-*.tar.gz` without an
  explicit archive selector and checks DB/env but not every media byte.
  Any future approved restoration verifier must select the checksum-pinned
  archive and prove the media/key checks, with safe cleanup receipts.
- Check post-backup online/offline writes, including entries queued during
  temporary unavailability. Unknown count means release or cold rollback
  **cannot be considered safe** without reconciliation.

No step in this phase has been executed on production under the source-only
approval that created this document.

## Phase 3 — separate deployment approval and narrow cutover

A second, specific owner approval must name the pinned image digest,
production service `babytracker-sprout`, expected maintenance interruption,
verified backup/restore and write-quiescence receipts, previously running
image, rollback decisions, and post-release verification. It must be granted
**after** Phase 2 evidence is complete; earlier generic approvals do not count.

The future maintenance-branch-aware executor must be independently reviewed,
fail closed on moved refs and stale health/volume identity, never update
`babytracker-ocr-staging`, and operate only on the explicitly authorized
production target under a fresh lock. Use no unreviewed local re-build.
Preserve configuration, volumes, exact image ID and original live records.
No automatic rollback, historical database overwrite or fallback to a broad
feature image.

Following separately approved cutover, confirm the actual running digest,
health, authentication, unmodified volume mount identities and source guard.
Verify family-attachment isolation with authorized non-household synthetic
testing or independently approved noninvasive checks; do not probe or expose
other families' actual attachments. Record post-cutover writes and device queue
state before any rollback decision. No change to Cloudflare/DNS/Tailscale.

## Phase 4 — write-preserving rollback decision (never automatic)

This repository includes `scripts/feedback_hotfix_rollback_decision.py`.
It accepts only a sanitized JSON of aggregate counts and verification booleans;
it never contacts a live system, processes backups, grants approval, or
executes a restore. Do not put family identifiers, care rows, medical notes,
image bytes, credentials, encryption keys or archive paths in its input.

- **Any online write since backup** (including the gap between snapshot and
  cutover), any unreconciled offline write, or unresolved queue => preserve
  current state and plan a reviewed **roll-forward or reconciliation**;
  blindly restoring the old backup would erase later care data.
- Missing/incomplete snapshot, restored-data, encryption/media, freeze, device,
  or write-coverage evidence => **cold restore blocked**.
- Even if the checked snapshot and all write counts are verified, the result
  can only be **cold restore requires a NEW owner approval**, not permission
  to execute anything. A rollback must also be specifically reviewed for
  compatibility with the currently running image and schema.

Run the **synthetic-only** policy checker without touching production:

```powershell
python -m unittest discover -s tests/ops -p test_feedback_hotfix_rollback_decision.py -v
```

The repository provides a deliberately blocked, all-false example at
[feedback-hotfix-rollback-evidence.template.json](feedback-hotfix-rollback-evidence.template.json).
Do not commit completed evidence to GitHub, and do not confuse its default
unknown write counts with verified zero writes.

A future authorized operator may supply a private *sanitized* JSON summary
with schema version 1, exact release identity, all required booleans, and
nonnegative integer counts. The command is deliberately plan-only:

```powershell
python scripts/feedback_hotfix_rollback_decision.py --evidence <private-sanitized-evidence.json>
```

Use `--synthetic` for fixture checks, not real authorization. Supplying even
a fully green evidence file **never authorizes deployment or restore**.
`--apply` is intentionally unsupported.

## Explicit open gates

- Live consistent backup with separate approval: **NOT RUN**
- Checksum-pinned private isolated restore, retained encrypted media/key check:
  **NOT RUN**
- Real-history care/media, offline-device replay/write preservation:
  **NOT QUALIFIED**
- Release-branch-aware production cutover tool, independent source review and
  bounded synthetic executor tests: **NOT YET IMPLEMENTED**
- Production activation and post-deploy privacy proof: **NOT APPROVED / NOT RUN**

Keep security issue #25 and release readiness issue #50 open. The only
source-complete work in this package is a non-executing rollback decision gate,
synthetic tests, and this maintenance plan.
