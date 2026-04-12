import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { calculateCarSharingCommission, HOST_TIERS, TRIP_PROTECTION_TIERS, PROTECTION_EXCLUSIONS, OPTIONAL_ADDONS } from './car-sharing-commission.js';
import { getAllPolicies, TOLL_POLICY, LATE_RETURN_POLICY, MILEAGE_POLICY, CANCELLATION_POLICY, SECURITY_DEPOSIT_POLICY, FUEL_POLICY, CLEANING_POLICY, ACCIDENT_PROCEDURE, GUEST_REQUIREMENTS, OPTIONAL_ADDONS as POLICY_ADDONS } from './car-sharing-policies.js';

describe('Car Sharing Commission', () => {
  it('calculates STARTER tier correctly', () => {
    const result = calculateCarSharingCommission({ baseDailyRate: 50, days: 3, hostTier: 'STARTER' });
    assert.equal(result.tripSubtotal, 150);
    assert.equal(result.hostKeepsPct, 85);
    assert.equal(result.platformCommission, 22.5);
    assert.equal(result.hostEarnings, 127.5);
    assert.equal(result.guestServiceFee, 15);
    assert.equal(result.guestServiceFeePct, 10);
  });

  it('calculates PRO tier correctly', () => {
    const result = calculateCarSharingCommission({ baseDailyRate: 50, days: 3, hostTier: 'PRO' });
    assert.equal(result.hostKeepsPct, 80);
    assert.equal(result.platformCommission, 30);
    assert.equal(result.hostEarnings, 120);
  });

  it('calculates ELITE tier correctly', () => {
    const result = calculateCarSharingCommission({ baseDailyRate: 50, days: 3, hostTier: 'ELITE' });
    assert.equal(result.hostKeepsPct, 75);
    assert.equal(result.platformCommission, 37.5);
  });

  it('adds protection fee to guest total', () => {
    const result = calculateCarSharingCommission({ baseDailyRate: 50, days: 3, protectionTier: 'STANDARD' });
    assert.equal(result.protectionFee, 36); // $12 × 3
    assert.equal(result.protectionPerDay, 12);
  });

  it('adds premium protection fee', () => {
    const result = calculateCarSharingCommission({ baseDailyRate: 50, days: 3, protectionTier: 'PREMIUM' });
    assert.equal(result.protectionFee, 66); // $22 × 3
    assert.equal(result.deductibleReimbursementMax, 2500);
  });

  it('adds under 25 surcharge', () => {
    const result = calculateCarSharingCommission({ baseDailyRate: 50, days: 3, guestAge: 22 });
    assert.equal(result.under25Surcharge, 45); // $15 × 3
  });

  it('no surcharge for 25+', () => {
    const result = calculateCarSharingCommission({ baseDailyRate: 50, days: 3, guestAge: 25 });
    assert.equal(result.under25Surcharge, 0);
  });

  it('includes delivery and cleaning fees', () => {
    const result = calculateCarSharingCommission({ baseDailyRate: 50, days: 3, deliveryFee: 30, cleaningFee: 20 });
    assert.equal(result.deliveryFee, 30);
    assert.equal(result.cleaningFee, 20);
    assert.ok(result.guestTotal > result.tripSubtotal);
  });

  it('defaults to STARTER tier', () => {
    const result = calculateCarSharingCommission({ baseDailyRate: 50, days: 1 });
    assert.equal(result.hostTier, 'STARTER');
  });
});

describe('Host Tiers', () => {
  it('has 3 tiers', () => {
    assert.equal(Object.keys(HOST_TIERS).length, 3);
  });

  it('all tiers have features', () => {
    for (const tier of Object.values(HOST_TIERS)) {
      assert.ok(tier.features.length > 0);
      assert.ok(tier.hostKeepsPct > 0);
      assert.ok(tier.platformTakesPct > 0);
      assert.equal(tier.hostKeepsPct + tier.platformTakesPct, 100);
    }
  });
});

describe('Protection Tiers', () => {
  it('has 3 tiers', () => {
    assert.equal(Object.keys(TRIP_PROTECTION_TIERS).length, 3);
  });

  it('BASIC has zero reimbursement', () => {
    assert.equal(TRIP_PROTECTION_TIERS.BASIC.deductibleReimbursementMax, 0);
    assert.equal(TRIP_PROTECTION_TIERS.BASIC.pricePerDay, 0);
  });

  it('PREMIUM has highest reimbursement', () => {
    assert.ok(TRIP_PROTECTION_TIERS.PREMIUM.deductibleReimbursementMax > TRIP_PROTECTION_TIERS.STANDARD.deductibleReimbursementMax);
  });

  it('exclusions list is non-empty', () => {
    assert.ok(PROTECTION_EXCLUSIONS.length >= 10);
    assert.ok(PROTECTION_EXCLUSIONS.some((e) => e.toLowerCase().includes('tire')));
    assert.ok(PROTECTION_EXCLUSIONS.some((e) => e.toLowerCase().includes('glass')));
    assert.ok(PROTECTION_EXCLUSIONS.some((e) => e.toLowerCase().includes('wear')));
  });
});

describe('Policies', () => {
  it('getAllPolicies returns all sections', () => {
    const p = getAllPolicies();
    assert.ok(p.lateReturn);
    assert.ok(p.mileage);
    assert.ok(p.cancellation);
    assert.ok(p.securityDeposit);
    assert.ok(p.fuel);
    assert.ok(p.cleaning);
    assert.ok(p.accidentProcedure);
    assert.ok(p.guestRequirements);
    assert.ok(p.vehicleRestrictions);
    assert.ok(p.addons);
    assert.ok(p.tolls);
    assert.ok(p.dataUsageNotice);
  });

  it('toll policy has both with-pass and without-pass', () => {
    assert.equal(TOLL_POLICY.withPass.dailyRate, 3.5);
    assert.equal(TOLL_POLICY.withoutPass.adminFeePerToll, 5);
  });

  it('late return has grace period', () => {
    assert.equal(LATE_RETURN_POLICY.gracePeriodMinutes, 30);
    assert.equal(LATE_RETURN_POLICY.hourlyFee, 25);
  });

  it('mileage default is 200', () => {
    assert.equal(MILEAGE_POLICY.defaultDailyMiles, 200);
    assert.equal(MILEAGE_POLICY.excessRatePerMile, 0.35);
  });

  it('guest cancellation has 48hr free window', () => {
    assert.equal(CANCELLATION_POLICY.guest.freeWindowHours, 48);
  });

  it('security deposit default is 250', () => {
    assert.equal(SECURITY_DEPOSIT_POLICY.defaultAmount, 250);
    assert.equal(SECURITY_DEPOSIT_POLICY.maxHostAmount, 500);
  });

  it('accident procedure has 8 steps', () => {
    assert.equal(ACCIDENT_PROCEDURE.steps.length, 8);
  });

  it('guest minimum age is 21', () => {
    assert.equal(GUEST_REQUIREMENTS.minimumAge, 21);
    assert.equal(GUEST_REQUIREMENTS.youngDriverSurchargePerDay, 15);
  });

  it('add-ons include toll pass', () => {
    assert.ok(POLICY_ADDONS.TOLL_PASS);
    assert.equal(POLICY_ADDONS.TOLL_PASS.pricePerDay, 3.5);
    assert.ok(POLICY_ADDONS.TIRE_PROTECTION);
    assert.ok(POLICY_ADDONS.GLASS_PROTECTION);
    assert.ok(POLICY_ADDONS.ROADSIDE_ASSISTANCE);
  });

  it('all add-ons have covers and doesNotCover arrays', () => {
    for (const addon of Object.values(POLICY_ADDONS)) {
      assert.ok(Array.isArray(addon.covers), `${addon.id} missing covers`);
      assert.ok(Array.isArray(addon.doesNotCover), `${addon.id} missing doesNotCover`);
      assert.ok(addon.covers.length > 0);
      assert.ok(addon.doesNotCover.length > 0);
    }
  });

  it('cleaning tiers are defined', () => {
    assert.ok(CLEANING_POLICY.tiers.length >= 4);
    assert.equal(CLEANING_POLICY.smoking.fee, 250);
    assert.equal(CLEANING_POLICY.pets.fee, 150);
  });
});
