#!/usr/bin/env bash
# =====================================================================
# Ship the Settings Hub "Agreement Clauses" chip as v0.9.0-beta.64.
# Frontend-only, no migration. Run from your Mac, repo root:
#     bash .deploy-notes/2026-06-02-ship-settings-clauses-chip-beta64.sh
#
# Adds an "Agreement Clauses" chip to the Settings Hub (next to Agreement)
# that opens /settings/agreement-clauses — so staff find it in Settings, not
# just the left nav.
#
# NOTE: if you have NOT yet rebuilt the droplet for v0.9.0-beta.63, this
# beta.64 build includes everything from beta.63 too (the photosJson pull
# fix + the nav link), so a single beta.64 deploy covers both.
# =====================================================================
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

BRANCH_EXPECTED="release/v0.9.0-beta.58"
TAG="v0.9.0-beta.64"

echo "→ Branch: $(git branch --show-current)  (expected: $BRANCH_EXPECTED)"
[ "$(git branch --show-current)" = "$BRANCH_EXPECTED" ] || { echo "✗ Wrong branch." >&2; exit 1; }
if [ -f .git/index.lock ] && ! pgrep -x git >/dev/null 2>&1; then echo "→ clearing stale index.lock"; rm -f .git/index.lock; fi

FILES=(
  "frontend/src/app/settings/page.js"
  "doc/incident-reporting-playbook-2026-06-02.html"
  "doc/dejavoo-readiness-review-2026-06-02.md"
  "doc/session-handoff-2026-06-02.md"
  ".deploy-notes/2026-06-02-ship-settings-clauses-chip-beta64.sh"
)
for f in "${FILES[@]}"; do [ -e "$f" ] || { echo "✗ Missing: $f" >&2; exit 1; }; done

git add -- "${FILES[@]}"
git status --short -- "${FILES[@]}"
echo
read -r -p "Commit + tag $TAG + push? [y/N] " ok
[ "$ok" = "y" ] || { echo "Aborted (changes left staged)."; exit 0; }

git commit -m "feat(settings): Agreement Clauses chip in Settings Hub + session docs

- Settings Hub: add an 'Agreement Clauses' chip (next to Agreement) that opens
  /settings/agreement-clauses, so the clause library is discoverable in Settings.
- Docs: incident-reporting employee playbook, Dejavoo readiness review, handoff."
git tag "$TAG"
git push origin "$BRANCH_EXPECTED" "$TAG"
echo "✓ Pushed $BRANCH_EXPECTED and $TAG."

cat <<'EOF'

Deploy on the droplet (no migration):
  cd ~/RideFleetManagement
  git fetch --tags --force
  git checkout v0.9.0-beta.64
  docker compose -f docker-compose.prod.yml up -d --build
  sleep 60
  docker compose -f docker-compose.prod.yml ps

Then: Settings Hub shows an "Agreement Clauses" chip; clicking it opens the
clause library. (This build also carries the beta.63 photo-pull fix + nav link.)
EOF
