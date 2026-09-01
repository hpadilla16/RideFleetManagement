/**
 * Maintenance detection at check-in (Feature A, 2026-09-01).
 * Run via: npm run test:maintenance-checkin
 *
 * Covers, in order:
 *  A. Model discipline — the 20260902_maintenance_checkin migration against
 *     schema.prisma (column parity), additive/idempotent statement rules, and
 *     the pinned-predecessor sort (pinned against 20260901_notification_center,
 *     the migration that was newest when this one shipped).
 *  B. evalSchedule integration against TYPED readings — the exact mockup
 *     numbers: the reading the agent types is what crosses the interval.
 *  C. The close-time executor — SNOOZE records the silent stamp + marker and
 *     emits the NEEDS_ACTION envelope (deduped per vehicle+event); SEND opens
 *     the SCHEDULED RO with one line per flagged service and emits the INFO
 *     envelope naming the RO; a failed RO-open returns FAILED with the error
 *     recorded and NEVER throws (money first — the check-in has already
 *     completed).
 *  D. The snooze marker lifecycle — consumeSnooze clears on wizard open and
 *     returns the stamp; absent marker is a quiet no; scope gates hold.
 *  E. retryCheckinDecision — re-attempts a failed SEND, idempotent when the
 *     RO already exists, refuses non-SEND rows.
 *  F. Wiring — checkin-close calls the Safe executor AFTER its status syncs
 *     (arm at Step 3, fire after close's own sync), returns the outcome as
 *     `maintenance`; the maintenance router mounts consume + retry.
 *
 * DB-FREE: every service call injects a fake db (same technique as
 * maintenance.service.test.mjs); the Prisma client never connects.
 */

// MUST be first — sets DATABASE_URL etc. before lib/prisma.js constructs.
import '../../lib/_two-factor-test-env.mjs';

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

import { evalSchedule } from './maintenance.service.js';
import {
  executeCheckinMaintenanceDecisionSafe,
  consumeSnooze,
  retryCheckinDecision,
  CHECKIN_DECISIONS,
} from './maintenance-checkin.service.js';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));

// ───────────────────────── A. model / migration discipline ─────────────────

const MIGRATION_DIR = '20260902_maintenance_checkin';
// The migration that was newest when this one shipped. Pinned predecessor,
// not "newest in repo" — see billing-model.test.mjs for why.
const MIGRATION_PREDECESSOR = '20260901_notification_center';
const SQL = readFileSync(join(ROOT, 'prisma', 'migrations', MIGRATION_DIR, 'migration.sql'), 'utf8');
const SCHEMA = readFileSync(join(ROOT, 'prisma', 'schema.prisma'), 'utf8');
const STATEMENTS = SQL.replace(/^\s*--.*$/gm, '');

test('MaintenanceCheckinDecision: migration and schema.prisma declare the same columns', () => {
  const re = /CREATE TABLE IF NOT EXISTS "MaintenanceCheckinDecision" \(([\s\S]*?)\n\);/;
  const body = re.exec(SQL)?.[1];
  assert.ok(body, 'migration has no CREATE TABLE for MaintenanceCheckinDecision');
  const sqlCols = new Set();
  for (const line of body.split('\n')) {
    const m = /^\s*"(\w+)"\s/.exec(line);
    if (m) sqlCols.add(m[1]);
  }
  const modelRe = /\nmodel MaintenanceCheckinDecision \{([\s\S]*?)\n\}/;
  const modelBody = modelRe.exec(SCHEMA)?.[1];
  assert.ok(modelBody, 'schema.prisma has no model MaintenanceCheckinDecision');
  const fields = new Set();
  for (const line of modelBody.split('\n')) {
    const m = /^\s{2}(\w+)\s+\S+/.exec(line);
    if (m && !m[1].startsWith('@')) fields.add(m[1]);
  }
  const missingInSql = [...fields].filter((k) => !sqlCols.has(k));
  const missingInPrisma = [...sqlCols].filter((k) => !fields.has(k));
  assert.deepEqual(missingInSql, [], `in schema.prisma but not in the migration: ${missingInSql}`);
  assert.deepEqual(missingInPrisma, [], `in the migration but not in schema.prisma: ${missingInPrisma}`);
});

test('migration is additive and idempotent — no DROP/ALTER, IF NOT EXISTS everywhere', () => {
  assert.doesNotMatch(STATEMENTS, /\bDROP\b/i, 'no DROP of any kind');
  assert.doesNotMatch(STATEMENTS, /\bALTER TABLE\b/i, 'creates its own table only — never alters an existing one');
  assert.doesNotMatch(STATEMENTS, /\bCREATE TYPE\b/i, 'decision is TEXT, never a Postgres enum (additive rule)');
  const creates = STATEMENTS.match(/CREATE TABLE/gi) || [];
  const createsGuarded = STATEMENTS.match(/CREATE TABLE IF NOT EXISTS/gi) || [];
  assert.equal(creates.length, createsGuarded.length, 'every CREATE TABLE is IF NOT EXISTS');
  const idx = STATEMENTS.match(/CREATE (UNIQUE )?INDEX/gi) || [];
  const idxGuarded = STATEMENTS.match(/CREATE (UNIQUE )?INDEX IF NOT EXISTS/gi) || [];
  assert.equal(idx.length, idxGuarded.length, 'every CREATE INDEX is IF NOT EXISTS');
  assert.doesNotMatch(STATEMENTS, /FOREIGN KEY|REFERENCES/i, 'loose ids, observation-table style — no FKs');
});

test(`${MIGRATION_DIR} sorts after its pinned predecessor`, () => {
  const dirs = readdirSync(join(ROOT, 'prisma', 'migrations'), { withFileTypes: true })
    .filter((d) => d.isDirectory()).map((d) => d.name).sort();
  const at = dirs.indexOf(MIGRATION_DIR);
  const predecessorAt = dirs.indexOf(MIGRATION_PREDECESSOR);
  assert.ok(at !== -1, `${MIGRATION_DIR} is missing from prisma/migrations`);
  assert.ok(predecessorAt !== -1, `${MIGRATION_PREDECESSOR} is missing from prisma/migrations`);
  assert.ok(at > predecessorAt,
    `${MIGRATION_DIR} sorts before ${MIGRATION_PREDECESSOR} and would be skipped on a baselined DB`);
});

// ─────────────── B. evalSchedule against the TYPED reading ─────────────────
// The mockup's own numbers: nothing due at the pre-filled 48,318; the typed
// 48,730 crosses the LOF interval (1,230 mi overdue) and pulls TIRE_ROTATION
// into due-soon (370 mi out). The banner evaluates the typed value — the
// write to Vehicle.mileage hasn't happened yet.

const NOW = new Date('2026-09-01T14:14:00Z').getTime();
const LOF = { intervalMiles: 5000, intervalDays: null, lastServiceMiles: 42500, lastServiceAt: null };
const TIRES = { intervalMiles: 7500, intervalDays: null, lastServiceMiles: 41600, lastServiceAt: null };

test('typed odometer crossing the interval flips OVERDUE with the concrete gap', () => {
  const before = evalSchedule(LOF, 47400, NOW);
  assert.equal(before.overdue, false);
  const at = evalSchedule(LOF, 48730, NOW);
  assert.equal(at.overdue, true);
  assert.equal(at.nextDueMiles, 47500);
  assert.equal(at.dueByMiles, 1230); // "Oil change — 1,230 mi overdue"
});

test('due-soon rider at the same typed reading (within 500 mi)', () => {
  const ev = evalSchedule(TIRES, 48730, NOW);
  assert.equal(ev.overdue, false);
  assert.equal(ev.soon, true);
  assert.equal(ev.nextDueMiles, 49100);
  assert.equal(ev.dueByMiles, -370); // "due in 370 mi"
});

// ───────────────────────── fakes for the executor ───────────────────────────

function fakeDb({ vehicle, user, decisions = [] } = {}) {
  const calls = { creates: [], updates: [], updateManys: [] };
  let idSeq = 0;
  return {
    calls,
    vehicle: {
      findUnique: async () => vehicle ?? null,
      findFirst: async ({ where }) => {
        if (!vehicle) return null;
        if (where?.tenantId && vehicle.tenantId && where.tenantId !== vehicle.tenantId) return null;
        if (where?.homeLocationId?.in && !where.homeLocationId.in.includes(vehicle.homeLocationId)) return null;
        return vehicle;
      },
    },
    user: { findUnique: async () => user ?? null },
    maintenanceCheckinDecision: {
      create: async ({ data }) => {
        const row = { id: `dec-${++idSeq}`, createdAt: new Date(NOW), clearedAt: null, ...data };
        calls.creates.push(row);
        return row;
      },
      update: async ({ where, data }) => { calls.updates.push({ where, data }); return { ...where, ...data }; },
      updateMany: async ({ where, data }) => { calls.updateManys.push({ where, data }); return { count: decisions.length }; },
      findFirst: async () => decisions[0] ?? null,
    },
  };
}

function emitSpy() {
  const emitted = [];
  const fn = async (input) => { emitted.push(input); return { id: 'evt' }; };
  fn.emitted = emitted;
  return fn;
}

function fakeRepairOrders({ failCreate = false } = {}) {
  const calls = { creates: [], lines: [] };
  return {
    calls,
    create: async (body, scope) => {
      if (failCreate) { const e = new Error('db down'); throw e; }
      calls.creates.push({ body, scope });
      return { id: 'ro-1', label: 'RO-0007' };
    },
    addLine: async (id, body, scope) => { calls.lines.push({ id, body, scope }); return { id }; },
  };
}

const BASE = {
  tenantId: 't1',
  vehicleId: 'v1',
  reservationId: 'res-1',
  rentalAgreementId: 'ra-1',
  reservationNumber: 'RES-849112',
  locationId: 'loc-1',
  odometer: 48730,
  actorUserId: 'u1',
};
const VEHICLE = { id: 'v1', tenantId: 't1', plate: 'JVX-482', internalNumber: 'UNIT-025', homeLocationId: 'loc-1' };
const USER = { fullName: 'J. Rivera', email: 'jr@example.com' };

// ───────────────────────── C. the close-time executor ──────────────────────

test('SNOOZE records the silent stamp (who · reservation · odometer) as the active marker', async () => {
  const db = fakeDb({ vehicle: VEHICLE, user: USER });
  const emit = emitSpy();
  const out = await executeCheckinMaintenanceDecisionSafe(
    { ...BASE, action: 'SNOOZE', serviceTypes: ['LOF', 'TIRE_ROTATION'], note: 'shop at capacity' },
    { db, emit, now: NOW },
  );
  assert.equal(out.status, 'SNOOZED');
  assert.equal(db.calls.creates.length, 1);
  const row = db.calls.creates[0];
  assert.equal(row.decision, 'SNOOZE');
  assert.equal(row.byUserId, 'u1');
  assert.equal(row.byName, 'J. Rivera');
  assert.equal(row.reservationNumber, 'RES-849112');
  assert.equal(row.odometer, 48730);
  assert.equal(row.note, 'shop at capacity');
  assert.deepEqual(JSON.parse(row.serviceTypesJson), ['LOF', 'TIRE_ROTATION']);
  // The marker: a SNOOZE row is born ACTIVE (clearedAt not stamped at create).
  assert.equal(row.clearedAt, null);
  // Any previous active snooze for the vehicle is superseded first.
  assert.equal(db.calls.updateManys.length, 1);
  assert.deepEqual(db.calls.updateManys[0].where, { tenantId: 't1', vehicleId: 'v1', decision: 'SNOOZE', clearedAt: null });
});

test('SNOOZE emits the NEEDS_ACTION envelope with the pinned copy, deduped per vehicle+event', async () => {
  const db = fakeDb({ vehicle: VEHICLE, user: USER });
  const emit = emitSpy();
  await executeCheckinMaintenanceDecisionSafe(
    { ...BASE, action: 'SNOOZE', serviceTypes: ['LOF'] },
    { db, emit, now: NOW },
  );
  assert.equal(emit.emitted.length, 1);
  const evt = emit.emitted[0];
  assert.equal(evt.severity, 'NEEDS_ACTION');
  assert.equal(evt.sourceType, 'MAINTENANCE');
  assert.equal(evt.templateKey, 'maintSnoozed');
  assert.equal(evt.title, 'Maintenance snoozed at check-in — UNIT-025');
  assert.match(evt.body, /Snoozed by J\. Rivera — re-prompts at next rental event/);
  assert.equal(evt.dedupeKey, 'maint-snooze:v1:res-1');
  assert.deepEqual(evt.paramsJson, { unit: 'UNIT-025', name: 'J. Rivera' });
  // Same vehicle+event again → the SAME dedupeKey (upsert no-op downstream).
  const emit2 = emitSpy();
  await executeCheckinMaintenanceDecisionSafe(
    { ...BASE, action: 'SNOOZE', serviceTypes: ['LOF'] },
    { db: fakeDb({ vehicle: VEHICLE, user: USER }), emit: emit2, now: NOW },
  );
  assert.equal(emit2.emitted[0].dedupeKey, evt.dedupeKey);
});

test('SEND opens the SCHEDULED RO with one line per flagged service and emits INFO naming the RO', async () => {
  const db = fakeDb({ vehicle: VEHICLE, user: USER });
  const emit = emitSpy();
  const repairOrders = fakeRepairOrders();
  const out = await executeCheckinMaintenanceDecisionSafe(
    { ...BASE, action: 'SEND', serviceTypes: ['LOF', 'TIRE_ROTATION'] },
    { db, emit, repairOrders, now: NOW },
  );
  assert.equal(out.status, 'SENT');
  assert.equal(out.repairOrderId, 'ro-1');
  assert.equal(out.roLabel, 'RO-0007');
  // The RO: source SCHEDULED, the typed odometer, the actor's scope.
  assert.equal(repairOrders.calls.creates.length, 1);
  const created = repairOrders.calls.creates[0];
  assert.equal(created.body.source, 'SCHEDULED');
  assert.equal(created.body.odometerAtOpen, 48730);
  assert.equal(created.scope.tenantId, 't1');
  // One free-text line per service, type code greppable in the description.
  assert.equal(repairOrders.calls.lines.length, 2);
  assert.match(repairOrders.calls.lines[0].body.description, /Oil change \(LOF\)/);
  assert.match(repairOrders.calls.lines[1].body.description, /Tire rotation \(TIRE_ROTATION\)/);
  // The decision row gets its execution trail.
  assert.ok(db.calls.updates.some((u) => u.data.repairOrderId === 'ro-1'));
  // INFO envelope naming the RO.
  const evt = emit.emitted.find((e) => e.templateKey === 'maintCheckinSent');
  assert.ok(evt, 'INFO envelope emitted');
  assert.equal(evt.severity, 'INFO');
  assert.equal(evt.title, 'Sent to maintenance at check-in — UNIT-025 · RO-0007');
  assert.equal(evt.dedupeKey, 'maint-checkin-sent:v1:ro-1');
});

test('SEND rows are execution records, never markers — born cleared', async () => {
  const db = fakeDb({ vehicle: VEHICLE, user: USER });
  await executeCheckinMaintenanceDecisionSafe(
    { ...BASE, action: 'SEND', serviceTypes: ['LOF'] },
    { db, emit: emitSpy(), repairOrders: fakeRepairOrders(), now: NOW },
  );
  const row = db.calls.creates[0];
  assert.ok(row.clearedAt, 'SEND row must not read as an active snooze marker');
});

test('RO-open failure at close: FAILED outcome + lastError recorded, and it NEVER throws (money first)', async () => {
  const db = fakeDb({ vehicle: VEHICLE, user: USER });
  const out = await executeCheckinMaintenanceDecisionSafe(
    { ...BASE, action: 'SEND', serviceTypes: ['LOF'] },
    { db, emit: emitSpy(), repairOrders: fakeRepairOrders({ failCreate: true }), now: NOW },
  );
  assert.equal(out.status, 'FAILED');
  assert.match(out.error, /db down/);
  assert.ok(out.decisionId, 'the stamp row survives the failure — it is the retry handle');
  assert.ok(db.calls.updates.some((u) => /db down/.test(u.data.lastError || '')),
    'lastError recorded on the decision row');
});

test('invalid or absent decisions are a quiet null (legacy close payloads unchanged)', async () => {
  assert.equal(await executeCheckinMaintenanceDecisionSafe({ ...BASE, action: 'DELETE_CAR' }, { db: fakeDb({}), emit: emitSpy() }), null);
  assert.equal(await executeCheckinMaintenanceDecisionSafe({ ...BASE, action: null }, { db: fakeDb({}), emit: emitSpy() }), null);
  assert.equal(await executeCheckinMaintenanceDecisionSafe({}, { db: fakeDb({}), emit: emitSpy() }), null);
  assert.deepEqual([...CHECKIN_DECISIONS], ['SEND', 'SNOOZE']);
});

test('unknown service types are dropped, known ones kept', async () => {
  const db = fakeDb({ vehicle: VEHICLE, user: USER });
  await executeCheckinMaintenanceDecisionSafe(
    { ...BASE, action: 'SNOOZE', serviceTypes: ['LOF', 'WAX', 'lof', 'BRAKES'] },
    { db, emit: emitSpy(), now: NOW },
  );
  assert.deepEqual(JSON.parse(db.calls.creates[0].serviceTypesJson), ['LOF', 'BRAKES']);
});

// ───────────────────────── D. the snooze marker lifecycle ──────────────────

const SNOOZE_ROW = {
  id: 'dec-9', tenantId: 't1', vehicleId: 'v1', decision: 'SNOOZE', clearedAt: null,
  byName: 'J. Rivera', byUserId: 'u1', reservationNumber: 'RES-849112',
  odometer: 48730, note: 'shop at capacity', createdAt: new Date(NOW),
  serviceTypesJson: '["LOF","TIRE_ROTATION"]',
};

test('consumeSnooze: marker present → cleared with the event and the stamp returned', async () => {
  const db = fakeDb({ vehicle: VEHICLE, decisions: [SNOOZE_ROW] });
  const out = await consumeSnooze('v1', 'CHECKOUT', { tenantId: 't1' }, { db, now: NOW });
  assert.equal(out.snoozed, true);
  assert.equal(out.stamp.byName, 'J. Rivera');
  assert.equal(out.stamp.reservationNumber, 'RES-849112');
  assert.equal(out.stamp.odometer, 48730);
  assert.equal(out.stamp.note, 'shop at capacity');
  assert.deepEqual(out.stamp.serviceTypes, ['LOF', 'TIRE_ROTATION']);
  const clear = db.calls.updateManys.find((u) => u.data.clearedEvent === 'CHECKOUT');
  assert.ok(clear, 'marker cleared with the consuming event stamped');
  assert.deepEqual(clear.where, { vehicleId: 'v1', tenantId: 't1', decision: 'SNOOZE', clearedAt: null });
});

test('consumeSnooze: no marker → quiet {snoozed:false}, nothing written', async () => {
  const db = fakeDb({ vehicle: VEHICLE, decisions: [] });
  const out = await consumeSnooze('v1', 'CHECKIN', { tenantId: 't1' }, { db, now: NOW });
  assert.deepEqual(out, { snoozed: false, stamp: null });
  assert.equal(db.calls.updateManys.length, 0);
});

test('consumeSnooze: scope gates — out-of-scope vehicle 404s, deny-all tenant 400s', async () => {
  const db = fakeDb({ vehicle: VEHICLE, decisions: [SNOOZE_ROW] });
  await assert.rejects(
    () => consumeSnooze('v1', 'CHECKIN', { tenantId: 't1', allowedLocationIds: ['other-loc'] }, { db }),
    (e) => e.status === 404,
  );
  await assert.rejects(
    () => consumeSnooze('v1', 'CHECKIN', { tenantId: '__no_tenant__' }, { db }),
    (e) => e.status === 400,
  );
});

// ───────────────────────── E. retry ─────────────────────────────────────────

const FAILED_SEND_ROW = {
  id: 'dec-5', tenantId: 't1', vehicleId: 'v1', decision: 'SEND', repairOrderId: null,
  reservationNumber: 'RES-849112', odometer: 48730, byUserId: 'u1',
  serviceTypesJson: '["LOF"]', lastError: 'db down', createdAt: new Date(NOW),
};

test('retryCheckinDecision re-attempts the RO-open and stamps the trail', async () => {
  const db = fakeDb({ vehicle: VEHICLE, decisions: [FAILED_SEND_ROW] });
  const repairOrders = fakeRepairOrders();
  const emit = emitSpy();
  const out = await retryCheckinDecision('dec-5', { tenantId: 't1' }, { db, repairOrders, emit });
  assert.equal(out.status, 'SENT');
  assert.equal(out.repairOrderId, 'ro-1');
  assert.equal(repairOrders.calls.creates[0].body.source, 'SCHEDULED');
  assert.ok(db.calls.updates.some((u) => u.data.repairOrderId === 'ro-1'));
  assert.equal(emit.emitted[0].templateKey, 'maintCheckinSent');
});

test('retryCheckinDecision is idempotent — an RO already open answers SENT without a second RO', async () => {
  const db = fakeDb({ vehicle: VEHICLE, decisions: [{ ...FAILED_SEND_ROW, repairOrderId: 'ro-1' }] });
  const repairOrders = fakeRepairOrders();
  const out = await retryCheckinDecision('dec-5', { tenantId: 't1' }, { db, repairOrders, emit: emitSpy() });
  assert.equal(out.status, 'SENT');
  assert.equal(out.alreadyOpen, true);
  assert.equal(repairOrders.calls.creates.length, 0);
});

test('retryCheckinDecision refuses non-SEND rows and unknown ids', async () => {
  const db = fakeDb({ vehicle: VEHICLE, decisions: [{ ...FAILED_SEND_ROW, decision: 'SNOOZE' }] });
  await assert.rejects(
    () => retryCheckinDecision('dec-5', { tenantId: 't1' }, { db, repairOrders: fakeRepairOrders(), emit: emitSpy() }),
    (e) => e.status === 400,
  );
  const empty = fakeDb({ vehicle: VEHICLE, decisions: [] });
  await assert.rejects(
    () => retryCheckinDecision('dec-x', { tenantId: 't1' }, { db: empty, repairOrders: fakeRepairOrders(), emit: emitSpy() }),
    (e) => e.status === 404,
  );
});

test('retry surfaces a second failure as an error AND records it (the wizard can retry again)', async () => {
  const db = fakeDb({ vehicle: VEHICLE, decisions: [FAILED_SEND_ROW] });
  await assert.rejects(
    () => retryCheckinDecision('dec-5', { tenantId: 't1' }, { db, repairOrders: fakeRepairOrders({ failCreate: true }), emit: emitSpy() }),
    /db down/,
  );
  assert.ok(db.calls.updates.some((u) => /db down/.test(u.data.lastError || '')));
});

// ───────────────────────── F. wiring (source assertions) ────────────────────

const CLOSE_SRC = readFileSync(join(ROOT, 'src', 'modules', 'rental-agreements', 'checkin-close.service.js'), 'utf8');
const ROUTES_SRC = readFileSync(join(ROOT, 'src', 'modules', 'maintenance', 'maintenance.routes.js'), 'utf8');

test('checkin-close imports the SAFE executor (a failed RO-open cannot block the close)', () => {
  assert.match(CLOSE_SRC, /import \{ executeCheckinMaintenanceDecisionSafe \} from '\.\.\/maintenance\/maintenance-checkin\.service\.js'/);
  assert.match(CLOSE_SRC, /maintenance = await executeCheckinMaintenanceDecisionSafe\(/);
});

test('arm/fire ordering: the executor fires AFTER both balance branches\' status syncs', () => {
  const callAt = CLOSE_SRC.indexOf('executeCheckinMaintenanceDecisionSafe({');
  assert.ok(callAt !== -1, 'executor call site exists');
  const lastSyncAt = CLOSE_SRC.lastIndexOf('syncVehicleStatusForReservation(prisma');
  assert.ok(lastSyncAt !== -1, 'status sync call sites exist');
  assert.ok(callAt > lastSyncAt,
    'the maintenance decision must fire after the close\'s own sync (sync sets AVAILABLE; the RO-open flips AVAILABLE → IN_MAINTENANCE)');
  // And the outcome is returned to the wizard as `maintenance`.
  const returnMatch = /maintenance\r?\n\s*\};/.exec(CLOSE_SRC);
  assert.ok(returnMatch && returnMatch.index > callAt, 'outcome returned to the wizard as `maintenance`');
});

test('maintenance router mounts the snooze consume + retry endpoints', () => {
  assert.match(ROUTES_SRC, /post\('\/vehicles\/:vehicleId\/snooze\/consume'/);
  assert.match(ROUTES_SRC, /post\('\/checkin-decisions\/:id\/retry'/);
  assert.match(ROUTES_SRC, /maintenanceCheckinService/);
});
