# Family boundaries for care history

Care records and their related catalogs have independent family identifiers.
An older import or inconsistent database can therefore contain an owned care
event linked to another family's caretaker, medicine, or food. It can also
contain another family's care event whose child ID points at an owned child.
Authorization of the child alone does not authorize those rows or relations.

## Row scope

History queries require both the authenticated family and the authorized child.
The same predicate must apply before pagination, latest-record selection,
session grouping, daily counts, and history-derived reference choices. A
missing or mismatched care-row family is not inferred from the child ID.

The hook activity list, status summaries, active breastfeed state, latest
measurements, and sleep/play reference history follow this rule. Existing
canonical timeline and export row filters follow the same boundary. The child
access check and API-key child restrictions remain separate required checks.

## Historical related metadata

An owned care event remains visible when its caretaker or catalog relation
cannot be verified. Its own time, quantity, notes, reaction information and
identifiers remain part of that event. Foreign labels and catalog flags are
withheld.

`app/api/utils/careReadScope.ts` provides the shared display and classification
rules. Optional caretaker and food relations are queried with a family filter.
Medicine display queries select only name and family, and project the name
only when it belongs to the authenticated family.

Historical displays deliberately retain metadata for deleted related records
in the same family. Live catalog selectors continue to apply their own active
and deletion rules. Do not add live-catalog filters to a historical join and
silently remove the care event or its legitimate historical label.

Food timeline metadata comes from the family-scoped catalog lookup. Neither
`foodItems` nor the legacy top-level `food` relation may fall back to an
unverified catalog item. When metadata is unavailable, the allergen flag is
absent, rather than newly asserting that the food is not an allergen. CSV and
XLSX share the same scoped display projection and retain the owned event with
blank unavailable labels.

## Medicine and supplement classification

`isSupplement` is catalog metadata. A foreign catalog's flag must not determine
the category of an owned dose, even if its name is hidden.

| Related catalog | Public category | Public name |
| --- | --- | --- |
| Same family, `isSupplement: true` | Supplement | Owned catalog name |
| Same family, `isSupplement: false` | Medicine | Owned catalog name |
| Other family or unresolved catalog family | Medicine | `null` / unavailable |

`medicineCategoryWhere` implements this partition before filtering limits,
latest selection and counts. Each owned dose belongs to exactly one category.
Nullable catalog family needs an explicit predicate because SQL inequality
does not match null.

The hook activity mutation lookup uses the same classification. An owned dose
with an unverified catalog can be corrected as generic medicine without
disclosing the foreign name in the response. Typed and untyped deletion also
use the same category; requesting the foreign catalog's supplement category
does not reveal or select it. Normal owned medicine/supplement mutations keep
their existing categories. Writable-key permission, child and care-row family
checks remain required.

This changes classification and response selection for inconsistent joins; it
does not broaden accepted mutation fields, replace catalog associations, repair
historical data, or change the schema.

## Verification

`tests/familyReadBoundaries.integration.test.ts` runs the actual route wrappers
against migrated disposable SQLite. It obtains ordinary USER tokens through
`/api/auth` and keys through the real admin key-issuance route. It covers foreign
and nullable row/catalog families, all hook activity types, limit-one selection,
status and aggregate queries, original owned/deleted metadata, both export
formats, notes-only responses, and typed/untyped deletion compatibility.

`scripts/family-read-boundary-http.mjs` provides seven authenticated HTTP checks
against the compiled local application through the acceptance runner. These
checks use their own synthetic families and real logins and keys; they do not
reuse a live browser session. The required
`familyReadBoundaryChecksPassed` flag prevents a skipped module from satisfying
the release gate. The HTTP checks are labeled explicitly in the shared browser
acceptance report; no UI interaction is claimed for them.
