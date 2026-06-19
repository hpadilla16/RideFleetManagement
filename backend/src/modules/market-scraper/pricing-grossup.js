/**
 * Tax/fee gross-up math for tax-aware pricing (per-tenant, per-location config).
 *
 * Expedia shows the customer an ALL-IN price built from the BASE rate we upload.
 * The build differs by connection type (configured per location in Settings):
 *
 *   TITANIUM — everything compounds, customer sees "taxes and fees included":
 *       all_in = base × (1 + taxes) × (1 + brokerage)
 *
 *   AMADEUS — brokerage applies to base only, taxes shown separately/added on:
 *       all_in = base × (1 + brokerage) + base × taxes
 *              = base × (1 + brokerage + taxes)
 *
 * To compete we scrape the competitor ALL-IN, pick a target all-in (cheapest −
 * margin), then BACK-SOLVE the base to upload so that after the gross-up we land
 * just under the competitor:
 *
 *   base_to_upload = target_all_in / grossupFactor(config)
 *
 * `taxes` is the sum of the location's tax components (e.g. PR tax 11.5% + airport
 * fee 10.5% = 22%). No flat per-rental fees (Hector, 2026-06-19) → every term is a
 * percentage, so this works per-day without needing the length of rental.
 *
 * All pure (no prisma / no IO) so the money math is unit-testable in isolation.
 */

export const CONNECTION_TYPES = ['TITANIUM', 'AMADEUS'];

/** Sum the location's tax components → a fraction (0.22 for 11.5% + 10.5%). */
export function taxesFraction(config = {}) {
  const list = Array.isArray(config.taxes) ? config.taxes : [];
  const pct = list.reduce((acc, t) => acc + (Number(t?.pct) || 0), 0);
  return pct / 100;
}

function brokerageFraction(config = {}) {
  return (Number(config.brokeragePct) || 0) / 100;
}

function connType(config = {}) {
  const c = String(config.connectionType || 'TITANIUM').toUpperCase();
  return CONNECTION_TYPES.includes(c) ? c : 'TITANIUM';
}

/** Multiplier such that all_in = base × grossupFactor(config). */
export function grossupFactor(config = {}) {
  const t = taxesFraction(config);
  const b = brokerageFraction(config);
  // AMADEUS: base×(1+b) + base×t = base×(1+b+t)  → additive.
  if (connType(config) === 'AMADEUS') return 1 + b + t;
  // TITANIUM: base×(1+t)×(1+b) → compounding.
  return (1 + t) * (1 + b);
}

/** Forward: the all-in price the customer sees for a given base rate. */
export function customerAllInFromBase(base, config = {}) {
  if (base == null || base === '') return null; // Number(null) is 0 — guard it.
  const v = Number(base);
  if (!Number.isFinite(v)) return null;
  return round2(v * grossupFactor(config));
}

/** Inverse: the base rate to upload so the customer all-in equals targetAllIn. */
export function baseFromCustomerAllIn(targetAllIn, config = {}) {
  if (targetAllIn == null || targetAllIn === '') return null;
  const v = Number(targetAllIn);
  const f = grossupFactor(config);
  if (!Number.isFinite(v) || !(f > 0)) return null;
  return round2(v / f);
}

function round2(n) { return Math.round((n + Number.EPSILON) * 100) / 100; }
