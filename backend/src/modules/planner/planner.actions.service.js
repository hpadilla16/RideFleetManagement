import { prisma } from '../../lib/prisma.js';
import { activeVehicleBlockOverlapWhere } from '../vehicles/vehicle-blocks.js';

function tenantWhere(scope = {}) {
  if (scope?.tenantId) return { tenantId: scope.tenantId };
  return scope?.allowCrossTenant ? undefined : { tenantId: '__never__' };
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
      pickupAt: true,
      returnAt: true
    }
  });
  if (!reservation) throw new Error('Reservation not found');
  return reservation;
}

async function ensureVehicleAvailableForReservation(tx, vehicleId, reservation, scope = {}) {
  const vehicle = await tx.vehicle.findFirst({
    where: {
      id: vehicleId,
      ...(tenantWhere(scope) || {})
    },
    select: {
      id: true,
      internalNumber: true,
      status: true
    }
  });
  if (!vehicle) throw new Error('Vehicle not found');
  if (['IN_MAINTENANCE', 'OUT_OF_SERVICE'].includes(String(vehicle.status || '').toUpperCase())) {
    throw new Error(`Vehicle ${vehicle.internalNumber || vehicle.id} is not available for assignment`);
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
    throw new Error(`Vehicle conflict with reservation ${conflictingReservation.reservationNumber}`);
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
    throw new Error(`Vehicle has an active ${String(conflictingBlock.blockType || '').toLowerCase()} during this reservation window`);
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

    const applied = await prisma.$transaction(async (tx) => {
      const results = [];
      for (const action of scenarioActions.sort((left, right) => left.sortOrder - right.sortOrder)) {
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
      }

      await tx.plannerScenario.update({
        where: { id: scenarioId },
        data: {
          status: 'APPLIED'
        }
      });

      return results;
    });

    return {
      applied: true,
      appliedCount: applied.length,
      scenarioId,
      reservations: applied
    };
  }
};
