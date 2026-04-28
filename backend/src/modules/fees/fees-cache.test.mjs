import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { prisma } from '../../lib/prisma.js';
import { cache } from '../../lib/cache.js';
import { feesService } from './fees.service.js';

// Verifies the cache wiring on feesService:
//   1. list() is memoized per tenant scope (single prisma.fee.findMany call
//      across multiple list() calls within TTL).
//   2. create / update / remove invalidate the per-tenant list cache so the
//      next list() reflects the write.
// Uses a monkey-patched prisma — no DB. Cache module is the real one; we
// clear it between tests to avoid leakage.

describe('feesService — list cache + write invalidation', () => {
  let findManyCalls;
  let origFindMany;
  let origCreate;
  let origUpdate;
  let origDelete;
  let origFindFirst;

  beforeEach(() => {
    cache.clear();
    findManyCalls = 0;
    origFindMany = prisma.fee.findMany;
    origCreate = prisma.fee.create;
    origUpdate = prisma.fee.update;
    origDelete = prisma.fee.delete;
    origFindFirst = prisma.fee.findFirst;

    prisma.fee.findMany = async () => {
      findManyCalls += 1;
      return [{ id: 'fee-1', name: 'Test', tenantId: 'tenant-1' }];
    };
    prisma.fee.create = async (args) => ({ id: 'fee-new', ...(args?.data || {}) });
    prisma.fee.update = async (args) => ({ id: args?.where?.id, ...(args?.data || {}) });
    prisma.fee.delete = async (args) => ({ id: args?.where?.id });
    // Default findFirst stub — individual tests can override for tenant-specific scenarios.
    prisma.fee.findFirst = async (args) => ({
      id: args?.where?.id || 'fee-1',
      tenantId: args?.where?.tenantId || 'tenant-1'
    });
  });

  afterEach(() => {
    prisma.fee.findMany = origFindMany;
    prisma.fee.create = origCreate;
    prisma.fee.update = origUpdate;
    prisma.fee.delete = origDelete;
    prisma.fee.findFirst = origFindFirst;
    cache.clear();
  });

  it('memoizes list() per tenant scope — second call hits cache, not prisma', async () => {
    await feesService.list({ tenantId: 'tenant-1' });
    await feesService.list({ tenantId: 'tenant-1' });
    await feesService.list({ tenantId: 'tenant-1' });
    assert.equal(findManyCalls, 1);
  });

  it('keeps separate cache entries per tenant', async () => {
    await feesService.list({ tenantId: 'tenant-1' });
    await feesService.list({ tenantId: 'tenant-2' });
    await feesService.list({ tenantId: 'tenant-1' });
    await feesService.list({ tenantId: 'tenant-2' });
    assert.equal(findManyCalls, 2);
  });

  it('create() invalidates the per-tenant list cache', async () => {
    await feesService.list({ tenantId: 'tenant-1' });
    assert.equal(findManyCalls, 1);
    await feesService.create({ name: 'New Fee', mode: 'FIXED', amount: 1 }, { tenantId: 'tenant-1' });
    await feesService.list({ tenantId: 'tenant-1' });
    assert.equal(findManyCalls, 2, 'list after create should re-query prisma');
  });

  it('update() invalidates the per-tenant list cache', async () => {
    await feesService.list({ tenantId: 'tenant-1' });
    await feesService.update('fee-1', { name: 'Renamed' }, { tenantId: 'tenant-1' });
    await feesService.list({ tenantId: 'tenant-1' });
    assert.equal(findManyCalls, 2);
  });

  it('remove() invalidates the per-tenant list cache', async () => {
    await feesService.list({ tenantId: 'tenant-1' });
    await feesService.remove('fee-1', { tenantId: 'tenant-1' });
    await feesService.list({ tenantId: 'tenant-1' });
    assert.equal(findManyCalls, 2);
  });

  it('write to tenant-1 does NOT invalidate tenant-2 list cache', async () => {
    await feesService.list({ tenantId: 'tenant-2' });
    assert.equal(findManyCalls, 1);
    await feesService.create({ name: 'X', mode: 'FIXED', amount: 1 }, { tenantId: 'tenant-1' });
    await feesService.list({ tenantId: 'tenant-2' });
    assert.equal(findManyCalls, 1, 'tenant-2 cache should remain warm after tenant-1 write');
  });

  // Codex bot finding (PR #15): SUPER_ADMIN can write into a tenant via
  // data.tenantId without `?tenantId=` in the request. The original
  // implementation invalidated by request scope only, so the per-tenant
  // cache stayed stale until TTL expired.
  it('SUPER_ADMIN create with empty scope but data.tenantId clears the row\'s tenant cache', async () => {
    // Warm the per-tenant cache as if a tenant user just listed
    await feesService.list({ tenantId: 'tenant-9' });
    assert.equal(findManyCalls, 1);

    // SUPER_ADMIN creates a fee for tenant-9 without ?tenantId= in the request
    await feesService.create(
      { name: 'Cross-tenant', mode: 'FIXED', amount: 1, tenantId: 'tenant-9' },
      {} // empty scope (e.g., SUPER_ADMIN without ?tenantId=)
    );

    // The per-tenant cache must now be cleared so the tenant user sees the
    // new row on the next list() call.
    await feesService.list({ tenantId: 'tenant-9' });
    assert.equal(findManyCalls, 2, 'per-tenant cache must be invalidated by data.tenantId');
  });

  it('tenant-scoped create also invalidates the global SUPER_ADMIN list cache', async () => {
    // SUPER_ADMIN warms the global (unfiltered) list
    await feesService.list({}); // scope without tenantId -> 'fees:list:global'
    assert.equal(findManyCalls, 1);

    // A tenant-scoped write happens
    await feesService.create({ name: 'X', mode: 'FIXED', amount: 1 }, { tenantId: 'tenant-1' });

    // Global list should be re-queried because it includes all tenants' rows
    await feesService.list({});
    assert.equal(findManyCalls, 2, 'global cache must be invalidated by tenant-scoped write');
  });

  it('update() invalidates by the row\'s tenantId, not the request scope', async () => {
    // Override findFirst to model SUPER_ADMIN updating a tenant-9 row from empty scope
    prisma.fee.findFirst = async () => ({ id: 'fee-1', tenantId: 'tenant-9' });

    await feesService.list({ tenantId: 'tenant-9' });
    assert.equal(findManyCalls, 1);

    await feesService.update('fee-1', { name: 'Renamed' }, {}); // empty scope

    await feesService.list({ tenantId: 'tenant-9' });
    assert.equal(findManyCalls, 2, 'update must invalidate the row\'s tenant cache');
  });
});
