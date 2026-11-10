# Production record-preservation gate

Use PowerShell 7 for the owner-invoked promotion:

```powershell
./scripts/promote-release.ps1 -Apply -Image $acceptedImmutableImageId -VerifyDataPreservation
```

The existing exact-main CI, image provenance, isolated preview, backup, restore,
health and volume checks still apply. A private full-startup migration rehearsal
and the synthetic previous-image rollback drill remain separate prerequisites.
The promoter refuses `-Apply` without `-VerifyDataPreservation` before any
inspection or mutation. Plan-only inspection still works with or without the
switch. The lower-level updater retains its existing interface; production
releases use the guarded promoter above.
The backup helper refuses an unsuccessful service-state inspection before
stopping, restarting or archiving anything. An already stopped service can still
be backed up without starting it.

## Capture at the correct point

`backup.ps1` stops and then restarts the previous application. Older seeds update
`Unit.updatedAt` during that restart. Capturing before the promoter therefore
produces a baseline that is already stale before the candidate starts.

With `-VerifyDataPreservation`, the updater records the previous image before
backup, completes backup and restore verification, waits for that exact previous
image to become healthy, and then captures the baseline. It rechecks the old
container ID, boot time, health and production volume identities after capture.
Only then does it change the image configuration and start the candidate.

The driver is fixed to `scripts/test-live-preservation.ps1` and its reviewed
`verify-live-preservation.cjs` companion. No arbitrary script path or scriptblock
is accepted by the promotion command. Each invocation uses a new private folder
under `.local/releases`, which is excluded from Git.

## What is verified

The helper reads both SQLite databases through `docker exec` in the existing
production container. Its connections are read-only with `query_only=ON`, and
each database is read inside its own transaction. No test container mounts live
volumes, and no extra restart or application HTTP request is required.

The private baseline stores schema names, counts and sorted SHA256 hashes of
typed row values. It contains no plaintext row values. Post-deploy verification
uses only each table's original columns, allowing additive migrations and new
rows while requiring every old row hash, including duplicate multiplicity, to
remain present. Changed or deleted old rows fail even if total counts increase.
Only `_prisma_migrations` is excluded. SQLite's internal `sqlite_sequence` is
checked separately: every previous sequence entry must remain present and its
integer counter must not decrease; normal increments and new entries are
reported as bounded metadata counts. This allows AUTOINCREMENT log inserts
without weakening any application-row comparison. Both databases must pass
integrity checks.

The driver binds the exact baseline bytes to the capture receipt's SHA256 and
the actual container to the expected immutable image. It streams the manifest
on stdin, suppresses native output, applies an in-container 90-second process
timeout, and returns bounded counts, digests and error codes. Temporary helper
and manifest files are removed from the container; private host evidence stays
available for review.

## Coverage and failure behavior

The baseline is an **online snapshot**, not a global write freeze. Main and log
databases are captured in separate read transactions. New rows written after
their capture are outside the old-row preservation guarantee. An edit or delete
of a baseline row during the capture-to-cutover interval will fail verification
and needs explicit reconciliation; the gate does not silently excuse it.

A failed capture leaves the previous image configuration unchanged and cancels
candidate startup. A failed post-deploy verification prevents `UPDATE_OK`, the
promotion success message and the new deployment receipt. The candidate and
private evidence remain for investigation; no database restore or rollback runs
automatically, because it could discard post-deploy writes.

Successful production promotion records `preservationStatus: PASS`, the baseline
digest, the private evidence location and the coverage statement. Historical
receipts with `NOT_REQUESTED` do not establish old-row preservation and cannot
qualify a new production promotion.
