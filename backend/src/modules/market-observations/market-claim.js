/**
 * The one sentence a revenue manager can act on (2026-09-10).
 *
 * Hector: *"que nosotros si decimos: mira, para HOY, desde la hora del scrape,
 * tu si eres el mas barato."* Not a forecast — a FACT, with its hour and its
 * scope attached. That is a claim we can always stand behind, and the previous
 * card could not make it for two reasons.
 *
 * FIRST, the ladder mixed pickup dates. The card's rank came from the cheapest
 * price per supplier across EVERY pickup date in the last 24h, and at SJU that
 * window holds 1,979 offers spread over FIFTY pickup dates, where the cheapest
 * rival for one class ranges from $15.86 to $135.82 — a 756% spread. Collapsing
 * that with a MIN takes the cheapest day in a fifty-day lookahead and calls it
 * today's market. Ranked against that, a single daily rate always looks
 * expensive: measured the same day, six of ten classes changed rank once the
 * ladder was built per pickup date (CCAR #7 of 9 became #4 of 3).
 *
 * SECOND, a renter books ONE pickup date. A rank over a mixture of dates is not
 * a statement about anything they can buy.
 *
 * So a claim is scoped to (class, pickup date), built from the LATEST quote per
 * supplier, and it carries the timestamp it was true at. What it does NOT do is
 * predict tomorrow: measured over 363 class-day pairs at SJU, an ordinal
 * position survives 24 hours 42% of the time, and 52% at best. Durability is a
 * separate, clearly-labelled number — never folded into the claim.
 *
 * Pure: no prisma, no IO.
 */

/** Never render "#5 of 4": when nobody is above you, say so in words. */
export const CLAIM = {
  CHEAPEST: 'CHEAPEST',
  MID: 'MID',
  MOST_EXPENSIVE: 'MOST_EXPENSIVE',
  NO_DATA: 'NO_DATA',
  NO_PRICE: 'NO_PRICE',
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
 * One quote per supplier for one pickup date: the LATEST, not the cheapest.
 *
 * Cheapest-per-supplier is what the old aggregate did, and across a window it
 * silently answers "what is the best this agency has offered lately" — a
 * different question from "what are they charging right now", which is the only
 * one a claim about this moment can be built from.
 */
export function latestPerSupplier(rows = []) {
  const best = new Map();
  for (const r of Array.isArray(rows) ? rows : []) {
    const supplier = String(r?.supplier ?? r?.vendor ?? '').trim();
    if (!supplier) continue;              // anonymous rows are not a competitor
    const price = num(r?.price ?? r?.allIn);
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
 * Build the claim.
 *
 * @param {object[]} rows        competitor rows for ONE class and ONE pickup date,
 *                               already in the ALL-IN domain: {supplier, price, observedAt}
 * @param {number}   yourAllIn   the all-in a customer pays us
 * @param {Date|string} pickupDate the date the claim is about
 * @param {Date}     asOf        when the scrape observed it (defaults to the newest row)
 * @param {number}   suppliersKnown how many agencies quote this class at all — the
 *                               scope of what we DIDN'T see
 */
export function buildRankClaim({ rows = [], yourAllIn = null, pickupDate = null, asOf = null, suppliersKnown = null } = {}) {
  const ladder = latestPerSupplier(rows);
  const mine = num(yourAllIn);
  const newest = ladder.reduce((acc, r) => (acc == null || r.observedAt > acc ? r.observedAt : acc), null);
  const observedAt = asOf ? new Date(asOf) : newest;

  const base = {
    pickupDate: dayKey(pickupDate),
    asOf: observedAt && !Number.isNaN(observedAt?.getTime?.()) && observedAt.getTime() > 0 ? observedAt : null,
    suppliersSeen: ladder.length,
    suppliersKnown: num(suppliersKnown),
    yourAllIn: round2(mine),
    cheapest: ladder.length ? round2(ladder[0].price) : null,
    cheapestSupplier: ladder.length ? ladder[0].supplier : null,
    dearest: ladder.length ? round2(ladder[ladder.length - 1].price) : null,
    ladder: ladder.map((r) => ({ supplier: r.supplier, price: round2(r.price) })),
  };

  if (!ladder.length) return { ...base, verdict: CLAIM.NO_DATA, rank: null, of: 0, gapToBeat: null, gapToNext: null };
  if (mine == null || mine <= 0) return { ...base, verdict: CLAIM.NO_PRICE, rank: null, of: ladder.length, gapToBeat: null, gapToNext: null };

  const cheaper = ladder.filter((r) => r.price < mine);
  const rank = cheaper.length + 1;
  const of = ladder.length + 1;                     // us plus the rivals we saw

  // The two numbers that tell you whether the position is worth anything:
  // what it would take to become the cheapest, and how much room there is
  // before the next rival undercuts you.
  const gapToBeat = rank === 1 ? null : round2(mine - ladder[0].price);
  const above = ladder.find((r) => r.price >= mine);
  const gapToNext = rank === 1
    ? round2(ladder[0].price - mine)
    : (above ? round2(above.price - mine) : null);

  const verdict = rank === 1
    ? CLAIM.CHEAPEST
    : (cheaper.length === ladder.length ? CLAIM.MOST_EXPENSIVE : CLAIM.MID);

  return { ...base, verdict, rank, of, gapToBeat, gapToNext };
}

/**
 * How durable the position is — deliberately SEPARATE from the claim, and
 * expressed against the class's own overnight movement rather than as a
 * confidence percentage nobody can check.
 *
 * Measured at SJU across 363 class-day pairs: when the gap to the rung below
 * exceeds the class's typical overnight move, an ordinal position survived the
 * night 52% of the time; when it did not, 33%. A gap SMALLER than the noise is
 * not a position at all — the "cheapest minus $1" strategy is inside the noise
 * for ECAR ($0.78/night), ICAR ($1.20) and CCAR ($1.39).
 */
export function describeDurability({ gapToNext = null, gapToBeat = null, overnightMove = null, verdict = null } = {}) {
  const noise = num(overnightMove);
  const margin = verdict === CLAIM.CHEAPEST ? num(gapToNext) : num(gapToBeat);
  if (noise == null || noise <= 0 || margin == null) {
    return { overnightMove: round2(noise), margin: round2(margin), durable: null, label: null };
  }
  const durable = Math.abs(margin) > noise;
  return {
    overnightMove: round2(noise),
    margin: round2(Math.abs(margin)),
    durable,
    label: durable
      ? `margin $${Math.abs(margin).toFixed(2)} vs $${noise.toFixed(2)} typical overnight move`
      : `margin $${Math.abs(margin).toFixed(2)} is INSIDE the $${noise.toFixed(2)} typical overnight move`,
  };
}

/** The sentence itself, so every surface says it the same way. */
export function claimSentence(claim, { timeZone = 'America/Puerto_Rico' } = {}) {
  if (!claim) return null;
  const when = claim.asOf
    ? new Date(claim.asOf).toLocaleString('en-US', { timeZone, month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
    : null;
  const forDate = claim.pickupDate ? ` for ${claim.pickupDate}` : '';
  const scope = claim.suppliersKnown && claim.suppliersKnown > claim.suppliersSeen
    ? ` (${claim.suppliersSeen} of ${claim.suppliersKnown} agencies that quote it)`
    : '';
  const stamp = when ? ` as of ${when}` : '';

  switch (claim.verdict) {
    case CLAIM.NO_DATA:
      return `No competitor quoted this class${forDate}${stamp || ''}`;
    case CLAIM.NO_PRICE:
      return `You have no price for this class${forDate}`;
    case CLAIM.CHEAPEST:
      return `Cheapest${forDate}${stamp}, against ${claim.suppliersSeen} ${claim.suppliersSeen === 1 ? 'agency' : 'agencies'}${scope}`;
    case CLAIM.MOST_EXPENSIVE:
      return `Dearest of ${claim.of}${forDate}${stamp}${scope}`;
    default:
      return `#${claim.rank} of ${claim.of}${forDate}${stamp}${scope}`;
  }
}
