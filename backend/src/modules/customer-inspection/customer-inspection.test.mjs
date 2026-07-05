import { test } from 'node:test';
import assert from 'node:assert/strict';
import { prisma } from '../../lib/prisma.js';
import { diagramTypeFor, VEHICLE_VIEWS, customerInspectionService } from './customer-inspection.service.js';

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
