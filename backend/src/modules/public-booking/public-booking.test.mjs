import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { prisma } from '../../lib/prisma.js';
import { publicBookingService } from './public-booking.service.js';

// These tests monkey-patch prisma.tenant.findFirst and prisma.fee.findMany
// so we can verify getWebsiteMandatoryFees behavior without a live DB.
// Live-DB tenant-isolation coverage lives in scripts/tenant-tests/v7-website-fees.mjs.

describe('publicBookingService.getWebsiteMandatoryFees', () => {
  let origTenantFindFirst;
  let origFeeFindMany;
  let tenantFindFirstArgs;
  let feeFindManyArgs;
  let fakeTenant;
  let fakeFees;

  beforeEach(() => {
    tenantFindFirstArgs = null;
    feeFindManyArgs = null;
    fakeTenant = { id: 'tenant-123' };
    fakeFees = [];
    origTenantFindFirst = prisma.tenant.findFirst;
    origFeeFindMany = prisma.fee.findMany;
    prisma.tenant.findFirst = async (args) => {
      tenantFindFirstArgs = args;
      return fakeTenant;
    };
    prisma.fee.findMany = async (args) => {
      feeFindManyArgs = args;
      return fakeFees;
    };
  });

  afterEach(() => {
    prisma.tenant.findFirst = origTenantFindFirst;
    prisma.fee.findMany = origFeeFindMany;
  });

  it('throws when neither tenantId nor tenantSlug is provided', async () => {
    await assert.rejects(
      () => publicBookingService.getWebsiteMandatoryFees({}),
      /tenantSlug or tenantId is required/
    );
  });

  it('throws when tenant lookup returns null', async () => {
    fakeTenant = null;
    await assert.rejects(
      () => publicBookingService.getWebsiteMandatoryFees({ tenantSlug: 'no-such-tenant' }),
      /Tenant not found/
    );
  });

  it('resolves tenant by slug (lowercased + trimmed) and filters ACTIVE', async () => {
    await publicBookingService.getWebsiteMandatoryFees({ tenantSlug: '  TENANT-A  ' });
    assert.equal(tenantFindFirstArgs.where.status, 'ACTIVE');
    assert.equal(tenantFindFirstArgs.where.slug, 'tenant-a');
  });

  it('resolves tenant by id (trimmed) when provided', async () => {
    await publicBookingService.getWebsiteMandatoryFees({ tenantId: '  tenant-xyz  ' });
    assert.equal(tenantFindFirstArgs.where.id, 'tenant-xyz');
  });

  it('fetches only fees where mandatory + active + displayOnline are all true', async () => {
    await publicBookingService.getWebsiteMandatoryFees({ tenantId: 'tenant-123' });
    assert.equal(feeFindManyArgs.where.tenantId, 'tenant-123');
    assert.equal(feeFindManyArgs.where.isActive, true);
    assert.equal(feeFindManyArgs.where.mandatory, true);
    assert.equal(feeFindManyArgs.where.displayOnline, true);
    assert.deepEqual(feeFindManyArgs.orderBy, { createdAt: 'asc' });
  });

  it('returns { tenantId, fees } on success', async () => {
    fakeFees = [
      { id: 'fee-1', name: 'Website Fee', amount: 5, mandatory: true, displayOnline: true }
    ];
    const result = await publicBookingService.getWebsiteMandatoryFees({ tenantId: 'tenant-123' });
    assert.equal(result.tenantId, 'tenant-123');
    assert.equal(result.fees.length, 1);
    assert.equal(result.fees[0].id, 'fee-1');
  });

  it('returns empty fees array when no matching rows', async () => {
    fakeFees = [];
    const result = await publicBookingService.getWebsiteMandatoryFees({ tenantId: 'tenant-123' });
    assert.deepEqual(result.fees, []);
  });
});
