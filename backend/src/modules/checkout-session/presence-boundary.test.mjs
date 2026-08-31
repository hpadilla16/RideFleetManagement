/**
 * M2-H6 (2026-08-28) — THE PRESENCE EMIT BOUNDARY.
 *
 * activePresence() now ships `actorUserId`, the id of a real employee. The
 * reason that is safe is not a property of this module: it is a property of
 * WHO RECEIVES the array. Today presence is produced in exactly one place
 * (withPresence) and reaches exactly two routes, both on checkoutSessionRouter
 * behind requireAuth + requireModuleAccess('reservations'). The customer's
 * phone, the public signing page and the lobby kiosk never receive it — the
 * kiosk only WRITES presence and never reads it back.
 *
 * That audit is what makes a global field safe instead of requiring a
 * staff/customer payload split. An audit that lives only in a comment decays
 * on the first commit that adds a route, and it decays SILENTLY — the leak
 * would be a payload nobody looks at, on a screen a customer is holding. So
 * the audit is re-derived from the source on every CI run here, in the shape
 * this repo already uses for test:money-route-gate.
 *
 * The load-bearing test in this file is the LAST one: it plants a staff id in
 * presence and asserts it cannot be found anywhere in the payload the
 * customer's phone gets back for its handoff token. The structural checks
 * above it explain WHY that holds; the functional one proves it.
 *
 * DB-free (prisma stubbed, dummy DATABASE_URL per beta-ci.yml).
 * Run: npm run test:presence-boundary
 */
import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { prisma } from '../../lib/prisma.js';
import { checkoutPresenceService } from './checkout-presence.service.js';
import { checkoutSessionService } from './checkout-session.service.js';

const SRC = new URL('../../', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const read = (rel) => readFileSync(join(SRC, rel), 'utf8');

/** Every .js file under backend/src (tests and node_modules excluded). */
function sourceFiles(dir = SRC, out = []) {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) { sourceFiles(full, out); continue; }
    if (entry.endsWith('.js')) out.push(full);
  }
  return out;
}

// ── 1. WHO CAN EMIT PRESENCE AT ALL ─────────────────────────────────────────

test('presence is read in exactly one file — the staff checkout router', () => {
  const readers = sourceFiles()
    .filter((f) => !f.endsWith('checkout-presence.service.js'))
    .filter((f) => /\b(withPresence|activePresence)\s*\(/.test(readFileSync(f, 'utf8')))
    .map((f) => f.slice(SRC.length).replace(/\\/g, '/'))
    .sort();

  assert.deepEqual(
    readers,
    ['modules/checkout-session/checkout-session.routes.js'],
    'A NEW presence reader appeared. presence carries actorUserId (staff PII) and '
    + 'displayName (staff full names). If the new reader serves a customer-facing or '
    + 'device-authed surface, it must NOT ship this array — see the header of '
    + 'checkout-presence.service.js. Update this list only after auditing the new route.',
  );
});

test('the kiosk touches presence write-only — it never reads the array back', () => {
  const kiosk = read('modules/kiosk/kiosk-checkout.service.js');
  assert.match(kiosk, /checkoutPresenceService\.recordPresenceSafe\(/, 'kiosk still heartbeats');
  // The lobby tablet is operated by the CUSTOMER. It may announce itself into
  // presence; it may never be handed the list of who else is here.
  assert.doesNotMatch(
    kiosk,
    /checkoutPresenceService\.(withPresence|activePresence)\s*\(/,
    'The kiosk (customer-operated, device-authed) must never read presence — '
    + 'it would put employee ids and names on a lobby screen.',
  );
});

// ── 2. WHERE THOSE EMITS ARE MOUNTED ────────────────────────────────────────

test('every withPresence call sits on the authenticated router, never the public one', () => {
  const routes = read('modules/checkout-session/checkout-session.routes.js');

  // Split the file at each router registration so a call site can be attributed
  // to the router whose handler it is inside.
  const registrations = [...routes.matchAll(/^(checkoutSession(?:Public)?Router)\.(get|post|put|patch|delete)\(/gm)];
  assert.ok(registrations.length > 0, 'route registrations still parse');

  const emitters = new Set();
  for (let i = 0; i < registrations.length; i += 1) {
    const start = registrations[i].index;
    const end = i + 1 < registrations.length ? registrations[i + 1].index : routes.length;
    if (/withPresence\s*\(/.test(routes.slice(start, end))) emitters.add(registrations[i][1]);
  }

  assert.deepEqual(
    [...emitters].sort(),
    ['checkoutSessionRouter'],
    'withPresence() is registered on a router other than the staff one. '
    + 'checkoutSessionPublicRouter is mounted with NO auth (/api/public/checkout-handoff) — '
    + 'presence must never be serialized there.',
  );
});

test('the router that emits presence is mounted behind requireAuth', () => {
  const main = read('main.js');

  const staffMount = main.match(/^app\.use\('\/api\/checkout-sessions'.*$/m);
  assert.ok(staffMount, 'the /api/checkout-sessions mount still exists');
  assert.match(
    staffMount[0],
    /requireAuth/,
    'The presence-emitting router lost requireAuth — presence would become '
    + 'readable without a staff session.',
  );

  // And the public one is still exactly what it claims to be: no auth, which is
  // precisely why nothing on it may serialize presence (asserted above).
  const publicMount = main.match(/^app\.use\('\/api\/public\/checkout-handoff'.*$/m);
  assert.ok(publicMount, 'the public handoff mount still exists');
  assert.doesNotMatch(publicMount[0], /requireAuth/, 'public handoff is unauthenticated by design');
});

// ── 3. THE ONE THAT ACTUALLY PROTECTS THE CUSTOMER ──────────────────────────

let db;

beforeEach(() => {
  db = { tokens: [], presences: [], users: [] };
  const findToken = ({ where } = {}) =>
    db.tokens.find((t) => (where?.token ? t.token === where.token : t.id === where?.id)) || null;

  Object.assign(prisma.handoffToken, {
    findUnique: async (args) => findToken(args),
    findFirst: async (args) => findToken(args),
    update: async ({ where, data } = {}) => {
      const row = findToken({ where });
      if (!row) throw new Error('stub update: no match');
      Object.assign(row, data);
      return row;
    },
  });
  Object.assign(prisma.checkoutPresence, {
    findMany: async () => db.presences,
    findFirst: async () => db.presences[0] || null,
  });
  Object.assign(prisma.user, {
    findMany: async () => db.users,
  });
});

/** Every string that appears anywhere in a JSON-serializable payload. */
function deepStrings(value, out = []) {
  if (value == null) return out;
  if (typeof value === 'string') { out.push(value); return out; }
  if (Array.isArray(value)) { value.forEach((v) => deepStrings(v, out)); return out; }
  if (typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) { out.push(k); deepStrings(v, out); }
  }
  return out;
}

test('the customer phone payload carries no staff id, no staff name, no presence at all', async () => {
  const STAFF_ID = 'usr_staff_leak_canary';
  const STAFF_NAME = 'Jose Garcia';

  // A busy session: two employees present, plus the kiosk. This is exactly the
  // state H6 makes visible to the OTHER staff surfaces.
  db.users.push({ id: STAFF_ID, fullName: STAFF_NAME });
  db.presences.push(
    { id: 'p1', sessionId: 'cs1', surface: 'COUNTER', actorUserId: STAFF_ID, displayLabel: null, lastSeenAt: new Date() },
    { id: 'p2', sessionId: 'cs1', surface: 'RIDEOPS', actorUserId: 'usr_other', displayLabel: 'Ana (patio)', lastSeenAt: new Date() },
    { id: 'p3', sessionId: 'cs1', surface: 'KIOSK', actorUserId: null, displayLabel: 'Lobby 1', lastSeenAt: new Date() },
  );

  // The fixture has to be able to LEAK before "no leak" means anything: prove
  // the staff view really does carry both the id and the name right now.
  const staffView = await checkoutPresenceService.activePresence('cs1');
  const staffStrings = deepStrings(staffView);
  assert.ok(staffStrings.includes(STAFF_ID), 'staff view carries the actor id (H6)');
  assert.ok(staffStrings.includes(STAFF_NAME), 'staff view carries the actor name');

  // Now the customer's phone redeems its handoff token — the no-auth payload.
  db.tokens.push({
    id: 'h1',
    token: 'tok_customer_phone',
    kind: 'INSPECTION',
    expiresAt: new Date(Date.now() + 10 * 60_000),
    consumedAt: null,
    reservation: {
      id: 'res1', reservationNumber: 'R-1001', customerId: 'cus1',
      vehicleId: 'veh1', pickupAt: new Date(), returnAt: new Date(),
    },
  });

  const customerPayload = await checkoutSessionService.exchangeHandoffToken('tok_customer_phone');
  const leaked = deepStrings(customerPayload);

  assert.ok(!leaked.includes(STAFF_ID), `EMPLOYEE ID LEAK: ${STAFF_ID} reached the customer's phone`);
  assert.ok(!leaked.includes(STAFF_NAME), `EMPLOYEE NAME LEAK: ${STAFF_NAME} reached the customer's phone`);
  assert.ok(!leaked.includes('actorUserId'), 'no actorUserId key in a customer-facing payload');
  assert.ok(!leaked.includes('presence'), 'the customer-facing payload carries no presence array at all');
  assert.equal(customerPayload.reservation.reservationNumber, 'R-1001', 'and it still returns what the phone needs');
});
