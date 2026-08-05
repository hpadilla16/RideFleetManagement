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

import { STOP_SALE_DAILY } from '../booking-source/stop-sale-closures.js';

export { STOP_SALE_DAILY };

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

/**
 * Is this exact cell+value pre-authorised? (F4)
 *
 * The match is deliberately STRICT on all three of class, date AND value: an
 * approval authorises the price the operator actually saw. If RFM's rate moves
 * afterwards, the old approval must NOT carry the new number through the band
 * — that would let an unreviewed price ride in on a stale decision. It goes
 * back to PENDING_APPROVAL instead.
 *
 * @param {Array<{classCode: string, rateDate: string, pushedValue: number|string}>} approvals
 */
export function isApproved(approvals, classCode, rateDate, value) {
  if (!Array.isArray(approvals) || !approvals.length) return false;
  const cls = String(classCode || '').toUpperCase();
  const amount = toAmount(value);
  if (amount === null) return false;
  return approvals.some((a) => (
    String(a?.classCode || '').toUpperCase() === cls
    && String(a?.rateDate || '') === String(rateDate)
    && toAmount(a?.pushedValue) === amount
  ));
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
 * @param {boolean} [p.approved]          a human authorised THIS exact value,
 *                                        so the delta band is bypassed for
 *                                        this cell only (F4). Every other
 *                                        guardrail still applies — an approval
 *                                        can never re-open a close-out, publish
 *                                        a zero, or create a close-out.
 * @returns {{push: boolean, value: number|null, reason: string|null}}
 */
export function decideCell({ rfmValue, portalValue, closeoutMin, maxDeltaPct = 60, approved = false, stopSale = false } = {}) {
  // A Ride stop sale (Hector, 2026-08-06) IS the operator decision the
  // "never create a close-out" refusal below exists to protect. The cell
  // closes by price — STOP_SALE_DAILY, at/above any sane sentinel — and the
  // delta band does not apply: holding a closure for review would leave a
  // closed class selling overnight. A cell the portal already shows closed
  // needs no write at all, whatever value closed it.
  if (stopSale) {
    const sentinel0 = toAmount(closeoutMin);
    if (sentinel0 === null) return { push: false, value: null, reason: SKIP.NO_SENTINEL };
    const current0 = toAmount(portalValue);
    if (current0 !== null && isCloseout(current0, sentinel0)) {
      return { push: false, value: null, reason: SKIP.CLOSEOUT_PRESERVED };
    }
    return { push: true, value: STOP_SALE_DAILY, reason: null, stopSale: true };
  }

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
  // Big swings against an EXISTING price are held for a human (F4: held, not
  // discarded — the caller queues them for approval). An unset cell
  // (current === null) has no baseline to swing from, so it is allowed, and an
  // explicit approval of THIS value bypasses the band for this cell only.
  if (!approved && current !== null && current > 0 && Number.isFinite(maxDeltaPct)) {
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
  classOverrides = {}, closeoutMin, maxDeltaPct = 60, approvals = [],
  closedDates = null,
} = {}) {
  const pushes = [];
  const skips = [];

  // Ride stop sales (Map<CLASS, Set<iso>> from stop-sale-closures.js). Checked
  // under BOTH the RFM class code and the portal's, so a class-code override
  // cannot open a hole in a closure.
  const isClosed = (rfmCode, portalCode, rateDate) => {
    if (!closedDates || typeof closedDates.get !== 'function') return false;
    const under = (code) => {
      const days = code ? closedDates.get(String(code).toUpperCase()) : null;
      return !!days && days.has(rateDate);
    };
    return under(rfmCode) || under(portalCode);
  };

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
      // F4: a human may have pre-authorised this exact (class, date, value).
      const approved = isApproved(approvals, portalClass, rateDate, rate.daily);
      const stopSale = isClosed(rate.classCode, portalClass, rateDate);
      const decision = decideCell({ rfmValue: rate.daily, portalValue, closeoutMin, maxDeltaPct, approved, stopSale });
      const row = {
        classCode: portalClass,
        rfmClassCode: rate.classCode,
        rateDate,
        priorValue: toAmount(portalValue),
        sourceRateItemId: rate.rateItemId || null,
        approved,
        ...(stopSale ? { stopSale: true } : {}),
      };
      if (decision.push) pushes.push({ ...row, pushedValue: decision.value });
      // `intendedValue` is what we WOULD have published — it makes an
      // out-of-band row readable as "portal $11 -> RFM $20" in the approval
      // queue instead of a bare zero placeholder.
      else skips.push({ ...row, reason: decision.reason, intendedValue: toAmount(rate.daily) });
    }
  }

  // Portal classes we hold no rate for — recorded so the gap is visible. A
  // closed date on such a class STILL pushes its close-out: the closure
  // matters more than the price, and skipping it would leave a class Ride has
  // declared unsellable open at the portal's own rate.
  if (portalClasses) {
    for (const pc of portalClasses) {
      const code = String(pc).toUpperCase();
      if (claimants.has(code)) continue;
      let closedAny = false;
      for (const rateDate of dates) {
        if (!isClosed(code, code, rateDate)) continue;
        closedAny = true;
        const portalValue = portalGrid?.[code]?.[rateDate];
        const decision = decideCell({ portalValue, closeoutMin, stopSale: true });
        const row = { classCode: code, rfmClassCode: code, rateDate, priorValue: toAmount(portalValue), sourceRateItemId: null, stopSale: true };
        if (decision.push) pushes.push({ ...row, pushedValue: decision.value });
        else skips.push({ ...row, reason: decision.reason, intendedValue: STOP_SALE_DAILY });
      }
      if (!closedAny) skips.push({ classCode: code, rateDate: null, reason: SKIP.NO_RFM_RATE });
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
