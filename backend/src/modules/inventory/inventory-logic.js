/**
 * Inventory Helper — pure logic (2026-06-09).
 *
 * No DB, no I/O — just the decision rules, so they're unit-testable in
 * isolation and shared between the snapshot path and the gating path:
 *   - detectMismatch: does a vehicle's stored status disagree with reservation truth?
 *   - canCompleteSession: is every item handled + every mismatch resolved?
 *   - computeTotals: denormalized counts for progress UI + report summary.
 *
 * Mismatch rules mirror the invariant in vehicle-status-sync.js
 * (sweepVehicleStatusDrift), plus the "overdue" nuance the sweep can't auto-fix.
 */

export const MISMATCH = { ON_RENT_OVERDUE: 'ON_RENT_OVERDUE', SHOULD_BE_ON_RENT: 'SHOULD_BE_ON_RENT' };

/**
 * Decide whether a vehicle is in a status-mismatch state.
 * @param {object} v
 * @param {string} v.status — VehicleStatus (AVAILABLE, ON_RENT, ...)
 * @param {{returnAt?: Date|string|null}|null} v.checkedOutReservation
 *        the vehicle's current CHECKED_OUT reservation, or null if none
 * @param {Date} [now]
 * @returns {('ON_RENT_OVERDUE'|'SHOULD_BE_ON_RENT'|null)}
 */
export function detectMismatch(v, now = new Date()) {
  const status = String(v?.status || '').toUpperCase();
  const res = v?.checkedOutReservation || null;

  // Marked out on the road but no live checkout → handled by the sweep, not a
  // mismatch we surface here.
  if (status === 'ON_RENT') {
    if (!res) return null;
    const due = res.returnAt ? new Date(res.returnAt) : null;
    if (due && !Number.isNaN(due.getTime()) && due.getTime() < now.getTime()) {
      // Out on rent but the return was due in the past — "checked out but
      // should be checked in". This is the case the sweep leaves alone.
      return MISMATCH.ON_RENT_OVERDUE;
    }
    return null;
  }

  // On the lot per the system, but a reservation says it's checked out.
  if ((status === 'AVAILABLE' || status === 'RESERVED') && res) {
    return MISMATCH.SHOULD_BE_ON_RENT;
  }

  return null;
}

const DONE_STATES = new Set(['CONFIRMED', 'EXCEPTION']);

function itemDone(item) {
  return DONE_STATES.has(String(item?.state || '').toUpperCase());
}

function mismatchHandled(item) {
  if (!item?.mismatchType) return true;
  return item.mismatchResolved === true;
}

/**
 * Can the session be completed?
 * Rule (per Hector, 2026-06-09): every item must be CONFIRMED or EXCEPTION, AND
 * every item carrying a mismatch must be resolved.
 * @returns {{ok:boolean, pending:number, unresolvedMismatches:number, reasons:string[]}}
 */
export function canCompleteSession(items = []) {
  const pending = items.filter((it) => !itemDone(it)).length;
  const unresolvedMismatches = items.filter((it) => !mismatchHandled(it)).length;
  const reasons = [];
  if (pending > 0) reasons.push(`${pending} vehicle(s) not yet confirmed or marked as exception`);
  if (unresolvedMismatches > 0) reasons.push(`${unresolvedMismatches} status mismatch(es) still need resolving`);
  return { ok: pending === 0 && unresolvedMismatches === 0, pending, unresolvedMismatches, reasons };
}

/**
 * Denormalized counts for the session (progress UI + report summary).
 */
export function computeTotals(items = []) {
  const t = {
    total: items.length,
    pending: 0,
    confirmed: 0,
    exception: 0,
    mismatches: 0,
    mismatchesResolved: 0,
    atLot: 0,
    maintenance: 0,
    onRent: 0,
  };
  for (const it of items) {
    const state = String(it?.state || '').toUpperCase();
    if (state === 'CONFIRMED') t.confirmed += 1;
    else if (state === 'EXCEPTION') t.exception += 1;
    else t.pending += 1;

    if (it?.mismatchType) {
      t.mismatches += 1;
      if (it.mismatchResolved === true) t.mismatchesResolved += 1;
    }

    const located = String(it?.locatedStatus || '').toUpperCase();
    if (located === 'AT_LOT') t.atLot += 1;
    else if (located === 'IN_MAINTENANCE' || located === 'OUT_OF_SERVICE') t.maintenance += 1;
    else if (located === 'ON_RENT') t.onRent += 1;
  }
  return t;
}
