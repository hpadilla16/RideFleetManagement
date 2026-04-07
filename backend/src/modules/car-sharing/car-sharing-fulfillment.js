function cleanString(value) {
  const normalized = String(value || '').trim();
  return normalized || '';
}

function pickFirstActiveServiceArea(listing, fulfillmentChoice) {
  const areas = Array.isArray(listing?.serviceAreas) ? listing.serviceAreas : [];
  const wanted = String(fulfillmentChoice || 'PICKUP').toUpperCase();
  if (wanted === 'DELIVERY') {
    return areas.find((area) => ['DELIVERY', 'BOTH'].includes(String(area?.serviceType || '').toUpperCase())) || null;
  }
  return areas.find((area) => ['PICKUP', 'BOTH'].includes(String(area?.serviceType || '').toUpperCase())) || null;
}

function resolveTripHandoffMode({ pickupSpot = null, visibilityMode = '' } = {}) {
  if (pickupSpot?.instructions && /lockbox/i.test(String(pickupSpot.instructions))) return 'LOCKBOX';
  if (String(visibilityMode || '').toUpperCase() === 'APPROXIMATE_ONLY') return 'SELF_SERVICE';
  return 'IN_PERSON';
}

export function resolveDeliveryFeeOverride({ listing, fulfillmentChoice, searchPlaceId } = {}) {
  const choice = String(fulfillmentChoice || 'PICKUP').toUpperCase();
  if (choice !== 'DELIVERY') return null;
  const serviceAreas = Array.isArray(listing?.serviceAreas) ? listing.serviceAreas : [];
  const requestedSearchPlaceId = cleanString(searchPlaceId);
  let matchedArea = null;
  if (requestedSearchPlaceId) {
    matchedArea = serviceAreas.find((area) => String(area?.searchPlaceId || '') === requestedSearchPlaceId) || null;
  }
  if (!matchedArea) {
    matchedArea = pickFirstActiveServiceArea(listing, 'DELIVERY');
  }
  if (matchedArea != null && matchedArea.feeOverride !== null && matchedArea.feeOverride !== undefined) {
    return Number(matchedArea.feeOverride);
  }
  return null;
}

export function resolveDeliveryAreaHints(listing) {
  const areas = Array.isArray(listing?.serviceAreas) ? listing.serviceAreas : [];
  return areas
    .filter((area) => ['DELIVERY', 'BOTH'].includes(String(area?.serviceType || '').toUpperCase()) && area.isActive !== false)
    .map((area) => ({
      id: area.id,
      searchPlaceId: area.searchPlaceId || null,
      label: area.searchPlace?.displayName || area.searchPlace?.name || area.deliveryAreaChoiceLabel || null,
      city: area.searchPlace?.city || null,
      state: area.searchPlace?.state || null,
      placeType: area.searchPlace?.placeType || null,
      radiusMiles: area.radiusMiles ?? null,
      feeOverride: area.feeOverride ?? null,
      serviceType: String(area.serviceType || 'DELIVERY').toUpperCase()
    }));
}

export function buildTripFulfillmentPlanData({ listing, fulfillmentChoice, searchPlaceId, deliveryAreaChoice = null }) {
  const choice = String(fulfillmentChoice || 'PICKUP').toUpperCase() === 'DELIVERY' ? 'DELIVERY' : 'PICKUP';
  const requestedSearchPlaceId = cleanString(searchPlaceId);
  const listingPickupSpot = listing?.pickupSpot || null;
  const listingPickupSearchPlace = listingPickupSpot?.searchPlace || null;
  const serviceAreas = Array.isArray(listing?.serviceAreas) ? listing.serviceAreas : [];

  let matchedServiceArea = null;
  let matchedSearchPlace = null;

  if (requestedSearchPlaceId) {
    matchedServiceArea = serviceAreas.find((area) => String(area?.searchPlaceId || '') === requestedSearchPlaceId) || null;
    if (matchedServiceArea?.searchPlace) {
      matchedSearchPlace = matchedServiceArea.searchPlace;
    } else if (String(listingPickupSearchPlace?.id || '') === requestedSearchPlaceId) {
      matchedSearchPlace = listingPickupSearchPlace;
    }
  }

  if (!matchedServiceArea && choice === 'DELIVERY') {
    matchedServiceArea = pickFirstActiveServiceArea(listing, 'DELIVERY');
    if (matchedServiceArea?.searchPlace) matchedSearchPlace = matchedServiceArea.searchPlace;
  }

  if (!matchedSearchPlace && choice === 'PICKUP' && listingPickupSearchPlace) {
    matchedSearchPlace = listingPickupSearchPlace;
  }

  if (!matchedSearchPlace && matchedServiceArea?.searchPlace) {
    matchedSearchPlace = matchedServiceArea.searchPlace;
  }

  const visibilityMode = matchedSearchPlace?.visibilityMode
    || listingPickupSearchPlace?.visibilityMode
    || 'REVEAL_AFTER_BOOKING';
  const pickupSpot = choice === 'PICKUP'
    ? (listingPickupSpot || null)
    : null;

  return {
    searchPlaceId: matchedSearchPlace?.id || null,
    pickupSpotId: pickupSpot?.id || null,
    serviceAreaId: matchedServiceArea?.id || null,
    fulfillmentChoice: choice,
    deliveryAreaChoiceLabel: cleanString(deliveryAreaChoice) || null,
    pickupRevealMode: visibilityMode,
    handoffMode: resolveTripHandoffMode({ pickupSpot, visibilityMode }),
    exactAddress1: pickupSpot?.address1 || null,
    exactAddress2: pickupSpot?.address2 || null,
    city: pickupSpot?.city || matchedSearchPlace?.city || null,
    state: pickupSpot?.state || matchedSearchPlace?.state || null,
    postalCode: pickupSpot?.postalCode || matchedSearchPlace?.postalCode || null,
    country: pickupSpot?.country || matchedSearchPlace?.country || null,
    latitude: pickupSpot?.latitude ?? matchedSearchPlace?.latitude ?? null,
    longitude: pickupSpot?.longitude ?? matchedSearchPlace?.longitude ?? null,
    instructions: pickupSpot?.instructions || null
  };
}
