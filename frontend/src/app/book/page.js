'use client';

import Link from 'next/link';
import { Suspense, useEffect, useMemo, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { api } from '../../lib/client';

const PUBLIC_BOOKING_DRAFT_KEY = 'fleet_public_booking_draft';

function toLocalInputValue(date) {
  const value = new Date(date);
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, '0');
  const day = String(value.getDate()).padStart(2, '0');
  const hours = String(value.getHours()).padStart(2, '0');
  const minutes = String(value.getMinutes()).padStart(2, '0');
  return `${year}-${month}-${day}T${hours}:${minutes}`;
}

function addDays(base, days) {
  const next = new Date(base);
  next.setDate(next.getDate() + days);
  return next;
}

function fmtMoney(value) {
  return `$${Number(value || 0).toFixed(2)}`;
}

function computeFeeLineTotal(fee, { baseAmount = 0, days = 1 } = {}) {
  const amount = Number(fee?.amount || 0);
  const mode = String(fee?.mode || 'FIXED').toUpperCase();
  if (mode === 'PERCENTAGE') return Number((baseAmount * (amount / 100)).toFixed(2));
  if (mode === 'PER_DAY') return Number((amount * Math.max(1, Number(days || 1))).toFixed(2));
  return Number(amount.toFixed(2));
}

function fmtRating(value, count = 0) {
  const rating = Number(value || 0);
  if (!count) return 'New host';
  return `${rating.toFixed(2)} star rating (${count})`;
}

function normalizeImageList(value) {
  const items = Array.isArray(value) ? value : value ? [value] : [];
  return items.map((item) => String(item || '').trim()).filter(Boolean).slice(0, 6);
}

function publicLocationLabel(location) {
  return [location?.name, location?.city, location?.state].filter(Boolean).join(' | ') || 'Location';
}

function buildPublicLocationOptions(locations = []) {
  const groups = new Map();
  locations.forEach((location) => {
    const key = publicLocationLabel(location);
    if (!groups.has(key)) {
      groups.set(key, {
        id: key,
        label: key,
        locationIds: [],
        tenantIds: [],
        locations: []
      });
    }
    const group = groups.get(key);
    group.locationIds.push(location.id);
    if (location.tenantId && !group.tenantIds.includes(location.tenantId)) {
      group.tenantIds.push(location.tenantId);
    }
    group.locations.push(location);
  });
  return Array.from(groups.values()).sort((a, b) => a.label.localeCompare(b.label));
}

function publicPickupSpotLabel(pickupSpot, fallbackLocation = null) {
  if (pickupSpot?.label) {
    const address = [pickupSpot?.city, pickupSpot?.state].filter(Boolean).join(', ');
    const anchor = pickupSpot?.anchorLocation?.name ? ` | Ops hub ${pickupSpot.anchorLocation.name}` : '';
    return `${pickupSpot.label}${address ? ` | ${address}` : ''}${anchor}`;
  }
  return fallbackLocation ? publicLocationLabel(fallbackLocation) : 'Location';
}

function pickupSpotHint(pickupSpot) {
  return [pickupSpot?.address1, pickupSpot?.city, pickupSpot?.state, pickupSpot?.postalCode].filter(Boolean).join(' | ');
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

function searchPlaceGroupLabel(type) {
  const normalized = String(type || 'HOST_PICKUP_SPOT').trim().toUpperCase();
  if (normalized === 'AIRPORT') return 'Airports';
  if (normalized === 'HOTEL') return 'Hotels';
  if (normalized === 'NEIGHBORHOOD') return 'Neighborhoods';
  if (normalized === 'STATION') return 'Stations';
  if (normalized === 'TENANT_BRANCH') return 'Branch areas';
  if (normalized === 'HOST_PICKUP_SPOT') return 'Host pickup spots';
  return 'Other search places';
}

function searchPlaceTypePriority(type) {
  const normalized = String(type || 'HOST_PICKUP_SPOT').trim().toUpperCase();
  if (normalized === 'AIRPORT') return 10;
  if (normalized === 'HOTEL') return 20;
  if (normalized === 'NEIGHBORHOOD') return 30;
  if (normalized === 'STATION') return 40;
  if (normalized === 'HOST_PICKUP_SPOT') return 50;
  if (normalized === 'TENANT_BRANCH') return 60;
  return 90;
}

function carSharingSearchPlaceLabel(place) {
  if (!place) return 'Search place';
  const bits = [place.label || place.rawLabel || 'Search place'];
  const area = [place.city, place.state].filter(Boolean).join(', ');
  if (area) bits.push(area);
  return bits.join(' | ');
}

function carSharingSearchPlaceHint(place) {
  if (!place) return '';
  const type = searchPlaceTypeLabel(place.placeType);
  const visibility = place.visibilityMode === 'PUBLIC_EXACT'
    ? 'Exact handoff can be shown before booking'
    : place.visibilityMode === 'APPROXIMATE_ONLY'
      ? 'Approximate area shown before booking'
      : 'Exact handoff shared after booking';
  const fulfillment = [
    place.pickupEligible ? 'pickup' : '',
    place.deliveryEligible ? 'delivery' : ''
  ].filter(Boolean).join(' + ');
  return [type, fulfillment || 'pickup', visibility].filter(Boolean).join(' | ');
}

function buildCarSharingSearchOptionGroups(options = []) {
  const groups = new Map();
  options.forEach((option) => {
    const key = option.groupLabel || 'Other search places';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(option);
  });
  return Array.from(groups.entries()).map(([label, items]) => ({
    label,
    options: items.sort((left, right) => String(left.label || '').localeCompare(String(right.label || '')))
  }));
}

function uniqueLabels(items = []) {
  return Array.from(new Set((Array.isArray(items) ? items : []).map((item) => String(item || '').trim()).filter(Boolean)));
}

function carSharingDiscoveryBadges(result) {
  if (!result) return [];
  return uniqueLabels([
    result.recommendedBadge,
    result.trustBadge,
    result.searchPlaceType ? searchPlaceTypeLabel(result.searchPlaceType) : '',
    result.instantBook ? 'Instant book' : '',
    Array.isArray(result.availableFulfillmentChoices) && result.availableFulfillmentChoices.includes('DELIVERY') ? 'Delivery available' : '',
    result.exactLocationHidden ? 'Exact details after booking' : 'Exact area visible'
  ]).slice(0, 5);
}

function fulfillmentModeLabel(mode) {
  const value = String(mode || 'PICKUP_ONLY').toUpperCase();
  if (value === 'DELIVERY_ONLY') return 'Delivery only';
  if (value === 'PICKUP_OR_DELIVERY') return 'Pickup or delivery';
  return 'Pickup only';
}

function fulfillmentHint(result) {
  if (!result) return '';
  const bits = [fulfillmentModeLabel(result.fulfillmentMode)];
  if (result.deliveryRadiusMiles) bits.push(`${result.deliveryRadiusMiles} mi radius`);
  if (Array.isArray(result.deliveryAreas) && result.deliveryAreas.length) bits.push(`${result.deliveryAreas.length} delivery areas`);
  if (Number(result.pickupFee || 0) > 0) bits.push(`Pickup fee ${fmtMoney(result.pickupFee)}`);
  if (Number(result.deliveryFee || 0) > 0) bits.push(`Delivery fee ${fmtMoney(result.deliveryFee)}`);
  return bits.join(' | ');
}

function defaultFulfillmentChoice(result) {
  const mode = String(result?.fulfillmentMode || 'PICKUP_ONLY').toUpperCase();
  return mode === 'DELIVERY_ONLY' ? 'DELIVERY' : 'PICKUP';
}

function locationLabelFromId(locations, id) {
  if (!id) return '';
  const match = (Array.isArray(locations) ? locations : []).find((location) => String(location.id) === String(id));
  return match ? publicLocationLabel(match) : '';
}

function buildServiceSelectionState(result) {
  return Object.fromEntries(
    (result?.additionalServices || []).map((service) => [
      service.serviceId,
      {
        selected: !!service.mandatory,
        quantity: Math.max(1, Number(service.quantity || 1) || 1)
      }
    ])
  );
}

function buildInsuranceSelectionState(_result, mode) {
  if (mode !== 'RENTAL') {
    return {
      selectedPlanCode: '',
      declinedCoverage: false,
      usingOwnInsurance: false,
      liabilityAccepted: false,
      ownPolicyNumber: ''
    };
  }
  return {
    selectedPlanCode: '',
    declinedCoverage: false,
    usingOwnInsurance: false,
    liabilityAccepted: false,
    ownPolicyNumber: ''
  };
}

function restorePublicBookingDraft() {
  if (typeof window === 'undefined') return null;
  try {
    const raw = sessionStorage.getItem(PUBLIC_BOOKING_DRAFT_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    return parsed;
  } catch {
    return null;
  }
}

function BookingStageBar({ stage }) {
  const stages = [
    { key: 'search', label: 'Search' },
    { key: 'select', label: 'Select' },
    { key: 'checkout', label: 'Guest Details' },
    { key: 'confirm', label: 'Confirmation' }
  ];
  const activeIndex = stages.findIndex((item) => item.key === stage);

  return (
    <div className="metric-grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))' }}>
      {stages.map((item, index) => {
        const done = activeIndex > index;
        const active = activeIndex === index;
        const className = done ? 'status-chip good' : active ? 'status-chip' : 'status-chip neutral';
        return (
          <div key={item.key} className="surface-note" style={{ display: 'grid', gap: 8 }}>
            <span className={className} style={{ width: 'fit-content' }}>
              {done ? 'Done' : active ? 'Current' : 'Next'}
            </span>
            <strong>{item.label}</strong>
          </div>
        );
      })}
    </div>
  );
}

function BookingCard({ title, subtitle, meta, quote, cta, onClick, selected = false, hints = [], imageUrl = '', imageUrls = [], hostSummary = '', hostHref = '' }) {
  const gallery = normalizeImageList(imageUrls?.length ? imageUrls : imageUrl ? [imageUrl] : []);
  return (
    <article
      className="glass card section-card"
      style={selected ? { borderColor: 'rgba(110,73,255,.38)', boxShadow: '0 18px 42px rgba(110,73,255,.18)' } : undefined}
    >
      {gallery[0] ? (
        <div className="stack" style={{ gap: 10 }}>
          <img
            src={gallery[0]}
            alt={title}
            style={{ width: '100%', aspectRatio: '16 / 9', objectFit: 'cover', borderRadius: 18, border: '1px solid rgba(110,73,255,.15)' }}
          />
          {gallery.length > 1 ? (
            <div className="inline-actions">
              {gallery.slice(0, 4).map((photo, index) => (
                <img
                  key={`${title}-${index}`}
                  src={photo}
                  alt={`${title} ${index + 1}`}
                  style={{ width: 56, height: 40, objectFit: 'cover', borderRadius: 10, border: '1px solid rgba(110,73,255,.15)' }}
                />
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
      <div className="stack" style={{ gap: 8 }}>
        <div className="row-between" style={{ gap: 12, alignItems: 'start' }}>
          <div className="eyebrow">{meta}</div>
          {selected ? <span className="status-chip good">Selected</span> : null}
        </div>
        <div className="page-title">{title}</div>
        {subtitle ? <p className="ui-muted">{subtitle}</p> : null}
        {hostSummary ? (
          <div className="label" style={{ textTransform: 'none', letterSpacing: 0, fontSize: 13 }}>
            {hostSummary}
            {hostHref ? (
              <>
                {' | '}
                <Link href={hostHref}>View host</Link>
              </>
            ) : null}
          </div>
        ) : null}
      </div>
      {hints.length ? (
        <div className="inline-actions">
          {hints.map((hint) => (
            <span key={hint} className="status-chip neutral">{hint}</span>
          ))}
        </div>
      ) : null}
      <div className="metric-grid">
        {quote.map((item) => (
          <div key={item.label} className="metric-card">
            <span className="label">{item.label}</span>
            <strong>{item.value}</strong>
          </div>
        ))}
      </div>
      <div className="inline-actions">
        <button type="button" onClick={onClick}>{cta}</button>
      </div>
    </article>
  );
}

function PublicBookingPageInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const initialDraft = restorePublicBookingDraft();
  const embedMode = searchParams.get('embed') === '1';
  const queryTenantSlug = String(searchParams.get('tenantSlug') || '').trim();
  const querySearchMode = String(searchParams.get('searchMode') || '').trim().toUpperCase() === 'CAR_SHARING' ? 'CAR_SHARING' : '';
  const queryPickupAt = String(searchParams.get('pickupAt') || '').trim();
  const queryReturnAt = String(searchParams.get('returnAt') || '').trim();
  const queryVehicleTypeId = String(searchParams.get('vehicleTypeId') || '').trim();
  const queryPickupLocationId = String(searchParams.get('pickupLocationId') || '').trim();
  const queryReturnLocationId = String(searchParams.get('returnLocationId') || '').trim();
  const [bootstrap, setBootstrap] = useState(null);
  const [tenantSlug, setTenantSlug] = useState(queryTenantSlug || initialDraft?.tenantSlug || '');
  const [uiStep, setUiStep] = useState(initialDraft?.uiStep || 'search');
  const [searchMode, setSearchMode] = useState(querySearchMode || initialDraft?.searchMode || 'RENTAL');
  const [pickupLocationId, setPickupLocationId] = useState(initialDraft?.pickupLocationId || '');
  const [returnLocationId, setReturnLocationId] = useState(initialDraft?.returnLocationId || '');
  const [carSharingSearchPlaceId, setCarSharingSearchPlaceId] = useState(initialDraft?.carSharingSearchPlaceId || '');
  const [vehicleTypeId, setVehicleTypeId] = useState(queryVehicleTypeId || initialDraft?.vehicleTypeId || '');
  const [pickupAt, setPickupAt] = useState(queryPickupAt || initialDraft?.pickupAt || toLocalInputValue(addDays(new Date(), 1)));
  const [returnAt, setReturnAt] = useState(queryReturnAt || initialDraft?.returnAt || toLocalInputValue(addDays(new Date(), 4)));
  const [results, setResults] = useState(initialDraft?.results || null);
  const [loadingBootstrap, setLoadingBootstrap] = useState(true);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState('');
  const [selectedResult, setSelectedResult] = useState(initialDraft?.selectedResult || null);
  const [selectedFulfillmentChoice, setSelectedFulfillmentChoice] = useState(initialDraft?.selectedFulfillmentChoice || 'PICKUP');
  const [selectedDeliveryArea, setSelectedDeliveryArea] = useState(initialDraft?.selectedDeliveryArea || '');
  const [autoSearchDone, setAutoSearchDone] = useState(false);
  const [autoSelectionDone, setAutoSelectionDone] = useState(false);
  const [checkoutState, setCheckoutState] = useState(initialDraft?.checkoutState || {
    firstName: '',
    lastName: '',
    email: '',
    phone: '',
    dateOfBirth: '',
    licenseNumber: '',
    licenseState: ''
  });
  const [submitting, setSubmitting] = useState(false);
  const [lookingUp, setLookingUp] = useState(false);
  const [selectedServices, setSelectedServices] = useState(initialDraft?.selectedServices || {});
  const [insuranceSelection, setInsuranceSelection] = useState(initialDraft?.insuranceSelection || buildInsuranceSelectionState(null, 'RENTAL'));
  const [lookupState, setLookupState] = useState(initialDraft?.lookupState || {
    reference: '',
    email: ''
  });

  const loadBootstrap = async (slug) => {
    setLoadingBootstrap(true);
    setError('');
    try {
      const query = slug ? `?tenantSlug=${encodeURIComponent(slug)}` : '';
      const payload = await api(`/api/public/booking/bootstrap${query}`);
      setBootstrap(payload);
      const selectedSlug = payload?.selectedTenant?.slug || '';
      setTenantSlug(selectedSlug);
      const nextLocationOptions = buildPublicLocationOptions(payload?.locations || []);
      const nextSearchPlaces = Array.isArray(payload?.carSharingSearchPlaces) ? payload.carSharingSearchPlaces : [];
      const firstLocationId = payload?.locations?.[0] ? publicLocationLabel(payload.locations[0]) : '';
      const preferredPickupLocation = locationLabelFromId(payload?.locations, queryPickupLocationId) || firstLocationId;
      const preferredReturnLocation = locationLabelFromId(payload?.locations, queryReturnLocationId) || preferredPickupLocation || firstLocationId;
      setPickupLocationId((current) =>
        payload?.locations?.some((item) => publicLocationLabel(item) === current) ? current : preferredPickupLocation
      );
      setReturnLocationId((current) =>
        payload?.locations?.some((item) => publicLocationLabel(item) === current) ? current : preferredReturnLocation
      );
      setVehicleTypeId((current) => {
        if (current && payload?.vehicleTypes?.some((item) => item.id === current)) return current;
        if (queryVehicleTypeId && payload?.vehicleTypes?.some((item) => item.id === queryVehicleTypeId)) return queryVehicleTypeId;
        return '';
      });
      setCarSharingSearchPlaceId((current) => {
        const validCurrent = current && (
          nextSearchPlaces.some((item) => `place:${item.id}` === current)
          || nextLocationOptions.some((item) => `branch:${item.id}` === current)
        );
        if (validCurrent) return current;
        if (queryPickupLocationId && nextSearchPlaces.some((item) => String(item.id) === String(queryPickupLocationId))) {
          return `place:${queryPickupLocationId}`;
        }
        const matchingBranch = queryPickupLocationId
          ? nextLocationOptions.find((option) => option.locationIds.some((id) => String(id) === String(queryPickupLocationId)))
          : null;
        if (matchingBranch) return `branch:${matchingBranch.id}`;
        if (nextSearchPlaces[0]?.id) return `place:${nextSearchPlaces[0].id}`;
        if (nextLocationOptions[0]?.id) return `branch:${nextLocationOptions[0].id}`;
        return '';
      });
    } catch (err) {
      setError(err.message);
    } finally {
      setLoadingBootstrap(false);
    }
  };

  useEffect(() => {
    loadBootstrap(queryTenantSlug || initialDraft?.tenantSlug || '');
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    try {
      sessionStorage.setItem(PUBLIC_BOOKING_DRAFT_KEY, JSON.stringify({
        tenantSlug,
        uiStep,
        searchMode,
        pickupLocationId,
        returnLocationId,
        carSharingSearchPlaceId,
        vehicleTypeId,
        pickupAt,
        returnAt,
        results,
        selectedResult,
        selectedFulfillmentChoice,
        selectedDeliveryArea,
        checkoutState,
        selectedServices,
        insuranceSelection,
        lookupState
      }));
    } catch {}
  }, [
    checkoutState,
    carSharingSearchPlaceId,
    insuranceSelection,
    lookupState,
    pickupAt,
    pickupLocationId,
    results,
    returnAt,
    returnLocationId,
    searchMode,
    selectedResult,
    selectedFulfillmentChoice,
    selectedDeliveryArea,
    selectedServices,
    tenantSlug,
    uiStep,
    vehicleTypeId
  ]);

  useEffect(() => {
    if (!selectedResult) {
      setSelectedServices({});
      setInsuranceSelection(buildInsuranceSelectionState(null, searchMode));
      setSelectedFulfillmentChoice('PICKUP');
      setSelectedDeliveryArea('');
      return;
    }
    setSelectedServices(buildServiceSelectionState(selectedResult));
    setInsuranceSelection(buildInsuranceSelectionState(selectedResult, searchMode));
    if (searchMode === 'CAR_SHARING') {
      setSelectedFulfillmentChoice(defaultFulfillmentChoice(selectedResult));
      setSelectedDeliveryArea(Array.isArray(selectedResult.deliveryAreas) ? (selectedResult.deliveryAreas[0] || '') : '');
    }
  }, [selectedResult, searchMode]);

  useEffect(() => {
    if (searchMode !== 'CAR_SHARING') {
      setSelectedDeliveryArea('');
      return;
    }
    if (selectedFulfillmentChoice !== 'DELIVERY') {
      setSelectedDeliveryArea('');
      return;
    }
    const allowedAreas = Array.isArray(selectedResult?.deliveryAreas) ? selectedResult.deliveryAreas : [];
    if (!allowedAreas.length) return;
    if (!allowedAreas.includes(selectedDeliveryArea)) {
      setSelectedDeliveryArea(allowedAreas[0] || '');
    }
  }, [searchMode, selectedDeliveryArea, selectedFulfillmentChoice, selectedResult]);

  useEffect(() => {
    if (autoSearchDone || loadingBootstrap || !bootstrap) return;
    const shouldAutoSearch = !!queryVehicleTypeId || (!!queryPickupLocationId && !!queryPickupAt && !!queryReturnAt);
    if (!shouldAutoSearch) return;
    if (searchMode === 'CAR_SHARING' && !carSharingSearchPlaceId && !pickupLocationId) return;
    if (searchMode === 'RENTAL' && !pickupLocationId) return;
    setAutoSearchDone(true);
    runSearch();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoSearchDone, bootstrap, carSharingSearchPlaceId, loadingBootstrap, pickupLocationId, searchMode]);

  useEffect(() => {
    if (autoSelectionDone || !queryVehicleTypeId || !results?.results?.length) return;
    const match = results.results.find((row) => String(row?.vehicleType?.id || '') === String(queryVehicleTypeId));
    setAutoSelectionDone(true);
    if (!match) return;
    setSelectedResult(match);
    goToStep('checkout');
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoSelectionDone, queryVehicleTypeId, results]);

  const locations = bootstrap?.locations || [];
  const carSharingSearchPlaces = bootstrap?.carSharingSearchPlaces || [];
  const vehicleTypes = bootstrap?.vehicleTypes || [];
  const featuredListings = bootstrap?.featuredCarSharingListings || [];
  const bookingStage = uiStep === 'checkout' ? 'checkout' : uiStep === 'select' ? 'select' : 'search';
  const publicLocationOptions = useMemo(() => buildPublicLocationOptions(locations), [locations]);
  const carSharingSearchOptions = useMemo(() => {
    const directPlaces = carSharingSearchPlaces.map((place) => ({
      id: `place:${place.id}`,
      mode: 'SEARCH_PLACE',
      searchPlaceId: place.id,
      placeType: place.placeType || 'HOST_PICKUP_SPOT',
      groupLabel: searchPlaceGroupLabel(place.placeType),
      typeLabel: searchPlaceTypeLabel(place.placeType),
      label: carSharingSearchPlaceLabel(place),
      hint: carSharingSearchPlaceHint(place),
      place
    }));
    const branchFallbacks = publicLocationOptions.map((location) => ({
      id: `branch:${location.id}`,
      mode: 'LOCATION_GROUP',
      searchPlaceId: '',
      placeType: 'TENANT_BRANCH',
      groupLabel: 'Branch areas',
      typeLabel: 'Branch area',
      locationIds: location.locationIds,
      label: `${location.label} | Branch area`,
      hint: 'Search host pickups and deliveries anchored to this branch area',
      location
    }));
    return [...directPlaces, ...branchFallbacks].sort((left, right) => {
      const priorityDiff = searchPlaceTypePriority(left.placeType) - searchPlaceTypePriority(right.placeType);
      if (priorityDiff !== 0) return priorityDiff;
      return String(left.label || '').localeCompare(String(right.label || ''));
    });
  }, [carSharingSearchPlaces, publicLocationOptions]);
  const carSharingSearchOptionGroups = useMemo(
    () => buildCarSharingSearchOptionGroups(carSharingSearchOptions),
    [carSharingSearchOptions]
  );
  const featuredCarSharingSearchOptions = useMemo(
    () => carSharingSearchOptions
      .filter((option) => option.mode === 'SEARCH_PLACE' && ['AIRPORT', 'HOTEL', 'NEIGHBORHOOD', 'STATION'].includes(String(option.placeType || '').toUpperCase()))
      .slice(0, 6),
    [carSharingSearchOptions]
  );
  const selectedPickupLocationOption = useMemo(
    () => publicLocationOptions.find((location) => location.id === pickupLocationId) || null,
    [publicLocationOptions, pickupLocationId]
  );
  const selectedCarSharingSearchOption = useMemo(
    () => carSharingSearchOptions.find((option) => option.id === carSharingSearchPlaceId) || null,
    [carSharingSearchOptions, carSharingSearchPlaceId]
  );
  const availableReturnLocations = useMemo(() => {
    if (!selectedPickupLocationOption?.tenantIds?.length) return publicLocationOptions;
    return publicLocationOptions.filter((location) => location.tenantIds.some((tenantId) => selectedPickupLocationOption.tenantIds.includes(tenantId)));
  }, [publicLocationOptions, selectedPickupLocationOption?.tenantIds]);
  const availableVehicleTypes = useMemo(() => {
    if (!selectedPickupLocationOption?.tenantIds?.length) return vehicleTypes;
    return vehicleTypes.filter((vehicleType) => selectedPickupLocationOption.tenantIds.includes(vehicleType.tenantId));
  }, [selectedPickupLocationOption?.tenantIds, vehicleTypes]);

  const goToStep = (step) => {
    setUiStep(step);
    if (typeof window !== 'undefined') {
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }
  };

  const clearSelection = () => {
    setSelectedResult(null);
    goToStep(results?.results?.length ? 'select' : 'search');
  };

  const resolveReturnLocationForSelection = () => {
    if (!selectedResult?.location?.tenantId) return selectedResult?.location?.id || '';
    const chosenReturnOption = publicLocationOptions.find((location) => location.id === returnLocationId);
    const matchingReturnLocation = chosenReturnOption?.locations?.find((location) => location.tenantId === selectedResult.location.tenantId);
    return matchingReturnLocation?.id || selectedResult?.location?.id || '';
  };

  useEffect(() => {
    if (!availableReturnLocations.some((location) => location.id === returnLocationId)) {
      setReturnLocationId(availableReturnLocations[0]?.id || '');
    }
  }, [availableReturnLocations, returnLocationId]);

  useEffect(() => {
    if (!availableVehicleTypes.some((vehicleType) => vehicleType.id === vehicleTypeId)) {
      setVehicleTypeId('');
    }
  }, [availableVehicleTypes, vehicleTypeId]);

  const chosenAdditionalServices = useMemo(() => {
    if (!selectedResult?.additionalServices?.length) return [];
    const bookingDays = searchMode === 'RENTAL'
      ? Number(selectedResult?.quote?.days || 1)
      : Number(selectedResult?.quote?.tripDays || 1);
    return selectedResult.additionalServices
      .filter((service) => selectedServices[service.serviceId]?.selected || service.mandatory)
      .map((service) => {
        const quantity = Math.max(1, Number(selectedServices[service.serviceId]?.quantity ?? service.quantity ?? 1) || 1);
        const total = service.pricingMode === 'PER_DAY'
          ? Number(service.rate || 0) * bookingDays * quantity
          : Number(service.rate || 0) * quantity;
        return {
          ...service,
          quantity,
          total
        };
      });
  }, [searchMode, selectedResult, selectedServices]);

  const chosenAdditionalServicesTotal = useMemo(
    () => chosenAdditionalServices.reduce((sum, service) => sum + Number(service.total || 0), 0),
    [chosenAdditionalServices]
  );
  const linkedServiceFees = useMemo(() => {
    if (!chosenAdditionalServices.length) return [];
    const bookingDays = searchMode === 'RENTAL'
      ? Number(selectedResult?.quote?.days || 1)
      : Number(selectedResult?.quote?.tripDays || 1);
    const baseAmount = searchMode === 'RENTAL'
      ? Number(selectedResult?.quote?.baseTotal || 0) + Number(selectedResult?.quote?.mandatoryFees || 0) + chosenAdditionalServicesTotal
      : Number(selectedResult?.quote?.subtotal || 0) + chosenAdditionalServicesTotal;
    return chosenAdditionalServices
      .filter((service) => service.linkedFee?.feeId)
      .map((service) => ({
        ...service.linkedFee,
        serviceId: service.serviceId,
        serviceName: service.name,
        total: computeFeeLineTotal(service.linkedFee, { baseAmount, days: bookingDays })
      }));
  }, [chosenAdditionalServices, chosenAdditionalServicesTotal, searchMode, selectedResult]);
  const linkedServiceFeesTotal = useMemo(
    () => linkedServiceFees.reduce((sum, fee) => sum + Number(fee.total || 0), 0),
    [linkedServiceFees]
  );
  const mandatoryBookingFees = useMemo(
    () => Array.isArray(selectedResult?.mandatoryFees) ? selectedResult.mandatoryFees : [],
    [selectedResult]
  );
  const mandatoryBookingFeesTotal = useMemo(
    () => mandatoryBookingFees.reduce((sum, fee) => sum + Number(fee.total || 0), 0),
    [mandatoryBookingFees]
  );

  const selectedInsurancePlan = useMemo(() => {
    if (searchMode !== 'RENTAL') return null;
    const code = String(insuranceSelection.selectedPlanCode || '').trim().toUpperCase();
    if (!code) return null;
    return (selectedResult?.insurancePlans || []).find((plan) => String(plan.code || '').trim().toUpperCase() === code) || null;
  }, [insuranceSelection.selectedPlanCode, searchMode, selectedResult]);

  const selectedInsuranceTotal = useMemo(
    () => Number(selectedInsurancePlan?.total || 0),
    [selectedInsurancePlan]
  );

  const checkoutEstimatedTotal = useMemo(() => {
    if (!selectedResult) return 0;
    const baseTotal = searchMode === 'RENTAL'
      ? Number(selectedResult?.quote?.estimatedTripTotal || 0)
      : Number(
          selectedFulfillmentChoice === 'DELIVERY'
            ? (selectedResult?.quote?.deliveryTotal || selectedResult?.quote?.total || 0)
            : (selectedResult?.quote?.pickupTotal || selectedResult?.quote?.total || 0)
        );
    return baseTotal + chosenAdditionalServicesTotal + linkedServiceFeesTotal + selectedInsuranceTotal;
  }, [chosenAdditionalServicesTotal, linkedServiceFeesTotal, searchMode, selectedFulfillmentChoice, selectedInsuranceTotal, selectedResult]);

  const selectedCarSharingGuestTripFee = useMemo(() => {
    if (searchMode !== 'CAR_SHARING' || !selectedResult) return 0;
    return Number(
      selectedFulfillmentChoice === 'DELIVERY'
        ? (selectedResult?.quote?.deliveryGuestTripFee || selectedResult?.quote?.guestTripFee || 0)
        : (selectedResult?.quote?.pickupGuestTripFee || selectedResult?.quote?.guestTripFee || 0)
    );
  }, [searchMode, selectedFulfillmentChoice, selectedResult]);

  const selectedCarSharingHostChargeFees = useMemo(() => {
    if (searchMode !== 'CAR_SHARING' || !selectedResult) return 0;
    return Number(
      selectedFulfillmentChoice === 'DELIVERY'
        ? (selectedResult?.quote?.deliveryHostChargeFees || (Number(selectedResult?.quote?.fees || 0) - Number(selectedResult?.quote?.guestTripFee || 0)))
        : (selectedResult?.quote?.pickupHostChargeFees || (Number(selectedResult?.quote?.fees || 0) - Number(selectedResult?.quote?.guestTripFee || 0)))
    );
  }, [searchMode, selectedFulfillmentChoice, selectedResult]);
  const tripLengthDays = useMemo(() => {
    const pickup = new Date(pickupAt);
    const ret = new Date(returnAt);
    if (Number.isNaN(pickup.getTime()) || Number.isNaN(ret.getTime())) return 0;
    return Math.max(1, Math.ceil((ret - pickup) / (1000 * 60 * 60 * 24)));
  }, [pickupAt, returnAt]);

  const runSearch = async () => {
    const pickupLocationIds = publicLocationOptions.find((location) => location.id === pickupLocationId)?.locationIds || [];
    const returnLocationIds = publicLocationOptions.find((location) => location.id === returnLocationId)?.locationIds || pickupLocationIds;
    const selectedSearchOption = carSharingSearchOptions.find((option) => option.id === carSharingSearchPlaceId) || null;
    if (!pickupLocationIds.length) {
      if (searchMode === 'RENTAL') {
        setError('Choose a location before searching.');
        return;
      }
    }
    if (searchMode === 'CAR_SHARING' && !selectedSearchOption && !pickupLocationIds.length) {
      setError('Choose a search place before searching car sharing.');
      return;
    }
    setSearching(true);
    setError('');
    setSelectedResult(null);
    try {
      const endpoint = searchMode === 'RENTAL'
        ? '/api/public/booking/rental-search'
        : '/api/public/booking/car-sharing-search';
      const payload = await api(endpoint, {
        method: 'POST',
        body: JSON.stringify({
          tenantSlug,
          pickupLocationId: searchMode === 'RENTAL' ? pickupLocationIds[0] : '',
          pickupLocationIds: searchMode === 'RENTAL' ? pickupLocationIds : [],
          returnLocationId: searchMode === 'RENTAL' ? (returnLocationIds[0] || pickupLocationIds[0]) : '',
          returnLocationIds: searchMode === 'RENTAL' ? returnLocationIds : [],
          locationId: searchMode === 'CAR_SHARING'
            ? (selectedSearchOption?.mode === 'LOCATION_GROUP' ? selectedSearchOption.locationIds?.[0] || '' : '')
            : pickupLocationIds[0],
          locationIds: searchMode === 'CAR_SHARING'
            ? (selectedSearchOption?.mode === 'LOCATION_GROUP' ? selectedSearchOption.locationIds || [] : [])
            : pickupLocationIds,
          searchPlaceId: searchMode === 'CAR_SHARING' ? (selectedSearchOption?.searchPlaceId || '') : '',
          searchPlaceIds: searchMode === 'CAR_SHARING' && selectedSearchOption?.searchPlaceId ? [selectedSearchOption.searchPlaceId] : [],
          vehicleTypeId: vehicleTypeId || null,
          pickupAt,
          returnAt
        })
      });
      setResults(payload);
      goToStep(payload?.results?.length ? 'select' : 'search');
    } catch (err) {
      setResults(null);
      setError(err.message);
    } finally {
      setSearching(false);
    }
  };

  return (
    <main className={embedMode ? 'public-booking-shell public-booking-shell-embed' : 'public-booking-shell'}>
      <div className={embedMode ? 'public-booking-layout public-booking-layout-embed' : 'public-booking-layout'}>
        {embedMode ? (
          <section className="glass card-lg section-card">
            <div className="row-between">
              <div>
                <span className="eyebrow">Ride Fleet Booking</span>
                <div className="section-title">Reserve a vehicle without leaving your website.</div>
                <p className="ui-muted">Search availability, choose a vehicle class, and complete the booking flow here.</p>
              </div>
              <span className="status-chip neutral">{searchMode === 'RENTAL' ? 'Rental Flow' : 'Car Sharing Flow'}</span>
            </div>
          </section>
        ) : (
          <section className="glass card-lg page-hero">
            <div className="hero-grid">
              <div className="hero-copy">
                <span className="eyebrow">Ride Fleet Marketplace</span>
                <h1 className="page-title" style={{ fontSize: 'clamp(30px, 5vw, 54px)', lineHeight: 1.02 }}>
                  Find the right vehicle for your dates, location, and trip.
                </h1>
                <p>
                  Browse rental inventory and car sharing supply from one public booking flow built around where and when you need the vehicle.
                </p>
                <div className="hero-meta">
                  <span className="hero-pill">Location-first search</span>
                  <span className="hero-pill">Guided steps</span>
                  <span className="hero-pill">Rental + Car Sharing</span>
                </div>
              </div>
            </div>
          </section>
        )}

        <section className="glass card-lg section-card">
          <div className="row-between">
            <div>
              <div className="section-title">Booking Journey</div>
              <p className="ui-muted">One public path for search, selection, guest details, and confirmation.</p>
            </div>
            <span className="status-chip neutral">{searchMode === 'RENTAL' ? 'Rental Flow' : 'Car Sharing Flow'}</span>
          </div>
          <BookingStageBar stage={bookingStage} />
          <div className="inline-actions" style={{ marginTop: 14 }}>
            <button type="button" className={uiStep === 'search' ? '' : 'button-subtle'} onClick={() => goToStep('search')}>1. Search</button>
            <button
              type="button"
              className={uiStep === 'select' ? '' : 'button-subtle'}
              disabled={!results?.results?.length}
              onClick={() => goToStep('select')}
            >
              2. Select
            </button>
            <button
              type="button"
              className={uiStep === 'checkout' ? '' : 'button-subtle'}
              disabled={!selectedResult}
              onClick={() => goToStep('checkout')}
            >
              3. Guest Details
            </button>
          </div>
        </section>

        {uiStep === 'search' ? (
        <>
        <section className="split-panel">
          <div className="glass card-lg section-card">
            <div className="row-between">
              <div>
                <div className="section-title">Booking Search</div>
                <p className="ui-muted">Choose your location, dates, and trip type to see what is available.</p>
              </div>
              <div className="inline-actions">
                <button
                  type="button"
                  className={searchMode === 'RENTAL' ? '' : 'button-subtle'}
                  onClick={() => {
                    setSearchMode('RENTAL');
                    setResults(null);
                    setSelectedResult(null);
                    setUiStep('search');
                  }}
                >
                  Rental
                </button>
                <button
                  type="button"
                  className={searchMode === 'CAR_SHARING' ? '' : 'button-subtle'}
                  onClick={() => {
                    setSearchMode('CAR_SHARING');
                    setResults(null);
                    setSelectedResult(null);
                    setUiStep('search');
                  }}
                >
                  Car Sharing
                </button>
              </div>
            </div>

            <div className="form-grid-3">
              <div>
                <div className="label">Pickup</div>
                <input type="datetime-local" value={pickupAt} onChange={(event) => setPickupAt(event.target.value)} />
              </div>
              <div>
                <div className="label">Return</div>
                <input type="datetime-local" value={returnAt} onChange={(event) => setReturnAt(event.target.value)} />
              </div>
              <div>
                <div className="label">{searchMode === 'RENTAL' ? 'Pickup Location' : 'Where do you want the car?'}</div>
                {searchMode === 'RENTAL' ? (
                  <select value={pickupLocationId} onChange={(event) => setPickupLocationId(event.target.value)}>
                    {publicLocationOptions.map((location) => (
                      <option key={location.id} value={location.id}>{location.label}</option>
                    ))}
                  </select>
                ) : (
                  <select value={carSharingSearchPlaceId} onChange={(event) => setCarSharingSearchPlaceId(event.target.value)}>
                    {carSharingSearchOptionGroups.map((group) => (
                      <optgroup key={group.label} label={group.label}>
                        {group.options.map((option) => (
                          <option key={option.id} value={option.id}>{option.label}</option>
                        ))}
                      </optgroup>
                    ))}
                  </select>
                )}
              </div>
            </div>

            {searchMode === 'CAR_SHARING' && featuredCarSharingSearchOptions.length ? (
              <div className="surface-note" style={{ marginTop: 12, display: 'grid', gap: 10 }}>
                <strong>Popular search presets</strong>
                <div className="inline-actions">
                  {featuredCarSharingSearchOptions.map((option) => (
                    <button
                      key={option.id}
                      type="button"
                      className={carSharingSearchPlaceId === option.id ? '' : 'button-subtle'}
                      onClick={() => setCarSharingSearchPlaceId(option.id)}
                    >
                      {option.place?.publicLabel || option.place?.label || option.label}
                    </button>
                  ))}
                </div>
              </div>
            ) : null}

            {searchMode === 'CAR_SHARING' && selectedCarSharingSearchOption ? (
              <div className="surface-note" style={{ marginTop: 12 }}>
                <strong>{selectedCarSharingSearchOption.label}</strong>
                <br />
                {selectedCarSharingSearchOption.typeLabel}
                <br />
                {selectedCarSharingSearchOption.hint}
              </div>
            ) : null}

            <div className={searchMode === 'RENTAL' ? 'form-grid-2' : 'form-grid-1'}>
              {searchMode === 'RENTAL' ? (
                <>
                  <div>
                    <div className="label">Return Location</div>
                        <select value={returnLocationId} onChange={(event) => setReturnLocationId(event.target.value)}>
                          {availableReturnLocations.map((location) => (
                            <option key={location.id} value={location.id}>{location.label}</option>
                          ))}
                        </select>
                  </div>
                  <div>
                    <div className="label">Vehicle Type</div>
                        <select value={vehicleTypeId} onChange={(event) => setVehicleTypeId(event.target.value)}>
                          <option value="">All eligible classes</option>
                          {availableVehicleTypes.map((vehicleType) => (
                            <option key={vehicleType.id} value={vehicleType.id}>{vehicleType.name}</option>
                          ))}
                        </select>
                  </div>
                </>
              ) : null}
            </div>

            <div className="inline-actions">
              <button type="button" onClick={runSearch} disabled={loadingBootstrap || searching}>
                {searching ? 'Searching...' : `Search ${searchMode === 'RENTAL' ? 'Rental Vehicles' : 'Car Sharing Vehicles'}`}
              </button>
            </div>

            {error ? <div className="surface-note" style={{ color: '#991b1b' }}>{error}</div> : null}
          </div>

          <div className="glass card-lg section-card">
            <div className="row-between">
              <div>
                <div className="section-title">Discovery Feed</div>
                <p className="ui-muted">Featured availability and host trust signals for the public booking experience.</p>
              </div>
              <span className="status-chip neutral">Featured Vehicles</span>
            </div>
            {featuredListings.length ? (
              <div className="stack">
                {featuredListings.map((listing) => (
                  <div key={listing.id} className="surface-note" style={{ display: 'grid', gap: 10 }}>
                    {listing.primaryImageUrl ? (
                      <img src={listing.primaryImageUrl} alt={listing.title} style={{ width: '100%', aspectRatio: '16 / 9', objectFit: 'cover', borderRadius: 16, border: '1px solid rgba(110,73,255,.15)' }} />
                    ) : null}
                    <strong>{listing.title}</strong>
                    <br />
                    {listing.vehicle?.label || 'Vehicle pending'}
                    <br />
                    {`Fulfillment ${fulfillmentModeLabel(listing.fulfillmentMode)}`}
                    {listing.deliveryRadiusMiles ? ` | ${listing.deliveryRadiusMiles} mi radius` : ''}
                    {Array.isArray(listing.deliveryAreas) && listing.deliveryAreas.length ? ` | ${listing.deliveryAreas.length} delivery areas` : ''}
                    {listing.deliveryNotes ? ` | ${listing.deliveryNotes}` : ''}
                    <br />
                    Search place: {listing.searchPlace ? carSharingSearchPlaceLabel(listing.searchPlace) : publicPickupSpotLabel(listing.pickupSpot, listing.location)}
                    {pickupSpotHint(listing.pickupSpot) ? (
                      <>
                        <br />
                        {pickupSpotHint(listing.pickupSpot)}
                      </>
                    ) : null}
                    {listing.location?.name ? ` | ${listing.location.name}` : ''}
                    <br />
                    Host: {listing.host?.displayName || 'Unassigned'} | {fmtRating(listing.host?.averageRating, listing.host?.reviewCount)} | From {fmtMoney(listing.baseDailyRate)}/day
                  </div>
                ))}
              </div>
            ) : (
              <div className="surface-note">
                No featured car sharing vehicles are highlighted yet. You can still search the location and dates above.
              </div>
            )}
          </div>
        </section>

        <section className="glass card-lg section-card">
          <div className="row-between">
            <div>
              <div className="section-title">Find Existing Booking</div>
              <p className="ui-muted">Already booked? Resume your trip with your reference number and email.</p>
            </div>
            <span className="status-chip neutral">Resume Flow</span>
          </div>
          <div className="form-grid-2">
            <div>
              <div className="label">Reference</div>
              <input
                value={lookupState.reference}
                onChange={(event) => setLookupState((current) => ({ ...current, reference: event.target.value }))}
                placeholder="Reservation number or trip code"
              />
            </div>
            <div>
              <div className="label">Email</div>
              <input
                type="email"
                value={lookupState.email}
                onChange={(event) => setLookupState((current) => ({ ...current, email: event.target.value }))}
                placeholder="guest@email.com"
              />
            </div>
          </div>
          <div className="inline-actions">
            <button
              type="button"
              disabled={lookingUp}
              onClick={async () => {
                setLookingUp(true);
                setError('');
                try {
                  const payload = await api('/api/public/booking/lookup', {
                    method: 'POST',
                    body: JSON.stringify({
                      tenantSlug,
                      reference: lookupState.reference,
                      email: lookupState.email
                    })
                  });
                  if (typeof window !== 'undefined') {
                    sessionStorage.setItem('fleet_public_booking_confirmation', JSON.stringify(payload));
                  }
                  router.push('/book/confirmation');
                } catch (err) {
                  setError(err.message);
                } finally {
                  setLookingUp(false);
                }
              }}
            >
              {lookingUp ? 'Finding Booking...' : 'Find My Booking'}
            </button>
          </div>
        </section>
        </>
        ) : null}

        {uiStep !== 'search' ? (
        <>
        <section className="glass card-lg section-card">
          <div className="row-between">
            <div>
              <div className="section-title">{uiStep === 'select' ? 'Step 2 | Select Your Vehicle' : 'Step 3 | Guest Details'}</div>
              <p className="ui-muted">
                {searchMode === 'RENTAL'
                  ? `${selectedPickupLocationOption?.label || 'Selected location'} | ${pickupAt} to ${returnAt}`
                  : `${selectedCarSharingSearchOption?.label || selectedPickupLocationOption?.label || 'Selected search place'} | ${pickupAt} to ${returnAt}`}
              </p>
            </div>
            <div className="inline-actions">
              <button type="button" className="button-subtle" onClick={() => goToStep('search')}>Back to Search</button>
              {uiStep === 'checkout' ? (
                <button type="button" className="button-subtle" onClick={() => goToStep('select')}>Back to Results</button>
              ) : null}
            </div>
          </div>
          <div className="app-banner-list">
            <span className="app-banner-pill">{selectedPickupLocationOption?.label || 'Selected location'}</span>
            {searchMode === 'CAR_SHARING' && selectedCarSharingSearchOption ? (
              <span className="app-banner-pill">{selectedCarSharingSearchOption.label}</span>
            ) : null}
            <span className="app-banner-pill">{pickupAt}</span>
            <span className="app-banner-pill">{returnAt}</span>
            {selectedResult ? (
              <span className="app-banner-pill">
                {searchMode === 'RENTAL' ? (selectedResult.vehicleType?.name || 'Selected rental') : (selectedResult.title || 'Selected vehicle')}
              </span>
            ) : null}
          </div>
          <div className="app-card-grid compact">
            <div className="info-tile">
              <span className="label">Pickup</span>
              <strong>{searchMode === 'CAR_SHARING' ? (selectedCarSharingSearchOption?.label || 'Selected search place') : (selectedPickupLocationOption?.label || 'Selected location')}</strong>
            </div>
            <div className="info-tile">
              <span className="label">Trip Length</span>
              <strong>{tripLengthDays} day{tripLengthDays === 1 ? '' : 's'}</strong>
            </div>
            <div className="info-tile">
              <span className="label">Selected Package</span>
              <strong>{selectedResult ? (searchMode === 'RENTAL' ? (selectedResult.vehicleType?.name || 'Rental option') : (selectedResult.title || 'Vehicle')) : 'Choose vehicle'}</strong>
            </div>
            <div className="info-tile">
              <span className="label">Estimated Total</span>
              <strong>{selectedResult ? fmtMoney(checkoutEstimatedTotal) : '$0.00'}</strong>
            </div>
          </div>
        </section>

        {uiStep === 'select' ? (
        <section className="glass card-lg section-card">
          <div className="row-between">
            <div>
              <div className="section-title">Search Results</div>
              <p className="ui-muted">
                {results
                  ? `${results.results?.length || 0} ${searchMode === 'RENTAL' ? 'rental quote option(s)' : 'listing option(s)'} returned`
                  : 'Run a search to load public inventory and pricing.'}
              </p>
            </div>
            <span className="status-chip neutral">{searchMode === 'RENTAL' ? 'Rental options' : 'Car sharing options'}</span>
          </div>

          {results?.results?.length ? (
            <>
            {selectedResult ? (
              <div className="surface-note" style={{ marginBottom: 14 }}>
                <strong>Selected Package</strong>
                <br />
                {searchMode === 'RENTAL'
                  ? `${selectedResult.vehicleType?.name || 'Rental option'} | Estimated total ${fmtMoney(selectedResult.quote?.estimatedTripTotal)}`
                  : `${selectedResult.title || 'Vehicle'} | Estimated total ${fmtMoney(checkoutEstimatedTotal)}`}
                {searchMode === 'RENTAL' && selectedResult?.quote?.revenuePricingApplied ? (
                  <>
                    <br />
                    <span className="ui-muted">
                      Revenue-adjusted quote: base daily {fmtMoney(selectedResult.quote?.baseDailyRate)} to current daily {fmtMoney(selectedResult.quote?.dailyRate)}.
                    </span>
                  </>
                ) : null}
              </div>
            ) : null}
            <div className="grid2" style={{ marginBottom: 0 }}>
              {searchMode === 'RENTAL'
                ? results.results.map((result) => (
                    <BookingCard
                      key={result.vehicleType.id}
                      title={result.vehicleType.name}
                      subtitle={`${result.sampleVehicleLabel || result.vehicleType.description || 'Public rental quote available'}${result.location?.name ? ` | ${publicLocationLabel(result.location)}` : ''}`}
                      meta={result.soldOut ? 'Waitlist / sold out' : `${result.availabilityCount} unit(s) available`}
                      selected={selectedResult?.vehicleType?.id === result.vehicleType.id}
                      imageUrl={result.primaryImageUrl}
                      imageUrls={result.imageUrls}
                      hints={[
                        ...(result.quote?.revenuePricingApplied ? [`Revenue adjusted +${Number(result.quote?.revenueAdjustmentPct || 0).toFixed(2)}%`] : []),
                        ...(result.additionalServices?.length ? [`${result.additionalServices.length} add-on${result.additionalServices.length === 1 ? '' : 's'} online`] : []),
                        ...(result.insurancePlans?.length ? [`${result.insurancePlans.length} insurance option${result.insurancePlans.length === 1 ? '' : 's'}`] : [])
                      ]}
                      quote={[
                        { label: 'Daily Rate', value: fmtMoney(result.quote.dailyRate) },
                        ...(result.quote?.revenuePricingApplied ? [{ label: 'Base Daily', value: fmtMoney(result.quote.baseDailyRate) }] : []),
                        { label: 'Trip Total', value: fmtMoney(result.quote.estimatedTripTotal) },
                        { label: 'Deposit Due', value: fmtMoney(result.quote.depositAmountDue) },
                        { label: 'Security Deposit', value: fmtMoney(result.quote.securityDepositAmount) }
                      ]}
                      cta={result.soldOut ? 'Notify Me Later' : 'Continue'}
                      onClick={() => {
                        setSelectedResult(result);
                        goToStep('checkout');
                      }}
                    />
                  ))
                : results.results.map((result) => (
                    <BookingCard
                      key={result.id}
                      title={result.title}
                      subtitle={`${result.vehicle?.label || 'Vehicle'}${result.searchPlace?.label ? ` | ${result.searchPlace.label}` : result.location?.name ? ` | ${result.location.name}` : ''}`}
                      meta={result.recommendedBadge || (result.instantBook ? 'Instant book ready' : `Hosted by ${result.host?.displayName || 'Host'}`)}
                      selected={selectedResult?.id === result.id}
                      imageUrl={result.primaryImageUrl}
                      imageUrls={result.imageUrls}
                      hostSummary={result.host ? `${result.host.displayName} | ${fmtRating(result.host.averageRating, result.host.reviewCount)}` : ''}
                      hostHref={result.host?.id ? `/host-profile/${result.host.id}` : ''}
                      hints={[
                        ...carSharingDiscoveryBadges(result),
                        ...(result.trustScore ? [`Trust score ${result.trustScore}/100`] : []),
                        ...(result.trustTripSignals?.completionRatePct ? [`${Math.round(Number(result.trustTripSignals.completionRatePct || 0))}% trip completion`] : []),
                        ...(result.trustTripSignals?.handoffConfirmationRatePct ? [`${Math.round(Number(result.trustTripSignals.handoffConfirmationRatePct || 0))}% handoff confirmation`] : []),
                        ...((result.trustReasons || []).slice(0, 2)),
                        ...((result.rankingReasons || []).slice(0, 2)),
                        ...(!result.instantBook ? ['Approval flow'] : []),
                        `${Math.max(1, Number(result.minTripDays || 1))}+ day minimum`,
                        fulfillmentHint(result),
                        ...(result.searchPlace?.label ? [`Search place: ${result.searchPlace.label}`] : []),
                        ...(result.pickupSpot?.label ? [`Pickup spot: ${result.pickupSpot.label}`] : []),
                        ...(pickupSpotHint(result.pickupSpot) ? [pickupSpotHint(result.pickupSpot)] : []),
                        ...(result.deliveryNotes ? [result.deliveryNotes] : []),
                        ...(normalizeImageList(result.imageUrls || []).length ? [`${normalizeImageList(result.imageUrls || []).length} photo${normalizeImageList(result.imageUrls || []).length === 1 ? '' : 's'}`] : []),
                        ...(result.additionalServices?.length ? [`${result.additionalServices.length} host add-on${result.additionalServices.length === 1 ? '' : 's'}`] : [])
                      ]}
                      quote={[
                        { label: 'Daily Rate', value: fmtMoney(result.quote.subtotal / Math.max(1, result.quote.tripDays)) },
                        { label: 'Trip Total', value: fmtMoney(result.quote.total) },
                        { label: 'Trip Fee', value: fmtMoney(result.quote.guestTripFee) },
                        { label: 'Minimum Trip', value: `${Math.max(1, Number(result.minTripDays || 1))} day${Math.max(1, Number(result.minTripDays || 1)) === 1 ? '' : 's'}` },
                        ...(result.trustScore ? [{ label: 'Trust Score', value: `${result.trustScore}/100` }] : [])
                      ]}
                      cta={result.instantBook ? 'Continue' : 'Request Booking'}
                      onClick={() => {
                        setSelectedResult(result);
                        goToStep('checkout');
                      }}
                    />
                  ))}
            </div>
            </>
          ) : (
            <div className="surface-note">
              {results
                ? 'No options matched those dates yet. Try another date range or location.'
                : 'Search results will appear here with a shared quote contract for both rental and car sharing.'}
            </div>
          )}
        </section>
        ) : null}
        </>
        ) : null}

        {selectedResult && uiStep === 'checkout' ? (
          <section className="glass card-lg section-card">
            <div className="row-between">
              <div>
                <div className="section-title">Selected Package</div>
                <p className="ui-muted">Review the vehicle, pricing, and next guest steps before creating the booking.</p>
              </div>
              <button type="button" className="button-subtle" onClick={clearSelection}>Clear</button>
            </div>
            <div className="split-panel">
              <div className="surface-note">
                {normalizeImageList(selectedResult.imageUrls?.length ? selectedResult.imageUrls : selectedResult.primaryImageUrl ? [selectedResult.primaryImageUrl] : [])[0] ? (
                  <div className="stack" style={{ gap: 10, marginBottom: 12 }}>
                    <img
                      src={normalizeImageList(selectedResult.imageUrls?.length ? selectedResult.imageUrls : [selectedResult.primaryImageUrl])[0]}
                      alt={searchMode === 'RENTAL' ? selectedResult.vehicleType?.name : selectedResult.title}
                      style={{ width: '100%', maxWidth: 520, aspectRatio: '16 / 9', objectFit: 'cover', borderRadius: 18, border: '1px solid rgba(110,73,255,.15)' }}
                    />
                    {normalizeImageList(selectedResult.imageUrls?.length ? selectedResult.imageUrls : [selectedResult.primaryImageUrl]).length > 1 ? (
                      <div className="inline-actions">
                        {normalizeImageList(selectedResult.imageUrls).map((photo, index) => (
                          <img
                            key={`selected-${index}`}
                            src={photo}
                            alt={`Selected option ${index + 1}`}
                            style={{ width: 72, height: 52, objectFit: 'cover', borderRadius: 12, border: '1px solid rgba(110,73,255,.15)' }}
                          />
                        ))}
                      </div>
                    ) : null}
                  </div>
                ) : null}
                <strong>{searchMode === 'RENTAL' ? selectedResult.vehicleType?.name : selectedResult.title}</strong>
                <br />
                {searchMode === 'RENTAL'
                  ? `Pickup ${publicLocationLabel(selectedResult.location || {})} | ${fmtMoney(checkoutEstimatedTotal)} estimated total`
                  : `${selectedResult.vehicle?.label || ''} | ${fmtMoney(selectedResult.quote?.total)} trip total before host add-ons`}
                <br />
                {searchMode === 'CAR_SHARING' && selectedResult.host ? (
                  <>
                    {`Host ${selectedResult.host.displayName} | ${fmtRating(selectedResult.host.averageRating, selectedResult.host.reviewCount)}`}
                    {selectedResult.host.id ? (
                      <>
                        {' | '}
                        <Link href={`/host-profile/${selectedResult.host.id}`}>View profile</Link>
                      </>
                    ) : null}
                    <br />
                  </>
                ) : null}
                {searchMode === 'CAR_SHARING' ? (
                  <>
                    {`Search place ${selectedResult.searchPlace?.label || publicPickupSpotLabel(selectedResult.pickupSpot, selectedResult.location)}`}
                    {pickupSpotHint(selectedResult.pickupSpot) ? ` | ${pickupSpotHint(selectedResult.pickupSpot)}` : ''}
                    <br />
                    {uniqueLabels([selectedResult.recommendedBadge, selectedResult.matchReason]).join(' | ')}
                    <br />
                    {selectedResult.trustBadge ? `${selectedResult.trustBadge} | ` : ''}{selectedResult.trustScore ? `Trust score ${selectedResult.trustScore}/100` : ''}
                    <br />
                  </>
                ) : null}
                {searchMode === 'RENTAL'
                  ? `Deposit due now: ${fmtMoney(selectedResult.quote?.depositAmountDue)}${chosenAdditionalServicesTotal ? ` | Add-ons ${fmtMoney(chosenAdditionalServicesTotal)}` : ''}${selectedInsuranceTotal ? ` | Insurance ${fmtMoney(selectedInsuranceTotal)}` : ''}`
                  : `Trip total: ${fmtMoney(checkoutEstimatedTotal)} | Mandatory trip fee ${fmtMoney(selectedCarSharingGuestTripFee)}${chosenAdditionalServicesTotal ? ` | Vehicle add-ons ${fmtMoney(chosenAdditionalServicesTotal)}` : ''}`}
              </div>

              <div className="section-card">
                <div className="app-card-grid compact" style={{ marginBottom: 12 }}>
                  {searchMode === 'RENTAL' ? (
                    <>
                      <div className="doc-card">
                        <strong>Estimated Total</strong>
                        <div className="doc-meta">{fmtMoney(checkoutEstimatedTotal)}</div>
                      </div>
                      <div className="doc-card">
                        <strong>Due At Pre-Check-In</strong>
                        <div className="doc-meta">{fmtMoney(selectedResult?.quote?.depositAmountDue)}</div>
                      </div>
                      <div className="doc-card">
                        <strong>Security Deposit</strong>
                        <div className="doc-meta">{fmtMoney(selectedResult?.quote?.securityDepositAmount)}</div>
                      </div>
                      <div className="doc-card">
                        <strong>Included Extras</strong>
                        <div className="doc-meta">{selectedResult?.additionalServices?.length || 0} service option{(selectedResult?.additionalServices?.length || 0) === 1 ? '' : 's'}</div>
                      </div>
                    </>
                  ) : (
                    <>
                      <div className="doc-card">
                        <strong>Trip Total</strong>
                        <div className="doc-meta">{fmtMoney(checkoutEstimatedTotal)}</div>
                      </div>
                      <div className="doc-card">
                        <strong>Mandatory Trip Fee</strong>
                        <div className="doc-meta">{fmtMoney(selectedCarSharingGuestTripFee)}</div>
                      </div>
                      <div className="doc-card">
                        <strong>Trip Length</strong>
                        <div className="doc-meta">{Math.max(1, Number(selectedResult?.quote?.tripDays || 1))} day{Math.max(1, Number(selectedResult?.quote?.tripDays || 1)) === 1 ? '' : 's'}</div>
                      </div>
                      <div className="doc-card">
                        <strong>Host Trust</strong>
                        <div className="doc-meta">{selectedResult?.host ? fmtRating(selectedResult.host.averageRating, selectedResult.host.reviewCount) : 'New host'}</div>
                      </div>
                    </>
                  )}
                </div>
                <div className="surface-note" style={{ marginBottom: 6 }}>
                  <strong>Checkout Snapshot</strong>
                  <br />
                  {searchMode === 'RENTAL'
                    ? `Base total ${fmtMoney(selectedResult?.quote?.estimatedTripTotal)}${mandatoryBookingFeesTotal ? ` | Required fees ${fmtMoney(mandatoryBookingFeesTotal)}` : ''} | Estimated total ${fmtMoney(checkoutEstimatedTotal)}`
                    : `Base host charges ${fmtMoney(selectedCarSharingHostChargeFees)} | Mandatory trip fee ${fmtMoney(selectedCarSharingGuestTripFee)} | Guest total ${fmtMoney(checkoutEstimatedTotal)}.`}
                </div>
                {searchMode === 'CAR_SHARING' ? (
                  <div className="surface-note" style={{ marginBottom: 12, display: 'grid', gap: 10 }}>
                    <strong>Pickup Or Delivery</strong>
                    <div>{fulfillmentHint(selectedResult)}</div>
                    {selectedResult.recommendedBadge ? <div>{selectedResult.recommendedBadge}</div> : null}
                    {selectedResult.matchReason ? <div>{selectedResult.matchReason}</div> : null}
                    {(selectedResult.trustScore || selectedResult.trustBadge) ? (
                      <div>
                        {selectedResult.trustBadge ? `${selectedResult.trustBadge} · ` : ''}
                        {selectedResult.trustScore ? `Trust score ${selectedResult.trustScore}/100` : ''}
                      </div>
                    ) : null}
                    {selectedResult.trustTripSignals ? (
                      <div>
                        {selectedResult.trustTripSignals.tripCount ? `${selectedResult.trustTripSignals.tripCount} recent trip${selectedResult.trustTripSignals.tripCount === 1 ? '' : 's'}` : 'New listing'}
                        {selectedResult.trustTripSignals.completionRatePct ? ` · ${Math.round(Number(selectedResult.trustTripSignals.completionRatePct || 0))}% completion` : ''}
                        {selectedResult.trustTripSignals.pickupReliabilityPct ? ` · ${Math.round(Number(selectedResult.trustTripSignals.pickupReliabilityPct || 0))}% pickup reliability` : ''}
                      </div>
                    ) : null}
                    {(selectedResult.rankingReasons || []).length ? (
                      <div className="inline-actions">
                        {selectedResult.rankingReasons.slice(0, 4).map((reason) => (
                          <span key={reason} className="status-chip neutral">{reason}</span>
                        ))}
                      </div>
                    ) : null}
                    {(selectedResult.trustReasons || []).length ? (
                      <div className="inline-actions">
                        {selectedResult.trustReasons.slice(0, 4).map((reason) => (
                          <span key={reason} className="status-chip neutral">{reason}</span>
                        ))}
                      </div>
                    ) : null}
                    {selectedResult.exactLocationHidden ? <div>Exact pickup details will be shared after booking confirmation.</div> : null}
                    {Array.isArray(selectedResult.deliveryAreas) && selectedResult.deliveryAreas.length ? (
                      <div>Allowed delivery areas: {selectedResult.deliveryAreas.join(' | ')}</div>
                    ) : null}
                    {selectedResult.deliveryNotes ? <div>{selectedResult.deliveryNotes}</div> : null}
                    {String(selectedResult.fulfillmentMode || 'PICKUP_ONLY').toUpperCase() === 'PICKUP_OR_DELIVERY' ? (
                      <div className="inline-actions">
                        <button type="button" className={selectedFulfillmentChoice === 'PICKUP' ? '' : 'button-subtle'} onClick={() => setSelectedFulfillmentChoice('PICKUP')}>
                          Pickup {Number(selectedResult.pickupFee || 0) > 0 ? `| ${fmtMoney(selectedResult.pickupFee)}` : '| Included'}
                        </button>
                        <button type="button" className={selectedFulfillmentChoice === 'DELIVERY' ? '' : 'button-subtle'} onClick={() => setSelectedFulfillmentChoice('DELIVERY')}>
                          Delivery {Number(selectedResult.deliveryFee || 0) > 0 ? `| ${fmtMoney(selectedResult.deliveryFee)}` : '| Included'}
                        </button>
                      </div>
                    ) : (
                      <div>
                        {String(selectedResult.fulfillmentMode || 'PICKUP_ONLY').toUpperCase() === 'DELIVERY_ONLY'
                          ? `Delivery is required for this listing${Number(selectedResult.deliveryFee || 0) > 0 ? ` | ${fmtMoney(selectedResult.deliveryFee)}` : ''}.`
                          : `Pickup is required for this listing${Number(selectedResult.pickupFee || 0) > 0 ? ` | ${fmtMoney(selectedResult.pickupFee)}` : ''}.`}
                      </div>
                    )}
                    {selectedFulfillmentChoice === 'DELIVERY' && Array.isArray(selectedResult.deliveryAreas) && selectedResult.deliveryAreas.length ? (
                      <div>
                        <div className="label">Delivery Area</div>
                        <select value={selectedDeliveryArea} onChange={(event) => setSelectedDeliveryArea(event.target.value)}>
                          {selectedResult.deliveryAreas.map((area) => <option key={area} value={area}>{area}</option>)}
                        </select>
                      </div>
                    ) : null}
                  </div>
                ) : null}
                <div className="section-title">Guest Details</div>
                {error ? <div className="surface-note" style={{ marginBottom: 16, color: '#991b1b' }}>{error}</div> : null}
                {searchMode === 'RENTAL' ? (
                  <div className="stack" style={{ marginBottom: 18 }}>
                    <div>
                      <div className="section-title" style={{ fontSize: 16 }}>Insurance</div>
                      <p className="ui-muted">Choose one of our protection plans or certify that you will use your own insurance and accept responsibility and liability.</p>
                    </div>
                    {selectedResult?.insurancePlans?.length ? (
                      <div className="stack">
                        <div className="form-grid-2">
                          <div>
                            <div className="label">Our Insurance Plan</div>
                            <select
                              value={insuranceSelection.selectedPlanCode}
                              onChange={(event) => {
                                const code = event.target.value;
                                setInsuranceSelection((current) => ({
                                  ...current,
                                  selectedPlanCode: code,
                                  declinedCoverage: false,
                                  usingOwnInsurance: false,
                                  liabilityAccepted: false
                                }));
                              }}
                            >
                              <option value="">Select a protection plan</option>
                              {selectedResult.insurancePlans.map((plan) => (
                                <option key={plan.code} value={plan.code}>
                                  {plan.name} ({plan.chargeBy === 'PER_DAY' ? `${fmtMoney(plan.amount)}/day` : plan.chargeBy === 'PERCENTAGE' ? `${plan.amount}%` : fmtMoney(plan.amount)})
                                </option>
                              ))}
                            </select>
                          </div>
                          <div>
                            <div className="label">Insurance Total</div>
                            <input value={selectedInsurancePlan ? fmtMoney(selectedInsurancePlan.total) : '$0.00'} disabled />
                          </div>
                        </div>
                        {selectedInsurancePlan?.description ? (
                          <div className="surface-note">{selectedInsurancePlan.description}</div>
                        ) : null}
                      </div>
                    ) : (
                      <div className="surface-note">
                        No house insurance plans are currently configured for this rental. The customer must proceed using their own insurance.
                      </div>
                    )}

                    <div className="surface-note" style={{ display: 'grid', gap: 10 }}>
                      <strong>Decline Our Insurance</strong>
                      <label style={{ display: 'inline-flex', gap: 8, alignItems: 'center' }}>
                        <input
                          type="checkbox"
                          checked={insuranceSelection.declinedCoverage}
                          onChange={(event) => {
                            const checked = event.target.checked;
                            setInsuranceSelection((current) => ({
                              ...current,
                              selectedPlanCode: checked ? '' : current.selectedPlanCode,
                              declinedCoverage: checked
                            }));
                          }}
                        />
                        <span>I decline the company insurance offered for this rental.</span>
                      </label>
                      <label style={{ display: 'inline-flex', gap: 8, alignItems: 'center' }}>
                        <input
                          type="checkbox"
                          checked={insuranceSelection.usingOwnInsurance}
                          onChange={(event) => setInsuranceSelection((current) => ({ ...current, usingOwnInsurance: event.target.checked }))}
                          disabled={!insuranceSelection.declinedCoverage}
                        />
                        <span>I confirm I will use my own insurance coverage for this rental.</span>
                      </label>
                      <label style={{ display: 'inline-flex', gap: 8, alignItems: 'center' }}>
                        <input
                          type="checkbox"
                          checked={insuranceSelection.liabilityAccepted}
                          onChange={(event) => setInsuranceSelection((current) => ({ ...current, liabilityAccepted: event.target.checked }))}
                          disabled={!insuranceSelection.declinedCoverage}
                        />
                        <span>I accept responsibility and liability if I decline your insurance coverage.</span>
                      </label>
                      <div>
                        <div className="label">Own Insurance Policy Number</div>
                        <input
                          value={insuranceSelection.ownPolicyNumber}
                          onChange={(event) => setInsuranceSelection((current) => ({ ...current, ownPolicyNumber: event.target.value }))}
                          placeholder="Optional but recommended if using your own policy"
                          disabled={!insuranceSelection.declinedCoverage}
                        />
                      </div>
                    </div>
                  </div>
                ) : null}
                {searchMode === 'RENTAL' && mandatoryBookingFees.length ? (
                  <div className="stack" style={{ marginBottom: 18 }}>
                    <div>
                      <div className="section-title" style={{ fontSize: 16 }}>Required Fees</div>
                      <p className="ui-muted">These fees are mandatory for this pickup location and are automatically included in the reservation total.</p>
                    </div>
                    <div className="stack">
                      {mandatoryBookingFees.map((fee) => (
                        <div key={fee.feeId || fee.code || fee.name} className="surface-note" style={{ display: 'grid', gap: 10 }}>
                          <div className="row-between" style={{ alignItems: 'start', gap: 12 }}>
                            <div className="stack" style={{ gap: 4 }}>
                              <strong>{fee.name}</strong>
                              {fee.description ? <span className="ui-muted">{fee.description}</span> : null}
                              <span className="eyebrow">
                                Required fee
                                {fee.taxable ? ' | Taxable' : ''}
                                {fee.mode ? ` | ${String(fee.mode).replaceAll('_', ' ')}` : ''}
                              </span>
                            </div>
                            <span className="status-chip neutral">Included</span>
                          </div>
                          <div className="form-grid-2">
                            <div>
                              <div className="label">Fee Total</div>
                              <input value={fmtMoney(fee.total)} disabled />
                            </div>
                            <div>
                              <div className="label">Billing Rule</div>
                              <input
                                value={
                                  String(fee.mode || 'FIXED').toUpperCase() === 'PER_DAY'
                                    ? `Per day for ${selectedResult?.quote?.days || 1} day(s)`
                                    : String(fee.mode || 'FIXED').toUpperCase() === 'PERCENTAGE'
                                      ? `${Number(fee.amount || 0).toFixed(2)}% of base rate`
                                      : 'Flat amount'
                                }
                                disabled
                              />
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                ) : null}
                {selectedResult?.additionalServices?.length ? (
                  <div className="stack" style={{ marginBottom: 18 }}>
                    <div>
                      <div className="section-title" style={{ fontSize: 16 }}>{searchMode === 'RENTAL' ? 'Additional Services' : 'Vehicle Add-Ons'}</div>
                      <p className="ui-muted">{searchMode === 'RENTAL' ? 'Add optional extras before the customer creates the reservation.' : 'Choose host-provided extras for this specific vehicle before creating the trip request.'}</p>
                    </div>
                    <div className="stack">
                      {selectedResult.additionalServices.map((service) => {
                        const serviceState = selectedServices[service.serviceId] || {
                          selected: !!service.mandatory,
                          quantity: Math.max(1, Number(service.quantity || 1) || 1)
                        };
                        const serviceTotal = service.pricingMode === 'PER_DAY'
                          ? Number(service.rate || 0) * Number(searchMode === 'RENTAL' ? selectedResult?.quote?.days || 1 : selectedResult?.quote?.tripDays || 1) * Number(serviceState.quantity || 1)
                          : Number(service.rate || 0) * Number(serviceState.quantity || 1);
                        return (
                          <div key={service.serviceId} className="surface-note" style={{ display: 'grid', gap: 12 }}>
                            <div className="row-between" style={{ alignItems: 'start', gap: 12 }}>
                              <div className="stack" style={{ gap: 4 }}>
                                <strong>{service.name}</strong>
                                {service.description ? <span className="ui-muted">{service.description}</span> : null}
                                <span className="eyebrow">
                                  {service.pricingMode === 'PER_DAY'
                                    ? `${fmtMoney(service.rate)} / ${service.unitLabel.toLowerCase()} / day`
                                    : `${fmtMoney(service.rate)} / ${service.unitLabel.toLowerCase()}`}
                                  {service.taxable ? ' | Taxable' : ''}
                                  {service.mandatory ? ' | Required' : ''}
                                  {service.linkedFee?.name ? ` | Auto fee ${service.linkedFee.name}` : ''}
                                </span>
                              </div>
                              <label style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                                <input
                                  type="checkbox"
                                  checked={!!serviceState.selected || !!service.mandatory}
                                  disabled={!!service.mandatory}
                                  onChange={(event) => {
                                    const checked = event.target.checked;
                                    setSelectedServices((current) => ({
                                      ...current,
                                      [service.serviceId]: {
                                        selected: checked,
                                        quantity: Math.max(1, Number(current[service.serviceId]?.quantity ?? service.quantity ?? 1) || 1)
                                      }
                                    }));
                                  }}
                                />
                                <span>{service.mandatory ? 'Included' : 'Add service'}</span>
                              </label>
                            </div>
                            <div className="form-grid-3">
                              <div>
                                <div className="label">Quantity</div>
                                <input
                                  type="number"
                                  min="1"
                                  value={serviceState.quantity}
                                  disabled={!serviceState.selected && !service.mandatory}
                                  onChange={(event) => {
                                    const quantity = Math.max(1, Number(event.target.value || 1) || 1);
                                    setSelectedServices((current) => ({
                                      ...current,
                                      [service.serviceId]: {
                                        selected: current[service.serviceId]?.selected ?? !!service.mandatory,
                                        quantity
                                      }
                                    }));
                                  }}
                                />
                              </div>
                              <div>
                                <div className="label">Billing</div>
                                <input
                                  value={service.pricingMode === 'PER_DAY' ? `Per day x ${searchMode === 'RENTAL' ? selectedResult?.quote?.days || 1 : selectedResult?.quote?.tripDays || 1} day(s)` : 'Flat'}
                                  disabled
                                />
                              </div>
                              <div>
                                <div className="label">Service Total</div>
                                <input value={fmtMoney(serviceTotal)} disabled />
                              </div>
                            </div>
                            {service.linkedFee?.name ? (
                              <div className="surface-note">
                                Selecting this service also adds the fee <strong>{service.linkedFee.name}</strong>
                                {service.linkedFee.mode ? ` (${String(service.linkedFee.mode).replaceAll('_', ' ')})` : ''}.
                              </div>
                            ) : null}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                ) : null}
                {linkedServiceFees.length ? (
                  <div className="stack" style={{ marginBottom: 18 }}>
                    <div>
                      <div className="section-title" style={{ fontSize: 16 }}>Auto-Applied Service Fees</div>
                      <p className="ui-muted">These fees are automatically added because of the services selected above.</p>
                    </div>
                    <div className="stack">
                      {linkedServiceFees.map((fee) => (
                        <div key={`${fee.feeId}-${fee.serviceId}`} className="surface-note" style={{ display: 'grid', gap: 8 }}>
                          <strong>{fee.name}</strong>
                          <span className="ui-muted">Triggered by {fee.serviceName}</span>
                          <div className="row-between" style={{ gap: 12 }}>
                            <span className="eyebrow">{String(fee.mode || 'FIXED').replaceAll('_', ' ')}</span>
                            <strong>{fmtMoney(fee.total)}</strong>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                ) : null}
                {!selectedResult?.additionalServices?.length ? (
                  <div className="surface-note" style={{ marginBottom: 18 }}>
                    {searchMode === 'RENTAL'
                      ? 'No online additional services are configured for this rental yet. In Settings > Additional Services, make sure the service is active, matches this location/vehicle type, and has Display Online enabled.'
                      : 'No host add-ons are configured for this vehicle yet.'}
                  </div>
                ) : null}

                <div className="form-grid-2">
                  <div>
                    <div className="label">First Name</div>
                    <input value={checkoutState.firstName} onChange={(event) => setCheckoutState((current) => ({ ...current, firstName: event.target.value }))} />
                  </div>
                  <div>
                    <div className="label">Last Name</div>
                    <input value={checkoutState.lastName} onChange={(event) => setCheckoutState((current) => ({ ...current, lastName: event.target.value }))} />
                  </div>
                </div>
                <div className="form-grid-2">
                  <div>
                    <div className="label">Email</div>
                    <input type="email" value={checkoutState.email} onChange={(event) => setCheckoutState((current) => ({ ...current, email: event.target.value }))} />
                  </div>
                  <div>
                    <div className="label">Phone</div>
                    <input value={checkoutState.phone} onChange={(event) => setCheckoutState((current) => ({ ...current, phone: event.target.value }))} />
                  </div>
                </div>
                <div className="form-grid-3">
                  <div>
                    <div className="label">Date of Birth</div>
                    <input type="date" value={checkoutState.dateOfBirth} onChange={(event) => setCheckoutState((current) => ({ ...current, dateOfBirth: event.target.value }))} />
                  </div>
                  <div>
                    <div className="label">License Number</div>
                    <input value={checkoutState.licenseNumber} onChange={(event) => setCheckoutState((current) => ({ ...current, licenseNumber: event.target.value }))} />
                  </div>
                  <div>
                    <div className="label">License State</div>
                    <input value={checkoutState.licenseState} onChange={(event) => setCheckoutState((current) => ({ ...current, licenseState: event.target.value }))} />
                  </div>
                </div>
                <div className="inline-actions">
                  <button
                    type="button"
                    disabled={submitting}
                    onClick={async () => {
                      if (searchMode === 'RENTAL' && !selectedInsurancePlan) {
                        if (!(insuranceSelection.declinedCoverage && insuranceSelection.usingOwnInsurance && insuranceSelection.liabilityAccepted)) {
                          setError('Choose one of our insurance plans or certify that you are declining it, using your own insurance, and accepting responsibility and liability.');
                          return;
                        }
                      }
                      setSubmitting(true);
                      setError('');
                      try {
                        if (searchMode === 'CAR_SHARING' && selectedFulfillmentChoice === 'DELIVERY' && Array.isArray(selectedResult?.deliveryAreas) && selectedResult.deliveryAreas.length && !selectedDeliveryArea) {
                          setError('Choose one of the allowed delivery areas for this listing.');
                          setSubmitting(false);
                          return;
                        }
                        const payload = await api('/api/public/booking/checkout', {
                          method: 'POST',
                          body: JSON.stringify({
                            tenantSlug,
                            searchType: searchMode,
                            pickupAt,
                            returnAt,
                            pickupLocationId: selectedResult?.location?.id || '',
                            returnLocationId: searchMode === 'RENTAL' ? resolveReturnLocationForSelection() : (selectedResult?.location?.id || ''),
                            searchPlaceId: searchMode === 'CAR_SHARING'
                              ? (selectedResult?.searchPlace?.id || selectedCarSharingSearchOption?.searchPlaceId || '')
                              : '',
                            requestedSearchPlaceId: searchMode === 'CAR_SHARING'
                              ? (selectedCarSharingSearchOption?.searchPlaceId || '')
                              : '',
                            vehicleTypeId: searchMode === 'RENTAL' ? selectedResult?.vehicleType?.id : null,
                            listingId: searchMode === 'CAR_SHARING' ? selectedResult?.id : null,
                            fulfillmentChoice: searchMode === 'CAR_SHARING' ? selectedFulfillmentChoice : null,
                            deliveryAreaChoice: searchMode === 'CAR_SHARING' && selectedFulfillmentChoice === 'DELIVERY' ? selectedDeliveryArea : null,
                            additionalServices: chosenAdditionalServices.map((service) => ({
                              serviceId: service.serviceId,
                              quantity: service.quantity
                            })),
                            insuranceSelection: searchMode === 'RENTAL'
                              ? {
                                  selectedPlanCode: selectedInsurancePlan?.code || '',
                                  declinedCoverage: !!insuranceSelection.declinedCoverage,
                                  usingOwnInsurance: !!insuranceSelection.usingOwnInsurance,
                                  liabilityAccepted: !!insuranceSelection.liabilityAccepted,
                                  ownPolicyNumber: insuranceSelection.ownPolicyNumber || ''
                                }
                              : null,
                            customer: checkoutState
                          })
                        });
                        if (typeof window !== 'undefined') {
                          sessionStorage.removeItem(PUBLIC_BOOKING_DRAFT_KEY);
                          sessionStorage.setItem('fleet_public_booking_confirmation', JSON.stringify(payload));
                        }
                        router.push('/book/confirmation');
                      } catch (err) {
                        setError(err.message);
                      } finally {
                        setSubmitting(false);
                      }
                    }}
                  >
                {submitting ? 'Creating Booking...' : `Create ${searchMode === 'RENTAL' ? 'Reservation' : 'Trip'} Request`}
                  </button>
                </div>
                {searchMode === 'RENTAL' ? (
                  <div className="surface-note">
                    Base trip total {fmtMoney(selectedResult?.quote?.estimatedTripTotal)}.
                    {mandatoryBookingFeesTotal ? ` Required fees included: ${fmtMoney(mandatoryBookingFeesTotal)}.` : ''}
                    {chosenAdditionalServicesTotal || linkedServiceFeesTotal || selectedInsuranceTotal
                      ? ` With extras${linkedServiceFeesTotal ? ', linked service fees' : ''} and insurance: ${fmtMoney(checkoutEstimatedTotal)}.`
                      : ' Additional services and insurance will be reflected here before checkout.'}
                  </div>
                ) : null}
              </div>
            </div>
          </section>
        ) : null}
      </div>
    </main>
  );
}

export default function PublicBookingPage() {
  return (
    <Suspense
      fallback={(
        <main className="public-booking-shell">
          <div className="public-booking-layout">
            <section className="glass card-lg section-card">
              <div className="section-title">Loading booking experience...</div>
              <p className="ui-muted">Preparing the public booking flow.</p>
            </section>
          </div>
        </main>
      )}
    >
      <PublicBookingPageInner />
    </Suspense>
  );
}
