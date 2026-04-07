'use client';

export function PlannerToolbar({
  isSuper,
  tenantRows,
  activeTenantId,
  setActiveTenantId,
  vehicleTypes,
  filterVehicleTypeId,
  setFilterVehicleTypeId,
  locations,
  filterLocationId,
  setFilterLocationId,
  view,
  setView,
  clearVisibleAssignments,
  autoAssignUnassignedReservations,
  simulateMaintenancePlan,
  simulateWashPlan,
  goToday,
  goPrev,
  goNext,
  rangeStart,
  rangeEnd,
  fmtDay,
  plannerRunning,
  msg,
  plannerRules
}) {
  const actionsBusy = plannerRunning === 'assign' || plannerRunning === 'clear' || plannerRunning === 'apply' || plannerRunning === 'maintenance' || plannerRunning === 'wash';

  return (
    <>
      <div className="row-between" style={{ alignItems: 'flex-end', flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', gap: 10, alignItems: 'flex-end', flexWrap: 'wrap' }}>
          <h2>Daily Planner</h2>
          {isSuper ? (
            <div className="stack" style={{ minWidth: 260 }}>
              <label className="label">Tenant</label>
              <select value={activeTenantId} onChange={(e) => setActiveTenantId(e.target.value)}>
                <option value="">Select tenant</option>
                {tenantRows.map((tenant) => (
                  <option key={tenant.id} value={tenant.id}>
                    {tenant.name}{tenant.slug ? ` (${tenant.slug})` : ''}
                  </option>
                ))}
              </select>
            </div>
          ) : null}
          <div className="stack" style={{ minWidth: 180 }}>
            <label className="label">Vehicle Type</label>
            <select value={filterVehicleTypeId} onChange={(e) => setFilterVehicleTypeId(e.target.value)}>
              <option value="">All</option>
              {vehicleTypes.map((vt) => <option key={vt.id} value={vt.id}>{vt.name}</option>)}
            </select>
          </div>
          <div className="stack" style={{ minWidth: 180 }}>
            <label className="label">Location</label>
            <select value={filterLocationId} onChange={(e) => setFilterLocationId(e.target.value)}>
              <option value="">All</option>
              {locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
            </select>
          </div>
          <div className="stack" style={{ minWidth: 130 }}>
            <label className="label">View</label>
            <select value={view} onChange={(e) => setView(e.target.value)}>
              <option value="DAY">Day</option>
              <option value="WEEK">Week</option>
              <option value="MONTH">Month</option>
            </select>
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <button type="button" className="button-subtle" onClick={clearVisibleAssignments} disabled={actionsBusy}>
            {plannerRunning === 'clear' ? 'Moving...' : 'Move To Unassigned'}
          </button>
          <button type="button" onClick={autoAssignUnassignedReservations} disabled={actionsBusy}>
            {plannerRunning === 'assign' ? 'Auto-Placing...' : 'Auto-Accommodate'}
          </button>
          <button type="button" className="button-subtle" onClick={simulateMaintenancePlan} disabled={actionsBusy}>
            {plannerRunning === 'maintenance' ? 'Planning Maintenance...' : 'Plan Maintenance'}
          </button>
          <button type="button" className="button-subtle" onClick={simulateWashPlan} disabled={actionsBusy}>
            {plannerRunning === 'wash' ? 'Planning Wash...' : 'Plan Wash Buffers'}
          </button>
          <button onClick={goToday}>Today</button>
          <button onClick={goPrev}>Previous</button>
          <div className="label" style={{ minWidth: 180, textAlign: 'center' }}>{fmtDay(rangeStart)} - {fmtDay(new Date(rangeEnd.getTime() - 24 * 60 * 60 * 1000))}</div>
          <button onClick={goNext}>Next</button>
        </div>
      </div>

      {msg ? <p className="label">{msg}</p> : null}
      {isSuper && !activeTenantId ? (
        <div className="surface-note" style={{ marginBottom: 12 }}>
          Select a tenant to load planner reservations, vehicles, and Smart Planner actions.
        </div>
      ) : null}
      <div className="app-banner-list" style={{ marginBottom: 12 }}>
        <span className="app-banner-pill">Green = Confirmed</span>
        <span className="app-banner-pill">Blue = New</span>
        <span className="app-banner-pill">Purple = Checked Out</span>
        <span className="app-banner-pill">Gray = Migration Hold</span>
        <span className="app-banner-pill">Orange = Maintenance</span>
        <span className="app-banner-pill">Teal = Wash Buffer</span>
        <span className="app-banner-pill">Red = Out Of Service</span>
        <span className="app-banner-pill" style={{ background: '#fee2e2', color: '#991b1b', borderColor: '#fecaca' }}>Bright Red = Overbooked</span>
      </div>
      {plannerRules ? (
        <div className="surface-note" style={{ marginBottom: 12 }}>
          Smart Planner rules active: turnaround {plannerRules.minTurnaroundMinutes} min, wash {plannerRules.washBufferMinutes} min, prep {plannerRules.prepBufferMinutes} min, lock window {plannerRules.lockWindowMinutesBeforePickup} min before pickup.
        </div>
      ) : null}
    </>
  );
}

