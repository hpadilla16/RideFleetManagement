'use client';

import Link from 'next/link';

export function PlannerOpsBoard({
  plannerFocusSummary,
  plannerOpsBoard,
  plannerFocusOptions,
  plannerFocus,
  setPlannerFocus,
  plannerFocusItems,
  vehicles,
  plannerShortage,
  plannerRecommendationSummary
}) {
  return (
    <section className="glass card-lg section-card" style={{ marginBottom: 16 }}>
      <div className="app-banner">
        <div className="row-between" style={{ alignItems: 'start', marginBottom: 0 }}>
          <div>
            <span className="eyebrow">Planner Ops Board</span>
            <h2 className="page-title" style={{ marginTop: 6 }}>
              Keep the yard balanced before you drop into the timeline.
            </h2>
            <p className="ui-muted">{plannerFocusSummary}</p>
          </div>
          <span className="status-chip neutral">Planner Hub</span>
        </div>
        <div className="app-card-grid compact">
          <div className="info-tile">
            <span className="label">Pickups Today</span>
            <strong>{plannerOpsBoard.pickupsToday}</strong>
            <span className="ui-muted">Reservations scheduled to leave today.</span>
          </div>
          <div className="info-tile">
            <span className="label">Returns Today</span>
            <strong>{plannerOpsBoard.returnsToday}</strong>
            <span className="ui-muted">Bookings expected back today.</span>
          </div>
          <div className="info-tile">
            <span className="label">Checked Out</span>
            <strong>{plannerOpsBoard.checkedOut}</strong>
            <span className="ui-muted">Bookings currently out and locked by agreement.</span>
          </div>
          <div className="info-tile">
            <span className="label">Migration Holds</span>
            <strong>{plannerOpsBoard.migrationHolds}</strong>
            <span className="ui-muted">Vehicles blocked until legacy contracts are expected back.</span>
          </div>
          <div className="info-tile">
            <span className="label">Service Holds</span>
            <strong>{plannerOpsBoard.serviceHolds}</strong>
            <span className="ui-muted">Maintenance and out-of-service windows on the board.</span>
          </div>
          <div className="info-tile">
            <span className="label">Wash Holds</span>
            <strong>{plannerOpsBoard.washHolds}</strong>
            <span className="ui-muted">Temporary wash and turnaround buffers already blocking units.</span>
          </div>
          <div className="info-tile">
            <span className="label">Turn-Ready Attention</span>
            <strong>{plannerOpsBoard.turnReadyAttention}</strong>
            <span className="ui-muted">Units with readiness friction before their next clean turn.</span>
          </div>
          <div className="info-tile">
            <span className="label">Turn-Ready Blocked</span>
            <strong>{plannerOpsBoard.turnReadyBlocked}</strong>
            <span className="ui-muted">Units currently blocked by damage, maintenance, or active dispatch blockers.</span>
          </div>
          <div className="info-tile">
            <span className="label">Inspection Attention</span>
            <strong>{plannerOpsBoard.inspectionAttention}</strong>
            <span className="ui-muted">Units whose latest inspection still has damage, flags, or missing photo coverage.</span>
          </div>
          <div className="info-tile">
            <span className="label">Damage Triage</span>
            <strong>{(vehicles || []).filter((vehicle) => ['MEDIUM', 'HIGH'].includes(String(vehicle?.operationalSignals?.inspection?.damageTriage?.severity || '').toUpperCase())).length}</strong>
            <span className="ui-muted">Units whose latest inspection suggests medium or high damage review before the next turn.</span>
          </div>
          <div className="info-tile">
            <span className="label">Telematics Attention</span>
            <strong>{plannerOpsBoard.telematicsAttention}</strong>
            <span className="ui-muted">Vehicles with stale or missing telematics signal even though they are on the board.</span>
          </div>
          <div className="info-tile">
            <span className="label">Low Fuel</span>
            <strong>{(vehicles || []).filter((vehicle) => ['LOW', 'CRITICAL'].includes(String(vehicle?.operationalSignals?.telematics?.fuelStatus || '').toUpperCase())).length}</strong>
            <span className="ui-muted">Units whose live telematics fuel reading may create dispatch friction.</span>
          </div>
          <div className="info-tile">
            <span className="label">GPS Missing</span>
            <strong>{(vehicles || []).filter((vehicle) => String(vehicle?.operationalSignals?.telematics?.gpsStatus || '').toUpperCase() === 'MISSING').length}</strong>
            <span className="ui-muted">Units whose latest telematics update did not report coordinates.</span>
          </div>
          <div className="info-tile">
            <span className="label">Unassigned</span>
            <strong>{plannerOpsBoard.unassigned}</strong>
            <span className="ui-muted">Reservations still waiting for a vehicle track.</span>
          </div>
          <div className="info-tile">
            <span className="label">Overbooked</span>
            <strong>{plannerOpsBoard.overbooked}</strong>
            <span className="ui-muted">Unassigned bookings that still do not fit after auto-accommodate.</span>
          </div>
          <div className="info-tile">
            <span className="label">Cars Needed</span>
            <strong>{plannerShortage.totalCarsNeeded || 0}</strong>
            <span className="ui-muted">Extra units needed to cover the peak shortage in this visible range.</span>
          </div>
          <div className="info-tile">
            <span className="label">Suggested Fits</span>
            <strong>{plannerRecommendationSummary.assignmentRecommendations || 0}</strong>
            <span className="ui-muted">Smart Planner recommendations currently available for this visible range.</span>
          </div>
          <div className="info-tile">
            <span className="label">Maintenance Slots</span>
            <strong>{plannerOpsBoard.maintenanceRecommendations || 0}</strong>
            <span className="ui-muted">Visible-range service windows the planner can currently recommend.</span>
          </div>
          <div className="info-tile">
            <span className="label">Wash Risks</span>
            <strong>{plannerOpsBoard.washViolations || 0}</strong>
            <span className="ui-muted">Turnaround gaps that do not currently satisfy wash and prep rules.</span>
          </div>
        </div>
        {plannerFocusOptions.length ? (
          <div className="app-banner-list">
            {plannerFocusOptions.map((option) => (
              <button
                key={option.id}
                type="button"
                className={plannerFocus === option.id ? '' : 'button-subtle'}
                onClick={() => setPlannerFocus(option.id)}
                style={{ minHeight: 36, paddingInline: 14 }}
              >
                {option.label} | {option.count}
              </button>
            ))}
          </div>
        ) : null}
        {plannerFocusItems.length ? (
          <div className="app-card-grid compact">
            {plannerFocusItems.map((item) => (
              <section key={item.id} className="glass card section-card">
                <div className="section-title" style={{ fontSize: 15 }}>{item.title}</div>
                <div className="ui-muted">{item.detail}</div>
                <div className="surface-note">{item.note}</div>
                <div className="inline-actions">
                  <Link href={item.href}><button type="button">{item.actionLabel}</button></Link>
                </div>
              </section>
            ))}
          </div>
        ) : plannerOpsBoard.nextItems.length ? (
          <div className="surface-note">No bookings match this planner focus right now. Switch filters to review another lane.</div>
        ) : null}
      </div>
    </section>
  );
}

