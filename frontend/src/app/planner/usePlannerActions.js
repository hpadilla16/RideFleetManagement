'use client';

import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { API_BASE, api, readStoredToken } from '../../lib/client';
import {
  createPlannerCopilotConfig,
} from './planner-utils.mjs';
import {
  buildAutoAssignCandidates,
  buildClearAssignmentCandidates,
  buildPlannerRangePayload
} from './planner-action-helpers.mjs';
import { parseAssignConflict } from './planner-board-helpers.mjs';

export function usePlannerActions({
  token,
  activeTenantId,
  isSuper,
  reservations,
  rangeStart,
  rangeEnd,
  filterLocationId,
  filterVehicleTypeId,
  lockedReservationIds,
  applyAssignmentLocally,
  reloadPlannerSnapshot,
  showToast,
  setMsg,
  setOverbookedReservationIds,
  setPlannerShortage
}) {
  const { t } = useTranslation();
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

  const conflictMessage = useCallback((conflict) => {
    const byCode = {
      OCCUPIED: t('planner.conflictOccupied'),
      TURNAROUND: t('planner.conflictTurnaround'),
      TYPE_MISMATCH: t('planner.conflictTypeMismatch'),
      CROSS_LOCATION: t('planner.conflictCrossLocation'),
      LOCKED_STATUS: t('planner.conflictLockedStatus')
    };
    const base = byCode[conflict.code] || t('planner.assignFailed');
    return conflict.detail ? `${base} — ${conflict.detail}` : base;
  }, [t]);

  // Direct fetch (same auth conventions as api()) because the shared helper
  // folds 409 bodies into a plain message and would drop {code, detail}.
  const callAssign = useCallback(async ({ reservationId, vehicleId, force = false }) => {
    const headers = { 'Content-Type': 'application/json' };
    const authToken = token || readStoredToken();
    if (authToken) headers.Authorization = `Bearer ${authToken}`;
    const res = await fetch(`${API_BASE}${scopedPath('/api/planner/assign')}`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        reservationId,
        vehicleId: vehicleId || null,
        ...(force ? { force: true } : {}),
        ...(isSuper && activeTenantId ? { tenantId: activeTenantId } : {})
      })
    });
    if (res.ok) return res.status === 204 ? null : res.json();
    let body = null;
    try { body = await res.json(); } catch {}
    const error = new Error(body?.error || `/api/planner/assign failed (${res.status})`);
    error.status = res.status;
    error.conflictCode = body?.code || null;
    error.conflictDetail = body?.detail || '';
    throw error;
  }, [scopedPath, isSuper, activeTenantId, token]);

  // Assign (or unassign with vehicleId=null) a reservation to a vehicle.
  // Optimistic: the board updates immediately and reverts on failure.
  const performAssign = useCallback(async (reservation, targetVehicleId, { force = false, silent = false } = {}) => {
    if (!reservation?.id) return false;
    if (lockedReservationIds.has(reservation.id)) {
      showToast({ text: t('planner.lockedReservation'), kind: 'error' });
      return false;
    }
    const previousVehicleId = reservation.vehicleId || null;
    const nextVehicleId = targetVehicleId || null;
    if (previousVehicleId === nextVehicleId && !force) return false;

    applyAssignmentLocally(reservation, nextVehicleId);
    try {
      await callAssign({ reservationId: reservation.id, vehicleId: nextVehicleId, force });
      if (!silent) {
        showToast({
          text: nextVehicleId
            ? t('planner.assignSuccess', { number: reservation.reservationNumber || '' })
            : t('planner.unassignSuccess', { number: reservation.reservationNumber || '' }),
          kind: 'success',
          ttlMs: 10000,
          action: {
            label: t('planner.undo'),
            // force:true only bypasses the strict type-match rule (occupancy and
            // locked-status are still enforced server-side), so restoring the
            // previous placement — which the server had already accepted, possibly
            // via "Force" — cannot get stuck behind its own type rule.
            onClick: () => performAssign({ ...reservation, vehicleId: nextVehicleId }, previousVehicleId, { silent: true, force: true })
          }
        });
      } else {
        showToast({ text: t('planner.undone'), kind: 'success' });
      }
      return true;
    } catch (error) {
      // Revert the optimistic move.
      applyAssignmentLocally({ ...reservation, vehicleId: nextVehicleId }, previousVehicleId);
      const conflict = parseAssignConflict(error);
      // Rule conflicts (never occupancy) are force-bypassable server-side.
      if (conflict.status === 409 && (conflict.code === 'TYPE_MISMATCH' || conflict.code === 'CROSS_LOCATION')) {
        showToast({
          text: conflictMessage(conflict),
          kind: 'error',
          ttlMs: 12000,
          action: {
            label: t('planner.force'),
            onClick: () => performAssign(reservation, nextVehicleId, { force: true })
          }
        });
      } else if (conflict.status === 409 && conflict.code) {
        showToast({ text: conflictMessage(conflict), kind: 'error', ttlMs: 8000 });
      } else {
        showToast({ text: error.message || t('planner.assignFailed'), kind: 'error', ttlMs: 8000 });
      }
      return false;
    }
  }, [lockedReservationIds, applyAssignmentLocally, callAssign, showToast, conflictMessage, t]);

  const fetchSuggestions = useCallback(async (reservationId) => {
    const result = await api(scopedPath('/api/planner/suggest'), {
      method: 'POST',
      body: JSON.stringify({
        reservationId,
        ...(isSuper && activeTenantId ? { tenantId: activeTenantId } : {})
      })
    }, token);
    return Array.isArray(result?.suggestions) ? result.suggestions : [];
  }, [scopedPath, isSuper, activeTenantId, token]);

  const clearVisibleAssignments = async () => {
    const candidates = buildClearAssignmentCandidates(reservations, rangeStart, rangeEnd);
    if (!candidates.length) {
      setMsg(t('planner.nothingToClear'));
      return;
    }
    const ok = window.confirm(t('planner.confirmClear', { count: candidates.length }));
    if (!ok) return;
    setPlannerRunning('clear');
    // Candidates already mirror the backend's assignable statuses, but a row
    // can change state mid-loop (e.g. gets checked out) — skip 409s and keep
    // going instead of aborting the bulk clear partway (QA MAJOR 2026-07-14).
    let cleared = 0;
    let skipped = 0;
    let lastError = null;
    try {
      for (const candidate of candidates) {
        try {
          await callAssign({ reservationId: candidate.id, vehicleId: null });
          cleared += 1;
        } catch (error) {
          const conflict = parseAssignConflict(error);
          if (conflict.status === 409) { skipped += 1; continue; }
          lastError = error;
          break;
        }
      }
      setOverbookedReservationIds([]);
      reloadPlannerSnapshot();
      if (lastError) {
        setMsg(lastError.message || t('planner.assignFailed'));
      } else if (skipped > 0) {
        setMsg(t('planner.clearedPartial', { count: cleared, skipped }));
      } else {
        setMsg(t('planner.clearedCount', { count: cleared }));
      }
    } finally {
      setPlannerRunning('');
    }
  };

  const autoAssignUnassignedReservations = async () => {
    const candidates = buildAutoAssignCandidates(reservations);
    if (!candidates.length) {
      setMsg(t('planner.noUnassignedInRange'));
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
      const appliedCount = result?.appliedCount ?? plannerScenario.actions.length;
      const skippedCount = result?.skippedCount || 0;
      if (skippedCount > 0) {
        // Surface why some actions were skipped — the scenario was generated
        // from a snapshot and the world may have changed (e.g. someone checked
        // out a reservation between simulate and apply).
        const sampleReason = result?.skipped?.[0]?.reason || 'state changed since simulation';
        setMsg(`${appliedCount} planner assignment(s) applied, ${skippedCount} skipped (${sampleReason}${skippedCount > 1 ? ', ...' : ''}). Re-run auto-acomodar to resolve the rest.`);
      } else {
        setMsg(`${appliedCount} planner assignment(s) applied.`);
      }
    } catch (error) {
      setMsg(error.message || 'Unable to apply planner scenario');
    } finally {
      setPlannerRunning('');
    }
  };

  const simulateMaintenancePlan = async (maintenanceBufferMinutes = 120) => {
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
          extra: { durationMinutes: maintenanceBufferMinutes }
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
    performAssign,
    fetchSuggestions,
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
