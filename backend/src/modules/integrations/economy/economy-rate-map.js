/**
 * Outbound rate-push mapping + guardrails (2026-07-28). PURE — no IO, no
 * prisma, no network. This is the money-critical decision layer: given what
 * RFM holds and what the franchise portal currently shows, decide for each
 * (class, date) whether we push, what value, or why we skip.
 *
 * Context (doc: memory economy-rate-push-contract):
 *  - RFM rates are the source of truth; Market Intelligence already applies
 *    the pricing formula, so whatever RateItem.daily holds is what the
 *    franchise must mirror.
 *  - The portal prices PER CALENDAR DATE, so decisions are per (class, date).
 *  - CLOSE-OUTS: the operator blocks days by pricing them absurdly high (LAX
 *    uses 250.00). An existing portal value at/above the sentinel is a
 *    deliberate close-out and is NEVER overwritten — doing so silently
 *    re-opens inventory that was closed on purpose.
 *  - ApplyRates reports success even when it ignores a value, so the caller
 *    MUST re-read and compare; `verifyPush` below is that comparison.
 */

/** Skip reasons — stored verbatim in RatePushLog.skipReason. */
export const SKIP = {
  NO_CLASS_MAP: 'no_class_map',            // RFM class has no portal counterpart
  NO_RFM_RATE: 'no_rfm_rate',              // portal class we hold no rate for
  CLOSEOUT_PRESERVED: 'closeout_preserved', // portal value is a deliberate block
  NO_CHANGE: 'no_change',                  // portal already matches RFM
  INVALID_VALUE: 'invalid_value',          // 0/negative/NaN — never publish
  OUT_OF_BAND: 'out_of_band',              // delta beyond the safety band
  NO_SENTINEL: 'no_sentinel',              // location never declared a close-out value
  COLLISION_LOST: 'collision_lost',         // another RFM class owns this portal class
  COLLISION_UNRESOLVED: 'collision_unresolved', // several aliases, no identity — human call
};

/**
 * Resolve an RFM class code to the portal's class code.
 * Codes are ACRISS on both sides and match 1:1 for most classes, so identity
 * is the default; `overrides` ({RFM: PORTAL}) carries only the exceptions.
 * A class the portal does not offer maps to null (caller skips it).
 */
export function mapClassCode(rfmCode, { overrides = {}, portalClasses = null } = {}) {
  const code = String(rfmCode || '').trim().toUpperCase();
  if (!code) return null;
  const mapped = String(overrides[code] || code).toUpperCase();
  if (portalClasses && !portalClasses.map((c) => String(c).toUpperCase()).includes(mapped)) return null;
  return mapped;
}

/** Money parse that refuses to guess: null unless it is a finite number. */
export function toAmount(v) {
  if (v === null || v === undefined || v === '') return null;
  // Strip currency/formatting, but NEVER let stripped-to-empty garbage become
  // a number: Number('') is 0, and 0 is the single most dangerous value here
  // (a free rental). Unparseable input must be null so callers refuse it.
  const cleaned = String(v).replace(/[^0-9.\-]/g, '');
  if (!/\d/.test(cleaned)) return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? Number(n.toFixed(2)) : null;
}

/** A portal value at/above the sentinel is a deliberate close-out. */
export function isCloseout(portalValue, closeoutMin) {
  const v = toAmount(portalValue);
  const min = toAmount(closeoutMin);
  if (v === null || min === null) return false;
  return v >= min;
}

/**
 * Decide ONE (class, date) cell.
 *
 * @param {object} p
 * @param {number|string} p.rfmValue      RateItem.daily for the class
 * @param {number|string} p.portalValue   what the portal shows today ('' = unset)
 * @param {number|string} p.closeoutMin   the location's close-out sentinel
 * @param {number} [p.maxDeltaPct]        refuse a change larger than this (%)
 * @returns {{push: boolean, value: number|null, reason: string|null}}
 */
export function decideCell({ rfmValue, portalValue, closeoutMin, maxDeltaPct = 60 } = {}) {
  const target = toAmount(rfmValue);
  // Never publish a missing/zero/negative price — an empty cell is safer than
  // a wrong one, and 0.00 would be a free rental.
  if (target === null || target <= 0) return { push: false, value: null, reason: SKIP.INVALID_VALUE };

  // A location must declare its close-out sentinel before it may write at all,
  // otherwise we cannot tell a blocked day from a real price.
  const sentinel = toAmount(closeoutMin);
  if (sentinel === null) return { push: false, value: null, reason: SKIP.NO_SENTINEL };

  const current = toAmount(portalValue);

  // Deliberate block — leave it alone.
  if (current !== null && isCloseout(current, sentinel)) {
    return { push: false, value: null, reason: SKIP.CLOSEOUT_PRESERVED };
  }
  // Already correct — do not spend a write (and do not churn the audit log).
  if (current !== null && current === target) {
    return { push: false, value: null, reason: SKIP.NO_CHANGE };
  }
  // Would the push itself create a close-out? Refuse: blocking days is an
  // operator decision, never a side effect of a pricing sync.
  if (target >= sentinel) {
    return { push: false, value: null, reason: SKIP.OUT_OF_BAND };
  }
  // Big swings against an EXISTING price are held for a human. An unset cell
  // (current === null) has no baseline to swing from, so it is allowed.
  if (current !== null && current > 0 && Number.isFinite(maxDeltaPct)) {
    const deltaPct = Math.abs((target - current) / current) * 100;
    if (deltaPct > maxDeltaPct) return { push: false, value: null, reason: SKIP.OUT_OF_BAND };
  }
  return { push: true, value: target, reason: null };
}

/**
 * Build the full per-(class, date) plan for one location.
 *
 * @param {object} p
 * @param {Array<{classCode: string, daily: number|string, rateItemId?: string}>} p.rfmRates
 * @param {string[]} p.dates                ISO yyyy-mm-dd, the grid columns to cover
 * @param {Record<string, Record<string, string|number>>} p.portalGrid  {CLASS: {date: value}}
 * @param {string[]} [p.portalClasses]      classes the portal offers
 * @param {Record<string,string>} [p.classOverrides]
 * @param {number|string} p.closeoutMin
 * @param {number} [p.maxDeltaPct]
 * @returns {{pushes: Array, skips: Array}}
 */
export function buildPushPlan({
  rfmRates = [], dates = [], portalGrid = {}, portalClasses = null,
  classOverrides = {}, closeoutMin, maxDeltaPct = 60,
} = {}) {
  const pushes = [];
  const skips = [];

  // ---- Collision resolution ------------------------------------------------
  // Several RFM classes can alias onto ONE portal class (LAX: RFM has both
  // IFAR and SFAR, the portal only IFAR). They carry different prices, so
  // pushing both would write the same cell twice and the last one would win
  // arbitrarily. Resolve deterministically instead: the class that matches the
  // portal code by IDENTITY owns it (Hector 2026-07-28 — IFAR's own price wins
  // over an aliased SFAR). With no identity claimant the choice is a business
  // one, so we publish NOTHING for that class and flag it for a human.
  const claimants = new Map(); // portalClass -> [rate, ...]
  const unmapped = [];
  for (const rate of rfmRates) {
    const portalClass = mapClassCode(rate.classCode, { overrides: classOverrides, portalClasses });
    if (!portalClass) { unmapped.push(rate); continue; }
    if (!claimants.has(portalClass)) claimants.set(portalClass, []);
    claimants.get(portalClass).push(rate);
  }

  for (const rate of unmapped) {
    skips.push({ classCode: rate.classCode, portalClass: null, rateDate: null, reason: SKIP.NO_CLASS_MAP });
  }

  const owners = new Map(); // portalClass -> the single rate that may write it
  for (const [portalClass, contenders] of claimants) {
    if (contenders.length === 1) { owners.set(portalClass, contenders[0]); continue; }
    const identity = contenders.find((r) => String(r.classCode).toUpperCase() === portalClass);
    if (identity) {
      owners.set(portalClass, identity);
      for (const loser of contenders.filter((r) => r !== identity)) {
        skips.push({ classCode: portalClass, rfmClassCode: loser.classCode, rateDate: null, reason: SKIP.COLLISION_LOST });
      }
    } else {
      // Ambiguous: two aliases, no identity. Never guess a price.
      for (const c of contenders) {
        skips.push({ classCode: portalClass, rfmClassCode: c.classCode, rateDate: null, reason: SKIP.COLLISION_UNRESOLVED });
      }
    }
  }

  for (const [portalClass, rate] of owners) {
    for (const rateDate of dates) {
      const portalValue = portalGrid?.[portalClass]?.[rateDate];
      const decision = decideCell({ rfmValue: rate.daily, portalValue, closeoutMin, maxDeltaPct });
      const row = {
        classCode: portalClass,
        rfmClassCode: rate.classCode,
        rateDate,
        priorValue: toAmount(portalValue),
        sourceRateItemId: rate.rateItemId || null,
      };
      if (decision.push) pushes.push({ ...row, pushedValue: decision.value });
      else skips.push({ ...row, reason: decision.reason });
    }
  }

  // Portal classes we hold no rate for — recorded so the gap is visible.
  if (portalClasses) {
    for (const pc of portalClasses) {
      const code = String(pc).toUpperCase();
      if (!claimants.has(code)) skips.push({ classCode: code, rateDate: null, reason: SKIP.NO_RFM_RATE });
    }
  }

  return { pushes, skips };
}

/**
 * Compare a re-read against what we sent. ApplyRates lies (returns success
 * while ignoring the value), so this — not the response body — decides whether
 * a push really landed.
 */
export function verifyPush({ pushedValue, readBackValue } = {}) {
  const sent = toAmount(pushedValue);
  const got = toAmount(readBackValue);
  if (sent === null) return { status: 'FAILED', verifiedValue: got };
  if (got === null) return { status: 'MISMATCH', verifiedValue: null };
  return { status: got === sent ? 'VERIFIED' : 'MISMATCH', verifiedValue: got };
}
