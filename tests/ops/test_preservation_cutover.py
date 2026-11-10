"""Execute the real updater against synthetic PowerShell command adapters.

No Docker daemon, repository, credentials or production data are accessed.
The fixed preservation driver is replaced only inside this disposable fixture;
these tests verify orchestration order, identity binding and fail-closed cutover.
"""
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
PWSH = shutil.which('pwsh')
if os.environ.get('CI') and not PWSH:
    raise RuntimeError('PowerShell 7 is required for the production cutover contract tests')

HARNESS = r'''
param([string]$Scenario, [string]$Root)
$ErrorActionPreference='Stop'
$previous='sha256:'+('a'*64); $candidate='sha256:'+('c'*64); $revision='d'*40
$global:ops=@{ Events=[Collections.Generic.List[string]]::new(); Image=$previous; Previous=$previous; Candidate=$candidate;
 Revision=$revision; Scenario=$Scenario; Restarted=$false; Restored=$false; HealthReads=0; SeedComplete=$true;
 StartedAt='2026-11-02T00:00:00.000000000Z'; CaptureHash=('b'*64) }
function global:git {
 $global:LASTEXITCODE=0
 $a=@($args)
 if ($a[0] -eq 'rev-parse') { return $global:ops.Revision }
 if ($a[0] -eq 'status') { return }
 throw 'Unexpected synthetic git command'
}
function global:Start-Sleep { $global:ops.Events.Add('startup-wait') }
function global:docker {
 $global:LASTEXITCODE=0
 $a=@($args)
 if ($a[0] -eq 'compose' -and $a[1] -eq 'config') { return }
 if ($a[0] -eq 'image' -and $a[1] -eq 'inspect') {
  return (@{ Id=$global:ops.Candidate; Config=@{ Labels=@{ 'org.opencontainers.image.source'='https://github.com/MulattoTech/BabyTracker-Master'; 'org.opencontainers.image.revision'=$global:ops.Revision } } } | ConvertTo-Json -Depth 5 -Compress)
 }
 if ($a[0] -eq 'inspect') {
  $health='healthy'
  if ($global:ops.Restarted -and $global:ops.Image -eq $global:ops.Previous -and -not $global:ops.SeedComplete) {
   $global:ops.HealthReads++
   if ($global:ops.HealthReads -eq 1) { $health='starting' }
   else { $global:ops.SeedComplete=$true; $global:ops.Events.Add('old-startup-complete') }
  }
  return (@{ Id=('e'*64); Name='/babytracker-sprout'; Image=$global:ops.Image;
   State=@{ Running=$true; Paused=$false; StartedAt=$global:ops.StartedAt; Health=@{ Status=$health } };
   Mounts=@(@{ Type='volume'; Destination='/db'; Name='babytracker-sprout-db' },
    @{ Type='volume'; Destination='/app/env'; Name='babytracker-sprout-env' },
    @{ Type='volume'; Destination='/app/Files'; Name='babytracker-sprout-files' }) } | ConvertTo-Json -Depth 6 -Compress)
 }
 if ($a[0] -eq 'compose' -and $a[1] -eq 'up') {
  $global:ops.Events.Add('cutover'); $global:ops.Image=$global:ops.Candidate
  if ((Get-Content (Join-Path $Root '.env') -Raw) -notmatch [regex]::Escape($global:ops.Candidate)) { throw 'Candidate config was not written before cutover' }
  return
 }
 throw 'Unexpected synthetic Docker command'
}
$original=[IO.File]::ReadAllText((Join-Path $Root '.env'))
$failure=$null; $output=[Collections.Generic.List[object]]::new()
try {
 if ($Scenario -eq 'validate-only') { & (Join-Path $Root 'scripts/update-babytracker.ps1') -Image $candidate -VerifyDataPreservation -ValidateOnly | ForEach-Object { [void]$output.Add($_) } }
 else { & (Join-Path $Root 'scripts/update-babytracker.ps1') -Image $candidate -VerifyDataPreservation | ForEach-Object { [void]$output.Add($_) } }
} catch { $failure=$_.Exception.Message }
$reports=@(Get-ChildItem (Join-Path $Root '.local/releases') -Filter preservation.json -Recurse -ErrorAction SilentlyContinue)
@{ failed=($null -ne $failure); error=$failure; events=$global:ops.Events.ToArray(); output=$output.ToArray();
 envUnchanged=([IO.File]::ReadAllText((Join-Path $Root '.env')) -ceq $original); image=$global:ops.Image;
 preservationReports=$reports.Count } | ConvertTo-Json -Depth 6 -Compress
'''

BACKUP = r'''
$global:ops.Events.Add('backup')
$global:ops.Restarted=$true; $global:ops.SeedComplete=$false
if ($global:ops.Scenario -eq 'old-image-changed') { $global:ops.Image='sha256:'+('f'*64) }
'''
RESTORE = r'''
$global:ops.Events.Add('restore'); $global:ops.Restored=$true
'''
DRIVER = r'''
param([string]$Mode,[string]$ExpectedImage,[string]$BaselineFile,[string]$BaselineSha256)
$global:LASTEXITCODE=0
if ($Mode -eq 'Capture') {
 $global:ops.Events.Add('capture')
 if (-not $global:ops.Restored -or -not $global:ops.SeedComplete -or $ExpectedImage -cne $global:ops.Previous) { throw 'Capture preceded completed old startup/restore or used wrong image' }
 [IO.File]::WriteAllText($BaselineFile,'synthetic hash-only baseline')
 if ($global:ops.Scenario -eq 'restart-during-capture') { $global:ops.StartedAt='2026-11-02T00:01:00.000000000Z' }
 $status=if ($global:ops.Scenario -eq 'capture-status-failure') { 'FAIL' } else { 'PASS' }
 if ($global:ops.Scenario -eq 'capture-exit-failure') { $global:LASTEXITCODE=1 }
 @{ status=$status; baselineManifestSha256=$global:ops.CaptureHash; temporaryFilesRemoved=$true;
  verification=@{ mode='capture-live'; observedImageId=$ExpectedImage; databases=@{ main=@{ currentRows=2 }; logs=@{ currentRows=1 } } } } | ConvertTo-Json -Depth 6 -Compress
} else {
 $global:ops.Events.Add('verify')
 if ($ExpectedImage -cne $global:ops.Candidate -or $BaselineSha256 -cne $global:ops.CaptureHash -or -not (Test-Path $BaselineFile)) { throw 'Verification is not bound to the candidate and capture hash' }
 $status=if ($global:ops.Scenario -eq 'verify-failure') { 'FAIL' } else { 'PASS' }
 @{ status=$status; baselineManifestSha256=$BaselineSha256; temporaryFilesRemoved=$true;
  verification=@{ mode='verify-live'; observedImageId=$ExpectedImage; allBaselineRowsPreserved=($status -eq 'PASS'); baselineCreatedAt='2026-11-02T00:00:30.000Z';
   databases=@{ main=@{ baselineRows=2; matchedPreexistingRows=2 }; logs=@{ baselineRows=1; matchedPreexistingRows=1 } } } } | ConvertTo-Json -Depth 6 -Compress
}
exit $global:LASTEXITCODE
'''


@unittest.skipUnless(PWSH, 'PowerShell 7 is unavailable locally; CI requires it')
class PreservationCutover(unittest.TestCase):
    def run_scenario(self, scenario):
        with tempfile.TemporaryDirectory(prefix='sat-preservation-contract-') as temporary:
            root = Path(temporary)
            (root / 'scripts').mkdir()
            (root / 'backups').mkdir()
            (root / '.local/releases').mkdir(parents=True)
            (root / '.env').write_text('BABYTRACKER_IMAGE=sha256:' + 'a' * 64 + '\nUNRELATED=synthetic-only\n')
            shutil.copyfile(ROOT / 'scripts/update-babytracker.ps1', root / 'scripts/update-babytracker.ps1')
            for name, source in [('backup.ps1', BACKUP), ('test-restore.ps1', RESTORE), ('test-live-preservation.ps1', DRIVER), ('verify-live-preservation.cjs', '// synthetic helper placeholder')]:
                (root / 'scripts' / name).write_text(source)
            harness = root / 'harness.ps1'
            harness.write_text(HARNESS)
            run = subprocess.run([PWSH, '-NoProfile', '-NonInteractive', '-File', str(harness), '-Scenario', scenario, '-Root', str(root)], capture_output=True, text=True, timeout=30)
            self.assertEqual(run.returncode, 0, run.stderr)
            return json.loads(run.stdout.strip())

    def test_capture_follows_old_startup_and_verify_follows_cutover(self):
        result = self.run_scenario('success')
        self.assertFalse(result['failed'], result['error'])
        actions = [event for event in result['events'] if event != 'startup-wait']
        self.assertEqual(actions, ['backup', 'restore', 'old-startup-complete', 'capture', 'cutover', 'verify'])
        self.assertIn('startup-wait', result['events'])
        self.assertEqual(result['preservationReports'], 1)
        self.assertTrue(any(line.startswith('UPDATE_OK=') for line in result['output']))

    def test_capture_exit_or_report_failure_preserves_old_configuration(self):
        for scenario in ['capture-exit-failure', 'capture-status-failure']:
            with self.subTest(scenario=scenario):
                result = self.run_scenario(scenario)
                self.assertTrue(result['failed'])
                self.assertTrue(result['envUnchanged'])
                self.assertNotIn('cutover', result['events'])
                self.assertNotIn('verify', result['events'])
                self.assertEqual(result['preservationReports'], 0)

    def test_verify_failure_has_no_success_or_automatic_rollback(self):
        result = self.run_scenario('verify-failure')
        self.assertTrue(result['failed'])
        self.assertEqual(result['events'].count('cutover'), 1)
        self.assertEqual(result['image'], 'sha256:' + 'c' * 64)
        self.assertEqual(result['preservationReports'], 0)
        self.assertFalse(any(line.startswith('UPDATE_OK=') for line in result['output']))

    def test_changed_old_identity_or_reboot_during_capture_cancels_cutover(self):
        for scenario in ['old-image-changed', 'restart-during-capture']:
            with self.subTest(scenario=scenario):
                result = self.run_scenario(scenario)
                self.assertTrue(result['failed'])
                self.assertTrue(result['envUnchanged'])
                self.assertNotIn('cutover', result['events'])
                self.assertEqual(result['preservationReports'], 0)

    def test_validate_only_does_not_capture_or_mutate(self):
        result = self.run_scenario('validate-only')
        self.assertFalse(result['failed'], result['error'])
        self.assertEqual(result['events'], [])
        self.assertTrue(result['envUnchanged'])
        self.assertEqual(result['preservationReports'], 0)


class PreservationSourceContract(unittest.TestCase):
    def test_promoter_requires_current_receipt_before_writing_deployment_success(self):
        source = (ROOT / 'scripts/promote-release.ps1').read_text()
        self.assertIn('-VerifyDataPreservation:$VerifyDataPreservation', source)
        self.assertIn('-PreservationEvidenceDirectory $preservationDirectory', source)
        self.assertLess(source.index("'update-babytracker.ps1'"), source.index("'preservation.json'"))
        self.assertLess(source.index("'preservation.json'"), source.index("'deployed.json'"))
        for required in ['$preservation.imageId -cne $candidate.Id', '$preservation.previousImageId -cne $live.Image', '$preservation.revision -cne $revision', "'NOT_REQUESTED'"]:
            self.assertIn(required, source)


if __name__ == '__main__':
    unittest.main()
