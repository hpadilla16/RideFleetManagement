#!/usr/bin/env bash
# RateOffer: tabla de ingest del nuevo engine de market intelligence (Kayak metasearch).
#   bash .deploy-notes/2026-07-02-ship-rate-offer-model.sh
#   (tag default v0.9.0-beta.281 — override: TAG_OVERRIDE=v0.9.0-beta.NNN)
#
# BACKEND-only (schema + migración aditiva 20260702_rate_offer). CERO código de app —
# el consumer del dashboard MI es ticket aparte. Pipeline: build → Innovation (1 MUST:
# id ahora con DEFAULT en DB — gen_random_uuid()::text — porque el droplet inserta SQL
# directo y @default(cuid()) es solo del cliente Prisma) → QA = SHIP (migración aplicada
# 2× contra Postgres 18 embebido; upserts, dedup por source, GROUP BY provider y
# cascadas verificados con SQL real).
#
# QUÉ (handoff del scraper team, 2026-07-02): el scraper directo de Expedia está caído
# desde Jul 1; el reemplazo scrapea Kayak (metasearch) que trae varios OTAs por auto.
# Nueva tabla RateOffer con el triple canónico source/provider/supplier + enum RateSource
# (KAYAK, EXPEDIA_DIRECT, CARRENTALS). Dedup: unique rateoffer_identity_key
# (runId, source, provider, supplier, rawCategory, sipp, pickupDate, returnDate) —
# identidad NOT NULL con '' cuando falta (NULLs romperían el dedup). Reusa
# MarketObservationStatus. FKs formales con Cascade a MarketScrapeRun/Profile
# (mismo patrón que MarketObservation) + back-relations.
#
# RESPUESTAS AL SCRAPER TEAM: doc/rateoffer-handoff-reply-2026-07-02.md (sintaxis de
# upsert obligatoria — ON CONFLICT por lista de columnas, NO "ON CONSTRAINT"; id se
# omite; handshake del MarketScrapeRun; GRANTs de contingencia).
#
# ── SMOKE ──
#   Tras el deploy el runner de boot aplica la migración solo (AUTO_MIGRATE_ON_BOOT).
#   Verificar en logs: "startup-migrate" aplicando 20260702_rate_offer, boot limpio.
#   SELECT count(*) FROM "RateOffer";  → 0 (existe). El scraper team corre su primera
#   corrida (~42 filas) y se verifica GROUP BY provider.
#
# DEPLOY (BACKEND only — la migración corre SOLA en el boot):
#   git fetch --tags && git checkout <TAG>
#   docker compose -f docker-compose.prod.yml build backend
#   docker compose -f docker-compose.prod.yml up -d --force-recreate backend worker
#
# FILES:
#   backend/prisma/schema.prisma
#   backend/prisma/migrations/20260702_rate_offer/migration.sql
#   doc/rateoffer-handoff-reply-2026-07-02.md
#   .deploy-notes/2026-07-02-ship-rate-offer-model.sh
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"; cd "$REPO_ROOT"
BRANCH="$(git branch --show-current)"
TAG="${TAG_OVERRIDE:-v0.9.0-beta.281}"
[ "$BRANCH" = "release/deposit-balance-fix-beta119" ] || { echo "Must be on release/deposit-balance-fix-beta119. On: $BRANCH" >&2; exit 1; }
git rev-parse -q --verify "refs/tags/$TAG" >/dev/null && { echo "ABORT: el tag $TAG ya existe — usa TAG_OVERRIDE" >&2; exit 1; }
echo "Shipping $TAG from $BRANCH"
[ -f .git/index.lock ] && ! pgrep -x git >/dev/null 2>&1 && rm -f .git/index.lock || true

FILES=(
  "backend/prisma/schema.prisma"
  "backend/prisma/migrations/20260702_rate_offer/migration.sql"
  "doc/rateoffer-handoff-reply-2026-07-02.md"
  ".deploy-notes/2026-07-02-ship-rate-offer-model.sh"
)

# ── SANITY GATES ──
grep -q "model RateOffer" backend/prisma/schema.prisma || { echo "ABORT: schema sin RateOffer" >&2; exit 1; }
grep -q "gen_random_uuid" backend/prisma/migrations/20260702_rate_offer/migration.sql || { echo "ABORT: migración sin DB default de id" >&2; exit 1; }
grep -q "IF NOT EXISTS" backend/prisma/migrations/20260702_rate_offer/migration.sql || { echo "ABORT: migración no idempotente" >&2; exit 1; }
( cd backend && npx prisma validate && npx prisma generate >/dev/null ) || { echo "ABORT: prisma validate/generate" >&2; exit 1; }
echo "Guards OK."

git add -- "${FILES[@]}"; echo; git status --short -- "${FILES[@]}"; echo
read -r -p "Commit + tag $TAG + push? [y/N] " ok
[ "$ok" = "y" ] || { echo "Left staged. Unstage: git restore --staged ${FILES[*]}"; exit 0; }
git commit -m "feat(market-intelligence): RateOffer ingest table for the Kayak metasearch scraper

The direct-Expedia scraper has been blocked since Jul 1; the replacement
scrapes Kayak metasearch, which quotes multiple OTAs per car — hence the
canonical source/provider/supplier triple the old MarketObservation model
lacks. New RateSource enum (KAYAK, EXPEDIA_DIRECT, CARRENTALS) + RateOffer
model with dedup unique rateoffer_identity_key (runId, source, provider,
supplier, rawCategory, sipp, pickupDate, returnDate; identity columns NOT NULL
with '' sentinels), formal Cascade FKs to MarketScrapeRun/Profile matching the
MarketObservation pattern, and a DB-side id default (gen_random_uuid()::text)
so the droplet's raw-SQL inserts can omit id — Prisma's cuid() is client-only.
Additive idempotent migration, auto-applied at boot by startup-migrate.
Zero app code — the MI dashboard consumer is a follow-up. QA verified against
a real Postgres: double-apply, column-list ON CONFLICT upserts, per-source
dedup, GROUP BY provider, and FK cascades. Scraper-team integration answers in
doc/rateoffer-handoff-reply-2026-07-02.md."
git tag "$TAG"
git push origin "$BRANCH" "$TAG"
echo "Pushed $TAG. Droplet: build BACKEND → recreate backend+worker (la migración corre sola en el boot). Luego el scraper team corre su primera corrida."
