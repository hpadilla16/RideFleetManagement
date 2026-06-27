/**
 * Integration tests for the public website RENTAL self-serve endpoints
 * (2026-06-26): cancellation + license/insurance upload, keyed by
 * reservationNumber + email.
 *
 *   publicBookingService.cancelGuestBooking({ reservationNumber, email, tenantId })
 *   publicBookingService.submitBookingDocuments(reservationRef, { email, license?, insurance? })
 *
 * Requires a live Postgres via DATABASE_URL (same convention as the other
 * DB-backed suites). Seeds its own customer/location/reservations and cleans up.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { PrismaClient } from '@prisma/client';
import { publicBookingService } from './public-booking.service.js';

const prisma = new PrismaClient();
const TAG = `SS-${Date.now()}`;
const ids = { reservations: [], customer: null, location: null };
const EMAIL = `guest-${TAG}@example.com`.toLowerCase();
const PNG = 'data:image/png;base64,' + 'A'.repeat(400);

test.after(async () => {
  await prisma.reservation.deleteMany({ where: { id: { in: ids.reservations } } }).catch(() => {});
  if (ids.customer) await prisma.customer.delete({ where: { id: ids.customer } }).catch(() => {});
  if (ids.location) await prisma.location.delete({ where: { id: ids.location } }).catch(() => {});
  await prisma.$disconnect();
});

async function seedBase() {
  const cust = await prisma.customer.create({ data: { firstName: 'Self', lastName: 'Serve', phone: '7875551111', email: EMAIL } });
  const loc = await prisma.location.create({ data: { code: `SS-${TAG}`.slice(0, 12), name: 'Self-Serve Loc' } });
  ids.customer = cust.id; ids.location = loc.id;
  return { cust, loc };
}
async function mkReservation(seed, num, { hoursOut = 72, status = 'CONFIRMED' } = {}) {
  const pickupAt = new Date(Date.now() + hoursOut * 3600e3);
  const returnAt = new Date(pickupAt.getTime() + 3 * 86400e3);
  const r = await prisma.reservation.create({ data: {
    reservationNumber: num, customerId: seed.cust.id, pickupLocationId: seed.loc.id, returnLocationId: seed.loc.id,
    pickupAt, returnAt, status } });
  ids.reservations.push(r.id);
  return r;
}

test('cancelGuestBooking: cancels a CONFIRMED reservation >24h out with matching email', async () => {
  const seed = await seedBase();
  const r = await mkReservation(seed, `RES-${TAG}-OK`, { hoursOut: 72 });
  const out = await publicBookingService.cancelGuestBooking({ reservationNumber: r.reservationNumber, email: EMAIL });
  assert.equal(out.ok, true);
  assert.equal(out.status, 'CANCELLED');
  const after = await prisma.reservation.findUnique({ where: { id: r.id } });
  assert.equal(after.status, 'CANCELLED');
});

test('cancelGuestBooking: rejects email mismatch / missing fields / unknown reservation', async () => {
  const seed = { cust: { id: ids.customer }, loc: { id: ids.location } };
  const r = await mkReservation(seed, `RES-${TAG}-MM`, { hoursOut: 72 });
  await assert.rejects(() => publicBookingService.cancelGuestBooking({ reservationNumber: r.reservationNumber, email: 'wrong@example.com' }), /match/i);
  await assert.rejects(() => publicBookingService.cancelGuestBooking({ reservationNumber: r.reservationNumber }), /email is required/i);
  await assert.rejects(() => publicBookingService.cancelGuestBooking({ email: EMAIL }), /reservationNumber is required/i);
  await assert.rejects(() => publicBookingService.cancelGuestBooking({ reservationNumber: 'NOPE-404', email: EMAIL }), /not found/i);
});

test('cancelGuestBooking: enforces the 24h free-cancellation window', async () => {
  const seed = { cust: { id: ids.customer }, loc: { id: ids.location } };
  const r = await mkReservation(seed, `RES-${TAG}-SOON`, { hoursOut: 5 });
  await assert.rejects(() => publicBookingService.cancelGuestBooking({ reservationNumber: r.reservationNumber, email: EMAIL }), /window has passed/i);
  const after = await prisma.reservation.findUnique({ where: { id: r.id } });
  assert.equal(after.status, 'CONFIRMED', 'not cancelled inside the window');
});

test('cancelGuestBooking: refuses non-cancellable statuses (already checked out)', async () => {
  const seed = { cust: { id: ids.customer }, loc: { id: ids.location } };
  const r = await mkReservation(seed, `RES-${TAG}-OUT`, { hoursOut: 72, status: 'CHECKED_OUT' });
  await assert.rejects(() => publicBookingService.cancelGuestBooking({ reservationNumber: r.reservationNumber, email: EMAIL }), /cannot be cancelled/i);
});

test('submitBookingDocuments: stores license + insurance on the customer record', async () => {
  const seed = { cust: { id: ids.customer }, loc: { id: ids.location } };
  const r = await mkReservation(seed, `RES-${TAG}-DOC`, { hoursOut: 72 });
  const out = await publicBookingService.submitBookingDocuments(r.reservationNumber, { email: EMAIL, license: PNG, licenseBack: PNG, insurance: PNG });
  assert.equal(out.ok, true);
  assert.deepEqual(out.submitted.sort(), ['INSURANCE', 'LICENSE', 'LICENSE_BACK']);
  const cust = await prisma.customer.findUnique({ where: { id: ids.customer } });
  assert.equal(cust.idPhotoUrl, PNG, 'license front stored on idPhotoUrl');
  assert.equal(cust.licenseBackUrl, PNG, 'license back stored on licenseBackUrl');
  assert.equal(cust.insuranceDocumentUrl, PNG, 'insurance stored on insuranceDocumentUrl');
});

test('submitBookingDocuments: validates email, data URL, and at-least-one rule', async () => {
  const seed = { cust: { id: ids.customer }, loc: { id: ids.location } };
  const r = await mkReservation(seed, `RES-${TAG}-DOC2`, { hoursOut: 72 });
  await assert.rejects(() => publicBookingService.submitBookingDocuments(r.reservationNumber, { email: 'wrong@example.com', license: PNG }), /match/i);
  await assert.rejects(() => publicBookingService.submitBookingDocuments(r.reservationNumber, { email: EMAIL }), /at least one/i);
  await assert.rejects(() => publicBookingService.submitBookingDocuments(r.reservationNumber, { email: EMAIL, license: 'not-a-data-url' }), /base64 data URL/i);
  await assert.rejects(() => publicBookingService.submitBookingDocuments('NOPE-404', { email: EMAIL, license: PNG }), /not found/i);
});
