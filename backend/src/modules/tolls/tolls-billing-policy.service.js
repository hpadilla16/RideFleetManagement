export function evaluateTollBillingPolicy({
  prepaidTollServiceCount = 0,
  transactions = []
} = {}) {
  const usageCount = Array.isArray(transactions) ? transactions.length : 0;
  const coveredByTollPackage = Number(prepaidTollServiceCount || 0) > 0;

  return {
    coveredByTollPackage,
    billingMode: coveredByTollPackage ? 'USAGE_ONLY' : 'CHARGEABLE',
    usageOnlyCount: coveredByTollPackage ? usageCount : 0,
    chargeableCount: coveredByTollPackage ? 0 : usageCount,
    shouldCreateChargeRows: !coveredByTollPackage,
    shouldApplyPolicyFee: !coveredByTollPackage && usageCount > 0
  };
}
