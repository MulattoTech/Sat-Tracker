# Verified canonical deployment — 2026-10-28

BabyTracker is the single active application repository. The maintained application
is in `application/`, with deployment and backups at the root. The previous
BabyTracker-App main history is retained as merge ancestry; legacy branches and
uncommitted work have separate archive/recovery refs in this repository.

## Executed evidence
- Canonical image built from the imported, tested application source.
- Application: 1,490 tests across 118 files, TypeScript check, production build and
  hosted OCR browser acceptance passed.
- Private backup restored to isolated volumes with no network access. Existing
  records and encryption/authentication keys were preserved. The reference Unit
  table's startup-maintained updatedAt timestamps were refreshed; its contents
  and all application records were otherwise preserved.
- Production health passed; loopback home returned 200 and unauthenticated OCR
  access returned 401. Original production volumes, ports and HTTPS route retained.
- Staging is managed from this repository's application/compose.ocr-staging.yml.

## Controllers and agent workspaces
Both native controllers are maintained in MulattoTech/Fleet-Control-Hub, with
separate state and unchanged quota/emergency boundaries. The shared hub and both
controllers were restarted without launching agents; both fleets remained paused.
Existing BabyTracker agent workspaces were migrated to this canonical layout.
A compatibility checkout may retain its former BabyTracker-App folder name, but
its Git remote and native project repository binding now point to BabyTracker.
No worker sessions were destroyed. Unfinished OCR work remains unaccepted recovery
work, not a claim of implemented handwriting/Baby Buddy/sleep/camera parity.

## Safe updates
Use `scripts/update-babytracker.ps1 -ValidateOnly` for a read-only check. To deploy
an accepted clean checkout, use `scripts/update-babytracker.ps1 -Build`, or supply
an already-pulled image whose source/revision labels match the exact checkout.
It backs up and verifies restore before updating. Direct stock-upstream image
replacement is intentionally disabled; upstream releases still require review.
Never delete the three babytracker-sprout-* volumes to perform an update.

Private rollback snapshots, original task definitions and detailed migration
receipts remain outside Git on the authorized workstation. This public report
contains no baby records, secrets, prompts or runtime transcripts.
