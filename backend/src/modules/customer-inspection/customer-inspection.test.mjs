import { test } from 'node:test';
import assert from 'node:assert/strict';
import { prisma } from '../../lib/prisma.js';
import {
  diagramTypeFor,
  VEHICLE_VIEWS,
  customerInspectionService,
  signReservation,
  verifyReservationSig,
  buildSeedCandidates,
  SEED_SOURCE,
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

// ---------------------------------------------------------------------------
// Seed from history (2026-09-06, audit/baseline closers) — the per-vehicle
// cold-start job (damage-baseline NOTES §D5 path B): PROPOSED entries only
// (status REPORTED · source SEED_HISTORY), idempotent via seedSourceRef,
// capped at 50 with an explicit notice, audit-logged per entry; the admin's
// approve/discard review closes each proposal.
// ---------------------------------------------------------------------------

test('buildSeedCandidates: three sources map to stable refs; soft-approved rows keep their real view/dot/photo', () => {
  const { candidates, totalCandidates, capped } = buildSeedCandidates({
    softApproved: [{
      id: 'vdr-1', phase: 'CHECKIN', view: 'REAR', xPct: 24, yPct: 66,
      description: 'Scuff, rear bumper', photoJson: { storage: true }, reservationId: 'res-1', reservationNumber: 'R-1',
    }],
    inspections: [{
      id: 'insp-1', phase: 'CHECKOUT', damages: 'Door edge chip, rear right',
      capturedAt: '2026-05-12T10:00:00Z', rentalAgreement: { reservationId: 'res-2' },
    }],
    incidents: [{
      id: 'inc-1', reportNumber: 'INC-20260601-ABC124', title: 'Wheel arch scratch', narrative: 'Found at return', reservationId: 'res-3',
    }],
  });
  assert.equal(totalCandidates, 3);
  assert.equal(capped, false);
  assert.deepEqual(candidates.map((c) => c.seedSourceRef), ['vdr:vdr-1', 'insp:insp-1', 'inc:inc-1']);
  const [soft, insp, inc] = candidates;
  assert.equal(soft.view, 'REAR');
  assert.equal(soft.xPct, 24);
  assert.deepEqual(soft.photoJson, { storage: true }, 'existing evidence rides along');
  assert.equal(insp.view, 'FRONT', 'free text has no view — desk-triage placeholder');
  assert.equal(insp.xPct, 50);
  assert.match(insp.description, /^\[CHECKOUT 2026-05-12\] Door edge chip/);
  assert.equal(insp.reservationId, 'res-2', 'reservation resolved through the agreement');
  assert.match(inc.description, /^\[Incident INC-20260601-ABC124\] Wheel arch scratch — Found at return/);
});

test('buildSeedCandidates: refs already on the vehicle are skipped (idempotence) and blank inspection text never seeds', () => {
  const { candidates, totalCandidates } = buildSeedCandidates({
    softApproved: [{ id: 'vdr-1', view: 'REAR', xPct: 1, yPct: 1, description: 'x' }],
    inspections: [
      { id: 'insp-1', phase: 'CHECKIN', damages: '   ', rentalAgreement: {} },
      { id: 'insp-2', phase: 'CHECKIN', damages: 'Real note', rentalAgreement: {} },
    ],
    incidents: [{ id: 'inc-1', title: 'Old dent' }],
    existingRefs: ['vdr:vdr-1', 'inc:inc-1'],
  });
  assert.equal(totalCandidates, 1, 'only the unseen inspection note remains');
  assert.equal(candidates[0].seedSourceRef, 'insp:insp-2');
});

test('buildSeedCandidates: caps at 50 with capped:true and the real total', () => {
  const incidents = Array.from({ length: 60 }, (_, i) => ({ id: `inc-${i}`, title: `Dent ${i}` }));
  const { candidates, totalCandidates, capped, cap } = buildSeedCandidates({ incidents });
  assert.equal(cap, 50);
  assert.equal(candidates.length, 50);
  assert.equal(totalCandidates, 60);
  assert.equal(capped, true);
});

function patchSeedPrisma({ vehicle = { id: 'veh-1' }, existing = [], inspections = [], incidents = [] } = {}) {
  const state = { created: [], audits: [], updates: [] };
  const orig = {
    vehicleFindFirst: prisma.vehicle.findFirst,
    vdrFindMany: prisma.vehicleDamageReport.findMany,
    vdrCreate: prisma.vehicleDamageReport.create,
    vdrFindFirst: prisma.vehicleDamageReport.findFirst,
    vdrUpdate: prisma.vehicleDamageReport.update,
    inspFindMany: prisma.rentalAgreementInspection.findMany,
    incFindMany: prisma.reservationIncident.findMany,
    auditCreate: prisma.auditLog.create,
  };
  prisma.vehicle.findFirst = async () => vehicle;
  prisma.vehicleDamageReport.findMany = async () => existing;
  prisma.vehicleDamageReport.create = async ({ data }) => {
    const row = { id: `seed-${state.created.length + 1}`, ...data };
    state.created.push(row);
    return row;
  };
  prisma.vehicleDamageReport.update = async ({ where, data }) => { state.updates.push({ where, data }); return { id: where.id, ...data }; };
  prisma.rentalAgreementInspection.findMany = async () => inspections;
  prisma.reservationIncident.findMany = async () => incidents;
  prisma.auditLog.create = async ({ data }) => { state.audits.push(data); return { id: `a-${state.audits.length}`, ...data }; };
  const restore = () => {
    prisma.vehicle.findFirst = orig.vehicleFindFirst;
    prisma.vehicleDamageReport.findMany = orig.vdrFindMany;
    prisma.vehicleDamageReport.create = orig.vdrCreate;
    prisma.vehicleDamageReport.findFirst = orig.vdrFindFirst;
    prisma.vehicleDamageReport.update = orig.vdrUpdate;
    prisma.rentalAgreementInspection.findMany = orig.inspFindMany;
    prisma.reservationIncident.findMany = orig.incFindMany;
    prisma.auditLog.create = orig.auditCreate;
  };
  return { state, restore };
}

const SEED_INSPECTIONS = [
  { id: 'insp-1', phase: 'CHECKOUT', damages: 'Door edge chip', capturedAt: '2026-05-12T10:00:00Z', rentalAgreement: { reservationId: 'res-2' } },
];
const SEED_INCIDENTS = [
  { id: 'inc-1', reportNumber: 'INC-1', title: 'Wheel scratch', narrative: null, reservationId: 'res-3' },
];

test('seedBaselineFromHistory dryRun: lists the exact candidates and creates NOTHING', async () => {
  const { state, restore } = patchSeedPrisma({ inspections: SEED_INSPECTIONS, incidents: SEED_INCIDENTS });
  try {
    const out = await customerInspectionService.seedBaselineFromHistory({
      vehicleId: 'veh-1', dryRun: true, actorUserId: 'u-admin', scope: { tenantId: 't1' },
    });
    assert.equal(out.dryRun, true);
    assert.equal(out.created, 0);
    assert.equal(state.created.length, 0, 'dry run writes nothing');
    assert.equal(state.audits.length, 0);
    assert.equal(out.totalCandidates, 2);
    assert.deepEqual(out.candidates.map((c) => c.seedSourceRef), ['insp:insp-1', 'inc:inc-1']);
    assert.equal(out.capped, false);
  } finally { restore(); }
});

test('seedBaselineFromHistory: creates REPORTED · SEED_HISTORY rows (never HARD_APPROVED), audit-logged per reservation-anchored entry', async () => {
  const { state, restore } = patchSeedPrisma({
    existing: [{ id: 'vdr-open', status: 'HARD_APPROVED', seedSourceRef: null }],
    inspections: SEED_INSPECTIONS,
    incidents: SEED_INCIDENTS,
  });
  try {
    const out = await customerInspectionService.seedBaselineFromHistory({
      vehicleId: 'veh-1', actorUserId: 'u-admin', scope: { tenantId: 't1' },
    });
    assert.equal(out.created, 2);
    assert.equal(out.alreadyActive, 1, 'open HARD_APPROVED rows are already baseline — reported, not reseeded');
    for (const row of state.created) {
      assert.equal(row.status, 'REPORTED', 'proposals only — an admin reviews');
      assert.equal(row.source, SEED_SOURCE);
      assert.ok(row.seedSourceRef);
      assert.equal(row.tenantId, 't1');
    }
    assert.equal(state.audits.length, 2, 'both candidates carry reservations so both audit-log');
    assert.equal(state.audits[0].action, 'ADMIN_OVERRIDE');
    assert.equal(state.audits[0].actorUserId, 'u-admin');
    assert.equal(JSON.parse(state.audits[0].metadata).kind, 'damage_baseline_seed');
  } finally { restore(); }
});

test('seedBaselineFromHistory: a re-run creates nothing new (refs already present) — idempotence', async () => {
  const { state, restore } = patchSeedPrisma({
    existing: [
      { id: 's1', status: 'REPORTED', seedSourceRef: 'insp:insp-1' },
      { id: 's2', status: 'SOFT_APPROVED', seedSourceRef: 'inc:inc-1' }, // discarded tombstone still blocks
    ],
    inspections: SEED_INSPECTIONS,
    incidents: SEED_INCIDENTS,
  });
  try {
    const out = await customerInspectionService.seedBaselineFromHistory({
      vehicleId: 'veh-1', actorUserId: 'u-admin', scope: { tenantId: 't1' },
    });
    assert.equal(out.created, 0);
    assert.equal(out.totalCandidates, 0);
    assert.equal(state.created.length, 0);
  } finally { restore(); }
});

test('seedBaselineFromHistory: caps a 60-incident backlog at 50 created with capped:true', async () => {
  const incidents = Array.from({ length: 60 }, (_, i) => ({ id: `inc-${i}`, title: `Dent ${i}`, reservationId: null }));
  const { state, restore } = patchSeedPrisma({ incidents });
  try {
    const out = await customerInspectionService.seedBaselineFromHistory({
      vehicleId: 'veh-1', actorUserId: 'u-admin', scope: { tenantId: 't1' },
    });
    assert.equal(out.created, 50);
    assert.equal(out.capped, true);
    assert.equal(out.cap, 50);
    assert.equal(out.totalCandidates, 60);
    assert.equal(state.created.length, 50);
    assert.equal(state.audits.length, 0, 'no reservation on these — row-level provenance is the trail');
  } finally { restore(); }
});

test('seedBaselineFromHistory guards: tenantId required; unknown vehicle 404', async () => {
  await assert.rejects(
    customerInspectionService.seedBaselineFromHistory({ vehicleId: 'veh-1', scope: {} }),
    (e) => e.status === 400,
  );
  const { restore } = patchSeedPrisma({ vehicle: null });
  try {
    await assert.rejects(
      customerInspectionService.seedBaselineFromHistory({ vehicleId: 'nope', scope: { tenantId: 't1' } }),
      (e) => e.status === 404,
    );
  } finally { restore(); }
});

test('reviewSeededEntry: approve applies dot/view correction + reviewer stamp; discard leaves a SOFT_APPROVED tombstone', async () => {
  const { state, restore } = patchSeedPrisma({});
  prisma.vehicleDamageReport.findFirst = async () => ({
    id: 'seed-1', status: 'REPORTED', source: 'SEED_HISTORY', tenantId: 't1', vehicleId: 'veh-1', reservationId: 'res-2',
  });
  try {
    const out = await customerInspectionService.reviewSeededEntry({
      reportId: 'seed-1', action: 'approve', view: 'REAR', xPct: 24, yPct: 66,
      description: 'Chip — rear right door edge', actorUserId: 'u-admin', scope: { tenantId: 't1' },
    });
    assert.equal(out.status, 'HARD_APPROVED');
    const d = state.updates[0].data;
    assert.equal(d.status, 'HARD_APPROVED');
    assert.equal(d.view, 'REAR');
    assert.equal(d.xPct, 24);
    assert.equal(d.yPct, 66);
    assert.equal(d.reviewedByUserId, 'u-admin');
    assert.equal(JSON.parse(state.audits[0].metadata).kind, 'damage_baseline_seed_review');

    const out2 = await customerInspectionService.reviewSeededEntry({
      reportId: 'seed-1', action: 'discard', actorUserId: 'u-admin', scope: { tenantId: 't1' },
    });
    assert.equal(out2.status, 'SOFT_APPROVED', 'discard keeps the row (and its seedSourceRef) as a tombstone');
  } finally { restore(); }
});

test('reviewSeededEntry guards: SEED_HISTORY-only, REPORTED-only, valid view/dot', async () => {
  const { restore } = patchSeedPrisma({});
  try {
    prisma.vehicleDamageReport.findFirst = async () => ({ id: 'd1', status: 'REPORTED', source: 'CUSTOMER', tenantId: 't1' });
    await assert.rejects(
      customerInspectionService.reviewSeededEntry({ reportId: 'd1', action: 'approve', scope: { tenantId: 't1' } }),
      (e) => e.status === 400 && /seeded proposals/.test(e.message),
      'customer REPORTED rows belong to the inspection queue, not here',
    );
    prisma.vehicleDamageReport.findFirst = async () => ({ id: 'd1', status: 'HARD_APPROVED', source: 'SEED_HISTORY', tenantId: 't1' });
    await assert.rejects(
      customerInspectionService.reviewSeededEntry({ reportId: 'd1', action: 'approve', scope: { tenantId: 't1' } }),
      (e) => e.status === 409,
    );
    prisma.vehicleDamageReport.findFirst = async () => ({ id: 'd1', status: 'REPORTED', source: 'SEED_HISTORY', tenantId: 't1' });
    await assert.rejects(
      customerInspectionService.reviewSeededEntry({ reportId: 'd1', action: 'approve', view: 'TOP', scope: { tenantId: 't1' } }),
      (e) => e.status === 400 && /Invalid view/.test(e.message),
    );
    await assert.rejects(
      customerInspectionService.reviewSeededEntry({ reportId: 'd1', action: 'approve', xPct: 400, scope: { tenantId: 't1' } }),
      (e) => e.status === 400 && /xPct/.test(e.message),
    );
    await assert.rejects(
      customerInspectionService.reviewSeededEntry({ reportId: 'd1', action: 'whatever', scope: { tenantId: 't1' } }),
      (e) => e.status === 400,
    );
  } finally { restore(); }
});

test('seed wiring: both routes exist and are ADMIN-gated', async () => {
  const { readFileSync: rf } = await import('node:fs');
  const src = rf(new URL('./customer-inspection.routes.js', import.meta.url), 'utf8');
  assert.match(src, /'\/vehicle\/:vehicleId\/seed-baseline', requireRole\('ADMIN', 'SUPER_ADMIN'\)/);
  assert.match(src, /'\/reports\/:reportId\/seed-review', requireRole\('ADMIN', 'SUPER_ADMIN'\)/);
  assert.match(src, /seedBaselineFromHistory/);
  assert.match(src, /reviewSeededEntry/);
});
