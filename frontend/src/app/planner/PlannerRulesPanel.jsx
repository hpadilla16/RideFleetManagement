'use client';

export function PlannerRulesPanel({
  canManagePlannerSetup,
  savePlannerRules,
  plannerRulesSaving,
  plannerRunning,
  plannerRulesForm,
  handlePlannerRuleValueChange,
  handlePlannerRuleToggle
}) {
  if (!canManagePlannerSetup) return null;

  return (
    <section className="glass card" style={{ marginBottom: 12 }}>
      <div className="row-between" style={{ alignItems: 'flex-start', gap: 12 }}>
        <div>
          <div className="section-title" style={{ fontSize: 16 }}>Planner Rules</div>
          <div className="ui-muted">
            Set the tenant rules Smart Planner should respect before recommending or applying assignments.
          </div>
        </div>
        <span className="status-chip neutral">Tenant Scoped</span>
      </div>
      <form onSubmit={savePlannerRules} className="stack" style={{ marginTop: 12, gap: 12 }}>
        <div className="app-card-grid compact">
          <div className="stack">
            <label className="label">Turnaround Minutes</label>
            <input
              type="number"
              min="0"
              value={plannerRulesForm.minTurnaroundMinutes}
              onChange={(e) => handlePlannerRuleValueChange('minTurnaroundMinutes', e.target.value)}
            />
          </div>
          <div className="stack">
            <label className="label">Wash Buffer Minutes</label>
            <input
              type="number"
              min="0"
              value={plannerRulesForm.washBufferMinutes}
              onChange={(e) => handlePlannerRuleValueChange('washBufferMinutes', e.target.value)}
            />
          </div>
          <div className="stack">
            <label className="label">Prep Buffer Minutes</label>
            <input
              type="number"
              min="0"
              value={plannerRulesForm.prepBufferMinutes}
              onChange={(e) => handlePlannerRuleValueChange('prepBufferMinutes', e.target.value)}
            />
          </div>
          <div className="stack">
            <label className="label">Maintenance Buffer Minutes</label>
            <input
              type="number"
              min="0"
              value={plannerRulesForm.maintenanceBufferMinutes}
              onChange={(e) => handlePlannerRuleValueChange('maintenanceBufferMinutes', e.target.value)}
            />
          </div>
          <div className="stack">
            <label className="label">Lock Window Before Pickup</label>
            <input
              type="number"
              min="0"
              value={plannerRulesForm.lockWindowMinutesBeforePickup}
              onChange={(e) => handlePlannerRuleValueChange('lockWindowMinutesBeforePickup', e.target.value)}
            />
          </div>
          <div className="stack">
            <label className="label">Same-Day Buffer Minutes</label>
            <input
              type="number"
              min="0"
              value={plannerRulesForm.sameDayReservationBufferMinutes}
              onChange={(e) => handlePlannerRuleValueChange('sameDayReservationBufferMinutes', e.target.value)}
            />
          </div>
          <div className="stack">
            <label className="label">Assignment Mode</label>
            <select value={plannerRulesForm.assignmentMode} onChange={(e) => handlePlannerRuleValueChange('assignmentMode', e.target.value)}>
              <option value="STRICT">Strict</option>
              <option value="FLEXIBLE">Flexible</option>
            </select>
          </div>
          <div className="stack">
            <label className="label">Maintenance Mode</label>
            <select value={plannerRulesForm.maintenanceMode} onChange={(e) => handlePlannerRuleValueChange('maintenanceMode', e.target.value)}>
              <option value="STRICT">Strict</option>
              <option value="FLEXIBLE">Flexible</option>
            </select>
          </div>
        </div>
        <div className="app-card-grid compact">
          <label className="label"><input type="checkbox" checked={plannerRulesForm.allowCrossLocationReassignment} onChange={(e) => handlePlannerRuleToggle('allowCrossLocationReassignment', e.target.checked)} /> Allow cross-location reassignment</label>
          <label className="label"><input type="checkbox" checked={plannerRulesForm.strictVehicleTypeMatch} onChange={(e) => handlePlannerRuleToggle('strictVehicleTypeMatch', e.target.checked)} /> Require exact vehicle type match</label>
          <label className="label"><input type="checkbox" checked={plannerRulesForm.allowUpgrade} onChange={(e) => handlePlannerRuleToggle('allowUpgrade', e.target.checked)} /> Allow upgrades</label>
          <label className="label"><input type="checkbox" checked={plannerRulesForm.allowDowngrade} onChange={(e) => handlePlannerRuleToggle('allowDowngrade', e.target.checked)} /> Allow downgrades</label>
          <label className="label"><input type="checkbox" checked={plannerRulesForm.defaultWashRequired} onChange={(e) => handlePlannerRuleToggle('defaultWashRequired', e.target.checked)} /> Require wash by default</label>
        </div>
        <div className="surface-note">
          These rules immediately affect Smart Planner simulation, shortage math, and assignment recommendations for this tenant.
        </div>
        <div className="inline-actions">
          <button type="submit" disabled={plannerRulesSaving || plannerRunning === 'assign' || plannerRunning === 'apply' || plannerRunning === 'maintenance' || plannerRunning === 'wash'}>
            {plannerRulesSaving ? 'Saving Rules...' : 'Save Planner Rules'}
          </button>
        </div>
      </form>
    </section>
  );
}

