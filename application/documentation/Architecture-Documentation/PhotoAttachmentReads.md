# Photo attachment reads and explicit historical unlinking

This document describes the read/client portion of issue #16's shared photo
ownership and link-integrity foundation. It does not qualify diaper capture,
portable media recovery, deployment or physical-device acceptance.

## Authorized projection

`photo-ownership.ts` resolves supported activity references in batches. A
readable target belongs to the authenticated family and a live child, and is
not deleted. `photo-read.ts` independently checks the photo's family and child,
then exposes a link only when its target has the same child. It applies the
same policy to the separate `Photo.milestoneId` relationship.

Gallery, single-photo, upload/PATCH and PhotoLog responses use this projection.
Unavailable target IDs, types and titles are omitted. An owned photo may carry
`unavailableLinkIds` containing only its opaque link handles, and
`unavailableMilestone: true` for a hidden scalar tag. Those fields allow an
explicit removal request without exposing the unavailable target. Reads never
rewrite stored historical relationships.

The photo itself remains available in its owning family's library when an
activity relationship is hidden. Image reads enforce the photo and child's
family ownership; they do not require an activity link. Existing trash access
rules still apply.

## Direct lookup contracts

`GET /api/photos/attachments?activityType=...&activityId=...` returns
`{ success: true, data: { photos, retainedLinkCount, maxPhotos } }` after target
authorization. Supported types include `diaper`, though this package adds no
diaper capture UI. The response is independent of gallery pagination.

Photos follow link creation order with an ID tie-breaker. A milestone also
includes valid scalar-only tags, appended in creation/ID order without
duplicating a photo that already has a link. Such reads do not create a missing
link. Capacity counts the retained union, including hidden and trashed
references; `maxPhotos` is four.

`GET /api/photos/[id]` returns a single sanitized `PhotoResponse`. TimelineV2
and the Photo Tracker detail handler use this endpoint instead of searching a
gallery page. Timeline
metadata separately filters its batched links and includes diaper targets.

## Existing client behavior

Feed, milestone, play, bath, measurement and food editors use
`useActivityPhotoAttachments`. They render only the current target's response,
cancel obsolete requests, show read errors with retry, and reserve hidden
capacity before permitting another file selection. `PhotoAttachments` remains
a controlled strip and performs no listing of its own.

PhotoForm sends membership, time, caption and milestone changes only when
edited. The server additionally preserves hidden references during a visible
set replacement. PhotoDetail and the paginated gallery lightbox share explicit
unavailable-link/tag actions that retain errors and refresh their handles after
success. The gallery updates that photo in place without dropping loaded pages.
These actions do not delete the photo
or care event.

## Verification and limits

Focused tests cover real authenticated SQLite gallery/single/target/PhotoLog
and timeline reads, malformed sibling/foreign/null/deleted references, retained
capacity, scalar-only milestone tags and attachments beyond 200 newer rows.
Pure presentation tests cover omission and slot accounting; all new controls
are localized in the twelve supported locales. Hosted provider/browser results
belong to the implementation PR; source coverage alone is not acceptance.

Portable encrypted-file recovery, upload lost-response identity, durable
offline drafts, session image-cache qualification, broader per-photo roles,
physical camera evidence and photos embedded in reports remain follow-ups.
