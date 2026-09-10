/**
 * The closed loop (2026-09-10).
 *
 * Every recommendation this system makes is a claim about the future: "set this
 * base and you will be 2nd cheapest on eight of twelve dates". The tenant's own
 * listing appears in the next scrape, so the claim can be GRADED — and until it
 * is, nobody, us included, has any evidence the machine works.
 *
 * That is not hypothetical. Production's recommendation was measured this day to
 * deliver the configured target on 0 of 14 classes: it wrote a customer-facing
 * price as a base, so the tenant landed one to three rungs dearer than asked,
 * every day, for weeks, with 56 of those applied. A ledger that graded its own
 * promises would have caught it on day two.
 *
 * A promise is recorded when it is PUBLISHED, not when it is computed — an
 * un-taken recommendation proves nothing about the model. Grading needs our own
 * observed listing (see self-position.js): if the scrape did not catch us, the
 * promise stays PENDING rather than being scored on an estimate, because
 * grading an estimate with an estimate measures nothing.
 *
 * Stored as JSON in AppSetting (`tenant:<id>:pricePromises`), bounded, so this
 * needs no migration and cannot fail a deploy. Pure: no prisma, no IO.
 */

export const PROMISE = {
  PENDING: 'PENDING',     // published, our listing not yet observed
  KEPT: 'KEPT',           // observed, and the position matched
  MISSED: 'MISSED',       // observed, and it did not
  EXPIRED: 'EXPIRED',     // never observed inside the window; graded as nothing
};

/** Keep the ledger small enough to sit in a settings row and long enough to mean something. */
export const DEFAULT_CAP = 200;

/** How long a promise waits for our listing before it is written off. */
export const DEFAULT_TTL_DAYS = 7;

function num(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function dayKey(d) {
  if (!d) return null;
  if (typeof d === 'string') return d.length >= 10 ? d.slice(0, 10) : null;
  const dt = new Date(d);
  return Number.isNaN(dt.getTime()) ? null : dt.toISOString().slice(0, 10);
}

function iso(d) {
  if (!d) return null;
  const dt = new Date(d);
  return Number.isNaN(dt.getTime()) ? null : dt.toISOString();
}

/**
 * Record a promise at PUBLISH time.
 *
 * Returns a NEW list; the caller writes it. Newest first, capped, and a promise
 * for the same (rate, target) supersedes the previous PENDING one — otherwise a
 * tenant who re-publishes twice in a day collects promises nobody can attribute.
 */
export function recordPromise(existing = [], promise = {}, { cap = DEFAULT_CAP, now = new Date() } = {}) {
  const list = Array.isArray(existing) ? existing : [];
  // A default parameter only fires on undefined, so an explicit null still
  // arrives as null — the same trap as Number(null) === 0.
  const p = promise || {};
  const base = num(p.base);
  const rateId = p.rateId ? String(p.rateId) : null;
  if (base == null || base <= 0 || !rateId) return list;         // not a promise, not recorded
  // Promising nothing is not a promise. A BLOCKED recommendation -- one the
  // tenant's own floor pushes to where it holds zero dates -- would otherwise
  // enter the ledger and be trivially KEPT, inflating the scoreboard with
  // successes nobody wanted.
  if ((num(p.holdsOn) ?? 0) <= 0) return list;

  const entry = {
    id: `${rateId}:${Date.now()}`,
    rateId,
    sipp: p.sipp ? String(p.sipp) : null,
    locationCode: p.locationCode ? String(p.locationCode) : null,
    targetN: Math.max(1, Math.floor(num(p.targetN) ?? 1)),
    base,
    listedExpected: num(p.listedExpected),
    ratioUsed: num(p.ratioUsed),
    ratioAssumed: !!p.ratioAssumed,
    // What we said would happen, in the tenant's own terms.
    holdsOn: num(p.holdsOn) ?? 0,
    ofDates: num(p.ofDates) ?? 0,
    dates: Array.isArray(p.dates) ? p.dates.map(dayKey).filter(Boolean) : [],
    publishedAt: iso(p.publishedAt || now),
    status: PROMISE.PENDING,
    observedListing: null,
    observedHoldsOn: null,
    verifiedAt: null,
  };

  const superseded = list.filter((p) => !(p?.status === PROMISE.PENDING && p?.rateId === rateId && p?.targetN === entry.targetN));
  return [entry, ...superseded].slice(0, Math.max(1, cap));
}

/**
 * Grade one promise against what the scrape later observed.
 *
 * @param {object} promise
 * @param {object} observation {listed, holdsOn, ofDates, observedAt}
 *        `listed` is our OWN observed listing; `holdsOn` is how many of the
 *        promised dates we actually held the target position on.
 */
export function gradePromise(promise = {}, observation = null, { now = new Date(), ttlDays = DEFAULT_TTL_DAYS } = {}) {
  if (!promise || promise.status !== PROMISE.PENDING) return promise;

  const listed = observation ? num(observation.listed) : null;
  const observedHoldsOn = observation ? num(observation.holdsOn) : null;

  if (listed == null || observedHoldsOn == null) {
    // Still waiting — unless it waited too long, in which case it is written
    // off rather than left to inflate the pending pile forever.
    const published = promise.publishedAt ? new Date(promise.publishedAt) : null;
    const age = published ? (new Date(now) - published) / 86400000 : 0;
    if (age > ttlDays) {
      return { ...promise, status: PROMISE.EXPIRED, verifiedAt: iso(now), note: `our listing was never observed within ${ttlDays} days` };
    }
    return promise;
  }

  // KEPT means the position we promised is the position we got, on at least as
  // many dates as promised. Landing BETTER than promised is still kept: the
  // tenant asked to be 2nd and being 1st does not make the advice wrong.
  const promised = num(promise.holdsOn) ?? 0;
  const kept = observedHoldsOn >= promised;

  return {
    ...promise,
    status: kept ? PROMISE.KEPT : PROMISE.MISSED,
    observedListing: listed,
    observedHoldsOn,
    ofDates: num(observation.ofDates) ?? promise.ofDates,
    // The number that calibrates the model: what the OTA listed for the base we
    // published. A drift here is the earliest signal the ratio moved.
    observedRatio: promise.base ? Math.round((listed / promise.base) * 10000) / 10000 : null,
    verifiedAt: iso(observation.observedAt || now),
  };
}

/** The scoreboard a tenant can hold us to. */
export function scorePromises(list = []) {
  const rows = (Array.isArray(list) ? list : []).filter(Boolean);
  const graded = rows.filter((p) => p.status === PROMISE.KEPT || p.status === PROMISE.MISSED);
  const kept = graded.filter((p) => p.status === PROMISE.KEPT).length;
  const ratios = graded.map((p) => num(p.observedRatio)).filter((r) => r != null && r > 0).sort((a, b) => a - b);
  return {
    total: rows.length,
    pending: rows.filter((p) => p.status === PROMISE.PENDING).length,
    expired: rows.filter((p) => p.status === PROMISE.EXPIRED).length,
    graded: graded.length,
    kept,
    missed: graded.length - kept,
    // Null, not 100%, when nothing has been graded: an empty scoreboard must
    // never read as a perfect one.
    keptPct: graded.length ? Math.round((kept / graded.length) * 1000) / 10 : null,
    observedRatio: ratios.length
      ? { n: ratios.length, min: ratios[0], max: ratios[ratios.length - 1], median: ratios[Math.floor(ratios.length / 2)] }
      : { n: 0, min: null, max: null, median: null },
  };
}

/** One line a human can read without opening anything. */
export function scoreSentence(score) {
  if (!score || !score.graded) {
    return score?.pending
      ? `${score.pending} recommendation${score.pending === 1 ? '' : 's'} published, none graded yet`
      : 'No recommendations published yet';
  }
  return `${score.kept} of ${score.graded} recommendations delivered the position they promised (${score.keptPct}%)`;
}
