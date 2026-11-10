<# Owner-invoked promotion. Apply requires record preservation. Exact-main CI -> pinned image -> synthetic preview -> verified backup -> preserved production records. #>
[CmdletBinding()]
param([switch]$Apply,[switch]$Build,[string]$Image,[switch]$VerifyDataPreservation)
$ErrorActionPreference='Stop'
if ($Apply -and -not $VerifyDataPreservation) {
  throw 'Production promotion requires -VerifyDataPreservation; no inspection or mutation was performed'
}
$root=(Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$repo='MulattoTech/BabyTracker-Master'
$expectedVolumes=@('babytracker-sprout-db','babytracker-sprout-env','babytracker-sprout-files')
Push-Location $root
$oldImageEnv=$env:BABYTRACKER_IMAGE
$oldPreviewEnv=$env:BABYTRACKER_STAGING_IMAGE
try {
  $revision=(& git rev-parse HEAD).Trim()
  if($LASTEXITCODE -ne 0 -or $revision -notmatch '^[0-9a-f]{40}$'){throw 'Cannot determine exact Git revision'}
  if(@(& git status --porcelain).Count -gt 0){throw 'Promotion requires a clean checkout; never discard agent work'}
  $branch=(& git branch --show-current).Trim()
  if($branch -ne 'main'){throw 'Promote from main, not a worker branch'}
  $main=(& gh api "repos/$repo/commits/main" --jq .sha).Trim()
  if($LASTEXITCODE -ne 0 -or $main -ne $revision){throw 'Local checkout does not equal current GitHub main'}
  $runsRaw=& gh api "repos/$repo/actions/workflows/babytracker-ci.yml/runs?head_sha=$revision&branch=main&per_page=20"
  if($LASTEXITCODE -ne 0){throw 'Cannot verify acceptance workflow'}
  $runs=$runsRaw|ConvertFrom-Json
  $latest=@($runs.workflow_runs|Where-Object {$_.head_sha -eq $revision -and $_.head_branch -eq 'main'}|Sort-Object created_at -Descending|Select-Object -First 1)
  if($latest.Count -ne 1 -or $latest[0].status -ne 'completed' -or $latest[0].conclusion -ne 'success'){throw 'Latest acceptance run for this exact main commit must pass'}
  $opsRaw=& gh api "repos/$repo/actions/workflows/ops-contracts.yml/runs?head_sha=$revision&branch=main&per_page=20"
  if($LASTEXITCODE -ne 0){throw 'Cannot verify operations contracts'}
  $ops=@(($opsRaw|ConvertFrom-Json).workflow_runs|Where-Object {$_.head_sha -eq $revision -and $_.head_branch -eq 'main'}|Sort-Object created_at -Descending|Select-Object -First 1)
  if($ops.Count -ne 1 -or $ops[0].status -ne 'completed' -or $ops[0].conclusion -ne 'success'){throw 'Latest operations contracts for this exact main commit must pass'}
  & docker compose config --quiet
  if($LASTEXITCODE -ne 0){throw 'Compose validation failed'}
  $live=(& docker inspect babytracker-sprout|ConvertFrom-Json)[0]
  if($LASTEXITCODE -ne 0 -or $live.State.Health.Status -ne 'healthy'){throw 'Production must be healthy before promotion'}
  $actual=@($live.Mounts|ForEach-Object {$_.Name}|Sort-Object)
  if(Compare-Object $expectedVolumes $actual){throw 'Production volume contract mismatch'}
  if(!$Image){$Image='babytracker:git-'+$revision.Substring(0,12)}
  if($Image -notmatch '^[A-Za-z0-9][A-Za-z0-9._/@:-]{1,250}$'){throw 'Invalid image reference'}
  if(!$Apply){Write-Output "PROMOTION_PLAN_ONLY sha=$revision image=$Image acceptedRun=$($latest[0].id) productionChanged=false preservationRequested=$([bool]$VerifyDataPreservation)";return}
  $receiptDir=Join-Path $root '.local/releases'
  New-Item -ItemType Directory -Force $receiptDir|Out-Null
  $lock=Join-Path $root '.local/maintenance.lock'
  $lockStream=[IO.File]::Open($lock,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
  try {
    if($Build){
      # Build a frozen Git export, never a concurrently edited agent checkout.
      $buildRoot=Join-Path $receiptDir ('build-'+[Guid]::NewGuid().ToString('N'))
      New-Item -ItemType Directory $buildRoot|Out-Null
      $archive=Join-Path $buildRoot 'source.tar';$context=Join-Path $buildRoot 'context'
      New-Item -ItemType Directory $context|Out-Null
      & git archive --format=tar --output $archive $revision application
      if($LASTEXITCODE -ne 0){throw 'Cannot export exact accepted source'}
      & tar -xf $archive -C $context --strip-components 1
      if($LASTEXITCODE -ne 0){throw 'Cannot extract accepted source'}
      & docker build --label "org.opencontainers.image.source=https://github.com/$repo" --label "org.opencontainers.image.revision=$revision" -t $Image $context
      if($LASTEXITCODE -ne 0){throw 'Image build failed; production unchanged'}
    }
    $candidate=(& docker image inspect $Image|ConvertFrom-Json)[0]
    if($LASTEXITCODE -ne 0 -or $candidate.Config.Labels.'org.opencontainers.image.source' -ne "https://github.com/$repo" -or $candidate.Config.Labels.'org.opencontainers.image.revision' -ne $revision){throw 'Image does not match accepted source revision'}
    $env:BABYTRACKER_STAGING_IMAGE=$candidate.Id
    & docker compose -f application/compose.ocr-staging.yml up -d --no-build --pull never --wait --wait-timeout 180 app
    if($LASTEXITCODE -ne 0){throw 'Preview failed health gate; production unchanged'}
    $stage=(& docker inspect babytracker-ocr-staging|ConvertFrom-Json)[0]
    if(@($stage.Mounts|Where-Object {$expectedVolumes -contains $_.Name}).Count -gt 0){throw 'Preview is incorrectly mounted to production data'}
    if($stage.Image -ne $candidate.Id){throw 'Preview image identity mismatch'}
    & docker exec babytracker-ocr-staging node /app/scripts/ocr-staging-check.mjs
    if($LASTEXITCODE -ne 0){throw 'Synthetic OCR acceptance failed; production unchanged'}
    # The existing deployment helper snapshots all volumes and verifies restoration.
    # Never roll back a migrated live database automatically: post-deploy writes could be lost.
    $env:BABYTRACKER_IMAGE=$null
    $preservationDirectory = $null
    if ($VerifyDataPreservation) {
      $preservationDirectory = Join-Path $receiptDir ('preservation-' + [Guid]::NewGuid().ToString('N'))
    }
    & (Join-Path $PSScriptRoot 'update-babytracker.ps1') -Image $candidate.Id -VerifyDataPreservation:$VerifyDataPreservation -PreservationEvidenceDirectory $preservationDirectory
    if(!$?){throw 'Production health gate failed; preserve backups and investigate migration compatibility before rollback'}
    $after=(& docker inspect babytracker-sprout|ConvertFrom-Json)[0]
    if($after.Image -ne $candidate.Id -or $after.State.Health.Status -ne 'healthy'){throw 'Production revision not verified'}
    if(Compare-Object $expectedVolumes @($after.Mounts|ForEach-Object {$_.Name}|Sort-Object)){throw 'Post-deploy volume contract mismatch'}
    $preservation = $null
    if ($VerifyDataPreservation) {
      $preservation = Get-Content -LiteralPath (Join-Path $preservationDirectory 'preservation.json') -Raw | ConvertFrom-Json
      if ($preservation.status -cne 'PASS' -or $preservation.revision -cne $revision -or
          $preservation.imageId -cne $candidate.Id -or $preservation.previousImageId -cne $live.Image -or
          -not $preservation.allBaselineRowsPreserved -or $preservation.baselineManifestSha256 -notmatch '^[a-f0-9]{64}$') {
        throw 'Current promotion has no valid preservation evidence; production success is not verified'
      }
    }
    $receipt=@{repository=$repo;revision=$revision;imageId=$candidate.Id;previousImageId=$live.Image;acceptanceRun=$latest[0].html_url;deployedAt=(Get-Date).ToUniversalTime().ToString('o');production='https://tracker.m-techlabs.com';preview='https://tracker-preview.m-techlabs.com';dataVolumesPreserved=$true}
    $receipt.preservationStatus = if ($VerifyDataPreservation) { 'PASS' } else { 'NOT_REQUESTED' }
    if ($preservation) {
      $receipt.preservationBaselineSha256 = $preservation.baselineManifestSha256
      $receipt.preservationEvidence = Join-Path $preservationDirectory 'preservation.json'
      $receipt.preservationCoverage = $preservation.coverage
    }
    $receipt|ConvertTo-Json -Depth 5|Set-Content (Join-Path $receiptDir 'deployed.json') -Encoding utf8
    Write-Output "PROMOTION_VERIFIED sha=$revision imageId=$($candidate.Id)"
  }finally{$lockStream.Dispose();Remove-Item -LiteralPath $lock -ErrorAction SilentlyContinue}
}finally{$env:BABYTRACKER_IMAGE=$oldImageEnv;$env:BABYTRACKER_STAGING_IMAGE=$oldPreviewEnv;Pop-Location}
