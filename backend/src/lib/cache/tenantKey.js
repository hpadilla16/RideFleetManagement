/**
 * Tenant-scoped cache key helpers.
 *
 * Centralises how cache keys are built so that every per-tenant cache entry
 * is namespaced under `t:<tenantId>:...` and every cross-tenant ("global")
 * entry is namespaced under `global:...`. Mixing the two namespaces is the
 * #1 root cause of cross-tenant cache bleed: a missing tenantId silently
 * collapses two tenants onto the same key and the second tenant gets the
 * first tenant's payload until TTL expires.
 *
 * Usage:
 *   import { tenantKey, globalKey } from '../../lib/cache/tenantKey.js';
 *
 *   // Per-tenant:
 *   const key = tenantKey(scope.tenantId, 'reservations', 'list', page);
 *   // -> "t:abc-123:reservations:list:1"
 *
 *   // Cross-tenant (SUPER_ADMIN unfiltered list, kiosk, etc.):
 *   const key = globalKey('reservations', 'list', page);
 *   // -> "global:reservations:list:1"
 *
 * Design notes:
 *   - tenantId is REQUIRED for tenantKey(). We throw rather than fall back
 *     to "global" because a silent fallback is exactly the bug this helper
 *     exists to prevent. Callers that legitimately need a global key must
 *     ask for one explicitly via globalKey().
 *   - We accept numeric tenantIds (legacy seed data uses integers) and
 *     coerce to string. We do NOT accept BigInt — Prisma surfaces those as
 *     strings already.
 *   - Parts are joined with ":" and stringified. Objects / null / undefined
 *     parts throw, since they almost always indicate a bug in the caller
 *     (e.g. forgetting to pass `scope.tenantId`).
 *
 * See backend/scripts/lint-cache-keys.mjs — the companion lint that flags
 * cache callsites that build keys without routing through these helpers.
 */

function assertPart(part, index) {
  if (part === null || part === undefined) {
    throw new TypeError(`tenantKey/globalKey: part[${index}] is ${part}`);
  }
  if (typeof part === 'object') {
    throw new TypeError(`tenantKey/globalKey: part[${index}] is an object; pass primitives`);
  }
  // booleans, numbers, strings — anything that coerces cleanly to a string is fine.
  return String(part);
}

/**
 * Build a per-tenant cache key.
 *
 * @param {string|number} tenantId - Tenant identifier. Must be non-empty.
 *   A number is coerced to its decimal string form.
 * @param {...(string|number|boolean)} parts - One or more key segments.
 * @returns {string} `t:<tenantId>:<parts joined by ":">`
 * @throws {TypeError} if tenantId is empty/null/undefined/not a string-or-number,
 *   or if no parts are supplied, or if any part is null/undefined/object.
 */
export function tenantKey(tenantId, ...parts) {
  if (tenantId === null || tenantId === undefined) {
    throw new TypeError(`tenantKey: tenantId is required (got ${tenantId})`);
  }
  const t = typeof tenantId;
  if (t !== 'string' && t !== 'number') {
    throw new TypeError(`tenantKey: tenantId must be string or number (got ${t})`);
  }
  const tenantStr = String(tenantId);
  if (tenantStr.length === 0) {
    throw new TypeError('tenantKey: tenantId must not be empty');
  }
  if (parts.length === 0) {
    throw new TypeError('tenantKey: at least one key part is required');
  }
  const tail = parts.map(assertPart).join(':');
  return `t:${tenantStr}:${tail}`;
}

/**
 * Build a cross-tenant ("global") cache key. Use this only when the cached
 * value is genuinely tenant-agnostic (e.g. a SUPER_ADMIN unfiltered list,
 * a kiosk token lookup, a public booking-engine catalog).
 *
 * @param {...(string|number|boolean)} parts - One or more key segments.
 * @returns {string} `global:<parts joined by ":">`
 * @throws {TypeError} if no parts are supplied, or if any part is
 *   null/undefined/object.
 */
export function globalKey(...parts) {
  if (parts.length === 0) {
    throw new TypeError('globalKey: at least one key part is required');
  }
  const tail = parts.map(assertPart).join(':');
  return `global:${tail}`;
}
