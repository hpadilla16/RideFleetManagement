import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  guardrailsConfigured,
  boundsConfigured,
  evaluateWrite,
  isMarketAutoApplyEnabled,
  HOLD_REASONS,
} from './market-autoapply-guardrails.js';

// Pure, DB-free money-guardrail invariants. Each block asserts the SAFE outcome
// and (where noted) the exact condition that must flip for the guard to bite.

const FULL_CFG = { floorBase: 20, ceilingBase: 200, maxDeltaPct: 15 };

describe('guardrailsConfigured — AUTO requires floor + ceiling + maxDeltaPct', () => {
  it('ok only when all three present', () => {
    assert.equal(guardrailsConfigured(FULL_CFG).ok, true);
  });
  it('not ok when config missing entirely', () => {
    const g = guardrailsConfigured(null);
    assert.equal(g.ok, false);
    assert.deepEqual(g.missing, ['floorBase', 'ceilingBase', 'maxDeltaPct']);
  });
  it('not ok when maxDeltaPct missing (the new field)', () => {
    const g = guardrailsConfigured({ floorBase: 20, ceilingBase: 200 });
    assert.equal(g.ok, false);
    assert.deepEqual(g.missing, ['maxDeltaPct']);
  });
});

describe('boundsConfigured — floor+ceiling are HARD for everyone (MC3)', () => {
  it('ok only when floor AND ceiling present', () => {
    assert.equal(boundsConfigured({ floorBase: 20, ceilingBase: 200 }).ok, true);
    assert.equal(boundsConfigured({ floorBase: 20 }).ok, false);
    assert.equal(boundsConfigured(null).ok, false);
  });
});

describe('evaluateWrite — fail-closed HOLDs', () => {
  it('AUTO with no config HOLDs (guardrails not configured)', () => {
    const d = evaluateWrite({ suggestedBase: 50, currentBase: 55, config: null, hasOwnRateItem: true, mode: 'auto' });
    assert.equal(d.outcome, 'held');
    assert.match(d.reason, /guardrails not configured/);
    assert.equal(d.finalDaily, null);
  });

  it('MANUAL with no bounds HOLDs — a human still cannot write unbounded (MC3)', () => {
    const d = evaluateWrite({ suggestedBase: 50, currentBase: 55, config: null, hasOwnRateItem: true, mode: 'manual' });
    assert.equal(d.outcome, 'held');
    assert.match(d.reason, /floor\/ceiling not configured/);
    assert.equal(d.finalDaily, null);
  });

  it('MANUAL with bounds but NO maxDeltaPct still applies (band optional for humans)', () => {
    const d = evaluateWrite({ suggestedBase: 50, currentBase: 55, config: { floorBase: 20, ceilingBase: 200 }, hasOwnRateItem: true, mode: 'manual' });
    assert.equal(d.outcome, 'applied');
    assert.equal(d.finalDaily, 50);
  });

  it('a class with NO own RateItem HOLDs (header-fallback data gap) — both modes', () => {
    for (const mode of ['auto', 'manual']) {
      const d = evaluateWrite({ suggestedBase: 50, currentBase: 55, config: FULL_CFG, hasOwnRateItem: false, mode });
      assert.equal(d.outcome, 'held');
      assert.equal(d.reason, HOLD_REASONS.FALLBACK_CLASS);
    }
  });

  it('currentFromFallback flag HOLDs even if a RateItem is claimed', () => {
    const d = evaluateWrite({ suggestedBase: 50, currentBase: 55, config: FULL_CFG, hasOwnRateItem: true, currentFromFallback: true, mode: 'auto' });
    assert.equal(d.outcome, 'held');
    assert.equal(d.reason, HOLD_REASONS.FALLBACK_CLASS);
  });

  it('AUTO with no baseline price HOLDs (can\'t measure delta)', () => {
    const d = evaluateWrite({ suggestedBase: 50, currentBase: 0, config: FULL_CFG, hasOwnRateItem: true, mode: 'auto' });
    assert.equal(d.outcome, 'held');
    assert.equal(d.reason, HOLD_REASONS.NO_BASELINE);
  });
});

describe('evaluateWrite — maxDeltaPct band', () => {
  it('AUTO: within band applies', () => {
    // 55 -> 50 is -9.09%, within 15%
    const d = evaluateWrite({ suggestedBase: 50, currentBase: 55, config: FULL_CFG, hasOwnRateItem: true, mode: 'auto' });
    assert.equal(d.outcome, 'applied');
    assert.equal(d.finalDaily, 50);
    assert.equal(d.deltaPct, -9.09);
  });

  it('AUTO: beyond band is HELD, never applied, never clamped (money invariant)', () => {
    // 100 -> 50 is -50%, way beyond 15%. Also below no floor issue (floor 20).
    const d = evaluateWrite({ suggestedBase: 50, currentBase: 100, config: FULL_CFG, hasOwnRateItem: true, mode: 'auto' });
    assert.equal(d.outcome, 'held');
    assert.equal(d.reason, HOLD_REASONS.MAX_DELTA);
    assert.equal(d.finalDaily, null);
    // BITE: if the code clamped instead of holding, finalDaily would be a number.
  });

  it('MANUAL: beyond band is ALLOWED with a warning (human intent)', () => {
    const d = evaluateWrite({ suggestedBase: 50, currentBase: 100, config: FULL_CFG, hasOwnRateItem: true, mode: 'manual' });
    assert.equal(d.outcome, 'applied');
    assert.equal(d.finalDaily, 50);
    assert.ok(d.warnings.some((w) => /exceeds maxDeltaPct/.test(w)));
  });
});

describe('evaluateWrite — floor / ceiling (never write outside the bound)', () => {
  it('below floor clamps UP to floor (both modes)', () => {
    // Large maxDeltaPct so the band doesn't HOLD before the floor clamp is reached.
    // currentBase moved 21 -> 15 on 2026-09-10: 10 against 21 is 0.48x the live
    // base, which the data-quality band now HOLDS before any clamp is reached
    // (see the companion test below). The clamp itself is unchanged.
    const cfg = { floorBase: 20, ceilingBase: 200, maxDeltaPct: 100000 };
    for (const mode of ['auto', 'manual']) {
      const d = evaluateWrite({ suggestedBase: 10, currentBase: 15, config: cfg, hasOwnRateItem: true, mode });
      assert.equal(d.outcome, 'clamped');
      assert.equal(d.finalDaily, 20);
    }
  });

  it('above ceiling clamps DOWN to ceiling', () => {
    // suggested 240, ceiling 200; current 190. Was 500 until 2026-09-10, which
    // is 2.6x the live base and is now a data-quality HOLD rather than a clamp.
    const d = evaluateWrite({ suggestedBase: 240, currentBase: 190, config: FULL_CFG, hasOwnRateItem: true, mode: 'manual' });
    assert.equal(d.outcome, 'clamped');
    assert.equal(d.finalDaily, 200);
  });

  it('never returns a finalDaily below floor or above ceiling', () => {
    const lots = [1, 5, 19.99, 20, 100, 200, 200.01, 999];
    for (const s of lots) {
      const d = evaluateWrite({ suggestedBase: s, currentBase: 100, config: { floorBase: 20, ceilingBase: 200, maxDeltaPct: 100000 }, hasOwnRateItem: true, mode: 'manual' });
      if (d.finalDaily != null) {
        assert.ok(d.finalDaily >= 20, `finalDaily ${d.finalDaily} below floor`);
        assert.ok(d.finalDaily <= 200, `finalDaily ${d.finalDaily} above ceiling`);
      }
    }
  });
});

describe('isMarketAutoApplyEnabled — master kill switch', () => {
  it('defaults to false', () => {
    assert.equal(isMarketAutoApplyEnabled({}), false);
  });
  it('only literal "true" enables', () => {
    assert.equal(isMarketAutoApplyEnabled({ MARKET_AUTOAPPLY_ENABLED: 'true' }), true);
    assert.equal(isMarketAutoApplyEnabled({ MARKET_AUTOAPPLY_ENABLED: 'TRUE' }), true);
    assert.equal(isMarketAutoApplyEnabled({ MARKET_AUTOAPPLY_ENABLED: '1' }), false);
    assert.equal(isMarketAutoApplyEnabled({ MARKET_AUTOAPPLY_ENABLED: 'yes' }), false);
    assert.equal(isMarketAutoApplyEnabled({ MARKET_AUTOAPPLY_ENABLED: 'false' }), false);
  });
});

// ---------------------------------------------------------------------------
// Data-quality band (2026-09-10).
//
// Measured at SJU that day: LFAR held ten offers from ONE supplier and the cars
// were Infiniti QX50/QX60 at $46-66, while the tenant's LFAR base is $213.
// "Cheapest minus a dollar" then says $45 — arithmetically perfect, a different
// vehicle. A maxDeltaPct breach says "big move"; this says "not the same
// product", so it holds in BOTH modes, where the delta band does not.
//
// The escape is deliberately awkward: `acknowledgeDataQuality` is separate from
// `force`, because `force` already means "a human pressed Apply now" and would
// otherwise carry the acknowledgement on every click.
// ---------------------------------------------------------------------------
describe('evaluateWrite — data-quality band', () => {
  const CFG = { floorBase: 1, ceilingBase: 9999, maxDeltaPct: 100000 };

  it('THE LFAR CASE: a suggestion a fifth of the live base is HELD in auto AND manual', () => {
    for (const mode of ['auto', 'manual']) {
      const d = evaluateWrite({ suggestedBase: 45.08, currentBase: 213.07, config: CFG, hasOwnRateItem: true, mode });
      assert.equal(d.outcome, 'held', mode);
      assert.equal(d.finalDaily, null, 'nothing is written');
      assert.match(d.reason, /too far from the live base/);
      assert.match(d.reason, /0\.21x/, 'the reason names the ratio a human can check');
    }
  });

  it('holds a suggestion more than 2x the live base', () => {
    const d = evaluateWrite({ suggestedBase: 500, currentBase: 190, config: CFG, hasOwnRateItem: true, mode: 'manual' });
    assert.equal(d.outcome, 'held');
    assert.match(d.reason, /2\.63x/);
  });

  it('the band is a RATIO, not a delta — it fires however wide maxDeltaPct is', () => {
    // maxDeltaPct 100000 cannot save it: the two checks answer different questions.
    const d = evaluateWrite({ suggestedBase: 1, currentBase: 100, config: CFG, hasOwnRateItem: true, mode: 'auto' });
    assert.equal(d.outcome, 'held');
    assert.match(d.reason, /too far from the live base/);
  });

  it('the edges are inclusive: exactly 2x and exactly half still write', () => {
    // A hard cut at the boundary would make the band feel arbitrary to whoever
    // reads the number on screen.
    for (const [s, b] of [[200, 100], [50, 100]]) {
      const d = evaluateWrite({ suggestedBase: s, currentBase: b, config: CFG, hasOwnRateItem: true, mode: 'auto' });
      assert.notEqual(d.outcome, 'held', `${s} vs ${b}`);
    }
  });

  it('an ordinary move is untouched', () => {
    const d = evaluateWrite({ suggestedBase: 105, currentBase: 100, config: CFG, hasOwnRateItem: true, mode: 'auto' });
    assert.equal(d.outcome, 'applied');
    assert.equal(d.finalDaily, 105);
  });

  it('MANUAL + acknowledgeDataQuality writes it, and says the band was acknowledged', () => {
    // This is the seed-the-base operation (the LAX bootstrap) — still possible,
    // now on the record.
    const d = evaluateWrite({ suggestedBase: 500, currentBase: 190, config: CFG, hasOwnRateItem: true, mode: 'manual', acknowledgeDataQuality: true });
    assert.equal(d.outcome, 'applied');
    assert.equal(d.finalDaily, 500);
    assert.ok(d.warnings.some((w) => /acknowledged/.test(w)), 'the bypass leaves a trace');
  });

  it('the acknowledgement does NOT work in auto — a cron cannot vouch for a sample', () => {
    const d = evaluateWrite({ suggestedBase: 500, currentBase: 190, config: CFG, hasOwnRateItem: true, mode: 'auto', acknowledgeDataQuality: true });
    assert.equal(d.outcome, 'held');
  });

  it('the acknowledgement does not disable the OTHER guardrails', () => {
    // Floor/ceiling are values, not data quality: they still clamp.
    const d = evaluateWrite({
      suggestedBase: 500, currentBase: 190, config: { floorBase: 20, ceilingBase: 200, maxDeltaPct: 100000 },
      hasOwnRateItem: true, mode: 'manual', acknowledgeDataQuality: true,
    });
    assert.equal(d.outcome, 'clamped');
    assert.equal(d.finalDaily, 200);
  });

  it('a per-location dataQualityFactor overrides the default', () => {
    const cfg = { ...CFG, dataQualityFactor: 5 };
    const d = evaluateWrite({ suggestedBase: 500, currentBase: 190, config: cfg, hasOwnRateItem: true, mode: 'auto' });
    assert.equal(d.outcome, 'applied', '2.63x is inside a 5x band');
  });

  it('a nonsense factor falls back to the default rather than disabling the band', () => {
    for (const bad of [0, 1, -3, 'abc', null]) {
      const d = evaluateWrite({ suggestedBase: 45.08, currentBase: 213.07, config: { ...CFG, dataQualityFactor: bad }, hasOwnRateItem: true, mode: 'auto' });
      assert.equal(d.outcome, 'held', `factor ${JSON.stringify(bad)}`);
    }
  });

  it('with no baseline there is no ratio to judge, and the band stays out of it', () => {
    // currentBase 0/null is the NO_BASELINE case, which the delta band owns.
    const d = evaluateWrite({ suggestedBase: 500, currentBase: 0, config: { floorBase: 1, ceilingBase: 9999 }, hasOwnRateItem: true, mode: 'manual' });
    assert.equal(/too far from the live base/.test(d.reason || ''), false, 'no ratio exists, so the band must not speak');
    // And in AUTO the same shape is still held, by NO_BASELINE, not by this band.
    const a = evaluateWrite({ suggestedBase: 500, currentBase: 0, config: { floorBase: 1, ceilingBase: 9999, maxDeltaPct: 15 }, hasOwnRateItem: true, mode: 'auto' });
    assert.equal(a.outcome, 'held');
    assert.match(a.reason, /baseline/);
  });
});
