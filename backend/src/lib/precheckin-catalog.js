/**
 * Pre-check-in upsell catalog enrichment (2026-06-27).
 *
 * Pure helper (no DB) used by GET /api/public/customer-info/:token to:
 *  - apply the tenant's pre-check-in discount to every add-on price (insurance
 *    plans + additional services) for display, keeping the counter price for a
 *    strike-through;
 *  - flag add-ons already on the reservation so the upsell can hide them — e.g.
 *    if insurance is already selected, surface the OTHER services (pre-paid fuel,
 *    toll pass, etc.) instead of re-offering protection.
 */

export function makeDiscountFn(discount) {
  const d = discount && discount.enabled ? discount : null;
  return (amount) => {
    const a = Number(amount || 0);
    if (!d || !a) return Number(a.toFixed(2));
    if (String(d.type).toUpperCase() === 'PERCENTAGE') {
      return Number((a * (1 - Number(d.value || 0) / 100)).toFixed(2));
    }
    return Number(Math.max(0, a - Number(d.value || 0)).toFixed(2));
  };
}

export function enrichPrecheckinCatalog({ insurancePlans = [], additionalServices = [], existingCharges = [], precheckinDiscount = null } = {}) {
  const applyDiscount = makeDiscountFn(precheckinDiscount);
  const selected = (existingCharges || []).filter((c) => c && c.selected);
  const hasInsurance = selected.some((c) => String(c.source || '').toUpperCase() === 'INSURANCE');
  const serviceRefIds = new Set(
    selected
      .filter((c) => String(c.source || '').toUpperCase() === 'ADDITIONAL_SERVICE_PRECHECKIN')
      .map((c) => c.sourceRefId)
      .filter(Boolean),
  );

  const plans = (insurancePlans || [])
    .filter((p) => p && p.isActive !== false)
    .map((p) => {
      const amount = Number(p.amount || p.rate || p.total || 0);
      const discountedAmount = applyDiscount(amount);
      return { ...p, amount, discountedAmount, discounted: discountedAmount < amount, alreadyOnReservation: hasInsurance };
    });

  const services = (additionalServices || []).map((s) => {
    const rate = Number(s.rate || 0);
    const dailyRate = Number(s.dailyRate || 0);
    return {
      ...s,
      discountedRate: applyDiscount(rate),
      discountedDailyRate: applyDiscount(dailyRate),
      discounted: applyDiscount(rate) < rate || applyDiscount(dailyRate) < dailyRate,
      alreadyOnReservation: serviceRefIds.has(s.id),
    };
  });

  return { insurancePlans: plans, additionalServices: services };
}

export default enrichPrecheckinCatalog;
