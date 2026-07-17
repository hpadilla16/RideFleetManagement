/**
 * Mandatory swap photos — pure gate logic (2026-07-16).
 *
 * Hector's rule: 8 standard photos per car, both cars (16 total), HARD BLOCK with
 * no override. This module is the client-side mirror of the backend gate in
 * `backend/src/modules/reservations/swap-photos.js`. The backend is the real gate;
 * this exists so the UI can disable submit and say exactly what is missing and
 * FROM WHICH CAR instead of surprising the employee with an error at the end.
 *
 * Pure + framework-free so it can be unit-tested with `node --test`.
 */

/** The app's standard 8 slots — identical set/order as the inspection wizard. */
export const SWAP_PHOTO_SLOTS = Object.freeze([
  'front',
  'rear',
  'left',
  'right',
  'frontSeat',
  'rearSeat',
  'dashboard',
  'trunk'
]);

export const PHOTOS_PER_VEHICLE = SWAP_PHOTO_SLOTS.length; // 8
export const PHOTOS_TOTAL = PHOTOS_PER_VEHICLE * 2; // 16

export function emptySwapPhotos() {
  const out = {};
  for (const slot of SWAP_PHOTO_SLOTS) out[slot] = '';
  return out;
}

/** Slots with no photo yet, in canonical order. */
export function missingSlots(photos) {
  return SWAP_PHOTO_SLOTS.filter((slot) => !photos?.[slot]);
}

export function filledCount(photos) {
  return PHOTOS_PER_VEHICLE - missingSlots(photos).length;
}

export function isVehicleComplete(photos) {
  return missingSlots(photos).length === 0;
}

/**
 * The whole gate in one call.
 *
 * @param {object} previousPhotos - photos of the car coming back
 * @param {object} nextPhotos     - photos of the car being handed over
 * @returns {{
 *   previousFilled:number, nextFilled:number, total:number,
 *   previousMissing:string[], nextMissing:string[],
 *   previousComplete:boolean, nextComplete:boolean, complete:boolean
 * }}
 */
export function swapPhotoGate(previousPhotos, nextPhotos) {
  const previousMissing = missingSlots(previousPhotos);
  const nextMissing = missingSlots(nextPhotos);
  const previousFilled = PHOTOS_PER_VEHICLE - previousMissing.length;
  const nextFilled = PHOTOS_PER_VEHICLE - nextMissing.length;
  return {
    previousFilled,
    nextFilled,
    total: previousFilled + nextFilled,
    previousMissing,
    nextMissing,
    previousComplete: previousMissing.length === 0,
    nextComplete: nextMissing.length === 0,
    complete: previousMissing.length === 0 && nextMissing.length === 0
  };
}

/**
 * SW-2's rule: don't scold from second zero. A car's empty slots only turn red
 * once the employee has attempted to submit, OR once the OTHER car is already
 * complete (at which point the missing ones are genuinely the blocker).
 */
export function shouldFlagMissing({ attempted, otherComplete }) {
  return Boolean(attempted || otherComplete);
}

/**
 * Every precondition of a swap, in the order the employee works. Ordered so the
 * FIRST blocker is the one to fix next.
 */
export const SWAP_BLOCKERS = Object.freeze({
  VEHICLE: 'vehicle',
  PHOTOS: 'photos',
  ODOMETER_CURRENT: 'odometerCurrent',
  ODOMETER_NEXT: 'odometerNext'
});

/** An odometer reading is present if it's a non-empty string. "0" counts. */
function hasReading(value) {
  return String(value ?? '').trim() !== '';
}

/**
 * GD-4: readiness is EVERY precondition submit() enforces — not just photos.
 *
 * The bug this fixes: the photo gate alone drove the footer and the button, so
 * at 16/16 with an empty odometer the footer said "Ready to swap", the button
 * enabled, and the tap threw "Odometer is required" — the surprise-error-at-the-
 * end the approved mockup explicitly forbids ("nada de un error sorpresa al
 * final"). A disabled button must always explain itself.
 *
 * This deliberately WRAPS `swapPhotoGate` rather than changing it: the 16/16
 * hard block and shouldFlagMissing semantics are correct and stay untouched.
 *
 * `blockedOnlyByPhotos` is what the ADMIN override (2026-07-17) is allowed to
 * act on: the override bypasses the PHOTO requirement and NOTHING else, so an
 * admin with no replacement car selected or a blank odometer is still blocked —
 * mirroring the backend, where those rules run before and after the photo gate
 * regardless of the override (planner `force` semantics, beta.311).
 *
 * @returns {{ ready:boolean, blockers:string[], first:string|null, blockedOnlyByPhotos:boolean }}
 */
export function swapReadiness({ vehicleSelected, photosComplete, currentOdometer, nextOdometer } = {}) {
  const blockers = [];
  if (!vehicleSelected) blockers.push(SWAP_BLOCKERS.VEHICLE);
  if (!photosComplete) blockers.push(SWAP_BLOCKERS.PHOTOS);
  if (!hasReading(currentOdometer)) blockers.push(SWAP_BLOCKERS.ODOMETER_CURRENT);
  if (!hasReading(nextOdometer)) blockers.push(SWAP_BLOCKERS.ODOMETER_NEXT);
  return {
    ready: blockers.length === 0,
    blockers,
    first: blockers[0] || null,
    blockedOnlyByPhotos: blockers.length === 1 && blockers[0] === SWAP_BLOCKERS.PHOTOS
  };
}
