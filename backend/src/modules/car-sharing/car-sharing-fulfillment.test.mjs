import test from 'node:test';
import assert from 'node:assert/strict';

import { buildTripFulfillmentPlanData } from './car-sharing-fulfillment.js';

test('buildTripFulfillmentPlanData prefers explicit search place for delivery area matches', () => {
  const plan = buildTripFulfillmentPlanData({
    fulfillmentChoice: 'DELIVERY',
    searchPlaceId: 'place_airport',
    deliveryAreaChoice: 'SJU Airport',
    listing: {
      pickupSpot: null,
      serviceAreas: [
        {
          id: 'service_1',
          serviceType: 'DELIVERY',
          searchPlaceId: 'place_airport',
          searchPlace: {
            id: 'place_airport',
            visibilityMode: 'APPROXIMATE_ONLY',
            city: 'Carolina',
            state: 'PR'
          }
        }
      ]
    }
  });

  assert.equal(plan.searchPlaceId, 'place_airport');
  assert.equal(plan.serviceAreaId, 'service_1');
  assert.equal(plan.pickupSpotId, null);
  assert.equal(plan.fulfillmentChoice, 'DELIVERY');
  assert.equal(plan.pickupRevealMode, 'APPROXIMATE_ONLY');
  assert.equal(plan.handoffMode, 'SELF_SERVICE');
  assert.equal(plan.deliveryAreaChoiceLabel, 'SJU Airport');
});

test('buildTripFulfillmentPlanData captures pickup spot details for pickup bookings', () => {
  const plan = buildTripFulfillmentPlanData({
    fulfillmentChoice: 'PICKUP',
    searchPlaceId: 'place_condado',
    listing: {
      pickupSpot: {
        id: 'spot_1',
        address1: '123 Main St',
        city: 'San Juan',
        state: 'PR',
        postalCode: '00907',
        country: 'PR',
        instructions: 'Lockbox next to gate',
        latitude: '18.45',
        longitude: '-66.07',
        searchPlace: {
          id: 'place_condado',
          visibilityMode: 'REVEAL_AFTER_BOOKING',
          city: 'San Juan',
          state: 'PR',
          postalCode: '00907',
          country: 'PR'
        }
      },
      serviceAreas: []
    }
  });

  assert.equal(plan.searchPlaceId, 'place_condado');
  assert.equal(plan.pickupSpotId, 'spot_1');
  assert.equal(plan.serviceAreaId, null);
  assert.equal(plan.pickupRevealMode, 'REVEAL_AFTER_BOOKING');
  assert.equal(plan.handoffMode, 'LOCKBOX');
  assert.equal(plan.exactAddress1, '123 Main St');
});
