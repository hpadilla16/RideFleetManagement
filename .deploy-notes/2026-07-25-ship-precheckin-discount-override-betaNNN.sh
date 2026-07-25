#!/usr/bin/env bash
# Pre-check-in discount survives Save Override (MONEY CODE — Hector approved
# the rule and reviewed the diff, 2026-07-25).
#
# THE BUG (three faces, one root: the Edit-pricing UI rebuilds rows from CATALOG
# prices and replacePricing persists whatever the UI sends):
#  1. Insurance bought at pre-check-in with the tenant discount reverted to list
#     price on any Save Override ($38 back to $40) — the reported symptom.
#  2. The portal never updates snapshot.selectedInsuranceCodes and the editor
#     derived its insurance selection from the SNAPSHOT — so a plan added fresh
#     at pre-check-in was not in the selection and Save Override DELETED it.
#     (Bonus latent bug: the snapshot schema only persists the SINGULAR
#     selectedInsuranceCode, so the 2nd+ plan of ANY reservation vanished on
#     every override.)
#  3. Services bought at pre-check-in (source ADDITIONAL_SERVICE_PRECHECKIN)
#     were not derived into the editor at all — override deleted them outright.
#
# THE RULE (Hector 2026-07-25, narrowed by QA):
#  - INSURANCE: reservation carries the pre-check-in marker → discount
#    re-applies to the plan slot, INCLUDING a plan the agent swaps in.
#  - SERVICES: only services the customer actually bought at pre-check-in keep
#    the discount and their PRECHECKIN source; agent-added services are
#    counter-priced.
#  - An explicit per-row rate typed by the agent always wins (applyOv).
#
# QA FIX-FIRST round: identity now keys on sourceRefId (name-only matching
# missed the editor's own "Service: " prefix — on the SECOND override the row
# lost its PRECHECKIN source and the portal's delete-by-source re-created it,
# double-charging the customer); ONE precheckinCtx feeds both the preview and
# the Save payload (they used to disagree — agent quoted a price that was never
# persisted); the two-override round-trip test exists and was mutation-verified.
#
# FRONTEND + BACKEND (frontend container rebuilds). No migration, no schema, no
# env keys. Backend change = pricing-options exposes the tenant's
# precheckinDiscount config (read-only).
#
#   TAG=v0.9.0-beta.NNN bash .deploy-notes/2026-07-25-ship-precheckin-discount-override-betaNNN.sh
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"; cd "$REPO_ROOT"
BRANCH="$(git branch --show-current)"; TAG="${TAG:-SET-NEXT-BETA-TAG}"
[ -n "$BRANCH" ] || { echo "Detached HEAD" >&2; exit 1; }
[ "$TAG" != "SET-NEXT-BETA-TAG" ] || { echo "Set TAG=v0.9.0-beta.NNN" >&2; exit 1; }
echo "Shipping $TAG from branch: $BRANCH"

ROUTES="backend/src/modules/reservations/reservations.routes.js"
PAGE="frontend/src/app/reservations/[id]/page.js"
LIB_D="frontend/src/lib/precheckin-discount.js"
LIB_E="frontend/src/lib/pricing-editor.js"
TEST_D="frontend/test/precheckin-discount.test.js"
TEST_E="frontend/test/pricing-editor.test.js"
SELF=".deploy-notes/2026-07-25-ship-precheckin-discount-override-betaNNN.sh"
FILES=("$ROUTES" "$PAGE" "$LIB_D" "$LIB_E" "$TEST_D" "$TEST_E" "$SELF")

# ── GATE 1: backend syntax + boot; `next build` (GATE 5) is the JSX gate.
( cd backend && node --check "${ROUTES#backend/}" )
( cd backend && DATABASE_URL="postgresql://u:p@127.0.0.1:5432/x" \
  JWT_SECRET="ship-gate-smoke-secret-not-a-real-one-000" SKIP_LISTEN=1 \
  node -e "import('./src/main.js').then(()=>process.exit(0)).catch(e=>{console.error(e.message);process.exit(1)})" >/dev/null 2>&1 ) \
  || { echo "ABORT: main.js does not boot-import." >&2; exit 1; }
echo "GATE 1 OK: backend syntax + boot."

# ── GATE 2: MIRROR PARITY. The frontend discount math must stay byte-equal with
# the backend's (lib/precheckin-catalog.js) — a drift means the portal and the
# override write different cents for the same price. Executed, not grepped.
node -e '
const { pathToFileURL } = require("node:url");
const be = pathToFileURL(require("path").resolve("backend/src/lib/precheckin-catalog.js")).href;
const fe = pathToFileURL(require("path").resolve("frontend/src/lib/precheckin-discount.js")).href;
Promise.all([import(be), import(fe)]).then(([b, f]) => {
  const cfgs = [null, {enabled:false,type:"PERCENTAGE",value:50}, {enabled:true,type:"PERCENTAGE",value:5},
    {enabled:true,type:"PERCENTAGE",value:12.5}, {enabled:true,type:"FIXED",value:5}, {enabled:true,type:"FIXED",value:100}];
  const amts = [0, 3, 29.99, 35.99, 40, 12.345, 0.005, 999.999];
  for (const c of cfgs) for (const a of amts) {
    const x = b.makeDiscountFn(c)(a), y = f.makeDiscountFn(c)(a);
    if (x !== y) { console.error(`PARITY BREAK cfg=${JSON.stringify(c)} amt=${a}: backend=${x} frontend=${y}`); process.exit(1); }
  }
  console.log("GATE 2 OK: discount math byte-equal across 48 combos.");
}).catch((e) => { console.error("GATE 2 FAIL:", e.message); process.exit(1); });
' || exit 1

# ── GATE 2b: the structural guards QA demanded.
# Identity keys on sourceRefId via isPrecheckinService — in BOTH the save
# payload and the display preview (2 uses); name-only matching is the blocker.
[ "$(grep -c 'isPrecheckinService(' "$PAGE")" -eq 2 ] \
  || { echo "ABORT: expected isPrecheckinService at exactly 2 sites (save + preview)." >&2; exit 1; }
# One shared context: preview and Save must not diverge again.
[ "$(grep -c 'const precheckinCtx = useMemo' "$PAGE")" -eq 1 ] \
  || { echo "ABORT: the single precheckinCtx memo is gone — preview and save can drift apart." >&2; exit 1; }
[ "$(grep -c 'precheckinCtx' "$PAGE")" -ge 5 ] \
  || { echo "ABORT: precheckinCtx no longer feeds both paths." >&2; exit 1; }
# The editor must derive precheckin services and charges-first insurance (the
# deletion bugs) — these now live in the lib.
[ "$(grep -c 'ADDITIONAL_SERVICE_PRECHECKIN' "$LIB_E")" -ge 1 ] \
  || { echo "ABORT: pricingEditorState no longer derives precheckin services — override would delete them again." >&2; exit 1; }
[ "$(grep -c 'insuranceCodesFromCharges' "$LIB_E")" -eq 2 ] \
  || { echo "ABORT: insurance selection no longer derives from live charges." >&2; exit 1; }
# pricing-options must expose the discount config, fail-safe.
[ "$(grep -c 'getPrecheckinDiscount(tenantScope)' "$ROUTES")" -eq 1 ] \
  || { echo "ABORT: pricing-options no longer exposes precheckinDiscount." >&2; exit 1; }
echo "GATE 2b OK: structural guards hold."

# ── GATE 2c: ENCODING (tr, not grep — $'\r' collapses to an empty pattern here).
for F in "${FILES[@]}"; do
  [ "$(tr -dc '\r' < "$F" | wc -c)" -eq 0 ] || { echo "ABORT: $F has CR bytes." >&2; exit 1; }
  [ "$(grep -c 'Â\|â€' "$F" || true)" -eq 0 ] || { echo "ABORT: $F has mojibake." >&2; exit 1; }
done
echo "GATE 2c OK: no CR, no mojibake."

# ── GATE 3: no schema / migration / lockfile / dependency change.
[ -z "$(git diff HEAD --name-only -- backend/prisma backend/package.json backend/package-lock.json frontend/package.json frontend/package-lock.json 2>/dev/null)" ] \
  || { echo "ABORT: schema/package files changed — this ship is code-only." >&2; exit 1; }
echo "GATE 3 OK: code-only ship."

# ── GATE 4: the new tests are discoverable by the standard runner (vitest
# include is test/**/*.test.{js,jsx} — both files must live there).
[ -f "$TEST_D" ] && [ -f "$TEST_E" ] || { echo "ABORT: a test file is missing." >&2; exit 1; }
echo "GATE 4 OK: both suites in vitest's include path."

# ── GATE 5: run everything.
( cd frontend && npx vitest run test/precheckin-discount.test.js test/pricing-editor.test.js ) \
  || { echo "ABORT: vitest failed." >&2; exit 1; }
( cd frontend && npx next build >/dev/null ) || { echo "ABORT: next build failed." >&2; exit 1; }
if command -v nc >/dev/null 2>&1 && nc -z localhost 5432 >/dev/null 2>&1; then
  ( cd backend && DATABASE_URL="${DEV_DB_URL:-postgresql://$(whoami)@localhost:5432/fleet_management?schema=public}" npm run test:reservations ) \
    || { echo "ABORT: test:reservations failed." >&2; exit 1; }
  echo "GATE 5 OK: vitest + build + reservations green."
else
  echo "GATE 5 OK: vitest + build green (no local postgres for backend suite)."
fi

# ── GATE 6: env parity (no new keys).
ENVBAK="$(mktemp)"; cp backend/.env.example "$ENVBAK"
git checkout HEAD -- backend/.env.example 2>/dev/null || true
bash scripts/env-diff-check.sh < /dev/null || { cp "$ENVBAK" backend/.env.example; echo "env-diff-check failed." >&2; exit 1; }
cp "$ENVBAK" backend/.env.example

# ── STAGE + guard
git reset >/dev/null
git add -- "${FILES[@]}"
EXPECTED="$(printf '%s\n' "${FILES[@]}" | sort)"; STAGED="$(git diff --cached --name-only | sort)"
[ "$EXPECTED" = "$STAGED" ] || {
  echo "ABORT: staged set does not match FILES[]." >&2
  comm -3 <(echo "$EXPECTED") <(echo "$STAGED") >&2; git reset >/dev/null; exit 1
}
echo "GATE 7 OK: staged set = FILES[] exactly (${#FILES[@]} files)."

echo; git diff --cached --stat; echo
read -r -p "Commit + tag $TAG + push? [y/N] " ok < /dev/tty
[ "$ok" = "y" ] || { echo "Left staged (not committed)."; exit 0; }
git commit -m "fix(pricing): pre-check-in discount and purchases survive Save Override

MONEY CODE — rule decided and diff reviewed by Hector (2026-07-25).

The Edit-pricing UI rebuilds insurance/service rows from CATALOG prices and
replacePricing persists whatever the UI sends. Three consequences:
the discounted price a customer accepted at pre-check-in reverted to list on
any Save Override (\$38 back to \$40); a plan added fresh at pre-check-in was
DELETED, because the portal writes the INSURANCE charge but never updates
snapshot.selectedInsuranceCodes and the editor derived its selection from the
snapshot; and services bought at pre-check-in (ADDITIONAL_SERVICE_PRECHECKIN)
were not derived into the editor at all, so overrides deleted those too. Bonus
latent bug fixed by deriving from live charges: the snapshot schema only
persists the SINGULAR selectedInsuranceCode, so the 2nd+ insurance plan of ANY
reservation silently vanished on every override.

The rule: with the pre-check-in marker on the reservation, the discount
re-applies to the insurance slot — including a plan the agent swaps in — while
only services the customer actually bought at pre-check-in keep the discount
and their PRECHECKIN source; agent-added services stay counter-priced. An
explicit per-row rate typed by the agent always wins.

QA (FIX-FIRST) reshaped the first attempt: service identity keys on
sourceRefId, not name — name-only matching missed the editor's own 'Service: '
prefix, so on the SECOND override the row lost its PRECHECKIN source and the
portal's delete-by-source re-created the charge, double-billing the customer.
One shared precheckinCtx now feeds both the preview and the Save payload;
they used to disagree, so the agent quoted a price that was never persisted.
pricingEditorState moved to lib/ so the portal→derive→rebuild round trip is
vitest-covered; the two-override test was mutation-verified against the
reintroduced blocker. Discount math is asserted byte-equal with the backend's
makeDiscountFn (ship gate executes both over 48 combos).

Known and documented, not touched: PERCENTAGE plans have always computed their
base as dailyRate×days while the portal sums all non-insurance charges
(pre-existing divergence, now stated honestly in the comment); a precheckin
service with qty>1 rebuilds at the editor's derived quantity; the portal
creates charges without taxable so the first override adds the correct tax.

Backend: pricing-options exposes the tenant's precheckinDiscount config
(read-only, fail-safe default). No migration, no schema, no new deps.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
git tag "$TAG"; git push origin "$BRANCH" "$TAG"
echo; echo "Pushed $TAG. Droplet: git fetch --tags && git checkout $TAG && docker compose -f docker-compose.prod.yml build && docker compose -f docker-compose.prod.yml up -d --force-recreate"
echo "FRONTEND container must rebuild — the fix is mostly frontend."
echo "Verify: open a reservation that went through pre-check-in, Edit pricing, Save"
echo "  without changes → the discounted price and every precheckin service survive."
