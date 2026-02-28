param(
  [string]$Tag = "",
  [switch]$NoBuild
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

Write-Host "[Deploy] Starting beta deploy..." -ForegroundColor Cyan

if ($Tag) {
  Write-Host "[Deploy] Checking out tag $Tag" -ForegroundColor Cyan
  git fetch --tags
  git checkout $Tag
}

Write-Host "[Deploy] Preflight: frontend production build" -ForegroundColor Cyan
Push-Location "$root\frontend"
npm run build
Pop-Location

if (-not $NoBuild) {
  Write-Host "[Deploy] Building and starting prod stack" -ForegroundColor Cyan
  docker compose -f docker-compose.prod.yml up -d --build
} else {
  Write-Host "[Deploy] Starting prod stack (no build)" -ForegroundColor Cyan
  docker compose -f docker-compose.prod.yml up -d
}

Write-Host "[Deploy] Waiting for health checks..." -ForegroundColor Cyan
Start-Sleep -Seconds 8

docker compose -f docker-compose.prod.yml ps

$backendOk = $false
$frontendOk = $false

for ($i=0; $i -lt 20; $i++) {
  try { Invoke-WebRequest -UseBasicParsing -TimeoutSec 5 http://localhost:4000/health | Out-Null; $backendOk=$true } catch {}
  try { Invoke-WebRequest -UseBasicParsing -TimeoutSec 5 http://localhost:3000 | Out-Null; $frontendOk=$true } catch {}
  if ($backendOk -and $frontendOk) { break }
  Start-Sleep -Seconds 3
}

if (-not ($backendOk -and $frontendOk)) {
  Write-Host "[Deploy] Health checks failed. Run rollback script." -ForegroundColor Red
  exit 2
}

Write-Host "[Deploy] Beta deploy complete." -ForegroundColor Green