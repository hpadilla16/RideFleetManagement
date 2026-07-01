/**
 * 16l backfill script tests (mock prisma, no real network).
 *
 * Updated 2026-06 for the production-scale rewrite: discovery is via
 * $queryRawUnsafe (ids only) + per-row findUnique, and the HARDENED path
 * requires a read-back verify (downloader). The stub below emulates exactly the
 * SQL shapes the script issues. The authoritative at-scale coverage lives in
 * backfill-inspection-photos-to-storage.embedded.test.mjs; these are fast
 * logic checks.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { runBackfill } from './backfill-inspection-photos-to-storage.mjs';

// Valid tiny PNG (real magic header) — required now that decode validates it.
const TINY_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
const TINY_LEN = Buffer.from(TINY_B64, 'base64').byteLength;

/**
 * Prisma stub implementing the calls the script actually makes:
 *   - $queryRawUnsafe(countSql[, tenant])        -> [{ n }]
 *   - $queryRawUnsafe(discoverSql[, tenant], lim)-> [{ id, tenantId }]
 *   - rentalAgreementInspection.findUnique({where:{id}}) -> row
 *   - rentalAgreementInspection.update(...)      -> records update
 */
function makePrismaStub({ rows }) {
  const updates = [];
  const candidates = (tenant) =>
    rows.filter(
      (r) =>
        r.photosJson != null &&
        r.photoStorageRefs == null &&
        r.rentalAgreement?.tenantId != null &&
        (!tenant || r.rentalAgreement.tenantId === tenant)
    );
  return {
    updates,
    async $queryRawUnsafe(sql, ...params) {
      const isCount = /count\(\*\)/i.test(sql);
      // Last positional param is the LIMIT for discovery; tenant (if any) first.
      const hasTenant = / r\."tenantId" = \$/.test(sql);
      const tenant = hasTenant ? params[0] : null;
      if (isCount) return [{ n: candidates(tenant).length }];
      const limit = params[params.length - 1];
      return candidates(tenant)
        .slice(0, limit)
        .map((r) => ({ id: r.id, tenantId: r.rentalAgreement.tenantId }));
    },
    rentalAgreementInspection: {
      async findUnique({ where }) {
        const r = rows.find((x) => x.id === where.id);
        if (!r) return null;
        return { photosJson: r.photosJson, photoStorageRefs: r.photoStorageRefs };
      },
      async update({ where, data }) {
        updates.push({ where, data });
        const r = rows.find((x) => x.id === where.id);
        if (r) Object.assign(r, data);
        return r;
      }
    },
    async $disconnect() {}
  };
}

const okDownloader = async () => ({ body: Buffer.alloc(TINY_LEN) });
function silentLogger() {
  return { log: () => {}, error: () => {}, warn: () => {} };
}

describe('runBackfill — dry-run (default)', () => {
  it('does not upload and does not write; reports candidate count', async () => {
    const prisma = makePrismaStub({
      rows: [{ id: 'insp1', photosJson: JSON.stringify({ front: TINY_B64 }), photoStorageRefs: null, rentalAgreement: { tenantId: 't1' } }]
    });
    let uploaderCalls = 0;
    const uploader = async () => { uploaderCalls++; return {}; };
    const stats = await runBackfill({
      args: { commit: false, limit: null, tenant: null, batch: 100 },
      prismaClient: prisma, uploader, downloader: okDownloader, logger: silentLogger()
    });
    assert.equal(uploaderCalls, 0);
    assert.equal(prisma.updates.length, 0);
    assert.equal(stats.candidates, 1);
    assert.equal(stats.total, 0);
    assert.equal(stats.migrated, 0);
  });
});

describe('runBackfill — commit (hardened, read-back verify)', () => {
  it('uploads each photo, verifies, and writes photoStorageRefs', async () => {
    const prisma = makePrismaStub({
      rows: [{ id: 'insp_commit', photosJson: JSON.stringify({ front: TINY_B64, rear: TINY_B64 }), photoStorageRefs: null, rentalAgreement: { tenantId: 't1' } }]
    });
    const uploaderCalls = [];
    const uploader = async (args) => { uploaderCalls.push(args); return { path: args.path }; };
    const stats = await runBackfill({
      args: { commit: true, limit: null, tenant: null, batch: 100 },
      prismaClient: prisma, uploader, downloader: okDownloader, logger: silentLogger()
    });
    assert.equal(uploaderCalls.length, 2);
    assert.equal(prisma.updates.length, 1);
    assert.equal(prisma.updates[0].data.photoStorageRefs.length, 2);
    assert.equal(stats.migrated, 1);
    assert.equal(stats.failed, 0);
    assert.equal(stats.verifyFailed, 0);
  });

  it('HARDENED: read-back mismatch -> verifyFailed, no refs written', async () => {
    const prisma = makePrismaStub({
      rows: [{ id: 'mismatch', photosJson: JSON.stringify({ front: TINY_B64 }), photoStorageRefs: null, rentalAgreement: { tenantId: 't1' } }]
    });
    const uploader = async (args) => ({ path: args.path });
    const badDownloader = async () => ({ body: Buffer.alloc(3) }); // wrong length
    const stats = await runBackfill({
      args: { commit: true, limit: null, tenant: null, batch: 100 },
      prismaClient: prisma, uploader, downloader: badDownloader, logger: silentLogger()
    });
    assert.equal(stats.migrated, 0);
    assert.equal(stats.verifyFailed, 1);
    assert.equal(prisma.updates.length, 0, 'no refs written when verify fails');
  });

  it('marks rows failed when upload throws and continues to the next', async () => {
    const prisma = makePrismaStub({
      rows: [
        { id: 'will_fail', photosJson: JSON.stringify({ front: TINY_B64 }), photoStorageRefs: null, rentalAgreement: { tenantId: 't1' } },
        { id: 'will_pass', photosJson: JSON.stringify({ front: TINY_B64 }), photoStorageRefs: null, rentalAgreement: { tenantId: 't1' } }
      ]
    });
    let n = 0;
    const uploader = async (args) => { n++; if (n === 1) throw new Error('storage 500'); return { path: args.path }; };
    const stats = await runBackfill({
      args: { commit: true, limit: null, tenant: null, batch: 100 },
      prismaClient: prisma, uploader, downloader: okDownloader, logger: silentLogger()
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
        { id: 'A', photosJson: JSON.stringify({ front: TINY_B64 }), photoStorageRefs: null, rentalAgreement: { tenantId: 'tA' } },
        { id: 'B', photosJson: JSON.stringify({ front: TINY_B64 }), photoStorageRefs: null, rentalAgreement: { tenantId: 'tB' } }
      ]
    });
    const uploader = async (args) => ({ path: args.path });
    const stats = await runBackfill({
      args: { commit: true, limit: null, tenant: 'tA', batch: 100 },
      prismaClient: prisma, uploader, downloader: okDownloader, logger: silentLogger()
    });
    assert.equal(stats.total, 1);
    assert.equal(stats.migrated, 1);
    assert.equal(prisma.updates[0].where.id, 'A');
  });
});
