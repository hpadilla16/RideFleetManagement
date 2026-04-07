import test from 'node:test';
import assert from 'node:assert/strict';

import {
  compareCarSharingSearchResults,
  resolveListingSearchMatch,
  serializePublicPickupSpot
} from './car-sharing-discovery.js';

test('serializePublicPickupSpot hides exact address until booking when visibility is restricted', () => {
  const summary = serializePublicPickupSpot({
    id: 'spot_1',
    label: 'Host garage',
    address1: '123 Main St',
    city: 'San Juan',
    state: 'PR',
    postalCode: '00907',
    country: 'PR',
    latitude: '18.4512',
    longitude: '-66.0711',
    instructions: 'Use the side gate',
    anchorLocation: { id: 'loc_1', name: 'Condado', city: 'San Juan', state: 'PR' },
    searchPlace: {
      publicLabel: 'Condado pickup',
      visibilityMode: 'REVEAL_AFTER_BOOKING'
    }
  });

  assert.equal(summary.label, 'Condado pickup');
  assert.equal(summary.exactLocationHidden, true);
  assert.equal(summary.address1, '');
  assert.equal(summary.latitude, null);
  assert.equal(summary.instructions, '');
});

test('resolveListingSearchMatch prefers explicit host pickup spot matches over branch matches', () => {
  const match = resolveListingSearchMatch({
    requestedLocationIds: ['loc_1'],
    requestedSearchPlaceIds: ['place_pickup'],
    listing: {
      locationId: 'loc_1',
      fulfillmentMode: 'PICKUP_OR_DELIVERY',
      instantBook: true,
      location: { id: 'loc_1', name: 'Condado Branch', city: 'San Juan', state: 'PR' },
      pickupSpot: {
        anchorLocationId: 'loc_1',
        searchPlace: {
          id: 'place_pickup',
          placeType: 'HOST_PICKUP_SPOT',
          publicLabel: 'Condado pickup',
          label: 'Host garage',
          city: 'San Juan',
          state: 'PR',
          visibilityMode: 'REVEAL_AFTER_BOOKING',
          pickupEligible: true,
          deliveryEligible: false,
          anchorLocation: { id: 'loc_1', name: 'Condado Branch', city: 'San Juan', state: 'PR' }
        }
      },
      serviceAreas: []
    }
  });

  assert.equal(match.matchReasonCode, 'HOST_PICKUP_SPOT_EXACT');
  assert.equal(match.searchPlaceSummary?.label, 'Condado pickup');
  assert.equal(match.searchPlaceType, 'HOST_PICKUP_SPOT');
  assert.equal(match.recommendedBadge, 'Flexible handoff');
  assert.ok(Array.isArray(match.rankingReasons));
  assert.ok(match.rankingReasons.includes('Instant book available'));
  assert.deepEqual(match.availableFulfillmentChoices, ['PICKUP', 'DELIVERY']);
});

test('resolveListingSearchMatch surfaces delivery zone matches for area search', () => {
  const match = resolveListingSearchMatch({
    requestedLocationIds: ['loc_airport'],
    requestedSearchPlaceIds: ['place_airport'],
    listing: {
      locationId: 'loc_branch',
      fulfillmentMode: 'PICKUP_OR_DELIVERY',
      location: { id: 'loc_branch', name: 'Metro Branch', city: 'San Juan', state: 'PR' },
      pickupSpot: null,
      serviceAreas: [
        {
          serviceType: 'DELIVERY',
          searchPlace: {
            id: 'place_airport',
            placeType: 'AIRPORT',
            publicLabel: 'SJU airport',
            label: 'Luis Munoz Marin',
            city: 'Carolina',
            state: 'PR',
            visibilityMode: 'APPROXIMATE_ONLY',
            pickupEligible: false,
            deliveryEligible: true,
            anchorLocationId: 'loc_airport',
            anchorLocation: { id: 'loc_airport', name: 'Airport', city: 'Carolina', state: 'PR' }
          }
        }
      ]
    }
  });

  assert.equal(match.matchReasonCode, 'DELIVERY_ZONE_EXACT');
  assert.equal(match.visibilityMode, 'APPROXIMATE_ONLY');
  assert.equal(match.exactLocationHidden, true);
  assert.equal(match.searchPlaceType, 'AIRPORT');
  assert.equal(match.recommendedBadge, 'Airport delivery favorite');
  assert.ok(match.rankingReasons.includes('Airport preset match'));
});

test('compareCarSharingSearchResults prefers curated airport matches when base score ties', () => {
  const results = [
    {
      listing: {
        instantBook: false,
        fulfillmentMode: 'PICKUP_ONLY',
        trustSummary: { score: 65 },
        host: { averageRating: 4.7, reviewCount: 8 },
        publishedAt: '2026-04-01T12:00:00.000Z'
      },
      searchMatch: {
        score: 360,
        searchPlaceType: 'HOST_PICKUP_SPOT',
        visibilityMode: 'REVEAL_AFTER_BOOKING'
      }
    },
    {
      listing: {
        instantBook: false,
        fulfillmentMode: 'PICKUP_ONLY',
        trustSummary: { score: 65 },
        host: { averageRating: 4.7, reviewCount: 8 },
        publishedAt: '2026-04-01T12:00:00.000Z'
      },
      searchMatch: {
        score: 360,
        searchPlaceType: 'AIRPORT',
        visibilityMode: 'APPROXIMATE_ONLY'
      }
    }
  ];

  results.sort(compareCarSharingSearchResults);
  assert.equal(results[0]?.searchMatch?.searchPlaceType, 'AIRPORT');
});

test('compareCarSharingSearchResults uses trust score before lower ranking signals', () => {
  const results = [
    {
      listing: {
        instantBook: false,
        fulfillmentMode: 'PICKUP_ONLY',
        trustSummary: { score: 58 },
        host: { averageRating: 4.9, reviewCount: 1 },
        publishedAt: '2026-04-01T12:00:00.000Z'
      },
      searchMatch: {
        score: 420,
        searchPlaceType: 'HOTEL',
        visibilityMode: 'APPROXIMATE_ONLY'
      }
    },
    {
      listing: {
        instantBook: false,
        fulfillmentMode: 'PICKUP_ONLY',
        trustSummary: { score: 91 },
        host: { averageRating: 4.6, reviewCount: 25 },
        publishedAt: '2026-04-01T12:00:00.000Z'
      },
      searchMatch: {
        score: 420,
        searchPlaceType: 'HOTEL',
        visibilityMode: 'APPROXIMATE_ONLY'
      }
    }
  ];

  results.sort(compareCarSharingSearchResults);
  assert.equal(results[0]?.listing?.trustSummary?.score, 91);
});
