/**
 * DB-backed tests for the notesUpdatedAt stamp (LAX #12, 2026-07-28).
 * Requires DATABASE_URL. Pins the one subtle behavior: the stamp moves ONLY
 * when the notes text really changes — the automatic [UNDERAGE ALERT]
 * re-splice that update() performs on EVERY patch must not count.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { PrismaClient } from '@prisma/client';
import { reservationsService } from './reservations.service.js';

const prisma = new PrismaClient();
const TAG = `NUA-${Date.now()}`;
const ids = { tenant: null, location: null, customer: null, reservation: null };

test.after(async () => {
  if (ids.reservation) {
    await prisma.auditLog.deleteMany({ where: { reservationId: ids.reservation } }).catch(() => {});
    await prisma.reservation.delete({ where: { id: ids.reservation } }).catch(() => {});
  }
  if (ids.customer) await prisma.customer.delete({ where: { id: ids.customer } }).catch(() => {});
  if (ids.location) await prisma.location.delete({ where: { id: ids.location } }).catch(() => {});
  if (ids.tenant) await prisma.tenant.delete({ where: { id: ids.tenant } }).catch(() => {});
  await prisma.$disconnect();
});

test('setup', async () => {
  const t = await prisma.tenant.create({ data: { name: `T ${TAG}`, slug: `t-${TAG}`.toLowerCase() } }); ids.tenant = t.id;
  const loc = await prisma.location.create({ data: { code: `L-${TAG}`.slice(0, 12), name: 'Loc', tenantId: t.id } }); ids.location = loc.id;
  const cust = await prisma.customer.create({ data: { firstName: 'Nota', lastName: 'Bene', phone: '7875550166', email: `c-${TAG}@x.com`, tenantId: t.id } }); ids.customer = cust.id;
  const r = await prisma.reservation.create({ data: {
    reservationNumber: `R-${TAG}`, tenantId: t.id, customerId: cust.id,
    pickupLocationId: loc.id, returnLocationId: loc.id,
    pickupAt: new Date(Date.now() + 5 * 86400e3), returnAt: new Date(Date.now() + 8 * 86400e3),
    status: 'CONFIRMED', dailyRate: 50,
  } }); ids.reservation = r.id;
  assert.equal(r.notesUpdatedAt, null, 'no stamp without a note');
});

test('writing a note stamps notesUpdatedAt', async () => {
  await reservationsService.update(ids.reservation, { notes: 'cliente llega tarde, esperar hasta las 10pm' }, { tenantId: ids.tenant });
  const after = await prisma.reservation.findUnique({ where: { id: ids.reservation } });
  assert.ok(after.notesUpdatedAt, 'stamped on first note');
});

test('a patch that does NOT touch notes leaves the stamp alone', async () => {
  const before = (await prisma.reservation.findUnique({ where: { id: ids.reservation } })).notesUpdatedAt;
  await new Promise((r) => setTimeout(r, 25));
  await reservationsService.update(ids.reservation, { dailyRate: 55 }, { tenantId: ids.tenant });
  const after = await prisma.reservation.findUnique({ where: { id: ids.reservation } });
  assert.equal(after.notesUpdatedAt.getTime(), before.getTime(), 'stamp untouched by a non-notes patch');
});

test('re-sending the SAME notes text does not move the stamp', async () => {
  const current = await prisma.reservation.findUnique({ where: { id: ids.reservation } });
  const before = current.notesUpdatedAt;
  await new Promise((r) => setTimeout(r, 25));
  // The detail page always round-trips the full notes text on save — an
  // unchanged text must not read as "new note".
  await reservationsService.update(ids.reservation, { notes: current.notes }, { tenantId: ids.tenant });
  const after = await prisma.reservation.findUnique({ where: { id: ids.reservation } });
  assert.equal(after.notesUpdatedAt.getTime(), before.getTime(), 'identical text is not a new note');
});

test('editing the note text moves the stamp', async () => {
  const before = (await prisma.reservation.findUnique({ where: { id: ids.reservation } })).notesUpdatedAt;
  await new Promise((r) => setTimeout(r, 25));
  await reservationsService.update(ids.reservation, { notes: 'cliente llega tarde\nrevisar deposito' }, { tenantId: ids.tenant });
  const after = await prisma.reservation.findUnique({ where: { id: ids.reservation } });
  assert.ok(after.notesUpdatedAt.getTime() > before.getTime(), 'stamp advanced on a real edit');
});
