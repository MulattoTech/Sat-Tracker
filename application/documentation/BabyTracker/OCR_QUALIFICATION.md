# Private image recognition qualification

This harness measures the existing local OCR pipeline against actual PNG, JPEG,
and PDF bytes. It calls `recognizeOcrDocument`, then `parseOcrPages`; no injectable
recognizer or parser-string input can substitute for image recognition. The
originals, ground truth and detailed report stay beneath the repository's
ignored `.local/` directory. No database, import commit or application auth
module is loaded, and extraction never approves rows.

**Representative handwriting remains BLOCKED until representative human-written
images are supplied privately.** Printed calibration images, cursive fonts,
selectable PDF text and parser-string tests do not establish handwriting
accuracy. Automated measurement alone never assigns a handwriting PASS.

## Prepare a private corpus

Use the canonical source checkout, with its existing dependencies and Linux OCR
runtime (Poppler, Tesseract, prlimit and the pinned English model). Keep source
files and the manifest in `.local/ocr-qualification/`. Do not upload the corpus,
raw recognition or private reports to GitHub Actions/artifacts/issues.

For every document, transcribe all expected care rows in page/reading order.
Include repeated real rows separately. The transcription is private alignment
input; `fields` is independently checked ground truth. Use canonical local dates
and 24-hour clocks, original ML/OZ units and duration **in seconds**. A numeric
duration of 1200 means twenty minutes. Omit a field when it is outside the test;
set it to `null` when its absent/illegible value should remain unresolved.
Every row must declare event type, date and time, including explicit nulls.

Example manifest shape (the example values below are synthetic):

```json
{
  "version": 1,
  "documents": [{
    "input": "private-log.png",
    "provenance": {
      "origin": "family-paper-log",
      "humanHandwritten": true,
      "representativeOfFamilyWorkflow": true,
      "groundTruthDoubleChecked": true,
      "consentForLocalEvaluation": true
    },
    "parse": { "timeFormat": "24h" },
    "expectedRows": [{
      "page": 1,
      "transcription": "08:15 bottle formula 90 mL duration 20 min",
      "fields": {
        "eventType": "feed",
        "localDate": "2026-10-20",
        "localTime": "08:15",
        "amount": 90,
        "unit": "ML",
        "feedDuration": 1200
      }
    }]
  }]
}
```

`origin` must be `family-paper-log`, `volunteer-paper-log`, `synthetic-print`,
or `synthetic-cursive-font`. Synthetic origins cannot declare representative
human handwriting. Provenance is a manifest attestation requiring independent
review, not something software can establish from a boolean. Keep writer names,
child IDs, ground-truth explanations and consent records private; none belong
in the public summary. Include ordinary and difficult examples, several writers,
camera/scanner captures, rotations, uneven lighting, mixed units, ambiguous
fields, repeated rows and repeated uploads before proposing acceptance.

Optional `intake` uses the existing `rotation`, `selectedPage`, and `crop`
options. A crop uses numeric `left`, `top`, `width`, `height`, and optional unit
`pixel` or `percent`. Expected rows must describe only the selected page/crop.
Optional `parse.defaultDate` is explicitly user-supplied context; the report
counts date answers supplied by that context separately. It must not be used
to claim unaided date recognition.

Run from `application/`:

```sh
node --import tsx scripts/qualify-ocr.ts --manifest ../.local/ocr-qualification/manifest.json
```

The command prints only a random run ID, execution status, representative status
and measured/failed document counts. The full count-only report is written with
exclusive creation and private permissions to
`.local/ocr-qualification/reports/<run-id>.json`. Errors print fixed codes, never
native exception text, input paths, transcripts or field values. Input paths
are resolved inside `.local` including symlink checks. Sources are read only.
There are at most 100 documents, 200 expected rows/document and 64 alignment
tokens/row; existing intake byte/page/pixel/native-process bounds still apply.

Exit 0 means the measurement completed, **not** that recognition or the product
passed. Exit 2 means a manifest/input/engine/repeat-pair error. Failed documents
are explicitly excluded from measured aggregates, so inspect `failedDocuments`
and `executionStatus` before using any score.

## What the numbers mean

- Row correspondence uses deterministic, one-to-one, monotonic matching within
  each page. A pair requires at least 0.6 normalized token similarity between
  private row transcription and actual recognized source text. Expected field
  values never drive alignment. Missing rows reduce recall; extra candidates
  reduce precision and increase false-discovery rate. Duplicate expected rows
  cannot reuse a single detected row.
- **Correspondence is an automatic estimate.** Similar adjacent rows can align
  incorrectly and grossly unreadable rows can be unmatched. Review those cases
  privately against the originals before accepting a corpus result. This is
  not a bounding-box detector benchmark.
- Every field shows known-value counts, exact correct/wrong values, known-value
  abstentions and missed rows. Accuracy is correct / all annotated known
  values, including missing rows. Numeric values require exact agreement in
  the declared units; there is no hidden tolerance or unit normalization.
- Explicit unknown annotations show safe abstentions, unsafe guesses, unresolved
  non-null suggestions and missing rows separately. Safe abstention requires an
  actual null/absent/unknown output. A non-null value marked ambiguous or missing
  is an unresolved suggestion, never credited as safe abstention. Missing a row
  is not credited either. Ambiguous/missing origins remain unaccepted when
  scoring known-value accuracy, even if their non-null suggestion happens to match.
- No denominator produces `null`, not 100%. False discovery is extra candidates
  / all candidates. Classical specificity/false-positive rate needs a defined
  true-negative population and is not invented here.
- The representative subset includes only attested, double-checked human logs
  marked representative, and only pages that actually used raster OCR. Native
  PDF text cannot qualify as handwritten-image recognition. Synthetic results
  are always separate. Mixed printed/handwritten pages measure the entire
  representative page workflow, not isolated handwritten glyph accuracy.

## Repeated inputs and independent acceptance

Add another document with `repeatOf` equal to an earlier zero-based document
index and `repeatKind` of `same-bytes` or `transformed-scan`. Recognition really
runs again. Exact repeats must have identical bytes; transformed scans may
differ. The report compares the multiset of extracted scored fields, retaining
repeated rows. Empty outputs and pairs with no resolved scored field are tracked
separately and cannot inflate `consistentPairs`. Even other consistent outputs
may contain identical partial abstentions; consistency measures repeatability,
not correctness. Consult the field-level scores.

This measures **extraction consistency only**. Canonical duplicate detection,
transactional idempotency, human-corrected import equality, timezone resolution,
authorization, mobile behavior and production acceptance remain `NOT_RUN`.
Use the existing service/browser/database suites for those contracts. A future
handwriting acceptance decision also needs reviewed row correspondence,
representative provenance, sample coverage and agreed numeric thresholds;
nonempty measurements are reported as `MEASURED_NOT_ACCEPTED` until then.

## Harness regression tests

```sh
npx --no-install vitest run tests/ocr-qualification.test.ts tests/ocr-qualification-images.test.ts
```

Scoring tests cover extra/missing/cross-page/repeated rows, wrong date/volume/
duration, abstention and redaction. Linux integration tests generate actual
printed PNG/JPEG and mixed native/scanned PDF bytes, invoke the real pinned
local engine, verify exact synthetic fields and repeated recognition, and
assert that representative handwriting remains BLOCKED. Non-Linux image tests
are skipped and must not be reported as image-recognition PASS. These fixtures
contain no real family records.
