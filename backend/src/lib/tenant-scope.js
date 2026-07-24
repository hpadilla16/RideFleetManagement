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
 *
 * SUPER_ADMIN is cross-tenant and is never location-scoped.
 *
 * ADMIN (2026-07-23): an ADMIN with NO locationIds keeps tenant-wide visibility
 * (unchanged — that is the ordinary tenant admin). An ADMIN WITH explicit
 * locationIds is a LOCATION admin — the admin OF that branch — and is now scoped
 * to it. Previously ADMIN bypassed unconditionally, so assigning locationIds to
 * an admin silently did nothing and they still saw the whole tenant; the
 * assignment looked applied but wasn't.
 */
export function userAllowedLocationIds(user) {
  const role = String(user?.role || '').toUpperCase();
  if (role === 'SUPER_ADMIN') return null;
  const ids = Array.isArray(user?.locationIds) ? user.locationIds.filter(Boolean) : null;
  return ids && ids.length ? ids : null;
}

/**
 * The caller's own location restriction, normalized: a non-empty array of ids,
 * or null = unrestricted. This is the `scope` half of `effectiveLocationIds`,
 * split out for the callers that must NOT intersect with a `?locationId` —
 * planner's reservation filter ORs the selection across three columns
 * (pickup/return/vehicle home) and ANDs the caller's restriction on top, so it
 * needs the restriction alone.
 *
 * The `.filter(Boolean)` is the part that kept getting dropped in the inline
 * copies: without it a `[null]` allowedLocationIds becomes `{ in: [null] }`,
 * which is a filter matching only null-location rows rather than the
 * "unrestricted" it means. `userAllowedLocationIds` already filters, so no
 * scope built by `scopeFor` can reach that state today — this keeps it true for
 * scopes assembled by hand (tests, schedulers, future callers).
 */
export function scopeAllowedLocationIds(scope = {}) {
  const ids = Array.isArray(scope?.allowedLocationIds)
    ? scope.allowedLocationIds.filter(Boolean)
    : null;
  return ids && ids.length ? ids : null;
}

/**
 * The Location ids a single request may actually read = the caller's allowed
 * locations ∩ the explicit `?locationId` selection. Returns null = no
 * restriction, so it composes into any `where`.
 *
 * The invariant, and the reason this is one function instead of a paste in each
 * service: a `?locationId` the caller is NOT allowed to see never widens the
 * scope — it is ignored and the caller falls back to their own locations. An
 * unrestricted caller keeps honoring the filter as a plain filter.
 *
 * Hoisted here 2026-07-23 (it was duplicated per-module) once repair orders
 * became the second consumer in the same file pair. `lib/program-category.js`
 * established the precedent: scoping fragments live in lib so services compose
 * them instead of re-deriving them. The last four inline copies (reports
 * overview/commissions, planner reservations/vehicles) were folded in
 * 2026-07-24 — they had drifted from this one by omitting the `.filter(Boolean)`.
 */
export function effectiveLocationIds(query = {}, scope = {}) {
  const locationId = query?.locationId ? String(query.locationId) : null;
  const allowed = scopeAllowedLocationIds(scope);
  if (!allowed) return locationId ? [locationId] : null;
  return locationId && allowed.includes(locationId) ? [locationId] : allowed;
}

/**
 * Location filter for a RESERVATION-shaped query (2026-07-24): visible when
 * EITHER endpoint is in the caller's allowed set. This is the rule the
 * reservations module has always used — a one-way rental belongs to both the
 * branch that handed the car out and the branch that takes it back, so keying on
 * a single column would hide it from one of them.
 *
 * Deliberately NOT the vehicle's home location: which branch a car is garaged at
 * says nothing about who rented it out.
 *
 * Returns {} when the caller is unrestricted, so it composes into any `where`.
 *
 * NOTE: `reservations.service.js` still has three inline copies of this shape
 * (its list/summary paths). They are equivalent today; folding them in is a
 * follow-up, kept out of this change because that file has other work in flight.
 */
export function reservationLocationWhere(scope = {}) {
  const ids = scopeAllowedLocationIds(scope);
  if (!ids) return {};
  return { OR: [{ pickupLocationId: { in: ids } }, { returnLocationId: { in: ids } }] };
}

/**
 * Deliberate privilege elevation (2026-07-24): strip the caller's location /
 * program restrictions and keep ONLY the tenant boundary.
 *
 * Use this — never a bare `{ tenantId }` literal — wherever a request has ALREADY
 * been authorized and what follows is reconciliation or post-write hydration
 * rather than a new read. Two shapes need it:
 *
 *  1. RECONCILIATION that prunes. `syncReservationTollCharges` /
 *     `syncCitationCharges` rebuild a reservation's charges from the rows their
 *     query returns and DELETE the ones it doesn't. Narrowing that query by the
 *     acting user's locations deletes real money.
 *  2. POST-WRITE HYDRATION. Re-reading a row you just legitimately created or
 *     updated through the caller's read filter can throw AFTER the write
 *     committed — a 404 on a successful write, with the side effects already
 *     applied.
 *
 * The point is not the abstraction (it is three lines); it is that every
 * elevation becomes greppable by one token instead of living only in a comment.
 * Keep the comment too — this says WHAT, the comment says WHY here.
 */
export function systemScope(scope = {}) {
  return { tenantId: scope?.tenantId ?? null };
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
