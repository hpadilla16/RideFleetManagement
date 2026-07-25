import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { prisma } from '../../lib/prisma.js';
import { publicBookingService } from './public-booking.service.js';

// Regression tests for the guest-agreement "key terms" panel (MONEY-adjacent
// display, 2026-07-25). Before the fix it read
// reservation.securityDepositAmount and reservation.dailyMileageCap — fields
// that exist on NO model — so EVERY customer was told "$300 security deposit"
// regardless of the real amount, and the mileage branch was dead code. The
// panel now reads the frozen ReservationPricingSnapshot (deposit + the
// local/non-local rule decision) with the vehicle type's mileage profile as
// fallback, and shows NO figure when none is known.

function fakeReservation(overrides = {}) {
  return {
    id: 'res-1',
    signatureToken: 'tok-1',
    reservationNumber: 'R-1001',
    signatureSignedAt: null,
    signatureSignedBy: null,
    notes: null,
    pickupAt: new Date('2026-08-01T15:00:00Z'),
    returnAt: new Date('2026-08-04T15:00:00Z'),
    customer: { firstName: 'Ana', lastName: 'Rios', email: 'ana@example.com' },
    vehicle: { year: 2025, make: 'Toyota', model: 'Corolla', color: 'White' },
    vehicleType: { label: 'Economy', unlimitedMileage: false, freeMilesPerDay: null },
    pickupLocation: { name: 'LAX' },
    returnLocation: { name: 'LAX' },
    carSharingTrip: null,
    pricingSnapshot: null,
    ...overrides,
  };
}

describe('publicBookingService.getGuestAgreement — key terms panel', () => {
  let origFindFirst;
  let findFirstArgs;
  let reservation;

  beforeEach(() => {
    reservation = fakeReservation();
    findFirstArgs = null;
    origFindFirst = prisma.reservation.findFirst;
    prisma.reservation.findFirst = async (args) => {
      findFirstArgs = args;
      return reservation;
    };
  });

  afterEach(() => {
    prisma.reservation.findFirst = origFindFirst;
  });

  const depositTerm = (res) => res.keyTerms.find((t) => t.icon === 'money');
  const mileageTerm = (res) => res.keyTerms.find((t) => t.icon === 'road');

  it('fetches the pricing snapshot and vehicle-type mileage fields the panel reads', async () => {
    await publicBookingService.getGuestAgreement('tok-1');
    const include = findFirstArgs.include;
    assert.deepEqual(include.pricingSnapshot, {
      select: { securityDepositAmount: true, securityDepositRuleJson: true },
    });
    assert.equal(include.vehicleType.select.unlimitedMileage, true);
    assert.equal(include.vehicleType.select.freeMilesPerDay, true);
  });

  it('shows the deposit frozen on the pricing snapshot, not a constant', async () => {
    reservation.pricingSnapshot = { securityDepositAmount: 2000, securityDepositRuleJson: null };
    const res = await publicBookingService.getGuestAgreement('tok-1');
    assert.equal(depositTerm(res).title, '$2000 security deposit');
  });

  it('converts a Prisma Decimal deposit via its string form', async () => {
    // Prisma returns Decimal objects, not numbers — Number() must still work.
    reservation.pricingSnapshot = {
      securityDepositAmount: { toString: () => '1000.00' },
      securityDepositRuleJson: null,
    };
    const res = await publicBookingService.getGuestAgreement('tok-1');
    assert.equal(depositTerm(res).title, '$1000 security deposit');
  });

  it('shows NO dollar figure when there is no pricing snapshot (was: $300 for everyone)', async () => {
    reservation.pricingSnapshot = null;
    const res = await publicBookingService.getGuestAgreement('tok-1');
    const term = depositTerm(res);
    assert.equal(term.title, 'Security deposit');
    assert.ok(!/\$/.test(term.title), 'deposit title must not invent a dollar amount');
  });

  it('shows NO dollar figure when the snapshot deposit is zero', async () => {
    reservation.pricingSnapshot = { securityDepositAmount: 0, securityDepositRuleJson: null };
    const res = await publicBookingService.getGuestAgreement('tok-1');
    assert.equal(depositTerm(res).title, 'Security deposit');
  });

  it('derives mileage from the frozen deposit-rule decision', async () => {
    reservation.pricingSnapshot = {
      securityDepositAmount: 2000,
      securityDepositRuleJson: JSON.stringify({
        locality: 'LOCAL', basis: 'LICENSE', milesPerDay: 150, unlimitedMileage: false,
      }),
    };
    const res = await publicBookingService.getGuestAgreement('tok-1');
    assert.equal(mileageTerm(res).title, '150 miles/day included');
  });

  it('shows unlimited mileage from the frozen decision, without an overage line', async () => {
    reservation.pricingSnapshot = {
      securityDepositAmount: 1000,
      securityDepositRuleJson: JSON.stringify({
        locality: 'NON_LOCAL', basis: 'LICENSE', milesPerDay: null, unlimitedMileage: true,
      }),
    };
    const res = await publicBookingService.getGuestAgreement('tok-1');
    const term = mileageTerm(res);
    assert.equal(term.title, 'Unlimited mileage');
    assert.ok(!/overage/i.test(term.detail), 'unlimited must not threaten an overage fee');
  });

  it('frozen decision wins over the vehicle type profile', async () => {
    reservation.vehicleType = { label: 'SUV', unlimitedMileage: true, freeMilesPerDay: null };
    reservation.pricingSnapshot = {
      securityDepositAmount: 2000,
      securityDepositRuleJson: JSON.stringify({ milesPerDay: 150, unlimitedMileage: false }),
    };
    const res = await publicBookingService.getGuestAgreement('tok-1');
    assert.equal(mileageTerm(res).title, '150 miles/day included');
  });

  it('falls back to the vehicle type: unlimitedMileage', async () => {
    reservation.vehicleType = { label: 'SUV', unlimitedMileage: true, freeMilesPerDay: null };
    const res = await publicBookingService.getGuestAgreement('tok-1');
    assert.equal(mileageTerm(res).title, 'Unlimited mileage');
  });

  it('falls back to the vehicle type: freeMilesPerDay', async () => {
    reservation.vehicleType = { label: 'Economy', unlimitedMileage: false, freeMilesPerDay: 200 };
    const res = await publicBookingService.getGuestAgreement('tok-1');
    assert.equal(mileageTerm(res).title, '200 miles/day included');
  });

  it('shows the honest generic line when nothing declares a mileage allowance', async () => {
    const res = await publicBookingService.getGuestAgreement('tok-1');
    assert.equal(mileageTerm(res).title, 'Mileage included per listing');
  });
});
