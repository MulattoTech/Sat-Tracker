# Child age and recorded gestation

This is the profile/header foundation for issue #15 and PAR-042. It adds
recorded gestational context and one shared daily-age calculation. Growth
references, historical milestone interpretation, sleep planning and physical
device acceptance retain their separate integration requirements.

## Canonical data

`Baby.gestationalAgeDays` is a nullable integer. The profile presents weeks and
days and stores their sum. Existing children retain `null`; unknown gestation
is never inferred from birth date, weight, care history or missing fields.
The API accepts whole numbers from 1 through 315 days. That 45-week ceiling is
a product input bound, not a clinical classification or viability rule.
An omitted field on update preserves its value, while an explicit `null`
clears it. The form omits untouched gestation, including on older cached
profiles that lack the property.

The additive SQLite migration adds only the nullable column. PostgreSQL uses
the repository's existing schema-sync path. Both baby creation routes and the
ordinary update route retain their existing family and role authorization.
No historical birth timestamp, care record or profile is backfilled. Generic
JSON/SQLite backup scalar handling carries the new value and its null state.

## Calculation and labels

`src/utils/childAge.ts` exports `calculateChildAge` and the canonical input
guard. The calculation takes an explicit birth value, gestation, reference
date (`asOf`) and display timezone. Its result distinguishes:

| State | Meaning |
| --- | --- |
| `invalid` | A date, timezone or gestation is invalid, or the reference calendar day precedes birth. |
| `unknown` correction | The birth date supports chronological age, but gestation is not recorded. |
| `not-applicable` correction | Recorded gestation is at least 37 completed weeks. |
| `before-due-date` | A recorded preterm birth has not yet reached its derived due-date reference. The remaining days are shown explicitly. |
| `corrected` | Corrected age is available alongside chronological age. Zero days at the due-date reference is valid. |

The American Academy of Pediatrics describes corrected age as chronological
age minus the interval born early, using 40 weeks minus gestational age at
birth for that interval. WHO defines preterm birth as before 37 completed
weeks. The calculation therefore uses a 280-day anchor for recorded gestation
below 259 days; the 40-week anchor does not classify a 38- or 39-week birth as
preterm. Gestational days are preserved rather than rounded to whole weeks.

- [AAP: Corrected Age for Preemies](https://www.healthychildren.org/English/ages-stages/baby/preemie/Pages/Corrected-Age-For-Preemies.aspx)
- [WHO: Preterm birth](https://www.who.int/news-room/fact-sheets/detail/preterm-birth)

The AAP discussion concerns developmental context during the first two years.
This foundation displays ages and retains historical calculation beyond that
period; it does not evaluate development, diagnose delay, change vaccine
schedules or prescribe feeding/sleep behavior. That display policy is a
product choice, distinct from clinical guidance.

The returned `estimatedDueDate` is derived from the recorded birth and
gestation. It is not a separately recorded clinician-provided due date.
Chronological and corrected values remain separately labelled. Missing
gestation has an explicit unknown state; a negative corrected interval is
shown as time before the estimated due date rather than clamped to zero.

## Calendar and timezone contract

Stored birth instants and their millisecond precision are preserved. Date
objects and offset-qualified ISO strings are projected into the explicitly
requested IANA display timezone, then age is computed from calendar dates.
A literal `YYYY-MM-DD` is already a calendar date. Ambiguous offset-free
timestamps, impossible dates and unsupported calendar years are rejected.
The helper never reads the host timezone or changes its input Date objects.

The current profile does not record a separate birth-calendar timezone. The
UI uses the existing `userTimezone` context. Different display timezones can
place an instant on different calendar days; this policy is explicit rather
than silently rewriting stored dates. Tests hold the requested timezone fixed
while changing the host timezone, and also cover local midnight and DST.

Age spans include total days, weeks plus days, and completed calendar months
and years. Month anniversaries clamp to the target month's last day: January
31 reaches one month on February 28/29, and a February 29 birthday reaches the
following year's anniversary on February 28. No 30.44-day or 365.25-day average
is used. The UI formats these spans with localized units.

## UI and cache integration

Both existing BabyForm appearances use the shared gestational controls and
age display. An unchanged birthday keeps its original instant even when the
caregiver opens the date picker and selects the same displayed day. Successful
profile saves notify the family layout; a same-ID selected child is replaced
with the fresh server record. This prevents stale header ages after edits.
The child selector/header and retained chronological quick-info callback use
the shared calculation. Existing cached children without gestation still load.

## Verification boundaries

- `tests/childAge.test.ts`: known formula cases, gestational precision,
  unknown/invalid/term states, before/on due date, historical references,
  month/year/leap boundaries, timezone/DST and input immutability.
- Existing baby-create and care-write integration suites: both real creation
  paths, read/update, omission/null behavior and family authorization.
- Additive SQLite upgrade and actual backup/restore tests preserve original
  birth and care values as well as the new scalar.
- A separate disposable PostgreSQL CI job verifies that provider's schema
  upgrade and JSON export/restore, independently of SQLite results.
- The required synthetic browser module exercises actual profile edits,
  immediate header refresh, both form appearances, child switching, old
  cached records, validation, clearing and owned fixture cleanup.

Source tests and viewport checks do not establish physical-device or deployed
acceptance. PAR-042 stays IN PROGRESS until its remaining consumers and release
evidence are qualified. All automated fixtures are synthetic.
