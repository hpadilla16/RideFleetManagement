/**
 * Advantage reservation ingestion BY EMAIL — constants.
 *
 * WHY THIS EXISTS AT ALL. Every other booking source in RFM is a portal
 * scraper (Economy/RezLight, NU, Flexways, MEX, TL, and Advantage's own TSD
 * RezCentral worker). Advantage has told us there is no integration to scrape
 * for this account:
 *
 *   Ryan White, IT Manager, Advantage Car Rental, 2026-09-08:
 *   "Since there is no TSD integration, everything will need to be done VIA
 *    email delivery."
 *
 * So this module adds the one thing the codebase did not have — an INBOUND
 * mail path — and then hands off to machinery that already exists. It stages
 * into ExternalReservation exactly like the scrapers, and promotes through the
 * SAME shared promoter (createPromoter), the SAME matcher (evaluatePromotion)
 * and the SAME franchise resolver (resolveImportFranchiseId).
 *
 * TWO sourceSystem VALUES, ON PURPOSE:
 *   - SOURCE_SYSTEM = 'ADVANTAGE' for the STAGED ROWS. A booking is a booking
 *     however it reached us; the review tray, the franchise resolver and the
 *     (sourceSystem, externalRef) unique all key on this. If the portal worker
 *     ever becomes available for the same account, both paths converge on ONE
 *     row for confirmation AEXP141D54 instead of racing to create two.
 *   - CREDENTIAL_SOURCE_SYSTEM / RUN_SOURCE_SYSTEM = 'ADVANTAGE_EMAIL' for the
 *     IntegrationCredential row and the ExternalSyncRun rows. IntegrationCredential
 *     is unique on (tenantId, sourceSystem) and the portal worker already owns
 *     'ADVANTAGE' there with the TSD portal login — a mailbox password is a
 *     different secret and must not evict it. Keeping the RUNS separate too is
 *     what makes "the mailbox has been quiet for two days" legible in the panel
 *     instead of averaged into a scraper's run history.
 *
 * MONEY POSTURE, UNCHANGED: estimatedTotal only. The email carries far more
 * than any scraper does — an assigned unit, mileage and fuel out, counter
 * extras with prices, card authorizations and a CARD DEPOSIT — and ALL of it
 * is parsed and kept in rawJson, but NONE of it moves money, assigns a
 * vehicle, or touches a card. See advantage-email.worker.js.
 *
 * NO NEW npm DEPENDENCIES. The IMAP client (imap-client.js) and the MIME text
 * extractor (mime-text.js) are written here rather than pulled in, so nothing
 * about a mail library's licence or transitive tree lands in a PCI-scoped
 * deployment for a feature this narrow.
 *
 * See doc/advantage-email-ingestion-2026-09-08.md
 */

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

/** ExternalReservation.sourceSystem — SHARED with the TSD portal worker. */
export const SOURCE_SYSTEM = 'ADVANTAGE';

/** IntegrationCredential.sourceSystem — the MAILBOX secret, not the portal's. */
export const CREDENTIAL_SOURCE_SYSTEM = 'ADVANTAGE_EMAIL';

/** ExternalSyncRun.sourceSystem — this transport's own run history. */
export const RUN_SOURCE_SYSTEM = 'ADVANTAGE_EMAIL';

/** Reservation.bookingChannel on promote — same brand as the portal path. */
export const BOOKING_CHANNEL = 'FRANCHISE_ADVANTAGE';

/** Reservation.reservationNumber prefix — same as the portal path. */
export const RESERVATION_PREFIX = 'ADV-';

/** BullMQ queue. */
export const QUEUE_NAME = 'advantage-email.sync';

/** Tenant.integrationConfig key for the per-tenant master switch. */
export const CONFIG_KEY = 'advantageEmail';

/** Env prefix for the shared scheduler factory. */
export const ENV_PREFIX = 'ADVANTAGE_EMAIL';

export const LOG_PREFIX = '[advantage-email]';

/**
 * The wall-clock timezone the email's dates are written in. The sample stamps
 * "Date Booked : 2026/08/07 13:52 (ET)" and every other timestamp is bare, so
 * they are all branch-local Eastern for an MCO account. Falls back to the
 * portal worker's setting so a tenant that already tuned ADVANTAGE_TIME_ZONE
 * does not have to tune it twice.
 */
export const TIME_ZONE = process.env.ADVANTAGE_EMAIL_TIME_ZONE
  || process.env.ADVANTAGE_TIME_ZONE
  || 'America/New_York';

// ---------------------------------------------------------------------------
// Document type — the banner on line 2 ("AMADEUS ***CONFIRMATION***")
// ---------------------------------------------------------------------------

/**
 * WHY THE BANNER IS THE WHOLE IDEMPOTENCY STORY.
 *
 * We asked Advantage whether the same confirmation arrives again on a
 * modification or a cancellation and DO NOT YET HAVE THE ANSWER (see
 * "Questions still open with Ryan" in the plan doc). The sample itself argues
 * that re-sends happen: it is banner-dated 2026/08/07 at booking time, yet it
 * already carries a RENTAL AGREEMENT DETAILS block with a Date Out of
 * 2026/09/03 10:22 and a 381.80 deposit taken that morning. That document was
 * regenerated a month after the booking it describes.
 *
 * So the pipeline is built to be re-send-safe either way: ExternalReservation
 * is unique on (sourceSystem, externalRef) and every message UPSERTS, so a
 * second copy enriches the row rather than duplicating it.
 *
 * A CANCELLATION, though, cannot be inferred — it has to be RECOGNISED. The
 * banner is the only field that carries that meaning, so it is treated as a
 * closed vocabulary: a token we know maps to a decision, and a token we do NOT
 * know QUARANTINES the message (staged nowhere, counted, named in the run
 * notes) rather than being silently read as a confirmation. Guessing here means
 * either resurrecting a cancelled booking or cancelling a live one.
 */
export const DOC_TYPES = Object.freeze({
  CONFIRMATION: 'CONFIRMATION',
  MODIFICATION: 'MODIFICATION',
  CANCELLATION: 'CANCELLATION',
  UNKNOWN: 'UNKNOWN',
});

/**
 * Banner token → document type. Keys are the UPPERCASED word(s) found between
 * the asterisks. Extend this ONLY with a token seen in a real message.
 */
export const DOC_TYPE_TOKENS = Object.freeze({
  CONFIRMATION: DOC_TYPES.CONFIRMATION,
  CONFIRMED: DOC_TYPES.CONFIRMATION,
  RESERVATION: DOC_TYPES.CONFIRMATION,
  MODIFICATION: DOC_TYPES.MODIFICATION,
  MODIFIED: DOC_TYPES.MODIFICATION,
  MODIFY: DOC_TYPES.MODIFICATION,
  CHANGE: DOC_TYPES.MODIFICATION,
  CHANGED: DOC_TYPES.MODIFICATION,
  AMENDMENT: DOC_TYPES.MODIFICATION,
  CANCELLATION: DOC_TYPES.CANCELLATION,
  CANCELATION: DOC_TYPES.CANCELLATION,
  CANCELLED: DOC_TYPES.CANCELLATION,
  CANCELED: DOC_TYPES.CANCELLATION,
  CANCEL: DOC_TYPES.CANCELLATION,
  VOID: DOC_TYPES.CANCELLATION,
});

/** Document types that produce a live, promotable staged row. */
export const PROMOTABLE_DOC_TYPES = Object.freeze([
  DOC_TYPES.CONFIRMATION,
  DOC_TYPES.MODIFICATION,
]);

/** ExternalReservation.rejectedReason for a cancellation email. */
export const REJECT_REASONS = Object.freeze({
  SOURCE_CANCELLED: 'source_cancelled',
});

/**
 * Why a message was set aside instead of imported. Stored on
 * AdvantageInboundEmail.failureReason and summarised in the run notes.
 */
export const QUARANTINE_REASONS = Object.freeze({
  UNKNOWN_DOC_TYPE: 'unknown_doc_type',
  LAYOUT: 'layout',
  NO_TEXT_BODY: 'no_text_body',
  SENDER_NOT_ALLOWED: 'sender_not_allowed',
  LOCATION_NOT_CONFIGURED: 'location_not_configured',
  CROSS_TENANT: 'cross_tenant',
});

/** AdvantageInboundEmail.status values. */
export const INBOUND_STATUS = Object.freeze({
  IMPORTED: 'IMPORTED',
  QUARANTINED: 'QUARANTINED',
  FAILED: 'FAILED',
});

// ---------------------------------------------------------------------------
// Mailbox / transport configuration
// ---------------------------------------------------------------------------

function envStr(name, fallback = '') {
  const raw = process.env[name];
  return raw == null || String(raw).trim() === '' ? fallback : String(raw).trim();
}

function envNum(name, fallback) {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * Host/port/TLS DEFAULTS. The real values live in the per-tenant encrypted
 * credential blob (set from the panel, never in chat or in code — Hector's
 * standing rule); these only fill in when the blob omits them, so a fleet of
 * tenants on one provider can be configured once on the droplet.
 *
 * Read through functions, not frozen at import: the worker process reads its
 * env before these modules load in some boot orders, and a constant captured at
 * import time is how an ops toggle silently does nothing.
 */
export function defaultImapHost() { return envStr('ADVANTAGE_EMAIL_IMAP_HOST'); }
export function defaultImapPort() { return envNum('ADVANTAGE_EMAIL_IMAP_PORT', 993); }
export function defaultImapSecure() {
  return envStr('ADVANTAGE_EMAIL_IMAP_SECURE', 'true').toLowerCase() !== 'false';
}

/** Folder polled for new mail. */
export function defaultMailbox() { return envStr('ADVANTAGE_EMAIL_MAILBOX', 'INBOX'); }

/**
 * Folder a successfully handled message is MOVED to. Empty (the default) means
 * "do not move" — the message is only flagged \Seen. Moving is nicer
 * housekeeping, but it rearranges a mailbox whose policy is not ours, so it is
 * opt-in.
 */
export function defaultProcessedMailbox() {
  return envStr('ADVANTAGE_EMAIL_PROCESSED_MAILBOX', '');
}

/**
 * Cap on messages handled per run. A backlog drains over consecutive runs
 * rather than in one job holding a connection open for an hour.
 */
export function maxMessagesPerRun() { return envNum('ADVANTAGE_EMAIL_MAX_PER_RUN', 200); }

/** Socket + per-command timeouts (ms). */
export function connectTimeoutMs() { return envNum('ADVANTAGE_EMAIL_CONNECT_TIMEOUT_MS', 20000); }
export function commandTimeoutMs() { return envNum('ADVANTAGE_EMAIL_COMMAND_TIMEOUT_MS', 60000); }

/**
 * SENDER ALLOWLIST — comma-separated domains and/or full addresses, matched
 * case-insensitively against the From header.
 *
 * STATED PLAINLY: an inbound mailbox is a WRITE PATH INTO THE RESERVATION
 * SYSTEM that anyone who learns the address can post to, and a From header is
 * forgeable, so this is a speed bump and not a boundary. What actually keeps a
 * forged message from becoming a rental is the rest of the pipeline: the
 * (tsdNumber, branch) pair must match an ENABLED AdvantageLocationConfig row
 * for THIS tenant, the row lands in staging, and it still has to pass every
 * promotion gate before it becomes a Reservation.
 *
 * Default EMPTY = accept any sender. That is deliberately not silent: the run
 * notes and GET /status both report the allowlist as `unrestricted` so the gap
 * is visible in the panel rather than assumed away.
 */
export function allowedSenders() {
  return envStr('ADVANTAGE_EMAIL_ALLOWED_SENDERS')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

/** Pull the bare address out of a From header ("Name <a@b.com>" → "a@b.com"). */
export function extractAddress(header) {
  const s = String(header || '').trim();
  if (!s) return null;
  const angled = s.match(/<([^>]+)>/);
  const raw = (angled ? angled[1] : s).trim().toLowerCase();
  if (!raw.includes('@')) return null;
  // Strip any stray display text left over from an unbracketed header.
  const token = raw.split(/\s+/).find((t) => t.includes('@'));
  return token || null;
}

/**
 * Does `fromHeader` satisfy the allowlist? An empty list accepts everything.
 * An entry containing '@' must match the address exactly; an entry without one
 * is a domain and matches that domain or any subdomain of it.
 */
export function senderAllowed(fromHeader, list = allowedSenders()) {
  if (!list.length) return true;
  const addr = extractAddress(fromHeader);
  if (!addr) return false;
  const domain = addr.slice(addr.lastIndexOf('@') + 1);
  return list.some((entry) => (entry.includes('@')
    ? entry === addr
    : domain === entry || domain.endsWith(`.${entry}`)));
}
