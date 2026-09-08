/**
 * Source-side cancellations and modifications reaching RFM (2026-09-08).
 *
 * The load-bearing rule is the one about a rental that has already STARTED: a
 * scraper reading a web page does not get to cancel a car that is out, or move
 * the return date of one somebody is driving. Everything else here pins that
 * the note is written anyway, so nothing is silently dropped.
 *
 * No DB: a fake reservation client records the update it was handed.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

const {
  diffStagedRow, buildChangeNote, appendNote, applySourceChange, CHANGE_NOTE_PREFIX,
} = await import('./source-changes.js');

function fakeDb(row, capture = {}) {
  return {
    capture,
    reservation: {
      findUnique: async () => row,
      update: async (args) => { capture.update = args; return { ...row, ...args.data }; },
    },
  };
}

const ARGS = { reservationId: 'r1', sourceName: 'MEX', externalRef: 'JMX0004361' };

// ---------------------------------------------------------------------------
// diffStagedRow
// ---------------------------------------------------------------------------
test('diff: reports only what actually moved', () => {
  const before = {
    pickupAt: new Date('2026-09-11T14:00:00Z'),
    dropoffAt: new Date('2026-09-14T14:00:00Z'),
    vehicleAcriss: 'ICAR', totalAmount: 120,
  };
  const after = { ...before, dropoffAt: new Date('2026-09-16T14:00:00Z'), totalAmount: 180 };
  const d = diffStagedRow(before, after);
  assert.deepEqual(d.map((c) => c.field), ['dropoffAt', 'totalAmount']);
});

test('diff: 44 and "44.00" are the same money, not a change', () => {
  assert.deepEqual(diffStagedRow({ totalAmount: 44 }, { totalAmount: '44.00' }), []);
});

test('diff: equal dates in different representations are not a change', () => {
  const a = new Date('2026-09-11T14:00:00Z');
  assert.deepEqual(diffStagedRow({ pickupAt: a }, { pickupAt: '2026-09-11T14:00:00.000Z' }), []);
});

test('diff: a field ABSENT from the incoming row is never reported as cleared', () => {
  // The source sent no class this sweep. That is silence, not "the class was
  // removed" — reporting it would tell an agent the booking changed when the
  // only thing that changed is what the scraper could read.
  const d = diffStagedRow({ vehicleAcriss: 'ICAR', totalAmount: 90 }, { totalAmount: 90 });
  assert.deepEqual(d, []);

  // But a field the source DID send, against one we never had, is a real change.
  assert.deepEqual(
    diffStagedRow({ vehicleAcriss: 'ICAR' }, { totalAmount: 1 }).map((c) => c.field),
    ['totalAmount'],
  );
});

test('diff: null to a value, and a value to null, both count', () => {
  assert.equal(diffStagedRow({ totalAmount: null }, { totalAmount: 90 }).length, 1);
  assert.equal(diffStagedRow({ totalAmount: 90 }, { totalAmount: null }).length, 1);
});

// ---------------------------------------------------------------------------
// The rule that matters
// ---------------------------------------------------------------------------
test('CONFIRMED + cancelled at source: RFM cancels it and says who did', async () => {
  const db = fakeDb({ id: 'r1', status: 'CONFIRMED', notes: null });
  const out = await applySourceChange(db, { ...ARGS, cancelledAtSource: true });

  assert.equal(out.cancelled, true);
  assert.equal(db.capture.update.data.status, 'CANCELLED');
  const note = db.capture.update.data.notes;
  assert.ok(note.startsWith(CHANGE_NOTE_PREFIX));
  assert.match(note, /MEX JMX0004361/);
  assert.match(note, /cancelled at the source/);
  assert.ok(db.capture.update.data.notesUpdatedAt instanceof Date);
});

test('CHECKED_OUT + cancelled at source: the car is out, so the status does NOT move', async () => {
  const db = fakeDb({ id: 'r1', status: 'CHECKED_OUT', notes: null });
  const out = await applySourceChange(db, { ...ARGS, cancelledAtSource: true });

  assert.equal(out.blocked, true);
  assert.equal(out.cancelled, false);
  assert.equal('status' in db.capture.update.data, false, 'a rental in progress is never cancelled by a scraper');
  assert.match(db.capture.update.data.notes, /already started/);
});

test('every other in-progress status is equally protected', async () => {
  for (const status of ['CHECKED_IN', 'CHECKED_IN_UNPAID', 'NO_SHOW', 'PENDING_FRANCHISE_IMPORT']) {
    const db = fakeDb({ id: 'r1', status, notes: null });
    await applySourceChange(db, { ...ARGS, cancelledAtSource: true });
    assert.equal('status' in db.capture.update.data, false, `${status} must not be auto-cancelled`);
  }
});

test('already CANCELLED in RFM: nothing is written, so the note cannot grow every sweep', async () => {
  const db = fakeDb({ id: 'r1', status: 'CANCELLED', notes: 'x' });
  const out = await applySourceChange(db, { ...ARGS, cancelledAtSource: true });
  assert.equal(out.applied, false);
  assert.equal(db.capture.update, undefined);
});

test('a modification before pickup is noted with the actual before/after values', async () => {
  const db = fakeDb({ id: 'r1', status: 'CONFIRMED', notes: null });
  await applySourceChange(db, {
    ...ARGS,
    changes: [
      { field: 'dropoffAt', label: 'return', from: new Date('2026-09-14T14:00:00Z'), to: new Date('2026-09-16T14:00:00Z') },
      { field: 'totalAmount', label: 'total', from: 120, to: 180 },
    ],
  });
  const note = db.capture.update.data.notes;
  assert.match(note, /return 2026-09-14 14:00 -> 2026-09-16 14:00/);
  assert.match(note, /total 120 -> 180/);
  assert.equal('status' in db.capture.update.data, false, 'a modification never changes status');
});

test('a modification after pickup is recorded but explicitly not applied', async () => {
  const db = fakeDb({ id: 'r1', status: 'CHECKED_OUT', notes: null });
  const out = await applySourceChange(db, {
    ...ARGS, changes: [{ field: 'dropoffAt', label: 'return', from: 1, to: 2 }],
  });
  assert.equal(out.blocked, true);
  assert.match(db.capture.update.data.notes, /already started/);
});

test('notes are appended, never replaced', () => {
  assert.equal(appendNote('older line', 'new line'), 'older line\nnew line');
  assert.equal(appendNote('', 'new line'), 'new line');
  assert.equal(appendNote(null, 'new line'), 'new line');
});

test('appending preserves what a human wrote', async () => {
  const db = fakeDb({ id: 'r1', status: 'CONFIRMED', notes: 'Customer called, arriving late.' });
  await applySourceChange(db, { ...ARGS, cancelledAtSource: true });
  assert.match(db.capture.update.data.notes, /^Customer called, arriving late\.\n\[source\]/);
});

test('nothing to say means nothing is written', async () => {
  const db = fakeDb({ id: 'r1', status: 'CONFIRMED', notes: null });
  const out = await applySourceChange(db, { ...ARGS, cancelledAtSource: false, changes: [] });
  assert.equal(out.applied, false);
  assert.equal(db.capture.update, undefined);
});

test('a failure never throws into the import', async () => {
  const boom = { reservation: { findUnique: async () => { throw new Error('pool timeout'); } } };
  assert.deepEqual(
    await applySourceChange(boom, { ...ARGS, cancelledAtSource: true }),
    { applied: false, blocked: false, cancelled: false, noted: false },
  );
  assert.equal((await applySourceChange(null, { ...ARGS, cancelledAtSource: true })).applied, false);
  assert.equal((await applySourceChange(fakeDb(null), { ...ARGS, cancelledAtSource: true })).applied, false);
});

test('the note line is greppable and dated', () => {
  const line = buildChangeNote({
    sourceName: 'Economy', externalRef: 'E1', kind: 'CANCELLED', at: new Date('2026-09-08T15:30:00Z'),
  });
  assert.equal(line, '[source] 2026-09-08 15:30 Economy E1: cancelled at the source.');
});

// ---------------------------------------------------------------------------
// isDeadSourceStatus — each portal spells it differently (2026-09-08).
// Economy's RezLight grid says ACT / CAN (and VOR twice in 3,000 rows); MEX's
// T&M report says CANCELLED / NO SHOW. One answer, so the next source that
// gains a signal does not grow a fourth private list.
// ---------------------------------------------------------------------------
const { isDeadSourceStatus } = await import('./source-changes.js');

test('dead status: every spelling the portals actually use', () => {
  for (const v of ['CAN', 'can', ' Can ', 'CANCELLED', 'CANCELED', 'VOR', 'VOID', 'NO SHOW', 'NO_SHOW', 'NOSHOW']) {
    assert.equal(isDeadSourceStatus(v), true, `${JSON.stringify(v)} means the booking is dead`);
  }
});

test('dead status: a live booking, and absence, are never dead', () => {
  for (const v of ['ACT', 'CONFIRMED', 'OK', '1', 'active']) {
    assert.equal(isDeadSourceStatus(v), false, `${JSON.stringify(v)} must not read as cancelled`);
  }
  // Absence is NOT a cancellation. Treating a missing status as dead would
  // cancel every booking from a source that simply does not send one.
  for (const v of [null, undefined, '', '   ', 0]) {
    assert.equal(isDeadSourceStatus(v), false);
  }
});

test('dead status: a word that merely CONTAINS "can" is not a cancellation', () => {
  for (const v of ['CANDIDATE', 'CANCUN', 'SCAN']) {
    assert.equal(isDeadSourceStatus(v), false, `${v} is not a status meaning cancelled`);
  }
});
