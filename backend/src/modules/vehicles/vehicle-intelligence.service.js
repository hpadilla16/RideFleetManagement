import { prisma } from '../../lib/prisma.js';

const REQUIRED_INSPECTION_PHOTOS = ['front', 'rear', 'left', 'right', 'frontSeat', 'rearSeat', 'dashboard', 'trunk'];
const INSPECTION_CONDITION_KEYS = ['exterior', 'interior', 'tires', 'lights', 'windshield'];
const HIGH_DAMAGE_KEYWORDS = ['accident', 'collision', 'broken', 'cracked', 'crack', 'shattered', 'airbag', 'frame', 'total', 'unsafe', 'leaking', 'tow'];
const MEDIUM_DAMAGE_KEYWORDS = ['dent', 'scratch', 'scuff', 'chip', 'tear', 'stain', 'burn', 'missing', 'loose', 'warning light', 'flat', 'puncture'];

function safeJsonParse(value, fallback = {}) {
  try {
    if (!value) return fallback;
    if (typeof value === 'string') return JSON.parse(value);
    if (typeof value === 'object') return value;
  } catch {}
  return fallback;
}

function toNumberOrNull(value) {
  if (value === '' || value == null) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function toIsoOrNull(value) {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function activeBlockLabel(blockType) {
  switch (String(blockType || '').toUpperCase()) {
    case 'MAINTENANCE_HOLD':
      return 'maintenance hold';
    case 'WASH_HOLD':
      return 'wash buffer';
    case 'OUT_OF_SERVICE_HOLD':
      return 'out-of-service hold';
    default:
      return 'migration hold';
  }
}

function clampScore(value) {
  return Math.max(0, Math.min(100, Math.round(value)));
}

function inspectionPhotoCoverage(photos = {}) {
  const filled = REQUIRED_INSPECTION_PHOTOS.filter((key) => !!photos?.[key]);
  return {
    required: REQUIRED_INSPECTION_PHOTOS.length,
    captured: filled.length,
    missingKeys: REQUIRED_INSPECTION_PHOTOS.filter((key) => !filled.includes(key))
  };
}

function conditionAttentionCount(inspection = {}) {
  return INSPECTION_CONDITION_KEYS.filter((key) => {
    const value = String(inspection?.[key] || '').trim().toUpperCase();
    return value && value !== 'GOOD';
  }).length;
}

function uniqueList(values = []) {
  return [...new Set(values.filter(Boolean))];
}

function extractDamageKeywords(text = '') {
  const normalized = String(text || '').toLowerCase();
  if (!normalized.trim()) return [];
  return uniqueList([
    ...HIGH_DAMAGE_KEYWORDS.filter((keyword) => normalized.includes(keyword)),
    ...MEDIUM_DAMAGE_KEYWORDS.filter((keyword) => normalized.includes(keyword))
  ]);
}

function inspectionCategoryFlags(inspection = {}) {
  const categories = [];
  if (String(inspection?.exterior || '').trim().toUpperCase() && String(inspection.exterior).trim().toUpperCase() !== 'GOOD') categories.push('EXTERIOR');
  if (String(inspection?.interior || '').trim().toUpperCase() && String(inspection.interior).trim().toUpperCase() !== 'GOOD') categories.push('INTERIOR');
  if (String(inspection?.tires || '').trim().toUpperCase() && String(inspection.tires).trim().toUpperCase() !== 'GOOD') categories.push('TIRES');
  if (String(inspection?.lights || '').trim().toUpperCase() && String(inspection.lights).trim().toUpperCase() !== 'GOOD') categories.push('LIGHTS');
  if (String(inspection?.windshield || '').trim().toUpperCase() && String(inspection.windshield).trim().toUpperCase() !== 'GOOD') categories.push('WINDSHIELD');
  return uniqueList(categories);
}

export function buildDamageTriage(inspection = {}) {
  const damagesText = String(inspection?.damages || '').trim();
  const notesText = String(inspection?.notes || '').trim();
  const keywords = extractDamageKeywords(`${damagesText} ${notesText}`);
  const categories = inspectionCategoryFlags(inspection);
  const conditionFlags = conditionAttentionCount(inspection);
  const missingPhotos = Math.max(0, Number(inspection?.photoCoverage?.required || 0) - Number(inspection?.photoCoverage?.captured || 0));
  const highKeywordHit = keywords.some((keyword) => HIGH_DAMAGE_KEYWORDS.includes(keyword));
  const mediumKeywordHit = keywords.some((keyword) => MEDIUM_DAMAGE_KEYWORDS.includes(keyword));
  const explicitDamage = !!damagesText;

  let severity = 'NONE';
  if (explicitDamage || conditionFlags > 0 || missingPhotos > 0) severity = 'LOW';
  if (mediumKeywordHit || categories.length >= 2 || conditionFlags >= 2 || missingPhotos >= 3) severity = 'MEDIUM';
  if (highKeywordHit || categories.some((category) => ['TIRES', 'LIGHTS', 'WINDSHIELD'].includes(category)) && explicitDamage) severity = 'HIGH';

  const reviewNeeded = severity !== 'NONE';
  const confidence = explicitDamage || categories.length || conditionFlags >= 2
    ? 'HIGH'
    : missingPhotos > 0 || mediumKeywordHit
      ? 'MEDIUM'
      : 'LOW';
  const nextAction = severity === 'HIGH'
    ? 'Hold unit and route to damage review before the next assignment.'
    : severity === 'MEDIUM'
      ? 'Have ops review the latest inspection and decide whether the unit needs a hold or repair.'
      : severity === 'LOW'
        ? 'Double-check the inspection and capture any missing photos before dispatch.'
        : 'No damage triage action is required from the latest inspection.';
  const summary = severity === 'HIGH'
    ? 'Inspection suggests high-risk damage or safety-related issues.'
    : severity === 'MEDIUM'
      ? 'Inspection suggests moderate damage or condition issues that deserve ops review.'
      : severity === 'LOW'
        ? 'Inspection has minor damage or documentation gaps to clean up.'
        : 'No damage issues were inferred from the latest inspection.';

  return {
    severity,
    confidence,
    reviewNeeded,
    categories,
    keywords,
    missingPhotos,
    recommendedAction: nextAction,
    summary
  };
}

export function buildInspectionIntelligence(source = {}) {
  const checkout = source?.checkout || null;
  const checkin = source?.checkin || null;
  const latest = [checkout, checkin]
    .filter(Boolean)
    .sort((left, right) => new Date(right?.at || 0).getTime() - new Date(left?.at || 0).getTime())[0] || null;

  if (!latest) {
    return {
      status: 'NO_DATA',
      latestPhase: null,
      latestAt: null,
      photoCoverage: { required: REQUIRED_INSPECTION_PHOTOS.length, captured: 0, missingKeys: [...REQUIRED_INSPECTION_PHOTOS] },
      conditionAttentionCount: 0,
      damageReported: false,
      damageTriage: buildDamageTriage(),
      summary: 'No inspection has been captured for this vehicle yet.'
    };
  }

  const photos = safeJsonParse(latest.photos, {});
  const coverage = inspectionPhotoCoverage(photos);
  const attentionCount = conditionAttentionCount(latest);
  const damageReported = !!String(latest?.damages || '').trim();
  const incomplete = coverage.captured < coverage.required;
  const damageTriage = buildDamageTriage({
    ...latest,
    photoCoverage: coverage
  });
  const status = incomplete || attentionCount > 0 || damageReported ? 'ATTENTION' : 'READY';

  return {
    status,
    latestPhase: latest.phase || null,
    latestAt: toIsoOrNull(latest.at),
    photoCoverage: coverage,
    conditionAttentionCount: attentionCount,
    damageReported,
    damageTriage,
    odometer: toNumberOrNull(latest.odometer),
    fuelLevel: latest.fuelLevel == null ? null : String(latest.fuelLevel),
    notesPresent: !!String(latest?.notes || '').trim(),
    summary: status === 'READY'
      ? 'Latest inspection is complete and ready for dispatch.'
      : damageTriage.severity === 'HIGH'
        ? 'Latest inspection suggests high-risk damage that should be reviewed before dispatch.'
        : incomplete
        ? `Latest inspection is missing ${coverage.required - coverage.captured} required photo(s).`
        : damageReported
          ? 'Latest inspection reported damage or condition issues that need review.'
          : 'Latest inspection has condition flags that should be reviewed before assignment.'
  };
}

export function buildTelematicsSummary({ device = null, event = null, featureEnabled = true }) {
  if (featureEnabled === false) {
    return {
      status: 'DISABLED',
      provider: null,
      deviceLabel: null,
      externalDeviceId: null,
      lastSeenAt: null,
      lastEventAt: null,
      odometer: null,
      odometerStatus: 'UNKNOWN',
      fuelPct: null,
      fuelStatus: 'UNKNOWN',
      speedMph: null,
      batteryPct: null,
      batteryStatus: 'UNKNOWN',
      latitude: null,
      longitude: null,
      gpsStatus: 'UNKNOWN',
      movementStatus: 'UNKNOWN',
      alerts: [],
      recommendedAction: 'Telematics is disabled for this tenant.',
      summary: 'Telematics is disabled for this tenant.'
    };
  }
  if (!device) {
    return {
      status: 'NO_DEVICE',
      provider: null,
      deviceLabel: null,
      externalDeviceId: null,
      lastSeenAt: null,
      lastEventAt: null,
      odometer: null,
      odometerStatus: 'UNKNOWN',
      fuelPct: null,
      fuelStatus: 'UNKNOWN',
      speedMph: null,
      batteryPct: null,
      batteryStatus: 'UNKNOWN',
      latitude: null,
      longitude: null,
      gpsStatus: 'UNKNOWN',
      movementStatus: 'UNKNOWN',
      alerts: [],
      recommendedAction: 'Link a telematics device if this tenant expects live GPS, fuel, and odometer data.',
      summary: 'No telematics device is linked to this vehicle yet.'
    };
  }

  const latestSeenAt = event?.eventAt || device?.lastSeenAt || null;
  const ageMinutes = latestSeenAt
    ? Math.round((Date.now() - new Date(latestSeenAt).getTime()) / 60000)
    : null;
  const status = ageMinutes == null
    ? 'NO_SIGNAL'
    : ageMinutes <= 15
      ? 'ONLINE'
      : ageMinutes <= 180
        ? 'STALE'
        : 'OFFLINE';
  const odometer = toNumberOrNull(event?.odometer);
  const fuelPct = toNumberOrNull(event?.fuelPct);
  const speedMph = toNumberOrNull(event?.speedMph);
  const batteryPct = toNumberOrNull(event?.batteryPct);
  const latitude = toNumberOrNull(event?.latitude);
  const longitude = toNumberOrNull(event?.longitude);
  const gpsStatus = latitude != null && longitude != null ? 'KNOWN' : 'MISSING';
  const fuelStatus = fuelPct == null ? 'UNKNOWN' : fuelPct <= 15 ? 'CRITICAL' : fuelPct <= 30 ? 'LOW' : 'OK';
  const odometerStatus = odometer == null ? 'MISSING' : 'REPORTED';
  const batteryStatus = batteryPct == null ? 'UNKNOWN' : batteryPct <= 20 ? 'LOW' : 'OK';
  const movementStatus = speedMph == null ? (typeof event?.engineOn === 'boolean' && event.engineOn ? 'ENGINE_ON' : 'UNKNOWN') : speedMph >= 5 ? 'IN_MOTION' : 'PARKED';
  const alerts = [];
  if (status === 'NO_SIGNAL') alerts.push('Telematics device is linked but has not sent a signal yet.');
  if (status === 'STALE') alerts.push('Telematics feed is stale and should be checked before moving this unit.');
  if (status === 'OFFLINE') alerts.push('Telematics feed appears offline.');
  if (fuelStatus === 'CRITICAL') alerts.push('Fuel level is critically low for the next turn.');
  else if (fuelStatus === 'LOW') alerts.push('Fuel level is low and may need refueling before the next reservation.');
  if (gpsStatus === 'MISSING' && ['ONLINE', 'STALE'].includes(status)) alerts.push('GPS coordinates are missing from the latest telematics update.');
  if (odometerStatus === 'MISSING' && ['ONLINE', 'STALE'].includes(status)) alerts.push('Latest telematics update did not include odometer data.');
  if (batteryStatus === 'LOW') alerts.push('Telematics battery level is low.');
  const recommendedAction = fuelStatus === 'CRITICAL'
    ? 'Refuel this unit before the next assignment and confirm live signal health.'
    : status === 'OFFLINE'
      ? 'Check the telematics device connection before relying on live location or fuel data.'
      : gpsStatus === 'MISSING'
        ? 'Confirm the device is reporting GPS correctly before dispatching off-site.'
        : odometerStatus === 'MISSING'
          ? 'Confirm odometer reporting so mileage and maintenance remain accurate.'
          : 'Telematics feed is usable for dispatch, GPS, fuel, and mileage tracking.';

  return {
    status,
    provider: device.provider || null,
    deviceLabel: device.label || null,
    externalDeviceId: device.externalDeviceId || null,
    lastSeenAt: toIsoOrNull(device.lastSeenAt || latestSeenAt),
    lastEventAt: toIsoOrNull(event?.eventAt),
    signalAgeMinutes: ageMinutes,
    odometer,
    odometerStatus,
    fuelPct,
    fuelStatus,
    speedMph,
    batteryPct,
    batteryStatus,
    latitude,
    longitude,
    gpsStatus,
    movementStatus,
    engineOn: typeof event?.engineOn === 'boolean' ? event.engineOn : null,
    alerts,
    recommendedAction,
    summary: status === 'ONLINE'
      ? fuelStatus === 'CRITICAL'
        ? 'Telematics feed is online, but fuel is critically low for the next turn.'
        : gpsStatus === 'MISSING'
          ? 'Telematics feed is online, but GPS coordinates are missing from the latest update.'
          : 'Telematics feed is online and updating recently.'
      : status === 'STALE'
        ? 'Telematics feed is connected but has not checked in recently.'
        : status === 'OFFLINE'
          ? 'Telematics feed appears offline and should be checked.'
          : 'Telematics device is linked but no signal has been recorded yet.'
  };
}

export function buildTurnReadyScore({ inspection = null, telematics = null, activeBlock = null }) {
  let score = 100;
  const reasons = [];
  const blockers = [];
  const blockType = String(activeBlock?.blockType || '').toUpperCase();

  if (blockType === 'WASH_HOLD') {
    score -= 35;
    reasons.push('Vehicle is currently inside a planned wash and turnaround buffer.');
  } else if (blockType === 'MAINTENANCE_HOLD') {
    score -= 75;
    blockers.push('Vehicle is blocked for scheduled maintenance right now.');
  } else if (blockType === 'OUT_OF_SERVICE_HOLD') {
    score -= 85;
    blockers.push('Vehicle is marked out of service and should not be dispatched.');
  } else if (blockType === 'MIGRATION_HOLD') {
    score -= 70;
    blockers.push('Vehicle is still protected by a migration hold and is not dispatchable yet.');
  }

  if (inspection?.status === 'NO_DATA') {
    score -= 25;
    reasons.push('No recent inspection is on file for this vehicle.');
  } else if (inspection?.status === 'ATTENTION') {
    score -= 28;
    const missingPhotos = Math.max(0, Number(inspection?.photoCoverage?.required || 0) - Number(inspection?.photoCoverage?.captured || 0));
    if (missingPhotos > 0) {
      score -= Math.min(18, missingPhotos * 3);
      reasons.push(`Latest inspection is missing ${missingPhotos} required photo(s).`);
    }
    if (Number(inspection?.conditionAttentionCount || 0) > 0) {
      score -= Math.min(18, Number(inspection.conditionAttentionCount) * 6);
      reasons.push(`Latest inspection has ${inspection.conditionAttentionCount} condition flag(s) to review.`);
    }
    if (inspection?.damageReported) {
      score -= 16;
      blockers.push('Latest inspection reported damage that still needs review before dispatch.');
    }
    if (String(inspection?.damageTriage?.severity || '').toUpperCase() === 'HIGH') {
      score -= 25;
      blockers.push('Damage triage marked this vehicle as high-risk based on the latest inspection.');
    } else if (String(inspection?.damageTriage?.severity || '').toUpperCase() === 'MEDIUM') {
      score -= 10;
      reasons.push('Damage triage suggests moderate review before the next turn.');
    }
  }

  switch (String(telematics?.status || '').toUpperCase()) {
    case 'NO_DEVICE':
      score -= 8;
      reasons.push('No telematics device is linked to this vehicle.');
      break;
    case 'NO_SIGNAL':
      score -= 14;
      reasons.push('Telematics device is linked but has not reported a signal yet.');
      break;
    case 'STALE':
      score -= 10;
      reasons.push('Telematics feed has gone stale and should be checked.');
      break;
    case 'OFFLINE':
      score -= 18;
      reasons.push('Telematics feed appears offline.');
      break;
    default:
      break;
  }

  switch (String(telematics?.fuelStatus || '').toUpperCase()) {
    case 'CRITICAL':
      score -= 20;
      reasons.push('Fuel level is critically low for the next assignment.');
      break;
    case 'LOW':
      score -= 10;
      reasons.push('Fuel level is low and may need attention before dispatch.');
      break;
    default:
      break;
  }

  if (String(telematics?.gpsStatus || '').toUpperCase() === 'MISSING' && ['ONLINE', 'STALE'].includes(String(telematics?.status || '').toUpperCase())) {
    score -= 8;
    reasons.push('Latest telematics update is missing GPS coordinates.');
  }
  if (String(telematics?.odometerStatus || '').toUpperCase() === 'MISSING' && ['ONLINE', 'STALE'].includes(String(telematics?.status || '').toUpperCase())) {
    score -= 6;
    reasons.push('Latest telematics update is missing odometer data.');
  }
  if (String(telematics?.batteryStatus || '').toUpperCase() === 'LOW') {
    score -= 6;
    reasons.push('Telematics battery is low.');
  }

  const finalScore = clampScore(score);
  const status = blockers.length
    ? 'BLOCKED'
    : finalScore >= 85
      ? 'READY'
      : finalScore >= 65
        ? 'WATCH'
        : 'ATTENTION';

  const summary = blockers.length
    ? blockers[0]
    : status === 'READY'
      ? 'Vehicle is operationally turn-ready for the next assignment.'
      : status === 'WATCH'
        ? 'Vehicle is usable, but ops should clear readiness friction before the next turn.'
        : 'Vehicle needs readiness review before the next assignment.';

  return {
    score: finalScore,
    status,
    reasons: [...new Set(reasons)].slice(0, 4),
    blockers: [...new Set(blockers)].slice(0, 3),
    activeBlockType: blockType || null,
    activeBlockLabel: activeBlock ? activeBlockLabel(blockType) : null,
    summary
  };
}

export function buildVehicleOperationalSignals({ latestAgreement = null, latestEvent = null, activeDevice = null, activeBlock = null, telematicsFeatureEnabled = true }) {
  const inspection = buildInspectionIntelligence({
    checkout: latestAgreement?.checkoutInspection || null,
    checkin: latestAgreement?.checkinInspection || null
  });
  const telematics = buildTelematicsSummary({ device: activeDevice, event: latestEvent, featureEnabled: telematicsFeatureEnabled });
  const turnReady = buildTurnReadyScore({ inspection, telematics, activeBlock });

  const attentionReasons = [];
  if (turnReady.status !== 'READY') attentionReasons.push(turnReady.summary);
  if (inspection.status === 'ATTENTION') attentionReasons.push(inspection.summary);
  if (['STALE', 'OFFLINE', 'NO_SIGNAL'].includes(telematics.status)) attentionReasons.push(telematics.summary);

  return {
    status: turnReady.status,
    needsAttention: turnReady.status !== 'READY',
    attentionReasons: [...new Set(attentionReasons)],
    inspection,
    telematics,
    turnReady
  };
}

export async function buildVehicleOperationalSignalsMap(vehicleIds = [], scope = {}, options = {}) {
  const ids = [...new Set((Array.isArray(vehicleIds) ? vehicleIds : []).filter(Boolean))];
  if (!ids.length) return new Map();
  const activeBlocksByVehicleId = options?.activeBlocksByVehicleId instanceof Map ? options.activeBlocksByVehicleId : new Map();

  const tenantFilter = scope?.tenantId ? { tenantId: scope.tenantId } : {};
  const [agreements, devices, events] = await Promise.all([
    prisma.rentalAgreement.findMany({
      where: {
        vehicleId: { in: ids },
        ...tenantFilter
      },
      orderBy: [{ createdAt: 'desc' }],
      select: {
        vehicleId: true,
        id: true,
        agreementNumber: true,
        inspections: {
          orderBy: [{ capturedAt: 'desc' }],
          select: {
            phase: true,
            capturedAt: true,
            exterior: true,
            interior: true,
            tires: true,
            lights: true,
            windshield: true,
            fuelLevel: true,
            odometer: true,
            damages: true,
            notes: true,
            photosJson: true
          }
        }
      }
    }),
    prisma.vehicleTelematicsDevice.findMany({
      where: {
        vehicleId: { in: ids },
        isActive: true,
        ...tenantFilter
      },
      orderBy: [{ updatedAt: 'desc' }, { createdAt: 'desc' }]
    }),
    prisma.vehicleTelematicsEvent.findMany({
      where: {
        vehicleId: { in: ids },
        ...tenantFilter
      },
      orderBy: [{ eventAt: 'desc' }, { createdAt: 'desc' }]
    })
  ]);

  const agreementByVehicleId = new Map();
  for (const agreement of agreements) {
    if (!agreement?.vehicleId || agreementByVehicleId.has(agreement.vehicleId)) continue;
    const checkout = (agreement.inspections || []).find((item) => String(item.phase || '').toUpperCase() === 'CHECKOUT') || null;
    const checkin = (agreement.inspections || []).find((item) => String(item.phase || '').toUpperCase() === 'CHECKIN') || null;
    agreementByVehicleId.set(agreement.vehicleId, {
      agreementId: agreement.id,
      agreementNumber: agreement.agreementNumber,
      checkoutInspection: checkout ? {
        phase: checkout.phase,
        at: checkout.capturedAt,
        exterior: checkout.exterior,
        interior: checkout.interior,
        tires: checkout.tires,
        lights: checkout.lights,
        windshield: checkout.windshield,
        fuelLevel: checkout.fuelLevel,
        odometer: checkout.odometer,
        damages: checkout.damages,
        notes: checkout.notes,
        photos: safeJsonParse(checkout.photosJson, {})
      } : null,
      checkinInspection: checkin ? {
        phase: checkin.phase,
        at: checkin.capturedAt,
        exterior: checkin.exterior,
        interior: checkin.interior,
        tires: checkin.tires,
        lights: checkin.lights,
        windshield: checkin.windshield,
        fuelLevel: checkin.fuelLevel,
        odometer: checkin.odometer,
        damages: checkin.damages,
        notes: checkin.notes,
        photos: safeJsonParse(checkin.photosJson, {})
      } : null
    });
  }

  const activeDeviceByVehicleId = new Map();
  for (const device of devices) {
    if (!device?.vehicleId || activeDeviceByVehicleId.has(device.vehicleId)) continue;
    activeDeviceByVehicleId.set(device.vehicleId, device);
  }

  const latestEventByVehicleId = new Map();
  for (const event of events) {
    if (!event?.vehicleId || latestEventByVehicleId.has(event.vehicleId)) continue;
    latestEventByVehicleId.set(event.vehicleId, event);
  }

  return new Map(ids.map((vehicleId) => ([
    vehicleId,
    buildVehicleOperationalSignals({
      latestAgreement: agreementByVehicleId.get(vehicleId) || null,
      latestEvent: latestEventByVehicleId.get(vehicleId) || null,
      activeDevice: activeDeviceByVehicleId.get(vehicleId) || null,
      activeBlock: activeBlocksByVehicleId.get(vehicleId) || null,
      telematicsFeatureEnabled: options?.telematicsFeatureEnabled !== false
    })
  ])));
}
