function decimalToNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function cleanString(value) {
  const normalized = String(value || '').trim();
  return normalized || '';
}

function titleCaseMatchReason(code) {
  if (!code) return 'Available in this area';
  if (code === 'HOST_PICKUP_SPOT_EXACT') return 'Pickup available at this host spot';
  if (code === 'HOST_PICKUP_SPOT_NEARBY') return 'Pickup available near this area';
  if (code === 'DELIVERY_ZONE_EXACT') return 'Delivery available for this search area';
  if (code === 'DELIVERY_ZONE_NEARBY') return 'Delivery available near this area';
  if (code === 'TENANT_BRANCH') return 'Available from this branch area';
  if (code === 'ANCHOR_BRANCH_NEARBY') return 'Available near this branch area';
  return 'Available in this area';
}

function searchPlaceTypeLabel(type) {
  const normalized = String(type || 'HOST_PICKUP_SPOT').trim().toUpperCase();
  if (normalized === 'AIRPORT') return 'Airport';
  if (normalized === 'HOTEL') return 'Hotel';
  if (normalized === 'NEIGHBORHOOD') return 'Neighborhood';
  if (normalized === 'STATION') return 'Station';
  if (normalized === 'TENANT_BRANCH') return 'Branch area';
  if (normalized === 'HOST_PICKUP_SPOT') return 'Host pickup';
  return normalized.replaceAll('_', ' ').toLowerCase();
}

function searchPlaceTypeRank(type) {
  const normalized = String(type || 'HOST_PICKUP_SPOT').trim().toUpperCase();
  if (normalized === 'AIRPORT') return 60;
  if (normalized === 'STATION') return 56;
  if (normalized === 'HOTEL') return 52;
  if (normalized === 'NEIGHBORHOOD') return 48;
  if (normalized === 'TENANT_BRANCH') return 34;
  if (normalized === 'HOST_PICKUP_SPOT') return 24;
  return 16;
}

function visibilityRank(mode) {
  const normalized = String(mode || 'REVEAL_AFTER_BOOKING').trim().toUpperCase();
  if (normalized === 'PUBLIC_EXACT') return 3;
  if (normalized === 'APPROXIMATE_ONLY') return 2;
  return 1;
}

function fulfillmentFlexRank(mode) {
  const normalized = String(mode || 'PICKUP_ONLY').trim().toUpperCase();
  if (normalized === 'PICKUP_OR_DELIVERY') return 3;
  if (normalized === 'DELIVERY_ONLY') return 2;
  return 1;
}

function reviewCountRank(count) {
  return Math.min(250, Math.max(0, Number(count || 0)));
}

function buildRecommendedBadge({ matchReasonCode, searchPlaceType, listing, visibilityMode }) {
  const normalizedType = String(searchPlaceType || 'HOST_PICKUP_SPOT').trim().toUpperCase();
  const normalizedMode = String(listing?.fulfillmentMode || 'PICKUP_ONLY').trim().toUpperCase();
  const normalizedVisibility = String(visibilityMode || 'REVEAL_AFTER_BOOKING').trim().toUpperCase();

  if (matchReasonCode === 'DELIVERY_ZONE_EXACT' && normalizedType === 'AIRPORT') return 'Airport delivery favorite';
  if (matchReasonCode === 'DELIVERY_ZONE_EXACT') return 'Delivery favorite';
  if (matchReasonCode === 'HOST_PICKUP_SPOT_EXACT' && normalizedType === 'AIRPORT') return 'Airport pickup favorite';
  if (matchReasonCode === 'HOST_PICKUP_SPOT_EXACT' && normalizedType === 'HOTEL') return 'Hotel-area favorite';
  if (matchReasonCode === 'HOST_PICKUP_SPOT_EXACT' && normalizedType === 'NEIGHBORHOOD') return 'Neighborhood favorite';
  if (normalizedMode === 'PICKUP_OR_DELIVERY') return 'Flexible handoff';
  if (listing?.instantBook) return 'Instant book';
  if (normalizedVisibility === 'PUBLIC_EXACT') return 'Exact handoff visible';
  return `${searchPlaceTypeLabel(normalizedType)} match`;
}

function buildRankingReasons({ listing, matchReasonCode, searchPlaceType, visibilityMode }) {
  const reasons = [];
  const normalizedType = String(searchPlaceType || 'HOST_PICKUP_SPOT').trim().toUpperCase();
  const normalizedMode = String(listing?.fulfillmentMode || 'PICKUP_ONLY').trim().toUpperCase();
  const normalizedVisibility = String(visibilityMode || 'REVEAL_AFTER_BOOKING').trim().toUpperCase();

  reasons.push(titleCaseMatchReason(matchReasonCode));

  if (normalizedType && normalizedType !== 'HOST_PICKUP_SPOT') {
    reasons.push(`${searchPlaceTypeLabel(normalizedType)} preset match`);
  }

  if (listing?.instantBook) reasons.push('Instant book available');

  if (normalizedMode === 'PICKUP_OR_DELIVERY') {
    reasons.push('Pickup or delivery available');
  } else if (normalizedMode === 'DELIVERY_ONLY') {
    reasons.push('Delivery workflow supported');
  } else {
    reasons.push('Pickup workflow supported');
  }

  if (normalizedVisibility === 'PUBLIC_EXACT') {
    reasons.push('Exact handoff area visible before booking');
  } else if (normalizedVisibility === 'APPROXIMATE_ONLY') {
    reasons.push('Approximate handoff area visible before booking');
  } else {
    reasons.push('Exact handoff shared after booking');
  }

  if (Number(listing?.hostProfile?.reviewCount || listing?.host?.reviewCount || 0) >= 10) {
    reasons.push('Strong host review history');
  }

  return Array.from(new Set(reasons)).filter(Boolean).slice(0, 4);
}

export function serializeCarSharingSearchPlace(place) {
  if (!place) return null;
  return {
    id: place.id,
    placeType: place.placeType || 'HOST_PICKUP_SPOT',
    label: cleanString(place.publicLabel || place.label),
    rawLabel: cleanString(place.label),
    city: cleanString(place.city),
    state: cleanString(place.state),
    postalCode: cleanString(place.postalCode),
    country: cleanString(place.country),
    latitude: decimalToNumber(place.latitude),
    longitude: decimalToNumber(place.longitude),
    radiusMiles: place.radiusMiles ? Number(place.radiusMiles) : null,
    visibilityMode: place.visibilityMode || 'REVEAL_AFTER_BOOKING',
    deliveryEligible: !!place.deliveryEligible,
    pickupEligible: !!place.pickupEligible,
    anchorLocation: place.anchorLocation ? {
      id: place.anchorLocation.id,
      name: cleanString(place.anchorLocation.name),
      city: cleanString(place.anchorLocation.city),
      state: cleanString(place.anchorLocation.state)
    } : null
  };
}

export function serializeTenantBranchSearchPlace(location) {
  if (!location) return null;
  return {
    id: `branch:${location.id}`,
    placeType: 'TENANT_BRANCH',
    label: cleanString(location.name),
    rawLabel: cleanString(location.name),
    city: cleanString(location.city),
    state: cleanString(location.state),
    postalCode: '',
    country: '',
    latitude: null,
    longitude: null,
    radiusMiles: null,
    visibilityMode: 'PUBLIC_EXACT',
    deliveryEligible: false,
    pickupEligible: true,
    anchorLocation: {
      id: location.id,
      name: cleanString(location.name),
      city: cleanString(location.city),
      state: cleanString(location.state)
    }
  };
}

export function serializePublicPickupSpot(pickupSpot) {
  if (!pickupSpot) return null;
  const visibilityMode = pickupSpot.searchPlace?.visibilityMode || 'REVEAL_AFTER_BOOKING';
  const exactVisible = visibilityMode === 'PUBLIC_EXACT';
  return {
    id: pickupSpot.id,
    label: cleanString(pickupSpot.searchPlace?.publicLabel || pickupSpot.label),
    city: cleanString(pickupSpot.city),
    state: cleanString(pickupSpot.state),
    postalCode: exactVisible ? cleanString(pickupSpot.postalCode) : '',
    country: cleanString(pickupSpot.country),
    visibilityMode,
    exactLocationHidden: !exactVisible,
    address1: exactVisible ? cleanString(pickupSpot.address1) : '',
    address2: exactVisible ? cleanString(pickupSpot.address2) : '',
    latitude: exactVisible ? decimalToNumber(pickupSpot.latitude) : null,
    longitude: exactVisible ? decimalToNumber(pickupSpot.longitude) : null,
    instructions: exactVisible ? cleanString(pickupSpot.instructions) : '',
    anchorLocation: pickupSpot.anchorLocation ? {
      id: pickupSpot.anchorLocation.id,
      name: cleanString(pickupSpot.anchorLocation.name),
      city: cleanString(pickupSpot.anchorLocation.city),
      state: cleanString(pickupSpot.anchorLocation.state)
    } : null
  };
}

export function availableFulfillmentChoices(fulfillmentMode) {
  const normalized = String(fulfillmentMode || 'PICKUP_ONLY').trim().toUpperCase();
  if (normalized === 'DELIVERY_ONLY') return ['DELIVERY'];
  if (normalized === 'PICKUP_OR_DELIVERY') return ['PICKUP', 'DELIVERY'];
  return ['PICKUP'];
}

export function resolveListingSearchMatch({ listing, requestedLocationIds = [], requestedSearchPlaceIds = [] }) {
  const locationIdSet = new Set((requestedLocationIds || []).map(String).filter(Boolean));
  const searchPlaceIdSet = new Set((requestedSearchPlaceIds || []).map(String).filter(Boolean));
  const pickupSpotSearchPlace = listing?.pickupSpot?.searchPlace || null;
  const serviceAreas = Array.isArray(listing?.serviceAreas) ? listing.serviceAreas : [];
  const branchPlace = listing?.location ? serializeTenantBranchSearchPlace(listing.location) : null;
  const candidates = [];

  if (pickupSpotSearchPlace?.id && searchPlaceIdSet.has(String(pickupSpotSearchPlace.id))) {
    candidates.push({
      score: 520,
      matchReasonCode: 'HOST_PICKUP_SPOT_EXACT',
      searchPlaceSummary: serializeCarSharingSearchPlace(pickupSpotSearchPlace),
      visibilityMode: pickupSpotSearchPlace.visibilityMode || 'REVEAL_AFTER_BOOKING'
    });
  }

  for (const area of serviceAreas) {
    if (area?.searchPlace?.id && searchPlaceIdSet.has(String(area.searchPlace.id))) {
      candidates.push({
        score: String(area.serviceType || '').toUpperCase() === 'PICKUP' ? 440 : 480,
        matchReasonCode: String(area.serviceType || '').toUpperCase() === 'PICKUP'
          ? 'HOST_PICKUP_SPOT_EXACT'
          : 'DELIVERY_ZONE_EXACT',
        searchPlaceSummary: serializeCarSharingSearchPlace(area.searchPlace),
        visibilityMode: area.searchPlace.visibilityMode || 'REVEAL_AFTER_BOOKING'
      });
    }
  }

  if (pickupSpotSearchPlace?.anchorLocationId && locationIdSet.has(String(pickupSpotSearchPlace.anchorLocationId))) {
    candidates.push({
      score: 360,
      matchReasonCode: 'HOST_PICKUP_SPOT_NEARBY',
      searchPlaceSummary: serializeCarSharingSearchPlace(pickupSpotSearchPlace),
      visibilityMode: pickupSpotSearchPlace.visibilityMode || 'REVEAL_AFTER_BOOKING'
    });
  }

  for (const area of serviceAreas) {
    if (area?.searchPlace?.anchorLocationId && locationIdSet.has(String(area.searchPlace.anchorLocationId))) {
      candidates.push({
        score: String(area.serviceType || '').toUpperCase() === 'PICKUP' ? 320 : 340,
        matchReasonCode: String(area.serviceType || '').toUpperCase() === 'PICKUP'
          ? 'HOST_PICKUP_SPOT_NEARBY'
          : 'DELIVERY_ZONE_NEARBY',
        searchPlaceSummary: serializeCarSharingSearchPlace(area.searchPlace),
        visibilityMode: area.searchPlace.visibilityMode || 'REVEAL_AFTER_BOOKING'
      });
    }
  }

  if (listing?.locationId && locationIdSet.has(String(listing.locationId))) {
    candidates.push({
      score: 300,
      matchReasonCode: 'TENANT_BRANCH',
      searchPlaceSummary: branchPlace,
      visibilityMode: 'PUBLIC_EXACT'
    });
  }

  if (listing?.pickupSpot?.anchorLocationId && locationIdSet.has(String(listing.pickupSpot.anchorLocationId)) && !candidates.length) {
    candidates.push({
      score: 250,
      matchReasonCode: 'ANCHOR_BRANCH_NEARBY',
      searchPlaceSummary: pickupSpotSearchPlace ? serializeCarSharingSearchPlace(pickupSpotSearchPlace) : branchPlace,
      visibilityMode: pickupSpotSearchPlace?.visibilityMode || 'REVEAL_AFTER_BOOKING'
    });
  }

  const match = candidates.sort((left, right) => right.score - left.score)[0] || null;
  if (!match) return null;
  const searchPlaceType = match.searchPlaceSummary?.placeType || 'HOST_PICKUP_SPOT';
  return {
    ...match,
    searchPlaceType,
    matchReason: titleCaseMatchReason(match.matchReasonCode),
    exactLocationHidden: String(match.visibilityMode || 'REVEAL_AFTER_BOOKING') !== 'PUBLIC_EXACT',
    availableFulfillmentChoices: availableFulfillmentChoices(listing?.fulfillmentMode),
    recommendedBadge: buildRecommendedBadge({
      matchReasonCode: match.matchReasonCode,
      searchPlaceType,
      listing,
      visibilityMode: match.visibilityMode
    }),
    rankingReasons: buildRankingReasons({
      listing,
      matchReasonCode: match.matchReasonCode,
      searchPlaceType,
      visibilityMode: match.visibilityMode
    })
  };
}

export function compareCarSharingSearchResults(left, right) {
  const leftMatchScore = Number(left?.searchMatch?.score || 0);
  const rightMatchScore = Number(right?.searchMatch?.score || 0);
  if (leftMatchScore !== rightMatchScore) return rightMatchScore - leftMatchScore;

  const leftTrustScore = Number(left?.listing?.trustSummary?.score || 0);
  const rightTrustScore = Number(right?.listing?.trustSummary?.score || 0);
  if (leftTrustScore !== rightTrustScore) return rightTrustScore - leftTrustScore;

  const leftTypeRank = searchPlaceTypeRank(left?.searchMatch?.searchPlaceType || left?.listing?.searchPlace?.placeType);
  const rightTypeRank = searchPlaceTypeRank(right?.searchMatch?.searchPlaceType || right?.listing?.searchPlace?.placeType);
  if (leftTypeRank !== rightTypeRank) return rightTypeRank - leftTypeRank;

  const leftVisibility = visibilityRank(left?.searchMatch?.visibilityMode || left?.listing?.searchMatch?.visibilityMode);
  const rightVisibility = visibilityRank(right?.searchMatch?.visibilityMode || right?.listing?.searchMatch?.visibilityMode);
  if (leftVisibility !== rightVisibility) return rightVisibility - leftVisibility;

  const leftFulfillment = fulfillmentFlexRank(left?.listing?.fulfillmentMode);
  const rightFulfillment = fulfillmentFlexRank(right?.listing?.fulfillmentMode);
  if (leftFulfillment !== rightFulfillment) return rightFulfillment - leftFulfillment;

  const leftInstantBook = left?.listing?.instantBook ? 1 : 0;
  const rightInstantBook = right?.listing?.instantBook ? 1 : 0;
  if (leftInstantBook !== rightInstantBook) return rightInstantBook - leftInstantBook;

  const leftRating = Number(left?.listing?.host?.averageRating || 0);
  const rightRating = Number(right?.listing?.host?.averageRating || 0);
  if (leftRating !== rightRating) return rightRating - leftRating;

  const leftReviewCount = reviewCountRank(left?.listing?.host?.reviewCount);
  const rightReviewCount = reviewCountRank(right?.listing?.host?.reviewCount);
  if (leftReviewCount !== rightReviewCount) return rightReviewCount - leftReviewCount;

  const leftCreated = new Date(left?.listing?.publishedAt || left?.listing?.createdAt || 0).getTime();
  const rightCreated = new Date(right?.listing?.publishedAt || right?.listing?.createdAt || 0).getTime();
  return rightCreated - leftCreated;
}
