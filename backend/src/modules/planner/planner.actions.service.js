import { prisma } from '../../lib/prisma.js';
import { activeVehicleBlockOverlapWhere } from '../vehicles/vehicle-blocks.js';
import { plannerRulesService } from './planner.rules.service.js';
import { isAssignableReservationStatus } from './planner.service.js';

function tenantWhere(scope = {}) {
  if (scope?.tenantId) return { tenantId: scope.tenantId };
  return scope?.allowCrossTenant ? undefined : { tenantId: '__never__' };
}

// Conflict errors carry a machine-readable code so the single-assignment
// endpoint (POST /api/planner/assign, 2026-07-14 board reimagining) can map
// them to 409 {error, code, detail}. The MESSAGES stay identical to the
// legacy ones so apply-plan's RECOVERABLE_PATTERNS regexes keep matching.
function plannerConflict(code, message, detail = null) {
  const error = new Error(message);
  error.plannerConflictCode = code;
  error.plannerConflictDetail = detail || message;
  return error;
}

async function ensureReservationForAction(tx, reservationId, scope = {}) {
  const reservation = await tx.reservation.findFirst({
    where: {
      id: reservationId,
      ...(tenantWhere(scope) || {})
    },
    select: {
      id: true,
      tenantId: true,
      reservationNumber: true,
      status: true,
      vehicleId: true,
      vehicleTypeId: true,
      pickupLocationId: true,
      pickupAt: true,
      returnAt: true
    }
  });
  if (!reservation) throw new Error('Reservation not found');
  return reservation;
}

async function ensureVehicleAvailableForReservation(tx, vehicleId, reservation, scope = {}, { turnaroundMinutes = 0 } = {}) {
  const vehicle = await tx.vehicle.findFirst({
    where: {
      id: vehicleId,
      ...(tenantWhere(scope) || {})
    },
    select: {
      id: true,
      internalNumber: true,
      status: true,
      vehicleTypeId: true,
      homeLocationId: true
    }
  });
  if (!vehicle) throw new Error('Vehicle not found');
  if (['IN_MAINTENANCE', 'OUT_OF_SERVICE', 'SOLD'].includes(String(vehicle.status || '').toUpperCase())) {
    throw plannerConflict('LOCKED_STATUS', `Vehicle ${vehicle.internalNumber || vehicle.id} is not available for assignment`);
  }

  const conflictingReservation = await tx.reservation.findFirst({
    where: {
      ...(tenantWhere(scope) || {}),
      vehicleId,
      id: { not: reservation.id },
      status: { in: ['NEW', 'CONFIRMED', 'CHECKED_OUT'] },
      pickupAt: { lt: reservation.returnAt },
      returnAt: { gt: reservation.pickupAt }
    },
    select: {
      id: true,
      reservationNumber: true
    }
  });
  if (conflictingReservation) {
    throw plannerConflict('OCCUPIED', `Vehicle conflict with reservation ${conflictingReservation.reservationNumber}`);
  }

  const conflictingBlock = await tx.vehicleAvailabilityBlock.findFirst({
    where: {
      ...(tenantWhere(scope) || {}),
      vehicleId,
      ...activeVehicleBlockOverlapWhere({
        start: reservation.pickupAt,
        end: reservation.returnAt
      })
    },
    select: {
      id: true,
      blockType: true,
      availableFrom: true
    }
  });
  if (conflictingBlock) {
    throw plannerConflict('OCCUPIED', `Vehicle has an active ${String(conflictingBlock.blockType || '').toLowerCase()} during this reservation window`);
  }

  // Turnaround buffer (PlannerRuleSet.minTurnaroundMinutes): a raw-window
  // clear vehicle can still be an illegal drop if the neighboring occupancy
  // does not leave the tenant's configured turnaround gap. Only the /assign
  // path passes a buffer — apply-plan keeps its historical semantics
  // (buffer 0, raw overlap only).
  const bufferMs = Math.max(0, Number(turnaroundMinutes || 0)) * 60 * 1000;
  if (bufferMs > 0) {
    const bufferedStart = new Date(new Date(reservation.pickupAt).getTime() - bufferMs);
    const bufferedEnd = new Date(new Date(reservation.returnAt).getTime() + bufferMs);
    const turnaroundReservation = await tx.reservation.findFirst({
      where: {
        ...(tenantWhere(scope) || {}),
        vehicleId,
        id: { not: reservation.id },
        status: { in: ['NEW', 'CONFIRMED', 'CHECKED_OUT'] },
        pickupAt: { lt: bufferedEnd },
        returnAt: { gt: bufferedStart }
      },
      select: {
        id: true,
        reservationNumber: true
      }
    });
    if (turnaroundReservation) {
      throw plannerConflict('TURNAROUND', `Vehicle conflict with reservation ${turnaroundReservation.reservationNumber} inside the ${Number(turnaroundMinutes)}-minute turnaround buffer`);
    }

    const turnaroundBlock = await tx.vehicleAvailabilityBlock.findFirst({
      where: {
        ...(tenantWhere(scope) || {}),
        vehicleId,
        ...activeVehicleBlockOverlapWhere({
          start: bufferedStart,
          end: bufferedEnd
        })
      },
      select: {
        id: true,
        blockType: true
      }
    });
    if (turnaroundBlock) {
      throw plannerConflict('TURNAROUND', `Vehicle has an active ${String(turnaroundBlock.blockType || '').toLowerCase()} inside the ${Number(turnaroundMinutes)}-minute turnaround buffer`);
    }
  }

  return vehicle;
}

async function ensureVehicleForBlock(tx, vehicleId, scope = {}) {
  const vehicle = await tx.vehicle.findFirst({
    where: {
      id: vehicleId,
      ...(tenantWhere(scope) || {})
    },
    select: {
      id: true,
      tenantId: true,
      internalNumber: true,
      status: true
    }
  });
  if (!vehicle) throw new Error('Vehicle not found');
  return vehicle;
}

function normalizeActionWindow(payload = {}) {
  const blockedFrom = payload?.blockedFrom ? new Date(payload.blockedFrom) : null;
  const availableFrom = payload?.availableFrom ? new Date(payload.availableFrom) : null;
  if (!blockedFrom || Number.isNaN(blockedFrom.getTime())) throw new Error('blockedFrom is required for planner block action');
  if (!availableFrom || Number.isNaN(availableFrom.getTime())) throw new Error('availableFrom is required for planner block action');
  if (availableFrom <= blockedFrom) throw new Error('availableFrom must be after blockedFrom for planner block action');
  return { blockedFrom, availableFrom };
}

async function ensureVehicleAvailableForBlock(tx, vehicleId, payload, scope = {}) {
  const vehicle = await ensureVehicleForBlock(tx, vehicleId, scope);
  const { blockedFrom, availableFrom } = normalizeActionWindow(payload);

  const conflictingReservation = await tx.reservation.findFirst({
    where: {
      ...(tenantWhere(scope) || {}),
      vehicleId,
      status: { in: ['NEW', 'CONFIRMED', 'CHECKED_OUT'] },
      pickupAt: { lt: availableFrom },
      returnAt: { gt: blockedFrom }
    },
    select: {
      id: true,
      reservationNumber: true
    }
  });
  if (conflictingReservation) {
    throw new Error(`Vehicle conflict with reservation ${conflictingReservation.reservationNumber}`);
  }

  const conflictingBlock = await tx.vehicleAvailabilityBlock.findFirst({
    where: {
      ...(tenantWhere(scope) || {}),
      vehicleId,
      ...activeVehicleBlockOverlapWhere({
        start: blockedFrom,
        end: availableFrom
      })
    },
    select: {
      id: true,
      blockType: true
    }
  });
  if (conflictingBlock) {
    throw new Error(`Vehicle already has an active ${String(conflictingBlock.blockType || '').toLowerCase()} during this planner block window`);
  }

  return {
    vehicle,
    blockedFrom,
    availableFrom
  };
}

function normalizeIncomingActions(rawActions = []) {
  return (Array.isArray(rawActions) ? rawActions : []).map((action, index) => ({
    reservationId: action?.reservationId ? String(action.reservationId) : null,
    vehicleId: action?.vehicleId ? String(action.vehicleId) : null,
    actionType: String(action?.actionType || '').trim().toUpperCase(),
    sortOrder: Number.isFinite(action?.sortOrder) ? action.sortOrder : index,
    payload: action?.payload && typeof action.payload === 'object' ? action.payload : null
  }));
}

export const plannerActionsService = {
  /**
   * Transactional single assignment for the board's drag-drop (2026-07-14
   * planner reimagining). Replaces the frontend's direct
   * PATCH /api/reservations/:id, which bypassed every planner rule.
   *
   * vehicleId null = unassign. force:true bypasses the strict type-match
   * rule ONLY — occupancy/turnaround conflicts are never bypassable.
   * Conflicts throw with plannerConflictCode
   * (OCCUPIED | LOCKED_STATUS | TYPE_MISMATCH | TURNAROUND) → route maps to 409.
   */
  async assignVehicle({ reservationId, vehicleId = null, force = false, scope = {}, actorUserId = null } = {}) {
    if (!scope?.tenantId) throw new Error('tenantId is required for planner assign');
    if (!reservationId) throw new Error('reservationId is required for planner assign');
    const nextVehicleId = vehicleId ? String(vehicleId) : null;

    const updated = await prisma.$transaction(async (tx) => {
      const reservation = await ensureReservationForAction(tx, String(reservationId), scope);
      const status = String(reservation.status || '').toUpperCase();
      if (!isAssignableReservationStatus(status)) {
        throw plannerConflict('LOCKED_STATUS', status === 'CHECKED_OUT'
          ? `Reservation ${reservation.reservationNumber} is locked by check-out and cannot be reassigned`
          : `Reservation ${reservation.reservationNumber} is ${status} and cannot be assigned from the planner`);
      }

      if (nextVehicleId && reservation.vehicleId !== nextVehicleId) {
        const rules = await plannerRulesService.resolveEffectiveRules({
          scope,
          locationId: reservation.pickupLocationId || null,
          vehicleTypeId: reservation.vehicleTypeId || null
        });
        const vehicle = await ensureVehicleAvailableForReservation(tx, nextVehicleId, reservation, scope, {
          turnaroundMinutes: Number(rules.minTurnaroundMinutes || 0)
        });
        if (!force && rules.strictVehicleTypeMatch && reservation.vehicleTypeId && vehicle.vehicleTypeId !== reservation.vehicleTypeId) {
          throw plannerConflict('TYPE_MISMATCH', `Vehicle ${vehicle.internalNumber || vehicle.id} does not match the reserved vehicle type`, 'Pass force:true to override the strict vehicle-type rule for this drop');
        }
        // Cross-location parity with the recommendation engine (Innovation
        // MUST-CHANGE 2026-07-14): the drag preview and vehicleIsCompatible()
        // both flag this, so the endpoint must enforce it too — otherwise a
        // drop on a "red" lane silently succeeds. Same force story as
        // TYPE_MISMATCH (rule overrides only; never occupancy).
        if (
          !force &&
          !rules.allowCrossLocationReassignment &&
          reservation.pickupLocationId &&
          vehicle.homeLocationId &&
          vehicle.homeLocationId !== reservation.pickupLocationId
        ) {
          throw plannerConflict('CROSS_LOCATION', `Vehicle ${vehicle.internalNumber || vehicle.id} is homed at a different location than the reservation pickup`, 'Pass force:true to override the cross-location rule for this drop');
        }
      }

      const row = await tx.reservation.update({
        where: { id: reservation.id },
        data: nextVehicleId
          ? { vehicle: { connect: { id: nextVehicleId } } }
          : { vehicle: { disconnect: true } },
        select: {
          id: true,
          tenantId: true,
          reservationNumber: true,
          status: true,
          vehicleId: true
        }
      });
      // Same audit shape apply-plan writes. AuditAction has no PLANNER_ASSIGN
      // value and migrations are out of scope for this ship, so the action
      // rides in metadata (action: 'PLANNER_ASSIGN') on an UPDATE row.
      await tx.auditLog.create({
        data: {
          tenantId: row.tenantId || scope.tenantId,
          reservationId: row.id,
          action: 'UPDATE',
          actorUserId: actorUserId || null,
          fromStatus: reservation.status,
          toStatus: row.status,
          reason: 'Planner board assignment',
          metadata: JSON.stringify({
            source: 'planner-board',
            action: 'PLANNER_ASSIGN',
            previousVehicleId: reservation.vehicleId || null,
            nextVehicleId,
            force: !!force
          })
        }
      });
      return row;
    });

    return {
      ok: true,
      reservation: {
        id: updated.id,
        vehicleId: updated.vehicleId || null
      },
      conflict: null
    };
  },

  async applyScenario({ scenarioId, actions = null, scope = {}, actorUserId = null } = {}) {
    if (!scope?.tenantId) throw new Error('tenantId is required for planner apply-plan');
    if (!scenarioId) throw new Error('scenarioId is required');

    const scenario = await prisma.plannerScenario.findFirst({
      where: {
        id: scenarioId,
        tenantId: scope.tenantId
      },
      include: {
        actions: {
          orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }]
        }
      }
    });
    if (!scenario) throw new Error('Planner scenario not found');

    const requestedActions = normalizeIncomingActions(actions || []);
    const scenarioActions = requestedActions.length
      ? requestedActions
      : (scenario.actions || []).map((action) => ({
          reservationId: action.reservationId ? String(action.reservationId) : null,
          vehicleId: action.vehicleId ? String(action.vehicleId) : null,
          actionType: String(action.actionType || '').trim().toUpperCase(),
          sortOrder: action.sortOrder || 0,
          payload: (() => {
            try {
              return action.actionPayloadJson ? JSON.parse(action.actionPayloadJson) : null;
            } catch {
              return null;
            }
          })()
        }));

    if (!scenarioActions.length) throw new Error('Planner scenario has no actions to apply');

    // Errors that indicate the world changed between simulate and apply (or
    // between scenario persistence and apply). These are recoverable per-action:
    // we skip the stale action and keep going so the other 79 valid assignments
    // still land. All of these are thrown BEFORE any tx.write, so the postgres
    // transaction state stays healthy after catching.
    const RECOVERABLE_PATTERNS = /is locked by check-out|is not available for assignment|Vehicle conflict with reservation|active .* during this reservation window|active .* during this planner block window|Reservation not found|Vehicle not found|reservationId is required for planner action|vehicleId is required for ASSIGN_VEHICLE|vehicleId is required for planner block action|must be after blockedFrom|blockedFrom is required for planner block action|availableFrom is required for planner block action/i;

    const skipped = [];

    const applied = await prisma.$transaction(async (tx) => {
      const results = [];
      for (const action of scenarioActions.sort((left, right) => left.sortOrder - right.sortOrder)) {
        try {
        if (!['ASSIGN_VEHICLE', 'UNASSIGN_VEHICLE', 'CREATE_MAINTENANCE_BLOCK', 'CREATE_WASH_BLOCK'].includes(action.actionType)) {
          throw new Error(`Planner action ${action.actionType || 'UNKNOWN'} is not supported yet`);
        }

        if (['ASSIGN_VEHICLE', 'UNASSIGN_VEHICLE'].includes(action.actionType) && !action.reservationId) {
          throw new Error('reservationId is required for planner action');
        }

        if (['ASSIGN_VEHICLE', 'UNASSIGN_VEHICLE'].includes(action.actionType)) {
          const reservation = await ensureReservationForAction(tx, action.reservationId, scope);
          if (String(reservation.status || '').toUpperCase() === 'CHECKED_OUT') {
            throw new Error(`Reservation ${reservation.reservationNumber} is locked by check-out and cannot be reassigned`);
          }

          if (action.actionType === 'ASSIGN_VEHICLE') {
            if (!action.vehicleId) throw new Error('vehicleId is required for ASSIGN_VEHICLE');
            if (reservation.vehicleId !== action.vehicleId) {
              await ensureVehicleAvailableForReservation(tx, action.vehicleId, reservation, scope);
            }
            const updated = await tx.reservation.update({
              where: { id: reservation.id },
              data: {
                vehicle: { connect: { id: action.vehicleId } }
              },
              select: {
                id: true,
                tenantId: true,
                reservationNumber: true,
                status: true,
                vehicleId: true
              }
            });
            await tx.auditLog.create({
              data: {
                tenantId: updated.tenantId || scope.tenantId,
                reservationId: updated.id,
                action: 'UPDATE',
                actorUserId: actorUserId || null,
                fromStatus: reservation.status,
                toStatus: updated.status,
                reason: 'Planner scenario applied',
                metadata: JSON.stringify({
                  source: 'smart-planner',
                  scenarioId,
                  actionType: action.actionType,
                  previousVehicleId: reservation.vehicleId || null,
                  nextVehicleId: action.vehicleId
                })
              }
            });
            await tx.plannerRecommendationAudit.create({
              data: {
                tenantId: updated.tenantId || scope.tenantId,
                scenarioId,
                recommendationType: 'VEHICLE_ASSIGNMENT',
                reservationId: updated.id,
                vehicleId: action.vehicleId,
                title: `Applied Smart Planner assignment for ${updated.reservationNumber}`,
                detail: 'Planner scenario assignment applied from simulation',
                recommendationJson: JSON.stringify({
                  source: 'smart-planner',
                  scenarioId,
                  actionType: action.actionType,
                  reservationId: updated.id,
                  vehicleId: action.vehicleId
                }),
                applied: true,
                appliedByUserId: actorUserId || null,
                appliedAt: new Date()
              }
            });
            results.push(updated);
            continue;
          }

          const updated = await tx.reservation.update({
            where: { id: reservation.id },
            data: {
              vehicle: { disconnect: true }
            },
            select: {
              id: true,
              tenantId: true,
              reservationNumber: true,
              status: true,
              vehicleId: true
            }
          });
          await tx.auditLog.create({
            data: {
              tenantId: updated.tenantId || scope.tenantId,
              reservationId: updated.id,
              action: 'UPDATE',
              actorUserId: actorUserId || null,
              fromStatus: reservation.status,
              toStatus: updated.status,
              reason: 'Planner scenario applied',
              metadata: JSON.stringify({
                source: 'smart-planner',
                scenarioId,
                actionType: action.actionType,
                previousVehicleId: reservation.vehicleId || null,
                nextVehicleId: null
              })
            }
          });
          results.push(updated);
          continue;
        }

        if (!action.vehicleId) throw new Error('vehicleId is required for planner block action');
        const blockType = action.actionType === 'CREATE_MAINTENANCE_BLOCK' ? 'MAINTENANCE_HOLD' : 'WASH_HOLD';
        const recommendationType = action.actionType === 'CREATE_MAINTENANCE_BLOCK' ? 'MAINTENANCE_SLOT' : 'WASH_SLOT';
        const { vehicle, blockedFrom, availableFrom } = await ensureVehicleAvailableForBlock(tx, action.vehicleId, action.payload || {}, scope);
        const createdBlock = await tx.vehicleAvailabilityBlock.create({
          data: {
            tenantId: vehicle.tenantId || scope.tenantId,
            vehicleId: vehicle.id,
            blockType,
            blockedFrom,
            availableFrom,
            reason: action.payload?.reason ? String(action.payload.reason).slice(0, 255) : (action.actionType === 'CREATE_MAINTENANCE_BLOCK' ? 'Planned maintenance' : 'Planned wash buffer'),
            notes: action.payload?.notes ? String(action.payload.notes) : null,
            sourceType: action.payload?.sourceType ? String(action.payload.sourceType).trim().toUpperCase() : 'SMART_PLANNER'
          },
          select: {
            id: true,
            vehicleId: true,
            blockType: true,
            blockedFrom: true,
            availableFrom: true
          }
        });
        await tx.plannerRecommendationAudit.create({
          data: {
            tenantId: vehicle.tenantId || scope.tenantId,
            scenarioId,
            recommendationType,
            vehicleId: vehicle.id,
            title: `${action.actionType === 'CREATE_MAINTENANCE_BLOCK' ? 'Applied maintenance slot' : 'Applied wash buffer'} for ${vehicle.internalNumber || vehicle.id}`,
            detail: action.payload?.reason ? String(action.payload.reason) : null,
            recommendationJson: JSON.stringify({
              source: 'smart-planner',
              scenarioId,
              actionType: action.actionType,
              vehicleId: vehicle.id,
              blockId: createdBlock.id,
              blockedFrom: createdBlock.blockedFrom,
              availableFrom: createdBlock.availableFrom
            }),
            applied: true,
            appliedByUserId: actorUserId || null,
            appliedAt: new Date()
          }
        });
        results.push(createdBlock);
        } catch (error) {
          const message = String(error?.message || '');
          if (RECOVERABLE_PATTERNS.test(message)) {
            skipped.push({
              reservationId: action.reservationId || null,
              vehicleId: action.vehicleId || null,
              actionType: action.actionType,
              reason: message
            });
            continue;
          }
          throw error;
        }
      }

      // Only mark the scenario as APPLIED if we actually applied at least one
      // action. If every action was skipped (e.g. the scenario was so stale that
      // every reservation got checked out), leave the scenario open so the user
      // can re-simulate and try again.
      if (results.length > 0) {
        await tx.plannerScenario.update({
          where: { id: scenarioId },
          data: {
            status: 'APPLIED'
          }
        });
      }

      return results;
    });

    return {
      applied: true,
      appliedCount: applied.length,
      skippedCount: skipped.length,
      skipped,
      scenarioId,
      reservations: applied
    };
  }
};
