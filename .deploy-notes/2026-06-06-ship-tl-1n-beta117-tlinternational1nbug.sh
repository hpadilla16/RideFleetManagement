#!/usr/bin/env bash
# v0.9.0-beta.117.tlinternational1nbug — tl-international /status 500 hotfix (Sentry -1N).
#   bash .deploy-notes/2026-06-06-ship-tl-1n-beta117-tlinternational1nbug.sh
#
# Hotfix on top of beta.117. GET /api/admin/integrations/tl-international/status
# threw PrismaClientValidationError -> 500 on EVERY admin settings-panel load,
# because the externalSyncRun.findFirst() select listed `triggeredBy`, which is
# NOT a column on the ExternalSyncRun model (it is only a job-payload field; the
# DB row never stored it). The route was a 404 in beta.115, so the bad select
# never ran until beta.116 added the /status route and exposed it.
# Fix (Hector's chosen variant): simply DROP the non-existent `triggeredBy` from
# the select. Minimal, no behaviour change for the panel.
# NOTE: supersedes the scheduled bug-agent's beta.118 draft (which swapped
# triggeredBy -> notes). Do NOT also run .deploy-notes/2026-06-06-ship-tl-status-fix-beta118.sh.
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"; cd "$REPO_ROOT"
BRANCH="release/v0.9.0-beta.58"; TAG="v0.9.0-beta.117.tlinternational1nbug"
[ "$(git branch --show-current)" = "$BRANCH" ] || { echo "Not on $BRANCH (run: git checkout $BRANCH)" >&2; exit 1; }
[ -f .git/index.lock ] && ! pgrep -x git >/dev/null 2>&1 && rm -f .git/index.lock || true

PATCHES=( "ops/.agent-patches/04-tl-international-status-triggeredby-500.patch" )
EDITED=(  "backend/src/modules/integrations/tl-international/tl-international.routes.js" )

# ── PRE-FLIGHT: patch must apply cleanly on top of the deployed base
for p in "${PATCHES[@]}"; do
  [ -f "$p" ] || { echo "missing patch: $p" >&2; exit 1; }
  git apply --check "$p" || { echo "patch does not apply cleanly: $p (base changed — re-review)" >&2; exit 1; }
done
echo "Patch applies cleanly. Applying…"
for p in "${PATCHES[@]}"; do git apply "$p"; done

# ── SYNTAX GATE
for f in "${EDITED[@]}"; do ( cd backend && node --check "${f#backend/}" ); done
echo "node --check OK."

FILES=( "${EDITED[@]}" "${PATCHES[@]}" ".deploy-notes/2026-06-06-ship-tl-1n-beta117-tlinternational1nbug.sh" )
git add -- "${FILES[@]}"; git status --short -- "${FILES[@]}"; echo
read -r -p "Commit + tag $TAG + push? [y/N] " ok
[ "$ok" = "y" ] || { echo "Left applied + staged (not committed). To undo: git checkout -- ${EDITED[*]}"; exit 0; }
git commit -m "fix(tl-international): drop non-existent triggeredBy from /status select

GET /api/admin/integrations/tl-international/status threw
PrismaClientValidationError -> 500 on every settings-panel load: the
externalSyncRun.findFirst select listed triggeredBy, which is not a column on
ExternalSyncRun (it is only a job-payload field). Remove it from the select.
(Sentry JAVASCRIPT-NEXTJSBACKEND-1N)"
git tag "$TAG"; git push origin "$BRANCH" "$TAG"
echo "Pushed. Deploy $TAG:"
echo "  git fetch origin --tags && git checkout $TAG && docker compose -f docker-compose.prod.yml build && docker compose -f docker-compose.prod.yml up -d --force-recreate"
