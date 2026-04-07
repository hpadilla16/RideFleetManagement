'use client';

import { useMemo } from 'react';
import {
  buildItemsByTrack,
  buildLockedReservationIds,
  buildPlannerFocusItems,
  buildPlannerFocusOptions,
  buildPlannerFocusSummary,
  buildPlannerOpsBoard,
  buildTrackRows,
  buildVehicleTracks,
  filterPlannerVehicles
} from './planner-board-helpers.mjs';

export function usePlannerBoard({
  reservations,
  vehicles,
  filterVehicleTypeId,
  filterLocationId,
  rangeStart,
  rangeEnd,
  dayCount,
  overbookedReservationIds,
  plannerMaintenancePlan,
  plannerWashPlan,
  plannerFocus
}) {
  const lockedReservationIds = useMemo(() => buildLockedReservationIds(reservations), [reservations]);

  const filteredVehicles = useMemo(
    () => filterPlannerVehicles(vehicles, filterVehicleTypeId, filterLocationId),
    [vehicles, filterVehicleTypeId, filterLocationId]
  );

  const vehicleTracks = useMemo(() => buildVehicleTracks(filteredVehicles), [filteredVehicles]);

  const trackRows = useMemo(() => buildTrackRows(vehicleTracks), [vehicleTracks]);

  const itemsByTrack = useMemo(
    () => buildItemsByTrack({ vehicleTracks, reservations, vehicles, rangeStart, rangeEnd, dayCount }),
    [vehicleTracks, reservations, vehicles, rangeStart, rangeEnd, dayCount]
  );

  const plannerOpsBoard = useMemo(
    () => buildPlannerOpsBoard({
      reservations,
      vehicles,
      lockedReservationIds,
      overbookedReservationIds,
      plannerMaintenancePlan,
      plannerWashPlan
    }),
    [reservations, vehicles, lockedReservationIds, overbookedReservationIds, plannerMaintenancePlan, plannerWashPlan]
  );

  const plannerFocusOptions = useMemo(() => buildPlannerFocusOptions(plannerOpsBoard), [plannerOpsBoard]);

  const plannerFocusSummary = useMemo(() => buildPlannerFocusSummary(plannerFocus), [plannerFocus]);

  const plannerFocusItems = useMemo(() => buildPlannerFocusItems(plannerFocus, plannerOpsBoard), [plannerFocus, plannerOpsBoard]);

  return {
    lockedReservationIds,
    vehicleTracks,
    trackRows,
    itemsByTrack,
    plannerOpsBoard,
    plannerFocusOptions,
    plannerFocusSummary,
    plannerFocusItems
  };
}
