# OCR redaction and source retention

The OCR redaction endpoint accepts a JSON object with optional boolean
`redactNotes` and `purgeSource` fields. An explicit empty object selects both.
Invalid JSON, missing bodies, unknown options, invalid option types and oversized
bodies fail before any mutation. Existing administrator and family checks apply.

`redactNotes` removes OCR free text from the original extraction (including page
text), the current review, document filename and encrypted audit snapshots.
Audit IDs, actions, actors, timestamps and structured provenance are retained.
This explicit privacy operation is the exception to ordinary review immutability.
It increments the document revision and clears uncommitted approvals so a stale
review cannot restore the old text. A decryption or database failure rolls back
the entire operation. Imported care events and their notes are not modified;
correct those through the ordinary care-event editor if needed.

`purgeSource` revokes source access and detaches file references in the same
database transaction as the requested action. Physical encrypted files are
unlinked only after that transaction succeeds. A transaction failure therefore
preserves both the original source and the database state. Failed file cleanup
does not undo committed care events: detached encrypted files are inaccessible
through the document API and are retried by the existing orphan-retention sweep
after its one-hour grace period. `purgedAt` means access was revoked, not that
secure erasure of physical storage has been proven. Generic cleanup errors never
include document text, filenames or family identifiers.

Source-only purge preserves OCR review text and provenance. Text-only redaction
preserves the original source file when explicitly requested. Neither operation
rewrites existing backups or deletes already imported canonical care records.

Regression coverage includes real SQLite transaction rollback, all OCR text
copies, stale revisions, wrong-family attempts, failed unlink retry, malformed
requests and rejection of unsupported native OCR platforms. Recognition fixtures
are generated explicitly in tests; the runtime OCR engine never substitutes
fabricated rows based on test environment variables.
