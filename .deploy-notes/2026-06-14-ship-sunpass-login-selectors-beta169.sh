#!/usr/bin/env bash
# v0.9.0-beta.169 — FIX login de SunPass (selectores del portal rediseñado)
#   bash .deploy-notes/2026-06-14-ship-sunpass-login-selectors-beta169.sh
#
# BACKEND-ONLY (tolls.service.js, lo usan backend + worker). SIN migración.
# NO toca matching ni charge math — solo el mecanismo de login/scrape.
#
# POR QUÉ: Sentry JAVASCRIPT-NEXTJSBACKEND-1V — "No element found for selector:
#   input#loginUsername" en sunpassLogin al correr POST /api/tolls/provider-account/
#   live-sync (tenant corpus). El portal SunPass (Conduent "vector") fue rediseñado:
#   los ids viejos loginUsername/loginPassword YA NO EXISTEN. La página ahora trae DOS
#   copias responsive del form (desktop tt_username/tt_loginPassword name=loginName/
#   password; mobile tt_username1/tt_loginPassword1 name=login/loginPassword) + un search
#   de FAQs (name="sy"). Selectores reales confirmados por DevTools de Hector.
#
# QUÉ ENTRA (tolls.service.js):
#   • sunpassLogin reescrito: resuelve los campos por VISIBILIDAD + contexto (password
#     visible → su <form> → username text input por placeholder/nombre acct/user, nunca
#     el search; botón "Login" del mismo form). Robusto a futuros renames de id. Si no
#     encuentra campos: throw claro "SunPass login fields not found (layout changed)".
#   • 2× page.waitForTimeout(N) → new Promise(setTimeout) en sunpassNavigateToActivity y
#     sunpassFilterAndSearch (esta versión de puppeteer NO tiene waitForTimeout — habría
#     crasheado justo después del login; AutoExpreso ya usaba setTimeout).
#
# NOTA: solo se verificó el LOGIN. La navegación a Activity + filtro + scrape post-rediseño
#   pueden necesitar ajustes — re-test del Live-Sync tras deploy + revisar Sentry; el
#   próximo error (si lo hay) apunta al siguiente selector.
#
# Deploy: build backend + worker + force-recreate. Verify: re-correr Live-Sync de SunPass
#   en corpus (Tolls → Provider Setup → Sync) → ya NO debe salir el error de input#loginUsername
#   en Sentry; ver hasta dónde llega.
#
# FILES:
#   backend/src/modules/tolls/tolls.service.js
#   .deploy-notes/2026-06-14-ship-sunpass-login-selectors-beta169.sh
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"; cd "$REPO_ROOT"
BRANCH="$(git branch --show-current)"; TAG="v0.9.0-beta.169"
[ "$BRANCH" = "release/deposit-balance-fix-beta119" ] || { echo "Must be on release/deposit-balance-fix-beta119. On: $BRANCH" >&2; exit 1; }
echo "Shipping $TAG from $BRANCH"
[ -f .git/index.lock ] && ! pgrep -x git >/dev/null 2>&1 && rm -f .git/index.lock || true

FILES=(
  "backend/src/modules/tolls/tolls.service.js"
  ".deploy-notes/2026-06-14-ship-sunpass-login-selectors-beta169.sh"
)

# ── GATES
node --check backend/src/modules/tolls/tolls.service.js
! grep -q "waitForTimeout" backend/src/modules/tolls/tolls.service.js || { echo "ABORT: waitForTimeout still present (puppeteer has no such method)." >&2; exit 1; }
grep -nq "login page layout changed" backend/src/modules/tolls/tolls.service.js || { echo "ABORT: new resilient login resolver missing." >&2; exit 1; }
grep -nq 'input\[type="password"\]' backend/src/modules/tolls/tolls.service.js || { echo "ABORT: password-by-type resolver missing." >&2; exit 1; }
echo "Guards OK."

git add -- "${FILES[@]}"; echo; git status --short -- "${FILES[@]}"; echo
read -r -p "Commit + tag $TAG + push? [y/N] " ok
[ "$ok" = "y" ] || { echo "Left staged. Unstage: git restore --staged ${FILES[*]}"; exit 0; }
git commit -m "fix(tolls): SunPass login selectors for redesigned portal

- sunpassLogin resolves username/password/login-button by visibility + context
  instead of the removed ids loginUsername/loginPassword (Sentry
  JAVASCRIPT-NEXTJSBACKEND-1V). Handles the dual responsive forms + skips the FAQ
  search box; throws a clear error if the layout changes again.
- Replace 2 page.waitForTimeout(n) with setTimeout (this puppeteer build lacks
  waitForTimeout; would have crashed right after login). No matching/charge changes."
git tag "$TAG"
git push origin "$BRANCH" --tags
echo "Pushed $TAG. Deploy: backend+worker build + force-recreate, then re-run SunPass Live-Sync and recheck Sentry."
