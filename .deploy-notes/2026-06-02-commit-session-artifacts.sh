#!/usr/bin/env bash
# =====================================================================
# Commit this session's paper trail: SQL fixes, deploy scripts, and the
# updated handoff doc. These are docs/scripts only — nothing here is built
# into the running containers, so no deploy follows. Run from your Mac:
#     bash .deploy-notes/2026-06-02-commit-session-artifacts.sh
# =====================================================================
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

# Clear the stale 0-byte .git/index.lock the Cowork sandbox leaves behind.
if [ -f .git/index.lock ] && ! pgrep -x git >/dev/null 2>&1; then
  echo "→ Removing stale .git/index.lock"
  rm -f .git/index.lock
fi

FILES=(
  "doc/fixes/2026-06-02-TL-ZE40788172BA-diagnostic.sql"
  "doc/fixes/2026-06-02-TL-ZE40788172BA-vehicle-swap.sql"
  "doc/fixes/2026-06-02-vehicle-status-drift-sweep.sql"
  ".deploy-notes/2026-06-02-ship-override-panel-beta60.sh"
  ".deploy-notes/2026-06-02-ship-vehicle-status-sync-beta61.sh"
  ".deploy-notes/2026-06-02-commit-session-artifacts.sh"
  "doc/session-handoff-2026-06-02.md"
)

echo "→ Staging session artifacts:"
for f in "${FILES[@]}"; do
  [ -e "$f" ] || { echo "  (skip, missing) $f"; continue; }
  git add -- "$f"
  echo "    $f"
done
echo

git status --short -- "${FILES[@]}"
echo
read -r -p "Commit these artifacts? [y/N] " ok
[ "$ok" = "y" ] || { echo "Aborted (changes left staged)."; exit 0; }

git commit -m "docs(ops): session artifacts — TL-ZE40788172BA fix, beta.60/61 deploy scripts, bug #44 sweep, handoff update"
git push origin "$(git branch --show-current)"
echo "✓ Committed + pushed session artifacts."
