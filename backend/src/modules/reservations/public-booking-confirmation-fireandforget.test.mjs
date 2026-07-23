/**
 * DB-backed tests for firePublicBookingConfirmationEmail — the fire-and-forget
 * wrapper the two PUBLIC BOOKING create paths in booking-engine.service.js use
 * (RENTAL ~1888, CAR_SHARING ~2093). Requires DATABASE_URL.
 *
 * WHY THIS EXISTS: those two paths used to AWAIT the SMTP send inside the create
 * request, so every booking made from the website paid ~4-5s before the
 * confirmation screen could render. This is the public-facing sibling of the
 * beta.336 hotfix (e24d5c7), which fixed the same await on the staff /
 * quote-convert create path — see confirmation-email-on-create.test.mjs, whose
 * "CARE 1b" test this one mirrors.
 *
 * CARES PROVEN HERE (each bites):
 *  1. the wrapper RESOLVES to its caller before a slow send completes — the whole
 *     point of the fix; a regression here silently restores the 4-5s latency.
 *  2. the email still actually goes out, exactly once, to the on-file address.
 *  3. a mailer failure is swallowed (never throws at the caller) and is reported
 *     as emailSent:false — a booking must never fail because SMTP did.
 *  4. a REJECTION from inside the sender (not a mail failure — a DB-shaped error
 *     from the re-fetch, which sits outside the sender's own try/catch) is
 *     swallowed too, so the floating promise can never surface as an unhandled
 *     rejection and crash the process.
 *
 * The mailer is stubbed via the module's __test seam so no real SMTP is touched.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { PrismaClient } from '@prisma/client';
import { reservationsService } from './reservations.service.js';
import {
  __test as confirmEmailTest,
  firePublicBookingConfirmationEmail
} from './reservation-confirmation-email.js';

const prisma = new PrismaClient();
const TAG = `PBF-${Date.now()}`;
const ON_FILE_EMAIL = `pbf-onfile-${TAG}@example.com`;

const ids = { tenant: null, location: null, customer: null };
let scope = null;
let seq = 0;
let sent = [];

function futureWindow() {
  const n = ++seq;
  return {
    pickupAt: new Date(Date.now() + (7 + n) * 86400e3).toISOString(),
    returnAt: new Date(Date.now() + (10 + n) * 86400e3).toISOString()
  };
}

// Create a reservation WITHOUT letting the create path send anything of its own
// (sendConfirmationEmail:false is the documented opt-out), so every email these
// tests observe came from the wrapper under test.
async function makeReservation() {
  const { pickupAt, returnAt } = futureWindow();
  return reservationsService.create(
    {
      reservationNumber: `RES-${TAG}-${seq}`,
      customerId: ids.customer,
      pickupLocationId: ids.location,
      returnLocationId: ids.location,
      pickupAt,
      returnAt,
      dailyRate: 45,
      estimatedTotal: 265.88,
      sendConfirmationEmail: false
    },
    scope
  );
}

test.after(async () => {
  confirmEmailTest.reset();
  await prisma.reservation.deleteMany({ where: { tenantId: ids.tenant } }).catch(() => {});
  if (ids.customer) await prisma.customer.delete({ where: { id: ids.customer } }).catch(() => {});
  if (ids.location) await prisma.location.delete({ where: { id: ids.location } }).catch(() => {});
  if (ids.tenant) await prisma.tenant.delete({ where: { id: ids.tenant } }).catch(() => {});
  await prisma.$disconnect();
});

test('setup', async () => {
  const tenant = await prisma.tenant.create({ data: { name: `T ${TAG}`, slug: `t-${TAG}`.toLowerCase() } });
  ids.tenant = tenant.id;
  scope = { tenantId: tenant.id };
  const location = await prisma.location.create({
    data: { code: `L-${TAG}`.slice(0, 12), name: 'HQ', tenantId: tenant.id }
  });
  ids.location = location.id;
  const customer = await prisma.customer.create({
    data: { firstName: 'Ana', lastName: 'Rivera', phone: '7875550301', email: ON_FILE_EMAIL, tenantId: tenant.id }
  });
  ids.customer = customer.id;
  assert.ok(scope.tenantId);
});

test('CARE 1 + 2: the wrapper returns BEFORE a slow send finishes, and the email still goes out exactly once', async () => {
  const reservation = await makeReservation();

  let sendCompleted = false;
  sent = [];
  confirmEmailTest.setSender(async (msg) => {
    await new Promise((r) => setTimeout(r, 300));
    sent.push(msg);
    sendCompleted = true;
    return { ok: true };
  });

  const startedAt = Date.now();
  const floating = firePublicBookingConfirmationEmail({
    reservation,
    customer: { id: ids.customer, email: ON_FILE_EMAIL, firstName: 'Ana', lastName: 'Rivera' },
    tenant: { name: `T ${TAG}` },
    bookingType: 'RENTAL',
    vehicleLabel: 'Compact'
  });
  const elapsed = Date.now() - startedAt;

  // The caller (createPublicBooking) continues immediately — this is the fix.
  assert.equal(sendCompleted, false, 'the send must NOT have completed by the time the wrapper returned');
  assert.ok(elapsed < 250, `the wrapper must return without waiting on the send (took ${elapsed}ms)`);

  await confirmEmailTest.flushPending();

  assert.equal(sendCompleted, true, 'the send must complete in the background');
  assert.equal(sent.length, 1, 'exactly one confirmation email must be sent');
  assert.equal(sent[0].to, ON_FILE_EMAIL, 'recipient must be the on-file customer email');
  assert.match(
    String(sent[0].subject || ''),
    new RegExp(reservation.reservationNumber),
    'subject carries the reservation number'
  );
  assert.equal(await floating.then((r) => r.emailSent), true, 'the drained result reports the send succeeded');
});

test('CARE 3: a mailer failure is swallowed — a booking never fails because SMTP did', async () => {
  const reservation = await makeReservation();

  sent = [];
  confirmEmailTest.setSender(async () => { throw new Error('SMTP down (simulated)'); });

  const result = await firePublicBookingConfirmationEmail({
    reservation,
    customer: { id: ids.customer, email: ON_FILE_EMAIL, firstName: 'Ana', lastName: 'Rivera' },
    tenant: { name: `T ${TAG}` },
    bookingType: 'RENTAL'
  });

  assert.equal(result.emailSent, false, 'a mail failure reports emailSent:false');
  assert.ok(result.warning, 'and carries a warning explaining why');
  assert.equal(sent.length, 0, 'nothing was actually sent');
});

test('CARE 4: a rejection from inside the sender is swallowed, never an unhandled rejection', async () => {
  // The sender re-fetches the reservation OUTSIDE its own try/catch, so a
  // DB-shaped error there rejects rather than returning. A malformed id
  // reproduces that without needing to break the database.
  sent = [];
  confirmEmailTest.setSender(async (msg) => { sent.push(msg); return { ok: true }; });

  const result = await firePublicBookingConfirmationEmail({
    reservation: { id: { not: 'a valid id' }, reservationNumber: 'BOGUS' },
    customer: { id: ids.customer, email: ON_FILE_EMAIL, firstName: 'Ana', lastName: 'Rivera' },
    tenant: { name: `T ${TAG}` },
    bookingType: 'RENTAL'
  });

  assert.equal(result.emailSent, false, 'a rejection is converted into emailSent:false, not re-thrown');
  assert.ok(result.warning, 'and carries the error text as a warning');
  assert.equal(sent.length, 0, 'no email was sent');
});
