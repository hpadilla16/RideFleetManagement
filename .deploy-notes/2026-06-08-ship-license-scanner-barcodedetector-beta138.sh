#!/usr/bin/env bash
# v0.9.0-beta.138 — license scanner uses native BarcodeDetector (3.4 rev 2).
#   bash .deploy-notes/2026-06-08-ship-license-scanner-barcodedetector-beta138.sh
#
# Frontend-only. No migration. No money code.
#
# WHY: zxing-js decodes real-license PDF417 poorly — the live scan failed on both
# webcam AND an Android tablet. Confirmed via BarcodeDetector probe that this
# browser supports native `pdf417` decoding (Chrome desktop + Android Chrome),
# which is hardware-accelerated and far more reliable than zxing-js.
#
# WHAT: frontend/src/components/loaner/LicenseScanner.jsx rewritten to own the
# camera stream (high-res rear cam) and prefer the native BarcodeDetector with a
# tight detect loop on the live <video>; zxing-js (decodeFromStream) is kept only
# as a fallback for browsers without BarcodeDetector (e.g. iOS Safari). The
# upload-photo path also tries BarcodeDetector first, then zxing.
#
# ALSO (frontend/src/lib/aamva.js): the parser missed the LICENSE NUMBER (DAQ) —
# once a phone decoded the barcode only state + expiry came through. DAQ is the
# FIRST subfile element and follows the "DL" designator with NO leading line
# break, so the newline-only anchor skipped it. Fixed extract() to also anchor on
# the DL/ID designator (state/expiry/name still parse correctly).
#
# NOTE (related Sentry JAVASCRIPT-NEXTJSFRONTEND-Q "setPhotoOptions failed"): that
# was the OLD April bundle (frontend-2026-04-17-hotfix.1) cached on the tablet —
# an old PhotoCapture that used ImageCapture. Current code captures via canvas and
# has NO ImageCapture, so it can't recur. The tablet just needs its cache cleared
# (no service worker in this app) to pick up current frontend.
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"; cd "$REPO_ROOT"
BRANCH="$(git branch --show-current)"; TAG="v0.9.0-beta.138"
[ -n "$BRANCH" ] || { echo "Detached HEAD — checkout release/deposit-balance-fix-beta119 first" >&2; exit 1; }
echo "Shipping $TAG from branch: $BRANCH (ship after beta.137)"
[ -f .git/index.lock ] && ! pgrep -x git >/dev/null 2>&1 && rm -f .git/index.lock || true

FILES=(
  "frontend/src/components/loaner/LicenseScanner.jsx"
  "frontend/src/lib/aamva.js"
  ".deploy-notes/2026-06-08-ship-license-scanner-barcodedetector-beta138.sh"
)

# ── SYNTAX GATE: jsx validated by the docker frontend build; parsed clean with
#    @babel/parser during prep.
grep -nq "BarcodeDetector" frontend/src/components/loaner/LicenseScanner.jsx || { echo "ABORT: BarcodeDetector path missing." >&2; exit 1; }
grep -nq "decodeFromStream" frontend/src/components/loaner/LicenseScanner.jsx || { echo "ABORT: zxing fallback missing." >&2; exit 1; }
echo "Guards OK."

bash scripts/env-diff-check.sh || { echo "env-diff-check failed — resolve before deploy." >&2; exit 1; }

git add -- "${FILES[@]}"; echo; git status --short -- "${FILES[@]}"; echo
read -r -p "Commit + tag $TAG + push? [y/N] " ok
[ "$ok" = "y" ] || { echo "Left staged (not committed). To unstage: git restore --staged ${FILES[*]}"; exit 0; }
git commit -m "fix(loaner): license scanner uses native BarcodeDetector (pdf417), zxing fallback

zxing-js decoded real-license PDF417 poorly (failed on webcam + Android tablet).
LicenseScanner now owns a high-res rear-camera stream and prefers the native
BarcodeDetector API (Chrome desktop + Android Chrome support pdf417, hardware-
accelerated), running a detect loop on the live video; zxing decodeFromStream is
the fallback for browsers without it (iOS Safari). Upload path tries
BarcodeDetector first, then zxing. Frontend-only; no migration.

Note: the related Sentry 'setPhotoOptions failed' was an old cached April bundle
(ImageCapture); current PhotoCapture uses canvas — clearing the device cache
resolves it (no service worker in this app)."
git tag "$TAG"; git push origin "$BRANCH" "$TAG"
echo
echo "Pushed $TAG. On the droplet:"
echo "  git fetch --tags && git checkout $TAG \\"
echo "    && docker compose -f docker-compose.prod.yml build \\"
echo "    && docker compose -f docker-compose.prod.yml up -d --force-recreate"
echo
echo "VERIFY: 4 containers healthy + /health + frontend HARD refresh (clear tablet cache!)."
echo "  smoke: on Android Chrome (cache cleared) open a loaner check-out → Scan license"
echo "         barcode → hold the BACK of a real license → fields auto-fill."
