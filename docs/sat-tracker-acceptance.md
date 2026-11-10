# Sat Tracker acceptance ledger

The canonical machine-readable inventory is [sat-tracker-acceptance-ledger.json](sat-tracker-acceptance-ledger.json).
The issue-by-issue audit is [sat-tracker-issue-dispositions-2026-11-02.json](sat-tracker-issue-dispositions-2026-11-02.json).

This is a **provisional evidence acceptance inventory**, independently reconciled
against merged source `a07289755b9a142e300f5367eba48ede8b999f1d`. The five accepted
release controls remain anchored to released revision
64c69c4b35df1161b2846c4f4e663e44e70d74a5 and release
[sat-tracker-2026-11-02](https://github.com/MulattoTech/BabyTracker-Master/releases/tag/sat-tracker-2026-11-02).
It is not a claim that only a small percentage of the source exists. Audited main
source is not automatically the deployed source; a new promotion needs its own
exact-image runtime receipts.

## Scope and counting

The inventory preserves all 77 original feature-matrix capabilities, including
76 Required and one Desired (SQLite). It adds 24 distinct cross-cutting mission
contracts for handwriting qualification, source privacy, the shared journal,
legacy history, real synchronization/devices, packaging disposition, setup,
modules/updater, camera, upstream maintenance, release controls, issue governance,
continuation and reusable form templates.

The [continuation scope audit](sat-tracker-scope-audit-2026-11-02.md) adds three
distinct required capabilities that were not explicitly contracted: the #22
caregiver handoff summary, #27 cross-domain data-quality resolution, and #28
prospective model evaluation/version governance. It expands detailed criteria
within existing rows for overlapping behavior instead of counting each test or
implementation slice as another accepted feature.

There are **103 inventoried required contracts** and one Desired contract.
Scope version `2026-11-02-v2` has 5 VERIFIED PASS, 76 IN PROGRESS,
6 BLOCKED and 16 NOT IMPLEMENTED. No existing status becomes PASS in this audit.

**The final whole-product denominator is not yet certified.** The scopeComplete
field therefore remains false and the validator deliberately returns a null
acceptance percentage. The current audit maps the detailed mission and live-issue
criteria, including closed residual scope. Pinned upstream field-level parity,
package commitments and preserved private recovery proposals still require
reconciliation, followed by an independent final counterexample audit. Record
the resulting scope version before publishing a whole-product percentage. Never
treat 103 inventoried contracts as evidence that all possible scope is known, or
interpret the five release-control contracts as a percentage of implemented code.

When the scope is certified, completion is:

**VERIFIED PASS required contracts / all required contracts**

Blocked and unimplemented requirements remain in that denominator. Desired
items are shown separately. Source presence, passing unit tests, a merged PR,
or a closed issue cannot independently establish full contract acceptance.

## Merged continuation source

PRs [#66](https://github.com/MulattoTech/BabyTracker-Master/pull/66) through
[#70](https://github.com/MulattoTech/BabyTracker-Master/pull/70) add structured OCR
duration, a durable new-bottle outbox, private image-qualification infrastructure,
the initial ledger and unknown-medication-dose preservation. Acceptance,
operations, Compose and image-build workflows passed on `a072897`. Their narrow
synthetic evidence is attached to the affected open contracts. It does not accept
physical devices, real handwriting, actual historical migration or broad parity.

The outbox covers new bottles in a loaded Journal; cold offline startup,
background delivery while closed, historical edits and other care types remain
open. The handwriting harness is implemented; representative human-paper input
and reviewed ground truth are still missing. Unknown-dose imports now retain an
unresolved Note, while complete medication semantics remain unaccepted.

## Status and evidence

- **VERIFIED PASS**: every criterion has the required implementation, test,
  preview, production and physical-device evidence for its declared scope.
- **IN PROGRESS**: implementation or partial evidence exists, but the complete
  contract is unaccepted.
- **BLOCKED**: a named external input/device prevents acceptance; independent
  preparation may continue.
- **NOT IMPLEMENTED**: the audited canonical runtime does not provide the
  required capability, or it is still a planned integration.

The five accepted release controls reference the published release and its
private operational receipts. They are not reusable blanket permission for a
future candidate: every new production promotion must bind its own exact source,
image, preview, backup/restore, migration, rollback, preservation and live-smoke
evidence. Keep private source documents, databases, keys, record counts and
per-row fingerprints outside Git.

Physical Pixel/iPad contracts explicitly require device evidence. Desktop
emulation is useful partial evidence but cannot replace physical-device results.
The shared Journal, actual multi-device synchronization and family setup
contracts also require device evidence. Each device receipt declares
`environment: "physical-device"` and a nonempty `deviceModels` list. Pixel/iPad
receipts must identify the required model. A synchronization receipt additionally
declares `physicalDeviceCount` of at least two for the same demonstrated test;
two devices can have the same model. These metadata are reviewed attestations,
not an automatic proof of genuine device use. Do not include serial numbers,
account identities or family records in public evidence.
Representative handwriting requires actual image recognition of representative
samples. Printed fixtures and parser-string tests cannot satisfy it.

Native/desktop contracts first require an explicit commitment/reuse disposition.
The legacy wrappers and web bridge are not accepted canonical packages. Keep
those contracts open until either the promised packages are qualified or the
owner records a scope decision.

## Updating the ledger

1. Preserve stable IDs and the original feature coverage.
2. Add any newly discovered required contract with its source and acceptance
   criteria. Document duplicate mappings; do not remove inconvenient criteria.
3. Attach implementation references and scoped evidence with full source SHAs.
4. Record narrow implementation successes in checkpoints while broad parent
   contracts remain open.
5. Set VERIFIED PASS only when every required evidence category is populated
   and no remaining work exists.
6. Update the source/release checkpoint and this explanation when accepting a
   newer release. Do not cite a future unexecuted release as passing evidence.
7. Reconcile linked GitHub issues only after their complete acceptance contract
   is met. Leave #39 Fleet outside this application mission.

Run the deterministic validator and its negative tests from the repository root:

    python scripts/acceptance_ledger.py
    python -m unittest discover -s tests/ops -p test_acceptance_ledger.py -v

The validator guards schema, stable IDs, explicit required scope, statuses,
evidence presence, physical-device evidence and honest denominators. It cannot
authenticate an evidence claim; independent review of the linked receipts and
runtime remains mandatory.
Malformed input returns validation errors. When any validation error exists,
`verifiedPass` and `acceptancePercent` are null; `claimedPass` is diagnostic only.
An invalid file cannot emit an accepted count or a 100% acceptance result.

## Open issue and PR disposition

The source audit rechecked 33 open issues, of which 32 belong to the app mission, and
one preserved draft PR (#35). Existing labels use an older P1-P5 scale; the
issue audit records suggested P0-P3 mission priorities separately and does not
rewrite labels.

Closed #29, #37 and #38 retain broad unaccepted criteria. Their status is not
counted as PASS. Closed #11/#12/#25 also need the residual acceptance assessment
recorded in the audit. Any reopened/superseded issue must explain exactly which
criterion remains, without erasing valid completed work.

Draft #35 contains Feature Studio intake configuration and an issue form,
not a runtime module updater. Keep its work intact and review it independently.
Issue #49 still requires the preserved private PR1 comparison and disposition
of deferred adapter/crop proposals. No recovery branch, worktree or stash is
deleted by this ledger.
