/**
 * Flexways worker — DB-backed handler guard (requires DATABASE_URL).
 *
 * THE INVARIANT this locks (Innovation/QA 2026-07-13, the batch's central risk):
 * the sync handler must SKIP the per-reservation detail fetch (N × ~1MB
 * modificarReserva.php) for already AUTO_PROMOTED/PROMOTED rows — the skip is
 * ordered BEFORE `fetchReservationDetail`. A future refactor moving the skip
 * below the fetch would re-hammer the portal every 15 min and raise the
 * reCAPTCHA-v3 bot-score risk. This test drives flexwaysSyncHandler against a
 * seeded promoted row with a stubbed HTTP layer and asserts the detail endpoint
 * (modificarReserva.php) is NEVER hit.
 *
 * Run: npm run test:flexways   (DATABASE_URL must point at a dev/test postgres)
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { PrismaClient } from '@prisma/client';

process.env.INTEGRATION_ENC_KEY = crypto.randomBytes(32).toString('base64');
process.env.FLEXWAYS_INTEGRATION_ENABLED = 'true'; // let the handler run in-test

const svc = await import('./flexways.service.js');
const { flexwaysSyncHandler } = await import('./flexways.worker.js');
const { CONTRACT_LIST_PATH, CONTRACT_LIST_PAGE_PATH, DETAIL_PATH } = await import('./flexways.constants.js');

const prisma = new PrismaClient();
const TAG = `FWW-${Date.now()}`;
// Unique per-run ref so a leftover row from a prior run can't (a) collide on the
// (sourceSystem, externalRef) unique, nor (b) get skipped via the CROSS-TENANT
// guard instead of the promoted-skip we're actually testing.
const REF = `QJDK07-${TAG}`;
const ids = { tenant: null, location: null, config: null, ext: null, run: [] };

test.after(async () => {
  await prisma.externalSyncRun.deleteMany({ where: { tenantId: ids.tenant } }).catch(() => {});
  if (ids.ext) await prisma.externalReservation.delete({ where: { id: ids.ext } }).catch(() => {});
  if (ids.config) await prisma.flexwaysLocationConfig.delete({ where: { id: ids.config } }).catch(() => {});
  if (ids.location) await prisma.location.delete({ where: { id: ids.location } }).catch(() => {});
  if (ids.tenant) await prisma.tenant.delete({ where: { id: ids.tenant } }).catch(() => {});
  svc.__test.setFetch(null);
  svc.__test.setBrowserLogin(null);
  svc.__test.setCredentialsResolver(null);
  svc._resetCookieJarsForTests();
  await prisma.$disconnect();
});

// A contract-list payload whose single API row (ref QJDK07) is the one we
// pre-seed as AUTO_PROMOTED — so the handler must NOT fetch its detail.
function contractPayload() {
  return {
    draw: 1, recordsTotal: 1, recordsFiltered: 1,
    data: [{
      0: '485160', 1: 'AR', 2: 'Flexways Orlando - Vista East',
      3: '19/07/2026 15:00:00', 4: '21/07/2026 10:00:00',
      5: 'Aeropuerto Internacional de Orlando', 6: 'Aeropuerto Internacional de Orlando',
      7: 'API', 8: 'Alfredo Reyes', 9: '', 10: REF,
      // idAlquiler is delivered inside the actions HTML (parser anchors from the end)
      11: '<div class="list-icons"><input type="hidden" name="idAlquiler" value="485160"><a href="#">Modificar</a></div>',
    }],
  };
}

function stubResponse(body, status = 200) {
  return { status, ok: status >= 200 && status < 300, headers: { get: () => null }, text: async () => body };
}

test('setup: seed tenant + enabled sede config + an AUTO_PROMOTED Flexways reservation', async () => {
  const t = await prisma.tenant.create({ data: { name: `T ${TAG}`, slug: `t-${TAG}`.toLowerCase() } });
  ids.tenant = t.id;
  const loc = await prisma.location.create({ data: { code: `L-${TAG}`.slice(0, 12), name: 'Orlando', tenantId: t.id } });
  ids.location = loc.id;
  const cfg = await prisma.flexwaysLocationConfig.create({
    data: { tenantId: t.id, idSede: '383', locationId: loc.id, enabled: true, lookbackDays: 30, lookaheadDays: 3650 },
  });
  ids.config = cfg.id;
  // The row that is ALREADY promoted — its detail must be skipped.
  const ext = await prisma.externalReservation.create({
    data: {
      tenantId: t.id, sourceSystem: 'FLEXWAYS', externalRef: REF,
      status: 'CONFIRMED', promotionStatus: 'AUTO_PROMOTED',
      pickupAt: new Date('2026-07-19T19:00:00Z'), rawJson: {},
    },
  });
  ids.ext = ext.id;
  assert.ok(ids.tenant && ids.config && ids.ext);
});

test('handler SKIPS the detail fetch for an already-promoted row (no modificarReserva.php hit)', async () => {
  const hits = { page: 0, pageBeforeContract: false, contract: 0, detail: 0, detailUrls: [] };

  // Stub auth so ensureSession succeeds without a real encrypted credential row.
  svc.__test.setCredentialsResolver(() => ({ username: 'u', password: 'p' }));
  svc.__test.setBrowserLogin(async () => 'FWSESSION=stub');

  // Stub the HTTP layer: serve the contract list, and RECORD any detail hit.
  svc.__test.setFetch(async (url) => {
    const u = String(url);
    // The list PAGE must be primed BEFORE the AJAX (sets the session filter).
    if (u.includes(CONTRACT_LIST_PAGE_PATH)) { hits.page += 1; return stubResponse('<html>ok</html>'); }
    if (u.includes(CONTRACT_LIST_PATH)) {
      if (hits.page > 0) hits.pageBeforeContract = true;
      hits.contract += 1;
      return stubResponse(JSON.stringify(contractPayload()));
    }
    if (u.includes(DETAIL_PATH)) { hits.detail += 1; hits.detailUrls.push(u); return stubResponse('<html></html>'); }
    return stubResponse('', 200);
  });

  await flexwaysSyncHandler({ data: { tenantId: ids.tenant, triggeredBy: 'test' } });

  assert.ok(hits.contract >= 1, 'contract list should have been fetched');
  assert.ok(hits.page >= 1, 'the list page must be primed before the AJAX (session filter state)');
  assert.ok(hits.pageBeforeContract, 'the page prime must happen BEFORE the contract AJAX');
  assert.equal(hits.detail, 0, `detail fetch must be SKIPPED for the promoted row (got ${hits.detail}: ${hits.detailUrls.join(', ')})`);
});
