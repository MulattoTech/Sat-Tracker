# Sat-Tracker: pinned feedback security hotfix — read-only release preflight

**Scope:** A diagnostic-only release-check command for the maintenance hotfix. This is NOT a
production promotion mechanism, maintenance approval, backup tool or rollback script.

## Source of truth

| Field | Pinned value |
| --- | --- |
| Canonical repository | `MulattoTech/Sat-Tracker` |
| Maintenance branch | `release/feedback-security-b24ccc9` |
| Deployed source baseline | `b24ccc9cd70076cb1d8e0fed477e14d0cf533444` |
| Reviewed maintenance merge | `f3ea00e6161f887d4802f2a41238eb6a36d8103c` / PR #107 |
| Published hotfix | `ghcr.io/mulattotech/babytracker-master@sha256:7521979f4e9af6b5c9ee6cbfa1ec1ec8adb812b5ee2ce915e22168343c2f4cad` |
| Previously observed production and preview image | `sha256:1b4f57866debda9557d3ef073be61332f4440702daa5e8786245b198ea821756` |
| Required CI | maintenance-branch acceptance and operations |
| Publisher | successful pinned-image workflow run 44810452281 |
| Production services | `babytracker-sprout`, `babytracker-ocr-staging` |
| Production volumes | `babytracker-sprout-db`, `babytracker-sprout-env`, `babytracker-sprout-files` |

## Running the inspection

From a clean checkout where PowerShell 7, GitHub CLI, and Docker buildx are available
and authenticated for **read-only** metadata access. The exact immutable hotfix
image must **already be cached locally**; the preflight refuses to pull it:

```powershell
pwsh -NoProfile -NonInteractive -File scripts/feedback-hotfix-release-preflight.ps1
```

A successful run prints **`LIVE_READ_ONLY_PREFLIGHT_PASS`**, including the exact hotfix
SHA and image digest. It also prints `deploymentApproved: false` and
`approvedForCutover: false` deliberately. A PASS means *only* that the recorded
source, CI, registry index and existing container metadata matched at inspection time.
A failure throws `PREFLIGHT_BLOCKED` and must not be bypassed by changing expected
values or executing an older release script.

The script uses only `gh api`, `gh run list`, `gh run view`,
`docker buildx imagetools inspect`, `docker inspect`, and `docker image inspect`
for actual host inspection. The container lookups read only identity, state and
mount metadata. Image inspection reads only the local immutable image ID, OCI
labels and repo digests; it verifies exact release revision, original baseline,
canonical source, historical publishing source, fix scope and GHCR binding.
The historical `org.opencontainers.image.source` label is explicitly pinned to
`MulattoTech/BabyTracker-Master`, while the separate canonical label must equal
`MulattoTech/Sat-Tracker`; this does not authorize arbitrary legacy provenance.
Application environment-variable values, encryption keys, database rows and file
contents are not fetched. No images are pulled and no containers are started.

## Synthetic validation

```powershell
pwsh -NoProfile -NonInteractive -File scripts/feedback-hotfix-release-preflight.test.ps1
```

The tests use temporary fabricated JSON snapshots, including negative scenarios for
unexpected commits, changed source files, CI failures, altered image digest, missing
architecture, mismatched/missing local image identity, wrong revision or baseline
labels, unrelated scope/repository labels, incorrect local repo digest, broken
production/preview volume isolation, unhealthy/stopped/paused containers, changed
startup identities, and unsupported `-Apply` usage.

The standalone inspector also accepts `-Synthetic -FixturePath <path>` solely to
exercise its validation logic. It reports **`SYNTHETIC_ONLY_PASS`**, never live
readiness; fixtures are not an alternative to actual GitHub/registry/host checks.

Operations CI runs these refusal tests and separately parses every PowerShell script.

## Explicit release boundary

**Do not invoke** `scripts/promote-release.ps1 -Apply`,
`scripts/update-babytracker.ps1` without `-ValidateOnly`, or
`scripts/backup.ps1` under this package. The legacy promoter assumes current
`main`, not the pinned maintenance branch, and its apply path modifies the existing
protected preview before invoking production deployment. The backup script stops and
restarts production to acquire a consistent SQLite/env/files snapshot.

A *separately reviewed deployment implementation* would still require all of:
1. Exact hotfix image/branch and freshly verified checks, immutable provenance and a
   disposable old-schema/hotfix startup and authorization rehearsal; never reuse the
   existing preview as the rehearsal.
2. An explicitly approved maintenance interval and caregiver write-quiescence plan,
   including disconnected devices/offline outboxes, and a private three-volume
   snapshot. A future authorized backup must verify archive hashes, encryption
   configuration, and a strictly isolated restore before cutover.
3. Recorded migration/rollback decision points and tested preservation of historical
   care/media records. **Never replace post-cutover care entries with an older backup.**
   A cold restore of a synthetic historical seed does not prove write-preserving
   rollback for live records.
4. Another specific owner approval for the named production and preview targets and
   expected downtime, followed by post-activation health, authorization, image-digest,
   record-preservation and encrypted-media checks.

For the specifically scoped downtime/backup plan, exact-archive restore warnings,
offline caregiver-write quiescence and the non-executing rollback decision policy,
see [feedback-hotfix-maintenance-runbook.md](feedback-hotfix-maintenance-runbook.md).

No production backup, restart, deployment, Cloudflare change, real-family access,
historical data repair or sensitive key export is authorized by the preflight or the
approved source-review package. Keep privacy issue #25 and release issue #50 open
until their broader evidence and separate approvals exist.
