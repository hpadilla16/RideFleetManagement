import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { prisma } from '../../lib/prisma.js';
import { feesService } from './fees.service.js';

// These tests monkey-patch prisma.fee.create to capture the shape of the
// data object the service sends. That lets us verify default behavior
// around `displayOnline` without needing a live database.
//
// Rationale: feesService.create is a thin passthrough — the only thing
// worth unit-testing is that every column (including the new displayOnline
// field) gets sent with the correct default. Real DB persistence is
// covered by the tenant-isolation suite (v7-website-fees.mjs).

describe('feesService.create — displayOnline default behavior', () => {
  let capturedArgs;
  let origCreate;

  beforeEach(() => {
    capturedArgs = null;
    origCreate = prisma.fee.create;
    prisma.fee.create = async (args) => {
      capturedArgs = args;
      return { id: 'stub-id', ...(args?.data || {}) };
    };
  });

  afterEach(() => {
    prisma.fee.create = origCreate;
  });

  it('defaults displayOnline to false when not provided', async () => {
    await feesService.create(
      { name: 'Basic Fee', mode: 'FIXED', amount: 10 },
      { tenantId: 'tenant-123' }
    );
    assert.equal(capturedArgs.data.displayOnline, false);
  });

  it('persists displayOnline=true when explicitly set', async () => {
    await feesService.create(
      { name: 'Website Fee', mode: 'FIXED', amount: 5, displayOnline: true },
      { tenantId: 'tenant-123' }
    );
    assert.equal(capturedArgs.data.displayOnline, true);
  });

  it('persists displayOnline=false when explicitly set', async () => {
    await feesService.create(
      { name: 'Hidden Fee', mode: 'FIXED', amount: 7, displayOnline: false },
      { tenantId: 'tenant-123' }
    );
    assert.equal(capturedArgs.data.displayOnline, false);
  });

  it('still applies tenant scoping even when displayOnline is set', async () => {
    await feesService.create(
      { name: 'Scoped', mode: 'FIXED', amount: 1, displayOnline: true },
      { tenantId: 'tenant-xyz' }
    );
    assert.equal(capturedArgs.data.tenantId, 'tenant-xyz');
    assert.equal(capturedArgs.data.displayOnline, true);
  });
});
