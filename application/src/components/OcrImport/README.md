# Document import review

The authenticated `/{familySlug}/ocr-import` route shares Sprout's selected-child context.
It uses only family-authorized `/api/ocr/documents` endpoints; source previews and downloads
are fetched with an authorization header and rendered from temporary blob URLs.

## Workflow

1. Choose a child, upload a supported image/PDF, and explicitly choose source date/clock/timezone context.
2. Compare the original page side-by-side with editable feeding, diaper and sleep drafts. Toggle between side-by-side and stacked views on phone/tablet.
3. Edit, add manual events, split rows, merge adjacent split lines, or explicitly reject unwanted rows. Unknown handwriting can be manually transcribed.
4. Check individual approved rows or explicitly bulk-approve valid rows after review. Edits, timezone changes, and merges clear approval.
5. Review live recalculating totals (feeding volume in mL/oz, diaper breakdown by type, sleep duration).
6. Save incomplete drafts without creating events. Preview approved rows against existing care records.
7. Resolve every reported duplicate (clearly distinguished between same-sheet event collisions and timeline duplicates) as a deliberate skip or a distinct event, acknowledge source/warning review, and confirm the import.

Unchecked and rejected rows remain in the draft/audit and are not selected for canonical import. Confirmation finalizes
the whole document, including unchecked rows: resumable partial batches are not implemented in this slice.
The final confirmation warns about this explicitly. Committed documents are displayed as locked history.
Source deletion is an explicit separate action preserving care events
and audit history. No drafts or source images are persisted to browser storage by this component.

## Components

- `useOcrImport.ts`: scoped asynchronous state, cancellation, optimistic revision requests, row operations (edit, approve, reject, merge, split, remove, revert), draft/preview/commit actions.
- `UploadPanel.tsx`: bounded format intake, clock context, rotation and retention settings.
- `SourcePanel.tsx`: authorized previews, page selection, enlargement, download and deletion.
- `RowEditor.tsx`: original text/provenance, corrections, per-row approval/rejection, manual split, merge with previous/next, duplicate alerts, and removal.
- `TimeChoice.tsx`: explicit selection of repeated DST clock occurrences.
- `ReviewActions.tsx`: live recalculating totals card, selected-row preview, duplicate choices and final confirmation.
- `review-helpers.ts`: pure draft updates, row merge, row rejection, live totals calculation, timezone and validation helpers.

The English printed-text baseline is stated explicitly. Engine scores are not field correctness probabilities.
Translation keys for the feature are collected in `translation-keys.json` for integration with the existing localization files.

Feeding duration is optional. Explicit elapsed durations are extracted in whole seconds, displayed and edited in minutes (rounded to the nearest second), and written to the existing canonical `FeedLog.feedDuration` only after confirmation. Missing or ambiguous durations remain blank; duration edits clear approval.
