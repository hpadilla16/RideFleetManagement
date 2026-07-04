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
});

test('method casing and trailing slash / query string are tolerated', () => {
  allowed('get', '/api/auth/me');
  allowed('GET', '/api/customers/');
  allowed('GET', '/api/customers?q=perez');
  allowed('GET', '/api/reservations/RES-00123/payments/');
});

test('payment writes are denied (manual + card-on-file + alias routes)', () => {
  denied('POST', '/api/rental-agreements/abc123/payments/manual');
  denied('POST', '/api/rental-agreements/abc123/charge-card-on-file');
  denied('POST', '/api/reservations/abc123/payments'); // GET is allowed, POST is not
  denied('POST', '/api/reservations/abc123/charge-card-on-file');
});

test('mutations are denied: PATCH reservations, void aliases, DELETE anything', () => {
  denied('PATCH', '/api/reservations/abc123');
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
