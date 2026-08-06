/**
 * "Collected today" splits per location and every user can see it
 * (Hector, 2026-08-06). The split keys off the agreement's reservation pickup
 * location; a location-scoped user's ids flow into the Prisma where, so their
 * tile shows THEIR money instead of the old 403.
 */
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://u:p@127.0.0.1:5432/none';

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const { computeTodayKpis } = await import('./today-kpis.js');

const SJU = { id: 'loc-sju', code: 'SJU', name: 'San Juan Airport' };
const PSE = { id: 'loc-pse', code: 'PSE', name: 'Ponce' };
const pay = (amount, loc) => ({
  amount,
  rentalAgreement: { reservation: { pickupLocation: loc } },
});

function fakeDb(payments, { capture = {} } = {}) {
  return {
    rentalAgreementPayment: {
      findMany: async (args) => { capture.paymentWhere = args.where; return payments; },
    },
    tollTransaction: {
      count: async (args) => { capture.tollWhere = args.where; return 3; },
    },
  };
}

describe('computeTodayKpis per-location split', () => {
  it('sums the day per pickup location, largest first, and still totals exactly', async () => {
    const db = fakeDb([pay(100.10, SJU), pay(50.25, PSE), pay(199.90, SJU)]);
    const out = await computeTodayKpis('t1', { prisma: db });
    assert.equal(out.collectedToday, 350.25);
    assert.deepEqual(out.byLocation, [
      { locationId: 'loc-sju', code: 'SJU', name: 'San Juan Airport', amount: 300 },
      { locationId: 'loc-pse', code: 'PSE', name: 'Ponce', amount: 50.25 },
    ]);
    assert.equal(out.scoped, false);
    assert.equal(out.pendingTolls, 3);
  });

  it('a payment with no pickup location still counts — bucketed, never dropped', async () => {
    const db = fakeDb([pay(75, SJU), pay(25, null)]);
    const out = await computeTodayKpis('t1', { prisma: db });
    assert.equal(out.collectedToday, 100, 'money must never vanish from the total');
    const unknown = out.byLocation.find((l) => l.locationId === null);
    assert.equal(unknown.amount, 25);
  });

  it('a scoped user filters payments AND tolls to their locations', async () => {
    const capture = {};
    const db = fakeDb([pay(60, SJU)], { capture });
    const out = await computeTodayKpis('t1', { prisma: db, locationIds: ['loc-sju'] });
    assert.equal(out.scoped, true);
    assert.deepEqual(
      capture.paymentWhere.rentalAgreement.reservation.pickupLocationId,
      { in: ['loc-sju'] },
      'the scope reaches the Prisma where — not a post-filter that can leak',
    );
    assert.deepEqual(capture.tollWhere.reservation.pickupLocationId, { in: ['loc-sju'] });
  });

  it('an empty scope array means unscoped, not scoped-to-nothing', async () => {
    const capture = {};
    const db = fakeDb([], { capture });
    await computeTodayKpis('t1', { prisma: db, locationIds: [] });
    assert.equal(capture.paymentWhere.rentalAgreement.reservation, undefined);
  });

  it('an empty day is zeros, not nulls', async () => {
    const out = await computeTodayKpis('t1', { prisma: fakeDb([]) });
    assert.equal(out.collectedToday, 0);
    assert.deepEqual(out.byLocation, []);
  });
});
