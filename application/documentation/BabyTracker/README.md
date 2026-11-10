# BabyTracker application derivative

This repository is the application source for BabyTracker, based on **Sprout Track
1.6.7**, upstream commit `462246d9653c805cac87ee4e860fec7b54367f8a`.
Deployment, backups and the roadmap remain in `MulattoTech/BabyTracker`.

Copyright for Sprout Track remains with John Overton and Oak and Sprout. This is a
modified derivative, not an upstream-endorsed product. The original
[Sprout Track license](../../LICENSE.md), attribution, non-commercial and
share-alike terms are retained. Do not change repository visibility without a
history/privacy review and the owner's explicit confirmation.

## Implemented slice

- Local English OCR for JPEG, PNG, WebP and up to six PDF pages.
- Native Tesseract and Poppler with Linux `prlimit`; no external AI service or document transfer.
- Source signature/size/pixel/page limits, explicit rotation, EXIF orientation,
  contrast normalization, bounded child processes and one active job per family.
- Source-page preview, editable feeding/diaper/sleep candidates, uncertainty,
  original text and field provenance. Explicit row approval and final confirmation.
- Saved draft revisions, field corrections, source encryption and encrypted audit snapshots.
- Family-scoped, transactional writes through Sprout's existing import executor.
- File-hash deduplication, near-time duplicate warnings, explicit keep/skip choices,
  idempotent commit receipts and concurrency protection.
- Daylight-saving repeated/missing clock handling; an offset must be chosen when
  a clock repeats. No guessed dates, AM/PM or midnight rollover.

The UI is at `/<family-slug>/ocr-import` and is linked in the administrator menu.
Select a child first. Every row begins unapproved. Editing a field, date, time zone
or repeated-clock occurrence clears the corresponding approval.

Confirmation finalizes the whole document. Unchecked rows are excluded and cannot
be resumed from the same document afterward; the UI warns before confirmation.

**This is not yet an accepted sloppy-handwriting recognizer.** Tesseract is a
printed-text baseline. Hard handwriting can yield incorrect text or no useful
candidate. The original remains visible for manual transcription. Representative
family forms must be evaluated privately before claiming handwriting acceptance.
No real family records, images or camera footage belong in this repository.

## Tests

```sh
npm ci
npm run prisma:generate
npm run prisma:generate:log
npx tsc --noEmit --incremental false
npm test
npm run build
```

OCR integration tests require Tesseract, Poppler, DejaVu fonts and the pinned
English model described in [OCR engines](OCR_ENGINES.md). The tests create
disposable SQLite databases and synthetic documents. They do not connect to the
production application. The `BabyTracker acceptance` Actions workflow runs the
same gate. A locally green run does not establish hosted CI acceptance.

## Operational boundaries

- Production remains on its existing pinned image until review, staging,
  backup/restore and CI gates are satisfied.
- `BABYTRACKER_OCR_ENABLED=false` disables import routes without changing tracking.
- OCR adds two tables; care events remain in `FeedLog`, `DiaperLog` and `SleepLog`.
- Original and preview files use Sprout's existing AES-256-GCM file encryption and
  persistent `Files` volume. Draft/original/audit state is encrypted using the same
  key, with family/document-associated authentication data.
- Back up the database, encryption/configuration volume and file volume together.
- Default binary-source retention is 30 days, selected at upload (1–365 days).
  Expired originals are refused on access and a startup/five-minute maintenance
  loop physically removes expired originals (100 documents per sweep). Orphaned
  encrypted files from interrupted uploads/deleted families are removed after a
  one-hour grace period. Maintenance failures are reported without source content.
  Derived review and audit state remains encrypted for provenance. The UI offers
  immediate source removal without deleting canonical events.
- Native work is bounded to two documents per application process and one per
  family. Containers should also have an explicit CPU/RAM/PID budget. Horizontal
  replicas do not share the in-process job limit; use one OCR-enabled replica in
  this slice. Database revision/unique constraints still protect canonical commits.
- Native OCR/PDF child processes run with a 768 MiB address-space limit, 25 seconds
  CPU/wall limit per command and 64 MiB output-file limit. They fail closed if the
  Linux resource limiter is unavailable. Use the Linux container for recognition.

See [architecture and compatibility](ARCHITECTURE.md) and the GitHub roadmap's
existing OCR issues #11, #37, #38, #12, #25 and #29. Those issues stay open until
their full acceptance criteria are demonstrated.

Use the [isolated staging and browser verification instructions](STAGING.md)
before release. These describe the remaining production acceptance gates.
