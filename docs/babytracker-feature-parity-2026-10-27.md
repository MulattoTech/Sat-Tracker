# BabyTracker feature parity: Sprout Track 1.6.7 and Baby Buddy v2.11.0

**Evidence date:** 2026-10-27. **Tracking:** [#34][i34] (Baby Buddy release review), [#13][i13] (compatibility), [#21][i21] (product union), [#29][i29] (acceptance).

## Decision and scope

Retain Sprout Track 1.6.7 as the application baseline and extend its existing models, APIs and Baby Buddy importer. The source already implements most ordinary care domains. Remaining work is a mixture of specific semantic differences, missing concepts, integration compatibility and acceptance evidence; it is not a mandate to rebuild the tracker or write a second Baby Buddy importer.

This document compares exactly these revisions:

| Reference | Pinned revision | Verification |
|---|---|---|
| Installed Sprout baseline identified for this work | `462246d9653c805cac87ee4e860fec7b54367f8a` | `package.json` declares `1.6.7`; inspected the immutable Git objects for schema, routes, UI, importer and tests. This source review does not independently re-attest the running production image. [S-version] |
| Official Baby Buddy | tag `v2.11.0`, commit `4c14f7428f24a725710d8deb03d5f28105e4da4e` | Official tag resolved with read-only `git ls-remote`; model, API, report, import/export and timer sources retrieved from that tag. [B-models] [B-api] [B-reports] |

Sprout 1.6.8 and the two concurrent OCR feature branches are **outside this baseline comparison**. Their implementation or CI results must not be counted as installed 1.6.7 parity. The existing [#36][i36] owns the 1.6.8 upstream review. OCR remains under [#37][i37] → [#38][i38] → [#11][i11] → [#12][i12], with release evidence in [#29][i29]. No upgrade, merge, clinical assessment or real-family data operation was performed for this matrix.

### How to read the status

- **Present** means the pinned source contains a concrete model and relevant implementation. It does not mean the whole feature has passed BabyTracker acceptance.
- **Partial** means useful implementation exists, but a specific field, workflow or compatibility difference is identified below.
- **Not found** describes the inspected pinned core/schema, not every third-party extension or future release.
- **Acceptance pending** means the complete contract has not been demonstrated here: create/edit/delete, permissions, validation, API and import/export fidelity, reporting, mobile usability and migration safety. Existing tests are evidence of implemented checks, not a claim that a new full end-to-end run occurred.

The older `FEATURE_PARITY_MATRIX.md` describes the desired product union. This document supplies versioned evidence and corrections; it does not silently turn planning requirements into upstream capabilities or mark their issues complete.

## Eighteen-category implementation matrix

All Sprout schema references below point to the pinned [schema][S-models]; all Baby Buddy model references point to its pinned [core models][B-models]. More specific route, UI and test references follow the tables.

| # | Category | Official Baby Buddy v2.11.0 | Sprout Track 1.6.7 implementation | Comparison and existing owner |
|---|---|---|---|---|
| 1 | Feeding and breastfeeding | `Feeding` separates food **type** (breast milk, formula, fortified breast milk, solid food) from **method** (bottle, left/right/both breasts, parent/self fed). Start/end, duration, optional amount, notes and tags are stored. [B-models] | `FeedLog` supports BREAST/BOTTLE/SOLIDS, volume/unit, left/right, start/end, active duration, pause duration, linked session ID, bottle content, mixed breast-milk volume and reactions. `ActiveBreastFeed` stores pause/resume and side state; dedicated feed forms and APIs exist. [S-models] [S-feed] | **Partial semantic parity; substantial implementation present.** Both-breast source semantics, fortified milk, feeding method versus content, tags and import duration conventions require explicit preservation. Extend existing work under [#3][i3], [#13][i13]. |
| 2 | Diapers | `DiaperChange` stores independent wet/solid booleans, color, optional numeric amount, notes and tags. Both booleans false can represent neither wet nor dirty. [B-models] | `DiaperLog` has WET/DIRTY/BOTH/DRY, condition, color, blowout, cream and notes; form, log API, statistics and nursery flows exist. No numeric diaper amount or generic tags field is present. [S-models] [S-diaper] | **Partial.** Preserve numeric amount independently of condition. Existing Baby Buddy mapping already handles DRY and warns about unsupported amount and wet-only color. [#5][i5], [#13][i13]. |
| 3 | Sleep | `Sleep` stores start/end, computed duration, nap boolean, notes and tags; generic timers can become sleep entries. Configured time ranges can determine nap classification when unset. [B-models] [B-timers] | `SleepLog` has start/optional end, duration, NAP/NIGHT_SLEEP, location, quality and notes. Sleep form, API, active nursery workflow and reports are present. [S-models] [S-sleep] | **Present core tracking; partial compatibility.** Verify nap classification, ongoing versus completed entries, tag preservation, overnight/DST durations and report agreement. Predictive sleep is separate product work, not established by these tracking models. [#6][i6], [#13][i13]; prediction remains [#7][i7]–[#9][i9]. |
| 4 | Pumping and milk inventory | `Pumping` records start/end, duration, total amount, notes and tags. The inspected core does not provide Sprout's stored/fed/discarded inventory model. [B-models] | `PumpLog` supports left/right/total volume, unit, optional end, duration and disposition. `BreastMilkAdjustment` records signed adjustments/reasons; feeds can link to a pump and record mixed-milk consumption. Inventory logic/tests already exist. [S-models] [S-inventory-test] | **Present with Sprout-specific extensions; import semantics partial.** Existing importer defaults Baby Buddy pumping to STORED and warns. Test resulting inventory, conversion and duplicate replay; do not invent an upstream disposition. [#4][i4], [#13][i13]. |
| 5 | Growth measurements | Separate BMI, weight, height and head-circumference models store date/value, notes and tags. Sex-specific weight/height percentile models and report routes exist. [B-models] [B-reports] | `Measurement` supports HEIGHT, WEIGHT, HEAD_CIRCUMFERENCE and TEMPERATURE with value/unit/date/notes. CDC/WHO reference tables, growth charts and standard-selection policy exist. No BMI measurement enum exists. [S-models] [S-growth] | **Partial.** Preserve direct BMI observations or explicitly exclude them; do not equate BMI with a height/weight chart. Verify date precision, units and reference labels using golden data. Existing importer identifies BMI as unsupported. [#15][i15], [#13][i13], [#19][i19]. |
| 6 | Medication | `Medication` stores name, optional dosage, a limited dosage-unit vocabulary, time, optional next-dose interval, notes and tags. `next_dose_time` is derived per entry. [B-models] | `Medicine` catalogue plus `MedicineLog` dose events, units, minimum interval, notes, active state and supplement flag; management/administration UI and reports exist. [S-models] [S-medicine] | **Partial semantic parity.** Compare per-dose versus catalogue interval semantics, optional dosage and units. Existing importer maps missing dosage to zero with a warning; that is not lossless preservation of “unknown.” [#15][i15], [#13][i13]. |
| 7 | Temperature | Dedicated timestamped `Temperature` values with notes/tags, API and chart. [B-models] [B-api] [B-reports] | `Measurement.type=TEMPERATURE`, explicit unit, timestamp, notes, measurement form/API and temperature reports; existing importer requires a source unit. [S-models] [S-measurement] [S-import-remaining] | **Present; acceptance pending.** Prove unit conversion, timestamp preservation and report/export identity. Tags remain a separate gap. [#15][i15], [#13][i13], [#19][i19]. |
| 8 | Tummy time | Dedicated `TummyTime` with start/end, duration, milestone text, notes and tags; generic timer conversion. [B-models] [B-timers] | `PlayLog.type=TUMMY_TIME`, duration/start/end, notes and activities; `ActiveActivity` stores timing/pause state and subcategory. Activity form, API and nursery flow exist. [S-models] [S-activity] | **Present via existing play model; import partial.** Current mapper places source milestone text in notes, but does not combine the separate Baby Buddy notes field. Preserve both texts and provenance rather than overwriting either. [#17][i17], [#13][i13]. |
| 9 | Milestones | Tummy-time milestone text exists; no separate general `Milestone` model appears in the pinned core model inventory. [B-models] | Dedicated `Milestone` with date, title, description, categories including CUSTOM, age-in-days and photo association; form/API and report sections exist. [S-models] [S-milestones] | **Present Sprout capability.** Do not misclassify a Baby Buddy tummy-time text field as an equivalent milestone catalogue. Confirm linked media, edits and export behavior under [#16][i16], [#19][i19]. |
| 10 | Notes and organization | `Note` has timestamp, free text, optional image and generic tags. Tags also attach to many care models. [B-models] | `Note` has timestamp, content and optional category; `Photo`, `PhotoLink` and related models support media association elsewhere in the model. No generic Tag/Tagged model is present. [S-models] [S-note] | **Partial.** Text notes already exist and import; category is not a substitute for many-to-many tags. Verify Baby Buddy note-image migration separately from text and preserve unsupported attachment references. [#17][i17], [#16][i16], [#13][i13]. |
| 11 | Timers | Independent named `Timer` objects belong to a user, optionally a child; start/edit/restart/delete and consumption into duration entries are implemented. Consumption has ownership/permission checks. [B-models] [B-timers] [B-api] | Domain-specific active breastfeeding/activity records and ongoing sleep/pump records exist; breastfeeding stores pause and side totals. No independent generic Timer model appears in the schema. [S-models] [S-timers] | **Partial.** Reuse domain timers; define whether a generic reusable timer is required and how it converts atomically without duplication. Generic timer lifecycle/wire compatibility is owned by [#17][i17], [#18][i18]. |
| 12 | Custom activities | Generic tags, notes and named timers provide flexibility; no arbitrary user-defined event-schema model appears in the pinned core. [B-models] | `PlayType.CUSTOM`, free-text activities/notes, custom milestone categories and custom calendar types exist in the schema. This alone does not prove a complete configurable activity builder or every UI path. [S-models] [S-activity] | **Partial product requirement, not a missing copied Baby Buddy feature.** Verify actual create/edit/report/export support for each custom type before designing extensions. [#17][i17], [#16][i16], [#24][i24]. |
| 13 | Reporting and summaries | Child-specific reports cover feeding quantities/durations/intervals/patterns, diaper counts/amounts/intervals, sleep patterns/totals, pumping, growth, temperature, tummy time and medication. [B-reports] | Reports UI includes activity, health, growth, heatmaps, milestones and monthly report cards; monthly report API and PDF generation exist. [S-reports] [S-monthly] | **Present, with calculation parity unverified.** Compare equivalent totals and intervals over identical fixtures rather than matching screen names. PDF output is already implemented; qualify it instead of rebuilding it. [#19][i19], [#29][i29]. |
| 14 | Charts and analytics | Report routes include BMI, growth, diaper amounts, feeding intervals/patterns, sleep patterns/totals and medication frequency/intervals; graph-specific tests exist in `reports/tests/graphs/`. [B-reports] [B-tree] | Dedicated chart components include feeding, sleep, pumping, diapers, health, play, growth and heatmaps. `growthStandard.ts` selects WHO versus CDC and applies an age-based fallback; related tests exist. [S-reports] [S-growth] | **Partial result parity.** The datasets, windows and formulas are not interchangeable merely because both render charts. BMI and numeric diaper-amount charts depend on fields Sprout currently lacks. [#15][i15], [#19][i19], [#29][i29]. |
| 15 | Import, export and portability | Django admin import/export supports multiple formats, including CSV/XLSX, with validation. `core/admin.py` defines model resources and tags; fixture-based import/export tests exist. [B-import] [B-admin] | **Baby Buddy CSV importer already built:** detection, preview, source units/timezone, child mapping, warnings, normalized records and family-scoped transactional execution/provenance. Timeline CSV/XLSX export and database backup/restore paths also exist. [S-import] [S-export] [S-import-tests] | **Partial fidelity, not missing infrastructure.** Audit the existing adapter against v2.11.0; extend its warnings/mappings and golden tests. A timeline export is not automatically a lossless portable archive or a Baby Buddy-compatible export. [#13][i13], [#12][i12], [#14][i14], [#19][i19]. |
| 16 | APIs and integrations | DRF model endpoints, token/session authentication, filtering/pagination and live OpenAPI schema; medication is in actual routes even though the prose endpoint list is older. README lists separate MCP, Home Assistant and mobile projects. [B-api] [B-api-doc] [B-readme] | App APIs plus `/api/hooks/v1` read/create/update/delete activity endpoints, family/baby-scoped hashed API keys, scopes, expiry, revocation and rate limiting are implemented/documented. [S-hooks] [S-hook-tests] | **Partial protocol parity.** Different URLs, auth schemes, identifiers, payloads and pagination mean no automatic Baby Buddy wire compatibility. “Webhook API” here is an inbound HTTP interface, not evidence of signed outbound callbacks. External MCP/HA projects are separate integrations. [#18][i18], [#22][i22], [#13][i13]. |
| 17 | Mobile, installability and offline operation | Responsive mobile UI and a web manifest are present; official README links separately maintained mobile clients. The inspected core tree supplies no demonstrated offline write-queue/reconciliation implementation. [B-readme] [B-tree] | Responsive UI, PWA manifest, push worker, nursery/night mode and native-shell adaptation exist. `public/sw.js` uses an empty fetch listener for installability and handles push; it does not implement a care-entry offline queue. [S-sw] [S-native] | **Partial.** Installability and a native wrapper do not establish offline writes. Phone/iPad accessibility and interrupted/offline reconciliation require acceptance under [#2][i2], [#23][i23], [#29][i29]. |
| 18 | Prematurity, due date and corrected age | **Not found in pinned core Child model:** it has birth date and optional birth time, but no due date, gestational age or corrected-age field. Do not attribute this capability to Baby Buddy v2.11.0 without separate evidence. [B-models] | `Baby` has birthDate and gender, but no due-date, gestational-age or corrected-age field in this baseline. Importer explicitly warns that separate birth time is unsupported. [S-models] [S-import-warnings] | **Missing product capability in the compared core models.** Correct the older matrix's Baby Buddy attribution. Treat corrected age as a deliberate BabyTracker domain extension, with defined storage/calculation contracts and tests, under existing [#1][i1], [#15][i15], [#13][i13]. |

## Existing evidence and remaining acceptance checks

No row is declared end-to-end **COMPLETE** by this source audit. The following tests and behavior checks already exist; they should be extended, not replaced by a parallel implementation.

| Area | Existing Sprout evidence at the pinned revision | Acceptance still required under existing issues |
|---|---|---|
| Feeding and timers | `tests/activeBreastFeed.test.ts`, `activeBreastFeedActions.test.ts`, `breastfeedStart.test.ts`, `feedSessionUtils.test.ts`, `feedTimerConfig.test.ts`, `pauseDisplay.test.ts`; concrete active-session models. [S-tests] | Golden pause/resume/side-switch totals; both-breast source preservation; interrupted and concurrent actions; caregiver/family isolation; phone and tablet flow. #3, #17, #22, #29. |
| Pumping/inventory | `tests/breastMilkInventory.test.ts`, `nursery-pump-session.test.ts`; pump and adjustment models. [S-tests] | Stored/fed/discarded corrections, mixed units, imported disposition acknowledgement, duplicate-safe accounting and ordinary edit/export parity. #4, #13, #29. |
| Diaper, sleep, activity | `tests/diaperStats.test.ts`, `sleepLocationUtils.test.ts`, `activityHook.test.ts`, nursery activity tests; forms/routes and importer mapping tests. [S-tests] | Numeric diaper amount versus condition; source tags; midnight/DST and ongoing durations; tummy-time milestone plus notes; report totals. #5, #6, #17, #19. |
| Measurements and medication | `tests/measurementConversion.test.ts`, `growthStandard.test.ts`, `growthChartAxis.test.ts`; medication/temperature import mappings and report components. [S-tests] [S-import-medicine] | BMI representation; date-only versus timestamp precision; unknown dosage versus zero; per-entry interval preservation; unit round trips. These are data-contract checks, not dosage or clinical recommendations. #13, #15, #19. |
| Notes, milestones, custom activity | Dedicated schema/forms/routes; generic tags absent. [S-models] [S-note] [S-milestones] | Verify full CRUD, attachment authorization/export and custom-type rendering; add generic tags only under the agreed domain contract. #16, #17, #22, #25. |
| Reporting/charts/export | `tests/monthly-report-card.helpers.test.ts`, growth/diaper/feed statistics tests; monthly report API, PDF rendering and CSV/XLSX export. [S-tests] [S-monthly] [S-export] | Same synthetic events → agreed expected totals, intervals, unit labels and exported values; cross-midnight/date-window cases; no hidden unsupported-field loss. #19, #29. |
| Import/provenance | `babyBuddyImportParsing.test.ts`, `babyBuddyImportMapping.test.ts`, `babyBuddyPreview.test.ts`, `babyBuddyRealExportIntegration.test.ts`, `externalImportExecution.test.ts`, `externalImportDestinations.test.ts`. Tests cover real-export-shaped fixtures, localized decimals, child mapping, existing provenance and cross-family rejection; several execution tests use mocked delegates. [S-import-tests] [S-execute-tests] | Pin fixture generation to v2.11.0, assert every supported/unsupported field, test actual DB transactions/concurrency and recovery, and compare API/UI/report/export output. Source presence and mocked tests are not a production migration proof. #12, #13, #22, #29. |
| APIs/mobile/platform | Hook mutation/reference tests, native-shell tests and PWA tests; scoped integration documentation. [S-hook-tests] [S-tests] | Endpoint-by-endpoint compatibility contract, permissions/expiry, offline reconciliation, real phone/iPad checks, backup/restore and migration rehearsal. #2, #18, #20, #22, #29, #30. |

## Reuse the existing Baby Buddy adapter

The pinned implementation is already a coherent pipeline:

`ExternalImport UI → /api/import/external/preview → provider detection/parsing → child/timezone/unit configuration → normalized records → /api/import/external/execute → executeExternalImport → existing Sprout care tables + ExternalImportRecord`.

Its main source directory is `src/lib/importers/baby-buddy/`; common execution and provenance live in `src/lib/importers/execute.ts`, `plan.ts`, `provenance.ts` and `timezone.ts`. `src/components/ExternalImport/README.md` describes the administrator flow and skipped-file behavior. [S-import] [S-execute]

Prioritize these bounded audits within #13 rather than creating another importer:

1. **Retain existing explicit warnings.** `warnings.ts` already counts unsupported birth time, tags, BMI, both-breast side, breast-feed amount, diaper amount, wet-only color, pump disposition and missing medication dosage. Existing warning coverage is useful evidence; it is not proof of lossless migration. [S-import-warnings]
2. **Preserve type versus method.** `map.ts` imports both-breast feeding without inventing LEFT/RIGHT, places parent/self-fed method in notes for bottle-like records, and maps non-formula/non-breast-milk bottle contents to Other. Fortified milk and source method need an explicit retained representation or an actionable exclusion. [S-import-map]
3. **Preserve separate fields.** `remaining-map.ts` maps tummy-time milestone into notes but does not preserve the separate source notes field there. Generic source tags are warned about rather than stored. Birth date is imported while separate birth time is omitted. Record these as known fidelity limitations, not absent domain logging. [S-import-map] [S-import-remaining] [S-import-warnings]
4. **Distinguish unknowns from defaults.** Pump records become STORED with a warning; missing medication dosage becomes zero with a warning. These transformations must be explicitly accepted or replaced by a documented representation that preserves source meaning. [S-import-remaining] [S-import-medicine]
5. **Test the target export, not merely plausible CSV.** Reuse existing fixture and unit/decimal tests, then add v2.11.0 golden exports and actual database replay. Verify elapsed time, timezone/DST, child identity, source IDs, unsupported fields and export results. Do not call the current fixture suite complete v2.11.0 acceptance without this comparison. [S-import-tests] [B-import-tests]

## Corrections to planning assumptions

- Due date/corrected age is a desired BabyTracker capability, **not established Baby Buddy v2.11.0 core functionality**. The direct model comparison above is the controlling evidence for this version. #1/#15 remain its implementation owners.
- A generic named timer is different from an arbitrary custom activity schema. Baby Buddy provides the former; neither inspected core establishes a complete user-defined event-schema builder.
- Baby Buddy's mobile, MCP and Home Assistant links describe separate projects. Their existence does not prove those clients are bundled, deployed or compatible with this Sprout installation. [B-readme]
- Sprout's `/api/hooks/v1` supports real scoped integration operations already. A future Baby Buddy-compatible API or signed outbound webhook contract should be added around that implementation under #18, not justified by claiming Sprout has no API. [S-hooks]
- A web manifest/service worker does not establish an offline transaction queue. The installed Sprout push worker does not provide one. [S-sw]
- OCR library installation, a green feature-branch build or a successful printed fixture does not establish handwriting accuracy or ordinary-feature parity. Keep those acceptance tracks separate in #11/#29.

## Licensing and change boundary

The official Sprout 1.6.7 `LICENSE.md` is a custom license with attribution, non-commercial and share-alike conditions; preserve its notices and the exact applicable terms. Official Baby Buddy v2.11.0 uses BSD-2-Clause, requiring preservation of its notices/conditions/disclaimer in applicable redistribution forms. These are different licenses; Baby Buddy's license does not replace the Sprout derivative's obligations. Consult the primary texts when evaluating a concrete redistribution or commercial proposal. [S-license] [B-license]

This document copies no application code, imports no Git history and authorizes no deployment. Continue with contracts, mappings and independently tested behavior. #34 explicitly requires isolated qualification and verified backup/restore before promotion and does not authorize automatic production updates. All listed follow-up work maps to existing issues; no new issues were created. [i34]

## Primary source register

Source links are pinned to the inspected revision/tag. Directory links identify the precise implementation/test families; named paths were checked against the pinned trees, with the core models, mapping functions, warnings, selected test assertions and documentation read using `git show` or official GitHub file retrieval. Merely identifying a test file is not evidence that it passed. The source audit did not execute Baby Buddy's runtime or its full test suite, did not run a new complete Sprout suite, and did not inspect personal records.

[S-version]: https://github.com/MulattoTech/BabyTracker-App/blob/462246d9653c805cac87ee4e860fec7b54367f8a/package.json
[S-models]: https://github.com/MulattoTech/BabyTracker-App/blob/462246d9653c805cac87ee4e860fec7b54367f8a/prisma/schema.prisma
[S-feed]: https://github.com/MulattoTech/BabyTracker-App/tree/462246d9653c805cac87ee4e860fec7b54367f8a/src/components/forms/FeedForm
[S-diaper]: https://github.com/MulattoTech/BabyTracker-App/blob/462246d9653c805cac87ee4e860fec7b54367f8a/app/api/diaper-log/route.ts
[S-sleep]: https://github.com/MulattoTech/BabyTracker-App/tree/462246d9653c805cac87ee4e860fec7b54367f8a/src/components/forms/SleepForm
[S-inventory-test]: https://github.com/MulattoTech/BabyTracker-App/blob/462246d9653c805cac87ee4e860fec7b54367f8a/tests/breastMilkInventory.test.ts
[S-growth]: https://github.com/MulattoTech/BabyTracker-App/blob/462246d9653c805cac87ee4e860fec7b54367f8a/src/utils/growthStandard.ts
[S-medicine]: https://github.com/MulattoTech/BabyTracker-App/tree/462246d9653c805cac87ee4e860fec7b54367f8a/src/components/forms/MedicineForm
[S-measurement]: https://github.com/MulattoTech/BabyTracker-App/blob/462246d9653c805cac87ee4e860fec7b54367f8a/app/api/measurement-log/route.ts
[S-activity]: https://github.com/MulattoTech/BabyTracker-App/blob/462246d9653c805cac87ee4e860fec7b54367f8a/src/components/forms/ActivityForm/index.tsx
[S-milestones]: https://github.com/MulattoTech/BabyTracker-App/blob/462246d9653c805cac87ee4e860fec7b54367f8a/app/api/milestone-log/route.ts
[S-note]: https://github.com/MulattoTech/BabyTracker-App/blob/462246d9653c805cac87ee4e860fec7b54367f8a/app/api/note/route.ts
[S-timers]: https://github.com/MulattoTech/BabyTracker-App/blob/462246d9653c805cac87ee4e860fec7b54367f8a/app/api/active-activity/route.ts
[S-reports]: https://github.com/MulattoTech/BabyTracker-App/tree/462246d9653c805cac87ee4e860fec7b54367f8a/src/components/Reports
[S-monthly]: https://github.com/MulattoTech/BabyTracker-App/blob/462246d9653c805cac87ee4e860fec7b54367f8a/src/components/Reports/MonthlyReportCard/index.tsx
[S-import]: https://github.com/MulattoTech/BabyTracker-App/blob/462246d9653c805cac87ee4e860fec7b54367f8a/src/components/ExternalImport/README.md
[S-import-map]: https://github.com/MulattoTech/BabyTracker-App/blob/462246d9653c805cac87ee4e860fec7b54367f8a/src/lib/importers/baby-buddy/map.ts
[S-import-remaining]: https://github.com/MulattoTech/BabyTracker-App/blob/462246d9653c805cac87ee4e860fec7b54367f8a/src/lib/importers/baby-buddy/remaining-map.ts
[S-import-medicine]: https://github.com/MulattoTech/BabyTracker-App/blob/462246d9653c805cac87ee4e860fec7b54367f8a/src/lib/importers/baby-buddy/medication-map.ts
[S-import-warnings]: https://github.com/MulattoTech/BabyTracker-App/blob/462246d9653c805cac87ee4e860fec7b54367f8a/src/lib/importers/baby-buddy/warnings.ts
[S-import-tests]: https://github.com/MulattoTech/BabyTracker-App/blob/462246d9653c805cac87ee4e860fec7b54367f8a/tests/babyBuddyRealExportIntegration.test.ts
[S-execute-tests]: https://github.com/MulattoTech/BabyTracker-App/blob/462246d9653c805cac87ee4e860fec7b54367f8a/tests/externalImportExecution.test.ts
[S-execute]: https://github.com/MulattoTech/BabyTracker-App/blob/462246d9653c805cac87ee4e860fec7b54367f8a/src/lib/importers/execute.ts
[S-export]: https://github.com/MulattoTech/BabyTracker-App/blob/462246d9653c805cac87ee4e860fec7b54367f8a/app/api/timeline/export/route.ts
[S-hooks]: https://github.com/MulattoTech/BabyTracker-App/blob/462246d9653c805cac87ee4e860fec7b54367f8a/documentation/Admin-Documentation/webhook-api.md
[S-hook-tests]: https://github.com/MulattoTech/BabyTracker-App/blob/462246d9653c805cac87ee4e860fec7b54367f8a/tests/hooksActivityMutationRoute.test.ts
[S-sw]: https://github.com/MulattoTech/BabyTracker-App/blob/462246d9653c805cac87ee4e860fec7b54367f8a/public/sw.js
[S-native]: https://github.com/MulattoTech/BabyTracker-App/blob/462246d9653c805cac87ee4e860fec7b54367f8a/documentation/Architecture-Documentation/NativeAppIntegration.md
[S-tests]: https://github.com/MulattoTech/BabyTracker-App/tree/462246d9653c805cac87ee4e860fec7b54367f8a/tests
[S-license]: https://github.com/Oak-and-Sprout/sprout-track/blob/1.6.7/LICENSE.md
[B-models]: https://github.com/babybuddy/babybuddy/blob/4c14f7428f24a725710d8deb03d5f28105e4da4e/core/models.py
[B-api]: https://github.com/babybuddy/babybuddy/blob/4c14f7428f24a725710d8deb03d5f28105e4da4e/api/urls.py
[B-api-doc]: https://github.com/babybuddy/babybuddy/blob/4c14f7428f24a725710d8deb03d5f28105e4da4e/docs/api.md
[B-reports]: https://github.com/babybuddy/babybuddy/blob/4c14f7428f24a725710d8deb03d5f28105e4da4e/reports/urls.py
[B-timers]: https://github.com/babybuddy/babybuddy/blob/4c14f7428f24a725710d8deb03d5f28105e4da4e/docs/user-guide/using-timers.md
[B-import]: https://github.com/babybuddy/babybuddy/blob/4c14f7428f24a725710d8deb03d5f28105e4da4e/docs/import-export.md
[B-admin]: https://github.com/babybuddy/babybuddy/blob/4c14f7428f24a725710d8deb03d5f28105e4da4e/core/admin.py
[B-import-tests]: https://github.com/babybuddy/babybuddy/blob/4c14f7428f24a725710d8deb03d5f28105e4da4e/core/tests/tests_import_export.py
[B-readme]: https://github.com/babybuddy/babybuddy/blob/4c14f7428f24a725710d8deb03d5f28105e4da4e/README.md
[B-tree]: https://github.com/babybuddy/babybuddy/tree/4c14f7428f24a725710d8deb03d5f28105e4da4e
[B-license]: https://github.com/babybuddy/babybuddy/blob/4c14f7428f24a725710d8deb03d5f28105e4da4e/LICENSE
[i1]: https://github.com/MulattoTech/BabyTracker/issues/1
[i2]: https://github.com/MulattoTech/BabyTracker/issues/2
[i3]: https://github.com/MulattoTech/BabyTracker/issues/3
[i4]: https://github.com/MulattoTech/BabyTracker/issues/4
[i5]: https://github.com/MulattoTech/BabyTracker/issues/5
[i6]: https://github.com/MulattoTech/BabyTracker/issues/6
[i7]: https://github.com/MulattoTech/BabyTracker/issues/7
[i8]: https://github.com/MulattoTech/BabyTracker/issues/8
[i9]: https://github.com/MulattoTech/BabyTracker/issues/9
[i11]: https://github.com/MulattoTech/BabyTracker/issues/11
[i12]: https://github.com/MulattoTech/BabyTracker/issues/12
[i13]: https://github.com/MulattoTech/BabyTracker/issues/13
[i14]: https://github.com/MulattoTech/BabyTracker/issues/14
[i15]: https://github.com/MulattoTech/BabyTracker/issues/15
[i16]: https://github.com/MulattoTech/BabyTracker/issues/16
[i17]: https://github.com/MulattoTech/BabyTracker/issues/17
[i18]: https://github.com/MulattoTech/BabyTracker/issues/18
[i19]: https://github.com/MulattoTech/BabyTracker/issues/19
[i20]: https://github.com/MulattoTech/BabyTracker/issues/20
[i21]: https://github.com/MulattoTech/BabyTracker/issues/21
[i22]: https://github.com/MulattoTech/BabyTracker/issues/22
[i23]: https://github.com/MulattoTech/BabyTracker/issues/23
[i24]: https://github.com/MulattoTech/BabyTracker/issues/24
[i25]: https://github.com/MulattoTech/BabyTracker/issues/25
[i29]: https://github.com/MulattoTech/BabyTracker/issues/29
[i30]: https://github.com/MulattoTech/BabyTracker/issues/30
[i34]: https://github.com/MulattoTech/BabyTracker/issues/34
[i36]: https://github.com/MulattoTech/BabyTracker/issues/36
[i37]: https://github.com/MulattoTech/BabyTracker/issues/37
[i38]: https://github.com/MulattoTech/BabyTracker/issues/38
