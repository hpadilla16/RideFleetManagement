#!/usr/bin/env bash
# v0.9.0-beta.205 — Pricing Fase 2.1: tiers de utilization POSICIONALES (3er más barato, mercado, etc.).
#   bash .deploy-notes/2026-06-19-ship-positional-utilization-tiers-beta205.sh
#
# Backend + frontend, code-only, SIN migración (la columna utilizationRules ya existe de beta.204;
# solo cambia la FORMA del JSON). ZERO charge logic.
#
# ⚠️ NOTA DE DINERO: define el SUGGESTED por posición en el mercado según la demanda proyectada.
#    OPT-IN (solo con MarketPricingConfig + tiers). Se aplica solo con autoApply=true (default FALSE;
#    NO se enciende aquí). Smoke antes de encender. No toca lógica de cobro.
#
# QUÉ CAMBIA vs beta.204: los tiers pasan de ajustes "+$/−$/%" sobre el más barato → a TARGETS
# POSICIONALES sobre la lista ordenada de competidores. Escalera de Hector:
#   < 50% → margen base · ≥50% → 3er más barato · ≥70% → 5to más barato · ≥85% → mercado (mediana) ·
#   ≥90% → mercado +15%. Semántica "cuando LLEGA a X%" (fromPct, el tier más alto alcanzado gana;
#   por debajo del primero → margen base).
#
# QUE ENTRA:
#   1) pricing-tiers.js (PURO, 7 tests): pickUtilizationTier (fromPct) + resolveTierTarget +
#      medianOf. Types: NTH_CHEAPEST(n) · NTH_EXPENSIVE(n) · MARKET(mediana) · MARKET_PCT(±%) ·
#      CHEAPEST_MINUS(amount). La lógica de tier salió de pricing-utilization.js (que queda solo con
#      el lookup que reusa el reporte Availability Forecast).
#   2) aggregateCheapestBySippDate ahora devuelve `prices` (mín por vendor, ascendente) por celda →
#      necesario para rankear posiciones. El window export también arma `prices` por celda.
#   3) computeRunComparison + window export: si el util alcanzó un tier → posición en la escalera
#      (con fallback al margen base si el pool está vacío); si no → margen base. Antes del gross-up→base.
#   4) Settings: editor de tiers nuevo formato "fromPct => target" (ej. "70 => 5 cheapest", "90 =>
#      market +15%"). Parser/formatter + sanitize backend al nuevo shape.
#   NOTA: tiers viejos (shape maxPct/adjust de beta.204, si hubiera) quedan inertes (→ margen base)
#   hasta re-guardarlos en el nuevo formato.
#
# Verificado: node --check OK; tests 7/7 (tiers) + 32/32 (resto); smoke end-to-end: 6 competidores,
# util 70% → Suggested(all-in)=40 (5to más barato) → Uploaded base 27.30.
#
# Deploy: build BACKEND + FRONTEND + force-recreate. SIN migración.
#
# FILES:
#   backend/src/modules/market-scraper/pricing-tiers.js
#   backend/src/modules/market-scraper/pricing-tiers.test.mjs
#   backend/src/modules/market-scraper/pricing-utilization.js
#   backend/src/modules/market-scraper/pricing-utilization.test.mjs
#   backend/src/modules/market-scraper/market-scrape-comparison.service.js
#   backend/src/modules/market-observations/market-observations.service.js
#   backend/src/modules/settings/settings.service.js
#   frontend/src/app/settings/page.js
#   .deploy-notes/2026-06-19-ship-positional-utilization-tiers-beta205.sh
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"; cd "$REPO_ROOT"
BRANCH="$(git branch --show-current)"; TAG="v0.9.0-beta.205"
[ "$BRANCH" = "release/deposit-balance-fix-beta119" ] || { echo "Must be on release/deposit-balance-fix-beta119. On: $BRANCH" >&2; exit 1; }
echo "Shipping $TAG from $BRANCH"
[ -f .git/index.lock ] && ! pgrep -x git >/dev/null 2>&1 && rm -f .git/index.lock || true

FILES=(
  "backend/src/modules/market-scraper/pricing-tiers.js"
  "backend/src/modules/market-scraper/pricing-tiers.test.mjs"
  "backend/src/modules/market-scraper/pricing-utilization.js"
  "backend/src/modules/market-scraper/pricing-utilization.test.mjs"
  "backend/src/modules/market-scraper/market-scrape-comparison.service.js"
  "backend/src/modules/market-observations/market-observations.service.js"
  "backend/src/modules/settings/settings.service.js"
  "frontend/src/app/settings/page.js"
  ".deploy-notes/2026-06-19-ship-positional-utilization-tiers-beta205.sh"
)

# ── SANITY GATES ──
[ -f backend/src/modules/market-scraper/pricing-tiers.js ] || { echo "ABORT: falta pricing-tiers.js" >&2; exit 1; }
printf '%s\n' "${FILES[@]}" | grep -Fqx "backend/src/modules/market-scraper/pricing-tiers.js" || { echo "ABORT: pricing-tiers.js no está en FILES[]" >&2; exit 1; }
for f in \
  backend/src/modules/market-scraper/pricing-tiers.js \
  backend/src/modules/market-scraper/pricing-utilization.js \
  backend/src/modules/market-scraper/market-scrape-comparison.service.js \
  backend/src/modules/market-observations/market-observations.service.js \
  backend/src/modules/settings/settings.service.js; do
  node --check "$f" || { echo "ABORT: node --check $f" >&2; exit 1; }
done
grep -q "resolveTierTarget" backend/src/modules/market-scraper/market-scrape-comparison.service.js || { echo "ABORT: comparison no usa resolveTierTarget." >&2; exit 1; }
grep -q "resolveTierTarget" backend/src/modules/market-observations/market-observations.service.js || { echo "ABORT: window export no usa resolveTierTarget." >&2; exit 1; }
grep -q "NTH_CHEAPEST" backend/src/modules/settings/settings.service.js || { echo "ABORT: settings no sanitiza el nuevo shape." >&2; exit 1; }
grep -q "fromPct =&gt; target" frontend/src/app/settings/page.js || grep -q "fromPct => target" frontend/src/app/settings/page.js || { echo "ABORT: frontend sin el editor nuevo." >&2; exit 1; }
# Tests (sin 'timeout' — no existe en macOS).
node --test backend/src/modules/market-scraper/pricing-tiers.test.mjs >/dev/null 2>&1 \
  && echo "tier tests OK" || { echo "ABORT: tier tests fallaron." >&2; exit 1; }
( cd backend && node --test --test-force-exit \
    src/modules/market-scraper/pricing-grossup.test.mjs \
    src/modules/market-scraper/pricing-utilization.test.mjs \
    src/modules/market-scraper/market-vendor.test.mjs \
    src/modules/market-scraper/market-scrape-comparison.test.mjs >/dev/null 2>&1 ) \
  && echo "market tests OK" || { echo "ABORT: market tests fallaron (corre el bloque a mano para el detalle)." >&2; exit 1; }
echo "Guards OK. (Frontend lo valida el 'next build' del docker build.)"

git add -- "${FILES[@]}"; echo; git status --short -- "${FILES[@]}"; echo
read -r -p "Commit + tag $TAG + push? [y/N] " ok
[ "$ok" = "y" ] || { echo "Left staged. Unstage: git restore --staged ${FILES[*]}"; exit 0; }
git commit -m "feat(market): positional utilization tiers (3rd cheapest / market / market+%)

Utilization tiers now target a POSITION on the competitive ladder instead of a
+/- nudge: NTH_CHEAPEST(n), NTH_EXPENSIVE(n), MARKET (median), MARKET_PCT (±%),
CHEAPEST_MINUS (amount). 'When utilization reaches fromPct' semantics — the highest
fromPct reached wins; below the lowest, the base margin applies. New pure pricing-
tiers.js (7 tests); aggregateCheapestBySippDate now exposes the per-vendor price
ladder; computeRunComparison + the window export resolve the tier against it before
the gross-up→base conversion. Settings editor uses 'fromPct => target' lines. Opt-in;
autoApply NOT enabled. No migration (utilizationRules column already exists; JSON shape
changed — old-shape tiers become inert until re-saved). No charge logic touched."
git tag "$TAG"
git push origin "$BRANCH" --tags
echo "Pushed $TAG. Droplet: build backend+frontend → force-recreate. Sin migración."
