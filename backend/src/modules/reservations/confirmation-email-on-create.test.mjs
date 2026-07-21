/**
 * DB-backed tests for the reservation CONFIRMATION email that reservationsService
 * .create() sends by consuming the (historically DEAD) sendConfirmationEmail flag.
 * Requires DATABASE_URL (localhost:5432/fleet_management on the dev Mac).
 *
 * BUG (the reason this exists): `sendConfirmationEmail` was persisted on every
 * reservation but NOTHING ever read it — so VozIA quote-convert reservations and
 * staff-created reservations sent NO confirmation email at all. The fix makes
 * create() consume the flag and fire an immediate branded confirmation to the
 * customer's ON-FILE email.
 *
 * MONEY/COMMS cares proven here (each bites):
 *  1. flag default (unset) + on-file email  → EXACTLY ONE send to the on-file
 *     address, and confirmationEmailSentAt is stamped.
 *  2. sendConfirmationEmail: false           → NOTHING sent (integration/public
 *     paths, which all set it false, are unaffected — no double-email).
 *  3. no customer email                       → no send, no stamp, no throw.
 *  4. mailer failure                          → reservation STILL commits
 *     (best-effort); no stamp; nothing rolled back.
 *  5. exactly ONCE                            → a second create for the same
 *     sourceRef is rejected by the dedupe and does NOT re-send; and the stamp
 *     guard blocks any re-entry for an already-sent reservation.
 *  6. ON-FILE email only                      → a payload-supplied address is
 *     never used; the send always goes to the persisted customer email.
 *
 * The mailer is stubbed via the module's __test seam so no real SMTP is touched.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { PrismaClient } from '@prisma/client';
import { reservationsService } from './reservations.service.js';
import {
  __test as confirmEmailTest,
  maybeSendConfirmationEmailOnCreate
} from './reservation-confirmation-email.js';

const prisma = new PrismaClient();
const TAG = `CFM-${Date.now()}`;

const ids = { tenant: null, location: null, vehicleType: null, customerWithEmail: null, customerNoEmail: null };
let scope = null;
let seq = 0;

// Captured outbound emails (populated by the stubbed sender).
let sent = [];
function installCapturingSender() {
  sent = [];
  confirmEmailTest.setSender(async (msg) => { sent.push(msg); return { ok: true }; });
}
function installThrowingSender() {
  sent = [];
  confirmEmailTest.setSender(async () => { throw new Error('SMTP down (simulated)'); });
}

const ON_FILE_EMAIL = `onfile-${TAG}@example.com`;

function futureWindow() {
  const n = ++seq;
  // Well into the future; the seeded location has no hours config so any time passes.
  const pickupAt = new Date(Date.now() + (7 + n) * 86400e3).toISOString();
  const returnAt = new Date(Date.now() + (10 + n) * 86400e3).toISOString();
  return { pickupAt, returnAt };
}

function baseCreateData(customerId, extra = {}) {
  const { pickupAt, returnAt } = futureWindow();
  return {
    reservationNumber: `RES-${TAG}-${seq}`,
    customerId,
    pickupLocationId: ids.location,
    returnLocationId: ids.location,
    pickupAt,
    returnAt,
    dailyRate: 45,
    estimatedTotal: 265.88,
    ...extra
  };
}

test.after(async () => {
  confirmEmailTest.reset();
  await prisma.reservation.deleteMany({ where: { tenantId: ids.tenant } }).catch(() => {});
  if (ids.customerWithEmail) await prisma.customer.delete({ where: { id: ids.customerWithEmail } }).catch(() => {});
  if (ids.customerNoEmail) await prisma.customer.delete({ where: { id: ids.customerNoEmail } }).catch(() => {});
  if (ids.vehicleType) await prisma.vehicleType.delete({ where: { id: ids.vehicleType } }).catch(() => {});
  if (ids.location) await prisma.location.delete({ where: { id: ids.location } }).catch(() => {});
  if (ids.tenant) await prisma.tenant.delete({ where: { id: ids.tenant } }).catch(() => {});
  await prisma.$disconnect();
});

test('setup', async () => {
  const tenant = await prisma.tenant.create({ data: { name: `T ${TAG}`, slug: `t-${TAG}`.toLowerCase() } });
  ids.tenant = tenant.id;
  scope = { tenantId: tenant.id };
  const location = await prisma.location.create({ data: { code: `L-${TAG}`.slice(0, 12), name: 'HQ', tenantId: tenant.id } });
  ids.location = location.id;
  const vt = await prisma.vehicleType.create({ data: { tenantId: tenant.id, code: `VT-${TAG}`.slice(0, 10), name: 'Compact' } });
  ids.vehicleType = vt.id;
  const c1 = await prisma.customer.create({
    data: { firstName: 'Maria', lastName: 'Hernandez', phone: '7875550101', email: ON_FILE_EMAIL, tenantId: tenant.id }
  });
  ids.customerWithEmail = c1.id;
  const c2 = await prisma.customer.create({
    data: { firstName: 'NoEmail', lastName: 'Customer', phone: '7875550102', email: null, tenantId: tenant.id }
  });
  ids.customerNoEmail = c2.id;
  assert.ok(scope.tenantId);
});

test('CARE 1 + 6: default flag + on-file email → exactly ONE send to the ON-FILE address, and confirmationEmailSentAt stamped', async () => {
  installCapturingSender();
  // A payload-supplied email must NEVER be used — pass a decoy to prove it.
  const created = await reservationsService.create(
    baseCreateData(ids.customerWithEmail, { email: 'attacker-payload@evil.com', contactEmail: 'attacker2@evil.com' }),
    scope
  );

  assert.equal(sent.length, 1, 'exactly one confirmation email must be sent');
  assert.equal(sent[0].to, ON_FILE_EMAIL, 'recipient must be the ON-FILE customer email');
  assert.notEqual(sent[0].to, 'attacker-payload@evil.com', 'must never send to a payload-supplied address');
  assert.match(String(sent[0].subject || ''), new RegExp(created.reservationNumber), 'subject carries the reservation number');

  const row = await prisma.reservation.findUnique({
    where: { id: created.id },
    select: { confirmationEmailSentAt: true }
  });
  assert.ok(row.confirmationEmailSentAt, 'confirmationEmailSentAt must be stamped after a successful send');
});

test('CARE 2: sendConfirmationEmail:false → NOTHING sent, no stamp (integration/public paths unaffected)', async () => {
  installCapturingSender();
  const created = await reservationsService.create(
    baseCreateData(ids.customerWithEmail, { sendConfirmationEmail: false }),
    scope
  );
  assert.equal(sent.length, 0, 'a false flag must suppress the email entirely (no double-email for integration paths)');
  const row = await prisma.reservation.findUnique({
    where: { id: created.id },
    select: { confirmationEmailSentAt: true }
  });
  assert.equal(row.confirmationEmailSentAt, null, 'no stamp when nothing was sent');
});

test('CARE 3: customer has no email → no send, no stamp, create still succeeds (no throw)', async () => {
  installCapturingSender();
  const created = await reservationsService.create(baseCreateData(ids.customerNoEmail), scope);
  assert.ok(created?.id, 'reservation must be created even without a customer email');
  assert.equal(sent.length, 0, 'no send when the customer has no email on file');
  const row = await prisma.reservation.findUnique({
    where: { id: created.id },
    select: { confirmationEmailSentAt: true }
  });
  assert.equal(row.confirmationEmailSentAt, null, 'no stamp when nothing was sent');
});

test('CARE 4: mailer failure → reservation STILL commits (best-effort), no stamp', async () => {
  installThrowingSender();
  const created = await reservationsService.create(baseCreateData(ids.customerWithEmail), scope);
  assert.ok(created?.id, 'a mailer failure must NEVER fail or roll back the reservation');
  const row = await prisma.reservation.findUnique({
    where: { id: created.id },
    select: { id: true, confirmationEmailSentAt: true }
  });
  assert.ok(row, 'the reservation row must exist despite the mail failure');
  assert.equal(row.confirmationEmailSentAt, null, 'no stamp when the send failed');
});

test('CARE 5a: exactly ONCE — a duplicate sourceRef create is rejected and does NOT re-send', async () => {
  installCapturingSender();
  const sourceRef = `QUOTE:${TAG}-once`;
  const first = await reservationsService.create(
    baseCreateData(ids.customerWithEmail, { sourceRef }),
    scope
  );
  assert.equal(sent.length, 1, 'first create sends exactly one email');

  // Second create for the SAME sourceRef (VozIA/convert retry) must be rejected
  // by the dedupe BEFORE any reservation/email is produced.
  await assert.rejects(
    reservationsService.create(
      baseCreateData(ids.customerWithEmail, { sourceRef }),
      scope
    ),
    /already exists/i,
    'duplicate sourceRef must be rejected'
  );
  assert.equal(sent.length, 1, 'the rejected retry must NOT send a second email');
  assert.ok(first.id);
});

test('CARE 5b: stamp guard — an already-stamped reservation is never re-sent', async () => {
  installCapturingSender();
  const result = await maybeSendConfirmationEmailOnCreate({
    reservation: {
      id: 'ignored',
      tenantId: ids.tenant,
      confirmationEmailSentAt: new Date(), // already sent
      customer: { email: ON_FILE_EMAIL, firstName: 'Maria', lastName: 'H' }
    }
  });
  assert.equal(result.skipped, 'already-sent', 'must skip when already stamped');
  assert.equal(sent.length, 0, 'no email when the stamp is already set');
});

test('CARE 2 (unit): explicit false flag is honored by the helper directly', async () => {
  installCapturingSender();
  const result = await maybeSendConfirmationEmailOnCreate({
    reservation: {
      id: 'ignored',
      tenantId: ids.tenant,
      customer: { email: ON_FILE_EMAIL, firstName: 'Maria', lastName: 'H' }
    },
    sendConfirmationEmail: false
  });
  assert.equal(result.skipped, 'flag-false');
  assert.equal(sent.length, 0);
});
