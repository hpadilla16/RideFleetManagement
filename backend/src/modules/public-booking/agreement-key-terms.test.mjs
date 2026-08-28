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
    // Scope the fee-rate lookup resolves against. `include` (not `select`)
    // means Prisma returns these scalars automatically in production.
    tenantId: 'tenant-1',
    pickupLocationId: 'loc-1',
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

// ── FeeRate / Location stubs ────────────────────────────────────────────
// The key-terms panel resolves LATE_RETURN + EXCESS_MILEAGE through the fee
// engine and the pickup location's grace window. Stub both so these tests
// never touch a real database (and so a stale generated client, which can
// leave prisma.feeRate undefined, doesn't blow the suite up).

const rateStubs = { saved: null };

function stubRateLookups({ rows = [], locationConfig = null, fail = false } = {}) {
  if (!prisma.feeRate) prisma.feeRate = {};
  if (!prisma.location) prisma.location = {};
  rateStubs.saved = {
    feeRateFindFirst: prisma.feeRate.findFirst,
    locationFindUnique: prisma.location.findUnique,
  };
  prisma.feeRate.findFirst = async ({ where }) => {
    if (fail) throw new Error('simulated FeeRate lookup failure');
    return (
      rows.find(
        (r) =>
          r.tenantId === where.tenantId &&
          (r.locationId ?? null) === (where.locationId ?? null) &&
          r.feeType === where.feeType,
      ) || null
    );
  };
  prisma.location.findUnique = async () => ({ locationConfig });
}

function restoreRateLookups() {
  if (!rateStubs.saved) return;
  prisma.feeRate.findFirst = rateStubs.saved.feeRateFindFirst;
  prisma.location.findUnique = rateStubs.saved.locationFindUnique;
  rateStubs.saved = null;
}

const feeRow = (feeType, amount, extra = {}) => ({
  tenantId: 'tenant-1',
  locationId: null,
  feeType,
  unit: feeType === 'LATE_RETURN' ? 'PER_HOUR' : 'PER_MILE',
  amount,
  isActive: true,
  id: `rate-${feeType}-${extra.locationId ?? 'tenant'}`,
  ...extra,
});

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
    stubRateLookups();
  });

  afterEach(() => {
    prisma.reservation.findFirst = origFindFirst;
    restoreRateLookups();
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


// Regression tests for the fee figures the same panel quotes (2026-08-26).
// Before the fix the copy hardcoded "$50/hour" late and "$0.45/mi" overage
// while check-in billed the resolved FeeRate — platform defaults $25.00/hour
// and $0.50/mi. Customers signed a quote for a late rate 2x what we charge,
// and any tenant that customized its rates drifted further still.
describe('publicBookingService.getGuestAgreement — fee rates quoted', () => {
  let origFindFirst;
  let reservation;

  const lateTerm = (res) => res.keyTerms.find((t) => t.icon === 'clock');
  const mileageTerm = (res) => res.keyTerms.find((t) => t.icon === 'road');

  beforeEach(() => {
    reservation = fakeReservation();
    origFindFirst = prisma.reservation.findFirst;
    prisma.reservation.findFirst = async () => reservation;
  });

  afterEach(() => {
    prisma.reservation.findFirst = origFindFirst;
    restoreRateLookups();
  });

  it('never quotes the old hardcoded literals', async () => {
    stubRateLookups();
    const res = await publicBookingService.getGuestAgreement('tok-1');
    const allCopy = res.keyTerms.map((t) => `${t.title} ${t.detail}`).join(' | ');
    assert.ok(!/\$50\/hour/.test(allCopy), `late literal survived: ${allCopy}`);
    assert.ok(!/\$0\.45/.test(allCopy), `mileage literal survived: ${allCopy}`);
  });

  it('falls back to the platform default rate the engine also falls back to', async () => {
    stubRateLookups(); // no FeeRate rows at all
    const res = await publicBookingService.getGuestAgreement('tok-1');
    assert.equal(
      lateTerm(res).detail,
      'Grace window: 30 minutes. After that, a $25/hour late fee applies.',
    );
    assert.equal(
      mileageTerm(res).detail,
      "Overage billed at $0.50/mi against the Renter's card at return.",
    );
  });

  it('quotes the tenant-default FeeRate when one exists', async () => {
    stubRateLookups({ rows: [feeRow('LATE_RETURN', 40)] });
    const res = await publicBookingService.getGuestAgreement('tok-1');
    assert.match(lateTerm(res).detail, /a \$40\/hour late fee applies/);
  });

  it('lets a location-specific FeeRate win over the tenant default', async () => {
    stubRateLookups({
      rows: [
        feeRow('LATE_RETURN', 40),
        feeRow('LATE_RETURN', 75, { locationId: 'loc-1' }),
      ],
    });
    const res = await publicBookingService.getGuestAgreement('tok-1');
    assert.match(lateTerm(res).detail, /a \$75\/hour late fee applies/);
  });

  it('keeps the cents on a non-whole rate', async () => {
    stubRateLookups({ rows: [feeRow('LATE_RETURN', 27.5)] });
    const res = await publicBookingService.getGuestAgreement('tok-1');
    assert.match(lateTerm(res).detail, /a \$27\.50\/hour late fee applies/);
  });

  it('converts a Prisma Decimal rate via its string form', async () => {
    stubRateLookups({
      rows: [feeRow('LATE_RETURN', { toString: () => '33.00' })],
    });
    const res = await publicBookingService.getGuestAgreement('tok-1');
    assert.match(lateTerm(res).detail, /a \$33\/hour late fee applies/);
  });

  it('reads the grace window from the pickup location, not a constant', async () => {
    stubRateLookups({ locationConfig: { gracePeriodMin: 60 } });
    const res = await publicBookingService.getGuestAgreement('tok-1');
    assert.match(lateTerm(res).detail, /^Grace window: 1 hour\./);
  });

  it('drops the grace sentence when the location grace is zero', async () => {
    stubRateLookups({ locationConfig: { gracePeriodMin: 0 } });
    const res = await publicBookingService.getGuestAgreement('tok-1');
    const detail = lateTerm(res).detail;
    assert.ok(!/Grace window/.test(detail), detail);
    assert.equal(detail, 'A $25/hour late fee applies after the scheduled return time.');
  });

  it('promises NO fee when the tenant disabled the late-return fee', async () => {
    stubRateLookups({ rows: [feeRow('LATE_RETURN', 25, { isActive: false })] });
    const res = await publicBookingService.getGuestAgreement('tok-1');
    const detail = lateTerm(res).detail;
    assert.match(detail, /No late-return fee applies to this rental\./);
    assert.ok(!/\$/.test(detail), `disabled fee must not quote a figure: ${detail}`);
  });

  it('promises NO overage when the tenant disabled excess mileage', async () => {
    stubRateLookups({ rows: [feeRow('EXCESS_MILEAGE', 0.5, { isActive: false })] });
    const res = await publicBookingService.getGuestAgreement('tok-1');
    const detail = mileageTerm(res).detail;
    assert.equal(detail, 'No overage fee applies beyond the included mileage.');
    assert.ok(!/\$/.test(detail), detail);
  });

  it('quotes NO figure when the reservation has no tenant', async () => {
    reservation.tenantId = null;
    stubRateLookups({ rows: [feeRow('LATE_RETURN', 40)] });
    const res = await publicBookingService.getGuestAgreement('tok-1');
    const detail = lateTerm(res).detail;
    assert.ok(!/\$/.test(detail), `untenanted reservation must not quote: ${detail}`);
    assert.match(detail, /rate in your rental agreement/);
  });

  it('quotes NO figure — and still returns — when the rate lookup fails', async () => {
    stubRateLookups({ fail: true });
    const res = await publicBookingService.getGuestAgreement('tok-1');
    const detail = lateTerm(res).detail;
    assert.ok(!/\$/.test(detail), `failed lookup must not quote: ${detail}`);
    assert.match(detail, /rate in your rental agreement/);
    // The screen must still render so the customer can sign.
    assert.equal(res.keyTerms.length, 4);
  });

  it('does not threaten an overage rate on an unlimited-mileage rental', async () => {
    reservation.vehicleType = { label: 'SUV', unlimitedMileage: true, freeMilesPerDay: null };
    stubRateLookups({ rows: [feeRow('EXCESS_MILEAGE', 0.75)] });
    const res = await publicBookingService.getGuestAgreement('tok-1');
    const detail = mileageTerm(res).detail;
    assert.equal(detail, 'No mileage cap applies to this rental.');
    assert.ok(!/0\.75/.test(detail), detail);
  });
});
