/**
 * Commission service catalog — single source of truth for the flat-rate
 * "$X per attached service" commission scheme that mirrors Hector's April
 * 2026 hand-built PDF.
 *
 * Used by:
 *   - syncAgreementCommissionSnapshot (rental-agreements.service.js)
 *     as a fallback when no CommissionPlan rule covers a charge. This is
 *     the path that determines what gets written to the AgreementCommission
 *     ledger, which the Commission Payouts report reads.
 *   - commission-sales-performance.report.js
 *     for the inline per-agent commission calculation (attach × commPerSale).
 *   - agent-track-record.report.js
 *     same inline calculation, month-over-month.
 *
 * commPerSale is in DOLLARS. Service matching: by `code` first (exact uppercase
 * match against the entry's codes[]), then a fuzzy name match against
 * namePatterns[]. Handles both the iPOS Transact CSV import flow and the
 * native RFM line items.
 *
 * If you add a service here, the three reports + the sync will pick it up
 * automatically. No DB migration needed — this is pure code config.
 */

export const SERVICE_CATALOG = [
  { slug: 'TOLLS',             label: 'Tolls',             codes: ['TOLLS', 'TOLL'],                  namePatterns: [/tolls?/i],                                            commPerSale: 1, benchmark: '85%+' },
  { slug: 'TIRE_GLASS',        label: 'Tire & Glass',      codes: ['TIRE_GLASS', 'TG'],               namePatterns: [/tire.*glass/i],                                       commPerSale: 1, benchmark: '60%+' },
  { slug: 'ROADSIDE',          label: 'Roadside',          codes: ['ROADSIDE', 'RS'],                 namePatterns: [/roadside/i],                                          commPerSale: 1, benchmark: '60%+' },
  { slug: 'LIABILITY',         label: 'Liability',         codes: ['LIABILITY', 'LIAB'],              namePatterns: [/liab/i],                                              commPerSale: 2, benchmark: '55%+' },
  { slug: 'INSURANCE',         label: 'Insurance',         codes: ['INSURANCE', 'INS'],               namePatterns: [/insurance/i],                                         commPerSale: 3, benchmark: '45–55%' },
  { slug: 'ADDITIONAL_DRIVER', label: 'Additional Driver', codes: ['ADDITIONAL_DRIVER', 'ADD_DRIVER'],namePatterns: [/additional.*driver/i, /add.*driver/i],                commPerSale: 1, benchmark: 'demand-led' },
  { slug: 'CAR_SEAT',          label: 'Car Seat',          codes: ['CAR_SEAT', 'CARSEAT'],            namePatterns: [/car.*seat/i],                                         commPerSale: 1, benchmark: 'demand-led' },
  { slug: 'PRE_PAID_GAS',      label: 'Pre-Paid Gas',      codes: ['PRE_PAID_GAS', 'GAS_PREPAY'],     namePatterns: [/pre.?paid.*gas/i, /gas.*pre.?paid/i],                 commPerSale: 1, benchmark: '15%+' },
];

/**
 * Match a charge row (with .code and .name) against a SERVICE_CATALOG entry.
 * Code match wins; name pattern is the fallback for legacy/import rows that
 * didn't carry a code.
 */
export function matchesService(charge, service) {
  if (charge?.code && service.codes.includes(String(charge.code).toUpperCase())) return true;
  const name = String(charge?.name || '');
  return service.namePatterns.some((re) => re.test(name));
}

/**
 * Resolve which SERVICE_CATALOG entry (if any) a charge maps to.
 * Returns null if no entry matches.
 */
export function resolveCatalogEntry(charge) {
  for (const service of SERVICE_CATALOG) {
    if (matchesService(charge, service)) return service;
  }
  return null;
}
