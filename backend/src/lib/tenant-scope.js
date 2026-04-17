import { isSuperAdmin } from '../middleware/auth.js';

/**
 * Sentinel scope that matches no rows. Returned when a non-super-admin user
 * is missing a tenantId — we'd rather fail closed (no data) than return all
 * tenants' data or anything with a null tenantId.
 */
const DENY_ALL_SCOPE = { tenantId: '__no_tenant__' };

function resolveTenantScopedUser(user, extras = {}) {
  const tenantId = user?.tenantId;
  if (!tenantId) return { ...DENY_ALL_SCOPE, ...extras };
  return { tenantId, ...extras };
}

/**
 * Standard tenant scope — used by most modules (rates, fees, locations, etc.).
 * Super-admins can pass ?tenantId= to narrow to a specific tenant, otherwise global.
 * Non-super-admins without a tenantId get a deny-all scope (fail-closed).
 */
export function scopeFor(req) {
  if (isSuperAdmin(req.user)) {
    return req.query?.tenantId ? { tenantId: String(req.query.tenantId) } : {};
  }
  return resolveTenantScopedUser(req.user);
}

/**
 * Car-sharing scope — includes allowUnassigned flag for vehicle/listing queries.
 */
export function carSharingScopeFor(req) {
  if (isSuperAdmin(req.user)) {
    return req.query?.tenantId
      ? { tenantId: String(req.query.tenantId), allowUnassigned: true }
      : { allowUnassigned: true };
  }
  return resolveTenantScopedUser(req.user, { allowUnassigned: false });
}

/**
 * Cross-tenant scope — used by reservations and vehicles modules.
 */
export function crossTenantScopeFor(req) {
  if (isSuperAdmin(req.user)) {
    return req.query?.tenantId
      ? { allowCrossTenant: true, tenantId: String(req.query.tenantId) }
      : { allowCrossTenant: true };
  }
  return resolveTenantScopedUser(req.user, { allowCrossTenant: false });
}
