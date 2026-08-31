/**
 * Tolls phase 2 — the evidence pane's "losing candidate" data. DB-free.
 *
 * serializeCandidateAssignments turns the assignment history the dashboard
 * query ALREADY loads into candidate summaries for the drawer: superseded
 * suggestions that point at a DIFFERENT reservation than the current one.
 * The rules under test:
 *   - assignments[0] (the latest) is never a candidate — it IS the suggestion;
 *   - prior assignments on the SAME reservation are noise (re-writes from the
 *     sweep), not candidates;
 *   - candidates are deduped per reservation and capped at 3;
 *   - assignments with no reservation attached are skipped;
 *   - the shape is additive: nothing existing in serializeTransaction moves.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { serializeCandidateAssignments } from './tolls.service.js';

const RES_A = { id: 'res-a', reservationNumber: 'TL-A', pickupAt: '2026-08-24T13:00:00Z', returnAt: '2026-08-29T13:00:00Z' };
const RES_B = { id: 'res-b', reservationNumber: 'TL-B', pickupAt: '2026-08-10T13:00:00Z', returnAt: '2026-08-24T09:12:00Z' };
const RES_C = { id: 'res-c', reservationNumber: 'TL-C', pickupAt: '2026-09-01T13:00:00Z', returnAt: '2026-09-05T13:00:00Z' };

function assignment(id, reservation, extra = {}) {
  return { id, status: 'REJECTED', confidence: 41, matchReason: 'plate,withinGraceWindow', reservation, ...extra };
}

test('no history → no candidates (empty, single, missing)', () => {
  assert.deepEqual(serializeCandidateAssignments(), []);
  assert.deepEqual(serializeCandidateAssignments([]), []);
  assert.deepEqual(serializeCandidateAssignments([assignment('a1', RES_A, { status: 'SUGGESTED' })]), []);
});

test('a superseded suggestion on ANOTHER reservation becomes the losing candidate', () => {
  const out = serializeCandidateAssignments([
    assignment('a2', RES_A, { status: 'SUGGESTED', confidence: 92 }),
    assignment('a1', RES_B)
  ]);
  assert.equal(out.length, 1);
  assert.deepEqual(out[0], {
    id: 'a1',
    status: 'REJECTED',
    confidence: 41,
    matchReason: 'plate,withinGraceWindow',
    reservation: { id: 'res-b', reservationNumber: 'TL-B', pickupAt: RES_B.pickupAt, returnAt: RES_B.returnAt }
  });
});

test('prior assignments on the SAME reservation are sweep re-writes, not candidates', () => {
  const out = serializeCandidateAssignments([
    assignment('a3', RES_A, { status: 'SUGGESTED', confidence: 92 }),
    assignment('a2', RES_A),
    assignment('a1', RES_B)
  ]);
  assert.deepEqual(out.map((c) => c.id), ['a1']);
});

test('candidates dedupe per reservation and cap at 3', () => {
  const RES_D = { ...RES_B, id: 'res-d', reservationNumber: 'TL-D' };
  const RES_E = { ...RES_B, id: 'res-e', reservationNumber: 'TL-E' };
  const out = serializeCandidateAssignments([
    assignment('a9', RES_A, { status: 'SUGGESTED' }),
    assignment('a8', RES_B),
    assignment('a7', RES_B), // dupe reservation — dropped
    assignment('a6', RES_C),
    assignment('a5', RES_D),
    assignment('a4', RES_E) // beyond the cap of 3
  ]);
  assert.deepEqual(out.map((c) => c.reservation.id), ['res-b', 'res-c', 'res-d']);
});

test('assignments without a reservation are skipped, confidence normalizes to number or null', () => {
  const out = serializeCandidateAssignments([
    assignment('a3', RES_A, { status: 'SUGGESTED' }),
    assignment('a2', null),
    assignment('a1', RES_B, { confidence: '55' }),
    assignment('a0', RES_C, { confidence: null })
  ]);
  assert.deepEqual(out.map((c) => [c.id, c.confidence]), [['a1', 55], ['a0', null]]);
});
