"""Run the real promoter with synthetic commands and no live service access.

Negative cases must refuse before even a Git/Docker/GitHub inspection. Plan-only
cases may inspect synthetic identities, but cannot create a lock or receipt or
invoke an updater. PowerShell 7 is available in the required operations CI job.
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
    raise RuntimeError('PowerShell 7 is required for production promotion contract tests')

HARNESS = r'''
param([string]$Scenario, [string]$Root)
$ErrorActionPreference='Stop'
$global:events=[Collections.Generic.List[string]]::new()
$revision='d'*40
function global:git {
 $global:LASTEXITCODE=0
 $global:events.Add('git:' + ($args -join ' '))
 if ($args[0] -eq 'rev-parse') { return 'd'*40 }
 if ($args[0] -eq 'status') { return }
 if ($args[0] -eq 'branch') { return 'main' }
 throw 'Unexpected synthetic git command'
}
function global:gh {
 $global:LASTEXITCODE=0
 $global:events.Add('gh:' + ($args -join ' '))
 if ($args[0] -ne 'api') { throw 'Unexpected synthetic GitHub command' }
 if ($args[1] -like '*/commits/main') { return 'd'*40 }
 if ($args[1] -like '*/actions/workflows/*/runs?*') {
  return (@{ workflow_runs=@(@{ head_sha=('d'*40); head_branch='main'; status='completed'; conclusion='success'; created_at='2026-11-02T00:00:00Z'; id=1 }) } | ConvertTo-Json -Depth 4 -Compress)
 }
 throw 'Unexpected synthetic GitHub API path'
}
function global:docker {
 $global:LASTEXITCODE=0
 $global:events.Add('docker:' + ($args -join ' '))
 if ($args[0] -eq 'compose' -and $args[1] -eq 'config') { return }
 if ($args[0] -eq 'inspect' -and $args[1] -eq 'babytracker-sprout') {
  return (@{ Image=('sha256:'+('a'*64)); State=@{ Health=@{ Status='healthy' } };
   Mounts=@(@{ Name='babytracker-sprout-db' },@{ Name='babytracker-sprout-env' },@{ Name='babytracker-sprout-files' }) } | ConvertTo-Json -Depth 5 -Compress)
 }
 throw 'Mutation or unexpected Docker command refused by the synthetic harness'
}
$failure=$null; $output=@()
$envPath=Join-Path $Root '.env'
$original=[IO.File]::ReadAllText($envPath)
$location=(Get-Location).Path
try {
 $parameters=@{}
 if ($Scenario -like 'apply-*') { $parameters.Apply=$true }
 if ($Scenario -eq 'apply-explicit-false') { $parameters.VerifyDataPreservation=$false }
 if ($Scenario -eq 'apply-build') { $parameters.Build=$true }
 if ($Scenario -eq 'plan-with-preservation') { $parameters.VerifyDataPreservation=$true }
 $output=@(& (Join-Path $Root 'scripts/promote-release.ps1') @parameters)
} catch { $failure=$_.Exception.Message }
@{ failed=($null -ne $failure); error=$failure; events=$global:events.ToArray(); output=$output;
 envUnchanged=([IO.File]::ReadAllText($envPath) -ceq $original);
 locationUnchanged=((Get-Location).Path -ceq $location);
 localCreated=(Test-Path (Join-Path $Root '.local')) } | ConvertTo-Json -Depth 6 -Compress
'''


@unittest.skipUnless(PWSH, 'PowerShell 7 is unavailable locally; CI requires it')
class PromotionPreservationRequired(unittest.TestCase):
    def run_scenario(self, scenario):
        with tempfile.TemporaryDirectory(prefix='sat-promotion-contract-') as temporary:
            root = Path(temporary)
            (root / 'scripts').mkdir()
            (root / '.env').write_text('BABYTRACKER_IMAGE=synthetic-previous\nUNRELATED=retain\n')
            shutil.copyfile(ROOT / 'scripts/promote-release.ps1', root / 'scripts/promote-release.ps1')
            harness = root / 'harness.ps1'
            harness.write_text(HARNESS)
            run = subprocess.run([PWSH, '-NoProfile', '-NonInteractive', '-File', str(harness), '-Scenario', scenario, '-Root', str(root)], capture_output=True, text=True, timeout=30)
            self.assertEqual(run.returncode, 0, run.stderr)
            return json.loads(run.stdout.strip())

    def test_apply_without_preservation_refuses_before_inspection_or_mutation(self):
        for scenario in ['apply-missing', 'apply-explicit-false', 'apply-build']:
            with self.subTest(scenario=scenario):
                result = self.run_scenario(scenario)
                self.assertTrue(result['failed'])
                self.assertIn('requires -VerifyDataPreservation', result['error'])
                self.assertEqual(result['events'], [])
                self.assertEqual(result['output'], [])
                self.assertTrue(result['envUnchanged'])
                self.assertTrue(result['locationUnchanged'])
                self.assertFalse(result['localCreated'])

    def test_plan_only_remains_available_with_or_without_preservation_switch(self):
        for scenario in ['plan-default', 'plan-with-preservation']:
            with self.subTest(scenario=scenario):
                result = self.run_scenario(scenario)
                self.assertFalse(result['failed'], result['error'])
                self.assertTrue(result['events'])
                self.assertEqual(len(result['output']), 1)
                self.assertIn('PROMOTION_PLAN_ONLY', result['output'][0])
                self.assertIn('productionChanged=false', result['output'][0])
                self.assertTrue(result['envUnchanged'])
                self.assertTrue(result['locationUnchanged'])
                self.assertFalse(result['localCreated'])


class PromotionPreservationSourceContract(unittest.TestCase):
    def test_refusal_precedes_root_resolution_and_every_external_operation(self):
        source = (ROOT / 'scripts/promote-release.ps1').read_text()
        refusal = source.index('if ($Apply -and -not $VerifyDataPreservation)')
        for later in ['$root=', 'Push-Location', '& git', '& gh', '& docker', 'New-Item']:
            self.assertLess(refusal, source.index(later))

    def test_emitted_candidate_command_requests_required_preservation(self):
        workflow = (ROOT / '.github/workflows/application-image.yml').read_text()
        command_line = next(line for line in workflow.splitlines() if "'promotionCommand':" in line)
        self.assertIn('-VerifyDataPreservation', command_line)
        self.assertIn('-Apply', command_line)


if __name__ == '__main__':
    unittest.main()
