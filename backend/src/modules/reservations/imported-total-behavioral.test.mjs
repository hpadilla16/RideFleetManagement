import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { prisma } from '../../lib/prisma.js';
import { reservationPricingService } from './reservation-pricing.service.js';
import { tollsService } from '../tolls/tolls.service.js';

/**
 * The guard, exercised through the REAL getPricing — no mirror.
 *
 * The first version of these tests re-implemented the guard in a local
 * `decide()` helper. Deleting the guard from the service left every one of them
 * green, so they proved only that I could restate my own rule. That is the
 * third time this week a test in this repo validated a copy instead of the
 * thing, and it is how the defect in case B below shipped past review.
 *
 * DB-free: prisma delegates are stubbed in-memory (the kiosk-offers pattern),
 * so this belongs in a CI-run suite rather than the DB-backed one.
 */

let db;
function condMatch(rowVal, cond) {
  for (const [op, val] of Object.entries(cond)) {
    if (op === 'mode') continue;
    if (op === 'not') { if (val === null ? rowVal == null : rowVal === val) return false; }
    else if (op === 'in') { if (!val.includes(rowVal)) return false; }
    else if (op === 'equals') { if (rowVal !== val) return false; }
    else return false;
  }
  return true;
}
function matches(row, where) {
  return Object.entries(where || {}).every(([key, val]) => {
    if (val === undefined) return true;
    if (key === 'OR') return val.some((c) => matches(row, c));
    if (key === 'AND') return val.every((c) => matches(row, c));
    if (key === 'NOT') return !matches(row, val);
    if (val === null) return row[key] == null;
    if (val instanceof Date || typeof val !== 'object') return row[key] === val;
    return condMatch(row[key], val);
  });
}
function applyData(row, data) { for (const [k, v] of Object.entries(data || {})) row[k] = v; return row; }
function delegateStub(rows) {
  let seq = 0;
  return {
    findFirst: async ({ where } = {}) => rows().find((r) => matches(r, where)) || null,
    findUnique: async ({ where } = {}) => rows().find((r) => matches(r, where)) || null,
    findMany: async ({ where, take } = {}) => {
      const out = rows().filter((r) => matches(r, where));
      return typeof take === 'number' ? out.slice(0, take) : out;
    },
    create: async ({ data } = {}) => { const row = { id: `row_${++seq}`, ...data }; rows().push(row); return row; },
    createMany: async ({ data } = {}) => { (Array.isArray(data)?data:[data]).forEach((e)=>rows().push({id:`row_${++seq}`,selected:true,...e})); return {count:1}; },
    update: async ({ where, data } = {}) => { const row = rows().find((r) => matches(r, where)); if (!row) throw new Error('stub update: no match'); return applyData(row, data); },
    updateMany: async ({ where, data } = {}) => { rows().filter((r)=>matches(r,where)).forEach((r)=>applyData(r,data)); return {count:1}; },
    deleteMany: async ({ where } = {}) => { const keep = rows().filter((r) => !matches(r, where)); const n = rows().length - keep.length; rows().splice(0, rows().length, ...keep); return { count: n }; },
    groupBy: async () => [],
  };
}
beforeEach(() => {
  db = { reservations: [], reservationCharges: [], locations: [], agreements: [] };
  db.locations.push({ id: 'loc1', tenantId: 't1', taxRate: 11.5 });
  Object.assign(prisma.location, delegateStub(() => db.locations));
  Object.assign(prisma.reservation, delegateStub(() => db.reservations));
  Object.assign(prisma.reservationCharge, delegateStub(() => db.reservationCharges));
  Object.assign(prisma.rentalAgreement, delegateStub(() => db.agreements));
  prisma.$transaction = async (fn) => (typeof fn === 'function' ? fn(prisma) : Promise.all(fn));
  tollsService.syncReservationCharges = async () => 0;
});
const HOUR = 3600e3, DAY = 24 * HOUR;
function seedReservation(overrides = {}) {
  const base = Date.now() + 2 * HOUR;
  const r = {
    id: 'res1', tenantId: 't1', bookingChannel: 'FRANCHISE_NU', pickupLocationId: 'loc1',
    pickupAt: new Date(base), returnAt: new Date(base + 3 * DAY),
    dailyRate: null, estimatedTotal: 412.5,
    pickupLocation: { locationFees: [] }, pricingSnapshot: null, payments: [], rentalAgreement: null,
    get charges() { return db.reservationCharges.filter((c) => c.reservationId === this.id); },
    ...overrides,
  };
  db.reservations.push(r);
  return r;
}

test('A: broker reservation, no rows, no location fees → total survives the READ', async () => {
  const r = seedReservation();
  await reservationPricingService.getPricing('res1', { tenantId: 't1' });
  assert.equal(r.estimatedTotal, 412.5);
});

test('B: a mandatory location fee does NOT let the sync overwrite the imported total', async () => {
  const fee = { id: 'fee1', code: 'ENV', name: 'Environmental fee', mode: 'FIXED', amount: 4.5, isActive: true, mandatory: true, displayOnline: false, taxable: false };
  const r = seedReservation({ pickupLocation: { locationFees: [{ fee }] } });
  await reservationPricingService.getPricing('res1', { tenantId: 't1' });
  // THE CASE THAT CAUGHT THE FIRST FIX. The guard used to read AFTER this
  // loop, so the fee row it had just created satisfied its own precondition:
  // the write landed with only the fee in the set and $412.50 became $4.50 —
  // non-zero, so it did not even look wrong. Reading before the loop is the
  // whole difference.
  assert.ok(
    db.reservationCharges.some((c) => String(c.source || '').toUpperCase() === 'MANDATORY_FEE'),
    'the mandatory fee row must actually exist, or this case proves nothing'
  );
  assert.equal(Number(r.estimatedTotal), 412.5, 'the imported total must survive a location that charges a mandatory fee');
});

test('C: rows exist but all voided → still goes to zero', async () => {
  const r = seedReservation({ estimatedTotal: 300 });
  db.reservationCharges.push({ id: 'c1', reservationId: 'res1', name: 'Daily', total: 300, taxable: true, selected: false, sortOrder: 0, source: null });
  await reservationPricingService.getPricing('res1', { tenantId: 't1' });
  assert.equal(Number(r.estimatedTotal), 0);
});

test('D: normally priced reservation still recomputes', async () => {
  const r = seedReservation({ estimatedTotal: 1 });
  db.reservationCharges.push({ id: 'c1', reservationId: 'res1', name: 'Daily', total: 150, taxable: false, selected: true, sortOrder: 0, source: null });
  await reservationPricingService.getPricing('res1', { tenantId: 't1' });
  assert.equal(Number(r.estimatedTotal), 150);
});

test('B2: the total survives REPEATED reads — one call is not the test', async () => {
  // THE CASE THAT CAUGHT THE SECOND FIX. Hoisting the read above the fee loop
  // made call #1 safe and left call #2 broken: the guard saw the MANDATORY_FEE
  // that call #1 had created, decided the reservation "has charge rows", and
  // wrote the fee amount over the imported total. Measured against real
  // Postgres: 412.50 → 4.50 on the second read.
  //
  // A single getPricing call cannot distinguish "the guard works" from "the
  // guard is one read behind", which is why both shipped past a green suite.
  const r = seedReservation();
  r.pickupLocation.locationFees = [{ fee: {
    id: 'fee1', code: 'ENV', name: 'Environmental fee', mode: 'FIXED', amount: 4.5,
    isActive: true, mandatory: true, displayOnline: false, taxable: false,
  } }];
  for (let i = 1; i <= 3; i++) {
    await reservationPricingService.getPricing('res1', { tenantId: 't1' });
    // ASSERT THE PRECONDITION. Without this the test passes vacuously when the
    // fake never creates the fee row — which is exactly how a test can "cover"
    // a defect it cannot see.
    assert.ok(
      db.reservationCharges.some((c) => String(c.source || '').toUpperCase() === 'MANDATORY_FEE'),
      `read #${i}: the mandatory fee row must actually exist, or this test proves nothing`
    );
    assert.equal(Number(r.estimatedTotal), 412.5, `imported total must survive read #${i}`);
  }
});

test('B3: a reservation with REAL pricing still recomputes on repeated reads', async () => {
  // The mirror: the guard must not become "never write". A base-rate row is
  // somebody's pricing, so the total tracks it on every read.
  const r = seedReservation();
  db.reservationCharges.push({
    id: 'base', reservationId: 'res1', source: 'BASE_RATE', name: 'Daily',
    chargeType: 'UNIT', quantity: 3, rate: 50, total: 150, taxable: true, selected: true,
  });
  await reservationPricingService.getPricing('res1', { tenantId: 't1' });
  await reservationPricingService.getPricing('res1', { tenantId: 't1' });
  assert.equal(Number(r.estimatedTotal), 150);
});

test('B4: the UNDERAGE fee group cannot overwrite the imported total either', async () => {
  // THE CASE THAT CAUGHT THE THIRD FIX. syncMandatoryLocationFees writes TWO
  // groups on this base — MANDATORY_FEE and, since the 2026-07-28 age rules,
  // UNDERAGE_FEE. A hand-written list of "sources we own" had only the first,
  // so an imported 412.50 became 9.99 on the second read: same defect, one door
  // over, with an 11/11 green suite over it because no case exercised age rules.
  //
  // The set is now DERIVED from feeGroups, so a third group cannot reintroduce
  // this. That is what this case guards — not the string 'UNDERAGE_FEE'.
  const base = Date.now() + 2 * HOUR;
  const r = seedReservation({
    // 22 years old: inside the 21-24 underage band, over the hard block.
    customer: { dateOfBirth: new Date(base - 22 * 365.25 * DAY) },
  });
  r.pickupLocation.locationConfig = JSON.stringify({
    // The keys evaluateAgeRules actually reads — chargeAgeMin/chargeAgeMax/
    // underageFeeMaxAge. The first version used invented names and passed only
    // because the defaults happened to put age 22 in the band.
    ageRulesEnforced: true, chargeAgeMin: 21, underageFeeMaxAge: 24,
  });
  r.pickupLocation.locationFees = [{
    fee: {
      id: 'ufee1', code: 'UNDER', name: 'Underage fee', mode: 'PER_DAY', amount: 9.99,
      isActive: true, mandatory: false, isUnderageFee: true, displayOnline: false, taxable: false,
    },
  }];

  for (let i = 1; i <= 3; i++) {
    await reservationPricingService.getPricing('res1', { tenantId: 't1' });
    assert.ok(
      db.reservationCharges.some((c) => String(c.source || '').toUpperCase() === 'UNDERAGE_FEE'),
      `read #${i}: the underage fee row must actually exist, or this case proves nothing`
    );
    assert.equal(Number(r.estimatedTotal), 412.5, `imported total must survive read #${i}`);
  }
});
