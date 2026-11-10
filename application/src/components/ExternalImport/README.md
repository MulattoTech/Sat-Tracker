# ExternalImport

Family-scoped external-platform import flow.

The component currently supports Baby Buddy CSV exports and guides family administrators through:

1. selecting CSV files;
2. previewing detected records and warnings;
3. configuring child destination, source timezone and source units;
4. reviewing the planned import;
5. executing the import and viewing created/already-imported counts.

External imports are additive. The importer does not use database restore endpoints and does not modify or delete existing Sprout Track records.

## Pumping disposition and milk stock

Baby Buddy's pumping model and CSV exporter do not record whether the milk was
stored, fed, or discarded. New imports therefore use the canonical string
`pumpAction: UNKNOWN`, displayed as **Needs review**, while retaining the pumped
total, unit, timestamps, notes and source provenance. Side amounts stay absent.
Neither notes, tags, nor unrecognized extra columns establish a disposition.
The Configure and Review steps explain this before any records are written.

An unresolved pump stays in pumping history but contributes no stored milk and
creates no feeding entry. Open it from the timeline, choose an action and save:
Stored adds its amount to stock; Fed follows the existing linked automatic-feed
behavior when milk tracking is enabled; Discarded and Needs review add no stock.
Saving an unrelated edit retains the unresolved action. Disposition-only edits
preserve the original timestamps, duration, amount, notes and absent sides.
Reverting a fed pump to Needs review removes its linked or eligible legacy automatic feed.
The legacy note-matching fallback is limited to pumps previously marked Fed,
so a newly imported session cannot adopt or delete another session's feed.

Reuploading the same source returns the existing target and does not undo a
caregiver's correction. Older imports already recorded as Stored remain
unchanged and need explicit review if their historical disposition was unknown.
New pumping imports use the same strict timestamp resolver as feeding: naive
times use the selected source timezone, explicit offsets retain their instant,
and ambiguous or nonexistent local times require source correction. Exact
endpoints are preserved; duration remains whole minutes rounded from actual
elapsed time after resolving both endpoints. Reversed endpoints are rejected
before rounding. Replay and unrelated edits preserve previously imported rows,
including their historical duration and disposition. See the
[pumping timing contract](../../../../docs/baby-buddy-pumping-import.md).

No schema or migration change is required: the database field is already a
string. Earlier images can read UNKNOWN and their stock queries still exclude
it, but show the raw label; their pump editor rejects an unchanged UNKNOWN save.
Full unresolved-state editing requires the new image. The hooks API continues
to read UNKNOWN but its accepted write actions remain unchanged; perform this
review through the app or `/api/pump-log`, which synchronizes linked feeds.
Hook feed-synchronization parity is separate work.

Upstream contract checked at Baby Buddy commit
[`2bd0461f5a7e407147bcfef363eb79dce6c9708d`](https://github.com/babybuddy/babybuddy/blob/2bd0461f5a7e407147bcfef363eb79dce6c9708d/core/models.py)
(`Pumping`) and its
[`core/admin.py` exporter](https://github.com/babybuddy/babybuddy/blob/2bd0461f5a7e407147bcfef363eb79dce6c9708d/core/admin.py).
Migrated SQLite/API tests and the actual wizard/edit/stock browser gate cover
the contract; source acceptance remains separate from deployment acceptance.

## Feeding timestamp fidelity

Baby Buddy bottle, breast and solid-food imports retain both source endpoints.
The canonical activity timestamp remains the session end, matching the existing
import convention. Feeding duration is the exact elapsed whole seconds between
the resolved UTC endpoints, so clock changes and midnight do not distort it.
The source timezone applies to timestamps without an offset. An explicit `Z`,
`+05:30`, `-06:00` or equivalent compact offset identifies its own instant and is
not reinterpreted in the selected timezone.

The importer rejects invalid calendar dates, missing endpoints, negative or
nonintegral-second durations, and naive times in a daylight-saving gap or fold.
It never chooses an occurrence of a repeated clock time automatically. The error
remains visible on the review screen; correct the source with its recorded UTC
offset or correct the invalid time and reselect the file. The entire batch rolls
back if a later record is invalid, including its source-provenance entries.

Reimporting a source ID returns its existing target unchanged. This repair does
not rewrite previously imported bottles with absent duration or historical
breastfeeding durations; those need explicit source reconciliation. Both-breast
and fortified-milk semantics, other timestamp adapters and generic import
undo remain separate acceptance work. Unit tests, migrated SQLite transaction
tests, and the disposable browser/API gate cover this bounded feeding contract;
production-image and physical-device acceptance remain separate release gates.

## Skipped files, activity-only children, and medication imports

- Files that don't match a supported Baby Buddy export are skipped rather than aborting the whole import. The Configure step surfaces a "Files that will be skipped" warning listing each skipped file and its reason; if none of the uploaded files are usable, the preview step blocks progression with an error instead.
- Children that only appear in activity files (no accompanying Child export) are still listed for mapping, but can only be added to an existing baby — the destination defaults to "existing" and the new-baby option is not offered for them. If no existing babies are available yet, the card prompts the user to create one first or include the Child export file.
- Medication entries with a recorded amount import as medicine logs, including an explicitly recorded zero. Entries without an amount are preserved as clearly labelled notes with an unknown dose, original timestamp, name, source unit/interval/notes and medication provenance. The `medication-dosage-missing` warning explains this before import. These notes do not contribute invented numeric doses to medicine reports. Reimporting the same source event remains idempotent, including events previously imported by older versions; this change does not rewrite existing history. A later corrected source dose needs explicit reconciliation rather than an automatic second record.
- When two or more imported children are mapped to the same existing baby, the Configure and Review steps show a non-blocking "Same destination selected for multiple children" warning (their records would be combined under one baby). Deliberate merging remains possible.
