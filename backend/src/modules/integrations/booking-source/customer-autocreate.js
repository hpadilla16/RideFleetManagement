/**
 * Shared "auto-create customer" path for booking-source integrations
 * (R0 extraction, 2026-07-13).
 *
 * maybeCreateCustomerFromNu / maybeCreateCustomerFromEconomy were 100%
 * identical apart from the env flag key and the log line — when promotion is
 * blocked ONLY by customer_not_found and the source's *_AUTO_CREATE_CUSTOMERS
 * flag is on, create a lightweight Customer from the staged row and let the
 * worker re-evaluate.
 *
 * WIRED (2026-09-01 audit): advantage, flexways and mex call this shared
 * helper; economy, nu and tl-international still keep their own copies of the
 * same function. All four hold the customer-email gate (writers #11-#14 in
 * lib/customer-email.js) and booking-source.test.mjs asserts they stay in
 * parity. The R0 note that used to sit here said none of them were wired,
 * which had been false for long enough that nobody trusted the header.
 */

import logger from '../../../lib/logger.js';
import { importCustomerEmailOrNull } from '../../../lib/customer-email.js';

// Same placeholder both sources use when the row has a name but no phone —
// Customer.phone is required, and the counter fixes it at the desk.
export const CUSTOMER_PHONE_PLACEHOLDER = '0000000000';

/**
 * Stamp for a customer created from a name and nothing else. A stable, greppable
 * prefix so the merge pass that eventually cleans these up can select exactly
 * this population instead of guessing from a placeholder phone number (which
 * predates this and means something slightly different).
 */
export const NAME_ONLY_NOTE_PREFIX = '[import:name-only]';

export function nameOnlyNote(sourceName, externalRef) {
  return `${NAME_ONLY_NOTE_PREFIX} ${sourceName} ${externalRef || '?'} — no contact data from the source; complete at the counter`;
}

/**
 * Parse a *_AUTO_CREATE_CUSTOMERS-style env flag. Default OFF — auto-creating
 * customers from scraped rows is opt-in per source.
 */
export function autoCreateEnabledFromEnv(envKey) {
  const raw = (process.env[envKey] ?? 'false').toString().trim().toLowerCase();
  return raw === 'true' || raw === '1' || raw === 'yes';
}

/**
 * Create (or reuse) a Customer for a staged ExternalReservation row.
 *
 * @param {object} prismaClient  Prisma handle (worker passes its client/tx).
 * @param {object} extRes        ExternalReservation row (tenantId + customer* fields).
 * @param {object} opts
 * @param {boolean|function=} opts.isEnabled  Optional gate. The current workers
 *   check the env flag BEFORE calling, so this defaults to true; passing the
 *   flag (or a thunk) here lets a re-wired caller collapse the two steps
 *   without changing the decision order.
 * @param {string}  opts.logPrefix   e.g. '[nu-sync]'
 * @param {string}  opts.sourceName  e.g. 'NU' — used in the log line only.
 * @param {boolean=} opts.allowNameOnly  Accept a row that carries NO contact at
 *   all, creating the customer from the name with a placeholder phone. OFF by
 *   default; each source opts in for itself (see the block comment below).
 * @returns {Promise<object|null>} the (existing or created) customer, or null
 *   when the row lacks the minimum identity.
 */
export async function maybeCreateCustomerFromSource(prismaClient, extRes, opts = {}) {
  const {
    isEnabled = true, logPrefix = '[booking-source]', sourceName = 'source',
    allowNameOnly = false,
  } = opts;
  const enabled = typeof isEnabled === 'function' ? isEnabled() : isEnabled;
  if (!enabled) return null;

  const firstName = (extRes.customerFirstName || '').trim();
  const lastName = (extRes.customerLastName || '').trim();
  // Writer #11 of the customer-email inventory (lib/customer-email.js) — the
  // shared OTA path (advantage, flexways, mex). IMPORT policy: a scraped row
  // that carries junk in the email column must NOT cost us the reservation, so
  // the address is dropped to null and a warning names the tenant and the
  // external ref. Without that warning this is indistinguishable from a source
  // that simply had no email, and the cleanup has nothing to work from.
  const email = importCustomerEmailOrNull(extRes.customerEmail, {
    log: logger,
    source: sourceName,
    tenantId: extRes.tenantId,
    externalRef: extRes.externalRef,
    reservationId: extRes.promotedToReservationId ?? null,
  }) || '';
  const phone = (extRes.customerPhone || '').trim();

  if (!firstName || !lastName) return null;

  // NAME-ONLY (2026-09-07, Hector: "customer not found deberia ser crear
  // customer nuevo automatico utilizando info que da economy").
  //
  // Some sources hand over a booking with a name and nothing else. Refusing it
  // does not protect anybody — it just leaves a real reservation invisible to
  // the counter on the morning the customer shows up. With this on, the name is
  // enough: the phone becomes the placeholder and the desk completes the record
  // at check-in, exactly as it already does for a row that had a name but no
  // phone.
  //
  // THE COST, stated plainly: dedup below is by EMAIL. A name-only customer can
  // never match one, so a repeat renter becomes a new Customer every booking.
  // We do NOT dedup by name — merging two different people who happen to share
  // one is a worse failure than a duplicate. The rows are stamped in `notes`
  // instead, so a later merge pass can find exactly this population.
  const nameOnly = !email && !phone;
  if (nameOnly && !allowNameOnly) return null;

  if (email) {
    const existing = await prismaClient.customer.findFirst({
      where: { tenantId: extRes.tenantId, email: { equals: email, mode: 'insensitive' } },
      select: { id: true },
    }).catch(() => null);
    if (existing) return existing;
  }

  const created = await prismaClient.customer.create({
    data: {
      tenantId: extRes.tenantId,
      firstName,
      lastName,
      email: email || null,
      phone: phone || CUSTOMER_PHONE_PLACEHOLDER,
      country: extRes.customerCountry || null,
      ...(nameOnly ? { notes: nameOnlyNote(sourceName, extRes.externalRef) } : {}),
    },
    select: { id: true, firstName: true, lastName: true, email: true, phone: true },
  });
  logger.info(`${logPrefix} auto-created Customer from ${sourceName} data`, {
    tenantId: extRes.tenantId,
    externalRef: extRes.externalRef,
    customerId: created.id,
    nameOnly,
  });
  return created;
}
