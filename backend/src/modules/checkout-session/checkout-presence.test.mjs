/**
 * M2 P1 — checkout presence tests (2026-08-17). DB-free: in-memory prisma
 * stubs in the kiosk-checkout.test.mjs style, dummy DATABASE_URL convention
 * from beta-ci.yml (a PrismaClient is constructed at import, never connected).
 *
 * What must never regress:
 *   • presence is INFORMATIVE — a presence failure degrades to presence: []
 *     and never breaks the session read the wizards poll on
 *   • the 45 s TTL is a READ-time filter (stale rows exist but don't render)
 *   • heartbeat upserts (one row per session+surface+actor, label preserved
 *     on label-less refreshes)
 *   • displayName resolution: label → user fullName → surface fallback
 * Run: npm run test:checkout-multisurface
 */
import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { prisma } from '../../lib/prisma.js';
import {
  checkoutPresenceService,
  PRESENCE_TTL_MS,
  CHECKOUT_SURFACES,
} from './checkout-presence.service.js';
import { CheckoutSessionError } from './checkout-session.service.js';

// ── minimal in-memory stubs ─────────────────────────────────────────────────

let db;

function matches(row, where) {
  return Object.entries(where || {}).every(([key, val]) => {
    if (val === undefined) return true;
    if (key === 'OR') return val.some((clause) => matches(row, clause));
    if (val === null) return row[key] == null;
    if (val instanceof Date || typeof val !== 'object') return row[key] === val;
    if ('gte' in val) return row[key] != null && row[key] >= val.gte;
    if ('in' in val) return val.in.includes(row[key]);
    return false;
  });
}

function stub(rows) {
  let seq = 0;
  return {
    findFirst: async ({ where } = {}) => rows().find((r) => matches(r, where)) || null,
    findUnique: async ({ where } = {}) => rows().find((r) => matches(r, where)) || null,
    findMany: async ({ where, orderBy } = {}) => {
      let out = rows().filter((r) => matches(r, where));
      if (orderBy?.lastSeenAt === 'desc') {
        out = [...out].sort((a, b) => b.lastSeenAt - a.lastSeenAt);
      }
      return out;
    },
    create: async ({ data } = {}) => {
      const row = { id: `row_${++seq}`, ...data };
      rows().push(row);
      return row;
    },
    update: async ({ where, data } = {}) => {
      const row = rows().find((r) => matches(r, where));
      if (!row) throw new Error('stub update: no match');
      Object.assign(row, data);
      return row;
    },
  };
}

beforeEach(() => {
  db = { sessions: [], presences: [], users: [] };
  Object.assign(prisma.checkoutSession, stub(() => db.sessions));
  Object.assign(prisma.checkoutPresence, stub(() => db.presences));
  Object.assign(prisma.user, stub(() => db.users));
});

const SESSION = { id: 'cs1', tenantId: 't1', reservationId: 'res1', currentStep: 'CONFIRMING' };

// ── heartbeat ───────────────────────────────────────────────────────────────

test('heartbeat: validates surface (400 UNKNOWN_SURFACE) and session (404)', async () => {
  db.sessions.push({ ...SESSION });
  await assert.rejects(
    () => checkoutPresenceService.heartbeat({ sessionId: 'cs1', surface: 'DRONE' }),
    (e) => e instanceof CheckoutSessionError && e.status === 400 && e.code === 'UNKNOWN_SURFACE',
  );
  await assert.rejects(
    () => checkoutPresenceService.heartbeat({ sessionId: 'nope', surface: 'RIDEOPS' }),
    (e) => e.status === 404,
  );
  // tenant soft-scope: mismatched tenant refuses, null-tenant legacy accepts
  await assert.rejects(
    () => checkoutPresenceService.heartbeat({ sessionId: 'cs1', surface: 'RIDEOPS', tenantId: 't2' }),
    (e) => e.status === 404,
  );
});

test('heartbeat: upserts one row per (session, surface, actor); label survives label-less refresh', async () => {
  db.sessions.push({ ...SESSION });

  const first = await checkoutPresenceService.heartbeat({
    sessionId: 'cs1', surface: 'rideops', actorUserId: 'u1', label: 'Ana (patio)',
  });
  assert.equal(first.ok, true);
  assert.equal(first.surface, 'RIDEOPS', 'surface normalized to uppercase');
  assert.equal(db.presences.length, 1);

  // Same actor+surface refreshes IN PLACE — no second row, label preserved.
  const before = db.presences[0].lastSeenAt;
  await new Promise((r) => setTimeout(r, 5));
  await checkoutPresenceService.heartbeat({ sessionId: 'cs1', surface: 'RIDEOPS', actorUserId: 'u1' });
  assert.equal(db.presences.length, 1, 'refresh must not mint a duplicate row');
  assert.equal(db.presences[0].displayLabel, 'Ana (patio)', 'label-less refresh keeps the chip name');
  assert.ok(db.presences[0].lastSeenAt >= before);

  // Different surface or actor = its own row.
  await checkoutPresenceService.heartbeat({ sessionId: 'cs1', surface: 'COUNTER', actorUserId: 'u1' });
  await checkoutPresenceService.heartbeat({ sessionId: 'cs1', surface: 'RIDEOPS', actorUserId: 'u2' });
  assert.equal(db.presences.length, 3);
});

// ── TTL + serialization ─────────────────────────────────────────────────────

test('activePresence: read-time TTL filter — stale rows exist but do not render', async () => {
  const now = new Date();
  db.presences.push(
    { id: 'p1', sessionId: 'cs1', surface: 'KIOSK', actorUserId: null, displayLabel: 'Lobby 1', lastSeenAt: new Date(now.getTime() - 10_000) },
    { id: 'p2', sessionId: 'cs1', surface: 'COUNTER', actorUserId: 'u1', displayLabel: null, lastSeenAt: new Date(now.getTime() - PRESENCE_TTL_MS - 1000) },
    { id: 'p3', sessionId: 'other', surface: 'COUNTER', actorUserId: 'u1', displayLabel: null, lastSeenAt: now },
  );
  const out = await checkoutPresenceService.activePresence('cs1', { now });
  assert.equal(out.length, 1, 'stale + other-session rows filtered out');
  assert.deepEqual(
    { surface: out[0].surface, displayName: out[0].displayName },
    { surface: 'KIOSK', displayName: 'Lobby 1' },
  );
});

test('activePresence: displayName = label → user fullName → surface fallback', async () => {
  const now = new Date();
  db.users.push({ id: 'u1', fullName: 'Ana Rivera' });
  db.presences.push(
    { id: 'p1', sessionId: 'cs1', surface: 'COUNTER', actorUserId: 'u1', displayLabel: null, lastSeenAt: now },
    { id: 'p2', sessionId: 'cs1', surface: 'CUSTOMER', actorUserId: null, displayLabel: null, lastSeenAt: new Date(now.getTime() - 1) },
  );
  const out = await checkoutPresenceService.activePresence('cs1', { now });
  assert.equal(out[0].displayName, 'Ana Rivera', 'no label → staff fullName');
  assert.equal(out[1].displayName, 'Customer', 'no label, no user → generic surface label');
});

test('withPresence: attaches additive presence field and NEVER breaks the read', async () => {
  const now = new Date();
  db.presences.push({ id: 'p1', sessionId: 'cs1', surface: 'KIOSK', actorUserId: null, displayLabel: 'Lobby 1', lastSeenAt: now });

  const ok = await checkoutPresenceService.withPresence({ ...SESSION });
  assert.equal(ok.currentStep, 'CONFIRMING', 'session fields untouched');
  assert.equal(ok.presence.length, 1);

  // Presence infrastructure exploding must degrade to [] — the wizards poll
  // GET /:id every 5 s; a presence hiccup must not take the poll down.
  prisma.checkoutPresence.findMany = async () => { throw new Error('boom'); };
  const degraded = await checkoutPresenceService.withPresence({ ...SESSION });
  assert.deepEqual(degraded.presence, [], 'failure degrades to empty presence');
  assert.equal(degraded.id, 'cs1');

  // Null session (route 404 path) passes through untouched.
  assert.equal(await checkoutPresenceService.withPresence(null), null);
});

test('recordPresenceSafe: fire-and-forget writer never rejects, rejects junk quietly', async () => {
  const row = await checkoutPresenceService.recordPresenceSafe({
    sessionId: 'cs1', surface: 'KIOSK', displayLabel: 'Lobby 1',
  });
  assert.ok(row, 'writes the presence row');
  assert.equal(db.presences.length, 1);

  assert.equal(await checkoutPresenceService.recordPresenceSafe({ sessionId: 'cs1', surface: 'DRONE' }), null);
  assert.equal(await checkoutPresenceService.recordPresenceSafe({ sessionId: null, surface: 'KIOSK' }), null);

  prisma.checkoutPresence.findFirst = async () => { throw new Error('db down'); };
  const out = await checkoutPresenceService.recordPresenceSafe({ sessionId: 'cs1', surface: 'KIOSK' });
  assert.equal(out, null, 'infrastructure failure swallowed — never a rejection');
});

test('surface list matches the Prisma enum contract', () => {
  assert.deepEqual(CHECKOUT_SURFACES, ['RIDEOPS', 'COUNTER', 'KIOSK', 'CUSTOMER']);
});
