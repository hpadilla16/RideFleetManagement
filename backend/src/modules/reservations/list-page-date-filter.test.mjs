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

  it('applies single-date filter when dateOn is set', async () => {
    await reservationsService.listPage({ dateOn: '2026-04-28' }, { tenantId: 't1' });
    const w = captured.findManyWhere;
    assert.ok(w.pickupAt?.lte, 'expected pickupAt.lte');
    assert.ok(w.returnAt?.gte, 'expected returnAt.gte');
    assert.equal(w.pickupAt.lte.toISOString().slice(0, 10), '2026-04-28');
    assert.equal(w.returnAt.gte.toISOString().slice(0, 10), '2026-04-28');
    // start of day for returnAt.gte; end of day for pickupAt.lte
    assert.equal(w.returnAt.gte.getHours(), 0);
    assert.equal(w.pickupAt.lte.getHours(), 23);
  });

  it('applies range filter when dateFrom + dateTo are set', async () => {
    await reservationsService.listPage(
      { dateFrom: '2026-04-01', dateTo: '2026-04-30' },
      { tenantId: 't1' }
    );
    const w = captured.findManyWhere;
    assert.equal(w.returnAt.gte.toISOString().slice(0, 10), '2026-04-01');
    assert.equal(w.pickupAt.lte.toISOString().slice(0, 10), '2026-04-30');
  });

  it('open-ended range: dateFrom alone', async () => {
    await reservationsService.listPage({ dateFrom: '2026-04-15' }, { tenantId: 't1' });
    const w = captured.findManyWhere;
    assert.equal(w.returnAt.gte.toISOString().slice(0, 10), '2026-04-15');
    // upper bound should be far future
    assert.ok(w.pickupAt.lte.getFullYear() >= 9999);
  });

  it('open-ended range: dateTo alone', async () => {
    await reservationsService.listPage({ dateTo: '2026-04-15' }, { tenantId: 't1' });
    const w = captured.findManyWhere;
    assert.equal(w.pickupAt.lte.toISOString().slice(0, 10), '2026-04-15');
    // lower bound should be far past
    assert.ok(w.returnAt.gte.getFullYear() <= 1970);
  });

  it('explicit range wins over dateOn when both are set', async () => {
    await reservationsService.listPage(
      { dateOn: '2026-04-28', dateFrom: '2026-04-01', dateTo: '2026-04-30' },
      { tenantId: 't1' }
    );
    const w = captured.findManyWhere;
    assert.equal(w.returnAt.gte.toISOString().slice(0, 10), '2026-04-01');
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

  it('combines date filter with text query (both applied)', async () => {
    await reservationsService.listPage(
      { dateOn: '2026-04-28', query: 'smith' },
      { tenantId: 't1' }
    );
    const w = captured.findManyWhere;
    assert.ok(w.pickupAt?.lte, 'date filter applied');
    assert.ok(Array.isArray(w.OR), 'text query applied');
    assert.equal(w.tenantId, 't1');
  });
});
