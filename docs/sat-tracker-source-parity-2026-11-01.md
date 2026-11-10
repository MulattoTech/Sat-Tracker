# Sat Tracker source parity and OCR qualification

Evidence date: 2026-11-01 (America/Chicago).

## Scope and source of truth

The canonical application is `MulattoTech/BabyTracker-Master/application`.
This audit started at main `8636421b7573de5c70d98dc579cc4265fb9e88a0` (application version 1.6.7).
Official Sprout main reported 1.6.8; its upgrade is outside this focused change.
Baby Buddy core was inspected at `2bd0461f5a7e407147bcfef363eb79dce6c9708d`.

The parallel Bottle Journal work found the actual legacy implementation in
`Satele_Family_Sync_Source.zip` and the offline Windows source. Its authoritative
cloud backend is a Cloudflare Durable Object with SQLite. The offline client
uses `%LOCALAPPDATA%\\SateleBottleJournal\\journal.json`; that data file was not
present on the inspected PC. Finding source does not prove that all legacy
records have been migrated.

The unified Bottle Journal change is tracked in PR #58. It uses the existing
FeedLog tables and adds optional bottle metadata, per-child targets, a reviewed
legacy JSON/CSV import, and foreground polling with ETags. This document records
source implementation, not production deployment or migration acceptance.

## Feature matrix

Present means implemented source was found. It does not claim new end-to-end
acceptance. Unknown means the audited source did not establish the behavior.

| Feature | Existing Sprout | Legacy Family Bottle Journal | Baby Buddy core | Unified application |
| --- | --- | --- | --- | --- |
| Bottle feeding | FeedLog, amount/unit, contents, time, notes, caregiver | Consumed volume, formula calories, time, notes | Contents/method, amount, duration, notes/tags | Existing FeedLog plus journal UI; PR #58 adds optional offered amount and metadata |
| Breastfeeding | Side/session/pause tracking | Not found | Left/right/both methods | Existing nursing module; both-breast import semantics partial |
| Pumping | PumpLog, left/right/total, duration | Not found | Total amount/duration | Existing module and adapter |
| Milk inventory | Stored/fed/discarded and adjustments | Not found | No equivalent inventory model found | Existing Sprout inventory; imported pump disposition needs acknowledgement |
| Diapers | Wet/dirty/both/dry, notes/color | Not found | Wet/solid, numeric amount, tags | Existing module; numeric amount/tags remain gaps |
| Sleep | Nap/night, ongoing/completed, reports | Not found | Sleep and generic timers | Existing module; predictive sleep not established |
| Timers | Nursing/activity/sleep/pump | Not found | Independent named user timer | Domain timers present; generic named timer absent |
| Tummy time | PlayLog and active timer | Not found | Dedicated milestone/notes/tags | Existing module; this patch preserves both imported milestone and notes |
| Growth | Height/weight/head circumference, CDC/WHO | Not established | Includes BMI | Existing charts; BMI not represented |
| Health observations | Temperature, medicine, vaccines, reactions, notes | Feeding observations in notes | Temperature/medication/notes | Existing modules; some import semantics remain partial |
| Caregiver activity | Family/caretaker relationships | Caregiver name/notes | Accounts/caregiver API and timer owner | Shared family/caretaker model; source caregiver label retained separately |
| Reports | Reports and monthly PDF | Intake totals/target progress | Child reports/graphs | Existing reports plus journal daily/rolling totals; reconcile in release acceptance |
| Export/import | CSV/XLSX, Baby Buddy adapter | JSON/CSV source/export path | Django admin CSV/XLSX | Existing provenance executor; PR #58 adds reviewed legacy import |
| API/integrations | App API and scoped hooks | Shared Durable Object backend | REST endpoints/schema/webhooks | One canonical backend; not Baby Buddy wire-compatible |

Reuse `src/lib/importers/baby-buddy/`, `execute.ts`, and
`ExternalImportRecord`. Do not create another Django stack or conflicting care
database. Remaining import fidelity gaps include generic tags, BMI, some
both-breast and fortified-milk semantics, image references, and optional
medication dosage currently represented as zero with a warning.

## OCR implementation in this change

- Text-only PDF pages use Poppler `pdftotext -layout` locally.
- Native text has **null recognition confidence**; selectable text is not a
  guarantee that the source or interpreted fields are correct.
- `pdfimages -list` checks each page. A page containing raster content uses
  full-page local OCR so that a selectable header cannot hide scanned entries.
  This is deliberately conservative: even a logo can cause OCR fallback.
- Broken/empty text layers, unavailable text inspection, scanned pages, and
  requested crop/rotation use the existing pinned Tesseract engine.
- Source previews are still rendered. Every event remains unapproved until
  reviewed. No permanent care record is written by extraction.
- A manual row on a single selected PDF page is validated against the original
  page numbers, not the number of selected pages.
- The existing encryption, family scoping, retention, confirmation, duplicate
  decisions and transactional provenance pipeline remain authoritative.

Limits remain 12 MB, six pages per batch (or one selected page of a PDF up to
100 pages), 24 megapixels per image, and 200 candidate rows. HEIC must be
converted before upload.

## Real synthetic fixture coverage

`tests/ocr-intake.test.ts` generates actual PDF/PNG/JPEG bytes using jsPDF
and Sharp. On Linux it invokes the real bounded Poppler/Tesseract commands.
These are printed synthetic fixtures and contain no family data.

| Fixture | Acceptance asserted |
| --- | --- |
| Native-text PDF, selected page 3 | Native engine marker; null confidence; exact date/time/volume/unit/content for two feeds (10 fields) |
| Three-page native + scanned + mixed-header/image PDF | Native first page; Tesseract on both raster pages; exact time/volume/unit/content for four feeds (16 fields) |
| Low-contrast JPEG | Actual preprocessing + recognition; exact time/volume/unit for two feeds (6 fields) |
| Rotated PNG corrected 270 degrees | Actual image recognition after correction; exact time/volume/unit for two feeds (6 fields) |
| Existing image/PDF/error fixtures | Signature/size, malformed PDF, excessive page count, cancellation, unapproved results |
| Selected-page review regression | Manual page 5 accepted with selected page count 1; unselected/invalid pages rejected |

Each metric is printed **only after its assertions pass**. A skipped Linux
test is not a passing OCR result. Use the root release run and its exact commit
for actual results; this document does not predeclare a successful run.

Run from `application/` in an isolated Linux OCR container:

```sh
npx vitest run tests/ocr-intake.test.ts tests/ocr-selected-page-review.test.ts tests/babyBuddyImportMapping.test.ts tests/ocr-parsing.test.ts tests/ocr-import.integration.test.ts tests/ocr-reconciliation.test.ts
```

Use synthetic storage only. Do not mount production database, environment, or
source-document volumes in a test container.

## Handwriting limitations

**General handwriting recognition remains unqualified.** The existing
`ocr-handwriting-benchmarks.test.ts` feeds synthetic strings to the parser; it
tests normalization and abstention, not image recognition. Printed text,
rotated printed images, or a cursive font do not establish performance on
parents' handwritten logs.

Tesseract may fail to detect handwritten entries, alter digits, merge columns,
or omit rows. Review the original page and add/correct rows manually. No
representative handwritten image corpus or the family's actual paper logs was
available in this audit. Do not advertise comprehensive handwriting support
until representative image fixtures have measured results. No externally
hosted recognition service was enabled.

## Identity and source notices

Use **Sat Tracker**, with a clarifying subtitle such as “Family care journal.”
Keep the repository and production hostname unchanged. “Sat Tracker” overlaps
generic satellite/vehicle tracking terminology; “Family Nest” already names a
family locator and “LittleLedger” already names a home-daycare app. This is a
brief naming check, not a uniqueness determination.

Preserve the Sprout custom license (attribution, noncommercial, share-alike)
and its copyright. Baby Buddy's BSD-2-Clause license does not replace those
terms. Any copied Baby Buddy code must retain its own copyright, conditions
and disclaimer. The pinned OCR model's Apache-2.0 notice is already in
`application/documentation/BabyTracker/licenses/`.

## Evidence links

- [Canonical schema](https://github.com/MulattoTech/BabyTracker-Master/blob/8636421b7573de5c70d98dc579cc4265fb9e88a0/application/prisma/schema.prisma)
- [Existing detailed baseline matrix](https://github.com/MulattoTech/BabyTracker-Master/blob/8636421b7573de5c70d98dc579cc4265fb9e88a0/docs/babytracker-feature-parity-2026-10-27.md)
- [Unified Bottle Journal PR #58](https://github.com/MulattoTech/BabyTracker-Master/pull/58)
- [Baby Buddy models](https://github.com/babybuddy/babybuddy/blob/2bd0461f5a7e407147bcfef363eb79dce6c9708d/core/models.py)
- [Baby Buddy API](https://github.com/babybuddy/babybuddy/blob/2bd0461f5a7e407147bcfef363eb79dce6c9708d/api/urls.py)
- [Baby Buddy reports](https://github.com/babybuddy/babybuddy/blob/2bd0461f5a7e407147bcfef363eb79dce6c9708d/reports/urls.py)
- [Sprout license](https://github.com/MulattoTech/BabyTracker-Master/blob/8636421b7573de5c70d98dc579cc4265fb9e88a0/LICENSE.md)
- [Baby Buddy license](https://github.com/babybuddy/babybuddy/blob/2bd0461f5a7e407147bcfef363eb79dce6c9708d/LICENSE)
- [Family Nest](https://www.familynestapp.com/)
- [LittleLedger](https://littleledgerdaycare.com/)
- [SAT TRACKER 360](https://play.google.com/store/apps/details?id=com.app.sat.tracker360)
