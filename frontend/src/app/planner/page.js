'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AuthGate } from '../../components/AuthGate';
import { AppShell } from '../../components/AppShell';
import { api } from '../../lib/client';
import {
  DAY_MS,
  addDays,
  createPlannerCopilotConfig,
  createPlannerRulesForm,
  startOfDay,
} from './planner-utils.mjs';
import { PlannerBlockSidepanel } from './PlannerBlockSidepanel.jsx';
import { PlannerBoard } from './PlannerBoard.jsx';
import { PlannerCopilotPanel } from './PlannerCopilotPanel.jsx';
import { PlannerDock } from './PlannerDock.jsx';
import { PlannerHeader } from './PlannerHeader.jsx';
import { PlannerHoldModal } from './PlannerHoldModal.jsx';
import { PlannerRecommendationPanels } from './PlannerRecommendationPanels.jsx';
import { PlannerRulesPanel } from './PlannerRulesPanel.jsx';
import { PlannerSlideOver } from './PlannerSlideOver.jsx';
import { PlannerSuggestPanel } from './PlannerSuggestPanel.jsx';
import { PlannerToolbar } from './PlannerToolbar.jsx';
import {
  adjustCountersForAssignment,
  applyAssignmentToTracks,
  buildBoardRows,
  buildKpiPills,
  buildLockedReservationIds,
  computeDragLegality,
  ghostPositionForReservation
} from './planner-board-helpers.mjs';
import { usePlannerActions } from './usePlannerActions.js';
import { usePlannerData } from './usePlannerData.js';
import { usePlannerPanels } from './usePlannerPanels.js';

const COL_WIDTH_BY_VIEW = { DAY: 860, WEEK: 148, MONTH: 66 };

export default function PlannerPage() {
  return <AuthGate>{({ token, me, logout }) => <PlannerInner token={token} me={me} logout={logout} />}</AuthGate>;
}

function PlannerInner({ token, me, logout }) {
  const { t } = useTranslation();
  const role = String(me?.role || '').toUpperCase().trim();
  const isSuper = role === 'SUPER_ADMIN';
  const canManagePlannerSetup = ['SUPER_ADMIN', 'ADMIN', 'OPS'].includes(role);

  const [view, setView] = useState('WEEK');
  const [cursor, setCursor] = useState(startOfDay(new Date()));
  const [filterVehicleTypeId, setFilterVehicleTypeId] = useState('');
  const [filterLocationId, setFilterLocationId] = useState('');
  const [search, setSearch] = useState('');
  const [dockExpanded, setDockExpanded] = useState(false);
  const [highlightOverbooked, setHighlightOverbooked] = useState(false);
  const [openPanel, setOpenPanel] = useState('');
  const [dragItem, setDragItem] = useState(null);
  const [plannerReloadKey, setPlannerReloadKey] = useState(0);
  const [plannerRulesForm, setPlannerRulesForm] = useState(() => createPlannerRulesForm());
  const [plannerRulesSaving, setPlannerRulesSaving] = useState(false);
  const [tenantRows, setTenantRows] = useState([]);
  const [activeTenantId, setActiveTenantId] = useState('');
  const [toast, setToast] = useState(null);
  const toastTimerRef = useRef(null);

  const dayCount = view === 'DAY' ? 1 : view === 'WEEK' ? 7 : 30;
  const colWidth = COL_WIDTH_BY_VIEW[view] || COL_WIDTH_BY_VIEW.MONTH;
  const rangeStart = useMemo(() => startOfDay(cursor), [cursor]);
  const rangeEnd = useMemo(() => addDays(rangeStart, dayCount), [rangeStart, dayCount]);
  const todayIndex = Math.floor((startOfDay(new Date()).getTime() - rangeStart.getTime()) / DAY_MS);
  const reloadPlannerSnapshot = useCallback(() => setPlannerReloadKey((current) => current + 1), []);
  const [plannerCopilotConfigBootstrap, setPlannerCopilotConfigBootstrap] = useState(() => createPlannerCopilotConfig());

  const showToast = useCallback(({ text, kind = 'info', ttlMs = 6000, action = null }) => {
    if (!text) return;
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    setToast({ id: Date.now(), text, kind, action });
    toastTimerRef.current = setTimeout(() => setToast(null), ttlMs);
  }, []);
  useEffect(() => () => {
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
  }, []);
  const setMsg = useCallback((text) => {
    if (text) showToast({ text });
  }, [showToast]);

  const {
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

  const lockedReservationIds = useMemo(
    () => buildLockedReservationIds(reservations),
    [reservations]
  );

  // Optimistic local assignment — keeps snapshot-driven state (tracks, dock,
  // counters, reservation list, open panels) coherent without a refetch.
  const applyAssignmentLocally = useCallback((reservation, vehicleId) => {
    const previousVehicleId = reservation.vehicleId || null;
    const nextVehicleId = vehicleId || null;
    const updated = { ...reservation, vehicleId: nextVehicleId };
    setTracks((current) => applyAssignmentToTracks({ tracks: current, reservation: updated, vehicleId: nextVehicleId, rangeStart }));
    setUnassignedReservations((current) => {
      const without = (current || []).filter((row) => row.id !== reservation.id);
      return nextVehicleId ? without : [...without, updated];
    });
    setCounters((current) => adjustCountersForAssignment(current, previousVehicleId, nextVehicleId));
    setReservations((current) => current.map((row) => (row.id === reservation.id ? { ...row, vehicleId: nextVehicleId } : row)));
    setOverbookedReservationIds((current) => (nextVehicleId ? current.filter((id) => id !== reservation.id) : current));
    syncUpdatedReservation(updated);
  }, [rangeStart, setTracks, setUnassignedReservations, setCounters, setReservations, setOverbookedReservationIds, syncUpdatedReservation]);

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
  } = usePlannerActions({
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
  }, [token, isSuper, activeTenantId, setMsg]);

  useEffect(() => {
    resetPlannerInsights();
  }, [cursor, view, filterVehicleTypeId, filterLocationId, resetPlannerInsights]);

  useEffect(() => {
    setPlannerRulesForm(createPlannerRulesForm(plannerRules));
  }, [plannerRules]);

  useEffect(() => {
    setPlannerCopilotConfig(plannerCopilotConfigBootstrap);
  }, [plannerCopilotConfigBootstrap, setPlannerCopilotConfig]);

  // ------------------------------------------------------------------ rules
  const handlePlannerRuleValueChange = (key, value) => {
    setPlannerRulesForm((current) => ({ ...current, [key]: value }));
  };
  const handlePlannerRuleToggle = (key, checked) => {
    setPlannerRulesForm((current) => ({ ...current, [key]: checked }));
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

  // ------------------------------------------------------------------ board
  const boardRows = useMemo(() => buildBoardRows({ tracks, search }), [tracks, search]);
  const kpis = useMemo(() => buildKpiPills(counters, plannerShortage), [counters, plannerShortage]);
  // Pill label = TODAY's short type straight from the snapshot counter
  // (Innovation 2026-07-14: the old derivation used the range-wide shortage
  // and only when exactly one type was short). Range fallback kept for legacy
  // snapshots that predate counters.shortageToday.
  const shortageTypeLabel = useMemo(() => {
    if (kpis.shortageTodayType) return kpis.shortageTodayType;
    if (kpis.shortageTodayTypeId) {
      const type = vehicleTypes.find((row) => row.id === kpis.shortageTodayTypeId);
      if (type) return type.code || type.name || '';
    }
    const rows = (plannerShortage?.byVehicleType || []).filter((row) => row.carsNeeded > 0);
    if (rows.length !== 1) return '';
    const type = vehicleTypes.find((row) => row.id === rows[0].vehicleTypeId);
    return type?.code || type?.name || '';
  }, [kpis, plannerShortage, vehicleTypes]);

  // Drag preview legality (client-side only — the server re-validates on drop).
  const legalityMap = useMemo(
    () => (dragItem ? computeDragLegality({ reservation: dragItem, tracks, rules: plannerRules }) : null),
    [dragItem, tracks, plannerRules]
  );
  const ghost = useMemo(
    () => (dragItem ? ghostPositionForReservation(dragItem, rangeStart, dayCount) : null),
    [dragItem, rangeStart, dayCount]
  );

  const startDrag = useCallback((reservation, event) => {
    if (event?.dataTransfer) {
      event.dataTransfer.effectAllowed = 'move';
      try { event.dataTransfer.setData('text/plain', reservation.id); } catch {}
    }
    setDragItem(reservation);
  }, []);
  const endDrag = useCallback(() => setDragItem(null), []);

  const handleDropOnVehicle = (vehicleId) => {
    const reservation = dragItem;
    setDragItem(null);
    if (!reservation || !vehicleId) return;
    performAssign(reservation, vehicleId);
  };
  const handleDropToUnassign = () => {
    const reservation = dragItem;
    setDragItem(null);
    if (!reservation?.vehicleId) return;
    performAssign(reservation, null);
  };
  const handleTouchDrop = (event) => {
    if (!dragItem) return;
    const touch = event.changedTouches?.[0];
    if (!touch) {
      setDragItem(null);
      return;
    }
    const element = document.elementFromPoint(touch.clientX, touch.clientY);
    const lane = element?.closest?.('[data-vehicle-id]');
    const dock = element?.closest?.('[data-dock-drop]');
    if (lane) handleDropOnVehicle(lane.getAttribute('data-vehicle-id'));
    else if (dock) handleDropToUnassign();
    else setDragItem(null);
  };

  const handlePillClick = (pillId) => {
    if (pillId === 'unassigned') {
      setDockExpanded((current) => !current);
    } else if (pillId === 'overbooked') {
      setDockExpanded(true);
      setHighlightOverbooked((current) => !current);
    } else if (pillId === 'shortage') {
      const affected = (plannerShortage?.byVehicleType || []).find((row) => row.carsNeeded > 0);
      const typeId = affected?.vehicleTypeId;
      if (typeId && typeId !== 'UNSPECIFIED') {
        setFilterVehicleTypeId((current) => (current === typeId ? '' : typeId));
      }
    } else if (pillId === 'pickups' || pillId === 'returns') {
      setView('DAY');
      setCursor(startOfDay(new Date()));
    }
  };

  const handleAccommodateAll = () => {
    setOpenPanel('recs');
    autoAssignUnassignedReservations();
  };

  const handleAddHold = (vehicle) => {
    const fullVehicle = vehicles.find((row) => row.id === vehicle.id) || vehicle;
    openBlockVehicle(fullVehicle);
  };
  const handleSelectBlock = ({ block, vehicle }) => {
    const fullVehicle = vehicles.find((row) => row.id === vehicle.id) || vehicle;
    selectBlock({ block, vehicle: fullVehicle });
  };
  const handleSaveVehicleBlock = async (event) => {
    await saveVehicleBlock(event);
    reloadPlannerSnapshot();
  };
  const handleReleaseVehicleBlock = async (blockId) => {
    await releaseVehicleBlock(blockId);
    reloadPlannerSnapshot();
  };

  const goPrev = () => setCursor((d) => addDays(d, -dayCount));
  const goNext = () => setCursor((d) => addDays(d, dayCount));
  const goToday = () => setCursor(startOfDay(new Date()));

  const recsBusy = ['assign', 'apply', 'clear', 'maintenance', 'wash'].includes(plannerRunning);

  return (
    <AppShell me={me} logout={logout}>
      <div className="pl-root">
        <PlannerHeader
          kpis={kpis}
          shortageTypeLabel={shortageTypeLabel}
          onPillClick={handlePillClick}
          onOpenRules={() => setOpenPanel('rules')}
          onOpenCopilot={() => setOpenPanel('copilot')}
          onAccommodateAll={handleAccommodateAll}
          canManagePlannerSetup={canManagePlannerSetup}
          plannerRunning={plannerRunning}
        />
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
          goToday={goToday}
          goPrev={goPrev}
          goNext={goNext}
          rangeStart={rangeStart}
          rangeEnd={rangeEnd}
          search={search}
          setSearch={setSearch}
        />
        <PlannerDock
          unassignedReservations={unassignedReservations}
          search={search}
          expanded={dockExpanded}
          setExpanded={setDockExpanded}
          highlightOverbooked={highlightOverbooked}
          overbookedReservationIds={overbookedReservationIds}
          dragItem={dragItem}
          onDragCardStart={startDrag}
          onDragCardEnd={endDrag}
          onTouchCardStart={startDrag}
          onTouchDrop={handleTouchDrop}
          onSelectReservation={selectReservation}
          onDropToUnassign={handleDropToUnassign}
        />
        {isSuper && !activeTenantId ? (
          <div className="pl-state">
            <div className="pl-state-title">{t('planner.selectTenant')}</div>
            <div className="pl-state-body">{t('planner.selectTenantBody')}</div>
          </div>
        ) : loading ? (
          <div className="pl-board-scroll pl-skeleton" aria-hidden="true">
            <div className="pl-skel pl-skel-head" />
            {Array.from({ length: 9 }).map((_, index) => (
              <div key={index} className="pl-skel pl-skel-row" style={{ animationDelay: `${index * 90}ms` }} />
            ))}
          </div>
        ) : loadError ? (
          <div className="pl-state">
            <div className="pl-state-title">{t('planner.errorTitle')}</div>
            <div className="pl-state-body">{loadError}</div>
            <button type="button" className="pl-btn-primary" onClick={reloadPlannerSnapshot}>{t('planner.retry')}</button>
          </div>
        ) : boardRows.length === 0 ? (
          <div className="pl-state">
            <div className="pl-state-title">{t('planner.emptyTitle')}</div>
            <div className="pl-state-body">{search ? t('planner.emptySearchBody') : t('planner.emptyBody')}</div>
          </div>
        ) : (
          <PlannerBoard
            rows={boardRows}
            dayCount={dayCount}
            colWidth={colWidth}
            rangeStart={rangeStart}
            todayIndex={todayIndex}
            dragItem={dragItem}
            legalityMap={legalityMap}
            ghost={ghost}
            turnaroundMinutes={plannerRules?.minTurnaroundMinutes || 0}
            overbookedReservationIds={overbookedReservationIds}
            highlightOverbooked={highlightOverbooked}
            onDropVehicle={handleDropOnVehicle}
            onBarDragStart={startDrag}
            onBarDragEnd={endDrag}
            onBarTouchStart={startDrag}
            onTouchDrop={handleTouchDrop}
            onSelectReservation={selectReservation}
            onSelectBlock={handleSelectBlock}
            onAddHold={handleAddHold}
          />
        )}
      </div>

      <PlannerSuggestPanel
        selected={selectedReservation}
        vehicles={vehicles}
        fetchSuggestions={fetchSuggestions}
        onAssign={performAssign}
        onClose={closeSelectedReservation}
        plannerRunning={plannerRunning}
      />
      <PlannerBlockSidepanel
        selectedBlock={selectedBlock}
        onClose={closeSelectedBlock}
        onReleaseVehicleBlock={handleReleaseVehicleBlock}
        onOpenBlockVehicle={openBlockVehicle}
      />
      <PlannerHoldModal
        showBlockVehicle={showBlockVehicle}
        selectedVehicleForBlock={selectedVehicleForBlock}
        blockForm={blockForm}
        setBlockForm={setBlockForm}
        saveVehicleBlock={handleSaveVehicleBlock}
        onClose={closeBlockVehicle}
      />

      <PlannerSlideOver
        open={openPanel === 'rules'}
        title={t('planner.rules')}
        onClose={() => setOpenPanel('')}
        closeLabel={t('common.close')}
      >
        <PlannerRulesPanel
          canManagePlannerSetup={canManagePlannerSetup}
          savePlannerRules={savePlannerRules}
          plannerRulesSaving={plannerRulesSaving}
          plannerRunning={plannerRunning}
          plannerRulesForm={plannerRulesForm}
          handlePlannerRuleValueChange={handlePlannerRuleValueChange}
          handlePlannerRuleToggle={handlePlannerRuleToggle}
        />
      </PlannerSlideOver>
      <PlannerSlideOver
        open={openPanel === 'copilot'}
        title={t('planner.copilot')}
        onClose={() => setOpenPanel('')}
        closeLabel={t('common.close')}
      >
        <PlannerCopilotPanel
          plannerCopilotConfig={plannerCopilotConfig}
          plannerCopilot={plannerCopilot}
          plannerCopilotQuestion={plannerCopilotQuestion}
          setPlannerCopilotQuestion={setPlannerCopilotQuestion}
          askPlannerCopilot={askPlannerCopilot}
          plannerRunning={plannerRunning}
        />
      </PlannerSlideOver>
      <PlannerSlideOver
        open={openPanel === 'recs'}
        title={t('planner.recommendations')}
        onClose={() => setOpenPanel('')}
        closeLabel={t('common.close')}
      >
        <div className="pl-recs-actions">
          <button type="button" onClick={autoAssignUnassignedReservations} disabled={recsBusy}>
            {plannerRunning === 'assign' ? t('planner.accommodating') : t('planner.accommodateAll')}
          </button>
          <button type="button" className="button-subtle" onClick={() => simulateMaintenancePlan(plannerRules?.maintenanceBufferMinutes || 120)} disabled={recsBusy}>
            {t('planner.planMaintenance')}
          </button>
          <button type="button" className="button-subtle" onClick={simulateWashPlan} disabled={recsBusy}>
            {t('planner.planWash')}
          </button>
          <button type="button" className="button-subtle" onClick={clearVisibleAssignments} disabled={recsBusy}>
            {t('planner.moveAllToUnassigned')}
          </button>
        </div>
        {!plannerScenario && !plannerMaintenancePlan && !plannerWashPlan ? (
          <div className="pl-panel-note">{t('planner.recommendationsEmpty')}</div>
        ) : null}
        <PlannerRecommendationPanels
          plannerMaintenancePlan={plannerMaintenancePlan}
          plannerWashPlan={plannerWashPlan}
          plannerScenario={plannerScenario}
          plannerRunning={plannerRunning}
          applyMaintenancePlan={applyMaintenancePlan}
          applyWashPlan={applyWashPlan}
          applyPlannerScenario={applyPlannerScenario}
        />
      </PlannerSlideOver>

      {toast ? (
        <div className={`pl-toast pl-toast-${toast.kind}`} role="status">
          <span className="pl-toast-text">{toast.text}</span>
          {toast.action ? (
            <button
              type="button"
              className="pl-toast-action"
              onClick={() => {
                if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
                setToast(null);
                toast.action.onClick();
              }}
            >
              {toast.action.label}
            </button>
          ) : null}
          <button
            type="button"
            className="pl-toast-close"
            aria-label={t('common.close')}
            onClick={() => {
              if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
              setToast(null);
            }}
          >
            ×
          </button>
        </div>
      ) : null}
    </AppShell>
  );
}
