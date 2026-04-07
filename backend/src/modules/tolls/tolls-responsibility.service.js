const CHECKED_OUT_STATUSES = new Set(['CHECKED_OUT', 'CHECKED_IN']);

export const DISPATCH_CONFIRMATION_REVIEW_CATEGORY = 'DISPATCH_CONFIRMATION_REQUIRED';
export const DISPATCH_CONFIRMATION_REASON_TOKEN = 'dispatch-confirmation-required';

function normalizeDateTime(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function upper(value) {
  return String(value || '').trim().toUpperCase();
}

function minutesBefore(date, minutes) {
  return new Date(date.getTime() - minutes * 60 * 1000);
}

function minutesAfter(date, minutes) {
  return new Date(date.getTime() + minutes * 60 * 1000);
}

function sortSwaps(swaps = []) {
  return [...(Array.isArray(swaps) ? swaps : [])].sort((a, b) => {
    const aAt = normalizeDateTime(a?.nextCheckedOutAt)?.getTime()
      ?? normalizeDateTime(a?.previousCheckedInAt)?.getTime()
      ?? normalizeDateTime(a?.createdAt)?.getTime()
      ?? 0;
    const bAt = normalizeDateTime(b?.nextCheckedOutAt)?.getTime()
      ?? normalizeDateTime(b?.previousCheckedInAt)?.getTime()
      ?? normalizeDateTime(b?.createdAt)?.getTime()
      ?? 0;
    return aAt - bAt;
  });
}

export function inferDispatchConfirmedAt(reservation = {}) {
  const status = upper(reservation?.status);
  const agreement = reservation?.rentalAgreement || {};
  const checkoutInspection = Array.isArray(agreement?.inspections)
    ? agreement.inspections.find((row) => upper(row?.phase) === 'CHECKOUT')
    : null;
  const finalizedAt = normalizeDateTime(agreement?.finalizedAt);
  const checkoutCapturedAt = normalizeDateTime(checkoutInspection?.capturedAt || checkoutInspection?.createdAt);
  if (finalizedAt) return finalizedAt;
  if (checkoutCapturedAt) return checkoutCapturedAt;
  if (CHECKED_OUT_STATUSES.has(status)) return normalizeDateTime(reservation?.pickupAt);
  return null;
}

export function buildReservationVehicleResponsibilityWindows(reservation = {}) {
  const pickupAt = normalizeDateTime(reservation?.pickupAt);
  const returnAt = normalizeDateTime(reservation?.returnAt);
  if (!pickupAt || !returnAt || returnAt <= pickupAt) return [];

  const agreement = reservation?.rentalAgreement || {};
  const swaps = sortSwaps(agreement?.vehicleSwaps || []);
  const dispatchConfirmedAt = inferDispatchConfirmedAt(reservation);
  const readyForPickupAt = normalizeDateTime(reservation?.readyForPickupAt);
  const dispatchStartAt = dispatchConfirmedAt || readyForPickupAt || pickupAt;
  const dispatchConfirmed = !!dispatchConfirmedAt;

  const initialVehicleId = agreement?.vehicleId
    || swaps[0]?.previousVehicleId
    || reservation?.vehicleId
    || null;

  const windows = [];
  let currentVehicleId = initialVehicleId;
  let currentStartAt = dispatchStartAt;

  for (const swap of swaps) {
    const previousVehicleId = swap?.previousVehicleId || currentVehicleId || null;
    const previousEndAt = normalizeDateTime(swap?.previousCheckedInAt)
      || normalizeDateTime(swap?.nextCheckedOutAt)
      || normalizeDateTime(swap?.createdAt)
      || returnAt;

    if (previousVehicleId && currentStartAt && previousEndAt > currentStartAt) {
      windows.push({
        vehicleId: previousVehicleId,
        startAt: currentStartAt,
        endAt: previousEndAt < returnAt ? previousEndAt : returnAt,
        source: 'SWAP_PREVIOUS',
        dispatchConfirmed,
        dispatchConfirmationRequired: !dispatchConfirmed
      });
    }

    currentVehicleId = swap?.nextVehicleId || currentVehicleId || null;
    currentStartAt = normalizeDateTime(swap?.nextCheckedOutAt)
      || normalizeDateTime(swap?.createdAt)
      || previousEndAt
      || currentStartAt;
  }

  const fallbackVehicleId = currentVehicleId || reservation?.vehicleId || null;
  if (fallbackVehicleId && currentStartAt && returnAt > currentStartAt) {
    windows.push({
      vehicleId: fallbackVehicleId,
      startAt: currentStartAt,
      endAt: returnAt,
      source: swaps.length ? 'SWAP_NEXT' : 'ASSIGNED_VEHICLE',
      dispatchConfirmed,
      dispatchConfirmationRequired: !dispatchConfirmed
    });
  }

  const deduped = [];
  for (const window of windows) {
    if (!window?.vehicleId || !window?.startAt || !window?.endAt || window.endAt <= window.startAt) continue;
    const last = deduped[deduped.length - 1];
    if (last && last.vehicleId === window.vehicleId && last.endAt.getTime() === window.startAt.getTime()) {
      last.endAt = window.endAt;
      last.dispatchConfirmationRequired = last.dispatchConfirmationRequired || window.dispatchConfirmationRequired;
      continue;
    }
    deduped.push({ ...window });
  }

  return deduped;
}

export function reservationReferencesVehicle(reservation = {}, vehicleId = null) {
  if (!vehicleId) return false;
  return buildReservationVehicleResponsibilityWindows(reservation).some((window) => String(window.vehicleId) === String(vehicleId));
}

export function resolveReservationResponsibility({
  reservation = {},
  transactionAt,
  vehicleId = null,
  prePickupGraceMinutes = 0,
  postReturnGraceMinutes = 0
} = {}) {
  const when = normalizeDateTime(transactionAt);
  const pickupAt = normalizeDateTime(reservation?.pickupAt);
  const returnAt = normalizeDateTime(reservation?.returnAt);
  const windows = buildReservationVehicleResponsibilityWindows(reservation);

  if (!when || !pickupAt || !returnAt) {
    return {
      windows,
      matchedWindow: null,
      withinTripWindow: false,
      withinGraceWindow: false,
      withinEffectiveWindow: false,
      dispatchConfirmationRequired: false,
      reviewCategory: null
    };
  }

  const prePickupAt = minutesBefore(pickupAt, Number(prePickupGraceMinutes || 0));
  const postReturnAt = minutesAfter(returnAt, Number(postReturnGraceMinutes || 0));
  const matchedWindow = windows.find((window) => (
    (!vehicleId || String(window.vehicleId) === String(vehicleId))
    && when >= window.startAt
    && when <= window.endAt
  )) || null;

  const withinTripWindow = when >= pickupAt && when <= returnAt;
  const withinGraceWindow = !withinTripWindow && when >= prePickupAt && when <= postReturnAt;
  const dispatchConfirmationRequired = !!matchedWindow?.dispatchConfirmationRequired;

  return {
    windows,
    matchedWindow,
    withinTripWindow,
    withinGraceWindow,
    withinEffectiveWindow: !!matchedWindow,
    dispatchConfirmationRequired,
    reviewCategory: dispatchConfirmationRequired ? DISPATCH_CONFIRMATION_REVIEW_CATEGORY : null
  };
}

export function appendReviewCategory(reason = '', reviewCategory = null) {
  const base = String(reason || '').trim();
  if (reviewCategory !== DISPATCH_CONFIRMATION_REVIEW_CATEGORY) return base;
  if (!base) return DISPATCH_CONFIRMATION_REASON_TOKEN;
  if (base.includes(DISPATCH_CONFIRMATION_REASON_TOKEN)) return base;
  return `${base},${DISPATCH_CONFIRMATION_REASON_TOKEN}`;
}

export function inferReviewCategory(reason = '') {
  const normalized = String(reason || '').toLowerCase();
  if (normalized.includes(DISPATCH_CONFIRMATION_REASON_TOKEN)) {
    return DISPATCH_CONFIRMATION_REVIEW_CATEGORY;
  }
  return null;
}

export function clearDispatchConfirmationReview(reason = '') {
  return String(reason || '')
    .split(',')
    .map((token) => token.trim())
    .filter(Boolean)
    .filter((token) => token.toLowerCase() !== DISPATCH_CONFIRMATION_REASON_TOKEN)
    .join(',');
}
