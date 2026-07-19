/**
 * S27 W-D (2026-07-19) — service-account PATCH whitelist for
 * PATCH /api/customers/:id. Mirrors vozia-reservation-patch.js: pure,
 * unit-testable validation + apply with injectable deps.
 *
 * This is the SENSITIVE-INFO surface (política Hector 2026-07-19): en VozIA,
 * estas mutaciones son la ÚNICA categoría que pide aprobación de supervisor.
 * RFM-side hardening for email (decisión Hector, con blindaje):
 *   - the OLD email gets a "your email was changed" notice (best-effort) so a
 *     fraudulent change can't happen silently — email redirects the token-gated
 *     pay/sign links, the exact surface Fase 6 closed.
 *   - every change lands in AuditLog with before/after + author + ticketId.
 * NOTE: Chloe (the AI) still cannot reach email — her executor's field list
 * excludes it on the VozIA side; this endpoint serves the HUMAN agent workspace
 * through the same service account.
 */

export const VOZIA_CUSTOMER_FIELDS = [
  'email',
  'address1',
  'address2',
  'city',
  'state',
  'zip'
];

export const VOZIA_CUSTOMER_TICKET_RE = /^[A-Za-z0-9._-]{1,64}$/;
const AUTHOR_MAX = 120;
const FIELD_MAX = {
  email: 254,
  address1: 200,
  address2: 200,
  city: 100,
  state: 60,
  zip: 20
};
// Deliberately simple: one @, no spaces, a dot in the domain. The mailer is
// the real validator; this just rejects garbage before it lands in the column.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function validateVoziaCustomerPatch(body = {}) {
  const errors = [];
  const keys = Object.keys(body || {});
  const fieldKeys = keys.filter((k) => VOZIA_CUSTOMER_FIELDS.includes(k));
  const strayKeys = keys.filter(
    (k) => !VOZIA_CUSTOMER_FIELDS.includes(k) && k !== 'author' && k !== 'ticketId'
  );

  if (strayKeys.length) {
    errors.push(
      `Field(s) not editable via VozIA: ${strayKeys.join(', ')}. ` +
      `Allowed: ${VOZIA_CUSTOMER_FIELDS.join(', ')}.`
    );
  }
  if (fieldKeys.length === 0) {
    errors.push(`Exactly one editable field is required (${VOZIA_CUSTOMER_FIELDS.join(', ')}).`);
  } else if (fieldKeys.length > 1) {
    errors.push(`Exactly one field per request — got: ${fieldKeys.join(', ')}.`);
  }

  const field = fieldKeys[0] || null;
  let value = '';
  if (field) {
    value = typeof body[field] === 'string' ? body[field].trim() : '';
    // address2 may be cleared (set to empty); everything else requires a value.
    if (!value && field !== 'address2') {
      errors.push(`${field} requires a non-empty string value.`);
    } else if (value.length > FIELD_MAX[field]) {
      errors.push(`${field} must be ${FIELD_MAX[field]} characters or fewer.`);
    }
    if (field === 'email' && value && !EMAIL_RE.test(value)) {
      errors.push('email must be a valid email address.');
    }
  }

  const author = typeof body.author === 'string' ? body.author.trim() : '';
  if (!author) errors.push('author is required');
  else if (author.length > AUTHOR_MAX) errors.push(`author must be ${AUTHOR_MAX} characters or fewer`);

  const ticketId = typeof body.ticketId === 'string' ? body.ticketId.trim() : '';
  if (!ticketId || !VOZIA_CUSTOMER_TICKET_RE.test(ticketId)) {
    errors.push('ticketId is required and must match ^[A-Za-z0-9._-]{1,64}$');
  }

  return { errors, value: { field, value, author, ticketId } };
}

/**
 * Apply a validated customer patch. `customer` is the tenant-scoped row
 * (id + tenantId + current field values + firstName). deps = { prisma,
 * sendEmail } — injectable for tests. Returns { ok, field, before, after,
 * customerId, oldEmailNotified }.
 */
export async function applyVoziaCustomerPatch(
  { field, value, author, ticketId },
  customer,
  deps = {},
  actorUserId = null
) {
  const { prisma, sendEmail } = deps;
  const before = customer[field] ?? null;

  await prisma.customer.update({
    where: { id: customer.id },
    data: { [field]: value }
  });

  // Blindaje de email (decisión Hector 2026-07-19): avisar al email VIEJO.
  // Best-effort — the change stands even if the notice bounces, but the
  // attempt (and its failure) is part of the audit metadata.
  let oldEmailNotified = false;
  if (field === 'email' && before && before !== value && typeof sendEmail === 'function') {
    try {
      await sendEmail({
        to: before,
        subject: 'Your email on file was changed / Tu email en archivo fue cambiado',
        text:
          `Hi ${customer.firstName || ''},\n\n` +
          `The email on your customer profile was changed to ${maskEmail(value)}. ` +
          `If you did NOT request this, call us immediately.\n\n` +
          `Hola ${customer.firstName || ''},\n\n` +
          `El email de tu perfil de cliente fue cambiado a ${maskEmail(value)}. ` +
          `Si NO fuiste tú, llámanos inmediatamente.`
      });
      oldEmailNotified = true;
    } catch (e) {
      // Visible in ops logs, not just audit rows (Innovation nit) — no PII:
      // customer id + error CLASS only. Never interpolate e.message here — an
      // SMTP bounce embeds the recipient address ("550 <old@x> rejected"), the
      // exact interpolation-skips-the-redactor class beta.318 fixed.
      console.warn(
        `[vozia-customer-patch] old-email notice failed for customer ${customer.id} (${e?.code || e?.name || 'Error'})`
      );
      oldEmailNotified = false;
    }
  }

  await prisma.auditLog.create({
    data: {
      tenantId: customer.tenantId || null,
      action: 'UPDATE',
      actorUserId: actorUserId || null,
      metadata: JSON.stringify({
        source: 'vozia',
        entity: 'customer',
        customerId: customer.id,
        ticketId,
        author,
        field,
        before,
        after: value,
        ...(field === 'email' ? { oldEmailNotified } : {})
      })
    }
  });

  return { ok: true, field, before, after: value, customerId: customer.id, oldEmailNotified };
}

/** c•••@domain — enough for the notice without leaking the full new address. */
export function maskEmail(email = '') {
  const [user, domain] = String(email).split('@');
  if (!user || !domain) return '•••';
  return `${user.slice(0, 1)}•••@${domain}`;
}
