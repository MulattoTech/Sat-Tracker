# Sat Tracker source parity checkpoint — 2026-11-02

This checkpoint records reviewed implementation and synthetic acceptance for the
November 2 iteration. The canonical application and care database remain under
`application/`. Production acceptance belongs to the exact released image and
its release receipts; this file does not qualify a future candidate by itself.

## Changes since the November 1 audit

| Capability | Implemented slice and evidence | Remaining acceptance |
| --- | --- | --- |
| OCR feeding duration | [PR #66](https://github.com/MulattoTech/BabyTracker-Master/pull/66) parses explicit elapsed quantities, reviews minutes and persists whole seconds in `FeedLog.feedDuration`. Exact-head acceptance, operations and Compose CI passed before merge. | Representative handwritten images and physical phone review remain open. The separate Baby Buddy feeding adapter still needs duration/timezone fidelity work. |
| Durable bottle entry | [PR #67](https://github.com/MulattoTech/BabyTracker-Master/pull/67) writes an immutable request to IndexedDB before transmission, coordinates concurrent tabs, and validates caregiver/family/child scope on the server. Actual disconnected browser, reload, full process restart and lost-response checks passed on disposable SQLite. | Cold offline startup, background synchronization while closed, historical edits and queues for other care domains remain open. Physical devices are unverified. |
| Private image qualification | [PR #68](https://github.com/MulattoTech/BabyTracker-Master/pull/68) measures actual document bytes through the local intake engine, with explicit row/field/abstention denominators. All 18 harness tests passed, including PNG/JPEG/mixed PDF recognition. | A representative privately supplied human-paper corpus, reviewed ground truth, correspondence review and acceptance thresholds are still required. |
| Missing medication dose | `medication-map.ts` preserves undosed Baby Buddy events as explicit unresolved Notes. Mapping/executor tests, four real SQLite cases and the actual import wizard/API checks passed. | Complete medication/health parity and reconciliation of previously imported source errors remain open. |
| Acceptance inventory | [PR #69](https://github.com/MulattoTech/BabyTracker-Master/pull/69) preserves 77 original capabilities and adds 24 cross-cutting contracts, with evidence validation and concrete issue dispositions. | The final whole-product scope denominator and broad runtime/device acceptance remain uncertified. |

All five slices received independent source review. The combined normal build
and browser gate passed 27 checks, with verified cleanup of owned synthetic
processes. Required final-revision CI, preview and operational receipts remain
the authority for release promotion. None of these changes adds a schema
migration or a separate care store.

## Data fidelity and reliability boundaries

OCR duration is accepted only from explicit labels and units. Ranges, uncertainty,
conflicting labels, invalid quantities and missing values remain unresolved.
Duration tokens are excluded from clock recognition. Editing duration clears
approval; final confirmation persists corrected seconds and provenance through
the existing transaction and replay receipt. Older drafts without this optional
field retain their confirmation identity.

The bottle queue excludes pending entries from totals until the server confirms
them. It retains original timestamps and UUIDs, coordinates sends using short
leases and requires explicit review after access, validation or conflict errors.
Discard removes only the browser's pending copy; the server record remains.
The queue is scoped to the signed-in actor, family and child, stores no credentials,
and is bounded at 100 entries per browser origin. Browser-local IndexedDB is not
encrypted by this feature, and clearing site data removes unsent entries.

The November 1 audit described missing Baby Buddy dosage becoming zero with a
warning. The new mapping instead retains the source name, time, unit, interval,
notes, child and medication provenance in a clearly labeled unresolved Note.
Explicit source zero remains zero. Malformed nonempty doses fail validation.
Existing older imports remain unchanged, and replay reports their actual stored
target type. A later corrected source dose requires explicit reconciliation;
reimporting does not silently replace history or create a second event.

The qualification CLI measures extraction only and creates no care records.
It reports page-constrained estimated row correspondence, missing/extra rows,
field/date/time/volume/unit/duration accuracy, abstention, unsafe guesses and
uncertain suggestions. Repeat metrics distinguish useful consistent results,
unresolved outputs and empty outputs. These metrics do not establish canonical
database deduplication or reviewed-import correctness. Reports omit source text,
filenames and raw field values; inputs and reports remain private.

Representative handwriting remains **BLOCKED** without a genuine reviewed
human-paper corpus. Printed fixtures, cursive fonts and native-text-only PDFs
cannot establish this acceptance. A measured corpus still needs independent
review of its representativeness, correspondence and thresholds.

## Remaining parity and acceptance

The canonical ledger retains 100 inventoried required contracts and one desired
contract. `scopeComplete` remains false, so whole-product acceptance percentage
is unavailable. The five accepted operational contracts are scoped to the prior
published release. These narrow implementation results do not accept their
broader parent contracts.

Remaining source parity includes fortified-milk and both-breast semantics, tags,
numeric diaper amounts, BMI, imported image references, pump disposition,
Baby Buddy feeding timestamps/duration, Sprout import, generic named timers,
corrected-age behavior, advanced sleep prediction, module install/update/rollback
and camera integration. Existing related screens do not establish complete parity.

Actual legacy history migration, physical Pixel 9/Pixel 10/iPad checks and real
caregiver multi-device synchronization require their missing exports/devices.
Safe import undo, full product acceptance and representative handwriting remain
explicit unresolved issue scope. Preserve draft PR #35 and recovery references;
its intake configuration is not an accepted runtime module updater.

See [the acceptance ledger](sat-tracker-acceptance.md) and the exact release's
sanitized notes for subsequent CI, preview, backup/restore, migration, rollback,
record-preservation and live-smoke evidence.
