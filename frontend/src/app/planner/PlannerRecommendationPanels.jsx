'use client';

import Link from 'next/link';

export function PlannerRecommendationPanels({
  plannerMaintenancePlan,
  plannerWashPlan,
  plannerScenario,
  plannerRunning,
  applyMaintenancePlan,
  applyWashPlan,
  applyPlannerScenario
}) {
  return (
    <>
      {plannerMaintenancePlan ? (
        <section className="glass card" style={{ marginBottom: 12 }}>
          <div className="row-between" style={{ alignItems: 'flex-start', gap: 12 }}>
            <div>
              <div className="section-title" style={{ fontSize: 16 }}>Maintenance Recommendations</div>
              <div className="ui-muted">
                Scenario {plannerMaintenancePlan.scenarioId || 'n/a'} | {plannerMaintenancePlan.recommendations?.length || 0} slot suggestion(s) | {plannerMaintenancePlan.unresolved?.length || 0} unresolved | Queue: {plannerMaintenancePlan.maintenanceQueueCount || 0}
              </div>
            </div>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              {plannerMaintenancePlan.actions?.length ? (
                <button type="button" onClick={applyMaintenancePlan} disabled={plannerRunning === 'apply' || plannerRunning === 'assign' || plannerRunning === 'clear' || plannerRunning === 'maintenance' || plannerRunning === 'wash'}>
                  {plannerRunning === 'maintenance' ? 'Applying...' : 'Apply Maintenance Slots'}
                </button>
              ) : null}
              <span className="status-chip neutral">Simulation Only</span>
            </div>
          </div>
          {plannerMaintenancePlan.recommendations?.length ? (
            <div className="app-card-grid compact" style={{ marginTop: 12 }}>
              {plannerMaintenancePlan.recommendations.map((item) => (
                <section key={`${item.vehicleId}-${item.start}`} className="glass card section-card">
                  <div className="section-title" style={{ fontSize: 15 }}>{item.internalNumber || item.vehicleId}</div>
                  <div className="ui-muted">{item.maintenanceTitle} | Score {item.impactScore}</div>
                  <div className="surface-note">
                    {new Date(item.start).toLocaleString()} - {new Date(item.end).toLocaleString()} | Idle window {item.idleWindowMinutes} min
                  </div>
                  <div className="ui-muted">{Array.isArray(item.reasons) ? item.reasons.join(' | ') : ''}</div>
                </section>
              ))}
            </div>
          ) : null}
          {plannerMaintenancePlan.unresolved?.length ? (
            <div className="stack" style={{ marginTop: 12 }}>
              {plannerMaintenancePlan.unresolved.map((item) => (
                <div key={`${item.vehicleId}-${item.maintenanceJobId || 'open'}`} className="surface-note" style={{ background: '#fff7ed', borderColor: '#fed7aa', color: '#9a3412' }}>
                  {item.internalNumber || item.vehicleId} | {item.maintenanceTitle} | {item.reason}
                </div>
              ))}
            </div>
          ) : null}
        </section>
      ) : null}
      {plannerWashPlan ? (
        <section className="glass card" style={{ marginBottom: 12 }}>
          <div className="row-between" style={{ alignItems: 'flex-start', gap: 12 }}>
            <div>
              <div className="section-title" style={{ fontSize: 16 }}>Wash Buffer Recommendations</div>
              <div className="ui-muted">
                Scenario {plannerWashPlan.scenarioId || 'n/a'} | {plannerWashPlan.slots?.length || 0} slot suggestion(s) | {plannerWashPlan.violations?.length || 0} risk(s)
              </div>
            </div>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              {plannerWashPlan.actions?.length ? (
                <button type="button" onClick={applyWashPlan} disabled={plannerRunning === 'apply' || plannerRunning === 'assign' || plannerRunning === 'clear' || plannerRunning === 'maintenance' || plannerRunning === 'wash'}>
                  {plannerRunning === 'wash' ? 'Applying...' : 'Apply Wash Buffers'}
                </button>
              ) : null}
              <span className="status-chip neutral">Simulation Only</span>
            </div>
          </div>
          {plannerWashPlan.slots?.length ? (
            <div className="app-card-grid compact" style={{ marginTop: 12 }}>
              {plannerWashPlan.slots.map((item) => (
                <section key={`${item.vehicleId}-${item.currentReservationId}-${item.nextReservationId}`} className="glass card section-card">
                  <div className="section-title" style={{ fontSize: 15 }}>{item.internalNumber || item.vehicleId}</div>
                  <div className="ui-muted">{item.currentReservationNumber} {'->'} {item.nextReservationNumber} | {item.status}</div>
                  <div className="surface-note">
                    Wash {new Date(item.start).toLocaleString()} - {new Date(item.end).toLocaleString()} | Slack {item.slackMinutes} min
                  </div>
                  <div className="ui-muted">{Array.isArray(item.reasons) ? item.reasons.join(' | ') : ''}</div>
                </section>
              ))}
            </div>
          ) : null}
          {plannerWashPlan.violations?.length ? (
            <div className="stack" style={{ marginTop: 12 }}>
              {plannerWashPlan.violations.map((item) => (
                <div key={`${item.vehicleId}-${item.currentReservationId}-${item.nextReservationId}`} className="surface-note" style={{ background: '#fef2f2', borderColor: '#fecaca', color: '#991b1b' }}>
                  {item.internalNumber || item.vehicleId} | {item.currentReservationNumber} {'->'} {item.nextReservationNumber} | Gap {item.gapMinutes} min / Need {item.requiredMinutes} min
                </div>
              ))}
            </div>
          ) : null}
        </section>
      ) : null}
      {plannerScenario ? (
        <section className="glass card" style={{ marginBottom: 12 }}>
          <div className="row-between" style={{ alignItems: 'flex-start', gap: 12 }}>
            <div>
              <div className="section-title" style={{ fontSize: 16 }}>Smart Planner Recommendations</div>
              <div className="ui-muted">
                Scenario {plannerScenario.scenarioId} | {plannerScenario.summary?.assigned || 0} suggested assignment(s) | {plannerScenario.summary?.unresolved || 0} unresolved | Cars needed: {plannerScenario.summary?.carsNeeded || 0}
              </div>
            </div>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              {plannerScenario.actions?.length ? (
                <button type="button" onClick={applyPlannerScenario} disabled={plannerRunning === 'apply' || plannerRunning === 'assign' || plannerRunning === 'clear' || plannerRunning === 'maintenance' || plannerRunning === 'wash'}>
                  {plannerRunning === 'apply' ? 'Applying...' : 'Apply Suggested Assignments'}
                </button>
              ) : null}
              <span className="status-chip neutral">Simulation Only</span>
            </div>
          </div>
          {plannerScenario.actions?.length ? (
            <div className="app-card-grid compact" style={{ marginTop: 12 }}>
              {plannerScenario.actions.map((action) => (
                <section key={`${action.reservationId}-${action.vehicleId}`} className="glass card section-card">
                  <div className="section-title" style={{ fontSize: 15 }}>Assign {action.reservationId}</div>
                  <div className="ui-muted">Vehicle {action.vehicleId} | Score {action.score}</div>
                  <div className="surface-note">{Array.isArray(action.reasons) ? action.reasons.join(' | ') : 'Best fit under current planner rules.'}</div>
                  <div className="inline-actions">
                    <Link href={`/reservations/${action.reservationId}`}><button type="button" className="button-subtle">Open Reservation</button></Link>
                  </div>
                </section>
              ))}
            </div>
          ) : null}
          {plannerScenario.unresolved?.length ? (
            <div className="stack" style={{ marginTop: 12 }}>
              {plannerScenario.unresolved.map((item) => (
                <div key={item.reservationId} className="surface-note" style={{ background: '#fef2f2', borderColor: '#fecaca', color: '#991b1b' }}>
                  {item.reservationNumber || item.reservationId} | {item.reason}
                </div>
              ))}
            </div>
          ) : null}
        </section>
      ) : null}
    </>
  );
}

