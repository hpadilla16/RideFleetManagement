import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DISPATCH_CONFIRMATION_REVIEW_CATEGORY,
  appendReviewCategory,
  buildReservationVehicleResponsibilityWindows,
  clearDispatchConfirmationReview,
  inferReviewCategory,
  resolveReservationResponsibility,
  reservationReferencesVehicle
} from './tolls-responsibility.service.js';

test('buildReservationVehicleResponsibilityWindows creates swap-aware windows', () => {
  const reservation = {
    status: 'CHECKED_OUT',
    pickupAt: new Date('2026-04-07T10:00:00.000Z'),
    returnAt: new Date('2026-04-10T10:00:00.000Z'),
    vehicleId: 'veh-current',
    rentalAgreement: {
      vehicleId: 'veh-original',
      finalizedAt: new Date('2026-04-07T10:15:00.000Z'),
      vehicleSwaps: [
        {
          previousVehicleId: 'veh-original',
          nextVehicleId: 'veh-current',
          previousCheckedInAt: new Date('2026-04-08T14:00:00.000Z'),
          nextCheckedOutAt: new Date('2026-04-08T14:00:00.000Z'),
          createdAt: new Date('2026-04-08T14:00:00.000Z')
        }
      ]
    }
  };

  const windows = buildReservationVehicleResponsibilityWindows(reservation);
  assert.equal(windows.length, 2);
  assert.deepEqual(
    windows.map((row) => ({
      vehicleId: row.vehicleId,
      startAt: row.startAt.toISOString(),
      endAt: row.endAt.toISOString(),
      dispatchConfirmationRequired: row.dispatchConfirmationRequired
    })),
    [
      {
        vehicleId: 'veh-original',
        startAt: '2026-04-07T10:15:00.000Z',
        endAt: '2026-04-08T14:00:00.000Z',
        dispatchConfirmationRequired: false
      },
      {
        vehicleId: 'veh-current',
        startAt: '2026-04-08T14:00:00.000Z',
        endAt: '2026-04-10T10:00:00.000Z',
        dispatchConfirmationRequired: false
      }
    ]
  );
});

test('resolveReservationResponsibility flags dispatch confirmation when tolls happen before formal checkout', () => {
  const reservation = {
    status: 'CONFIRMED',
    pickupAt: new Date('2026-04-07T10:00:00.000Z'),
    returnAt: new Date('2026-04-09T10:00:00.000Z'),
    vehicleId: 'veh-1',
    readyForPickupAt: new Date('2026-04-07T09:45:00.000Z'),
    rentalAgreement: {
      vehicleId: 'veh-1',
      finalizedAt: null,
      vehicleSwaps: []
    }
  };

  const responsibility = resolveReservationResponsibility({
    reservation,
    vehicleId: 'veh-1',
    transactionAt: new Date('2026-04-07T12:00:00.000Z')
  });

  assert.equal(responsibility.withinEffectiveWindow, true);
  assert.equal(responsibility.dispatchConfirmationRequired, true);
  assert.equal(responsibility.reviewCategory, DISPATCH_CONFIRMATION_REVIEW_CATEGORY);
});

test('reservationReferencesVehicle recognizes vehicles from swap history', () => {
  const reservation = {
    status: 'CHECKED_OUT',
    pickupAt: new Date('2026-04-07T10:00:00.000Z'),
    returnAt: new Date('2026-04-10T10:00:00.000Z'),
    vehicleId: 'veh-current',
    rentalAgreement: {
      vehicleId: 'veh-original',
      finalizedAt: new Date('2026-04-07T10:15:00.000Z'),
      vehicleSwaps: [
        {
          previousVehicleId: 'veh-original',
          nextVehicleId: 'veh-current',
          previousCheckedInAt: new Date('2026-04-08T14:00:00.000Z'),
          nextCheckedOutAt: new Date('2026-04-08T14:00:00.000Z')
        }
      ]
    }
  };

  assert.equal(reservationReferencesVehicle(reservation, 'veh-original'), true);
  assert.equal(reservationReferencesVehicle(reservation, 'veh-current'), true);
  assert.equal(reservationReferencesVehicle(reservation, 'veh-missing'), false);
});

test('review category helpers round-trip dispatch confirmation token', () => {
  const reason = appendReviewCategory('vehicleResponsibilityWindow', DISPATCH_CONFIRMATION_REVIEW_CATEGORY);
  assert.match(reason, /dispatch-confirmation-required/);
  assert.equal(inferReviewCategory(reason), DISPATCH_CONFIRMATION_REVIEW_CATEGORY);
  assert.equal(clearDispatchConfirmationReview(reason), 'vehicleResponsibilityWindow');
});
