# Recognition baseline and evaluation gate

## Reproducible local baseline

- Engine: native Tesseract, English, page-segmentation mode 6.
- Model: official `tesseract-ocr/tessdata_fast` `eng.traineddata` at commit
  `87416418657359cb625c412a48b6e1d6d41c29bd`.
- Model SHA-256:
  `7d4322bd2a7749724879683fc3912cb542f19906c83bcc1a52132556427170b2`.
- Model license: Apache-2.0; upstream terms at
  https://github.com/tesseract-ocr/tessdata_fast/blob/87416418657359cb625c412a48b6e1d6d41c29bd/LICENSE .
- Docker and CI download the immutable model at build/setup time and verify its
  checksum. Runtime recognition verifies the checksum again, and source provenance
  records the actual engine version, model hash and segmentation mode.
- Test environment engine observed: Tesseract 5.3.4. Native package versions can
  differ between platforms; an engine upgrade requires rerunning the same fixtures.

Model URL:
https://raw.githubusercontent.com/tesseract-ocr/tessdata_fast/87416418657359cb625c412a48b6e1d6d41c29bd/eng.traineddata

## What the evidence establishes

Synthetic printed PNG, explicit 90-degree rotation recovery, two-page PDF,
malformed PDF, page limit, cancellation, candidate parsing and reviewed transactional
import are exercised by automated tests. Generated documents use no real infant
data. Engine confidence is a 0–100 recognition score, not a field-correctness
probability. No benchmark on messy family handwriting has been performed.

Parsed rows retain the recognized page's requested rotation and crop in their
source evidence, including rows split from the same line. The crop is the page
recognition region, not a detected row bounding box: its pixel or percentage
coordinates apply after EXIF orientation and the requested rotation, before the
final image size limit. PDF pages are rasterized before those transforms. The
original encrypted upload remains unchanged. Persisted server evidence takes
precedence over source metadata submitted with review edits; older drafts without
these optional fields remain readable and do not gain inferred coordinates.

Tesseract's own FAQ states that it is designed for printed text and does not work
well for handwriting: https://tesseract-ocr.github.io/tessdoc/FAQ . The UI must retain
manual transcription and explicit approval even when recognition looks confident.

## Handwriting candidates to evaluate

| Candidate | Why evaluate | Evidence still needed |
| --- | --- | --- |
| Tesseract baseline | Small local CPU dependency and reproducible comparison | Field accuracy/abstention on the actual form layouts |
| PaddleOCR PP-OCRv5 local pipeline | Upstream documents recognition for complex English handwriting and page layout | Private same-fixture accuracy, resource use, installation/model license review |
| Human transcription with image review | Reliable fallback for ambiguous strokes, cross-outs and missing fields | Mobile usability and reviewer time |

Primary PaddleOCR reference:
https://github.com/PaddlePaddle/PaddleOCR/blob/main/docs/version3.x/algorithm/PP-OCRv5/PP-OCRv5.en.md .

Do not install an always-running model or send family documents to a hosted model
by default. A future alternate recognizer must emit the same candidate/provenance
contract and cannot commit records. Compare the same privately stored, representative
handwritten/printed forms. Report exact field match, missing-field abstention,
incorrect event split/merge, duplicate handling, review time, CPU/RAM and latency.
Do not promote a model solely on its published benchmark. Unknown values must stay
unknown until the caregiver resolves them.
