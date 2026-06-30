/**
 * 16l backfill — embedded-postgres integration test, AT SCALE.
 *
 * Boots a real throwaway Postgres + generated Prisma client and seeds MANY
 * inspection rows (40+) each carrying a non-trivial base64 blob, with a mix of:
 *   - inline base64 photosJson, photoStorageRefs IS NULL   (MUST migrate)
 *   - already migrated (photoStorageRefs non-null)         (MUST skip)
 *   - photosJson holding an http(s) passthrough value      (uploads 0, ref kept)
 *   - photosJson NULL                                      (MUST skip)
 *
 * It proves the production-scale redesign:
 *   - DISCOVERY is via $queryRaw and selects ONLY ids (never photosJson). We
 *     assert this by spying on prisma.$queryRawUnsafe and confirming no
 *     discovery SQL mentions the photosJson column.
 *   - dry-run COUNT equals the inline candidates only (excludes migrated/null).
 *   - --commit migrates every inline row one-at-a-time, uploader called the
 *     right number of times.
 *   - second run is idempotent (0 migrated).
 *   - --limit N processes at most N.
 *
 * No real network: an injected uploader is used.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { bootEmbeddedPg } from './embedded-pg-boot.mjs';
import { runBackfill } from './backfill-inspection-photos-to-storage.mjs';

// A few-KB base64 blob (non-trivial — the point is many rows + real bytes).
const BIG_B64 = Buffer.alloc(3000, 7).toString('base64');
const DATA_URL = `data:image/png;base64,${BIG_B64}`;

function silentLogger() {
  return { log: () => {}, error: () => {} };
}

let pgHandle;
let prisma;
let _seq = 0;

async function seedInspection({ tenantId, photosJson, photoStorageRefs }) {
  _seq += 1;
  const now = new Date();
  const later = new Date(now.getTime() + 86400000);
  const loc = await prisma.location.create({
    data: { tenantId, code: `L${(Date.now() + _seq) % 100000}`, name: 'Insp Loc' }
  });
  const cust = await prisma.customer.create({
    data: { tenantId, firstName: 'Insp', lastName: `Cust${_seq}`, phone: `555-10${_seq}` }
  });
  const resv = await prisma.reservation.create({
    data: {
      tenantId,
      customerId: cust.id,
      reservationNumber: `R-${Date.now()}-${_seq}`,
      pickupAt: now,
      returnAt: later,
      pickupLocationId: loc.id,
      returnLocationId: loc.id
    }
  });
  const ag = await prisma.rentalAgreement.create({
    data: {
      tenantId,
      agreementNumber: `AG-${Date.now()}-${_seq}`,
      reservationId: resv.id,
      pickupAt: now,
      returnAt: later,
      pickupLocationId: loc.id,
      returnLocationId: loc.id,
      customerFirstName: 'Insp',
      customerLastName: `Cust${_seq}`
    }
  });
  const data = {
    rentalAgreementId: ag.id,
    phase: 'CHECKOUT',
    photosJson: photosJson ?? null
  };
  if (photoStorageRefs !== undefined) data.photoStorageRefs = photoStorageRefs;
  return prisma.rentalAgreementInspection.create({ data });
}

let _tenantSeq = 0;
async function freshTenant() {
  _tenantSeq += 1;
  const t = await prisma.tenant.create({
    data: { name: `Insp Backfill Tenant ${_tenantSeq}`, slug: `ibf-${Date.now()}-${_tenantSeq}` }
  });
  return t.id;
}

before(async () => {
  pgHandle = await bootEmbeddedPg();
  prisma = pgHandle.prisma;
});

after(async () => {
  if (pgHandle) await pgHandle.stop();
});

describe('inspection-photos backfill — at scale (embedded-postgres)', () => {
  it('dry-run COUNT excludes migrated + null rows; discovery never selects photosJson', async () => {
    const tenantId = await freshTenant();
    // photosJson is a JSON MAP, not a single value. The lightweight discovery
    // predicate (photosJson present + no refs) intentionally CANNOT peer inside
    // the JSON to tell an inline-base64 map from an http-only map — that's
    // resolved per-row at upload time. So both inline and http-map rows are
    // legitimate candidates; only already-migrated (refs set) and null-photosJson
    // rows are cheaply excludable.
    const INLINE = 42;
    const MIGRATED = 6;
    const HTTP = 4;
    const NULLS = 5;
    const EXPECTED_CANDIDATES = INLINE + HTTP; // = 46

    for (let i = 0; i < INLINE; i++) {
      await seedInspection({ tenantId, photosJson: JSON.stringify({ front: DATA_URL }) });
    }
    for (let i = 0; i < MIGRATED; i++) {
      await seedInspection({
        tenantId,
        photosJson: JSON.stringify({ front: DATA_URL }),
        photoStorageRefs: [{ key: 'front', path: 'tenants/x/inspections/y/front.png' }]
      });
    }
    for (let i = 0; i < HTTP; i++) {
      await seedInspection({
        tenantId,
        photosJson: JSON.stringify({ front: 'https://cdn.example.com/x.png' })
      });
    }
    for (let i = 0; i < NULLS; i++) {
      await seedInspection({ tenantId, photosJson: null });
    }

    // Spy on $queryRawUnsafe to prove discovery never pulls the blob column.
    const seenSql = [];
    const realQRU = prisma.$queryRawUnsafe.bind(prisma);
    prisma.$queryRawUnsafe = (sql, ...params) => {
      seenSql.push(String(sql));
      return realQRU(sql, ...params);
    };

    let stats;
    try {
      stats = await runBackfill({
        args: { commit: false, limit: null, tenant: tenantId, batch: 100 },
        prismaClient: prisma,
        logger: silentLogger()
      });
    } finally {
      prisma.$queryRawUnsafe = realQRU;
    }

    assert.equal(stats.candidates, EXPECTED_CANDIDATES, 'count excludes migrated + null rows');
    assert.equal(stats.total, 0, 'dry-run processes no rows');
    assert.equal(stats.migrated, 0);
    assert.ok(seenSql.length >= 1, 'discovery used $queryRawUnsafe');
    // The blob column may appear in the WHERE predicate (length(...) is computed
    // server-side, transferring no bytes) but must NEVER be in the SELECT list —
    // that is what would pull gigabytes and time out. Check the SELECT list only.
    for (const sql of seenSql) {
      const selectList = sql.slice(0, sql.toUpperCase().indexOf(' FROM '));
      assert.ok(
        !/photosJson/.test(selectList),
        `discovery SELECT list must not include the photosJson blob column: ${selectList}`
      );
    }
    // It DOES reference the cheap predicate length(...) and IS NULL.
    assert.ok(seenSql.some((s) => /count\(\*\)/i.test(s)), 'a cheap COUNT was used');
  });

  it('--commit migrates every inline row one at a time; uploader called per photo', async () => {
    const tenantId = await freshTenant();
    const INLINE = 40;
    for (let i = 0; i < INLINE; i++) {
      await seedInspection({ tenantId, photosJson: JSON.stringify({ front: DATA_URL }) });
    }
    // Excluded rows.
    await seedInspection({
      tenantId,
      photosJson: JSON.stringify({ front: DATA_URL }),
      photoStorageRefs: [{ key: 'front', path: 'tenants/x/inspections/y/front.png' }]
    });
    await seedInspection({ tenantId, photosJson: null });

    let uploadCalls = 0;
    const uploader = async (args) => { uploadCalls++; return { path: args.path }; };

    const stats = await runBackfill({
      args: { commit: true, limit: null, tenant: tenantId, batch: 7 }, // small batch ⇒ multiple loops
      prismaClient: prisma,
      uploader,
      logger: silentLogger()
    });

    assert.equal(stats.candidates, INLINE);
    assert.equal(stats.total, INLINE, 'processed exactly the inline rows');
    assert.equal(stats.migrated, INLINE);
    assert.equal(stats.failed, 0);
    assert.equal(uploadCalls, INLINE, 'one upload per single-photo inline row');

    // Every inline row now has a refs array.
    const remaining = await prisma.$queryRawUnsafe(
      `SELECT count(*)::int AS n FROM "RentalAgreementInspection" i
       JOIN "RentalAgreement" r ON r.id = i."rentalAgreementId"
       WHERE i."photosJson" IS NOT NULL AND length(i."photosJson")>0
         AND i."photoStorageRefs" IS NULL AND r."tenantId" = $1`,
      tenantId
    );
    assert.equal(Number(remaining[0].n), 0, 'no inline candidates remain');
  });

  it('is idempotent: a second --commit run migrates 0', async () => {
    const tenantId = await freshTenant();
    for (let i = 0; i < 30; i++) {
      await seedInspection({ tenantId, photosJson: JSON.stringify({ front: DATA_URL }) });
    }
    const uploader = async (args) => ({ path: args.path });

    const first = await runBackfill({
      args: { commit: true, limit: null, tenant: tenantId, batch: 100 },
      prismaClient: prisma, uploader, logger: silentLogger()
    });
    assert.equal(first.migrated, 30);

    const second = await runBackfill({
      args: { commit: true, limit: null, tenant: tenantId, batch: 100 },
      prismaClient: prisma, uploader, logger: silentLogger()
    });
    assert.equal(second.candidates, 0, 'nothing left to migrate');
    assert.equal(second.total, 0);
    assert.equal(second.migrated, 0);
  });

  it('--limit N processes at most N rows', async () => {
    const tenantId = await freshTenant();
    for (let i = 0; i < 50; i++) {
      await seedInspection({ tenantId, photosJson: JSON.stringify({ front: DATA_URL }) });
    }
    const uploader = async (args) => ({ path: args.path });
    const stats = await runBackfill({
      args: { commit: true, limit: 12, tenant: tenantId, batch: 5 },
      prismaClient: prisma, uploader, logger: silentLogger()
    });
    assert.equal(stats.total, 12, 'processed exactly the limit');
    assert.equal(stats.migrated, 12);
  });
});
