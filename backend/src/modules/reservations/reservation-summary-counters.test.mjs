import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { prisma } from '../../lib/prisma.js';
import {
  readFreshCounters,
  refreshCounters
} from './reservation-summary-counters.service.js';

// Verifies the L-2 daily counter table service:
//   1. readFreshCounters returns the row when refreshedAt is within
//      maxAgeMs.
//   2. readFreshCounters returns null when the row is stale, so the
//      caller falls back to live aggregation.
//   3. refreshCounters runs 5 prisma.reservation.count() calls in
//      parallel and upserts the result.
//   4. Errors inside readFreshCounters / refreshCounters never throw —
//      they return null so a counter-table outage can't break the
//      dashboard endpoint.
//
// Pattern: monkey-patch prisma. No DB needed.

describe('reservation-summary-counters', () => {
  let origFindUnique;
  let origUpsert;
  let origCount;
  let countCalls;
  let upsertCalls;

  beforeEach(() => {
    origFindUnique = prisma.reservationDailyCounter?.findUnique;
    origUpsert = prisma.reservationDailyCounter?.upsert;
    origCount = prisma.reservation.count;
    countCalls = 0;
    upsertCalls = 0;

    // Real prisma client may not have the new model wired up in this
    // sandbox until prisma:generate runs — provide a stub.
    if (!prisma.reservationDailyCounter) {
      prisma.reservationDailyCounter = {};
    }

    prisma.reservation.count = async () => {
      countCalls += 1;
      return countCalls; // 1, 2, 3, 4, 5 across the 5 calls
    };
  });

  afterEach(() => {
    if (origFindUnique) prisma.reservationDailyCounter.findUnique = origFindUnique;
    else delete prisma.reservationDailyCounter.findUnique;
    if (origUpsert) prisma.reservationDailyCounter.upsert = origUpsert;
    else delete prisma.reservationDailyCounter.upsert;
    prisma.reservation.count = origCount;
  });

  describe('readFreshCounters', () => {
    it('returns the row when refreshedAt is within maxAgeMs', async () => {
      const row = {
        tenantId: 'tenant-1',
        day: new Date('2026-04-28T00:00:00Z'),
        pickupsToday: 7,
        returnsToday: 3,
        checkedOut: 12,
        feeAdvisories: 1,
        noShows: 0,
        refreshedAt: new Date(Date.now() - 10_000) // 10s old
      };
      prisma.reservationDailyCounter.findUnique = async () => row;

      const out = await readFreshCounters({
        tenantId: 'tenant-1',
        day: row.day,
        maxAgeMs: 60_000
      });

      assert.ok(out, 'expected a hit');
      assert.equal(out.pickupsToday, 7);
      assert.equal(out.checkedOut, 12);
      assert.ok(out.ageMs >= 10_000 && out.ageMs < 30_000);
    });

    it('returns null when refreshedAt is older than maxAgeMs', async () => {
      const row = {
        tenantId: 'tenant-1',
        day: new Date('2026-04-28T00:00:00Z'),
        pickupsToday: 7,
        returnsToday: 3,
        checkedOut: 12,
        feeAdvisories: 1,
        noShows: 0,
        refreshedAt: new Date(Date.now() - 10 * 60 * 1000) // 10 min old
      };
      prisma.reservationDailyCounter.findUnique = async () => row;

      const out = await readFreshCounters({
        tenantId: 'tenant-1',
        day: row.day,
        maxAgeMs: 5 * 60 * 1000
      });

      assert.equal(out, null, 'stale row should be treated as a miss');
    });

    it('returns null when no row exists', async () => {
      prisma.reservationDailyCounter.findUnique = async () => null;
      const out = await readFreshCounters({
        tenantId: 'tenant-1',
        day: new Date('2026-04-28T00:00:00Z')
      });
      assert.equal(out, null);
    });

    it('returns null and does not throw when prisma rejects', async () => {
      prisma.reservationDailyCounter.findUnique = async () => {
        throw new Error('connection lost');
      };
      const out = await readFreshCounters({
        tenantId: 'tenant-1',
        day: new Date('2026-04-28T00:00:00Z')
      });
      assert.equal(out, null);
    });
  });

  describe('refreshCounters', () => {
    it('runs 5 count() queries and upserts the result', async () => {
      let upsertArgs = null;
      prisma.reservationDailyCounter.upsert = async (args) => {
        upsertCalls += 1;
        upsertArgs = args;
        return { id: 'row-1', ...args.create };
      };

      const day = new Date('2026-04-28T00:00:00Z');
      const dayStart = new Date('2026-04-28T00:00:00Z');
      const dayEnd = new Date('2026-04-28T23:59:59.999Z');

      const out = await refreshCounters({
        tenantId: 'tenant-1',
        day,
        dayStart,
        dayEnd
      });

      assert.equal(countCalls, 5, 'should run 5 prisma count() calls');
      assert.equal(upsertCalls, 1, 'should upsert exactly once');
      assert.equal(upsertArgs.create.tenantId, 'tenant-1');
      assert.equal(upsertArgs.create.pickupsToday, 1);
      assert.equal(upsertArgs.create.returnsToday, 2);
      assert.equal(upsertArgs.create.checkedOut, 3);
      assert.equal(upsertArgs.create.feeAdvisories, 4);
      assert.equal(upsertArgs.create.noShows, 5);
      assert.ok(out, 'should return the upserted row');
    });

    it('returns null and does not throw when count() rejects', async () => {
      prisma.reservation.count = async () => {
        throw new Error('pool timeout');
      };
      prisma.reservationDailyCounter.upsert = async () => {
        upsertCalls += 1;
        return null;
      };

      const out = await refreshCounters({
        tenantId: 'tenant-1',
        day: new Date(),
        dayStart: new Date(),
        dayEnd: new Date()
      });

      assert.equal(out, null);
      assert.equal(upsertCalls, 0, 'upsert should not run when count() failed');
    });

    it('returns null when called with missing args', async () => {
      const out = await refreshCounters({});
      assert.equal(out, null);
    });
  });
});
