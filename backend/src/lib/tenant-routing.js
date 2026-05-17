// backend/src/lib/tenant-routing.js
//
// Path D — Routing-Ready Shared Multi-Tenancy.
//
// withTenantSchema(tenantId, callback) wraps tenant-scoped database work in
// a schema resolution + (when applicable) Postgres search_path transaction.
//
// Today (2026-05-17 cutover): every tenant has schemaName='public' in the
// Tenant table. The wrapper short-circuits to a no-op fast path — callback
// runs against the shared prisma client with zero overhead.
//
// Future (when a tenant is promoted to a dedicated schema): the wrapper
// resolves schemaName='tenant_<slug>' from the cached Tenant row, opens a
// transaction, sets `SET LOCAL search_path TO "tenant_<slug>", public`,
// and runs the callback inside that transaction. Zero application code
// changes are required when promotions happen — only the routing cache
// needs to be invalidated (see invalidateTenantRouting below).
//
// See doc/multitenancy-hybrid-architecture.md for the full spec.
//
// Companion to:
//   - scopeFor(req) in tenant-scope.js — handles WHERE clause tenantId filtering.
//   - withTenantSchema(tenantId, fn) — handles SCHEMA routing.
// Both work together as defense-in-depth.

import { prisma } from './prisma.js';
import logger from './logger.js';

// In-memory routing cache. tenantId → { schemaName, tier, expiresAt }.
// 5-minute TTL. Invalidated explicitly on tenant promotion via
// invalidateTenantRouting(tenantId) (called from the promotion script and
// from a Redis pub/sub subscriber so every worker drops the entry).
const routingCache = new Map();
const ROUTING_CACHE_TTL_MS = 5 * 60 * 1000;

// Constants used in the wrapper logic.
const DEFAULT_SCHEMA = 'public';
const DEFAULT_TIER = 'STANDARD';

/**
 * Resolve the routing entry for a tenant. Reads from cache when fresh,
 * otherwise hits the Tenant table via the shared prisma client.
 *
 * @param {string} tenantId
 * @returns {Promise<{schemaName: string, tier: string}>}
 */
async function resolveTenantRouting(tenantId) {
  if (!tenantId) {
    throw new Error('withTenantSchema requires a non-empty tenantId');
  }

  const cached = routingCache.get(tenantId);
  if (cached && cached.expiresAt > Date.now()) {
    return { schemaName: cached.schemaName, tier: cached.tier };
  }

  const tenant = await prisma.tenant.findUnique({
    where: { id: tenantId },
    select: { schemaName: true, tier: true },
  });

  if (!tenant) {
    throw new Error(`withTenantSchema: unknown tenant ${tenantId}`);
  }

  const entry = {
    schemaName: tenant.schemaName || DEFAULT_SCHEMA,
    tier: tenant.tier || DEFAULT_TIER,
    expiresAt: Date.now() + ROUTING_CACHE_TTL_MS,
  };
  routingCache.set(tenantId, entry);
  return { schemaName: entry.schemaName, tier: entry.tier };
}

/**
 * Run a database callback in the schema context of the given tenant.
 *
 * Today (Path D): when schemaName='public', callback runs against the
 * shared prisma client directly — zero overhead, identical to calling
 * `prisma.X` in the handler.
 *
 * Future: when a tenant has been promoted to a dedicated schema, the
 * callback runs inside a transaction with `SET LOCAL search_path` so
 * unqualified table references resolve to the tenant's schema.
 *
 * Either way, the callback receives a `db` argument that should be used
 * in place of the imported prisma client for all queries.
 *
 * Usage:
 *   const reservations = await withTenantSchema(req.tenantId, (db) =>
 *     db.reservation.findMany({ where: { ...scope, status: 'NEW' } })
 *   );
 *
 * Do NOT use this for super-admin / cross-tenant queries — those should
 * use the prisma client directly (or the future withAllTenantSchemas helper).
 *
 * @param {string} tenantId
 * @param {(db: import('@prisma/client').PrismaClient | import('@prisma/client').Prisma.TransactionClient) => Promise<T>} callback
 * @returns {Promise<T>}
 */
export async function withTenantSchema(tenantId, callback) {
  const { schemaName } = await resolveTenantRouting(tenantId);

  // Path D fast path: schemaName='public' means no schema routing needed.
  // Every tenant lives here today. Zero overhead — direct prisma callback.
  if (schemaName === DEFAULT_SCHEMA) {
    return callback(prisma);
  }

  // Future branch: tenant promoted to a dedicated schema. Run inside a
  // transaction with SET LOCAL search_path so Postgres resolves
  // unqualified table references to the right schema.
  return prisma.$transaction(async (tx) => {
    // schemaName comes from our own Tenant table — controlled input — but
    // we double-validate the format here to make SQL injection impossible
    // even if the Tenant row was somehow corrupted.
    if (!/^[a-z][a-z0-9_]{0,62}$/.test(schemaName)) {
      throw new Error(`withTenantSchema: invalid schemaName "${schemaName}"`);
    }
    await tx.$executeRawUnsafe(`SET LOCAL search_path TO "${schemaName}", public`);
    return callback(tx);
  });
}

/**
 * Drop a tenant's cached routing entry. Called from the promotion script
 * after updating Tenant.schemaName so the next request picks up the new
 * routing.
 *
 * For cluster-mode safety, this should ALSO be published over Redis pub/sub
 * on the `tenant:routing-invalidate` channel so every backend worker drops
 * its in-process cache entry. The Redis subscriber wiring lives in
 * cache.js's pub/sub setup (TODO: extend cache.js subscriber).
 *
 * @param {string} tenantId
 */
export function invalidateTenantRouting(tenantId) {
  routingCache.delete(tenantId);
}

/**
 * Drop all cached routing entries. Used in tests + for emergency cache
 * resets. Production code should prefer invalidateTenantRouting per tenant.
 */
export function invalidateAllTenantRouting() {
  routingCache.clear();
}

/**
 * Return the cached routing entry for a tenant without falling back to a
 * database read. Returns null if not cached. Intended for diagnostic /
 * observability use — not for routing decisions.
 *
 * @param {string} tenantId
 * @returns {{schemaName: string, tier: string, expiresAt: number} | null}
 */
export function peekRoutingCache(tenantId) {
  return routingCache.get(tenantId) || null;
}

/**
 * Stats for the routing cache. Intended for /health endpoint.
 *
 * @returns {{size: number, ttlMs: number}}
 */
export function routingCacheStats() {
  return {
    size: routingCache.size,
    ttlMs: ROUTING_CACHE_TTL_MS,
  };
}

// Log when this module initializes so cluster-worker boots are traceable.
logger.info('[tenant-routing] withTenantSchema wrapper initialized (Path D mode)');
