import { test } from 'node:test';
import assert from 'node:assert/strict';
import { prisma } from '../../lib/prisma.js';
import {
  diagramTypeFor,
  VEHICLE_VIEWS,
  customerInspectionService,
  signReservation,
  verifyReservationSig,
} from './customer-inspection.service.js';
import { checkoutSessionService } from '../checkout-session/checkout-session.service.js';

// The reservation-bound resolver signs with vehicleSigSecret(), which FAILS
// CLOSED when no secret is configured. Give the whole suite a deterministic one.
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-for-inspection';

const HOUR_MS = 60 * 60 * 1000;
function hoursUntil(date) { return (new Date(date).getTime() - Date.now()) / HOUR_MS; }
function enabledAppSetting({ where } = {}) {
  return String(where?.key || '').includes('customerInspectionConfig')
    ? { value: JSON.stringify({ enabled: true }) }
    : null;
}

test('diagramTypeFor: maps vehicle type names to diagram families', () => {
  assert.equal(diagramTypeFor('Full Size SUV'), 'suv');
  assert.equal(diagramTypeFor('Compact SUV / Crossover'), 'suv');
  assert.equal(diagramTypeFor('Minivan'), 'van');
  assert.equal(diagramTypeFor('Passenger Van'), 'van');
  assert.equal(diagramTypeFor('Pickup Truck'), 'pickup');
  assert.equal(diagramTypeFor('Pick-up'), 'pickup');
  assert.equal(diagramTypeFor('Economy'), 'sedan');
  assert.equal(diagramTypeFor('Midsize Sedan'), 'sedan');
  assert.equal(diagramTypeFor('Full Size'), 'sedan');
});

test('diagramTypeFor: junk falls back to sedan', () => {
  assert.equal(diagramTypeFor(null), 'sedan');
  assert.equal(diagramTypeFor(''), 'sedan');
  assert.equal(diagramTypeFor('Spaceship'), 'sedan');
});

test('VEHICLE_VIEWS: the five canonical views, frozen', () => {
  assert.deepEqual([...VEHICLE_VIEWS], ['FRONT', 'REAR', 'LEFT', 'RIGHT', 'INTERIOR']);
  assert.ok(Object.isFrozen(VEHICLE_VIEWS));
});

// ---------------------------------------------------------------------------
// closedSession return CONTRACT (kiosk B3b, Innovation R6). The kiosk DONE
// screen renders `result.link` as an on-screen QR; the kiosk suite mocks this
// function, so the field name must be pinned HERE at the source — renaming
// `link` would otherwise keep test:kiosk green while breaking the kiosk QR.
// Runs the REAL sendCustomerInspection against in-memory prisma stubs; email
// delivery goes through the MailerSend HTTP path with a stubbed fetch.
// ---------------------------------------------------------------------------

test('sendCustomerInspection({closedSession:true}) returns { ok, inspectionId, emailTo, expiresAt, link }', async (t) => {
  const prevKey = process.env.MAILERSEND_API_KEY;
  const prevFrom = process.env.MAILERSEND_FROM;
  const prevFetch = globalThis.fetch;
  process.env.MAILERSEND_API_KEY = 'test-key';
  process.env.MAILERSEND_FROM = 'no-reply@test.local';
  globalThis.fetch = async () => ({ ok: true, status: 202, json: async () => ({}), text: async () => '' });
  t.after(() => {
    if (prevKey === undefined) delete process.env.MAILERSEND_API_KEY; else process.env.MAILERSEND_API_KEY = prevKey;
    if (prevFrom === undefined) delete process.env.MAILERSEND_FROM; else process.env.MAILERSEND_FROM = prevFrom;
    globalThis.fetch = prevFetch;
  });

  const resv = {
    id: 'res1', tenantId: 't1', reservationNumber: 'RES-1',
    customer: { id: 'cust1', firstName: 'Maria', lastName: 'G', email: 'maria@example.com' },
    vehicle: { id: 'v1', year: 2025, make: 'Kia', model: 'Soul', plate: 'ABC-123', vehicleType: { name: 'SUV', code: 'S' } },
    rentalAgreement: { id: 'ra1' },
  };
  prisma.checkoutSession.findUnique = async () => ({
    id: 'cs1', tenantId: 't1', reservationId: 'res1', agreementId: 'ra1',
    currentStep: 'CLOSED', events: '[]', reservation: resv,
  });
  // mintHandoffToken appends a session event — no-op it.
  prisma.checkoutSession.update = async ({ data } = {}) => ({ id: 'cs1', ...data });
  prisma.appSetting.findUnique = async ({ where } = {}) => (
    String(where?.key || '').includes('customerInspectionConfig')
      ? { value: JSON.stringify({ enabled: true }) }
      : null
  );
  prisma.customerInspection.findFirst = async () => null; // no dedupe hit
  prisma.customerInspection.create = async ({ data }) => ({ id: 'ci1', ...data });
  prisma.handoffToken.findFirst = async () => null;
  prisma.handoffToken.create = async ({ data }) => ({ id: 'ht1', ...data });

  const result = await customerInspectionService.sendCustomerInspection({
    sessionId: 'cs1', actorUserId: null, closedSession: true,
  });

  assert.equal(result.ok, true);
  assert.equal(result.inspectionId, 'ci1');
  assert.equal(result.emailTo, 'maria@example.com');
  assert.ok(result.expiresAt instanceof Date);
  // THE contract the kiosk QR depends on:
  assert.match(String(result.link), /\/inspect\/.+/, 'closedSession return must carry the public /inspect/:token URL as `link`');
});

// ---------------------------------------------------------------------------
// A1 — configurable, phase-appropriate TTLs (2026-08-22 redesign).
// ---------------------------------------------------------------------------

test('mintHandoffToken: CUSTOMER_INSPECTION checkout token defaults to ~72h', async () => {
  prisma.checkoutSession.findUnique = async () => ({ id: 'cs1', reservationId: 'res1', events: '[]' });
  prisma.checkoutSession.update = async ({ data } = {}) => ({ id: 'cs1', ...data });
  prisma.handoffToken.findFirst = async () => null;
  let created = null;
  prisma.handoffToken.create = async ({ data }) => { created = data; return { id: 'ht1', ...data }; };

  const out = await checkoutSessionService.mintHandoffToken({ sessionId: 'cs1', kind: 'CUSTOMER_INSPECTION', actorUserId: null });
  assert.ok(Math.abs(hoursUntil(out.expiresAt) - 72) < 0.2, `expected ~72h, got ${hoursUntil(out.expiresAt)}h`);
  assert.ok(Math.abs(hoursUntil(created.expiresAt) - 72) < 0.2);
});

test('mintHandoffToken: checkout TTL honors CUSTOMER_INSPECTION_CHECKOUT_TTL_HOURS', async (t) => {
  const prev = process.env.CUSTOMER_INSPECTION_CHECKOUT_TTL_HOURS;
  process.env.CUSTOMER_INSPECTION_CHECKOUT_TTL_HOURS = '100';
  t.after(() => { if (prev === undefined) delete process.env.CUSTOMER_INSPECTION_CHECKOUT_TTL_HOURS; else process.env.CUSTOMER_INSPECTION_CHECKOUT_TTL_HOURS = prev; });

  prisma.checkoutSession.findUnique = async () => ({ id: 'cs1', reservationId: 'res1', events: '[]' });
  prisma.checkoutSession.update = async ({ data } = {}) => ({ id: 'cs1', ...data });
  prisma.handoffToken.findFirst = async () => null;
  prisma.handoffToken.create = async ({ data }) => ({ id: 'ht1', ...data });

  const out = await checkoutSessionService.mintHandoffToken({ sessionId: 'cs1', kind: 'CUSTOMER_INSPECTION', actorUserId: null });
  assert.ok(Math.abs(hoursUntil(out.expiresAt) - 100) < 0.2, `expected ~100h, got ${hoursUntil(out.expiresAt)}h`);
});

test('sendCheckinInspection: check-in token defaults to ~72h and honors env override', async (t) => {
  const prevKey = process.env.MAILERSEND_API_KEY;
  const prevFrom = process.env.MAILERSEND_FROM;
  const prevFetch = globalThis.fetch;
  const prevTtl = process.env.CUSTOMER_INSPECTION_CHECKIN_TTL_HOURS;
  process.env.MAILERSEND_API_KEY = 'test-key';
  process.env.MAILERSEND_FROM = 'no-reply@test.local';
  globalThis.fetch = async () => ({ ok: true, status: 202, json: async () => ({}), text: async () => '' });
  t.after(() => {
    if (prevKey === undefined) delete process.env.MAILERSEND_API_KEY; else process.env.MAILERSEND_API_KEY = prevKey;
    if (prevFrom === undefined) delete process.env.MAILERSEND_FROM; else process.env.MAILERSEND_FROM = prevFrom;
    if (prevTtl === undefined) delete process.env.CUSTOMER_INSPECTION_CHECKIN_TTL_HOURS; else process.env.CUSTOMER_INSPECTION_CHECKIN_TTL_HOURS = prevTtl;
    globalThis.fetch = prevFetch;
  });

  prisma.reservation.findUnique = async () => ({
    id: 'res1', tenantId: 't1', reservationNumber: 'RES-1',
    customer: { id: 'c1', firstName: 'Ana', lastName: 'P', email: 'ana@example.com' },
    vehicle: { id: 'v1', year: 2025, make: 'Kia', model: 'Soul', plate: 'ABC-123' },
    rentalAgreement: { id: 'ra1' },
  });
  prisma.appSetting.findUnique = async (args) => enabledAppSetting(args);
  prisma.customerInspection.findFirst = async () => null;
  prisma.customerInspection.create = async ({ data }) => ({ id: 'ci1', ...data });
  prisma.handoffToken.create = async ({ data }) => ({ id: 'ht1', ...data });

  const def = await customerInspectionService.sendCheckinInspection({ reservationId: 'res1' });
  assert.ok(Math.abs(hoursUntil(def.expiresAt) - 72) < 0.2, `expected ~72h, got ${hoursUntil(def.expiresAt)}h`);

  process.env.CUSTOMER_INSPECTION_CHECKIN_TTL_HOURS = '96';
  const over = await customerInspectionService.sendCheckinInspection({ reservationId: 'res1', force: true });
  assert.ok(Math.abs(hoursUntil(over.expiresAt) - 96) < 0.2, `expected ~96h, got ${hoursUntil(over.expiresAt)}h`);
});

// ---------------------------------------------------------------------------
// A2 — reservation-bound signed resolver.
// ---------------------------------------------------------------------------

test('verifyReservationSig: accepts a fresh signature, rejects tampering', () => {
  const id = 'res-abc';
  const exp = Date.now() + 24 * HOUR_MS;
  const sig = signReservation(id, exp);
  assert.equal(verifyReservationSig(id, exp, sig), true);
  // Tampered signature.
  assert.equal(verifyReservationSig(id, exp, `${sig}0`), false);
  assert.equal(verifyReservationSig(id, exp, 'deadbeef'), false);
  // Tampered reservation id.
  assert.equal(verifyReservationSig('res-xyz', exp, sig), false);
  // Tampered expiry (expiry is INSIDE the signed message — extending it breaks the sig).
  assert.equal(verifyReservationSig(id, exp + HOUR_MS, sig), false);
});

function stubResolverActive({ liveToken = null, existingInsp = null } = {}) {
  prisma.reservation.findFirst = async ({ where } = {}) => (
    where?.id && where?.status === 'CHECKED_OUT'
      ? { id: where.id, tenantId: 't1', vehicleId: 'v1', rentalAgreement: { id: 'ra1' }, reservationNumber: 'RES-1' }
      : null
  );
  prisma.appSetting.findUnique = async (args) => enabledAppSetting(args);
  prisma.handoffToken.findFirst = async () => liveToken;
  prisma.customerInspection.findFirst = async () => existingInsp;
}

test('startInspectionByReservationQr: CHECKED_OUT reservation → mints token, name hidden', async () => {
  const id = 'res-1';
  const exp = Date.now() + 24 * HOUR_MS;
  const payload = `${id}.${exp}.${signReservation(id, exp)}`;
  stubResolverActive();
  let inspData = null; let tokData = null;
  prisma.customerInspection.create = async ({ data }) => { inspData = data; return { id: 'ci1', ...data }; };
  prisma.handoffToken.create = async ({ data }) => { tokData = data; return { id: 'ht1', ...data }; };

  const out = await customerInspectionService.startInspectionByReservationQr({ payload });
  assert.match(out.token, /^[0-9a-f]{48}$/);
  assert.equal(inspData.emailTo, null, 'resolver-minted inspection must hide the renter (emailTo null)');
  assert.equal(inspData.phase, 'CHECKIN');
  assert.equal(inspData.reservationId, id);
  assert.ok(Math.abs(hoursUntil(tokData.expiresAt) - 72) < 0.2);
});

test('startInspectionByReservationQr: expired signed payload → RESOLVER_EXPIRED (410)', async () => {
  const id = 'res-1';
  const exp = Date.now() - 1000; // already expired, but validly signed
  const payload = `${id}.${exp}.${signReservation(id, exp)}`;
  // reservation.findFirst must never be reached.
  prisma.reservation.findFirst = async () => { throw new Error('should not query when payload expired'); };
  await assert.rejects(
    customerInspectionService.startInspectionByReservationQr({ payload }),
    (err) => { assert.equal(err.code, 'RESOLVER_EXPIRED'); assert.equal(err.status, 410); return true; },
  );
});

test('startInspectionByReservationQr: bad signature → BAD_QR', async () => {
  const id = 'res-1';
  const exp = Date.now() + HOUR_MS;
  const payload = `${id}.${exp}.deadbeefdeadbeefdeadbeef`;
  await assert.rejects(
    customerInspectionService.startInspectionByReservationQr({ payload }),
    (err) => { assert.equal(err.code, 'BAD_QR'); return true; },
  );
});

test('startInspectionByReservationQr: no active rental → NO_ACTIVE_RENTAL (409)', async () => {
  const id = 'res-1';
  const exp = Date.now() + HOUR_MS;
  const payload = `${id}.${exp}.${signReservation(id, exp)}`;
  prisma.reservation.findFirst = async () => null; // not CHECKED_OUT
  await assert.rejects(
    customerInspectionService.startInspectionByReservationQr({ payload }),
    (err) => { assert.equal(err.code, 'NO_ACTIVE_RENTAL'); assert.equal(err.status, 409); return true; },
  );
});

test('startInspectionByReservationQr: reuses live token + inspection when present', async () => {
  const id = 'res-1';
  const exp = Date.now() + HOUR_MS;
  const payload = `${id}.${exp}.${signReservation(id, exp)}`;
  stubResolverActive({ liveToken: { token: 'live-token-xyz' }, existingInsp: { id: 'ci-existing' } });
  prisma.customerInspection.create = async () => { throw new Error('must not create a new inspection when one is live'); };
  prisma.handoffToken.create = async () => { throw new Error('must not mint a new token when one is live'); };

  const out = await customerInspectionService.startInspectionByReservationQr({ payload });
  assert.equal(out.token, 'live-token-xyz');
});

test('inspectionResolverUrlForReservation: builds /inspect/r/<id>.<expMs>.<sig> and verifies', () => {
  const id = 'res-9';
  const url = customerInspectionService.inspectionResolverUrlForReservation(id, { expiresAt: new Date(Date.now() + 10 * HOUR_MS) });
  const m = /\/inspect\/r\/([^.]+)\.(\d+)\.([0-9a-f]+)$/.exec(url);
  assert.ok(m, `url shape unexpected: ${url}`);
  assert.equal(m[1], id);
  assert.equal(verifyReservationSig(m[1], Number(m[2]), m[3]), true);
});

// ---------------------------------------------------------------------------
// Name-hiding + token-expiry regression (loadByToken / loadToken).
// ---------------------------------------------------------------------------

function stubLoadToken(row) {
  prisma.handoffToken.findUnique = async () => row;
}

test('loadByToken: resolver-minted inspection (emailTo null) hides the customer name', async () => {
  stubLoadToken({
    id: 'ht1', token: 'tok', kind: 'CUSTOMER_INSPECTION', reservationId: 'res1',
    expiresAt: new Date(Date.now() + HOUR_MS), consumedAt: null,
    reservation: { customer: { firstName: 'Maria', lastName: 'G' }, vehicle: { id: 'v1', year: 2025, make: 'Kia', model: 'Soul', plate: 'ABC-123', color: 'Red', vehicleType: { name: 'SUV', code: 'S' } } },
  });
  prisma.customerInspection.findFirst = async () => ({ id: 'ci1', tenantId: 't1', phase: 'CHECKIN', emailTo: null, openedAt: new Date() });
  prisma.customerInspection.update = async () => ({});
  prisma.vehicleDamageReport.count = async () => 0;

  const out = await customerInspectionService.loadByToken('tok');
  assert.equal(out.customerName, null);
  assert.equal(out.vehicle.plate, 'ABC-123');
});

test('loadByToken: emailed inspection (emailTo set) reveals the customer name', async () => {
  stubLoadToken({
    id: 'ht1', token: 'tok', kind: 'CUSTOMER_INSPECTION', reservationId: 'res1',
    expiresAt: new Date(Date.now() + HOUR_MS), consumedAt: null,
    reservation: { customer: { firstName: 'Maria', lastName: 'G' }, vehicle: { id: 'v1', year: 2025, make: 'Kia', model: 'Soul', plate: 'ABC-123', color: 'Red', vehicleType: { name: 'SUV', code: 'S' } } },
  });
  prisma.customerInspection.findFirst = async () => ({ id: 'ci1', tenantId: 't1', phase: 'CHECKIN', emailTo: 'maria@example.com', openedAt: new Date() });
  prisma.customerInspection.update = async () => ({});
  prisma.vehicleDamageReport.count = async () => 0;

  const out = await customerInspectionService.loadByToken('tok');
  assert.equal(out.customerName, 'Maria G');
});

test('loadByToken: expired token → TOKEN_EXPIRED, consumed token → TOKEN_CONSUMED', async () => {
  stubLoadToken({ id: 'ht1', token: 'tok', kind: 'CUSTOMER_INSPECTION', reservationId: 'res1', expiresAt: new Date(Date.now() - 1000), consumedAt: null, reservation: {} });
  await assert.rejects(
    customerInspectionService.loadByToken('tok'),
    (err) => { assert.equal(err.code, 'TOKEN_EXPIRED'); return true; },
  );

  stubLoadToken({ id: 'ht1', token: 'tok', kind: 'CUSTOMER_INSPECTION', reservationId: 'res1', expiresAt: new Date(Date.now() + HOUR_MS), consumedAt: new Date(), reservation: {} });
  await assert.rejects(
    customerInspectionService.loadByToken('tok'),
    (err) => { assert.equal(err.code, 'TOKEN_CONSUMED'); return true; },
  );
});

// ---------------------------------------------------------------------------
// A3 — contract QR block. Dynamic import keeps rental-agreements' heavy module
// graph from affecting the rest of this file's tests.
// ---------------------------------------------------------------------------

test('buildInspectionQrBlockHtml: enabled → QR <img> data-URL + resolver link; disabled → empty', async () => {
  const { buildInspectionQrBlockHtml } = await import('../rental-agreements/rental-agreements.service.js');

  prisma.appSetting.findUnique = async (args) => enabledAppSetting(args);
  const enabled = await buildInspectionQrBlockHtml({ reservationId: 'res-123', tenantId: 't1', returnAt: new Date() });
  assert.match(enabled, /<img[^>]+src="data:image\/png;base64,/, 'enabled tenant must embed an inline QR image');
  assert.match(enabled, /\/inspect\/r\/res-123\./, 'block must carry the reservation-bound resolver link');

  prisma.appSetting.findUnique = async () => null; // → getCustomerInspectionConfig { enabled:false }
  const disabled = await buildInspectionQrBlockHtml({ reservationId: 'res-123', tenantId: 't1', returnAt: new Date() });
  assert.equal(disabled, '', 'disabled tenant must get an empty block (contract byte-unchanged)');

  const none = await buildInspectionQrBlockHtml({ reservationId: null, tenantId: 't1' });
  assert.equal(none, '', 'no reservation → empty block');
});
