'use client';

import { useEffect, useState } from 'react';
import { api } from '../../lib/client';
import { buildPlannerQuery } from './planner-utils.mjs';

const EMPTY_SHORTAGE = { totalCarsNeeded: 0, byDate: [], byVehicleType: [], byLocation: [] };
const EMPTY_RECOMMENDATION_SUMMARY = { assignmentRecommendations: 0, fleetShortageAlerts: 0 };

export function usePlannerData({
  token,
  canManagePlannerSetup,
  rangeStart,
  rangeEnd,
  filterLocationId,
  filterVehicleTypeId,
  plannerReloadKey,
  setPlannerCopilotConfig,
  createPlannerCopilotConfig,
  onMessage
}) {
  const [reservations, setReservations] = useState([]);
  const [vehicles, setVehicles] = useState([]);
  const [vehicleTypes, setVehicleTypes] = useState([]);
  const [locations, setLocations] = useState([]);
  const [overbookedReservationIds, setOverbookedReservationIds] = useState([]);
  const [plannerRules, setPlannerRules] = useState(null);
  const [plannerShortage, setPlannerShortage] = useState(EMPTY_SHORTAGE);
  const [plannerRecommendationSummary, setPlannerRecommendationSummary] = useState(EMPTY_RECOMMENDATION_SUMMARY);

  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      const snapshotPath = buildPlannerQuery(rangeStart, rangeEnd, filterLocationId, filterVehicleTypeId);
      const [snapshotResult, rulesResult, copilotConfigResult, vehicleTypesResult, locationsResult] = await Promise.allSettled([
        api(snapshotPath, { bypassCache: true }, token),
        api('/api/planner/rules', { bypassCache: true }, token),
        api('/api/planner/copilot-config', { bypassCache: true }, token),
        canManagePlannerSetup ? api('/api/vehicle-types', {}, token) : Promise.resolve([]),
        canManagePlannerSetup ? api('/api/locations', {}, token) : Promise.resolve([])
      ]);

      if (cancelled) return;

      if (snapshotResult.status === 'fulfilled') {
        setReservations(snapshotResult.value?.reservations || []);
        setVehicles(snapshotResult.value?.vehicles || []);
        setOverbookedReservationIds((snapshotResult.value?.overbookedReservations || []).map((row) => row.id));
        setPlannerShortage(snapshotResult.value?.shortage || EMPTY_SHORTAGE);
        setPlannerRecommendationSummary(snapshotResult.value?.recommendationSummary || EMPTY_RECOMMENDATION_SUMMARY);
      } else {
        setReservations([]);
        setVehicles([]);
        setOverbookedReservationIds([]);
        setPlannerShortage(EMPTY_SHORTAGE);
        setPlannerRecommendationSummary(EMPTY_RECOMMENDATION_SUMMARY);
      }

      if (rulesResult.status === 'fulfilled') setPlannerRules(rulesResult.value || null);
      else setPlannerRules(null);

      if (copilotConfigResult.status === 'fulfilled') setPlannerCopilotConfig(createPlannerCopilotConfig(copilotConfigResult.value));
      else setPlannerCopilotConfig(createPlannerCopilotConfig());

      if (vehicleTypesResult.status === 'fulfilled') setVehicleTypes(vehicleTypesResult.value || []);
      else setVehicleTypes([]);

      if (locationsResult.status === 'fulfilled') setLocations(locationsResult.value || []);
      else setLocations([]);

      if (snapshotResult.status === 'rejected') {
        onMessage?.(snapshotResult.reason?.message || 'Unable to load planner');
      } else if (
        rulesResult.status === 'rejected'
        || copilotConfigResult.status === 'rejected'
        || (canManagePlannerSetup && [vehicleTypesResult, locationsResult].some((row) => row.status === 'rejected'))
      ) {
        onMessage?.('Planner loaded with limited supporting data');
      } else {
        onMessage?.('');
      }
    };

    load();
    return () => {
      cancelled = true;
    };
  }, [
    token,
    canManagePlannerSetup,
    rangeStart,
    rangeEnd,
    filterLocationId,
    filterVehicleTypeId,
    plannerReloadKey,
    setPlannerCopilotConfig,
    createPlannerCopilotConfig,
    onMessage
  ]);

  return {
    reservations,
    setReservations,
    vehicles,
    setVehicles,
    vehicleTypes,
    locations,
    overbookedReservationIds,
    setOverbookedReservationIds,
    plannerRules,
    setPlannerRules,
    plannerShortage,
    setPlannerShortage,
    plannerRecommendationSummary
  };
}
