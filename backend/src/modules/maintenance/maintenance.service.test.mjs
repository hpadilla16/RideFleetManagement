// Maintenance service tests — miles-driven due status + "Log service" baseline roll.
// evalSchedule is pure; logService runs against an injected fake db (no postgres).
// Run: npm run test:maintenance  (needs --test-force-exit: importing the service
// pulls in the prisma singleton, whose open handle otherwise keeps node alive).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evalSchedule, maintenanceService } from './maintenance.service.js';

const NOW = new Date('2026-07-13T12:00:00Z').getTime();
const daysAgo = (d) => new Date(NOW - d * 86400000);

// ── evalSchedule: status is MILES-driven when intervalMiles is set ──

test('miles overdue even though days have NOT crossed', () => {
  const ev = evalSchedule(
    { intervalMiles: 5000, intervalDays: 180, lastServiceMiles: 10000, lastServiceAt: daysAgo(10) },
    15200, NOW,
  );
  assert.equal(ev.basis, 'MILES');
  assert.equal(ev.overdue, true);
  assert.equal(ev.nextDueMiles, 15000);
  assert.equal(ev.dueByMiles, 200);
  // Day info still computed + returned for display.
  assert.ok(ev.nextDueAt instanceof Date);
  assert.equal(ev.dueByDays, -170);
});

test('days crossed but miles fine → NOT overdue (miles are the basis)', () => {
  const ev = evalSchedule(
    { intervalMiles: 5000, intervalDays: 90, lastServiceMiles: 10000, lastServiceAt: daysAgo(120) },
    11000, NOW,
  );
  assert.equal(ev.basis, 'MILES');
  assert.equal(ev.overdue, false);
  assert.equal(ev.soon, false);
  // The lapsed calendar due is still visible as info.
  assert.equal(ev.dueByDays, 30);
});

test('due soon within 500 mi of the interval', () => {
  const ev = evalSchedule(
    { intervalMiles: 5000, intervalDays: null, lastServiceMiles: 10000, lastServiceAt: null },
    14700, NOW,
  );
  assert.equal(ev.basis, 'MILES');
  assert.equal(ev.overdue, false);
  assert.equal(ev.soon, true);
  assert.equal(ev.dueByMiles, -300);
});

test('days-only schedule falls back to day-driven status', () => {
  const overdue = evalSchedule(
    { intervalMiles: null, intervalDays: 90, lastServiceMiles: null, lastServiceAt: daysAgo(100) },
    50000, NOW,
  );
  assert.equal(overdue.basis, 'DAYS');
  assert.equal(overdue.overdue, true);
  const soon = evalSchedule(
    { intervalMiles: null, intervalDays: 90, lastServiceMiles: null, lastServiceAt: daysAgo(80) },
    50000, NOW,
  );
  assert.equal(soon.basis, 'DAYS');
  assert.equal(soon.overdue, false);
  assert.equal(soon.soon, true);
});

test('null vehicle mileage: miles basis unavailable → days decide', () => {
  const ev = evalSchedule(
    { intervalMiles: 5000, intervalDays: 90, lastServiceMiles: 10000, lastServiceAt: daysAgo(100) },
    null, NOW,
  );
  assert.equal(ev.basis, 'DAYS');
  assert.equal(ev.overdue, true);
  assert.equal(ev.nextDueMiles, 15000); // still shown
});

test('blank baseline = INACTIVE: no due no matter the odometer or calendar', () => {
  const ev = evalSchedule(
    { intervalMiles: 5000, intervalDays: 90, lastServiceMiles: null, lastServiceAt: null },
    999999, NOW,
  );
  assert.equal(ev.basis, null);
  assert.equal(ev.overdue, false);
  assert.equal(ev.soon, false);
  assert.equal(ev.nextDueMiles, null);
  assert.equal(ev.nextDueAt, null);
});

test('miles baseline blank but day baseline set → day-driven (partial baseline)', () => {
  const ev = evalSchedule(
    { intervalMiles: 5000, intervalDays: 90, lastServiceMiles: null, lastServiceAt: daysAgo(10) },
    20000, NOW,
  );
  assert.equal(ev.basis, 'DAYS');
  assert.equal(ev.overdue, false);
  assert.equal(ev.soon, false);
});

// ── logService: baseline rolls to the vehicle's CURRENT odometer + now ──

function fakeDb({ vehicle, schedule }) {
  const calls = { updates: [] };
  return {
    calls,
    vehicle: { findFirst: async () => vehicle },
    serviceSchedule: {
      findFirst: async () => schedule,
      update: async ({ where, data }) => {
        calls.updates.push({ where, data });
        return { ...schedule, ...data };
      },
    },
  };
}

const SCOPE = { tenantId: 't1' };

test('logService rolls baseline to Vehicle.mileage + now and next-due recomputes', async () => {
  const db = fakeDb({
    vehicle: { id: 'v1', mileage: 42350 },
    schedule: { id: 's1', vehicleId: 'v1', serviceType: 'LOF', intervalMiles: 5000, intervalDays: 180, lastServiceMiles: 30000, lastServiceAt: daysAgo(400), active: true },
  });
  const out = await maintenanceService.logService('v1', 'LOF', SCOPE, { db, now: NOW, actorUserId: 'u1' });
  assert.equal(db.calls.updates.length, 1);
  assert.equal(db.calls.updates[0].data.lastServiceMiles, 42350);
  assert.equal(new Date(db.calls.updates[0].data.lastServiceAt).getTime(), NOW);
  // Next due recomputed from the fresh baseline, status back to OK.
  assert.equal(out.nextDueMiles, 47350);
  assert.equal(out.basis, 'MILES');
  assert.equal(out.overdue, false);
  assert.equal(out.soon, false);
});

test('logService: schedule must already exist (404)', async () => {
  const db = fakeDb({ vehicle: { id: 'v1', mileage: 100 }, schedule: null });
  await assert.rejects(() => maintenanceService.logService('v1', 'LOF', SCOPE, { db, now: NOW }), (e) => e.status === 404);
});

test('logService: vehicle without an odometer reading → 400, never fabricates a 0 baseline', async () => {
  const db = fakeDb({
    vehicle: { id: 'v1', mileage: null },
    schedule: { id: 's1', vehicleId: 'v1', serviceType: 'LOF', intervalMiles: 5000, intervalDays: null, lastServiceMiles: null, lastServiceAt: null, active: true },
  });
  await assert.rejects(() => maintenanceService.logService('v1', 'LOF', SCOPE, { db, now: NOW }), (e) => e.status === 400 && /odometer/i.test(e.message));
  assert.equal(db.calls.updates.length, 0);
});

test('logService: unknown vehicle 404, bad serviceType 400, __no_tenant__ 400', async () => {
  const db = fakeDb({ vehicle: null, schedule: null });
  await assert.rejects(() => maintenanceService.logService('vX', 'LOF', SCOPE, { db, now: NOW }), (e) => e.status === 404);
  await assert.rejects(() => maintenanceService.logService('v1', 'WAX', SCOPE, { db, now: NOW }), (e) => e.status === 400);
  await assert.rejects(() => maintenanceService.logService('v1', 'LOF', { tenantId: '__no_tenant__' }, { db, now: NOW }), (e) => e.status === 400);
});

test('logService: super-admin scope (no tenantId) derives the tenant from the vehicle row', async () => {
  const db = fakeDb({
    vehicle: { id: 'v1', mileage: 42350, tenantId: 't-of-vehicle' },
    schedule: { id: 's1', vehicleId: 'v1', serviceType: 'LOF', intervalMiles: 5000, intervalDays: null, lastServiceMiles: 30000, lastServiceAt: null, active: true },
  });
  const out = await maintenanceService.logService('v1', 'LOF', {}, { db, now: NOW });
  assert.equal(db.calls.updates.length, 1);
  assert.equal(out.lastServiceMiles, 42350);
});
