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

/**
 * COMPETITOR side of the same coin (2026-09-10).
 *
 * The module header above assumes we scrape the competitor ALL-IN. Measured
 * that day, we do not: Kayak's number is a TEASER. Expedia's legacy rows carry
 * both halves and they differ in 15,864 of 17,011 rows; against those, Kayak
 * sits at 0.871x the teaser and 0.582x the all-in, weighted over 5,188 rows and
 * seven classes at SJU. So ranking our grossed-up price against their raw quote
 * compares what our customer pays against what theirs is merely shown -- which
 * is why SJU read "#4 of 4" while being roughly at market.
 *
 * This lifts a competitor quote to the all-in their customer will pay:
 *
 *   competitor_all_in = quoted x (1 + taxes) + flatPerDay
 *
 * BROKERAGE IS DELIBERATELY EXCLUDED. It is our channel cost, already inside
 * the price they are advertising through theirs. Including it would inflate
 * every rival by our own commission.
 *
 * `basis` travels with the number so a screen can label it and a suggestion can
 * be audited:
 *   MEASURED    - the location carries a calibrated factor (config.competitorAllInFactor)
 *   TAXES_ONLY  - built from the location's own tax + flat-fee layer
 *   QUOTED      - no tax layer configured: the quote passes through untouched,
 *                 and the comparison is quote-vs-base. Same as before this
 *                 existed, so a location without config behaves identically.
 *
 * Known residual: at SJU the configured layer is 1.22 while Expedia's own
 * all-in/teaser ratio measured 1.444, so a TAXES_ONLY basis still understates
 * the competition by ~18%. That gap is fees Kayak omits beyond the configured
 * taxes; closing it needs a per-airport calibrated factor, which is what
 * MEASURED is for.
 */
export function competitorAllInBasis(config = {}) {
  const calibrated = Number(config?.competitorAllInFactor);
  if (Number.isFinite(calibrated) && calibrated > 1) {
    return { factor: calibrated, flat: flatPerDay(config), basis: 'MEASURED' };
  }
  const taxes = taxesFraction(config);
  const flat = flatPerDay(config);
  if (taxes > 0 || flat > 0) return { factor: 1 + taxes, flat, basis: 'TAXES_ONLY' };
  return { factor: 1, flat: 0, basis: 'QUOTED' };
}

/** A competitor quote lifted to the all-in their customer pays. Null in, null out. */
export function competitorAllIn(quoted, config = {}) {
  const q = Number(quoted);
  if (!Number.isFinite(q)) return null;
  const { factor, flat } = competitorAllInBasis(config);
  return Math.round((q * factor + flat) * 100) / 100;
}

/**
 * Re-solve a base rate for a DIFFERENT connection type at the same location.
 *
 * Hector, 2026-09-08: "market intelligence hace precios dependiendo si es
 * amadeus o titanium, pero para una cuenta que tiene multiples integraciones y
 * no todas son las mismas, deberian poder configurarlo por sedes y por
 * integracion".
 *
 * The engine maintains ONE base per class, back-solved under the location's
 * single connectionType, and every writeback then pushes that same number to
 * every integration. When two integrations at one sede sit on different
 * connections that is wrong for one of them: the customer-facing all-in is
 * composed differently, so the same base lands at a different shelf price and
 * only one of the two is positioned where the strategy intended.
 *
 * The connection-independent quantity is the ALL-IN — what the customer sees.
 * So: reconstruct it from the stored base under the type it was solved for,
 * then back-solve again under the target type.
 *
 *   all_in   = base_from × factor_from + flat
 *   base_to  = (all_in − flat) / factor_to
 *            = base_from × factor_from / factor_to
 *
 * The flat per-day fees CANCEL, and that is not a shortcut — they are the
 * location's own licence and facility charges, identical on both connections.
 * Only the shape of the tax/brokerage composition differs, which is exactly the
 * factor. Written the long way anyway, through the two existing functions, so
 * this cannot drift from the forward math it has to agree with.
 *
 * Returns the input unchanged when the two types are the same, and null when
 * either side cannot be solved — never a guess.
 */
export function rebaseForConnection(base, config = {}, toConnectionType) {
  const to = String(toConnectionType || '').toUpperCase();
  if (!CONNECTION_TYPES.includes(to)) return null;
  if (connType(config) === to) return base == null ? null : round2(Number(base));

  const allIn = customerAllInFromBase(base, config);
  if (allIn == null) return null;
  return baseFromCustomerAllIn(allIn, { ...config, connectionType: to });
}

function round2(n) { return Math.round((n + Number.EPSILON) * 100) / 100; }
