/**
 * clear-migrated-photos-json — embedded-postgres test (HARDENED guard).
 *
 * Proves:
 *   - a row whose photoStorageRefs all look real (size >= 100) IS cleared,
 *   - a row carrying a SUSPICIOUS ref (size < 100, the 9-byte garbage case) is
 *     NEVER cleared — its photosJson is left intact (skippedSuspicious),
 *   - a malformed ref (missing size) is also treated as suspicious,
 *   - an external-URL ref (no size) is fine and the row clears,
 *   - a row whose first ref's LIVE download is missing/tiny is NEVER cleared
 *     (even when the recorded ref.size looks real).
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { bootEmbeddedPg } from './embedded-pg-boot.mjs';
import { runCleanup } from './clear-migrated-photos-json.mjs';

function silentLogger() {
  return { log: () => {}, error: () => {}, warn: () => {} };
}

// In-memory Storage for the live read-back guard. Seed real objects by path so
// the good/external rows verify; leave a path unseeded (or tiny) to simulate a
// missing/corrupt object that must BLOCK clearing.
function makeDownloader() {
  const store = new Map(); // path -> byte length
  return {
    seed(path, len) { store.set(path, len); },
    downloader: async ({ path }) => {
      const len = store.get(path);
      if (len == null) throw new Error(`not found: ${path}`);
      return { body: Buffer.alloc(len), size: len };
    }
  };
}

let pgHandle;
let prisma;
let _seq = 0;

async function seedInspection({ tenantId, photosJson, photoStorageRefs }) {
  _seq += 1;
  const now = new Date();
  const later = new Date(now.getTime() + 86400000);
  const loc = await prisma.location.create({
    data: { tenantId, code: `CL${(Date.now() + _seq) % 100000}`, name: 'Clear Loc' }
  });
  const cust = await prisma.customer.create({
    data: { tenantId, firstName: 'Clr', lastName: `Cust${_seq}`, phone: `555-20${_seq}` }
  });
  const resv = await prisma.reservation.create({
    data: {
      tenantId, customerId: cust.id, reservationNumber: `CR-${Date.now()}-${_seq}`,
      pickupAt: now, returnAt: later, pickupLocationId: loc.id, returnLocationId: loc.id
    }
  });
  const ag = await prisma.rentalAgreement.create({
    data: {
      tenantId, agreementNumber: `CAG-${Date.now()}-${_seq}`, reservationId: resv.id,
      pickupAt: now, returnAt: later, pickupLocationId: loc.id, returnLocationId: loc.id,
      customerFirstName: 'Clr', customerLastName: `Cust${_seq}`
    }
  });
  const data = { rentalAgreementId: ag.id, phase: 'CHECKOUT', photosJson: photosJson ?? null };
  if (photoStorageRefs !== undefined) data.photoStorageRefs = photoStorageRefs;
  return prisma.rentalAgreementInspection.create({ data });
}

let _tenantSeq = 0;
async function freshTenant() {
  _tenantSeq += 1;
  const t = await prisma.tenant.create({
    data: { name: `Clear Tenant ${_tenantSeq}`, slug: `clr-${Date.now()}-${_tenantSeq}` }
  });
  return t.id;
}

before(async () => { pgHandle = await bootEmbeddedPg(); prisma = pgHandle.prisma; });
after(async () => { if (pgHandle) await pgHandle.stop(); });

describe('clear-migrated-photos-json — suspicious-ref guard (embedded)', () => {
  it('clears a row with real refs but NEVER a row with a <100-byte ref', async () => {
    const tenantId = await freshTenant();
    const good = await seedInspection({
      tenantId,
      photosJson: JSON.stringify({ front: 'data:image/png;base64,AAAA' }),
      photoStorageRefs: [{ key: 'front', path: 'tenants/t/inspections/i/front.png', size: 50000 }]
    });
    const suspicious = await seedInspection({
      tenantId,
      photosJson: JSON.stringify({ front: 'data:image/png;base64,REAL_ORIGINAL' }),
      photoStorageRefs: [{ key: 'front', path: 'tenants/t/inspections/i/front.png', size: 9 }]
    });
    const malformed = await seedInspection({
      tenantId,
      photosJson: JSON.stringify({ front: 'data:image/png;base64,REAL2' }),
      photoStorageRefs: [{ key: 'front', path: 'tenants/t/inspections/i/front.png' }] // no size
    });
    const external = await seedInspection({
      tenantId,
      photosJson: JSON.stringify({ front: 'https://cdn/x.png' }),
      photoStorageRefs: [{ key: 'front', external: true, url: 'https://cdn/x.png' }] // size N/A, OK
    });

    const dl = makeDownloader();
    // Seed the good row's referenced object with a plausible byte length that
    // matches its recorded size, so the live read-back passes.
    dl.seed('tenants/t/inspections/i/front.png', 50000);
    const stats = await runCleanup({
      args: { commit: true, limit: null, tenant: tenantId },
      prismaClient: prisma, downloader: dl.downloader, logger: silentLogger()
    });

    assert.equal(stats.cleared, 2, 'good + external rows cleared');
    assert.equal(stats.skippedSuspicious, 2, 'suspicious + malformed rows skipped');

    const g = await prisma.rentalAgreementInspection.findUnique({ where: { id: good.id }, select: { photosJson: true } });
    assert.equal(g.photosJson, null, 'good row cleared');

    const sus = await prisma.rentalAgreementInspection.findUnique({ where: { id: suspicious.id }, select: { photosJson: true } });
    assert.ok(sus.photosJson, 'SUSPICIOUS row photosJson INTACT — never destroyed the original');

    const mal = await prisma.rentalAgreementInspection.findUnique({ where: { id: malformed.id }, select: { photosJson: true } });
    assert.ok(mal.photosJson, 'malformed-ref row photosJson INTACT');

    const ext = await prisma.rentalAgreementInspection.findUnique({ where: { id: external.id }, select: { photosJson: true } });
    assert.equal(ext.photosJson, null, 'external-URL ref row cleared (size N/A is fine)');
  });
  it('NEVER clears a row whose first ref\'s live download is missing/tiny', async () => {
    const tenantId = await freshTenant();
    // recorded size looks perfectly real (>= 100) — but the live object is gone.
    const missing = await seedInspection({
      tenantId,
      photosJson: JSON.stringify({ front: 'data:image/png;base64,STILL_THE_ONLY_COPY' }),
      photoStorageRefs: [{ key: 'front', path: 'tenants/t/inspections/gone/front.png', size: 42000 }]
    });
    // recorded size looks real, but the live object is a 9-byte turd.
    const tiny = await seedInspection({
      tenantId,
      photosJson: JSON.stringify({ front: 'data:image/png;base64,ALSO_ONLY_COPY' }),
      photoStorageRefs: [{ key: 'front', path: 'tenants/t/inspections/tiny/front.png', size: 42000 }]
    });
    // a genuinely good row (live object present + big) to prove clearing still works.
    const good = await seedInspection({
      tenantId,
      photosJson: JSON.stringify({ front: 'data:image/png;base64,MIGRATED_OK' }),
      photoStorageRefs: [{ key: 'front', path: 'tenants/t/inspections/ok/front.png', size: 30000 }]
    });

    const dl = makeDownloader();
    // 'gone' path deliberately NOT seeded -> download throws (missing).
    dl.seed('tenants/t/inspections/tiny/front.png', 9);   // tiny -> blocked
    dl.seed('tenants/t/inspections/ok/front.png', 30000); // good -> clears

    const stats = await runCleanup({
      args: { commit: true, limit: null, tenant: tenantId },
      prismaClient: prisma, downloader: dl.downloader, logger: silentLogger()
    });

    assert.equal(stats.cleared, 1, 'only the row with a real live object cleared');
    assert.equal(stats.skippedSuspicious, 2, 'missing + tiny live objects blocked the clear');

    const m = await prisma.rentalAgreementInspection.findUnique({ where: { id: missing.id }, select: { photosJson: true } });
    assert.ok(m.photosJson, 'missing-live-object row photosJson INTACT — original not destroyed');

    const t = await prisma.rentalAgreementInspection.findUnique({ where: { id: tiny.id }, select: { photosJson: true } });
    assert.ok(t.photosJson, 'tiny-live-object row photosJson INTACT — original not destroyed');

    const g = await prisma.rentalAgreementInspection.findUnique({ where: { id: good.id }, select: { photosJson: true } });
    assert.equal(g.photosJson, null, 'good row cleared after live read-back passed');
  });
});
