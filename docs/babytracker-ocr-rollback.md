# OCR staging rollback rehearsal

## Scope

This drill verifies that the **actual currently deployed immutable image** can
start against a copy of the candidate's migrated synthetic storage and read the
two canonical care events. It uses **only the disposable synthetic OCR stage**.
It does not stop, mount or restore production storage, downgrade a live database,
or authorize production promotion.

Capture the previous image from the production container before promotion and
pass its immutable `sha256:` image ID through the required `-RollbackImage`
parameter. A historical image or mutable tag does not qualify rollback from the
current candidate. Recheck that production still uses the captured image before
promoting; if another release changed it, repeat the drill with the new previous
image.

The allowed source container and Compose project are both
`babytracker-ocr-staging`. The only permitted source volumes are
`babytracker-ocr-staging_staging-db`, `babytracker-ocr-staging_staging-env` and
`babytracker-ocr-staging_staging-files`. The source container must have exactly
those mounts, the explicit synthetic-staging flag, and healthy/unpaused state.

## Run

Use **PowerShell 7**, not Windows PowerShell 5.1. Native arguments use
`ProcessStartInfo.ArgumentList` to avoid shell quoting and interpretation.
The stage must run the exact accepted candidate and first pass
`application/scripts/ocr-staging-check.mjs` inside that image. The previous image
and `alpine:3.21` copy helper must already be cached; the drill
does not pull images or use an external network.

```powershell
# Run in PowerShell 7, before any production promotion.
Set-Location 'C:\Tools\Dev\BabyTracker-Master'
$rollbackImage = (& docker inspect babytracker-sprout --format '{{.Image}}').Trim()
if ($LASTEXITCODE -ne 0 -or $rollbackImage -notmatch '^sha256:[a-f0-9]{64}$') {
    throw 'Cannot establish the current production image for rollback'
}
& ./scripts/test-ocr-rollback.ps1 -RollbackImage $rollbackImage
if ($LASTEXITCODE -ne 0) { throw 'Rollback rehearsal failed; do not promote' }
```

Keep the returned receipt private with the release evidence. Require
`passed: true`, `cleanupVerified: true`, the expected `candidateImage` and the
captured `rollbackImage`. The drill pauses only the synthetic stage briefly
while copying it, resumes it in `finally`, and removes only its owned resources.

The verifier requires the known synthetic family, child and two imported events.
It also permits the exact untouched, empty family/caretaker/settings defaults
created by Sprout's first-run seed. Additional children, configured seed records,
other family-associated records and references to the seed caretaker are refused.
It never removes records to make a fixture pass. The staging check may reopen an
already committed fixture (`mode: verify-existing`); that is compatibility
evidence, not fresh acceptance of every newly added feature. Run broader feature
acceptance on separate disposable storage so this rollback fixture remains
qualified without deleting records to satisfy the verifier.

The script verifies identity, pauses only the immutable staging container ID,
copies its three volumes read-only into unique ownership-labelled volumes, and
resumes staging immediately in `finally`. It starts the original image on those
clones with no published ports, `--network none`, one CPU, 2 GiB RAM and a PID
limit. Ordinary authentication and timeline checks run inside that container.
Cleanup verifies ownership labels before removing only this invocation's
temporary containers and volumes. Credentials and record contents are not printed.

## Historical observed result — 2026-10-27

The evidence below applies only to the recorded October 27 candidate and the
then-original Sprout Track 1.6.7 image
`sha256:445b7dfd6cc8976e9e0ec313457c11b8336befea5a2fab69fd573ff55ac77a64`.
It must not be reused as a current release's rollback receipt.

**PASS**, exit 0, against the staged application runtime built from
`7b94b2290e6989adc9b9a99a2fc694c54258ccd7`. The later app commit `04feb01` changes
only browser-test cleanup. Application PR [#2] is merged as `83326cf`; its
[hosted acceptance run] passed 1,490 tests, TypeScript, build and real Chromium
acceptance before merge.

| Check | Observed result |
| --- | --- |
| Original immutable image starts on cloned volumes | PASS |
| Ordinary caretaker authentication and care timeline | PASS |
| Exactly two canonical events, with unchanged complete rows, IDs and timestamps | PASS |
| OCR document and audit rows preserved | PASS |
| Exactly two original import-ledger mappings preserved | PASS |
| Encrypted original and preview bytes preserved | PASS, two files |
| Staging resumed and temporary resources removed | PASS |
| Staging subsequently returns HTTP 200 and healthy status | PASS |
| Production health and original start time unchanged | PASS |

The synthetic canonical digest was
`3e3016f05622ab207d22f73204990b20b9558600cb4bf6bb3be64cfbfe1ed161`.
Hashes cover full rows, not just event counts. An initial preflight refusal
correctly stopped before pausing because the first helper did not recognize the
stock seed. The reviewed helper now verifies that seed's exact defaults and
empty relationships. During the successful pause/copy, a health probe briefly
reported unhealthy; subsequent checks confirmed recovery without restarting
staging or production.

## Separate production gates

Every production promotion separately requires exact-revision CI, candidate
preview acceptance, a fresh consistent backup and isolated restore, a private
full-startup migration rehearsal, this previous-image rollback drill, protected
access checks, and live data-preservation evidence. The owner-invoked promoter
refuses `-Apply` without `-VerifyDataPreservation`; plan-only inspection remains
available without it. See [the preservation contract](release-data-preservation.md).

The October 7 backup described in the original drill is **not a current
production backup**. Synthetic rollback does not prove representative handwriting,
physical-device acceptance, every production-data migration, or PostgreSQL
rollback behavior. Current unresolved acceptance belongs to the
[canonical ledger](sat-tracker-acceptance.md) and issues [#49], [#50], and [#30].

[#2]: https://github.com/MulattoTech/BabyTracker-App/pull/2
[hosted acceptance run]: https://github.com/MulattoTech/BabyTracker-App/actions/runs/40456178992
[#49]: https://github.com/MulattoTech/BabyTracker-Master/issues/49
[#50]: https://github.com/MulattoTech/BabyTracker-Master/issues/50
[#30]: https://github.com/MulattoTech/BabyTracker-Master/issues/30
