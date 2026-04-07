function parseLocationConfig(raw) {
  try {
    if (!raw) return {};
    if (typeof raw === 'string') return JSON.parse(raw);
    if (typeof raw === 'object') return raw;
  } catch {}
  return {};
}

function normalizeTimeValue(value = '') {
  const match = String(value || '').trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) return null;
  return (hours * 60) + minutes;
}

function formatDateTime(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString();
}

function getLocationDayWindow(dateValue, rawConfig) {
  const config = parseLocationConfig(rawConfig);
  const date = new Date(dateValue);
  if (Number.isNaN(date.getTime())) {
    return {
      configured: false,
      closed: false,
      outsideHours: false,
      open: '',
      close: '',
      summary: 'Operating hours unavailable.'
    };
  }
  const weekdayKey = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'][date.getDay()];
  const weekly = config?.weeklyHours && typeof config.weeklyHours === 'object' ? config.weeklyHours[weekdayKey] : null;
  const enabled = weekly?.enabled != null ? !!weekly.enabled : true;
  const open = String(weekly?.open || config?.operationsOpenTime || '').trim();
  const close = String(weekly?.close || config?.operationsCloseTime || '').trim();
  const openMinutes = normalizeTimeValue(open);
  const closeMinutes = normalizeTimeValue(close);
  const currentMinutes = (date.getHours() * 60) + date.getMinutes();
  const configured = Number.isFinite(openMinutes) && Number.isFinite(closeMinutes);
  const closed = !enabled;
  const outsideHours = closed || (configured ? currentMinutes < openMinutes || currentMinutes > closeMinutes : false);
  return {
    configured,
    closed,
    outsideHours,
    open,
    close,
    allowOutsideHours: !!config?.allowOutsideHours,
    summary: closed
      ? 'Location is marked closed for that day.'
      : configured
        ? `${open} - ${close}`
        : 'Operating hours unavailable.'
  };
}

export function buildSelfServiceSnapshot({
  reservation = {},
  agreement = null,
  selfServiceConfig = {},
  confirmations = {},
  customerInfoComplete = false,
  signatureComplete = false,
  paymentComplete = false
} = {}) {
  const enabled = !!selfServiceConfig?.enabled;
  const pickupLocationConfig = parseLocationConfig(reservation?.pickupLocation?.locationConfig);
  const returnLocationConfig = parseLocationConfig(reservation?.returnLocation?.locationConfig);
  const pickupWindow = getLocationDayWindow(reservation?.pickupAt, reservation?.pickupLocation?.locationConfig);
  const dropoffWindow = getLocationDayWindow(reservation?.returnAt, reservation?.returnLocation?.locationConfig);
  const pickupBlockers = [];
  const dropoffBlockers = [];

  if (!enabled) {
    pickupBlockers.push('Self-service handoff is disabled for this tenant.');
    dropoffBlockers.push('Self-service handoff is disabled for this tenant.');
  }
  if (enabled && !selfServiceConfig?.allowPickup) pickupBlockers.push('Self-service pickup is not enabled.');
  if (enabled && !selfServiceConfig?.allowDropoff) dropoffBlockers.push('Self-service drop-off is not enabled.');
  if (enabled && selfServiceConfig?.requirePrecheckinForPickup && !customerInfoComplete) pickupBlockers.push('Pre-check-in must be completed before pickup.');
  if (enabled && selfServiceConfig?.requireSignatureForPickup && !signatureComplete) pickupBlockers.push('Agreement signature must be completed before pickup.');
  if (enabled && selfServiceConfig?.requirePaymentForPickup && !paymentComplete) pickupBlockers.push('Payment must be completed before pickup.');
  if (enabled && !selfServiceConfig?.allowAfterHoursPickup && pickupWindow.outsideHours) pickupBlockers.push('Pickup is outside configured operating hours.');
  if (enabled && !selfServiceConfig?.allowAfterHoursDropoff && dropoffWindow.outsideHours) dropoffBlockers.push('Drop-off is outside configured operating hours.');

  const pickupReady = enabled && pickupBlockers.length === 0;
  const dropoffReady = enabled && dropoffBlockers.length === 0;
  const overallStatus = !enabled
    ? 'DISABLED'
    : pickupReady && dropoffReady
      ? 'READY'
      : selfServiceConfig?.readinessMode === 'ADVISORY'
        ? 'ATTENTION'
        : 'BLOCKED';
  const keyExchangeMode = String(selfServiceConfig?.keyExchangeMode || 'DESK').trim().toUpperCase() || 'DESK';
  const locationPickupMode = String(pickupLocationConfig?.selfServiceKeyExchangeMode || '').trim().toUpperCase();
  const effectiveKeyExchangeMode = locationPickupMode || keyExchangeMode;
  const keyExchangeLabel = {
    DESK: 'Front desk handoff',
    LOCKBOX: 'Lockbox pickup/drop-off',
    SMART_LOCK: 'Smart lock / remote unlock',
    KEY_CABINET: 'Key cabinet pickup/drop-off'
  }[effectiveKeyExchangeMode] || effectiveKeyExchangeMode;
  const pickupConfirmedAt = confirmations?.pickup?.confirmedAt || null;
  const dropoffConfirmedAt = confirmations?.dropoff?.confirmedAt || null;

  return {
    enabled,
    status: overallStatus,
    readyForPickup: pickupReady,
    readyForDropoff: dropoffReady,
    keyExchangeMode: effectiveKeyExchangeMode,
    keyExchangeLabel,
    supportPhone: String(selfServiceConfig?.supportPhone || '').trim() || String(pickupLocationConfig?.locationPhone || '').trim() || '',
    confirmations: {
      pickup: {
        confirmed: !!pickupConfirmedAt,
        confirmedAt: pickupConfirmedAt
      },
      dropoff: {
        confirmed: !!dropoffConfirmedAt,
        confirmedAt: dropoffConfirmedAt
      }
    },
    canConfirmPickup: pickupReady && !pickupConfirmedAt,
    canConfirmDropoff: dropoffReady && !dropoffConfirmedAt,
    pickup: {
      at: reservation?.pickupAt || null,
      locationName: reservation?.pickupLocation?.name || '',
      afterHours: !!pickupWindow.outsideHours,
      operatingWindow: pickupWindow.summary,
      pointLabel: String(pickupLocationConfig?.selfServicePickupPointLabel || '').trim(),
      instructions: String(pickupLocationConfig?.selfServicePickupInstructions || '').trim() || String(selfServiceConfig?.pickupInstructions || '').trim() || String(pickupLocationConfig?.pickupInstructions || '').trim() || '',
      blockers: pickupBlockers
    },
    dropoff: {
      at: reservation?.returnAt || null,
      locationName: reservation?.returnLocation?.name || '',
      afterHours: !!dropoffWindow.outsideHours,
      operatingWindow: dropoffWindow.summary,
      pointLabel: String(returnLocationConfig?.selfServiceDropoffPointLabel || '').trim(),
      instructions: String(returnLocationConfig?.selfServiceDropoffInstructions || '').trim() || String(selfServiceConfig?.dropoffInstructions || '').trim() || String(returnLocationConfig?.dropoffInstructions || '').trim() || '',
      blockers: dropoffBlockers
    },
    agreement: agreement
      ? {
          id: agreement.id,
          agreementNumber: agreement.agreementNumber,
          status: agreement.status
        }
      : null,
    readinessSummary: !enabled
      ? 'Self-service handoff is disabled for this tenant.'
      : pickupReady && dropoffReady
        ? `Self-service ${keyExchangeLabel.toLowerCase()} is ready for both pickup and drop-off.`
        : `Self-service needs attention before ${pickupReady ? 'drop-off' : 'pickup'}.`,
    nextAction: pickupReady
      ? (dropoffReady ? 'Pickup and drop-off can be handled through the configured self-service flow.' : (dropoffBlockers[0] || 'Review drop-off handoff requirements.'))
      : (pickupBlockers[0] || 'Review pickup handoff requirements.'),
    timestamps: {
      pickupLabel: formatDateTime(reservation?.pickupAt),
      dropoffLabel: formatDateTime(reservation?.returnAt)
    }
  };
}
