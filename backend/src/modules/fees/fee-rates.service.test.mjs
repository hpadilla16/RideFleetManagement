/**
 * Unit tests for fee-rates.service.js (16q).
 *
 * Follows the prisma monkey-patch pattern used in fees.test.mjs: we stub the
 * specific prisma.feeRate methods + $transaction so the service can exercise
 * its own merge / validation / upsert logic without a live database.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { prisma } from '../../lib/prisma.js';
import { feeRatesService, validateBulkPayload, listForScope, bulkUpsert, FEE_TYPE_METADATA } from './fee-rates.service.js';
import { ValidationError } from '../../lib/errors.js';

const TENANT = 'tenant-abc';

let stubs;

beforeEach(() => {
  stubs = {
    rows: [],            // current in-memory FeeRate table (locationId: null)
    findManyArgs: null,
    txCalls: 0
  };

  const orig = {
    findMany: prisma.feeRate.findMany,
    findFirst: prisma.feeRate.findFirst,
    create: prisma.feeRate.create,
    update: prisma.feeRate.update,
    transaction: prisma.$transaction
  };

  prisma.feeRate.findMany = async (args) => {
    stubs.findManyArgs = args;
    return stubs.rows.filter((r) =>
      r.tenantId === args.where.tenantId &&
      r.locationId === args.where.locationId
    );
  };
  prisma.feeRate.findFirst = async (args) => {
    return stubs.rows.find((r) =>
      r.tenantId === args.where.tenantId &&
      r.locationId === args.where.locationId &&
      r.feeType === args.where.feeType
    ) || null;
  };
  prisma.feeRate.create = async ({ data }) => {
    const row = { id: `id-${stubs.rows.length + 1}`, updatedAt: new Date(), ...data };
    stubs.rows.push(row);
    return row;
  };
  prisma.feeRate.update = async ({ where, data }) => {
    const row = stubs.rows.find((r) => r.id === where.id);
    Object.assign(row, data, { updatedAt: new Date() });
    return row;
  };
  prisma.$transaction = async (fn) => {
    stubs.txCalls += 1;
    // Mimic the interactive-transaction signature (callback gets a tx client).
    // Our stub just passes the same prisma so nested calls resolve.
    return fn(prisma);
  };

  stubs.restore = () => {
    prisma.feeRate.findMany = orig.findMany;
    prisma.feeRate.findFirst = orig.findFirst;
    prisma.feeRate.create = orig.create;
    prisma.feeRate.update = orig.update;
    prisma.$transaction = orig.transaction;
  };
});

afterEach(() => {
  stubs.restore();
});

// ─────────────────────────────────────────────────────────────────────────────
// listForScope — merging defaults with DB overrides
// ─────────────────────────────────────────────────────────────────────────────

describe('feeRatesService.listForScope', () => {
  it('returns 7 rows from empty DB, all marked hardcoded', async () => {
    const rows = await listForScope({ tenantId: TENANT });
    assert.equal(rows.length, 7);
    for (const row of rows) {
      assert.equal(row.currentSource, 'hardcoded');
      assert.equal(row.rateId, null);
      assert.equal(row.locationId, null);
      assert.equal(typeof row.defaultAmount, 'number');
      assert.equal(typeof row.validRange.min, 'number');
    }
  });

  it('filters by tenantId + locationId: null', async () => {
    await listForScope({ tenantId: TENANT });
    assert.equal(stubs.findManyArgs.where.tenantId, TENANT);
    assert.equal(stubs.findManyArgs.where.locationId, null);
  });

  it('merges 2 tenant overrides on top of defaults', async () => {
    stubs.rows.push(
      { id: 'r1', tenantId: TENANT, locationId: null, feeType: 'FUEL_REFILL',  unit: 'PER_GALLON', amount: 8.50, isActive: true,  notes: 'higher gas market', updatedAt: new Date('2026-05-18T00:00:00Z') },
      { id: 'r2', tenantId: TENANT, locationId: null, feeType: 'SMOKING',      unit: 'FLAT',       amount: 500,  isActive: true,  notes: null,                updatedAt: new Date('2026-05-18T00:00:00Z') }
    );

    const rows = await listForScope({ tenantId: TENANT }, { editable: true });
    const byType = Object.fromEntries(rows.map((r) => [r.feeType, r]));

    assert.equal(byType.FUEL_REFILL.currentSource, 'tenant_default');
    assert.equal(byType.FUEL_REFILL.currentAmount, 8.50);
    assert.equal(byType.FUEL_REFILL.notes, 'higher gas market');
    assert.equal(byType.FUEL_REFILL.rateId, 'r1');

    assert.equal(byType.SMOKING.currentSource, 'tenant_default');
    assert.equal(byType.SMOKING.currentAmount, 500);

    // Remaining 5 still hardcoded
    assert.equal(byType.CLEANING_LIGHT.currentSource, 'hardcoded');
    assert.equal(byType.CLEANING_LIGHT.rateId, null);

    // editable flag propagates to every row
    for (const r of rows) assert.equal(r.editable, true);
  });

  it('rejects deny-all sentinel scope', async () => {
    await assert.rejects(
      listForScope({ tenantId: '__no_tenant__' }),
      (e) => e instanceof ValidationError && /tenantId required/i.test(e.message)
    );
  });

  it('rejects empty scope (super-admin without tenantId)', async () => {
    await assert.rejects(
      listForScope({}),
      (e) => e instanceof ValidationError
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// validateBulkPayload — pure validation
// ─────────────────────────────────────────────────────────────────────────────

describe('feeRatesService.validateBulkPayload', () => {
  it('accepts a clean single-rate payload', () => {
    const r = validateBulkPayload({ rates: [{ feeType: 'FUEL_REFILL', amount: 7.50 }] });
    assert.equal(r.ok, true);
    assert.equal(r.rates[0].unit, 'PER_GALLON');   // server-controlled
  });

  it('rejects unknown feeType', () => {
    const r = validateBulkPayload({ rates: [{ feeType: 'TIRE_DAMAGE', amount: 50 }] });
    assert.equal(r.ok, false);
    assert.match(r.errors[0].message, /Unknown feeType/);
  });

  it('rejects amount below min (boundary)', () => {
    const meta = FEE_TYPE_METADATA.SMOKING;
    const r = validateBulkPayload({ rates: [{ feeType: 'SMOKING', amount: meta.min - 1 }] });
    assert.equal(r.ok, false);
    assert.match(r.errors[0].message, /out of range/);
  });

  it('rejects amount above max (boundary)', () => {
    const meta = FEE_TYPE_METADATA.SMOKING;
    const r = validateBulkPayload({ rates: [{ feeType: 'SMOKING', amount: meta.max + 1 }] });
    assert.equal(r.ok, false);
    assert.match(r.errors[0].message, /out of range/);
  });

  it('accepts amount exactly at min and max', () => {
    const meta = FEE_TYPE_METADATA.SMOKING;
    const lo = validateBulkPayload({ rates: [{ feeType: 'SMOKING', amount: meta.min }] });
    const hi = validateBulkPayload({ rates: [{ feeType: 'SMOKING', amount: meta.max }] });
    assert.equal(lo.ok, true);
    assert.equal(hi.ok, true);
  });

  it('rejects negative amount', () => {
    const r = validateBulkPayload({ rates: [{ feeType: 'FUEL_REFILL', amount: -1 }] });
    assert.equal(r.ok, false);
    // negative is caught before range check
    assert.ok(r.errors[0].message.match(/>= 0|out of range/));
  });

  it('rejects NaN', () => {
    const r = validateBulkPayload({ rates: [{ feeType: 'FUEL_REFILL', amount: NaN }] });
    assert.equal(r.ok, false);
    assert.match(r.errors[0].message, /finite number/);
  });

  it('rejects Infinity', () => {
    const r = validateBulkPayload({ rates: [{ feeType: 'FUEL_REFILL', amount: Infinity }] });
    assert.equal(r.ok, false);
    assert.match(r.errors[0].message, /finite number/);
  });

  it('rejects duplicate feeType in payload', () => {
    const r = validateBulkPayload({
      rates: [
        { feeType: 'FUEL_REFILL', amount: 7 },
        { feeType: 'FUEL_REFILL', amount: 8 }
      ]
    });
    assert.equal(r.ok, false);
    assert.match(r.errors[0].message, /Duplicate/);
  });

  it('ignores client-supplied unit (uses metadata unit)', () => {
    const r = validateBulkPayload({
      rates: [{ feeType: 'FUEL_REFILL', amount: 7, unit: 'PER_BANANA' }]
    });
    assert.equal(r.ok, true);
    assert.equal(r.rates[0].unit, 'PER_GALLON');
  });

  it('rejects notes longer than 280 chars', () => {
    const r = validateBulkPayload({
      rates: [{ feeType: 'FUEL_REFILL', amount: 7, notes: 'x'.repeat(281) }]
    });
    assert.equal(r.ok, false);
    assert.match(r.errors[0].message, /280/);
  });

  it('rejects missing rates array', () => {
    assert.equal(validateBulkPayload({}).ok, false);
    assert.equal(validateBulkPayload({ rates: [] }).ok, false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// bulkUpsert — DB writes via transaction
// ─────────────────────────────────────────────────────────────────────────────

describe('feeRatesService.bulkUpsert', () => {
  it('creates new rows in a transaction (empty DB)', async () => {
    const rows = await bulkUpsert(
      { rates: [{ feeType: 'FUEL_REFILL', amount: 9.00 }, { feeType: 'SMOKING', amount: 300 }] },
      { tenantId: TENANT },
      { actorUserId: 'user-1' }
    );
    assert.equal(stubs.txCalls, 1);
    assert.equal(stubs.rows.length, 2);
    assert.equal(stubs.rows[0].tenantId, TENANT);
    assert.equal(stubs.rows[0].locationId, null);

    const fuel = rows.find((r) => r.feeType === 'FUEL_REFILL');
    assert.equal(fuel.currentSource, 'tenant_default');
    assert.equal(fuel.currentAmount, 9);
  });

  it('updates an existing row instead of inserting a duplicate', async () => {
    stubs.rows.push({
      id: 'r-existing', tenantId: TENANT, locationId: null, feeType: 'FUEL_REFILL',
      unit: 'PER_GALLON', amount: 7.00, isActive: true, notes: null, updatedAt: new Date()
    });

    await bulkUpsert(
      { rates: [{ feeType: 'FUEL_REFILL', amount: 11.50, notes: 'market surge' }] },
      { tenantId: TENANT }
    );

    // Still 1 row — updated in place
    assert.equal(stubs.rows.length, 1);
    assert.equal(Number(stubs.rows[0].amount), 11.50);
    assert.equal(stubs.rows[0].notes, 'market surge');
  });

  it('throws ValidationError with details on bad payload', async () => {
    await assert.rejects(
      bulkUpsert({ rates: [{ feeType: 'BOGUS', amount: 5 }] }, { tenantId: TENANT }),
      (e) => e instanceof ValidationError && Array.isArray(e.details) && e.details[0].feeType === 'BOGUS'
    );
    // Transaction never opened — validation runs first
    assert.equal(stubs.txCalls, 0);
  });

  it('rejects deny-all sentinel scope', async () => {
    await assert.rejects(
      bulkUpsert({ rates: [{ feeType: 'FUEL_REFILL', amount: 7 }] }, { tenantId: '__no_tenant__' }),
      (e) => e instanceof ValidationError
    );
  });

  it('returns the freshly-listed shape post-write (editable propagates)', async () => {
    const rows = await bulkUpsert(
      { rates: [{ feeType: 'FUEL_REFILL', amount: 7.5 }] },
      { tenantId: TENANT },
      { editable: true }
    );
    assert.equal(rows.length, 7);
    for (const r of rows) assert.equal(r.editable, true);
  });
});

// Exported-shape sanity check
describe('feeRatesService exports', () => {
  it('exposes the metadata + functions on the named export', () => {
    assert.equal(typeof feeRatesService.listForScope, 'function');
    assert.equal(typeof feeRatesService.bulkUpsert, 'function');
    assert.equal(typeof feeRatesService.validateBulkPayload, 'function');
    assert.equal(Object.keys(feeRatesService.FEE_TYPE_METADATA).length, 7);
  });
});
