# DiaperForm

The active diaper editor creates and updates wet, dirty, wet-and-dirty, and dry records. It is used by Log Entry and the timeline editors. The older DiaperModal is not part of this flow.

## Props

| Prop | Type | Purpose |
| --- | --- | --- |
| `isOpen` | `boolean` | Opens the form page. |
| `onClose` | `() => void` | Closes the editor. |
| `babyId` | `string \| undefined` | Identifies the selected child. |
| `initialTime` | `string` | Initial event time for a new entry. |
| `activity` | `DiaperLogResponse` | Optional existing entry to edit. |
| `onSuccess` | `() => void` | Refreshes the caller after a successful write. |

Family authorization is enforced by the API using the authenticated session. This component does not accept a client-selected family ID.

## Observational rash capture

`DiaperRashFields` presents three keyboard-accessible, mutually exclusive pressed buttons. **Rash observed** records `true`; **No rash observed** records `false`; **Clear rash observation** records `null` (not recorded). A new or legacy record starts unknown. Cream use, diaper type, and caregiver text never decide rash status. Clearing the status leaves optional text intact; each text field can be cleared separately.

The optional fields are rash location (200 characters), description (2,000), products applied (1,000), and follow-up notes (2,000). They record caregiver observations without diagnosis, severity scoring, treatment advice, or inferred relationships. Limits are shared with the API through `DIAPER_RASH_TEXT_LIMITS`. HTML `maxLength` and the API use UTF-16 string length. Nonblank text remains verbatim; a caregiver clearing a text field sends `null`.

All four diaper types expose these controls. Stool condition and color retain their existing dirty/both behavior. The independent cream, blowout, and general notes fields remain available.

## Editing and failures

The draft initializes on opening a record and survives failed saves and same-record refreshes. Only touched rash fields enter the payload, protecting newer stored data when a legacy cached activity lacks those fields. Untouched fields are omitted for both new entries and edits; the API supplies null defaults for new records.

The date/time picker edits minutes. When the selected instant remains within the original minute, the update omits `time`, preserving stored seconds, milliseconds, and the original instant. A changed minute is sent as an ISO timestamp; repeated wall-clock times across a DST change remain distinct instants.

Save failures show a localized inline alert and keep every field on screen for retry. A successful response closes the editor and refreshes the caller. Closing and reopening a new-entry form starts a fresh draft.

## History and search

`src/utils/diaperRash.ts` supplies the same explicit true/false/unknown wording to timeline details, compact summaries, and selected-range exports. Full Log search includes every optional rash text plus localized status and labels. Diaper detail rows stack on narrow screens and wrap long text while preserving line breaks.

Photos, timestamped follow-up history, complete caregiver handoff, and clinical interpretation are outside this component's current scope.

## Verification

`tests/diaperRashPresentation.test.ts` covers status distinctions, caregiver-text preservation, actual history formatting for all four diaper types, legacy omission, explicit clears, length boundaries, and timestamp preservation including the repeated DST hour. The translation suite verifies every new message in all twelve locales. The separate browser acceptance harness verifies real create/edit/failure/history/search and responsive keyboard interactions with synthetic records.
