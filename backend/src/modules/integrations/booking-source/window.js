/**
 * Shared date-window math for booking-source integrations (R0 extraction,
 * 2026-07-13).
 *
 * economy.constants.js and nu.constants.js carried VERBATIM duplicates of
 * normalizeDays / effectiveWindowDays / windowBoundsForConfig (Economy adds the
 * union-window pair for its multi-area fetch). The only real difference was the
 * env-default pair each source reads (ECONOMY_DATE_WINDOW_* vs NU_DATE_WINDOW_*),
 * so the shared helpers are built by a factory that takes those defaults —
 * each source keeps its own env keys while the math can never drift apart.
 *
 * NOT wired into economy/nu yet — R0 ships the shared code + tests only; the
 * per-source constants keep their own copies until the re-wire phase.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/** Coerce a nullable per-config value to a finite non-negative day count, or null. */
export function normalizeDays(v) {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/**
 * Build the window helpers for one source. `defaults` are the source's env-
 * resolved fallback days (captured once, exactly like the module-load-time
 * Number(process.env...) reads in the per-source constants).
 *
 * @param {{ defaultLookbackDays: number, defaultLookaheadDays: number }} defaults
 * @returns {{
 *   effectiveWindowDays: (config?: object) => { lookbackDays: number, lookaheadDays: number },
 *   windowBoundsForConfig: (config?: object, now?: number) => { dateFrom: Date, dateTo: Date },
 *   unionWindowDays: (configs?: object[]) => { lookbackDays: number, lookaheadDays: number },
 *   unionWindowBounds: (configs?: object[], now?: number) => { dateFrom: Date, dateTo: Date },
 * }}
 */
export function createWindowHelpers({ defaultLookbackDays, defaultLookaheadDays }) {
  // Effective [lookbackDays, lookaheadDays] for a single config row, applying
  // the source-default fallback when a column is null. Pure.
  function effectiveWindowDays(config = {}) {
    const back = normalizeDays(config?.lookbackDays);
    const ahead = normalizeDays(config?.lookaheadDays);
    return {
      lookbackDays: back == null ? defaultLookbackDays : back,
      lookaheadDays: ahead == null ? defaultLookaheadDays : ahead,
    };
  }

  // UNION window for a single list fetch covering every enabled config: the
  // WIDEST lookback + WIDEST lookahead (default applied per null value). With
  // no configs it still returns the defaults so callers stay well-defined.
  function unionWindowDays(configs = []) {
    let back = defaultLookbackDays;
    let ahead = defaultLookaheadDays;
    for (const c of Array.isArray(configs) ? configs : []) {
      const eff = effectiveWindowDays(c);
      if (eff.lookbackDays > back) back = eff.lookbackDays;
      if (eff.lookaheadDays > ahead) ahead = eff.lookaheadDays;
    }
    return { lookbackDays: back, lookaheadDays: ahead };
  }

  // Resolve a config's effective window to absolute [dateFrom, dateTo] bounds
  // relative to `now` (epoch ms, default Date.now()). Pure.
  function windowBoundsForConfig(config = {}, now = Date.now()) {
    const { lookbackDays, lookaheadDays } = effectiveWindowDays(config);
    return {
      dateFrom: new Date(now - lookbackDays * DAY_MS),
      dateTo: new Date(now + lookaheadDays * DAY_MS),
    };
  }

  // Resolve the UNION window across enabled configs to absolute bounds. Pure.
  function unionWindowBounds(configs = [], now = Date.now()) {
    const { lookbackDays, lookaheadDays } = unionWindowDays(configs);
    return {
      dateFrom: new Date(now - lookbackDays * DAY_MS),
      dateTo: new Date(now + lookaheadDays * DAY_MS),
    };
  }

  return { effectiveWindowDays, unionWindowDays, windowBoundsForConfig, unionWindowBounds };
}
