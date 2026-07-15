'use client';

import { useEffect, useState } from 'react';
import { api } from '../../lib/client';
import { buildPlannerQuery } from './planner-utils.mjs';

const EMPTY_SHORTAGE = { totalCarsNeeded: 0, byDate: [], byVehicleType: [], byLocation: [] };

export function usePlannerData({
  token,
  activeTenantId,
  isSuper,
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
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [reservations, setReservations] = useState([]);
  const [vehicles, setVehicles] = useState([]);
  const [tracks, setTracks] = useState([]);
  const [counters, setCounters] = useState({});
  const [unassignedReservations, setUnassignedReservations] = useState([]);
  const [vehicleTypes, setVehicleTypes] = useState([]);
  const [locations, setLocations] = useState([]);
  const [overbookedReservationIds, setOverbookedReservationIds] = useState([]);
  const [plannerRules, setPlannerRules] = useState(null);
  const [plannerShortage, setPlannerShortage] = useState(EMPTY_SHORTAGE);

  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      if (isSuper && !activeTenantId) {
        setLoading(false);
        setLoadError('');
        setReservations([]);
        setVehicles([]);
        setTracks([]);
        setCounters({});
        setUnassignedReservations([]);
        setVehicleTypes([]);
        setLocations([]);
        setOverbookedReservationIds([]);
        setPlannerRules(null);
        setPlannerShortage(EMPTY_SHORTAGE);
        setPlannerCopilotConfig(createPlannerCopilotConfig());
        return;
      }

      setLoading(true);
      const scopedPath = (path) => {
        if (!isSuper || !activeTenantId) return path;
        const joiner = path.includes('?') ? '&' : '?';
        return `${path}${joiner}tenantId=${encodeURIComponent(activeTenantId)}`;
      };
      const snapshotPath = buildPlannerQuery(rangeStart, rangeEnd, filterLocationId, filterVehicleTypeId, activeTenantId);
      const [snapshotResult, rulesResult, copilotConfigResult, vehicleTypesResult, locationsResult] = await Promise.allSettled([
        api(snapshotPath, { bypassCache: true }, token),
        api(scopedPath('/api/planner/rules'), { bypassCache: true }, token),
        api(scopedPath('/api/planner/copilot-config'), { bypassCache: true }, token),
        canManagePlannerSetup ? api(scopedPath('/api/vehicle-types'), {}, token) : Promise.resolve([]),
        canManagePlannerSetup ? api(scopedPath('/api/locations'), {}, token) : Promise.resolve([])
      ]);

      if (cancelled) return;

      if (snapshotResult.status === 'fulfilled') {
        const snapshot = snapshotResult.value || {};
        setReservations(snapshot.reservations || []);
        setVehicles(snapshot.vehicles || []);
        setTracks(Array.isArray(snapshot.tracks) ? snapshot.tracks : []);
        setCounters(snapshot.counters || {});
        setUnassignedReservations(Array.isArray(snapshot.unassignedReservations)
          ? snapshot.unassignedReservations
          : (snapshot.reservations || []).filter((row) => !row.vehicleId));
        setOverbookedReservationIds((snapshot.overbookedReservations || []).map((row) => row.id));
        setPlannerShortage(snapshot.shortage || EMPTY_SHORTAGE);
        setLoadError('');
      } else {
        setReservations([]);
        setVehicles([]);
        setTracks([]);
        setCounters({});
        setUnassignedReservations([]);
        setOverbookedReservationIds([]);
        setPlannerShortage(EMPTY_SHORTAGE);
        setLoadError(snapshotResult.reason?.message || 'Unable to load planner');
      }

      if (rulesResult.status === 'fulfilled') setPlannerRules(rulesResult.value || null);
      else setPlannerRules(null);

      if (copilotConfigResult.status === 'fulfilled') setPlannerCopilotConfig(createPlannerCopilotConfig(copilotConfigResult.value));
      else setPlannerCopilotConfig(createPlannerCopilotConfig());

      if (vehicleTypesResult.status === 'fulfilled') setVehicleTypes(vehicleTypesResult.value || []);
      else setVehicleTypes([]);

      if (locationsResult.status === 'fulfilled') setLocations(locationsResult.value || []);
      else setLocations([]);

      setLoading(false);

      if (snapshotResult.status === 'fulfilled' && (
        rulesResult.status === 'rejected'
        || copilotConfigResult.status === 'rejected'
        || (canManagePlannerSetup && [vehicleTypesResult, locationsResult].some((row) => row.status === 'rejected'))
      )) {
        onMessage?.('Planner loaded with limited supporting data');
      }
    };

    load();
    return () => {
      cancelled = true;
    };
  }, [
    token,
    activeTenantId,
    isSuper,
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
    loading,
    loadError,
    reservations,
    setReservations,
    vehicles,
    setVehicles,
    tracks,
    setTracks,
    counters,
    setCounters,
    unassignedReservations,
    setUnassignedReservations,
    vehicleTypes,
    locations,
    overbookedReservationIds,
    setOverbookedReservationIds,
    plannerRules,
    setPlannerRules,
    plannerShortage,
    setPlannerShortage
  };
}
