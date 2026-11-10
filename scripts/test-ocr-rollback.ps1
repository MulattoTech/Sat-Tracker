#Requires -Version 7.0
[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [ValidatePattern('^sha256:[a-f0-9]{64}$')]
    [string]$RollbackImage
)
# Synthetic-only rollback rehearsal. Never mount or stop production resources.
$ErrorActionPreference = 'Stop'
$stage = 'babytracker-ocr-staging'
$stageProject = 'babytracker-ocr-staging'
$oldImage = $RollbackImage
$sourceVolumes = [ordered]@{ db='babytracker-ocr-staging_staging-db'; env='babytracker-ocr-staging_staging-env'; files='babytracker-ocr-staging_staging-files' }
$targets = @{ db='/db'; env='/app/env'; files='/app/Files' }
$id = [Guid]::NewGuid().ToString('N')
$prefix = "babytracker-ocr-rollback-$id"
$cloneVolumes = @{}
$createdVolumes = [System.Collections.Generic.List[string]]::new()
$createdContainers = [System.Collections.Generic.List[string]]::new()
$helperSource = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'verify-ocr-rollback.cjs') -Raw
$dockerExe = (Get-Command docker -ErrorAction Stop).Source
$paused = $false
$report = $null
$failure = $null
$cleanupErrors = [System.Collections.Generic.List[string]]::new()
$script:CurrentOperation = 'Preflight'

function Invoke-Docker {
    param([string[]]$DockerArguments, [string]$InputText, [int]$TimeoutSeconds = 120, [string]$Operation = 'docker')
    $script:CurrentOperation = $Operation
    $info = [System.Diagnostics.ProcessStartInfo]::new()
    $info.FileName = $dockerExe
    $info.UseShellExecute = $false
    $info.CreateNoWindow = $true
    $info.RedirectStandardOutput = $true
    $info.RedirectStandardError = $true
    $info.RedirectStandardInput = $true
    foreach ($argument in $DockerArguments) { [void]$info.ArgumentList.Add($argument) }
    $process = [System.Diagnostics.Process]::new()
    $process.StartInfo = $info
    try {
        if (-not $process.Start()) { throw "Could not start $Operation" }
        $stdout = $process.StandardOutput.ReadToEndAsync()
        $stderr = $process.StandardError.ReadToEndAsync()
        if ($InputText) { $process.StandardInput.Write($InputText) }
        $process.StandardInput.Close()
        if (-not $process.WaitForExit($TimeoutSeconds * 1000)) {
            $process.Kill()
            throw "$Operation exceeded its bounded timeout"
        }
        $out = $stdout.GetAwaiter().GetResult()
        [void]$stderr.GetAwaiter().GetResult() # Capture normal native stderr without printing secrets or triggering PS NativeCommandError.
        if ($process.ExitCode -ne 0) {
            if ($out.Trim() -match '^\{"passed":false,"error":"([A-Z0-9_]+)"\}$') { $script:CurrentOperation = "$Operation [$($Matches[1])]" }
            throw "$Operation failed (exit $($process.ExitCode)); no private output was printed"
        }
        return $out.Trim()
    } finally { $process.Dispose() }
}

function Get-Container([string]$Name) {
    $items = @(Invoke-Docker -DockerArguments @('inspect', '--type', 'container', $Name) -Operation 'Container identity inspection' | ConvertFrom-Json)
    if ($items.Count -ne 1) { throw 'Container identity is ambiguous' }
    return $items[0]
}

function Assert-Stage {
    $value = Get-Container $stage
    if ($value.Name -ne "/$stage" -or $value.Config.Labels.'com.docker.compose.project' -ne $stageProject -or
        $value.Config.Env -notcontains 'BABYTRACKER_SYNTHETIC_STAGING=true' -or -not $value.State.Running -or $value.State.Paused) {
        throw 'Refusing a container that is not the running, unpaused synthetic OCR stage'
    }
    if ($value.State.Health.Status -ne 'healthy') { throw 'Synthetic OCR stage is not healthy' }
    if (@($value.Mounts).Count -ne 3) { throw 'Unexpected stage mounts' }
    foreach ($kind in $sourceVolumes.Keys) {
        $mount = @($value.Mounts | Where-Object { $_.Destination -eq $targets[$kind] })
        if ($mount.Count -ne 1 -or $mount[0].Type -ne 'volume' -or $mount[0].Name -ne $sourceVolumes[$kind]) { throw 'Stage volume allowlist check failed' }
    }
    return $value
}

function Invoke-Inspection([string]$Container, [string]$Mode) {
    $text = Invoke-Docker -DockerArguments @('exec', '-i', $Container, 'node', '-', $Mode) -InputText $helperSource -TimeoutSeconds 90 -Operation 'Synthetic fixture verification'
    $value = $text | ConvertFrom-Json
    if (-not $value.passed -or -not $value.syntheticOnly) { throw 'Synthetic fixture verification did not pass' }
    return $value
}

function Resume-Stage {
    $current = Get-Container $stageIdentity.Id
    if ($current.Id -ne $stageIdentity.Id -or $current.Name -ne "/$stage" -or $current.Config.Labels.'com.docker.compose.project' -ne $stageProject) { throw 'Original synthetic stage identity could not be reverified' }
    if ($current.State.Paused) { [void](Invoke-Docker -DockerArguments @('unpause', $stageIdentity.Id) -Operation 'Resume synthetic stage') }
    $current = Get-Container $stageIdentity.Id
    if (-not $current.State.Running -or $current.State.Paused) { throw 'Synthetic stage resume could not be verified' }
}

try {
    $stageIdentity = Assert-Stage
    $cachedOld = @(Invoke-Docker -DockerArguments @('image', 'inspect', $oldImage) -Operation 'Cached rollback image inspection' | ConvertFrom-Json)
    if ($cachedOld.Count -ne 1 -or $cachedOld[0].Id -ne $oldImage) { throw 'Immutable cached rollback image is unavailable' }
    [void](Invoke-Docker -DockerArguments @('image', 'inspect', 'alpine:3.21') -Operation 'Cached copy-helper image inspection')
    $before = Invoke-Inspection $stage 'inspect'
    foreach ($kind in $sourceVolumes.Keys) {
        $name = "$prefix-$kind"
        [void](Invoke-Docker -DockerArguments @('volume', 'create', '--label', "babytracker.rollback.id=$id", $name) -Operation 'Create isolated clone volume')
        $volume = @(Invoke-Docker -DockerArguments @('volume', 'inspect', $name) -Operation 'Verify clone ownership' | ConvertFrom-Json)[0]
        if ($volume.Name -ne $name -or $volume.Labels.'babytracker.rollback.id' -ne $id) { throw 'Clone ownership validation failed' }
        $createdVolumes.Add($name)
        $cloneVolumes[$kind] = $name
    }
    $copyName = "$prefix-copy"
    $copyArgs = @('run', '--rm', '--pull', 'never', '--name', $copyName, '--label', "babytracker.rollback.id=$id", '--network', 'none', '--cpus', '1', '--memory', '256m', '--pids-limit', '64')
    foreach ($kind in $sourceVolumes.Keys) {
        $copyArgs += @('--mount', "type=volume,source=$($sourceVolumes[$kind]),target=/from/$kind,readonly", '--mount', "type=volume,source=$($cloneVolumes[$kind]),target=/to/$kind")
    }
    $copyArgs += @('alpine:3.21', 'sh', '-euc', 'set -o pipefail; for item in db env files; do tar -C /from/$item -cf - . | tar -C /to/$item -xf -; done')
    $createdContainers.Add($copyName)
    try {
        # Recheck exact identity immediately before pausing. No production name is accepted.
        $current = Assert-Stage
        if ($current.Id -ne $stageIdentity.Id) { throw 'Stage container identity changed during preparation' }
        $paused = $true
        [void](Invoke-Docker -DockerArguments @('pause', $stageIdentity.Id) -Operation 'Pause only synthetic stage')
        [void](Invoke-Docker -DockerArguments $copyArgs -Operation 'Copy frozen synthetic volumes')
    } finally {
        if ($paused) {
            Resume-Stage
            $paused = $false
        }
    }

    $appName = "$prefix-app"
    $runArgs = @('run', '-d', '--pull', 'never', '--name', $appName, '--label', "babytracker.rollback.id=$id", '--network', 'none', '--cpus', '1', '--memory', '2g', '--pids-limit', '128',
        '--env', 'BABYTRACKER_SYNTHETIC_STAGING=true', '--env', 'ENABLE_NOTIFICATIONS=false', '--env', 'ENABLE_LOG=false', '--env', 'DATABASE_PROVIDER=sqlite')
    foreach ($kind in $sourceVolumes.Keys) { $runArgs += @('--mount', "type=volume,source=$($cloneVolumes[$kind]),target=$($targets[$kind])") }
    $runArgs += $oldImage
    $createdContainers.Add($appName)
    [void](Invoke-Docker -DockerArguments $runArgs -Operation 'Start isolated original-image rollback')
    $rollback = Get-Container $appName
    if ($rollback.Image -ne $oldImage -or $rollback.HostConfig.NetworkMode -ne 'none' -or @($rollback.Mounts).Count -ne 3 -or $rollback.Config.Labels.'babytracker.rollback.id' -ne $id) { throw 'Rollback isolation verification failed' }
    foreach ($kind in $sourceVolumes.Keys) {
        $mount = @($rollback.Mounts | Where-Object { $_.Destination -eq $targets[$kind] })
        if ($mount.Count -ne 1 -or $mount[0].Type -ne 'volume' -or $mount[0].Name -ne $cloneVolumes[$kind]) { throw 'Rollback container mounted an unexpected volume' }
    }
    $after = Invoke-Inspection $appName 'http'
    if ($after.canonicalDigest -ne $before.canonicalDigest -or $after.ocrDigest -ne $before.ocrDigest -or $after.ledgerDigest -ne $before.ledgerDigest -or $after.encryptedSourceDigest -ne $before.encryptedSourceDigest -or $after.ocrDocuments -ne $before.ocrDocuments -or $after.ocrAudits -ne $before.ocrAudits -or $after.ledgerRecords -ne 2 -or $after.encryptedSourceFiles -ne $before.encryptedSourceFiles) { throw 'Rollback changed canonical data, OCR history, import ledger, or encrypted source files' }
    $stageAfter = Invoke-Inspection $stage 'inspect'
    if ($stageAfter.canonicalDigest -ne $before.canonicalDigest -or $stageAfter.ocrDigest -ne $before.ocrDigest -or $stageAfter.ledgerDigest -ne $before.ledgerDigest -or $stageAfter.encryptedSourceDigest -ne $before.encryptedSourceDigest) { throw 'Synthetic stage changed during the drill' }
    $report = [ordered]@{ passed=$true; syntheticOnly=$true; candidateImage=$stageIdentity.Image; rollbackImage=$oldImage; originalImageStarted=$true; isolatedNetwork=$true; ordinaryTimelineVerified=$after.ordinaryTimelineVerified; canonicalEvents=2; canonicalDigest=$after.canonicalDigest; ocrTablesPreserved=$true; ocrDigest=$after.ocrDigest; importLedgerPreserved=$true; ledgerRecords=$after.ledgerRecords; ledgerDigest=$after.ledgerDigest; encryptedSourcesPreserved=$true; encryptedSourceFiles=$after.encryptedSourceFiles; encryptedSourceDigest=$after.encryptedSourceDigest; stageResumed=$true }
} catch {
    $failure = "Synthetic rollback drill failed during: $script:CurrentOperation"
} finally {
    if ($paused) {
        try { Resume-Stage; $paused=$false }
        catch { $cleanupErrors.Add('Synthetic stage resume could not be verified') }
    }
    foreach ($name in $createdContainers) {
        try {
            $matches = Invoke-Docker -DockerArguments @('ps', '-a', '--filter', "name=^/$name`$", '--format', '{{.Names}}') -Operation 'Locate owned temporary container'
            if ($matches -eq $name) {
                $owned = Get-Container $name
                if ($owned.Config.Labels.'babytracker.rollback.id' -ne $id) { throw 'Temporary container owner changed' }
                [void](Invoke-Docker -DockerArguments @('rm', '-f', $owned.Id) -Operation 'Remove owned temporary container')
            }
        } catch { $cleanupErrors.Add("Temporary container cleanup unverified: $name") }
    }
    foreach ($name in $createdVolumes) {
        try {
            $owned = @(Invoke-Docker -DockerArguments @('volume', 'inspect', $name) -Operation 'Recheck temporary volume owner' | ConvertFrom-Json)[0]
            if ($owned.Labels.'babytracker.rollback.id' -ne $id) { throw 'Temporary volume owner changed' }
            [void](Invoke-Docker -DockerArguments @('volume', 'rm', $name) -Operation 'Remove owned temporary volume')
        } catch { $cleanupErrors.Add("Temporary volume cleanup unverified: $name") }
    }
}
if ($failure -or $cleanupErrors.Count) {
    [ordered]@{ passed=$false; syntheticOnly=$true; error=$failure; cleanupErrors=@($cleanupErrors); stageResumeUnverified=$paused } | ConvertTo-Json -Compress
    exit 1
}
$report.cleanupVerified = $true
$report | ConvertTo-Json -Compress
