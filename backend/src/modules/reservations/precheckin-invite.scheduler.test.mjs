/**
 * Integration tests for the pre-check-in auto-invite scheduler (2026-06-28).
 * Requires a live Postgres via DATABASE_URL. Seeds its own tenant/customer/
 * location/reservations and cleans up. Deps (mailer/getConfig/now) are injected.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { PrismaClient } from '@prisma/client';
import { runPrecheckinInviteSweep, buildInviteEmail } from './precheckin-invite.scheduler.js';

const prisma = new PrismaClient();
const TAG = `PCI-${Date.now()}`;
const ids = { reservations: [], customers: [], tenant: null, location: null, locationOff: null };
const NOW = new Date('2026-07-01T12:00:00Z');
const hoursOut = (h) => new Date(NOW.getTime() + h * 3600e3);

function mailerSpy() {
  const sent = [];
  return { sent, sendEmail: async (m) => { sent.push(m); } };
}
const enabledCfg = { enabled: true, leadHours: 48, reminderEnabled: true, reminderLeadHours: 24 };
const getConfigEnabled = async () => ({ ...enabledCfg });
const getConfigDisabled = async () => ({ enabled: false, leadHours: 48, reminderEnabled: true, reminderLeadHours: 24 });
const noBrand = async () => undefined;

test.after(async () => {
  await prisma.reservation.deleteMany({ where: { id: { in: ids.reservations } } }).catch(() => {});
  await prisma.customer.deleteMany({ where: { id: { in: ids.customers } } }).catch(() => {});
  if (ids.location) await prisma.location.delete({ where: { id: ids.location } }).catch(() => {});
  if (ids.locationOff) await prisma.location.delete({ where: { id: ids.locationOff } }).catch(() => {});
  if (ids.tenant) await prisma.tenant.delete({ where: { id: ids.tenant } }).catch(() => {});
  await prisma.$disconnect();
});

async function seed() {
  const tenant = await prisma.tenant.create({ data: { name: `T ${TAG}`, slug: `t-${TAG}`.toLowerCase() } });
  ids.tenant = tenant.id;
  const loc = await prisma.location.create({ data: { code: `L-${TAG}`.slice(0, 12), name: 'Loc', tenantId: tenant.id } });
  ids.location = loc.id;
  return { tenant, loc };
}
async function mkCust(email, locale) {
  const c = await prisma.customer.create({ data: { firstName: 'Auto', lastName: 'Invite', phone: '7875550000', email, locale: locale || null, tenantId: ids.tenant } });
  ids.customers.push(c.id); return c;
}
async function mkRes(seed, num, custEmail, opts = {}) {
  const cust = await mkCust(custEmail, opts.locale);
  const pickupAt = hoursOut(opts.hoursToPickup ?? 30);
  const r = await prisma.reservation.create({ data: {
    reservationNumber: num, tenantId: ids.tenant, customerId: cust.id,
    pickupLocationId: seed.loc.id, returnLocationId: seed.loc.id,
    pickupAt, returnAt: new Date(pickupAt.getTime() + 3 * 86400e3),
    status: opts.status || 'CONFIRMED',
    customerInfoToken: opts.token || null,
    customerInfoCompletedAt: opts.completed ? NOW : null,
    precheckinAutoInviteSentAt: opts.inviteSent ? NOW : null,
    precheckinAutoReminderSentAt: opts.reminderSent ? NOW : null,
  } });
  ids.reservations.push(r.id);
  return r;
}

test('INVITE: sends to in-window, enabled, no-token, not-completed reservation and stamps it', async () => {
  const s = await seed();
  const r = await mkRes(s, `R-${TAG}-INV`, `inv-${TAG}@x.com`, { hoursToPickup: 30 });
  const mailer = mailerSpy();
  const out = await runPrecheckinInviteSweep({ prisma, mailer, now: () => NOW, getConfig: getConfigEnabled, resolveBrand: noBrand });
  assert.ok(out.invited >= 1);
  assert.equal(mailer.sent.length >= 1, true);
  const after = await prisma.reservation.findUnique({ where: { id: r.id } });
  assert.ok(after.precheckinAutoInviteSentAt, 'invite stamped');
  assert.ok(after.customerInfoToken, 'token minted');
});

test('DISABLED tenant: no sends', async () => {
  const s = { loc: { id: ids.location } };
  await mkRes(s, `R-${TAG}-OFF`, `off-${TAG}@x.com`, { hoursToPickup: 30 });
  const mailer = mailerSpy();
  const out = await runPrecheckinInviteSweep({ prisma, mailer, now: () => NOW, getConfig: getConfigDisabled, resolveBrand: noBrand });
  assert.equal(out.invited, 0);
  assert.equal(mailer.sent.length, 0);
});

test('Manual token already issued: auto-invite is skipped', async () => {
  const s = { loc: { id: ids.location } };
  const r = await mkRes(s, `R-${TAG}-MAN`, `man-${TAG}@x.com`, { hoursToPickup: 30, token: 'manual-token-xyz' });
  const mailer = mailerSpy();
  await runPrecheckinInviteSweep({ prisma, mailer, now: () => NOW, getConfig: getConfigEnabled, resolveBrand: noBrand });
  const after = await prisma.reservation.findUnique({ where: { id: r.id } });
  assert.equal(after.precheckinAutoInviteSentAt, null, 'not auto-invited');
  assert.equal(after.customerInfoToken, 'manual-token-xyz', 'manual token untouched');
});

test('REMINDER: invite already sent, inside reminder window, not completed -> reminded once', async () => {
  const s = { loc: { id: ids.location } };
  const r = await mkRes(s, `R-${TAG}-REM`, `rem-${TAG}@x.com`, { hoursToPickup: 12, inviteSent: true, token: 'tok-rem' });
  const mailer = mailerSpy();
  const out = await runPrecheckinInviteSweep({ prisma, mailer, now: () => NOW, getConfig: getConfigEnabled, resolveBrand: noBrand });
  assert.ok(out.reminded >= 1);
  const after = await prisma.reservation.findUnique({ where: { id: r.id } });
  assert.ok(after.precheckinAutoReminderSentAt, 'reminder stamped');
});

test('COMPLETED reservation is excluded', async () => {
  const s = { loc: { id: ids.location } };
  const r = await mkRes(s, `R-${TAG}-DONE`, `done-${TAG}@x.com`, { hoursToPickup: 12, completed: true });
  const mailer = mailerSpy();
  await runPrecheckinInviteSweep({ prisma, mailer, now: () => NOW, getConfig: getConfigEnabled, resolveBrand: noBrand });
  const after = await prisma.reservation.findUnique({ where: { id: r.id } });
  assert.equal(after.precheckinAutoInviteSentAt, null);
  assert.equal(after.precheckinAutoReminderSentAt, null);
});

test('DEDUPE: a second sweep does not re-invite the same reservation', async () => {
  const s = { loc: { id: ids.location } };
  const r = await mkRes(s, `R-${TAG}-DUP`, `dup-${TAG}@x.com`, { hoursToPickup: 30 });
  const m1 = mailerSpy();
  await runPrecheckinInviteSweep({ prisma, mailer: m1, now: () => NOW, getConfig: getConfigEnabled, resolveBrand: noBrand });
  const firstStamp = (await prisma.reservation.findUnique({ where: { id: r.id } })).precheckinAutoInviteSentAt;
  const m2 = mailerSpy();
  await runPrecheckinInviteSweep({ prisma, mailer: m2, now: () => NOW, getConfig: getConfigEnabled, resolveBrand: noBrand });
  const dupSent = m2.sent.filter((e) => e.to === `dup-${TAG}@x.com`);
  assert.equal(dupSent.length, 0, 'no resend on second sweep');
  assert.ok(firstStamp, 'still stamped');
});

test('LOCATION kill switch (LAX #7): precheckinAutoEmailEnabled=false on the pickup location skips the send', async () => {
  const locOff = await prisma.location.create({ data: {
    code: `LO-${TAG}`.slice(0, 12), name: 'Loc Off', tenantId: ids.tenant,
    locationConfig: JSON.stringify({ precheckinAutoEmailEnabled: false }),
  } });
  ids.locationOff = locOff.id;
  const s = { loc: { id: locOff.id } };
  const r = await mkRes(s, `R-${TAG}-LOFF`, `loff-${TAG}@x.com`, { hoursToPickup: 30 });
  const mailer = mailerSpy();
  const out = await runPrecheckinInviteSweep({ prisma, mailer, now: () => NOW, getConfig: getConfigEnabled, resolveBrand: noBrand });
  assert.ok(out.skippedLocationDisabled >= 1, 'counted as location-disabled');
  const sent = mailer.sent.filter((e) => e.to === `loff-${TAG}@x.com`);
  assert.equal(sent.length, 0, 'no email to the disabled location');
  const after = await prisma.reservation.findUnique({ where: { id: r.id } });
  assert.equal(after.precheckinAutoInviteSentAt, null, 'not stamped');
});

test('buildInviteEmail localizes EN/ES and includes the link', () => {
  const en = buildInviteEmail('INVITE', { reservationNumber: 'A1', customerName: 'Joe', link: 'https://x/y', locale: 'en' }, undefined);
  assert.match(en.subject, /Complete your pre-check-in/);
  assert.match(en.text, /https:\/\/x\/y/);
  const es = buildInviteEmail('REMINDER', { reservationNumber: 'A1', customerName: 'Jose', link: 'https://x/y', locale: 'es' }, undefined);
  assert.match(es.subject, /Recordatorio/);
});
