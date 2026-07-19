/**
 * S27 W-D (2026-07-19) — service-account validators for the agent-workspace
 * operations that go BEYOND the W1 field patch: cancel and reschedule.
 * Pure + unit-testable (vozia-reservation-ops.test.mjs), same pattern as
 * vozia-reservation-patch.js. The allowlist opens the PATH; these are the
 * payload gates.
 *
 * Política Hector 2026-07-19: los agentes humanos operan DIRECTO — pero solo
 * PRE-PICKUP. Cancel/reschedule aplican únicamente en NEW/CONFIRMED; todo lo
 * demás (CHECKED_OUT etc.) sigue siendo el flujo humano/admin de siempre.
 */

export const VOZIA_TICKET_RE = /^[A-Za-z0-9._-]{1,64}$/;
export const VOZIA_PRE_PICKUP_STATUSES = ['NEW', 'CONFIRMED'];
const AUTHOR_MAX = 120;
const REASON_MAX = 500;

function checkAttribution(body, errors) {
  const author = typeof body.author === 'string' ? body.author.trim() : '';
  if (!author) errors.push('author is required');
  else if (author.length > AUTHOR_MAX) errors.push(`author must be ${AUTHOR_MAX} characters or fewer`);

  const ticketId = typeof body.ticketId === 'string' ? body.ticketId.trim() : '';
  if (!ticketId || !VOZIA_TICKET_RE.test(ticketId)) {
    errors.push('ticketId is required and must match ^[A-Za-z0-9._-]{1,64}$');
  }
  return { author, ticketId };
}

/**
 * Cancel payload: { status: 'CANCELLED', cancellationReason, author, ticketId }.
 * Reason is MANDATORY for service accounts (the human route treats it as
 * optional-but-consumed; for the agent workspace it is the audit trail).
 */
export function validateVoziaCancelPayload(body = {}) {
  const errors = [];
  const allowed = new Set(['status', 'cancellationReason', 'author', 'ticketId']);
  const stray = Object.keys(body || {}).filter((k) => !allowed.has(k));
  if (stray.length) {
    errors.push(`Field(s) not allowed on a VozIA cancel: ${stray.join(', ')}.`);
  }
  if (body.status !== 'CANCELLED') {
    errors.push("status must be 'CANCELLED'");
  }
  const reason = typeof body.cancellationReason === 'string' ? body.cancellationReason.trim() : '';
  if (!reason) errors.push('cancellationReason is required');
  else if (reason.length > REASON_MAX) {
    errors.push(`cancellationReason must be ${REASON_MAX} characters or fewer`);
  }
  const { author, ticketId } = checkAttribution(body || {}, errors);
  return { errors, value: { reason, author, ticketId } };
}

/**
 * Reschedule payload: { pickupAt, returnAt, pickupLocationId?, expectedNewTotal,
 * author, ticketId }. expectedNewTotal is the STALENESS GUARD (Innovation,
 * plan 2026-07-19): the write carries the total the agent SAW in the preview;
 * the route re-prices server-side and 409s on drift — the customer never gets
 * quoted one number and charged another.
 */
export function validateVoziaReschedulePayload(body = {}) {
  const errors = [];
  const allowed = new Set([
    'pickupAt', 'returnAt', 'pickupLocationId', 'expectedNewTotal', 'author', 'ticketId'
  ]);
  const stray = Object.keys(body || {}).filter((k) => !allowed.has(k));
  if (stray.length) {
    errors.push(`Field(s) not allowed on a VozIA reschedule: ${stray.join(', ')}.`);
  }

  // Innovation MC-1 (2026-07-19): dates pass through RAW. Parsing here with
  // `new Date()` would read a naive "2026-08-01T10:00" as server-local (UTC in
  // the container) while quotesService.preview / reservationsService.update
  // parse it as TENANT wall-clock (parseDateTimeInTz — the repo convention).
  // The parsed Dates below are used ONLY for the ordering sanity check; the
  // raw strings are what preview() and update() receive, so preview and apply
  // can never disagree by a timezone.
  const parseDate = (label) => {
    const raw = body[label];
    const s = typeof raw === 'string' ? raw.trim() : '';
    const d = s ? new Date(s) : null;
    if (!s || !d || Number.isNaN(d.getTime())) {
      errors.push(`${label} is required and must be a parseable date`);
      return null;
    }
    return { raw: s, parsed: d };
  };
  const pickup = parseDate('pickupAt');
  const ret = parseDate('returnAt');
  if (pickup && ret && ret.parsed <= pickup.parsed) {
    errors.push('returnAt must be after pickupAt');
  }
  const pickupAt = pickup ? pickup.raw : null;
  const returnAt = ret ? ret.raw : null;

  let pickupLocationId;
  if (body.pickupLocationId !== undefined) {
    pickupLocationId = typeof body.pickupLocationId === 'string' ? body.pickupLocationId.trim() : '';
    if (!pickupLocationId) errors.push('pickupLocationId, when present, must be a non-empty string');
  }

  const expectedNewTotal = Number(body.expectedNewTotal);
  if (body.expectedNewTotal === undefined || !Number.isFinite(expectedNewTotal) || expectedNewTotal < 0) {
    errors.push('expectedNewTotal is required and must be a number >= 0 (from reprice-preview)');
  }

  const { author, ticketId } = checkAttribution(body || {}, errors);
  return {
    errors,
    value: { pickupAt, returnAt, pickupLocationId, expectedNewTotal, author, ticketId }
  };
}

/** Pre-pickup gate shared by cancel + reschedule. Returns an Error or null. */
export function assertPrePickup(status, operation) {
  if (VOZIA_PRE_PICKUP_STATUSES.includes(status)) return null;
  const err = new Error(
    `Cannot ${operation} a reservation in status ${status} — only before pickup ` +
    `(${VOZIA_PRE_PICKUP_STATUSES.join('/')}). Escalate to an admin in RideFleet.`
  );
  err.code = 'NOT_PRE_PICKUP';
  err.status = 409;
  return err;
}
