# Deploy a clean canonical revision without resetting or deleting production data.
[CmdletBinding()]
param(
    [string]$Image, [switch]$Build, [switch]$ValidateOnly,
    [switch]$VerifyDataPreservation,
    [string]$PreservationEvidenceDirectory
)
$ErrorActionPreference = 'Stop'
$project = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path

function Get-ProductionContainer([string]$ExpectedImage) {
    $raw = & docker inspect babytracker-sprout 2>$null
    if ($LASTEXITCODE -ne 0) { throw 'Cannot inspect the production container' }
    $items = @($raw | ConvertFrom-Json)
    if ($items.Count -ne 1) { throw 'Production container identity is ambiguous' }
    $value = $items[0]
    if ($value.Name -cne '/babytracker-sprout' -or $value.Image -notmatch '^sha256:[a-f0-9]{64}$' -or
        -not $value.State.Running -or $value.State.Paused) { throw 'Expected running production container is unavailable' }
    if ($ExpectedImage -and $value.Image -cne $ExpectedImage) { throw 'Production image changed before the intended cutover' }
    $volumes = @{ '/db'='babytracker-sprout-db'; '/app/env'='babytracker-sprout-env'; '/app/Files'='babytracker-sprout-files' }
    if (@($value.Mounts).Count -ne 3) { throw 'Production volume contract mismatch' }
    foreach ($mount in $value.Mounts) {
        if ($mount.Type -cne 'volume' -or -not $volumes.ContainsKey($mount.Destination) -or
            $mount.Name -cne $volumes[$mount.Destination]) { throw 'Production volume contract mismatch' }
    }
    return $value
}
function Wait-PreviousStartup([string]$ExpectedImage) {
    $deadline = [DateTime]::UtcNow.AddSeconds(180)
    do {
        $value = Get-ProductionContainer $ExpectedImage
        if ($value.State.Health.Status -eq 'healthy') { return $value }
        Start-Sleep -Seconds 2
    } while ([DateTime]::UtcNow -lt $deadline)
    throw 'Restarted previous application did not become healthy; candidate cutover cancelled'
}

Push-Location $project
try {
    $revision = (& git rev-parse HEAD).Trim()
    if ($LASTEXITCODE -ne 0) { throw 'Git revision unavailable' }
    if (-not $Image) { $Image = 'babytracker:git-' + $revision.Substring(0,12) }
    if ($Image -notmatch '^[A-Za-z0-9][A-Za-z0-9._/:-]{1,199}$') { throw 'Invalid image reference' }
    & docker compose config --quiet
    if ($LASTEXITCODE -ne 0) { throw 'Invalid canonical Compose configuration' }
    if ($ValidateOnly) {
        Write-Output "VALIDATION_OK=$revision; image=$Image; no build, stop or mutation requested"
        return
    }
    if (@(& git status --porcelain).Count -gt 0) { throw 'Use a clean accepted checkout; preserve uncommitted work first' }
    if ($Build) {
        & docker build --label 'org.opencontainers.image.source=https://github.com/MulattoTech/BabyTracker-Master' --label "org.opencontainers.image.revision=$revision" -t $Image ./application
        if ($LASTEXITCODE -ne 0) { throw 'Canonical image build failed; production was not changed' }
    }
    $details = (& docker image inspect $Image | ConvertFrom-Json)[0]
    if ($LASTEXITCODE -ne 0 -or -not $details) { throw 'Image is not available locally; build it or explicitly pull the accepted image first' }
    if ($details.Config.Labels.'org.opencontainers.image.source' -ne 'https://github.com/MulattoTech/BabyTracker-Master' -or $details.Config.Labels.'org.opencontainers.image.revision' -ne $revision) {
        throw 'Image provenance must match this exact canonical checkout; no production change was made'
    }
    if ($VerifyDataPreservation) {
        if ($PSVersionTable.PSVersion.Major -lt 7) { throw 'Data preservation verification requires PowerShell 7' }
        $driverPath = Join-Path $PSScriptRoot 'test-live-preservation.ps1'
        if (-not (Test-Path -LiteralPath $driverPath -PathType Leaf) -or
            -not (Test-Path -LiteralPath (Join-Path $PSScriptRoot 'verify-live-preservation.cjs') -PathType Leaf)) {
            throw 'The fixed repository preservation driver is unavailable'
        }
        $previous = Get-ProductionContainer
        if ($previous.State.Health.Status -ne 'healthy') { throw 'Production must be healthy before the preservation check' }
        $privateRoot = [IO.Path]::GetFullPath((Join-Path $project '.local/releases'))
        $preservationDirectory = if ($PreservationEvidenceDirectory) {
            [IO.Path]::GetFullPath($PreservationEvidenceDirectory)
        } else { Join-Path $privateRoot ('preservation-' + [Guid]::NewGuid().ToString('N')) }
        if (-not $preservationDirectory.StartsWith($privateRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::Ordinal) -or
            (Test-Path -LiteralPath $preservationDirectory)) { throw 'Preservation evidence requires a new directory under .local/releases' }
    }
    & (Join-Path $PSScriptRoot 'backup.ps1')
    if (-not $?) { throw 'Backup failed; update cancelled' }
    & (Join-Path $PSScriptRoot 'test-restore.ps1')
    if (-not $?) { throw 'Restore verification failed; update cancelled' }
    $envPath = Join-Path $project '.env'
    if (-not (Test-Path $envPath)) { throw 'Missing local .env; existing configuration is required' }
    $old = Get-Content $envPath -Raw
    if ([regex]::Matches($old,'(?m)^BABYTRACKER_IMAGE=').Count -gt 1) { throw 'Duplicate image configuration' }
    if ($VerifyDataPreservation) {
        # backup.ps1 restarts the previous image. Its startup/seed must finish
        # before this baseline: old seed versions rewrite Unit.updatedAt.
        $captureSource = Wait-PreviousStartup $previous.Image
        [void](New-Item -ItemType Directory -Path $preservationDirectory)
        $baselinePath = Join-Path $preservationDirectory 'live-preservation-baseline.json'
        $global:LASTEXITCODE = 0
        $captureRaw = & $driverPath -Mode Capture -ExpectedImage $previous.Image -BaselineFile $baselinePath
        $captureSucceeded = $?
        if (-not $captureSucceeded -or $LASTEXITCODE -ne 0) { throw 'Pre-cutover preservation capture failed; candidate was not started' }
        $capture = $captureRaw | ConvertFrom-Json
        if ($capture.status -cne 'PASS' -or $capture.baselineManifestSha256 -notmatch '^[a-f0-9]{64}$' -or
            $capture.verification.mode -cne 'capture-live' -or $capture.verification.observedImageId -cne $previous.Image -or
            -not $capture.temporaryFilesRemoved) { throw 'Pre-cutover preservation receipt is invalid; candidate was not started' }
        $captureEnd = Get-ProductionContainer $previous.Image
        if ($captureEnd.Id -cne $captureSource.Id -or $captureEnd.State.StartedAt -cne $captureSource.State.StartedAt -or
            $captureEnd.State.Health.Status -ne 'healthy') { throw 'Previous application restarted during capture; candidate cutover cancelled' }
        # This is an online read snapshot. Writes after capture and before
        # compose stops the old app are outside its coverage; edits/deletes of
        # baseline rows still fail verification and require reconciliation.
    }
    Copy-Item $envPath (Join-Path $project ('backups/.env-before-update-' + (Get-Date -Format 'yyyyMMdd-HHmmss')))
    $line = 'BABYTRACKER_IMAGE=' + $Image
    $new = if ($old -match '(?m)^BABYTRACKER_IMAGE=') { [regex]::Replace($old,'(?m)^BABYTRACKER_IMAGE=.*$', $line) } else { $old.TrimEnd() + "`n" + $line + "`n" }
    [IO.File]::WriteAllText($envPath, $new, [Text.UTF8Encoding]::new($false))
    & docker compose up -d --no-build --pull never --wait --wait-timeout 180 sprout
    if ($LASTEXITCODE -ne 0) { throw 'Health gate failed. Preserve the snapshot and inspect before rollback; no volumes were deleted or restored automatically' }
    if ($VerifyDataPreservation) {
        $deployed = Get-ProductionContainer $details.Id
        if ($deployed.State.Health.Status -ne 'healthy') { throw 'Candidate is not healthy for preservation verification' }
        $global:LASTEXITCODE = 0
        $verificationRaw = & $driverPath -Mode Verify -ExpectedImage $details.Id -BaselineFile $baselinePath -BaselineSha256 $capture.baselineManifestSha256
        $verificationSucceeded = $?
        if (-not $verificationSucceeded -or $LASTEXITCODE -ne 0) {
            throw 'Post-deploy preservation failed; retain the candidate, backup and evidence for investigation; no automatic rollback was performed'
        }
        $verification = $verificationRaw | ConvertFrom-Json
        if ($verification.status -cne 'PASS' -or $verification.baselineManifestSha256 -cne $capture.baselineManifestSha256 -or
            $verification.verification.observedImageId -cne $details.Id -or -not $verification.verification.allBaselineRowsPreserved -or
            -not $verification.temporaryFilesRemoved) { throw 'Post-deploy preservation receipt is invalid; release success is not verified' }
        $preservation = [ordered]@{
            version=1; status='PASS'; revision=$revision; previousImageId=$previous.Image; imageId=$details.Id
            baselineManifestSha256=$capture.baselineManifestSha256
            allBaselineRowsPreserved=$true; excludedTables=@('_prisma_migrations')
            sqliteSequencePolicy=$verification.verification.sqliteSequencePolicy
            before=$capture.verification.databases; after=$verification.verification.databases
            baselineCreatedAt=$verification.verification.baselineCreatedAt
            coverage='Online snapshots after the previous image restart; writes after capture are outside the baseline. Missing or changed baseline rows are failures.'
            completedAt=[DateTime]::UtcNow.ToString('o')
        }
        $preservation | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath (Join-Path $preservationDirectory 'preservation.json') -Encoding utf8NoBOM
        Write-Output "DATA_PRESERVATION_VERIFIED baselineSha256=$($capture.baselineManifestSha256)"
    }
    Write-Output "UPDATE_OK=$revision; image=$Image; existing named volumes retained"
} finally { Pop-Location }
