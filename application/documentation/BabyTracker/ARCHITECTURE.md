# Architecture decision: Sprout remains authoritative

## Source boundary

Keep the deployment repository and application derivative separate. The derivative
retains the exact deployed Sprout revision as its base and an `upstream` Git remote.
New OCR code lives under `src/lib/ocr`, `src/components/OcrImport` and
`app/api/ocr`. Existing edits are limited to additive schema/migration, navigation,
localization, build packaging and CI. The inherited Docker Hub publishing workflow
is explicitly restricted to the upstream owner's repository.

## Data boundary

One family identity, one child identity, one canonical care-event store.
`OcrDocument` is a staging/provenance object, not another infant-care database.
`OcrAudit` holds append-only encrypted snapshots of upload, review, commit and purge
actions. Client-supplied family IDs never choose the authorized family.

| Review value | Canonical Sprout destination | Notes |
| --- | --- | --- |
| Feeding | `FeedLog` through `executeExternalImport` | Time, method, quantity, ML/OZ, milk designation and notes preserved |
| Diaper | `DiaperLog` through `executeExternalImport` | Type and reviewed notes; stool description retained in notes |
| Sleep | `SleepLog` through `executeExternalImport` | Explicit start/end, nap/night designation, notes |
| Document/row identity | `ExternalImportRecord` | Family + provider + child/file hash/source row; original IDs remain unchanged |
| Original bytes | Encrypted `Files/ocr` | Authenticated source endpoint only; never a public static asset |
| Extracted values and corrections | Encrypted `OcrDocument`/`OcrAudit` | Immutable originals distinguished from reviewed values |

All approved rows are validated before any write. A transaction claims the review
revision, checks duplicates, creates canonical events and provenance, and records
the receipt. A later-row failure rolls everything back. A repeated identical
request returns the existing receipt. A different request against a committed
document is rejected. Potential duplicates are warnings requiring explicit keep
or skip; they are never silently merged or deleted. All-skipped reviews receive a
zero-created receipt.

## Existing Baby Buddy functionality

Sprout **1.6.7 already contains** a Baby Buddy CSV importer, per-child destination
mapping, unit selection, transactional execution and source provenance, with
dedicated parsing/mapping/execution tests. Its modules are under
`src/lib/importers/baby-buddy`, `src/components/ExternalImport`, and
`app/api/import/external`. Do not implement this importer a second time.

| Capability | Verified source baseline | Remaining BabyTracker work |
| --- | --- | --- |
| Feeding, diaper, sleep, pumping, tummy time | Existing Sprout routes/models and Baby Buddy mapping/tests | Private device acceptance and import parity evidence |
| Growth/temperature/notes/medication imports | Existing Baby Buddy mapping modules/tests | Compare source exports and edge semantics before marking parity accepted |
| Milk inventory, foods/allergens, milestones, vaccines, photos | Existing Sprout routes/models | Versioned behavior matrix, corrected-age audit |
| Timers, reporting and export | Existing Sprout components/routes | Mobile/offline behavior acceptance and targeted differences |
| OCR import | This derivative | Representative handwriting evaluation, staging and release gates |
| Adaptive next-nap prediction | No BabyTracker prediction engine accepted | Independently implement and evaluate against a simple baseline |
| Monai viewing | Separate `MulattoTech/Monai-RTC` project | Authenticated on-demand stream adapter; no continuous transcoding |

This is a source inventory, not a declaration of feature acceptance. Existing
Sprout features must be tested before opening duplicate implementation issues.

## Upgrade and rollback

The OCR migration only creates `OcrDocument`, `OcrAudit` and their indexes. It does
not rewrite infant events or their IDs/timestamps. Never run it against production
as a development test. Qualify upgrades on disposable synthetic storage first,
then on a protected restore of the owner's backup under the production process.

Rollback is to the previously pinned image with the same three persistent volumes.
Leave additive OCR tables in place; do not down-migrate or delete imported events.
The older app can still read canonical care events. Confirm its startup/migration
behavior against staging before calling rollback verified. Backups must include
`ENC_HASH`; otherwise encrypted source/audit state cannot be restored.

## Next modules

Build Baby Buddy compatibility, sleep estimates and camera adapters against these
existing domain boundaries. Do not merge another application database or copy
proprietary Huckleberry code. Ordinary tracking must continue when optional modules
are disabled or unavailable. Corrected-age display and clinical information require
their own evidence and review; OCR does not infer a child's age or clinical needs.
