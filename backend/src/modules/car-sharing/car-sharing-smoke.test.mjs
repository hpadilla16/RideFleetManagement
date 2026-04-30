import assert from 'node:assert/strict';
import { test } from 'node:test';
import { computeMarketplaceTripPricing } from './car-sharing-pricing.js';
import { resolveDeliveryFeeOverride, resolveDeliveryAreaHints } from './car-sharing-fulfillment.js';
import { resolveHandoffConfirmationAlerts } from './car-sharing-handoff.js';

// ─── computeMarketplaceTripPricing ───────────────────────────────────────────

test('computeMarketplaceTripPricing pickup path applies correct fee structure', () => {
  const result = computeMarketplaceTripPricing({
    subtotal: 300,
    cleaningFee: 40,
    pickupFee: 20,
    deliveryFee: 50,
    fulfillmentChoice: 'PICKUP',
    taxes: 0,
    hostProfile: { averageRating: 5, reviewCount: 15 }
  });

  assert.equal(result.fulfillmentChoice, 'PICKUP');
  assert.equal(result.selectedFulfillmentFee, 20);
  assert.equal(result.hostGrossRevenue, 360); // 300 + 40 + 20
  assert.equal(result.hostServiceFeeRate, 10); // top tier: 10+ reviews, 4.8+ rating
  assert.equal(result.hostServiceFee, 36);
  assert.equal(result.hostEarnings, 324);
  assert.ok(result.guestTripFee >= 7 && result.guestTripFee <= 35, 'guest trip fee within bounds');
  assert.equal(result.quotedTotal, 300 + 40 + 20 + result.guestTripFee);
});

test('computeMarketplaceTripPricing delivery path uses delivery fee not pickup fee', () => {
  const result = computeMarketplaceTripPricing({
    subtotal: 200,
    cleaningFee: 30,
    pickupFee: 15,
    deliveryFee: 60,
    fulfillmentChoice: 'DELIVERY',
    taxes: 0,
    hostProfile: null
  });

  assert.equal(result.fulfillmentChoice, 'DELIVERY');
  assert.equal(result.selectedFulfillmentFee, 60);
  assert.equal(result.hostGrossRevenue, 290); // 200 + 30 + 60
  assert.equal(result.hostServiceFeeRate, 15); // default tier
});

test('computeMarketplaceTripPricing guest trip fee is capped at $35', () => {
  const result = computeMarketplaceTripPricing({
    subtotal: 5000,
    cleaningFee: 0,
    pickupFee: 0,
    deliveryFee: 0,
    fulfillmentChoice: 'PICKUP',
    taxes: 0,
    hostProfile: null
  });
  assert.equal(result.guestTripFee, 35);
});

test('computeMarketplaceTripPricing guest trip fee has $7 floor', () => {
  const result = computeMarketplaceTripPricing({
    subtotal: 10,
    cleaningFee: 0,
    pickupFee: 0,
    deliveryFee: 0,
    fulfillmentChoice: 'PICKUP',
    taxes: 0,
    hostProfile: null
  });
  assert.equal(result.guestTripFee, 7);
});

test('computeMarketplaceTripPricing host service fee tiers work correctly', () => {
  const topTier = computeMarketplaceTripPricing({
    subtotal: 100, cleaningFee: 0, pickupFee: 0, deliveryFee: 0, fulfillmentChoice: 'PICKUP',
    hostProfile: { averageRating: 4.9, reviewCount: 12 }
  });
  const midTier = computeMarketplaceTripPricing({
    subtotal: 100, cleaningFee: 0, pickupFee: 0, deliveryFee: 0, fulfillmentChoice: 'PICKUP',
    hostProfile: { averageRating: 4.7, reviewCount: 5 }
  });
  const baseTier = computeMarketplaceTripPricing({
    subtotal: 100, cleaningFee: 0, pickupFee: 0, deliveryFee: 0, fulfillmentChoice: 'PICKUP',
    hostProfile: null
  });

  assert.equal(topTier.hostServiceFeeRate, 10);
  assert.equal(midTier.hostServiceFeeRate, 12);
  assert.equal(baseTier.hostServiceFeeRate, 15);
  assert.ok(topTier.hostEarnings > midTier.hostEarnings, 'top tier host earns more');
  assert.ok(midTier.hostEarnings > baseTier.hostEarnings, 'mid tier host earns more than base');
});

// ─── resolveDeliveryAreaHints ─────────────────────────────────────────────────

test('resolveDeliveryAreaHints returns only delivery service areas with correct shape', () => {
  const listing = {
    serviceAreas: [
      { id: 'sa1', searchPlaceId: 'sp1', serviceType: 'DELIVERY', radiusMiles: 15, feeOverride: 40, isActive: true, searchPlace: { displayName: 'Miami Airport', city: 'Miami', state: 'FL', placeType: 'AIRPORT' } },
      { id: 'sa2', searchPlaceId: 'sp2', serviceType: 'PICKUP', radiusMiles: null, feeOverride: null, isActive: true, searchPlace: { displayName: 'Downtown', city: 'Miami', state: 'FL', placeType: 'NEIGHBORHOOD' } },
      { id: 'sa3', searchPlaceId: 'sp3', serviceType: 'BOTH', radiusMiles: 8, feeOverride: null, isActive: true, searchPlace: { displayName: 'Port Miami', city: 'Miami', state: 'FL', placeType: 'STATION' } }
    ]
  };
  const hints = resolveDeliveryAreaHints(listing);
  assert.equal(hints.length, 2, 'only DELIVERY and BOTH areas');
  assert.equal(hints[0].label, 'Miami Airport');
  assert.equal(hints[0].radiusMiles, 15);
  assert.equal(hints[0].feeOverride, 40);
  assert.equal(hints[1].label, 'Port Miami');
  assert.equal(hints[1].radiusMiles, 8);
  assert.equal(hints[1].feeOverride, null);
});

test('resolveDeliveryAreaHints returns empty array for listing with no service areas', () => {
  assert.deepEqual(resolveDeliveryAreaHints(null), []);
  assert.deepEqual(resolveDeliveryAreaHints({ serviceAreas: [] }), []);
});

// ─── resolveDeliveryFeeOverride ───────────────────────────────────────────────

test('resolveDeliveryFeeOverride returns null for pickup trips', () => {
  const listing = {
    serviceAreas: [{ searchPlaceId: 'sp1', serviceType: 'DELIVERY', feeOverride: 75, isActive: true }]
  };
  const result = resolveDeliveryFeeOverride({ listing, fulfillmentChoice: 'PICKUP', searchPlaceId: 'sp1' });
  assert.equal(result, null);
});

test('resolveDeliveryFeeOverride applies matching service area fee override for delivery', () => {
  const listing = {
    serviceAreas: [
      { searchPlaceId: 'sp-airport', serviceType: 'DELIVERY', feeOverride: 90, isActive: true },
      { searchPlaceId: 'sp-hotel', serviceType: 'DELIVERY', feeOverride: 50, isActive: true }
    ]
  };
  const result = resolveDeliveryFeeOverride({ listing, fulfillmentChoice: 'DELIVERY', searchPlaceId: 'sp-airport' });
  assert.equal(result, 90);
});

test('resolveDeliveryFeeOverride falls back to first active delivery area when no searchPlaceId', () => {
  const listing = {
    serviceAreas: [
      { searchPlaceId: 'sp1', serviceType: 'PICKUP', feeOverride: 30, isActive: true },
      { searchPlaceId: 'sp2', serviceType: 'DELIVERY', feeOverride: 65, isActive: true }
    ]
  };
  const result = resolveDeliveryFeeOverride({ listing, fulfillmentChoice: 'DELIVERY', searchPlaceId: '' });
  assert.equal(result, 65);
});

test('resolveDeliveryFeeOverride returns null when service area has no fee override', () => {
  const listing = {
    serviceAreas: [
      { searchPlaceId: 'sp1', serviceType: 'DELIVERY', feeOverride: null, isActive: true }
    ]
  };
  const result = resolveDeliveryFeeOverride({ listing, fulfillmentChoice: 'DELIVERY', searchPlaceId: 'sp1' });
  assert.equal(result, null);
});

test('resolveDeliveryFeeOverride returns null when no service areas match', () => {
  const listing = { serviceAreas: [] };
  const result = resolveDeliveryFeeOverride({ listing, fulfillmentChoice: 'DELIVERY', searchPlaceId: 'sp-unknown' });
  assert.equal(result, null);
});

// ─── resolveHandoffConfirmationAlerts ────────────────────────────────────────

function makeTrip({ id = 't1', hoursFromNow = 12, confirmed = false, revealMode = 'REVEAL_AFTER_BOOKING', handoffMode = 'IN_PERSON', status = 'CONFIRMED' } = {}) {
  const now = new Date();
  const scheduledPickupAt = new Date(now.getTime() + hoursFromNow * 60 * 60 * 1000);
  return {
    id,
    tripCode: `TRIP-${id}`,
    listingId: `listing-${id}`,
    hostProfileId: `host-${id}`,
    status,
    scheduledPickupAt,
    fulfillmentPlan: {
      confirmedAt: confirmed ? new Date() : null,
      pickupRevealMode: revealMode,
      handoffMode
    }
  };
}

test('resolveHandoffConfirmationAlerts flags unconfirmed trip within warning window', () => {
  const trip = makeTrip({ hoursFromNow: 10 });
  const alerts = resolveHandoffConfirmationAlerts([trip], { warningHoursBeforePickup: 24, now: new Date() });
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].tripId, 't1');
  assert.equal(alerts[0].isOverdue, false);
  assert.ok(alerts[0].hoursUntilPickup <= 10);
});

test('resolveHandoffConfirmationAlerts ignores trips outside warning window', () => {
  const trip = makeTrip({ hoursFromNow: 48 });
  const alerts = resolveHandoffConfirmationAlerts([trip], { warningHoursBeforePickup: 24, now: new Date() });
  assert.equal(alerts.length, 0);
});

test('resolveHandoffConfirmationAlerts ignores already confirmed trips', () => {
  const trip = makeTrip({ hoursFromNow: 6, confirmed: true });
  const alerts = resolveHandoffConfirmationAlerts([trip], { warningHoursBeforePickup: 24, now: new Date() });
  assert.equal(alerts.length, 0);
});

test('resolveHandoffConfirmationAlerts ignores PUBLIC_EXACT reveal mode', () => {
  const trip = makeTrip({ hoursFromNow: 6, revealMode: 'PUBLIC_EXACT' });
  const alerts = resolveHandoffConfirmationAlerts([trip], { warningHoursBeforePickup: 24, now: new Date() });
  assert.equal(alerts.length, 0);
});

test('resolveHandoffConfirmationAlerts marks overdue when pickup has passed', () => {
  const trip = makeTrip({ hoursFromNow: -3 });
  const alerts = resolveHandoffConfirmationAlerts([trip], { warningHoursBeforePickup: 24, now: new Date() });
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].isOverdue, true);
  assert.equal(alerts[0].hoursUntilPickup, 0);
});

test('resolveHandoffConfirmationAlerts sorts by soonest pickup first', () => {
  const trips = [
    makeTrip({ id: 'far', hoursFromNow: 20 }),
    makeTrip({ id: 'close', hoursFromNow: 4 }),
    makeTrip({ id: 'mid', hoursFromNow: 12 })
  ];
  const alerts = resolveHandoffConfirmationAlerts(trips, { warningHoursBeforePickup: 24, now: new Date() });
  assert.equal(alerts.length, 3);
  assert.equal(alerts[0].tripId, 'close');
  assert.equal(alerts[2].tripId, 'far');
});

test('resolveHandoffConfirmationAlerts handles empty trip list', () => {
  const alerts = resolveHandoffConfirmationAlerts([], { warningHoursBeforePickup: 24, now: new Date() });
  assert.deepEqual(alerts, []);
});

test('resolveHandoffConfirmationAlerts handles trip with no fulfillment plan', () => {
  const trip = { id: 't-nofp', tripCode: 'TRIP-nofp', scheduledPickupAt: new Date(), fulfillmentPlan: null };
  const alerts = resolveHandoffConfirmationAlerts([trip], { warningHoursBeforePickup: 24, now: new Date() });
  assert.equal(alerts.length, 0);
});

// ─── platformFeeConfig tests ───────────────────────────────────────────────────

test('computeMarketplaceTripPricing with platformFeeEnabled=false returns 0 guestTripFee', () => {
  const result = computeMarketplaceTripPricing({
    subtotal: 500,
    cleaningFee: 50,
    pickupFee: 25,
    deliveryFee: 0,
    fulfillmentChoice: 'PICKUP',
    taxes: 0,
    hostProfile: null,
    platformFeeConfig: { enabled: false, pct: 10, min: 7, max: 35 }
  });
  assert.equal(result.guestTripFee, 0);
  assert.equal(result.platformRevenue, result.hostServiceFee);
});

test('computeMarketplaceTripPricing with custom pct=15 uses 15% instead of 10%', () => {
  // Use max=1000 so the percentage isn't clamped — we want to verify
  // pct=15 is honored, not the cap behavior (covered by other tests).
  const result = computeMarketplaceTripPricing({
    subtotal: 300,
    cleaningFee: 0,
    pickupFee: 0,
    deliveryFee: 0,
    fulfillmentChoice: 'PICKUP',
    taxes: 0,
    hostProfile: null,
    platformFeeConfig: { enabled: true, pct: 15, min: 7, max: 1000 }
  });
  // 15% of hostGrossRevenue (= subtotal + 0 fees = 300) = 45
  assert.equal(result.guestTripFee, 45);
});

test('computeMarketplaceTripPricing with custom min=0, max=0 returns 0 guestTripFee', () => {
  const result = computeMarketplaceTripPricing({
    subtotal: 500,
    cleaningFee: 0,
    pickupFee: 0,
    deliveryFee: 0,
    fulfillmentChoice: 'PICKUP',
    taxes: 0,
    hostProfile: null,
    platformFeeConfig: { enabled: true, pct: 10, min: 0, max: 0 }
  });
  assert.equal(result.guestTripFee, 0);
});

test('computeMarketplaceTripPricing with custom min/max clamps correctly', () => {
  const result = computeMarketplaceTripPricing({
    subtotal: 50,
    cleaningFee: 0,
    pickupFee: 0,
    deliveryFee: 0,
    fulfillmentChoice: 'PICKUP',
    taxes: 0,
    hostProfile: null,
    platformFeeConfig: { enabled: true, pct: 10, min: 25, max: 40 }
  });
  // 50 * 0.1 = 5, clamped between [25, 40] = 25
  assert.equal(result.guestTripFee, 25);
});
