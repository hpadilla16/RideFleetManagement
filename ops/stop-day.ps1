$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

Write-Host "[FleetOps] Stopping stack..." -ForegroundColor Cyan
docker compose down
Write-Host "[FleetOps] Stopped." -ForegroundColor Green
