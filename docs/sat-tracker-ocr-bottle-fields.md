# OCR bottle fields and source interpretation

These additions depend on the unified Bottle Journal schema and external-import
executor from PR #58. They preserve the existing canonical FeedLog backend.

## Explicit fields

- `amount` is consumed volume. `offeredAmount` uses the same `unit`.
- Explicit offered/prepared and consumed/taken/drank/drunk labels are distinguished.
- A single ordinary bottle volume retains the established consumed-volume behavior.
- An offered-only quantity never becomes consumed volume.
- Remaining, left, unused, discarded and other residual-only quantities never
  become consumed volume. Remaining volume is not subtracted to invent consumption.
- Conflicting prefix/suffix role labels, negated labels and unclear label direction
  require correction. Punctuation-delimited suffix labels are supported.
- Separately recorded mL/oz offered and consumed values are normalized into the
  consumed value's unit. The untouched source line remains available for comparison.
- Concentration requires an explicit `kcal/oz` or `kcal per oz` unit. Ranges,
  question marks, missing units and unsupported units remain unresolved.
- Formula names, bottle identifiers and caregiver names require an explicitly
  colon-labelled cell. Free-form prose is retained in source/notes, not guessed.
- Source caregiver text never selects an authenticated account or changes ownership.

Example:

```text
08:15 bottle formula; offered: 120 mL; consumed: 90 mL; concentration: 22 kcal/oz; formula name: Example Brand; bottle id: A-1; caregiver: Test Parent
```

The review form exposes all optional fields. Editing clears approval. Server
validation bounds quantities and text, requires consistent offered/consumed units,
and rejects consumed volume above offered volume. Corrected values retain field
provenance and pass through the existing external-import transaction.
Merging draft rows converts copied consumed or offered quantities into the target
row's established unit. A quantity without a source unit remains unresolved, and
a unit from another row cannot silently reinterpret an existing unitless quantity.

## Feeding duration

Explicit `duration: 20 min`, `feeding duration: 1 h 5 min` and `nursed for 15 minutes`
produce a structured `feedDuration` in whole seconds. A duration cell is excluded
from event-clock/date parsing, so `1200 s` cannot become a 12:00 feeding time.
The review field displays minutes and accepts fractional minutes, rounded to the
nearest second. A missing duration stays blank; no time difference or implicit
unit is invented. Ranges, question marks, unlabelled values, repeated units and
conflicting duration labels remain unresolved for review.

Server validation requires 1–86400 whole seconds when supplied and warns above
two hours. This is a data-integrity bound, not a recommended feeding duration.
Corrections reset approval and preserve field provenance. After explicit final
confirmation, the existing import transaction writes `FeedLog.feedDuration`; no
schema migration or second store is needed. Older reviews retain the absent field
and their existing confirmation hash. Source deletion leaves canonical records
unchanged. Handwriting recognition remains a separate qualification requirement.

`ocr-duration.test.ts` covers parsing, abstention, bounds, editing, merging,
provenance and old receipt replay. The real Linux image/SQLite integration and
browser gate verify recognized duration, correction and exact canonical seconds.

## Compatibility

New fields are optional. A pre-existing draft that omitted them continues to omit
them during server normalization; its confirmation hash therefore remains stable.
Tests check this explicitly. Preserve the privacy branch's
`purgeSourceAfterCommit` behavior when integrating this change.

## Date headings

The parser previously interpreted the year 2026 inside an ISO date as military
time 20:26. That prevented a native PDF date heading from applying to its rows.
Clock parsing now excludes explicit date and quantity spans. Dates and times
inside labelled identifiers or names also cannot become event timestamps.

An explicit complete ISO date heading applies only within its own page.
Ambiguous numeric dates, missing years and invalid dates require review.
Full dotted dates and year-first slash dates clear any supplied default date;
their year tokens cannot become military clock times. Only a complete canonical
ISO date is resolved automatically. A two-part dotted clock such as `14.15`
retains its time interpretation.
A date does not carry silently from one page to the next.

## Tests

- `ocr-rich-fields.test.ts`: labelled quantities, mixed units, abstention,
  validation, editing, merging, server mapping and old receipt hashes.
- `ocr-rich-fields.integration.test.ts`: corrected metadata survives a real
  isolated SQLite commit into FeedLog, then repeated confirmation creates no
  second feed or provenance record.
- `ocr-date-heading.test.ts`: explicit headings, no cross-page carry, incomplete
  dates and identifier isolation.
- The separate real Linux intake fixtures exercise native PDFs, scanned/mixed
  PDFs, rotated PNGs and low-contrast JPEGs.

These source changes do not establish handwriting accuracy. The existing
handwriting-named parser suite uses text strings, and representative handwritten
image recognition remains unqualified.
