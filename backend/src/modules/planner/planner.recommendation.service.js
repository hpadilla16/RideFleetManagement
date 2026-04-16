import { prisma } from '../../lib/prisma.js';
import { plannerRulesService } from './planner.rules.service.js';
import {
  DAY_MS,
  buildOccupancyMap,
  calculateShortage,
  intervalsOverlap,
  isMovablePlannerStatus,
  loadPlannerReservations,
  loadPlannerVehicles,
  normalizePlannerDateRange,
  reservationLocationId,
  reservationVehicleTypeId
} from './planner.service.js';

function previousAndNextIntervals(intervals = [], start, end) {
  const previous = [...intervals].filter((row) => row.end <= start).sort((a, b) => b.end - a.end)[0] || null;
  const next = [...intervals].filter((row) => row.start >= end).sort((a, b) => a.start - b.start)[0] || null;
  return { previous, next };
}

function vehicleIsCompatible(vehicle, reservation, rules) {
  if (!vehicle) return false;
  const status = String(vehicle.status || '').toUpperCase();
  if (['IN_MAINTENANCE', 'OUT_OF_SERVICE'].includes(status)) return false;

  const requiredVehicleTypeId = reservationVehicleTypeId(reservation);
  if (requiredVehicleTypeId) {
    if (rules.strictVehicleTypeMatch && vehicle.vehicleTypeId !== requiredVehicleTypeId) return false;
    if (!rules.strictVehicleTypeMatch && vehicle.vehicleTypeId !== requiredVehicleTypeId && !rules.allowUpgrade && !rules.allowDowngrade) return false;
  }

  const pickupLocationId = reservation.pickupLocationId || null;
  if (!rules.allowCrossLocationReassignment && pickupLocationId && vehicle.homeLocationId && vehicle.homeLocationId !== pickupLocationId) {
    return false;
  }

  return true;
}

function normalizePositiveInteger(value, fallback) {
  const parsed = Number.parseInt(String(value), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function clampInterval(interval, windowStartMs, windowEndMs) {
  const start = Math.max(windowStartMs, interval.start);
  const end = Math.min(windowEndMs, interval.end);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null;
  return {
    ...interval,
    start,
    end
  };
}

function buildAvailabilityWindows(intervals = [], windowStartMs, windowEndMs) {
  const clipped = intervals
    .map((interval) => clampInterval(interval, windowStartMs, windowEndMs))
    .filter(Boolean)
    .sort((left, right) => left.start - right.start);

  const windows = [];
  let cursor = windowStartMs;
  clipped.forEach((interval) => {
    if (interval.start > cursor) {
      windows.push({
        start: cursor,
        end: interval.start
      });
    }
    cursor = Math.max(cursor, interval.end);
  });
  if (cursor < windowEndMs) {
    windows.push({
      start: cursor,
      end: windowEndMs
    });
  }
  return windows.filter((window) => window.end > window.start);
}

function slotScoreMinutes(windowMinutes, requiredMinutes, futureSlackMinutes = 0) {
  const slack = Math.max(0, windowMinutes - requiredMinutes);
  return Math.max(0, 100 - Math.min(60, Math.floor(slack / 30)) + Math.min(20, Math.floor(futureSlackMinutes / 30)));
}

function humanVehicleLabel(vehicle = {}) {
  return vehicle.internalNumber || `${vehicle.make || ''} ${vehicle.model || ''}`.trim() || vehicle.id;
}

function findReservationsForVehicle(reservations = [], vehicleId) {
  return reservations
    .filter((reservation) => reservation.vehicleId === vehicleId)
    .sort((left, right) => new Date(left.pickupAt) - new Date(right.pickupAt));
}

async function loadOpenMaintenanceJobs(scope = {}, vehicleIds = []) {
  if (!scope?.tenantId || !vehicleIds.length) return [];
  return prisma.maintenanceJob.findMany({
    where: {
      vehicleId: { in: vehicleIds },
      status: { in: ['OPEN', 'IN_PROGRESS'] },
      vehicle: {
        tenantId: scope.tenantId
      }
    },
    orderBy: [{ openedAt: 'asc' }],
    select: {
      id: true,
      vehicleId: true,
      title: true,
      status: true,
      openedAt: true
    }
  });
}

export function scoreVehicleFit({ vehicle, reservation, intervals = [], rules = {} }) {
  const start = new Date(reservation.pickupAt).getTime();
  const end = new Date(reservation.returnAt).getTime();
  const requiredVehicleTypeId = reservationVehicleTypeId(reservation);
  const pickupLocationId = reservation.pickupLocationId || null;
  const { previous, next } = previousAndNextIntervals(intervals, start, end);

  const gapBefore = previous ? Math.max(0, start - previous.end) : 2 * DAY_MS;
  const gapAfter = next ? Math.max(0, next.start - end) : 2 * DAY_MS;
  const exactTypeMatch = !!requiredVehicleTypeId && vehicle.vehicleTypeId === requiredVehicleTypeId;
  const sameLocation = !!pickupLocationId && !!vehicle.homeLocationId && pickupLocationId === vehicle.homeLocationId;
  const slackMinutes = Math.round(Math.min(gapBefore, gapAfter) / (60 * 1000));
  const minTurnaround = Number(rules.minTurnaroundMinutes || 0);

  const parts = {
    exactVehicleType: exactTypeMatch ? 40 : 0,
    sameLocation: sameLocation ? 30 : 0,
    flexibleType: !exactTypeMatch && !rules.strictVehicleTypeMatch ? 10 : 0,
    idleGapEfficiency: Math.max(0, 20 - Math.min(20, Math.floor((gapBefore + gapAfter) / (12 * 60 * 60 * 1000)))),
    turnaroundSlack: slackMinutes >= minTurnaround ? Math.min(15, Math.floor((slackMinutes - minTurnaround) / 15)) : -20,
    futureImpactPenalty: next ? -Math.min(10, Math.floor((Math.max(0, next.start - end) / (60 * 60 * 1000)) / 8)) : 0
  };
  const score = Object.values(parts).reduce((sum, value) => sum + value, 0);
  return {
    score,
    parts
  };
}

export function explainVehicleRecommendation({ reservation, rules = {}, scoreParts = {} }) {
  const reasons = [];
  if (scoreParts.exactVehicleType > 0) reasons.push('Exact vehicle type match');
  else if (!rules.strictVehicleTypeMatch) reasons.push('Compatible under flexible vehicle type rules');
  if (scoreParts.sameLocation > 0) reasons.push('Home location matches pickup');
  if (scoreParts.turnaroundSlack >= 0) reasons.push('Turnaround buffer satisfied');
  if (scoreParts.idleGapEfficiency > 0) reasons.push('Lower idle gap impact than other candidates');
  if (!reasons.length) reasons.push(`Best available fit for reservation ${reservation?.reservationNumber || reservation?.id || ''}`.trim());
  return reasons;
}

async function resolveVehicleRules(scope, vehicle) {
  return plannerRulesService.resolveEffectiveRules({
    scope,
    locationId: vehicle?.homeLocationId || null,
    vehicleTypeId: vehicle?.vehicleTypeId || null
  });
}

function resolveVehicleRulesFromCache(ruleSet, vehicle) {
  const locationOverrides = vehicle?.homeLocationId ? (ruleSet.locationOverrides?.[vehicle.homeLocationId] || {}) : {};
  const vehicleTypeOverrides = vehicle?.vehicleTypeId ? (ruleSet.vehicleTypeOverrides?.[vehicle.vehicleTypeId] || {}) : {};
  return { ...ruleSet, ...locationOverrides, ...vehicleTypeOverrides };
}

async function createPlannerScenario({
  scope = {},
  start,
  end,
  locationId = null,
  vehicleTypeId = null,
  scenarioType,
  summary = {},
  rulesSnapshot = {},
  actions = []
} = {}) {
  const scenario = await prisma.plannerScenario.create({
    data: {
      tenantId: scope.tenantId,
      startAt: start,
      endAt: end,
      locationId,
      vehicleTypeId,
      scenarioType,
      status: 'SIMULATED',
      summaryJson: JSON.stringify(summary || {}),
      rulesSnapshotJson: JSON.stringify(rulesSnapshot || {}),
      createdByUserId: scope?.actorUserId || null,
      actions: {
        create: (actions || []).map((action, index) => ({
          reservationId: action.reservationId || null,
          vehicleId: action.vehicleId || null,
          actionType: action.actionType,
          actionPayloadJson: JSON.stringify(action.payload || {}),
          reasonSummary: Array.isArray(action.reasons) ? action.reasons.join(' | ') : (action.reasonSummary || null),
          score: Number.isFinite(action.score) ? action.score : null,
          sortOrder: Number.isFinite(action.sortOrder) ? action.sortOrder : index
        }))
      }
    },
    select: {
      id: true
    }
  });
  return scenario.id;
}

async function buildMaintenanceRecommendations({ start, end, locationId = null, vehicleTypeId = null, vehicleIds = [], durationMinutes = null, scope = {} }) {
  const [vehicles, reservations, baseRules, fullRuleSet] = await Promise.all([
    loadPlannerVehicles({ start, end, locationId, vehicleTypeId, scope }),
    loadPlannerReservations({ start, end, locationId, vehicleTypeId, scope }),
    plannerRulesService.resolveEffectiveRules({ scope, locationId, vehicleTypeId }),
    plannerRulesService.getRuleSet(scope)
  ]);
  const selectedVehicleIds = new Set((Array.isArray(vehicleIds) ? vehicleIds : []).map((value) => String(value)));
  const visibleVehicles = selectedVehicleIds.size ? vehicles.filter((vehicle) => selectedVehicleIds.has(vehicle.id)) : vehicles;
  const openJobs = await loadOpenMaintenanceJobs(scope, visibleVehicles.map((vehicle) => vehicle.id));
  const openJobVehicleIds = new Set(openJobs.map((job) => job.vehicleId));
  const candidateVehicles = openJobVehicleIds.size
    ? visibleVehicles.filter((vehicle) => openJobVehicleIds.has(vehicle.id))
    : visibleVehicles;

  const occupancy = buildOccupancyMap({ vehicles: visibleVehicles, reservations });
  const recommendations = [];
  const unresolved = [];
  const durationToUse = normalizePositiveInteger(durationMinutes, Number(baseRules.maintenanceBufferMinutes || 120));
  const windowStartMs = start.getTime();
  const windowEndMs = end.getTime();

  for (const vehicle of candidateVehicles) {
    const rules = resolveVehicleRulesFromCache(fullRuleSet, vehicle);
    const requiredMinutes = normalizePositiveInteger(durationToUse, Number(rules.maintenanceBufferMinutes || durationToUse));
    const intervals = occupancy.get(vehicle.id) || [];
    const windows = buildAvailabilityWindows(intervals, windowStartMs, windowEndMs)
      .map((window) => ({
        ...window,
        windowMinutes: Math.round((window.end - window.start) / (60 * 1000))
      }))
      .filter((window) => window.windowMinutes >= requiredMinutes)
      .sort((left, right) => left.windowMinutes - right.windowMinutes);

    if (!windows.length) {
      if (openJobVehicleIds.has(vehicle.id)) {
        const job = openJobs.find((row) => row.vehicleId === vehicle.id);
        unresolved.push({
          vehicleId: vehicle.id,
          internalNumber: vehicle.internalNumber,
          maintenanceJobId: job?.id || null,
          maintenanceTitle: job?.title || 'Open maintenance',
          reason: `No free window of ${requiredMinutes} minutes was found in the visible range`
        });
      }
      continue;
    }

    const bestWindow = windows[0];
    const reservationsForVehicle = findReservationsForVehicle(reservations, vehicle.id);
    const nextReservation = reservationsForVehicle.find((reservation) => new Date(reservation.pickupAt).getTime() >= bestWindow.end) || null;
    const futureSlackMinutes = nextReservation
      ? Math.max(0, Math.round((new Date(nextReservation.pickupAt).getTime() - bestWindow.end) / (60 * 1000)))
      : Math.round((bestWindow.windowMinutes - requiredMinutes) / 2);
    const job = openJobs.find((row) => row.vehicleId === vehicle.id) || null;
    recommendations.push({
      vehicleId: vehicle.id,
      internalNumber: vehicle.internalNumber,
      vehicleTypeId: vehicle.vehicleTypeId || null,
      maintenanceJobId: job?.id || null,
      maintenanceTitle: job?.title || 'Planned maintenance',
      start: new Date(bestWindow.start).toISOString(),
      end: new Date(bestWindow.start + requiredMinutes * 60 * 1000).toISOString(),
      windowEnd: new Date(bestWindow.end).toISOString(),
      durationMinutes: requiredMinutes,
      idleWindowMinutes: bestWindow.windowMinutes,
      impactScore: slotScoreMinutes(bestWindow.windowMinutes, requiredMinutes, futureSlackMinutes),
      reasons: [
        bestWindow.windowMinutes === requiredMinutes ? 'Fits tightly inside an existing idle window' : 'Uses the smallest available idle window first',
        futureSlackMinutes > 0 ? 'Leaves buffer before the next reservation' : 'No immediate downstream reservation impact in the visible range',
        job ? 'Prioritized because this vehicle already has an open maintenance job' : 'Vehicle can absorb maintenance in the current planner range'
      ]
    });
  }

  recommendations.sort((left, right) => right.impactScore - left.impactScore);

  const topRecommendations = recommendations.slice(0, 8);
  const actions = topRecommendations.map((item, index) => ({
    vehicleId: item.vehicleId,
    actionType: 'CREATE_MAINTENANCE_BLOCK',
    score: item.impactScore,
    sortOrder: index,
    reasons: item.reasons,
    payload: {
      blockedFrom: item.start,
      availableFrom: item.end,
      reason: item.maintenanceTitle,
      notes: Array.isArray(item.reasons) ? item.reasons.join(' | ') : null,
      sourceType: 'SMART_PLANNER'
    }
  }));

  return {
    durationMinutes: durationToUse,
    maintenanceQueueCount: openJobs.length,
    recommendations: topRecommendations,
    unresolved,
    actions
  };
}

async function buildWashPlan({ start, end, locationId = null, vehicleTypeId = null, vehicleIds = [], scope = {} }) {
  const [vehicles, reservations, baseRules, fullRuleSet] = await Promise.all([
    loadPlannerVehicles({ start, end, locationId, vehicleTypeId, scope }),
    loadPlannerReservations({ start, end, locationId, vehicleTypeId, scope }),
    plannerRulesService.resolveEffectiveRules({ scope, locationId, vehicleTypeId }),
    plannerRulesService.getRuleSet(scope)
  ]);
  const selectedVehicleIds = new Set((Array.isArray(vehicleIds) ? vehicleIds : []).map((value) => String(value)));
  const visibleVehicles = selectedVehicleIds.size ? vehicles.filter((vehicle) => selectedVehicleIds.has(vehicle.id)) : vehicles;

  const slots = [];
  const violations = [];

  for (const vehicle of visibleVehicles) {
    const rules = resolveVehicleRulesFromCache(fullRuleSet, vehicle);
    const washMinutes = Math.max(0, Number(rules.washBufferMinutes || baseRules.washBufferMinutes || 0));
    const prepMinutes = Math.max(0, Number(rules.prepBufferMinutes || baseRules.prepBufferMinutes || 0));
    if (washMinutes <= 0) continue;

    const assignedReservations = findReservationsForVehicle(reservations, vehicle.id)
      .filter((reservation) => isMovablePlannerStatus(reservation.status));

    for (let index = 0; index < assignedReservations.length - 1; index += 1) {
      const current = assignedReservations[index];
      const next = assignedReservations[index + 1];
      const gapMinutes = Math.round((new Date(next.pickupAt).getTime() - new Date(current.returnAt).getTime()) / (60 * 1000));
      const requiredMinutes = washMinutes + prepMinutes;
      const washStart = new Date(current.returnAt).toISOString();
      const washEnd = new Date(new Date(current.returnAt).getTime() + washMinutes * 60 * 1000).toISOString();

      if (gapMinutes >= requiredMinutes) {
        slots.push({
          vehicleId: vehicle.id,
          internalNumber: vehicle.internalNumber,
          currentReservationId: current.id,
          currentReservationNumber: current.reservationNumber,
          nextReservationId: next.id,
          nextReservationNumber: next.reservationNumber,
          start: washStart,
          end: washEnd,
          status: 'RECOMMENDED',
          washMinutes,
          prepMinutes,
          slackMinutes: gapMinutes - requiredMinutes,
          reasons: [
            'Wash and prep both fit before the next pickup',
            'Preserves the configured turnaround rules for this tenant'
          ]
        });
        continue;
      }

      if (gapMinutes >= washMinutes) {
        slots.push({
          vehicleId: vehicle.id,
          internalNumber: vehicle.internalNumber,
          currentReservationId: current.id,
          currentReservationNumber: current.reservationNumber,
          nextReservationId: next.id,
          nextReservationNumber: next.reservationNumber,
          start: washStart,
          end: washEnd,
          status: 'AT_RISK',
          washMinutes,
          prepMinutes,
          slackMinutes: Math.max(0, gapMinutes - washMinutes),
          reasons: [
            'Wash can fit, but prep buffer is short',
            'Review manually before locking the next departure'
          ]
        });
        continue;
      }

      violations.push({
        vehicleId: vehicle.id,
        internalNumber: vehicle.internalNumber,
        currentReservationId: current.id,
        currentReservationNumber: current.reservationNumber,
        nextReservationId: next.id,
        nextReservationNumber: next.reservationNumber,
        requiredMinutes,
        gapMinutes,
        reason: 'Not enough time between reservations to complete the configured wash and prep buffers'
      });
    }
  }

  slots.sort((left, right) => new Date(left.start) - new Date(right.start));
  violations.sort((left, right) => left.gapMinutes - right.gapMinutes);

  const topSlots = slots.slice(0, 24);
  const topViolations = violations.slice(0, 24);
  const actions = topSlots
    .filter((item) => item.status === 'RECOMMENDED')
    .map((item, index) => ({
      vehicleId: item.vehicleId,
      actionType: 'CREATE_WASH_BLOCK',
      score: Math.max(0, 100 - Math.min(60, Number(item.slackMinutes || 0))),
      sortOrder: index,
      reasons: item.reasons,
      payload: {
        blockedFrom: item.start,
        availableFrom: item.end,
        reason: 'Planned wash buffer',
        notes: Array.isArray(item.reasons) ? item.reasons.join(' | ') : null,
        sourceType: 'SMART_PLANNER'
      }
    }));

  return {
    rulesApplied: {
      washBufferMinutes: Number(baseRules.washBufferMinutes || 0),
      prepBufferMinutes: Number(baseRules.prepBufferMinutes || 0)
    },
    slots: topSlots,
    violations: topViolations,
    actions
  };
}

export const plannerRecommendationService = {
  async simulateAutoAccommodate(input = {}, scope = {}) {
    if (!scope?.tenantId) throw new Error('tenantId is required for planner simulation');
    const { start, end } = normalizePlannerDateRange(input);
    const locationId = input.locationId ? String(input.locationId) : null;
    const vehicleTypeId = input.vehicleTypeId ? String(input.vehicleTypeId) : null;
    const requestedReservationIds = new Set(Array.isArray(input.reservationIds) ? input.reservationIds.map((value) => String(value)) : []);

    const [reservations, vehicles, baseRules, fullRuleSet] = await Promise.all([
      loadPlannerReservations({ start, end, locationId, vehicleTypeId, scope }),
      loadPlannerVehicles({ start, end, locationId, vehicleTypeId, scope }),
      plannerRulesService.resolveEffectiveRules({ scope, locationId, vehicleTypeId }),
      plannerRulesService.getRuleSet(scope)
    ]);

    const candidates = reservations
      .filter((reservation) => !reservation.vehicleId && isMovablePlannerStatus(reservation.status))
      .filter((reservation) => !requestedReservationIds.size || requestedReservationIds.has(reservation.id))
      .sort((left, right) => {
        const pickupDiff = new Date(left.pickupAt) - new Date(right.pickupAt);
        if (pickupDiff !== 0) return pickupDiff;
        return new Date(right.returnAt) - new Date(right.pickupAt) - (new Date(left.returnAt) - new Date(left.pickupAt));
      });

    const occupancy = buildOccupancyMap({
      vehicles,
      reservations,
      ignoredReservationIds: new Set(candidates.map((reservation) => reservation.id))
    });

    const actions = [];
    const unresolved = [];

    for (const reservation of candidates) {
      const resLocationId = reservationLocationId(reservation);
      const resVehicleTypeId = reservationVehicleTypeId(reservation);
      const locationOverrides = resLocationId ? (fullRuleSet.locationOverrides?.[resLocationId] || {}) : {};
      const vehicleTypeOverrides = resVehicleTypeId ? (fullRuleSet.vehicleTypeOverrides?.[resVehicleTypeId] || {}) : {};
      const effectiveRules = { ...fullRuleSet, ...locationOverrides, ...vehicleTypeOverrides };
      const startMs = new Date(reservation.pickupAt).getTime();
      const endMs = new Date(reservation.returnAt).getTime();
      const ranked = vehicles
        .filter((vehicle) => vehicleIsCompatible(vehicle, reservation, effectiveRules))
        .map((vehicle) => {
          const intervals = occupancy.get(vehicle.id) || [];
          const hasConflict = intervals.some((interval) => intervalsOverlap(interval.start, interval.end, startMs, endMs));
          if (hasConflict) return null;
          const scored = scoreVehicleFit({ vehicle, reservation, intervals, rules: effectiveRules });
          return {
            vehicle,
            score: scored.score,
            scoreParts: scored.parts
          };
        })
        .filter(Boolean)
        .sort((left, right) => right.score - left.score);

      const bestFit = ranked[0];
      if (!bestFit) {
        unresolved.push({
          reservationId: reservation.id,
          reservationNumber: reservation.reservationNumber,
          reason: 'No compatible vehicle satisfies current planner rules and active occupancy'
        });
        continue;
      }

      actions.push({
        reservationId: reservation.id,
        vehicleId: bestFit.vehicle.id,
        actionType: 'ASSIGN_VEHICLE',
        score: bestFit.score,
        reasons: explainVehicleRecommendation({
          reservation,
          rules: effectiveRules,
          scoreParts: bestFit.scoreParts
        })
      });

      const intervals = occupancy.get(bestFit.vehicle.id) || [];
      intervals.push({
        type: 'reservation',
        reservationId: reservation.id,
        start: startMs,
        end: endMs
      });
      intervals.sort((left, right) => left.start - right.start);
      occupancy.set(bestFit.vehicle.id, intervals);
    }

    const unresolvedReservations = reservations.filter((reservation) => unresolved.some((row) => row.reservationId === reservation.id));
    const shortage = calculateShortage({
      start,
      end,
      reservations: unresolvedReservations,
      vehicles: []
    });

    const scenarioId = await createPlannerScenario({
      scope,
      start,
      end,
      locationId,
      vehicleTypeId,
      scenarioType: 'AUTO_ACCOMMODATE',
      summary: {
        totalCandidates: candidates.length,
        assigned: actions.length,
        unresolved: unresolved.length,
        carsNeeded: shortage.totalCarsNeeded
      },
      rulesSnapshot: baseRules,
      actions: actions.map((action) => ({
        reservationId: action.reservationId,
        vehicleId: action.vehicleId,
        actionType: action.actionType,
        score: action.score,
        reasons: action.reasons,
        payload: {
          reservationId: action.reservationId,
          vehicleId: action.vehicleId,
          reasons: action.reasons
        }
      }))
    });

    return {
      scenarioId,
      summary: {
        totalCandidates: candidates.length,
        assigned: actions.length,
        unresolved: unresolved.length,
        carsNeeded: shortage.totalCarsNeeded
      },
      actions,
      unresolved
    };
  },

  async simulateMaintenance(input = {}, scope = {}) {
    if (!scope?.tenantId) throw new Error('tenantId is required for planner simulation');
    const { start, end } = normalizePlannerDateRange(input);
    const locationId = input.locationId ? String(input.locationId) : null;
    const vehicleTypeId = input.vehicleTypeId ? String(input.vehicleTypeId) : null;
    const result = await buildMaintenanceRecommendations({
      start,
      end,
      locationId,
      vehicleTypeId,
      vehicleIds: input.vehicleIds,
      durationMinutes: input.durationMinutes,
      scope
    });
    const rulesSnapshot = await plannerRulesService.resolveEffectiveRules({ scope, locationId, vehicleTypeId });
    const scenarioId = await createPlannerScenario({
      scope,
      start,
      end,
      locationId,
      vehicleTypeId,
      scenarioType: 'MAINTENANCE_PLAN',
      summary: {
        recommended: result.recommendations.length,
        unresolved: result.unresolved.length,
        maintenanceQueueCount: result.maintenanceQueueCount,
        durationMinutes: result.durationMinutes
      },
      rulesSnapshot,
      actions: result.actions
    });
    return {
      scenarioId,
      ...result
    };
  },

  async simulateWashPlan(input = {}, scope = {}) {
    if (!scope?.tenantId) throw new Error('tenantId is required for planner simulation');
    const { start, end } = normalizePlannerDateRange(input);
    const locationId = input.locationId ? String(input.locationId) : null;
    const vehicleTypeId = input.vehicleTypeId ? String(input.vehicleTypeId) : null;
    const result = await buildWashPlan({
      start,
      end,
      locationId,
      vehicleTypeId,
      vehicleIds: input.vehicleIds,
      scope
    });
    const rulesSnapshot = await plannerRulesService.resolveEffectiveRules({ scope, locationId, vehicleTypeId });
    const scenarioId = await createPlannerScenario({
      scope,
      start,
      end,
      locationId,
      vehicleTypeId,
      scenarioType: 'WASH_PLAN',
      summary: {
        slots: result.slots.length,
        violations: result.violations.length,
        appliedSlots: result.actions.length
      },
      rulesSnapshot,
      actions: result.actions
    });
    return {
      scenarioId,
      ...result
    };
  }
};
