'use client';

import { useTranslation } from 'react-i18next';

// PL-1 compact header: title + 5 actionable KPI pills + panel buttons.
export function PlannerHeader({
  kpis,
  shortageTypeLabel,
  onPillClick,
  onOpenRules,
  onOpenCopilot,
  onAccommodateAll,
  canManagePlannerSetup,
  plannerRunning
}) {
  const { t } = useTranslation();
  const busy = ['assign', 'apply', 'clear', 'maintenance', 'wash'].includes(plannerRunning);

  const pills = [
    { id: 'unassigned', tone: kpis.unassigned > 0 ? 'warn' : 'ok', label: t('planner.kpiUnassigned'), value: kpis.unassigned },
    { id: 'overbooked', tone: kpis.overbooked > 0 ? 'bad' : 'ok', label: t('planner.kpiOverbooked'), value: kpis.overbooked },
    {
      id: 'shortage',
      tone: kpis.shortageToday > 0 ? 'warn' : 'ok',
      label: t('planner.kpiShortage'),
      value: shortageTypeLabel ? `${kpis.shortageToday} ${shortageTypeLabel}` : kpis.shortageToday
    },
    { id: 'pickups', tone: 'ok', label: t('planner.kpiPickups'), value: kpis.pickupsToday },
    { id: 'returns', tone: 'ok', label: t('planner.kpiReturns'), value: kpis.returnsToday }
  ];

  return (
    <div className="pl-hdr">
      <div className="pl-hdr-title"><span className="pl-hdr-dot" /> {t('planner.title')}</div>
      <div className="pl-kpis">
        {pills.map((pill) => (
          <button
            key={pill.id}
            type="button"
            className={`pl-kpi pl-kpi-${pill.tone}`}
            onClick={() => onPillClick(pill.id)}
            title={t('planner.kpiHint')}
          >
            {pill.label} <span className="pl-kpi-n">{pill.value}</span>
          </button>
        ))}
      </div>
      <div className="pl-hdr-spacer" />
      {canManagePlannerSetup ? (
        <button type="button" className="pl-btn-ghost" onClick={onOpenRules}>⚙︎ {t('planner.rules')}</button>
      ) : null}
      <button type="button" className="pl-btn-ghost" onClick={onOpenCopilot}>✦ {t('planner.copilot')}</button>
      <button type="button" className="pl-btn-primary" onClick={onAccommodateAll} disabled={busy}>
        {plannerRunning === 'assign' ? t('planner.accommodating') : `✓ ${t('planner.accommodateAll')}`}
      </button>
    </div>
  );
}
