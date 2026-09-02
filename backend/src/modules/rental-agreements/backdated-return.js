/**
 * Backdating a check-in: who may, how far, and what it must never do.
 *
 * THE CASE (Hector, 2026-08-10): "si estan haciendo un check in que el cliente
 * entrego el dia que era pero los agentes no le hicieron el checkin." The
 * customer returned the car on time; staff recorded the check-in days later.
 * The fee engine computes LATE_RETURN from `returnedAt`, which defaulted to
 * the moment the wizard fired — so the customer was billed for the STAFF's
 * delay. An admin needs to state when the car actually came back, and the
 * money must follow that statement.
 *
 * The plumbing already existed: checkin-close accepts payload.returnedAt and
 * the fee engine honours it. What did not exist was a gate. Any API caller
 * could backdate any check-in silently — no role check, no bounds, no trail.
 * Exposing the field in the UI without adding the gate would have turned a
 * fee-forgiveness convenience into an invisible way to erase late fees.
 *
 * Rules, in the order they are checked:
 *   - a small grace (default 15 min) is anyone's: clock skew and walking from
 *     the car to the counter are not "backdating";
 *   - beyond that, ADMIN / OPS / SUPER_ADMIN only;
 *   - never before the rental began (finalizedAt, falling back to pickupAt) —
 *     a car cannot come back before it left;
 *   - never in the future beyond the same grace: a check-in is a record of
 *     something that happened, not a plan.
 */

export const BACKDATE_ROLES = Object.freeze(['ADMIN', 'OPS', 'SUPER_ADMIN']);
export const BACKDATE_GRACE_MS = 15 * 60 * 1000;

/**
 * Machine-attested backdate sources (2026-09-02). The role gate below polices
 * HUMAN-asserted backdates — "the car came back Tuesday, trust me". A QR
 * self-return stamp is different in kind: the system recorded the moment as
 * it happened (customer scan, tokenized per-location page, first-stamp-wins),
 * it can only ever move the return time EARLIER at close, and it is
 * admin-voidable. Evidence from this list skips ONLY the role rule; the
 * sanity bounds (not in the future, not before the rental started) still
 * apply — evidence can prove when the car came back, it cannot make time run
 * backwards.
 */
export const BACKDATE_EVIDENCE_SOURCES = Object.freeze(['CUSTOMER_SELF_RETURN']);

/**
 * @returns {{ok: true, backdated: boolean} | {ok: false, error: string}}
 */
export function validateBackdatedReturn({
  returnedAt,
  now = new Date(),
  role = 'AGENT',
  rentalStartAt = null,
  graceMs = BACKDATE_GRACE_MS,
  evidence = null,
} = {}) {
  const when = returnedAt instanceof Date ? returnedAt : new Date(returnedAt);
  if (Number.isNaN(when.getTime())) return { ok: false, error: 'returnedAt is not a valid date' };

  const nowMs = (now instanceof Date ? now : new Date(now)).getTime();

  if (when.getTime() > nowMs + graceMs) {
    return { ok: false, error: 'The actual return time cannot be in the future.' };
  }

  const start = rentalStartAt ? new Date(rentalStartAt) : null;
  if (start && !Number.isNaN(start.getTime()) && when.getTime() < start.getTime()) {
    return { ok: false, error: 'The actual return time cannot be before the rental started.' };
  }

  const backdated = nowMs - when.getTime() > graceMs;
  const evidenceBacked = BACKDATE_EVIDENCE_SOURCES.includes(String(evidence || '').toUpperCase());
  if (backdated && !evidenceBacked && !BACKDATE_ROLES.includes(String(role || '').toUpperCase())) {
    return { ok: false, error: 'Only an admin can backdate a check-in. Ask an admin to close this rental with the actual return date.' };
  }

  return { ok: true, backdated };
}

/** The system note a backdated close leaves behind — greppable months later. */
export function backdatedReturnNote({ returnedAt, actorRole, now = new Date() }) {
  const when = (returnedAt instanceof Date ? returnedAt : new Date(returnedAt)).toISOString();
  const at = (now instanceof Date ? now : new Date(now)).toISOString();
  return `[BACKDATED CHECK-IN ${at}] actual return set to ${when} by ${String(actorRole || 'UNKNOWN').toUpperCase()} — late-fee math uses this timestamp`;
}
