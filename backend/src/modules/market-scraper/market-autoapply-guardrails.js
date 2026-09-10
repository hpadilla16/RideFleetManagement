/**
 * Money guardrails for the Market Intelligence auto-apply path (Engine A).
 *
 * This module is PURE (no prisma / no IO) so every fail-closed rule is unit-
 * testable in isolation and the money math can't hide behind a mock. It decides,
 * for a single (rate class × pickup date) cell, whether an MI-suggested BASE rate
 * may be written, and if so at what value.
 *
 * FAIL-CLOSED PHILOSOPHY: correctness beats coverage. When anything about the
 * decision is uncertain — no guardrail config, no clean baseline price, a move
 * beyond the allowed band — the cell is HELD (not written), never guessed.
 *
 * Two callers, two modes:
 *   - mode='auto'   : the cron. Requires FULL guardrails (floor + ceiling +
 *                     maxDeltaPct). A maxDeltaPct breach HOLDS. Missing config
 *                     HOLDS. This is the path that moves live prices unattended.
 *   - mode='manual' : a human clicked "Apply". Explicit intent lets them bypass
 *                     the per-profile enable and a maxDeltaPct breach (surfaced
 *                     as a warning), but NEVER the floor/ceiling — a human still
 *                     cannot write below floor or above ceiling.
 *
 * Independent of mode, a class with NO class-specific RateItem on the target
 * rate is ALWAYS held ('no class-specific rate (fallback)'): resolveForRental
 * would quote it via the header fallback (a known cross-pricing data gap), so an
 * MI override must not paper over a broken base.
 */

export const HOLD_REASONS = {
  GUARDRAILS_MISSING: 'guardrails not configured',
  BOUNDS_MISSING: 'floor/ceiling not configured',
  FALLBACK_CLASS: 'no class-specific rate (fallback)',
  NO_BASELINE: 'no baseline price',
  MAX_DELTA: 'maxDeltaPct breach',
  DATA_QUALITY: 'suggestion too far from the live base to be a market signal',
};

/**
 * Data-quality reject band (2026-09-10).
 *
 * A `maxDeltaPct` breach says "that is a big move". This says something else:
 * "that is not the same product". Measured at SJU the same day: LFAR carried
 * ten offers from ONE supplier and the cars were Infiniti QX50/QX60 at $46-66
 * while the tenant's LFAR base is $213. "Cheapest minus a dollar" then says
 * $45 — arithmetically perfect, a different vehicle. No competitive strategy
 * asks for a price a fifth of the current one; a sample that suggests it is
 * telling you about the sample, not about the market.
 *
 * So this HOLDS IN BOTH MODES, unlike the delta band, which a human may
 * knowingly bypass. Explicit intent is a reason to widen a band, never to
 * switch off the check that the two things being compared are comparable.
 */
export const DATA_QUALITY_FACTOR = 2;

/**
 * The band holds in AUTO unconditionally. On a MANUAL apply it still holds
 * unless the caller passes `acknowledgeDataQuality: true` — a flag deliberately
 * SEPARATE from `force`, because `force` already means "a human pressed Apply
 * now" (`market-scrape-correction.service.js:97`) and every click would
 * otherwise carry the acknowledgement silently. The escape exists because
 * seeding a base that legitimately starts far from the market — the LAX
 * bootstrap — is a real operation; it just has to be said out loud.
 */

function num(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function round2(n) { return Math.round((n + Number.EPSILON) * 100) / 100; }

/**
 * Are the AUTO guardrails fully configured for a location? Requires floorBase,
 * ceilingBase AND maxDeltaPct — auto-write REQUIRES all three (fail-closed).
 * Returns { ok, missing: string[] }.
 */
export function guardrailsConfigured(config) {
  const missing = [];
  if (!config) return { ok: false, missing: ['floorBase', 'ceilingBase', 'maxDeltaPct'] };
  if (num(config.floorBase) == null) missing.push('floorBase');
  if (num(config.ceilingBase) == null) missing.push('ceilingBase');
  if (num(config.maxDeltaPct) == null) missing.push('maxDeltaPct');
  return { ok: missing.length === 0, missing };
}

/**
 * Are the floor + ceiling bounds configured? These are HARD for EVERYONE — auto
 * AND manual. A human clicking "Apply" may bypass the per-profile enable and the
 * maxDeltaPct band (explicit intent), but can never write below floor / above
 * ceiling, and can't write at all when the bounds aren't set. Returns { ok, missing }.
 */
export function boundsConfigured(config) {
  const missing = [];
  if (num(config?.floorBase) == null) missing.push('floorBase');
  if (num(config?.ceilingBase) == null) missing.push('ceilingBase');
  return { ok: missing.length === 0, missing };
}

/**
 * Decide the fate of one MI-suggested BASE rate for a class/date cell.
 *
 * @param {object} p
 * @param {number}  p.suggestedBase        - Engine A's back-solved BASE rate to upload.
 * @param {number|null} p.currentBase       - current live resolved BASE for this class/date.
 * @param {object|null} p.config            - the location's MarketPricingConfig (floorBase/ceilingBase/maxDeltaPct).
 * @param {boolean} p.hasOwnRateItem        - does the vehicleType have its OWN RateItem on the target rate?
 * @param {boolean} [p.currentFromFallback] - did currentBase come from the header fallback (no RateItem / no override)?
 * @param {'auto'|'manual'} p.mode
 * @returns {{
 *   outcome: 'applied'|'clamped'|'held',
 *   finalDaily: number|null,   // value to write (applied/clamped); null when held
 *   deltaPct: number|null,     // signed % move vs currentBase (null if no baseline)
 *   reason: string|null,       // hold/clamp reason
 *   warnings: string[]         // non-blocking warnings (e.g. manual maxDelta breach)
 * }}
 */
export function evaluateWrite(p) {
  const {
    suggestedBase, currentBase, config,
    hasOwnRateItem, currentFromFallback = false, mode,
    acknowledgeDataQuality = false,
  } = p;
  const warnings = [];

  const suggested = num(suggestedBase);
  if (suggested == null || suggested <= 0) {
    return { outcome: 'held', finalDaily: null, deltaPct: null, reason: 'invalid suggested price', warnings };
  }

  // (1) Data-integrity gate — applies to BOTH modes. A class quoting via the
  // header fallback has a broken base; never let an MI write paper over it.
  if (!hasOwnRateItem || currentFromFallback) {
    return { outcome: 'held', finalDaily: null, deltaPct: null, reason: HOLD_REASONS.FALLBACK_CLASS, warnings };
  }

  const floor = num(config?.floorBase);
  const ceiling = num(config?.ceilingBase);
  const maxDelta = num(config?.maxDeltaPct);

  // (2) Config requirements.
  //   AUTO   : full guardrails (floor + ceiling + maxDeltaPct). Fail-closed HOLD.
  //   MANUAL : floor + ceiling are HARD (a human still cannot write unbounded, and
  //            cannot write at all without bounds). maxDeltaPct stays bypassable.
  if (mode === 'auto') {
    const g = guardrailsConfigured(config);
    if (!g.ok) {
      return {
        outcome: 'held', finalDaily: null, deltaPct: null,
        reason: `${HOLD_REASONS.GUARDRAILS_MISSING}: ${g.missing.join(', ')}`, warnings,
      };
    }
  } else {
    const b = boundsConfigured(config);
    if (!b.ok) {
      return {
        outcome: 'held', finalDaily: null, deltaPct: null,
        reason: `${HOLD_REASONS.BOUNDS_MISSING}: ${b.missing.join(', ')}`, warnings,
      };
    }
  }

  const base = num(currentBase);

  // (2b) Data-quality band — BOTH modes, and checked before the delta band
  // because it is the stronger statement: a suggestion this far from the live
  // base is evidence about the sample, not about the market. See
  // DATA_QUALITY_FACTOR.
  const dqFactor = (() => {
    const c = num(config?.dataQualityFactor);
    return c != null && c > 1 ? c : DATA_QUALITY_FACTOR;
  })();
  if (base != null && base > 0) {
    const ratio = suggested / base;
    if (ratio > dqFactor || ratio < 1 / dqFactor) {
      const detail = `${round2(ratio)}x the live base (limit ${dqFactor}x)`;
      if (!(mode === 'manual' && acknowledgeDataQuality === true)) {
        return {
          outcome: 'held',
          finalDaily: null,
          deltaPct: round2((suggested - base) / base * 100),
          reason: `${HOLD_REASONS.DATA_QUALITY}: ${detail}`,
          warnings,
        };
      }
      warnings.push(`data-quality band acknowledged: ${detail}`);
    }
  }

  // (3) maxDeltaPct band — computed vs the current live BASE.
  let deltaPct = null;
  if (base != null && base !== 0) {
    deltaPct = round2((suggested - base) / base * 100);
  }

  if (maxDelta != null) {
    if (base == null || base === 0) {
      // No clean baseline to measure against. AUTO fails closed; manual is allowed
      // (human intent) but warned.
      if (mode === 'auto') {
        return { outcome: 'held', finalDaily: null, deltaPct, reason: HOLD_REASONS.NO_BASELINE, warnings };
      }
      warnings.push('no baseline price to measure delta against');
    } else if (Math.abs(deltaPct) > maxDelta) {
      if (mode === 'auto') {
        // HOLD — never clamp a maxDelta breach (per money-safety invariant).
        return { outcome: 'held', finalDaily: null, deltaPct, reason: HOLD_REASONS.MAX_DELTA, warnings };
      }
      // Manual: explicit human intent → warn but allow. Unchanged: this is the
      // bypass the "Apply now" route documents, and the one the LAX bootstrap
      // depends on to seed a base that starts far from the market.
      warnings.push(`delta ${deltaPct}% exceeds maxDeltaPct ${maxDelta}% (allowed on manual)`);
    }
  }

  // (4) Floor / ceiling — never write outside the bound. Clamp is acceptable here
  // for BOTH modes (a bound breach is a value cap, not a data-quality reject).
  let finalDaily = round2(suggested);
  let clamped = false;
  if (floor != null && finalDaily < floor) { finalDaily = round2(floor); clamped = true; }
  if (ceiling != null && finalDaily > ceiling) { finalDaily = round2(ceiling); clamped = true; }

  return {
    outcome: clamped ? 'clamped' : 'applied',
    finalDaily,
    deltaPct,
    reason: clamped ? 'clamped to floor/ceiling' : null,
    warnings,
  };
}

/** Read the master kill switch. Both this AND the per-profile autoApply must be true to write. */
export function isMarketAutoApplyEnabled(env = process.env) {
  return String(env.MARKET_AUTOAPPLY_ENABLED || 'false').toLowerCase() === 'true';
}

export const marketAutoApplyGuardrails = {
  guardrailsConfigured,
  boundsConfigured,
  evaluateWrite,
  isMarketAutoApplyEnabled,
  HOLD_REASONS,
  DATA_QUALITY_FACTOR,
};
