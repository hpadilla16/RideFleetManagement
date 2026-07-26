#!/usr/bin/env bash
# =============================================================================
#  paymentActions capability gate (MONEY)  —  branch release/deposit-balance-fix-beta119
#  Tag number is chosen AT RUNTIME (see step 0). Base: whatever HEAD is when you run this.
#  backend + frontend + ADDITIVE MIGRATION
# =============================================================================
#
#  ⚠️ v0.9.0-beta.349 IS ALREADY TAKEN. Hector tagged it on 2026-07-25 15:18 for
#  commit d26d700 (feat(pricing): per-reservation mileage exception + flat
#  per-day fee in MI) and it is PUSHED to origin. This script therefore does NOT
#  hardcode a tag: it finds the highest existing v0.9.0-beta.N across local AND
#  origin and takes N+1. Override with TAG=v0.9.0-beta.NNN if you want a specific
#  one. Note that beta.349 also touches backend/package.json, which this change
#  reconstructs — deriving from HEAD at runtime (below) keeps their edit.
#
#  DESIGNED TO BE RUN LATE. Five parallel sessions were editing these same files
#  when this was written, so NOTHING here is frozen: no blob hashes, no line
#  numbers, no fixed counts. Every surgical blob is rebuilt from whatever HEAD
#  and whatever working tree exist at run time, using CONTENT anchors. Every
#  guard DETECTS rather than assumes, and every failure does `git reset` and
#  exits rather than shipping a mixture.
#
#  WHAT THIS SHIPS
#  Money-moving routes (charge / capture / release / refund / delete a payment /
#  mint a stored card) sat behind requireModuleAccess('reservations') and nothing
#  else: any employee with the Reservations module could charge a saved card.
#  Measured in prod before the change: 43 refunds totalling $9,618.79, 18 of them
#  by AGENTs. They now carry requireCapability('paymentActions') — FAIL-CLOSED,
#  requires an explicit `true` (requireModuleAccess denies only on an explicit
#  `false`, so a missing key PERMITS; unacceptable for money). Plus the
#  structural guard that keeps it that way, the module-access audit trail, and
#  the People / Settings / payments-screen UI.
#
# -----------------------------------------------------------------------------
#  ⚠️ MANDATORY DEPLOY STEP — VozIA IS 403 UNTIL YOU RUN THIS
# -----------------------------------------------------------------------------
#  The VozIA refund revocation was DOUBLE. Restoring the service-account
#  allowlist entry (in this tag) is NOT enough: the refund route also carries
#  requireCapability('paymentActions'), and the service account's role is AGENT,
#  whose role default for that module is FALSE. Two independent layers:
#      requireAuth -> allowlist  = WHICH PATHS a service account may touch
#      requireCapability         = WHICH PRINCIPALS may move money
#  After deploying, inside fleet-backend-prod (DRY RUN first):
#      docker exec fleet-backend-prod sh -c \
#        'node scripts/grant-payment-actions.mjs <svc-vozia-prod-email>'
#      docker exec fleet-backend-prod sh -c \
#        'node scripts/grant-payment-actions.mjs --apply <svc-vozia-prod-email>'
#  Effective within ~30s (session cache TTL), no restart, writes a
#  ModuleAccessAuditLog row, reversible with --revoke.
#  Hector kept VozIA's refund deliberately with the full Fase 6 record in view
#  (doc/session-handoff-2026-07-04-EOD.md): ceiling voziaMaxRefundAmount 2000,
#  non-recyclable idempotency, ops runbook for stuck keys. Never dormant — only
#  never exercised.
#
# -----------------------------------------------------------------------------
#  ⚠️ DAY-1 OPERATIONAL CHANGE (Hector's decision — tell the counter)
# -----------------------------------------------------------------------------
#  From this deploy a COUNTER AGENT CANNOT RELEASE A CUSTOMER'S DEPOSIT HOLD at
#  close. They must find an admin. There is no automatic release anywhere, so
#  this WILL be hit on day 1. Mitigation for one person, no deploy:
#      node scripts/grant-payment-actions.mjs --apply <their-email>
#  or per-person from People -> Module access. ADMIN/OPS keep it by default;
#  AGENT does not. ADMIN is immune to the tenant-wide switch (anti-self-lockout)
#  so the company can never lock itself out of releasing a deposit.
#  NAMED USERS WHO LOSE REFUNDS: Xavier Perez, Jalisvier Huertas Santana.
#
# -----------------------------------------------------------------------------
#  THINGS THAT WILL LOOK LIKE BUGS BUT ARE NOT
# -----------------------------------------------------------------------------
#  m-3  globals.css adds `:root[data-theme='dark'] .label`. `.label` had no dark
#       override and sat at 3.26:1 (below AA); now #a5a0bd (6.86:1). This is a
#       GLOBAL restyle — .label is used in ~67 files, not just the payments
#       screen. QA approved it as an improvement. A label looking different in
#       dark mode on an unrelated screen is THIS, not that screen's own work.
#  m-5  recordModuleAccessAudit now diffs TRI-STATE (true|false|absent). Removing
#       an explicit {paymentActions:false} used to read false->false and write no
#       row, though effective access jumps to the role default (true for
#       ADMIN/OPS) — a silent grant. Consequence: the FIRST module-access save
#       for a user with no prior override now also logs the `false` keys as
#       null -> false. Correct, but it is visible row content that changed.
#  m-6  package.json is rebuilt as HEAD + ONLY this change's 4 suites. Another
#       session added `--test-force-exit` to ~10 unrelated suites; those are not
#       this change's to ship and would make the diff unreviewable. Same reason
#       schema.prisma is rebuilt: the tree copy is a full `prisma format`
#       reformat with no semantic change beyond the new model.
#
# -----------------------------------------------------------------------------
#  MIGRATION — additive, one new table
# -----------------------------------------------------------------------------
#  backend/prisma/migrations/20260725_module_access_audit_log/migration.sql
#  ⚠️ IF THIS FILE IS MISSING THE DEPLOY GOES GREEN AND THE FEATURE IS SILENTLY
#  DEAD: Prisma exposes the model, the table does not exist, every create()
#  throws P2021, and recordModuleAccessAudit's best-effort catch swallows it.
#  Zero audit rows forever with every test passing. Guard C checks it explicitly.
#
#  Apply on the SESSION port 5432, NEVER pgbouncer 6543 (pgbouncer hangs Prisma):
#    docker exec fleet-backend-prod sh -c \
#      'export DATABASE_URL=$(echo "$DATABASE_URL" | sed -e "s/:6543/:5432/" \
#         -e "s/[?&]pgbouncer=true//"); npx prisma migrate deploy'
#
#  PRE-FLIGHT: bash scripts/env-diff-check.sh (no new env keys this tag).
#  POST: 3 containers healthy, clean boot, /api/health 200 (bare /health is 404
#  in public nginx by design — beta.327).
#  SMOKE: as AGENT the payments panel is disabled with the denial banner + lock
#  hints and the amount inputs are NOT typeable; as ADMIN unchanged.
#
#  USAGE
#    SHIP_DRY_RUN=1 bash .deploy-notes/2026-07-25-ship-payment-actions-gate.sh
#    bash .deploy-notes/2026-07-25-ship-payment-actions-gate.sh
# =============================================================================
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

BRANCH="release/deposit-balance-fix-beta119"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

say(){ printf "\n\033[1;36m== %s\033[0m\n" "$*"; }
ok(){ printf "   \033[32mOK\033[0m    %s\n" "$*"; }
note(){ printf "   \033[33mNOTE\033[0m  %s\n" "$*"; }
die(){ printf "\n   \033[31mABORT\033[0m %s\n\n" "$*"; git reset -q; exit 1; }

# `git show ... | grep -q` is a TRAP under `set -o pipefail`: grep exits early on
# a match, git show takes SIGPIPE, and the PIPELINE returns 141 even though the
# text was found — so a passing check reads as a failure. Repo lesson from the
# beta.320 ship scripts. Always count instead of short-circuiting.
has(){   [ "$(git show ":$1" | grep -cF "$2" || true)" -gt 0 ]; }   # staged blob contains
hasnt(){ [ "$(git show ":$1" | grep -cF "$2" || true)" -eq 0 ]; }  # staged blob lacks
cnt(){   git show ":$1" | grep -cF "$2" || true; }                 # `|| true`: grep -c exits 1 on zero

# Files staged verbatim from the working tree. NEVER an add-everything.
# Shared files (issues/people/moduleAccess) are bounds-checked in Guard E.
FILES=(
  ".github/workflows/beta-ci.yml"
  "backend/prisma/migrations/20260725_module_access_audit_log/migration.sql"
  "backend/scripts/grant-payment-actions.mjs"
  "backend/src/lib/module-access.js"
  "backend/src/lib/module-access-audit.db.test.mjs"
  "backend/src/lib/module-access-frontend-defaults.test.mjs"
  "backend/src/lib/module-access-payment-actions.test.mjs"
  "backend/src/lib/service-account-allowlist.js"
  "backend/src/lib/service-account-allowlist.test.mjs"
  "backend/src/middleware/auth.js"
  "backend/src/modules/auth/service-auth.test.mjs"
  "backend/src/modules/settings/settings.routes.js"
  "doc/payment-actions-gate-mockups-2026-07-25.html"
  "frontend/src/app/globals.css"
  "frontend/src/app/issues/page.js"
  "frontend/src/app/people/page.js"
  "frontend/src/app/reservations/[id]/payments/page.js"
  "frontend/src/app/settings/page.js"
  "frontend/src/lib/moduleAccess.js"
  "frontend/test/module-access-defaults.test.js"
  ".deploy-notes/2026-07-25-ship-payment-actions-gate.sh"
)

MIGRATION="backend/prisma/migrations/20260725_module_access_audit_log/migration.sql"

# ── 0. context + tag selection ───────────────────────────────────────────────
say "0. context"
[ "$(git rev-parse --abbrev-ref HEAD)" = "$BRANCH" ] || die "not on $BRANCH"
[ -z "$(git diff --cached --name-only)" ] || die "index is not empty — commit or reset it first"

git fetch --tags --quiet origin 2>/dev/null || note "could not fetch tags from origin; using local tags only"
if [ -z "${TAG:-}" ]; then
  LAST=$(git tag -l 'v0.9.0-beta.*' | sed 's/.*beta\.//' | grep -E '^[0-9]+$' | sort -n | tail -1)
  TAG="v0.9.0-beta.$((LAST + 1))"
fi
git rev-parse -q --verify "refs/tags/$TAG" >/dev/null && die "$TAG already exists — pass TAG=... explicitly"
ok "branch $BRANCH · HEAD $(git rev-parse --short HEAD) · tag $TAG"

for f in "${FILES[@]}"; do [ -f "$f" ] || die "FILES[] entry missing from the tree: $f"; done
ok "${#FILES[@]} tree files present"

# ── 1. DETECT: has the foreign 410 retirement landed in HEAD? ────────────────
# The parallel session (task_3f0a5161) retires
#   POST /api/reservations/:id/payments/:paymentId/delete
# to a 410 stub. Two different correct behaviours, so we DETECT rather than
# assume:
#   in HEAD      -> it is merged work. Leave it alone; excluding it would be
#                   reverting someone else's shipped change. We simply do not
#                   inject a gate into a 410 stub.
#   only in tree -> still uncommitted foreign work. Our route files are rebuilt
#                   from HEAD, so it is excluded automatically.
say "1. detect the state of the foreign 410 retirement"
FOREIGN_410_MARK='void-no-refund (admin, soft void with reason + audit)'
# counted, not `grep -q`: under pipefail a short-circuiting grep SIGPIPEs the
# upstream git show and the condition reads FALSE even on a match — which here
# would silently misclassify merged upstream work as uncommitted.
if [ "$(git show "HEAD:backend/src/modules/reservations/reservations.routes.js" | grep -cF "$FOREIGN_410_MARK")" -gt 0 ]; then
  RETIRED_IN_HEAD=1; ok "the 410 retirement is IN HEAD — treating it as merged upstream work"
else
  RETIRED_IN_HEAD=0
  if grep -qF "$FOREIGN_410_MARK" backend/src/modules/reservations/reservations.routes.js; then
    note "the 410 retirement is in the WORKING TREE but not in HEAD -> excluded (rebuilt from HEAD)"
  else
    ok "no 410 retirement anywhere — the delete route is live"
  fi
fi

# ── 2. DERIVE the route files from HEAD (foreign-edit proof) ─────────────────
# Our change to these files is exactly: import requireCapability, then insert
# `requireCapability('paymentActions'), ` into a known set of route
# registrations. That is declarative, so we rebuild it on top of whatever HEAD
# says today instead of copying a working tree five sessions are editing.
# Anchors are route PATH LITERALS, never line numbers.
say "2. rebuild the route files: HEAD + our gates"
cat > "$WORK/gate.mjs" <<'MJS'
import fs from 'node:fs';
// spec: { headFile, outFile, label, routes[], importAnchor?, importBlock? }
const spec = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const { label, routes } = spec;
let s = fs.readFileSync(spec.headFile, 'utf8');
const GATE = "requireCapability('paymentActions')";
let added = 0, already = 0, stubs = 0, stubbed = 0, retired = 0;

// The import. Two shapes, both content-anchored:
//   - the file already imports from middleware/auth.js -> extend that list
//   - it does not (rental-agreements, issue-center)    -> insert a new import
//     with its rationale comment, before a named anchor line.
// Skipped entirely if requireCapability is already imported (idempotent, and
// correct if an upstream commit already landed part of this).
if (!/^import \{[^}]*\brequireCapability\b/m.test(s)) {
  const before = s;
  s = s.replace(/^(import \{)([^}]*?)(\} from '(?:\.\.\/)+middleware\/auth\.js';)$/m,
                (m, a, names, c) => `${a}${names.replace(/\s+$/, '')}, requireCapability ${c}`);
  if (s === before) {
    if (!spec.importAnchor || !spec.importBlock) {
      throw new Error(`${label}: no middleware/auth.js import to extend and no importAnchor given`);
    }
    // Single-line anchors only — a multi-line anchor is brittle against
    // reformatting. `importAfter` inserts below the anchor line, otherwise above.
    // CRLF-AWARE: rental-agreements.routes.js is CRLF (747 of 748 lines) while
    // reservations.routes.js is LF. Matching on the raw line would silently miss
    // every anchor in the CRLF file, and inserting LF lines into it would leave
    // mixed endings. So: compare stripped, re-emit in the file's own ending.
    const lines = s.split('\n');
    const bare = (l) => l.replace(/\r$/, '');
    const at = lines.findIndex((l) => bare(l) === spec.importAnchor);
    if (at < 0) throw new Error(`${label}: import anchor line not found in HEAD: ${spec.importAnchor}`);
    const crlf = lines.filter((l) => l.endsWith('\r')).length > lines.length / 2;
    const block = spec.importBlock.replace(/\n$/, '').split('\n').map((l) => (crlf ? bare(l) + '\r' : bare(l)));
    lines.splice(spec.importAfter ? at + 1 : at, 0, ...block);
    s = lines.join('\n');
  }
}

// RETIRE-TO-410. Two rental-agreements routes called
// rentalAgreementsService.deletePaymentHard, which has never existed anywhere in
// the codebase: every call threw TypeError and returned 500. They are replaced
// wholesale (registration through its closing `});`) rather than gated — gating
// a route that always 500s would be theater. Declarative and idempotent: if the
// stub is already there, nothing happens.
for (const st of spec.stubs || []) {
  const head = s.indexOf(`Router.post('${st.route}'`);
  if (head < 0) throw new Error(`${label}: cannot retire ${st.route} — registration not found`);
  // already a 410 stub (re-run, or an upstream commit got there first)? leave it.
  if (/res\.status\(410\)/.test(s.slice(head, head + 400))) { stubbed++; continue; }
  const lineStart = s.lastIndexOf('\n', head) + 1;
  // walk back over the contiguous comment block above the registration
  const before = s.slice(0, lineStart).split('\n');
  let k = before.length - 1;
  while (k > 0 && before[k - 1].replace(/\r$/, '').trim().startsWith('//')) k--;
  const from = before.slice(0, k).join('\n').length + 1;
  const to = s.indexOf('\n});', head) + 4;
  if (to < 4) throw new Error(`${label}: cannot find the end of ${st.route}`);
  const crlf2 = s.split('\n').filter((l) => l.endsWith('\r')).length > s.split('\n').length / 2;
  s = s.slice(0, from) + (crlf2 ? st.block.replace(/\n/g, '\r\n') : st.block) + s.slice(to);
  retired++;
}

for (const r of routes) {
  const re = new RegExp(`^(\\w+Router\\.post\\(\\s*'${r.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}',\\s*)`, 'm');
  const m = s.match(re);
  if (!m) throw new Error(`${label}: route not found in HEAD: ${r}`);
  const rest = s.slice(m.index + m[0].length, m.index + m[0].length + 400);
  if (rest.startsWith(GATE)) { already++; continue; }
  // a 410 stub takes no gate — it reaches no gateway and destroys nothing
  if (/^async \(req, res\) => \{\s*\n\s*res\.status\(410\)/.test(rest)) { stubs++; continue; }
  s = s.slice(0, m.index + m[0].length) + GATE + ', ' + s.slice(m.index + m[0].length);
  added++;
}

// The one prose addition of this change: why the reservations refund route was
// the worst of the set. Anchored on the route line, inserted only if absent, so
// re-running or an upstream edit above it cannot duplicate or misplace it.
const NOTE = [
  '// REFUND — moves money OUT to the customer\'s card via Authorize.Net.',
  '// This route was NEVER gated. It sits directly above the ADMIN-only',
  '// `void-no-refund` block, and its "ADMIN-only" comment made it LOOK protected',
  '// on a casual read (and to a grep) — the handler checked nothing. Measured in',
  '// prod before this change: 43 refunds totalling $9,618.79, 18 of them by',
  '// AGENTs. This is closing an open hole, not tightening an existing permission.'
].join('\n');
if (label.startsWith('reservations') && !s.includes('43 refunds totalling')) {
  const anchor = /^reservationsRouter\.post\(\s*'\/:id\/payments\/:paymentId\/refund',/m;
  if (anchor.test(s)) s = s.replace(anchor, (m0) => NOTE + '\n' + m0);
}

fs.writeFileSync(spec.outFile, s);
console.log(`   ${label}: +${added} gated, ${already} already gated, ${stubs} skipped (410 stub)` + ((retired+stubbed) ? `, ${retired} retired to 410, ${stubbed} already retired` : ''));
if (added + already === 0) throw new Error(`${label}: gated nothing — anchors are stale`);
MJS

derive_routes() { # <path> [--anchor <line> --block <file>] <route literals...>
  local path="$1"; shift
  local anchor="" blockfile="" after="" stubspec=""
  while [ "${1:-}" = "--anchor" ] || [ "${1:-}" = "--block" ] || [ "${1:-}" = "--after" ] || [ "${1:-}" = "--stub" ]; do
    [ "$1" = "--anchor" ] && { anchor="$2"; shift 2; continue; }
    [ "$1" = "--block" ]  && { blockfile="$2"; shift 2; continue; }
    [ "$1" = "--after" ]  && { after="1"; shift; continue; }
    [ "$1" = "--stub" ]   && { stubspec="$stubspec$2"$'\n'; shift 2; continue; }
  done
  local out="$WORK/$(echo "$path" | tr '/' '_')"
  git show "HEAD:$path" > "$out.head"
  ANCHOR="$anchor" BLOCKFILE="$blockfile" AFTER="$after" STUBS="$stubspec" HEADF="$out.head" OUTF="$out.out" \
  LABEL="$(basename "$path")" ROUTES="$(printf '%s\n' "$@")" node -e '
    const fs=require("fs");
    const spec={ headFile:process.env.HEADF, outFile:process.env.OUTF, label:process.env.LABEL,
      routes:process.env.ROUTES.split("\n").filter(Boolean) };
    if(process.env.ANCHOR){ spec.importAnchor=process.env.ANCHOR;
      spec.importAfter=process.env.AFTER==="1";
      spec.importBlock=fs.readFileSync(process.env.BLOCKFILE,"utf8"); }
    spec.stubs=(process.env.STUBS||"").split("\n").filter(Boolean).map((e)=>{
      const i=e.indexOf("|"); const route=e.slice(0,i);
      const block=fs.readFileSync(e.slice(i+1),"utf8").replace(/\n$/,"");
      return { route, block };
    });
    fs.writeFileSync(process.env.OUTF+".spec.json", JSON.stringify(spec));
  ' || die "could not build the spec for $path"
  # progress to stderr: stdout of this function is captured as the blob SHA
  node "$WORK/gate.mjs" "$out.out.spec.json" >&2 || die "could not rebuild $path from HEAD (anchors changed?)"
  git hash-object -w "$out.out"
}

cat > "$WORK/stub-void.txt" <<'STUB'
// REMOVED 2026-07-25. This route called `rentalAgreementsService.deletePaymentHard`,
// which HAS NEVER EXISTED anywhere in the codebase — every call threw TypeError
// and returned 500. Same bug class as the removed `adjustCustomerCredit`
// (RES-849093 FIX 3c), and retired the same way rather than left as a dead
// route that 500s. No frontend calls it.
// To void a payment for bookkeeping (no refund), use the ADMIN-only
//   POST /api/reservations/:id/payments/:paymentId/void-no-refund
// which soft-voids with a mandatory reason and a full AuditLog entry.
// For a real card refund use POST /:id/payments/:paymentId/refund.
rentalAgreementsRouter.post('/:id/payments/:paymentId/void', async (req, res) => {
  res.status(410).json({
    error: 'Endpoint removed. Use POST /api/reservations/:id/payments/:paymentId/void-no-refund (admin, soft void with reason + audit), or /refund for a real card refund.'
  });
});
STUB
cat > "$WORK/stub-delete.txt" <<'STUB'
// PAYMENT_ACTION_COMPAT_ROUTES
// REMOVED 2026-07-25 — same story as /void above: `deletePaymentHard` does not
// exist, so this always 500'd. Retired as a 410 rather than left dead.
// The working equivalent is POST /api/reservations/:id/payments/:paymentId/delete.
rentalAgreementsRouter.post('/:id/payments/:paymentId/delete', async (req, res) => {
  res.status(410).json({
    error: 'Endpoint removed. Use POST /api/reservations/:id/payments/:paymentId/delete, or prefer the audited soft void at /void-no-refund.'
  });
});
STUB

# Rationale comments for the two files that gain a brand-new auth import.
cat > "$WORK/blk-rentalagr.txt" <<'BLK'
// Payment Actions gate (2026-07-25). This router is mounted with only
// requireModuleAccess('reservations') (main.js:319), so every money route below
// was reachable by any employee holding the Reservations module — and these are
// byte-for-byte the same service calls as the /api/reservations twins. Gating
// one file and not this one would have been theater.
import { requireCapability } from '../../middleware/auth.js';
BLK
cat > "$WORK/blk-issue.txt" <<'BLK'
// Payment Actions gate (2026-07-25). This router is mounted with only
// requireModuleAccess('issueCenter') (main.js:237), which AGENTS have ON by
// default. issueCenterService.chargeCardOnFile reaches the very same
// rentalAgreementsService.chargeCardOnFile — a real Authorize.Net charge
// against the saved profile — so without this an agent denied the charge on
// the reservation screen could simply do it from Issue Center instead.
import { requireCapability } from '../../middleware/auth.js';
BLK

SHA_RESERVATIONS=$(derive_routes backend/src/modules/reservations/reservations.routes.js \
  '/:id/agreement/payments/charge-card-on-file' '/:id/agreement/security-deposit/capture' \
  '/:id/agreement/security-deposit/release' '/:id/agreement/spin/charge-card-on-file' \
  '/:id/agreement/spin/release-deposit' '/:id/agreement/spin/reauth-deposit' \
  '/:id/agreement/customer/card-on-file' '/:id/payments/:paymentId/delete' \
  '/:id/payments/:paymentId/refund' '/:id/payments/:paymentId/save-card-on-file' \
  '/:id/payments/reconcile-authorizenet' '/:id/payments/charge-card-on-file')

SHA_RENTALAGR=$(derive_routes backend/src/modules/rental-agreements/rental-agreements.routes.js \
  --anchor "import { idempotency } from '../../middleware/idempotency.js';" --after --block "$WORK/blk-rentalagr.txt" \
  --stub "/:id/payments/:paymentId/void|$WORK/stub-void.txt" \
  --stub "/:id/payments/:paymentId/delete|$WORK/stub-delete.txt" \
  '/:id/customer/card-on-file' '/:id/payments/charge-card-on-file' \
  '/:id/security-deposit/capture' '/:id/security-deposit/release' \
  '/:id/payments/:paymentId/refund' '/:id/charge-card-on-file')

SHA_ISSUECENTER=$(derive_routes backend/src/modules/issue-center/issue-center.routes.js \
  --anchor "import { attachPublicRequestMeta, createOptionalIdempotencyGuard, createPublicRateLimitGuard } from '../../middleware/public-endpoint-guards.js';" --after --block "$WORK/blk-issue.txt" \
  '/incidents/:id/charge-card-on-file')

# ── 3. DERIVE schema.prisma: HEAD + only the ModuleAccessAuditLog model ──────
say "2b. rebuild money-route-gate.test.mjs: pins reconciled with what actually ships"
CALLBACK_IN_HEAD=0
[ "$(git show "HEAD:backend/src/modules/payment-gateway/payment-gateway.routes.js" | grep -cF "post('/callback'" || true)" -gt 0 ] && CALLBACK_IN_HEAD=1 || true
cat > "$WORK/pins.mjs" <<'MJS'
// Reconcile money-route-gate.test.mjs PINS with the code this tag actually ships.
//
// The guard asserts "every pin matches the code". That makes it self-validating
// — and it also makes it FAIL when a parallel session edits a pin here to
// describe a code change whose CODE is not in this tag. Two such pins exist:
//
//   1. reservations POST /:id/payments/:paymentId/delete
//      A session retired it to a 410 and moved its pin into EXEMPT. If that
//      retirement is not in HEAD we ship the route LIVE AND GATED, so the pin
//      must go back to B-destructive or the guard lies (and CI fails).
//   2. paymentGateway POST /callback
//      A session deleted the route and removed its pin. If that deletion is not
//      in HEAD the route still exists in the tree we test, so it must stay
//      pinned or Layer 2 reports an unpinned money route.
//
// Both are decided by what is IN HEAD, never by what the working tree says, and
// both are anchored on CONTENT (the route path string) because this file moves.
// Everything else in the file — our m-4 paymentGateway pins, the VozIA refund
// pin, the MOUNT test, allMoney — is left exactly as found.
import fs from 'node:fs';
const [srcFile, outFile] = process.argv.slice(2);
const deleteRetiredInHead = process.env.RETIRED_IN_HEAD === '1';
const callbackInHead      = process.env.CALLBACK_IN_HEAD === '1';
let lines = fs.readFileSync(srcFile, 'utf8').split('\n');
const log = [];

const idxOf = (pred, from = 0) => lines.findIndex((l, i) => i >= from && pred(l, i));
const DELETE_KEY = "'reservations POST /:id/payments/:paymentId/delete'";
const PIN_DELETE =
  "  'reservations POST /:id/payments/:paymentId/delete': ['B-destructive', 'hard-deletes the payment row and its mirror; writes NO AuditLog'],";
const PIN_CALLBACK =
  "  'paymentGateway POST /callback': ['role-admin', 'SPIn webhook receiver; logs and returns ok, no DB write (TODO in-file). Behind the same auth mount, so SPIn cannot actually reach it — recorded, not changed here.'],";

/** Bounds of the EXEMPT map. */
function exemptBounds() {
  const s = idxOf((l) => l.startsWith('const EXEMPT = new Map(['));
  if (s < 0) throw new Error('EXEMPT map not found');
  const e = idxOf((l) => l === ']);', s + 1);
  if (e < 0) throw new Error('end of EXEMPT map not found');
  return [s, e];
}
/** Is <key> an entry of the EXEMPT map? -> its line index, or -1 */
function exemptEntry(key) {
  const [s, e] = exemptBounds();
  return idxOf((l, i) => i > s && i < e && l.includes(key), s + 1);
}
/** Replace a contiguous `  //` comment block starting at `at` with `repl`. */
function replaceCommentBlock(at, repl, what) {
  let n = 0;
  while (at + n < lines.length && /^\s*\/\//.test(lines[at + n])) n++;
  if (n === 0) throw new Error(`expected a comment block for ${what}`);
  lines.splice(at, n, repl);
}

// ── 1. the reservations hard-delete route ───────────────────────────────────
{
  const ex = exemptEntry(DELETE_KEY);
  const pinned = idxOf((l) => l.includes(DELETE_KEY + ':'));
  if (deleteRetiredInHead) {
    if (ex < 0) throw new Error('the 410 is in HEAD but the route is not EXEMPT — pin and code disagree');
    if (pinned >= 0) throw new Error('the 410 is in HEAD yet the route is still pinned as a live money route');
    log.push('delete route: 410 is upstream -> EXEMPT kept as-is');
  } else if (ex >= 0) {
    // Remove the whole EXEMPT entry: back to its `[`, forward to its `]`/`],`.
    let o = ex; while (o > 0 && lines[o].trim() !== '[') o--;
    let c = ex; while (c < lines.length && !/^\s*\],?$/.test(lines[c])) c++;
    const trailed = lines[c].trim() === '],';
    lines.splice(o, c - o + 1);
    if (!trailed) { // it was the last entry: drop the now-dangling comma above
      const [, e2] = exemptBounds();
      if (/^\s*\],$/.test(lines[e2 - 1])) lines[e2 - 1] = lines[e2 - 1].replace(/,$/, '');
    }
    log.push('delete route: removed the foreign EXEMPT entry (its 410 is not in HEAD)');
  }
  if (!deleteRetiredInHead && idxOf((l) => l.includes(DELETE_KEY + ':')) < 0) {
    const hdr = idxOf((l) => l.includes('── Group B — destructive'));
    if (hdr < 0) throw new Error('Group B destructive header not found in PINNED');
    if (/EMPTY ON PURPOSE/.test(lines[hdr + 1] || '')) {
      replaceCommentBlock(hdr + 1, PIN_DELETE, 'the EMPTY ON PURPOSE block');
    } else {
      lines.splice(hdr + 1, 0, PIN_DELETE);
    }
    log.push('delete route: restored the B-destructive pin (route ships live + gated)');
  }
}

// ── 2. the payment-gateway webhook ──────────────────────────────────────────
{
  const KEY = "'paymentGateway POST /callback'";
  const pinned = idxOf((l) => l.includes(KEY + ':'));
  if (callbackInHead && pinned < 0) {
    const gone = idxOf((l) => l.includes('POST /callback was pinned here'));
    if (gone >= 0) replaceCommentBlock(gone, PIN_CALLBACK, 'the /callback GONE note');
    else {
      const after = idxOf((l) => l.includes("'paymentGateway POST /settle'"));
      if (after < 0) throw new Error('cannot place the /callback pin: no /settle anchor');
      lines.splice(after + 1, 0, PIN_CALLBACK);
    }
    log.push('/callback: restored its pin (the route is still in HEAD)');
  } else if (!callbackInHead && pinned >= 0) {
    lines.splice(pinned, 1);
    log.push('/callback: removed its pin (the route is gone from HEAD)');
  } else {
    log.push(`/callback: pin already consistent (inHead=${callbackInHead}, pinned=${pinned >= 0})`);
  }
}

fs.writeFileSync(outFile, lines.join('\n'));
for (const l of log) console.log('   ' + l);
MJS
RETIRED_IN_HEAD="$RETIRED_IN_HEAD" CALLBACK_IN_HEAD="$CALLBACK_IN_HEAD" \
  node "$WORK/pins.mjs" backend/src/lib/money-route-gate.test.mjs "$WORK/pins.out" \
  || die "could not reconcile the money-route-gate pins"
SHA_GATEPINS=$(git hash-object -w "$WORK/pins.out")
ok "pins reconciled (delete-route retired in HEAD=$RETIRED_IN_HEAD, /callback in HEAD=$CALLBACK_IN_HEAD)"

say "3. rebuild schema.prisma: HEAD + only the new model"
git show HEAD:backend/prisma/schema.prisma > "$WORK/schema.head"
cat > "$WORK/schema.mjs" <<'MJS'
import fs from 'node:fs';
const [headFile, treeFile, outFile] = process.argv.slice(2);
const head = fs.readFileSync(headFile, 'utf8');
if (head.includes('model ModuleAccessAuditLog {')) {   // already upstream
  fs.writeFileSync(outFile, head); console.log('   model already in HEAD — schema untouched'); process.exit(0);
}
const tree = fs.readFileSync(treeFile, 'utf8').split('\n');
// content anchors: the doc comment down to the model's closing brace
const start = tree.findIndex((l) => l.startsWith('/// Module-access grant/revoke trail'));
if (start < 0) throw new Error('model doc-comment anchor not found in the working tree');
const open = tree.findIndex((l, i) => i >= start && l.startsWith('model ModuleAccessAuditLog {'));
if (open < 0) throw new Error('model declaration not found after its doc comment');
const end = tree.findIndex((l, i) => i > open && l === '}');
if (end < 0) throw new Error('model closing brace not found');
const block = tree.slice(start, end + 1);
const lines = head.split('\n');
// insert before the PERF telemetry section if present, else append
let at = lines.findIndex((l) => l.startsWith('// PR-5 — Endpoint-level performance telemetry'));
if (at < 0) at = lines.length;
lines.splice(at, 0, ...block, '');
fs.writeFileSync(outFile, lines.join('\n'));
console.log(`   inserted ${block.length} model lines at line ${at + 1}`);
MJS
node "$WORK/schema.mjs" "$WORK/schema.head" backend/prisma/schema.prisma "$WORK/schema.out" \
  || die "could not rebuild schema.prisma"
REM=$(diff "$WORK/schema.head" "$WORK/schema.out" | grep -c '^<' || true)
[ "$REM" = "0" ] || die "rebuilt schema REMOVES $REM line(s) from HEAD — the prisma-format reformat leaked in"
OUTSIDE=$(diff "$WORK/schema.head" "$WORK/schema.out" | grep '^>' \
  | grep -vcE 'ModuleAccessAuditLog|^> *///|^> +(id|tenantId|scope|targetUserId|actorUserId|actorRole|changed|changedAt) |^> +@@index|^> \}|^> $' || true)
[ "$OUTSIDE" = "0" ] || die "rebuilt schema adds $OUTSIDE line(s) outside the model"
SHA_SCHEMA=$(git hash-object -w "$WORK/schema.out")
ok "schema.prisma: nothing removed, additions confined to the model"

# ── 4. DERIVE package.json: HEAD + only our 4 suites ────────────────────────
say "4. rebuild package.json: HEAD + only this change's suites"
git show HEAD:backend/package.json > "$WORK/pkg.head"
cat > "$WORK/pkg.mjs" <<'MJS'
import fs from 'node:fs';
const [headFile, treeFile, outFile] = process.argv.slice(2);
let s = fs.readFileSync(headFile, 'utf8');
const head = JSON.parse(s), tree = JSON.parse(fs.readFileSync(treeFile, 'utf8'));
const KEYS = ['test:money-route-gate','test:payment-actions','test:module-access-audit','test:module-defaults-drift'];
const CHAIN = ['npm run test:money-route-gate','npm run test:payment-actions','npm run test:module-defaults-drift'];

const missing = KEYS.filter((k) => !(k in head.scripts));
if (missing.length) {
  for (const k of missing) if (!(k in tree.scripts)) throw new Error('working tree has no script '+k);
  // textual insert after the LAST script entry so upstream formatting is untouched
  const m = s.match(/\n(\s*)"([^"]+)":\s*("(?:[^"\\]|\\.)*")\n(\s*\})/);
  if (!m) throw new Error('could not locate the end of the scripts block');
  const add = missing.map((k) => `${m[1]}${JSON.stringify(k)}: ${JSON.stringify(tree.scripts[k])}`).join(',\n');
  s = s.replace(m[0], `\n${m[1]}"${m[2]}": ${m[3]},\n${add}\n${m[4]}`);
}
// chain: append ours after test:stale-preauth (content anchor), skip if present
const cur = JSON.parse(s).scripts.test;
const parts = cur.split(' && ');
const at = parts.indexOf('npm run test:stale-preauth');
if (at < 0) throw new Error('chain anchor "npm run test:stale-preauth" missing from HEAD');
const toAdd = CHAIN.filter((c) => !parts.includes(c));
if (toAdd.length) {
  parts.splice(at + 1, 0, ...toAdd);
  s = s.replace(JSON.stringify(cur), JSON.stringify(parts.join(' && ')));
}
const out = JSON.parse(s);
for (const k of Object.keys(head.scripts)) {
  if (!(k in out.scripts)) throw new Error('LOST upstream key ' + k);
  if (k !== 'test' && head.scripts[k] !== out.scripts[k]) throw new Error('MUTATED upstream key ' + k + ' (foreign --test-force-exit leaked in)');
}
const added = Object.keys(out.scripts).filter((k) => !(k in head.scripts)).sort();
if (JSON.stringify(added) !== JSON.stringify(missing.slice().sort())) throw new Error('unexpected keys added: ' + added.join(', '));
const hp = head.scripts.test.split(' && '), op = out.scripts.test.split(' && ');
for (const p of hp) if (!op.includes(p)) throw new Error('chain DROPPED ' + p + ' (test:deposit-rules was lost this way once already)');
for (const p of op) if (!hp.includes(p) && !CHAIN.includes(p)) throw new Error('chain gained a foreign entry: ' + p);
fs.writeFileSync(outFile, s);
console.log(`   +${missing.length} script key(s), +${toAdd.length} chain entr(ies); no upstream key lost or mutated`);
MJS
node "$WORK/pkg.mjs" "$WORK/pkg.head" backend/package.json "$WORK/pkg.out" \
  || die "could not rebuild package.json"
SHA_PKG=$(git hash-object -w "$WORK/pkg.out")
ok "package.json rebuilt from HEAD"

# ── 5. STAGE ────────────────────────────────────────────────────────────────
say "5. staging (explicit list + rebuilt blobs)"
git reset -q
git add -- "${FILES[@]}"
git update-index --add --cacheinfo "100644,$SHA_SCHEMA,backend/prisma/schema.prisma"
git update-index --add --cacheinfo "100644,$SHA_PKG,backend/package.json"
git update-index --add --cacheinfo "100644,$SHA_RESERVATIONS,backend/src/modules/reservations/reservations.routes.js"
git update-index --add --cacheinfo "100644,$SHA_RENTALAGR,backend/src/modules/rental-agreements/rental-agreements.routes.js"
git update-index --add --cacheinfo "100644,$SHA_ISSUECENTER,backend/src/modules/issue-center/issue-center.routes.js"
git update-index --add --cacheinfo "100644,$SHA_GATEPINS,backend/src/lib/money-route-gate.test.mjs"
STAGED=$(git diff --cached --name-only | wc -l | tr -d ' ')
ok "$STAGED files staged"

# ── GUARD A — explicit staging only ─────────────────────────────────────────
say "GUARD A — explicit staging only, nothing forbidden"
# Deliberately NOT a self-grep for the add-everything idiom: this file mentions
# it in its own comments, so grepping $0 always self-matches and the gate fires
# on a clean run. The real invariant is the OUTCOME.
EXPECT=$(( ${#FILES[@]} + 6 ))
[ "$STAGED" = "$EXPECT" ] || die "staged $STAGED, expected $EXPECT (${#FILES[@]} explicit + 5 rebuilt)"
for f in backend/src/main.js \
         backend/src/modules/payment-gateway/payment-gateway.routes.js \
         backend/src/docs/openapi.js \
         backend/src/middleware/tenant-rate-limit.js \
         backend/src/middleware/tenant-rate-limit.test.mjs \
         backend/src/modules/integrations/booking-source/booking-source.test.mjs \
         backend/scripts/tl-rematch-existing.test.mjs \
         doc/kiosk-smart-lookup-prompt-2026-07-19.md \
         doc/sunpass-droplet-connector-plan-2026-06-14.md \
         training/INDEX.md ; do
  [ -z "$(git diff --cached --name-only -- "$f")" ] || die "forbidden file staged: $f"
done
ok "main.js, payment-gateway.routes.js, openapi.js and the unrelated edits are out"

# ── GUARD B — the gates are really on the routes ────────────────────────────
say "GUARD B — every money route carries the gate"
G="requireCapability('paymentActions')"
[ "$(cnt backend/src/modules/reservations/reservations.routes.js "$G")" -ge 11 ] || die "reservations.routes.js: too few gated routes"
[ "$(cnt backend/src/modules/rental-agreements/rental-agreements.routes.js "$G")" -ge 6 ] || die "rental-agreements.routes.js: too few gated routes"
[ "$(cnt backend/src/modules/issue-center/issue-center.routes.js "$G")" -ge 1 ] || die "issue-center.routes.js: charge-card-on-file not gated"
has  backend/src/middleware/auth.js 'export function requireCapability' || die "requireCapability missing from auth.js"
has  backend/src/middleware/auth.js "moduleAccess?.[moduleKey] !== true"  || die "requireCapability is no longer FAIL-CLOSED (the !== true predicate is gone)"
hasnt backend/src/middleware/auth.js 'isServiceAccount) return next()'    || die "a service-account bypass was added to the capability gate"
ok "gates present; requireCapability still fail-closed with no service-account bypass"

# ── GUARD C — the migration (the silent killer) ─────────────────────────────
say "GUARD C — the migration is staged"
[ -n "$(git diff --cached --name-only -- "$MIGRATION")" ] || die "MIGRATION NOT STAGED — deploy would go green with the table missing and the audit silently dead"
has "$MIGRATION" 'CREATE TABLE IF NOT EXISTS "ModuleAccessAuditLog"' || die "migration does not create the table"
[ "$(cnt "$MIGRATION" 'CREATE INDEX IF NOT EXISTS')" = "3" ] || die "migration is missing indexes"
has backend/prisma/schema.prisma 'model ModuleAccessAuditLog {' || die "schema model missing while the migration ships"
ok "migration.sql staged (table + 3 indexes) and the schema model is present"

# ── GUARD D — the 410, handled the way we DETECTED it ──────────────────────
say "GUARD D — the 410 retirement is handled consistently"
if [ "$RETIRED_IN_HEAD" = "1" ]; then
  has backend/src/modules/reservations/reservations.routes.js "$FOREIGN_410_MARK" \
    || die "the 410 is in HEAD but vanished from the staged file — we would be reverting merged work"
  ok "410 is upstream and preserved"
else
  hasnt backend/src/modules/reservations/reservations.routes.js "$FOREIGN_410_MARK" \
    || die "uncommitted foreign 410 leaked into the staged file"
  has backend/src/modules/reservations/reservations.routes.js 'rentalAgreementPayment.delete(' \
    || die "the destructive delete route disappeared without the 410 being in HEAD"
  ok "410 excluded; the delete route ships live and gated"
fi
# Whichever branch we took, the guard's own pin must agree with the code. We do
# not police the pin by hand: test:money-route-gate asserts pin<->code agreement,
# and it runs against the STAGED content in the test step below.

# ── GUARD E — shared files carry OUR change, not someone else's ────────────
say "GUARD E — shared files contain our change and nothing oversized"
bounded() { # <path> <max changed lines> <required marker>
  local p="$1" max="$2" mark="$3"
  has "$p" "$mark" || die "$p no longer contains our marker: $mark"
  local n
  n=$(git diff --cached --numstat -- "$p" | awk '{print $1+$2}')
  [ -n "$n" ] || n=0
  [ "$n" -le "$max" ] || die "$p has $n changed lines (expected <= $max). A parallel session's work is probably mixed in — review it before shipping."
}
bounded frontend/src/app/issues/page.js         90  'capability-lock-hint'
bounded frontend/src/app/people/page.js        140  'buildDefaultUserModuleAccess'
bounded frontend/src/lib/moduleAccess.js       160  'paymentActions'
bounded backend/src/lib/service-account-allowlist.js 60 "payments/:paymentId/refund"
hasnt frontend/src/app/people/page.js 'function buildDefaultUserModuleAccess' \
  || die "People's hardcoded fail-open default map is back — a parallel session reverted the shared builder"
has backend/src/lib/service-account-allowlist.js "['POST', '/api/rental-agreements/:id/payments/:paymentId/refund']" \
  || die "VozIA's refund allowlist entry is missing (Hector kept it deliberately)"
ok "shared files carry our change, within expected bounds"

# ── 6. TEST AGAINST THE STAGED CONTENT (not the working tree) ──────────────
say "GUARD F — every reconciled pin agrees with the code that ships"
# Deliberately NOT relying on test:money-route-gate alone. That suite is the
# belt; this is the braces, and it names the exact contradiction if they diverge.
R_STAGED=backend/src/modules/reservations/reservations.routes.js
G_STAGED=backend/src/lib/money-route-gate.test.mjs
DEL_KEY="'reservations POST /:id/payments/:paymentId/delete'"

# What does the STAGED route file actually do?
if [ "$(cnt "$R_STAGED" 'rentalAgreementPayment.delete(')" -gt 0 ]; then DEL_CODE=live; else DEL_CODE=stub; fi
# What does the STAGED guard claim? (EXEMPT entry vs a PINNED B-destructive line)
DEL_EXEMPT=$(git show ":$G_STAGED" | sed -n '/^const EXEMPT = new Map(\[/,/^\]);/p' | grep -cF "$DEL_KEY" || true)
DEL_PINNED=$(cnt "$G_STAGED" "$DEL_KEY: ['B-destructive'" || true)

case "$DEL_CODE" in
  live)
    [ "$DEL_EXEMPT" = "0" ] || die "COHERENCE: the delete route ships LIVE (a real Prisma delete) but the guard lists it as an EXEMPT 410 stub. The pin lies and CI will fail."
    [ "$DEL_PINNED" = "1" ] || die "COHERENCE: the delete route ships LIVE but is not pinned B-destructive. Layer 2 would report an unpinned money route."
    ok "delete route: code=LIVE+gated, pin=B-destructive, not EXEMPT"
    ;;
  stub)
    [ "$DEL_EXEMPT" = "1" ] || die "COHERENCE: the delete route ships as a 410 stub but is not EXEMPT in the guard."
    [ "$DEL_PINNED" = "0" ] || die "COHERENCE: the delete route ships as a 410 stub yet is pinned as a live B-destructive route."
    ok "delete route: code=410 stub, pin=EXEMPT"
    ;;
esac

# Same check for the SPIn webhook: the guard reads payment-gateway.routes.js from
# the extracted index, and we do not stage that file — so it is HEAD's copy.
CB_KEY="'paymentGateway POST /callback'"
if [ "$CALLBACK_IN_HEAD" = "1" ]; then
  [ "$(cnt "$G_STAGED" "$CB_KEY:")" = "1" ] || die "COHERENCE: /callback still exists in HEAD's payment-gateway.routes.js (which is what the guard will read) but its pin was removed. Layer 2 would report an unpinned money route."
  ok "/callback: route in HEAD, pin present"
else
  [ "$(cnt "$G_STAGED" "$CB_KEY:")" = "0" ] || die "COHERENCE: /callback is gone from HEAD but the guard still pins it."
  ok "/callback: route gone from HEAD, no pin"
fi

# Our own m-4 pins and the VozIA refund pin must have survived the reconciliation.
[ "$(cnt "$G_STAGED" 'paymentGateway POST ')" -ge 8 ] || die "the m-4 payment-gateway pins were lost during reconciliation"
has "$G_STAGED" 'sole gated route on the VozIA service-account allowlist' || die "the VozIA refund pin was lost during reconciliation"
has "$G_STAGED" 'MOUNT — routers whose only protection' || die "the m-4 MOUNT test was lost during reconciliation"
has "$G_STAGED" 'allMoney: true' || die "the allMoney flag was lost during reconciliation"
ok "m-4 pins, MOUNT test, allMoney and the VozIA refund pin all intact"

say "6. running the suites against the STAGED index"
EXTRACT="$WORK/staged"
mkdir -p "$EXTRACT"
git checkout-index -a -f --prefix="$EXTRACT/"
ln -s "$(pwd)/backend/node_modules" "$EXTRACT/backend/node_modules" 2>/dev/null || true
for s in test:money-route-gate test:payment-actions test:service-auth test:module-defaults-drift; do
  ( cd "$EXTRACT/backend" && npm run "$s" >/dev/null 2>&1 ) || die "$s FAILED against the staged content"
  ok "$s"
done
note "test:money-route-gate is self-validating: it fails if any pin disagrees with"
note "the code actually staged, so foreign pins and ours must be consistent."

# ── 7. commit + tag ────────────────────────────────────────────────────────
if [ "${SHIP_DRY_RUN:-0}" = "1" ]; then
  say "DRY RUN — stopping before commit"; git diff --cached --name-status
  printf "\n   Every guard passed. Nothing committed. Tag that WOULD be cut: %s\n\n" "$TAG"; exit 0
fi

say "7. commit + tag $TAG"
git diff --cached --name-status
printf "\n   Ctrl-C now to stop.\n\n"
git commit -m "feat(security): paymentActions capability gate on money-moving routes (MONEY)

Gateway-calling, payment-destroying and card-storing routes were behind
requireModuleAccess('reservations') alone: any employee with the Reservations
module could charge a saved card, capture a deposit or delete a payment record.
Measured in prod first: 43 refunds totalling \$9,618.79, 18 of them by AGENTs.

- requireCapability(): FAIL-CLOSED gate requiring an explicit true. The nav gate
  requireModuleAccess denies only on an explicit false, so a missing key PERMITS
  — unacceptable for the gate that authorizes charging a card.
- paymentActions module: ON for ADMIN/OPS, OFF for AGENT and hosts. ADMIN is
  immune to the tenant switch (anti-self-lockout: releasing a deposit must never
  become impossible company-wide).
- money-route-gate.test.mjs: 3-layer structural guard. Group membership is
  derived from the SERVICE SOURCE transitively, not the route name, so a
  record-only method that starts calling a gateway fails the build.
- ModuleAccessAuditLog (additive migration): who granted the ability to refund,
  and when. Tri-state diff — removing an override is a change, not a no-op.
- Counter paths stay open on purpose: recording an external-POS payment and
  card-present terminal flows are not the system moving money on its own.
- VozIA keeps refund (Hector, with the Fase 6 record in view). Double-gated:
  allowlist + capability. Requires scripts/grant-payment-actions.mjs --apply.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
git tag -a "$TAG" -m "paymentActions capability gate on money-moving routes (MONEY)"

say "8. push"
echo "   git push origin $BRANCH && git push origin $TAG"
echo "   Then: CI green -> deploy -> migrate on 5432 -> grant-payment-actions.mjs --apply <vozia>"
