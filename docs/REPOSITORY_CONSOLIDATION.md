# Repository consolidation — 2026-10-28

Canonical application: MulattoTech/BabyTracker. Shared controller source:
MulattoTech/Fleet-Control-Hub. BabyTracker-App is a legacy source repository, not a
second application. Its main history is retained as ancestry and its exact source
is imported into application/. Original app license/attribution remain intact.

The original deployment scripts, issue tracker, roadmap and persistence names
remain in this repository. Upstream Sprout continues to be a tracked dependency;
there is only one authoritative production database.

## Rollback
Use the verified private volume snapshot and the previous image pinned in the local
migration report. `compose.upstream-rollback.yaml` describes the former deployment.
Do not start an old binary on a schema it cannot read: restore to separate volumes
and verify first. Git bundles and metadata exports are stored privately on the host.

## Retirement gates
- Canonical branch merged with passing application and deployment checks.
- Full legacy main history reachable; all other branches preserved.
- Open legacy work accounted for; no development targeting legacy origin.
- Canonical image built and tested; private snapshot and restore verified.
- Existing production volumes and routing preserved.
- Fleet source/tests/install references use the shared repository.

Consult the local execution report for actual PASS/BLOCKED results. This design
record alone does not assert a production cutover or authorize deleting history.
