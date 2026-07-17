/**
 * Unit tests for the client-side 16/16 swap-photo gate (2026-07-16).
 * Pure — mirrors the backend gate, which is the authoritative one.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PHOTOS_PER_VEHICLE,
  PHOTOS_TOTAL,
  SWAP_BLOCKERS,
  SWAP_PHOTO_SLOTS,
  emptySwapPhotos,
  filledCount,
  isVehicleComplete,
  missingSlots,
  shouldFlagMissing,
  swapPhotoGate,
  swapReadiness
} from './swap-photos.js';

const full = () => Object.fromEntries(SWAP_PHOTO_SLOTS.map((s) => [s, 'data:image/jpeg;base64,AAAA']));

test('slots match the backend contract exactly', () => {
  assert.deepEqual(SWAP_PHOTO_SLOTS, ['front', 'rear', 'left', 'right', 'frontSeat', 'rearSeat', 'dashboard', 'trunk']);
  assert.equal(PHOTOS_PER_VEHICLE, 8);
  assert.equal(PHOTOS_TOTAL, 16);
});

test('emptySwapPhotos starts at 0/8 with every slot missing', () => {
  const photos = emptySwapPhotos();
  assert.equal(filledCount(photos), 0);
  assert.equal(isVehicleComplete(photos), false);
  assert.deepEqual(missingSlots(photos), SWAP_PHOTO_SLOTS.slice());
});

test('SW-1: nothing captured -> 0/16, blocked', () => {
  const gate = swapPhotoGate(emptySwapPhotos(), emptySwapPhotos());
  assert.equal(gate.total, 0);
  assert.equal(gate.complete, false);
  assert.equal(gate.previousMissing.length, 8);
  assert.equal(gate.nextMissing.length, 8);
});

test('SW-2: 11/16 -> still blocked, and it knows the 5 are the replacement car', () => {
  const next = full();
  for (const slot of ['right', 'frontSeat', 'rearSeat', 'dashboard', 'trunk']) next[slot] = '';
  const gate = swapPhotoGate(full(), next);
  assert.equal(gate.total, 11);
  assert.equal(gate.complete, false);
  assert.equal(gate.previousComplete, true);
  assert.deepEqual(gate.nextMissing, ['right', 'frontSeat', 'rearSeat', 'dashboard', 'trunk']);
});

test('SW-3: 16/16 -> complete', () => {
  const gate = swapPhotoGate(full(), full());
  assert.equal(gate.total, 16);
  assert.equal(gate.complete, true);
  assert.equal(gate.previousMissing.length, 0);
  assert.equal(gate.nextMissing.length, 0);
});

test('15/16 is NOT complete — hard block, no rounding', () => {
  const next = full();
  next.trunk = '';
  assert.equal(swapPhotoGate(full(), next).complete, false);
});

test("SW-2's rule: don't scold from second zero", () => {
  // Fresh page, employee has captured nothing and clicked nothing.
  assert.equal(shouldFlagMissing({ attempted: false, otherComplete: false }), false);
  // After a submit attempt, show exactly what is missing.
  assert.equal(shouldFlagMissing({ attempted: true, otherComplete: false }), true);
  // Or once the other car is done, the gaps here are genuinely the blocker.
  assert.equal(shouldFlagMissing({ attempted: false, otherComplete: true }), true);
});

// ── GD-4: the disabled button must always explain itself ────────────────────

const ready = { vehicleSelected: true, photosComplete: true, currentOdometer: '34120', nextOdometer: '18200' };

test('GD-4: all preconditions met -> ready, no blockers', () => {
  const r = swapReadiness({ ...ready });
  assert.equal(r.ready, true);
  assert.deepEqual(r.blockers, []);
  assert.equal(r.first, null);
});

test('GD-4 REGRESSION: 16/16 photos but no odometer is NOT ready', () => {
  // The exact bug: the photo gate said complete, the footer said "Ready to
  // swap", the button enabled, and the tap threw "Odometer is required".
  const r = swapReadiness({ ...ready, currentOdometer: '' });
  assert.equal(r.ready, false, 'photos alone must never mean ready');
  assert.equal(r.first, SWAP_BLOCKERS.ODOMETER_CURRENT, 'and it must say WHICH odometer');

  const n = swapReadiness({ ...ready, nextOdometer: '' });
  assert.equal(n.ready, false);
  assert.equal(n.first, SWAP_BLOCKERS.ODOMETER_NEXT);
});

test('GD-4: no replacement vehicle selected is NOT ready, and is the first thing to fix', () => {
  const r = swapReadiness({ ...ready, vehicleSelected: false });
  assert.equal(r.ready, false);
  assert.equal(r.first, SWAP_BLOCKERS.VEHICLE);
});

test('GD-4: photos remain a blocker — the 16/16 hard block is untouched', () => {
  const r = swapReadiness({ ...ready, photosComplete: false });
  assert.equal(r.ready, false);
  assert.equal(r.first, SWAP_BLOCKERS.PHOTOS);
});

test('GD-4: blockers are ordered the way the employee works, first = fix next', () => {
  const r = swapReadiness({ vehicleSelected: false, photosComplete: false, currentOdometer: '', nextOdometer: '' });
  assert.deepEqual(r.blockers, [
    SWAP_BLOCKERS.VEHICLE,
    SWAP_BLOCKERS.PHOTOS,
    SWAP_BLOCKERS.ODOMETER_CURRENT,
    SWAP_BLOCKERS.ODOMETER_NEXT
  ]);
  assert.equal(r.first, SWAP_BLOCKERS.VEHICLE);
});

test('GD-4: an odometer of "0" is a real reading, not a missing one', () => {
  const r = swapReadiness({ ...ready, currentOdometer: '0', nextOdometer: '0' });
  assert.equal(r.ready, true, '"0" is falsy in JS but is a legitimate odometer');
});

test('GD-4: whitespace is not a reading', () => {
  assert.equal(swapReadiness({ ...ready, currentOdometer: '   ' }).first, SWAP_BLOCKERS.ODOMETER_CURRENT);
});

// ── ADMIN photo override (2026-07-17) ───────────────────────────────────────
// `blockedOnlyByPhotos` is the ONLY thing the override may act on. It exists so
// the UI cannot let an admin "override" their way past a missing car or a blank
// odometer — the override clears the PHOTO rule and nothing else, exactly as on
// the backend (planner `force` semantics, beta.311: bypass rules, never occupancy).

test('override: photos-only is the one state an override may act on', () => {
  const r = swapReadiness({ ...ready, photosComplete: false });
  assert.equal(r.ready, false);
  assert.equal(r.blockedOnlyByPhotos, true);
});

test('override: a missing vehicle is NOT overridable, even with photos missing too', () => {
  const r = swapReadiness({ ...ready, photosComplete: false, vehicleSelected: false });
  assert.equal(r.blockedOnlyByPhotos, false, 'no car selected is not a photo problem');
});

test('override: a missing odometer is NOT overridable', () => {
  for (const patch of [{ currentOdometer: '' }, { nextOdometer: '' }, { currentOdometer: '  ' }]) {
    const r = swapReadiness({ ...ready, photosComplete: false, ...patch });
    assert.equal(r.blockedOnlyByPhotos, false, `odometer ${JSON.stringify(patch)} must still block`);
  }
});

test('override: a fully ready swap is not "blocked only by photos" — there is nothing to override', () => {
  const r = swapReadiness({ ...ready });
  assert.equal(r.ready, true);
  assert.equal(r.blockedOnlyByPhotos, false);
});
