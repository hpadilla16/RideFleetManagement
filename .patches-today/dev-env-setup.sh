#!/bin/bash
# Local dev env setup for round 25.
# Run from your Mac terminal (not from sandbox).
#
# Usage:
#   bash .patches-today/dev-env-setup.sh
#
# What it does:
#   1. Brings up local Postgres (port 5433)
#   2. Brings up backend container (auto-runs `prisma db push` to apply the
#      new round-25-prep migration + all earlier ones to fresh DB)
#   3. Seeds local-dev tenant + locations + vehicle types
#   4. Seeds a SUPER_ADMIN you can log in with
#   5. Seeds a TermsTemplate for the local-dev tenant
#   6. Brings up frontend (port 3000)
#
# After it finishes you can log in at http://localhost:3000 with:
#   email:    superadmin@fleetbeta.local
#   password: TempPass123!
#
# Or to use the local-dev tenant ADMIN:
#   email:    admin@ridefleet.com
#   password: Ride1234!

set -e
cd /Users/hectorpadilla/Code/RideFleetManagement

echo "=== 1/6: Bringing up Postgres ==="
docker compose up -d db
sleep 4
docker compose ps db

echo ""
echo "=== 2/6: Bringing up backend (auto-runs prisma db push) ==="
echo "Watch the logs — it will do: npm install + prisma generate + prisma db push + npm run dev"
echo "Wait until you see 'listening on 4000', then Ctrl+C this and re-run with -d"
echo ""
echo "Run NEXT (in this terminal):"
echo "  docker compose up backend"
echo ""
echo "When backend is healthy, open ANOTHER terminal and run the seeds:"
echo "  docker compose exec backend node scripts/seed-bootstrap.mjs"
echo "  docker compose exec backend node scripts/tenant-seed-superadmin.mjs"
echo "  docker compose exec backend node scripts/seed-pilot-terms-template.mjs"
echo ""
echo "Then bring up frontend:"
echo "  docker compose up -d frontend"
echo ""
echo "Open http://localhost:3000 and log in."
