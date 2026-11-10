# Read public upstream releases and create non-duplicated GitHub review issues.
# Uses the existing GitHub CLI authentication on this PC. No Docker change is made.
$ErrorActionPreference = 'Stop'
$repo = 'MulattoTech/BabyTracker-Master'
$upstreams = @('Oak-and-Sprout/sprout-track','babybuddy/babybuddy')
$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$logs = Join-Path $root '.local'
New-Item -ItemType Directory -Force -Path $logs | Out-Null
$log = Join-Path $logs 'upstream-watch.log'
function Log([string]$message) {
    $line = ('{0}  {1}' -f (Get-Date -Format o), $message)
    Write-Output $line
    Add-Content -Path $log -Value $line
}
$existingRaw = & gh issue list -R $repo --state all --limit 500 --json title
if ($LASTEXITCODE -ne 0) { throw 'Unable to query BabyTracker GitHub issues' }
$existing = @($existingRaw | ConvertFrom-Json | ForEach-Object { $_.title })
foreach ($upstream in $upstreams) {
    try {
        $releaseRaw = & gh api "repos/$upstream/releases/latest" 2>$null
        if ($LASTEXITCODE -ne 0) {
            Log "WARN: Cannot read latest release for $upstream"
            continue
        }
        $release = $releaseRaw | ConvertFrom-Json
        $tag = [string]$release.tag_name
        if ([string]::IsNullOrWhiteSpace($tag)) { Log "WARN: No release tag for $upstream"; continue }
        $title = "[Upstream] $upstream $tag review"
        if ($existing -contains $title) { Log "UNCHANGED: $upstream $tag already tracked"; continue }
        $body = @"
New upstream release: https://github.com/$upstream/releases/tag/$tag

- [ ] Review changelog, security patches, migration and licensing changes
- [ ] Compare BabyTracker adapters/feature-parity requirements
- [ ] Take and verify production volume snapshot before any upgrade
- [ ] Qualify on isolated test instance; test phone/iPad, import/export and restore
- [ ] Promote pinned version only after all acceptance checks pass

**No automatic production update is authorized by this issue.**
"@
        $result = & gh issue create -R $repo --title $title --body $body
        if ($LASTEXITCODE -ne 0) { throw "Could not create issue $title" }
        Log "CREATED: $title -> $result"
        $existing += $title
    }
    catch {
        Log "ERROR checking $upstream : $($_.Exception.Message)"
    }
}
