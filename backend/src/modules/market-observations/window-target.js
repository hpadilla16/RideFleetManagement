/**
 * "For this pool of fourteen days, if you want to be the Nth cheapest EVERY
 * day, this is the price you have to set" (2026-09-10, Hector).
 *
 * To sit at position N on ONE pickup date our listed price must land strictly
 * between the (N-1)th and the Nth cheapest rival for that date. One price that
 * does it on EVERY date is the INTERSECTION of those intervals:
 *
 *     lower = max over dates of rival[N-2]     (nobody extra slips under us)
 *     upper = min over dates of rival[N-1]     (we stay under the Nth)
 *
 * When lower >= upper the honest answer is "no single price can do that",
 * followed by the best achievable coverage. Measured against the real SJU pool
 * that afternoon: for target #2, CCAR needed to be above $19.12 on one date and
 * below $18.30 on another, so the best any single price could do was hold the
 * slot on 8 of 12 dates. Reporting "you will be 2nd" there would have been a
 * lie in four dates out of twelve.
 *
 * TWO RULES THIS MODULE EXISTS TO ENFORCE:
 *
 * 1. The recommendation is a BASE, converted from the listed target with the
 *    ratio MEASURED from the tenant's own listings — not with the tax gross-up.
 *    What the OTA displays tracks the base (IRC CCAR: 0.919-1.037), so using
 *    the 1.4652 gross-up here would recommend a base ~32% too low.
 *
 * 2. If the floor or ceiling moves the price, the position is RECOMPUTED at the
 *    clamped price and the real number is reported. The pre-clamp promise is
 *    never carried: CCAR target #2 recommended $12.48 and held 8 of 12 dates,
 *    but clamped to its $14.14 floor it held 1 — and nothing said so.
 *
 * Pure: no prisma, no IO.
 */

export const ANSWER = {
  FEASIBLE: 'FEASIBLE',       // the price we recommend holds the slot on every usable date
  PARTIAL: 'PARTIAL',         // it holds on some of them; the count is reported
  BLOCKED: 'BLOCKED',         // the market allowed it, the tenant's own floor/ceiling does not
  NOT_ANSWERABLE: 'NOT_ANSWERABLE', // the pool has no date with N rivals
};

/**
 * `answer` describes what the tenant GETS, after their bounds. `marketAnswer`
 * describes what the market allowed before those bounds were applied — the two
 * differ exactly when a floor or ceiling is the binding constraint, which is
 * worth naming rather than blurring: one is a fact about competitors, the other
 * is a consequence of a setting they can change.
 */

/** A cent: enough to be strictly under a rival, small enough to be honest. */
const UNDERCUT = 0.01;

function num(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function round2(n) {
  return n == null ? null : Math.round((n + Number.EPSILON) * 100) / 100;
}

/** Position a listed price would take on one ascending rival ladder. */
export function positionOn(ladder = [], listedPrice) {
  const p = num(listedPrice);
  if (p == null) return null;
  return ladder.filter((r) => num(r?.price ?? r) < p).length + 1;
}

/**
 * Count, date by date, what a listed price ACTUALLY achieves. This is the
 * verification step, and it runs on the number we are about to recommend —
 * never on the number we wish we could recommend.
 */
export function verifyPositionAt({ laddersByDate = new Map(), listedPrice = null, targetN = 1 } = {}) {
  const entries = laddersByDate instanceof Map ? [...laddersByDate.entries()] : Object.entries(laddersByDate || {});
  const usable = entries.filter(([, l]) => Array.isArray(l) && l.length >= targetN);
  const byDate = {};
  let exact = 0;
  let better = 0;
  let worse = 0;
  for (const [date, ladder] of usable) {
    const pos = positionOn(ladder, listedPrice);
    byDate[date] = pos;
    if (pos === targetN) exact += 1;
    else if (pos < targetN) better += 1;
    else worse += 1;
  }
  return { dates: usable.length, exact, better, worse, byDate };
}

/**
 * The recommendation.
 *
 * @param {Map<string, Array<{price:number}>>} laddersByDate ascending rival ladders, ALL-IN-free
 *        (what the OTA lists), one entry per pickup date
 * @param {number} targetN         1 = cheapest, 2 = second cheapest, ...
 * @param {number} ratio           measured listed/base; null => 1 is assumed and flagged
 * @param {number} floor           rule.floorPrice — a BASE bound
 * @param {number} ceiling         rule.ceilingPrice — a BASE bound
 * @param {number} paddingPct      the tenant's undercut/overcut on the target
 */
export function recommendBaseForTarget({
  laddersByDate = new Map(), targetN = 1, ratio = null,
  floor = null, ceiling = null, paddingPct = 0,
} = {}) {
  const N = Math.max(1, Math.floor(num(targetN) ?? 1));
  const entries = laddersByDate instanceof Map ? [...laddersByDate.entries()] : Object.entries(laddersByDate || {});
  const totalDates = entries.length;
  const usable = entries.filter(([, l]) => Array.isArray(l) && l.length >= N);

  const r = num(ratio);
  const ratioUsed = r != null && r > 0 ? r : 1;
  const ratioAssumed = !(r != null && r > 0);
  const toBase = (listed) => round2(listed / ratioUsed);
  const toListed = (base) => round2(base * ratioUsed);

  if (!usable.length) {
    return {
      answer: ANSWER.NOT_ANSWERABLE,
      targetN: N,
      reason: `no pickup date in the pool has ${N} rival${N > 1 ? 's' : ''} for this class`,
      datesInPool: totalDates,
      usableDates: 0,
      base: null, listedTarget: null, ratioUsed, ratioAssumed,
    };
  }

  let lower = 0;
  let upper = Infinity;
  for (const [, l] of usable) {
    lower = Math.max(lower, N >= 2 ? num(l[N - 2]?.price ?? l[N - 2]) : 0);
    upper = Math.min(upper, num(l[N - 1]?.price ?? l[N - 1]));
  }

  const pad = (num(paddingPct) ?? 0) / 100;
  let listedTarget;
  let answer;
  if (lower < upper) {
    // The highest price that still holds the slot everywhere, then the tenant's
    // own padding on top (negative = undercut further).
    listedTarget = round2((upper - UNDERCUT) * (1 + pad));
    answer = ANSWER.FEASIBLE;
  } else {
    // No intersection. Sweep the rival prices and keep the one that holds the
    // slot on the most dates — a real number with a real coverage figure,
    // instead of a promise that is wrong on half the window.
    const candidates = [...new Set(usable.flatMap(([, l]) => l.map((x) => num(x?.price ?? x))))].filter((x) => x != null).sort((a, b) => a - b);
    let best = { listed: null, hits: -1 };
    for (const c of candidates) {
      const p = round2((c - UNDERCUT) * (1 + pad));
      const hits = usable.filter(([, l]) => positionOn(l, p) === N).length;
      if (hits > best.hits) best = { listed: p, hits };
    }
    listedTarget = best.listed;
    answer = ANSWER.PARTIAL;
  }

  const wantedBase = toBase(listedTarget);

  // The clamp, and then the truth about it.
  const f = num(floor);
  const c = num(ceiling);
  let base = wantedBase;
  let clampedTo = null;
  if (f != null && base < f) { base = round2(f); clampedTo = 'floor'; }
  if (c != null && base > c) { base = round2(c); clampedTo = 'ceiling'; }

  const listedAfter = toListed(base);
  const verified = verifyPositionAt({ laddersByDate, listedPrice: listedAfter, targetN: N });
  const verifiedWanted = clampedTo
    ? verifyPositionAt({ laddersByDate, listedPrice: listedTarget, targetN: N })
    : verified;

  // The market's verdict was computed on the un-clamped price. What the tenant
  // actually gets is the clamped one, so say that -- carrying the pre-clamp
  // promise is the exact defect this module exists to close.
  const marketAnswer = answer;
  const effectiveAnswer = verified.exact === usable.length
    ? ANSWER.FEASIBLE
    : (verified.exact > 0 ? ANSWER.PARTIAL : (clampedTo ? ANSWER.BLOCKED : ANSWER.PARTIAL));

  return {
    answer: effectiveAnswer,
    marketAnswer,
    targetN: N,
    // What we recommend, and what the OTA should then list for us.
    base,
    listedTarget,
    listedAfterClamp: listedAfter,
    wantedBase,
    clampedTo,
    // The clamp is only worth mentioning when it changed the OUTCOME, not
    // merely the number.
    clampChangedOutcome: !!clampedTo && verified.exact !== verifiedWanted.exact,
    // What the un-clamped recommendation would have held, so the warning can
    // name both numbers instead of gesturing at one.
    wantedHoldsOn: verifiedWanted.exact,
    band: { lower: round2(lower === 0 ? null : lower), upper: Number.isFinite(upper) ? round2(upper) : null },
    ratioUsed,
    ratioAssumed,
    datesInPool: totalDates,
    usableDates: usable.length,
    // VERIFIED at the price we are actually recommending.
    holdsOn: verified.exact,
    better: verified.better,
    worse: verified.worse,
    positionsByDate: verified.byDate,
  };
}

/** 1st, 2nd, 3rd, 4th -- "3th cheapest" on a tenant's screen is not a detail. */
function ordinal(n) {
  const i = Math.abs(Math.floor(Number(n) || 0));
  const tens = i % 100;
  if (tens >= 11 && tens <= 13) return `${i}th`;
  return `${i}${['th', 'st', 'nd', 'rd'][i % 10] || 'th'}`;
}

/** The sentence, so every surface says it identically. */
export function targetSentence(rec, { windowLabel = null, asOf = null, timeZone = 'America/Puerto_Rico' } = {}) {
  if (!rec) return null;
  const when = asOf
    ? new Date(asOf).toLocaleString('en-US', { timeZone, month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
    : null;
  const pool = `${windowLabel ? windowLabel + ' pool' : 'the pool'}${when ? ' scraped ' + when : ''}`;
  const nth = rec.targetN === 1 ? 'cheapest' : `${ordinal(rec.targetN)} cheapest`;

  if (rec.answer === ANSWER.NOT_ANSWERABLE) {
    return `Cannot say: ${rec.reason} (${pool})`;
  }
  const money = (v) => `$${Number(v).toFixed(2)}`;
  const dates = `${rec.usableDates} date${rec.usableDates === 1 ? '' : 's'}`;
  let head;
  if (rec.answer === ANSWER.FEASIBLE) {
    head = `Set base ${money(rec.base)} to be ${nth} on all ${dates} of ${pool}`;
  } else if (rec.answer === ANSWER.BLOCKED) {
    head = `Your ${rec.clampedTo} blocks this: base ${money(rec.base)} is ${nth} on 0 of ${dates} of ${pool}`;
  } else {
    head = `No single price is ${nth} on every date; base ${money(rec.base)} holds it on ${rec.holdsOn} of ${rec.usableDates}`;
  }

  const clamp = rec.clampChangedOutcome
    ? ` — WARNING: your ${rec.clampedTo} moved it from ${money(rec.wantedBase)}, which would have held ${rec.wantedHoldsOn} of ${rec.usableDates}`
    : '';
  const est = rec.ratioAssumed ? ' (assumes the OTA lists your base unchanged — not yet measured)' : '';
  return head + clamp + est;
}
