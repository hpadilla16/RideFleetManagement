import { money } from '../../lib/money.js';

export function computeCancellationRefund({
  quotedTotal = 0,
  guestTripFee = 0,
  scheduledPickupAt = null,
  cancelledAt = new Date(),
  policy = 'STANDARD'
} = {}) {
  const pickupDate = scheduledPickupAt instanceof Date ? scheduledPickupAt : (scheduledPickupAt ? new Date(scheduledPickupAt) : null);
  const cancelDate = cancelledAt instanceof Date ? cancelledAt : new Date(cancelledAt || Date.now());
  if (!pickupDate || Number.isNaN(pickupDate.getTime())) {
    return { refundAmount: 0, refundPct: 0, hoursUntilPickup: 0, baseAmount: 0, guestTripFeeRetained: money(guestTripFee), policy, reason: 'Pickup date missing — no refund calculated' };
  }
  const hoursUntilPickup = Math.max(0, (pickupDate.getTime() - cancelDate.getTime()) / (60 * 60 * 1000));
  const baseAmount = money(Number(quotedTotal || 0) - Number(guestTripFee || 0));

  let refundPct = 0;
  let reason = '';
  const normalized = String(policy || 'STANDARD').trim().toUpperCase();
  if (normalized === 'FLEXIBLE') {
    if (hoursUntilPickup >= 24) { refundPct = 100; reason = 'Cancelled 24+ hours before pickup — full refund'; }
    else { refundPct = 50; reason = 'Cancelled less than 24 hours before pickup — 50% refund of base charges'; }
  } else if (normalized === 'STRICT') {
    if (hoursUntilPickup >= 72) { refundPct = 100; reason = 'Cancelled 72+ hours before pickup — full refund'; }
    else if (hoursUntilPickup >= 24) { refundPct = 50; reason = 'Cancelled 24–72 hours before pickup — 50% refund of base charges'; }
    else { refundPct = 0; reason = 'Cancelled less than 24 hours before pickup — no refund'; }
  } else {
    if (hoursUntilPickup >= 48) { refundPct = 100; reason = 'Cancelled 48+ hours before pickup — full refund'; }
    else if (hoursUntilPickup >= 24) { refundPct = 50; reason = 'Cancelled 24–48 hours before pickup — 50% refund of base charges'; }
    else { refundPct = 0; reason = 'Cancelled less than 24 hours before pickup — no refund'; }
  }

  return {
    refundAmount: money(baseAmount * (refundPct / 100)),
    refundPct,
    hoursUntilPickup: Math.round(hoursUntilPickup),
    baseAmount,
    guestTripFeeRetained: money(Number(guestTripFee || 0)),
    policy: normalized,
    reason
  };
}

function resolveHostServiceFeeRate(hostProfile) {
  const averageRating = Number(hostProfile?.averageRating || 0);
  const reviewCount = Number(hostProfile?.reviewCount || 0);

  if (reviewCount >= 10 && averageRating >= 4.8) return 0.1;
  if (reviewCount >= 3 && averageRating >= 4.6) return 0.12;
  return 0.15;
}

function resolveGuestTripFee(hostGrossRevenue, platformFeeConfig = null) {
  // Default behavior matches the original hardcoded values
  // (10% / $7 min / $35 max) so tenants without explicit config
  // get the existing behavior. When platformFeeEnabled === false,
  // returns 0 — operator disables the platform cut entirely.
  const enabled = platformFeeConfig?.enabled !== false;
  if (!enabled) return 0;

  const pct = Number(platformFeeConfig?.pct ?? 10);
  const min = Number(platformFeeConfig?.min ?? 7);
  const max = Number(platformFeeConfig?.max ?? 35);
  const estimated = money(Number(hostGrossRevenue || 0) * (pct / 100));
  return money(Math.min(max, Math.max(min, estimated)));
}

export function computeMarketplaceTripPricing({
  subtotal = 0,
  cleaningFee = 0,
  pickupFee = 0,
  deliveryFee = 0,
  fulfillmentChoice = 'PICKUP',
  taxes = 0,
  hostProfile = null,
  platformFeeConfig = null
} = {}) {
  const tripSubtotal = money(subtotal);
  const normalizedChoice = String(fulfillmentChoice || 'PICKUP').trim().toUpperCase() === 'DELIVERY' ? 'DELIVERY' : 'PICKUP';
  const selectedFulfillmentFee = money(normalizedChoice === 'DELIVERY' ? Number(deliveryFee || 0) : Number(pickupFee || 0));
  const hostChargeFees = money(Number(cleaningFee || 0) + selectedFulfillmentFee);
  const hostGrossRevenue = money(tripSubtotal + hostChargeFees);
  const hostServiceFeeRate = resolveHostServiceFeeRate(hostProfile);
  const hostServiceFeeRatePct = money(hostServiceFeeRate * 100);
  const hostServiceFee = money(hostGrossRevenue * hostServiceFeeRate);
  const guestTripFee = resolveGuestTripFee(hostGrossRevenue, platformFeeConfig);
  const quotedFees = money(hostChargeFees + guestTripFee);
  const quotedTaxes = money(taxes);
  const quotedTotal = money(tripSubtotal + quotedFees + quotedTaxes);
  const hostEarnings = money(hostGrossRevenue - hostServiceFee);
  const platformRevenue = money(hostServiceFee + guestTripFee);

  return {
    tripSubtotal,
    fulfillmentChoice: normalizedChoice,
    selectedFulfillmentFee,
    hostChargeFees,
    guestTripFee,
    quotedTaxes,
    quotedFees,
    quotedTotal,
    hostGrossRevenue,
    hostServiceFeeRate: hostServiceFeeRatePct,
    hostServiceFee,
    hostEarnings,
    platformRevenue,
    platformFee: platformRevenue
  };
}

export function tenantPlatformFeeConfig(tenant) {
  if (!tenant) return null;
  return {
    enabled: tenant.platformFeeEnabled !== false,
    pct: Number(tenant.platformFeePct ?? 10),
    min: Number(tenant.platformFeeMin ?? 7),
    max: Number(tenant.platformFeeMax ?? 35)
  };
}
