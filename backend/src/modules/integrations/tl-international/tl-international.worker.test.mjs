import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

process.env.INTEGRATION_ENC_KEY = crypto.randomBytes(32).toString('base64');

// We use a worker handler dependency-injection variant in tests by replacing
// the module-level functions through dynamic imports + monkey patching.
// Node ESM doesn't allow this trivially, so the strategy is to inject a
// fake prisma + fake service into the handler. We achieve that by importing
// the worker module after replacing the underlying prisma + service modules
// via the registry pattern: not available in stock Node, so we test through
// a thin re-implementation of the inner loop instead.
//
// What we DO unit-test directly here:
//   - The lifecycle counts (newly inserted / updated / autoPromoted / needsReview)
//     against an in-memory fake of the worker's data dependencies.
//
// What we DEFER to the future end-to-end test (with real Postgres + Redis):
//   - actual prisma calls, BullMQ wiring.

// Re-implement the inner loop logic against fakes — the production handler
// follows the same shape (pre-fetch known refs, upsert, decide, branch).
// This guards the algorithmic contract.

function makeFakes({ pickups, detailsByRef, decisionByRef, knownRefs = new Set() }) {
  const externalReservationStore = new Map();
  for (const r of knownRefs) {
    externalReservationStore.set(r, { id: `er_${r}`, externalRef: r, promotionStatus: 'PENDING' });
  }
  const reservations = [];
  const syncRuns = [];

  const prisma = {
    externalSyncRun: {
      create: async ({ data }) => {
        const row = { id: `run_${syncRuns.length}`, ...data, startedAt: new Date() };
        syncRuns.push(row);
        return row;
      },
      update: async ({ where, data }) => {
        const idx = syncRuns.findIndex((r) => r.id === where.id);
        if (idx >= 0) syncRuns[idx] = { ...syncRuns[idx], ...data };
        return syncRuns[idx];
      },
    },
    externalReservation: {
      findMany: async ({ where }) => {
        return [...externalReservationStore.values()].filter((r) =>
          where.externalRef.in.includes(r.externalRef)
        );
      },
      upsert: async ({ where, create, update }) => {
        const ref = where.source_ref_unique.externalRef;
        const existing = externalReservationStore.get(ref);
        const merged = existing
          ? { ...existing, ...update, syncRunCount: (existing.syncRunCount || 1) + 1 }
          : { id: `er_${ref}`, ...create, syncRunCount: 1, promotionStatus: 'PENDING' };
        externalReservationStore.set(ref, merged);
        return merged;
      },
      update: async ({ where, data }) => {
        const row = [...externalReservationStore.values()].find((r) => r.id === where.id);
        if (row) Object.assign(row, data);
        return row;
      },
      findUnique: async ({ where }) => {
        return [...externalReservationStore.values()].find((r) => r.id === where.id) || null;
      },
    },
  };

  // Stubs for service deps
  const services = {
    fetchDashboardPickups: async () => pickups,
    fetchReservationDetail: async (_tid, ref) => detailsByRef.get(ref) ?? null,
    mapDetailToRow: (d, ref) => ({ ...d, externalRef: ref, rawJson: d }),
    DETAIL_DELAY_MS: 0,
    SOURCE_SYSTEM: 'TL_INTERNATIONAL',
    sleep: () => Promise.resolve(),
  };
  const matcher = async (ext) => decisionByRef.get(ext.externalRef) ?? { decision: 'MANUAL_REVIEW', reason: 'customer_not_found' };

  return { prisma, services, matcher, store: { externalReservationStore, reservations, syncRuns } };
}

// Replicate the worker loop algorithm (the unit under test is the algorithm,
// not the prisma calls themselves which are integration-level).
async function runFakeWorker({ prisma, services, matcher }, tenantId) {
  const startedAt = new Date();
  const runRow = await prisma.externalSyncRun.create({
    data: { tenantId, sourceSystem: services.SOURCE_SYSTEM, status: 'OK', notes: 'Triggered by: test' },
  });
  let pickupsFound = 0, newlyInserted = 0, updatedExisting = 0;
  let autoPromoted = 0, needsReview = 0, errorsCount = 0;
  const samples = [];
  try {
    const pickups = await services.fetchDashboardPickups();
    pickupsFound = pickups.length;
    const known = await prisma.externalReservation.findMany({
      where: { tenantId, sourceSystem: services.SOURCE_SYSTEM, externalRef: { in: pickups.map((p) => p.externalRef) } },
    });
    const knownSet = new Set(known.map((k) => k.externalRef));
    for (const p of pickups) {
      const wasKnown = knownSet.has(p.externalRef);
      const detail = await services.fetchReservationDetail(tenantId, p.externalRef);
      if (!detail) { errorsCount++; samples.push(`${p.externalRef}: no-detail`); continue; }
      const mapped = services.mapDetailToRow(detail, p.externalRef);
      const upserted = await prisma.externalReservation.upsert({
        where: { source_ref_unique: { sourceSystem: services.SOURCE_SYSTEM, externalRef: p.externalRef } },
        create: { ...mapped, tenantId, sourceSystem: services.SOURCE_SYSTEM },
        update: { ...mapped },
      });
      if (wasKnown) updatedExisting++; else newlyInserted++;
      const decision = await matcher(upserted);
      if (decision.decision === 'AUTO') {
        autoPromoted++;
        await prisma.externalReservation.update({ where: { id: upserted.id }, data: { promotionStatus: 'AUTO_PROMOTED' } });
      } else {
        needsReview++;
        await prisma.externalReservation.update({ where: { id: upserted.id }, data: { promotionStatus: 'MANUAL_REVIEW', needsReviewReason: decision.reason } });
      }
    }
  } catch (err) {
    samples.push(err.message);
  }
  const finishedAt = new Date();
  await prisma.externalSyncRun.update({
    where: { id: runRow.id },
    data: { finishedAt, durationMs: finishedAt - startedAt, status: errorsCount && (newlyInserted + updatedExisting) ? 'PARTIAL' : (errorsCount ? 'FAILED' : 'OK'), pickupsFound, newlyInserted, updatedExisting, autoPromoted, needsReview, errorsCount, notes: samples.length ? samples.slice(0, 5).join(' | ') : null },
  });
  return { runId: runRow.id, pickupsFound, newlyInserted, updatedExisting, autoPromoted, needsReview, errorsCount };
}

// ---------------------------------------------------------------------------
// Test cases
// ---------------------------------------------------------------------------

test('worker loop: counts new vs updated and writes one ExternalSyncRun', async () => {
  const fakes = makeFakes({
    pickups: [
      { externalRef: 'ZE1', cells: [] },
      { externalRef: 'ZE2', cells: [] },
      { externalRef: 'ZE3', cells: [] },
    ],
    detailsByRef: new Map([
      ['ZE1', { firstname: 'A' }],
      ['ZE2', { firstname: 'B' }],
      ['ZE3', { firstname: 'C' }],
    ]),
    decisionByRef: new Map([
      ['ZE1', { decision: 'AUTO', mappedCustomer: { id: 'c1' }, mappedLocation: { id: 'l1' }, mappedVehicleCategory: 'COMPACT' }],
      ['ZE2', { decision: 'MANUAL_REVIEW', reason: 'customer_not_found' }],
      ['ZE3', { decision: 'AUTO', mappedCustomer: { id: 'c3' }, mappedLocation: { id: 'l1' }, mappedVehicleCategory: 'COMPACT' }],
    ]),
    knownRefs: new Set(['ZE1']),  // ZE1 was already in DB
  });
  const out = await runFakeWorker(fakes, 'tnt_x');
  assert.equal(out.pickupsFound, 3);
  assert.equal(out.newlyInserted, 2);  // ZE2, ZE3
  assert.equal(out.updatedExisting, 1);  // ZE1
  assert.equal(out.autoPromoted, 2);
  assert.equal(out.needsReview, 1);
  assert.equal(out.errorsCount, 0);
  assert.equal(fakes.store.syncRuns.length, 1);
  assert.equal(fakes.store.syncRuns[0].status, 'OK');
});

test('worker loop: counts errors when detail returns null', async () => {
  const fakes = makeFakes({
    pickups: [{ externalRef: 'ZE_A', cells: [] }, { externalRef: 'ZE_B', cells: [] }],
    detailsByRef: new Map([
      ['ZE_A', { firstname: 'OK' }],
      // ZE_B intentionally absent → null
    ]),
    decisionByRef: new Map([
      ['ZE_A', { decision: 'AUTO', mappedCustomer: { id: 'c' }, mappedLocation: { id: 'l' }, mappedVehicleCategory: 'COMPACT' }],
    ]),
  });
  const out = await runFakeWorker(fakes, 'tnt_x');
  assert.equal(out.pickupsFound, 2);
  assert.equal(out.errorsCount, 1);
  assert.equal(fakes.store.syncRuns[0].status, 'PARTIAL');
});

test('worker loop: empty dashboard → OK status with all zeroes', async () => {
  const fakes = makeFakes({
    pickups: [],
    detailsByRef: new Map(),
    decisionByRef: new Map(),
  });
  const out = await runFakeWorker(fakes, 'tnt_x');
  assert.equal(out.pickupsFound, 0);
  assert.equal(out.newlyInserted, 0);
  assert.equal(out.autoPromoted, 0);
  assert.equal(fakes.store.syncRuns[0].status, 'OK');
});
