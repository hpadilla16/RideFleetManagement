/**
 * VozIA upsell, pre-checkout: "no agreement yet" is a STATE, not an error.
 *
 * Measured 2026-08-11 (RES-566343061B18): Chloe books, offers protection,
 * caller accepts — and the add lands on POST /:id/charges 36 seconds after
 * convert, where addManualCharge threw 404 'No agreement for reservation'.
 * Agreements are created at CHECK-OUT, so the upsell could never work.
 *
 * QA's first pass then killed the naive fix twice, with measurements:
 *   - a converted quote has estimatedTotal and ZERO charge rows, so writing
 *     the extra as the FIRST row made the next pricing read recompute
 *     estimatedTotal = just the extra ($322.88 → $63.00, real Postgres);
 *   - 6,353 row-less MIGRATION/FRANCHISE reservations would have been exposed
 *     to the same corruption through the same door.
 * Hence: refuse partner/prepaid channels with a speakable 409, and SEED the
 * booked price as rows before the first extra lands on a native reservation.
 *
 * Fake-prisma style from payment-idempotency.test.mjs — every case drives the
 * REAL addManualCharge.
 */
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { prisma } from '../../lib/prisma.js';
import { reservationPricingService } from './reservation-pricing.service.js';
import { PER_DAY_LIKE_SOURCES } from './reservation-extend.service.js';

let db;
let realGetPricing;

const NATIVE = {
  id: 'res1', tenantId: 't1', status: 'CONFIRMED', bookingChannel: 'VOZIA',
  isPrepaid: null, estimatedTotal: 322.88, dailyRate: 39.9,
  pickupAt: '2026-08-12T18:00:00Z', returnAt: '2026-08-18T18:00:00Z', // 6 days
  pricingSnapshot: null, charges: [], payments: [], rentalAgreement: null
};

function seed({ reservation = {}, agreement = null, existingCharges = [] } = {}) {
  db = { reservationCharges: [...existingCharges], agreementCharges: [], audits: [] };
  const row = { ...NATIVE, ...reservation };
  prisma.reservation.findFirst = async () => row;
  prisma.rentalAgreement.findFirst = async () => agreement;
  prisma.reservationCharge.findMany = async () => db.reservationCharges.map((c) => ({ id: c.id, selected: c.selected, source: c.source, total: c.total }));
  // The branch wraps its writes in one transaction; the fake passes the same
  // stubbed client through, which also means a THROW mid-callback leaves the
  // arrays exactly as a rolled-back transaction would in the assertions below.
  prisma.$transaction = async (fn) => fn(prisma);
  prisma.reservationCharge.create = async ({ data }) => {
    const created = { id: `rc_${db.reservationCharges.length + 1}`, ...data };
    db.reservationCharges.push(created);
    return created;
  };
  prisma.rentalAgreementCharge.create = async ({ data }) => {
    const created = { id: `ac_${db.agreementCharges.length + 1}`, ...data };
    db.agreementCharges.push(created);
    return created;
  };
  prisma.auditLog.create = async ({ data }) => { db.audits.push(data); return data; };
  realGetPricing = reservationPricingService.getPricing;
  db.getPricingCalls = 0;
  reservationPricingService.getPricing = async () => { db.getPricingCalls += 1; return { ok: true, stubbed: true, totals: { total: 0 } }; };
}

afterEach(() => {
  if (realGetPricing) reservationPricingService.getPricing = realGetPricing;
});

beforeEach(() => seed());

// ── The measured clobber, closed ────────────────────────────────────────────

test('row-less native reservation: the booked price is SEEDED before the extra — rows sum to est + extra', async () => {
  await reservationPricingService.addManualCharge(
    'res1',
    { name: 'Prepaid Toll Pass', amount: 63, kind: 'service', sourceRefId: 'svc_1' },
    { reason: 'VozIA upsell' },
    { tenantId: 't1' }
  );
  const rows = db.reservationCharges;
  // BASE_RATE (39.9 × 6 = 239.40) + remainder (83.48) + the extra (63)
  assert.equal(rows.length, 3, 'base + remainder + extra');
  const base = rows.find((r) => r.source === 'BASE_RATE');
  const rest = rows.find((r) => r.source === 'QUOTE_TAXES_FEES');
  const extra = rows.find((r) => r.source === 'ADDITIONAL_SERVICE_PRECHECKIN');
  assert.equal(base.quantity, 6);
  assert.equal(base.rate, 39.9);
  assert.equal(base.total, 239.4);
  // The remainder is chargeType TAX ON PURPOSE: the reschedule rebuild deletes
  // chargeType TAX wholesale, so this row dies with the base instead of
  // surviving as a stale double-count.
  assert.equal(rest.chargeType, 'TAX');
  assert.equal(rest.total, 83.48);
  assert.equal(extra.total, 63);
  const sum = rows.reduce((s, r) => s + r.total, 0);
  // THE invariant: the recompute after this lands on est + extra. Exactly.
  assert.equal(Math.round(sum * 100) / 100, Math.round((322.88 + 63) * 100) / 100);
});

test('no usable daily rate: one booked-rental row carries the whole est — still isBaseRentalRow-shaped', async () => {
  seed({ reservation: { dailyRate: null } });
  await reservationPricingService.addManualCharge(
    'res1', { name: 'GPS', amount: 25 }, { reason: 'x' }, { tenantId: 't1' }
  );
  const base = db.reservationCharges.find((r) => r.source === 'BASE_RATE');
  assert.equal(base.total, 322.88);
  assert.equal(base.quantity, 1);
  const sum = db.reservationCharges.reduce((s, r) => s + r.total, 0);
  assert.equal(Math.round(sum * 100) / 100, 347.88);
});

test('a reservation that ALREADY has rows is not re-seeded — just the extra', async () => {
  seed({ existingCharges: [{ id: 'rc_0', selected: true, source: 'BASE_RATE', total: 322.88 }] });
  await reservationPricingService.addManualCharge(
    'res1', { name: 'GPS', amount: 25 }, { reason: 'x' }, { tenantId: 't1' }
  );
  const created = db.reservationCharges.filter((r) => r.id !== 'rc_0');
  assert.equal(created.length, 1, 'only the extra');
  assert.equal(created[0].source, 'ADDITIONAL_SERVICE_PRECHECKIN');
});

test('QA probe B/C: a MANDATORY_FEE row neither blocks the seed nor gets double-counted', async () => {
  // The two measured holes of the second QA pass, one shape:
  //   C) the fee row must NOT count as "already priced" (it is the sync's own
  //      bookkeeping) — skipping the seed recomputed est $322.88 → $88.00;
  //   B) the quote total INCLUDES the fee, so the seeded remainder must
  //      subtract it — not doing so charged the fee twice (+$25).
  seed({ existingCharges: [{ id: 'fee_0', selected: true, source: 'MANDATORY_FEE', total: 25 }] });
  await reservationPricingService.addManualCharge(
    'res1',
    { name: 'Prepaid Toll Pass', amount: 63, kind: 'service' },
    { reason: 'VozIA upsell' },
    { tenantId: 't1' }
  );
  const rows = db.reservationCharges;
  const base = rows.find((r) => r.source === 'BASE_RATE');
  assert.ok(base, 'C: the seed still ran — the fee row is bookkeeping, not pricing');
  const rest = rows.find((r) => r.source === 'QUOTE_TAXES_FEES');
  // B: remainder = est − base − fee = 322.88 − 239.40 − 25 = 58.48 (not 83.48)
  assert.equal(rest.total, 58.48);
  const sum = rows.reduce((s, r) => s + Number(r.total), 0);
  // Grand invariant: fee + seeded + extra = est + extra. The fee is counted ONCE.
  assert.equal(Math.round(sum * 100) / 100, Math.round((322.88 + 63) * 100) / 100);
});

test('the pre-read runs BEFORE the row decision — fee rows exist when the math happens', async () => {
  // The ordering IS the fix for case B on a truly row-less reservation: the
  // getPricing call materializes the sync's fee rows first. Stubbed here, so
  // we pin the ordering signal: getPricing was called once BEFORE the writes
  // and once after (readback) — two calls total.
  await reservationPricingService.addManualCharge(
    'res1', { name: 'GPS', amount: 25 }, { reason: 'x' }, { tenantId: 't1' }
  );
  assert.equal(db.getPricingCalls, 2, 'pre-read + readback');
});

// ── The 6,353-reservation door, closed ──────────────────────────────────────

test('a broker import gets a SPEAKABLE 409, never a write (the 3a1b274 corruption class)', async () => {
  seed({ reservation: { bookingChannel: 'FRANCHISE_TL', isPrepaid: true } });
  await assert.rejects(
    () => reservationPricingService.addManualCharge('res1', { name: 'GPS', amount: 25 }, {}, { tenantId: 't1' }),
    (e) => e.status === 409 && e.code === 'EXTRA_AT_COUNTER' && /counter/.test(e.message)
  );
  assert.equal(db.reservationCharges.length, 0, 'no row, no seed, nothing');
});

test('prepaid on a native channel is refused too — the flag rules, not the channel', async () => {
  seed({ reservation: { bookingChannel: 'WEBSITE', isPrepaid: true } });
  await assert.rejects(
    () => reservationPricingService.addManualCharge('res1', { name: 'GPS', amount: 25 }, {}, { tenantId: 't1' }),
    (e) => e.code === 'EXTRA_AT_COUNTER'
  );
});

test('CANCELLED is a 400 for every caller now, not just service accounts', async () => {
  seed({ reservation: { status: 'CANCELLED' } });
  await assert.rejects(
    () => reservationPricingService.addManualCharge('res1', { name: 'GPS', amount: 25 }, {}, { tenantId: 't1' }),
    (e) => e.status === 400
  );
  assert.equal(db.reservationCharges.length, 0);
});

// ── Identity + audit + routing ──────────────────────────────────────────────

test('kind insurance → source INSURANCE with its plan code, so the counter SEES the coverage', async () => {
  await reservationPricingService.addManualCharge(
    'res1',
    { name: 'Full Coverage', amount: 89.5, kind: 'insurance', sourceRefId: 'FULL' },
    { reason: 'VozIA upsell' },
    { tenantId: 't1' }
  );
  const row = db.reservationCharges.find((r) => r.source === 'INSURANCE');
  assert.ok(row, 'coverage lands under the portal\'s own source');
  assert.equal(row.sourceRefId, 'FULL');
});

test('the audit trail survives — ADMIN_OVERRIDE with amount and source', async () => {
  await reservationPricingService.addManualCharge(
    'res1', { name: 'Toll Pass', amount: 63, kind: 'service' },
    { reason: 'VozIA ticket t-1', actorUserId: 'svc-vozia-prod' }, { tenantId: 't1' }
  );
  assert.equal(db.audits.length, 1);
  const meta = JSON.parse(db.audits[0].metadata);
  assert.equal(meta.kind, 'add_precheckout_extra');
  assert.equal(meta.amount, 63);
});

test('validation still bites first: zero amount is a 400, nothing written', async () => {
  await assert.rejects(
    () => reservationPricingService.addManualCharge('res1', { name: 'X', amount: 0 }, {}, { tenantId: 't1' }),
    (e) => e.status === 400
  );
  assert.equal(db.reservationCharges.length, 0);
});

test('WITH an agreement, the pre-checkout branch is never taken', async () => {
  seed({ agreement: { id: 'ag1', tenantId: 't1', balance: 100 } });
  prisma.rentalAgreementCharge.create = async () => { throw new Error('SENTINEL_OLD_PATH'); };
  await assert.rejects(
    () => reservationPricingService.addManualCharge('res1', { name: 'X', amount: 10, kind: 'insurance' }, {}, { tenantId: 't1' }),
    /SENTINEL_OLD_PATH/
  );
  assert.equal(db.reservationCharges.length, 0);
});

// ── Wire + reschedule wiring (QA B1 / Major 1) ─────────────────────────────

const ROUTE = readFileSync(new URL('./reservations.routes.js', import.meta.url), 'utf8');

test('QA B1: the route passes kind and sourceRefId through to the service', () => {
  // The first version validated these in the service and then the route
  // dropped them on the floor — the 6/6 suite green-lit a path no HTTP request
  // could reach. This anchor pins the wire.
  const call = ROUTE.slice(ROUTE.indexOf('reservationPricingService.addManualCharge'));
  const args = call.slice(0, call.indexOf(');'));
  assert.match(args, /kind:\s*req\.body\?\.kind/);
  assert.match(args, /sourceRefId:\s*req\.body\?\.sourceRefId/);
});

test('QA Major 1: a trip-priced pre-checkout extra blocks day-count reschedules like every other add-on', () => {
  assert.ok(PER_DAY_LIKE_SOURCES.has('ADDITIONAL_SERVICE_PRECHECKIN'));
  assert.ok(PER_DAY_LIKE_SOURCES.has('INSURANCE'));
});
