export const DAY_MS = 24 * 60 * 60 * 1000;
export const DAY_WIDTH = 72;

export function startOfDay(d) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

export function addDays(d, n) {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}

export function fmtDay(d) {
  return new Date(d).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export function statusColor(r, locked, overbooked = false) {
  if (overbooked) return '#ef4444';
  if (locked) return '#9ca3af';
  switch (r.status) {
    case 'CONFIRMED': return '#22c55e';
    case 'NEW': return '#38bdf8';
    case 'CHECKED_OUT': return '#a78bfa';
    case 'CHECKED_IN': return '#f59e0b';
    case 'CANCELLED': return '#ef4444';
    case 'NO_SHOW': return '#f97316';
    default: return '#60a5fa';
  }
}

export function blockColor(block) {
  const blockType = String(block?.blockType || '').toUpperCase();
  if (blockType === 'MAINTENANCE_HOLD') return '#f59e0b';
  if (blockType === 'WASH_HOLD') return '#06b6d4';
  if (blockType === 'OUT_OF_SERVICE_HOLD') return '#ef4444';
  const sourceType = String(block?.sourceType || '').toUpperCase();
  return sourceType === 'BULK_IMPORT' ? '#64748b' : '#6b7280';
}

export function activeAvailabilityBlock(vehicle) {
  const now = Date.now();
  return (Array.isArray(vehicle?.availabilityBlocks) ? vehicle.availabilityBlocks : []).find((block) => {
    const releasedAt = block?.releasedAt ? new Date(block.releasedAt).getTime() : null;
    const blockedFrom = block?.blockedFrom ? new Date(block.blockedFrom).getTime() : now;
    const availableFrom = block?.availableFrom ? new Date(block.availableFrom).getTime() : null;
    return !releasedAt && blockedFrom <= now && availableFrom && availableFrom > now;
  }) || null;
}

export function blockTypeLabel(value) {
  switch (String(value || '').toUpperCase()) {
    case 'MAINTENANCE_HOLD': return 'Maintenance Hold';
    case 'WASH_HOLD': return 'Wash Buffer';
    case 'OUT_OF_SERVICE_HOLD': return 'Out Of Service';
    default: return 'Migration Hold';
  }
}

export function isMigrationHold(block) {
  return String(block?.blockType || '').toUpperCase() === 'MIGRATION_HOLD';
}

export function isServiceHold(block) {
  return ['MAINTENANCE_HOLD', 'OUT_OF_SERVICE_HOLD'].includes(String(block?.blockType || '').toUpperCase());
}

export function isWashHold(block) {
  return String(block?.blockType || '').toUpperCase() === 'WASH_HOLD';
}

export function inspectionAttentionStatus(vehicle) {
  return String(vehicle?.operationalSignals?.inspection?.status || '').toUpperCase();
}

export function telematicsStatus(vehicle) {
  return String(vehicle?.operationalSignals?.telematics?.status || '').toUpperCase();
}

export function turnReadyStatus(vehicle) {
  return String(vehicle?.operationalSignals?.turnReady?.status || '').toUpperCase();
}

export function turnReadyScore(vehicle) {
  const value = Number(vehicle?.operationalSignals?.turnReady?.score);
  return Number.isFinite(value) ? value : null;
}

export function hasInspectionAttention(vehicle) {
  return inspectionAttentionStatus(vehicle) === 'ATTENTION';
}

export function hasTelematicsAttention(vehicle) {
  return ['STALE', 'OFFLINE', 'NO_SIGNAL'].includes(telematicsStatus(vehicle));
}

export function hasTurnReadyAttention(vehicle) {
  return ['WATCH', 'ATTENTION', 'BLOCKED'].includes(turnReadyStatus(vehicle));
}

export function turnReadyTone(value) {
  switch (String(value || '').toUpperCase()) {
    case 'READY':
      return 'good';
    case 'WATCH':
      return 'neutral';
    case 'ATTENTION':
    case 'BLOCKED':
      return 'warn';
    default:
      return 'neutral';
  }
}

export function toLocalDateTimeInput(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  return `${year}-${month}-${day}T${hours}:${minutes}`;
}

export function dayIndexInRange(rangeStart, dt) {
  return Math.floor((startOfDay(dt) - rangeStart) / DAY_MS);
}

export function reservationOverlapsRange(reservation, rangeStart, rangeEnd) {
  const pickup = new Date(reservation?.pickupAt);
  const ret = new Date(reservation?.returnAt);
  return pickup < rangeEnd && ret > rangeStart;
}

export function isPlannerMovableReservation(reservation) {
  const status = String(reservation?.status || '').toUpperCase();
  return !['CHECKED_OUT', 'CANCELLED', 'NO_SHOW'].includes(status);
}

export function intervalsOverlap(startA, endA, startB, endB) {
  return startA < endB && endA > startB;
}

export function reservationVehicleTypeId(reservation) {
  return reservation?.vehicleTypeId || reservation?.vehicleType?.id || null;
}

export function buildTrackOccupancy({ vehicles, reservations, ignoredReservationIds = new Set() }) {
  const occupancy = new Map();
  (vehicles || []).forEach((vehicle) => occupancy.set(vehicle.id, []));

  (reservations || []).forEach((reservation) => {
    const status = String(reservation?.status || '').toUpperCase();
    if (!reservation?.vehicleId || ignoredReservationIds.has(reservation.id) || (!isPlannerMovableReservation(reservation) && status !== 'CHECKED_OUT')) return;
    if (!occupancy.has(reservation.vehicleId)) return;
    const start = new Date(reservation.pickupAt).getTime();
    const end = new Date(reservation.returnAt).getTime();
    if (!Number.isFinite(start) || !Number.isFinite(end)) return;
    occupancy.get(reservation.vehicleId).push({
      type: 'reservation',
      reservationId: reservation.id,
      start,
      end
    });
  });

  (vehicles || []).forEach((vehicle) => {
    const list = occupancy.get(vehicle.id) || [];
    (Array.isArray(vehicle?.availabilityBlocks) ? vehicle.availabilityBlocks : []).forEach((block) => {
      if (block?.releasedAt) return;
      const start = new Date(block.blockedFrom || block.createdAt || new Date()).getTime();
      const end = new Date(block.availableFrom).getTime();
      if (!Number.isFinite(start) || !Number.isFinite(end)) return;
      list.push({
        type: 'block',
        blockId: block.id,
        start,
        end
      });
    });
    list.sort((a, b) => a.start - b.start);
    occupancy.set(vehicle.id, list);
  });

  return occupancy;
}

export function scoreVehicleFit(vehicle, reservation, intervals) {
  const start = new Date(reservation.pickupAt).getTime();
  const end = new Date(reservation.returnAt).getTime();
  const previous = [...intervals].filter((row) => row.end <= start).sort((a, b) => b.end - a.end)[0] || null;
  const next = [...intervals].filter((row) => row.start >= end).sort((a, b) => a.start - b.start)[0] || null;
  const gapBefore = previous ? Math.max(0, start - previous.end) : 4 * DAY_MS;
  const gapAfter = next ? Math.max(0, next.start - end) : 4 * DAY_MS;
  const pickupLocationId = reservation?.pickupLocationId || reservation?.locationId || null;
  const returnLocationId = reservation?.returnLocationId || null;
  const homeLocationId = vehicle?.homeLocationId || null;
  const locationPenalty =
    homeLocationId && (pickupLocationId || returnLocationId)
      ? ((pickupLocationId && homeLocationId !== pickupLocationId ? 3 * DAY_MS : 0) + (returnLocationId && homeLocationId !== returnLocationId ? 1.5 * DAY_MS : 0))
      : 0;
  return locationPenalty + gapBefore + gapAfter;
}

export function reservationVehicleTypeLabel(reservation) {
  return (
    reservation?.vehicleType?.name
    || reservation?.vehicle?.vehicleType?.name
    || reservation?.vehicleType?.code
    || reservation?.vehicle?.vehicleType?.code
    || 'Unspecified'
  );
}

export function buildPlannerQuery(rangeStart, rangeEnd, filterLocationId, filterVehicleTypeId, tenantId = '') {
  const params = new URLSearchParams({
    start: rangeStart.toISOString(),
    end: rangeEnd.toISOString()
  });
  if (filterLocationId) params.set('locationId', filterLocationId);
  if (filterVehicleTypeId) params.set('vehicleTypeId', filterVehicleTypeId);
  if (tenantId) params.set('tenantId', tenantId);
  return `/api/planner/snapshot?${params.toString()}`;
}

export function createPlannerRulesForm(rules = null) {
  return {
    minTurnaroundMinutes: String(rules?.minTurnaroundMinutes ?? 60),
    washBufferMinutes: String(rules?.washBufferMinutes ?? 30),
    prepBufferMinutes: String(rules?.prepBufferMinutes ?? 15),
    maintenanceBufferMinutes: String(rules?.maintenanceBufferMinutes ?? 120),
    lockWindowMinutesBeforePickup: String(rules?.lockWindowMinutesBeforePickup ?? 180),
    sameDayReservationBufferMinutes: String(rules?.sameDayReservationBufferMinutes ?? 45),
    allowCrossLocationReassignment: !!rules?.allowCrossLocationReassignment,
    strictVehicleTypeMatch: rules?.strictVehicleTypeMatch !== false,
    allowUpgrade: rules?.allowUpgrade !== false,
    allowDowngrade: !!rules?.allowDowngrade,
    defaultWashRequired: rules?.defaultWashRequired !== false,
    assignmentMode: String(rules?.assignmentMode || 'STRICT'),
    maintenanceMode: String(rules?.maintenanceMode || 'FLEXIBLE')
  };
}

export function createPlannerCopilotConfig(config = null) {
  return {
    enabled: !!config?.enabled,
    model: String(config?.model || 'gpt-4.1-mini'),
    ready: !!config?.ready,
    credentialSource: String(config?.credentialSource || 'NONE'),
    hasTenantApiKey: !!config?.hasTenantApiKey,
    allowedModels: Array.isArray(config?.allowedModels) ? config.allowedModels : [],
    monthlyQueryCap: config?.monthlyQueryCap == null ? null : Number(config.monthlyQueryCap),
    aiOnlyForPaidPlan: !!config?.aiOnlyForPaidPlan,
    tenantPlan: String(config?.tenantPlan || 'BETA'),
    planEligible: config?.planEligible !== false,
    modelAllowed: config?.modelAllowed !== false,
    planDefaults: {
      plannerCopilotIncluded: !!config?.planDefaults?.plannerCopilotIncluded,
      telematicsIncluded: !!config?.planDefaults?.telematicsIncluded,
      inspectionIntelligenceIncluded: config?.planDefaults?.inspectionIntelligenceIncluded !== false
    },
    usage: {
      currentPeriod: {
        period: config?.usage?.currentPeriod?.period || null,
        totalQueries: Number(config?.usage?.currentPeriod?.totalQueries || 0),
        aiResponses: Number(config?.usage?.currentPeriod?.aiResponses || 0),
        heuristicResponses: Number(config?.usage?.currentPeriod?.heuristicResponses || 0)
      },
      remainingQueries: config?.usage?.remainingQueries == null ? null : Number(config.usage.remainingQueries),
      monthlyCapReached: !!config?.usage?.monthlyCapReached
    }
  };
}
