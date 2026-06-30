/**
 * customer-documents backfill — embedded-postgres integration test, AT SCALE.
 *
 * Boots a real throwaway Postgres + generated Prisma client and seeds MANY
 * customers (40+) plus rental agreements, each carrying non-trivial base64 doc
 * blobs across idPhotoUrl / licenseBackUrl / insuranceDocumentUrl, with a mix:
 *   - inline base64 / data-url        (MUST migrate → 'tenants/...')
 *   - already-migrated 'tenants/...'  (MUST skip)
 *   - http(s) passthrough             (MUST skip)
 *   - null                            (MUST skip)
 *
 * Proves the production-scale redesign:
 *   - DISCOVERY via $queryRawUnsafe selecting ONLY ids (never the blob columns).
 *     Asserted by spying on $queryRawUnsafe and confirming no discovery SQL
 *     selects idPhotoUrl/licenseBackUrl/insuranceDocumentUrl into the result.
 *   - dry-run COUNT equals inline candidates only (excludes migrated/http/null).
 *   - --commit: every inline field → 'tenants/...'; uploader called the right
 *     number of times; read-back verify ran (downloader invoked per upload).
 *   - a forced read-back mismatch leaves that field inline (verifyFailed++).
 *   - second run idempotent (0 migrated).
 *   - --limit N processes at most N rows.
 *
 * No real network: injected uploader + downloader.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { bootEmbeddedPg } from './embedded-pg-boot.mjs';
import { runBackfill } from './backfill-customer-documents-to-storage.mjs';

// A few-KB base64 blob. We track the decoded byte length so the injected
// downloader can return a matching size for the read-back verification.
const RAW_BYTES = Buffer.alloc(2500, 9);
const B64 = RAW_BYTES.toString('base64');
const DATA_URL = `data:image/png;base64,${B64}`;
const DECODED_LEN = RAW_BYTES.byteLength;

function silentLogger() {
  return { log: () => {}, error: () => {} };
}

// Default uploader: returns whatever path uploadCustomerDocument computed.
// (uploadCustomerDocument builds the path and calls our uploader with it.)
function makeUploader() {
  const calls = [];
  const uploader = async (args) => { calls.push(args); return { path: args.path }; };
  return { uploader, calls };
}

// Default downloader: returns a body whose byteLength matches the source so the
// read-back verification passes. `mismatchFor` optionally forces a byte
// mismatch when the path matches a predicate (to exercise verifyFailed).
function makeDownloader({ mismatchFor } = {}) {
  const calls = [];
  const downloader = async ({ bucket, path }) => {
    calls.push({ bucket, path });
    if (mismatchFor && mismatchFor(path)) {
      return { body: Buffer.alloc(DECODED_LEN + 1) }; // wrong size → verify fail
    }
    return { body: Buffer.alloc(DECODED_LEN) };
  };
  return { downloader, calls };
}

let pgHandle;
let prisma;
let _seq = 0;

async function seedCustomer({ tenantId, idPhotoUrl, licenseBackUrl, insuranceDocumentUrl }) {
  _seq += 1;
  return prisma.customer.create({
    data: {
      tenantId,
      firstName: 'Doc',
      lastName: `Cust${_seq}`,
      phone: `555-20${_seq}`,
      idPhotoUrl: idPhotoUrl ?? null,
      licenseBackUrl: licenseBackUrl ?? null,
      insuranceDocumentUrl: insuranceDocumentUrl ?? null
    }
  });
}

async function seedAgreement({ tenantId, insuranceDocumentUrl }) {
  _seq += 1;
  const now = new Date();
  const later = new Date(now.getTime() + 86400000);
  const loc = await prisma.location.create({
    data: { tenantId, code: `LD${(Date.now() + _seq) % 100000}`, name: 'Doc Loc' }
  });
  const cust = await prisma.customer.create({
    data: { tenantId, firstName: 'Doc', lastName: `AgCust${_seq}`, phone: `555-30${_seq}` }
  });
  const resv = await prisma.reservation.create({
    data: {
      tenantId,
      customerId: cust.id,
      reservationNumber: `RD-${Date.now()}-${_seq}`,
      pickupAt: now,
      returnAt: later,
      pickupLocationId: loc.id,
      returnLocationId: loc.id
    }
  });
  return prisma.rentalAgreement.create({
    data: {
      tenantId,
      agreementNumber: `AGD-${Date.now()}-${_seq}`,
      reservationId: resv.id,
      pickupAt: now,
      returnAt: later,
      pickupLocationId: loc.id,
      returnLocationId: loc.id,
      customerFirstName: 'Doc',
      customerLastName: `Cust${_seq}`,
      insuranceDocumentUrl: insuranceDocumentUrl ?? null
    }
  });
}

let _tenantSeq = 0;
async function freshTenant() {
  _tenantSeq += 1;
  const t = await prisma.tenant.create({
    data: { name: `Doc Backfill Tenant ${_tenantSeq}`, slug: `dbf-${Date.now()}-${_tenantSeq}` }
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

describe('customer-documents backfill — at scale (embedded-postgres)', () => {
  it('dry-run COUNT equals inline candidates; discovery never selects blob columns', async () => {
    const tenantId = await freshTenant();
    const INLINE_CUST = 42; // each with an inline idPhotoUrl
    const MIGRATED = 5;
    const HTTP = 4;
    const NULLS = 6;
    const INLINE_AG = 8;

    for (let i = 0; i < INLINE_CUST; i++) {
      await seedCustomer({ tenantId, idPhotoUrl: DATA_URL });
    }
    for (let i = 0; i < MIGRATED; i++) {
      await seedCustomer({ tenantId, idPhotoUrl: 'tenants/x/customers/y/id-photo_z.png' });
    }
    for (let i = 0; i < HTTP; i++) {
      await seedCustomer({ tenantId, idPhotoUrl: 'https://cdn.example.com/id.png' });
    }
    for (let i = 0; i < NULLS; i++) {
      await seedCustomer({ tenantId, idPhotoUrl: null });
    }
    for (let i = 0; i < INLINE_AG; i++) {
      await seedAgreement({ tenantId, insuranceDocumentUrl: DATA_URL });
    }

    const seenSql = [];
    const realQRU = prisma.$queryRawUnsafe.bind(prisma);
    prisma.$queryRawUnsafe = (sql, ...params) => {
      seenSql.push(String(sql));
      return realQRU(sql, ...params);
    };

    const { uploader } = makeUploader();
    const { downloader } = makeDownloader();
    let stats;
    try {
      stats = await runBackfill({
        args: { commit: false, limit: null, tenant: tenantId, batch: 100 },
        prismaClient: prisma, uploader, downloader, logger: silentLogger()
      });
    } finally {
      prisma.$queryRawUnsafe = realQRU;
    }

    assert.equal(stats.customerCandidates, INLINE_CUST, 'customer count = inline only');
    assert.equal(stats.agreementCandidates, INLINE_AG, 'agreement count = inline only');
    assert.equal(stats.scanned, 0, 'dry-run processes no rows');
    assert.equal(stats.fieldsMigrated, 0);

    // No discovery/count SQL should pull the heavy blob columns into the result
    // set. The id-only SELECTs reference column NAMES only inside the predicate
    // (length(...), left(...)) — never as selected output. We assert the SELECT
    // list never names a blob column.
    const blobCols = ['idPhotoUrl', 'licenseBackUrl', 'insuranceDocumentUrl'];
    for (const sql of seenSql) {
      const selectList = sql.slice(0, sql.toUpperCase().indexOf(' FROM '));
      for (const col of blobCols) {
        assert.ok(
          !selectList.includes(col),
          `discovery SELECT list must not include blob column ${col}: ${selectList}`
        );
      }
    }
    assert.ok(seenSql.some((s) => /count\(\*\)/i.test(s)), 'a cheap COUNT was used');
  });

  it('--commit migrates every inline field to a tenants/ path; uploader+read-back ran', async () => {
    const tenantId = await freshTenant();
    const N = 40;
    // Each customer has TWO inline fields → 80 fields total.
    for (let i = 0; i < N; i++) {
      await seedCustomer({ tenantId, idPhotoUrl: DATA_URL, insuranceDocumentUrl: DATA_URL });
    }
    // Excluded rows.
    await seedCustomer({ tenantId, idPhotoUrl: 'https://cdn.example.com/id.png' });
    await seedCustomer({ tenantId, idPhotoUrl: 'tenants/x/customers/y/id.png' });
    await seedCustomer({ tenantId });

    const { uploader, calls: upCalls } = makeUploader();
    const { downloader, calls: dlCalls } = makeDownloader();

    const stats = await runBackfill({
      args: { commit: true, limit: null, tenant: tenantId, batch: 9 }, // small ⇒ multi-batch
      prismaClient: prisma, uploader, downloader, logger: silentLogger()
    });

    assert.equal(stats.customerCandidates, N);
    assert.equal(stats.scanned, N, 'scanned exactly the inline customers');
    assert.equal(stats.fieldsMigrated, N * 2, 'two fields per customer migrated');
    assert.equal(stats.verifyFailed, 0);
    assert.equal(upCalls.length, N * 2, 'uploader called once per inline field');
    assert.equal(dlCalls.length, N * 2, 'read-back downloader called once per upload');

    // Every freshly-migrated field is now a tenants/ path. (The pre-seeded
    // already-migrated row also starts with tenants/, so we assert via the
    // residual count below rather than a raw count of tenants/ rows.) Confirm
    // each migrated customer has BOTH fields converted.
    const withBoth = await prisma.customer.findMany({
      where: {
        tenantId,
        idPhotoUrl: { startsWith: 'tenants/' },
        insuranceDocumentUrl: { startsWith: 'tenants/' }
      },
      select: { id: true },
      take: 1000
    });
    assert.equal(withBoth.length, N, 'all N inline customers have both fields as tenants/ paths');

    // Lightweight residual check: no inline candidates remain.
    const remaining = await prisma.$queryRawUnsafe(
      `SELECT count(*)::int AS n FROM "Customer"
       WHERE "tenantId" = $1 AND (
         ("idPhotoUrl" IS NOT NULL AND length("idPhotoUrl")>0 AND left("idPhotoUrl",8) <> 'tenants/' AND left("idPhotoUrl",5) <> 'http:' AND left("idPhotoUrl",6) <> 'https:')
         OR ("insuranceDocumentUrl" IS NOT NULL AND length("insuranceDocumentUrl")>0 AND left("insuranceDocumentUrl",8) <> 'tenants/' AND left("insuranceDocumentUrl",5) <> 'http:' AND left("insuranceDocumentUrl",6) <> 'https:')
       )`,
      tenantId
    );
    assert.equal(Number(remaining[0].n), 0, 'no inline candidates remain');
  });

  it('forced read-back mismatch leaves the field inline and counts verifyFailed', async () => {
    const tenantId = await freshTenant();
    const cust = await seedCustomer({ tenantId, idPhotoUrl: DATA_URL });

    const { uploader } = makeUploader();
    // Force a mismatch for every id-photo path.
    const { downloader } = makeDownloader({ mismatchFor: (p) => p.includes('id-photo') });

    const stats = await runBackfill({
      args: { commit: true, limit: null, tenant: tenantId, batch: 100 },
      prismaClient: prisma, uploader, downloader, logger: silentLogger()
    });

    assert.equal(stats.fieldsMigrated, 0, 'mismatch ⇒ not migrated');
    assert.equal(stats.verifyFailed, 1, 'mismatch counted as verifyFailed');

    const after = await prisma.customer.findUnique({ where: { id: cust.id } });
    assert.equal(after.idPhotoUrl, DATA_URL, 'field left inline (never lose the doc)');
  });

  it('is idempotent: second --commit run migrates 0', async () => {
    const tenantId = await freshTenant();
    for (let i = 0; i < 25; i++) {
      await seedCustomer({ tenantId, idPhotoUrl: DATA_URL });
    }
    const { uploader } = makeUploader();
    const { downloader } = makeDownloader();

    const first = await runBackfill({
      args: { commit: true, limit: null, tenant: tenantId, batch: 100 },
      prismaClient: prisma, uploader, downloader, logger: silentLogger()
    });
    assert.equal(first.fieldsMigrated, 25);

    const second = await runBackfill({
      args: { commit: true, limit: null, tenant: tenantId, batch: 100 },
      prismaClient: prisma, uploader, downloader, logger: silentLogger()
    });
    assert.equal(second.customerCandidates, 0);
    assert.equal(second.scanned, 0);
    assert.equal(second.fieldsMigrated, 0);
  });

  it('--limit N processes at most N rows', async () => {
    const tenantId = await freshTenant();
    for (let i = 0; i < 50; i++) {
      await seedCustomer({ tenantId, idPhotoUrl: DATA_URL });
    }
    const { uploader } = makeUploader();
    const { downloader } = makeDownloader();
    const stats = await runBackfill({
      args: { commit: true, limit: 10, tenant: tenantId, batch: 4 },
      prismaClient: prisma, uploader, downloader, logger: silentLogger()
    });
    assert.equal(stats.scanned, 10, 'processed at most the limit');
    assert.equal(stats.fieldsMigrated, 10);
  });
});
