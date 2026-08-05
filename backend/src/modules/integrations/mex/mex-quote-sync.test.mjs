/**
 * syncImportedFeeCharges must converge on ONE row per line, whatever the
 * reservation already carries.
 *
 * Production, 2026-08-05: after the first backfill MEX-WMX000F971 showed two
 * "Daily" lines — the new one (source BASE_RATE) beside a stale $0.00 one the
 * engine had written under source DAILY. Same line, three historical
 * identities, so the matcher has to recognise all of them.
 */
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://u:p@127.0.0.1:5432/none';

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const { syncImportedFeeCharges } = await import('./mex.worker.js');

const DETAIL = {
  confirmation: 'WMX000F971',
  charges: { rateTotal: 336, taxTotal: 75.31, extraTotal: 318.9, estimatedTotal: 730.21 },
  optionalServices: [
    { amount: 5.93, description: 'CUSTOMER FACILITY CHARGE' },
    { amount: 2.5, description: 'VEHICLE LICENSE FEE SJU' },
    { amount: 2.2, description: 'SURCHARGE' },
  ],
};

// Minimal in-memory stand-in for the charge table.
function fakeDb(seed = [], { taxRate = 11.5, dailyRate = null } = {}) {
  let id = seed.length;
  const rows = seed.map((r, i) => ({ id: `c${i}`, ...r }));
  const reservation = { dailyRate, updates: [] };
  return {
    rows,
    reservation,
    reservationCharge: {
      findMany: async () => rows.map((r) => ({ ...r })),
      create: async ({ data }) => { rows.push({ id: `c${++id}`, ...data }); return data; },
      update: async ({ where, data }) => {
        const hit = rows.find((r) => r.id === where.id);
        Object.assign(hit, data);
        return hit;
      },
      deleteMany: async ({ where }) => {
        for (const rid of where.id.in) {
          const idx = rows.findIndex((r) => r.id === rid);
          if (idx >= 0) rows.splice(idx, 1);
        }
      },
    },
    reservation_: reservation,
    reservation: {
      findUnique: async () => ({ dailyRate, pickupLocation: { taxRate } }),
      update: async ({ data }) => { reservation.updates.push(data); return data; },
    },
  };
}

const dailyRows = (db) => db.rows.filter((r) => String(r.name).toUpperCase() === 'DAILY');

describe('syncImportedFeeCharges', () => {
  it('writes the whole quote onto a bare reservation and reconciles', async () => {
    const db = fakeDb();
    const out = await syncImportedFeeCharges(db, 'r1', DETAIL, { days: 30 });
    assert.equal(out.created, 5, 'rental + 3 fees + tax');
    assert.equal(out.removed, 0);
    const sum = db.rows.reduce((s, r) => s + Number(r.total), 0);
    assert.equal(Math.round(sum * 100) / 100, 730.21, 'must equal the portal Estimated Total');
    assert.equal(db.reservation_.updates[0].dailyRate, 11.2, 'the counter needs the daily rate');
  });

  it('collapses a stale $0.00 Daily written under a different identity', async () => {
    // The exact production shape: source DAILY, no code, zero money.
    const db = fakeDb([{ name: 'Daily', code: null, source: 'DAILY', chargeType: 'UNIT', quantity: 30, rate: 0, total: 0, taxable: true }]);
    await syncImportedFeeCharges(db, 'r1', DETAIL, { days: 30 });
    assert.equal(dailyRows(db).length, 1, 'one rental line, not two');
    assert.equal(dailyRows(db)[0].total, 336, 'and it carries the real money');
  });

  it('drops the imported tax it used to write, keeping only the computed one', async () => {
    const db = fakeDb([
      { name: 'Taxes (quoted by MEX)', code: 'IMPORTED_TAX', source: 'MEX_IMPORT', chargeType: 'UNIT', quantity: 1, rate: 75.31, total: 75.31, taxable: false, sourceRefId: 'WMX000F971:TAX' },
      { name: 'Rental — 30 day(s)', code: 'BASE_RATE', source: 'MEX_IMPORT', chargeType: 'UNIT', quantity: 30, rate: 11.2, total: 336, taxable: false, sourceRefId: 'WMX000F971:RATE' },
    ]);
    await syncImportedFeeCharges(db, 'r1', DETAIL, { days: 30 });
    assert.equal(db.rows.filter((r) => r.code === 'IMPORTED_TAX').length, 0);
    const taxes = db.rows.filter((r) => String(r.chargeType).toUpperCase() === 'TAX');
    assert.equal(taxes.length, 1);
    assert.equal(taxes[0].total, 75.31, 'the engine lands on the same number MEX quoted');
    assert.equal(dailyRows(db).length, 1);
    const sum = db.rows.reduce((s, r) => s + Number(r.total), 0);
    assert.equal(Math.round(sum * 100) / 100, 730.21);
  });

  it('is idempotent — a second run changes nothing', async () => {
    const db = fakeDb();
    await syncImportedFeeCharges(db, 'r1', DETAIL, { days: 30 });
    const before = JSON.stringify(db.rows.map((r) => [r.name, r.total]).sort());
    const out = await syncImportedFeeCharges(db, 'r1', DETAIL, { days: 30 });
    assert.deepEqual({ created: out.created, updated: out.updated, removed: out.removed }, { created: 0, updated: 0, removed: 0 });
    assert.equal(JSON.stringify(db.rows.map((r) => [r.name, r.total]).sort()), before);
  });

  it('writes no tax when the pickup location has no rate', async () => {
    const db = fakeDb([], { taxRate: null });
    await syncImportedFeeCharges(db, 'r1', DETAIL, { days: 30 });
    assert.equal(db.rows.some((r) => String(r.chargeType).toUpperCase() === 'TAX'), false);
    // Rental and fees still land — a missing tax rate is not a reason to
    // import nothing.
    assert.equal(dailyRows(db).length, 1);
    assert.equal(db.rows.filter((r) => r.source === 'MEX_IMPORT').length, 3);
  });

  it('does nothing without a reservation or a detail', async () => {
    const db = fakeDb();
    assert.deepEqual(await syncImportedFeeCharges(db, null, DETAIL, {}), { created: 0, updated: 0, removed: 0 });
    assert.deepEqual(await syncImportedFeeCharges(db, 'r1', null, {}), { created: 0, updated: 0, removed: 0 });
    assert.equal(db.rows.length, 0);
  });
});
