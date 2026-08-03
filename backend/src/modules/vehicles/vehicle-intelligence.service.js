import { Prisma } from '@prisma/client';
import { DEFAULT_TURN_READY_RULES, parseStoredTurnReadyRules } from '../../lib/turn-ready-rules.js';
import { prisma } from '../../lib/prisma.js';
import { canonicalPhotoKey } from '../rental-agreements/inspection-photos-normalize.js';

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

// 2026-06-10 (planner-snapshot 57014 fix): build the photo-coverage map for
// BULK signal hydration WITHOUT loading the legacy `photosJson` blob (multi-MB
// base64 per inspection row; selecting it for ~125 latest agreements is what
// blew past statement_timeout on GET /api/planner/snapshot — prisma slow query
// 140939ms then 57014 cancel). Coverage only needs KEY PRESENCE:
//   - rows written with INSPECTION_PHOTOS_STORAGE_ENABLED carry the slot keys
//     in the slim `photoStorageRefs` Json -> exact per-key coverage (keys are
//     canonicalized: mobile writes snake_case front_seat/rear_seat/dash).
//   - legacy rows keep photos inline in `photosJson`; we probe only
//     pg_column_size(photosJson) (no detoast of the blob content) and, when a
//     non-trivial blob exists, treat the photo set as complete instead of
//     flagging false "missing photo" attention. Exact per-key coverage for
//     those rows resumes as they are rewritten with storage refs.
export function slimInspectionPhotoMap(storageRefs, hasLegacyInlinePhotos) {
  if (Array.isArray(storageRefs) && storageRefs.length > 0) {
    const photos = {};
    for (const ref of storageRefs) {
      const key = canonicalPhotoKey(ref?.key);
      if (!key) continue;
      photos[key] = ref?.path || ref?.url || true;
    }
    return photos;
  }
  if (hasLegacyInlinePhotos) {
    return Object.fromEntries(REQUIRED_INSPECTION_PHOTOS.map((key) => [key, 'legacy-inline-photo']));
  }
  return {};
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

/**
 * Turn-Ready score.
 *
 * Every rule contributes exactly ONE labelled line to `breakdown`, carrying its
 * own signed point value and whatever evidence was in scope when it fired. The
 * lines sum to the score — `sum(delta) === rawScore` — and when the 0..100
 * clamp bites it becomes its own visible line rather than a silent difference.
 * That is what makes the score explainable instead of merely numeric.
 *
 * `reasons` and `blockers` keep their historical shape (deduped prose, capped
 * at 4 and 3) because the vehicle profile, issues centre and planner all render
 * them today. They are a SUMMARY view — the complete, untruncated list is
 * `breakdown`, and anything that needs to add up must read that.
 *
 * `rules` comes from the tenant's TurnReadyRuleSet; omitted, it is the frozen
 * default set that reproduces the pre-2026-08-03 formula exactly.
 */
export function buildTurnReadyScore({
  inspection = null,
  telematics = null,
  activeBlock = null,
  documents = null,
  maintenance = null,
} = {}, rules = DEFAULT_TURN_READY_RULES) {
  const r = rules && typeof rules === 'object' ? rules : DEFAULT_TURN_READY_RULES;
  const weight = (key) => {
    const v = Number(r[key]);
    return Number.isFinite(v) ? v : Number(DEFAULT_TURN_READY_RULES[key]) || 0;
  };

  const breakdown = [{
    key: 'baseline',
    label: 'Unit baseline',
    detail: 'Every unit starts at 100 and drops on evidence.',
    delta: 100,
    kind: 'base',
  }];
  const reasons = [];
  const blockers = [];

  // One rule firing = one line. `points` is a magnitude; the sign is applied
  // here so a mis-signed config cannot hand a vehicle free points.
  // `silent` = the rule deducted points but never contributed prose. Only
  // inspectionAttention is silent, and it must stay that way: adding a reason
  // would shift the slice(0, 4) window and change what every existing screen
  // displays today.
  const deduct = (key, label, detail, points, { evidence = null, blocking = false, silent = false } = {}) => {
    const magnitude = Math.max(0, Math.round(Number(points) || 0));
    breakdown.push({
      key,
      label,
      detail,
      // `-magnitude` on a zeroed-out weight yields -0, which is not strictly
      // equal to 0 and would quietly break any comparison downstream.
      delta: magnitude === 0 ? 0 : -magnitude,
      kind: magnitude === 0 ? 'ok' : 'down',
      ...(evidence ? { evidence } : {}),
    });
    if (silent) return;
    if (blocking) blockers.push(detail);
    else reasons.push(detail);
  };

  const blockType = String(activeBlock?.blockType || '').toUpperCase();
  const blockEvidence = activeBlock
    ? { type: 'availabilityBlock', blockType, startAt: activeBlock.startAt ?? null, endAt: activeBlock.endAt ?? null }
    : null;

  if (blockType === 'WASH_HOLD') {
    deduct('blockWashHold', 'Wash hold', 'Vehicle is currently inside a planned wash and turnaround buffer.', weight('blockWashHold'), { evidence: blockEvidence });
  } else if (blockType === 'MAINTENANCE_HOLD') {
    deduct('blockMaintenanceHold', 'Maintenance hold', 'Vehicle is blocked for scheduled maintenance right now.', weight('blockMaintenanceHold'), { evidence: blockEvidence, blocking: true });
  } else if (blockType === 'OUT_OF_SERVICE_HOLD') {
    deduct('blockOutOfService', 'Out of service', 'Vehicle is marked out of service and should not be dispatched.', weight('blockOutOfService'), { evidence: blockEvidence, blocking: true });
  } else if (blockType === 'MIGRATION_HOLD') {
    deduct('blockMigrationHold', 'Migration hold', 'Vehicle is still protected by a migration hold and is not dispatchable yet.', weight('blockMigrationHold'), { evidence: blockEvidence, blocking: true });
  }

  const inspectionEvidence = inspection
    ? {
        type: 'inspection',
        phase: inspection.latestPhase ?? null,
        at: inspection.latestAt ?? null,
        photosCaptured: Number(inspection?.photoCoverage?.captured || 0),
        photosRequired: Number(inspection?.photoCoverage?.required || 0),
      }
    : null;

  if (inspection?.status === 'NO_DATA') {
    deduct('inspectionMissing', 'Inspection', 'No recent inspection is on file for this vehicle.', weight('inspectionMissing'), { evidence: inspectionEvidence });
  } else if (inspection?.status === 'ATTENTION') {
    deduct('inspectionAttention', 'Inspection', 'Latest inspection needs review before the next turn.', weight('inspectionAttention'), { evidence: inspectionEvidence, silent: true });

    const missingPhotos = Math.max(0, Number(inspection?.photoCoverage?.required || 0) - Number(inspection?.photoCoverage?.captured || 0));
    if (missingPhotos > 0) {
      const points = Math.min(weight('inspectionMissingPhotoCap'), missingPhotos * weight('inspectionMissingPhotoEach'));
      deduct('inspectionMissingPhotos', 'Photo coverage', `Latest inspection is missing ${missingPhotos} required photo(s).`, points, { evidence: inspectionEvidence });
    }

    const conditionFlags = Number(inspection?.conditionAttentionCount || 0);
    if (conditionFlags > 0) {
      const points = Math.min(weight('inspectionConditionFlagCap'), conditionFlags * weight('inspectionConditionFlagEach'));
      deduct('inspectionConditionFlags', 'Condition flags', `Latest inspection has ${conditionFlags} condition flag(s) to review.`, points, { evidence: inspectionEvidence });
    }

    if (inspection?.damageReported) {
      deduct('inspectionDamageReported', 'Open damage', 'Latest inspection reported damage that still needs review before dispatch.', weight('inspectionDamageReported'), { evidence: inspectionEvidence, blocking: true });
    }

    const severity = String(inspection?.damageTriage?.severity || '').toUpperCase();
    if (severity === 'HIGH') {
      deduct('damageTriageHigh', 'Damage triage', 'Damage triage marked this vehicle as high-risk based on the latest inspection.', weight('damageTriageHigh'), { evidence: inspectionEvidence, blocking: true });
    } else if (severity === 'MEDIUM') {
      deduct('damageTriageMedium', 'Damage triage', 'Damage triage suggests moderate review before the next turn.', weight('damageTriageMedium'), { evidence: inspectionEvidence });
    }
  }

  const telematicsEvidence = telematics ? { type: 'telematics', at: telematics.lastEventAt ?? null } : null;

  switch (String(telematics?.status || '').toUpperCase()) {
    case 'NO_DEVICE':
      deduct('telematicsNoDevice', 'Telematics', 'No telematics device is linked to this vehicle.', weight('telematicsNoDevice'), { evidence: telematicsEvidence });
      break;
    case 'NO_SIGNAL':
      deduct('telematicsNoSignal', 'Telematics', 'Telematics device is linked but has not reported a signal yet.', weight('telematicsNoSignal'), { evidence: telematicsEvidence });
      break;
    case 'STALE':
      deduct('telematicsStale', 'Telematics', 'Telematics feed has gone stale and should be checked.', weight('telematicsStale'), { evidence: telematicsEvidence });
      break;
    case 'OFFLINE':
      deduct('telematicsOffline', 'Telematics', 'Telematics feed appears offline.', weight('telematicsOffline'), { evidence: telematicsEvidence });
      break;
    default:
      break;
  }

  const fuelLabel = telematics?.fuelPct == null ? 'Fuel' : `Fuel ${Math.round(Number(telematics.fuelPct))}%`;
  switch (String(telematics?.fuelStatus || '').toUpperCase()) {
    case 'CRITICAL':
      deduct('fuelCritical', fuelLabel, 'Fuel level is critically low for the next assignment.', weight('fuelCritical'), { evidence: telematicsEvidence });
      break;
    case 'LOW':
      deduct('fuelLow', fuelLabel, 'Fuel level is low and may need attention before dispatch.', weight('fuelLow'), { evidence: telematicsEvidence });
      break;
    default:
      break;
  }

  const feedLive = ['ONLINE', 'STALE'].includes(String(telematics?.status || '').toUpperCase());
  if (String(telematics?.gpsStatus || '').toUpperCase() === 'MISSING' && feedLive) {
    deduct('gpsMissing', 'GPS', 'Latest telematics update is missing GPS coordinates.', weight('gpsMissing'), { evidence: telematicsEvidence });
  }
  if (String(telematics?.odometerStatus || '').toUpperCase() === 'MISSING' && feedLive) {
    deduct('odometerMissing', 'Odometer', 'Latest telematics update is missing odometer data.', weight('odometerMissing'), { evidence: telematicsEvidence });
  }
  if (String(telematics?.batteryStatus || '').toUpperCase() === 'LOW') {
    deduct('batteryLow', 'Battery', 'Telematics battery is low.', weight('batteryLow'), { evidence: telematicsEvidence });
  }

  // ── Factors added 2026-08-03. Both OFF by default: enabling them lowers the
  // score of every unit that already has an expiring registration or an
  // approaching service, so it is the tenant's call, not ours.
  if (r.documentsEnabled) {
    const expiresAt = documents?.registrationExpiresAt ? new Date(documents.registrationExpiresAt) : null;
    const now = documents?.now ? new Date(documents.now) : new Date();
    if (expiresAt && !Number.isNaN(expiresAt.getTime())) {
      const days = Math.floor((expiresAt.getTime() - now.getTime()) / 86400000);
      const evidence = { type: 'document', document: 'registration', expiresAt: expiresAt.toISOString(), daysRemaining: days };
      if (days < 0) {
        deduct('documentsExpired', 'Documents', `Registration expired ${Math.abs(days)} day(s) ago.`, weight('documentsExpired'), { evidence });
      } else if (days <= weight('documentsExpiringWithinDays')) {
        deduct('documentsExpiringSoon', 'Documents', `Registration expires in ${days} day(s).`, weight('documentsExpiringSoon'), { evidence });
      } else {
        breakdown.push({
          key: 'documentsOk',
          label: 'Documents',
          detail: `Registration current · expires in ${days} day(s).`,
          delta: 0,
          kind: 'ok',
          evidence,
        });
      }
    }
  }

  if (r.maintenanceDueEnabled && maintenance) {
    const milesRemaining = maintenance.milesRemaining == null ? null : Number(maintenance.milesRemaining);
    const daysRemaining = maintenance.daysRemaining == null ? null : Number(maintenance.daysRemaining);
    const has = (v) => v != null && Number.isFinite(v);
    if (has(milesRemaining) || has(daysRemaining)) {
      const evidence = {
        type: 'serviceSchedule',
        serviceType: maintenance.serviceType ?? null,
        nextDueMiles: maintenance.nextDueMiles ?? null,
        nextDueAt: maintenance.nextDueAt ?? null,
        milesRemaining: has(milesRemaining) ? milesRemaining : null,
        daysRemaining: has(daysRemaining) ? daysRemaining : null,
      };
      const overdue = (has(milesRemaining) && milesRemaining < 0) || (has(daysRemaining) && daysRemaining < 0);
      const soon = (has(milesRemaining) && milesRemaining <= weight('maintenanceDueSoonWithinMiles'))
        || (has(daysRemaining) && daysRemaining <= weight('maintenanceDueSoonWithinDays'));
      // Prefer the mileage phrasing when we have it — that is how shops talk.
      const detailSuffix = has(milesRemaining)
        ? `${Math.abs(milesRemaining)} mi`
        : `${Math.abs(daysRemaining)} day(s)`;
      if (overdue) {
        deduct('maintenanceOverdue', 'Maintenance', `Service overdue by ${detailSuffix}.`, weight('maintenanceOverdue'), { evidence });
      } else if (soon) {
        deduct('maintenanceDueSoon', 'Maintenance', `Next service in ${detailSuffix}.`, weight('maintenanceDueSoon'), { evidence });
      } else {
        breakdown.push({
          key: 'maintenanceOk',
          label: 'Maintenance',
          detail: `Current · next service in ${detailSuffix}.`,
          delta: 0,
          kind: 'ok',
          evidence,
        });
      }
    }
  }

  const rawScore = breakdown.reduce((sum, row) => sum + row.delta, 0);
  const finalScore = clampScore(rawScore);
  // The clamp is a real adjustment, so it gets a real line. Without this the
  // column would not add up for any vehicle deep enough in the hole.
  if (finalScore !== rawScore) {
    breakdown.push({
      key: 'clamp',
      label: 'Floor',
      detail: `Score cannot go below 0 — ${rawScore} raised to ${finalScore}.`,
      delta: finalScore - rawScore,
      kind: 'clamp',
    });
  }

  const readyAt = Number(r.readyThreshold ?? DEFAULT_TURN_READY_RULES.readyThreshold);
  const watchAt = Number(r.watchThreshold ?? DEFAULT_TURN_READY_RULES.watchThreshold);
  const status = blockers.length
    ? 'BLOCKED'
    : finalScore >= readyAt
      ? 'READY'
      : finalScore >= watchAt
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
    // Legacy summary views — deduped and capped, as they have always been.
    // `breakdown` is the complete list; anything that must add up reads that.
    reasons: [...new Set(reasons)].slice(0, 4),
    blockers: [...new Set(blockers)].slice(0, 3),
    breakdown,
    activeBlockType: blockType || null,
    activeBlockLabel: activeBlock ? activeBlockLabel(blockType) : null,
    summary
  };
}

export function buildVehicleOperationalSignals({ latestAgreement = null, latestEvent = null, activeDevice = null, activeBlock = null, telematicsFeatureEnabled = true, rules = DEFAULT_TURN_READY_RULES, documents = null, maintenance = null }) {
  const inspection = buildInspectionIntelligence({
    checkout: latestAgreement?.checkoutInspection || null,
    checkin: latestAgreement?.checkinInspection || null
  });
  const telematics = buildTelematicsSummary({ device: activeDevice, event: latestEvent, featureEnabled: telematicsFeatureEnabled });
  const turnReady = buildTurnReadyScore({ inspection, telematics, activeBlock, documents, maintenance }, rules);

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

/**
 * Tenant Turn-Ready rules, resolved defensively.
 *
 * Scoring must never be able to take the planner down. A missing row, a
 * corrupt payload, or a Prisma client that predates the TurnReadyRuleSet model
 * (which is exactly what a rolling deploy looks like for the few seconds
 * before the new client lands) all degrade to the frozen defaults instead of
 * throwing — and the defaults reproduce the formula that shipped before this
 * table existed, so degrading changes nothing a user would notice.
 */
async function resolveTurnReadyRules(scope = {}) {
  if (!scope?.tenantId || !prisma?.turnReadyRuleSet?.findUnique) {
    return { ...DEFAULT_TURN_READY_RULES };
  }
  try {
    const row = await prisma.turnReadyRuleSet.findUnique({
      where: { tenantId: scope.tenantId },
      select: { rulesJson: true }
    });
    return parseStoredTurnReadyRules(row?.rulesJson);
  } catch {
    return { ...DEFAULT_TURN_READY_RULES };
  }
}

export async function buildVehicleOperationalSignalsMap(vehicleIds = [], scope = {}, options = {}) {
  const ids = [...new Set((Array.isArray(vehicleIds) ? vehicleIds : []).filter(Boolean))];
  if (!ids.length) return new Map();
  const activeBlocksByVehicleId = options?.activeBlocksByVehicleId instanceof Map ? options.activeBlocksByVehicleId : new Map();

  const tenantFilter = scope?.tenantId ? { tenantId: scope.tenantId } : {};
  // 2026-05-27: prior implementation loaded EVERY rental agreement (with all
  // its inspections including the photosJson blob) and every telematics event
  // for every vehicle, then picked the most recent of each in JS. With
  // ~125 vehicles and historical agreements that's hundreds of MB of payload
  // and easily blew past the 15s statement_timeout. We now scope to the
  // LATEST row per vehicle inside Postgres (DISTINCT ON), then load just
  // those rows' details.
  const tenantSqlFilter = scope?.tenantId
    ? Prisma.sql`AND "tenantId" = ${scope.tenantId}`
    : Prisma.empty;
  const idsArr = ids;

  const [latestAgreementRows, latestEventRows, devices] = await Promise.all([
    prisma.$queryRaw`
      SELECT DISTINCT ON ("vehicleId") "id", "vehicleId"
      FROM "RentalAgreement"
      WHERE "vehicleId" = ANY(${idsArr}::text[])
      ${tenantSqlFilter}
      ORDER BY "vehicleId", "createdAt" DESC
    `,
    prisma.$queryRaw`
      SELECT DISTINCT ON ("vehicleId") *
      FROM "VehicleTelematicsEvent"
      WHERE "vehicleId" = ANY(${idsArr}::text[])
      ${tenantSqlFilter}
      ORDER BY "vehicleId", "eventAt" DESC, "createdAt" DESC
    `,
    prisma.vehicleTelematicsDevice.findMany({
      where: {
        vehicleId: { in: ids },
        isActive: true,
        ...tenantFilter
      },
      orderBy: [{ updatedAt: 'desc' }, { createdAt: 'desc' }]
    })
  ]);

  // Hydrate the latest agreements with their CHECKOUT + CHECKIN inspections.
  // Filtering phase at the DB layer avoids dragging in irrelevant phases.
  // IMPORTANT (2026-06-10, planner 57014/504 fix): never select `photosJson`
  // here — it holds multi-MB base64 blobs and pulling it for every latest
  // agreement blew past the 15s statement_timeout (prisma slow query 140939ms
  // on this RentalAgreementInspection SELECT, then 57014 cancel -> /planner/
  // snapshot 504). Coverage is derived from the slim `photoStorageRefs` Json
  // plus a pg_column_size() presence probe (see slimInspectionPhotoMap).
  const latestAgreementIds = latestAgreementRows.map((row) => row.id);
  const [agreements, legacyPhotoPresenceRows] = latestAgreementIds.length
    ? await Promise.all([
        prisma.rentalAgreement.findMany({
          where: { id: { in: latestAgreementIds } },
          select: {
            vehicleId: true,
            id: true,
            agreementNumber: true,
            inspections: {
              where: { phase: { in: ['CHECKOUT', 'CHECKIN'] } },
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
                photoStorageRefs: true
              }
            }
          }
        }),
        // pg_column_size reads the stored (TOAST) size without detoasting the
        // blob, so this stays cheap no matter how large photosJson is. > 64
        // bytes filters out null / '{}' / '[]' placeholder rows.
        prisma.$queryRaw`
          SELECT "rentalAgreementId", "phase"::text AS "phase",
                 (pg_column_size("photosJson") > 64) AS "hasLegacyPhotos"
          FROM "RentalAgreementInspection"
          WHERE "rentalAgreementId" = ANY(${latestAgreementIds}::text[])
            AND "phase" IN ('CHECKOUT', 'CHECKIN')
        `
      ])
    : [[], []];

  const legacyPhotoPresence = new Map(
    (legacyPhotoPresenceRows || []).map((row) => [
      `${row.rentalAgreementId}|${String(row.phase || '').toUpperCase()}`,
      row.hasLegacyPhotos === true
    ])
  );

  const events = latestEventRows;

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
        photos: slimInspectionPhotoMap(
          checkout.photoStorageRefs,
          legacyPhotoPresence.get(`${agreement.id}|CHECKOUT`)
        )
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
        photos: slimInspectionPhotoMap(
          checkin.photoStorageRefs,
          legacyPhotoPresence.get(`${agreement.id}|CHECKIN`)
        )
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

  // Tenant scoring rules (2026-08-03). Callers may pass them in to avoid a
  // per-call lookup; otherwise resolve once for the whole batch.
  const rules = options?.rules || await resolveTurnReadyRules(scope);

  // The document and maintenance factors are opt-in, so their queries are too.
  // This function has a history of timing out on over-fetching (see the
  // DISTINCT ON note above) — a tenant that has not enabled these pays nothing.
  const documentsByVehicleId = new Map();
  const maintenanceByVehicleId = new Map();
  const now = options?.now ? new Date(options.now) : new Date();

  if (rules.documentsEnabled || rules.maintenanceDueEnabled) {
    const vehicleRows = await prisma.vehicle.findMany({
      where: { id: { in: ids }, ...tenantFilter },
      select: { id: true, mileage: true, registrationExpiresAt: true }
    });
    const mileageByVehicleId = new Map(vehicleRows.map((v) => [v.id, Number(v.mileage || 0)]));

    if (rules.documentsEnabled) {
      for (const v of vehicleRows) {
        documentsByVehicleId.set(v.id, { registrationExpiresAt: v.registrationExpiresAt || null, now });
      }
    }

    if (rules.maintenanceDueEnabled) {
      const schedules = await prisma.serviceSchedule.findMany({
        where: { vehicleId: { in: ids }, active: true, ...tenantFilter },
        select: { vehicleId: true, serviceType: true, nextDueMiles: true, nextDueAt: true }
      });
      for (const sched of schedules) {
        const mileage = mileageByVehicleId.get(sched.vehicleId) ?? null;
        const milesRemaining = sched.nextDueMiles != null && mileage != null
          ? Number(sched.nextDueMiles) - mileage
          : null;
        const daysRemaining = sched.nextDueAt
          ? Math.floor((new Date(sched.nextDueAt).getTime() - now.getTime()) / 86400000)
          : null;
        const candidate = {
          serviceType: sched.serviceType,
          nextDueMiles: sched.nextDueMiles ?? null,
          nextDueAt: sched.nextDueAt ? new Date(sched.nextDueAt).toISOString() : null,
          milesRemaining,
          daysRemaining
        };
        // A vehicle can have several schedules; the score should reflect the
        // one that comes due first, not whichever row the DB returned last.
        const urgency = (c) => Math.min(
          c.milesRemaining == null ? Number.POSITIVE_INFINITY : c.milesRemaining,
          c.daysRemaining == null ? Number.POSITIVE_INFINITY : c.daysRemaining
        );
        const existing = maintenanceByVehicleId.get(sched.vehicleId);
        if (!existing || urgency(candidate) < urgency(existing)) {
          maintenanceByVehicleId.set(sched.vehicleId, candidate);
        }
      }
    }
  }

  return new Map(ids.map((vehicleId) => ([
    vehicleId,
    buildVehicleOperationalSignals({
      latestAgreement: agreementByVehicleId.get(vehicleId) || null,
      latestEvent: latestEventByVehicleId.get(vehicleId) || null,
      activeDevice: activeDeviceByVehicleId.get(vehicleId) || null,
      activeBlock: activeBlocksByVehicleId.get(vehicleId) || null,
      telematicsFeatureEnabled: options?.telematicsFeatureEnabled !== false,
      rules,
      documents: documentsByVehicleId.get(vehicleId) || null,
      maintenance: maintenanceByVehicleId.get(vehicleId) || null
    })
  ])));
}
