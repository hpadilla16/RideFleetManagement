function norm(value) {
  return String(value || '').trim();
}

function toNumberOrNull(value) {
  if (value === '' || value == null) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function firstNonEmpty(...values) {
  for (const value of values) {
    if (value !== '' && value != null) return value;
  }
  return null;
}

function normalizeEventType(value) {
  const raw = norm(value).toUpperCase();
  if (!raw) return 'PING';
  if (['TRIP', 'IGNITION_ON', 'IGNITION_OFF', 'LOCATION', 'HEARTBEAT', 'STATUS'].includes(raw)) return raw;
  return raw.replace(/\s+/g, '_');
}

function normalizePayloadVersion(value) {
  const raw = norm(value);
  return raw || 'v1';
}

export function extractZubieExternalDeviceId(payload = {}) {
  return norm(
    firstNonEmpty(
      payload?.externalDeviceId,
      payload?.deviceId,
      payload?.device?.id,
      payload?.device?.externalDeviceId,
      payload?.asset?.deviceId,
      payload?.asset?.externalDeviceId,
      payload?.gps?.deviceId,
      payload?.message?.deviceId
    )
  );
}

export function normalizeZubieWebhookPayload(payload = {}, options = {}) {
  const externalDeviceId = extractZubieExternalDeviceId(payload);
  if (!externalDeviceId) throw new Error('externalDeviceId is required');
  const payloadVersion = normalizePayloadVersion(
    firstNonEmpty(
      options?.payloadVersion,
      payload?.payloadVersion,
      payload?.version,
      payload?.schemaVersion,
      payload?.meta?.version
    )
  );
  const ingestSource = norm(options?.ingestSource).toUpperCase() || 'WEBHOOK';

  const latitude = firstNonEmpty(
    payload?.latitude,
    payload?.lat,
    payload?.location?.latitude,
    payload?.location?.lat,
    payload?.gps?.latitude,
    payload?.gps?.lat,
    payload?.coordinates?.latitude,
    payload?.coordinates?.lat
  );
  const longitude = firstNonEmpty(
    payload?.longitude,
    payload?.lng,
    payload?.location?.longitude,
    payload?.location?.lng,
    payload?.gps?.longitude,
    payload?.gps?.lng,
    payload?.coordinates?.longitude,
    payload?.coordinates?.lng
  );

  return {
    provider: 'ZUBIE',
    externalDeviceId,
    eventType: normalizeEventType(
      firstNonEmpty(
        payload?.eventType,
        payload?.type,
        payload?.messageType,
        payload?.event?.type,
        'PING'
      )
    ),
    eventAt: firstNonEmpty(
      payload?.eventAt,
      payload?.timestamp,
      payload?.recordedAt,
      payload?.event?.recordedAt,
      payload?.gps?.recordedAt,
      new Date().toISOString()
    ),
    odometer: toNumberOrNull(firstNonEmpty(
      payload?.odometer,
      payload?.metrics?.odometer,
      payload?.distance?.odometer,
      payload?.vehicle?.odometer
    )),
    fuelPct: toNumberOrNull(firstNonEmpty(
      payload?.fuelPct,
      payload?.fuelLevelPct,
      payload?.fuel?.levelPct,
      payload?.fuel?.percent,
      payload?.metrics?.fuelPct
    )),
    batteryPct: toNumberOrNull(firstNonEmpty(
      payload?.batteryPct,
      payload?.battery?.percent,
      payload?.power?.batteryPct,
      payload?.metrics?.batteryPct
    )),
    speedMph: toNumberOrNull(firstNonEmpty(
      payload?.speedMph,
      payload?.speed,
      payload?.gps?.speedMph,
      payload?.metrics?.speedMph
    )),
    latitude: toNumberOrNull(latitude),
    longitude: toNumberOrNull(longitude),
    engineOn: typeof payload?.engineOn === 'boolean'
      ? payload.engineOn
      : typeof payload?.ignitionOn === 'boolean'
        ? payload.ignitionOn
        : typeof payload?.ignition?.on === 'boolean'
          ? payload.ignition.on
          : null,
    providerMeta: {
      provider: 'ZUBIE',
      connectorCode: 'ZUBIE_PLACEHOLDER',
      connectorMode: 'PLACEHOLDER',
      ingestSource,
      payloadVersion,
      requestMetadata: options?.requestMetadata || null
    },
    rawPayload: payload,
    mappingSummary: {
      deviceIdSource: externalDeviceId,
      hasCoordinates: latitude != null && longitude != null,
      hasFuel: firstNonEmpty(
        payload?.fuelPct,
        payload?.fuelLevelPct,
        payload?.fuel?.levelPct,
        payload?.fuel?.percent,
        payload?.metrics?.fuelPct
      ) != null,
      hasOdometer: firstNonEmpty(
        payload?.odometer,
        payload?.metrics?.odometer,
        payload?.distance?.odometer,
        payload?.vehicle?.odometer
      ) != null,
      payloadVersion
    }
  };
}
