function money(value) {
  return Number(Number(value || 0).toFixed(2));
}

function resolveHostServiceFeeRate(hostProfile) {
  const averageRating = Number(hostProfile?.averageRating || 0);
  const reviewCount = Number(hostProfile?.reviewCount || 0);

  if (reviewCount >= 10 && averageRating >= 4.8) return 0.1;
  if (reviewCount >= 3 && averageRating >= 4.6) return 0.12;
  return 0.15;
}

function resolveGuestTripFee(hostGrossRevenue) {
  const estimated = money(Number(hostGrossRevenue || 0) * 0.1);
  return money(Math.min(35, Math.max(7, estimated)));
}

export function computeMarketplaceTripPricing({
  subtotal = 0,
  cleaningFee = 0,
  deliveryFee = 0,
  taxes = 0,
  hostProfile = null
} = {}) {
  const tripSubtotal = money(subtotal);
  const hostChargeFees = money(Number(cleaningFee || 0) + Number(deliveryFee || 0));
  const hostGrossRevenue = money(tripSubtotal + hostChargeFees);
  const hostServiceFeeRate = resolveHostServiceFeeRate(hostProfile);
  const hostServiceFeeRatePct = money(hostServiceFeeRate * 100);
  const hostServiceFee = money(hostGrossRevenue * hostServiceFeeRate);
  const guestTripFee = resolveGuestTripFee(hostGrossRevenue);
  const quotedFees = money(hostChargeFees + guestTripFee);
  const quotedTaxes = money(taxes);
  const quotedTotal = money(tripSubtotal + quotedFees + quotedTaxes);
  const hostEarnings = money(hostGrossRevenue - hostServiceFee);
  const platformRevenue = money(hostServiceFee + guestTripFee);

  return {
    tripSubtotal,
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
