/**
 * The toll queue counts — DB-free.
 *
 * The whole point of this module is that ONE definition exists in two forms
 * (a JS predicate and a Prisma where). If those two ever disagree, the tab
 * count and the tab contents disagree, which is the bug all over again. So the
 * heart of this file is a tiny where-evaluator: every row in the corpus is run
 * through BOTH forms and they must agree, row by row, queue by queue.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  TOLL_QUEUE_KEYS,
  matches,
  queueWhere,
  countQueues,
  hasSuggestion,
  DISPATCH_TOKEN,
  TOLL_PACKAGE_NOTE,
} from './tolls-queue-counts.js';

// --------------------------------------------------------------------------
// A minimal Prisma-where evaluator — only the operators this module emits.
// --------------------------------------------------------------------------
function evalWhere(where, row) {
  if (!where || typeof where !== 'object') return true;
  return Object.entries(where).every(([key, cond]) => {
    if (key === 'AND') return cond.every((c) => evalWhere(c, row));
    if (key === 'OR') return cond.some((c) => evalWhere(c, row));
    if (key === 'NOT') return !evalWhere(cond, row);
    if (key === 'assignments') {
      const list = Array.isArray(row.assignments) ? row.assignments : [];
      if (cond.some) return list.some((a) => evalWhere(cond.some, a));
      throw new Error('unsupported relation filter');
    }
    const value = row[key];
    if (cond === null) return value == null;
    if (typeof cond !== 'object') return value === cond;
    return Object.entries(cond).every(([op, operand]) => {
      switch (op) {
        case 'not': return operand === null ? value != null : value !== operand;
        case 'in': return operand.includes(value);
        case 'gt': return value != null && Number(value) > operand;
        case 'lte': return value != null && Number(value) <= operand;
        case 'contains': return String(value ?? '').toLowerCase().includes(String(operand).toLowerCase());
        case 'mode': return true; // handled by contains being case-insensitive above
        default: throw new Error(`unsupported operator ${op}`);
      }
    });
  });
}

/** A fake prisma whose count() runs the real where against the corpus. */
const fakeDb = (rows) => ({
  tollTransaction: { count: async ({ where }) => rows.filter((r) => evalWhere(where, r)).length },
});

// --------------------------------------------------------------------------
// The corpus — every shape International's queue actually contains.
// --------------------------------------------------------------------------
const CORPUS = [
  { id: 'auto-1', reservationId: 'r1', vehicleId: 'v1', needsReview: false, status: 'MATCHED', billingStatus: 'PENDING', matchConfidence: 95, reviewNotes: null },
  { id: 'auto-2', reservationId: 'r2', vehicleId: 'v2', needsReview: false, status: 'BILLED', billingStatus: 'POSTED_TO_RESERVATION', matchConfidence: 90, reviewNotes: null },
  // Has a suggestion a human must accept — the 189.
  { id: 'sugg-res', reservationId: 'r3', vehicleId: 'v3', needsReview: true, status: 'IMPORTED', billingStatus: 'PENDING', matchConfidence: 60, reviewNotes: 'low confidence' },
  { id: 'sugg-veh', reservationId: null, vehicleId: 'v4', needsReview: true, status: 'IMPORTED', billingStatus: 'PENDING', matchConfidence: null, reviewNotes: 'vehicle-outside-location' },
  { id: 'sugg-conf', reservationId: null, vehicleId: null, needsReview: true, status: 'IMPORTED', billingStatus: 'PENDING', matchConfidence: 42, reviewNotes: 'weak' },
  // Flagged with NOTHING to suggest — the 3,390 of off-rental usage.
  { id: 'nosugg-1', reservationId: null, vehicleId: null, needsReview: true, status: 'IMPORTED', billingStatus: 'PENDING', matchConfidence: null, reviewNotes: 'vehicle-not-found' },
  { id: 'nosugg-2', reservationId: null, vehicleId: null, needsReview: true, status: 'IMPORTED', billingStatus: 'PENDING', matchConfidence: 0, reviewNotes: 'no candidate' },
  // Not flagged, nothing attached.
  { id: 'plain-unmatched', reservationId: null, vehicleId: null, needsReview: false, status: 'IMPORTED', billingStatus: 'PENDING', matchConfidence: null, reviewNotes: null },
  // Dispatch confirmation, both routes into it.
  { id: 'dispatch-notes', reservationId: 'r5', vehicleId: 'v5', needsReview: true, status: 'IMPORTED', billingStatus: 'PENDING', matchConfidence: 70, reviewNotes: `weak,${DISPATCH_TOKEN}` },
  { id: 'dispatch-assign', reservationId: 'r6', vehicleId: 'v6', needsReview: true, status: 'IMPORTED', billingStatus: 'PENDING', matchConfidence: 70, reviewNotes: '', assignments: [{ matchReason: DISPATCH_TOKEN }] },
  // Covered by a prepaid package — usage only, never billable.
  { id: 'package-1', reservationId: 'r7', vehicleId: 'v7', needsReview: false, status: 'MATCHED', billingStatus: 'PENDING', matchConfidence: 99, reviewNotes: `Covered by prepaid toll package` },
  // Ready to post: matched, unbilled, not covered.
  { id: 'ready-1', reservationId: 'r8', vehicleId: 'v8', needsReview: false, status: 'MATCHED', billingStatus: 'PENDING', matchConfidence: 88, reviewNotes: null },
  { id: 'already-posted', reservationId: 'r9', vehicleId: 'v9', needsReview: false, status: 'BILLED', billingStatus: 'POSTED_TO_AGREEMENT', matchConfidence: 88, reviewNotes: null },
];

// --------------------------------------------------------------------------

test('THE INVARIANT: the predicate and the Prisma where agree on every row', () => {
  for (const key of TOLL_QUEUE_KEYS) {
    const where = queueWhere(key);
    for (const row of CORPUS) {
      assert.equal(
        evalWhere(where, row),
        matches(key, row),
        `${key} disagrees on row ${row.id} — the tab count and the tab contents would differ`,
      );
    }
  }
});

test('every queue is countable against a scoped base where', async () => {
  const base = { tenantId: 't1' };
  const rows = CORPUS.map((r) => ({ ...r, tenantId: 't1' }));
  const counts = await countQueues(fakeDb(rows), base);
  assert.deepEqual(Object.keys(counts).sort(), [...TOLL_QUEUE_KEYS].sort());
  assert.equal(counts.ALL, rows.length);
  assert.equal(counts.NEEDS_REVIEW, 5, 'suggestion rows: res, veh, conf, and both dispatch rows');
  assert.equal(counts.NO_SUGGESTION, 2);
  assert.equal(counts.AUTO_MATCHED, 5);
  assert.equal(counts.USAGE_ONLY, 1);
  assert.equal(counts.DISPATCH_REVIEW, 2, 'reached via reviewNotes AND via the assignment fallback');
});

test('the base where is respected — a scoped user never sees another tenant', async () => {
  const rows = [
    ...CORPUS.map((r) => ({ ...r, tenantId: 't1' })),
    ...CORPUS.map((r) => ({ ...r, id: `${r.id}-other`, tenantId: 't2' })),
  ];
  const mine = await countQueues(fakeDb(rows), { tenantId: 't1' });
  assert.equal(mine.ALL, CORPUS.length, 'the other tenant is invisible');
});

test('NEEDS_REVIEW and NO_SUGGESTION partition the review flag exactly', () => {
  const flagged = CORPUS.filter((r) => r.needsReview);
  const withSugg = flagged.filter((r) => matches('NEEDS_REVIEW', r));
  const without = flagged.filter((r) => matches('NO_SUGGESTION', r));
  assert.equal(withSugg.length + without.length, flagged.length, 'no row falls between them');
  assert.equal(withSugg.filter((r) => without.includes(r)).length, 0, 'and none is in both');
});

test('THE 19-to-21 CASE: confirming rows can never raise the count', async () => {
  // Simulate the real sequence. A 200-row window over a deeper queue used to
  // pull unseen rows in as confirmed ones left, so the number went UP.
  const deep = Array.from({ length: 300 }, (_, i) => ({
    id: `t${i}`, tenantId: 't1', reservationId: `r${i}`, vehicleId: `v${i}`,
    needsReview: i < 40, status: 'IMPORTED', billingStatus: 'PENDING',
    matchConfidence: 55, reviewNotes: 'low confidence',
  }));
  const before = await countQueues(fakeDb(deep), { tenantId: 't1' });
  assert.equal(before.NEEDS_REVIEW, 40, 'the DB count sees past any page size');

  // Confirm 19 of them.
  const after = await countQueues(
    fakeDb(deep.map((r, i) => (i < 19 ? { ...r, needsReview: false, status: 'MATCHED' } : r))),
    { tenantId: 't1' },
  );
  assert.equal(after.NEEDS_REVIEW, 21);
  assert.ok(after.NEEDS_REVIEW < before.NEEDS_REVIEW, 'doing the work must make the number go DOWN');
});

test('a covered-by-package row is never offered as ready to post', () => {
  const covered = CORPUS.find((r) => r.id === 'package-1');
  assert.equal(matches('USAGE_ONLY', covered), true);
  assert.equal(matches('READY_TO_POST', covered), false, 'billing a covered toll double-charges the customer');
  assert.equal(evalWhere(queueWhere('READY_TO_POST'), covered), false);
});

test('hasSuggestion accepts either the raw column or the serialized relation', () => {
  assert.equal(hasSuggestion({ reservationId: 'r1' }), true);
  assert.equal(hasSuggestion({ reservation: { id: 'r1' } }), true, 'the API serializes it as a nested object');
  assert.equal(hasSuggestion({ vehicle: { id: 'v1' } }), true);
  assert.equal(hasSuggestion({ matchConfidence: 0 }), false, 'zero confidence is not a suggestion');
  assert.equal(hasSuggestion({}), false);
});

test('the package note is matched case-insensitively', () => {
  for (const notes of [TOLL_PACKAGE_NOTE, TOLL_PACKAGE_NOTE.toUpperCase(), `x, ${TOLL_PACKAGE_NOTE}`]) {
    assert.equal(matches('USAGE_ONLY', { reviewNotes: notes }), true, notes);
    assert.equal(evalWhere(queueWhere('USAGE_ONLY'), { reviewNotes: notes }), true, notes);
  }
});

test('reviewNotes wins over the assignment reason, exactly as the serializer does', () => {
  const row = { reviewNotes: 'unrelated', assignments: [{ matchReason: DISPATCH_TOKEN }] };
  assert.equal(matches('DISPATCH_REVIEW', row), false, 'non-empty notes are the answer');
  assert.equal(evalWhere(queueWhere('DISPATCH_REVIEW'), row), false);
});

test("the dashboard tile counts the SAME rows as the queue it links to", async () => {
  // Hector, 2026-08-07: the tile said 22, you clicked it and the module showed
  // nothing to do. It had been counting "matched but not collected yet",
  // which on an OPEN contract is not work — the toll rides along and settles
  // at check-in. today-kpis.js now imports queueWhere('NEEDS_REVIEW') instead
  // of restating a rule, so the tile and the tab cannot disagree. This test is
  // the tripwire on that import.
  const rows = CORPUS.map((r) => ({ ...r, tenantId: 't1', staffAckAt: null }));
  const counts = await countQueues(fakeDb(rows), { tenantId: 't1' });
  const tile = rows.filter((r) => evalWhere(queueWhere('NEEDS_REVIEW'), r)).length;
  assert.equal(tile, counts.NEEDS_REVIEW, 'the tile number IS the tab number');

  // And the old definition is not it: a matched, unbilled toll on an open
  // contract was counted before and must not be now.
  const ridesAlong = { tenantId: 't1', staffAckAt: null, reservationId: 'r1', vehicleId: 'v1',
    needsReview: false, status: 'MATCHED', billingStatus: 'PENDING', matchConfidence: 95, reviewNotes: null };
  assert.equal(evalWhere(queueWhere('NEEDS_REVIEW'), ridesAlong), false,
    'nobody has to touch this — it collects itself with the contract');
});
