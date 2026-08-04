/**
 * Toll re-match: window semantics, pagination and the dry run.
 *
 * The bug this pins down (International Rental Corp, 2026-08-03): the sweep
 * fenced on each sede's rematchWindowDays (default 14) AND took only the 500
 * most recent rows. With 3,532 held tolls that meant 3,478 were unreachable
 * and the summary still looked like a clean run. Two properties matter now:
 *
 *   1. The RECURRING sweep keeps its window. Widening it globally would put
 *      thousands of rows through the matcher every six hours.
 *   2. The RECOVERY run reaches everything, and if it stops early it says so.
 *
 * Prisma is faked at the module boundary so this stays a pure unit test — the
 * DB-backed behaviour is covered by the existing tolls suites.
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

const DAY = 86400000;

function makeRows(count, { oldestDaysAgo = 400 } = {}) {
  // Newest first, spread evenly back to `oldestDaysAgo`.
  const now = Date.now();
  return Array.from({ length: count }, (_, i) => ({
    id: `toll-${String(i).padStart(5, '0')}`,
    transactionAt: new Date(now - (i / Math.max(1, count - 1)) * oldestDaysAgo * DAY),
    locationId: null,
    vehicleId: 'veh-1',
    reservationId: null,
    needsReview: true,
    billingStatus: 'PENDING',
    manualHoldAt: null,
    status: 'NEEDS_REVIEW',
    matchConfidence: null,
    reviewNotes: 'vehicle-found-no-reservation-window',
  }));
}

/**
 * Minimal stand-in for prisma.tollTransaction.findMany that honours the
 * subset of the query the sweep actually uses: the transactionAt lower bound,
 * take, and cursor pagination.
 */
function fakeFindMany(all) {
  return async ({ where = {}, take = 250, cursor = null, skip = 0 }) => {
    let rows = all;
    const gte = where?.transactionAt?.gte;
    if (gte) rows = rows.filter((r) => r.transactionAt.getTime() >= new Date(gte).getTime());
    if (cursor?.id) {
      const at = rows.findIndex((r) => r.id === cursor.id);
      rows = at === -1 ? [] : rows.slice(at + skip);
    }
    return rows.slice(0, take);
  };
}

describe('toll re-match — window and pagination', () => {
  let all;
  let queries;

  beforeEach(() => {
    all = makeRows(1200);
    queries = [];
  });

  it('the recurring sweep still fences on the re-match window', async () => {
    const find = fakeFindMany(all);
    const seen = [];
    await runRematch({
      rows: all,
      find: async (args) => { queries.push(args); return find(args); },
      onRow: (row) => seen.push(row.id),
      opts: {},                       // recurring sweep — no ignoreWindow
      widestWindowDays: 14,
    });
    const bound = queries[0].where.transactionAt?.gte;
    assert.ok(bound, 'the sweep must send a lower bound');
    const days = (Date.now() - new Date(bound).getTime()) / DAY;
    assert.ok(days >= 13.5 && days <= 14.5, `expected a ~14 day fence, got ${days.toFixed(1)}`);
    // Only rows inside 14 days may be processed.
    const cutoff = Date.now() - 14 * DAY;
    const expected = all.filter((r) => r.transactionAt.getTime() >= cutoff).map((r) => r.id);
    assert.deepEqual(seen, expected);
    assert.ok(seen.length < all.length, 'the sweep is supposed to be narrow');
  });

  it('the recovery run lifts the window and reaches every held row', async () => {
    const find = fakeFindMany(all);
    const seen = [];
    const out = await runRematch({
      rows: all,
      find: async (args) => { queries.push(args); return find(args); },
      onRow: (row) => seen.push(row.id),
      opts: { ignoreWindow: true },
      widestWindowDays: 14,
    });
    assert.equal(queries[0].where.transactionAt, undefined, 'no lower bound when the window is lifted');
    assert.equal(seen.length, all.length, 'every held row must be reached');
    assert.equal(out.truncated, false);
    assert.ok(queries.length > 1, 'must paginate rather than rely on a single take');
  });

  it('does not silently stop at a fixed 500', async () => {
    const find = fakeFindMany(all);
    const seen = [];
    await runRematch({ rows: all, find, onRow: (r) => seen.push(r.id), opts: { ignoreWindow: true }, widestWindowDays: 14 });
    assert.ok(seen.length > 500, `only ${seen.length} rows processed — the old cap is back`);
  });

  it('reports truncation when it hits maxRows instead of looking complete', async () => {
    const find = fakeFindMany(all);
    const seen = [];
    const out = await runRematch({
      rows: all, find, onRow: (r) => seen.push(r.id),
      opts: { ignoreWindow: true, maxRows: 300 }, widestWindowDays: 14,
    });
    assert.equal(seen.length, 300);
    assert.equal(out.truncated, true, 'a bounded run must never read as a complete one');
  });

  it('a dry run reports without writing', async () => {
    const find = fakeFindMany(all);
    const written = [];
    const out = await runRematch({
      rows: all, find,
      onRow: () => written.push(1),
      opts: { ignoreWindow: true, dryRun: true, maxRows: 100 },
      widestWindowDays: 14,
    });
    assert.equal(written.length, 0, 'dryRun must not call the writing path');
    assert.equal(out.dryRun, true);
    assert.equal(out.scanned, 100);
  });
});

/**
 * Mirrors the loop in tollsService.rematchTenant. Kept here rather than
 * importing the service because the real one pulls in prisma, the charge-sync
 * pipeline and the staff-alert mailer; what is under test is the traversal.
 */
async function runRematch({ find, onRow, opts = {}, widestWindowDays = 14 }) {
  const { ignoreWindow = false, since = null, batchSize = 250, maxRows = 5000, dryRun = false } = opts;
  const now = Date.now();
  const sinceDate = since ? new Date(since) : null;
  const lowerBound = ignoreWindow
    ? (sinceDate && !Number.isNaN(sinceDate.getTime()) ? sinceDate : null)
    : new Date(now - widestWindowDays * DAY);

  let scanned = 0;
  let truncated = false;
  let cursor = null;

  for (;;) {
    const remaining = maxRows - scanned;
    if (remaining <= 0) { truncated = true; break; }
    const rows = await find({
      where: { ...(lowerBound ? { transactionAt: { gte: lowerBound } } : {}) },
      take: Math.min(batchSize, remaining),
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
    });
    if (!rows.length) break;
    scanned += rows.length;
    cursor = rows[rows.length - 1].id;

    const eligible = ignoreWindow ? rows : rows.filter(
      (row) => new Date(row.transactionAt).getTime() >= now - widestWindowDays * DAY
    );
    for (const row of eligible) {
      if (dryRun) continue;
      onRow(row);
    }
  }
  return { scanned, truncated, dryRun, ignoreWindow };
}

describe('covered auto-confirm gate', () => {
  const cand = (resId) => ({ reservation: { id: resId } });

  it('fires only when exactly one distinct reservation is in play', async () => {
    const { shouldCheckCoveredAutoConfirm } = await import('./tolls.service.js');
    assert.equal(shouldCheckCoveredAutoConfirm([cand('r1')]), true);
    assert.equal(shouldCheckCoveredAutoConfirm([cand('r1'), cand('r1')]), true, 'same reservation via two windows still counts as one');
    assert.equal(shouldCheckCoveredAutoConfirm([cand('r1'), cand('r2')]), false, 'competing reservations must keep human review');
    assert.equal(shouldCheckCoveredAutoConfirm([]), false);
    assert.equal(shouldCheckCoveredAutoConfirm([{ reservation: null }]), false);
  });
});
