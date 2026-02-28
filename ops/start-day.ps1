param(
  [switch]$Rebuild,
  [ValidateSet('local','staging','production')]
  [string]$Env = 'local'
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

Write-Host "[FleetOps] Starting daily stack ($Env)..." -ForegroundColor Cyan

if ($Env -ne 'local') {
  Write-Host "[FleetOps] Applying $Env templates..." -ForegroundColor Cyan
  powershell -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'set-env.ps1') -Target $Env
}

# 1) Ensure Docker is reachable
try {
  docker info | Out-Null
} catch {
  Write-Host "[FleetOps] Docker engine is not running. Start Docker Desktop first." -ForegroundColor Red
  exit 1
}

# 2) Bring up services
if ($Rebuild) {
  docker compose up --build -d
} else {
  docker compose up -d
}

# 3) Health checks
function Wait-Url($url, $name, $maxSec = 90) {
  $start = Get-Date
  while (((Get-Date) - $start).TotalSeconds -lt $maxSec) {
    try {
      $r = Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 5
      if ($r.StatusCode -ge 200 -and $r.StatusCode -lt 500) {
        Write-Host "[FleetOps] $name OK ($url)" -ForegroundColor Green
        return $true
      }
    } catch {}
    Start-Sleep -Seconds 2
  }
  Write-Host "[FleetOps] $name failed health check: $url" -ForegroundColor Yellow
  return $false
}

$backendOk = Wait-Url "http://localhost:4000/health" "Backend"
$frontendOk = Wait-Url "http://localhost:3000" "Frontend"

# 4) Summary
Write-Host "`n[FleetOps] Containers:" -ForegroundColor Cyan
docker compose ps

if ($backendOk -and $frontendOk) {
  Write-Host "`n[FleetOps] Daily startup complete." -ForegroundColor Green
  Write-Host "Frontend: http://localhost:3000"
  Write-Host "Backend:  http://localhost:4000/health"
  exit 0
} else {
  Write-Host "`n[FleetOps] Startup completed with warnings. Check logs:" -ForegroundColor Yellow
  Write-Host "docker compose logs backend --tail=120"
  Write-Host "docker compose logs frontend --tail=120"
  exit 2
}
