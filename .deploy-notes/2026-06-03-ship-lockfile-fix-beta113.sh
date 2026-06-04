#!/usr/bin/env bash
# v0.9.0-beta.113 — frontend package-lock.json sync (fixes npm EUSAGE build failure).
#   bash .deploy-notes/2026-06-03-ship-lockfile-fix-beta113.sh
#
# beta.112 added @zxing/browser + @zxing/library to frontend/package.json but
# the lockfile was never regenerated, so `npm ci` in the Docker frontend build
# fails with EUSAGE (package.json and package-lock.json out of sync).
# Lockfile regenerated with --package-lock-only; diff is the zxing entries only.
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"; cd "$REPO_ROOT"
BRANCH="release/v0.9.0-beta.58"; TAG="v0.9.0-beta.113"
[ "$(git branch --show-current)" = "$BRANCH" ] || { echo "Not on $BRANCH" >&2; exit 1; }
[ -f .git/index.lock ] && ! pgrep -x git >/dev/null 2>&1 && rm -f .git/index.lock || true
node -e "JSON.parse(require('fs').readFileSync('frontend/package-lock.json'))" || { echo "lockfile invalid JSON" >&2; exit 1; }
FILES=(
  "frontend/package-lock.json"
  ".deploy-notes/2026-06-03-ship-lockfile-fix-beta113.sh"
)
git add -- "${FILES[@]}"; git status --short -- "${FILES[@]}"; echo
read -r -p "Commit + tag $TAG + push? [y/N] " ok
[ "$ok" = "y" ] || { echo "Left staged."; exit 0; }
git commit -m "fix(build): sync frontend package-lock.json with zxing deps (npm ci EUSAGE)

beta.112 added @zxing deps to package.json without regenerating the lockfile;
npm ci in the Docker frontend build failed with EUSAGE. Lockfile regenerated."
git tag "$TAG"; git push origin "$BRANCH" "$TAG"
echo "Pushed. Deploy v0.9.0-beta.113 instead of beta.112:"
echo "  git checkout v0.9.0-beta.113 && docker compose -f docker-compose.prod.yml build && docker compose -f docker-compose.prod.yml up -d --force-recreate"
