/**
 * Tenant timezone resolution — single source of truth.
 *
 * Reports + services that need to bucket data in tenant-local time should
 * import resolveTenantTimeZone here rather than redefining it locally.
 *
 *   const tenantTz = await resolveTenantTimeZone(tenantId);
 *   // ...feed tenantTz into startOfDayInTz / isoDayInTz / dayLabelInTz, etc.
 *
 * The function never throws — if settings can't be read (missing record,
 * DB error, malformed JSON) it falls through to DEFAULT_TENANT_TIMEZONE so
 * callers don't have to wrap every use in their own try/catch.
 *
 * settings.service is loaded via dynamic import to keep lib/ free of a
 * static dependency on modules/ — that way other lib/ modules can pull in
 * this helper without dragging the settings subsystem along when not needed.
 */

import { DEFAULT_TENANT_TIMEZONE } from './date-utils.js';

let _settingsService = null;
async function getSettingsService() {
  if (_settingsService) return _settingsService;
  const mod = await import('../modules/settings/settings.service.js');
  _settingsService = mod.settingsService;
  return _settingsService;
}

/**
 * Resolve the IANA timezone name configured for a tenant. Returns the
 * canonical default ('America/Puerto_Rico') for missing tenants, missing
 * settings, or any error during lookup.
 */
export async function resolveTenantTimeZone(tenantId) {
  if (!tenantId) return DEFAULT_TENANT_TIMEZONE;
  try {
    const settingsService = await getSettingsService();
    const options = await settingsService.getReservationOptions({ tenantId });
    return String(options?.tenantTimeZone || DEFAULT_TENANT_TIMEZONE);
  } catch {
    return DEFAULT_TENANT_TIMEZONE;
  }
}
