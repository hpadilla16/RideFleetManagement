/**
 * Tenant suspension gate — the decision half. NO IO, NO PRISMA, NO CLOCK.
 *
 * Tenant Subscriptions Phase 5. This is the highest-blast-radius code in the
 * module: `requireAuth` consults it on EVERY authenticated request, so a bug
 * here does not affect one tenant, it locks every customer out of the product.
 * Everything about the file is arranged around that fact — the decision is pure
 * so it can be tested exhaustively without a database, the default is OFF, and
 * there is a kill-switch that stops enforcement without a deploy.
 *
 * ── THREE MODES, AND THE MIDDLE ONE IS THE POINT ──────────────────────────
 *
 *   off      (DEFAULT) Nothing is gated. The code deploys, runs on every
 *            request, and changes no outcome. This is how Phase 5 ships.
 *   log      The gate decides, LOGS what it WOULD have blocked, and then lets
 *            the request through. This is how the allowlist gets proven
 *            complete against real traffic instead of against my imagination:
 *            run it for a billing cycle, read the log, and every route a real
 *            suspended-tenant workflow needed shows up as a line with a method
 *            and a path. Skipping this step means discovering the gap from a
 *            customer who cannot return a car.
 *   enforce  Blocked requests get 403 TENANT_SUSPENDED.
 *
 * Set with TENANT_SUSPENSION_ENFORCEMENT. Read at CALL TIME, never cached, so a
 * change takes effect on the next request.
 *
 * ── KILL-SWITCH ───────────────────────────────────────────────────────────
 * TENANT_SUSPENSION_DISABLED=true forces `off` regardless of the mode setting,
 * the same shape and the same call-time read as TWO_FACTOR_ENFORCEMENT_DISABLED
 * (lib/two-factor-policy.js:73). Two variables rather than one because they
 * answer different questions under pressure: the mode variable is what an
 * operator sets deliberately, and the kill-switch is what somebody flips at 2am
 * without having to remember what the mode was before. Restoring the mode
 * afterwards is then a no-op rather than a guess.
 *
 * ── DEFAULT-DENY ALLOWLIST, NOT A DENY-LIST ───────────────────────────────
 * A route nobody thought about must fail closed into "blocked". The same shape
 * as PASSWORD_GATE_ALLOWLIST and the service-account allowlist, for the same
 * reason: a deny-list is a list somebody will forget to add to, and the
 * forgotten route will be the one that matters.
 *
 * The counter-pressure is real and is the whole design problem here: a
 * default-deny list that is INCOMPLETE strands a car on the street or locks a
 * paying customer out of the page where they pay. So the allowlist below is
 * enumerated deliberately, entry by entry, each with the reason it is there,
 * and the `log` mode exists to find the entries this file got wrong.
 *
 * ── THE ONE-LINE RULE BEHIND THE OPERATIONAL CARVE-OUT ────────────────────
 * A suspended tenant's staff MAY FINISH WHAT IS ALREADY ON THE STREET. THEY MAY
 * NOT START ANYTHING NEW. Closing a rental, taking a return, doing the return
 * inspection, settling the final bill and releasing the renter's deposit are
 * all allowed. Creating a reservation, starting a rental, editing rates,
 * running reports and everything else are not. That rule is what makes the list
 * decidable when a new route shows up: if it finishes an existing rental it
 * belongs here, otherwise it does not.
 */

/** The machine-readable code. Same convention as PASSWORD_CHANGE_REQUIRED. */
export const TENANT_SUSPENDED_CODE = 'TENANT_SUSPENDED';

export const SUSPENSION_MODE = Object.freeze({
  OFF: 'off',
  LOG: 'log',
  ENFORCE: 'enforce',
});

/**
 * Instant recovery with no redeploy. Read at call time. Accepts the common
 * truthy spellings, exactly like isEnforcementKilled() for 2FA.
 */
export function isSuspensionEnforcementKilled(env = process.env) {
  const raw = String(env.TENANT_SUSPENSION_DISABLED || '').trim().toLowerCase();
  return raw === 'true' || raw === '1' || raw === 'yes';
}

/**
 * Resolve the mode. UNKNOWN VALUES RESOLVE TO `off`, DELIBERATELY.
 *
 * This is the one place in the module that does NOT fail closed, and the
 * asymmetry is intentional: a typo in a deploy variable must not lock every
 * tenant out of the product. Failing closed is right for "which routes may a
 * SUSPENDED tenant reach" (the blast radius is one delinquent tenant) and wrong
 * for "is enforcement on at all" (the blast radius is everybody). A
 * misconfiguration that silently does nothing is recoverable in a minute; one
 * that silently gates the platform is an outage.
 */
export function suspensionMode(env = process.env) {
  if (isSuspensionEnforcementKilled(env)) return SUSPENSION_MODE.OFF;
  const raw = String(env.TENANT_SUSPENSION_ENFORCEMENT || '').trim().toLowerCase();
  if (raw === SUSPENSION_MODE.ENFORCE) return SUSPENSION_MODE.ENFORCE;
  if (raw === SUSPENSION_MODE.LOG) return SUSPENSION_MODE.LOG;
  return SUSPENSION_MODE.OFF;
}

/**
 * ONE ALLOWLIST ENTRY.
 *
 * `method` is '*' or an exact HTTP verb. `path` is matched literally unless it
 * contains `:param` (matches exactly one non-empty segment) or ends in `/*`
 * (matches one or more further segments). There is no free-form regex on
 * purpose: every entry has to be readable at a glance by whoever is deciding,
 * under pressure, whether a suspended tenant can do the thing in front of them.
 */
function rule(method, path, why) {
  return Object.freeze({ method, path, why });
}

/**
 * ══════════════════════════════════════════════════════════════════════════
 * THE ALLOWLIST. Every entry is justified; an entry with no justification is
 * a bug, and the test suite asserts that every rule carries one.
 * ══════════════════════════════════════════════════════════════════════════
 */
export const SUSPENSION_ALLOWLIST = Object.freeze([

  // ── GROUP A — the session itself, and the deadlock this prevents ────────
  //
  // Design §3.3. Without these the app cannot even render the hold screen that
  // explains why it is not working, and a suspended tenant whose admin ALSO
  // has a forced password change or a pending 2FA challenge would be
  // double-bricked: each gate 403s the other's only way out. That exact
  // deadlock is already documented at middleware/auth.js:16-27 for the
  // password/2FA pair; this gate must not reintroduce it as a triple.
  rule('GET', '/api/auth/me',
    'The hold screen cannot render without a session. Blocking /me turns a suspension into a blank page.'),
  rule('POST', '/api/auth/refresh',
    'Otherwise the hold screen expires while the person is reading it and they get a login form with no explanation.'),
  rule('POST', '/api/auth/logout',
    'Never trap someone in a session they cannot leave. Also the only clean way to switch to another tenant account.'),
  rule('POST', '/api/auth/change-password',
    'Deadlock: a suspended tenant whose admin is also on a temp password would have both exits 403d.'),
  rule('POST', '/api/auth/2fa/verify-login',
    'Same deadlock, 2FA leg. The pending-2FA gate already restricts these to the second leg only.'),
  rule('POST', '/api/auth/2fa/enroll/start',
    'Same deadlock: a policy-required enrollment must be completable, or the account is bricked twice over.'),
  rule('POST', '/api/auth/2fa/enroll/verify',
    'Same deadlock, enrollment second leg.'),

  // ── GROUP B — the page where they pay. THE MOST IMPORTANT ENTRY HERE ────
  //
  // The failure mode this whole allowlist exists to prevent has a name:
  // LOCKING A PAYING CUSTOMER OUT OF THE VERY PAGE THAT LETS THEM PAY. A
  // billing gate that blocks the billing page converts a $199 collections
  // problem into a churned account and a support fire, and it does it
  // silently, because the customer's only way to tell us is the channel we
  // just closed.
  rule('GET', '/api/billing/self',
    'Their own status, amount, card on file and the date it lapsed — what the hold screen is made of.'),
  rule('POST', '/api/billing/self/payment-link',
    'The way out. Emails THEM a fresh autopay update link; a suspended session never becomes a card-entry context.'),

  // ── GROUP C — finish what is already on the street ──────────────────────
  //
  // The delinquent party is the rental company. Freezing the return path would
  // strand cars already out with no way to be given back, and it buys no
  // leverage that darkening their booking site (which Tenant.status already
  // does, for free) has not already bought.
  //
  // READS FIRST — you cannot close a rental you cannot open.
  rule('GET', '/api/reservations',
    'The list of what is open. Without it staff cannot find the rental they are closing.'),
  rule('GET', '/api/reservations/:id',
    'The rental being returned.'),
  rule('GET', '/api/reservations/:id/*',
    'Everything hanging off one reservation the close screen reads: charges, payments, audit log, agreement, display data. '
    + 'GET-only and scoped to a single :id, so this is not a door to the module.'),
  rule('GET', '/api/rental-agreements',
    'The open-agreement list — the return queue.'),
  rule('GET', '/api/rental-agreements/:id',
    'The agreement being closed. THIS is the open rental object in this codebase.'),
  rule('GET', '/api/rental-agreements/:id/*',
    'Print, inspection report, addendums, commission — the documents a return produces.'),
  rule('GET', '/api/vehicles/:id',
    'The car coming back: its odometer, fuel and status. Not the fleet list — one vehicle.'),
  rule('GET', '/api/customers/:id',
    'The renter standing at the counter. Not the customer list.'),
  rule('GET', '/api/locations',
    'The return screen needs the location list to render at all. Read-only reference data.'),

  // WRITES — the return itself.
  rule('POST', '/api/rental-agreements/:id/inspection',
    'The return inspection. Refusing it means the damage found at return is never recorded.'),
  rule('POST', '/api/rental-agreements/:id/checkin-close',
    'THE RETURN. This is the single most important write in this group.'),
  rule('POST', '/api/rental-agreements/:id/close',
    'Closing the agreement.'),
  rule('POST', '/api/rental-agreements/:id/finalize',
    'Finalising the closed agreement.'),
  rule('POST', '/api/rental-agreements/:id/status',
    'The status transition a close drives.'),
  rule('POST', '/api/rental-agreements/:id/charges',
    'Fuel, mileage, late and damage charges are discovered AT return. Blocking them closes rentals at the wrong price.'),
  rule('POST', '/api/rental-agreements/:id/payments/manual',
    'Settling the final bill in cash or on the terminal.'),
  rule('POST', '/api/rental-agreements/:id/payments/charge-card-on-file',
    'Settling the final bill on the renter\'s stored card. This runs on the TENANT\'S OWN merchant account, '
    + 'not Ride\'s — a suspended tenant is delinquent to us, not barred from collecting from their own customer.'),
  rule('POST', '/api/rental-agreements/:id/security-deposit/release',
    'GIVING THE RENTER THEIR MONEY BACK. Refusing this would hold a third party\'s deposit hostage over '
    + 'somebody else\'s unpaid invoice. It is the one entry here that would be indefensible to omit.'),
  rule('POST', '/api/reservations/:id/correct-readings',
    'Odometer and fuel readings are entered at return.'),
  rule('POST', '/api/reservations/:id/notes',
    'The note explaining what happened at the return, written while it is happening.'),
  rule('POST', '/api/customer-inspections/:id/*',
    'Reviewing the customer-led return inspection the renter just submitted from their phone.'),

  // DELIBERATELY ABSENT, and this is the line the rule above draws:
  //   POST /api/reservations                      — creating a new booking
  //   POST /api/reservations/:id/start-rental     — putting another car out
  //   POST /api/rental-agreements/start-from-reservation/:id
  //   everything under /api/rates, /api/reports, /api/settings, /api/people…
  // Finish what is out. Start nothing new.
]);

/** Split a rule or request path into non-empty segments. */
function segments(path) {
  return String(path || '').split('/').filter(Boolean);
}

/**
 * Does one rule match this method+path?
 *
 * Segment-wise, never substring-wise. A `startsWith` match would let
 * `/api/billing/self-service-delete-everything` through on the strength of
 * `/api/billing/self`, which is exactly the class of bug an allowlist is
 * supposed to make impossible.
 */
function ruleMatches(r, method, pathSegments) {
  if (r.method !== '*' && r.method !== method) return false;
  const want = segments(r.path);
  const wildcard = want[want.length - 1] === '*';
  const fixed = wildcard ? want.slice(0, -1) : want;

  if (wildcard) {
    // `/a/b/*` requires at least one segment BEYOND the fixed prefix, so it
    // never silently stands in for the bare `/a/b` route.
    if (pathSegments.length <= fixed.length) return false;
  } else if (pathSegments.length !== fixed.length) {
    return false;
  }

  for (let i = 0; i < fixed.length; i += 1) {
    const w = fixed[i];
    if (w.startsWith(':')) {
      // A parameter matches exactly one non-empty segment — and never a
      // literal that a later rule might have meant to match specifically.
      if (!pathSegments[i]) return false;
      continue;
    }
    if (w !== pathSegments[i]) return false;
  }
  return true;
}

/**
 * Is this request one of the things a suspended tenant's staff may still do?
 *
 * @param {string} method HTTP verb, already uppercased by Express.
 * @param {string} path   Path WITHOUT the query string. Callers must strip it —
 *                        `?x=1` in the compared value would defeat every rule,
 *                        which is the bug password-gate.test.mjs pins for the
 *                        password allowlist.
 */
export function isAllowedWhileSuspended(method, path) {
  const m = String(method || '').toUpperCase();
  const segs = segments(String(path || '').split('?')[0]);
  if (segs.length === 0) return false;
  return SUSPENSION_ALLOWLIST.some((r) => ruleMatches(r, m, segs));
}

/**
 * THE WHOLE DECISION, in one pure function.
 *
 * Returns one of:
 *   { action: 'allow' }                          — nothing to do
 *   { action: 'observe', reason, mode: 'log' }   — would have blocked; do not
 *   { action: 'block',  reason }                 — 403 TENANT_SUSPENDED
 *
 * @param {object}  input
 * @param {object}  input.user        the hydrated req.user
 * @param {string}  input.method
 * @param {string}  input.path        already stripped of the query string
 * @param {object} [input.env]        injectable for tests
 */
export function evaluateTenantSuspension({ user, method, path, env = process.env } = {}) {
  const mode = suspensionMode(env);
  if (mode === SUSPENSION_MODE.OFF) return { action: 'allow', reason: 'mode-off' };

  // ── BYPASSES, IN THE ORDER THEY MATTER ────────────────────────────────

  // SUPER_ADMIN. Without this, suspending a tenant would lock the platform
  // owner out of the panel that un-suspends them — the gate would eat its own
  // undo button. Checked FIRST so no later condition can shadow it.
  if (String(user?.role || '').toUpperCase() === 'SUPER_ADMIN') {
    return { action: 'allow', reason: 'super-admin' };
  }

  // GUEST — the magic-link customer token (auth.service.js issueGuestToken).
  // This is the tenant's OWN CUSTOMER, not their staff. The three in-flight
  // customer surfaces the owner carved out (shuttle tracker, T&C signing,
  // pre-check-in) do not pass through requireAuth at all, so the gate cannot
  // reach them; a guest session is the one customer-shaped thing that DOES
  // arrive here, and punishing a renter for their rental company's unpaid
  // invoice is exactly what the carve-out exists to prevent.
  if (String(user?.role || '').toUpperCase() === 'GUEST') {
    return { action: 'allow', reason: 'guest-customer' };
  }

  // A user with no tenant is a platform-level account; there is no tenant
  // status to judge them by and inventing one would be a guess.
  if (!user?.tenantId) return { action: 'allow', reason: 'no-tenant' };

  if (String(user?.tenantStatus || '').toUpperCase() !== 'SUSPENDED') {
    return { action: 'allow', reason: 'tenant-not-suspended' };
  }

  // NOTE ON WHAT IS *NOT* A BYPASS:
  //   - IMPERSONATION (`imp` claim) does not bypass. The owner sees exactly
  //     what the customer sees; he does not need the bypass to fix anything
  //     because he acts as SUPER_ADMIN for that.
  //   - SERVICE ACCOUNTS do not bypass. A suspended tenant's integrations
  //     should stop, and Tenant.status already stops the schedulers.

  if (isAllowedWhileSuspended(method, path)) {
    return { action: 'allow', reason: 'allowlisted' };
  }

  if (mode === SUSPENSION_MODE.LOG) {
    return { action: 'observe', mode: SUSPENSION_MODE.LOG, reason: 'would-block' };
  }
  return { action: 'block', reason: 'suspended' };
}

/**
 * The 403 body. A DISTINCT, CATCHABLE CODE so the frontend renders the hold
 * screen rather than a generic "something went wrong" — the same contract
 * PASSWORD_CHANGE_REQUIRED and VIEW_LOCATION_DENIED already have.
 *
 * The English message is deliberate: it is the fallback a non-React client
 * (RideOps, a curl, a log line) shows, and it must say WHO to contact. The
 * bilingual copy lives in the frontend where the user's language is known.
 */
export function tenantSuspendedResponse() {
  return {
    error: 'This account is on hold for non-payment. Contact Ride to update your payment method and restore access.',
    code: TENANT_SUSPENDED_CODE,
  };
}
