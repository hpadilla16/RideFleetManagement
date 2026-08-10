import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { isSameRentalWindow } from './reservation-extend.service.js';

/**
 * "Already there" is not a change.
 *
 * Measured 2026-08-10 (RES-910342649838): VozIA fired rescheduleReservation
 * THREE times for one spoken request. The writes converged only because the
 * charge-row rebuild is deterministic — d9ad2f6's fix, doing an idempotent
 * job it was never meant to be the last line of defense for. Worse, the
 * deterministic Idempotency-Key on the Valet side could REPLAY a stale
 * "done!" for a change-back (X→Y→X inside the key's 24h TTL) without
 * executing anything, leaving the reservation at Y while the caller was told
 * X. Convergence now lives where the state lives: the handler no-ops with
 * `alreadyApplied` when the requested window already matches the reservation.
 *
 * The predicate is IMPORTED — the house lesson (vozia-reschedule-price-
 * persists.test.mjs, portal amount-due): a local copy goes on passing while
 * the real rule is replaced.
 */

const CURRENT = {
  pickupAt: new Date('2026-08-14T18:00:00Z'),
  returnAt: new Date('2026-08-21T18:00:00Z'),
  pickupLocationId: 'loc-sju'
};

test('same instants, same location — a re-fire no-ops', () => {
  const preview = { pickupAt: '2026-08-14T18:00:00Z', returnAt: '2026-08-21T18:00:00Z' };
  assert.equal(isSameRentalWindow(preview, CURRENT, 'loc-sju'), true);
});

test('spelling differences are NOT differences — the same instant in another format still no-ops', () => {
  // The voice model emits "T14:00" one turn and "T14:00:00" the next for the
  // same spoken request; the old content-hashed key split on exactly this.
  const preview = { pickupAt: '2026-08-14T18:00:00.000Z', returnAt: '2026-08-21T18:00:00.000Z' };
  assert.equal(isSameRentalWindow(preview, CURRENT, 'loc-sju'), true);
});

test('a real date change goes through — one minute of difference is a change', () => {
  const preview = { pickupAt: '2026-08-14T18:01:00Z', returnAt: '2026-08-21T18:00:00Z' };
  assert.equal(isSameRentalWindow(preview, CURRENT, 'loc-sju'), false);
});

test('X→Y→X is a REAL change each time, never a no-op against the wrong state', () => {
  // After moving to Y, asking for X again must execute — this is the exact
  // sequence the old deterministic key answered with a stale replay.
  const atY = { ...CURRENT, pickupAt: new Date('2026-08-15T18:00:00Z'), returnAt: new Date('2026-08-22T18:00:00Z') };
  const backToX = { pickupAt: '2026-08-14T18:00:00Z', returnAt: '2026-08-21T18:00:00Z' };
  assert.equal(isSameRentalWindow(backToX, atY, 'loc-sju'), false);
});

test('same dates but a different pickup location is a change', () => {
  const preview = { pickupAt: '2026-08-14T18:00:00Z', returnAt: '2026-08-21T18:00:00Z' };
  assert.equal(isSameRentalWindow(preview, CURRENT, 'loc-mia'), false);
});

test('no requested location falls back to current — still a no-op', () => {
  const preview = { pickupAt: '2026-08-14T18:00:00Z', returnAt: '2026-08-21T18:00:00Z' };
  assert.equal(isSameRentalWindow(preview, CURRENT, null), true);
});

test('missing or garbage preview echoes fail OPEN to the normal path', () => {
  // Worst case must be the pre-existing behavior (apply + reprice), never a
  // skipped legitimate change.
  assert.equal(isSameRentalWindow({}, CURRENT, 'loc-sju'), false);
  assert.equal(isSameRentalWindow({ pickupAt: 'garbage', returnAt: 'also' }, CURRENT, 'loc-sju'), false);
  assert.equal(isSameRentalWindow({ pickupAt: '2026-08-14T18:00:00Z', returnAt: '2026-08-21T18:00:00Z' }, {}, 'loc-sju'), false);
});

// ── Route wiring — the predicate must run, and run BEFORE the drift check ──
const ROUTE = readFileSync(new URL('./reservations.routes.js', import.meta.url), 'utf8');

test('the reschedule handler consults the predicate before the drift check', () => {
  const handler = ROUTE.slice(ROUTE.indexOf("reservationsRouter.post('/:id/reschedule'"));
  const noopAt = handler.indexOf('isSameRentalWindow(previewOut, current, pickupLocationId)');
  const driftAt = handler.indexOf("code: 'REPRICE_DRIFT'");
  assert.ok(noopAt > 0, 'the handler must call the imported predicate');
  assert.ok(driftAt > 0, 'the drift check must still exist');
  // BEFORE the drift check, deliberately: a re-fire of an applied change with
  // a slightly stale expected total must converge, not 409 — a 409 tells the
  // agent the change failed, and the measured response to that is retrying.
  assert.ok(noopAt < driftAt, 'the no-op must run before REPRICE_DRIFT');
});

test('the no-op response says alreadyApplied and moves nothing', () => {
  const handler = ROUTE.slice(ROUTE.indexOf("reservationsRouter.post('/:id/reschedule'"));
  const noopBlock = handler.slice(
    handler.indexOf('isSameRentalWindow(previewOut, current, pickupLocationId)'),
    handler.indexOf("code: 'REPRICE_DRIFT'")
  );
  assert.match(noopBlock, /alreadyApplied: true/);
  // The block must not call update() or reprice — state is reported, not touched.
  assert.doesNotMatch(noopBlock, /reservationsService\.update|repriceForNewDates/);
});
