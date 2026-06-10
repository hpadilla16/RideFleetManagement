#!/usr/bin/env bash
# v0.9.0-beta.145 — Inventory Helper, Phases A + B (live trial).
#   1) git checkout release/deposit-balance-fix-beta119
#   2) git merge --ff-only feat/inventory-helper
#   3) bash .deploy-notes/2026-06-09-ship-inventory-helper-AB-beta145.sh
#
# The code is ALREADY committed (merged from feat/inventory-helper via fast-
# forward), so this script does NOT stage/commit — it verifies, then tags +
# pushes beta.145. ADDITIVE migration (4 new tables + enums). No money code.
#
# WHAT SHIPS (A + B): the guided fleet-inventory wizard.
#   - Data model: InventorySession / InventoryItem / InventoryReport /
#     FleetReconciliationFlag (+ enums), migration 20260609_inventory_helper.
#   - Backend: /api/inventory session lifecycle (start/wipe/resume, snapshot +
#     mismatch detection, confirm at-lot/on-rent, maintenance note, exception,
#     resolve-with-note, complete with gating). Photos → Supabase
#     (bucket 'inventory-photos') with base64 fallback.
#   - Frontend: /vehicles/inventory-helper wizard + nav entry + VehicleScanner
#     (QR/VIN native BarcodeDetector, plate match) + 5-photo capture.
#
# NOT YET (later betas): Phase C (Complete → PDF report + Reports → Inventory
#   Reports) and Phase D (reconciliation dashboard tile). For this trial,
#   "Complete inventory" marks the session COMPLETED but produces NO PDF yet.
#
# INFRA for photos in prod (optional — falls back to base64 if absent):
#   - INSPECTION_PHOTOS_STORAGE_ENABLED=true on the droplet (existing flag)
#   - create the Supabase storage bucket 'inventory-photos'
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"; cd "$REPO_ROOT"
BRANCH="$(git branch --show-current)"; TAG="v0.9.0-beta.145"
[ "$BRANCH" = "release/deposit-balance-fix-beta119" ] || { echo "Must be on release/deposit-balance-fix-beta119 (merge feat/inventory-helper first). On: $BRANCH" >&2; exit 1; }
echo "Tagging $TAG on $BRANCH"

# ── Files must be present (i.e. the feat branch was merged in).
for f in \
  backend/prisma/migrations/20260609_inventory_helper/migration.sql \
  backend/src/modules/inventory/inventory.service.js \
  backend/src/modules/inventory/inventory.routes.js \
  backend/src/modules/inventory/inventory-logic.js \
  frontend/src/app/vehicles/inventory-helper/page.js \
  frontend/src/components/inventory/VehicleScanner.jsx ; do
  [ -f "$f" ] || { echo "ABORT: $f missing — did you merge feat/inventory-helper?" >&2; exit 1; }
done

# ── SYNTAX GATE (backend; frontend jsx validated by the docker build).
( cd backend \
  && node --check src/modules/inventory/inventory-logic.js \
  && node --check src/modules/inventory/inventory.service.js \
  && node --check src/modules/inventory/inventory.routes.js \
  && node --check src/main.js )
echo "node --check OK."

# ── UNIT TESTS + PRISMA.
( cd backend && node --test src/modules/inventory/inventory-logic.test.mjs >/dev/null ) && echo "inventory unit tests OK."
( cd backend && npx prisma validate >/dev/null ) && echo "prisma validate OK."

# ── GUARDS: wiring present end to end.
grep -nq "model InventorySession" backend/prisma/schema.prisma || { echo "ABORT: schema missing InventorySession." >&2; exit 1; }
grep -nq "/api/inventory" backend/src/main.js || { echo "ABORT: main.js not mounting /api/inventory." >&2; exit 1; }
grep -nq "inventory-helper" frontend/src/components/AppShell.jsx || { echo "ABORT: nav entry missing." >&2; exit 1; }
echo "Guards OK."

bash scripts/env-diff-check.sh || { echo "env-diff-check failed — resolve before deploy." >&2; exit 1; }

echo; read -r -p "Tag $TAG + push branch + tag? [y/N] " ok
[ "$ok" = "y" ] || { echo "Aborted (nothing tagged/pushed)."; exit 0; }
git tag "$TAG"; git push origin "$BRANCH" "$TAG"
echo
echo "Pushed $TAG. On the droplet:"
echo "  git fetch --tags && git checkout $TAG \\"
echo "    && docker compose -f docker-compose.prod.yml build \\"
echo "    && docker compose -f docker-compose.prod.yml up -d --force-recreate"
echo
echo "  # MIGRATION (additive) — SESSION port 5432, never pgbouncer 6543:"
echo "  docker exec fleet-backend-prod sh -c 'export DATABASE_URL=\$(echo \"\$DATABASE_URL\" | sed -e \"s/:6543/:5432/\" -e \"s/[?&]pgbouncer=true//\"); npx prisma migrate deploy'"
echo
echo "VERIFY: 4 containers healthy + clean boot + /health 200 + HARD refresh."
echo "  smoke: Vehicles → Inventory Helper → Start inventory → fleet lists grouped by lot."
echo "         Confirm a few cars (manual + photos), a maintenance note, an exception,"
echo "         resolve a mismatch, then Complete (no PDF yet — that's Phase C)."
echo "  photos: for Supabase storage, set INSPECTION_PHOTOS_STORAGE_ENABLED=true and"
echo "          create the 'inventory-photos' bucket; otherwise photos store as base64."
