/**
 * The tenant status vocabulary, frontend half.
 *
 * MUST STAY IN LOCKSTEP with TENANT_STATUSES in
 * backend/src/modules/tenants/tenants.service.js — the backend REJECTS anything
 * outside that list with a 400, so an option offered here that is not there
 * would only fail on save. A backend test
 * (modules/tenants/tenant-status.test.mjs) imports this file and asserts the two
 * lists agree, mirroring lib/module-access-frontend-defaults.test.mjs.
 *
 * Keep this file dependency-free plain ESM — no `next/*`, no React — or that
 * guard stops loading. That is why it lives here and not inside the page.
 */
export const TENANT_STATUS_OPTIONS = ['ACTIVE', 'SUSPENDED', 'DEMO'];

/**
 * True when `value` is a status the API will accept, ignoring case and padding —
 * which is exactly what normalizeTenantStatus does before it checks the list.
 */
export function isKnownStatus(value) {
  return TENANT_STATUS_OPTIONS.includes(String(value || '').trim().toUpperCase());
}

/**
 * The options to render for a tenant whose stored status is `current`.
 *
 * A controlled <select> whose value matches no <option> renders as though
 * NOTHING is selected: the real status becomes invisible, and the very next save
 * silently submits the first option instead. For the Demo tenant that meant a
 * one-click flip to ACTIVE, which publishes it into the public car-sharing
 * marketplace. So an unlisted stored value is appended rather than dropped.
 *
 * It is appended with its EXACT stored spelling, not upper-cased. The <select>
 * binds the raw column value, so an entry that differs only in case would not
 * match it and would reproduce the very nothing-selected render this exists to
 * prevent. Whether that spelling is SAVABLE is a separate question — the API
 * upper-cases before validating, so 'Active' saves fine while 'LEGACY' does not.
 * Use isKnownStatus for that, not membership in the returned list.
 */
export function statusOptionsFor(current) {
  const raw = String(current || '').trim();
  if (!raw || TENANT_STATUS_OPTIONS.includes(raw)) return TENANT_STATUS_OPTIONS;
  return [...TENANT_STATUS_OPTIONS, raw];
}

/**
 * Chip tone for the focused-tenant banner.
 *
 * DEMO is a showcase tenant, not a fault: bare `.status-chip` is the brand slot
 * (globals.css 194/1429), which reads notable rather than alarming. Bucketing
 * every non-ACTIVE status into `warn` would paint a healthy demo amber on a
 * banner headed "Review tenant health".
 */
export function statusChipTone(tenant) {
  if (!tenant) return 'neutral';
  const status = String(tenant.status || '').trim().toUpperCase();
  if (status === 'ACTIVE') return 'good';
  if (status === 'DEMO') return '';
  return 'warn';
}
