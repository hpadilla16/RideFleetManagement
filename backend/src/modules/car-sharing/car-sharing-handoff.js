function normalizeRevealMode(value) {
  return String(value || 'REVEAL_AFTER_BOOKING').trim().toUpperCase();
}

function normalizeHandoffMode(value) {
  return String(value || 'IN_PERSON').trim().toUpperCase();
}

function normalizeWindowHours(value, fallback = null) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return Math.floor(parsed);
}

function normalizeDate(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function hasExactHandoffPayload(plan = null) {
  if (!plan) return false;
  return !![
    plan.exactAddress1,
    plan.exactAddress2,
    plan.city,
    plan.state,
    plan.postalCode,
    plan.country,
    plan.instructions
  ].find((value) => String(value || '').trim());
}

function resolveSearchPlaceType(plan = null) {
  return String(
    plan?.searchPlace?.placeType
      || plan?.serviceArea?.searchPlace?.placeType
      || plan?.pickupSpot?.searchPlace?.placeType
      || 'HOST_PICKUP_SPOT'
  ).trim().toUpperCase();
}

export function resolveTripHandoffPreset(plan = null, selfServiceConfig = {}) {
  const placeType = resolveSearchPlaceType(plan);
  const modeMap = {
    AIRPORT: selfServiceConfig?.carSharingAirportHandoffMode,
    HOTEL: selfServiceConfig?.carSharingHotelHandoffMode,
    NEIGHBORHOOD: selfServiceConfig?.carSharingNeighborhoodHandoffMode,
    STATION: selfServiceConfig?.carSharingStationHandoffMode,
    TENANT_BRANCH: selfServiceConfig?.carSharingBranchHandoffMode,
    HOST_PICKUP_SPOT: selfServiceConfig?.carSharingHostPickupHandoffMode
  };
  const instructionMap = {
    AIRPORT: selfServiceConfig?.carSharingAirportInstructionsTemplate,
    HOTEL: selfServiceConfig?.carSharingHotelInstructionsTemplate,
    NEIGHBORHOOD: selfServiceConfig?.carSharingNeighborhoodInstructionsTemplate,
    STATION: selfServiceConfig?.carSharingStationInstructionsTemplate,
    TENANT_BRANCH: selfServiceConfig?.carSharingBranchInstructionsTemplate,
    HOST_PICKUP_SPOT: selfServiceConfig?.carSharingHostPickupInstructionsTemplate
  };
  const suggestedHandoffMode = normalizeHandoffMode(modeMap[placeType] || selfServiceConfig?.carSharingDefaultHandoffMode || 'IN_PERSON');
  const suggestedInstructions = String(instructionMap[placeType] || '').trim();
  return {
    placeType,
    suggestedHandoffMode,
    suggestedInstructions,
    suggestedLabel: `${placeType.replaceAll('_', ' ').toLowerCase()} preset`
  };
}

export function resolveTripHandoffWindowHours(plan = null, selfServiceConfig = {}) {
  if (!plan) return null;
  const revealMode = normalizeRevealMode(plan.pickupRevealMode);
  if (revealMode === 'PUBLIC_EXACT') return 0;

  const placeType = resolveSearchPlaceType(plan);

  if (placeType === 'AIRPORT') return normalizeWindowHours(selfServiceConfig?.carSharingAirportRevealWindowHours, 12);
  if (placeType === 'HOTEL') return normalizeWindowHours(selfServiceConfig?.carSharingHotelRevealWindowHours, 8);
  if (placeType === 'NEIGHBORHOOD') return normalizeWindowHours(selfServiceConfig?.carSharingNeighborhoodRevealWindowHours, 24);
  if (placeType === 'STATION') return normalizeWindowHours(selfServiceConfig?.carSharingStationRevealWindowHours, 10);
  if (placeType === 'TENANT_BRANCH') return normalizeWindowHours(selfServiceConfig?.carSharingBranchRevealWindowHours, 0);
  if (placeType === 'HOST_PICKUP_SPOT') return normalizeWindowHours(selfServiceConfig?.carSharingHostPickupRevealWindowHours, 18);
  return normalizeWindowHours(selfServiceConfig?.carSharingDefaultRevealWindowHours, 24);
}

export function resolveTripAutoRevealAt(plan = null, pickupAt = null, selfServiceConfig = {}) {
  const pickupDate = normalizeDate(pickupAt);
  if (!pickupDate) return null;
  const hours = resolveTripHandoffWindowHours(plan, selfServiceConfig);
  if (hours == null) return null;
  return new Date(pickupDate.getTime() - (hours * 60 * 60 * 1000));
}

export function resolveTripAutoRevealEligibility(plan = null, pickupAt = null, selfServiceConfig = {}) {
  if (!plan) return { eligible: false, autoRevealAt: null, windowHours: null, reason: 'No trip fulfillment plan is available.' };
  const revealMode = normalizeRevealMode(plan.pickupRevealMode);
  const handoffMode = normalizeHandoffMode(plan.handoffMode);
  const autoRevealModes = Array.isArray(selfServiceConfig?.carSharingAutoRevealModes)
    ? selfServiceConfig.carSharingAutoRevealModes.map((value) => String(value || '').trim().toUpperCase()).filter(Boolean)
    : ['LOCKBOX', 'REMOTE_UNLOCK', 'SELF_SERVICE'];

  if (revealMode === 'PUBLIC_EXACT') {
    return { eligible: true, autoRevealAt: null, windowHours: 0, reason: 'This place is configured for public exact visibility.' };
  }
  if (!selfServiceConfig?.carSharingAutoRevealEnabled) {
    return { eligible: false, autoRevealAt: null, windowHours: null, reason: 'Automatic reveal is disabled for this tenant.' };
  }
  if (!autoRevealModes.includes(handoffMode)) {
    return { eligible: false, autoRevealAt: null, windowHours: null, reason: 'This handoff mode still requires host confirmation.' };
  }
  if (!hasExactHandoffPayload(plan)) {
    return { eligible: false, autoRevealAt: null, windowHours: null, reason: 'The host still needs to enter the exact handoff details.' };
  }

  const windowHours = resolveTripHandoffWindowHours(plan, selfServiceConfig);
  const autoRevealAt = resolveTripAutoRevealAt(plan, pickupAt, selfServiceConfig);
  if (!autoRevealAt) {
    return { eligible: false, autoRevealAt: null, windowHours, reason: 'Pickup timing is missing, so the reveal window cannot be calculated yet.' };
  }
  return {
    eligible: true,
    autoRevealAt,
    windowHours,
    reason: `Exact handoff can unlock automatically ${windowHours} hour${windowHours === 1 ? '' : 's'} before pickup.`
  };
}

export function canRevealExactHandoff(plan = null, { pickupAt = null, selfServiceConfig = {}, now = new Date() } = {}) {
  if (!plan) return false;
  const revealMode = normalizeRevealMode(plan.pickupRevealMode);
  if (revealMode === 'PUBLIC_EXACT') return true;
  if (plan.confirmedAt) return true;
  const autoReveal = resolveTripAutoRevealEligibility(plan, pickupAt, selfServiceConfig);
  const nowDate = normalizeDate(now);
  return !!(autoReveal.eligible && autoReveal.autoRevealAt && nowDate && nowDate >= autoReveal.autoRevealAt);
}

export function resolveHandoffConfirmationAlerts(trips = [], { warningHoursBeforePickup = 24, now = new Date() } = {}) {
  const nowMs = (normalizeDate(now) || new Date()).getTime();
  const warningWindowMs = warningHoursBeforePickup * 60 * 60 * 1000;
  const alerts = [];

  for (const trip of trips) {
    const plan = trip?.fulfillmentPlan || null;
    if (!plan) continue;
    if (normalizeRevealMode(plan.pickupRevealMode) === 'PUBLIC_EXACT') continue;
    if (plan.confirmedAt) continue;

    const pickupAt = normalizeDate(trip?.scheduledPickupAt);
    if (!pickupAt) continue;

    const msUntilPickup = pickupAt.getTime() - nowMs;
    if (msUntilPickup > warningWindowMs) continue;

    const hoursUntilPickup = Math.max(0, Math.round(msUntilPickup / (60 * 60 * 1000)));
    const isOverdue = msUntilPickup < 0;

    alerts.push({
      tripId: trip.id || null,
      tripCode: trip.tripCode || null,
      listingId: trip.listingId || null,
      hostProfileId: trip.hostProfileId || null,
      scheduledPickupAt: pickupAt.toISOString(),
      hoursUntilPickup,
      isOverdue,
      handoffMode: normalizeHandoffMode(plan.handoffMode),
      pickupRevealMode: normalizeRevealMode(plan.pickupRevealMode),
      reason: isOverdue
        ? 'Pickup has passed and host never confirmed handoff details.'
        : `Host has not confirmed handoff details with ${hoursUntilPickup}h until pickup.`
    });
  }

  return alerts.sort((left, right) => left.hoursUntilPickup - right.hoursUntilPickup);
}

export function serializePublicTripFulfillmentPlan(
  plan = null,
  {
    pickupAt = null,
    selfServiceConfig = {},
    now = new Date(),
    serializeSearchPlace = (value) => value,
    serializePickupSpot = (value) => value,
    serializeServiceAreaSearchPlace = (value) => value
  } = {}
) {
  if (!plan) return null;
  const autoReveal = resolveTripAutoRevealEligibility(plan, pickupAt, selfServiceConfig);
  const exactHandoffVisible = canRevealExactHandoff(plan, { pickupAt, selfServiceConfig, now });
  const handoffPreset = resolveTripHandoffPreset(plan, selfServiceConfig);
  const selfServiceReady = !!(
    selfServiceConfig?.enabled
    && selfServiceConfig?.allowPickup
    && ['LOCKBOX', 'REMOTE_UNLOCK', 'SELF_SERVICE'].includes(normalizeHandoffMode(plan.handoffMode))
  );
  const selfServiceLabel = selfServiceReady
    ? {
        LOCKBOX: 'Lockbox handoff ready',
        REMOTE_UNLOCK: 'Remote unlock handoff ready',
        SELF_SERVICE: 'Self-service handoff ready'
      }[normalizeHandoffMode(plan.handoffMode)] || 'Self-service handoff ready'
    : 'Host confirmation required';

  let pendingReason = '';
  if (!exactHandoffVisible) {
    if (autoReveal.eligible && autoReveal.autoRevealAt) {
      pendingReason = `Exact handoff will unlock automatically on ${autoReveal.autoRevealAt.toISOString()}.`;
    } else {
      pendingReason = autoReveal.reason || 'The host is still confirming the final handoff details.';
    }
  }

  return {
    fulfillmentChoice: plan.fulfillmentChoice,
    deliveryAreaChoiceLabel: plan.deliveryAreaChoiceLabel || null,
    pickupRevealMode: plan.pickupRevealMode,
    handoffMode: plan.handoffMode,
    instructions: exactHandoffVisible ? (plan.instructions || null) : null,
    confirmedAt: plan.confirmedAt || null,
    exactHandoffVisible,
    exactHandoffConfirmed: !!plan.confirmedAt,
    exactHandoffPending: !exactHandoffVisible && normalizeRevealMode(plan.pickupRevealMode) !== 'PUBLIC_EXACT',
    exactHandoffPendingReason: !exactHandoffVisible ? pendingReason : '',
    autoRevealEligible: !!autoReveal.eligible,
    autoRevealAt: autoReveal.autoRevealAt ? autoReveal.autoRevealAt.toISOString() : null,
    autoRevealWindowHours: autoReveal.windowHours,
    autoRevealTriggered: !!(autoReveal.eligible && autoReveal.autoRevealAt && normalizeDate(now) >= autoReveal.autoRevealAt),
    selfServiceReady,
    selfServiceLabel,
    handoffPreset,
    exactHandoff: exactHandoffVisible
      ? {
          address1: plan.exactAddress1 || null,
          address2: plan.exactAddress2 || null,
          city: plan.city || null,
          state: plan.state || null,
          postalCode: plan.postalCode || null,
          country: plan.country || null,
          instructions: plan.instructions || null
        }
      : null,
    searchPlace: serializeSearchPlace(plan.searchPlace || null),
    pickupSpot: serializePickupSpot(plan.pickupSpot || null),
    serviceAreaSearchPlace: serializeServiceAreaSearchPlace(plan.serviceArea?.searchPlace || null)
  };
}
