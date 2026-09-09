/**
 * Are we actually publishing what the strategy said? (2026-09-09)
 *
 * Hector: "una forma de capturar nuestros propios precios para asegurar que
 * estamos publicando como se supone, like si la regla es cheapest pero en la
 * corrida se detecto que hay alguien cheaper de nosotros ps se puede auto
 * corregir el sistema".
 *
 * ── WE ALREADY HAVE THE DATA ────────────────────────────────────────────────
 * The tenant's exclusion list (`Tenant.marketExcludedVendors`) drops our own
 * brands when COMPUTING the cheapest competitor — it does not stop the scraper
 * STORING them. Every run has been recording our own shelf prices all along.
 * At LAX over the seven days to 2026-09-09: Economy Rent a Car 755 offers
 * (min $10), MEXRENTACAR 400 ($7), Zezgo 59 ($12.67).
 *
 * So this is a comparison, not a new capture.
 *
 * ── TWO DIRECTIONS, NOT ONE ─────────────────────────────────────────────────
 * The failure Hector described is somebody sitting BELOW us when the rule says
 * we should be cheapest. Real, and worth catching.
 *
 * But the LAX data says the live problem is the opposite one. The cheapest
 * competitor there is Ace at $15.67; under cheapest−$1 the target is ~$14.67,
 * and we publish $7–$10. Nobody is undercutting us — we are giving away $5–7
 * per day, per car, against our own rule. A one-directional check would have
 * reported LAX as healthy every single day.
 *
 * So each cell is judged on two independent axes and may fail both:
 *
 *   vs the TARGET       ABOVE_TARGET  we are dearer than intended (lose the
 *                                     booking) / BELOW_TARGET (leave money)
 *   vs the CHEAPEST     UNDERCUT      somebody is at or under us, so whatever
 *                       COMPETITOR    we intended, we are not the cheapest
 *
 * ── WHY IT ONLY REPORTS ─────────────────────────────────────────────────────
 * Auto-correction is deliberately NOT in this module. Every number here is a
 * SNAPSHOT of a market that moves, and a self-healing loop that writes prices
 * from a snapshot can chase itself: publish low, observe low, publish lower.
 * The existing guardrails (floor, ceiling, maxDeltaPct) already govern writes.
 * This produces findings; deciding to act on them is a separate, gated step.
 *
 * All pure — no prisma, no env. Money math stays testable on a laptop.
 */

import { vendorKey } from './market-vendor.js';

/**
 * Default tolerance in dollars. A scrape is a snapshot: a few cents of drift
 * between what we published and what the OTA rendered is not a finding, and
 * reporting it would bury the real ones.
 */
export const DEFAULT_TOLERANCE = 0.75;

/**
 * Fewest competitors a ladder needs before a gap against it means anything.
 *
 * Found in the real LAX data on the day this was written: our Standard SUV sits
 * at $14.67 and the rule reported a $77/day gap — because the ONLY competitor
 * listing that class on those dates was Hertz at $93. "Cheapest minus a dollar"
 * is arithmetically right and operationally nonsense there; LAX is a bimodal
 * market and we compete in the independent tier, not against Hertz.
 *
 * A thin ladder does not suppress the finding — it labels it, so nobody reads
 * "raise this to $92" off a sample of one.
 */
export const DEFAULT_MIN_SAMPLE = 3;

export const AXIS_TARGET = Object.freeze({
  ON: 'ON_TARGET',
  ABOVE: 'ABOVE_TARGET',
  BELOW: 'BELOW_TARGET',
  UNKNOWN: 'NO_TARGET',
});

export const AXIS_LADDER = Object.freeze({
  CHEAPEST: 'CHEAPEST',
  UNDERCUT: 'UNDERCUT',
  UNKNOWN: 'NO_COMPETITOR',
});

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
};

/**
 * Build the vendorKey set identifying ONE franchise's own listings.
 *
 * Aliases come from configuration, never from guessing: a brand's market
 * spelling ("MEXRENTACAR") rarely matches its franchise code ("MEX") or its
 * display name ("Mex"), and matching loosely would classify a competitor as
 * ourselves and silently exempt them from the ladder.
 */
export function ownVendorKeys(aliases) {
  const out = new Set();
  for (const a of Array.isArray(aliases) ? aliases : []) {
    const k = vendorKey(a);
    if (k) out.add(k);
  }
  return out;
}

/** Is this offer one of ours? */
export function isOwnOffer(supplier, ownKeys) {
  const k = vendorKey(supplier);
  return Boolean(k) && ownKeys instanceof Set && ownKeys.has(k);
}

/**
 * Judge one (date, class) cell.
 *
 * @param {object} args
 * @param {number} args.ours                our own observed shelf price
 * @param {number} [args.target]            what the strategy said to publish
 * @param {number} [args.cheapestCompetitor] cheapest price that is NOT ours
 * @param {number} [args.tolerance]
 * @returns {object} both axes, plus the signed deltas that justify them.
 */
export function evaluateCell({
  ours, target, cheapestCompetitor, rivalCount = null,
  tolerance = DEFAULT_TOLERANCE, minSample = DEFAULT_MIN_SAMPLE,
} = {}) {
  const mine = num(ours);
  const want = num(target);
  const rival = num(cheapestCompetitor);
  const tol = Number.isFinite(Number(tolerance)) && Number(tolerance) >= 0
    ? Number(tolerance) : DEFAULT_TOLERANCE;
  const floor = Number.isFinite(Number(minSample)) && Number(minSample) > 0
    ? Number(minSample) : DEFAULT_MIN_SAMPLE;
  // Unknown depth is not proof of a healthy ladder, but it is how every caller
  // that predates this field behaves, so it is not flagged either.
  //
  // Tested through `Number.isFinite(Number(rivalCount))` this was wrong in a way
  // that zeroed the headline number: Number(null) is 0, not NaN, so every caller
  // omitting the field got depth 0 and was labelled thin. Absence is checked
  // before coercion, never through it.
  const depth = (rivalCount === null || rivalCount === undefined || rivalCount === ''
    || !Number.isFinite(Number(rivalCount)))
    ? null
    : Number(rivalCount);
  const thinLadder = depth != null && depth < floor;

  if (mine == null) {
    return {
      ours: null,
      targetAxis: AXIS_TARGET.UNKNOWN,
      ladderAxis: AXIS_LADDER.UNKNOWN,
      deltaVsTarget: null,
      deltaVsCheapest: null,
      rivalCount: depth,
      thinLadder,
      // Not seeing ourselves is itself worth surfacing: it means either we are
      // not listed on this date/class at all, or the alias is wrong. Both are
      // things somebody should know, and neither is "healthy".
      ourPriceSeen: false,
    };
  }

  let targetAxis = AXIS_TARGET.UNKNOWN;
  let deltaVsTarget = null;
  if (want != null) {
    deltaVsTarget = round2(mine - want);
    if (Math.abs(deltaVsTarget) <= tol) targetAxis = AXIS_TARGET.ON;
    else targetAxis = deltaVsTarget > 0 ? AXIS_TARGET.ABOVE : AXIS_TARGET.BELOW;
  }

  let ladderAxis = AXIS_LADDER.UNKNOWN;
  let deltaVsCheapest = null;
  if (rival != null) {
    deltaVsCheapest = round2(mine - rival);
    // At or below us, beyond the noise band, means we are not the cheapest.
    ladderAxis = deltaVsCheapest > tol ? AXIS_LADDER.UNDERCUT : AXIS_LADDER.CHEAPEST;
  }

  return {
    ours: mine, targetAxis, ladderAxis, deltaVsTarget, deltaVsCheapest,
    rivalCount: depth, thinLadder, ourPriceSeen: true,
  };
}

function round2(n) {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}

/**
 * Roll a set of judged cells into something a person can act on.
 *
 * Sorted by MONEY, not by count: twelve cells a nickel off matter less than one
 * class eight dollars under target across a fortnight. `worst` carries the
 * single cell that costs the most so a report can lead with it.
 */
export function summarize(cells) {
  const list = (Array.isArray(cells) ? cells : []).filter(Boolean);
  const out = {
    cells: list.length,
    seen: 0,
    unseen: 0,
    undercut: 0,
    belowTarget: 0,
    aboveTarget: 0,
    onTarget: 0,
    thin: 0,
    // Signed money per day, summed over cells that are off target AND standing
    // on a ladder deep enough to believe. A $77 gap measured against a single
    // premium listing is not $77 of lost margin, and adding it to this total
    // would make the number worthless for deciding anything.
    dollarsLeftPerDay: 0,
    dollarsOverPerDay: 0,
    // The same money from thin ladders, kept apart rather than discarded.
    dollarsLeftPerDayThin: 0,
    worst: null,
  };
  for (const c of list) {
    if (c.thinLadder) out.thin += 1;
    if (!c.ourPriceSeen) { out.unseen += 1; continue; }
    out.seen += 1;
    if (c.ladderAxis === AXIS_LADDER.UNDERCUT) out.undercut += 1;
    if (c.targetAxis === AXIS_TARGET.BELOW) {
      out.belowTarget += 1;
      const money = Math.abs(c.deltaVsTarget);
      if (c.thinLadder) out.dollarsLeftPerDayThin = round2(out.dollarsLeftPerDayThin + money);
      else out.dollarsLeftPerDay = round2(out.dollarsLeftPerDay + money);
    } else if (c.targetAxis === AXIS_TARGET.ABOVE) {
      out.aboveTarget += 1;
      if (!c.thinLadder) out.dollarsOverPerDay = round2(out.dollarsOverPerDay + c.deltaVsTarget);
    } else if (c.targetAxis === AXIS_TARGET.ON) out.onTarget += 1;

    // `worst` leads the report, so it must be a cell somebody can act on.
    if (c.thinLadder) continue;
    const magnitude = Math.abs(Number(c.deltaVsTarget) || 0);
    if (magnitude > 0 && (!out.worst || magnitude > Math.abs(out.worst.deltaVsTarget))) out.worst = c;
  }
  return out;
}
