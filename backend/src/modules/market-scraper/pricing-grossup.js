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
 * fee 10.5% = 22%). Percentage terms work per-day without needing the length of
 * rental.
 *
 * 2026-07-25 — FLAT PER-DAY fees. The "no flat fees" rule (Hector, 2026-06-19)
 * held until LAX's Vehicle License Fee: a flat $2.00 PER DAY (Hector,
 * 2026-07-25). A tax component may now carry `amountPerDay` instead of `pct`:
 *
 *   all_in_per_day = base × grossupFactor + flatPerDay
 *   base_to_upload = (target_all_in − flatPerDay) / grossupFactor
 *
 * Still per-day (a per-RENTAL flat fee would need the rental length and is
 * deliberately NOT supported — reject it at config time, don't guess).
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

/** Sum the location's FLAT per-day fee components in USD (LAX VLF = $2/day).
 * Negatives are clamped to 0 per entry — a negative flat fee would push the
 * inverse ABOVE the market target, the silent-overprice failure mode.
 * upsertMarketPricingConfig rejects them loudly at write time; this clamp
 * covers hand-edited rows. An entry carrying BOTH pct and amountPerDay
 * applies both (pct into the factor, amount into the flat) — intentional. */
export function flatPerDay(config = {}) {
  const list = Array.isArray(config.taxes) ? config.taxes : [];
  return list.reduce((acc, t) => acc + Math.max(0, Number(t?.amountPerDay) || 0), 0);
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
  return round2(v * grossupFactor(config) + flatPerDay(config));
}

/** Inverse: the base rate to upload so the customer all-in equals targetAllIn.
 * Affine now: subtract the flat per-day fees BEFORE dividing by the factor.
 * A target at or below the flat fees means no positive base can reach it —
 * return null (fail-closed: the caller treats it as "no suggestion"), never
 * a zero/negative money value. */
export function baseFromCustomerAllIn(targetAllIn, config = {}) {
  if (targetAllIn == null || targetAllIn === '') return null;
  const v = Number(targetAllIn);
  const f = grossupFactor(config);
  if (!Number.isFinite(v) || !(f > 0)) return null;
  const net = v - flatPerDay(config);
  if (!(net > 0)) return null;
  return round2(net / f);
}

function round2(n) { return Math.round((n + Number.EPSILON) * 100) / 100; }
