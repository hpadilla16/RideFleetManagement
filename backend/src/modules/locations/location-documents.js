/**
 * Business-document expiry logic (2026-07-28). PURE — no IO, no prisma.
 *
 * A branch's paperwork (permits, registrations, insurance) has to be current
 * for it to trade legally. Expiry is computed HERE, from expiresAt, every time
 * it is read — never stored. A cached "valid/expired" flag would go stale the
 * moment a day passed without a sweep, and a document that merely LOOKS valid
 * is worse than having no record of it at all.
 */

/** Document kinds offered in the picker. OTHER keeps it open-ended. */
export const DOC_TYPES = Object.freeze([
  'PERMIT', 'REGISTRATION', 'INSURANCE', 'LICENSE', 'TAX', 'LEASE', 'OTHER',
]);

/** How far ahead we start warning. Hector's ask: 30 days. */
export const DEFAULT_WARN_DAYS = 30;

export const DOC_STATUS = Object.freeze({
  VALID: 'VALID',
  EXPIRING: 'EXPIRING',   // inside the warning window
  EXPIRED: 'EXPIRED',
  NO_EXPIRY: 'NO_EXPIRY', // perpetual — never chased
});

/** Midnight UTC for a date-only value, so comparisons never wobble by hours. */
function startOfUtcDay(value) {
  // Reject empties BEFORE Date sees them: new Date(null) is the 1970 epoch, a
  // perfectly valid date, so a document with no expiry would otherwise read as
  // "expired 20,000 days ago" and shout on the dashboard forever.
  if (value === null || value === undefined || value === '') return null;
  const d = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(d.valueOf())) return null;
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

/**
 * Whole days from `now` until `expiresAt`. Negative once past.
 * Date-only on both sides: a document is valid for the WHOLE of its final day,
 * so "expires today" is 0 days left, not a fraction that rounds to expired.
 */
export function daysUntilExpiry(expiresAt, now = new Date()) {
  const end = startOfUtcDay(expiresAt);
  const today = startOfUtcDay(now);
  if (end === null || today === null) return null;
  return Math.round((end - today) / 86400000);
}

/**
 * Classify one document.
 * @returns {{status: string, daysLeft: number|null}}
 */
export function documentExpiryStatus(expiresAt, { now = new Date(), warnDays = DEFAULT_WARN_DAYS } = {}) {
  if (expiresAt === null || expiresAt === undefined || expiresAt === '') {
    return { status: DOC_STATUS.NO_EXPIRY, daysLeft: null };
  }
  const daysLeft = daysUntilExpiry(expiresAt, now);
  if (daysLeft === null) return { status: DOC_STATUS.NO_EXPIRY, daysLeft: null };
  if (daysLeft < 0) return { status: DOC_STATUS.EXPIRED, daysLeft };
  const window = Number.isFinite(Number(warnDays)) ? Number(warnDays) : DEFAULT_WARN_DAYS;
  if (daysLeft <= window) return { status: DOC_STATUS.EXPIRING, daysLeft };
  return { status: DOC_STATUS.VALID, daysLeft };
}

/** Does this document need the operator's attention right now? */
export function needsAttention(expiresAt, opts = {}) {
  const { status } = documentExpiryStatus(expiresAt, opts);
  return status === DOC_STATUS.EXPIRING || status === DOC_STATUS.EXPIRED;
}

/**
 * Sort for the alert list: the most urgent first — already-expired before
 * merely-expiring, and within each the nearest date leads. Documents with no
 * expiry never appear here at all.
 */
export function sortByUrgency(docs = [], opts = {}) {
  return [...docs]
    .filter((d) => needsAttention(d?.expiresAt, opts))
    .sort((a, b) => {
      const da = daysUntilExpiry(a.expiresAt, opts.now) ?? 0;
      const db = daysUntilExpiry(b.expiresAt, opts.now) ?? 0;
      return da - db;
    });
}

/** Normalise a submitted docType; anything unrecognised becomes OTHER. */
export function normalizeDocType(v) {
  const t = String(v || '').trim().toUpperCase();
  return DOC_TYPES.includes(t) ? t : 'OTHER';
}
