/**
 * STRUCTURAL GUARD — gateway-calling and record-destroying routes must never
 * ship without an access gate.
 * Run via: npm run test:money-route-gate
 *
 * WHY THIS EXISTS (2026-07-25)
 * The money-mutating routes on /api/reservations and /api/rental-agreements were
 * mounted behind `requireModuleAccess('reservations')` and NOTHING ELSE, so any
 * employee holding the Reservations module could charge a saved card, capture a
 * deposit, or delete a payment record. Nobody decided that; the routes were
 * added one at a time and nobody watched the aggregate. This test watches it.
 *
 * THE RULE (Hector, 2026-07-25)
 *   An AGENT may RECORD what already happened outside the system.
 *   Only ADMIN/OPS may make the system MOVE money at the gateway, or DESTROY
 *   a payment record.
 * Ride Fleet's counter staff collect on an EXTERNAL POS terminal and then key
 * the result into Ride Fleet. Gating the record-only routes would jam the
 * counter, so they stay open; the gateway and destructive routes get the
 * `paymentActions` module.
 *
 * DESIGN — three layers.
 *
 *   Layer 0 (classification integrity — the important one):
 *     Group membership is derived from the SERVICE SOURCE, never from the route
 *     name. Every method listed as money-moving is asserted to actually contain
 *     a gateway call, and every method listed as record-only is asserted to
 *     contain NONE. So the day someone teaches `addManualPayment` to charge a
 *     card, this test fails and forces the route to be reclassified — which is
 *     exactly the failure mode a name-based check would sail straight past.
 *
 *   Layer 1 (semantic gate check):
 *     Any route whose handler reaches a money-moving service method, or which
 *     deletes a payment row, MUST carry a gate. A brand-new
 *     `post('/:id/payments/new-thing', chargeCardOnFile...)` fails immediately
 *     with no human involvement, whatever it is named.
 *
 *   Layer 2 (pinned inventory — forces conscious review):
 *     Every money-touching route is pinned with its GROUP and the REASON.
 *     Adding one is a deliberate two-step: classify + gate, then pin. Changing
 *     a route's group (e.g. a record-only route starts calling the gateway)
 *     breaks the pin even if Layer 1 somehow passed.
 *
 * Deliberately NOT a snapshot of every route in the file: an unrelated new
 * non-money route must not fail this test, or the team learns to update the
 * pin reflexively and the guard rots. Only money routes are pinned.
 *
 * WHERE THE DERIVATION STOPS — read this before trusting Layer 0.
 * Layer 0 indexes exactly the files in SERVICE_FILES: rental-agreements.service
 * and reservation-pricing.service. Its call-graph walk is also FILE-LOCAL, so a
 * gateway call reached through an import from a third file is invisible to it.
 * The practical consequence: a NEW route that imports `spinClient` (or any
 * gateway client) directly, or calls a gateway wrapper living in some other
 * module, is NOT caught by Layer 0 or Layer 1 — it is caught only by Layer 2,
 * and only if its path happens to match MONEY_PATH_RE (or its file is marked
 * `allMoney`). A route named e.g. POST /:id/finalize that charges a card
 * through its own import would slip past all three.
 * So: when a route file starts talking to a gateway on its own, add its service
 * to SERVICE_FILES — or mark the whole file `allMoney` — rather than assuming
 * this suite already sees it.
 *
 * A route counts as GATED if either:
 *   - its registration line carries requireModuleAccess('paymentActions'), or
 *   - its handler applies a role predicate AND can return 403.
 * The second form is strictly stronger (ADMIN-only) and predates this module;
 * it is accepted so the test does not force a behavior change on routes Hector
 * already locked down (Admin Corrections, beta.213).
 *
 * No DB and no app imports — pure source analysis, so it is fast and cannot be
 * defeated by mocking.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, '..');

const MAIN = path.join(SRC, 'main.js');

/**
 * `allMoney` — treat EVERY mutating route in the file as money, regardless of
 * its path or which service it calls. Only for files that are nothing but a
 * payment surface. Without it the classifier's path/service heuristics would
 * cover `/charge`, `/void` and `/refund` but silently skip `/auth-hold`,
 * `/capture`, `/tokenize` and `/settle` — gateway calls every one.
 *
 * `mountProtected` — the file's routes carry no per-route gate; their entire
 * protection is the middleware chain on the `app.use()` mount in main.js. Pins
 * in such a file are verified against that mount instead of the registration
 * line (see the MOUNT test at the bottom).
 */
const ROUTE_FILES = {
  reservations: { file: path.join(SRC, 'modules/reservations/reservations.routes.js') },
  rentalAgreements: { file: path.join(SRC, 'modules/rental-agreements/rental-agreements.routes.js') },
  // Issue Center reaches rentalAgreementsService.chargeCardOnFile through its
  // own service wrapper. Covered here because leaving it out would leave an
  // agent a two-click path to the exact charge this module denies elsewhere.
  issueCenter: { file: path.join(SRC, 'modules/issue-center/issue-center.routes.js') },
  // Checkout sessions run the PHYSICAL terminal. Covered so the decision to
  // leave them open is written down and pinned, rather than looking like a hole
  // nobody noticed. See the CARD-PRESENT note in PINNED.
  checkoutSession: { file: path.join(SRC, 'modules/checkout-session/checkout-session.routes.js') },
  // RAW GATEWAY SURFACE. Nine routes that talk to Spin/Dejavoo directly —
  // /charge, /auth-hold, /capture, /void, /refund, /tokenize, /settle. They are
  // NOT behind paymentActions; their only protection is requireRole('ADMIN',
  // 'OPS') on the mount, which happens to be equivalent to the new rule, so
  // there is no hole TODAY. The reason to cover the file is that without it the
  // guard's promise ("gateway-calling routes must never ship without a gate")
  // was scoped to four files while the most direct gateway surface in the
  // codebase sat outside it: deleting that requireRole would leave this suite
  // green. Now it does not.
  paymentGateway: {
    file: path.join(SRC, 'modules/payment-gateway/payment-gateway.routes.js'),
    allMoney: true,
    mountProtected: '/api/payment-gateway'
  }
};

const SERVICE_FILES = [
  path.join(SRC, 'modules/rental-agreements/rental-agreements.service.js'),
  path.join(SRC, 'modules/reservations/reservation-pricing.service.js')
];

// FAIL-CLOSED gate (requires moduleAccess.paymentActions === true). The
// nav-module gate requireModuleAccess() denies only on an explicit false, so a
// missing key would PERMIT — unacceptable for the gate that authorizes charging
// and refunding a card. See requireCapability in middleware/auth.js.
const MODULE_GATE = "requireCapability('paymentActions')";

/** Role predicates that produce a hard 403 in-handler. */
const ROLE_PREDICATES = [
  'canDoAdminCorrections',
  'isAdminRole',
  'canManageAddendum',
  'canManagePricingOverrides'
];

/**
 * The actual TRANSPORT calls to a payment gateway. Must list EVERY gateway
 * client imported by the service files, or a method whose only gateway is the
 * missing one would classify as record-only and its routes would be waved
 * through ungated.
 * authNetRequest     → Authorize.Net HTTP call
 * iposTransactClient → Spin / Dejavoo iPOS terminal
 * spinClient         → Spin gateway client (imported in rental-agreements.service.js)
 * payarcRefundCharge → PayArc refund (imported in rental-agreements.service.js)
 *
 * Matching only these two, then following calls TRANSITIVELY, is deliberate.
 * The first version of this guard matched idioms inside the service method's
 * own body only (depth 1) and therefore PASSED while asserting something
 * false: `saveCardOnFileFromPayment` reaches the gateway through the local
 * helper `saveAuthNetCardProfileFromReference`, and
 * `reconcileLatestAuthNetReservationPayment` through `authNetTransactionDetails`
 * — both invisible at depth 1. A guard whose load-bearing assertion is a lie is
 * worse than no guard, so classification now walks the local call graph.
 */
const GATEWAY_TRANSPORT_RE =
  /\bauthNetRequest\s*\(|\biposTransactClient\.|\bspinClient\.|\bpayarcRefundCharge\s*\(/;

/**
 * GROUP B — verified to call a gateway. Layer 0 proves each one really does.
 * Any route reaching one of these must be gated.
 */
const MONEY_MOVING_METHODS = [
  'chargeCardOnFile',
  'captureSecurityDeposit',
  'releaseSecurityDeposit',
  'spinChargeCardOnFile',
  'spinReleaseDepositHold',
  'spinReauthDepositHold',
  'refundPayment',
  // Both reach the gateway through a LOCAL HELPER, not in their own body —
  // which is exactly what the depth-1 version of this guard missed:
  //   saveCardOnFileFromPayment -> saveAuthNetCardProfileFromReference
  //                             -> authNetRequest(createCustomerProfileFrom...)
  //   reconcileLatestAuthNetReservationPayment -> authNetTransactionDetails
  //                             -> authNetRequest   (+ the same profile mint)
  // So reconcile-authorizenet is Group B BY CODE. It queries Authorize.Net and
  // mints a stored card profile; it is not merely "gated by decision".
  'saveCardOnFileFromPayment',
  'reconcileLatestAuthNetReservationPayment'
];

/**
 * GROUP A — verified to touch NO gateway: they write rows describing money that
 * already moved on an external POS. Layer 0 proves each one stays clean.
 * These are what the counter uses all day; gating them jams the counter.
 */
const RECORD_ONLY_METHODS = ['postPayment', 'addManualPayment', 'captureCustomerCardOnFile'];

/** Destructive payment writes done inline in the handler. */
const DESTRUCTIVE_RE =
  /(?:rentalAgreementPayment|reservationPayment)\.(?:delete|deleteMany)\(/;

/**
 * Service methods that destroy payment rows. Layer 0 proves each really deletes.
 * Empty today: the only candidate was `deletePaymentHard`, which this guard
 * discovered had NEVER been implemented — the two agreement routes calling it
 * threw TypeError and 500'd. Both are now 410 stubs (see EXEMPT below).
 *
 * As of 2026-07-25 NO route deletes a payment row at all: the last inline
 * Prisma delete (reservations /:id/payments/:paymentId/delete) was retired the
 * same day, so DESTRUCTIVE_RE currently matches nothing either. Both detection
 * paths stay armed for the next one — add a name here if deletion ever moves
 * into a service method.
 */
const DESTRUCTIVE_METHODS = [];

/**
 * Routes that match a money pattern but provably move no money. Each needs a
 * reason — the only sanctioned way to opt out, short on purpose.
 */
const EXEMPT = new Map([
  [
    'reservations POST /:id/agreement/credit',
    'Removed endpoint — bare 410 stub (RES-849093 FIX 3c). No DB access.'
  ],
  ['rentalAgreements POST /:id/credit', 'Removed endpoint — bare 410 stub. No DB access.'],
  [
    'rentalAgreements POST /:id/payments/:paymentId/void',
    'Removed 2026-07-25 — called deletePaymentHard, which never existed (always 500). Now a bare 410 stub.'
  ],
  [
    'rentalAgreements POST /:id/payments/:paymentId/delete',
    'Removed 2026-07-25 — same missing method. Now a bare 410 stub.'
  ]
]);

/**
 * PINNED MONEY-ROUTE INVENTORY (Layer 2).
 *
 * group:
 *   'B-gateway'     → calls a payment gateway. MUST carry the paymentActions gate.
 *   'B-destructive' → deletes/voids a payment record. MUST carry the gate.
 *   'A-record-only' → writes rows only; stays open to agents ON PURPOSE.
 *   'role-admin'    → pre-existing ADMIN-only predicate, stricter than the module.
 *
 * To add a money route: read what the SERVICE does, gate it if it is Group B,
 * then pin it here with a reason. Both steps, on purpose.
 */
const PINNED = {
  // ── Group B — gateway ──────────────────────────────────────────────────────
  'reservations POST /:id/agreement/payments/charge-card-on-file': ['B-gateway', 'AuthNet createTransaction against the saved profile'],
  'reservations POST /:id/payments/charge-card-on-file': ['B-gateway', 'AuthNet createTransaction (alias route)'],
  'reservations POST /:id/agreement/security-deposit/capture': ['B-gateway', 'AuthNet capture of the deposit hold'],
  'reservations POST /:id/agreement/security-deposit/release': ['B-gateway', 'AuthNet voidTransaction releasing the hold'],
  'reservations POST /:id/agreement/spin/charge-card-on-file': ['B-gateway', 'iPOS card-not-present charge'],
  'reservations POST /:id/agreement/spin/release-deposit': ['B-gateway', 'iPOS deposit-hold release'],
  'reservations POST /:id/agreement/spin/reauth-deposit': ['B-gateway', 'iPOS deposit re-authorization'],
  'reservations POST /:id/payments/:paymentId/refund': ['B-gateway', 'AuthNet refund/void — moves money OUT'],
  'rentalAgreements POST /:id/payments/charge-card-on-file': ['B-gateway', 'AuthNet charge (twin of the reservations route)'],
  'rentalAgreements POST /:id/charge-card-on-file': ['B-gateway', 'AuthNet charge (second alias)'],
  'rentalAgreements POST /:id/security-deposit/capture': ['B-gateway', 'AuthNet deposit capture'],
  'rentalAgreements POST /:id/security-deposit/release': ['B-gateway', 'AuthNet deposit release'],
  // The ONE gated route a service account can also reach: it is on the VozIA
  // allowlist (Hector 2026-07-25 — kept, with the full Fase 6 record in view).
  // DOUBLE-GATED: the allowlist admits the path, requireCapability still demands
  // the module, so the account must be granted it explicitly. Verified end to
  // end in modules/auth/service-auth.test.mjs.
  'rentalAgreements POST /:id/payments/:paymentId/refund': ['B-gateway', 'AuthNet refund — moves money OUT; also the sole gated route on the VozIA service-account allowlist (allowlist ∧ paymentActions)'],

  // ── Group B — destructive ──────────────────────────────────────────────────
  'reservations POST /:id/payments/:paymentId/delete': ['B-destructive', 'hard-deletes the payment row and its mirror; writes NO AuditLog'],
  'reservations POST /:id/payments/reconcile-authorizenet': ['B-gateway', 'queries AuthNet via authNetTransactionDetails and mints a stored card profile'],
  'reservations POST /:id/payments/:paymentId/save-card-on-file': ['B-gateway', 'mints a reusable AuthNet card profile via saveAuthNetCardProfileFromReference'],

  // ── Group A — record-only, DELIBERATELY UNGATED ────────────────────────────
  // Ride Fleet counters collect on an external POS and key the result in here.
  'reservations POST /:id/payments': ['A-record-only', 'postPayment: writes a ReservationPayment row, recomputes balance. No gateway. 63% of counter collections.'],
  'reservations POST /:id/agreement/payments/manual': ['A-record-only', 'addManualPayment: row write + audit only. No gateway.'],
  'reservations POST /:id/request-payment': ['A-record-only', 'mints a 2-day customer self-service token. No money, no record.'],
  'rentalAgreements POST /:id/payments/manual': ['A-record-only', 'addManualPayment twin. No gateway.'],

  // ── Group B — stores a REUSABLE payment credential ────────────────────────
  // These make no gateway call, so they are not "moving money" — but they are
  // not "recording what happened on the external POS" either. They mint a
  // credential that the Group B charge routes can then bill without the
  // customer present, so they are the ARMING step and belong behind the gate.
  // Checked before gating: the counter's real card capture happens in
  // /api/checkout-sessions (untouched); save-card-on-file is only reachable
  // from the View Payments admin tool, and the two customer/card-on-file
  // routes have NO frontend caller at all.
  'reservations POST /:id/agreement/customer/card-on-file': ['B-credential', 'attaches AuthNet profile IDs to the customer; no gateway call, no frontend caller'],
  'rentalAgreements POST /:id/customer/card-on-file': ['B-credential', 'twin of the above; no frontend caller'],

  // ── Pre-existing ADMIN-only predicates (stricter than the module gate) ─────
  'reservations PUT /:id/pricing': ['role-admin', 'Admin Corrections (beta.213)'],
  'reservations POST /:id/charges': ['role-admin', 'Admin Corrections + VozIA service carve-out'],
  'reservations POST /:id/charges/:chargeId/void': ['role-admin', 'Admin Corrections'],
  'reservations POST /:id/payments/:paymentId/void-no-refund': ['role-admin', 'Admin Corrections'],
  'rentalAgreements POST /:id/commission-owner': ['role-admin', 'commission reassignment'],
  'rentalAgreements POST /:id/addendums/:addendumId/void': ['role-admin', 'canManageAddendum'],

  // ── Issue Center ───────────────────────────────────────────────────────────
  'issueCenter POST /incidents/:id/charge-card-on-file': ['B-gateway', 'issueCenterService.chargeCardOnFile delegates to rentalAgreementsService.chargeCardOnFile — the identical AuthNet charge. Was the two-click bypass of this whole module.'],
  'issueCenter POST /incidents/:id/charge-draft': ['A-record-only', 'sets the amount the route above charges; writes charge lines (allowClosed), no gateway. Pre-existing openness — flagged, not changed here.'],

  // ── CARD-PRESENT — deliberately OPEN, and that is the correct call ─────────
  // These run against the PHYSICAL Spin/Dejavoo terminal and require a FRESH
  // TAP from the customer standing at the counter. Hector's rule gates the
  // system MOVING money on its own (card-not-present against a stored profile);
  // a customer physically presenting their card is the opposite situation, and
  // is in fact the authorization. Gating these would jam every checkout.
  // The record-manual-* pair writes rows for money taken on the terminal — the
  // same external-POS bookkeeping as postPayment.
  // Pinned so this reads as a DECISION, not as a hole nobody noticed.
  'checkoutSession POST /:id/charge': ['A-card-present', 'terminal sale + deposit preauth, customer taps at the counter'],
  'checkoutSession POST /:id/charge-sale': ['A-card-present', 'terminal sale, customer taps at the counter'],
  'checkoutSession POST /:id/hold-deposit': ['A-card-present', 'deposit pre-auth on a freshly presented card'],
  'checkoutSession POST /:id/record-manual-payment': ['A-record-only', 'records money already taken on the terminal'],
  'checkoutSession POST /:id/record-manual-deposit': ['A-record-only', 'records a deposit already taken on the terminal'],

  // ── Money-adjacent, no gateway, left as found ─────────────────────────────
  'rentalAgreements POST /:id/charges': ['A-record-only', 'replaceCharges: rewrites charge lines (what is owed), no payment/gateway. Pre-existing openness, unchanged by this task.'],

  // ── RAW GATEWAY ROUTER — protected by the MOUNT, not by a per-route gate ──
  // Every one of these is at least as sensitive as the routes above; the
  // difference is only WHERE the check lives. main.js mounts the whole router
  // behind requireRole('ADMIN', 'OPS'), which today grants exactly the same
  // audience as paymentActions defaults to. Pinned as 'role-admin' and verified
  // against the mount by the MOUNT test below, so removing that requireRole
  // fails this suite instead of passing silently.
  'paymentGateway POST /charge': ['role-admin', 'paymentGatewayService.chargeReservation — direct Spin/Dejavoo sale'],
  'paymentGateway POST /auth-hold': ['role-admin', 'direct deposit pre-authorization'],
  'paymentGateway POST /capture': ['role-admin', 'captures a previously authorized hold'],
  'paymentGateway POST /void': ['role-admin', 'voids a gateway transaction'],
  'paymentGateway POST /refund': ['role-admin', 'moves money OUT at the gateway'],
  'paymentGateway POST /tokenize': ['role-admin', 'mints a reusable card token — the ARMING step, same class as save-card-on-file'],
  'paymentGateway POST /settle': ['role-admin', 'settles the terminal batch'],
  'paymentGateway POST /callback': ['role-admin', 'SPIn webhook receiver; logs and returns ok, no DB write (TODO in-file). Behind the same auth mount, so SPIn cannot actually reach it — recorded, not changed here.'],
  'paymentGateway POST /ops-queue/:id/resolve': ['role-admin', 'marks a stranded hold / orphan payment resolved; no gateway call']
};

/** Path/body signals used only to decide what belongs in the inventory. */
const MONEY_PATH_RE =
  /payment|refund|deposit|card-on-file|charge|credit|reconcile|void|pricing|commission/i;

function methodCallRe(names) {
  return new RegExp(`\\.(?:${names.join('|')})\\(`);
}

/**
 * Extract every route registration and its handler body. Body runs to the next
 * `});` at column 0 — this codebase's consistent route terminator.
 */
export function parseRoutes(source, label, { allMoney = false } = {}) {
  const routes = [];
  const re = /^(\w+Router)\.(post|put|patch|delete)\(\s*'([^']+)'(.*)$/gm;
  let m;
  while ((m = re.exec(source)) !== null) {
    const [, , method, routePath, tail] = m;
    const rest = source.slice(m.index);
    const endRel = rest.indexOf('\n});');
    routes.push({
      key: `${label} ${method.toUpperCase()} ${routePath}`,
      path: routePath,
      alwaysMoney: allMoney,
      registrationTail: tail,
      body: endRel === -1 ? rest : rest.slice(0, endRel)
    });
  }
  return routes;
}

/**
 * Pull top-level `function name(...)` / `async function name(...)` bodies out of
 * a service file. Body runs to the next `}` at column 0 — the file is
 * prettier-formatted, so that is an exact terminator for a top-level function.
 */
export function parseTopLevelFunctions(source) {
  const out = {};
  const re = /^(?:export )?(?:async )?function (\w+)\s*\(/gm;
  let m;
  while ((m = re.exec(source)) !== null) {
    const rest = source.slice(m.index);
    const end = rest.indexOf('\n}');
    out[m[1]] = end === -1 ? rest : rest.slice(0, end);
  }
  return out;
}

/**
 * Names of the local functions in one file that reach a payment gateway, either
 * directly or through other local functions. Seeded with the direct transport
 * callers, then propagated to a fixed point.
 */
export function gatewayFunctionNames(source) {
  const fns = parseTopLevelFunctions(source);
  const names = Object.keys(fns);
  const gateway = new Set(names.filter((n) => GATEWAY_TRANSPORT_RE.test(fns[n])));
  // authNetRequest is the transport itself; its own body does not name it.
  if (fns.authNetRequest) gateway.add('authNetRequest');

  let changed = true;
  while (changed) {
    changed = false;
    for (const n of names) {
      if (gateway.has(n)) continue;
      for (const g of gateway) {
        if (new RegExp(`\\b${g}\\s*\\(`).test(fns[n])) {
          gateway.add(n);
          changed = true;
          break;
        }
      }
    }
  }
  return gateway;
}

/** Does this method body reach a gateway, directly or via a local helper? */
export function reachesGateway(body, gateway) {
  if (GATEWAY_TRANSPORT_RE.test(body)) return true;
  for (const g of gateway) {
    if (new RegExp(`\\b${g}\\s*\\(`).test(body)) return true;
  }
  return false;
}

/** Pull `async methodName(...) { ... }` bodies out of a service file. */
export function parseServiceMethods(source) {
  const out = {};
  const re = /^ {2}async (\w+)\(/gm;
  const hits = [...source.matchAll(re)];
  hits.forEach((m, i) => {
    const start = m.index;
    const end = i + 1 < hits.length ? hits[i + 1].index : source.length;
    out[m[1]] = source.slice(start, end);
  });
  return out;
}

export function isMoneyRoute(route) {
  return (
    route.alwaysMoney === true ||
    MONEY_PATH_RE.test(route.path) ||
    methodCallRe([...MONEY_MOVING_METHODS, ...RECORD_ONLY_METHODS, ...DESTRUCTIVE_METHODS]).test(
      route.body
    ) ||
    DESTRUCTIVE_RE.test(route.body)
  );
}

/** Layer 1: does the CODE say this route must be gated? */
/**
 * `destructiveMethods` is injectable so the delegation-detection mechanism stays
 * under test even while the real list is empty (see DESTRUCTIVE_METHODS). The
 * day deletion moves back into a service method, the mechanism is already
 * proven to work.
 */
export function requiresGate(route, destructiveMethods = DESTRUCTIVE_METHODS) {
  if (methodCallRe(MONEY_MOVING_METHODS).test(route.body)) return 'B-gateway';
  if (
    DESTRUCTIVE_RE.test(route.body) ||
    (destructiveMethods.length && methodCallRe(destructiveMethods).test(route.body))
  ) {
    return 'B-destructive';
  }
  return null;
}

export function isGated(route) {
  if (route.registrationTail.includes(MODULE_GATE)) return 'module';
  const usesPredicate = ROLE_PREDICATES.some((p) => route.body.includes(`${p}(`));
  if (usesPredicate && /status\(403\)/.test(route.body)) return 'role';
  return null;
}

function analyze() {
  const all = [];
  for (const [label, cfg] of Object.entries(ROUTE_FILES)) {
    all.push(...parseRoutes(fs.readFileSync(cfg.file, 'utf8'), label, { allMoney: !!cfg.allMoney }));
  }
  return { all, money: all.filter((r) => isMoneyRoute(r) && !EXEMPT.has(r.key)) };
}

if (process.env.DUMP_MONEY_ROUTES) {
  const { money } = analyze();
  for (const r of money) {
    console.log(
      [r.key, `requiresGate=${requiresGate(r) || '-'}`, `gated=${isGated(r) || 'NONE'}`].join('  |  ')
    );
  }
}

// ── Layer 0 — classification integrity ───────────────────────────────────────

/**
 * Build { methodName: reachesGateway } across the service files, resolving each
 * file's local call graph first (functions are file-scoped).
 */
export function buildServiceIndex() {
  const methods = {};
  const gatewayReach = {};
  for (const f of SERVICE_FILES) {
    const source = fs.readFileSync(f, 'utf8');
    const gateway = gatewayFunctionNames(source);
    for (const [name, body] of Object.entries(parseServiceMethods(source))) {
      methods[name] = body;
      gatewayReach[name] = reachesGateway(body, gateway);
    }
  }
  return { methods, gatewayReach };
}

if (process.env.DUMP_SERVICE_GATEWAY) {
  const { gatewayReach } = buildServiceIndex();
  for (const m of [...MONEY_MOVING_METHODS, ...RECORD_ONLY_METHODS]) {
    console.log(`${m.padEnd(42)} reachesGateway=${gatewayReach[m]}`);
  }
}

test('Layer 0 — every money-moving method really does reach a gateway', () => {
  const { methods, gatewayReach } = buildServiceIndex();

  const missing = MONEY_MOVING_METHODS.filter((m) => !methods[m]);
  assert.deepEqual(missing, [], `method(s) not found in the service sources: ${missing.join(', ')}`);

  const notGateway = MONEY_MOVING_METHODS.filter((m) => !gatewayReach[m]);
  assert.deepEqual(
    notGateway,
    [],
    'Listed as money-moving but no gateway call found (directly or via a local helper):\n' +
      notGateway.map((m) => `  - ${m}`).join('\n') +
      '\n\nEither the method stopped calling the gateway (move it to ' +
      'RECORD_ONLY_METHODS and re-evaluate its routes) or the transport idiom changed.'
  );
});

test('Layer 0 — every destructive method really does delete payment rows', () => {
  const methods = {};
  for (const f of SERVICE_FILES) Object.assign(methods, parseServiceMethods(fs.readFileSync(f, 'utf8')));

  const missing = DESTRUCTIVE_METHODS.filter((m) => !methods[m]);
  assert.deepEqual(missing, [], `method(s) not found in the service sources: ${missing.join(', ')}`);

  const notDestructive = DESTRUCTIVE_METHODS.filter((m) => !/\.(?:delete|deleteMany)\(/.test(methods[m]));
  assert.deepEqual(
    notDestructive,
    [],
    'Listed as destructive but no delete found:\n' + notDestructive.map((m) => `  - ${m}`).join('\n')
  );
});

test('Layer 0 — every record-only method stays free of gateway calls, at ANY depth', () => {
  const { methods, gatewayReach } = buildServiceIndex();

  const missing = RECORD_ONLY_METHODS.filter((m) => !methods[m]);
  assert.deepEqual(missing, [], `method(s) not found in the service sources: ${missing.join(', ')}`);

  const leaked = RECORD_ONLY_METHODS.filter((m) => gatewayReach[m]);
  assert.deepEqual(
    leaked,
    [],
    'A RECORD-ONLY method now calls a payment gateway:\n' +
      leaked.map((m) => `  - ${m}`).join('\n') +
      '\n\nThis is the exact regression this guard exists to catch. Agents can ' +
      'reach these methods. Either revert the gateway call, or move the method ' +
      'to MONEY_MOVING_METHODS and gate every route that reaches it.'
  );
});

// ── Layer 1 — semantic gate check ────────────────────────────────────────────

test('Layer 1 — every gateway-calling or destructive route carries a gate', () => {
  const { money } = analyze();
  const ungated = money
    .filter((r) => requiresGate(r) && !isGated(r))
    .map((r) => `${r.key}  (${requiresGate(r)})`);
  assert.deepEqual(
    ungated,
    [],
    'UNGATED GATEWAY/DESTRUCTIVE ROUTE(S):\n' +
      ungated.map((k) => `  - ${k}`).join('\n') +
      `\n\nAdd ${MODULE_GATE} to the route registration, then pin it below.`
  );
});

// ── Layer 2 — pinned inventory ───────────────────────────────────────────────

test('Layer 2 — the money-route inventory matches the pinned list', () => {
  const { money } = analyze();
  const found = money.map((r) => r.key);

  const added = found.filter((k) => !(k in PINNED));
  const removed = Object.keys(PINNED).filter((k) => !found.includes(k));

  assert.deepEqual(
    added,
    [],
    'NEW money route(s) not in the pinned inventory:\n' +
      added.map((k) => `  - ${k}`).join('\n') +
      '\n\nRead what the SERVICE does (not what the route is called). If it ' +
      'reaches a gateway or deletes a payment, gate it as Group B. If it only ' +
      'records what already happened, it may stay open — but pin it either way.'
  );
  assert.deepEqual(
    removed,
    [],
    'Pinned money route(s) no longer detected:\n' +
      removed.map((k) => `  - ${k}`).join('\n') +
      '\n\nIf deleted, remove from PINNED. If renamed or its handler changed so ' +
      'the classifier no longer sees money, VERIFY THE GATE BY HAND first.'
  );
});

test('Layer 2 — pinned Group B routes are gated, Group A routes are not silently gated', () => {
  const { money } = analyze();
  const byKey = Object.fromEntries(money.map((r) => [r.key, r]));

  const bUngated = [];
  const aGated = [];
  const roleUngated = [];
  for (const [key, [group]] of Object.entries(PINNED)) {
    const route = byKey[key];
    if (!route) continue; // covered by the inventory test
    if (group.startsWith('B-') && !isGated(route)) bUngated.push(key);
    // Any A-* group must stay ungated: gating a record-only or card-present
    // route is what jams the counter.
    if (group.startsWith('A-') && isGated(route) === 'module') aGated.push(key);
    // 'role-admin' claims a stricter-than-the-module in-handler predicate. Make
    // that claim load-bearing: an unverified label is how a route quietly loses
    // its protection while still reading as protected in the inventory.
    // Mount-protected files are the exception — their check lives in main.js and
    // is verified by the MOUNT test instead.
    const mountProtected = !!ROUTE_FILES[key.split(' ')[0]]?.mountProtected;
    if (group === 'role-admin' && !mountProtected && !isGated(route)) roleUngated.push(key);
  }
  assert.deepEqual(bUngated, [], `Group B route(s) missing a gate:\n${bUngated.join('\n')}`);
  assert.deepEqual(
    roleUngated,
    [],
    'Route(s) pinned as role-admin no longer apply any role predicate:\n' +
      roleUngated.map((k) => `  - ${k}`).join('\n') +
      `\n\nEither restore the predicate, or gate the route with ${MODULE_GATE} ` +
      'and re-pin it as Group B.'
  );
  assert.deepEqual(
    aGated,
    [],
    'Group A (record-only) route(s) picked up the paymentActions gate:\n' +
      aGated.join('\n') +
      '\n\nThese are the counter\'s external-POS bookkeeping paths. Gating them ' +
      'jams the counter (Hector, 2026-07-25). If a gate is genuinely needed, ' +
      'reclassify the pin and say why.'
  );
});

test('sanity — the parser found the routers (guards against a silent no-op)', () => {
  const { all, money } = analyze();
  assert.ok(all.length > 50, `expected >50 parsed routes, got ${all.length}`);
  assert.ok(money.length >= 25, `expected >=25 money routes, got ${money.length}`);
  for (const label of Object.keys(ROUTE_FILES)) {
    assert.ok(all.some((r) => r.key.startsWith(`${label} `)), `parsed no routes from ${label}`);
  }
});

test('MOUNT — routers whose only protection is the mount are still restricted', () => {
  // m-4. The routes in payment-gateway.routes.js carry no per-route gate: the
  // ENTIRE protection is the middleware chain on their app.use() line. isGated()
  // reads registration lines, so it can say nothing about them — which meant the
  // most direct gateway surface in the codebase could be thrown wide open by
  // deleting five tokens from main.js without one test going red.
  //
  // Accepted forms: the ADMIN/OPS role restriction it has today, or the
  // paymentActions capability gate if it is ever migrated to the module.
  const main = fs.readFileSync(MAIN, 'utf8');

  for (const [label, cfg] of Object.entries(ROUTE_FILES)) {
    if (!cfg.mountProtected) continue;

    const line = main
      .split('\n')
      .find((l) => l.includes(`app.use('${cfg.mountProtected}'`));
    assert.ok(
      line,
      `${label}: no app.use('${cfg.mountProtected}', ...) found in main.js. ` +
        'If the mount moved, point mountProtected at the new path — do NOT drop it.'
    );

    const hasRole = /requireRole\(\s*'ADMIN'\s*,\s*'OPS'\s*\)/.test(line);
    const hasCapability = line.includes(MODULE_GATE);
    assert.ok(
      hasRole || hasCapability,
      `${label}: the mount for ${cfg.mountProtected} lost its access restriction.\n` +
        `  ${line.trim()}\n\n` +
        'Every route in that file talks straight to the payment gateway ' +
        '(/charge, /auth-hold, /capture, /void, /refund, /tokenize, /settle) and ' +
        `none of them carries its own gate. Restore requireRole('ADMIN', 'OPS') ` +
        `or put ${MODULE_GATE} on the mount.`
    );
    assert.ok(
      /requireAuth/.test(line),
      `${label}: the mount for ${cfg.mountProtected} lost requireAuth — the gateway would be public.`
    );
  }
});

test('sanity — the parser sees EVERY route registration in each file', () => {
  // The route regex requires the path literal on the SAME LINE as the
  // registration. A prettier reformat that wraps a long registration onto the
  // next line would silently drop that route from the inventory — the guard
  // would go quiet instead of failing, which is the worst possible outcome for
  // a security check. Compare the parsed count against a raw count of
  // registrations and fail loudly if they diverge.
  for (const [label, cfg] of Object.entries(ROUTE_FILES)) {
    const source = fs.readFileSync(cfg.file, 'utf8');
    const raw = (source.match(/^\w+Router\.(?:post|put|patch|delete)\(/gm) || []).length;
    const parsed = parseRoutes(source, label).length;
    assert.equal(
      parsed,
      raw,
      `${label}: parsed ${parsed} routes but the file has ${raw} registrations. ` +
        'A registration was probably reformatted so its path is no longer on the ' +
        'same line as the router call. Fix the parser (or the formatting) — do NOT ' +
        'ignore this: routes missing from the inventory are silently unguarded.'
    );
  }
});

// ── NEGATIVE CONTROLS ────────────────────────────────────────────────────────
// Proof the guard bites. Each feeds synthetic source through the SAME functions
// the real assertions use — weakening the classifier fails these too.

test('negative control — a NEW ungated gateway route is detected', () => {
  const [route] = parseRoutes(
    `
reservationsRouter.post('/:id/payments/new-thing', async (req, res, next) => {
  const row = await rentalAgreementsService.chargeCardOnFile(id, req.body, req.user?.id);
  res.json(row);
});
`,
    'reservations'
  );
  assert.ok(isMoneyRoute(route));
  assert.equal(requiresGate(route), 'B-gateway', 'must be recognised as gateway-calling');
  assert.equal(isGated(route), null, 'must be recognised as UNGATED');
});

test('negative control — an INNOCENT-looking path is still caught via the service call', () => {
  const [route] = parseRoutes(
    `
reservationsRouter.post('/:id/settle', async (req, res, next) => {
  const row = await rentalAgreementsService.spinChargeCardOnFile(id, req.body, actor);
  res.json(row);
});
`,
    'reservations'
  );
  assert.equal(requiresGate(route), 'B-gateway', 'name says nothing about money; the service call does');
  assert.equal(isGated(route), null);
});

test('negative control — a new payment-deleting route is detected', () => {
  const [route] = parseRoutes(
    `
reservationsRouter.post('/:id/cleanup', async (req, res, next) => {
  await prisma.rentalAgreementPayment.deleteMany({ where: { id } });
  res.json({ ok: true });
});
`,
    'reservations'
  );
  assert.equal(requiresGate(route), 'B-destructive');
  assert.equal(isGated(route), null);
});

test('negative control — a route delegating deletion to a service method is detected', () => {
  // The real /:id/payments/:paymentId/void shape: nothing in the handler looks
  // destructive, the damage happens one call away.
  const [route] = parseRoutes(
    `
rentalAgreementsRouter.post('/:id/payments/:paymentId/archive', async (req, res, next) => {
  const row = await rentalAgreementsService.archivePaymentHard(req.params.id, req.params.paymentId, {}, actor);
  res.json(row);
});
`,
    'rentalAgreements'
  );
  assert.equal(
    requiresGate(route, ['archivePaymentHard']),
    'B-destructive',
    'must follow the call into the service'
  );
  assert.equal(isGated(route), null);
});

test('negative control — Layer 0 catches a record-only method that grows a DIRECT gateway call', () => {
  const mutated = `
async function authNetRequest(payload) {
  return fetch(url, payload);
}

  async addManualPayment(id, payload) {
    const authnet = await authNetRequest({ createTransactionRequest: {} });
    return authnet;
  }
  async next() {}
`;
  const gateway = gatewayFunctionNames(mutated);
  const methods = parseServiceMethods(mutated);
  assert.ok(methods.addManualPayment, 'parser must find the method');
  assert.ok(
    reachesGateway(methods.addManualPayment, gateway),
    'Layer 0 must flag a record-only method that starts calling the gateway'
  );
});

test('negative control — Layer 0 catches a gateway call hidden behind a LOCAL HELPER', () => {
  // This is the real bug the depth-1 version shipped with: the method body
  // contains no gateway idiom at all, the helper two calls away does.
  // Mirrors saveCardOnFileFromPayment -> saveAuthNetCardProfileFromReference.
  const mutated = `
async function authNetRequest(payload) {
  return fetch(url, payload);
}

async function saveAuthNetCardProfileFromReference({ reference }) {
  const out = await authNetRequest({ createCustomerProfileFromTransactionRequest: {} });
  return out;
}

async function innocentLookingWrapper(args) {
  return saveAuthNetCardProfileFromReference(args);
}

  async addManualPayment(id, payload) {
    await innocentLookingWrapper({ reference: payload.reference });
    return prisma.rentalAgreementPayment.create({ data: {} });
  }
  async next() {}
`;
  const gateway = gatewayFunctionNames(mutated);
  assert.ok(gateway.has('saveAuthNetCardProfileFromReference'), 'direct caller must be seeded');
  assert.ok(gateway.has('innocentLookingWrapper'), 'transitive caller must propagate');

  const methods = parseServiceMethods(mutated);
  assert.equal(
    GATEWAY_TRANSPORT_RE.test(methods.addManualPayment),
    false,
    'depth-1 sees nothing — this is precisely why the old guard lied'
  );
  assert.ok(
    reachesGateway(methods.addManualPayment, gateway),
    'transitive analysis MUST flag it'
  );
});

test('positive control — gated reads as gated; benign routes are ignored', () => {
  const [g] = parseRoutes(
    `
reservationsRouter.post('/:id/agreement/spin/reauth-deposit', ${MODULE_GATE}, async (req, res, next) => {
  const row = await rentalAgreementsService.spinReauthDepositHold(id, req.body, actor);
  res.json(row);
});
`,
    'reservations'
  );
  assert.equal(requiresGate(g), 'B-gateway');
  assert.equal(isGated(g), 'module');

  const [rec] = parseRoutes(
    `
reservationsRouter.post('/:id/payments', async (req, res, next) => {
  const out = await reservationPricingService.postPayment(id, req.body, scope, actor);
  res.status(201).json(out);
});
`,
    'reservations'
  );
  assert.ok(isMoneyRoute(rec), 'record-only routes still belong in the inventory');
  assert.equal(requiresGate(rec), null, 'but they must NOT be forced to carry a gate');

  const [b] = parseRoutes(
    `
reservationsRouter.post('/:id/notes', async (req, res, next) => {
  const out = await reservationsService.addNote(id, req.body);
  res.json(out);
});
`,
    'reservations'
  );
  assert.equal(isMoneyRoute(b), false, 'a plain notes route must NOT be flagged (no false positives)');
});
