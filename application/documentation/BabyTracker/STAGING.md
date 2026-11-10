# OCR staging and release gates

Use `compose.ocr-staging.yml` with synthetic records. It has a distinct project,
container and three persistence volumes, a loopback-only port, and a two-CPU,
3 GiB, 256-PID runtime budget. It never mounts production storage.

The separate staging network defaults to `10.254.73.0/28`; check existing Docker
networks and host routes first, or set `BABYTRACKER_STAGING_SUBNET` to another
verified unused private range. This avoids consuming an exhausted automatic
address pool. It does not remove or reconfigure existing networks. Docker Desktop
requires a regular bridge for the loopback port publication; this network is not
an outbound firewall. The OCR adapter itself makes no external recognition call.

```sh
docker compose -f compose.ocr-staging.yml build
docker compose -f compose.ocr-staging.yml up -d
docker compose -f compose.ocr-staging.yml ps
```

Open `http://127.0.0.1:3124` on the Docker host. For scripted acceptance, first run
the guarded check below to establish its fixed synthetic family and child, then
inspect that fixture through the UI. Creating a different child manually makes
the guarded check refuse the environment; use a separate disposable environment
for other manual synthetic fixtures. Authentication remains required for OCR.
No public tunnel or access-policy change is part of this file. Do not enter real
infant data into this acceptance environment.

For a new empty acceptance environment, the guarded HTTP check creates a fixed
synthetic family and child, then exercises native image recognition, draft save,
approval, exact retry, original-source access and the existing timeline:

```sh
docker compose -f compose.ocr-staging.yml exec -T app node scripts/ocr-staging-check.mjs
```

The check refuses to run without both explicit staging/OCR flags or if any other
child exists. Its first run creates two synthetic care events; later runs verify
the same receipt without adding events. A random, UI-compatible caretaker PIN is
stored only in `/app/env/ocr-staging-access.json` with mode 0600; it is never
printed in logs or committed. The synthetic family slug is `ocr-staging`, login
ID `01`. This check is for a disposable staging deployment, never production.

## Browser verification

After `npm run build`, run `npm run test:ocr-browser`. This script creates a fresh
temporary SQLite database, encryption key, synthetic identities and encrypted-file
directory, and starts one local test server. It uploads an actual generated image,
edits the recognized quantity, explicitly approves rows, checks the confirmation
gate, and verifies exact saved values through the ordinary timeline endpoint.
It also checks access denial, phone/tablet layout overflow and keyboard focus.
It closes its server and browser and removes its temporary storage afterward.

Playwright supplies the default Chromium binary. To use an already installed
official compatible binary, set `BABYTRACKER_TEST_BROWSER_PATH` to its executable.
This option is only consumed by the acceptance script. Screenshots and the JSON
report are written to ignored `test-results/`; only synthetic evidence belongs
there. Synthetic Chromium viewport tests do not establish physical iOS/Safari or
Android camera-upload acceptance.

Tests and local development may set `BABYTRACKER_OCR_FILES_DIR` to an isolated
server-side directory. Production normally uses the existing `Files/ocr` volume.
Never point a disposable database's retention sweep at another database's files.

## Recorded qualification — 2026-10-27

Application [PR #2] merged as
`83326cfe964926b49b3bc487679cb9aa10170e8c`. The [exact-head acceptance run] passed
1,490 tests in 118 files, TypeScript, the production build and real Chromium
acceptance including cleanup at reviewed head
`04feb01a92af4aa08b309f3e9d0db849d65cd1a1`. The [post-merge main run] also passed.
The squash commit has the same tree as that reviewed head.

The Docker evidence attaches to this actual staged artifact:

| Item | Observed identity or result |
| --- | --- |
| Runtime source commit | `7b94b2290e6989adc9b9a99a2fc694c54258ccd7` |
| Immutable Docker image ID | `sha256:c6821440824e16934b6b3a429bd3e28a53ca254b622048488912fa4448270a6d` |
| Stage project and container | `babytracker-ocr-staging` |
| Host listener | `127.0.0.1:3124`; stage healthy |
| Persistence | `babytracker-ocr-staging_staging-db`, `babytracker-ocr-staging_staging-env`, `babytracker-ocr-staging_staging-files` |
| Native HTTP qualification | All nine checks passed against the running Alpine image |
| Corrected canonical feed | One 95 mL formula bottle at `2026-10-20T13:15:00Z` |
| Canonical diaper | One wet diaper at `2026-10-20T14:30:00Z` |

The later `04feb01` change affects only `scripts/ocr-browser-smoke.mjs` process
cleanup. The staged image predates that test-script change; its image ID above
identifies the runtime that was actually qualified.

The nine HTTP checks cover the staging/fixture guard, fixture font, ordinary
caretaker authentication, native OCR upload, saved correction, preview, approved
commit plus exact retry, canonical database/timeline values, and exact original
source bytes. Upload, save and preview wrote no care events. The approved import
created exactly the two events above, and retry returned the same durable receipt.

### Original-image rollback rehearsal

The original image
`sha256:445b7dfd6cc8976e9e0ec313457c11b8336befea5a2fab69fd573ff55ac77a64`
passed the isolated rehearsal in **25.49 seconds**. The [pinned rollback record]
contains its procedure, restrictions and results. PowerShell 7 paused only the
verified synthetic stage long enough to copy its three volumes read-only into
unique ownership-labelled clones, then resumed staging. The old image ran on
those clones with `--network none` and no published ports.

Verification preserved the complete two canonical event rows, IDs and timestamps;
OCR document/audit rows; two import-ledger mappings; and both encrypted source
files. Ordinary original-image authentication and timeline checks passed.
Temporary container/volume cleanup was verified, and staging recovered healthy.
A health probe briefly reported unhealthy during pause/copy; subsequent checks
confirmed recovery without restarting staging or production.
The optional untouched stock seed is accepted only after its exact defaults and
empty relationships pass inspection. The verifier never deletes records to make
the fixture pass.

This result covers the synthetic SQLite scenario. It does not establish rollback
of a current production database or PostgreSQL. Production remained healthy on
its original image, with its start time unchanged at `2026-10-26T23:15:27Z`.

## Remaining production gates and follow-ups

| Gate | Evidence recorded | Still required |
| --- | --- | --- |
| Hosted acceptance and review | Exact-head and post-merge CI passed; scoped blocking review findings resolved; PR #2 merged | Normal review and required checks for subsequent changes |
| Synthetic staging | The identified Docker image passed nine native HTTP checks; stage healthy | Qualify any later runtime/image change before promotion |
| Backup and restore | Existing 2026-10-07 archive, 128,393 bytes, passed isolated integrity checks for both SQLite databases and required encryption/configuration key presence | A fresh consistent production backup of databases, configuration/key and source files; protected restore verification including application startup |
| Older-image rollback | Original image passed the bounded cloned-stage rehearsal without losing canonical events, OCR/audit rows, ledger mappings or encrypted sources | Review the rollback plan against the current production snapshot and the actual deployment being promoted |
| Handwritten/mixed documents | Printed synthetic recognition and manual review path demonstrated | Private representative forms, explicit transcription references and row/field error accounting |
| Physical devices | Automated Chromium phone/tablet viewport and focus checks passed | Physical phone/tablet, Safari and camera-upload acceptance |
| Production promotion | Existing production image and start time unchanged | Explicit reviewed promotion after the outstanding release gates |

The current engine is an English printed-text baseline. OCR is not fully accepted
until the handwriting and real-document requirements are demonstrated. Whole-
document finalization is intentional in this slice: unchecked rows are excluded
and the document becomes read-only. The UI warns before confirmation and in the
receipt. Incremental completion, import undo, and consolidation with the
[parallel browser-local OCR work] remain open follow-ups. These observations do
not close the parent OCR issue or imply an overall project completion percentage.

The source merge, hosted CI and synthetic staging results do not authorize a
production image update or production data migration. See the detailed
[acceptance matrix](ACCEPTANCE.md) and existing roadmap issues [#11], [#29] and
[#30] for the remaining acceptance and release scope.

[PR #2]: https://github.com/MulattoTech/BabyTracker-App/pull/2
[exact-head acceptance run]: https://github.com/MulattoTech/BabyTracker-App/actions/runs/40456178992
[post-merge main run]: https://github.com/MulattoTech/BabyTracker-App/actions/runs/40457271546
[pinned rollback record]: https://github.com/MulattoTech/BabyTracker/blob/3490b1d59c46544c2d83acc1555b428017949892/docs/babytracker-ocr-rollback.md
[parallel browser-local OCR work]: https://github.com/MulattoTech/BabyTracker-App/pull/1
[#11]: https://github.com/MulattoTech/BabyTracker/issues/11
[#29]: https://github.com/MulattoTech/BabyTracker/issues/29
[#30]: https://github.com/MulattoTech/BabyTracker/issues/30
