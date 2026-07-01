/**
 * Backfill integration tests on embedded-postgres.
 *
 * Boots a throwaway Postgres, seeds Customers/RentalAgreements with inline
 * base64 in the doc columns, then runs the backfill with injected uploader +
 * downloader (no real Supabase). Asserts:
 *   - --commit migrates each inline field to a Storage path
 *   - the uploader was called once per field, read-back verify ran
 *   - a second run is idempotent (0 migrated)
 *   - a field whose read-back byte length mismatches is NOT overwritten and is
 *     counted in verifyFailed
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { bootEmbeddedPg } from './embedded-pg-boot.mjs';
import { runBackfill } from './backfill-customer-documents-to-storage.mjs';

const PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
const PNG_BUF = Buffer.from(PNG_B64, 'base64');
const PNG_DATA_URL = `data:image/png;base64,${PNG_B64}`;

function silentLogger() {
  return { log: () => {}, error: () => {} };
}

// In-memory Storage that records uploads and can be told to corrupt a path so
// the read-back byte length mismatches.
function makeStorageStub() {
  const store = new Map(); // path -> Buffer
  const uploadCalls = [];
  const downloadCalls = [];
  const corruptPaths = new Set();
  return {
    uploadCalls,
    downloadCalls,
    store,
    corrupt(pathSubstring) { corruptPaths.add(pathSubstring); },
    uploader: async ({ bucket, path, body }) => {
      uploadCalls.push({ bucket, path, size: body?.byteLength });
      store.set(path, Buffer.from(body));
      return { path };
    },
    downloader: async ({ path }) => {
      downloadCalls.push({ path });
      let buf = store.get(path);
      // Simulate a corrupted round-trip for flagged paths: return a shorter buf.
      for (const sub of corruptPaths) {
        if (path.includes(sub)) {
          buf = Buffer.from((buf || Buffer.alloc(0)).slice(0, Math.max(0, (buf?.byteLength || 1) - 1)));
          break;
        }
      }
      if (buf == null) throw new Error(`not found: ${path}`);
      return { body: buf, contentType: 'application/octet-stream', size: buf.byteLength };
    }
  };
}

let pgHandle;
let prisma;
let _tenantSeq = 0;

async function freshTenant() {
  _tenantSeq += 1;
  const t = await prisma.tenant.create({
    data: { name: `Backfill Test Tenant ${_tenantSeq}`, slug: `bf-${Date.now()}-${_tenantSeq}` }
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

describe('customer-documents backfill (embedded-postgres)', () => {
  it('migrates all 3 inline doc fields → storage paths with read-back verify', async () => {
    const tenantId = await freshTenant();
    const cust = await prisma.customer.create({
      data: {
        tenantId,
        firstName: 'Inline',
        lastName: 'Docs',
        phone: '555-0001',
        idPhotoUrl: PNG_DATA_URL,
        insuranceDocumentUrl: PNG_DATA_URL
      }
    });
    // RentalAgreement requires a reservation + locations chain.
    const loc = await prisma.location.create({
      data: { tenantId, code: `L${Date.now() % 100000}`, name: 'Test Loc' }
    });
    const now = new Date();
    const later = new Date(now.getTime() + 86400000);
    const resv = await prisma.reservation.create({
      data: {
        tenantId,
        customerId: cust.id,
        reservationNumber: `R-${Date.now()}`,
        pickupAt: now,
        returnAt: later,
        pickupLocationId: loc.id,
        returnLocationId: loc.id
      }
    });
    const ag = await prisma.rentalAgreement.create({
      data: {
        tenantId,
        agreementNumber: `AG-${Date.now()}`,
        reservationId: resv.id,
        pickupAt: now,
        returnAt: later,
        pickupLocationId: loc.id,
        returnLocationId: loc.id,
        customerFirstName: 'Inline',
        customerLastName: 'Docs',
        insuranceDocumentUrl: PNG_DATA_URL
      }
    });

    const storage = makeStorageStub();
    const stats = await runBackfill({
      args: { commit: true, limit: null, tenant: tenantId },
      prismaClient: prisma,
      uploader: storage.uploader,
      downloader: storage.downloader,
      logger: silentLogger()
    });

    // 2 customer fields + 1 agreement field.
    assert.equal(stats.fieldsMigrated, 3, 'all three fields migrated');
    assert.equal(stats.verifyFailed, 0);
    assert.equal(stats.noTenant, 0);
    assert.equal(storage.uploadCalls.length, 3, 'uploader called once per field');
    assert.equal(storage.downloadCalls.length, 3, 'read-back ran once per field');

    const custAfter = await prisma.customer.findUnique({ where: { id: cust.id } });
    assert.match(custAfter.idPhotoUrl, /^tenants\/.*\/id-photo_.*\.png$/);
    assert.match(custAfter.insuranceDocumentUrl, /^tenants\/.*\/insurance_.*\.png$/);

    const agAfter = await prisma.rentalAgreement.findUnique({ where: { id: ag.id } });
    assert.match(agAfter.insuranceDocumentUrl, /^tenants\/.*\/insurance_.*\.png$/);

    // Uploaded bytes match source length.
    for (const call of storage.uploadCalls) {
      assert.equal(call.size, PNG_BUF.byteLength);
    }

    // ── Idempotency: a second run migrates nothing (fields are now paths). ──
    const storage2 = makeStorageStub();
    const stats2 = await runBackfill({
      args: { commit: true, limit: null, tenant: tenantId },
      prismaClient: prisma,
      uploader: storage2.uploader,
      downloader: storage2.downloader,
      logger: silentLogger()
    });
    assert.equal(stats2.fieldsMigrated, 0, 'idempotent: nothing migrated on re-run');
    assert.equal(storage2.uploadCalls.length, 0, 'no uploads on re-run');
  });

  it('leaves a field inline (and counts verifyFailed) when read-back mismatches', async () => {
    const tenantId = await freshTenant();
    const cust = await prisma.customer.create({
      data: {
        tenantId,
        firstName: 'Corrupt',
        lastName: 'RoundTrip',
        phone: '555-0002',
        idPhotoUrl: PNG_DATA_URL
      }
    });

    const storage = makeStorageStub();
    // Force the read-back for any id-photo path to be truncated → mismatch.
    storage.corrupt('id-photo_');

    const stats = await runBackfill({
      args: { commit: true, limit: null, tenant: tenantId },
      prismaClient: prisma,
      uploader: storage.uploader,
      downloader: storage.downloader,
      logger: silentLogger()
    });

    assert.equal(stats.verifyFailed, 1, 'one field failed verification');
    assert.equal(stats.fieldsMigrated, 0, 'nothing migrated for this customer');

    const after = await prisma.customer.findUnique({ where: { id: cust.id } });
    assert.equal(after.idPhotoUrl, PNG_DATA_URL, 'field left inline (NOT overwritten)');
  });

  it('dry-run (default) uploads nothing and writes nothing', async () => {
    const tenantId = await freshTenant();
    const cust = await prisma.customer.create({
      data: {
        tenantId,
        firstName: 'DryRun',
        lastName: 'Only',
        phone: '555-0003',
        idPhotoUrl: PNG_DATA_URL
      }
    });
    const storage = makeStorageStub();
    const stats = await runBackfill({
      args: { commit: false, limit: null, tenant: tenantId },
      prismaClient: prisma,
      uploader: storage.uploader,
      downloader: storage.downloader,
      logger: silentLogger()
    });
    assert.equal(storage.uploadCalls.length, 0, 'dry-run uploads nothing');
    const after = await prisma.customer.findUnique({ where: { id: cust.id } });
    assert.equal(after.idPhotoUrl, PNG_DATA_URL, 'unchanged on dry-run');
    // Dry-run is COUNT-only: it returns after the lightweight candidate count and
    // never per-row scans, so `fieldsSkipped` can never advance. Assert the REAL
    // intent instead — nothing migrated, and the cheap count found this row.
    assert.equal(stats.fieldsMigrated, 0, 'dry-run migrates nothing');
    assert.ok(stats.customerCandidates >= 1, 'dry-run counted at least one candidate row');
  });
});
