/**
 * The client-side half of backend/src/lib/tenant-brand.js.
 *
 * The backend resolves a tenant's customer-facing business name down a
 * cascade and deliberately returns null rather than ever handing back this
 * platform's name. Screens that a CUSTOMER can see have to honour that, which
 * means two things they used not to do:
 *
 *   • no `|| 'Ride Fleet'` fallback — "no name is known" renders as no
 *     wordmark, not as ours;
 *   • the tenant-wide setting still reads back the PLATFORM DEFAULT for a
 *     tenant who never filled the field in (settings.service.js DEFAULTS), so
 *     any screen reading that setting directly has to filter it, exactly as
 *     the backend resolver does.
 *
 * Kept as its own module rather than a local helper so it can be tested and
 * so the next customer-facing surface has somewhere to reach for it.
 */

/** settings.service.js DEFAULTS.companyName — the absence of an answer. */
export const PLATFORM_DEFAULT_COMPANY_NAME = 'Ride Fleet';

/**
 * The tenant's own business name, or '' when none is known.
 * Never returns the platform's name.
 *
 * @param {{ companyName?: string|null }|null} branding
 * @returns {string}
 */
export function tenantBrandName(branding) {
  const name = String(branding?.companyName || '').trim();
  return name === PLATFORM_DEFAULT_COMPANY_NAME ? '' : name;
}
