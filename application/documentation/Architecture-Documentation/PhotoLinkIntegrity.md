# Photo ownership, capacity and target lifecycle

Issue #16's shared attachment foundation applies to eight polymorphic targets:
`photo`, `feed`, `milestone`, `bath`, `play`, `measurement`, `foodLog` and `diaper`.
It preserves the existing Photo, PhotoLog, PhotoLink and PhotoFavorite schema.
The new diaper target is a prerequisite for a later capture UI, not acceptance
of that workflow. Read projection and client details are documented in
[PhotoAttachmentReads.md](PhotoAttachmentReads.md).

## Ownership and reservation rules

`photo-ownership.ts` requires the authenticated family explicitly. New links
require a live Photo, a live target and a live Baby belonging to that family;
the Photo and target must have the same baby ID. Nullable or inconsistent
historical family fields never establish ownership. Existing feature and write
permission checks remain in each route.

`photo-link-service.ts` is shared by direct links, milestone upload tags,
Photo milestone reassignment and PhotoLog creation/replacement. A target
reserves at most four distinct photos. Every retained PhotoLink reserves a
slot, including hidden, malformed or trashed relationships. Milestones count
the union of their PhotoLink photo IDs and `Photo.milestoneId` values. A
scalar-only legacy tag and its edge reserve one slot together.

After ownership validation, an already existing edge returns success without
changing its creation time, even at capacity. Adding an edge for an existing
scalar reservation does not consume another slot. A new distinct reservation
cannot exceed four. Legacy excess reservations are preserved for review;
reads and unrelated edits do not automatically reduce them.

PhotoLog replacement removes only visible, live, same-child owned edges that
the explicit new set omits. Hidden or trashed edges stay stored and reserve
capacity. Kept edges retain their identity and creation time. `photoIds: []`
on PUT explicitly clears the visible set; POST still requires at least one
photo. Omitting `photoIds` leaves membership untouched. The current PhotoLog
child is immutable, while an exact child-ID echo remains compatible.

## One database coordination point

Every participating transaction first performs this parameterized statement:

```sql
UPDATE "Family" SET "updatedAt" = "updatedAt" WHERE "id" = <authenticated family>
```

Exactly one row must match. The raw non-key update leaves every Family scalar,
including its timestamp, unchanged. It is shared by the web helper
`app/api/utils/photo-integrity.ts` and the startup solids converter through
`scripts/photo-integrity-lock.js`.

PostgreSQL serializes updaters of this Family row; a non-key update permits
unrelated foreign-key key-share locks. SQLite takes its writer before any
ownership, count or relationship read, avoiding a deferred read-to-write
upgrade. All participating code follows the same family-first order and
rechecks its predicates inside the transaction. A process-local mutex or a
preflight count alone is insufficient. Provider behavior is documented by
[PostgreSQL's explicit-locking reference](https://www.postgresql.org/docs/17/explicit-locking.html)
and [SQLite's transaction reference](https://www.sqlite.org/lang_transaction.html).

`withPhotoIntegrity` bounds transactions to 15 seconds with a five-second
acquisition wait. At most three attempts are allowed. A confirmed rolled-back
serialization/deadlock conflict, or SQLite BUSY before application work began,
may retry within the retry budget. P2028/P1008 uncertainty takes precedence
over nested retry-looking error codes and never replays a mutation. Exhausted
contention returns a review/retry conflict. Callback code contains database
work only; file encryption, cleanup, notifications and response projection
remain outside retries.

## Explicit detach and care mutations

The owned Photo establishes authority for a requested detach even when its
stored target relationship is invalid. The request supplies its photo ID and
either an opaque owned link ID or the compatible exact type/target reference.
The server deletes only that edge and clears a matching primary milestone
pointer atomically. A missing edge is idempotent. Clearing an unavailable
scalar-only milestone requires an explicit `milestoneId: null` PATCH. Neither
operation deletes the Photo or care record. Foreign Photo ownership is denied.

`photo-target-mutations.ts` defines the lifecycle behavior:

| Mutation | Required behavior |
| --- | --- |
| Ordinary explicit care deletion | Collect the retained edge/tag union. If all Photos, the target and its child have matching family/child ownership, detach the associations and perform the original hard/soft deletion atomically. Preserve Photos, bytes, captions, dates and unrelated links. |
| Ambiguous historical association | Return 409 and preserve the whole transaction for explicit review/detach. Never use ordinary deletion as automatic repair. |
| Child move | Reject while any edge or primary milestone reservation remains, including hidden or trashed references. Recheck the destination's live family ownership inside the lock. |
| Conditional Nursery Undo | Reject any retained reference, even when the care scalar revision still matches. Undo has no authority to discard a later photo attachment. |
| Pump correction that removes its automatic feed | Reject if the feed has any retained reference. |
| Explicit pump deletion | Apply ordinary deletion policy to its safely identified feed in the same transaction; roll back the pump too if the relationship is ambiguous. |
| Baby soft deletion | Acquire the same Family lock, then mark the child deleted while retaining historical rows and links. Later new attachments fail liveness checks. |

Canonical feed, bath, measurement and milestone moves participate. Play,
diaper and food edits do not support child reassignment. All eight target
delete paths and the applicable hook API delete paths participate. Hook URLs
recheck their child after acquiring the lock so a move that won first cannot
authorize deletion through the old child URL. Existing exact care snapshots,
Nursery revision identities and pump provenance checks remain required.

## Legacy solids conversion

`convert-solids-feeds-runner.js` moves a SOLIDS FeedLog's photo links to its new
FoodLog only after the same Family lock and exact source snapshot check. It
requires matching photo/target/child ownership and no more than four retained
photos. Catalog creation, new FoodLog, link transfer and exact source deletion
commit together. A rejection leaves no new catalog entry or converted copy.
An inconsistent association remains unchanged and is reported for review.

Unscoped historical feeds have no usable Family lock. They first claim their
exact row and may convert only when no retained photo association would be
transferred. Matching existing FoodLog provenance, including removed tries,
still prevents resurrection or duplicate conversion.

## File outcomes, trash and limits

Upload image processing/encryption occurs outside retryable database work.
Each Photo and any milestone edge/tag commit together. Known rejection before
commit removes the newly generated bytes. An uncertain commit or response
outcome retains bytes to avoid removing an image that may have committed;
the error is recorded for the subsequent reconciliation package. This does
not establish upload request identity or lost-response recovery.

Trash keeps references and capacity reservations. Restore does not create a
new reservation. Purge selects and deletes still-eligible trashed Photo rows
under the lock, then removes only those committed rows' files. A concurrent
restore cannot leave a live Photo whose files were deleted first. File cleanup
failure leaves an orphan residual and is logged.

Concurrent quota enforcement, portable metadata/file backup and recovery,
orphan reconciliation, durable upload retries, session image-cache
qualification, broader per-photo permissions, full reports and physical
camera/Safari/PWA evidence remain separate work. This source package makes no
deployment claim.

## Verification

Writer, read, lifecycle and Nursery/pump/conversion suites use migrated
synthetic SQLite with real authorization and, for uploads, encrypted files.
`photoIntegrityConcurrency.integration.test.ts` runs a second Node process and
independent adapter, observes actual lock rejection before releasing the
owner, checks both operation orderings and verifies subsequent commits from
both writers. It does not infer overlap from `Promise.all` alone.

`verify-photo-integrity-postgres.ts` guards an initially empty local synthetic
database, exercises production routes and encrypted files, and observes
PostgreSQL lock waits from an independent process. Hosted browser evidence
uses a separately bounded photo stage so the existing 186-check application
stage and its 600-second deadline remain intact. Exact-source hosted results
and independent review must be attached to the PR before source integration.
