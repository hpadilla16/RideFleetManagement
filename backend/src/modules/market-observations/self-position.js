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
 * How far back the RATIO may look (2026-09-10).
 *
 * The ladder must be fresh -- 24 hours, because it is today's market. The ratio
 * is a slow property of the CHANNEL, and measuring it in the same 24 hours
 * throws away almost all the evidence: at SJU the tenant's own listing appears
 * 979 times over 27 days for CFAR and 3 times in the last day, 199 times over
 * 12 days for SFAR and zero in the last day. Four classes read UNCALIBRATED
 * purely because of the window.
 *
 * But it cannot look back indefinitely either, and this is the trap: the BASE
 * moved during those 30 days (56 suggestions were applied, SFAR going $21.66 to
 * $37.90), so dividing an old listing by today's base measures the price
 * change, not the channel. Measured that way the ratios blew out to 0.702-3.809
 * for CFAR — noise wearing a calibration's clothes.
 *
 * So the window starts at the LATER of (now - days) and the last time the base
 * moved. A rate edited an hour ago simply has nothing to measure yet, which is
 * the honest answer rather than a confident wrong one.
 */
export const DEFAULT_RATIO_WINDOW_DAYS = 14;

export function ratioWindowStart({ now = new Date(), days = DEFAULT_RATIO_WINDOW_DAYS, baseChangedAt = null } = {}) {
  const end = new Date(now);
  if (Number.isNaN(end.getTime())) return null;
  const back = new Date(end.getTime() - Math.max(1, Number(days) || DEFAULT_RATIO_WINDOW_DAYS) * 86400000);
  const changed = baseChangedAt ? new Date(baseChangedAt) : null;
  if (!changed || Number.isNaN(changed.getTime())) return back;
  return changed > back ? changed : back;
}

/**
 * Which ratio to actually use, and where it came from.
 *
 * A class with one or two of its own listings is not calibrated, it is
 * anecdotal, so it falls back to the location's ratio — every class at one
 * airport goes through the same channel, so the tenant's own CCAR listings are
 * real evidence about what that channel does to a CFAR base. Only when neither
 * has a sample does it assume 1, and then it says so: `ASSUMED` is what the
 * card renders as UNCALIBRATED.
 *
 * Never averages the two. A weak class ratio blended with a strong location one
 * produces a number that describes nothing and cannot be traced.
 */
export const RATIO_SOURCE = { CLASS: 'CLASS', LOCATION: 'LOCATION', ASSUMED: 'ASSUMED' };
export const MIN_RATIO_SAMPLE = 3;

export function resolveRatio({ classRatio = null, locationRatio = null, minSample = MIN_RATIO_SAMPLE } = {}) {
  const min = Math.max(1, Number(minSample) || MIN_RATIO_SAMPLE);
  const usable = (r) => r && Number(r.n) >= min && Number(r.median) > 0;
  if (usable(classRatio)) {
    return { ratio: classRatio.median, source: RATIO_SOURCE.CLASS, n: classRatio.n, spreadPct: classRatio.spreadPct ?? null };
  }
  if (usable(locationRatio)) {
    return { ratio: locationRatio.median, source: RATIO_SOURCE.LOCATION, n: locationRatio.n, spreadPct: locationRatio.spreadPct ?? null };
  }
  return { ratio: 1, source: RATIO_SOURCE.ASSUMED, n: (classRatio?.n || 0) + (locationRatio?.n || 0), spreadPct: null };
}

/**
 * The location-wide ratio: every class's own listings against the base that was
 * live for that class, pooled. Callers pass one entry per class so a class with
 * a thousand listings cannot drown out the rest -- the median is taken over the
 * per-observation ratios, but each class contributes only what it observed.
 */
export function measureLocationRatio(perClass = []) {
  const values = [];
  for (const entry of Array.isArray(perClass) ? perClass : []) {
    const rows = Array.isArray(entry?.selfRows) ? entry.selfRows : [];
    const base = Number(entry?.base);
    if (!Number.isFinite(base) || base <= 0) continue;
    for (const r of rows) {
      const listed = Number(r?.price ?? r?.listed ?? r?.effectiveDailyPrice);
      if (!Number.isFinite(listed) || listed <= 0) continue;
      values.push(listed / base);
    }
  }
  if (!values.length) return { n: 0, median: null, min: null, max: null, spreadPct: null };
  values.sort((a, b) => a - b);
  const median = values.length % 2
    ? values[(values.length - 1) / 2]
    : (values[values.length / 2 - 1] + values[values.length / 2]) / 2;
  const lo = values[0];
  const hi = values[values.length - 1];
  return {
    n: values.length,
    median: Math.round(median * 10000) / 10000,
    min: Math.round(lo * 10000) / 10000,
    max: Math.round(hi * 10000) / 10000,
    spreadPct: lo > 0 ? Math.round(((hi / lo) - 1) * 1000) / 10 : null,
  };
}

/**
 * ARE WE EVEN ON THE SHELF? (2026-09-10, Hector: "dime cuando una clase no se
 * esta mostrando en los OTA".)
 *
 * A class the tenant prices, whose rivals the scraper sees every day, where our
 * own listing never appears, is not a data gap — it is a business fact, and
 * estimating a rank for it is a fiction. Measured at SJU over 30 days:
 *
 *   IFAR   rivals on 30 days from 11 agencies, ours on 0.  Never once.
 *   ICAR   rivals on 30 days from 12 agencies, ours on 2, last 11 days ago.
 *   LFAR   rivals on 3 days from 1 agency, ours on 0.
 *
 * Those are three different statements. The second is a fall OUT of the channel,
 * worth knowing while it is fresh. The third permits no conclusion at all.
 *
 * AND THE FIRST ONE WAS WRONG (retracted 2026-09-10, hours after shipping).
 * Hector opened Kayak and found ZezGo -- IRC's own brand -- listing a Toyota
 * Sienna as Minivan, a Ford F-150 as Pickup truck, a cargo van as Commercial
 * and a Jeep Wrangler at $46, which are precisely the classes this had just
 * declared absent from the channel. The verdict rested on an assumption nobody
 * checked: that if the scraper sees RIVALS for a class it would see US too.
 * That only holds if the scrape captures the whole result list, and it does
 * not -- those listings sit far down a page that ends in "Show more results",
 * and the profiles ask for 3-day rentals while that search was 7.
 *
 * Absence from our pool is not absence from the OTA. So NOT_VISIBLE is now
 * gated behind `captureComplete`, which nothing sets yet: until the scraper can
 * say it read the entire list, the honest verdict is INSUFFICIENT, and the
 * counts still travel so the gap is visible to us without being asserted at a
 * tenant.
 */
export const VISIBILITY = {
  VISIBLE: 'VISIBLE',             // we appear, recently
  FADING: 'FADING',               // we used to appear and have stopped
  NOT_VISIBLE: 'NOT_VISIBLE',     // rivals are watched daily; we have never appeared
  INSUFFICIENT: 'INSUFFICIENT',   // the class is barely scraped; no conclusion
};

/** The scrape must have watched the class this hard before absence means anything. */
export const VISIBILITY_MIN_RIVAL_DAYS = 10;
export const VISIBILITY_MIN_RIVAL_SUPPLIERS = 3;
/** How stale our own last listing may be before "visible" becomes "fading". */
export const VISIBILITY_STALE_DAYS = 7;

export function describeChannelVisibility({
  rivalDays = 0, rivalSuppliers = 0, selfDays = 0, selfLastSeenAt = null,
  now = new Date(), minRivalDays = VISIBILITY_MIN_RIVAL_DAYS,
  minRivalSuppliers = VISIBILITY_MIN_RIVAL_SUPPLIERS, staleDays = VISIBILITY_STALE_DAYS,
  captureComplete = false,
} = {}) {
  const rd = Math.max(0, Number(rivalDays) || 0);
  const rs = Math.max(0, Number(rivalSuppliers) || 0);
  const sd = Math.max(0, Number(selfDays) || 0);
  const last = selfLastSeenAt ? new Date(selfLastSeenAt) : null;
  const lastOk = last && !Number.isNaN(last.getTime()) ? last : null;
  const daysSince = lastOk ? Math.floor((new Date(now) - lastOk) / 86400000) : null;

  const watched = rd >= minRivalDays && rs >= minRivalSuppliers;
  const base = { rivalDays: rd, rivalSuppliers: rs, selfDays: sd, daysSinceSeen: daysSince, watched };

  if (!watched) {
    return { ...base, state: VISIBILITY.INSUFFICIENT, label: `only ${rd} day${rd === 1 ? '' : 's'} of market data — not enough to tell` };
  }
  if (sd === 0) {
    // Only a scrape that read the WHOLE list can turn our absence into a fact.
    if (!captureComplete) {
      return {
        ...base,
        state: VISIBILITY.INSUFFICIENT,
        label: `${rs} agencies quoted this class on ${rd} days and we never captured your listing — the scrape reads part of the results page, so this is a capture gap, not proof you are absent`,
      };
    }
    return {
      ...base,
      state: VISIBILITY.NOT_VISIBLE,
      label: `not appearing on the OTA: ${rs} agencies quoted this class on ${rd} days and you never did`,
    };
  }
  if (daysSince != null && daysSince > staleDays) {
    return {
      ...base,
      state: VISIBILITY.FADING,
      label: `last seen ${daysSince} days ago while rivals quoted on ${rd} days — you have dropped out of the channel`,
    };
  }
  return { ...base, state: VISIBILITY.VISIBLE, label: `seen on ${sd} of ${rd} days` };
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
