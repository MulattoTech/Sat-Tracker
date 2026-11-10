"""Exercise the actual backup script with synthetic Docker commands and files."""
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
    raise RuntimeError('PowerShell 7 is required for the backup state contract tests')

HARNESS = r'''
param([string]$Scenario, [string]$Root)
$ErrorActionPreference='Stop'
$global:events=[Collections.Generic.List[string]]::new()
$global:scenario=$Scenario
$global:destination=Join-Path $Root 'backups'
function global:docker {
 $global:LASTEXITCODE=0
 if ($args[0] -eq 'compose' -and $args[1] -eq 'ps') {
  $global:events.Add('inspect')
  if ($global:scenario -like 'ps-failure*') {
   $global:LASTEXITCODE=42
   if ($global:scenario -eq 'ps-failure-output') { return 'sprout' }
   return
  }
  if ($global:scenario -eq 'running') { return 'sprout' }
  return
 }
 if ($args[0] -eq 'compose' -and $args[1] -eq 'stop') {
  $global:events.Add('stop'); return
 }
 if ($args[0] -eq 'compose' -and $args[1] -eq 'up') {
  $global:events.Add('restart'); return
 }
 if ($args[0] -eq 'run') {
  $global:events.Add('archive')
  $filename=[regex]::Match($args[-1], 'babytracker-snapshot-\d{8}-\d{6}\.tar\.gz').Value
  if (-not $filename) { throw 'Synthetic archive filename not found' }
  [IO.File]::WriteAllBytes((Join-Path $global:destination $filename),[byte[]]::new(2048))
  return
 }
 throw 'Unexpected synthetic Docker command'
}
$failure=$null
$location=(Get-Location).Path
try { & (Join-Path $Root 'scripts/backup.ps1') -Destination $global:destination 6>$null }
catch { $failure=$_.Exception.Message }
@{ failed=($null -ne $failure); error=$failure; events=$global:events.ToArray();
 archiveCount=@(Get-ChildItem -LiteralPath $global:destination -Filter '*.tar.gz').Count;
 locationUnchanged=((Get-Location).Path -ceq $location) } | ConvertTo-Json -Depth 4 -Compress
'''


@unittest.skipUnless(PWSH, 'PowerShell 7 is unavailable locally; CI requires it')
class BackupStateContract(unittest.TestCase):
    def run_scenario(self, scenario):
        with tempfile.TemporaryDirectory(prefix='sat-backup-state-') as temporary:
            root = Path(temporary)
            (root / 'scripts').mkdir()
            shutil.copyfile(ROOT / 'scripts/backup.ps1', root / 'scripts/backup.ps1')
            harness = root / 'harness.ps1'
            harness.write_text(HARNESS)
            result = subprocess.run([PWSH, '-NoProfile', '-NonInteractive', '-File', str(harness), '-Scenario', scenario, '-Root', str(root)], capture_output=True, text=True, timeout=30)
            self.assertEqual(result.returncode, 0, result.stderr)
            return json.loads(result.stdout.strip())

    def test_failed_state_inspection_cannot_archive_stop_or_restart(self):
        for scenario in ['ps-failure-empty', 'ps-failure-output']:
            with self.subTest(scenario=scenario):
                result = self.run_scenario(scenario)
                self.assertTrue(result['failed'])
                self.assertIn('Cannot determine BabyTracker state', result['error'])
                self.assertEqual(result['events'], ['inspect'])
                self.assertEqual(result['archiveCount'], 0)
                self.assertTrue(result['locationUnchanged'])

    def test_already_stopped_service_can_be_backed_up_without_starting_it(self):
        result = self.run_scenario('stopped')
        self.assertFalse(result['failed'], result['error'])
        self.assertEqual(result['events'], ['inspect', 'archive'])
        self.assertEqual(result['archiveCount'], 1)
        self.assertTrue(result['locationUnchanged'])

    def test_running_service_is_stopped_before_archive_and_restarted(self):
        result = self.run_scenario('running')
        self.assertFalse(result['failed'], result['error'])
        self.assertEqual(result['events'], ['inspect', 'stop', 'archive', 'restart'])
        self.assertEqual(result['archiveCount'], 1)
        self.assertTrue(result['locationUnchanged'])


if __name__ == '__main__':
    unittest.main()
