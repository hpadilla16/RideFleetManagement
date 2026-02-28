param(
  [Parameter(Mandatory=$true)]
  [ValidateSet('staging','production')]
  [string]$Target
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot

$backendSrc = Join-Path $root "backend\.env.$Target.example"
$frontendSrc = Join-Path $root "frontend\.env.$Target.example"
$backendDst = Join-Path $root "backend\.env"
$frontendDst = Join-Path $root "frontend\.env.local"

if (!(Test-Path $backendSrc)) { throw "Missing $backendSrc" }
if (!(Test-Path $frontendSrc)) { throw "Missing $frontendSrc" }

Copy-Item $backendSrc $backendDst -Force
Copy-Item $frontendSrc $frontendDst -Force

Write-Host "[FleetOps] Environment templates applied for $Target" -ForegroundColor Green
Write-Host "- backend/.env"
Write-Host "- frontend/.env.local"
Write-Host "Now edit secrets/URLs before running in $Target." -ForegroundColor Yellow
