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
};

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
      // Manual: explicit human intent → warn but allow.
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
};
