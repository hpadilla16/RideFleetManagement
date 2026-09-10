/**
 * Measure, don't model (2026-09-10).
 *
 * A tenant's own brand is already in the scraped pool. `marketExcludedVendors`
 * records it — International Rental Corp sells as "ZezGo" — and until now that
 * field did one job: keep them out of their own competitor ladder. It can do a
 * far more valuable one.
 *
 * WHEN OUR OWN LISTING IS IN THE POOL FOR A (CLASS, PICKUP DATE), THE POSITION
 * IS A FACT. Both numbers were read off the same page by the same scrape, so no
 * gross-up, no factor, no assumption stands between the tenant and the answer.
 *
 * That matters because the modelled path was wrong, and wrong in the direction
 * that flatters nobody. Measured this day for IRC at SJU: their CCAR base is
 * $14.14 and the model claimed the customer therefore sees $14.14 x 1.4652 =
 * $20.72, which ranked them dearest of four. Their own listing was observed at
 * $13.00-$14.67 against rivals at $15.00-$20.00 — CHEAPEST on six of six dates
 * where both sides were seen. The observed listing / base ratio came to
 * 0.919-1.037, not 1.465: what the OTA displays tracks the BASE, not the
 * grossed-up total.
 *
 * So position is reported in tiers, and every surface says which one it used:
 *
 *   OBSERVED  — our listing and rivals both in the pool for that date. A fact.
 *   ESTIMATED — rivals only; our listed price is inferred from our base with
 *               the measured ratio. Labelled, never presented as observed.
 *   UNKNOWN   — no rivals for that date. No claim is made at all.
 *
 * Pure: no prisma, no IO.
 */

export const TIER = {
  OBSERVED: 'OBSERVED',
  ESTIMATED: 'ESTIMATED',
  UNKNOWN: 'UNKNOWN',
};

function num(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function round2(n) {
  return n == null ? null : Math.round((n + Number.EPSILON) * 100) / 100;
}

function dayKey(d) {
  if (!d) return null;
  if (typeof d === 'string') return d.length >= 10 ? d.slice(0, 10) : null;
  const dt = new Date(d);
  return Number.isNaN(dt.getTime()) ? null : dt.toISOString().slice(0, 10);
}

/**
 * Split a pool of offers into OURS and THEIRS.
 *
 * `isOwn` is injected rather than imported so this module stays pure and the
 * caller keeps using the one canonical vendor matcher (`isExcludedVendor` with
 * the tenant's own-brand set) instead of a second, subtly different one.
 */
export function splitSelfAndRivals(rows = [], isOwn = () => false) {
  const self = [];
  const rivals = [];
  for (const r of Array.isArray(rows) ? rows : []) {
    const supplier = String(r?.supplier ?? r?.vendor ?? '').trim();
    // An anonymous row can be neither: it cannot be undercut and it cannot be
    // recognised as ours. `loadCompetitorRows` already drops these; belt and
    // braces, because a blank sorting to the front of a ladder is a silent
    // wrong answer.
    if (!supplier) continue;
    (isOwn(supplier) ? self : rivals).push({ ...r, supplier });
  }
  return { self, rivals };
}

/**
 * The ratio between what the OTA LISTS for us and the BASE we uploaded.
 *
 * Reported with its range, not just a midpoint: the spread is the finding. IRC
 * CCAR came to 0.919-1.037 across six dates while CFAR sat at 0.702, and that
 * difference is a real question about the channel (length-of-rental discount? a
 * different rate pushed?), not noise to average away.
 */
export function measureSelfBaseRatio(selfRows = [], base = null) {
  const b = num(base);
  const values = [];
  if (b != null && b > 0) {
    for (const r of Array.isArray(selfRows) ? selfRows : []) {
      const listed = num(r?.price ?? r?.listed ?? r?.effectiveDailyPrice);
      if (listed == null || listed <= 0) continue;
      values.push(listed / b);
    }
  }
  if (!values.length) return { n: 0, median: null, min: null, max: null, spreadPct: null };
  values.sort((x, y) => x - y);
  const median = values.length % 2
    ? values[(values.length - 1) / 2]
    : (values[values.length / 2 - 1] + values[values.length / 2]) / 2;
  const min = values[0];
  const max = values[values.length - 1];
  return {
    n: values.length,
    median: Math.round(median * 10000) / 10000,
    min: Math.round(min * 10000) / 10000,
    max: Math.round(max * 10000) / 10000,
    spreadPct: min > 0 ? Math.round(((max / min) - 1) * 1000) / 10 : null,
  };
}

/**
 * Our position on ONE pickup date, at the highest tier the data supports.
 *
 * @param {object[]} selfRows  our own listings for that date  {supplier, price, observedAt}
 * @param {object[]} rivalRows rivals' listings for that date
 * @param {number}   base      the base we uploaded, for the ESTIMATED tier
 * @param {number}   ratio     measured listed/base; 1 is assumed when unknown,
 *                             and `ratioAssumed` says so
 */
export function buildPositionForDate({ selfRows = [], rivalRows = [], base = null, ratio = null, pickupDate = null } = {}) {
  const rivals = latestPerSupplier(rivalRows);
  const ours = latestPerSupplier(selfRows);
  const out = {
    pickupDate: dayKey(pickupDate),
    suppliersSeen: rivals.length,
    cheapestRival: rivals.length ? round2(rivals[0].price) : null,
    cheapestRivalSupplier: rivals.length ? rivals[0].supplier : null,
    ourListed: null,
    ourListedSource: null,
    ratioUsed: null,
    ratioAssumed: false,
  };

  if (!rivals.length) return { ...out, tier: TIER.UNKNOWN, position: null, of: 0, cheapest: false };

  if (ours.length) {
    // A fact: both sides came from the same scrape of the same page.
    const listed = ours[0].price;                    // our cheapest own listing
    const position = rivals.filter((r) => r.price < listed).length + 1;
    return {
      ...out,
      tier: TIER.OBSERVED,
      ourListed: round2(listed),
      ourListedSource: ours[0].supplier,
      position,
      of: rivals.length + 1,
      cheapest: position === 1,
      asOf: ours[0].observedAt || null,
    };
  }

  const b = num(base);
  if (b == null || b <= 0) return { ...out, tier: TIER.UNKNOWN, position: null, of: rivals.length, cheapest: false };

  const r = num(ratio);
  const usable = r != null && r > 0;
  const listed = round2(b * (usable ? r : 1));
  const position = rivals.filter((x) => x.price < listed).length + 1;
  return {
    ...out,
    tier: TIER.ESTIMATED,
    ourListed: listed,
    ourListedSource: null,
    ratioUsed: usable ? r : 1,
    ratioAssumed: !usable,
    position,
    of: rivals.length + 1,
    cheapest: position === 1,
    asOf: rivals[0].observedAt || null,
  };
}

/**
 * One quote per supplier, the LATEST — the same rule `market-claim.js` uses.
 * Cheapest-per-supplier answers "the best they have offered lately", which is a
 * different question from "what are they charging now".
 */
export function latestPerSupplier(rows = []) {
  const best = new Map();
  for (const r of Array.isArray(rows) ? rows : []) {
    const supplier = String(r?.supplier ?? r?.vendor ?? '').trim();
    if (!supplier) continue;
    const price = num(r?.price ?? r?.listed ?? r?.effectiveDailyPrice);
    if (price == null || price <= 0) continue;
    const at = r?.observedAt ? new Date(r.observedAt) : null;
    const seenAt = at && !Number.isNaN(at.getTime()) ? at : new Date(0);
    const key = supplier.toLowerCase();
    const prev = best.get(key);
    if (!prev || seenAt > prev.observedAt) best.set(key, { supplier, price, observedAt: seenAt });
  }
  return [...best.values()].sort((a, b) => a.price - b.price);
}

/**
 * How much of a class's window we can answer WITHOUT a model. This is the
 * number that decides how much the model still matters: for IRC CCAR it is 6 of
 * 13 dates today, for CFAR 1 of 13.
 */
export function describeSelfCoverage(byDate = new Map()) {
  const entries = byDate instanceof Map ? [...byDate.values()] : Object.values(byDate || {});
  const total = entries.length;
  const observed = entries.filter((p) => p?.tier === TIER.OBSERVED).length;
  const estimated = entries.filter((p) => p?.tier === TIER.ESTIMATED).length;
  return {
    dates: total,
    observed,
    estimated,
    unknown: total - observed - estimated,
    observedPct: total ? Math.round((observed / total) * 1000) / 10 : null,
  };
}
