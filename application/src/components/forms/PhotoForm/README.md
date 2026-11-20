# PhotoForm

The Add tab creates a PhotoLog or edits an existing PhotoLog. The Library tab
browses recent owned photos and can open the full paginated gallery or
PhotoDetail. This is the existing shared photo workflow; it does not add a
diaper camera or attachment control.

## Editing and historical relationships

`GET /api/photo-log?id=...` returns only readable same-child photos and a
`retainedLinkCount` that also accounts for hidden or trashed historical links.
Those hidden references reserve capacity without exposing their photo or target
metadata. Loading a different entry cancels the previous response, and failed
loads expose a retry action before attachment changes are allowed.

AddPhotoTab omits untouched `photoIds` and care time from update requests.
Caption and milestone changes are patched independently: changing a caption
does not send an unchanged, read-filtered milestone value. An explicit visible
set replacement removes only valid surfaced photos deliberately omitted; the
server retains hidden historical links. PUT may explicitly remove the final
visible photo, while creating a new PhotoLog still requires at least one.

The existing partial-upload retry keeps failed files, successful uploaded photo
IDs and a known created PhotoLog ID in memory. This does not qualify durable
offline/reload recovery or reconciliation after a successful upload/create
whose response is lost. Those are follow-up work before diaper capture.
