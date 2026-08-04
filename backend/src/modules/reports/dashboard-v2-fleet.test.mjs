/**
 * Dashboard v2 fleet table.
 *
 * What matters: the next-action priority chain (a hold outranks an open
 * return outranks a pickup outranks "assign"), worst-score-first ordering
 * with unscored units sinking, the soonest-wins pick when a vehicle has
 * several reservations, and totalCount being the real fleet size rather than
 * the page size.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { computeDashboardV2Fleet } from './dashboard-v2-fleet.js';

const NOW = new Date('2026-08-04T15:00:00.000Z');
const HOUR = 3600000;

function fakeDb({ vehicles = [], checkedOut = [], upcoming = [] } = {}) {
  return {
    vehicle: { findMany: async () => vehicles },
    reservation: {
      findMany: async ({ where }) =>
        (where.status === 'CHECKED_OUT' ? checkedOut : upcoming),
    },
  };
}

const fakeSignals = (byId) => async (ids) =>
  new Map(ids.map((id) => [id, byId[id]]).filter(([, v]) => v));

const veh = (id, over = {}) => ({
  id, plate: `PL-${id}`, internalNumber: `U-${id}`, make: 'Toyota', model: 'Corolla', year: 2024,
  status: 'AVAILABLE', homeLocation: { id: 'loc1', name: 'SJU' }, availabilityBlocks: [], ...over,
});
const tr = (score, status) => ({ turnReady: { score, status, summary: 's' } });

describe('dashboard-v2 fleet table', () => {
  it('derives the next action by priority: block > return > pickup > assign', async () => {
    const block = { blockType: 'WASH_HOLD', blockedFrom: new Date(NOW - HOUR), availableFrom: new Date(NOW.getTime() + HOUR), releasedAt: null };
    const out = await computeDashboardV2Fleet('t1', {
      now: NOW,
      deps: {
        prisma: fakeDb({
          vehicles: [
            veh('held', { availabilityBlocks: [block] }),
            veh('rented', { status: 'ON_RENT' }),
            veh('booked'),
            veh('idle'),
            veh('sad'),
          ],
          checkedOut: [
            // 'held' also has an open return — the hold must still win.
            { vehicleId: 'held', returnAt: new Date(NOW.getTime() + 2 * HOUR) },
            { vehicleId: 'rented', returnAt: new Date(NOW.getTime() + 3 * HOUR) },
          ],
          upcoming: [{ vehicleId: 'booked', pickupAt: new Date(NOW.getTime() + 5 * HOUR) }],
        }),
        buildVehicleOperationalSignalsMap: fakeSignals({
          held: tr(60, 'WATCH'), rented: tr(90, 'READY'), booked: tr(92, 'READY'),
          idle: tr(95, 'READY'), sad: tr(40, 'ATTENTION'),
        }),
      },
    });
    const by = Object.fromEntries(out.rows.map((r) => [r.id, r.nextAction]));
    assert.equal(by.held.kind, 'block');
    assert.equal(by.held.blockType, 'WASH_HOLD');
    assert.equal(by.rented.kind, 'return');
    assert.equal(by.booked.kind, 'pickup');
    assert.equal(by.idle.kind, 'assign');
    assert.equal(by.sad.kind, 'review', 'ATTENTION + idle must ask for review, not offer an assign');
  });

  it('sorts worst score first and sinks unscored units', async () => {
    const out = await computeDashboardV2Fleet('t1', {
      now: NOW,
      deps: {
        prisma: fakeDb({ vehicles: [veh('a'), veh('b'), veh('c'), veh('x')] }),
        buildVehicleOperationalSignalsMap: fakeSignals({ a: tr(96, 'READY'), b: tr(42, 'ATTENTION'), c: tr(71, 'WATCH') }),
      },
    });
    assert.deepEqual(out.rows.map((r) => r.id), ['b', 'c', 'a', 'x']);
  });

  it('keeps the soonest return when a vehicle has several open reservations', async () => {
    const out = await computeDashboardV2Fleet('t1', {
      now: NOW,
      deps: {
        prisma: fakeDb({
          vehicles: [veh('v', { status: 'ON_RENT' })],
          checkedOut: [
            // orderBy asc is the contract with the real query; the map keeps first.
            { vehicleId: 'v', returnAt: new Date(NOW.getTime() + 1 * HOUR) },
            { vehicleId: 'v', returnAt: new Date(NOW.getTime() + 9 * HOUR) },
          ],
        }),
        buildVehicleOperationalSignalsMap: fakeSignals({ v: tr(90, 'READY') }),
      },
    });
    assert.equal(new Date(out.rows[0].nextAction.at).getTime(), NOW.getTime() + 1 * HOUR);
  });

  it('caps rows at limit but reports the real fleet size', async () => {
    const vehicles = Array.from({ length: 12 }, (_, i) => veh(`v${i}`));
    const out = await computeDashboardV2Fleet('t1', {
      limit: 5,
      now: NOW,
      deps: { prisma: fakeDb({ vehicles }), buildVehicleOperationalSignalsMap: fakeSignals({}) },
    });
    assert.equal(out.rows.length, 5);
    assert.equal(out.totalCount, 12);
  });

  it('clamps a hostile limit into 1..50', async () => {
    const vehicles = Array.from({ length: 60 }, (_, i) => veh(`v${i}`));
    const big = await computeDashboardV2Fleet('t1', { limit: 9999, now: NOW, deps: { prisma: fakeDb({ vehicles }), buildVehicleOperationalSignalsMap: fakeSignals({}) } });
    assert.equal(big.rows.length, 50);
    const small = await computeDashboardV2Fleet('t1', { limit: -3, now: NOW, deps: { prisma: fakeDb({ vehicles }), buildVehicleOperationalSignalsMap: fakeSignals({}) } });
    assert.equal(small.rows.length, 1);
  });
});
