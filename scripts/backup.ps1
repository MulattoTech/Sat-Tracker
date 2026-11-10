# Consistent offline snapshot of all three BabyTracker Docker volumes.
# CAUTION: contains encryption keys and private care data; keep archive private.
param(
    [string]$Destination = (Join-Path $PSScriptRoot '..\backups')
)
$ErrorActionPreference = 'Stop'
$project = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$Destination = [System.IO.Path]::GetFullPath($Destination)
New-Item -ItemType Directory -Path $Destination -Force | Out-Null
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$archive = "babytracker-snapshot-$stamp.tar.gz"
Push-Location $project
$running = $false
try {
    $services = @(& docker compose ps --status running --services)
    if ($LASTEXITCODE -ne 0) { throw 'Cannot determine BabyTracker state; backup cancelled before service or archive changes' }
    $running = $services -contains 'sprout'
    if ($running) {
        Write-Host 'Stopping only BabyTracker for a consistent SQLite snapshot...'
        & docker compose stop sprout
        if ($LASTEXITCODE -ne 0) { throw 'Failed to stop BabyTracker safely' }
    }
    $dockerArgs = @(
        'run', '--rm',
        '--mount', 'type=volume,source=babytracker-sprout-db,target=/snapshot/db,readonly',
        '--mount', 'type=volume,source=babytracker-sprout-env,target=/snapshot/env,readonly',
        '--mount', 'type=volume,source=babytracker-sprout-files,target=/snapshot/files,readonly',
        '--mount', "type=bind,source=$Destination,target=/backup",
        'alpine:3.21', 'sh', '-ec',
        "tar -czf /backup/$archive -C /snapshot db env files"
    )
    & docker @dockerArgs
    if ($LASTEXITCODE -ne 0) { throw 'Backup archiving failed' }
    $target = Join-Path $Destination $archive
    if (-not (Test-Path $target) -or (Get-Item $target).Length -lt 1024) {
        throw 'Backup not found or implausibly small'
    }
    Write-Host "BACKUP_OK=$target"
}
finally {
    if ($running) {
        Write-Host 'Restarting only BabyTracker...'
        & docker compose up -d sprout
    }
    Pop-Location
}
