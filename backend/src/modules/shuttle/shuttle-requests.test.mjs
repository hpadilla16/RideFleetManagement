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

// ---------------------------------------------------------------------------
// 2026-08-07 (Hector's shuttle spec): manual COMPLETE, the history view, and
// the delay notice.
// ---------------------------------------------------------------------------

test('a driver can close a request as COMPLETED before any check-out', async () => {
  // The whole point: the only prior road to COMPLETED was the contract's
  // check-out, so a driver who had already picked the customer up could only
  // lie (cancel / no-show).
  const res = await prisma.reservation.create({
    data: {
      tenantId: tenant.id, reservationNumber: `SH-COMP-${Date.now()}`,
      customerId: (await prisma.customer.findFirst({ where: { tenantId: tenant.id } })).id,
      vehicleTypeId: (await prisma.vehicleType.findFirst({ where: { tenantId: tenant.id } })).id,
      status: 'CONFIRMED',
      pickupAt: new Date('2026-08-07T15:00:00Z'), returnAt: new Date('2026-08-09T15:00:00Z'),
      pickupLocationId: kennedy.id, returnLocationId: kennedy.id
    }
  });
  const { request } = await shuttleRequestsService.create({
    tenantId: tenant.id, locationId: kennedy.id, reservationId: res.id, customerName: 'Driver Pickup'
  });
  const user = await prisma.user.create({
    data: { tenantId: tenant.id, email: `driver-${Date.now()}@x.test`, fullName: 'Ana Driver', passwordHash: 'x', role: 'AGENT' }
  });
  const closed = await shuttleRequestsService.close(request.id, 'COMPLETED', { tenantId: tenant.id }, user.id, 'picked up at curb');
  assert.equal(closed.status, 'COMPLETED');
  assert.equal(closed.closedByUserId, user.id, 'the real authenticated user, never the payload');
  assert.ok(closed.closedAt);

  // And the reservation never checked out — proving this path is independent.
  const fresh = await prisma.reservation.findUnique({ where: { id: res.id }, select: { status: true } });
  assert.equal(fresh.status, 'CONFIRMED');
});

test('history view: status + date window + pagination + who closed it', async () => {
  const all = await shuttleRequestsService.list({ tenantId: tenant.id }, { status: 'all', from: '2000-01-01', to: '2100-01-01' });
  assert.ok(all.total >= 3, 'total is a real count, not the page length');
  assert.equal(typeof all.page, 'number');
  assert.equal(typeof all.pageSize, 'number');

  const completed = await shuttleRequestsService.list({ tenantId: tenant.id }, { status: 'COMPLETED', from: '2000-01-01', to: '2100-01-01' });
  assert.ok(completed.rows.length >= 1);
  assert.ok(completed.rows.every((r) => r.status === 'COMPLETED'));
  const withUser = completed.rows.find((r) => r.closedByUserId);
  if (withUser) assert.equal(withUser.closedByName, 'Ana Driver', 'the closer is named, not just an id');

  // Pagination really slices.
  const p1 = await shuttleRequestsService.list({ tenantId: tenant.id }, { status: 'all', limit: 1, page: 1, from: '2000-01-01', to: '2100-01-01' });
  const p2 = await shuttleRequestsService.list({ tenantId: tenant.id }, { status: 'all', limit: 1, page: 2, from: '2000-01-01', to: '2100-01-01' });
  assert.equal(p1.rows.length, 1);
  assert.equal(p2.rows.length, 1);
  assert.notEqual(p1.rows[0].id, p2.rows[0].id);

  // A window that excludes everything returns nothing — the date filter is real.
  const empty = await shuttleRequestsService.list({ tenantId: tenant.id }, { status: 'all', from: '1999-01-01', to: '1999-01-02' });
  assert.equal(empty.rows.length, 0);
  assert.equal(empty.total, 0);
});

test('the live queue keeps its shape — the banner contract is untouched', async () => {
  const open = await shuttleRequestsService.list({ tenantId: tenant.id }, { status: 'open' });
  assert.ok(Array.isArray(open.rows), 'rows[] is what ShuttleBanner reads');
  assert.equal(typeof open.openCount, 'number');
  assert.ok(open.rows.every((r) => ['READY', 'VIEWED'].includes(r.status)));
  // No date window is applied to the live queue: an old open request must not
  // vanish from the banner just because it was created yesterday.
  const stale = await prisma.shuttleRequest.findFirst({ where: { tenantId: tenant.id, status: { in: ['READY', 'VIEWED'] } } });
  if (stale) {
    await prisma.shuttleRequest.update({ where: { id: stale.id }, data: { createdAt: new Date('2020-01-01T00:00:00Z') } });
    const again = await shuttleRequestsService.list({ tenantId: tenant.id }, { status: 'open' });
    assert.ok(again.rows.some((r) => r.id === stale.id), 'a day-old open request still shows in the queue');
  }
});

test('locationId narrows within scope and can never widen it', async () => {
  const scoped = { tenantId: tenant.id, allowedLocationIds: [kennedy.id] };
  const own = await shuttleRequestsService.list(scoped, { status: 'all', locationId: kennedy.id, from: '2000-01-01', to: '2100-01-01' });
  assert.ok(own.rows.every((r) => r.locationId === kennedy.id));
  // Asking for a sede outside the allowed list yields nothing — not Ponce's queue.
  const foreign = await shuttleRequestsService.list(scoped, { status: 'all', locationId: ponce.id, from: '2000-01-01', to: '2100-01-01' });
  assert.equal(foreign.rows.length, 0);
  assert.equal(foreign.total, 0);
});

test('delay notice: emails the reservation customer, logs it, never awaits the send', async () => {
  const customer = await prisma.customer.create({
    data: { tenantId: tenant.id, firstName: 'Delayed', lastName: 'Passenger', phone: '787-555-9999', email: 'delayed@example.test' }
  });
  const res = await prisma.reservation.create({
    data: {
      tenantId: tenant.id, reservationNumber: `SH-DELAY-${Date.now()}`,
      customerId: customer.id,
      vehicleTypeId: (await prisma.vehicleType.findFirst({ where: { tenantId: tenant.id } })).id,
      status: 'CONFIRMED',
      pickupAt: new Date('2026-08-07T15:00:00Z'), returnAt: new Date('2026-08-09T15:00:00Z'),
      pickupLocationId: kennedy.id, returnLocationId: kennedy.id
    }
  });
  const { request } = await shuttleRequestsService.create({
    tenantId: tenant.id, locationId: kennedy.id, reservationId: res.id, customerName: 'Delayed Passenger'
  });

  const sent = [];
  let resolveSend;
  const pending = new Promise((r) => { resolveSend = r; });
  const out = await shuttleRequestsService.notifyDelay(
    request.id, { reason: 'traffic', etaMinutes: 15 }, { tenantId: tenant.id }, null,
    { sendEmail: async (msg) => { sent.push(msg); resolveSend(); return { ok: true }; } }
  );

  assert.equal(out.ok, true);
  assert.equal(out.notice.to, 'delayed@example.test', 'the address comes from the reservation Customer');
  assert.equal(out.notice.etaMinutes, 15);
  assert.equal(out.notice.status, 'SENT');

  // Logged BEFORE the provider answers — that is what stops three agents from
  // emailing the same customer blind.
  const logged = JSON.parse((await prisma.shuttleRequest.findUnique({ where: { id: request.id }, select: { delayNoticesJson: true } })).delayNoticesJson);
  assert.equal(logged.length, 1);
  assert.equal(logged[0].reason, 'traffic');

  await pending;
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /15 minutes/);
  assert.match(sent[0].subject, /Shuttle update/);

  // A second notice appends rather than replaces.
  await shuttleRequestsService.notifyDelay(request.id, { reason: 'still traffic' }, { tenantId: tenant.id }, null, { sendEmail: async () => ({ ok: true }) });
  const twice = JSON.parse((await prisma.shuttleRequest.findUnique({ where: { id: request.id }, select: { delayNoticesJson: true } })).delayNoticesJson);
  assert.equal(twice.length, 2);
});

test('delay notice without an email is a 409 carrying the phone, not a silent failure', async () => {
  const customer = await prisma.customer.create({
    data: { tenantId: tenant.id, firstName: 'NoEmail', lastName: 'Caller', phone: '787-555-1111' }
  });
  const res = await prisma.reservation.create({
    data: {
      tenantId: tenant.id, reservationNumber: `SH-NOEMAIL-${Date.now()}`,
      customerId: customer.id,
      vehicleTypeId: (await prisma.vehicleType.findFirst({ where: { tenantId: tenant.id } })).id,
      status: 'CONFIRMED',
      pickupAt: new Date('2026-08-07T15:00:00Z'), returnAt: new Date('2026-08-09T15:00:00Z'),
      pickupLocationId: kennedy.id, returnLocationId: kennedy.id
    }
  });
  const { request } = await shuttleRequestsService.create({
    tenantId: tenant.id, locationId: kennedy.id, reservationId: res.id,
    customerName: 'NoEmail Caller', customerPhone: '787-555-1111'
  });

  let sends = 0;
  await assert.rejects(
    () => shuttleRequestsService.notifyDelay(request.id, {}, { tenantId: tenant.id }, null, { sendEmail: async () => { sends += 1; } }),
    (e) => {
      assert.equal(e.status, 409);
      assert.equal(e.code, 'NO_EMAIL');
      assert.equal(e.customerPhone, '787-555-1111', 'the UI offers the call instead');
      return true;
    }
  );
  assert.equal(sends, 0, 'nothing was sent');
});

test('a closed request cannot be notified', async () => {
  const closed = await prisma.shuttleRequest.findFirst({ where: { tenantId: tenant.id, status: 'COMPLETED' } });
  if (closed) {
    await assert.rejects(
      () => shuttleRequestsService.notifyDelay(closed.id, {}, { tenantId: tenant.id }, null, { sendEmail: async () => ({}) }),
      /no delay notice needed/
    );
  }
});

test('allowlist stays shut: the new staff routes are humans-only', () => {
  assert.equal(isAllowedForServiceAccount('POST', '/api/shuttle-requests/abc/complete'), false);
  assert.equal(isAllowedForServiceAccount('POST', '/api/shuttle-requests/abc/notify-delay'), false);
  assert.equal(isAllowedForServiceAccount('POST', '/api/shuttle-requests'), true, 'Chloe keeps exactly her one write');
});

test('teardown', async () => {
  await prisma.$disconnect();
});
