# Sat-Tracker mandatory feature reconciliation — November 19, 2026

## Authority and evidence boundary

This is the reconciliation index for the owner's **Autonomous Engineering,
Complete Feature Parity & Product Delivery Mission**, supplied November 19, 2026.
The [acceptance ledger](sat-tracker-acceptance-ledger.json) remains the contract
and evidence authority. This document does not introduce a second ledger or a
new completion percentage.

The source inspected is
[`236856df566064a6ea720e95b9ffbfcd84a724ec`](https://github.com/MulattoTech/Sat-Tracker/commit/236856df566064a6ea720e95b9ffbfcd84a724ec)
in the canonical `MulattoTech/Sat-Tracker` repository, with application code in
`application/`. The audit date is November 19 in America/Chicago; the UTC
observation date is November 20. Root instructions, application instructions,
the original parity matrix, prior scope audit, ledger, relevant current source,
and the open/closed issue inventory were reconciled before adding scope.

Read-only runtime reconnaissance during this continuation observed production
and preview on revision
`b24ccc9cd70076cb1d8e0fed477e14d0cf533444`, image
`sha256:1b4f57866debda9557d3ef073be61332f4440702daa5e8786245b198ea821756`.
Both containers were healthy; their hostnames redirected unauthenticated callers
to Cloudflare Access, and sampled protected APIs returned 401. This is
availability and selected authentication evidence, not complete workflow
acceptance. Current main is newer than the running image. No deployment is
performed or accepted by this reconciliation.

The five historical release-control PASS records retain their exact original
release evidence at `64c69c4b35df1161b2846c4f4e663e44e70d74a5`. The newer observed
runtime does not silently rebind those receipts. Every future promotion needs
its own accepted source/image, independent review, synthetic preview, fresh
backup and isolated restoration, migration compatibility, write-preserving
rollback, explicit owner approval and post-release verification.

### Scope change

- Preserve all 77 original parity rows, including Desired SQLite, and every
  previous requirement ID, status and evidence item.
- Expand detailed criteria within 51 existing contracts. Catalog size, rash
  details, memory views, care plans and granular permissions are additional
  criteria for their existing owners, not new duplicate parent requirements.
- Add **DEV-004 — Apple Watch architecture, companion workflows and physical
  acceptance**. No previous platform contract covered watchOS delivery.
- The provisional inventory is **104 Required and one Desired**: **5 VERIFIED
  PASS, 76 IN PROGRESS, 6 BLOCKED and 17 NOT IMPLEMENTED** among Required rows.
  There are no new PASS claims. `scopeComplete` remains false and the validator
  emits a null acceptance percentage.

The counts describe recorded contract states, not a fresh runtime certification
of all 105 contracts. In particular, an inherited IN PROGRESS row may still
contain missing subfeatures. Source findings below identify those explicitly.

## Mandatory coverage matrix

The domain names follow the mission's 16 tracking domains. Repeated capabilities
map to the same contract owners. PARTIAL means related implementation exists;
MISSING means the named subfeature was not found or is still planned. BLOCKED
identifies a specific evidence/input boundary, not permission to stop independent
engineering. No row in this matrix grants product acceptance.

| Tracking domain / mission sections | Mandatory behavior and contract owners | Current source and remaining boundary | Existing issue owner |
| --- | --- | --- | --- |
| 1. Feeding and Bottle Journal — 6.1 | **PAR-004–008, JRN-001**: fast bottle/time/amount entry; prepared, offered, consumed and remaining quantities; prep/offered/start/end times; duration; partial bottles; formula/milk/mixed/concentration; observations, photos, notes, caregiver, audited corrections and session history; daily/rolling targets and conversions. Breastfeeding side/session/pause/switch remain included. | **PARTIAL**: `FeedLog`, rich Journal/form, reactions and photo attachments exist. Preparation/remaining semantics and complete full-history/cross-view evidence are open. Never infer unknown consumed volume or conflate supplied quantities. | [#3](https://github.com/MulattoTech/Sat-Tracker/issues/3), [#19](https://github.com/MulattoTech/Sat-Tracker/issues/19) |
| 1. Feeding patterns/schedules — 6.1, 6.11 | **PAR-048/058/076, JRN-001**: frequency, intervals, mean intake, local-day/rolling totals, overnight/time distribution, changes and configured targets; editable schedules/reminders, scheduled versus cue-based care, missed/delayed indicators and history. Pumping/inventory retain **PAR-009–011**. | **PARTIAL**: reports, reminder settings, recurrence and pump/inventory primitives exist. Qualify actual pattern/schedule workflows; suggestions respect caregiver and clinician-entered plans without prescribing feeding. | [#3](https://github.com/MulattoTech/Sat-Tracker/issues/3), [#4](https://github.com/MulattoTech/Sat-Tracker/issues/4), [#19](https://github.com/MulattoTech/Sat-Tracker/issues/19), [#24](https://github.com/MulattoTech/Sat-Tracker/issues/24) |
| 2. Solid Foods and Food Library — 6.3 | **PAR-012–015**: at least 75 curated preloaded foods, categories/allergen groupings, search, custom/recent/favorite foods, first exposures, time/amount/texture, preferences, reactions/notes/photos, tried/untried/recent/repeated/category progress and existing First 100 Foods scope. | **PARTIAL**, with curated defaults/categories/favorites **MISSING** at this source: `FoodForm`, family catalog, multi-food logging, reaction/photo links and progress exist; `Food` has no category/favorite fields and `seed.ts` contains no food defaults. Existing history must survive catalog additions. Food count is not a development score; observations do not diagnose allergy. | [#16](https://github.com/MulattoTech/Sat-Tracker/issues/16) |
| 2. Solid-food integration — 6.3, 6.10 | **PAR-012/044/052/057/061–062**, **SYNC-001**: ordinary timeline/summaries, attribution, private photos, historical correction, reporting/export and supported offline sync. | **PARTIAL**: canonical `FoodLog`, `FeedLog` linkage, timeline and reporting exist. Broader offline/outbox and complete cross-view/export behavior remain unaccepted; do not create a separate food database. | [#16](https://github.com/MulattoTech/Sat-Tracker/issues/16), [#2](https://github.com/MulattoTech/Sat-Tracker/issues/2), [#19](https://github.com/MulattoTech/Sat-Tracker/issues/19) |
| 3. Diapers and Bowel Health — 6.4 | **PAR-016–018/044/058/060–061, CARE-001**: fast wet/dirty/mixed/dry entry, one-tap rash, location/severity/description, private photo, product/cream and follow-up; stool color/consistency/amount/frequency, trends/counts and latest-change handoff. | **PARTIAL**, explicit rash/photo workflow **MISSING**: `DiaperLog` and form have type/color/condition/blowout/cream/notes. A cream flag is not rash support. Daily/weekly selected reports and authorized rash handoff need complete acceptance. | [#5](https://github.com/MulattoTech/Sat-Tracker/issues/5), [#19](https://github.com/MulattoTech/Sat-Tracker/issues/19), [#22](https://github.com/MulattoTech/Sat-Tracker/issues/22) |
| 4. Sleep and Routines — 6.5 | **PAR-019–023/048/058**: nap/night/manual start/end/duration/location/notes/corrections; start/stop/supported resume, refresh/network/device-sleep recovery; daily/week totals, naps/averages/bedtime changes; editable wake windows and bedtime routines. | **PARTIAL**: sleep APIs, revision-aware nursery actions, forms and charts exist. Qualify interruption and cross-caregiver behavior, accurate local-day calculations and all manual/correction paths. | [#6](https://github.com/MulattoTech/Sat-Tracker/issues/6), [#19](https://github.com/MulattoTech/Sat-Tracker/issues/19), [#24](https://github.com/MulattoTech/Sat-Tracker/issues/24) |
| 4. Overnight patterns — 6.5, 9 | **PAR-020/058**: caregiver-configured sleeping-through-the-night definition; distinguish one long session, repeated nights, interruptions, wake-ups and overnight feeds. | **MISSING** explicit configurable pattern contract in inspected source; nap/night classification alone does not satisfy it. No sleep may be fabricated from missing records. | [#6](https://github.com/MulattoTech/Sat-Tracker/issues/6), [#19](https://github.com/MulattoTech/Sat-Tracker/issues/19) |
| 5. Growth and Health — 6.2, 6.6 | **PAR-033–042**: temperature, weight/length/head circumference, measurement date/time/unit/source/notes, metric/imperial corrections/history, newborn gain at irregular intervals, graphs and validated labeled references; existing BMI scope retained. | **PARTIAL**: measurement routes, conversion helpers, growth chart/reference code exist. Qualify actual period/round-trip calculations and reference applicability; missing values are not zero and trends are not diagnoses. | [#15](https://github.com/MulattoTech/Sat-Tracker/issues/15) |
| 5. Medical/medication/vaccine records — 6.6 | **PAR-034–036/044–045/048–049/060–062/076**: appointments/providers, visit notes, entered diagnoses, care plans, follow-ups, related measurements/private documents; medication entered-dose/unit/time/caregiver/notes/reminders/history; vaccine date/series/provider/docs/follow-up. | **PARTIAL**: medicine, vaccine documents, contacts and recurring calendar models/UI exist. Complete linked visit/care-plan, permission and export workflows. Never infer a medication quantity or prescribe treatment. | [#15](https://github.com/MulattoTech/Sat-Tracker/issues/15), [#16](https://github.com/MulattoTech/Sat-Tracker/issues/16), [#24](https://github.com/MulattoTech/Sat-Tracker/issues/24), [#19](https://github.com/MulattoTech/Sat-Tracker/issues/19) |
| 6. Developmental Milestones — 6.6, 6.9 | **PAR-042–043**: birth/gestational context, consistent chronological/corrected age at current and historical dates, age labels and configurable milestone interpretation; smile/roll/sit/crawl/steps/words/teeth/custom milestones with dates/notes/photos/categories. | Milestones **PARTIAL**; corrected-age schema/calculation **MISSING** in inspected current `Baby` and application searches. Historical PAR-042 status is preserved as unaccepted, not evidence that this functionality exists. One canonical age contract must serve profile, growth, milestones and sleep. | [#15](https://github.com/MulattoTech/Sat-Tracker/issues/15), [#16](https://github.com/MulattoTech/Sat-Tracker/issues/16) |
| 7. Memories and Media — 6.8 | **PAR-043–045/057/060–062**: private firsts, smiles/laughs/teeth/steps/words/foods/holidays/birthdays/custom memories with child/date/title/category/description/photos/notes/caregiver; chronological filters and private exports. | **PARTIAL**: milestone fields, private photo links/gallery month and milestone groups, captions and filters exist. Extend and qualify the unified memory workflow using these models; do not introduce another authoritative journal. | [#16](https://github.com/MulattoTech/Sat-Tracker/issues/16), [#24](https://github.com/MulattoTech/Sat-Tracker/issues/24), [#19](https://github.com/MulattoTech/Sat-Tracker/issues/19) |
| 8. Family and Caregiver Management — 6.7 | **PAR-001–003, SETUP-001**: multiple children with separate histories/media, safe switching, partner/relative/babysitter invitations and expiry, caregiver identity and family settings. | **PARTIAL**: `Baby`, `Caretaker`, family-manager and auth contexts exist. Qualify child switching during forms/uploads/queueing and invitations/session lifecycle; physical onboarding is a separate acceptance boundary. | [#22](https://github.com/MulattoTech/Sat-Tracker/issues/22), [#30](https://github.com/MulattoTech/Sat-Tracker/issues/30) |
| 8. Handoff and personalized daily routines — 6.7–6.8 | **CARE-001, PAR-030–032/045/047–048/056–057**: latest feed/diaper/sleep, current timers, permitted meds, important notes/reminders/activity, per-item freshness/pending; tummy time, bath, story, walk/play/bedtime/custom routines with history, repetition and active/upcoming/completed overview. | **PARTIAL** primitives: `DailyStats`, activity models, calendar and nursery timers. Dedicated complete handoff and custom routine workflow remain open. Preserve existing named-timer scope; stale data must not appear current. | [#17](https://github.com/MulattoTech/Sat-Tracker/issues/17), [#22](https://github.com/MulattoTech/Sat-Tracker/issues/22), [#24](https://github.com/MulattoTech/Sat-Tracker/issues/24) |
| 9. Permissions and Auditing — 6.7, 13 | **PAR-002–003/044/072, OCR-002**: granular view/create/edit-own/edit-others/void, health/med/photo/camera/export/invite/child/family/module rights; least privilege, meaningful actor/time audit, revocation despite existing sessions, preserved historical attribution. | **PARTIAL**: auth wrappers, family scoping and some privileged-call audit exist. The full permission matrix and stale-session revocation require independent tests; related UI or admin role is insufficient. Cover attachments and tokens as well as records. | [#22](https://github.com/MulattoTech/Sat-Tracker/issues/22), [#25](https://github.com/MulattoTech/Sat-Tracker/issues/25), [#18](https://github.com/MulattoTech/Sat-Tracker/issues/18) |
| 10. Multi-Device Synchronization — 6.10 | **PAR-052, JRN-001, SYNC-001, DQ-001**: all supported event domains and corrections/media metadata; shared records, immutable retry, duplicates, conflict resolution, original actor, pending/errors, reconnect/restart/expired-session/interrupted-upload handling. | New-bottle loaded-Journal outbox **PARTIAL**; broader domain/cold-start/background/edit promises remain open. Physical two-caregiver demonstration **BLOCKED** pending actual-device evidence. Extend the existing outbox rather than replacing it. | [#2](https://github.com/MulattoTech/Sat-Tracker/issues/2), [#22](https://github.com/MulattoTech/Sat-Tracker/issues/22), [#27](https://github.com/MulattoTech/Sat-Tracker/issues/27), [#30](https://github.com/MulattoTech/Sat-Tracker/issues/30) |
| 11. Mobile, Desktop, and Apple Watch — 10 | **PAR-050–055/076–077, PKG-001–002, DEV-001–003**: responsive Android/tablet/Windows, PWA, camera OCR, notifications, secure sessions, offline/night/accessibility/one-hand UX; reuse Capacitor, qualify APK/update delivery and document Windows PWA/EXE disposition. | Web/native-aware layers **PARTIAL**. Canonical package and install/update qualification remain open; Pixel 9/10/iPad acceptance retains explicit physical evidence requirements. Browser emulation cannot close those contracts. | [#2](https://github.com/MulattoTech/Sat-Tracker/issues/2), [#20](https://github.com/MulattoTech/Sat-Tracker/issues/20), [#23](https://github.com/MulattoTech/Sat-Tracker/issues/23), [#30](https://github.com/MulattoTech/Sat-Tracker/issues/30) |
| 11. Apple Watch — 10.1 | **DEV-004**: current platform/pairing/tooling audit, approved architecture, watch prototype/auth/read-only status, quick bottle/diaper/sleep actions, reminders/notifications/handoff/sync and feasible offline behavior. | **NOT IMPLEMENTED**. No watch-specific source found. Compatible hardware/tooling inventory was not checked; do not assume Pixel pairing. Preparation can proceed, while physical acceptance must remain BLOCKED when required access or equipment is unavailable. | New [#98](https://github.com/MulattoTech/Sat-Tracker/issues/98), indexed by [#21](https://github.com/MulattoTech/Sat-Tracker/issues/21) |
| 12. OCR and Imports — 7 | **PAR-065–066, OCR-001–003**: local native/scanned/mixed/multipage PDF, PNG/JPEG/camera/printed and measured handwriting; date/time/volume/units/formula/duration/diaper/sleep/notes candidates, progressive other supported events; uncertainty, editing, explicit latest approval, duplicate decisions, transactional canonical import and provenance. | **PARTIAL** existing recognition/review pipeline. Current source has selected-page and row add/split/merge controls; qualify complete current workflow and remaining resource/format/crop/partial-batch/undo boundaries. Handwriting needs genuine representative corpus and field/error/reviewed-import metrics, not printed fixtures. | [#10](https://github.com/MulattoTech/Sat-Tracker/issues/10), [#26](https://github.com/MulattoTech/Sat-Tracker/issues/26), [#49](https://github.com/MulattoTech/Sat-Tracker/issues/49); closed residuals [#11](https://github.com/MulattoTech/Sat-Tracker/issues/11), [#37](https://github.com/MulattoTech/Sat-Tracker/issues/37), [#38](https://github.com/MulattoTech/Sat-Tracker/issues/38) |
| 12. Unified upstream history — 8 | **PAR-063–064, LEG-001, UP-001**: Sprout/Baby Buddy feeding/pumping/solids/diaper/sleep/growth/med/vaccine/activity/milestone/attribution/report parity, faithful imports/exports, timestamps/ownership/duplicates, private historical migration and source/license preservation. | Baby Buddy adapter **PARTIAL**; full application merger is not present. Sprout import and detailed pinned parity remain open. Actual legacy migration is BLOCKED on usable historical export, while synthetic adapter work is actionable. Preserve recovery references and valid completed slices. | [#13](https://github.com/MulattoTech/Sat-Tracker/issues/13), [#14](https://github.com/MulattoTech/Sat-Tracker/issues/14), [#31](https://github.com/MulattoTech/Sat-Tracker/issues/31), [#49](https://github.com/MulattoTech/Sat-Tracker/issues/49) |
| 13. Reporting and Pediatrician Handoffs — 6.4, 6.6, 12 | **PAR-056–062, CARE-001**: date-range feeding/intake, diapers/bowel/rash, sleep, growth, medication/vaccine/appointment reports; daily/week/month and handoff summaries; PDF/CSV/XLSX, timestamps/units, observation-versus-calculation labels, explicit authorized export/share. | **PARTIAL** reports and export primitives. Qualify selected-data accuracy, readable reports, allowed fields, formula-safe exports and media portability. No automatic provider transmission or unauthenticated family-report links. | [#19](https://github.com/MulattoTech/Sat-Tracker/issues/19), [#22](https://github.com/MulattoTech/Sat-Tracker/issues/22) |
| 14. Advanced Sleep Intelligence — 9 | **PAR-024–029/042, SLP-001**: personalized wake windows, next nap/wind-down/duration/wake/bedtime, transparent confidence/inputs, caregiver overrides, historical plans and prospective outcome/model evaluation. | **NOT IMPLEMENTED** broad contracts; module remains planned. Build on reliable logging, corrected-age baseline and sparse-data fallback. Evaluate before default enablement, preserve model versions and never replace actual recorded sleep. | [#7](https://github.com/MulattoTech/Sat-Tracker/issues/7), [#8](https://github.com/MulattoTech/Sat-Tracker/issues/8), [#9](https://github.com/MulattoTech/Sat-Tracker/issues/9), [#28](https://github.com/MulattoTech/Sat-Tracker/issues/28) |
| 15. Modules and Integrations — 11–12 | **MOD-001–002, CAM-001, PAR-071–076, UP-001**: registry descriptions/versions/dependencies/owner controls/settings/health/update/compatibility/rollback; optional OCR/sleep/catalog/report/memory/camera/watch integrations; secure camera/Monai, Home Assistant, API/webhooks/MCP. | Registry/CLI and API/notification primitives **PARTIAL**; runtime updater, camera, HA/MCP and other promised integrations unaccepted/planned. Preserve module data and core availability; no arbitrary code downloads. Camera follows core/OCR priority. | [#18](https://github.com/MulattoTech/Sat-Tracker/issues/18), [#31](https://github.com/MulattoTech/Sat-Tracker/issues/31), [#50](https://github.com/MulattoTech/Sat-Tracker/issues/50); draft [PR #35](https://github.com/MulattoTech/Sat-Tracker/pull/35) is intake configuration only |
| 16. Security, Recovery, and Deployment — 13–17 | **PAR-003/067–070, OCR-002, REL-001–005, GOV-001–003, SETUP-001, DQ-001**: family/media/privacy, data integrity, both database contracts, install/upgrade/recovery, immutable reviewed releases, backups/restores, compatible rollback, protected Access, issue/evidence governance and durable continuation. | Five historical release controls remain **VERIFIED PASS for their recorded release only**. Current-source/runtime qualification and future promotion are separate. Preserve all production volumes and recovery work; no live family data in automated fixtures or public records. | [#20](https://github.com/MulattoTech/Sat-Tracker/issues/20), [#21](https://github.com/MulattoTech/Sat-Tracker/issues/21), [#25](https://github.com/MulattoTech/Sat-Tracker/issues/25), [#27](https://github.com/MulattoTech/Sat-Tracker/issues/27), [#30](https://github.com/MulattoTech/Sat-Tracker/issues/30), [#49](https://github.com/MulattoTech/Sat-Tracker/issues/49), [#50](https://github.com/MulattoTech/Sat-Tracker/issues/50) |

## Duplicate mapping and issue governance

The original requirement IDs are stable. In particular:

- The food catalog minimum and categories expand **PAR-013**, and first-food
  views expand **PAR-014**. No second food-catalog parent is created.
- Rash expands **PAR-018**, with media in **PAR-044**, aggregates in **PAR-058**,
  exports in **PAR-060/061** and handoff in **CARE-001**. These are cooperating
  contracts, not five duplicate rash features.
- Memories extend **PAR-043/044/057** because the existing milestone and photo
  models already own private firsts and chronological media. Medical appointment
  details extend **PAR-048/049**, with existing health and document owners.
- Permissions/audit/revocation stay in **PAR-002/003**; handoff presentation stays
  in **CARE-001**. Routine scheduling stays in **PAR-048**, and activity logging
  stays in **PAR-030–032/047**.
- Sleeping-through-the-night semantics expand **PAR-020** and its graphs use
  **PAR-058**. Predictive behavior and prospective evaluation retain their
  separate existing owners **PAR-024–029** and **SLP-001**.
- Apple Watch is the only newly discovered distinct platform contract,
  **DEV-004**. The `DEV-` namespace also ensures the existing validator refuses
  omission of its physical-device evidence category.

Existing issues own unresolved implementation. Their current open/closed state
does not determine ledger acceptance. In particular, preserve accepted slices
of closed #11/#12/#25/#29/#37/#38 and link their residual criteria through the
current canonical owners, especially #49 and #21. Review draft PR #35 separately
from the module runtime. #39 concerns Fleet-Control-Hub and is outside this
application's implementation ownership.

The issue inventory uses legacy P0–P5 labels. Record **missionPriority: P0–P3**
in reconciliation comments or task text without silently rewriting those labels.
For example, existing #5/#15/#22 carry legacy P3 and #16 legacy P4; this mission
places essential diaper, age/health and caregiver work ahead of P2 catalog/media
completion. Each scoped update should retain current source state, missing user
behavior, criteria, code, dependencies, complexity, verification and privacy
notes and link its ledger IDs. New watch issue
[#98](https://github.com/MulattoTech/Sat-Tracker/issues/98) is the single owner for
DEV-004; link it from #21, #2 and #23 rather than duplicating its parent.

## Prioritized implementation queue

This is a bounded queue under the existing issues, not a replacement board.
Assignments describe this continuation's logical owners. Dependencies and
acceptance checks determine readiness; no row below claims executed tests.
P0 defects found in integrity, isolation or core availability take precedence.

| Order | Task / mission priority / complexity | Dependencies and ownership | Required verification and completion boundary |
| --- | --- | --- | --- |
| 1 | OCR review totals use the same displayed timezone/day boundaries, including DST — **P1 / S** | Existing OCR review; root implementation; #49, **PAR-066** | Golden midnight/DST totals and reviewed-row behavior, focused tests and applicable disposable browser check; broad OCR contract stays open. |
| 2 | Investigate remaining PIN-login acceptance gate after merged input-preservation fix — **P1 / S–M** | Existing auth/layout and PR #96; independent QA/reviewer; #2/#23, **PAR-050/055, SETUP-001** | Reproduce the actual gate, distinguish UI regression from test timing, keep meaningful assertions, rerun affected browser/auth check; no repeated implementation of a merged fix without evidence. |
| 3 | Canonical birth/gestational/corrected-age model and shared helper — **P1 / M** | #15; backend plus UI; **PAR-042**, consumers **PAR-041/043** | Synthetic premature/term and historical date cases, local-day/leap boundaries, missing context and units; schema/upgrade safety and consistent labels; no live-record mutation in tests. |
| 4 | One-tap diaper-rash capture and safe private attachments — **P1 / M** | #5/#16; existing diaper/media ownership; **PAR-018/044** | Minimal mobile action, stored field/media ownership, edit/history, wrong-family rejection and display; follow-up reporting/handoff remains linked to #19/#22. |
| 5 | Minimum curated food catalog with safe existing-family adoption — **P2 / S–M** | #16; food API/form owner; **PAR-012–015** | At least 75 distinct searchable categorized entries on fresh install, custom-name collisions, repeat initialization, existing history preserved, usable selection and exposure progress. Catalog expansion must not bypass family permissions. |
| 6 | Fresh caregiver handoff and daily routine summary — **P1 / M** | #22/#24; existing feeds/diapers/sleep/notes; **CARE-001, PAR-056** | Two synthetic caregivers, recent-event/caregiver accuracy, active timers, authorization, last-updated/pending labels, no stale data presented as current. |
| 7 | Extend durable retry/correction beyond bottle creates in small domain slices — **P1 / L, split** | #2/#22/#27; **PAR-052, SYNC-001, DQ-001** | Disconnect/restart/lost-response/revoked-session/concurrent-edit negative tests and duplicate-free canonical history per domain. Actual-device synchronization remains separately evidenced. |
| 8 | Complete selected-date pediatrician care reports and routine graphs — **P2 / M** | #19, relevant domain fields; **PAR-058–062** | Golden time/unit/counts, observed-versus-computed labels, readable PDF, faithful safe CSV/XLSX, permitted fields and explicit export action. |
| 9 | Reviewed OCR field/corpus and upstream adapter increments — **P1 / M–L, split** | #10/#13/#14/#26/#49; **PAR-063–066, OCR-001–003** | Real API/database explicit approval, original timestamps/units/provenance, transaction/retry/undo safety; representative handwriting and historical-family export stay named external evidence dependencies. |
| 10 | Apple Watch platform and architecture audit — **P3 / S preparation, L delivery** | #98, #2/#18/#22/#23; **DEV-004** | Current official platform feasibility, compatible pairing and tooling inventory, approved architecture and staged prototype plan; later genuine device receipt. No assumption that physical hardware has been checked. |

Advanced sleep, camera and broader module updates follow their existing parents
once logging, authorization and synchronization prerequisites are reliable.
Required scope is retained regardless of engineering order.

## Acceptance and continuity checks

Use synthetic families for every automated workflow. The end-to-end caregiver
sequence is: A records a bottle and diaper and starts a nap; B sees the updates,
stops the nap and adds a note; a historical edit is interrupted; reconnect leaves
one complete timeline and a fresh handoff. Execute negative authorization,
idempotency, conflict, timezone/DST and unit cases as well as successful actions.

Required external evidence remains explicit: genuine handwriting and ground
truth, actual legacy export, physical Pixel/iPad and multi-device interaction,
and any later compatible Watch/tooling access. Continue independent source,
synthetic and preview work while those boundaries are unresolved. Do not change
IN PROGRESS to PASS because source exists, tests are written, CI is green, an
issue is closed or a PR is merged.

Run from the repository root after editing the ledger:

```sh
python scripts/acceptance_ledger.py
python -m unittest discover -s tests/ops -p test_acceptance_ledger.py -v
```

Also verify that original IDs/statuses/evidence remain unchanged, every matrix
reference resolves to a real contract and each new implementation reference
exists. Checkpoints must record exact commit/test/PR and release boundaries;
subsequent code slices append evidence only for their executed scope. The user
can approve the next explicitly described bounded work package without repeating
this audit. Production releases and other high-risk changes still require their
specific target, verified recovery plan and approval.

Validation executed for this documentation change: the ledger validator passed,
all 13 existing ledger contract/negative tests passed, `git diff --check` passed,
and a baseline comparison confirmed preservation of all 104 prior IDs, required
flags, priorities, statuses, evidence and criteria. All newly added source paths
and current-document contract references resolved. These checks validate the
reconciliation's structure and preservation, not the described product workflows.
