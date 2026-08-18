/**
 * THE OTHER TWO PLACES THAT REBUILD A TAX ROW FROM THE WRONG RATE.
 *
 * Sibling of the extension-path fix (extend-tax-rate.test.mjs, 2026-08-18) and
 * of the pre-check-in one before it. That fix's QA gate found these two and
 * deliberately left them out of its diff to keep the money-path blast radius
 * small — finding m-3. This suite is that finding being cashed.
 *
 * WHAT WAS WRONG. Both sites REBUILD the TAX charge row and both read only the
 * pickup location, never the reservation's pricing snapshot:
 *
 *   long-term.service.js:95   const taxRate = Number(reservation.pickupLocation?.taxRate || 0);
 *   mex.worker.js:227         const taxRate = Number(reservation?.pickupLocation?.taxRate) || null;
 *
 * ReservationPricingSnapshot.taxRate is NULLABLE (schema.prisma:2823), so
 * "unset" already has its own representation and a stored 0 is DELIBERATE:
 * car-sharing.service.js:253 writes a literal 0 for a trip it does not tax, on
 * a reservation whose pickup location DOES have a rate. Put one of those on a
 * monthly plan and it got taxed at the location's rate — money the customer
 * never agreed to, exactly as on the extension path.
 *
 * THESE ARE WRITERS, NOT READERS. The location-only READERS elsewhere
 * (booking-engine 1274/1769/1783/1801, public-booking 440, quotes 422,
 * cash-flow 208/393) are CORRECT and untouched: Location.taxRate is NON-NULL
 * with default 0 (schema.prisma:660), so their `|| 0` branch is unreachable and
 * a no-op edit there would only mislead the next reader.
 *
 * WHY DB-FREE, AND WHY THAT IS THE POINT. Prisma hands a `Decimal?` column back
 * as a Decimal OBJECT, and `new Decimal(0)` is TRUTHY — so a DB-backed case
 * passes identically under `||` and under `!= null` and guards NOTHING. That is
 * measured, not assumed: it is what let the pre-check-in bug ship green. Only a
 * PRIMITIVE 0 tells the two apart, so every case below feeds one by hand
 * through a stub client and lets the REAL function do the real work.
 *
 * THE DELIBERATE-ZERO POPULATION IS BIGGER THAN CAR-SHARING, and tax-rate.js's
 * own docblock understates it. Location.taxRate is non-null @default(0)
 * (schema.prisma:660), so EVERY staff reservation created at a location whose
 * rate was never configured now carries an authoritative 0 — and if that
 * location's rate is later corrected upward, these two writers will no longer
 * apply tax where they used to. That is judged correct rather than merely
 * tolerable: rental-agreements.service.js:2844/3241 — the agreement, which is
 * the document the customer actually signs — already resolves with `??`, so the
 * writers now agree with it instead of contradicting it. Recorded here rather
 * than in tax-rate.js because that file is kept byte-identical to an
 * uncommitted copy on a sibling branch so the two merge without a conflict.
 *
 * ONE HOLE THIS SUITE DOES NOT CLOSE. resolveTaxRate treats '' as unset, and
 * its docblock justifies that as protecting a CLEARED Tax % field. No such
 * value can reach it: the staff editor sends Number(chargeModel.taxRate || 0)
 * (frontend .../reservations/[id]/page.js:2450), so clearing the field arrives
 * as a primitive 0 — which this change makes AUTHORITATIVE, i.e. tax suppressed
 * on that reservation. The guard is real but its stated threat model is not,
 * and the actual vector is on the frontend and out of scope here. Flagged, not
 * fixed.
 *
 * WHY THIS SUITE NEEDS NO DATABASE AT ALL. applyMonthlyPricing ends by
 * propagating to the rental agreement through the MODULE-LEVEL prisma client,
 * and that step now runs only when no client was injected — a caller that hands
 * over its own client (a transaction) owns the follow-up, because getPricing
 * would otherwise read outside that transaction. Passing a stub therefore skips
 * it, which is the same condition that keeps this suite silent and fast.
 */
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://u:p@127.0.0.1:5432/none';

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Prisma } from '@prisma/client';

import { resolveTaxRate } from './tax-rate.js';

const { applyMonthlyPricing } = await import('../modules/long-term/long-term.service.js');
const { syncImportedFeeCharges } = await import('../modules/integrations/mex/mex.worker.js');

/**
 * Assertion helper only — deliberately NOT the production `isTaxRow` from
 * lib/charge-identity.js. This one does not exclude the QUOTE_TAXES_FEES
 * remainder, so a test can still catch that row being wrongly converted INTO a
 * tax row. Asserting with the predicate under test would hide exactly that.
 */
const looksLikeTaxRow = (r) => String(r?.chargeType || '').toUpperCase() === 'TAX'
  || String(r?.source || '').toUpperCase() === 'TAX'
  || String(r?.code || '').toUpperCase() === 'TAX';

/** The row reservation-pricing.service.js:1085 materializes. $214.90 of it. */
const BOOKED_PRICE_REMAINDER = {
  source: 'QUOTE_TAXES_FEES',
  name: 'Taxes & fees (booked price)',
  chargeType: 'TAX',
  quantity: 1,
  rate: 214.9,
  total: 214.9,
  taxable: false,
};

// ---------------------------------------------------------------------------
// SITE 1 — long-term.service.js, applyMonthlyPricing.
//
// applyMonthlyPricing takes its client as a parameter for the same reason
// recomputeTaxRow does (reservation-extend.service.js:297): the zero case is
// not observable through a database. That seam is what lets the real function,
// the real branch and the real writes be watched below.
// ---------------------------------------------------------------------------

/** In-memory stand-in for the charge table + the one reservation read. */
function longTermDb({ snapshot = undefined, locationRate = 11.5, seed = [] } = {}) {
  let n = seed.length;
  const rows = seed.map((r, i) => ({ id: `c${i}`, selected: true, ...r }));
  const updates = [];
  return {
    rows,
    updates,
    reservation: {
      findUnique: async () => ({
        id: 'r1',
        pricingSnapshot: snapshot === undefined ? null : { taxRate: snapshot },
        pickupLocation: locationRate === null ? null : { taxRate: locationRate },
      }),
      update: async ({ data }) => { updates.push(data); return data; },
    },
    reservationCharge: {
      findMany: async () => rows.filter((r) => r.selected).map((r) => ({ ...r })),
      create: async ({ data }) => { const row = { id: `c${++n}`, ...data }; rows.push(row); return row; },
      update: async ({ where, data }) => {
        const hit = rows.find((r) => r.id === where.id);
        Object.assign(hit, data);
        return hit;
      },
      delete: async ({ where }) => {
        const i = rows.findIndex((r) => r.id === where.id);
        if (i >= 0) rows.splice(i, 1);
      },
      // Two real call shapes. Without a `where.id.in` it is the rental-base
      // sweep and mirrors the OR the real call uses: the base line under any of
      // its historical identities, plus a prior monthly line. With one, it is
      // the duplicate-tax-row removal.
      deleteMany: async ({ where } = {}) => {
        const ids = where?.id?.in;
        for (let i = rows.length - 1; i >= 0; i -= 1) {
          const r = rows[i];
          const hit = ids
            ? ids.includes(r.id)
            : (r.source === 'BASE_RATE' || r.source === 'MONTHLY_CYCLE' || r.code === 'DAILY' || r.name === 'Daily');
          if (hit) rows.splice(i, 1);
        }
      },
    },
  };
}

describe('applyMonthlyPricing (long-term monthly plan)', () => {
  it('a snapshot taxRate of PRIMITIVE 0 writes no tax row, even though the location has one', async () => {
    // THE ASSERTION THE WHOLE FIX RESTS ON. Before it, this wrote a $109.25 TAX
    // row at the location's 11.5% onto a rental priced tax-exempt.
    const db = longTermDb({ snapshot: 0, locationRate: 11.5 });
    await applyMonthlyPricing('r1', 950, {}, db);

    assert.equal(db.rows.some(looksLikeTaxRow), false, 'a deliberate 0% must produce NO tax row');
    assert.deepEqual(db.rows.map((r) => r.code), ['MONTHLY'], 'only the locked monthly line');
    assert.equal(db.updates.at(-1).estimatedTotal, 950, 'the total carries no invented tax');
  });

  it('a snapshot taxRate of Decimal(0) — what Prisma actually returns — also writes no tax row', async () => {
    // Belt and braces on the trap itself. Decimal(0) is TRUTHY, so this case
    // cannot tell `||` from `!= null` on the raw value; it is here to prove the
    // fix does not regress the shape the database really hands over.
    const db = longTermDb({ snapshot: new Prisma.Decimal(0), locationRate: 11.5 });
    await applyMonthlyPricing('r1', 950, {}, db);

    assert.equal(db.rows.some(looksLikeTaxRow), false);
    assert.equal(db.updates.at(-1).estimatedTotal, 950);
  });

  it('a deliberate 0 REMOVES a tax row a previous rate had already written', async () => {
    // Repricing is the moment the mistake would otherwise be locked in: the
    // stale TAX row has to GO, not merely stop being recreated.
    const db = longTermDb({
      snapshot: 0,
      locationRate: 11.5,
      seed: [{ code: 'TAX', name: 'Sales Tax (11.50%)', chargeType: 'TAX', source: 'TAX', total: 109.25, taxable: false }],
    });
    await applyMonthlyPricing('r1', 950, {}, db);

    assert.equal(db.rows.some(looksLikeTaxRow), false, 'the stale tax row must be deleted');
  });

  it('a NULL snapshot rate still falls back to the pickup location', async () => {
    // The fallback is load-bearing: every ordinary staff/OTA reservation
    // depends on it. 11.5% of the $950 monthly line.
    const db = longTermDb({ snapshot: null, locationRate: 11.5 });
    await applyMonthlyPricing('r1', 950, {}, db);

    const tax = db.rows.find(looksLikeTaxRow);
    assert.equal(Number(tax.total), 109.25);
    assert.match(tax.name, /11\.50%/);
    assert.equal(db.updates.at(-1).estimatedTotal, 1059.25);
  });

  it('no snapshot row at all falls back to the pickup location', async () => {
    const db = longTermDb({ snapshot: undefined, locationRate: 8 });
    await applyMonthlyPricing('r1', 100, {}, db);

    assert.equal(Number(db.rows.find(looksLikeTaxRow).total), 8);
  });

  it('a nonzero snapshot rate beats the location', async () => {
    // The location's rate was edited after the quote; the customer still owes
    // the rate they actually agreed to.
    const db = longTermDb({ snapshot: 8.25, locationRate: 11.5 });
    await applyMonthlyPricing('r1', 1000, {}, db);

    assert.equal(Number(db.rows.find(looksLikeTaxRow).total), 82.5, 'the quoted 8.25%, not the location 11.5%');
  });

  it('a TAX_RECALC row from the extension path is REPLACED, not duplicated', async () => {
    // recomputeTaxRow (reservation-extend.service.js:323) writes source
    // TAX_RECALC with NO code, so the old source/code-only match missed it:
    // extend a rental, then attach a monthly plan, and a SECOND tax row was
    // created. taxableBase excludes it but estimatedTotal counts it — the
    // customer was billed sales tax twice. chargeType is part of the identity.
    const db = longTermDb({
      snapshot: null,
      locationRate: 11.5,
      seed: [{ source: 'TAX_RECALC', name: 'Sales Tax (11.50%)', chargeType: 'TAX', total: 40, taxable: false }],
    });
    await applyMonthlyPricing('r1', 950, {}, db);

    assert.equal(db.rows.filter(looksLikeTaxRow).length, 1, 'one tax row, not two');
    assert.equal(Number(db.rows.find(looksLikeTaxRow).total), 109.25, 'and it carries the recomputed amount');
    assert.equal(db.updates.at(-1).estimatedTotal, 1059.25, 'no double tax in the total');
  });

  it('a reservation that ALREADY carries two tax rows comes out with one', async () => {
    // Not just "stop creating duplicates" — undo them. That double-bill is live
    // in production today, and `.find()` on an unordered findMany would have
    // repriced a nondeterministic one and left the other counted in
    // estimatedTotal. Same precedent as the MEX stale-row sweep.
    const db = longTermDb({
      snapshot: null,
      locationRate: 11.5,
      seed: [
        { id: 'c0', source: 'TAX', code: 'TAX', name: 'Sales Tax (11.50%)', chargeType: 'TAX', total: 40, taxable: false, sortOrder: 1 },
        { id: 'c1', source: 'TAX_RECALC', name: 'Sales Tax (11.50%)', chargeType: 'TAX', total: 55, taxable: false, sortOrder: 2 },
      ],
    });
    await applyMonthlyPricing('r1', 950, {}, db);

    assert.equal(db.rows.filter(looksLikeTaxRow).length, 1, 'the duplicate must be removed, not just left alone');
    assert.equal(db.updates.at(-1).estimatedTotal, 1059.25, 'and the total counts tax exactly once');
  });

  it('the booked-price remainder SURVIVES a zero-rate reprice — it is fees, not tax', async () => {
    // The site-1 mirror of the MEX case, and the wider of the two: this needs
    // no snapshot and no car-sharing. Location.taxRate is non-null @default(0)
    // (schema.prisma:660), so any tenant that never configured a rate resolves
    // to 0 and would have had this row DELETED on the next attachPlan —
    // $214.90 of real fee money, gone.
    const db = longTermDb({ snapshot: undefined, locationRate: 0, seed: [{ ...BOOKED_PRICE_REMAINDER }] });
    await applyMonthlyPricing('r1', 950, {}, db);

    const kept = db.rows.find((r) => r.source === 'QUOTE_TAXES_FEES');
    assert.ok(kept, 'the booked-price remainder must not be deleted as a stale tax row');
    assert.equal(Number(kept.total), 214.9, 'and it must keep its money');
    assert.equal(db.updates.at(-1).estimatedTotal, 1164.9, '950 monthly + 214.90 booked fees');
  });

  it('a MANDATORY FEE an admin coded "TAX" is not mistaken for the tax row', async () => {
    // ReservationCharge.code is copied verbatim from Fee.code
    // (reservation-pricing.service.js:658), which is admin FREE TEXT
    // (schema.prisma:3055 — `String?`, no enum). A company billing a municipal
    // or tourism tax as a mandatory fee and coding it "TAX" is ordinary. When
    // the ownership predicate consulted `code`, the deterministic (sortOrder,
    // id) sort put that fee AHEAD of the real tax row every time — because the
    // tax row is always written at maxSort + 1 — so the fee was repriced into
    // "Sales Tax" while the genuine tax row was deleted as the duplicate. The
    // $45 simply vanished, and the survivor kept source MANDATORY_FEE and its
    // sourceRefId, so the next pricing read flipped it back and the total
    // oscillated between reads.
    const db = longTermDb({
      snapshot: null,
      locationRate: 11.5,
      seed: [
        { id: 'fee1', code: 'TAX', name: 'Municipal Tourism Tax', chargeType: 'UNIT', source: 'MANDATORY_FEE', sourceRefId: 'feeid-123', quantity: 1, rate: 45, total: 45, taxable: false, sortOrder: 3 },
        { id: 'tax1', code: 'TAX', name: 'Sales Tax (11.50%)', chargeType: 'TAX', source: 'TAX', quantity: 1, rate: 20, total: 20, taxable: false, sortOrder: 4 },
      ],
    });
    await applyMonthlyPricing('r1', 950, {}, db);

    const fee = db.rows.find((r) => r.id === 'fee1');
    assert.ok(fee, 'the mandatory fee must not be deleted as a duplicate tax row');
    assert.equal(Number(fee.total), 45, 'and it must keep its money');
    assert.equal(fee.name, 'Municipal Tourism Tax', 'and its name');
    assert.equal(fee.source, 'MANDATORY_FEE', 'and its ownership');

    // The genuine tax row is the one repriced, and it is still the only one.
    const tax = db.rows.filter((r) => String(r.chargeType).toUpperCase() === 'TAX');
    assert.equal(tax.length, 1, 'exactly one real tax row');
    assert.equal(Number(tax[0].total), 109.25, '11.5% of the $950 monthly line');
    assert.equal(db.updates.at(-1).estimatedTotal, 1104.25, '950 monthly + 45 fee + 109.25 tax');
  });

  it('the booked-price remainder is NOT overwritten when a rate does apply', async () => {
    // The other half, and the subtler one: at rate > 0 the row was updated IN
    // PLACE into the recomputed tax, dropping the fee component and leaving a
    // row whose source says QUOTE_TAXES_FEES while its name says "Sales Tax".
    const db = longTermDb({ snapshot: null, locationRate: 11.5, seed: [{ ...BOOKED_PRICE_REMAINDER }] });
    await applyMonthlyPricing('r1', 950, {}, db);

    const kept = db.rows.find((r) => r.source === 'QUOTE_TAXES_FEES');
    assert.equal(Number(kept.total), 214.9, 'its money is untouched');
    assert.match(kept.name, /booked price/, 'and so is its identity');
    // The real tax row is created alongside it, not stamped over it.
    const tax = db.rows.find((r) => String(r.source).toUpperCase() === 'TAX');
    assert.equal(Number(tax.total), 109.25, '11.5% of the $950 monthly line');
  });
});

// ---------------------------------------------------------------------------
// SITE 2 — mex.worker.js, syncImportedFeeCharges.
//
// REACHABILITY, because it is narrower than site 1 and worth stating. A fresh
// AUTO promotion writes NO snapshot (promote.js promoteWithMappings creates the
// reservation without one), so on that path this resolves to the location
// exactly as before — no behaviour change. What makes it reachable is the
// DUPLICATE-LINK path: findDuplicateReservation matches on tenant + customer
// name + pickup DAY with no channel or workflowMode filter, so a MEX row can
// link to a reservation another flow already created — car-sharing included —
// and mex.worker.js:747 then hands that reservation straight to this sync.
// ---------------------------------------------------------------------------

const DETAIL = {
  confirmation: 'WMX000F971',
  charges: { rateTotal: 336, taxTotal: 75.31, extraTotal: 318.9, estimatedTotal: 730.21 },
  optionalServices: [
    { amount: 5.93, description: 'CUSTOMER FACILITY CHARGE' },
    { amount: 2.5, description: 'VEHICLE LICENSE FEE SJU' },
    { amount: 2.2, description: 'SURCHARGE' },
  ],
};

/** Same shape as mex-quote-sync.test.mjs's fakeDb, plus the snapshot. */
function mexDb({ snapshot = undefined, locationRate = 11.5, seed = [] } = {}) {
  let id = seed.length;
  const rows = seed.map((r, i) => ({ id: `s${i}`, ...r }));
  return {
    rows,
    reservation: {
      findUnique: async () => ({
        dailyRate: null,
        pricingSnapshot: snapshot === undefined ? null : { taxRate: snapshot },
        pickupLocation: locationRate === null ? null : { taxRate: locationRate },
      }),
      update: async ({ data }) => data,
    },
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
          const i = rows.findIndex((r) => r.id === rid);
          if (i >= 0) rows.splice(i, 1);
        }
      },
    },
  };
}

describe('syncImportedFeeCharges (MEX sync)', () => {
  it('a snapshot taxRate of PRIMITIVE 0 writes no tax row, even though the location has one', async () => {
    const db = mexDb({ snapshot: 0, locationRate: 11.5 });
    await syncImportedFeeCharges(db, 'r1', DETAIL, { days: 30 });

    assert.equal(db.rows.some(looksLikeTaxRow), false, 'a deliberate 0% must produce NO tax row');
    // The rest of the import is unaffected — a tax-exempt reservation still
    // gets its rental line and its three MEX fees.
    assert.equal(db.rows.length, 4, 'rental + 3 fees, no tax');
    assert.equal(db.rows.filter((r) => r.source === 'MEX_IMPORT').length, 3);
  });

  it('a snapshot taxRate of Decimal(0) also writes no tax row', async () => {
    const db = mexDb({ snapshot: new Prisma.Decimal(0), locationRate: 11.5 });
    await syncImportedFeeCharges(db, 'r1', DETAIL, { days: 30 });

    assert.equal(db.rows.some(looksLikeTaxRow), false);
  });

  it('a NULL snapshot rate still falls back to the pickup location', async () => {
    // The unchanged path: this is what a freshly promoted MEX booking does, and
    // it must keep reproducing the portal's own Estimated Total to the cent.
    const db = mexDb({ snapshot: null, locationRate: 11.5 });
    await syncImportedFeeCharges(db, 'r1', DETAIL, { days: 30 });

    assert.equal(Number(db.rows.find(looksLikeTaxRow).total), 75.31);
    const sum = db.rows.reduce((s, r) => s + Number(r.total), 0);
    assert.equal(Math.round(sum * 100) / 100, 730.21, 'still equals the portal Estimated Total');
  });

  it('a nonzero snapshot rate beats the location', async () => {
    const db = mexDb({ snapshot: 8.25, locationRate: 11.5 });
    await syncImportedFeeCharges(db, 'r1', DETAIL, { days: 30 });

    assert.match(db.rows.find(looksLikeTaxRow).name, /8\.25%/);
  });

  it('a deliberate 0 REMOVES a tax row an earlier sync had already written', async () => {
    // The site-1 mirror (see 'a deliberate 0 REMOVES...' above). Stopping the
    // overcharge is only half the job: a reservation already over-taxed by the
    // old rule re-syncs after this ships and must come out clean, not keep a
    // stale $75.31 row forever. The engine tax row is source/code TAX — an
    // identity this sync already claims in order to UPDATE it in place, so it
    // has to be removable too.
    const db = mexDb({
      snapshot: 0,
      locationRate: 11.5,
      seed: [{ code: 'TAX', name: 'Sales Tax (11.50%)', chargeType: 'TAX', source: 'TAX', quantity: 1, rate: 75.31, total: 75.31, taxable: false }],
    });
    await syncImportedFeeCharges(db, 'r1', DETAIL, { days: 30 });

    assert.equal(db.rows.some(looksLikeTaxRow), false, 'the stale tax row must be deleted');
    assert.equal(db.rows.length, 4, 'rental + 3 fees remain');
  });

  it('the booked-price remainder row SURVIVES a zero-rate sync — it is fees, not tax', async () => {
    // QUOTE_TAXES_FEES is chargeType TAX but carries the remainder of the
    // booked price after the daily base — taxes AND fees fused into one line
    // (reservation-pricing.service.js:1085), holding the invariant
    // `sum(seeded) + feeRowsTotal === est`. quoteRowKey buckets it as 'TAX' on
    // chargeType alone, so the removal sweep above would delete real FEE money
    // at a resolved rate of 0 — the undercharge direction. Reachable: a
    // promoted/linked MEX reservation starts with no charge rows, so the
    // materialization branch fires as soon as staff add a pre-checkout add-on.
    const db = mexDb({
      snapshot: 0,
      locationRate: 11.5,
      seed: [{ source: 'QUOTE_TAXES_FEES', name: 'Taxes & fees (booked price)', chargeType: 'TAX', quantity: 1, rate: 214.9, total: 214.9, taxable: false }],
    });
    await syncImportedFeeCharges(db, 'r1', DETAIL, { days: 30 });

    const kept = db.rows.find((r) => r.source === 'QUOTE_TAXES_FEES');
    assert.ok(kept, 'the booked-price remainder must NOT be swept as a tax row');
    assert.equal(Number(kept.total), 214.9, 'and it must keep its money');
  });
});

// ---------------------------------------------------------------------------
// The shared rule, isolated. These duplicate extend-tax-rate.test.mjs on
// purpose: that suite is on another branch and may land after this one, and a
// money guard does not get to depend on merge order.
// ---------------------------------------------------------------------------

describe('resolveTaxRate', () => {
  it('a primitive 0 snapshot rate wins over a nonzero location rate', () => {
    assert.equal(resolveTaxRate({ snapshotRate: 0, locationRate: 11.5 }), 0);
  });

  it('null, undefined and a cleared field all defer to the location', () => {
    assert.equal(resolveTaxRate({ snapshotRate: null, locationRate: 11.5 }), 11.5);
    assert.equal(resolveTaxRate({ snapshotRate: undefined, locationRate: 11.5 }), 11.5);
    assert.equal(resolveTaxRate({ snapshotRate: '', locationRate: 11.5 }), 11.5);
  });

  it('a Decimal(0) snapshot rate is a rate', () => {
    assert.equal(resolveTaxRate({ snapshotRate: new Prisma.Decimal(0), locationRate: 11.5 }), 0);
  });
});

// ---------------------------------------------------------------------------
// Source-level guards. Everything above runs through resolveTaxRate, so it
// would all stay green if someone reinstated a location-only read at the CALL
// SITE. These are the two lines that made the bug.
// ---------------------------------------------------------------------------

/**
 * Comments stripped, because the fixes QUOTE the lines they replaced — a guard
 * that scanned the raw file would fail on the very change it protects.
 *
 * The line strip is ANCHORED to the start of a line on purpose. An unanchored
 * `//` also eats the tail of any line holding a `'https://...'` literal, which
 * would silently shrink what these guards can see. Real code never sits to the
 * right of a `//` that begins its own line, so anchoring loses nothing.
 */
function codeOf(relPath) {
  return readFileSync(new URL(relPath, import.meta.url), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/[^\n]*/gm, '');
}

const WRITERS = [
  ['long-term.service.js', '../modules/long-term/long-term.service.js'],
  ['mex.worker.js', '../modules/integrations/mex/mex.worker.js'],
];

describe('the tax-row writers resolve through the shared rule', () => {
  for (const [label, relPath] of WRITERS) {
    it(`${label} calls resolveTaxRate and does not read the location alone`, () => {
      const code = codeOf(relPath);

      assert.match(code, /resolveTaxRate\s*\(/, `${label} must resolve the rate through the shared rule`);
      assert.ok(
        !/const\s+taxRate\s*=\s*Number\s*\(\s*reservation[?.]*\.?pickupLocation/.test(code),
        `${label} is deriving taxRate from the pickup location alone again — a stored snapshot 0 will be overridden`,
      );
    });
  }

  it('the staff create route does not invent a tax rate of 0', () => {
    // THE PRECONDITION THIS WHOLE CHANGE RESTS ON, and it belongs with the
    // readers rather than the writer because that is where it becomes visible.
    // pickupLoc is a tenant-scoped findFirst, so it is null when the id does not
    // resolve inside the caller's tenant; `?? 0` then stored "I could not find
    // the location" in a column whose 0 every reader now honours as a deliberate
    // tax-exempt rate. Honouring stored zeros is only safe once no writer
    // invents one — without this line the fix above turns an overcharge into a
    // silent UNDERCHARGE on the highest-volume writer in the app.
    const src = codeOf('../modules/reservations/reservations.routes.js');

    assert.ok(
      !/taxRate:\s*pickupLoc\?\.taxRate\s*\?\?\s*0\b/.test(src),
      'reservations.routes.js is writing `taxRate: pickupLoc?.taxRate ?? 0` again — '
        + 'that 0 means "location not found", and readers will treat it as tax-exempt',
    );
    assert.equal(
      (src.match(/taxRate:\s*pickupLoc\?\.taxRate\s*\?\?\s*null/g) || []).length,
      2,
      'both the create and update branches of the snapshot upsert must write null',
    );
  });

  it('the shared rule is defined in exactly one place', () => {
    // Two live copies of a money rule drift. lib/tax-rate.js owns it.
    for (const [label, relPath] of WRITERS) {
      assert.ok(
        !/export\s+function\s+resolveTaxRate\b/.test(codeOf(relPath)),
        `${label} now defines its own resolveTaxRate — import the shared one instead`,
      );
    }
  });
});
