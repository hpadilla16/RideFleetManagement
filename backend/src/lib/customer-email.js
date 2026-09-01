/**
 * THE single validator for a customer's email address AT CAPTURE.
 *
 * WHY THIS EXISTS. On 2026-08-31 the sealed-contract audit found 54 agreements
 * sealed without an email ever leaving the building. 20 of them carried an
 * address that was PRESENT but not an address: MailerSend rejected them with
 * 422 / MS42208 ("The to.0.email must be a valid email address"). The best
 * specimen was addressed to `GERENTE VOLVO` — free text typed into an email
 * field at the counter and then copied, unquestioned, onto the contract
 * snapshot and into the mailer. Nothing between the keyboard and MailerSend
 * ever asked whether the string was an address.
 *
 * WHY ONE MODULE AND NOT A REGEX PER ROUTE. Before this file the same shape
 * check existed three times, each written independently:
 *   - modules/customers/vozia-customer-patch.js        (EMAIL_RE)
 *   - modules/incident-report/incident-report.service.js
 *   - modules/public-booking/public-booking.service.js (line ~1372)
 * and ELEVEN other paths that write Customer.email or
 * RentalAgreement.customerEmail had no check at all. A rule enforced in three
 * doors out of fourteen is not a rule; the same rule pasted into fourteen is a
 * rule that will drift. See lib/tenant-provider-credential.js for the last time
 * this project paid for a per-call-site fix (the inherited-credential bug shipped
 * twice). It lives here, once.
 *
 * WHY NOT A PRISMA QUERY EXTENSION (the lib/customer-phone-normalize.js shape).
 * Normalization could ride an extension, but the POLICY cannot: the same bad
 * string must produce a 400 at the counter, a gentle 400 in the customer's
 * pre-check-in, and a silently-nulled field with a log line in an OTA import.
 * An extension sits below the request and cannot tell those three apart, and
 * making it throw would turn one bad OTA row into a lost reservation. So the
 * normalizer is shared and the verdict is applied by the caller, which is the
 * only layer that knows who is typing.
 *
 * WHAT THIS IS NOT. Not an RFC 5321/5322 parser. The target is "GERENTE VOLVO",
 * not purity: a strict grammar rejects odd-but-legal addresses and turns a
 * mail-delivery bug into a booking-refusal bug. `user+tag@sub.example.co` must
 * pass, and does (see customer-email.test.mjs).
 *
 * WRITER INVENTORY as of 2026-09-01 — every path that writes Customer.email or
 * RentalAgreement.customerEmail, and the policy each one got. Ratcheted by
 * `customer-email-writers.test.mjs`, so a new writer fails the build until it
 * is classified here.
 *
 *   STAFF CAPTURE → 400 + CUSTOMER_EMAIL_INVALID, message audience 'staff'
 *     1. customers.service.js create()              POST   /customers
 *     2. customers.service.js update()              PATCH  /customers/:id
 *     3. vozia-customer-patch.js                    PATCH  /customers/:id (service acct)
 *     4. reservations.routes.js staff-complete      POST   /reservations/:id/precheckin/staff-complete
 *     5. rental-agreements.service.js updateCustomer PUT   /rental-agreements/:id/customer
 *     6. dealership-loaner.service.js               loaner counter intake
 *     7. quotes.service.js convert()                quote → reservation
 *
 *   CUSTOMER CAPTURE → 400 + CUSTOMER_EMAIL_INVALID, message audience 'customer'
 *     8. customer-portal.routes.js pre-check-in submit
 *     9. public-booking.service.js createGuestAccount()
 *    10. booking-engine.service.js upsertPublicCustomer() (public storefront booking)
 *
 *   IMPORT / OTA → never rejects the batch; stores null and logs a warning
 *    11. integrations/booking-source/customer-autocreate.js  (advantage, flexways, mex)
 *    12. integrations/economy/economy.worker.js
 *    13. integrations/nu/nu.worker.js
 *    14. integrations/tl-international/tl-international.worker.js
 *    15. reservations.service.js createImportedCustomer()    (legacy reservation CSV)
 *
 *   STAFF BULK IMPORT → row-level rejection, batch survives
 *    16. customers.service.js buildCustomerImportRow()  POST /customers/bulk/validate|import
 *        Judgement call: this is neither of the three. It is staff-driven like
 *        (1)-(7), but it already has a validate-then-import report the operator
 *        reads BEFORE committing, and a 400 would discard 499 good rows over one
 *        bad cell. So the row is marked invalid with the same message the counter
 *        gets, the report surfaces it, and importBulk skips it — the operator sees
 *        and can fix it, and nothing else is lost.
 *
 *   NOT CAPTURE — deliberately untouched (a copy or a clear, never a keyboard):
 *     - rental-agreements.service.js rentalAgreement.create ×2: SNAPSHOTS
 *       reservation.customer.email onto the contract. Validating here would
 *       refuse to open an agreement for the 20 customers whose stored address is
 *       already bad — turning a mail bug into a counter outage. Those rows are a
 *       separate, Hector-approved cleanup.
 *     - kiosk-name-update.service.js customer.create: CLONES an existing row's
 *       email during a name correction. Same reasoning.
 *     - account-deletion.service.js: writes `email: null` (anonymiser).
 *     - public-booking.service.js issueGuestAccess(): email is in the WHERE, the
 *       data payload writes only guest-access tokens.
 *
 * Free of Prisma, Express and the mailer on purpose, so the whole matrix is
 * unit-testable without any of them (customer-email.test.mjs). The one import is
 * lib/errors.js, which is itself pure.
 */

import { ValidationError } from './errors.js';

/**
 * Machine code. DELIBERATELY ONE CODE FOR ALL AUDIENCES: one rule speaks one
 * vocabulary, and minting a portal-only code would recreate the divergence this
 * module exists to remove. What differs per surface is the human sentence.
 * (Same reasoning as checkout-session/insurance-selection-gate.js.)
 */
export const CUSTOMER_EMAIL_INVALID = 'CUSTOMER_EMAIL_INVALID';

/** RFC 5321 hard limits. Cheap, and they catch paste accidents. */
const MAX_TOTAL = 254;
const MAX_LOCAL = 64;

/**
 * Characters that are either illegal or that break header parsing downstream —
 * this is the set that produced the MS42208 rejections. Whitespace is the one
 * that actually caught "GERENTE VOLVO"; the rest catch "Name <a@b.com>" and
 * comma-joined lists pasted into a single-recipient field.
 */
const FORBIDDEN = /[\s,;<>()[\]\\"]/;

/** A dot may separate labels but may not lead, trail, or double up. */
function badDots(part) {
  return part.startsWith('.') || part.endsWith('.') || part.includes('..');
}

/**
 * Normalize and validate one customer email.
 *
 * Empty (null, undefined, blank, whitespace-only) is NOT an error: capturing an
 * address is optional today, and this module's job is to reject non-addresses,
 * not to invent a requirement. It reports `{ ok: true, email: null }` so callers
 * write an explicit null instead of an empty string — "" is what let a blank
 * field reach the mailer as a present-but-unusable recipient.
 *
 * Case: the WHOLE address is lowercased, not only the domain. The domain must be
 * (DNS is case-insensitive); the local part is too because six writers already
 * lowercase the whole thing and at least one dedupe lookup
 * (dealership-loaner.service.js) is an EXACT match — preserving local-part case
 * here would mint a second Customer row for the same human depending on which
 * door they walked through.
 *
 * @param {unknown} value
 * @returns {{ ok: true, email: string|null } | { ok: false, email: null, code: string }}
 */
export function normalizeCustomerEmail(value) {
  const invalid = { ok: false, email: null, code: CUSTOMER_EMAIL_INVALID };

  if (value === null || value === undefined) return { ok: true, email: null };
  // Only a string can be an address. Deliberately NOT String(value): an array
  // stringifies to '' and would have been waved through as "no email given",
  // which is precisely the kind of silent coercion this module exists to end.
  if (typeof value !== 'string') return invalid;

  const trimmed = value.trim();
  if (trimmed === '') return { ok: true, email: null };

  if (trimmed.length > MAX_TOTAL) return invalid;
  if (FORBIDDEN.test(trimmed)) return invalid;

  // Exactly one '@'. A quoted local part may legally hold more, but we already
  // rejected quotes above, so more than one '@' here is always a mistake.
  const at = trimmed.indexOf('@');
  if (at <= 0 || trimmed.indexOf('@', at + 1) !== -1) return invalid;

  const local = trimmed.slice(0, at);
  const domain = trimmed.slice(at + 1);

  if (local.length > MAX_LOCAL) return invalid;
  if (badDots(local)) return invalid;

  // Domain needs at least one dot, sane labels, and a TLD of >= 2 letters.
  // `a@localhost` is legal SMTP and useless to MailerSend, so it is refused.
  if (badDots(domain)) return invalid;
  const labels = domain.split('.');
  if (labels.length < 2) return invalid;
  if (labels.some((l) => l === '' || l.startsWith('-') || l.endsWith('-'))) return invalid;
  const tld = labels[labels.length - 1];
  if (!/^[A-Za-z]{2,}$/.test(tld)) return invalid;

  return { ok: true, email: trimmed.toLowerCase() };
}

/**
 * Audience-appropriate wording for the same rule.
 *
 * 'staff'    — an agent at the counter, who can retype it on the spot and needs
 *              to know it is the FORMAT that is wrong, not the customer.
 * 'customer' — nobody is standing next to them to interpret a 400, so the
 *              sentence has to be self-contained, kind, and free of internal
 *              vocabulary.
 */
export function messageFor(audience = 'staff') {
  return audience === 'customer'
    ? "That doesn't look like an email address. Please check it and enter it as name@example.com — that is where we send your confirmation and documents."
    : 'That is not a valid email address. Enter it in the form name@example.com, or leave the field empty.';
}

/**
 * 400, in the contract lib/errors.js already speaks — so a route that simply
 * calls `next(e)` answers 400 with the right sentence and no per-route wiring.
 * `statusCode` is set too because a few older handlers read that spelling.
 */
export class CustomerEmailError extends ValidationError {
  constructor(audience = 'staff') {
    super(messageFor(audience));
    this.name = 'CustomerEmailError';
    this.statusCode = 400;
    this.code = CUSTOMER_EMAIL_INVALID;
  }
}

/**
 * Capture path (staff or customer): return the normalized address, or throw a
 * 400 carrying CUSTOMER_EMAIL_INVALID. Empty returns null.
 *
 * @param {unknown} value
 * @param {{ audience?: 'staff'|'customer' }} [opts]
 * @returns {string|null}
 */
export function assertCustomerEmail(value, opts = {}) {
  const verdict = normalizeCustomerEmail(value);
  if (!verdict.ok) throw new CustomerEmailError(opts.audience || 'staff');
  return verdict.email;
}

/**
 * Mask an address for logs. The Winston redactor (lib/logger.js) blanks any meta
 * key literally named `email`, so a warning logged under that key would tell ops
 * nothing at all. Log the masked form under `emailMasked` instead: enough to
 * recognise the row in the source system, not enough to be PII.
 *
 *   "GERENTE VOLVO" -> "G***"      (no domain to keep)
 *   "jane@acme.com" -> "j***@acme.com"
 */
export function maskCustomerEmail(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return '';
  const at = raw.lastIndexOf('@');
  if (at <= 0) return `${raw.slice(0, 1)}***`;
  return `${raw.slice(0, 1)}***${raw.slice(at)}`;
}

/**
 * Import / OTA path: NEVER throw. Return the normalized address, or null when
 * the source handed us something that is not an address — and leave a trace.
 *
 * A reservation from an OTA with no email on it is worth strictly more than a
 * reservation we refused to import, so a bad cell may not fail the batch. The
 * warning is the whole point: without it this is indistinguishable from a source
 * that simply had no email, and the cleanup crew has nothing to work from.
 *
 * @param {unknown} value
 * @param {{ log?: object, source?: string, tenantId?: string|null,
 *           externalRef?: string|null, reservationId?: string|null }} [ctx]
 * @returns {string|null}
 */
export function importCustomerEmailOrNull(value, ctx = {}) {
  const verdict = normalizeCustomerEmail(value);
  if (verdict.ok) return verdict.email;

  const log = ctx.log;
  log?.warn?.('[customer-email] dropped an invalid customer email on import', {
    source: ctx.source || 'import',
    tenantId: ctx.tenantId ?? null,
    externalRef: ctx.externalRef ?? null,
    reservationId: ctx.reservationId ?? null,
    emailMasked: maskCustomerEmail(value),
    code: CUSTOMER_EMAIL_INVALID,
  });
  return null;
}
