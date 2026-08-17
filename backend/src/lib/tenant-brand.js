/**
 * Whose business name does the CUSTOMER see?
 *
 * Every surface a renter looks at during a handoff has to name the business
 * they are contracting with — never this platform. The cascade below was
 * written for the QR signing journey (gap #11, 2026-08-17), where the leak is
 * worst: the renter scans a code off the agent's counter screen, lands on
 * their own phone with no address bar context, no login and no logo, and
 * whatever the page says is who they believe they are renting from.
 *
 * The two screens of that journey — the counter display that shows the QR and
 * the phone that opens it — must agree. Sharing this function is NOT what
 * makes them agree; feeding it the same branch is. `resolveBrandLocation`
 * below is that second half, and both callers go through it.
 *
 *   location config → franchise → branch name → tenant-wide setting → Tenant.name
 *
 * Two deliberate deviations from the PDF header's version of this cascade
 * (rental-agreements.service.js:3551-3555), both guarding the same edge:
 *
 *   • the tenant-wide `companyName` is IGNORED while it still reads back the
 *     'Ride Fleet' DEFAULT that settings.service.js hands an unconfigured
 *     tenant — that is the absence of an answer, not an answer;
 *   • `Tenant.name` backstops the chain. It is a required column, so a tenant
 *     that configured nothing at all still gets its own plain-text name.
 *
 * Returns null only when every source is empty, which callers render as a
 * neutral, unbranded surface. It never returns the platform's name.
 *
 * NOT MIGRATED ON PURPOSE (2026-08-17): the PDF header
 * (rental-agreements.service.js:3552), the agreement email
 * (rental-agreements.service.js:3917 and lib/email-template.js:43-53) and the
 * addendum payload (addendum-signature-public.service.js:93) each carry their
 * own copy of this shape. They also resolve address/phone/logo/terms text and
 * sit on money and mail paths; folding them in belongs in its own change with
 * its own regression pass, not in the branch that closes the QR-journey leak.
 */

import { prisma } from './prisma.js';
import logger from './logger.js';
import { parseLocationConfig } from './location-config.js';

/**
 * settings.service.js DEFAULTS.companyName. A tenant that never filled in
 * Settings → Rental agreement reads this back from getRentalAgreementConfig(),
 * so it can never be treated as "the tenant configured their brand".
 */
export const PLATFORM_DEFAULT_COMPANY_NAME = 'Ride Fleet';

/**
 * WHICH branch brands a reservation — the half that actually keeps the counter
 * and the phone saying the same thing.
 *
 * `reservationsService.update` can move `Reservation.pickupLocationId` after
 * the agreement exists, and nothing syncs it back to the agreement. So a
 * reservation and its own agreement can name two different branches, and two
 * screens that each pick "the obvious one" end up disagreeing about which
 * business the customer is standing in front of.
 *
 * The AGREEMENT's branch wins, everywhere. It is the row that supplies the
 * clause text the renter initials, so identity and clauses always name the
 * same place. The reservation's branch is the fallback, for a reservation with
 * no agreement yet (the counter screen renders long before one exists) or an
 * agreement with no location.
 *
 * Costs nothing on either caller's common path. The phone's query already
 * loads `rentalAgreement.pickupLocation`, so it is returned as-is; the counter
 * screen only has the agreement's `pickupLocationId`, and reads it solely when
 * it differs from the reservation's — i.e. only after somebody moved one.
 *
 * @param {object|null} reservation — `pickupLocation` plus either
 *   `rentalAgreement.pickupLocation` (already loaded) or
 *   `rentalAgreement.pickupLocationId`
 * @returns {Promise<object|null>} a Location row (id, name, locationConfig)
 */
export async function resolveBrandLocation(reservation) {
  const reservationLocation = reservation?.pickupLocation || null;
  // Already in hand — never pay for a round trip to re-read it.
  const loadedAgreementLocation = reservation?.rentalAgreement?.pickupLocation || null;
  if (loadedAgreementLocation) return loadedAgreementLocation;

  const agreementLocationId = reservation?.rentalAgreement?.pickupLocationId || null;
  if (!agreementLocationId || agreementLocationId === reservationLocation?.id) {
    return reservationLocation;
  }
  try {
    const moved = await prisma.location.findUnique({
      where: { id: agreementLocationId },
      select: { id: true, name: true, locationConfig: true },
    });
    return moved || reservationLocation;
  } catch (err) {
    // Branding may never break the surface that renders it.
    logger.warn('[tenant-brand] agreement location lookup failed', { message: err.message });
    return reservationLocation;
  }
}

/**
 * Resolve the customer-facing business name.
 *
 * @param {object} input
 * @param {string|null} [input.tenantId]     scope for the tenant-wide setting
 * @param {string|null} [input.franchiseId]  reservation's franchise, if any
 * @param {object|null} [input.location]     pickup Location row — needs
 *                                           `locationConfig` and `name`
 * @param {string|null} [input.tenantName]   Tenant.name when the caller already
 *                                           has it; omit to let this look it up
 *                                           lazily, and only if the rest of the
 *                                           cascade came back empty
 * @param {object} [input.globalConfig]      an already-fetched
 *                                           getRentalAgreementConfig() result
 * @param {object|null} [input.franchiseConfig] an already-fetched
 *                                           franchise getAgreementConfig()
 * @returns {Promise<{ companyName: string|null }>}
 *
 * INJECT WHAT YOU ALREADY HAVE. `getRentalAgreementConfig` is NOT memoised
 * (settings.service.js: an appSetting.findMany plus a tenant.findUnique on
 * every call) and neither is the franchise read. A caller that fetched either
 * for its own payload must pass it in rather than paying for it twice —
 * display-data is polled every 1.5s per open counter screen, so "twice" means
 * ~80 redundant queries a minute per till.
 */
export async function resolveCustomerFacingBrand({
  tenantId = null,
  franchiseId = null,
  location = null,
  tenantName = undefined,
  globalConfig = undefined,
  franchiseConfig = undefined,
} = {}) {
  const locCfg = parseLocationConfig(location?.locationConfig);

  let globalCfg = globalConfig ?? {};
  let franchiseCfg = franchiseConfig ?? null;
  if (globalConfig === undefined) {
    try {
      const { settingsService } = await import('../modules/settings/settings.service.js');
      globalCfg = await settingsService.getRentalAgreementConfig(tenantId ? { tenantId } : {});
    } catch (err) {
      // Branding must never be able to break the surface that renders it —
      // signing least of all. Fall through to the location/tenant names.
      logger.warn('[tenant-brand] settings lookup failed', { message: err.message });
    }
  }
  if (franchiseConfig === undefined) {
    try {
      const { franchiseService } = await import('../modules/settings/franchise.service.js');
      franchiseCfg = await franchiseService.getAgreementConfig(franchiseId ?? null, { tenantId });
    } catch (err) {
      logger.warn('[tenant-brand] franchise lookup failed', { message: err.message });
    }
  }

  const configuredGlobalName = String(globalCfg?.companyName || '').trim();
  const beforeTenantName =
    String(locCfg?.companyName || '').trim()
    || String(franchiseCfg?.companyName || '').trim()
    || String(location?.name || '').trim()
    || (configuredGlobalName && configuredGlobalName !== PLATFORM_DEFAULT_COMPANY_NAME
      ? configuredGlobalName : '');

  if (beforeTenantName) return { companyName: beforeTenantName };

  // Backstop. Only reached by a tenant that configured nothing, so the extra
  // read costs nothing on the common path (and callers that already hold the
  // row pass `tenantName` and never get here).
  let name = typeof tenantName === 'string' ? tenantName.trim() : '';
  if (!name && tenantName === undefined && tenantId) {
    try {
      const row = await prisma.tenant.findUnique({ where: { id: tenantId }, select: { name: true } });
      name = String(row?.name || '').trim();
    } catch (err) {
      logger.warn('[tenant-brand] tenant name lookup failed', { message: err.message });
    }
  }

  return { companyName: name || null };
}
