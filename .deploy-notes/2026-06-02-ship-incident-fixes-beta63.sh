#!/usr/bin/env bash
# =====================================================================
# Ship incident-module follow-up fixes as v0.9.0-beta.63.
# Run from your Mac, repo root:
#     bash .deploy-notes/2026-06-02-ship-incident-fixes-beta63.sh
#
# Two fixes on top of beta.62 (NO schema migration this time):
#   1. pullInspectionEvidence now falls back to the legacy base64 photosJson
#      (decodes + uploads each inline inspection photo) when the modern
#      photoStorageRefs path is empty — fixes "pull pulls no pictures".
#   2. "Agreement clauses" nav link added under Settings (AppShell + en/es).
# =====================================================================
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

BRANCH_EXPECTED="release/v0.9.0-beta.58"
TAG="v0.9.0-beta.63"

echo "→ Branch: $(git branch --show-current)  (expected: $BRANCH_EXPECTED)"
[ "$(git branch --show-current)" = "$BRANCH_EXPECTED" ] || { echo "✗ Wrong branch." >&2; exit 1; }
if [ -f .git/index.lock ] && ! pgrep -x git >/dev/null 2>&1; then echo "→ clearing stale index.lock"; rm -f .git/index.lock; fi

FILES=(
  "backend/src/modules/incident-report/incident-report.service.js"
  "frontend/src/components/AppShell.jsx"
  "frontend/src/locales/en.json"
  "frontend/src/locales/es.json"
  ".deploy-notes/2026-06-02-ship-incident-fixes-beta63.sh"
)
for f in "${FILES[@]}"; do [ -e "$f" ] || { echo "✗ Missing: $f" >&2; exit 1; }; done

echo "→ Running incident tests (exit-code gated)..."
if ( cd backend && node --test --test-force-exit src/modules/incident-report/incident-report-pdf.test.mjs src/modules/incident-report/incident-report.service.test.mjs ); then
  echo "  ✓ tests passed"
else echo "✗ Tests failed — aborting." >&2; exit 1; fi
echo

git add -- "${FILES[@]}"
git status --short -- "${FILES[@]}"
echo
read -r -p "Commit + tag $TAG + push? [y/N] " ok
[ "$ok" = "y" ] || { echo "Aborted (changes left staged)."; exit 0; }

git commit -m "fix(incident): pull legacy photosJson inspection photos + add Agreement clauses nav link

- pullInspectionEvidence falls back to base64 photosJson (decode + upload to
  the incident bucket) when photoStorageRefs is empty (default storage-off prod).
- Settings nav: add /settings/agreement-clauses link (AppShell + en/es labels)."
git tag "$TAG"
git push origin "$BRANCH_EXPECTED" "$TAG"
echo "✓ Pushed $BRANCH_EXPECTED and $TAG."

cat <<'EOF'

Deploy on the droplet (no migration needed):
  cd ~/RideFleetManagement
  git fetch --tags --force
  git checkout v0.9.0-beta.63
  docker compose -f docker-compose.prod.yml up -d --build
  sleep 60
  docker compose -f docker-compose.prod.yml ps
  docker logs fleet-backend-prod --tail 20

Then: Settings should now show "Agreement clauses"; re-open an incident draft
and "Pull check-in" / "Pull check-out" should bring in the inspection photos.
EOF
