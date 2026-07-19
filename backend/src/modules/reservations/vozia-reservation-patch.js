/**
 * VozIA Cap 6 / W1 (2026-07-19) — service-account PATCH whitelist for
 * PATCH /api/reservations/:id. Mirrors the vozia-note.js pattern: pure,
 * unit-testable validation + an apply function with injectable deps.
 *
 * CONTRACT (VozIA's rideFleetWrites.ts is already built against this):
 *   body = { <exactly ONE of the 4 whitelisted fields>, author, ticketId }
 *   → 200 { ok: true, field, before, after, reservationId }
 *
 * DEFENSE IN DEPTH: the allowlist opens the PATH for service accounts; THIS
 * module is the field gate. Any key outside the whitelist (+author/ticketId)
 * is rejected — money/status/date fields can never ride through. Humans on
 * the same route are untouched (they never enter this branch).
 *
 * Field semantics (Hector, plan 2026-07-17 + decisión 2026-07-19):
 *   flightNumber / pickupInstructions → Reservation columns (new, additive).
 *   contactPhone                      → the reservation's CUSTOMER record (the
 *     operative contact). Signed agreements are legal documents, NOT mutated.
 *   contactEmail — EXCLUIDO a propósito (Hector 2026-07-19, Innovation MC-3):
 *     cambiar el email redirige los links token-gated de pago/firma (la misma
 *     superficie que Fase 6 cerró con extraEmails). Cambios de email → escalate
 *     a humano. Reabrible con notificación al email viejo como hardening.
 */

export const VOZIA_PATCH_FIELDS = [
  'flightNumber',
  'pickupInstructions',
  'contactPhone'
];

export const VOZIA_PATCH_TICKET_RE = /^[A-Za-z0-9._-]{1,64}$/;
const AUTHOR_MAX = 120;
const FIELD_MAX = {
  flightNumber: 20,
  pickupInstructions: 2000,
  contactPhone: 40
};

/**
 * Validate + normalize. Returns { errors, value } — errors is a list of
 * human-readable strings (route responds 400 with details when non-empty);
 * value = { field, value, author, ticketId }.
 */
export function validateVoziaPatchPayload(body = {}) {
  const errors = [];
  const keys = Object.keys(body || {});

  const fieldKeys = keys.filter((k) => VOZIA_PATCH_FIELDS.includes(k));
  const strayKeys = keys.filter(
    (k) => !VOZIA_PATCH_FIELDS.includes(k) && k !== 'author' && k !== 'ticketId'
  );

  if (strayKeys.length) {
    errors.push(
      `Field(s) not editable via VozIA: ${strayKeys.join(', ')}. ` +
      `Allowed: ${VOZIA_PATCH_FIELDS.join(', ')}.`
    );
  }
  if (fieldKeys.length === 0) {
    errors.push(`Exactly one editable field is required (${VOZIA_PATCH_FIELDS.join(', ')}).`);
  } else if (fieldKeys.length > 1) {
    errors.push(`Exactly one field per request — got: ${fieldKeys.join(', ')}.`);
  }

  const field = fieldKeys[0] || null;
  let value = '';
  if (field) {
    value = typeof body[field] === 'string' ? body[field].trim() : '';
    if (!value) errors.push(`${field} requires a non-empty string value.`);
    else if (value.length > FIELD_MAX[field]) {
      errors.push(`${field} must be ${FIELD_MAX[field]} characters or fewer.`);
    }
    if (field === 'contactPhone' && value && value.replace(/\D/g, '').length < 7) {
      errors.push('contactPhone must contain at least 7 digits.');
    }
  }

  const author = typeof body.author === 'string' ? body.author.trim() : '';
  if (!author) errors.push('author is required');
  else if (author.length > AUTHOR_MAX) errors.push(`author must be ${AUTHOR_MAX} characters or fewer`);

  const ticketId = typeof body.ticketId === 'string' ? body.ticketId.trim() : '';
  if (!ticketId || !VOZIA_PATCH_TICKET_RE.test(ticketId)) {
    errors.push('ticketId is required and must match ^[A-Za-z0-9._-]{1,64}$');
  }

  return { errors, value: { field, value, author, ticketId } };
}

/**
 * Apply a validated patch. `reservation` is the already-tenant-scoped row from
 * getById (id + customerId + current values). deps = { prisma } — injectable for
 * fake-db tests. actorUserId = the service account's User id (audit attribution,
 * same as the notes route). Writes ONE AuditLog row with before/after.
 * Returns { ok: true, field, before, after, reservationId }.
 */
export async function applyVoziaReservationPatch(
  { field, value, author, ticketId },
  reservation,
  scope = {},
  deps = {},
  actorUserId = null
) {
  const { prisma } = deps;

  let before = null;
  if (field === 'flightNumber' || field === 'pickupInstructions') {
    before = reservation[field] ?? null;
    // Innovation MC-1: a DIRECT column write, NOT reservationsService.update() —
    // update() re-runs location-window/vehicle-conflict/doNotRent gates that would
    // block a benign flight-number edit (and leak the DO-NOT-RENT reason toward a
    // caller-facing agent), and can fire car-sharing completion side-effects.
    // Tenant scoping is already proven: `reservation` came from the scoped getById.
    await prisma.reservation.update({
      where: { id: reservation.id },
      data: { [field]: value }
    });
  } else {
    // contactPhone → the reservation's customer (operative contact).
    if (field !== 'contactPhone') {
      // Belt-and-suspenders (QA MINOR-1): only contactPhone may reach this branch;
      // anything else here means a validator/whitelist drift — fail loudly.
      const err = new Error(`Field "${field}" is not applicable to the customer record`);
      err.code = 'FIELD_NOT_APPLICABLE';
      err.status = 422;
      throw err;
    }
    if (!reservation.customerId) {
      const err = new Error('Reservation has no customer to update');
      err.code = 'NO_CUSTOMER';
      err.status = 422;
      throw err;
    }
    const customer = await prisma.customer.findFirst({
      where: {
        id: reservation.customerId,
        ...(scope?.tenantId ? { tenantId: scope.tenantId } : {})
      },
      select: { id: true, phone: true, email: true }
    });
    if (!customer) {
      const err = new Error('Customer not found in this tenant');
      err.code = 'CUSTOMER_NOT_FOUND';
      err.status = 422;
      throw err;
    }
    const column = 'phone';
    before = customer[column] ?? null;
    // phone writes auto-derive phoneNormalized via the prisma extension (beta.322).
    await prisma.customer.update({
      where: { id: customer.id },
      data: { [column]: value }
    });
  }

  await prisma.auditLog.create({
    data: {
      tenantId: reservation.tenantId || scope?.tenantId || null,
      reservationId: reservation.id,
      action: 'UPDATE',
      // Innovation MC-2: the service account IS a User row — attribute like the
      // notes route does (metadata keeps the human-readable author/ticket).
      actorUserId: actorUserId || null,
      metadata: JSON.stringify({
        source: 'vozia',
        ticketId,
        author,
        field,
        before,
        after: value
      })
    }
  });

  return { ok: true, field, before, after: value, reservationId: reservation.id };
}
