/**
 * DB-backed tests for LOCATION scoping of citations (2026-07-23). Requires DATABASE_URL.
 *
 * WHY THIS EXISTS: a user restricted to one location (User.locationIds) was seeing
 * the whole tenant's citations — reported live: a LAX-scoped user saw 87 citations
 * that were all Orlando's. Citations have NO Location FK (`Citation.location` is
 * free text from the issuing agency), so the scope is resolved through the matched
 * vehicle: Citation.vehicleId → Vehicle.homeLocationId.
 *
 * CARES PROVEN HERE (each bites):
 *  1. a location-scoped caller sees ONLY its own location's citations — the actual bug.
 *  2. an unrestricted caller (tenant admin) still sees everything — no regression.
 *  3. the dashboard SUMMARY counts are scoped too, not just the list. The tile is
 *     where the wrong number was first noticed, and it is a separate query.
 *  4. an UNMATCHED citation (vehicleId = null, so no resolvable location) is hidden
 *     from a scoped caller (fail-closed) but still visible to a tenant admin, who is
 *     the one who triages it.
 *  5. getDetail is scoped, so a restricted caller cannot open another branch's
 *     citation by id even though the list hides it.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { PrismaClient } from '@prisma/client';
import { citationsService, citationLocationWhere } from './citations.service.js';

const prisma = new PrismaClient();
const TAG = `CITLOC-${Date.now()}`;
const ids = { tenant: null, locA: null, locB: null, vehA: null, vehB: null, vtype: null,
              citA: null, citB: null, citOrphan: null };

let scopedToA = null;   // caller restricted to location A
let unrestricted = null; // tenant admin — no location restriction

test.after(async () => {
  await prisma.citationDocument.deleteMany({ where: { tenantId: ids.tenant } }).catch(() => {});
  await prisma.citation.deleteMany({ where: { tenantId: ids.tenant } }).catch(() => {});
  await prisma.vehicle.deleteMany({ where: { tenantId: ids.tenant } }).catch(() => {});
  if (ids.vtype) await prisma.vehicleType.delete({ where: { id: ids.vtype } }).catch(() => {});
  for (const l of [ids.locA, ids.locB]) if (l) await prisma.location.delete({ where: { id: l } }).catch(() => {});
  if (ids.tenant) await prisma.tenant.delete({ where: { id: ids.tenant } }).catch(() => {});
  await prisma.$disconnect();
});

test('setup: two locations, a vehicle at each, one citation each + one unmatched', async () => {
  const tenant = await prisma.tenant.create({ data: { name: `T ${TAG}`, slug: `t-${TAG}`.toLowerCase() } });
  ids.tenant = tenant.id;
  scopedToA = null; // set below once locA exists
  const [a, b] = await Promise.all([
    prisma.location.create({ data: { tenantId: tenant.id, code: `A-${TAG}`.slice(0, 12), name: 'Branch A' } }),
    prisma.location.create({ data: { tenantId: tenant.id, code: `B-${TAG}`.slice(0, 12), name: 'Branch B' } })
  ]);
  ids.locA = a.id; ids.locB = b.id;
  const vt = await prisma.vehicleType.create({
    data: { tenantId: tenant.id, code: `VT-${TAG}`.slice(0, 10), name: 'Compact' }
  });
  ids.vtype = vt.id;
  const [va, vb] = await Promise.all([
    prisma.vehicle.create({ data: { tenantId: tenant.id, internalNumber: `A1-${TAG}`, vehicleTypeId: vt.id, homeLocationId: a.id, plate: `PA${TAG}`.slice(0, 12) } }),
    prisma.vehicle.create({ data: { tenantId: tenant.id, internalNumber: `B1-${TAG}`, vehicleTypeId: vt.id, homeLocationId: b.id, plate: `PB${TAG}`.slice(0, 12) } })
  ]);
  ids.vehA = va.id; ids.vehB = vb.id;

  const base = { tenantId: tenant.id, source: 'MANUAL', agency: 'TEST AGENCY', amount: 100, status: 'NEEDS_REVIEW' };
  const [ca, cb, orphan] = await Promise.all([
    prisma.citation.create({ data: { ...base, citationNo: `CA-${TAG}`, vehicleId: va.id } }),
    prisma.citation.create({ data: { ...base, citationNo: `CB-${TAG}`, vehicleId: vb.id } }),
    prisma.citation.create({ data: { ...base, citationNo: `CO-${TAG}`, vehicleId: null } })
  ]);
  ids.citA = ca.id; ids.citB = cb.id; ids.citOrphan = orphan.id;

  scopedToA = { tenantId: tenant.id, allowedLocationIds: [a.id] };
  unrestricted = { tenantId: tenant.id, allowedLocationIds: null };
  assert.ok(ids.citA && ids.citB && ids.citOrphan);
});

test('CARE 1 + 4: a location-scoped caller sees ONLY its location (and not the unmatched one)', async () => {
  const { rows, total } = await citationsService.list({ pageSize: 100 }, scopedToA);
  const nums = rows.map((r) => r.citationNo).sort();
  assert.deepEqual(nums, [`CA-${TAG}`], 'only Branch A citation is visible');
  assert.equal(total, 1, 'the total must be scoped too, not just the page');
});

test('CARE 2 + 4: an unrestricted caller still sees all three, including the unmatched one', async () => {
  const { rows, total } = await citationsService.list({ pageSize: 100 }, unrestricted);
  const nums = rows.map((r) => r.citationNo).sort();
  assert.deepEqual(nums, [`CA-${TAG}`, `CB-${TAG}`, `CO-${TAG}`].sort());
  assert.equal(total, 3);
});

test('CARE 3: dashboard summary counts are scoped (this is the tile that showed the wrong number)', async () => {
  const scoped = await citationsService.dashboardSummary(scopedToA);
  const all = await citationsService.dashboardSummary(unrestricted);
  assert.equal(scoped.needsReview, 1, 'scoped caller counts only its own location');
  assert.equal(all.needsReview, 3, 'unrestricted caller still counts everything');
  assert.ok(all.outstanding > scoped.outstanding, 'outstanding money is scoped as well');
});

// The where-fragment itself is pure, and every scoped query in the module is
// only as correct as its shape. Pinned here so a bad refactor fails in
// milliseconds instead of silently returning `{}` (= no filter at all).
test('citationLocationWhere: unrestricted callers get an EMPTY fragment, never a filter', () => {
  assert.deepEqual(citationLocationWhere({}), {});
  assert.deepEqual(citationLocationWhere({ allowedLocationIds: null }), {});
  assert.deepEqual(citationLocationWhere({ allowedLocationIds: [] }), {});
  assert.deepEqual(citationLocationWhere({ allowedLocationIds: [null, ''] }), {});
});

test('citationLocationWhere: scoped callers get the vehicle→homeLocationId relation filter', () => {
  assert.deepEqual(
    citationLocationWhere({ allowedLocationIds: ['L1', 'L2'] }),
    { vehicle: { is: { homeLocationId: { in: ['L1', 'L2'] } } } }
  );
  // `is` (not `some`) matters: it's a to-one relation, and it excludes rows
  // with a NULL vehicleId — that IS the fail-closed rule for unmatched citations.
  assert.deepEqual(
    citationLocationWhere({ allowedLocationIds: [null, 'L1'] }),
    { vehicle: { is: { homeLocationId: { in: ['L1'] } } } }
  );
});

test('CARE 5: getDetail cannot reach another branch citation by id', async () => {
  const mine = await citationsService.getDetail(ids.citA, scopedToA);
  assert.ok(mine, 'own-location citation is readable');
  await assert.rejects(
    () => citationsService.getDetail(ids.citB, scopedToA),
    'a scoped caller must not open another location citation by id'
  );
});

// CARE 6 — the side door. The OCR scheduler stamps Citation.documentPath with
// the CitationDocument's own bucketPath, so /citations/documents/:id/download
// serves the EXACT file that /citations/:id/document refuses, and
// listDocuments hands out the ids to try. Scoping the citation without
// scoping the document leaves the PII (driver name, license, address) one
// endpoint away.
test('CARE 6: the CitationDocument routes are scoped too, not just the citation', async () => {
  const SHARED_PATH = `citation-docs:${TAG}/notice.pdf`;
  const [docA, docB, docOrphan] = await Promise.all([
    prisma.citationDocument.create({ data: { tenantId: ids.tenant, bucketPath: SHARED_PATH, citationId: ids.citA, status: 'INGESTED' } }),
    prisma.citationDocument.create({ data: { tenantId: ids.tenant, bucketPath: SHARED_PATH, citationId: ids.citB, status: 'INGESTED' } }),
    prisma.citationDocument.create({ data: { tenantId: ids.tenant, bucketPath: SHARED_PATH, citationId: null, status: 'PENDING' } })
  ]);
  ids.docA = docA.id; ids.docB = docB.id; ids.docOrphan = docOrphan.id;

  const scopedList = await citationsService.listDocuments(scopedToA, { pageSize: 100 });
  assert.deepEqual(scopedList.rows.map((r) => r.id), [docA.id], 'only the document of its own branch');
  assert.equal(scopedList.total, 1, 'and the total is scoped, so pagination cannot leak the count');

  const adminList = await citationsService.listDocuments(unrestricted, { pageSize: 100 });
  assert.equal(adminList.total, 3, 'the tenant admin still sees all three, including the un-matched one');

  // The download itself: another branch's document must 404, exactly like the
  // citation-side route does.
  await assert.rejects(
    () => citationsService.getDocumentSignedUrl(docB.id, scopedToA),
    /not found/i,
    'a scoped caller must not sign a URL for another branch document'
  );
  await assert.rejects(
    () => citationsService.getDocumentSignedUrl(docOrphan.id, scopedToA),
    /not found/i,
    'nor for one not yet matched to a citation (fail-closed, the admin triages it)'
  );
  // Same rule on the mutation, so it can't be used to probe for existence.
  await assert.rejects(
    () => citationsService.retryDocument(docB.id, scopedToA),
    /not found/i,
    'retry is scoped as well'
  );
});

// ── CARE 7 (2026-07-24): the surfaces the 2026-07-23 pass scoped but never
// tested. Each was verified by reverting its `citationLocationWhere(scope)` and
// watching the matching assertion fail.

// review() is the MUTATION. Read scoping hides another branch's citation;
// without the same filter here a scoped caller could still VOID or DISPUTE it
// by id — and because review() re-bills through syncCitationCharges, that moves
// money on a reservation they were never allowed to see.
test('CARE 7a: review() is scoped — a mutation, not just a read', async () => {
  await assert.rejects(
    () => citationsService.review(ids.citB, { decision: 'VOID', userId: null }, scopedToA),
    /not found/i,
    'a scoped caller must not review another branch citation'
  );
  // And the row is genuinely untouched — the rejection is not cosmetic.
  const after = await prisma.citation.findUnique({ where: { id: ids.citB }, select: { status: true } });
  assert.equal(after.status, 'NEEDS_REVIEW', 'the other branch citation kept its status');

  // The no-regression half: its own branch still reviews normally.
  const ok = await citationsService.review(ids.citA, { decision: 'CONFIRM', userId: null }, scopedToA);
  assert.equal(ok.status, 'MATCHED');
  // Put it back so later assertions on counts stay stable.
  await prisma.citation.update({ where: { id: ids.citA }, data: { status: 'NEEDS_REVIEW', needsReview: true } });
});

// The unmatched citation has no resolvable location, so a scoped caller must
// not be able to review it either — fail-closed, the tenant admin triages it.
test('CARE 7a2: review() on an UNMATCHED citation is refused for a scoped caller', async () => {
  await assert.rejects(
    () => citationsService.review(ids.citOrphan, { decision: 'CONFIRM', userId: null }, scopedToA),
    /not found/i
  );
});

// getVehicleHistory takes a vehicleId, not a citation id — a different entry
// point into the same rows, and the one the vehicle profile page uses.
test('CARE 7b: getVehicleHistory() cannot read another branch vehicle history', async () => {
  const mine = await citationsService.getVehicleHistory(ids.vehA, scopedToA);
  assert.equal(mine.length, 1, 'own vehicle history is readable');

  const theirs = await citationsService.getVehicleHistory(ids.vehB, scopedToA);
  assert.deepEqual(theirs, [], 'another branch vehicle yields nothing, not its citations');

  const asAdmin = await citationsService.getVehicleHistory(ids.vehB, unrestricted);
  assert.equal(asAdmin.length, 1, 'the tenant admin still sees it — no regression');
});

// getDocumentUrl signs a URL for Citation.documentPath. Same file as the
// CitationDocument side door in CARE 6, reached through the citation instead.
test('CARE 7c: getDocumentUrl() is scoped by citation, not just by document', async () => {
  // An absolute URL is used deliberately: getDocumentUrl returns it verbatim
  // and never reaches getSignedUrl, so the admin control below asserts the
  // SCOPE without needing SUPABASE_URL configured in the test environment.
  const HREF = `https://example.invalid/citations/${TAG}/b.pdf`;
  await prisma.citation.update({ where: { id: ids.citB }, data: { documentPath: HREF } });
  await assert.rejects(
    () => citationsService.getDocumentUrl(ids.citB, scopedToA),
    /not found/i,
    'a scoped caller must not resolve another branch notice'
  );
  // Reaching it as the admin proves the 404 above came from the SCOPE and not
  // from a missing documentPath — otherwise this test would pass while broken.
  const asAdmin = await citationsService.getDocumentUrl(ids.citB, unrestricted);
  assert.equal(asAdmin.url, HREF, 'the tenant admin resolves the same citation');
});

// The affidavit is the highest-value leak in the module: it names the renter
// (full name, licence number, home address) on a rendered PDF.
test('CARE 7d: affidavitPdfBuffer() cannot render another branch renter PII', async () => {
  const { affidavitPdfBuffer } = await import('./citations-affidavit.service.js');
  await assert.rejects(
    () => affidavitPdfBuffer(ids.citB, scopedToA),
    /not found/i,
    'a scoped caller must not render an affidavit for another branch citation'
  );
  await assert.rejects(
    () => affidavitPdfBuffer(ids.citOrphan, scopedToA),
    /not found/i,
    'nor for an unmatched citation'
  );
  // As the tenant admin the SAME id gets past the scope gate and fails later on
  // the real precondition (no matched reservation/renter). Distinguishing the
  // two failures is the point: it proves the scoped rejection was the location
  // filter, not this precondition firing for everyone.
  await assert.rejects(
    () => affidavitPdfBuffer(ids.citB, unrestricted),
    (err) => !/not found/i.test(String(err?.message)),
    'the admin gets past the scope gate and fails on the missing renter instead'
  );
});
