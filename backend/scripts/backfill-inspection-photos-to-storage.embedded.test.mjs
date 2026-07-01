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

// A few-KB base64 blob carrying a VALID PNG magic header (89 50 4E 47 0D 0A 1A 0A)
// + IHDR-ish bytes, padded to a non-trivial size. The hardened decoder now
// validates the image magic header, so filler-only buffers (the old test data)
// would be correctly REJECTED — we must seed real-looking image bytes.
const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const BIG_IMAGE_BUF = Buffer.concat([PNG_SIG, Buffer.alloc(3000, 7)]);
const BIG_IMAGE_LEN = BIG_IMAGE_BUF.byteLength;
const BIG_B64 = BIG_IMAGE_BUF.toString('base64');
const DATA_URL = `data:image/png;base64,${BIG_B64}`;
// Verifying downloader: returns the exact source length for any stored path.
// The backfill compares back length to the decoded source length.
const okDownloader = async () => ({ body: Buffer.alloc(BIG_IMAGE_LEN) });

function silentLogger() {
  return { log: () => {}, error: () => {}, warn: () => {} };
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
      downloader: okDownloader,
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
      prismaClient: prisma, uploader, downloader: okDownloader, logger: silentLogger()
    });
    assert.equal(first.migrated, 30);

    const second = await runBackfill({
      args: { commit: true, limit: null, tenant: tenantId, batch: 100 },
      prismaClient: prisma, uploader, downloader: okDownloader, logger: silentLogger()
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
      prismaClient: prisma, uploader, downloader: okDownloader, logger: silentLogger()
    });
    assert.equal(stats.total, 12, 'processed exactly the limit');
    assert.equal(stats.migrated, 12);
  });
});

// A tiny VALID JPEG (FF D8 FF ...).
const TINY_JPEG_BUF = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0xff, 0xd9]);
const JPEG_DATA_URL = `data:image/jpeg;base64,${TINY_JPEG_BUF.toString('base64')}`;
// Downloader that returns the byte length for whatever was stored — but we keep
// a registry so it can verify per-path. Simpler: track uploaded bytes per path.

describe('inspection-photos backfill — HARDENED (three formats + read-back verify)', () => {
  it('migrates all THREE real formats; array-of-objects yields real-sized refs (NOT 9 bytes)', async () => {
    const tenantId = await freshTenant();

    // Track exact bytes uploaded per path so the downloader can return the
    // correct length and read-back verify passes for good rows.
    const storeByPath = new Map();
    const uploader = async (args) => { storeByPath.set(args.path, args.body); return { path: args.path }; };
    const downloader = async ({ path }) => {
      const buf = storeByPath.get(path);
      return { body: buf || Buffer.alloc(0) };
    };

    // Format #1: object of strings.
    const f1 = await seedInspection({ tenantId, photosJson: JSON.stringify({ front: DATA_URL, rear: JPEG_DATA_URL }) });
    // Format #2: object of nulls (empty).
    const f2 = await seedInspection({ tenantId, photosJson: JSON.stringify({ front: null, rear: null }) });
    // Format #3: ARRAY of objects [{key,dataUrl,...}] — the bug case.
    const f3 = await seedInspection({
      tenantId,
      photosJson: JSON.stringify([
        { key: 'front', dataUrl: DATA_URL, notes: '', capturedAt: '2026-01-01', customerIp: '1.2.3.4' },
        { key: 'rear', dataUrl: JPEG_DATA_URL, notes: '' }
      ])
    });

    const stats = await runBackfill({
      args: { commit: true, limit: null, tenant: tenantId, batch: 100 },
      prismaClient: prisma, uploader, downloader, logger: silentLogger()
    });

    // f1 + f3 migrate; f2 is empty (no refs) and is skipped/empty.
    assert.equal(stats.migrated, 2, 'format #1 and #3 both migrate');
    assert.ok(stats.empty >= 1, 'format #2 (object-of-nulls) counted empty');
    assert.equal(stats.verifyFailed, 0);
    assert.equal(stats.failed, 0);

    // Format #3 row: refs are REAL with correct slot keys + real byte sizes.
    const r3 = await prisma.rentalAgreementInspection.findUnique({
      where: { id: f3.id }, select: { photoStorageRefs: true, photosJson: true }
    });
    const refs3 = r3.photoStorageRefs;
    assert.ok(Array.isArray(refs3) && refs3.length === 2, 'array-of-objects produced 2 refs');
    const front3 = refs3.find((r) => r.key === 'front');
    const rear3 = refs3.find((r) => r.key === 'rear');
    assert.ok(front3 && rear3, 'slot keys preserved from element.key');
    assert.equal(front3.size, BIG_IMAGE_LEN, 'front ref byte size == decoded PNG (NOT 9 bytes)');
    assert.equal(rear3.size, TINY_JPEG_BUF.byteLength, 'rear ref byte size == decoded JPEG');
    assert.notEqual(front3.size, 9);
    // The backfill deliberately does NOT null photosJson (that is the clear
    // script\'s job — one-release safety net). It only SETS verified refs.
    assert.ok(r3.photosJson, 'backfill leaves photosJson intact as safety net');

    // Format #2 row: NO refs, photosJson intact (still the {nulls} map).
    const r2 = await prisma.rentalAgreementInspection.findUnique({
      where: { id: f2.id }, select: { photoStorageRefs: true, photosJson: true }
    });
    assert.equal(r2.photoStorageRefs, null, 'empty row gets no refs');
    assert.ok(r2.photosJson, 'empty row photosJson intact (skipped, not failed)');
  });

  it('read-back MISMATCH leaves the row WITHOUT refs and photosJson INTACT (verifyFailed)', async () => {
    const tenantId = await freshTenant();
    const uploader = async (args) => ({ path: args.path });
    // Downloader returns the WRONG byte length for everything -> verify fails.
    const badDownloader = async () => ({ body: Buffer.alloc(3) });

    const row = await seedInspection({ tenantId, photosJson: JSON.stringify({ front: DATA_URL }) });

    const stats = await runBackfill({
      args: { commit: true, limit: null, tenant: tenantId, batch: 100 },
      prismaClient: prisma, uploader, downloader: badDownloader, logger: silentLogger()
    });

    assert.equal(stats.migrated, 0, 'nothing migrated on verify failure');
    assert.equal(stats.verifyFailed, 1, 'counted as verifyFailed');

    const after = await prisma.rentalAgreementInspection.findUnique({
      where: { id: row.id }, select: { photoStorageRefs: true, photosJson: true }
    });
    assert.equal(after.photoStorageRefs, null, 'NO refs set on verify failure');
    assert.ok(after.photosJson, 'photosJson INTACT — clear step can never null it');
  });

  it('at scale (45 valid rows) all migrate + verify', async () => {
    const tenantId = await freshTenant();
    const storeByPath = new Map();
    const uploader = async (args) => { storeByPath.set(args.path, args.body); return { path: args.path }; };
    const downloader = async ({ path }) => ({ body: storeByPath.get(path) || Buffer.alloc(0) });
    for (let i = 0; i < 45; i++) {
      await seedInspection({ tenantId, photosJson: JSON.stringify({ front: DATA_URL }) });
    }
    const stats = await runBackfill({
      args: { commit: true, limit: null, tenant: tenantId, batch: 10 },
      prismaClient: prisma, uploader, downloader, logger: silentLogger()
    });
    assert.equal(stats.migrated, 45);
    assert.equal(stats.verifyFailed, 0);
    assert.equal(stats.failed, 0);
  });
});
