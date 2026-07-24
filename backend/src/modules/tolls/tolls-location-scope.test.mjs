/**
 * DB-backed tests for LOCATION scoping of the tolls module (2026-07-24).
 * Requires DATABASE_URL.
 *
 * WHY THIS EXISTS: the tolls module had ZERO location scoping — a user
 * restricted to one branch saw every toll in the tenant, on the list AND on all
 * five dashboard tiles, and could confirm/void/review any of them by id. This is
 * the same bug the citations module had, and it is fixed the same way: a
 * TollTransaction has no Location FK (its `location` column is the free-text
 * plaza name off the provider feed), so the scope resolves through the matched
 * vehicle — TollTransaction.vehicleId → Vehicle.homeLocationId.
 *
 * CARES PROVEN HERE (each bites — verified by reverting the filter):
 *  1. a scoped caller's dashboard LIST shows only its own branch.
 *  2. the dashboard METRIC TILES are scoped too. They are five separate count
 *     queries; scoping the list alone reproduces the maintenance-board bug where
 *     the tile and the list under it disagreed.
 *  3. an UNMATCHED toll (vehicleId = null) is hidden from a scoped caller
 *     (fail-closed) and still visible to the tenant admin who triages it.
 *  4. an unrestricted caller still sees everything — no regression.
 *  5. the by-id MUTATION gateway is scoped, so another branch's toll cannot be
 *     confirmed/reviewed by id.
 *  6. bulk confirm skips out-of-scope ids instead of acting on them.
 *  7. listReservationTolls is authorized on the RESERVATION ONLY (pickup/return).
 *     Its toll rows are deliberately NOT filtered by vehicle home — see MC3 at
 *     the bottom of this file. Do not 'restore' that filter.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { PrismaClient } from '@prisma/client';
import { tollsService, tollLocationWhere } from './tolls.service.js';

const prisma = new PrismaClient();
const TAG = `TOLLOC-${Date.now()}`;
const ids = { tenant: null, locA: null, locB: null, vehA: null, vehB: null, vtype: null,
              txA: null, txB: null, txOrphan: null, resA: null, resB: null, customer: null };

let scopedToA = null;    // caller restricted to location A
let unrestricted = null; // tenant admin — no location restriction

test.after(async () => {
  await prisma.tollAssignment.deleteMany({ where: { tollTransaction: { tenantId: ids.tenant } } }).catch(() => {});
  await prisma.tollTransaction.deleteMany({ where: { tenantId: ids.tenant } }).catch(() => {});
  await prisma.reservation.deleteMany({ where: { tenantId: ids.tenant } }).catch(() => {});
  await prisma.customer.deleteMany({ where: { tenantId: ids.tenant } }).catch(() => {});
  await prisma.vehicle.deleteMany({ where: { tenantId: ids.tenant } }).catch(() => {});
  if (ids.vtype) await prisma.vehicleType.delete({ where: { id: ids.vtype } }).catch(() => {});
  for (const l of [ids.locA, ids.locB]) if (l) await prisma.location.delete({ where: { id: l } }).catch(() => {});
  if (ids.tenant) await prisma.tenant.delete({ where: { id: ids.tenant } }).catch(() => {});
  await prisma.$disconnect();
});

test('setup: two branches, a vehicle + a toll at each, one unmatched toll', async () => {
  // tollsEnabled is required or getDashboard short-circuits to the disabled payload.
  const tenant = await prisma.tenant.create({
    data: { name: `T ${TAG}`, slug: `t-${TAG}`.toLowerCase(), tollsEnabled: true }
  });
  ids.tenant = tenant.id;

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

  const customer = await prisma.customer.create({
    data: { tenantId: tenant.id, firstName: 'Test', lastName: `Renter ${TAG}`, phone: '7875550100' }
  });
  ids.customer = customer.id;

  const pickupAt = new Date('2026-07-01T10:00:00Z');
  const returnAt = new Date('2026-07-05T10:00:00Z');
  const [ra, rb] = await Promise.all([
    prisma.reservation.create({ data: { tenantId: tenant.id, reservationNumber: `RA-${TAG}`, customerId: customer.id, vehicleId: va.id, pickupLocationId: a.id, returnLocationId: a.id, pickupAt, returnAt, status: 'CHECKED_OUT', estimatedTotal: 0 } }),
    prisma.reservation.create({ data: { tenantId: tenant.id, reservationNumber: `RB-${TAG}`, customerId: customer.id, vehicleId: vb.id, pickupLocationId: b.id, returnLocationId: b.id, pickupAt, returnAt, status: 'CHECKED_OUT' } })
  ]);
  ids.resA = ra.id; ids.resB = rb.id;

  const base = {
    tenantId: tenant.id,
    transactionAt: new Date('2026-07-02T12:00:00Z'),
    amount: 5.25,
    location: 'PLAZA TEODORO MOSCOSO', // free text — deliberately the SAME for both
    status: 'MATCHED',
    needsReview: true,
    billingStatus: 'PENDING'
  };
  const [ta, tb, orphan] = await Promise.all([
    prisma.tollTransaction.create({ data: { ...base, externalId: `TA-${TAG}`, vehicleId: va.id, reservationId: ra.id, plateRaw: `PA${TAG}`.slice(0, 12) } }),
    prisma.tollTransaction.create({ data: { ...base, externalId: `TB-${TAG}`, vehicleId: vb.id, reservationId: rb.id, plateRaw: `PB${TAG}`.slice(0, 12) } }),
    prisma.tollTransaction.create({ data: { ...base, externalId: `TO-${TAG}`, vehicleId: null, reservationId: null, plateRaw: 'UNKNOWN' } })
  ]);
  ids.txA = ta.id; ids.txB = tb.id; ids.txOrphan = orphan.id;

  scopedToA = { tenantId: tenant.id, allowedLocationIds: [a.id] };
  unrestricted = { tenantId: tenant.id, allowedLocationIds: null };
  assert.ok(ids.txA && ids.txB && ids.txOrphan);
});

// The where-fragment is pure and every scoped query is only as correct as its
// shape. Pinned so a bad refactor fails in milliseconds instead of silently
// returning `{}` (= no filter at all).
test('tollLocationWhere: unrestricted callers get an EMPTY fragment, never a filter', () => {
  assert.deepEqual(tollLocationWhere({}), {});
  assert.deepEqual(tollLocationWhere({ allowedLocationIds: null }), {});
  assert.deepEqual(tollLocationWhere({ allowedLocationIds: [] }), {});
  assert.deepEqual(tollLocationWhere({ allowedLocationIds: [null, ''] }), {});
});

test('tollLocationWhere: scoped callers get the vehicle→homeLocationId relation filter', () => {
  assert.deepEqual(
    tollLocationWhere({ allowedLocationIds: ['L1', 'L2'] }),
    { vehicle: { is: { homeLocationId: { in: ['L1', 'L2'] } } } }
  );
  // `is` (not `some`) matters: to-one relation, and it excludes vehicleId = null
  // — that IS the fail-closed rule for unmatched tolls.
  assert.deepEqual(
    tollLocationWhere({ allowedLocationIds: [null, 'L1'] }),
    { vehicle: { is: { homeLocationId: { in: ['L1'] } } } }
  );
});

test('CARE 1 + 3: the dashboard LIST shows only the caller own branch', async () => {
  const { transactions } = await tollsService.getDashboard(scopedToA, {});
  const externals = transactions.map((t) => t.externalId).sort();
  assert.deepEqual(externals, [`TA-${TAG}`], 'only Branch A toll — not B, not the unmatched one');
});

test('CARE 4: an unrestricted caller still sees all three', async () => {
  const { transactions } = await tollsService.getDashboard(unrestricted, {});
  const externals = transactions.map((t) => t.externalId).sort();
  assert.deepEqual(externals, [`TA-${TAG}`, `TB-${TAG}`, `TO-${TAG}`].sort());
});

test('CARE 2: every dashboard METRIC TILE is scoped, not just the list', async () => {
  // These are five separate count queries. Scoping the list alone is exactly the
  // contradiction the maintenance board shipped with: a tile saying 3 above a
  // list showing 1.
  const scoped = await tollsService.getDashboard(scopedToA, {});
  const all = await tollsService.getDashboard(unrestricted, {});

  assert.equal(scoped.metrics.matched, 1, 'matched tile counts only Branch A');
  assert.equal(all.metrics.matched, 3, 'admin still counts all three');

  assert.equal(scoped.metrics.needsReview, 1, 'needsReview tile is scoped');
  assert.equal(all.metrics.needsReview, 3);

  assert.equal(scoped.metrics.importedToday, 1, 'importedToday tile is scoped');
  assert.equal(all.metrics.importedToday, 3);
});

test('CARE 5: the by-id mutation gateway is scoped — confirm/review cannot reach another branch', async () => {
  // getTransactionOrThrow is the single gateway behind confirmMatch,
  // postToReservation and applyReviewAction, so scoping it covers all three.
  await assert.rejects(
    () => tollsService.applyReviewAction(ids.txB, { action: 'RESET_MATCH', note: 'x' }, scopedToA, null),
    /not found/i,
    'a scoped caller must not review another branch toll by id'
  );
  await assert.rejects(
    () => tollsService.applyReviewAction(ids.txOrphan, { action: 'RESET_MATCH', note: 'x' }, scopedToA, null),
    /not found/i,
    'nor an unmatched toll (fail-closed — the tenant admin triages it)'
  );
  // The row is genuinely untouched, so the rejection is not cosmetic.
  const after = await prisma.tollTransaction.findUnique({ where: { id: ids.txB }, select: { status: true, needsReview: true } });
  assert.equal(after.status, 'MATCHED');
  assert.equal(after.needsReview, true);
});

test('CARE 6: bulk confirm SKIPS out-of-scope ids instead of acting on them', async () => {
  const out = await tollsService.bulkConfirmMatches([ids.txA, ids.txB, ids.txOrphan], scopedToA, null, {});
  assert.equal(out.total, 3, 'all three were requested');
  // NOTE: the RESULT objects carry `action`; only the internal `plans` use
  // `kind`. Filtering on `kind` matched nothing, so this assertion used to rest
  // entirely on the message regex.
  //
  // Assert on the REASON, not just on "was skipped": txA is skipped too, but for
  // an unrelated reason ('No suggested reservation to confirm' — the fixture sets
  // needsReview, so it takes that branch). Conflating the two would let a
  // scope regression hide behind an ordinary skip.
  const outOfScope = out.results.filter((r) => r.action === 'SKIP' && /not found in scope/i.test(String(r.message || '')));
  assert.deepEqual(
    outOfScope.map((r) => r.id).sort(),
    [ids.txB, ids.txOrphan].sort(),
    'the other branch toll and the unmatched one are skipped AS OUT-OF-SCOPE, never confirmed'
  );
  assert.equal(
    out.results.filter((r) => r.id === ids.txA && /not found in scope/i.test(String(r.message || ''))).length,
    0,
    'the in-scope toll is never rejected for scope'
  );
  const after = await prisma.tollTransaction.findUnique({ where: { id: ids.txB }, select: { status: true } });
  assert.equal(after.status, 'MATCHED', 'the other branch row was not mutated');
});

test('CARE 7: listReservationTolls is gated on the reservation (NOT on vehicle home)', async () => {
  const mine = await tollsService.listReservationTolls(ids.resA, scopedToA);
  assert.equal(mine.transactions.length, 1, 'own reservation tolls are readable');

  // The reservation gate uses pickup/return location (how the reservations
  // module scopes), so another branch's reservation is not even confirmed to
  // exist — its reservationNumber must not leak.
  await assert.rejects(
    () => tollsService.listReservationTolls(ids.resB, scopedToA),
    /not found/i,
    'a scoped caller must not read another branch reservation tolls'
  );

  const asAdmin = await tollsService.listReservationTolls(ids.resB, unrestricted);
  assert.equal(asAdmin.transactions.length, 1, 'the tenant admin still sees it — no regression');
});

// ── Innovation review follow-ups (2026-07-24) ────────────────────────────────
// Three regressions/holes found reviewing the first cut of this change. Each
// test below fails against that first cut.

// MC1. `getTransactionOrThrow` is not only the read gateway — it is also the
// POST-WRITE hydrator inside createManualTransactions. Scoping it there meant a
// location-restricted staffer pasting a toll CSV threw on the first row whose
// plate matched no vehicle (vehicleId = null, which the filter excludes by
// design) — AFTER that row committed, leaving the import run stuck at RUNNING.
test('MC1: a location-scoped caller can still manually import tolls, incl. unmatched rows', async () => {
  const out = await tollsService.createManualTransactions(
    [
      { transactionAt: '2026-07-03T09:00:00Z', amount: 3.5, plate: `PA${TAG}`.slice(0, 12), externalId: `MI-MATCH-${TAG}`, location: 'PLAZA X' },
      // no vehicle has this plate → lands unmatched (vehicleId null). THE row
      // that used to throw.
      { transactionAt: '2026-07-03T09:05:00Z', amount: 4.25, plate: 'NOSUCHPLATE', externalId: `MI-ORPHAN-${TAG}`, location: 'PLAZA X' }
    ],
    scopedToA,
    null,
    {}
  );
  assert.equal(out.importedCount ?? out.created?.length, 2, 'both rows imported — the unmatched one did not throw');

  const run = await prisma.tollImportRun.findFirst({
    where: { tenantId: ids.tenant }, orderBy: { startedAt: 'desc' }, select: { status: true }
  });
  assert.notEqual(run.status, 'RUNNING', 'the import run was completed, not left hanging');

  // Cleanup so the dashboard-count assertions above stay meaningful if re-run.
  await prisma.tollTransaction.deleteMany({ where: { externalId: { in: [`MI-MATCH-${TAG}`, `MI-ORPHAN-${TAG}`] } } });
});

// MC2. The confirm-match TARGET reservation is free-choice input, so the by-id
// gateway does not cover it: a scoped caller could take an in-scope toll and
// post its money onto a reservation at another branch that they cannot read.
test('MC2: confirmMatch cannot post a toll onto another branch reservation', async () => {
  await assert.rejects(
    () => tollsService.confirmMatch(ids.txA, { reservationId: ids.resB }, scopedToA, null),
    /reservation not found/i,
    'the confirm-match target is location-gated, not just tenant-gated'
  );
  // Nothing moved: the toll still points at its own reservation.
  const after = await prisma.tollTransaction.findUnique({ where: { id: ids.txA }, select: { reservationId: true } });
  assert.equal(after.reservationId, ids.resA, 'the toll was not re-pointed at Branch B');
  // And no charge was posted onto the Branch B reservation.
  const charges = await prisma.reservationCharge.count({ where: { reservationId: ids.resB, source: 'TOLL_MODULE' } });
  assert.equal(charges, 0, 'no toll money landed on the unreachable reservation');
});

test('MC2b: confirmMatch still works within the caller own branch', async () => {
  // confirmMatch returns the SERIALIZED shape, which nests the reservation.
  const out = await tollsService.confirmMatch(ids.txA, { reservationId: ids.resA }, scopedToA, null);
  assert.equal(out.reservation?.id, ids.resA, 'the happy path did not 404 on post-write hydration');
  // MATCHED is what confirmMatch writes; the syncReservationTollCharges that
  // runs immediately after legitimately advances it to BILLED. Accept either so
  // this pins the SCOPE, not the billing state machine.
  assert.ok(['MATCHED', 'BILLED'].includes(String(out.status).toUpperCase()), `unexpected status ${out.status}`);
  assert.equal(out.needsReview, false, 'and the match was actually applied');
});

// MC3. listReservationTolls authorized on the reservation (pickup/return) but
// filtered its rows on vehicle home — a DIFFERENT axis. On a one-way rental, or
// any car garaged outside the renting branch, that blanked the tab while
// TOLL_MODULE charges sat on the agreement.
test('MC3: a one-way rental still shows its tolls to the renting branch', async () => {
  // Branch-A reservation, but the car is homed at Branch B (a one-way drop or a
  // rebalanced unit). The agent at A must still see the toll they are being
  // asked about.
  const oneWay = await prisma.reservation.create({
    data: {
      tenantId: ids.tenant, reservationNumber: `ROW-${TAG}`, customerId: ids.customer,
      vehicleId: ids.vehB, pickupLocationId: ids.locA, returnLocationId: ids.locB,
      pickupAt: new Date('2026-07-10T10:00:00Z'), returnAt: new Date('2026-07-12T10:00:00Z'),
      status: 'CHECKED_OUT', estimatedTotal: 0
    }
  });
  const tx = await prisma.tollTransaction.create({
    data: {
      tenantId: ids.tenant, externalId: `TOW-${TAG}`, transactionAt: new Date('2026-07-11T12:00:00Z'),
      amount: 2.75, vehicleId: ids.vehB, reservationId: oneWay.id, status: 'MATCHED', billingStatus: 'PENDING'
    }
  });

  const out = await tollsService.listReservationTolls(oneWay.id, scopedToA);
  assert.equal(out.transactions.length, 1, 'the Branch-A agent sees the toll on their own one-way rental');
  assert.equal(out.totals.totalAmount, 2.75, 'and the totals are not silently zero');

  await prisma.tollTransaction.delete({ where: { id: tx.id } });
  await prisma.reservation.delete({ where: { id: oneWay.id } });
});

// ── QA gate finding B2 (2026-07-24) ──────────────────────────────────────────
// The FIFTH sibling. bulkConfirmMatches loaded its target reservations with the
// tenant filter only, so the bulk door did what confirmMatch refuses: post
// TOLL_MODULE charges onto a reservation the caller cannot read.
//
// CARE 6 above structurally cannot catch this — it excludes the other branch at
// the TRANSACTION level, so it never builds the case that matters: a toll that
// IS in scope (vehicle homed here) whose suggested reservation is NOT.
test('B2: bulk-confirm cannot bill an out-of-scope reservation via an in-scope toll', async () => {
  // Toll on the Branch-A car (in scope for scopedToA) but its SUGGESTED
  // assignment points at the Branch-B reservation (out of scope).
  const tx = await prisma.tollTransaction.create({
    data: {
      tenantId: ids.tenant, externalId: `B2-${TAG}`,
      transactionAt: new Date('2026-07-02T13:00:00Z'), amount: 9.99,
      vehicleId: ids.vehA,            // in scope
      reservationId: null,
      status: 'NEEDS_REVIEW', needsReview: true, billingStatus: 'PENDING'
    }
  });
  await prisma.tollAssignment.create({
    data: {
      tenantId: ids.tenant,
      tollTransactionId: tx.id, reservationId: ids.resB,  // OUT of scope
      status: 'SUGGESTED', confidence: 95, matchReason: 'test-suggested'
    }
  });

  const chargesBefore = await prisma.reservationCharge.count({
    where: { reservationId: ids.resB, source: 'TOLL_MODULE' }
  });

  const out = await tollsService.bulkConfirmMatches([tx.id], scopedToA, null, {});

  // The toll was NOT re-pointed at the unreachable reservation...
  const after = await prisma.tollTransaction.findUnique({
    where: { id: tx.id }, select: { reservationId: true, status: true }
  });
  assert.equal(after.reservationId, null, 'the toll was not matched to the out-of-scope reservation');
  assert.notEqual(String(after.status).toUpperCase(), 'BILLED', 'and it was not billed');

  // ...and crucially no money landed on it.
  const chargesAfter = await prisma.reservationCharge.count({
    where: { reservationId: ids.resB, source: 'TOLL_MODULE' }
  });
  assert.equal(chargesAfter, chargesBefore, 'no TOLL_MODULE charge was posted to the out-of-scope reservation');

  // It is reported, not silently dropped.
  assert.equal(out.confirmed, 0, 'nothing was confirmed');

  await prisma.tollAssignment.deleteMany({ where: { tollTransactionId: tx.id } });
  await prisma.tollTransaction.delete({ where: { id: tx.id } });
});

test('B2b: an unrestricted admin can still bulk-confirm the same toll', async () => {
  // The no-regression half: the gate must be invisible to a tenant admin.
  const tx = await prisma.tollTransaction.create({
    data: {
      tenantId: ids.tenant, externalId: `B2B-${TAG}`,
      transactionAt: new Date('2026-07-02T14:00:00Z'), amount: 8.88,
      vehicleId: ids.vehA, reservationId: null,
      status: 'NEEDS_REVIEW', needsReview: true, billingStatus: 'PENDING'
    }
  });
  await prisma.tollAssignment.create({
    data: { tenantId: ids.tenant, tollTransactionId: tx.id, reservationId: ids.resB, status: 'SUGGESTED', confidence: 95, matchReason: 'test-suggested' }
  });

  const out = await tollsService.bulkConfirmMatches([tx.id], unrestricted, null, {});
  assert.equal(out.confirmed, 1, 'the tenant admin still confirms it');
  const after = await prisma.tollTransaction.findUnique({ where: { id: tx.id }, select: { reservationId: true } });
  assert.equal(after.reservationId, ids.resB, 'and the match was applied');

  await prisma.reservationCharge.deleteMany({ where: { reservationId: ids.resB, source: 'TOLL_MODULE' } });
  await prisma.tollAssignment.deleteMany({ where: { tollTransactionId: tx.id } });
  await prisma.tollTransaction.delete({ where: { id: tx.id } });
});
