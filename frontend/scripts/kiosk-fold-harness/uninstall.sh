#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
rm -rf src/app/kiosk/fold-harness src/app/kiosk/_screens.harness.js
echo "harness removed"
