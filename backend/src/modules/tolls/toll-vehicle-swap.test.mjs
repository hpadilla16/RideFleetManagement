/**
 * A toll belongs to whoever had THAT car at THAT moment — DB-free.
 *
 * RES-119005 (Hector, 2026-08-08): rented 15 Jun on KKJ-001, swapped to
 * KDY966 on 11 Jul at 3:30 PM, and the contract runs to 15 Sep. It had been
 * billed five KKJ-001 tolls from 25 Jul — a car already returned — AND four
 * KDY966 tolls from June, a car not yet handed over. $13.60 of $14.15 was
 * other customers' money.
 *
 * The responsibility windows were always built correctly. They only ADDED
 * score. A toll whose plate matched still earned +25 for the plate and +25
 * for landing inside a three-month rental window, reached ~50, and was
 * SUGGESTED — then confirmed in bulk.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveReservationResponsibility } from './tolls-responsibility.service.js';

const KKJ = 'veh-kkj001';
const KDY = 'veh-kdy966';

// The real record, to the minute.
const RESERVATION = {
  pickupAt: '2026-06-15T21:10:00.000Z',   // 5:10 PM AST
  returnAt: '2026-09-15T21:10:00.000Z',
  vehicleId: KDY,
  rentalAgreement: {
    vehicleId: KKJ,
    vehicleSwaps: [{
      previousVehicleId: KKJ,
      nextVehicleId: KDY,
      previousCheckedInAt: '2026-07-11T19:30:33.919Z',  // 3:30 PM AST
      nextCheckedOutAt: '2026-07-11T19:30:33.919Z',
      createdAt: '2026-07-11T19:30:34.085Z',
    }],
  },
};

const at = (iso, vehicleId) => resolveReservationResponsibility({
  reservation: RESERVATION, transactionAt: iso, vehicleId,
});

test('the swap produces one window per car, not one for the whole rental', () => {
  const { windows } = at('2026-06-17T16:05:00.000Z', KKJ);
  assert.equal(windows.length, 2);
  assert.equal(windows[0].vehicleId, KKJ);
  assert.equal(windows[1].vehicleId, KDY);
});

test('the one toll that IS his: KKJ-001 on 17 Jun, before the swap', () => {
  const r = at('2026-06-17T16:05:00.000Z', KKJ);
  assert.equal(r.withinEffectiveWindow, true);
  assert.equal(r.contradictsHeldVehicle, false, '$0.55 — the only correct row');
});

test('KDY966 tolls dated BEFORE the swap are not his', () => {
  // He had not been handed that car yet. $1.00 + $1.70 + $1.10.
  for (const iso of ['2026-06-25T12:23:00.000Z', '2026-07-09T10:46:00.000Z', '2026-07-09T10:54:00.000Z']) {
    const r = at(iso, KDY);
    assert.equal(r.contradictsHeldVehicle, true, iso);
    assert.equal(r.heldVehicleId, KKJ, 'he was driving KKJ-001 that day');
  }
});

test('THE SAME-DAY CASE: 11 Jul 11:58 AM is before the 3:30 PM swap', () => {
  // $4.00, the largest single row. A day-granular rule would have kept it.
  const r = at('2026-07-11T15:58:00.000Z', KDY);
  assert.equal(r.contradictsHeldVehicle, true, 'the swap had not happened yet');
  assert.equal(r.heldVehicleId, KKJ);
  // And minutes after the swap, the same car IS his.
  assert.equal(at('2026-07-11T19:45:00.000Z', KDY).contradictsHeldVehicle, false);
});

test('KKJ-001 tolls dated AFTER the swap are not his either', () => {
  // The car went back to the fleet on 11 Jul; these are 25 Jul. $5.80.
  const r = at('2026-07-25T14:27:00.000Z', KKJ);
  assert.equal(r.contradictsHeldVehicle, true);
  assert.equal(r.heldVehicleId, KDY, 'he was driving KDY966 by then');
});

test('the rule fires only on a POSITIVE contradiction', () => {
  // Outside every window — a grace-period toll after return. Nothing is known
  // to contradict it, so behaviour is unchanged and it is NOT disqualified.
  const after = at('2026-09-15T21:40:00.000Z', KDY);
  assert.equal(after.heldVehicleId, null);
  assert.equal(after.contradictsHeldVehicle, false, 'grace-window matches must survive');

  // A rental that never changed cars has no timeline to be wrong about. A car
  // that does not match there is a data gap (handed over without a recorded
  // swap), not proof — disqualifying it would bury real work in "no
  // candidate". Ordinary rentals keep their exact previous behaviour.
  const single = resolveReservationResponsibility({
    reservation: { pickupAt: '2026-06-15T21:10:00.000Z', returnAt: '2026-06-20T21:10:00.000Z', vehicleId: KKJ },
    transactionAt: '2026-06-17T16:05:00.000Z', vehicleId: KDY,
  });
  assert.equal(single.contradictsHeldVehicle, false, 'only a recorded swap is evidence enough');
});

test('a toll from a car that was never on this rental is still caught', () => {
  const r = at('2026-06-25T12:23:00.000Z', 'veh-someone-else');
  assert.equal(r.contradictsHeldVehicle, true, 'the rental held KKJ-001, not this car');
});

test('with no vehicle resolved, nothing is disqualified', () => {
  assert.equal(at('2026-06-25T12:23:00.000Z', null).contradictsHeldVehicle, false);
});
