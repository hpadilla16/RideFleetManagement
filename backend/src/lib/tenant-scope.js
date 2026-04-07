import { isSuperAdmin } from '../middleware/auth.js';

/**
 * Standard tenant scope — used by most modules (rates, fees, locations, etc.).
 * Super-admins can pass ?tenantId= to narrow to a specific tenant, otherwise global.
 */
export function scopeFor(req) {
  if (isSuperAdmin(req.user)) {
    return req.query?.tenantId ? { tenantId: String(req.query.tenantId) } : {};
  }
  return { tenantId: req.user?.tenantId || null };
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
  return { tenantId: req.user?.tenantId || null, allowUnassigned: false };
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
  return { tenantId: req.user?.tenantId || null, allowCrossTenant: false };
}
