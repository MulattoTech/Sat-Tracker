# Restore a recent snapshot to TEMPORARY named volumes, then verify both SQLite files.
# Production app and its three data volumes are never touched.
$ErrorActionPreference = 'Stop'
$verificationImage = (& docker inspect babytracker-sprout --format '{{.Config.Image}}').Trim()
if ($LASTEXITCODE -ne 0 -or -not $verificationImage) { throw 'Cannot identify the deployed image for a compatible restore verification' }
$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$archive = Get-ChildItem (Join-Path $root 'backups') -Filter 'babytracker-snapshot-*.tar.gz' | Sort-Object LastWriteTime -Descending | Select-Object -First 1
if (-not $archive) { throw 'No backups available; run backup.ps1 first' }
$id = [Guid]::NewGuid().ToString('N').Substring(0,8)
$dbName = "babytracker-restore-$id-db"
$envName = "babytracker-restore-$id-env"
$fileName = "babytracker-restore-$id-files"
$created = @()
try {
    foreach ($name in @($dbName,$envName,$fileName)) {
        & docker volume create $name | Out-Null
        if ($LASTEXITCODE -ne 0) { throw "Could not create $name" }
        $created += $name
    }
    $mounts = @(
      '--mount', "type=volume,source=$dbName,target=/restore/db",
      '--mount', "type=volume,source=$envName,target=/restore/env",
      '--mount', "type=volume,source=$fileName,target=/restore/files"
    )
    & docker run --rm @mounts --mount "type=bind,source=$($archive.DirectoryName),target=/backup,readonly" alpine:3.21 sh -ec "tar -xzf /backup/$($archive.Name) -C /restore"
    if ($LASTEXITCODE -ne 0) { throw 'Restore extraction failed' }
    $scriptPath = (Resolve-Path (Join-Path $PSScriptRoot 'verify-sqlite-backup.js')).Path
    & docker run --rm --entrypoint node @(
      '--mount',"type=volume,source=$dbName,target=/restore/db,readonly",
      '--mount',"type=volume,source=$envName,target=/restore/env,readonly",
      '--mount',"type=bind,source=$scriptPath,target=/app/verify-sqlite-backup.js,readonly"
    ) $verificationImage /app/verify-sqlite-backup.js
    if ($LASTEXITCODE -ne 0) { throw 'SQLite or configuration verification failed' }
    Write-Host "RESTORE_DRILL_PASS=$($archive.Name)"
}
finally {
    foreach ($name in $created) { & docker volume rm $name | Out-Null }
}
