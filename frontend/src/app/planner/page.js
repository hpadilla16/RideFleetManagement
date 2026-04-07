'use client';

import { useEffect, useMemo, useState } from 'react';
import { AuthGate } from '../../components/AuthGate';
import { AppShell } from '../../components/AppShell';
import { api } from '../../lib/client';
import {
  DAY_WIDTH,
  addDays,
  createPlannerCopilotConfig,
  createPlannerRulesForm,
  fmtDay,
  startOfDay,
} from './planner-utils.mjs';
import { PlannerBlockSidepanel } from './PlannerBlockSidepanel.jsx';
import { PlannerCopilotPanel } from './PlannerCopilotPanel.jsx';
import { PlannerHoldModal } from './PlannerHoldModal.jsx';
import { PlannerOpsBoard } from './PlannerOpsBoard.jsx';
import { PlannerRecommendationPanels } from './PlannerRecommendationPanels.jsx';
import { PlannerReservationSidepanel } from './PlannerReservationSidepanel.jsx';
import { PlannerRulesPanel } from './PlannerRulesPanel.jsx';
import { PlannerTrackRow } from './PlannerTrackRow.jsx';
import { PlannerToolbar } from './PlannerToolbar.jsx';
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
import { usePlannerActions } from './usePlannerActions.js';
import { usePlannerData } from './usePlannerData.js';
import { usePlannerPanels } from './usePlannerPanels.js';

export default function PlannerPage() {
  return <AuthGate>{({ token, me, logout }) => <PlannerInner token={token} me={me} logout={logout} />}</AuthGate>;
}

function PlannerInner({ token, me, logout }) {
  const role = String(me?.role || '').toUpperCase().trim();
  const isSuper = role === 'SUPER_ADMIN';
  const canManagePlannerSetup = ['SUPER_ADMIN', 'ADMIN', 'OPS'].includes(role);
  const [msg, setMsg] = useState('');
  const [view, setView] = useState('MONTH');
  const [cursor, setCursor] = useState(startOfDay(new Date()));
  const [filterVehicleTypeId, setFilterVehicleTypeId] = useState('');
  const [filterLocationId, setFilterLocationId] = useState('');
  const [dragItem, setDragItem] = useState(null);
  const [dragMeta, setDragMeta] = useState(null);
  const [draggingId, setDraggingId] = useState('');
  const [plannerFocus, setPlannerFocus] = useState('ALL');
  const [plannerReloadKey, setPlannerReloadKey] = useState(0);
  const [plannerRulesForm, setPlannerRulesForm] = useState(() => createPlannerRulesForm());
  const [plannerRulesSaving, setPlannerRulesSaving] = useState(false);
  const [tenantRows, setTenantRows] = useState([]);
  const [activeTenantId, setActiveTenantId] = useState('');

  const dayCount = view === 'DAY' ? 1 : view === 'WEEK' ? 7 : 30;
  const rangeStart = useMemo(() => startOfDay(cursor), [cursor]);
  const rangeEnd = useMemo(() => addDays(rangeStart, dayCount), [rangeStart, dayCount]);
  const reloadPlannerSnapshot = () => setPlannerReloadKey((current) => current + 1);
  const [plannerCopilotConfigBootstrap, setPlannerCopilotConfigBootstrap] = useState(() => createPlannerCopilotConfig());
  const {
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
  } = usePlannerData({
    token,
    activeTenantId,
    isSuper,
    canManagePlannerSetup,
    rangeStart,
    rangeEnd,
    filterLocationId,
    filterVehicleTypeId,
    plannerReloadKey,
    setPlannerCopilotConfig: setPlannerCopilotConfigBootstrap,
    createPlannerCopilotConfig,
    onMessage: setMsg
  });
  const {
    selectedReservation,
    selectedBlock,
    showBlockVehicle,
    selectedVehicleForBlock,
    blockForm,
    setBlockForm,
    selectReservation,
    selectBlock,
    closeSelectedReservation,
    closeSelectedBlock,
    closeBlockVehicle,
    syncUpdatedReservation,
    openBlockVehicle,
    saveVehicleBlock,
    releaseVehicleBlock
  } = usePlannerPanels({
    token,
    setVehicles,
    onMessage: setMsg
  });

  const replaceReservationInState = (updatedReservation) => {
    if (!updatedReservation?.id) return;
    setReservations((current) => current.map((row) => (
      row.id === updatedReservation.id
        ? { ...row, ...updatedReservation }
        : row
    )));
    setOverbookedReservationIds((current) => (
      updatedReservation?.vehicleId
        ? current.filter((id) => id !== updatedReservation.id)
        : current
    ));
    syncUpdatedReservation(updatedReservation);
  };

  const handlePlannerRuleValueChange = (key, value) => {
    setPlannerRulesForm((current) => ({
      ...current,
      [key]: value
    }));
  };

  const handlePlannerRuleToggle = (key, checked) => {
    setPlannerRulesForm((current) => ({
      ...current,
      [key]: checked
    }));
  };

  const savePlannerRules = async (event) => {
    event.preventDefault();
    if (!canManagePlannerSetup) return;

    setPlannerRulesSaving(true);
    try {
      const payload = {
        minTurnaroundMinutes: Number.parseInt(plannerRulesForm.minTurnaroundMinutes || '0', 10),
        washBufferMinutes: Number.parseInt(plannerRulesForm.washBufferMinutes || '0', 10),
        prepBufferMinutes: Number.parseInt(plannerRulesForm.prepBufferMinutes || '0', 10),
        maintenanceBufferMinutes: Number.parseInt(plannerRulesForm.maintenanceBufferMinutes || '0', 10),
        lockWindowMinutesBeforePickup: Number.parseInt(plannerRulesForm.lockWindowMinutesBeforePickup || '0', 10),
        sameDayReservationBufferMinutes: Number.parseInt(plannerRulesForm.sameDayReservationBufferMinutes || '0', 10),
        allowCrossLocationReassignment: !!plannerRulesForm.allowCrossLocationReassignment,
        strictVehicleTypeMatch: !!plannerRulesForm.strictVehicleTypeMatch,
        allowUpgrade: !!plannerRulesForm.allowUpgrade,
        allowDowngrade: !!plannerRulesForm.allowDowngrade,
        defaultWashRequired: !!plannerRulesForm.defaultWashRequired,
        assignmentMode: plannerRulesForm.assignmentMode,
        maintenanceMode: plannerRulesForm.maintenanceMode
      };
      const rulePath = isSuper && activeTenantId
        ? `/api/planner/rules?tenantId=${encodeURIComponent(activeTenantId)}`
        : '/api/planner/rules';
      const saved = await api(rulePath, {
        method: 'PUT',
        body: JSON.stringify({
          ...payload,
          ...(isSuper && activeTenantId ? { tenantId: activeTenantId } : {})
        })
      }, token);
      setPlannerRules(saved || null);
      resetPlannerInsights();
      reloadPlannerSnapshot();
      setMsg('Smart Planner rules updated.');
    } catch (error) {
      setMsg(error.message || 'Unable to save Smart Planner rules');
    } finally {
      setPlannerRulesSaving(false);
    }
  };

  const lockedReservationIds = useMemo(
    () => buildLockedReservationIds(reservations),
    [reservations]
  );
  const filteredVehicles = useMemo(
    () => filterPlannerVehicles(vehicles, filterVehicleTypeId, filterLocationId),
    [vehicles, filterVehicleTypeId, filterLocationId]
  );
  const vehicleTracks = useMemo(
    () => buildVehicleTracks(filteredVehicles),
    [filteredVehicles]
  );
  const trackRows = useMemo(
    () => buildTrackRows(vehicleTracks),
    [vehicleTracks]
  );
  const itemsByTrack = useMemo(
    () => buildItemsByTrack({
      vehicleTracks,
      reservations,
      vehicles,
      rangeStart,
      rangeEnd,
      dayCount
    }),
    [vehicleTracks, reservations, vehicles, rangeStart, rangeEnd, dayCount]
  );

  const {
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
  } = usePlannerActions({
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
  });

  useEffect(() => {
    if (!isSuper) return;
    api('/api/tenants', {}, token)
      .then((rows) => {
        const nextRows = Array.isArray(rows) ? rows : [];
        setTenantRows(nextRows);
        if (!activeTenantId && nextRows[0]?.id) setActiveTenantId(nextRows[0].id);
      })
      .catch((error) => setMsg(error.message || 'Unable to load tenants for planner'));
  }, [token, isSuper, activeTenantId]);

  const plannerOpsBoard = useMemo(
    () => buildPlannerOpsBoard({
      reservations,
      vehicles,
      lockedReservationIds,
      overbookedReservationIds,
      plannerMaintenancePlan,
      plannerWashPlan
    }),
    [
      reservations,
      vehicles,
      lockedReservationIds,
      overbookedReservationIds,
      plannerMaintenancePlan,
      plannerWashPlan
    ]
  );
  const plannerFocusOptions = useMemo(
    () => buildPlannerFocusOptions(plannerOpsBoard),
    [plannerOpsBoard]
  );
  const plannerFocusSummary = useMemo(
    () => buildPlannerFocusSummary(plannerFocus),
    [plannerFocus]
  );
  const plannerFocusItems = useMemo(
    () => buildPlannerFocusItems(plannerFocus, plannerOpsBoard),
    [plannerFocus, plannerOpsBoard]
  );

  useEffect(() => {
    resetPlannerInsights();
  }, [cursor, view, filterVehicleTypeId, filterLocationId, resetPlannerInsights]);

  useEffect(() => {
    setPlannerRulesForm(createPlannerRulesForm(plannerRules));
  }, [plannerRules]);

  useEffect(() => {
    setPlannerCopilotConfig(plannerCopilotConfigBootstrap);
  }, [plannerCopilotConfigBootstrap, setPlannerCopilotConfig]);

  const handleTouchDrop = (ev) => {
    if (!dragItem) return;
    const touch = ev.changedTouches?.[0];
    if (!touch) return;
    const el = document.elementFromPoint(touch.clientX, touch.clientY);
    const cell = el?.closest?.('[data-drop-cell="1"]');
    if (!cell) {
      setDragItem(null);
      setDraggingId('');
      return;
    }
    const rect = cell.getBoundingClientRect();
    onDropReservation(cell.getAttribute('data-track-id'), cell.getAttribute('data-day-index'), {
      pointerOffsetWithinCellPx: touch.clientX - rect.left
    });
  };

  const handleDragReservationStart = (reservation, event) => {
    const rect = event.currentTarget.getBoundingClientRect();
    setDragItem(reservation);
    setDragMeta({ grabOffsetPx: Math.max(0, event.clientX - rect.left) });
    setDraggingId(reservation.id);
  };

  const handleDragReservationEnd = () => {
    setDragItem(null);
    setDragMeta(null);
    setDraggingId('');
  };

  const handleTouchReservationStart = (reservation, event) => {
    const touch = event.touches?.[0];
    const rect = event.currentTarget.getBoundingClientRect();
    setDragItem(reservation);
    setDragMeta({ grabOffsetPx: touch ? Math.max(0, touch.clientX - rect.left) : 0 });
    setDraggingId(reservation.id);
  };

  const goPrev = () => setCursor((d) => addDays(d, -dayCount));
  const goNext = () => setCursor((d) => addDays(d, dayCount));
  const goToday = () => setCursor(startOfDay(new Date()));

  return (
    <AppShell me={me} logout={logout}>
      <PlannerOpsBoard
        plannerFocusSummary={plannerFocusSummary}
        plannerOpsBoard={plannerOpsBoard}
        plannerFocusOptions={plannerFocusOptions}
        plannerFocus={plannerFocus}
        setPlannerFocus={setPlannerFocus}
        plannerFocusItems={plannerFocusItems}
        vehicles={vehicles}
        plannerShortage={plannerShortage}
        plannerRecommendationSummary={plannerRecommendationSummary}
      />
      <section className="glass card-lg planner-wrap">
        <PlannerToolbar
          isSuper={isSuper}
          tenantRows={tenantRows}
          activeTenantId={activeTenantId}
          setActiveTenantId={setActiveTenantId}
          vehicleTypes={vehicleTypes}
          filterVehicleTypeId={filterVehicleTypeId}
          setFilterVehicleTypeId={setFilterVehicleTypeId}
          locations={locations}
          filterLocationId={filterLocationId}
          setFilterLocationId={setFilterLocationId}
          view={view}
          setView={setView}
          clearVisibleAssignments={clearVisibleAssignments}
          autoAssignUnassignedReservations={autoAssignUnassignedReservations}
          simulateMaintenancePlan={simulateMaintenancePlan}
          simulateWashPlan={simulateWashPlan}
          goToday={goToday}
          goPrev={goPrev}
          goNext={goNext}
          rangeStart={rangeStart}
          rangeEnd={rangeEnd}
          fmtDay={fmtDay}
          plannerRunning={plannerRunning}
          msg={msg}
          plannerRules={plannerRules}
        />
        <PlannerCopilotPanel
          plannerCopilotConfig={plannerCopilotConfig}
          plannerCopilot={plannerCopilot}
          plannerCopilotQuestion={plannerCopilotQuestion}
          setPlannerCopilotQuestion={setPlannerCopilotQuestion}
          askPlannerCopilot={askPlannerCopilot}
          plannerRunning={plannerRunning}
        />
        <PlannerRulesPanel
          canManagePlannerSetup={canManagePlannerSetup}
          savePlannerRules={savePlannerRules}
          plannerRulesSaving={plannerRulesSaving}
          plannerRunning={plannerRunning}
          plannerRulesForm={plannerRulesForm}
          handlePlannerRuleValueChange={handlePlannerRuleValueChange}
          handlePlannerRuleToggle={handlePlannerRuleToggle}
        />
        <PlannerRecommendationPanels
          plannerMaintenancePlan={plannerMaintenancePlan}
          plannerWashPlan={plannerWashPlan}
          plannerScenario={plannerScenario}
          plannerRunning={plannerRunning}
          applyMaintenancePlan={applyMaintenancePlan}
          applyWashPlan={applyWashPlan}
          applyPlannerScenario={applyPlannerScenario}
        />

        <div className="planner-scroll">
          <div className="planner-head" style={{ gridTemplateColumns: `260px repeat(${dayCount}, ${DAY_WIDTH}px)` }}>
            <div className="planner-cell planner-sticky">Vehicle Track</div>
            {Array.from({ length: dayCount }).map((_, i) => {
              const d = addDays(rangeStart, i);
              return <div key={i} className="planner-cell">{new Date(d).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric' })}</div>;
            })}
          </div>

          {trackRows.map((row) => {
            if (row.kind === 'group') {
              return (
                <div key={row.id} className="planner-row" style={{ gridTemplateColumns: `260px repeat(${dayCount}, ${DAY_WIDTH}px)` }}>
                  <div
                    className="planner-cell planner-sticky planner-track-meta"
                    style={{ minHeight: 54, justifyContent: 'center', background: 'linear-gradient(180deg, #faf7ff, #f4efff)' }}
                  >
                    <div style={{ fontWeight: 800 }}>{row.label}</div>
                    <div className="label">{row.code || 'Vehicle section'}</div>
                  </div>
                  <div
                    className="planner-cell"
                    style={{
                      gridColumn: `2 / span ${dayCount}`,
                      minHeight: 54,
                      display: 'flex',
                      alignItems: 'center',
                      paddingInline: 14,
                      background: 'linear-gradient(180deg, #faf7ff, #f7f4ff)',
                      fontWeight: 700,
                      color: '#5b4aa3'
                    }}
                  >
                    {row.count} vehicle{row.count === 1 ? '' : 's'}
                  </div>
                </div>
              );
            }

            const v = row.vehicle;
            const trackLayout = itemsByTrack.get(v.id) || { items: [], lanes: 1 };
            const rows = trackLayout.items;
            const laneCount = Math.max(1, trackLayout.lanes || 1);
            const maxRowHeight = 170;
            const lanePitch = laneCount <= 2 ? 30 : Math.max(14, Math.floor((maxRowHeight - 12) / laneCount));
            const blockHeight = Math.max(10, lanePitch - 6);
            const rowHeight = Math.max(64, Math.min(maxRowHeight, laneCount * lanePitch + 12));
          return (
            <PlannerTrackRow
              key={v.id}
              vehicle={v}
              trackLayout={trackLayout}
              dayCount={dayCount}
              dayWidth={DAY_WIDTH}
              plannerOverbookedCount={plannerOpsBoard.overbooked}
              lockedReservationIds={lockedReservationIds}
              overbookedReservationIds={overbookedReservationIds}
              draggingId={draggingId}
              onDropReservation={onDropReservation}
              onDragReservationStart={handleDragReservationStart}
              onDragReservationEnd={handleDragReservationEnd}
              onTouchReservationStart={handleTouchReservationStart}
              onTouchDrop={handleTouchDrop}
              onSelectReservation={selectReservation}
              onSelectBlock={selectBlock}
              onOpenBlockVehicle={openBlockVehicle}
              onReleaseVehicleBlock={releaseVehicleBlock}
            />
          );
        })}
      </div>
      </section>

      <PlannerReservationSidepanel
        selectedReservation={selectedReservation}
        vehicles={vehicles}
        onClose={closeSelectedReservation}
      />
      <PlannerBlockSidepanel
        selectedBlock={selectedBlock}
        onClose={closeSelectedBlock}
        onReleaseVehicleBlock={releaseVehicleBlock}
        onOpenBlockVehicle={openBlockVehicle}
      />
      <PlannerHoldModal
        showBlockVehicle={showBlockVehicle}
        selectedVehicleForBlock={selectedVehicleForBlock}
        blockForm={blockForm}
        setBlockForm={setBlockForm}
        saveVehicleBlock={saveVehicleBlock}
        onClose={closeBlockVehicle}
      />
    </AppShell>
  );
}
