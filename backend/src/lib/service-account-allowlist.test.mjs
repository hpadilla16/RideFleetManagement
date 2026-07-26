// VozIA Fase 3 (2026-07-03) — allowlist matcher matrix.
import test from 'node:test';
import assert from 'node:assert/strict';
import { isAllowedForServiceAccount } from './service-account-allowlist.js';
import { requireCapability } from '../middleware/auth.js';

const allowed = (m, p) => assert.equal(isAllowedForServiceAccount(m, p), true, `${m} ${p} should be ALLOWED`);
const denied = (m, p) => assert.equal(isAllowedForServiceAccount(m, p), false, `${m} ${p} should be DENIED`);

test('every allowlist entry matches with realistic params', () => {
  allowed('GET', '/api/auth/me');
  allowed('POST', '/api/auth/refresh');
  allowed('GET', '/api/reservations/cmcklz2ov0001abcd1234wxyz');
  allowed('GET', '/api/reservations/RES-00123'); // reservationNumber param (Fase 1)
  allowed('GET', '/api/reservations/TL-ZE40809640BA/payments');
  allowed('GET', '/api/reservations/cmcklz2ov0001abcd1234wxyz/audit-logs');
  allowed('GET', '/api/customers');
  allowed('GET', '/api/customers/cmck00000000000000000000');
  allowed('GET', '/api/rental-agreements/cmck11111111111111111111');
  allowed('GET', '/api/locations/loc123/hours');
  allowed('POST', '/api/reservations/RES-00123/notes');
  allowed('PATCH', '/api/reservations/RES-00123'); // W1 field-whitelisted (2026-07-19)
  // Fase 6 RE-SCOPE (2026-07-04): the link/adjust-only routes plus refund.
  allowed('POST', '/api/reservations/RES-00123/send-request-email');
  allowed('POST', '/api/reservations/RES-00123/charges');
  allowed('POST', '/api/rental-agreements/cmck11111111111111111111/payments/pay1/refund');
});

test('REFUND stays allowlisted for service accounts (Hector, 2026-07-25)', () => {
  // KEPT, and this test is the pin. It was briefly removed earlier the same day
  // on the premise that it was a dormant path with no usage; the premise was
  // wrong. doc/session-handoff-2026-07-04-EOD.md records refund as a capability
  // Hector deliberately scoped IN three weeks earlier, with a ceiling
  // (voziaMaxRefundAmount 2000), non-recyclable idempotency, an ops runbook for
  // releasing stuck keys, and an accepted known-risk note. Never-exercised is
  // not the same as dormant. Do not "clean this up" without re-reading that doc.
  allowed('POST', '/api/rental-agreements/abc123/payments/pay1/refund');
  allowed('POST', '/api/rental-agreements/cmck11111111111111111111/payments/pay1/refund');

  // The reservations-side refund TWIN is a different route and was never
  // allowlisted. Keeping it denied is deliberate: one refund path, one set of
  // guards, one thing to audit.
  denied('POST', '/api/reservations/abc123/payments/pay1/refund');
  // Nested sneak past the :paymentId param.
  denied('POST', '/api/rental-agreements/abc123/payments/pay1/refund/extra');
});

// ── THE DOUBLE GATE (2026-07-25) ────────────────────────────────────────────
//
// Restoring the allowlist entry above does NOT by itself let VozIA refund. The
// route carries requireCapability('paymentActions') as well, and the service
// account's role is AGENT, whose role default for that module is FALSE. Two
// independent layers, both of which must pass:
//
//   Layer 1  requireAuth  → isAllowedForServiceAccount(method, path)
//                           "WHICH PATHS may a service account touch"
//   Layer 2  the route    → requireCapability('paymentActions')
//                           "WHICH PRINCIPALS may make the system move money"
//
// Going live therefore takes a DEPLOY STEP, not just this diff:
//   node scripts/grant-payment-actions.mjs --apply <svc-account-email>
// (writes a per-user AppSetting override + a ModuleAccessAuditLog row; takes
// effect within the ~30s session-cache TTL, no restart).
//
// These tests exist so that nobody "fixes" the resulting 403 by punching a
// service-account exemption into requireCapability. That was considered and
// REJECTED: requireCapability's entire reason for existing is that an absent
// key must DENY, and an isServiceAccount bypass would reintroduce exactly the
// fail-open shape it was written to remove — for every service account that
// exists now or is created later, not just this one. The grant is data: scoped
// to one user id, reversible with --revoke, and audited.

/** Minimal express double — mirrors the one in module-access-payment-actions. */
function runGate(middleware, req) {
  const out = { status: null, nextCalled: false };
  const res = {
    status(code) {
      out.status = code;
      return res;
    },
    json() {
      return res;
    }
  };
  middleware(req, res, () => {
    out.nextCalled = true;
  });
  return out;
}

const REFUND_PATH = '/api/rental-agreements/cmck11111111111111111111/payments/pay1/refund';
const gate = requireCapability('paymentActions');
const svcAccount = (moduleAccess) => ({
  role: 'AGENT',
  isServiceAccount: true,
  ...(moduleAccess === undefined ? {} : { moduleAccess })
});

test('DOUBLE GATE — layer 1 admits the refund path for a service account', () => {
  allowed('POST', REFUND_PATH);
});

test('DOUBLE GATE — layer 2 STILL denies an ungranted service account', () => {
  // This is the state the account is in the instant this diff deploys, before
  // the grant script runs. The allowlist says yes, the capability says no, and
  // the request 403s. That is CORRECT, not a bug: it is what makes the grant a
  // deliberate, separately-audited act.
  assert.equal(gate.length, 3, 'requireCapability must return an express middleware');
  assert.equal(runGate(gate, { user: svcAccount({ reservations: true }) }).status, 403);
  assert.equal(runGate(gate, { user: svcAccount() }).status, 403, 'no moduleAccess at all → denied');
  assert.equal(runGate(gate, { user: svcAccount({ paymentActions: false }) }).status, 403);
});

test('DOUBLE GATE — layer 2 passes once the module is granted', () => {
  // What scripts/grant-payment-actions.mjs --apply produces: an explicit true in
  // the per-user override, which getEffectiveModuleAccessForUser surfaces as
  // moduleAccess.paymentActions on the hydrated session (buildSessionUser runs
  // for service accounts exactly as it does for humans).
  const out = runGate(gate, { user: svcAccount({ paymentActions: true }) });
  assert.equal(out.nextCalled, true, 'granted service account reaches the handler');
  assert.equal(out.status, null);
});

test('DOUBLE GATE — requireCapability has NO service-account exemption', () => {
  // The rejected design (option c). If someone adds
  //   if (req.user?.isServiceAccount) return next();
  // to requireCapability, this test goes red. Two identical sessions that differ
  // ONLY by isServiceAccount must be treated identically: being a robot is not
  // a permission.
  const human = { role: 'AGENT', moduleAccess: { reservations: true } };
  const robot = { role: 'AGENT', isServiceAccount: true, moduleAccess: { reservations: true } };
  assert.equal(runGate(gate, { user: human }).status, 403);
  assert.equal(
    runGate(gate, { user: robot }).status,
    403,
    'isServiceAccount must NOT bypass the capability gate — the allowlist is a ' +
      'path filter, not a money authorization. Grant the module instead: ' +
      'scripts/grant-payment-actions.mjs --apply <email>'
  );
});

test('DOUBLE GATE — a grant does not widen the PATH surface', () => {
  // The other half of the containment argument. Holding paymentActions lets the
  // account through layer 2 on every gated route, but layer 1 still admits only
  // the ONE refund path. Every other paymentActions route stays 403 at
  // requireAuth, before any handler runs.
  denied('POST', '/api/rental-agreements/abc123/payments/charge-card-on-file');
  denied('POST', '/api/rental-agreements/abc123/charge-card-on-file');
  denied('POST', '/api/rental-agreements/abc123/security-deposit/capture');
  denied('POST', '/api/rental-agreements/abc123/security-deposit/release');
  denied('POST', '/api/rental-agreements/abc123/customer/card-on-file');
  denied('POST', '/api/reservations/abc123/payments/pay1/refund');
  denied('POST', '/api/reservations/abc123/payments/pay1/delete');
  denied('POST', '/api/reservations/abc123/payments/pay1/save-card-on-file');
  denied('POST', '/api/reservations/abc123/payments/reconcile-authorizenet');
  denied('POST', '/api/reservations/abc123/agreement/security-deposit/capture');
  denied('POST', '/api/reservations/abc123/agreement/security-deposit/release');
  denied('POST', '/api/reservations/abc123/agreement/spin/charge-card-on-file');
  denied('POST', '/api/reservations/abc123/agreement/spin/release-deposit');
  denied('POST', '/api/reservations/abc123/agreement/spin/reauth-deposit');
  denied('POST', '/api/reservations/abc123/agreement/customer/card-on-file');
  denied('POST', '/api/issue-center/incidents/abc123/charge-card-on-file');
});

test('Fase 6 re-scope: link/charge routes open — DIRECT-charge routes now DENIED again', () => {
  // The benign capabilities VozIA still gets.
  allowed('POST', '/api/reservations/abc123/send-request-email');
  allowed('POST', '/api/reservations/abc123/charges');
  // The two DIRECT card-charge routes were REMOVED — DENIED again after re-scope.
  denied('POST', '/api/rental-agreements/abc123/payments/manual');
  denied('POST', '/api/rental-agreements/abc123/payments/charge-card-on-file');
  // The bare /:id/charge-card-on-file ALIAS is NOT allowlisted.
  denied('POST', '/api/rental-agreements/abc123/charge-card-on-file');
  denied('POST', '/api/rental-agreements/abc123/payments/pay1/void');
  denied('POST', '/api/rental-agreements/abc123/payments/pay1/delete');
  denied('POST', '/api/rental-agreements/abc123/security-deposit/capture');
  denied('POST', '/api/rental-agreements/abc123/security-deposit/release');
  // Fase 5 PATCH still reserved/denied.
  allowed('PATCH', '/api/reservations/abc123'); // W1 2026-07-19: path open, FIELD gate en vozia-reservation-patch.js
});

test('method casing and trailing slash / query string are tolerated', () => {
  allowed('get', '/api/auth/me');
  allowed('GET', '/api/customers/');
  allowed('GET', '/api/customers?q=perez');
  allowed('GET', '/api/reservations/RES-00123/payments/');
});

test('direct-charge + payment-write routes stay denied after the Fase 6 re-scope', () => {
  // Both direct card-charge routes are REMOVED — VozIA never captures a card.
  denied('POST', '/api/rental-agreements/abc123/payments/manual');
  denied('POST', '/api/rental-agreements/abc123/payments/charge-card-on-file');
  // The bare /:id/charge-card-on-file ALIAS on rental-agreements is NOT opened.
  denied('POST', '/api/rental-agreements/abc123/charge-card-on-file');
  denied('POST', '/api/reservations/abc123/payments'); // GET is allowed, POST is not
  denied('POST', '/api/reservations/abc123/charge-card-on-file');
});

test('mutations are denied: void aliases, DELETE anything (PATCH reservations moved to ALLOWED in W1)', () => {
  allowed('PATCH', '/api/reservations/abc123'); // W1 2026-07-19: path open, FIELD gate en vozia-reservation-patch.js
  denied('POST', '/api/reservations/abc123/void');
  denied('POST', '/api/reservations/abc123/payments/pay1/void');
  denied('POST', '/api/rental-agreements/abc123/payments/pay1/void');
  denied('POST', '/api/reservations/abc123/admin-transition');
  denied('DELETE', '/api/reservations/abc123');
  denied('DELETE', '/api/customers/abc123');
  denied('DELETE', '/api/locations/abc123');
});

test('other modules and auth admin endpoints are denied', () => {
  denied('GET', '/api/vehicles');
  denied('GET', '/api/reports/list');
  denied('GET', '/api/settings');
  denied('POST', '/api/auth/service-token');
  denied('POST', '/api/auth/service-token/revoke');
  denied('POST', '/api/auth/login');
  denied('GET', '/api/auth/users');
  denied('POST', '/api/reservations'); // create
  denied('POST', '/api/customers');
});

test('path params must be a single non-empty segment', () => {
  denied('GET', '/api/reservations//payments');
  denied('GET', '/api/reservations/a/b/payments');
  denied('GET', '/api/locations//hours');
});

test('garbage input never throws and is denied', () => {
  denied(null, null);
  denied('', '');
  denied('GET', undefined);
  denied('TRACE', '/api/auth/me');
});

test('encoded-slash / dot-segment bypasses are denied (pre-Fase-6 hardening)', () => {
  // %2F is a slash Express decodes for the route param but keeps literal in the
  // raw path — a two-segment route must NOT sneak past a :id param.
  denied('GET', '/api/reservations/123%2Fexport');
  denied('GET', '/api/reservations/123%2fexport');
  denied('POST', '/api/reservations/123%2F..%2Fcharge-card-on-file/notes');
  // dot-segments
  denied('POST', '/api/reservations/123/notes/../charge-card-on-file');
  denied('GET', '/api/reservations/../rental-agreements/abc');
  denied('GET', '/api/reservations/%2e%2e/vehicles');
  // malformed percent-encoding → deny, never throw
  denied('GET', '/api/reservations/%zz');
  // a normal encoded reservationNumber (no slash) still resolves fine
  allowed('GET', '/api/reservations/RES%2D00123'); // %2D = '-'
});

// ── Quotes module surface (Hector, 2026-07-17) ──────────────────────────────

test('quotes: VozIA can preview, create, read, list, and convert', () => {
  allowed('GET', '/api/quotes/preview');
  allowed('GET', '/api/quotes/preview?pickupLocationId=loc1&pickupAt=a&returnAt=b');
  allowed('GET', '/api/quotes');
  allowed('GET', '/api/quotes?customerId=c1&status=ACTIVE');
  allowed('GET', '/api/quotes/Q-1042');
  allowed('GET', '/api/quotes/cmck0001xyz');
  allowed('POST', '/api/quotes');
  allowed('POST', '/api/quotes/Q-1042/convert');
});

test('quotes: cancel and everything else stay humans-only', () => {
  denied('POST', '/api/quotes/Q-1042/cancel');
  denied('POST', '/api/quotes/Q-1042/requote'); // humans-only (Hector 2026-07-17)
  denied('PATCH', '/api/quotes/Q-1042');
  denied('DELETE', '/api/quotes/Q-1042');
  // convert is a single-segment param — a nested path must not sneak through
  denied('POST', '/api/quotes/Q-1042/convert/extra');
});

// ── S27 W-D surface (Hector, 2026-07-19) — agent workspace ──────────────────

test('W-D: reprice-preview, reschedule, extend, drivers, services, detail-email are allowed', () => {
  allowed('GET', '/api/reservations/abc123/reprice-preview');
  allowed('GET', '/api/reservations/abc123/reprice-preview?pickupAt=a&returnAt=b');
  allowed('POST', '/api/reservations/abc123/reschedule');
  allowed('POST', '/api/reservations/abc123/extend');
  allowed('GET', '/api/reservations/abc123/additional-drivers');
  allowed('PUT', '/api/reservations/abc123/additional-drivers');
  allowed('GET', '/api/reservations/abc123/available-services');
  allowed('POST', '/api/reservations/abc123/send-detail-email');
  allowed('PATCH', '/api/customers/cus123');
});

test('W-D: adjacent surfaces stay denied', () => {
  denied('DELETE', '/api/reservations/abc123/extension/ch1'); // extension revert = humans
  denied('DELETE', '/api/reservations/abc123/additional-drivers');
  denied('POST', '/api/customers');                            // create = humans/quotes flow
  denied('DELETE', '/api/customers/cus123');
  denied('POST', '/api/customers/cus123/password-reset');
  denied('POST', '/api/reservations/abc123/admin-transition'); // forced status = admins
  denied('GET', '/api/additional-services');                   // settings-module route = staff
  // nested-path sneaks
  denied('POST', '/api/reservations/abc123/reschedule/extra');
  denied('PATCH', '/api/customers/cus123/credit');
});

// ── S28 mini W-D bis (Hector, 2026-07-19) — kiosk video assist ──────────────

// ── S30 (Hector, 2026-07-19) — smart lookup de confirmación ─────────────────

test('S30: smart-lookup is allowed with query params; nested sneaks denied', () => {
  allowed('GET', '/api/reservations/smart-lookup');
  allowed('GET', '/api/reservations/smart-lookup?code=ZE40809640BA');
  allowed('GET', '/api/reservations/smart-lookup?name=Juan%20Perez&from=2026-07-20&to=2026-08-20');
  denied('POST', '/api/reservations/smart-lookup');           // read-only surface
  denied('GET', '/api/reservations/smart-lookup/extra');
});

test('S28: precheckin staff-complete is allowed; adjacent precheckin surfaces stay denied', () => {
  allowed('POST', '/api/reservations/abc123/precheckin/staff-complete');
  denied('POST', '/api/reservations/abc123/precheckin');          // customer-side flow
  denied('POST', '/api/reservations/abc123/precheckin/reset');
  denied('POST', '/api/reservations/abc123/precheckin/staff-complete/extra'); // nested sneak
  denied('POST', '/api/reservations/abc123/agreement/payments/manual');       // sigue muerto
});
