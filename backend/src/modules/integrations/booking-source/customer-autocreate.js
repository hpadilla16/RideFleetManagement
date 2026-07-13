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
 * NOT wired into economy/nu yet — R0 ships the shared code + tests only.
 */

import logger from '../../../lib/logger.js';

// Same placeholder both sources use when the row has a name but no phone —
// Customer.phone is required, and the counter fixes it at the desk.
export const CUSTOMER_PHONE_PLACEHOLDER = '0000000000';

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
 * @returns {Promise<object|null>} the (existing or created) customer, or null
 *   when the row lacks the minimum identity (first+last AND email-or-phone).
 */
export async function maybeCreateCustomerFromSource(prismaClient, extRes, opts = {}) {
  const { isEnabled = true, logPrefix = '[booking-source]', sourceName = 'source' } = opts;
  const enabled = typeof isEnabled === 'function' ? isEnabled() : isEnabled;
  if (!enabled) return null;

  const firstName = (extRes.customerFirstName || '').trim();
  const lastName = (extRes.customerLastName || '').trim();
  const email = (extRes.customerEmail || '').trim().toLowerCase();
  const phone = (extRes.customerPhone || '').trim();

  if (!firstName || !lastName) return null;
  if (!email && !phone) return null;

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
    },
    select: { id: true, firstName: true, lastName: true, email: true, phone: true },
  });
  logger.info(`${logPrefix} auto-created Customer from ${sourceName} data`, {
    tenantId: extRes.tenantId,
    externalRef: extRes.externalRef,
    customerId: created.id,
  });
  return created;
}
