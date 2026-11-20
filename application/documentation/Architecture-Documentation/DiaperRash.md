# Diaper rash observations

This is the bounded scalar-observation foundation for issue #5 / PAR-018.
It records caregiver observations without diagnosis, inferred severity, treatment
advice, or inference from cream use or an older free-text note.

## Stored contract

| Field | Meaning | API limit |
| --- | --- | --- |
| `rashObserved` | `true`: observed; `false`: explicitly not observed; `null`: not recorded | Boolean or null only |
| `rashLocation` | Caregiver description of location | 200 UTF-16 code units |
| `rashDescription` | Caregiver description, including severity in their own words | 2,000 UTF-16 code units |
| `rashProductsApplied` | Products the caregiver records having applied | 1,000 UTF-16 code units |
| `rashFollowUpNotes` | Current caregiver follow-up note | 2,000 UTF-16 code units |

The string limits match browser `maxLength` and JavaScript validation. They are
product input limits, not clinical thresholds. Text is nullable and independent
of the observation status. Changing or clearing the status never silently clears
the other details. Clearing a text control explicitly sends null; untouched
fields are omitted. The API does not coerce strings or numbers to booleans.

Both the canonical diaper routes and the existing API-key hook activity routes
accept these fields. Hook POST/list/PUT details return all five values explicitly,
with the same shared scalar validation. Existing family, child, read/write scope
and revoked-key rules still apply; legacy clients that omit them preserve them.

The SQLite migration only adds nullable columns without defaults or backfill.
PostgreSQL continues to use the existing schema-sync path. Existing IDs, care
times, attribution, notes, cream/blowout flags, deleted state and profile values
remain unchanged. The canonical scalar backup inventory already includes diaper
rows; its SQLite boolean mapping now also converts `rashObserved` 0/1 while
preserving null. This is scalar backup support, not portable photo backup.

## Form and history

The active `forms/DiaperForm` exposes one-tap observed, explicit negative and
clear choices for all four diaper types. Optional details are labeled, bounded
and available in all twelve locales. Failed submissions retain the form and
show an error. New rash fields are sent only after a deliberate edit, so an old
cached response cannot clear newer observations. Unchanged care time is omitted;
reselecting the displayed minute retains the original seconds and milliseconds.

`src/utils/diaperRash.ts` supplies the shared labels and verbatim text to ordinary
timeline details, full-history search and export details. An absent status is
shown as **Not recorded**, including legacy records. Long and multiline details
wrap in both ordinary and full-history panels.

## Nursery upgrade compatibility

Nursery quick diaper actions continue to record an unknown observation.
Their persisted v1 record identity keeps the exact original field set and key
order in `diaperIdentityV1`. Newly added nullable fields are initialized in the
complete reconstructed row, but never added to the v1 request hash. Thus an old
pending request, a committed request whose response was lost, and its durable
receipt still identify the same action after upgrading.

`careRevision` omits only the five enumerated rash additions when their value is
null or absent. That preserves the hash in an unchanged pre-upgrade Undo
descriptor. Explicit false, true, empty text and all recorded text participate
in the hash. The atomic delete/update precondition still uses **every generated
scalar**, including all five rash columns, through `careSnapshot`.

A later rash edit therefore conflicts with the old Undo, including an edit at
the same `updatedAt` millisecond or one committed between the initial snapshot
read and the atomic claim. Replay never adopts an edited row as a fresh original
revision, never recreates a removed record and never removes the durable receipt.
Future schema additions need their own deliberate identity/revision treatment;
this exception is not a general rule to drop null fields from every model.

## Selected exports

CSV, XLSX and the selected-range PDF share the same authorized child, family,
date-range and activity-type selection in `/api/timeline/export`. Rash details
are included with explicit status and labeled caregiver text; cream does not
determine status. The full-history text search remains a screen filter and is
not an export filter, matching the existing CSV/XLSX behavior.

The PDF option was added to the existing export menu because the previous PDF
surface was a monthly aggregate report. Its internal `format=json` response
contains the same localized rows and is marked private/no-store. Browser layout
and the existing html2canvas/jsPDF dependencies preserve the rendered locale and
caregiver text. Text is inserted as text nodes, split only at grapheme boundaries
when a field spans pages, and captured one page at a time. Temporary export DOM
is removed on success or failure. The PDF is a visual document made of page
images; it is not a searchable or tagged PDF. CSV/XLSX retain selectable data.

Only the spreadsheet-facing selected CSV escapes leading formula markers with
an apostrophe, including markers after whitespace/control characters. XLSX
values are plain string cells; the JSON/PDF and database values stay literal.
Canonical backup data is not altered by this display/export escaping.

## Evidence and remaining scope

Coverage includes canonical/API boundaries, SQLite additive migration and
JSON/legacy/current SQLite restore, guarded PostgreSQL schema sync and restore,
pre-upgrade Nursery request/receipt/Undo behavior, atomic peer edits, selected
exports, and actual browser create/edit/reload/error/mobile/keyboard workflows.
Exact-source results and artifact receipts belong to the implementation PR and
issue #5; source presence alone is not acceptance.

Private diaper photos and same-child link authorization, retained upload/link
failures, portable media backup, timestamped follow-up history, bowel/rash trends,
complete caregiver handoff and pediatrician-report qualification remain under
issues #5/#16/#19/#22. PAR-018 stays IN PROGRESS. Production promotion and physical
device acceptance retain their separate evidence and approval boundaries.
