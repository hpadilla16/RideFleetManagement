/**
 * QR self-return — the pure decisions (Hector, 2026-09-02). IO lives in
 * self-return.service.js; this file owns the rules and is testable without
 * Prisma, Redis, or a clock.
 *
 * THE CASE: the customer parks the car in the return area, scans the QR on
 * the poster, types their reservation number + last name, and taps "Devolví
 * el carro". An agent runs the check-in later — sometimes much later — and
 * the late fee used to run to the moment the wizard fired. The stamp records
 * when the customer actually handed the car back, and check-in close uses
 * that moment as the effective return time WHEN IT HELPS THE CUSTOMER
 * (earlier than the close's own return time). It never closes the agreement,
 * never touches the vehicle, never runs fees — the check-in stays the
 * agent's job.
 *
 * ABUSE POSTURE, in order of defense:
 *   - the QR token is unguessable (192-bit) and per-location; disabled or
 *     revoked reads exactly like unknown — the public page is a uniform 404;
 *   - identity is the (reservation number, last name) PAIR; any mismatch —
 *     wrong number, wrong name, wrong tenant, not an open rental — is the
 *     same generic not-found, so the form is never an existence oracle;
 *   - a stamp can only ever CAP fees downward (the earlier-only rule), the
 *     agent sees both timestamps at close, and an ADMIN can void;
 *   - a second scan is idempotent: the FIRST stamp stands.
 */
import crypto from 'node:crypto';

/** 192-bit random, base64url — the house public-token mint (same as
 *  ShuttleTrackerLink / ShuttleDriverShift). */
export function mintSelfReturnToken() {
  return crypto.randomBytes(24).toString('base64url');
}

/** Only an open rental can be handed back. Everything else — NEW, CONFIRMED,
 *  already checked in, cancelled — refuses as the same generic not-found. */
export const STAMPABLE_STATUSES = Object.freeze(['CHECKED_OUT']);

/** Roles that may void a stamp — deliberately the SAME set that may backdate
 *  a check-in (backdated-return.js BACKDATE_ROLES): both actions move the
 *  same late-fee money. */
export const SELF_RETURN_VOID_ROLES = Object.freeze(['ADMIN', 'OPS', 'SUPER_ADMIN']);

/** Public page path for a QR token (the QR encodes origin + this). */
export function selfReturnLinkPath(token) {
  return `/return/${token}`;
}

/** Is this QR row usable right now? Absent row and revoked row both read
 *  DISABLED — the route collapses everything into the same bare 404. */
export function qrState(row) {
  if (!row) return 'DISABLED';
  if (row.revokedAt) return 'DISABLED';
  return 'ACTIVE';
}

const stripAccents = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '');

/** Reservation-number input, normalized the way a phone keyboard mangles it:
 *  trimmed, uppercased. Empty → null. */
export function normalizeReservationNumber(input) {
  const s = String(input || '').trim().toUpperCase();
  return s || null;
}

/**
 * The verification pair's second half. Case-, accent- and whitespace-
 * insensitive: "peña" typed as "Pena" on an airport phone must still match.
 * Also accepts a match against the FULL last name when the customer has a
 * compound one and typed only part ("De la Cruz" vs "Cruz" does NOT match —
 * only exact-after-normalization; looser matching would weaken the pair).
 */
export function lastNameMatches(input, actualLastName) {
  const a = stripAccents(input).trim().replace(/\s+/g, ' ').toLowerCase();
  const b = stripAccents(actualLastName).trim().replace(/\s+/g, ' ').toLowerCase();
  return !!a && !!b && a === b;
}

/** Does this reservation carry a live (un-voided) self-return stamp? */
export function hasActiveSelfReturnStamp(reservation) {
  if (!reservation) return false;
  const at = reservation.customerReportedReturnAt
    ? new Date(reservation.customerReportedReturnAt).getTime()
    : NaN;
  return Number.isFinite(at) && !reservation.customerReportedReturnVoidedAt;
}

/**
 * Invariant (b): the stamp becomes the effective return time ONLY when it is
 * strictly EARLIER than what the close would otherwise use. A stamp later
 * than the close's return time is a no-op — it exists to stop a fee for the
 * counter's delay, never to extend one.
 *
 * @returns {Date|null} the stamp time to use, or null (keep the close's).
 */
export function selfReturnOverride({ reportedAt, closeReturnedAt } = {}) {
  const r = reportedAt instanceof Date ? reportedAt : new Date(reportedAt || NaN);
  const c = closeReturnedAt instanceof Date ? closeReturnedAt : new Date(closeReturnedAt || NaN);
  if (!Number.isFinite(r.getTime()) || !Number.isFinite(c.getTime())) return null;
  return r.getTime() < c.getTime() ? r : null;
}

/** May this staff role void a stamp? */
export function canVoidSelfReturn(role) {
  return SELF_RETURN_VOID_ROLES.includes(String(role || '').toUpperCase());
}

/** Capped request metadata stored with the stamp — abuse triage, never PII
 *  beyond what the request itself already carried. */
export function buildStampMeta({ ip = null, userAgent = null } = {}) {
  return JSON.stringify({
    ip: String(ip || '').slice(0, 64) || null,
    userAgent: String(userAgent || '').slice(0, 200) || null,
  });
}

/** The system note a void leaves in the audit metadata — greppable later. */
export function selfReturnVoidNote({ reportedAt, reason, now = new Date() }) {
  const when = (reportedAt instanceof Date ? reportedAt : new Date(reportedAt)).toISOString();
  const at = (now instanceof Date ? now : new Date(now)).toISOString();
  return `[SELF-RETURN VOIDED ${at}] customer return stamp of ${when} voided${reason ? ` — ${String(reason).trim()}` : ''}`;
}
