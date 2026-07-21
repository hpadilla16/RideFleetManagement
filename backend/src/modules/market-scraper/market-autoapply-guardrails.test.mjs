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
    const cfg = { floorBase: 20, ceilingBase: 200, maxDeltaPct: 100000 };
    for (const mode of ['auto', 'manual']) {
      const d = evaluateWrite({ suggestedBase: 10, currentBase: 21, config: cfg, hasOwnRateItem: true, mode });
      assert.equal(d.outcome, 'clamped');
      assert.equal(d.finalDaily, 20);
    }
  });

  it('above ceiling clamps DOWN to ceiling', () => {
    // suggested 500, ceiling 200; current 190 so delta within band
    const d = evaluateWrite({ suggestedBase: 500, currentBase: 190, config: FULL_CFG, hasOwnRateItem: true, mode: 'manual' });
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
