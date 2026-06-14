#!/usr/bin/env bash
# v0.9.0-beta.168 — SUNPASS SWEEP INDEPENDIENTE (worker, decoupled de AutoExpreso)
#   bash .deploy-notes/2026-06-14-ship-sunpass-independent-sweep-beta168.sh
#
# BACKEND-ONLY (worker). SIN migración. SIN cambios al matching/charge math.
#
# QUÉ ENTRA:
#   • tolls.service.js:
#       - runLiveSync(scope, actorUserId, options) — nuevo 3er arg { provider } para
#         fijar el provider (el sweep por-provider lo pasa explícito → un tenant con
#         SunPass Y AutoExpreso sincroniza el correcto, no el "más reciente").
#         Lock ahora por (tenant, provider) → SunPass y AutoExpreso nunca se bloquean.
#       - runAutomaticSyncSweep() → wrapper AUTOEXPRESO (igual que antes).
#       - runSunPassSyncSweep() → NUEVO wrapper SUNPASS.
#       - _runSyncSweepForProvider(provider, intervalMinutes) — core parametrizado
#         (antes el sweep filtraba 'AUTOEXPRESO' hardcoded; ahora por provider).
#       - getSunPassSyncIntervalMinutes() (default 720 = 12h).
#       - el update de lastSyncAt dentro del loop ahora filtra por provider también.
#   • tolls.scheduler.js: timer/flag/startup INDEPENDIENTE para SunPass
#       (sunpassSyncEnabled / sunpassSyncIntervalMs / sunpassStartupDelayMs). El worker
#       ya llama startTollAutoSyncScheduler() → ahora arranca AMBOS timers.
#
# ⚠️ MONEY-ADJACENT (revisar diff, Hector): el sweep dispara imports que postean los
#    peajes MATCHED al RentalAgreement.balance — MISMA vía que el manual-import/AutoExpreso
#    (createManualTransactions → syncReservationTollCharges). La aritmética del cargo NO
#    cambia; esto solo añade QUÉ cuentas (SunPass) se barren y en su PROPIO timer.
#
# SEGURO DE DEPLOYAR YA: corpus NO tiene cuenta SUNPASS activa todavía → el sweep nuevo
#    encuentra 0 cuentas y no hace nada hasta que Hector cree el TollProviderAccount
#    SUNPASS (creds vía Tolls → Provider Setup; el agente nunca teclea passwords).
#
# ENV nuevas (OPCIONALES, con default — NO van en .env.example, no fail env-diff):
#   TOLLS_SUNPASS_AUTO_SYNC_ENABLED (default true)
#   TOLLS_SUNPASS_SYNC_INTERVAL_MINUTES (default 720)
#   TOLLS_SUNPASS_STARTUP_DELAY_SECONDS (default 90)
#
# Deploy: build backend+worker + force-recreate. AutoExpreso INTACTO.
# Verify post-deploy: worker boot limpio + log "[tolls] SunPass sync scheduler started
#   every 720 minute(s)" Y "[tolls] auto sync scheduler started every 15 minute(s)"
#   (los DOS timers) + 3 contenedores healthy + /health 200.
#
# FILES:
#   backend/src/modules/tolls/tolls.service.js
#   backend/src/modules/tolls/tolls.scheduler.js
#   .deploy-notes/2026-06-14-ship-sunpass-independent-sweep-beta168.sh
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"; cd "$REPO_ROOT"
BRANCH="$(git branch --show-current)"; TAG="v0.9.0-beta.168"
[ "$BRANCH" = "release/deposit-balance-fix-beta119" ] || { echo "Must be on release/deposit-balance-fix-beta119. On: $BRANCH" >&2; exit 1; }
echo "Shipping $TAG from $BRANCH"
[ -f .git/index.lock ] && ! pgrep -x git >/dev/null 2>&1 && rm -f .git/index.lock || true

FILES=(
  "backend/src/modules/tolls/tolls.service.js"
  "backend/src/modules/tolls/tolls.scheduler.js"
  ".deploy-notes/2026-06-14-ship-sunpass-independent-sweep-beta168.sh"
)

# ── GATES
node --check backend/src/modules/tolls/tolls.service.js
node --check backend/src/modules/tolls/tolls.scheduler.js
grep -nq "runSunPassSyncSweep" backend/src/modules/tolls/tolls.service.js || { echo "ABORT: runSunPassSyncSweep missing in service." >&2; exit 1; }
grep -nq "runSunPassSyncSweep" backend/src/modules/tolls/tolls.scheduler.js || { echo "ABORT: SunPass timer missing in scheduler." >&2; exit 1; }
grep -nq "_runSyncSweepForProvider" backend/src/modules/tolls/tolls.service.js || { echo "ABORT: parametric sweep core missing." >&2; exit 1; }
echo "Guards OK."

git add -- "${FILES[@]}"; echo; git status --short -- "${FILES[@]}"; echo
read -r -p "Commit + tag $TAG + push? [y/N] " ok
[ "$ok" = "y" ] || { echo "Left staged. Unstage: git restore --staged ${FILES[*]}"; exit 0; }
git commit -m "feat(tolls): independent SunPass sweep (decoupled from AutoExpreso)

- runLiveSync gains a { provider } override so a per-provider sweep dispatches
  deterministically; sync lock is now per (tenant, provider).
- runAutomaticSyncSweep (AutoExpreso) + new runSunPassSyncSweep, both thin wrappers
  over _runSyncSweepForProvider(provider, intervalMinutes). SunPass has its own
  interval gate (default 12h) + its own worker timer/flag/startup delay, so neither
  connector can block the other. No change to matching or charge math."
git tag "$TAG"
git push origin "$BRANCH" --tags
echo "Pushed $TAG. Deploy: backend+worker build + force-recreate."
echo "Verify: worker logs show BOTH '[tolls] auto sync scheduler started' and"
echo "        '[tolls] SunPass sync scheduler started' on boot."
