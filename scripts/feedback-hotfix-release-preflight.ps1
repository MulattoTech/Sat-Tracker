# Read-only hotfix release decision support; this file intentionally has NO deploy or apply mode.
# Synthetic fixture mode is diagnostic-only and must never count as live release approval.
[CmdletBinding()]
param(
    [switch]$Synthetic,
    [string]$FixturePath
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$contract = [ordered]@{
    repository = 'MulattoTech/Sat-Tracker'
    releaseBranch = 'release/feedback-security-b24ccc9'
    releaseSha = 'f3ea00e6161f887d4802f2a41238eb6a36d8103c'
    baselineSha = 'b24ccc9cd70076cb1d8e0fed477e14d0cf533444'
    priorImage = 'sha256:1b4f57866debda9557d3ef073be61332f4440702daa5e8786245b198ea821756'
    candidate = 'ghcr.io/mulattotech/babytracker-master@sha256:7521979f4e9af6b5c9ee6cbfa1ec1ec8adb812b5ee2ce915e22168343c2f4cad'
    publisherRun = 44810452281
    canonicalSource = 'https://github.com/MulattoTech/Sat-Tracker'
    historicalSource = 'https://github.com/MulattoTech/BabyTracker-Master'
    hotfixScope = 'feedback-attachment-family-admin-boundary'
    productionStart = '2026-11-19T22:56:10.569818426Z'
    previewStart = '2026-11-19T22:56:10.575791966Z'
}

function Assert-MatchValue($actual, $expected, [string]$description) {
    if ($null -eq $actual -or [string]$actual -cne [string]$expected) {
        throw "PREFLIGHT_BLOCKED: $description differs from the pinned release contract"
    }
}
function Invoke-ReadOnly([string]$program, [string[]]$arguments) {
    # These call sites are strictly allowlisted below: gh api/run list/run view and
    # docker inspect/buildx imagetools inspect. Never compose, exec, pull or apply.
    $lines = & $program @arguments 2>&1
    if ($LASTEXITCODE -ne 0) {
        throw "PREFLIGHT_BLOCKED: read-only $program inspection failed"
    }
    return ($lines -join "`n").Trim()
}
function Get-ContainerSnapshot([string]$container) {
    # Only permitted metadata fields are retrieved; do not inspect Config.Env.
    $fields = Invoke-ReadOnly 'docker' @(
        'inspect', '--format',
        '{{.Name}}|{{.Image}}|{{.State.Running}}|{{.State.Paused}}|{{.State.Health.Status}}|{{.State.StartedAt}}',
        $container
    )
    $tokens = @($fields.Split('|'))
    if ($tokens.Count -ne 6) { throw 'PREFLIGHT_BLOCKED: unexpected container metadata' }
    $mountText = Invoke-ReadOnly 'docker' @('inspect', '--format', '{{json .Mounts}}', $container)
    $mounts = @($mountText | ConvertFrom-Json -Depth 20)
    return [pscustomobject]@{
        name = $tokens[0]; imageId = $tokens[1]
        running = ($tokens[2] -ceq 'true'); paused = ($tokens[3] -ceq 'true')
        health = $tokens[4]; startedAt = $tokens[5]; mounts = $mounts
    }
}
function Get-LocalCandidateIdentity {
    # Local OCI metadata only: never inspect or print image environment variables.
    # If the already-published image is absent locally, block rather than pulling it.
    $image = $contract.candidate
    $id = Invoke-ReadOnly 'docker' @('image', 'inspect', '--format', '{{.Id}}', $image)
    $labelsText = Invoke-ReadOnly 'docker' @('image', 'inspect', '--format', '{{json .Config.Labels}}', $image)
    $digestsText = Invoke-ReadOnly 'docker' @('image', 'inspect', '--format', '{{json .RepoDigests}}', $image)
    return [pscustomobject]@{
        imageId = $id
        labels = ($labelsText | ConvertFrom-Json -Depth 10)
        repoDigests = @($digestsText | ConvertFrom-Json -Depth 10)
    }
}
function Get-LiveSnapshot {
    $repo = $contract.repository
    $ref = $contract.releaseBranch
    $branchSha = Invoke-ReadOnly 'gh' @('api', "repos/$repo/git/ref/heads/$ref", '--jq', '.object.sha')
    $mainSha = Invoke-ReadOnly 'gh' @('api', "repos/$repo/commits/main", '--jq', '.sha')
    $compare = (Invoke-ReadOnly 'gh' @(
        'api', ("repos/{0}/compare/{1}...{2}" -f $repo, $contract.baselineSha, $contract.releaseSha)
    )) | ConvertFrom-Json -Depth 20
    $runs = (Invoke-ReadOnly 'gh' @(
        'run', 'list', '--repo', $repo, '--branch', $ref, '--limit', '50',
        '--json', 'databaseId,name,status,conclusion,headSha,createdAt,url'
    )) | ConvertFrom-Json -Depth 15
    $publisher = (Invoke-ReadOnly 'gh' @(
        'run', 'view', [string]$contract.publisherRun, '--repo', $repo,
        '--json', 'name,status,conclusion,url'
    )) | ConvertFrom-Json -Depth 15
    $registry = Invoke-ReadOnly 'docker' @('buildx', 'imagetools', 'inspect', $contract.candidate)
    $match = [regex]::Match($registry, '(?m)^Digest:\s*(sha256:[a-f0-9]{64})\s*$')
    if (-not $match.Success) { throw 'PREFLIGHT_BLOCKED: registry index digest unavailable' }
    return [pscustomobject]@{
        releaseRefSha = $branchSha; mainSha = $mainSha
        comparison = $compare
        runs = @($runs)
        publisher = $publisher
        registry = [pscustomobject]@{
            digest = $match.Groups[1].Value
            amd64 = $registry.Contains('linux/amd64')
        }
        localImage = Get-LocalCandidateIdentity
        production = Get-ContainerSnapshot 'babytracker-sprout'
        preview = Get-ContainerSnapshot 'babytracker-ocr-staging'
    }
}
function Assert-Mounts($container, [hashtable]$expected, [string]$description) {
    $mounts = @($container.mounts)
    if ($mounts.Count -ne $expected.Count) {
        throw "PREFLIGHT_BLOCKED: $description mount count changed"
    }
    $seen = @{}
    foreach ($mount in $mounts) {
        $destination = [string]$mount.Destination
        if ($seen.ContainsKey($destination) -or
            -not $expected.ContainsKey($destination) -or
            [string]$mount.Type -cne 'volume' -or
            [string]$mount.Name -cne $expected[$destination]) {
            throw "PREFLIGHT_BLOCKED: $description volume identity changed"
        }
        $seen[$destination] = $true
    }
}
function Assert-ReleasePlan($snapshot) {
    Assert-MatchValue $snapshot.releaseRefSha $contract.releaseSha 'release ref'
    if ([string]$snapshot.mainSha -notmatch '^[a-f0-9]{40}$' -or
        [string]$snapshot.mainSha -ceq $contract.releaseSha) {
        throw 'PREFLIGHT_BLOCKED: canonical main / maintenance ref separation invalid'
    }
    if ([int]$snapshot.comparison.ahead_by -ne 2 -or
        [int]$snapshot.comparison.behind_by -ne 0 -or
        [string]$snapshot.comparison.status -cne 'ahead') {
        throw 'PREFLIGHT_BLOCKED: unexpected historical release difference'
    }
    $paths = @($snapshot.comparison.files | ForEach-Object { [string]$_.filename } | Sort-Object)
    $allowed = @('application/app/api/feedback/file/[id]/route.ts', 'application/tests/feedbackFileIsolationBackport.test.ts') | Sort-Object
    if ($paths.Count -ne 2 -or $paths[0] -cne $allowed[0] -or $paths[1] -cne $allowed[1]) {
        throw 'PREFLIGHT_BLOCKED: diff contains non-hotfix files'
    }
    foreach ($workflow in @('BabyTracker acceptance', 'BabyTracker operations contracts')) {
        $latest = @($snapshot.runs | Where-Object { $_.name -ceq $workflow } |
            Sort-Object createdAt -Descending | Select-Object -First 1)
        if ($latest.Count -ne 1 -or
            [string]$latest[0].headSha -cne $contract.releaseSha -or
            [string]$latest[0].status -cne 'completed' -or
            [string]$latest[0].conclusion -cne 'success') {
            throw "PREFLIGHT_BLOCKED: exact-release $workflow gate missing or failed"
        }
    }
    Assert-MatchValue $snapshot.publisher.name 'Publish pinned feedback-attachment security hotfix' 'publisher identity'
    Assert-MatchValue $snapshot.publisher.status 'completed' 'publisher status'
    Assert-MatchValue $snapshot.publisher.conclusion 'success' 'publisher conclusion'
    Assert-MatchValue $snapshot.registry.digest ($contract.candidate.Split('@')[1]) 'GHCR immutable digest'
    if ($snapshot.registry.amd64 -cne $true) {
        throw 'PREFLIGHT_BLOCKED: linux/amd64 platform missing'
    }
    $local = $snapshot.localImage
    Assert-MatchValue $local.imageId ($contract.candidate.Split('@')[1]) 'local pinned image ID'
    Assert-MatchValue $local.labels.'org.opencontainers.image.revision' $contract.releaseSha 'local image source revision'
    Assert-MatchValue $local.labels.'io.mtech.hotfix.base-revision' $contract.baselineSha 'hotfix production baseline label'
    Assert-MatchValue $local.labels.'org.opencontainers.image.source.canonical' $contract.canonicalSource 'canonical source label'
    Assert-MatchValue $local.labels.'org.opencontainers.image.source' $contract.historicalSource 'original publisher source label'
    Assert-MatchValue $local.labels.'io.mtech.hotfix.scope' $contract.hotfixScope 'hotfix authorization scope'
    if (@($local.repoDigests) -cnotcontains $contract.candidate) {
        throw 'PREFLIGHT_BLOCKED: local image is not bound to the pinned GHCR repo digest'
    }
    $production = $snapshot.production
    $preview = $snapshot.preview
    foreach ($pair in @(@($production, '/babytracker-sprout', $contract.productionStart),
                        @($preview, '/babytracker-ocr-staging', $contract.previewStart))) {
        $item = $pair[0]
        Assert-MatchValue $item.name $pair[1] 'container name'
        Assert-MatchValue $item.imageId $contract.priorImage 'existing production/preview image'
        Assert-MatchValue $item.startedAt $pair[2] 'original container start time'
        Assert-MatchValue $item.health 'healthy' 'container health'
        if ($item.running -cne $true -or $item.paused -cne $false) {
            throw 'PREFLIGHT_BLOCKED: live container not running normally'
        }
    }
    Assert-Mounts $production @{
        '/db'='babytracker-sprout-db'
        '/app/env'='babytracker-sprout-env'
        '/app/Files'='babytracker-sprout-files'
    } 'production'
    Assert-Mounts $preview @{
        '/db'='babytracker-ocr-staging_staging-db'
        '/app/env'='babytracker-ocr-staging_staging-env'
        '/app/Files'='babytracker-ocr-staging_staging-files'
    } 'protected preview'
}
if ([bool]$Synthetic -ne [bool]$FixturePath) {
    throw 'PREFLIGHT_BLOCKED: -Synthetic requires -FixturePath (and fixture cannot be used in live mode)'
}
if ($Synthetic) {
    $snapshot = Get-Content -LiteralPath $FixturePath -Raw | ConvertFrom-Json -Depth 30
} else {
    $snapshot = Get-LiveSnapshot
}
Assert-ReleasePlan $snapshot
[pscustomobject][ordered]@{
    result = $(if ($Synthetic) { 'SYNTHETIC_ONLY_PASS' } else { 'LIVE_READ_ONLY_PREFLIGHT_PASS' })
    repo = $contract.repository
    releaseBranch = $contract.releaseBranch
    releaseSha = $contract.releaseSha
    imageDigest = $contract.candidate.Split('@')[1]
    localCandidateProvenanceVerified = $true
    originalProductionImage = $contract.priorImage
    productionHealthy = $true
    protectedPreviewHealthy = $true
    productionModified = $false
    previewModified = $false
    liveBackupPerformed = $false
    deploymentApproved = $false
    approvedForCutover = $false
} | ConvertTo-Json -Compress -Depth 6
