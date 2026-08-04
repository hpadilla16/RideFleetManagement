/**
 * Shuttle Requests (Valet arc) — DB-backed on embedded postgres.
 *
 * The behaviours that carry the operation:
 *   - idempotency: three calls from one anxious customer are ONE bus with
 *     callCount 3, snapped back to READY so the banner re-fires
 *   - location scoping: a Mayagüez agent never sees Ponce's queue
 *   - the check-out auto-close, in the same client the checkout tx uses
 *   - allowlist: Chloe's POST is reachable, nothing else shuttle-ish is
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { PrismaClient } from '@prisma/client';
import { shuttleRequestsService, autoCompleteShuttleRequestsOnCheckout } from './shuttle-requests.service.js';
import { isAllowedForServiceAccount } from '../../lib/service-account-allowlist.js';

const prisma = new PrismaClient();
let tenant;
let kennedy;
let ponce;
let reservation;
let reservation2;

test('setup: tenant, two sedes, two reservations', async () => {
  tenant = await prisma.tenant.create({ data: { name: `Shuttle Test ${Date.now()}`, slug: `shuttle-${Date.now()}` } });
  kennedy = await prisma.location.create({ data: { tenantId: tenant.id, code: 'KEN', name: 'Kennedy' } });
  ponce = await prisma.location.create({ data: { tenantId: tenant.id, code: 'PON', name: 'Ponce' } });
  const customer = await prisma.customer.create({ data: { tenantId: tenant.id, firstName: 'Carlos', lastName: 'Rivera', phone: '787-555-0001' } });
  const vt = await prisma.vehicleType.create({ data: { tenantId: tenant.id, code: 'ECON', name: 'Economy' } });
  const mkRes = (n, loc) => prisma.reservation.create({
    data: {
      tenantId: tenant.id,
      reservationNumber: n,
      customerId: customer.id,
      vehicleTypeId: vt.id,
      status: 'CONFIRMED',
      pickupAt: new Date('2026-08-05T15:00:00Z'),
      returnAt: new Date('2026-08-08T15:00:00Z'),
      pickupLocationId: loc.id,
      returnLocationId: loc.id
    }
  });
  reservation = await mkRes('SH-1001', kennedy);
  reservation2 = await mkRes('SH-1002', ponce);
});

test('three calls are one bus: callCount 3, back to READY after a view', async () => {
  const first = await shuttleRequestsService.create({
    tenantId: tenant.id, locationId: kennedy.id, reservationId: reservation.id,
    customerName: 'Carlos Rivera', customerPhone: '787-555-0001', partySize: 2, pickupNote: 'Terminal B, puerta 4'
  });
  assert.equal(first.deduplicated, false);
  assert.equal(first.request.callCount, 1);
  assert.equal(first.request.status, 'READY');

  // An agent sees it...
  await shuttleRequestsService.markViewed(first.request.id, { tenantId: tenant.id }, null);

  // ...and the customer calls twice more.
  const second = await shuttleRequestsService.create({ tenantId: tenant.id, locationId: kennedy.id, reservationId: reservation.id, partySize: 3 });
  const third = await shuttleRequestsService.create({ tenantId: tenant.id, locationId: kennedy.id, reservationId: reservation.id });
  assert.equal(second.deduplicated, true);
  assert.equal(third.deduplicated, true);
  assert.equal(third.request.id, first.request.id, 'same row, not a new bus');
  assert.equal(third.request.callCount, 3);
  assert.equal(third.request.status, 'READY', 'a repeat call must re-fire the banner even after a view');
  assert.equal(third.request.partySize, 3, 'latest party size wins');
  assert.equal(third.request.pickupNote, 'Terminal B, puerta 4', 'blank repeat-call fields must not erase what we know');
});

test('location scoping: Ponce-scoped staff cannot see or act on Kennedy rows', async () => {
  await shuttleRequestsService.create({ tenantId: tenant.id, locationId: ponce.id, reservationId: reservation2.id, customerName: 'Ponce Guy' });

  const tenantWide = await shuttleRequestsService.list({ tenantId: tenant.id });
  assert.equal(tenantWide.rows.length, 2);

  const ponceOnly = await shuttleRequestsService.list({ tenantId: tenant.id, allowedLocationIds: [ponce.id] });
  assert.equal(ponceOnly.rows.length, 1);
  assert.equal(ponceOnly.rows[0].location.code, 'PON');

  const kennedyRow = tenantWide.rows.find((r) => r.location.code === 'KEN');
  await assert.rejects(
    () => shuttleRequestsService.markViewed(kennedyRow.id, { tenantId: tenant.id, allowedLocationIds: [ponce.id] }, null),
    /not found/i,
    'acting across sedes must read as not-found, not forbidden-but-real'
  );
});

test('check-out auto-completes every open request for the reservation', async () => {
  const before = await prisma.shuttleRequest.findFirst({ where: { reservationId: reservation.id } });
  assert.ok(['READY', 'VIEWED'].includes(before.status));

  const count = await prisma.$transaction(async (tx) => autoCompleteShuttleRequestsOnCheckout(tx, reservation.id));
  assert.equal(count, 1);

  const after = await prisma.shuttleRequest.findFirst({ where: { reservationId: reservation.id } });
  assert.equal(after.status, 'COMPLETED');
  assert.match(after.closeReason, /checked out/i);

  // A NEW call after checkout is a fresh request (customer came back another day).
  const again = await shuttleRequestsService.create({ tenantId: tenant.id, locationId: kennedy.id, reservationId: reservation.id, customerName: 'Carlos Rivera' });
  assert.equal(again.deduplicated, false, 'closed rows must not absorb new calls');
  await shuttleRequestsService.close(again.request.id, 'CANCELLED', { tenantId: tenant.id }, null, 'test cleanup');
});

test('degrades to a no-op when the tx client predates the model (rolling deploy)', async () => {
  assert.equal(await autoCompleteShuttleRequestsOnCheckout({}, reservation.id), 0);
  assert.equal(await autoCompleteShuttleRequestsOnCheckout(null, reservation.id), 0);
});

test('close outcomes are constrained and idempotent', async () => {
  const { request } = await shuttleRequestsService.create({ tenantId: tenant.id, locationId: ponce.id, reservationId: reservation2.id });
  await assert.rejects(() => shuttleRequestsService.close(request.id, 'DELETED', { tenantId: tenant.id }), /Invalid close outcome/);
  const closed = await shuttleRequestsService.close(request.id, 'NO_SHOW', { tenantId: tenant.id }, null, 'never showed');
  assert.equal(closed.status, 'NO_SHOW');
  const again = await shuttleRequestsService.close(request.id, 'CANCELLED', { tenantId: tenant.id });
  assert.equal(again.status, 'NO_SHOW', 'a closed row stays closed');
});

test('allowlist: Chloe can POST the create, and only the create', () => {
  assert.equal(isAllowedForServiceAccount('POST', '/api/shuttle-requests'), true);
  assert.equal(isAllowedForServiceAccount('GET', '/api/shuttle-requests'), false);
  assert.equal(isAllowedForServiceAccount('POST', '/api/shuttle-requests/abc/view'), false);
  assert.equal(isAllowedForServiceAccount('POST', '/api/shuttle-requests/abc/cancel'), false);
});

test('teardown', async () => {
  await prisma.$disconnect();
});
