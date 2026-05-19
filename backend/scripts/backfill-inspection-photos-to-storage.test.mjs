/**
 * 16l backfill script tests.
 *
 * Style: node:test + assert/strict, no real Prisma / no real network.
 * We inject a tiny in-memory prisma stub and an uploader stub.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { runBackfill } from './backfill-inspection-photos-to-storage.mjs';

const TINY_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

function makePrismaStub({ rows }) {
  const updates = [];
  return {
    updates,
    rentalAgreementInspection: {
      async findMany({ where, take }) {
        // We do crude where-filter emulation just enough for tests.
        let out = rows.filter((r) => r.photosJson != null && r.photoStorageRefs == null);
        if (where?.rentalAgreement?.tenantId) {
          out = out.filter((r) => r.rentalAgreement?.tenantId === where.rentalAgreement.tenantId);
        }
        if (take) out = out.slice(0, take);
        return out;
      },
      async update({ where, data }) {
        updates.push({ where, data });
        const row = rows.find((r) => r.id === where.id);
        if (row) Object.assign(row, data);
        return row;
      }
    },
    async $disconnect() { /* noop */ }
  };
}

function silentLogger() {
  return {
    log: () => {},
    error: () => {}
  };
}

describe('runBackfill — dry-run (default)', () => {
  it('does not call uploader and does not write to prisma', async () => {
    const prisma = makePrismaStub({
      rows: [
        {
          id: 'insp1',
          photosJson: JSON.stringify({ front: TINY_B64 }),
          photoStorageRefs: null,
          rentalAgreement: { tenantId: 't1' }
        }
      ]
    });
    let uploaderCalls = 0;
    const uploader = async () => { uploaderCalls++; return {}; };
    const stats = await runBackfill({
      args: { commit: false, limit: null, tenant: null },
      prismaClient: prisma,
      uploader,
      logger: silentLogger()
    });
    assert.equal(uploaderCalls, 0);
    assert.equal(prisma.updates.length, 0);
    assert.equal(stats.total, 1);
    assert.equal(stats.migrated, 0);
    assert.equal(stats.skipped, 1);
  });
});

describe('runBackfill — commit', () => {
  it('uploads each photo and writes photoStorageRefs', async () => {
    const prisma = makePrismaStub({
      rows: [
        {
          id: 'insp_commit',
          photosJson: JSON.stringify({ front: TINY_B64, rear: TINY_B64 }),
          photoStorageRefs: null,
          rentalAgreement: { tenantId: 't1' }
        }
      ]
    });
    const uploaderCalls = [];
    const uploader = async (args) => {
      uploaderCalls.push(args);
      return { path: args.path };
    };
    const stats = await runBackfill({
      args: { commit: true, limit: null, tenant: null },
      prismaClient: prisma,
      uploader,
      logger: silentLogger()
    });
    assert.equal(uploaderCalls.length, 2);
    assert.equal(prisma.updates.length, 1);
    assert.equal(prisma.updates[0].where.id, 'insp_commit');
    assert.ok(Array.isArray(prisma.updates[0].data.photoStorageRefs));
    assert.equal(prisma.updates[0].data.photoStorageRefs.length, 2);
    assert.equal(stats.migrated, 1);
    assert.equal(stats.failed, 0);
  });

  it('skips rows whose agreement has no tenant', async () => {
    const prisma = makePrismaStub({
      rows: [
        {
          id: 'orphan',
          photosJson: JSON.stringify({ front: TINY_B64 }),
          photoStorageRefs: null,
          rentalAgreement: { tenantId: null }
        }
      ]
    });
    let uploaderCalls = 0;
    const uploader = async () => { uploaderCalls++; return {}; };
    const stats = await runBackfill({
      args: { commit: true, limit: null, tenant: null },
      prismaClient: prisma,
      uploader,
      logger: silentLogger()
    });
    assert.equal(uploaderCalls, 0);
    assert.equal(stats.noTenant, 1);
    assert.equal(stats.migrated, 0);
  });

  it('marks rows as failed when upload throws and continues', async () => {
    const prisma = makePrismaStub({
      rows: [
        {
          id: 'will_fail',
          photosJson: JSON.stringify({ front: TINY_B64 }),
          photoStorageRefs: null,
          rentalAgreement: { tenantId: 't1' }
        },
        {
          id: 'will_pass',
          photosJson: JSON.stringify({ front: TINY_B64 }),
          photoStorageRefs: null,
          rentalAgreement: { tenantId: 't1' }
        }
      ]
    });
    let n = 0;
    const uploader = async (args) => {
      n++;
      if (n === 1) throw new Error('storage 500');
      return { path: args.path };
    };
    const stats = await runBackfill({
      args: { commit: true, limit: null, tenant: null },
      prismaClient: prisma,
      uploader,
      logger: silentLogger()
    });
    assert.equal(stats.total, 2);
    assert.equal(stats.failed, 1);
    assert.equal(stats.migrated, 1);
    assert.equal(prisma.updates.length, 1);
    assert.equal(prisma.updates[0].where.id, 'will_pass');
  });

  it('respects --tenant scope', async () => {
    const prisma = makePrismaStub({
      rows: [
        {
          id: 'A',
          photosJson: JSON.stringify({ front: TINY_B64 }),
          photoStorageRefs: null,
          rentalAgreement: { tenantId: 'tA' }
        },
        {
          id: 'B',
          photosJson: JSON.stringify({ front: TINY_B64 }),
          photoStorageRefs: null,
          rentalAgreement: { tenantId: 'tB' }
        }
      ]
    });
    const uploader = async (args) => ({ path: args.path });
    const stats = await runBackfill({
      args: { commit: true, limit: null, tenant: 'tA' },
      prismaClient: prisma,
      uploader,
      logger: silentLogger()
    });
    assert.equal(stats.total, 1);
    assert.equal(stats.migrated, 1);
    assert.equal(prisma.updates.length, 1);
    assert.equal(prisma.updates[0].where.id, 'A');
  });
});
