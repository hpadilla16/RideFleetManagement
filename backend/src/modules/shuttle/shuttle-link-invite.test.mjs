import test from 'node:test';
import assert from 'node:assert/strict';
import {
  LINK_LEAD_HOURS, linkExpiresAt, pickCandidates, reachable,
  buildLinkEmail, buildLinkSms,
} from './shuttle-link-invite.js';
import { runShuttleLinkInviteSweep } from './shuttle-link-invite.scheduler.js';

const NOW = new Date('2026-08-15T15:00:00Z');

// ── pure decisions ──────────────────────────────────────────────────────────

test('link dies 24h after the RETURN — the same link covers the return ride', () => {
  const out = linkExpiresAt({ returnAt: '2026-08-20T10:00:00Z', pickupAt: '2026-08-16T10:00:00Z' }, NOW);
  assert.equal(out.toISOString(), '2026-08-21T10:00:00.000Z');
});

test('no return date falls back to pickup + 48h', () => {
  const out = linkExpiresAt({ returnAt: null, pickupAt: '2026-08-16T10:00:00Z' }, NOW);
  assert.equal(out.toISOString(), '2026-08-18T10:00:00.000Z');
});

test('any prior link — even revoked — blocks a re-invite', () => {
  const rows = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
  const fresh = pickCandidates(rows, ['b']);
  assert.deepEqual(fresh.map((r) => r.id), ['a', 'c']);
});

test('a customer with no email and no phone is unreachable', () => {
  assert.equal(reachable({ email: ' ', phone: null }), false);
  assert.equal(reachable({ email: 'a@b.co' }), true);
  assert.equal(reachable({ phone: '+17875550100' }), true);
});

test('email and sms localize on the customer locale, not the tenant', () => {
  const es = buildLinkEmail({ reservationNumber: 'R-1', customerName: 'Ana', link: 'https://x/shuttle/t', locale: 'es-PR', locationName: 'SJU' }, undefined);
  assert.match(es.subject, /Sigue tu shuttle/);
  const en = buildLinkEmail({ reservationNumber: 'R-1', customerName: 'Ana', link: 'https://x/shuttle/t', locale: 'en', locationName: 'SJU' }, undefined);
  assert.match(en.subject, /Track your shuttle/);
  assert.match(buildLinkSms({ link: 'https://x/shuttle/t', locale: 'es', locationName: 'SJU', companyName: 'IRC' }), /IRC \(SJU\): sigue tu shuttle/);
  assert.match(buildLinkSms({ link: 'https://x/shuttle/t', locale: 'en' }), /track your shuttle live/);
});

// ── the sweep, against injected fakes ───────────────────────────────────────

function fakeWorld({ configs = [], reservations = [], links = [] } = {}) {
  const created = [];
  const deleted = [];
  const prisma = {
    shuttleTrackerConfig: { findMany: async () => configs },
    reservation: { findMany: async () => reservations },
    shuttleTrackerLink: {
      findMany: async () => links,
      create: async ({ data }) => { const row = { id: `lnk_${created.length}`, ...data }; created.push(row); return row; },
      delete: async ({ where }) => { deleted.push(where.id); },
    },
  };
  return { prisma, created, deleted };
}

const RES = (id, over = {}) => ({
  id, tenantId: 't1', reservationNumber: `R-${id}`,
  pickupAt: '2026-08-16T10:00:00Z', returnAt: '2026-08-20T10:00:00Z',
  customer: { firstName: 'Ana', lastName: 'Cruz', email: 'ana@x.co', phone: '+17875550100', locale: 'es' },
  pickupLocation: { name: 'SJU' },
  ...over,
});

test('sweep with no tracked locations does nothing and queries nothing else', async () => {
  const { prisma } = fakeWorld();
  prisma.reservation.findMany = async () => { throw new Error('must not be called'); };
  const counts = await runShuttleLinkInviteSweep({ prisma, mailer: {}, smsSend: async () => {}, now: () => NOW });
  assert.equal(counts.trackedLocations, 0);
  assert.equal(counts.invited, 0);
});

test('happy path: mints once, emails and texts, dedupes prior links', async () => {
  const emails = []; const texts = [];
  const world = fakeWorld({
    configs: [{ locationId: 'loc1', tenantId: 't1' }],
    reservations: [RES('r1'), RES('r2')],
    links: [{ reservationId: 'r2' }], // r2 already invited
  });
  const counts = await runShuttleLinkInviteSweep({
    prisma: world.prisma,
    mailer: { sendEmail: async (m) => emails.push(m) },
    smsSend: async (m) => texts.push(m),
    resolveBrand: async () => ({ companyName: 'IRC' }),
    now: () => NOW,
  });
  assert.equal(counts.invited, 1);
  assert.equal(counts.deduped, 1);
  assert.equal(counts.emailed, 1);
  assert.equal(counts.smsed, 1);
  assert.equal(world.created.length, 1);
  assert.equal(world.created[0].reservationId, 'r1');
  // token is base64url and long enough for the public endpoint's floor
  assert.match(world.created[0].token, /^[A-Za-z0-9_-]{30,}$/);
  assert.equal(world.created[0].expiresAt.toISOString(), '2026-08-21T10:00:00.000Z');
  assert.match(emails[0].subject, /Sigue tu shuttle/);
  assert.ok(texts[0].body.includes(world.created[0].token));
  assert.equal(texts[0].tenantId, 't1');
});

test('sms-unconfigured tenant still gets the email — sms failure is tolerated', async () => {
  const world = fakeWorld({ configs: [{ locationId: 'loc1', tenantId: 't1' }], reservations: [RES('r1')] });
  const counts = await runShuttleLinkInviteSweep({
    prisma: world.prisma,
    mailer: { sendEmail: async () => {} },
    smsSend: async () => { throw new Error('SMS is not configured for this tenant'); },
    now: () => NOW,
  });
  assert.equal(counts.invited, 1);
  assert.equal(counts.emailed, 1);
  assert.equal(counts.smsed, 0);
  assert.equal(world.deleted.length, 0);
});

test('NEITHER channel delivered → link un-minted so the next sweep retries', async () => {
  const world = fakeWorld({ configs: [{ locationId: 'loc1', tenantId: 't1' }], reservations: [RES('r1')] });
  const counts = await runShuttleLinkInviteSweep({
    prisma: world.prisma,
    mailer: { sendEmail: async () => { throw new Error('smtp down'); } },
    smsSend: async () => { throw new Error('no creds'); },
    now: () => NOW,
  });
  assert.equal(counts.invited, 0);
  assert.equal(counts.failed, 1);
  assert.equal(world.created.length, 1);
  assert.deepEqual(world.deleted, [world.created[0].id]); // the mint was rolled back
});

test('unreachable customer: nothing minted at all', async () => {
  const world = fakeWorld({
    configs: [{ locationId: 'loc1', tenantId: 't1' }],
    reservations: [RES('r1', { customer: { firstName: 'Ana', email: '', phone: '', locale: 'es' } })],
  });
  const counts = await runShuttleLinkInviteSweep({
    prisma: world.prisma, mailer: { sendEmail: async () => {} }, smsSend: async () => {}, now: () => NOW,
  });
  assert.equal(counts.skippedNoContact, 1);
  assert.equal(world.created.length, 0);
});

test('lead window constant is what the spec says', () => {
  assert.equal(LINK_LEAD_HOURS, 24);
});
