# Master workspace and release operations

## One active application source
- Repository: https://github.com/MulattoTech/BabyTracker-Master (renamed in place; original issues, PRs and ancestry retained).
- Maintained checkout: `C:\Tools\Dev\BabyTracker-Master`.
- Application: `application/`; npm, Prisma and Next.js commands run there.
- New AO project: `babytracker-master`, display name **BabyTracker Master**.
- Agent handoff: `docs/handoff/GEMINI-OCR-MISSION.md`.
- Production: https://tracker.m-techlabs.com.
- Protected synthetic preview: https://tracker-preview.m-techlabs.com.

The old BabyTracker repository URL redirects here. BabyTracker-App remains archived,
not a second development destination. Preserve Sprout's license and attribution.
Shared generic Fleet Control source remains in MulattoTech/Fleet-Control-Hub; it
also serves other projects and must not be forked into a competing controller here.

## Local consolidation and remaining retirement work
The current master checkout contains canonical application source and operations.
The `.local/legacy-snapshots/` directory contains hash-verified source/private-state
snapshots of every other user-listed folder. `.local/consolidation-20261030/` holds
both verified Git bundles, GitHub issue/PR exports, all tracked diffs, untracked file
copies and a machine-readable file-hash manifest. Recovery refs can be inspected via
`git branch -r` (local-recovery and legacy-app-recovery namespaces).

Original Windows directories were retained because open handles blocked renaming.
They have NOT been deleted, emptied, or replaced with junctions. They are recovery
references, not maintained development roots. This is a verified master checkout
and consolidation of custody, not a claim that physical retirement is finished.
Before retirement, close/rehome old editor/session references, rescan for changes,
verify them against the snapshots, use Git worktree repair/move as appropriate and
keep compatibility links for any still-referenced launchers. Never prune or delete
worktrees solely because their old paths appear missing.

Private files stay private. Never push `.local`, `.env`, volume archives, family
records, uploaded images, encryption keys, credentials or agent transcripts.
Reproducible caches such as node_modules, .next and virtual environments were not
copied into the private source snapshots; Git history is preserved in bundles.

## Observed deployment at preparation (2026-10-30)
Production `babytracker-sprout` serves loopback port3123; synthetic preview
`babytracker-ocr-staging` serves3124. Cloudflare routes both through the existing
mtechlabs-service-hub tunnel. Both require Cloudflare Access plus application auth.
Preview copies the existing production Access allowlist; it is not a public demo.

Both images initially had ID
`sha256:63aafa44b21515dcab0e41f3890e87596072585d2e83663179beb15b80781555`
and legacy application revision label `44009d319854c3de26bd28addac184bc1e1043fb`.
That revision's source was at the repository root. The maintained application's
only difference from its root tree was staging Compose configuration, not 1,600
new application changes. Compare `legacy^{tree}` to `main:application` correctly.

OCR is enabled. Its printed-text/review pipeline exists; robust handwritten-sheet
accuracy remains unfinished. The existing synthetic committed receipt, corrected
feeding/diaper timeline, timestamps and source-image bytes passed verification.
That is not a new full OCR upload test or a claim that all handwriting works.

Production data volumes, NEVER disposable:
`babytracker-sprout-db`, `babytracker-sprout-env`, `babytracker-sprout-files`.
A fresh offline three-volume backup and isolated restore/integrity/config test
passed before preparation. The private archive is under `backups/`.
Preview uses different `babytracker-ocr-staging_*` volumes. Never copy real records
into preview or write synthetic tests into production.

## Updates: tested candidates, not arbitrary pushes
The acceptance workflow runs type checking, tests, build and browser OCR checks.
The accepted-image workflow builds SHA-addressed GHCR images after passing main
acceptance (or explicit main dispatch with the same gate) and emits an immutable
candidate manifest. It does NOT mutate your PC or automatically redeploy production.

From a clean, current `main` checkout, the owner promotion command is:

```powershell
pwsh -NoProfile -File .\scripts\promote-release.ps1 -Build
# Above is planning/validation only. Actual authorized promotion:
pwsh -NoProfile -File .\scripts\promote-release.ps1 -Build -Apply
```

Or explicitly pull a candidate pinned by digest, then pass it via `-Image`.
Promotion checks GitHub main and exact-commit acceptance, builds/identifies the
candidate, qualifies synthetic preview, then uses the existing offline backup,
restore-rehearsal and production-health gates. It records the deployed image/SHA
privately in `.local/releases/deployed.json`. The prior data volumes stay in place.
It must first be exercised end-to-end by the next release owner; local parser/unit
checks alone do not prove a successful production promotion.

Do not automatically restore an old database on health failure: that could erase
new care records or run an old application on an incompatible schema. Preserve the
snapshot, assess migration compatibility, and use a reviewed write-preserving
rollback. Unattended promotion and an in-app update UI are NOT implemented yet.
Do not add an unrestricted web endpoint capable of shell commands or Docker access.

## Optional modules
`modules/registry.json` separates available modules from planned features.

```powershell
python .\scripts\modules.py list
python .\scripts\modules.py disable ocr
# Requires explicit action; takes a backup and recreates the SAME image:
python .\scripts\modules.py disable ocr --apply
python .\scripts\modules.py enable ocr --apply
```

Without `--apply` no configuration or container is changed. OCR disable preserves
its records and source storage. Core cannot be disabled; unimplemented modules
cannot be installed. The CLI is a first working control foundation, not an in-app
module settings screen or a downloadable plugin marketplace. No remote-code loading.

## Upstream continuity
`upstreams.lock.json` records observed upstream heads and integration boundaries.
Master remotes: `upstream-sprout` -> Oak-and-Sprout/sprout-track main;
`upstream-babybuddy` -> babybuddy/babybuddy master.
The existing scheduled/manual release watcher creates review issues. Upstream
updates require prefix-aware comparison, license preservation, tests and review;
never replace application wholesale or blindly merge the two unrelated frameworks.
Only update integrationBase after a tested integration actually lands.

## Validation commands
```powershell
python -m unittest discover -s tests/ops -v
python scripts/modules.py list
pwsh -NoProfile -File scripts/update-babytracker.ps1 -ValidateOnly
# Existing synthetic receipt verification, never run against production:
docker exec babytracker-ocr-staging node /app/scripts/ocr-staging-check.mjs
```
The application keeps its own full CI. Module changes and deployment preparation
must be reviewed separately from claims about OCR recognition accuracy.
