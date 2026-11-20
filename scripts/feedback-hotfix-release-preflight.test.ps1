# Synthetic contract tests for inspection-only release readiness. No Docker/GitHub access.
[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$script = Join-Path $PSScriptRoot 'feedback-hotfix-release-preflight.ps1'
$directory = Join-Path ([IO.Path]::GetTempPath()) ('sat-hotfix-plan-test-' + [guid]::NewGuid().ToString('N'))
[void](New-Item -ItemType Directory -Path $directory)
$sha = 'f3ea00e6161f887d4802f2a41238eb6a36d8103c'
$oldImage = 'sha256:1b4f57866debda9557d3ef073be61332f4440702daa5e8786245b198ea821756'
$previewNames = @(
    @{ Name = 'babytracker-ocr-staging_staging-db'; Destination = '/db'; Type = 'volume' },
    @{ Name = 'babytracker-ocr-staging_staging-env'; Destination = '/app/env'; Type = 'volume' },
    @{ Name = 'babytracker-ocr-staging_staging-files'; Destination = '/app/Files'; Type = 'volume' }
)
$productionNames = @(
    @{ Name = 'babytracker-sprout-db'; Destination = '/db'; Type = 'volume' },
    @{ Name = 'babytracker-sprout-env'; Destination = '/app/env'; Type = 'volume' },
    @{ Name = 'babytracker-sprout-files'; Destination = '/app/Files'; Type = 'volume' }
)
$good = [ordered]@{
    releaseRefSha = $sha
    mainSha = '0345294a822be686f5d94fee785b441fa51601bf'
    comparison = @{
        status = 'ahead'; ahead_by = 2; behind_by = 0
        files = @(
            @{ filename = 'application/app/api/feedback/file/[id]/route.ts' },
            @{ filename = 'application/tests/feedbackFileIsolationBackport.test.ts' }
        )
    }
    runs = @(
        @{ name = 'BabyTracker acceptance'; headSha = $sha; status = 'completed'; conclusion = 'success'; createdAt = '2026-11-20T20:03:53Z' },
        @{ name = 'BabyTracker operations contracts'; headSha = $sha; status = 'completed'; conclusion = 'success'; createdAt = '2026-11-20T20:03:55Z' }
    )
    publisher = @{ name = 'Publish pinned feedback-attachment security hotfix'; status = 'completed'; conclusion = 'success' }
    registry = @{ digest = 'sha256:7521979f4e9af6b5c9ee6cbfa1ec1ec8adb812b5ee2ce915e22168343c2f4cad'; amd64 = $true }
    localImage = @{
        imageId = 'sha256:7521979f4e9af6b5c9ee6cbfa1ec1ec8adb812b5ee2ce915e22168343c2f4cad'
        repoDigests = @('ghcr.io/mulattotech/babytracker-master@sha256:7521979f4e9af6b5c9ee6cbfa1ec1ec8adb812b5ee2ce915e22168343c2f4cad')
        labels = @{
            'org.opencontainers.image.revision' = $sha
            'org.opencontainers.image.source.canonical' = 'https://github.com/MulattoTech/Sat-Tracker'
            'org.opencontainers.image.source' = 'https://github.com/MulattoTech/BabyTracker-Master'
            'io.mtech.hotfix.base-revision' = 'b24ccc9cd70076cb1d8e0fed477e14d0cf533444'
            'io.mtech.hotfix.scope' = 'feedback-attachment-family-admin-boundary'
        }
    }
    production = @{ name = '/babytracker-sprout'; imageId = $oldImage; running = $true; paused = $false; health = 'healthy'; startedAt = '2026-11-19T22:56:10.569818426Z'; mounts = $productionNames }
    preview = @{ name = '/babytracker-ocr-staging'; imageId = $oldImage; running = $true; paused = $false; health = 'healthy'; startedAt = '2026-11-19T22:56:10.575791966Z'; mounts = $previewNames }
}
$passed = 0
$failed = 0
function Invoke-Case([string]$name, [scriptblock]$mutate, [bool]$shouldPass) {
    $state = $good | ConvertTo-Json -Depth 30 | ConvertFrom-Json -Depth 30
    & $mutate $state
    $fixture = Join-Path $directory ('case-' + [guid]::NewGuid().ToString('N') + '.json')
    $state | ConvertTo-Json -Depth 30 | Set-Content -LiteralPath $fixture -Encoding utf8NoBOM
    $raw = & pwsh -NoProfile -NonInteractive -File $script -Synthetic -FixturePath $fixture 2>&1
    $exitCode = $LASTEXITCODE
    $output = ($raw -join "`n")
    if ($shouldPass) {
        $ok = $exitCode -eq 0 -and $output.Contains('"result":"SYNTHETIC_ONLY_PASS"') -and
            $output.Contains('"localCandidateProvenanceVerified":true') -and
            $output.Contains('"deploymentApproved":false') -and $output.Contains('"approvedForCutover":false')
    } else {
        $ok = $exitCode -ne 0 -and -not $output.Contains('"result":"SYNTHETIC_ONLY_PASS"')
    }
    if ($ok) {
        $script:passed++
        Write-Output "PASS $name"
    } else {
        $script:failed++
        Write-Output "FAIL $name (exit $exitCode) :: $($output.Substring(0, [math]::Min($output.Length, 350)))"
    }
}
try {
    Invoke-Case 'valid synthetic contract never authorizes deployment' {param($v)} $true
    Invoke-Case 'mismatched release ref' {param($v) $v.releaseRefSha = 'a' * 40} $false
    Invoke-Case 'main and maintenance unexpectedly equal' {param($v) $v.mainSha = $sha} $false
    Invoke-Case 'unexpected additional source commit' {param($v) $v.comparison.ahead_by = 3} $false
    Invoke-Case 'unsafe changed migration path' {param($v) $v.comparison.files[1].filename = 'application/prisma/schema.prisma'} $false
    Invoke-Case 'newer failed acceptance overrides older pass' {
        param($v) $v.runs += [pscustomobject]@{ name = 'BabyTracker acceptance'; headSha = $sha; status = 'completed'; conclusion = 'failure'; createdAt = '2026-11-20T20:40:00Z' }
    } $false
    Invoke-Case 'acceptance uses wrong commit' {param($v) $v.runs[0].headSha = 'b' * 40} $false
    Invoke-Case 'missing operations workflow' {param($v) $v.runs = @($v.runs[0])} $false
    Invoke-Case 'publisher failed' {param($v) $v.publisher.conclusion = 'failure'} $false
    Invoke-Case 'publisher identity changed' {param($v) $v.publisher.name = 'Different publisher'} $false
    Invoke-Case 'registry index digest changed' {param($v) $v.registry.digest = 'sha256:' + ('c' * 64)} $false
    Invoke-Case 'architecture missing' {param($v) $v.registry.amd64 = $false} $false
    Invoke-Case 'local image ID mismatched' {param($v) $v.localImage.imageId = 'sha256:' + ('c' * 64)} $false
    Invoke-Case 'local image revision label mismatched' {param($v) $v.localImage.labels.'org.opencontainers.image.revision' = 'd' * 40} $false
    Invoke-Case 'local image baseline label mismatched' {param($v) $v.localImage.labels.'io.mtech.hotfix.base-revision' = 'e' * 40} $false
    Invoke-Case 'canonical source label changed' {param($v) $v.localImage.labels.'org.opencontainers.image.source.canonical' = 'https://github.com/other/repo'} $false
    Invoke-Case 'historical publisher source label changed' {param($v) $v.localImage.labels.'org.opencontainers.image.source' = 'https://github.com/other/repo'} $false
    Invoke-Case 'hotfix scope label changed' {param($v) $v.localImage.labels.'io.mtech.hotfix.scope' = 'unrelated-change'} $false
    Invoke-Case 'image is not bound to approved repo digest' {param($v) $v.localImage.repoDigests = @('ghcr.io/other/image@sha256:' + ('c' * 64))} $false
    Invoke-Case 'local image metadata absent' {param($v) $v.PSObject.Properties.Remove('localImage')} $false
    Invoke-Case 'production image unexpectedly updated' {param($v) $v.production.imageId = 'sha256:' + ('d' * 64)} $false
    Invoke-Case 'production unhealthy' {param($v) $v.production.health = 'unhealthy'} $false
    Invoke-Case 'production stopped' {param($v) $v.production.running = $false} $false
    Invoke-Case 'production restart changed observed origin' {param($v) $v.production.startedAt = '2026-11-20T22:56:10Z'} $false
    Invoke-Case 'production extra mount' {param($v) $v.production.mounts += [pscustomobject]@{ Name = 'extra'; Destination = '/other'; Type = 'volume' }} $false
    Invoke-Case 'production nonvolume mount' {param($v) $v.production.mounts[0].Type = 'bind'} $false
    Invoke-Case 'protected preview shares production DB volume' {param($v) $v.preview.mounts[0].Name = 'babytracker-sprout-db'} $false
    Invoke-Case 'protected preview image changed' {param($v) $v.preview.imageId = 'sha256:' + ('e' * 64)} $false
    Invoke-Case 'preview paused' {param($v) $v.preview.paused = $true} $false

    # Argument guards must reject unsupported commands before contacting the real host.
    foreach ($arguments in @(
        @('-Apply'),
        @('-Synthetic'),
        @('-FixturePath', (Join-Path $directory 'does-not-exist.json'))
    )) {
        $raw = & pwsh -NoProfile -NonInteractive -File $script @arguments 2>&1
        if ($LASTEXITCODE -eq 0) {
            $script:failed++
            Write-Output "FAIL rejected invocation: $($arguments -join ' ')"
        } else {
            $script:passed++
            Write-Output "PASS rejected invocation: $($arguments -join ' ')"
        }
    }
    $tokens = $null; $parseErrors = $null
    [void][Management.Automation.Language.Parser]::ParseFile($script, [ref]$tokens, [ref]$parseErrors)
    if ($parseErrors.Count) { $script:failed++; Write-Output 'FAIL PowerShell syntax' }
    else { $script:passed++; Write-Output 'PASS PowerShell syntax' }
} finally {
    Remove-Item -LiteralPath $directory -Recurse -Force -ErrorAction SilentlyContinue
}
Write-Output "HOTFIX_PLAN_TESTS pass=$passed fail=$failed"
if ($failed) { exit 1 }
