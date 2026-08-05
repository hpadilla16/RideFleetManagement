/**
 * Engine B must look at fleet utilization and RAISE prices per the tenant's
 * tier settings (Hector, 2026-08-06: "asegurate que los precios de MI esten
 * mirando utilization rate y que estan subiendo basado de los settings").
 *
 * Found live: IRC had the full tier ladder configured on SJU while FFAR sat at
 * 100% projected utilization priced near its floor — the ladder existed only
 * on the comparison screen, and the engine that writes Rate.daily ignored it.
 */
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://u:p@127.0.0.1:5432/none';

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const { applyUtilizationLift } = await import('./pricing-suggestion-engine.service.js');

// IRC's REAL SJU ladder, verbatim from MarketPricingConfig.utilizationRules.
const IRC_RULES = [
  { n: 3, type: 'NTH_CHEAPEST', fromPct: 60 },
  { n: 5, type: 'NTH_CHEAPEST', fromPct: 70 },
  { type: 'MARKET', fromPct: 85 },
  { pct: 15, type: 'MARKET_PCT', fromPct: 90 },
  { pct: 500, type: 'MARKET_PCT', fromPct: 100 },
];

// A market of 7 vendors, ascending. Median = 60.
const PRICES = [40, 45, 52, 60, 75, 90, 120];

describe('applyUtilizationLift', () => {
  it('below the first rung nothing changes — empty fleet keeps chasing the market', () => {
    const out = applyUtilizationLift({ paddedPrice: 44.1, pricesAsc: PRICES, utilization: 0.45, rules: IRC_RULES });
    assert.deepEqual(out, { price: 44.1, utilization: 0.45, tier: null, lifted: false });
  });

  it('climbs the ladder exactly as configured', () => {
    // 65% → 3rd cheapest (52)
    assert.equal(applyUtilizationLift({ paddedPrice: 44.1, pricesAsc: PRICES, utilization: 0.65, rules: IRC_RULES }).price, 52);
    // 75% → 5th cheapest (75)
    assert.equal(applyUtilizationLift({ paddedPrice: 44.1, pricesAsc: PRICES, utilization: 0.75, rules: IRC_RULES }).price, 75);
    // 87% → market median (60)... which is BELOW the 5th-cheapest — see the
    // monotonicity test for why that still never lowers a higher base.
    assert.equal(applyUtilizationLift({ paddedPrice: 44.1, pricesAsc: PRICES, utilization: 0.87, rules: IRC_RULES }).price, 60);
    // 92% → median +15% (69)
    assert.equal(applyUtilizationLift({ paddedPrice: 44.1, pricesAsc: PRICES, utilization: 0.92, rules: IRC_RULES }).price, 69);
    // 100% → median +500% (360): the sold-out class prices itself out — the
    // rule ceiling clamps it afterwards, which is the point.
    const soldOut = applyUtilizationLift({ paddedPrice: 44.1, pricesAsc: PRICES, utilization: 1, rules: IRC_RULES });
    assert.equal(soldOut.price, 360);
    assert.equal(soldOut.lifted, true);
    assert.equal(soldOut.tier.fromPct, 100);
  });

  it('NEVER lowers the price — a tier below the strategy target is ignored', () => {
    // Base already at 80 (say a CHASE_VENDOR match); the 85% tier says median
    // (60). The comparison screen would REPLACE; the engine must not price a
    // fuller fleet cheaper.
    const out = applyUtilizationLift({ paddedPrice: 80, pricesAsc: PRICES, utilization: 0.87, rules: IRC_RULES });
    assert.equal(out.price, 80);
    assert.equal(out.lifted, false);
    assert.equal(out.tier.fromPct, 85, 'the tier is still reported for the money trail');
  });

  it('no utilization data or no rules → identical to the old behavior', () => {
    assert.equal(applyUtilizationLift({ paddedPrice: 44.1, pricesAsc: PRICES, utilization: null, rules: IRC_RULES }).price, 44.1);
    assert.equal(applyUtilizationLift({ paddedPrice: 44.1, pricesAsc: PRICES, utilization: 0.99, rules: [] }).price, 44.1);
    assert.equal(applyUtilizationLift({ paddedPrice: 44.1, pricesAsc: [], utilization: 0.99, rules: IRC_RULES }).price, 44.1,
      'an empty market cannot resolve a positional tier — keep the base');
  });

  it('the live FFAR case: 100% utilization lifts a floor-hugging price to the ceiling clamp zone', () => {
    // FFAR was 43.51 (2nd cheapest −2%) while sold out. With the ladder wired,
    // 100% → median×6 — far above; the rule's own ceiling (108.78) then clamps
    // in evaluateRule, and autoMaxDeltaPct routes it to the inbox. Here we
    // assert the lift itself.
    const out = applyUtilizationLift({ paddedPrice: 43.51, pricesAsc: [41.33, 42.67, 44, 60, 80], utilization: 1, rules: IRC_RULES });
    assert.equal(out.price, 264, 'median 44 × (1+500%)');
    assert.equal(out.lifted, true);
  });
});
