# Feature Parity Matrix

This file defines the desired *union* of Baby Buddy, Sprout Track, and independently implemented Huckleberry-style sleep planning.

## Current mandatory scope

The original 77 rows below retain stable ledger owners **PAR-001–PAR-077**.
The [November 19 mandatory coverage index](sat-tracker-mandatory-coverage-2026-11-19.md)
maps the owner's full baby-care mission to those rows and existing mission
extensions, with source findings, issue ownership and a prioritized queue.
Detailed acceptance criteria live in the
[canonical acceptance ledger](sat-tracker-acceptance-ledger.json), scope version
`2026-11-19-v3`; neither this table nor the coverage index is a separate progress
denominator.

The reconciliation explicitly retains preloaded foods (at least 75), rash
logging, granular caregiver permissions, medical appointment/care-plan details,
memory journals, cross-domain offline behavior and pediatrician reports within
their existing owners. **DEV-004** adds the distinct mandatory Apple Watch
architecture, workflows and physical-device acceptance contract, tracked in
[issue #98](https://github.com/MulattoTech/Sat-Tracker/issues/98). Existing
Android/Windows packaging and Pixel/iPad requirements remain intact.

No current implementation or acceptance status is implied by a Required target.
The ledger records VERIFIED PASS / IN PROGRESS / BLOCKED / NOT IMPLEMENTED and
preserves separate test, preview, production and physical-device evidence.

## Original parity capabilities

Status values for future use:

- NOT STARTED
- PARTIAL
- COMPLETE
- SUPERSEDED
- NOT APPLICABLE

| Domain | Capability | Source inspiration | Target |
|---|---|---|---|
| Family | Multiple babies | Both | Required |
| Family | Multiple caregivers/attribution | Both | Required |
| Family | Multi-family isolation | Sprout | Required |
| Feeding | Bottle feeding | Both | Required |
| Feeding | Breastfeeding side/session timers | Sprout | Required |
| Feeding | Pause/resume/switch side | Sprout | Required |
| Feeding | Formula/breast/mixed types | Both/Sprout | Required |
| Feeding | Feeding reactions | Sprout | Required |
| Pumping | Pump sessions | Both | Required |
| Pumping | Left/right volumes | Sprout | Required |
| Pumping | Breast-milk inventory | Sprout | Required |
| Food | Solid foods | Both | Required |
| Food | Dedicated foods catalog | Sprout | Required |
| Food | First 100 foods | Sprout | Required |
| Food | Allergens/reactions | Sprout | Required |
| Diaper | Wet/dirty/both/dry | Both | Required |
| Diaper | Color/condition/amount | Both | Required |
| Diaper | Blowout/cream | Sprout | Required |
| Sleep | Start/end/timer | Both | Required |
| Sleep | Nap/night classification | Both | Required |
| Sleep | Location | Sprout | Required |
| Sleep | Quality | Sprout | Required |
| Sleep | Average wake windows | Sprout | Required |
| Sleep AI | Next nap prediction | Huckleberry-style | Required |
| Sleep AI | Wind-down recommendation | Huckleberry-style | Required |
| Sleep AI | Nap duration/wake prediction | Custom | Required |
| Sleep AI | Bedtime projection | Huckleberry-style | Required |
| Sleep AI | Dynamic re-planning | Huckleberry-style | Required |
| Sleep AI | Confidence/explanation | Custom | Required |
| Activity | Tummy time | Baby Buddy | Required |
| Activity | Play/walk/outdoor | Sprout | Required |
| Activity | Bath tracking | Sprout | Required |
| Health | Temperature | Baby Buddy | Required |
| Health | Medication | Both | Required |
| Health | Supplements | Sprout | Required |
| Health | Vaccines + documents | Sprout | Required |
| Growth | Weight | Both | Required |
| Growth | Height/length | Both | Required |
| Growth | Head circumference | Both | Required |
| Growth | BMI | Baby Buddy | Required |
| Growth | CDC/WHO percentiles | Both/Sprout | Required |
| Growth | Due date / corrected age | Baby Buddy | Required |
| Milestones | Dedicated milestones | Sprout | Required |
| Media | Photos linked to activities | Sprout | Required |
| Notes | Free-form notes | Both | Required |
| Organization | Generic tags | Baby Buddy | Required |
| Timers | Generic reusable timers | Baby Buddy | Required |
| Calendar | Calendar/events | Sprout | Required |
| Contacts | Providers/contacts | Sprout | Required |
| UX | Mobile-first responsive UI | Both/Sprout | Required |
| UX | PWA/installable | Sprout | Required |
| UX | Offline-aware logging | Custom/Sprout direction | Required |
| UX | Nursery/night mode | Sprout | Required |
| UX | Dark mode | Sprout | Required |
| UX | Accessibility | Sprout/Baby Buddy maturity | Required |
| Reporting | Dashboard | Both | Required |
| Reporting | Searchable timeline/full log | Both/Sprout | Required |
| Reporting | Graphs/analytics | Both | Required |
| Reporting | Monthly report card | Sprout | Required |
| Reporting | PDF report | Sprout | Required |
| Export | CSV/XLSX | Both/Sprout | Required |
| Export | Full portable export | Custom | Required |
| Import | Baby Buddy import | Sprout | Required |
| Import | Sprout import | Custom | Required |
| Import | PDF form import | Custom | Required |
| Import | Scanned PDF review workflow | Custom | Required |
| Platform | Docker/self-hosting | Both | Required |
| Platform | PostgreSQL | Both | Required |
| Platform | SQLite option | Both | Desired |
| Platform | Backup/restore | Sprout | Required |
| API | Full REST/OpenAPI | Baby Buddy | Required |
| API | Scoped API keys | Both/Sprout | Required |
| API | Signed webhooks | Baby Buddy | Required |
| Integrations | Home Assistant | Baby Buddy ecosystem | Required |
| Integrations | MCP | Baby Buddy ecosystem | Required |
| Notifications | Web/native push | Sprout | Required |
| Localization | Multi-language | Both | Required |

## Parity rule

A feature should not be marked COMPLETE because a button exists. Completion requires:

- canonical data model support;
- create/edit/delete flows;
- validation;
- import/export representation;
- API representation where applicable;
- reporting/timeline representation where applicable;
- tests;
- mobile usability;
- migration/upgrade safety.
