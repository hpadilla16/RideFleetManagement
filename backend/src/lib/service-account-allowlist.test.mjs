// VozIA Fase 3 (2026-07-03) — allowlist matcher matrix.
import test from 'node:test';
import assert from 'node:assert/strict';
import { isAllowedForServiceAccount } from './service-account-allowlist.js';

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
  // Fase 6 RE-SCOPE (2026-07-04): the three link/adjust-only routes are allowed.
  allowed('POST', '/api/reservations/RES-00123/send-request-email');
  allowed('POST', '/api/rental-agreements/cmck11111111111111111111/payments/pay1/refund');
  allowed('POST', '/api/reservations/RES-00123/charges');
});

test('Fase 6 re-scope: link/refund/charge routes open — DIRECT-charge routes now DENIED again', () => {
  // The three benign capabilities VozIA now gets.
  allowed('POST', '/api/reservations/abc123/send-request-email');
  allowed('POST', '/api/rental-agreements/abc123/payments/pay1/refund');
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

test('S28: precheckin staff-complete is allowed; adjacent precheckin surfaces stay denied', () => {
  allowed('POST', '/api/reservations/abc123/precheckin/staff-complete');
  denied('POST', '/api/reservations/abc123/precheckin');          // customer-side flow
  denied('POST', '/api/reservations/abc123/precheckin/reset');
  denied('POST', '/api/reservations/abc123/precheckin/staff-complete/extra'); // nested sneak
  denied('POST', '/api/reservations/abc123/agreement/payments/manual');       // sigue muerto
});
