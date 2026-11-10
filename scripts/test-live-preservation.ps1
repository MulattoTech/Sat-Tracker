#Requires -Version 7.0
<#
Read-only production data verification through docker exec in the EXISTING app.
No stop/restart/pause, HTTP request, Docker run, or new live-volume mount occurs.
Capture writes only a private temporary hash manifest, copies it to the supplied
private host path, and removes its own temporary files. Verify streams that exact
manifest on stdin; it is never placed on a command line or printed.
BaselineSha256 is mandatory in Verify mode and must come from the capture receipt.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory)][ValidateSet('Capture', 'Verify')][string]$Mode,
    [Parameter(Mandatory)][ValidatePattern('^sha256:[a-f0-9]{64}$')][string]$ExpectedImage,
    [Parameter(Mandatory)][string]$BaselineFile,
    [ValidatePattern('^[a-f0-9]{64}$')][string]$BaselineSha256,
    [string]$Helper = (Join-Path $PSScriptRoot 'verify-live-preservation.cjs')
)
$ErrorActionPreference = 'Stop'
$runId = [Guid]::NewGuid().ToString('N')
$temporaryHelper = "/tmp/sat-tracker-preservation-$runId.cjs"
$temporaryBaseline = "/tmp/sat-tracker-preservation-$runId.json"
$containerId = $null
$helperCopied = $false
$script:Phase = 'preflight'
$receipt = [ordered]@{ version=1; status='FAIL'; operation=$Mode; runId=$runId; expectedImage=$ExpectedImage; existingContainerOnly=$true; readOnlyDatabaseAccess=$true; noDowntimeRequested=$true; plaintextRowsEmitted=$false; startedAt=[DateTime]::UtcNow.ToString('o') }

function Get-PrivateSha256([string]$Path) {
    $stream = [IO.File]::OpenRead($Path)
    $digest = [Security.Cryptography.SHA256]::Create()
    try { return [BitConverter]::ToString($digest.ComputeHash($stream)).Replace('-', '').ToLowerInvariant() }
    finally { $digest.Dispose(); $stream.Dispose() }
}

function Invoke-Docker {
    param([string[]]$DockerArguments, [string]$InputFile, [int]$TimeoutSeconds = 30, [switch]$AllowFailure)
    $info = [Diagnostics.ProcessStartInfo]::new()
    $info.FileName = $script:DockerExecutable
    $info.UseShellExecute=$false; $info.CreateNoWindow=$true
    $info.RedirectStandardOutput=$true; $info.RedirectStandardError=$true; $info.RedirectStandardInput=$true
    foreach ($argument in $DockerArguments) { [void]$info.ArgumentList.Add($argument) }
    $process = [Diagnostics.Process]::new(); $process.StartInfo=$info
    $inputStream = $null
    try {
        if (-not $process.Start()) { throw 'DOCKER_PROCESS_START_FAILED' }
        $stdout=$process.StandardOutput.ReadToEndAsync(); $stderr=$process.StandardError.ReadToEndAsync()
        if ($InputFile) {
            $inputStream = [IO.File]::OpenRead($InputFile)
            if (-not $inputStream.CopyToAsync($process.StandardInput.BaseStream).Wait(30000)) { throw 'PRIVATE_BASELINE_INPUT_TIMEOUT' }
        }
        $process.StandardInput.Close()
        if (-not $process.WaitForExit($TimeoutSeconds * 1000)) { throw 'DOCKER_COMMAND_TIMEOUT' }
        $output=$stdout.GetAwaiter().GetResult()
        [void]$stderr.GetAwaiter().GetResult() # Never emit a native error/stack/record.
        if ($output.Length -gt 64KB) { throw 'BOUNDED_REPORT_LIMIT_EXCEEDED' }
        if ($process.ExitCode -ne 0 -and -not $AllowFailure) { throw 'DOCKER_COMMAND_FAILED' }
        return [pscustomobject]@{ ExitCode=$process.ExitCode; Output=$output.Trim() }
    } finally {
        if ($inputStream) { $inputStream.Dispose() }
        try { if (-not $process.HasExited) { $process.Kill($true); [void]$process.WaitForExit(5000) } } catch {}
        $process.Dispose()
    }
}

function Get-VerifiedLiveContainer([string]$Identity) {
    $raw = Invoke-Docker -DockerArguments @('inspect', '--type', 'container', $Identity)
    $values = @($raw.Output | ConvertFrom-Json)
    if ($values.Count -ne 1) { throw 'LIVE_CONTAINER_IDENTITY_AMBIGUOUS' }
    $container=$values[0]
    if ($container.Name -cne '/babytracker-sprout' -or $container.Image -cne $ExpectedImage -or
        -not $container.State.Running -or $container.State.Paused) { throw 'EXPECTED_LIVE_CONTAINER_REQUIRED' }
    $expected = @{ '/db'='babytracker-sprout-db'; '/app/env'='babytracker-sprout-env'; '/app/Files'='babytracker-sprout-files' }
    if (@($container.Mounts).Count -ne 3) { throw 'PRODUCTION_VOLUME_CONTRACT_FAILED' }
    foreach ($mount in $container.Mounts) {
        if ($mount.Type -cne 'volume' -or -not $expected.ContainsKey($mount.Destination) -or
            $mount.Name -cne $expected[$mount.Destination]) { throw 'PRODUCTION_VOLUME_CONTRACT_FAILED' }
    }
    return $container
}

try {
    $script:DockerExecutable = (Get-Command docker -ErrorAction Stop).Source
    $baselinePath = [IO.Path]::GetFullPath($BaselineFile)
    if ([IO.Path]::GetFileName($baselinePath) -notmatch '^live-preservation-baseline(?:-[a-f0-9]{32})?\.json$') { throw 'PRIVATE_BASELINE_FILENAME_REQUIRED' }
    $evidenceDirectory = [IO.Path]::GetDirectoryName($baselinePath)
    if (-not (Test-Path -LiteralPath $evidenceDirectory -PathType Container)) { throw 'PRIVATE_EVIDENCE_DIRECTORY_REQUIRED' }
    $helperItem = Get-Item -LiteralPath $Helper
    if ($helperItem.PSIsContainer -or ($helperItem.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'HELPER_FILE_REFUSED' }
    $receipt.helperSha256 = Get-PrivateSha256 $helperItem.FullName
    if ($Mode -eq 'Capture') {
        if (Test-Path -LiteralPath $baselinePath) { throw 'BASELINE_ALREADY_EXISTS' }
    } else {
        if (-not $BaselineSha256) { throw 'CAPTURE_RECEIPT_BASELINE_HASH_REQUIRED' }
        $baseline = Get-Item -LiteralPath $baselinePath
        if ($baseline.PSIsContainer -or $baseline.Length -gt 64MB -or ($baseline.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'BASELINE_FILE_REFUSED' }
        if ((Get-PrivateSha256 $baselinePath) -cne $BaselineSha256) { throw 'BASELINE_DOES_NOT_MATCH_CAPTURE_RECEIPT' }
    }
    $container = Get-VerifiedLiveContainer 'babytracker-sprout'
    $containerId = $container.Id
    if ($containerId -notmatch '^[a-f0-9]{64}$') { throw 'LIVE_CONTAINER_ID_INVALID' }

    $script:Phase='copy-private-helper'
    # Register for cleanup before cp: a timed-out CLI might have completed it.
    $helperCopied=$true
    [void](Invoke-Docker -DockerArguments @('cp', $helperItem.FullName, [string]::Concat($containerId, ':', $temporaryHelper)))

    $script:Phase='read-only-database-snapshots'
    $helperMode = if ($Mode -eq 'Capture') { 'capture-live' } else { 'verify-live' }
    $arguments = @('exec', '-i', '--env', 'SAT_TRACKER_READONLY_LIVE_QA=true', '--env', "SAT_TRACKER_QA_IMAGE_ID=$ExpectedImage", '--env', "SAT_TRACKER_QA_RUN_ID=$runId", $containerId,
        'timeout', '-s', 'KILL', '90', 'node', '--max-old-space-size=256', $temporaryHelper, $helperMode)
    $inputPath = if ($Mode -eq 'Verify') { $baselinePath } else { $null }
    $raw = Invoke-Docker -DockerArguments $arguments -InputFile $inputPath -TimeoutSeconds 100 -AllowFailure
    try { $result = $raw.Output | ConvertFrom-Json } catch { throw 'BOUNDED_HELPER_REPORT_INVALID' }
    if ($result.mode -cne $helperMode -or -not $result.readOnlyDatabaseAccess -or $result.plaintextRowsEmitted) { throw 'HELPER_REPORT_CONTRACT_FAILED' }
    # The reviewed helper emits only bounded aliases, counts, hashes and codes.
    $receipt.verification = $result
    if ($raw.ExitCode -ne 0 -or $result.status -cne 'PASS') { throw 'READ_ONLY_PRESERVATION_CHECK_FAILED' }
    if ($Mode -eq 'Capture') {
        if ($result.baselineFile -cne $temporaryBaseline -or $result.baselineManifestSha256 -notmatch '^[a-f0-9]{64}$') { throw 'CAPTURE_OUTPUT_PATH_REFUSED' }
        $script:Phase='copy-private-hash-manifest'
        [void](Invoke-Docker -DockerArguments @('cp', [string]::Concat($containerId, ':', $temporaryBaseline), $baselinePath))
        if ((Get-PrivateSha256 $baselinePath) -cne $result.baselineManifestSha256) { throw 'COPIED_BASELINE_DIGEST_MISMATCH' }
    } else {
        if ($result.baselineManifestSha256 -cne $BaselineSha256 -or (Get-PrivateSha256 $baselinePath) -cne $BaselineSha256) { throw 'BASELINE_CHANGED_DURING_VERIFICATION' }
        if (-not $result.allBaselineRowsPreserved) { throw 'OLD_ROW_PRESERVATION_NOT_PROVEN' }
    }
    $script:Phase='verify-live-identity-unchanged'
    $after = Get-VerifiedLiveContainer $containerId
    if ($after.Id -cne $containerId) { throw 'LIVE_IDENTITY_CHANGED_DURING_CHECK' }
    if ((Get-PrivateSha256 $helperItem.FullName) -cne $receipt.helperSha256) { throw 'HELPER_SOURCE_CHANGED' }
    $receipt.liveIdentityUnchanged=$true
    $receipt.baselineManifestSha256=$result.baselineManifestSha256
    $receipt.status='PASS'
} catch {
    $receipt.status='FAIL'; $receipt.failedPhase=$script:Phase
    $message=$_.Exception.Message
    $receipt.error=if ($message -match '^[A-Z0-9_]{1,100}$') { $message } else { 'NATIVE_FAILURE_SUPPRESSED' }
} finally {
    $receipt.temporaryFilesRemoved=$false
    if ($helperCopied -and $containerId) {
        try {
            $cleanup = 'const fs=require("node:fs"); const paths=process.argv.slice(1); if(paths.some(p=>!/^\/tmp\/sat-tracker-preservation-[a-f0-9]{32}\.(cjs|json)$/.test(p)))process.exit(2); for(const p of paths){try{fs.unlinkSync(p)}catch(e){if(e.code!=="ENOENT")process.exit(3)}}'
            [void](Invoke-Docker -DockerArguments @('exec', $containerId, 'node', '-e', $cleanup, $temporaryHelper, $temporaryBaseline))
            $receipt.temporaryFilesRemoved=$true
        } catch { $receipt.status='FAIL'; $receipt.cleanupError='OWN_TEMPORARY_FILE_CLEANUP_UNVERIFIED' }
    } elseif (-not $helperCopied) { $receipt.temporaryFilesRemoved=$true }
}
$receipt.completedAt=[DateTime]::UtcNow.ToString('o')
if ($evidenceDirectory -and (Test-Path -LiteralPath $evidenceDirectory -PathType Container)) {
    try {
        $receiptFile = Join-Path $evidenceDirectory ("live-preservation-$($Mode.ToLowerInvariant())-$runId.json")
        $receipt | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath $receiptFile -Encoding utf8NoBOM
    } catch { $receipt.status='FAIL'; $receipt.evidenceWriteError='RECEIPT_WRITE_FAILED' }
}
$receipt | ConvertTo-Json -Depth 12 -Compress
if ($receipt.status -ne 'PASS') { exit 1 }
exit 0
