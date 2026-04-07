'use client';

import { useCallback, useState } from 'react';
import { api } from '../../lib/client';
import {
  createPlannerCopilotConfig,
} from './planner-utils.mjs';
import {
  buildAutoAssignCandidates,
  buildClearAssignmentCandidates,
  buildDropMovePlan,
  buildPlannerRangePayload,
  buildVehicleClearUpdates
} from './planner-action-helpers.mjs';

export function usePlannerActions({
  token,
  activeTenantId,
  isSuper,
  reservations,
  rangeStart,
  rangeEnd,
  filterLocationId,
  filterVehicleTypeId,
  plannerRules,
  vehicleTracks,
  dragItem,
  dragMeta,
  lockedReservationIds,
  replaceReservationInState,
  reloadPlannerSnapshot,
  setMsg,
  setDragItem,
  setDragMeta,
  setDraggingId,
  setOverbookedReservationIds,
  setPlannerShortage
}) {
  const [plannerRunning, setPlannerRunning] = useState('');
  const [plannerScenario, setPlannerScenario] = useState(null);
  const [plannerMaintenancePlan, setPlannerMaintenancePlan] = useState(null);
  const [plannerWashPlan, setPlannerWashPlan] = useState(null);
  const [plannerCopilotQuestion, setPlannerCopilotQuestion] = useState('What should ops focus on next in this visible planner range?');
  const [plannerCopilot, setPlannerCopilot] = useState(null);
  const [plannerCopilotConfig, setPlannerCopilotConfig] = useState(() => createPlannerCopilotConfig());
  const scopedPath = useCallback((path) => {
    if (!isSuper || !activeTenantId) return path;
    const joiner = path.includes('?') ? '&' : '?';
    return `${path}${joiner}tenantId=${encodeURIComponent(activeTenantId)}`;
  }, [activeTenantId, isSuper]);

  const resetPlannerInsights = useCallback(() => {
    setPlannerScenario(null);
    setPlannerMaintenancePlan(null);
    setPlannerWashPlan(null);
    setPlannerCopilot(null);
  }, []);

  const clearDragState = () => {
    setDragItem(null);
    setDragMeta(null);
    setDraggingId('');
  };

  const onDropReservation = async (trackVehicleId, dayIndexRaw, dropMetrics = null) => {
    if (!dragItem) return;
    const reservation = dragItem;
    if (lockedReservationIds.has(reservation.id)) return;

    const dayIndex = Number(dayIndexRaw);
    if (!Number.isFinite(dayIndex) || dayIndex < 0) return;

    try {
      const movePlan = buildDropMovePlan({
        reservation,
        trackVehicleId,
        dayIndexRaw,
        dropMetrics,
        dragMeta,
        rangeStart,
        vehicleTracks
      });
      if (!movePlan) return;
      const ok = window.confirm(
        `Move reservation ${reservation.reservationNumber}?\n\n` +
        `Pickup: ${movePlan.newPickup.toLocaleString()}\n` +
        `Return: ${movePlan.newReturn.toLocaleString()}\n` +
        `Vehicle: ${movePlan.targetVehicleLabel}`
      );
      if (!ok) {
        setMsg('Move cancelled');
        clearDragState();
        return;
      }

      const updatedReservation = await api(`/api/reservations/${reservation.id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          ...movePlan.patch,
          ...(isSuper && activeTenantId ? { tenantId: activeTenantId } : {})
        })
      }, token);
      replaceReservationInState(updatedReservation);
      setMsg(`Reservation ${reservation.reservationNumber} moved`);
      clearDragState();
    } catch (error) {
      setMsg(error.message);
      clearDragState();
    }
  };

  const reassignReservations = async (updates, successMessage, overbookedIds = []) => {
    if (!updates.length) {
      setOverbookedReservationIds(overbookedIds);
      setMsg(successMessage);
      return;
    }
    for (const update of updates) {
      const updatedReservation = await api(`/api/reservations/${update.id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          ...update.patch,
          ...(isSuper && activeTenantId ? { tenantId: activeTenantId } : {})
        })
      }, token);
      replaceReservationInState(updatedReservation);
    }
    setOverbookedReservationIds(overbookedIds);
    setMsg(successMessage);
  };

  const clearVisibleAssignments = async () => {
    const candidates = buildClearAssignmentCandidates(reservations, rangeStart, rangeEnd);
    if (!candidates.length) {
      setMsg('No movable reservations are currently assigned in this planner range.');
      return;
    }
    const ok = window.confirm(`Move ${candidates.length} reservation(s) back to Unassigned for this visible planner range?`);
    if (!ok) return;
    setPlannerRunning('clear');
    try {
      await reassignReservations(
        buildVehicleClearUpdates(candidates),
        `${candidates.length} reservation(s) moved back to Unassigned.`,
        []
      );
    } catch (error) {
      setMsg(error.message || 'Unable to clear assignments');
    } finally {
      setPlannerRunning('');
    }
  };

  const autoAssignUnassignedReservations = async () => {
    const candidates = buildAutoAssignCandidates(reservations);
    if (!candidates.length) {
      setMsg('No unassigned movable reservations were found in this planner range.');
      setOverbookedReservationIds([]);
      setPlannerScenario(null);
      return;
    }

    setPlannerRunning('assign');
    try {
      const result = await api(scopedPath('/api/planner/simulate-auto-accommodate'), {
        method: 'POST',
        body: JSON.stringify(buildPlannerRangePayload({ rangeStart, rangeEnd, filterLocationId, filterVehicleTypeId, tenantId: activeTenantId }))
      }, token);
      setPlannerScenario(result || null);
      setOverbookedReservationIds((result?.unresolved || []).map((row) => row.reservationId));
      setPlannerShortage((current) => ({
        ...current,
        totalCarsNeeded: result?.summary?.carsNeeded ?? current.totalCarsNeeded
      }));
      if (result?.summary?.assigned > 0) {
        setMsg(
          result.summary.unresolved
            ? `${result.summary.assigned} recommendation(s) ready. ${result.summary.unresolved} still need manual review.`
            : `${result.summary.assigned} recommendation(s) ready for review.`
        );
      } else {
        setMsg('No automatic accommodation could be suggested for this visible planner range.');
      }
    } catch (error) {
      setPlannerScenario(null);
      setMsg(error.message || 'Unable to simulate planner auto-accommodate');
    } finally {
      setPlannerRunning('');
    }
  };

  const applyPlannerScenario = async () => {
    if (!plannerScenario?.scenarioId) return;
    if (!plannerScenario.actions?.length) {
      setMsg('This planner scenario has no suggested assignments to apply.');
      return;
    }

    const ok = window.confirm(
      `Apply ${plannerScenario.actions.length} Smart Planner assignment(s) from scenario ${plannerScenario.scenarioId}?`
    );
    if (!ok) return;

    setPlannerRunning('apply');
    try {
      const result = await api(scopedPath('/api/planner/apply-plan'), {
        method: 'POST',
        body: JSON.stringify({
          scenarioId: plannerScenario.scenarioId,
          ...(isSuper && activeTenantId ? { tenantId: activeTenantId } : {})
        })
      }, token);
      setPlannerScenario(null);
      setOverbookedReservationIds([]);
      reloadPlannerSnapshot();
      setMsg(`${result?.appliedCount || plannerScenario.actions.length} planner assignment(s) applied.`);
    } catch (error) {
      setMsg(error.message || 'Unable to apply planner scenario');
    } finally {
      setPlannerRunning('');
    }
  };

  const simulateMaintenancePlan = async () => {
    setPlannerRunning('maintenance');
    try {
      const result = await api(scopedPath('/api/planner/simulate-maintenance'), {
        method: 'POST',
        body: JSON.stringify(buildPlannerRangePayload({
          rangeStart,
          rangeEnd,
          filterLocationId,
          filterVehicleTypeId,
          tenantId: activeTenantId,
          extra: { durationMinutes: plannerRules?.maintenanceBufferMinutes || 120 }
        }))
      }, token);
      setPlannerMaintenancePlan(result || null);
      if (result?.recommendations?.length) {
        setMsg(`${result.recommendations.length} maintenance slot recommendation(s) ready for review.`);
      } else if (result?.unresolved?.length) {
        setMsg('No maintenance slots fit cleanly in the visible range. Review unresolved vehicles.');
      } else {
        setMsg('No maintenance opportunities were found in the visible range.');
      }
    } catch (error) {
      setPlannerMaintenancePlan(null);
      setMsg(error.message || 'Unable to simulate maintenance planning');
    } finally {
      setPlannerRunning('');
    }
  };

  const simulateWashPlan = async () => {
    setPlannerRunning('wash');
    try {
      const result = await api(scopedPath('/api/planner/simulate-wash-plan'), {
        method: 'POST',
        body: JSON.stringify(buildPlannerRangePayload({ rangeStart, rangeEnd, filterLocationId, filterVehicleTypeId, tenantId: activeTenantId }))
      }, token);
      setPlannerWashPlan(result || null);
      if (result?.violations?.length) {
        setMsg(`${result.violations.length} wash buffer risk(s) need review in the visible range.`);
      } else if (result?.slots?.length) {
        setMsg(`${result.slots.length} wash slot recommendation(s) mapped for the visible range.`);
      } else {
        setMsg('No wash planning issues were found in the visible range.');
      }
    } catch (error) {
      setPlannerWashPlan(null);
      setMsg(error.message || 'Unable to simulate wash planning');
    } finally {
      setPlannerRunning('');
    }
  };

  const applyMaintenancePlan = async () => {
    if (!plannerMaintenancePlan?.scenarioId) return;
    if (!plannerMaintenancePlan.actions?.length) {
      setMsg('This maintenance simulation has no block actions ready to apply.');
      return;
    }

    const ok = window.confirm(
      `Apply ${plannerMaintenancePlan.actions.length} maintenance hold(s) from scenario ${plannerMaintenancePlan.scenarioId}?`
    );
    if (!ok) return;

    setPlannerRunning('maintenance');
    try {
      const result = await api(scopedPath('/api/planner/apply-plan'), {
        method: 'POST',
        body: JSON.stringify({
          scenarioId: plannerMaintenancePlan.scenarioId,
          ...(isSuper && activeTenantId ? { tenantId: activeTenantId } : {})
        })
      }, token);
      setPlannerMaintenancePlan(null);
      reloadPlannerSnapshot();
      setMsg(`${result?.appliedCount || 0} maintenance hold(s) applied.`);
    } catch (error) {
      setMsg(error.message || 'Unable to apply maintenance plan');
    } finally {
      setPlannerRunning('');
    }
  };

  const applyWashPlan = async () => {
    if (!plannerWashPlan?.scenarioId) return;
    if (!plannerWashPlan.actions?.length) {
      setMsg('This wash simulation has no safe wash buffers ready to apply.');
      return;
    }

    const ok = window.confirm(
      `Apply ${plannerWashPlan.actions.length} wash buffer block(s) from scenario ${plannerWashPlan.scenarioId}?`
    );
    if (!ok) return;

    setPlannerRunning('wash');
    try {
      const result = await api(scopedPath('/api/planner/apply-plan'), {
        method: 'POST',
        body: JSON.stringify({
          scenarioId: plannerWashPlan.scenarioId,
          ...(isSuper && activeTenantId ? { tenantId: activeTenantId } : {})
        })
      }, token);
      setPlannerWashPlan(null);
      reloadPlannerSnapshot();
      setMsg(`${result?.appliedCount || 0} wash buffer block(s) applied.`);
    } catch (error) {
      setMsg(error.message || 'Unable to apply wash plan');
    } finally {
      setPlannerRunning('');
    }
  };

  const askPlannerCopilot = async () => {
    if (!plannerCopilotConfig.enabled) {
      setMsg('Planner Copilot is not enabled for this tenant yet.');
      return;
    }
    setPlannerRunning('copilot');
    try {
      const result = await api(scopedPath('/api/planner/copilot'), {
        method: 'POST',
        body: JSON.stringify(buildPlannerRangePayload({
          rangeStart,
          rangeEnd,
          filterLocationId,
          filterVehicleTypeId,
          tenantId: activeTenantId,
          extra: { question: plannerCopilotQuestion }
        }))
      }, token);
      setPlannerCopilot(result || null);
      try {
        const cfg = await api(scopedPath('/api/planner/copilot-config'), { bypassCache: true }, token);
        setPlannerCopilotConfig(createPlannerCopilotConfig(cfg));
      } catch {}
      setMsg(result?.mode === 'AI' ? 'Planner Copilot responded with AI guidance.' : (result?.aiError ? `Planner Copilot fallback used: ${result.aiError}` : 'Planner Copilot generated a heuristic ops brief.'));
    } catch (error) {
      setPlannerCopilot(null);
      try {
        const cfg = await api(scopedPath('/api/planner/copilot-config'), { bypassCache: true }, token);
        setPlannerCopilotConfig(createPlannerCopilotConfig(cfg));
      } catch {}
      setMsg(error.message || 'Unable to load Planner Copilot guidance');
    } finally {
      setPlannerRunning('');
    }
  };

  return {
    plannerRunning,
    plannerScenario,
    plannerMaintenancePlan,
    plannerWashPlan,
    plannerCopilotQuestion,
    plannerCopilot,
    plannerCopilotConfig,
    setPlannerCopilotConfig,
    setPlannerCopilotQuestion,
    resetPlannerInsights,
    onDropReservation,
    clearVisibleAssignments,
    autoAssignUnassignedReservations,
    applyPlannerScenario,
    simulateMaintenancePlan,
    simulateWashPlan,
    applyMaintenancePlan,
    applyWashPlan,
    askPlannerCopilot
  };
}
