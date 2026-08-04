/**
 * Dashboard v2 hero KPIs.
 *
 * What matters: the utilization math (clipped overlap, tenant-tz windows,
 * WoW delta), the Turn-Ready rollup agreeing with the signals map it is fed,
 * and the null postures (empty fleet, no reservations) — a dashboard that
 * renders 0% when it means "no data" invents a crisis.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { computeDashboardV2Kpis } from './dashboard-v2-kpis.js';

const NOW = new Date('2026-08-03T18:00:00.000Z');
const DAY = 86400000;

function fakeDb({ vehicles = [], reservations = [], tollSum = 0, tollCount = 0, inReview = 0 } = {}) {
  return {
    vehicle: { findMany: async () => vehicles },
    reservation: { findMany: async () => reservations },
    tollTransaction: {
      aggregate: async () => ({ _sum: { amount: tollSum }, _count: { _all: tollCount } }),
      count: async () => inReview,
    },
  };
}

function fakeSignals(byId) {
  return async (ids) => new Map(ids.map((id) => [id, byId[id]]).filter(([, v]) => v));
}

const veh = (id) => ({ id, availabilityBlocks: [] });
const tr = (score, status) => ({ turnReady: { score, status } });

describe('dashboard-v2 KPIs', () => {
  it('rolls up turn-ready counts and average from the shared signals map', async () => {
    const out = await computeDashboardV2Kpis('t1', {
      now: NOW,
      deps: {
        prisma: fakeDb({ vehicles: [veh('a'), veh('b'), veh('c'), veh('d')] }),
        buildVehicleOperationalSignalsMap: fakeSignals({
          a: tr(96, 'READY'), b: tr(70, 'WATCH'), c: tr(40, 'ATTENTION'), d: tr(10, 'BLOCKED'),
        }),
      },
    });
    assert.deepEqual(
      { ready: 1, watch: 1, attention: 1, blocked: 1, scored: 4 },
      { ready: out.turnReady.ready, watch: out.turnReady.watch, attention: out.turnReady.attention, blocked: out.turnReady.blocked, scored: out.turnReady.scored },
    );
    assert.equal(out.turnReady.avgScore, Math.round((96 + 70 + 40 + 10) / 4));
  });

  it('computes utilization as clipped vehicle-days over capacity', async () => {
    // 2 vehicles. One reservation covering the ENTIRE last 14 days:
    // each 7-day window has 7 reserved days over 14 capacity days = 50%.
    const out = await computeDashboardV2Kpis('t1', {
      now: NOW,
      deps: {
        prisma: fakeDb({
          vehicles: [veh('a'), veh('b')],
          reservations: [{ pickupAt: new Date(NOW - 20 * DAY), returnAt: new Date(NOW.getTime() + 5 * DAY) }],
        }),
        buildVehicleOperationalSignalsMap: fakeSignals({}),
      },
    });
    assert.ok(Math.abs(out.utilization.pct - 50) < 1.5, `pct=${out.utilization.pct}`);
    assert.ok(Math.abs(out.utilization.prevPct - 50) < 1.5, `prev=${out.utilization.prevPct}`);
    assert.ok(Math.abs(out.utilization.deltaPts) < 0.2);
  });

  it('clips a reservation that only touches part of the window', async () => {
    // 1 vehicle; reservation covers ~3.5 of the last 7 days and none of the
    // week before -> this week ~50%, last week 0, delta ~+50.
    const out = await computeDashboardV2Kpis('t1', {
      now: NOW,
      deps: {
        prisma: fakeDb({
          vehicles: [veh('a')],
          reservations: [{ pickupAt: new Date(NOW - 4 * DAY), returnAt: new Date(NOW - 0.5 * DAY) }],
        }),
        buildVehicleOperationalSignalsMap: fakeSignals({}),
      },
    });
    assert.ok(out.utilization.pct > 40 && out.utilization.pct < 60, `pct=${out.utilization.pct}`);
    assert.equal(out.utilization.prevPct, 0);
    assert.ok(out.utilization.deltaPts > 40);
  });

  it('the daily series buckets with the same math as the headline number', async () => {
    // 2 vehicles, one reservation covering the whole window: every one of the
    // 7 day buckets must read ~50%, and the series must sum-consistently with
    // the headline (same clipped-overlap formula, same tz boundaries).
    const out = await computeDashboardV2Kpis('t1', {
      now: NOW,
      deps: {
        prisma: fakeDb({
          vehicles: [veh('a'), veh('b')],
          reservations: [{ pickupAt: new Date(NOW - 20 * DAY), returnAt: new Date(NOW.getTime() + 5 * DAY) }],
        }),
        buildVehicleOperationalSignalsMap: fakeSignals({}),
      },
    });
    assert.equal(out.utilization.days.length, 7);
    for (const d of out.utilization.days) {
      assert.ok(Math.abs(d.pct - 50) < 1.5, `day ${d.date} pct=${d.pct}`);
    }
    const avg = out.utilization.days.reduce((s2, d) => s2 + d.pct, 0) / 7;
    assert.ok(Math.abs(avg - out.utilization.pct) < 1.5, `series avg ${avg} vs headline ${out.utilization.pct}`);
  });

  it('a day with no coverage reads 0 in the series, null only when there is no fleet', async () => {
    const out = await computeDashboardV2Kpis('t1', {
      now: NOW,
      deps: {
        prisma: fakeDb({ vehicles: [veh('a')], reservations: [] }),
        buildVehicleOperationalSignalsMap: fakeSignals({}),
      },
    });
    assert.ok(out.utilization.days.every((d) => d.pct === 0));
    const empty = await computeDashboardV2Kpis('t1', {
      now: NOW,
      deps: { prisma: fakeDb({ vehicles: [] }), buildVehicleOperationalSignalsMap: fakeSignals({}) },
    });
    assert.ok(empty.utilization.days.every((d) => d.pct === null));
  });

  it('reports null utilization for an empty fleet — not a fake 0%', async () => {
    const out = await computeDashboardV2Kpis('t1', {
      now: NOW,
      deps: { prisma: fakeDb({ vehicles: [] }), buildVehicleOperationalSignalsMap: fakeSignals({}) },
    });
    assert.equal(out.utilization.pct, null);
    assert.equal(out.utilization.deltaPts, null);
    assert.equal(out.turnReady.avgScore, null);
    assert.equal(out.fleetCount, 0);
  });

  it('passes tolls through: reconciled sum + crossings + in-review', async () => {
    const out = await computeDashboardV2Kpis('t1', {
      now: NOW,
      deps: {
        prisma: fakeDb({ vehicles: [veh('a')], tollSum: 1284.5, tollCount: 342, inReview: 7 }),
        buildVehicleOperationalSignalsMap: fakeSignals({}),
      },
    });
    assert.equal(out.tolls30d.reconciledAmount, 1284.5);
    assert.equal(out.tolls30d.crossings, 342);
    assert.equal(out.tolls30d.inReview, 7);
  });

  it('caps utilization at 100 even with overlapping double-booked data', async () => {
    const out = await computeDashboardV2Kpis('t1', {
      now: NOW,
      deps: {
        prisma: fakeDb({
          vehicles: [veh('a')],
          reservations: [
            { pickupAt: new Date(NOW - 30 * DAY), returnAt: new Date(NOW.getTime() + 5 * DAY) },
            { pickupAt: new Date(NOW - 30 * DAY), returnAt: new Date(NOW.getTime() + 5 * DAY) },
          ],
        }),
        buildVehicleOperationalSignalsMap: fakeSignals({}),
      },
    });
    assert.ok(out.utilization.pct <= 100);
  });
});
