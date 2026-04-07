'use client';

import Link from 'next/link';

export function PlannerCopilotPanel({
  plannerCopilotConfig,
  plannerCopilot,
  plannerCopilotQuestion,
  setPlannerCopilotQuestion,
  askPlannerCopilot,
  plannerRunning
}) {
  return (
    <section className="glass card" style={{ marginBottom: 12 }}>
      <div className="row-between" style={{ alignItems: 'flex-start', gap: 12 }}>
        <div>
          <div className="section-title" style={{ fontSize: 16 }}>Planner Copilot</div>
          <div className="ui-muted">Ask for dispatch guidance using the visible range, shortage math, inspection intelligence, and telematics health.</div>
        </div>
        <span className={`status-chip ${plannerCopilotConfig.enabled ? (plannerCopilot?.mode === 'AI' ? 'good' : 'neutral') : 'warn'}`}>
          {plannerCopilotConfig.enabled ? (plannerCopilot?.mode === 'AI' ? 'AI' : 'Enabled') : 'Feature Off'}
        </span>
      </div>
      <div className="stack" style={{ marginTop: 12, gap: 10 }}>
        {!plannerCopilotConfig.planDefaults?.plannerCopilotIncluded ? (
          <div className="surface-note">
            Planner Copilot is not included in the {plannerCopilotConfig.tenantPlan} package for this tenant.
          </div>
        ) : !plannerCopilotConfig.enabled ? (
          <div className="surface-note">
            Planner Copilot is off for this tenant. Turn it on in Settings under AI Copilot before agents can use it here.
          </div>
        ) : plannerCopilotConfig.usage?.monthlyCapReached ? (
          <div className="surface-note">
            Planner Copilot reached its monthly query cap for {plannerCopilotConfig.usage?.currentPeriod?.period || 'the current period'}.
            {plannerCopilotConfig.monthlyQueryCap ? ` Used ${plannerCopilotConfig.usage?.currentPeriod?.totalQueries || 0} of ${plannerCopilotConfig.monthlyQueryCap}.` : ''}
          </div>
        ) : plannerCopilotConfig.aiOnlyForPaidPlan && !plannerCopilotConfig.planEligible ? (
          <div className="surface-note">
            This tenant is on plan {plannerCopilotConfig.tenantPlan}. AI responses are restricted by plan policy, so Copilot will stay in heuristic mode until the tenant is upgraded or policy changes.
          </div>
        ) : !plannerCopilotConfig.ready ? (
          <div className="surface-note">
            Planner Copilot is enabled, but AI credentials are not ready yet. It can still fall back to heuristic ops briefs until a tenant API key is saved or global fallback is allowed.
          </div>
        ) : (
          <div className="surface-note">
            AI is ready for this tenant using {plannerCopilotConfig.credentialSource === 'TENANT' ? 'tenant-managed credentials' : 'global fallback credentials'} on model {plannerCopilotConfig.model}.
          </div>
        )}
        {plannerCopilotConfig.enabled ? (
          <div className="surface-note">
            Current period: {plannerCopilotConfig.usage?.currentPeriod?.period || '—'} | Queries used: {plannerCopilotConfig.usage?.currentPeriod?.totalQueries || 0}
            {plannerCopilotConfig.monthlyQueryCap ? ` / ${plannerCopilotConfig.monthlyQueryCap}` : ' / uncapped'}
            {plannerCopilotConfig.usage?.remainingQueries != null ? ` | Remaining: ${plannerCopilotConfig.usage.remainingQueries}` : ''}
          </div>
        ) : null}
        <textarea
          rows={3}
          value={plannerCopilotQuestion}
          onChange={(e) => setPlannerCopilotQuestion(e.target.value)}
          placeholder="Ask what the shift should focus on next..."
          disabled={!plannerCopilotConfig.enabled || !plannerCopilotConfig.planDefaults?.plannerCopilotIncluded}
        />
        <div className="inline-actions">
          <button
            type="button"
            onClick={askPlannerCopilot}
            disabled={!plannerCopilotConfig.enabled || !plannerCopilotConfig.planDefaults?.plannerCopilotIncluded || plannerCopilotConfig.usage?.monthlyCapReached || plannerRunning === 'copilot' || plannerRunning === 'apply' || plannerRunning === 'assign' || plannerRunning === 'maintenance' || plannerRunning === 'wash'}
          >
            {plannerRunning === 'copilot' ? 'Asking Copilot...' : 'Ask Planner Copilot'}
          </button>
        </div>
        {plannerCopilot ? (
          <div className="stack" style={{ gap: 12 }}>
            <div className="surface-note">
              <strong>{plannerCopilot.riskLevel || 'LOW'} Risk</strong> | {plannerCopilot.summary}
            </div>
            {plannerCopilot.alerts?.length ? (
              <div className="app-card-grid compact">
                {plannerCopilot.alerts.map((item) => (
                  <section key={item.id} className="glass card section-card">
                    <div className="section-title" style={{ fontSize: 15 }}>{item.title}</div>
                    <div className="ui-muted">{item.detail}</div>
                    <div className="inline-actions">
                      <span className={`status-chip ${String(item.severity || '').toUpperCase() === 'HIGH' ? 'warn' : 'neutral'}`}>{item.severity || 'LOW'}</span>
                      {item.href ? <Link href={item.href}><button type="button" className="button-subtle">Open</button></Link> : null}
                    </div>
                  </section>
                ))}
              </div>
            ) : null}
            {plannerCopilot.recommendations?.length ? (
              <div className="app-card-grid compact">
                {plannerCopilot.recommendations.map((item) => (
                  <section key={item.id} className="glass card section-card">
                    <div className="section-title" style={{ fontSize: 15 }}>{item.title}</div>
                    <div className="ui-muted">{item.detail}</div>
                    <div className="inline-actions">
                      <span className="hero-pill">{item.actionLabel}</span>
                      {item.href ? <Link href={item.href}><button type="button" className="button-subtle">Open</button></Link> : null}
                    </div>
                  </section>
                ))}
              </div>
            ) : null}
            {plannerCopilot.followUps?.length ? (
              <div className="app-banner-list">
                {plannerCopilot.followUps.map((item) => (
                  <button key={item} type="button" className="button-subtle" onClick={() => setPlannerCopilotQuestion(item)}>
                    {item}
                  </button>
                ))}
              </div>
            ) : null}
            {plannerCopilot.aiError ? (
              <div className="surface-note">AI fallback note: {plannerCopilot.aiError}</div>
            ) : null}
          </div>
        ) : null}
      </div>
    </section>
  );
}

