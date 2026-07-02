import { isSuperAdmin } from '../middleware/auth.js';

/**
 * Sentinel scope that matches no rows. Returned when a non-super-admin user
 * is missing a tenantId — we'd rather fail closed (no data) than return all
 * tenants' data or anything with a null tenantId.
 */
const DENY_ALL_SCOPE = { tenantId: '__no_tenant__' };

/**
 * Location scoping (Fase 2). Returns the array of Location ids a user is
 * restricted to, or null = ALL locations (no restriction).
 * SUPER_ADMIN/ADMIN always bypass (null). Empty/absent locationIds = null.
 */
export function userAllowedLocationIds(user) {
  const role = String(user?.role || '').toUpperCase();
  if (role === 'SUPER_ADMIN' || role === 'ADMIN') return null;
  const ids = Array.isArray(user?.locationIds) ? user.locationIds.filter(Boolean) : null;
  return ids && ids.length ? ids : null;
}

/**
 * Program scoping (2026-07-02). Returns 'RENTAL_ONLY' | 'LOANER_ONLY' when the
 * employee is restricted to one program's data, or null = no restriction.
 * SUPER_ADMIN/ADMIN always bypass (null), mirroring location scoping above.
 * The default User.programScope is BOTH, which also maps to null, so existing
 * users see zero behavior change.
 */
export function userProgramScope(user) {
  const role = String(user?.role || '').toUpperCase();
  if (role === 'SUPER_ADMIN' || role === 'ADMIN') return null;
  const scope = String(user?.programScope || '').toUpperCase();
  if (scope === 'RENTAL_ONLY' || scope === 'LOANER_ONLY') return scope;
  return null;
}

/**
 * Cache-key segment for per-user visibility (2026-07-02). Cached responses
 * computed from a resolved scope must key on every dimension that shapes the
 * payload — tenant alone stopped being enough once programScope and
 * allowedLocationIds started filtering list/summary results (a scoped
 * employee and an admin must never share a cache entry). Pure and
 * deterministic: location ids are sorted so ['B','A'] and ['A','B'] produce
 * the same segment; 'ALL' marks an unrestricted axis.
 */
export function scopeVisibilityCacheSegment(scope) {
  const rawProgram = scope?.programScope;
  const program = rawProgram === 'RENTAL_ONLY' || rawProgram === 'LOANER_ONLY' ? rawProgram : 'ALL';
  const locIds = Array.isArray(scope?.allowedLocationIds)
    ? scope.allowedLocationIds.filter(Boolean)
    : null;
  const loc = locIds && locIds.length ? [...locIds].sort().join(',') : 'ALL';
  return `${program}:${loc}`;
}

function resolveTenantScopedUser(user, extras = {}) {
  const tenantId = user?.tenantId;
  const allowedLocationIds = userAllowedLocationIds(user);
  const programScope = userProgramScope(user);
  if (!tenantId) return { ...DENY_ALL_SCOPE, allowedLocationIds, programScope, ...extras };
  return { tenantId, allowedLocationIds, programScope, ...extras };
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
