#!/usr/bin/env bash
# v0.9.0-beta.135 — Market Intelligence onboarding wizard.
#   bash .deploy-notes/2026-06-08-ship-mi-onboarding-wizard-beta135.sh
#
# Ship AFTER beta.134 (dashboard SIPP picker). No migration. No money/gateway
# code — everything the wizard creates is additive and SUGGEST-mode (no price is
# auto-applied; rates are displayOnline=false until the tenant wires them).
#
# WHAT: a 4-step wizard (Settings → Market Intelligence → "Open wizard", route
# /market/onboarding) that automates the manual International switchover so a new
# tenant with marketIntelligenceEnabled self-configures:
#   1. airports  → create the scrape profile trio per airport (scheduler scrapes)
#   2. discovery → distinct SIPPs from scheduled-run observations (manual SIPP
#                  catalog fallback when no data yet — there is NO on-demand
#                  scrape trigger by design)
#   3. mapping   → SIPP↔VehicleType (auto-matched by code) → create Rate+RateItem
#                  (daily mirrored, locked rule) + PricingRule (SUGGEST)
#   4. guardrails→ floor/ceiling/maxDeltaPct per rule
#
# ⚠️ main.js imports the new market-onboarding router → BOTH new module files
#    MUST be in FILES[] or the backend won't boot (the #1 boot-crash cause).
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"; cd "$REPO_ROOT"
BRANCH="$(git branch --show-current)"; TAG="v0.9.0-beta.135"
[ -n "$BRANCH" ] || { echo "Detached HEAD — checkout release/deposit-balance-fix-beta119 first" >&2; exit 1; }
echo "Shipping $TAG from branch: $BRANCH (ship AFTER beta.134; tip should be v0.9.0-beta.134)"
[ -f .git/index.lock ] && ! pgrep -x git >/dev/null 2>&1 && rm -f .git/index.lock || true

FILES=(
  "backend/src/modules/market-onboarding/market-onboarding.service.js"
  "backend/src/modules/market-onboarding/market-onboarding.routes.js"
  "backend/src/main.js"
  "frontend/src/app/market/onboarding/page.js"
  "frontend/src/app/settings/page.js"
  ".deploy-notes/2026-06-08-ship-mi-onboarding-wizard-beta135.sh"
)

# ── SYNTAX GATE: backend via node --check (incl. main.js so a missing import is
#    caught NOW, not at boot); frontend (jsx) validated by the docker build.
( cd backend \
  && node --check src/modules/market-onboarding/market-onboarding.service.js \
  && node --check src/modules/market-onboarding/market-onboarding.routes.js \
  && node --check src/main.js )
echo "node --check OK."

# ── BOOT GUARD: every top-level import the new router pulls in must be tracked.
grep -nq "market-onboarding/market-onboarding.routes.js" backend/src/main.js || { echo "ABORT: main.js not importing the onboarding router." >&2; exit 1; }
for f in \
  backend/src/modules/market-onboarding/market-onboarding.service.js \
  backend/src/modules/market-onboarding/market-onboarding.routes.js \
  frontend/src/app/market/onboarding/page.js; do
  git ls-files --error-unmatch "$f" >/dev/null 2>&1 || printf '%s\n' "${FILES[@]}" | grep -qx "$f" || { echo "ABORT: $f is neither tracked nor in FILES[] — backend boot risk." >&2; exit 1; }
done
echo "Boot guard OK."

bash scripts/env-diff-check.sh || { echo "env-diff-check failed — resolve before deploy." >&2; exit 1; }

git add -- "${FILES[@]}"; echo; git status --short -- "${FILES[@]}"; echo
echo "Review:  git diff --cached -- ${FILES[*]}"; echo
read -r -p "Commit + tag $TAG + push? [y/N] " ok
[ "$ok" = "y" ] || { echo "Left staged (not committed). To unstage: git restore --staged ${FILES[*]}"; exit 0; }
git commit -m "feat(market-intel): onboarding wizard (airports → discovery → mapping → guardrails)

A 4-step wizard (/market/onboarding, linked from Settings → Market Intelligence)
that automates the manual International switchover for a new tenant with
marketIntelligenceEnabled:
- new market-onboarding module (service + routes), mounted behind
  requireModuleAccess('marketIntelligence') + ADMIN/OPS.
- step 1 creates the scrape profile trio per airport (scheduler-driven; no
  on-demand trigger by design).
- step 2 discovers SIPPs from scheduled-run observations, with a SIPP-catalog
  manual fallback when there's no data yet.
- step 3 maps SIPP↔VehicleType (by code) and creates Rate+RateItem (daily
  mirrored per the locked rule) + a SUGGEST PricingRule per class.
- step 4 sets floor/ceiling/maxDeltaPct guardrails.
Additive + SUGGEST-only: no Rate.daily auto-applied, rates displayOnline=false.
No migration."
git tag "$TAG"; git push origin "$BRANCH" "$TAG"
echo
echo "Pushed $TAG. On the droplet:"
echo "  git fetch --tags && git checkout $TAG \\"
echo "    && docker compose -f docker-compose.prod.yml build \\"
echo "    && docker compose -f docker-compose.prod.yml up -d --force-recreate"
echo
echo "VERIFY: 4 containers healthy + clean boot (no MODULE_NOT_FOUND — the new"
echo "  market-onboarding import is the thing to watch) + /health 200 + hard refresh."
echo "  smoke: Settings → Market Intelligence → Open wizard → add an airport →"
echo "         Create profiles → discovery (data or manual) → map a SIPP to a"
echo "         vehicle type + seed price → guardrails → Apply → a SUGGEST rule"
echo "         appears; check the Suggestions inbox after the next scheduled scrape."
