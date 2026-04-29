import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { prisma } from '../../lib/prisma.js';
import { reservationsService } from './reservations.service.js';

// Verifies the listPage date filter (overlap semantics):
//   pickupAt <= rangeEnd AND returnAt >= rangeStart
// Inputs:
//   dateOn = "YYYY-MM-DD" (single day)
//   dateFrom + dateTo (range; either alone is open-ended)
//   Invalid date strings drop the filter silently.
//
// Pattern: monkey-patch prisma to capture the where clause sent to
// findMany / count. No DB needed.

describe('reservationsService.listPage — date filter', () => {
  let captured;
  let origCount;
  let origFindMany;

  beforeEach(() => {
    captured = null;
    origCount = prisma.reservation.count;
    origFindMany = prisma.reservation.findMany;
    prisma.reservation.count = async ({ where }) => { captured = { ...captured, countWhere: where }; return 0; };
    prisma.reservation.findMany = async ({ where }) => { captured = { ...captured, findManyWhere: where }; return []; };
  });

  afterEach(() => {
    prisma.reservation.count = origCount;
    prisma.reservation.findMany = origFindMany;
  });

  // Filter semantics changed 2026-04-29: now "pickupAt falls in [from, to]"
  // (= checkout date), not rental-window-overlap. The where shape we expect:
  //   where.pickupAt = { gte: <start UTC>, lte: <end UTC> }
  //   where.returnAt is NOT set
  it('applies single-date filter when dateOn is set (UTC bounds)', async () => {
    await reservationsService.listPage({ dateOn: '2026-04-28' }, { tenantId: 't1' });
    const w = captured.findManyWhere;
    assert.ok(w.pickupAt?.gte, 'expected pickupAt.gte');
    assert.ok(w.pickupAt?.lte, 'expected pickupAt.lte');
    assert.equal(w.returnAt, undefined, 'returnAt should NOT be filtered (pickup-only semantics)');
    assert.equal(w.pickupAt.gte.toISOString().slice(0, 10), '2026-04-28');
    assert.equal(w.pickupAt.lte.toISOString().slice(0, 10), '2026-04-28');
    // Bounds are UTC midnight / end-of-day-UTC — independent of server timezone.
    assert.equal(w.pickupAt.gte.getUTCHours(), 0);
    assert.equal(w.pickupAt.gte.getUTCMinutes(), 0);
    assert.equal(w.pickupAt.lte.getUTCHours(), 23);
    assert.equal(w.pickupAt.lte.getUTCMinutes(), 59);
  });

  it('applies range filter when dateFrom + dateTo are set', async () => {
    await reservationsService.listPage(
      { dateFrom: '2026-04-01', dateTo: '2026-04-30' },
      { tenantId: 't1' }
    );
    const w = captured.findManyWhere;
    assert.equal(w.pickupAt.gte.toISOString().slice(0, 10), '2026-04-01');
    assert.equal(w.pickupAt.lte.toISOString().slice(0, 10), '2026-04-30');
    assert.equal(w.returnAt, undefined);
  });

  it('open-ended range: dateFrom alone', async () => {
    await reservationsService.listPage({ dateFrom: '2026-04-15' }, { tenantId: 't1' });
    const w = captured.findManyWhere;
    assert.equal(w.pickupAt.gte.toISOString().slice(0, 10), '2026-04-15');
    // upper bound is the year-9999 UTC sentinel — getUTCFullYear() because
    // local-time conversion can roll into year 10000 in west-of-UTC TZs.
    assert.ok(w.pickupAt.lte.getUTCFullYear() >= 9999);
  });

  it('open-ended range: dateTo alone', async () => {
    await reservationsService.listPage({ dateTo: '2026-04-15' }, { tenantId: 't1' });
    const w = captured.findManyWhere;
    assert.equal(w.pickupAt.lte.toISOString().slice(0, 10), '2026-04-15');
    // lower bound is the year-1970 UTC sentinel — same UTC reasoning.
    assert.ok(w.pickupAt.gte.getUTCFullYear() <= 1970);
  });

  it('explicit range wins over dateOn when both are set', async () => {
    await reservationsService.listPage(
      { dateOn: '2026-04-28', dateFrom: '2026-04-01', dateTo: '2026-04-30' },
      { tenantId: 't1' }
    );
    const w = captured.findManyWhere;
    assert.equal(w.pickupAt.gte.toISOString().slice(0, 10), '2026-04-01');
    assert.equal(w.pickupAt.lte.toISOString().slice(0, 10), '2026-04-30');
  });

  it('drops the filter silently on a malformed date string', async () => {
    await reservationsService.listPage({ dateOn: 'not-a-date' }, { tenantId: 't1' });
    const w = captured.findManyWhere;
    assert.equal(w.pickupAt, undefined, 'no date filter when input is invalid');
    assert.equal(w.returnAt, undefined);
    // tenant scope still applied
    assert.equal(w.tenantId, 't1');
  });

  it('no date filter when no date inputs are provided', async () => {
    await reservationsService.listPage({}, { tenantId: 't1' });
    const w = captured.findManyWhere;
    assert.equal(w.pickupAt, undefined);
    assert.equal(w.returnAt, undefined);
  });

  // Codex bot finding (PR #21): JS Date silently rolls invalid days
  // (2026-02-31 -> March 3) instead of failing. Pin the rejection.
  it('rejects invalid calendar dates (Feb 31, Apr 31, Feb 29 in non-leap year)', async () => {
    for (const bad of ['2026-02-31', '2026-04-31', '2025-02-29', '2026-13-01', '2026-00-15', '2026-04-00', '2026-04-32']) {
      captured = null;
      await reservationsService.listPage({ dateOn: bad }, { tenantId: 't1' });
      const w = captured.findManyWhere;
      assert.equal(w.pickupAt, undefined, `expected ${bad} to be rejected (no pickupAt filter)`);
      assert.equal(w.returnAt, undefined, `expected ${bad} to be rejected (no returnAt filter)`);
    }
  });

  it('rejects strings with trailing junk (anchored full-string match)', async () => {
    await reservationsService.listPage({ dateOn: '2026-04-28T17:00:00' }, { tenantId: 't1' });
    const w = captured.findManyWhere;
    assert.equal(w.pickupAt, undefined, 'strict YYYY-MM-DD match — no trailing time portion');
  });

  it('accepts a leap-year Feb 29 in a leap year', async () => {
    await reservationsService.listPage({ dateOn: '2024-02-29' }, { tenantId: 't1' });
    const w = captured.findManyWhere;
    assert.equal(w.pickupAt.gte.toISOString().slice(0, 10), '2024-02-29');
    assert.equal(w.pickupAt.lte.toISOString().slice(0, 10), '2024-02-29');
  });

  // Sentry bot finding (PR #21): bounds were built with a no-Z datetime
  // string, parsed in server-local time. Pin that bounds are now UTC.
  it('builds UTC bounds (independent of server timezone)', async () => {
    await reservationsService.listPage({ dateOn: '2026-04-28' }, { tenantId: 't1' });
    const w = captured.findManyWhere;
    // Start of day UTC = 00:00:00.000 UTC; toISOString shows that directly.
    assert.equal(w.pickupAt.gte.toISOString(), '2026-04-28T00:00:00.000Z');
    assert.equal(w.pickupAt.lte.toISOString(), '2026-04-28T23:59:59.999Z');
  });

  it('combines date filter with text query (both applied)', async () => {
    await reservationsService.listPage(
      { dateOn: '2026-04-28', query: 'smith' },
      { tenantId: 't1' }
    );
    const w = captured.findManyWhere;
    assert.ok(w.pickupAt?.gte && w.pickupAt?.lte, 'date filter applied');
    assert.ok(Array.isArray(w.OR), 'text query applied');
    assert.equal(w.tenantId, 't1');
  });
});
