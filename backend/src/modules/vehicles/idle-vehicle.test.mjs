/**
 * Idle-vehicle notification (2026-09-01, backlog #5). Run via:
 *   npm run test:idle-vehicle
 *
 * Covers, in order:
 *  A. Config normalization — OFF by default, thresholdDays 7, severity
 *     NEEDS_ACTION; junk falls back.
 *  B. computeIdleState — the idle definition's edge cases: cold start, open
 *     rental, upcoming booking, maintenance/car-sharing/shuttle exclusions,
 *     threshold boundary, episode key stability, early-return cap.
 *  C. The tenant sweep — config off = silence, episode dedupe across runs,
 *     sweep-resolves on activity, severity from config, envelope content.
 *  D. Wiring — FLEET registered as a source, scheduler math + kill-switch,
 *     worker.js registration, package.json chain membership.
 *
 * DB-FREE (same technique as notifications.test.mjs): every query goes
 * through injected deps; the real Prisma client never connects.
 */

// MUST be first — sets DATABASE_URL etc. before lib/prisma.js constructs.
import '../../lib/_two-factor-test-env.mjs';

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

import {
  normalizeIdleVehicleConfig,
  computeIdleState,
  sweepIdleVehiclesForTenant,
  IDLE_DEFAULT_THRESHOLD_DAYS,
} from './idle-vehicle.service.js';
import {
  enabled as idleSweepEnabled,
  msUntilNextRun,
  sweepIdleOnce,
} from './idle-vehicle.scheduler.js';
import { NOTIFICATION_SOURCE_TYPES } from '../notifications/notifications-emit.js';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));

const NOW = new Date('2026-09-01T12:00:00.000Z');
const daysAgo = (n) => new Date(NOW.getTime() - n * 24 * 60 * 60 * 1000);

function vehicle(overrides = {}) {
  return {
    id: 'veh_1',
    plate: 'ABC-123',
    internalNumber: 'U-101',
    createdAt: daysAgo(400),
    status: 'AVAILABLE',
    fleetMode: 'RENTAL_ONLY',
    programCategory: 'RENTAL_ONLY',
    homeLocationId: 'loc_1',
    homeLocation: { name: 'SJU Airport' },
    reservations: [],
    ...overrides,
  };
}

// ───────────────────────── A. config normalization ─────────────────────────

test('config: OFF by default with thresholdDays 7 and NEEDS_ACTION severity', () => {
  const cfg = normalizeIdleVehicleConfig(null);
  assert.deepEqual(cfg, { enabled: false, thresholdDays: 7, severity: 'NEEDS_ACTION' });
  assert.equal(IDLE_DEFAULT_THRESHOLD_DAYS, 7);
});

test('config: junk falls back; valid values pass through; floats floor', () => {
  const junk = normalizeIdleVehicleConfig({ enabled: 'yes', thresholdDays: 'NaN', severity: 'LOUD' });
  assert.deepEqual(junk, { enabled: false, thresholdDays: 7, severity: 'NEEDS_ACTION' });
  const ok = normalizeIdleVehicleConfig({ enabled: true, thresholdDays: 14.9, severity: 'info' });
  assert.deepEqual(ok, { enabled: true, thresholdDays: 14, severity: 'INFO' });
  // thresholdDays below 1 is meaningless — falls back, never 0/negative.
  assert.equal(normalizeIdleVehicleConfig({ thresholdDays: 0 }).thresholdDays, 7);
  assert.equal(normalizeIdleVehicleConfig({ thresholdDays: -3 }).thresholdDays, 7);
});

// ───────────────────────── B. computeIdleState ──────────────────────────────

test('cold start: fresh vehicle with no reservations is not idle yet', () => {
  const s = computeIdleState(vehicle({ createdAt: daysAgo(2), reservations: [] }), { now: NOW, thresholdDays: 7 });
  assert.equal(s.eligible, true);
  assert.equal(s.idle, false);
  assert.equal(s.daysIdle, 2);
});

test('cold start: vehicle created 10 days ago, never reserved, is idle with createdAt episode', () => {
  const created = daysAgo(10);
  const s = computeIdleState(vehicle({ createdAt: created, reservations: [] }), { now: NOW, thresholdDays: 7 });
  assert.equal(s.idle, true);
  assert.equal(s.daysIdle, 10);
  assert.equal(s.episodeStart, created.toISOString().slice(0, 10));
  assert.equal(s.dedupeKey, `idle-vehicle:veh_1:${created.toISOString().slice(0, 10)}`);
});

test('open rental: a CHECKED_OUT reservation means never idle', () => {
  const s = computeIdleState(vehicle({
    reservations: [{ status: 'CHECKED_OUT', createdAt: daysAgo(30), returnAt: daysAgo(-2) }],
  }), { now: NOW, thresholdDays: 7 });
  assert.equal(s.eligible, true);
  assert.equal(s.idle, false);
});

test('upcoming booking: NEW/CONFIRMED with future returnAt means spoken for, not idle', () => {
  for (const status of ['NEW', 'CONFIRMED']) {
    const s = computeIdleState(vehicle({
      reservations: [{ status, createdAt: daysAgo(40), returnAt: daysAgo(-5) }],
    }), { now: NOW, thresholdDays: 7 });
    assert.equal(s.idle, false, status);
  }
});

test('a long-past NEW/CONFIRMED assignment does not occupy, but counts as activity', () => {
  // Stale unfulfilled booking whose window fully passed: not occupying, but
  // the assignment (createdAt) is the vehicle's last activity.
  const s = computeIdleState(vehicle({
    createdAt: daysAgo(400),
    reservations: [{ status: 'CONFIRMED', createdAt: daysAgo(9), returnAt: daysAgo(3) }],
  }), { now: NOW, thresholdDays: 7 });
  assert.equal(s.idle, true);
  assert.equal(s.daysIdle, 9);
});

test('never idle: IN_MAINTENANCE / OUT_OF_SERVICE / ON_RENT / SOLD statuses', () => {
  for (const status of ['IN_MAINTENANCE', 'OUT_OF_SERVICE', 'ON_RENT', 'RESERVED', 'SOLD']) {
    const s = computeIdleState(vehicle({ status, createdAt: daysAgo(100) }), { now: NOW, thresholdDays: 7 });
    assert.equal(s.eligible, false, status);
    assert.equal(s.idle, false, status);
  }
});

test('excluded fleets: CAR_SHARING_ONLY and SHUTTLE_ONLY are out of scope; LOANER_ONLY is in', () => {
  assert.equal(computeIdleState(vehicle({ fleetMode: 'CAR_SHARING_ONLY', createdAt: daysAgo(100) }), { now: NOW }).eligible, false);
  assert.equal(computeIdleState(vehicle({ programCategory: 'SHUTTLE_ONLY', createdAt: daysAgo(100) }), { now: NOW }).eligible, false);
  const loaner = computeIdleState(vehicle({ programCategory: 'LOANER_ONLY', createdAt: daysAgo(100) }), { now: NOW, thresholdDays: 7 });
  assert.equal(loaner.eligible, true);
  assert.equal(loaner.idle, true);
});

test('check-in close is activity: recent return blocks idle, old return does not', () => {
  const recent = computeIdleState(vehicle({
    reservations: [{ status: 'CHECKED_IN', createdAt: daysAgo(20), returnAt: daysAgo(3) }],
  }), { now: NOW, thresholdDays: 7 });
  assert.equal(recent.idle, false);
  assert.equal(recent.daysIdle, 3);

  const old = computeIdleState(vehicle({
    reservations: [{ status: 'CHECKED_IN_UNPAID', createdAt: daysAgo(30), returnAt: daysAgo(12) }],
  }), { now: NOW, thresholdDays: 7 });
  assert.equal(old.idle, true);
  assert.equal(old.daysIdle, 12);
  assert.equal(old.episodeStart, daysAgo(12).toISOString().slice(0, 10));
});

test('early return: a CHECKED_IN reservation with future returnAt caps activity at now', () => {
  // Returned early — booked through next week but already checked in. The
  // future returnAt must not push lastActivity past `now` (negative idle).
  const s = computeIdleState(vehicle({
    reservations: [{ status: 'CHECKED_IN', createdAt: daysAgo(10), returnAt: daysAgo(-7) }],
  }), { now: NOW, thresholdDays: 7 });
  assert.equal(s.idle, false);
  assert.equal(s.daysIdle, 0);
});

test('threshold boundary: exactly thresholdDays counts as idle; one day short does not', () => {
  const at = computeIdleState(vehicle({ createdAt: daysAgo(7) }), { now: NOW, thresholdDays: 7 });
  assert.equal(at.idle, true);
  assert.equal(at.daysIdle, 7);
  const under = computeIdleState(vehicle({ createdAt: daysAgo(6.9) }), { now: NOW, thresholdDays: 7 });
  assert.equal(under.idle, false);
  assert.equal(under.daysIdle, 6);
});

test('episode key is stable across sweep days while the episode lasts', () => {
  const v = vehicle({
    reservations: [{ status: 'CHECKED_IN', createdAt: daysAgo(30), returnAt: daysAgo(10) }],
  });
  const day1 = computeIdleState(v, { now: NOW, thresholdDays: 7 });
  const day2 = computeIdleState(v, { now: new Date(NOW.getTime() + 24 * 60 * 60 * 1000), thresholdDays: 7 });
  assert.equal(day1.idle, true);
  assert.equal(day2.idle, true);
  assert.equal(day1.dedupeKey, day2.dedupeKey);
  assert.equal(day2.daysIdle, day1.daysIdle + 1);
});

test('cancelled/no-show rows are excluded upstream; the pure function tolerates junk input', () => {
  assert.deepEqual(
    computeIdleState(null, { now: NOW }),
    { eligible: false, idle: false, lastActivityAt: null, daysIdle: 0, episodeStart: null, dedupeKey: null },
  );
});

// ───────────────────────── C. the tenant sweep ──────────────────────────────

function fakeDb({ vehicles = [], openNotifications = [] } = {}) {
  const calls = { vehicleFindMany: [], notifFindMany: [], updateMany: [] };
  return {
    calls,
    vehicle: {
      findMany: async (args) => { calls.vehicleFindMany.push(args); return vehicles; },
    },
    notificationEvent: {
      findMany: async (args) => { calls.notifFindMany.push(args); return openNotifications; },
      updateMany: async (args) => { calls.updateMany.push(args); return { count: 1 }; },
    },
    tenant: {
      findMany: async () => [{ id: 't1' }],
    },
  };
}

const CFG_ON = { enabled: true, thresholdDays: 7, severity: 'NEEDS_ACTION' };

test('sweep: config off means silence — no reads beyond config, no emits, no resolves', async () => {
  const db = fakeDb({ vehicles: [vehicle({ createdAt: daysAgo(100) })] });
  const emitted = [];
  const out = await sweepIdleVehiclesForTenant('t1', {
    db, emit: async (e) => emitted.push(e), getConfig: async () => ({ enabled: false }), now: NOW,
  });
  assert.equal(out.skipped, true);
  assert.equal(emitted.length, 0);
  assert.equal(db.calls.vehicleFindMany.length, 0);
  assert.equal(db.calls.updateMany.length, 0);
});

test('sweep: emits one FLEET envelope per idle vehicle with the episode dedupeKey', async () => {
  const created = daysAgo(20);
  const db = fakeDb({ vehicles: [vehicle({ createdAt: created })] });
  const emitted = [];
  const out = await sweepIdleVehiclesForTenant('t1', {
    db, emit: async (e) => emitted.push(e), getConfig: async () => CFG_ON, now: NOW,
  });
  assert.equal(out.skipped, false);
  assert.equal(out.emitted, 1);
  const e = emitted[0];
  assert.equal(e.tenantId, 't1');
  assert.equal(e.sourceType, 'FLEET');
  assert.equal(e.sourceRefId, 'veh_1');
  assert.equal(e.severity, 'NEEDS_ACTION');
  assert.equal(e.locationId, 'loc_1');
  assert.equal(e.deepLink, '/vehicles/veh_1');
  assert.equal(e.dedupeKey, `idle-vehicle:veh_1:${created.toISOString().slice(0, 10)}`);
  assert.equal(e.templateKey, 'idleVehicle');
  assert.deepEqual(e.paramsJson, { unit: 'U-101', days: 20, location: 'SJU Airport' });
  assert.match(e.title, /Idle vehicle — U-101, 20 days/);
  assert.match(e.body, /SJU Airport/);
});

test('sweep: episode dedupe — day-2 run re-emits the SAME key (upsert no-op, no re-badge)', async () => {
  const created = daysAgo(20);
  const run = async (now) => {
    const db = fakeDb({ vehicles: [vehicle({ createdAt: created })] });
    const emitted = [];
    await sweepIdleVehiclesForTenant('t1', { db, emit: async (e) => emitted.push(e), getConfig: async () => CFG_ON, now });
    return emitted[0].dedupeKey;
  };
  const k1 = await run(NOW);
  const k2 = await run(new Date(NOW.getTime() + 24 * 60 * 60 * 1000));
  assert.equal(k1, k2);
});

test('sweep: resolve-on-activity — open envelope for a no-longer-idle vehicle gets resolvedAt', async () => {
  // veh_1 got a booking (upcoming CONFIRMED) → not idle; its open envelope resolves.
  const db = fakeDb({
    vehicles: [vehicle({
      reservations: [{ status: 'CONFIRMED', createdAt: daysAgo(1), returnAt: daysAgo(-4) }],
    })],
    openNotifications: [{ id: 'n1', sourceRefId: 'veh_1', dedupeKey: 'idle-vehicle:veh_1:2026-08-10' }],
  });
  const emitted = [];
  const out = await sweepIdleVehiclesForTenant('t1', {
    db, emit: async (e) => emitted.push(e), getConfig: async () => CFG_ON, now: NOW,
  });
  assert.equal(out.resolved, 1);
  assert.equal(emitted.length, 0);
  assert.deepEqual(db.calls.updateMany[0].where, { id: 'n1', resolvedAt: null });
  assert.equal(db.calls.updateMany[0].data.resolvedAt.getTime(), NOW.getTime());
});

test('sweep: an open envelope for the CURRENT episode is left alone', async () => {
  const created = daysAgo(20);
  const key = `idle-vehicle:veh_1:${created.toISOString().slice(0, 10)}`;
  const db = fakeDb({
    vehicles: [vehicle({ createdAt: created })],
    openNotifications: [{ id: 'n1', sourceRefId: 'veh_1', dedupeKey: key }],
  });
  const out = await sweepIdleVehiclesForTenant('t1', {
    db, emit: async () => {}, getConfig: async () => CFG_ON, now: NOW,
  });
  assert.equal(out.resolved, 0);
  assert.equal(db.calls.updateMany.length, 0);
});

test('sweep: a stale-episode envelope resolves even while a NEW episode emits', async () => {
  const created = daysAgo(9); // new episode: idle 9 days
  const db = fakeDb({
    vehicles: [vehicle({ createdAt: created })],
    openNotifications: [{ id: 'n_old', sourceRefId: 'veh_1', dedupeKey: 'idle-vehicle:veh_1:2026-01-01' }],
  });
  const emitted = [];
  const out = await sweepIdleVehiclesForTenant('t1', {
    db, emit: async (e) => emitted.push(e), getConfig: async () => CFG_ON, now: NOW,
  });
  assert.equal(out.resolved, 1);
  assert.equal(out.emitted, 1);
  assert.notEqual(emitted[0].dedupeKey, 'idle-vehicle:veh_1:2026-01-01');
});

test('sweep: severity comes from config (INFO tenant emits INFO)', async () => {
  const db = fakeDb({ vehicles: [vehicle({ createdAt: daysAgo(30) })] });
  const emitted = [];
  await sweepIdleVehiclesForTenant('t1', {
    db, emit: async (e) => emitted.push(e),
    getConfig: async () => ({ enabled: true, thresholdDays: 7, severity: 'INFO' }), now: NOW,
  });
  assert.equal(emitted[0].severity, 'INFO');
});

test('sweep: custom threshold respected (idle 10d, threshold 14 → silence)', async () => {
  const db = fakeDb({ vehicles: [vehicle({ createdAt: daysAgo(10) })] });
  const emitted = [];
  const out = await sweepIdleVehiclesForTenant('t1', {
    db, emit: async (e) => emitted.push(e),
    getConfig: async () => ({ enabled: true, thresholdDays: 14, severity: 'NEEDS_ACTION' }), now: NOW,
  });
  assert.equal(out.emitted, 0);
  assert.equal(emitted.length, 0);
});

test('sweep: query excludes non-AVAILABLE, car-sharing-only and shuttle-only at the DB', async () => {
  const db = fakeDb({ vehicles: [] });
  await sweepIdleVehiclesForTenant('t1', { db, emit: async () => {}, getConfig: async () => CFG_ON, now: NOW });
  const where = db.calls.vehicleFindMany[0].where;
  assert.equal(where.status, 'AVAILABLE');
  assert.deepEqual(where.fleetMode, { in: ['RENTAL_ONLY', 'BOTH'] });
  assert.deepEqual(where.programCategory, { not: 'SHUTTLE_ONLY' });
  const resWhere = db.calls.vehicleFindMany[0].select.reservations.where;
  assert.deepEqual(resWhere.status, { notIn: ['CANCELLED', 'NO_SHOW'] });
});

test('sweepIdleOnce: iterates tenants and aggregates; per-tenant failure never aborts', async () => {
  const db = {
    tenant: { findMany: async () => [{ id: 't1' }, { id: 't2' }] },
    vehicle: {
      findMany: async ({ where }) => {
        if (where.tenantId === 't2') throw new Error('boom');
        return [vehicle({ createdAt: daysAgo(30) })];
      },
    },
    notificationEvent: { findMany: async () => [], updateMany: async () => ({ count: 1 }) },
  };
  const warned = [];
  const out = await sweepIdleOnce({
    db, emit: async () => {}, getConfig: async () => CFG_ON, now: NOW,
    logger: { warn: (...a) => warned.push(a), info: () => {}, error: () => {} },
  });
  assert.equal(out.tenants, 2);
  assert.equal(out.emitted, 1);
  assert.equal(warned.length, 1);
});

// ───────────────────────── D. wiring ────────────────────────────────────────

test('FLEET is a registered notification source', () => {
  assert.ok(NOTIFICATION_SOURCE_TYPES.includes('FLEET'));
});

test('scheduler: 09:20 UTC daily window and env kill-switch', () => {
  const ms = msUntilNextRun(new Date('2026-09-01T09:00:00.000Z'));
  assert.equal(ms, 20 * 60 * 1000); // 09:00 → 09:20 same day
  const past = msUntilNextRun(new Date('2026-09-01T09:21:00.000Z'));
  assert.equal(past, (24 * 60 - 1) * 60 * 1000); // 09:21 → tomorrow 09:20

  const prev = process.env.IDLE_VEHICLE_SWEEP_ENABLED;
  try {
    delete process.env.IDLE_VEHICLE_SWEEP_ENABLED;
    assert.equal(idleSweepEnabled(), true); // default ON
    process.env.IDLE_VEHICLE_SWEEP_ENABLED = 'false';
    assert.equal(idleSweepEnabled(), false);
  } finally {
    if (prev === undefined) delete process.env.IDLE_VEHICLE_SWEEP_ENABLED;
    else process.env.IDLE_VEHICLE_SWEEP_ENABLED = prev;
  }
});

test('worker.js registers the idle-vehicle sweep scheduler', () => {
  const src = readFileSync(join(ROOT, 'src', 'worker.js'), 'utf8');
  assert.ok(src.includes("./modules/vehicles/idle-vehicle.scheduler.js"));
  assert.ok(src.includes('startIdleVehicleSweepScheduler'));
});

test('package.json: test:idle-vehicle exists and is in the main test chain', () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  assert.ok(pkg.scripts['test:idle-vehicle']);
  assert.ok(pkg.scripts.test.includes('npm run test:idle-vehicle'));
});

test('settings routes expose GET/PUT /idle-vehicles (PUT admin-gated)', () => {
  const src = readFileSync(join(ROOT, 'src', 'modules', 'settings', 'settings.routes.js'), 'utf8');
  assert.ok(src.includes("settingsRouter.get('/idle-vehicles'"));
  assert.ok(/settingsRouter\.put\('\/idle-vehicles', requireRole\('ADMIN'\)/.test(src));
});
