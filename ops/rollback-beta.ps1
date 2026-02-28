param(
  [Parameter(Mandatory=$true)]
  [string]$Tag
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

Write-Host "[Rollback] Rolling back to $Tag" -ForegroundColor Yellow

git fetch --tags
git checkout $Tag

docker compose -f docker-compose.prod.yml up -d --build

docker compose -f docker-compose.prod.yml ps

Write-Host "[Rollback] Done. Verify app and API health manually." -ForegroundColor Green