/**
 * VozIA Fase 3 (2026-07-03) — default-deny endpoint gate for service accounts.
 *
 * A service account (User.isServiceAccount, e.g. the VozIA voice agent) may
 * ONLY call the endpoints enumerated below. Everything else — refunds, voids,
 * deposits, status changes, the payment ALIAS routes, PATCH/DELETE anything —
 * is rejected with 403 by requireAuth (middleware/auth.js) BEFORE any route
 * handler runs. Growing the surface means editing this table, on purpose,
 * in a reviewable diff.
 *
 * Pure + table-driven so the matcher is unit-testable without Express
 * (service-account-allowlist.test.mjs). Patterns tolerate path params
 * (`:param` matches one non-empty segment), an optional trailing slash,
 * and any query string (callers should pass the pathname, but we strip
 * defensively).
 */

const escapeSegment = (seg) => seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function compile(pattern) {
  const body = pattern
    .split('/')
    .map((seg) => (seg.startsWith(':') ? '[^/]+' : escapeSegment(seg)))
    .join('/');
  return new RegExp(`^${body}/?$`);
}

// method → compiled patterns. Keep this list SHORT and explicit.
const ALLOWED = [
  ['GET', '/api/auth/me'],
  ['POST', '/api/auth/refresh'],
  ['GET', '/api/reservations/:id'],
  ['GET', '/api/reservations/:id/payments'],
  ['GET', '/api/reservations/:id/audit-logs'],
  ['GET', '/api/customers'],
  ['GET', '/api/customers/:id'],
  ['GET', '/api/rental-agreements/:id'],
  ['GET', '/api/locations/:id/hours'],
  // Quotes module (Hector, 2026-07-17): VozIA can preview, create, read and
  // CONVERT quotes (a conversion creates a NEW reservation at the quoted
  // price — no payment, no vehicle hold). cancel stays humans-only.
  ['GET', '/api/quotes/preview'],
  ['GET', '/api/quotes'],
  ['GET', '/api/quotes/:id'],
  ['POST', '/api/quotes'],
  ['POST', '/api/quotes/:id/convert'],
  ['POST', '/api/reservations/:id/notes'],
  // W1 (Hector, 2026-07-19): field-whitelisted PATCH — the route enforces that a
  // service account can ONLY set flightNumber/pickupInstructions/contactPhone
  // (vozia-reservation-patch.js). contactEmail is EXCLUDED by Hector's security
  // decision (email changes redirect token-gated pay/sign links — escalate to a
  // human instead). Path-level open, field-level gated.
  ['PATCH', '/api/reservations/:id'],
  // Fase 6 RE-SCOPE (Hector, 2026-07-04): VozIA NEVER captures a card directly.
  // It adjusts the balance and sends the customer a link to pay themselves. So
  // the two direct-charge routes (payments/manual + payments/charge-card-on-file)
  // are REMOVED from this allowlist — a service account can no longer reach them
  // (requireAuth 403s anything not listed here). Instead VozIA gets four benign,
  // link/adjust-only capabilities, each gated by service-payment-guards.js
  // (author+ticketId required + a per-transaction ceiling) and, where money-state
  // changes, the idempotency middleware:
  //   1. send-request-email  → emails the customer a self-pay link (no money moves)
  //   2. refund              → refunds an existing payment (native refund<=original cap)
  //   3. charges             → add service/fee (positive) OR credit (negative); no gateway
  ['POST', '/api/reservations/:id/send-request-email'],
  ['POST', '/api/rental-agreements/:id/payments/:paymentId/refund'],
  ['POST', '/api/reservations/:id/charges'],
  // S27 W-D (Hector, 2026-07-19) — the human-agent workspace operates through
  // this same service account. Each write below has its own payload gate:
  //   cancel        → rides PATCH /api/reservations/:id (already listed above);
  //                   vozia-reservation-ops.js gates it to NEW/CONFIRMED + reason.
  //   reprice-preview → READ-ONLY live-engine diff for a proposed date change.
  //   reschedule    → pre-pickup date/location change; expectedNewTotal
  //                   staleness guard (409 REPRICE_DRIFT) + idempotency.
  //   extend        → existing extend service; author+ticketId + idempotency.
  //   drivers       → replace-all additional drivers (existing service).
  //   available-services → read-only catalog of the reservation's location.
  //   send-detail-email  → on-file email ONLY (extraEmails stripped) + attribution.
  //   customers PATCH    → field-whitelisted (email/address1/address2/city/state/zip)
  //                        via vozia-customer-patch.js; email notifies the OLD
  //                        address (blindaje). SENSITIVE surface — VozIA gates it
  //                        behind supervisor approval on its side.
  ['GET', '/api/reservations/:id/reprice-preview'],
  ['POST', '/api/reservations/:id/reschedule'],
  ['POST', '/api/reservations/:id/extend'],
  ['GET', '/api/reservations/:id/additional-drivers'],
  ['PUT', '/api/reservations/:id/additional-drivers'],
  ['GET', '/api/reservations/:id/available-services'],
  ['POST', '/api/reservations/:id/send-detail-email'],
  ['PATCH', '/api/customers/:id'],
];

// -----------------------------------------------------------------------------
// RESERVED — still DENIED after the Fase 6 re-scope (Hector, 2026-07-04):
//   (PATCH /api/reservations/:id moved to ALLOWED 2026-07-19 — W1 field whitelist)
//   ['POST', '/api/rental-agreements/:id/payments/manual'],          // direct charge — removed
//   ['POST', '/api/rental-agreements/:id/payments/charge-card-on-file'], // direct charge — removed
// -----------------------------------------------------------------------------

const TABLE = new Map();
for (const [method, pattern] of ALLOWED) {
  const key = method.toUpperCase();
  if (!TABLE.has(key)) TABLE.set(key, []);
  TABLE.get(key).push(compile(pattern));
}

export function isAllowedForServiceAccount(method, path) {
  const m = String(method || '').toUpperCase();
  let p = String(path || '').split('?')[0];

  // Hardening (Innovation review 2026-07-03, pre-Fase-6/payments): match on a
  // NORMALIZED pathname so the allowlist can't diverge from what Express
  // actually routes. Express keeps %2F literal in originalUrl but decodes it
  // for the route param, so an encoded-slash id-shaped path ('/123%2Fexport')
  // could sneak a two-segment route past a `[^/]+` param. Decode once, then
  // FAIL CLOSED (deny) on anything with an encoded slash, a decoded slash that
  // survived, a dot-segment ('..'/'.'), or a decode error. This shuts the
  // encoded-path class of bypass permanently before payment routes are gated.
  if (/%2f/i.test(p) || /%2e/i.test(p)) return false;
  try {
    p = decodeURIComponent(p);
  } catch {
    return false; // malformed percent-encoding → deny
  }
  if (p.split('/').some((seg) => seg === '..' || seg === '.')) return false;

  const patterns = TABLE.get(m);
  if (!patterns) return false;
  return patterns.some((re) => re.test(p));
}
