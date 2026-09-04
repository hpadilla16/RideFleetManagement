#!/usr/bin/env bash
# Installs the fold-measurement harness into the kiosk app dir (UNCOMMITTABLE:
# both paths are gitignored). Run from frontend/. Remove with ./uninstall.sh.
set -euo pipefail
cd "$(dirname "$0")/../.."
K=src/app/kiosk
sed -E 's/^function (LookupScreen|IdScreen|OffersScreen|PaymentScreen|SignScreen|SelfieScreen|ProgressSteps|PairingScreen|WelcomeScreen)\(/export function \1(/; s/^export default function KioskPage\(/function KioskPage(/' "$K/page.js" > "$K/_screens.harness.js"
mkdir -p "$K/fold-harness" && cp scripts/kiosk-fold-harness/fold-harness.page.js "$K/fold-harness/page.js"
echo "harness installed → start next dev (e.g. npx next dev -p 3105) and open /kiosk/fold-harness?screen=ID&lang=es&notice=2"
echo "NOTE: IdScreen's camera needs reactStrictMode:false in next.config.js while measuring (dev-only StrictMode double-mount flips unmountedRef). Do not commit that either."
