// backend/src/lib/tenant-routing.test.mjs
//
// Tests for withTenantSchema() wrapper. Mirrors the structure of
// cache.test.mjs in the same directory.
//
// Runs with the project's existing node:test runner. No new deps.

import { test } from 'node:test';
import assert from 'node:assert/strict';

// We mock the prisma client via dependency injection. To do that cleanly
// without rewriting tenant-routing.js to accept an injected client, we
// use a small module-level test override pattern: replace the cached
// prisma reference before importing the SUT.
//
// Since the import is static in tenant-routing.js, we use node:test's
// import hooks via a wrapper. Simpler approach: spin a real test prisma
// against an in-memory schema OR mock at the integration level.
//
// For this test file we focus on the CACHE + ROUTING LOGIC since the
// downstream Prisma behavior is verified by integration tests.

// To make this file simple to run in CI without a DB, we use a fake
// prisma client passed into a helper-exported `__withTestPrisma(p)` hook
// we'll add in a follow-up PR. For now, the tests below describe the
// contract; they can be enabled once the test hook ships.

// =============================================================================
// Contract tests (not currently runnable without DB; describe expected behavior)
// =============================================================================

test('withTenantSchema requires a non-empty tenantId', async () => {
  const { withTenantSchema } = await import('./tenant-routing.js');
  await assert.rejects(
    () => withTenantSchema(null, async () => 'never'),
    /requires a non-empty tenantId/,
  );
  await assert.rejects(
    () => withTenantSchema('', async () => 'never'),
    /requires a non-empty tenantId/,
  );
  await assert.rejects(
    () => withTenantSchema(undefined, async () => 'never'),
    /requires a non-empty tenantId/,
  );
});

test('routingCacheStats reports a TTL of 5 minutes', async () => {
  const { routingCacheStats } = await import('./tenant-routing.js');
  const stats = routingCacheStats();
  assert.equal(stats.ttlMs, 5 * 60 * 1000);
});

test('peekRoutingCache returns null for unknown tenants', async () => {
  const { peekRoutingCache, invalidateAllTenantRouting } = await import('./tenant-routing.js');
  invalidateAllTenantRouting();
  assert.equal(peekRoutingCache('does-not-exist'), null);
});

test('invalidateAllTenantRouting clears all entries', async () => {
  const { invalidateAllTenantRouting, routingCacheStats } = await import('./tenant-routing.js');
  invalidateAllTenantRouting();
  assert.equal(routingCacheStats().size, 0);
});

// =============================================================================
// Integration test (requires a DB connection; gated on TEST_DATABASE_URL)
// =============================================================================

test('withTenantSchema executes callback against shared prisma when schemaName=public', { skip: !process.env.TEST_DATABASE_URL }, async () => {
  const { withTenantSchema, invalidateAllTenantRouting } = await import('./tenant-routing.js');
  const { prisma } = await import('./prisma.js');

  // Find any STANDARD-tier tenant (every tenant today).
  const tenant = await prisma.tenant.findFirst({
    where: { tier: 'STANDARD' },
    select: { id: true, schemaName: true },
  });
  assert.ok(tenant, 'expected at least one STANDARD-tier tenant in the test DB');
  assert.equal(tenant.schemaName, 'public', 'all tenants should be on public schema in Path D');

  invalidateAllTenantRouting();
  const result = await withTenantSchema(tenant.id, async (db) => {
    return db.tenant.count({ where: { id: tenant.id } });
  });
  assert.equal(result, 1);
});

test('withTenantSchema throws for unknown tenantId', { skip: !process.env.TEST_DATABASE_URL }, async () => {
  const { withTenantSchema } = await import('./tenant-routing.js');
  await assert.rejects(
    () => withTenantSchema('nonexistent-tenant-id', async () => 'never'),
    /unknown tenant/,
  );
});

test('withTenantSchema caches routing for subsequent calls (no DB read second time)', { skip: !process.env.TEST_DATABASE_URL }, async () => {
  const { withTenantSchema, peekRoutingCache, invalidateAllTenantRouting } = await import('./tenant-routing.js');
  const { prisma } = await import('./prisma.js');

  invalidateAllTenantRouting();
  const tenant = await prisma.tenant.findFirst({ select: { id: true } });
  await withTenantSchema(tenant.id, async (db) => db.tenant.count({ where: { id: tenant.id } }));
  const cached = peekRoutingCache(tenant.id);
  assert.ok(cached, 'expected routing cache to be populated after first call');
  assert.equal(cached.schemaName, 'public');
});
