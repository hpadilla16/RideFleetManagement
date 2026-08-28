/**
 * The allowlist and the mode machine, tested as pure functions.
 *
 * This file exists to make it IMPOSSIBLE to ship a gate that locks out the
 * wrong people. Every assertion below is a named failure mode:
 *   - a paying customer locked out of the page where they pay
 *   - a car on the street with no way to be returned
 *   - the platform owner locked out of the panel that undoes the suspension
 *   - a typo'd deploy variable gating every tenant on the platform
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SUSPENSION_ALLOWLIST,
  SUSPENSION_MODE,
  TENANT_SUSPENDED_CODE,
  evaluateTenantSuspension,
  isAllowedWhileSuspended,
  isSuspensionEnforcementKilled,
  suspensionMode,
  tenantSuspendedResponse,
} from './tenant-suspension.js';

const ENFORCE = { TENANT_SUSPENSION_ENFORCEMENT: 'enforce' };
const SUSPENDED_ADMIN = { id: 'u1', role: 'ADMIN', tenantId: 't1', tenantStatus: 'SUSPENDED' };
const ACTIVE_ADMIN = { id: 'u2', role: 'ADMIN', tenantId: 't1', tenantStatus: 'ACTIVE' };

function decide(user, method, path, env = ENFORCE) {
  return evaluateTenantSuspension({ user, method, path, env });
}

// ── The mode machine ───────────────────────────────────────────────────────

test('DEFAULT IS OFF — an empty env gates nothing', () => {
  assert.equal(suspensionMode({}), SUSPENSION_MODE.OFF);
  assert.equal(decide(SUSPENDED_ADMIN, 'GET', '/api/reports/revenue', {}).action, 'allow');
});

test('an unknown mode value resolves to off, never to enforce', () => {
  // A typo in a deploy variable must not gate the platform. This is the one
  // place in the module that deliberately fails OPEN.
  for (const raw of ['enfroce', 'ENFORCED', 'true', '1', 'yes', 'on', ' ']) {
    assert.equal(suspensionMode({ TENANT_SUSPENSION_ENFORCEMENT: raw }), SUSPENSION_MODE.OFF, raw);
  }
});

test('the kill-switch beats an explicit enforce, in every truthy spelling', () => {
  for (const raw of ['true', 'TRUE', '1', 'yes', ' Yes ']) {
    assert.equal(isSuspensionEnforcementKilled({ TENANT_SUSPENSION_DISABLED: raw }), true, raw);
    assert.equal(
      suspensionMode({ TENANT_SUSPENSION_ENFORCEMENT: 'enforce', TENANT_SUSPENSION_DISABLED: raw }),
      SUSPENSION_MODE.OFF,
      raw,
    );
  }
  // ...and does NOT fire on a value that merely mentions it
  assert.equal(isSuspensionEnforcementKilled({ TENANT_SUSPENSION_DISABLED: 'false' }), false);
});

test('log mode observes without blocking', () => {
  // A path that is NOT on the allowlist, so the only thing keeping it alive is
  // the mode — which is exactly what this test is about.
  const out = decide(SUSPENDED_ADMIN, 'GET', '/api/reports/revenue', { TENANT_SUSPENSION_ENFORCEMENT: 'log' });
  assert.equal(out.action, 'observe');
  assert.equal(out.mode, SUSPENSION_MODE.LOG);
});

// ── Who is never locked out ────────────────────────────────────────────────

test('an ACTIVE tenant is unaffected on every route, in enforce mode', () => {
  for (const [m, p] of [
    ['GET', '/api/reservations'], ['POST', '/api/reservations'], ['GET', '/api/reports/foo'],
    ['PUT', '/api/rates/1'], ['DELETE', '/api/people/9'], ['POST', '/api/settings/anything'],
  ]) {
    assert.equal(decide(ACTIVE_ADMIN, m, p).action, 'allow', `${m} ${p}`);
  }
});

test('SUPER_ADMIN is never locked out of anything — including the undo button', () => {
  const su = { id: 's1', role: 'SUPER_ADMIN', tenantId: 't1', tenantStatus: 'SUSPENDED' };
  assert.equal(decide(su, 'POST', '/api/tenants/billing/t1/restore').action, 'allow');
  assert.equal(decide(su, 'DELETE', '/api/anything/at/all').action, 'allow');
});

test('a GUEST (the tenant\'s own customer) is not punished for the tenant\'s unpaid bill', () => {
  const guest = { id: 'g1', role: 'GUEST', tenantId: 't1', tenantStatus: 'SUSPENDED' };
  assert.equal(decide(guest, 'GET', '/api/public/booking/host-status').action, 'allow');
});

test('a user with no tenant is not judged by a tenant status it does not have', () => {
  assert.equal(decide({ id: 'p1', role: 'ADMIN', tenantId: null }, 'GET', '/api/reservations').action, 'allow');
});

test('impersonation does NOT bypass — the owner sees what the customer sees', () => {
  const imp = { ...SUSPENDED_ADMIN, imp: 'super@ride.com' };
  assert.equal(decide(imp, 'GET', '/api/reports/revenue').action, 'block');
});

test('service accounts do NOT bypass — a suspended tenant\'s integrations stop', () => {
  const svc = { id: 'svc', role: 'AGENT', tenantId: 't1', tenantStatus: 'SUSPENDED', isServiceAccount: true };
  assert.equal(decide(svc, 'GET', '/api/reports/revenue').action, 'block');
});

// ── THE CARVE-OUTS ─────────────────────────────────────────────────────────

test('THE MOST IMPORTANT ENTRY: a suspended tenant can always reach the page where they pay', () => {
  assert.equal(decide(SUSPENDED_ADMIN, 'GET', '/api/billing/self').action, 'allow');
  assert.equal(decide(SUSPENDED_ADMIN, 'POST', '/api/billing/self/payment-link').action, 'allow');
});

test('the session can hydrate, refresh and end — no blank hold screen, no trap', () => {
  for (const [m, p] of [
    ['GET', '/api/auth/me'],
    ['POST', '/api/auth/refresh'],
    ['POST', '/api/auth/logout'],
  ]) {
    assert.equal(decide(SUSPENDED_ADMIN, m, p).action, 'allow', `${m} ${p}`);
  }
});

test('no triple deadlock: password change and both 2FA legs stay open', () => {
  for (const p of [
    '/api/auth/change-password',
    '/api/auth/2fa/verify-login',
    '/api/auth/2fa/enroll/start',
    '/api/auth/2fa/enroll/verify',
  ]) {
    assert.equal(decide(SUSPENDED_ADMIN, 'POST', p).action, 'allow', p);
  }
});

test('staff can still close an open rental and take a return', () => {
  const mustWork = [
    ['GET', '/api/reservations'],
    ['GET', '/api/reservations/r1'],
    ['GET', '/api/reservations/r1/audit-logs'],
    ['GET', '/api/rental-agreements'],
    ['GET', '/api/rental-agreements/a1'],
    ['GET', '/api/rental-agreements/a1/print'],
    ['GET', '/api/vehicles/v1'],
    ['GET', '/api/customers/c1'],
    ['GET', '/api/locations'],
    ['POST', '/api/rental-agreements/a1/inspection'],
    ['POST', '/api/rental-agreements/a1/checkin-close'],
    ['POST', '/api/rental-agreements/a1/close'],
    ['POST', '/api/rental-agreements/a1/finalize'],
    ['POST', '/api/rental-agreements/a1/status'],
    ['POST', '/api/rental-agreements/a1/charges'],
    ['POST', '/api/rental-agreements/a1/payments/manual'],
    ['POST', '/api/rental-agreements/a1/payments/charge-card-on-file'],
    ['POST', '/api/reservations/r1/correct-readings'],
    ['POST', '/api/reservations/r1/notes'],
  ];
  for (const [m, p] of mustWork) {
    assert.equal(decide(SUSPENDED_ADMIN, m, p).action, 'allow', `${m} ${p}`);
  }
});

test('releasing the RENTER\'S deposit is never blocked by the TENANT\'S unpaid invoice', () => {
  // Holding a third party's money hostage over somebody else's bill.
  assert.equal(decide(SUSPENDED_ADMIN, 'POST', '/api/rental-agreements/a1/security-deposit/release').action, 'allow');
});

test('THE LINE: finish what is on the street, start nothing new', () => {
  const mustBlock = [
    ['POST', '/api/reservations'],
    ['POST', '/api/reservations/r1/start-rental'],
    ['POST', '/api/rental-agreements/start-from-reservation/r1'],
    ['POST', '/api/vehicles'],
    ['GET', '/api/reports/revenue'],
    ['GET', '/api/people'],
    ['PUT', '/api/rates/1'],
    ['GET', '/api/settings'],
    ['GET', '/api/market/observations'],
  ];
  for (const [m, p] of mustBlock) {
    assert.equal(decide(SUSPENDED_ADMIN, m, p).action, 'block', `${m} ${p}`);
  }
});

// ── The matcher itself ─────────────────────────────────────────────────────

test('DEFAULT-DENY: a route nobody thought about is blocked, not silently open', () => {
  assert.equal(decide(SUSPENDED_ADMIN, 'GET', '/api/some-module-invented-next-year').action, 'block');
  assert.equal(decide(SUSPENDED_ADMIN, 'GET', '/').action, 'block');
  assert.equal(decide(SUSPENDED_ADMIN, 'GET', '').action, 'block');
});

test('matching is method-exact: DELETE on an allowlisted GET is not a way in', () => {
  assert.equal(isAllowedWhileSuspended('GET', '/api/billing/self'), true);
  assert.equal(isAllowedWhileSuspended('DELETE', '/api/billing/self'), false);
  assert.equal(isAllowedWhileSuspended('POST', '/api/reservations/r1'), false);
});

test('matching is SEGMENT-wise, not substring-wise — no prefix smuggling', () => {
  // The bug an allowlist exists to make impossible.
  assert.equal(isAllowedWhileSuspended('GET', '/api/billing/selfdestruct'), false);
  assert.equal(isAllowedWhileSuspended('GET', '/api/billing/self/secrets'), false);
  assert.equal(isAllowedWhileSuspended('GET', '/api/reservations-export'), false);
  assert.equal(isAllowedWhileSuspended('POST', '/api/rental-agreements/a1/closeXX'), false);
});

test('a :param matches exactly one segment, never zero and never two', () => {
  assert.equal(isAllowedWhileSuspended('GET', '/api/vehicles/v1'), true);
  assert.equal(isAllowedWhileSuspended('GET', '/api/vehicles'), false);
  assert.equal(isAllowedWhileSuspended('GET', '/api/vehicles/v1/history'), false);
});

test('a trailing /* requires at least one further segment', () => {
  assert.equal(isAllowedWhileSuspended('GET', '/api/reservations/r1/charges'), true);
  assert.equal(isAllowedWhileSuspended('GET', '/api/reservations/r1/charges/c9'), true);
  // The bare /api/reservations/:id is matched by its OWN rule, not by the star.
  assert.equal(isAllowedWhileSuspended('GET', '/api/reservations/r1'), true);
});

test('a query string cannot defeat the allowlist', () => {
  assert.equal(isAllowedWhileSuspended('GET', '/api/billing/self?x=1'), true);
  // ...and cannot be used to smuggle a blocked path past it either.
  assert.equal(isAllowedWhileSuspended('GET', '/api/reports?path=/api/billing/self'), false);
});

// ── Hygiene ────────────────────────────────────────────────────────────────

test('every allowlist entry carries a justification', () => {
  for (const r of SUSPENSION_ALLOWLIST) {
    assert.ok(r.why && r.why.length > 20, `rule ${r.method} ${r.path} has no real justification`);
  }
});

test('the allowlist stays small enough for a human to audit in one sitting', () => {
  // Not a style rule. A default-deny list nobody reads is a deny-list with
  // extra steps; if this trips, the growth is the thing to look at.
  //
  // Raised 40 → 50 on 2026-08-28, and the growth WAS looked at. A log-mode run
  // against a suspended tenant with cars still out showed the first pass had
  // reasoned from the route table instead of from the close flow's real calls:
  // the check-in wizard's own reads, and the signature it posts, were missing.
  // Every entry added is a single narrow path. The available consolidations
  // were rejected deliberately — `/api/settings/*` or `/api/tolls/*` would each
  // open a whole module to buy back one line here.
  assert.ok(SUSPENSION_ALLOWLIST.length <= 50, `allowlist has grown to ${SUSPENSION_ALLOWLIST.length} entries`);
});

test('the close flow this group exists for is allowed end to end', () => {
  // Every call the check-in wizard actually makes, read off its source rather
  // than inferred from the route table. This is the test that would have
  // caught the original gap.
  for (const [method, path] of [
    ['GET', '/api/reservations/res1'],
    ['GET', '/api/rental-agreements/ra1'],
    ['GET', '/api/rental-agreements/ra1/inspection-report'],
    ['GET', '/api/settings/customer-inspection'],
    ['GET', '/api/settings/fee-rates'],
    ['GET', '/api/customer-inspections'],
    ['POST', '/api/rental-agreements/ra1/inspection'],
    ['POST', '/api/rental-agreements/ra1/signature'],
    ['POST', '/api/rental-agreements/ra1/checkin-close'],
    ['POST', '/api/rental-agreements/ra1/email-agreement'],
  ]) {
    assert.equal(isAllowedWhileSuspended(method, path), true, `the close needs ${method} ${path}`);
  }
});

test('opening one setting does not open the settings module', () => {
  assert.equal(isAllowedWhileSuspended('GET', '/api/settings/fee-rates'), true);
  assert.equal(isAllowedWhileSuspended('GET', '/api/settings/general'), false);
  assert.equal(isAllowedWhileSuspended('POST', '/api/settings/fee-rates'), false);
});

test('a waiting shuttle passenger can be dispatched, but no new request is taken', () => {
  // Keeping the renter's tracker lit is worthless if nobody on staff can see
  // that they are standing there.
  assert.equal(isAllowedWhileSuspended('GET', '/api/shuttle-requests'), true);
  assert.equal(isAllowedWhileSuspended('POST', '/api/shuttle-requests/req1/assign'), true);
  assert.equal(isAllowedWhileSuspended('GET', '/api/shuttle-monitor/enabled'), true);
  // …and the line this group draws everywhere else still holds.
  assert.equal(isAllowedWhileSuspended('POST', '/api/shuttle-requests'), false);
});

test('the general-purpose reservation PATCH stays blocked', () => {
  // It shows up in a log-mode run because the wizard appends a notes line with
  // it, but that write is non-fatal and `POST /:id/notes` already covers the
  // need. Allowing PATCH would open date, vehicle and price rewrites.
  assert.equal(isAllowedWhileSuspended('PATCH', '/api/reservations/res1'), false);
  assert.equal(isAllowedWhileSuspended('POST', '/api/reservations/res1/notes'), true);
});

test('the app chrome renders — the location switcher is not blocked', () => {
  // AppShell calls this on every page; without it the hold screen and the
  // billing page fail to render along with everything else.
  assert.equal(isAllowedWhileSuspended('GET', '/api/locations/selectable'), true);
});

test('the blocked response carries the distinct catchable code', () => {
  const body = tenantSuspendedResponse();
  assert.equal(body.code, TENANT_SUSPENDED_CODE);
  assert.equal(body.code, 'TENANT_SUSPENDED');
  assert.match(body.error, /Contact Ride/i);
});
