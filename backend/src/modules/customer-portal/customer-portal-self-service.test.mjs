import test from 'node:test';
import assert from 'node:assert/strict';

import { buildSelfServiceSnapshot } from './customer-portal-self-service.js';

const reservation = {
  pickupAt: '2026-04-08T14:00:00.000Z',
  returnAt: '2026-04-11T00:30:00.000Z',
  pickupLocation: {
    name: 'SJU',
    locationConfig: JSON.stringify({
      pickupInstructions: 'Meet at bay 3.',
      operationsOpenTime: '08:00',
      operationsCloseTime: '18:00',
      weeklyHours: {
        wednesday: { enabled: true, open: '08:00', close: '18:00' },
        friday: { enabled: true, open: '08:00', close: '18:00' }
      }
    })
  },
  returnLocation: {
    name: 'SJU',
    locationConfig: JSON.stringify({
      dropoffInstructions: 'Return keys to the after-hours drop slot.',
      operationsOpenTime: '08:00',
      operationsCloseTime: '18:00',
      weeklyHours: {
        wednesday: { enabled: true, open: '08:00', close: '18:00' },
        friday: { enabled: true, open: '08:00', close: '18:00' }
      }
    })
  }
};

test('buildSelfServiceSnapshot marks pickup blocked when required steps are incomplete', () => {
  const snapshot = buildSelfServiceSnapshot({
    reservation,
    selfServiceConfig: {
      enabled: true,
      allowPickup: true,
      allowDropoff: true,
      requirePrecheckinForPickup: true,
      requireSignatureForPickup: true,
      requirePaymentForPickup: true,
      allowAfterHoursPickup: false,
      allowAfterHoursDropoff: true,
      keyExchangeMode: 'LOCKBOX',
      supportPhone: '(787) 555-1010'
    },
    confirmations: {},
    customerInfoComplete: true,
    signatureComplete: false,
    paymentComplete: false
  });

  assert.equal(snapshot.status, 'BLOCKED');
  assert.equal(snapshot.readyForPickup, false);
  assert.equal(snapshot.keyExchangeLabel, 'Lockbox pickup/drop-off');
  assert.deepEqual(snapshot.pickup.blockers, [
    'Agreement signature must be completed before pickup.',
    'Payment must be completed before pickup.'
  ]);
});

test('buildSelfServiceSnapshot marks after-hours drop-off attention in advisory mode', () => {
  const snapshot = buildSelfServiceSnapshot({
    reservation,
    selfServiceConfig: {
      enabled: true,
      allowPickup: true,
      allowDropoff: true,
      requirePrecheckinForPickup: true,
      requireSignatureForPickup: true,
      requirePaymentForPickup: true,
      allowAfterHoursPickup: false,
      allowAfterHoursDropoff: false,
      readinessMode: 'ADVISORY',
      keyExchangeMode: 'DESK'
    },
    confirmations: {},
    customerInfoComplete: true,
    signatureComplete: true,
    paymentComplete: true
  });

  assert.equal(snapshot.status, 'ATTENTION');
  assert.equal(snapshot.readyForPickup, true);
  assert.equal(snapshot.readyForDropoff, false);
  assert.equal(snapshot.dropoff.afterHours, true);
  assert.equal(snapshot.dropoff.blockers[0], 'Drop-off is outside configured operating hours.');
  assert.equal(snapshot.pickup.instructions, 'Meet at bay 3.');
});

test('buildSelfServiceSnapshot prefers location overrides and exposes confirmation affordances', () => {
  const snapshot = buildSelfServiceSnapshot({
    reservation: {
      ...reservation,
      pickupLocation: {
        ...reservation.pickupLocation,
        locationConfig: JSON.stringify({
          selfServiceKeyExchangeMode: 'LOCKBOX',
          selfServicePickupPointLabel: 'Locker Wall A',
          selfServicePickupInstructions: 'Use locker wall A and code from SMS.',
          operationsOpenTime: '08:00',
          operationsCloseTime: '18:00',
          weeklyHours: {
            wednesday: { enabled: true, open: '08:00', close: '18:00' }
          }
        })
      }
    },
    selfServiceConfig: {
      enabled: true,
      allowPickup: true,
      allowDropoff: true,
      requirePrecheckinForPickup: true,
      requireSignatureForPickup: true,
      requirePaymentForPickup: true,
      allowAfterHoursPickup: false,
      allowAfterHoursDropoff: true,
      keyExchangeMode: 'DESK'
    },
    confirmations: {
      pickup: { confirmedAt: '2026-04-08T14:10:00.000Z' }
    },
    customerInfoComplete: true,
    signatureComplete: true,
    paymentComplete: true
  });

  assert.equal(snapshot.keyExchangeMode, 'LOCKBOX');
  assert.equal(snapshot.pickup.pointLabel, 'Locker Wall A');
  assert.equal(snapshot.pickup.instructions, 'Use locker wall A and code from SMS.');
  assert.equal(snapshot.confirmations.pickup.confirmed, true);
  assert.equal(snapshot.canConfirmPickup, false);
  assert.equal(snapshot.canConfirmDropoff, true);
});
