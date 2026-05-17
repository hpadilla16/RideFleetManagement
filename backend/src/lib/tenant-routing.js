// backend/src/lib/tenant-routing.js — REPLACE the existing file with this version
//
// Path D — Routing-Ready Shared Multi-Tenancy.
//
// CHANGE FROM v1: Tolerates null/undefined tenantId (Path D safety for
// SUPER_ADMIN paths where req.user.tenantId is unset). When tenantId is
// missing, short-circuits to callback(prisma) — same behavior as the
// 'public' schema fast path.
//
// Rationale: SUPER_ADMIN users can access cross-tenant resources. Their
// req.user.tenantId is undefined. Today, with all tenants on 'public', the
// wrapper is effectively a no-op anyway. When promotions happen, SUPER_ADMIN
// queries that span tenants need explicit tenantId from the resource being
// accessed (not from req.user) — this is documented as a future-promotion
// follow-up in the architecture spec.

import { prisma } from './prisma.js';
import logger from './logger.js';

const routingCache = new Map();
const ROUTING_CACHE_TTL_MS = 5 * 60 * 1000;
const DEFAULT_SCHEMA = 'public';
const DEFAULT_TIER = 'STANDARD';

async function resolveTenantRouting(tenantId) {
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

export async function withTenantSchema(tenantId, callback) {
  // Path D safety: SUPER_ADMIN paths may not have a tenantId on req.user.
  // Short-circuit to no-op — equivalent to the 'public' schema fast path.
  // When promotions happen later, SUPER_ADMIN queries that need to hit a
  // promoted tenant's schema must pass an explicit tenantId from the
  // resource being accessed (e.g. reservation.tenantId), not from req.user.
  if (!tenantId) {
    return callback(prisma);
  }

  const { schemaName } = await resolveTenantRouting(tenantId);

  if (schemaName === DEFAULT_SCHEMA) {
    return callback(prisma);
  }

  return prisma.$transaction(async (tx) => {
    if (!/^[a-z][a-z0-9_]{0,62}$/.test(schemaName)) {
      throw new Error(`withTenantSchema: invalid schemaName "${schemaName}"`);
    }
    await tx.$executeRawUnsafe(`SET LOCAL search_path TO "${schemaName}", public`);
    return callback(tx);
  });
}

export function invalidateTenantRouting(tenantId) {
  routingCache.delete(tenantId);
}

export function invalidateAllTenantRouting() {
  routingCache.clear();
}

export function peekRoutingCache(tenantId) {
  return routingCache.get(tenantId) || null;
}

export function routingCacheStats() {
  return {
    size: routingCache.size,
    ttlMs: ROUTING_CACHE_TTL_MS,
  };
}

logger.info('[tenant-routing] withTenantSchema wrapper initialized (Path D mode, null-tolerant)');
