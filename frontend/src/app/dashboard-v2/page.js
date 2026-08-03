'use client';

/**
 * Dashboard v2 (2026-08-03, phases 4-5 of design/DASHBOARD-V2.md).
 *
 * Built alongside `/` — the current dashboard stays untouched until Hector
 * signs this off with live data (his rollout decision). The composition is the
 * marketing product shot's hero row: the Turn-Ready ring (STATIC — the
 * animated sweep was rejected in INNOVATION-REVIEW.md), utilization with a
 * week-over-week delta, and tolls reconciled over 30 days. Every number comes
 * from GET /api/reports/dashboard-v2-kpis, which rolls Turn-Ready up through
 * the same signals map the planner and vehicle profile use — this page must
 * agree with the screens it links to.
 *
 * The endpoint is ADMIN/OPS and fail-closed for location-scoped users (same
 * posture as /today-kpis); a 403 shows the access note rather than fake zeros.
 */

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslation } from 'react-i18next';
import { AuthGate } from '../../components/AuthGate';
import { AppShell } from '../../components/AppShell';
import { api } from '../../lib/client';

function ringTone(avgScore) {
  if (avgScore == null) return 'neutral';
  if (avgScore >= 85) return 'ok';
  if (avgScore >= 65) return 'warn';
  return 'danger';
}

function TurnReadyRing({ score }) {
  const pct = score == null ? 0 : Math.max(0, Math.min(100, score));
  return (
    <div className="ring" style={{ '--pct': pct }} role="img" aria-label={`Turn-ready ${score ?? '-'} de 100`}>
      <svg viewBox="0 0 88 88" aria-hidden="true">
        <circle className="track" cx="44" cy="44" r="38" />
        <circle className="prog" cx="44" cy="44" r="38" />
      </svg>
      <div className="rcenter">
        <div>
          <div className="rnum">{score ?? '–'}</div>
          <div className="rsuf">score</div>
        </div>
      </div>
    </div>
  );
}

export default function DashboardV2Page() {
  return (
    <AuthGate>
      {({ token, me, logout }) => <DashboardV2Inner token={token} me={me} logout={logout} />}
    </AuthGate>
  );
}

function DashboardV2Inner({ token, me, logout }) {
  const { t } = useTranslation();
  const router = useRouter();
  const [kpis, setKpis] = useState(null);
  const [state, setState] = useState('loading'); // loading | ready | forbidden | error

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const out = await api('/api/reports/dashboard-v2-kpis', {}, token);
        if (!cancelled) { setKpis(out); setState('ready'); }
      } catch (err) {
        if (cancelled) return;
        setState(/403|forbidden|restricted/i.test(String(err?.message || '')) ? 'forbidden' : 'error');
      }
    })();
    return () => { cancelled = true; };
  }, [token]);

  const tr = kpis?.turnReady || null;
  const util = kpis?.utilization || null;
  const tolls = kpis?.tolls30d || null;
  const money = (n) => `$${Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

  return (
    <AppShell me={me} logout={logout}>
      <section className="glass card-lg section-card" style={{ marginBottom: 16 }}>
        <div className="row-between" style={{ alignItems: 'start', marginBottom: 12 }}>
          <div>
            <span className="eyebrow">{t('dashboardV2.eyebrow', 'Operations')}</span>
            <h2 className="page-title" style={{ marginTop: 6 }}>{t('dashboardV2.title', "Today's turns")}</h2>
            <p className="ui-muted">
              {kpis?.fleetCount != null
                ? t('dashboardV2.subtitle', '{{count}} units in fleet', { count: kpis.fleetCount })
                : t('dashboardV2.subtitleLoading', 'Loading fleet…')}
            </p>
          </div>
          <span className="status-chip neutral">{t('dashboardV2.previewChip', 'v2 preview')}</span>
        </div>

        {state === 'forbidden' ? (
          <p className="ui-muted">{t('dashboardV2.forbidden', 'These KPIs are limited to admin and ops accounts without a location restriction.')}</p>
        ) : state === 'error' ? (
          <p className="ui-muted">{t('dashboardV2.error', 'The KPI service did not respond. Reload to retry.')}</p>
        ) : (
          <div className="kpis">
            <button
              type="button"
              className="kpi kpi--ring"
              style={{ textAlign: 'left', cursor: 'pointer' }}
              onClick={() => router.push('/planner')}
              title={t('dashboardV2.turnReadyTitle', 'Open the planner')}
            >
              <TurnReadyRing score={tr?.avgScore ?? null} />
              <div style={{ minWidth: 0 }}>
                <div className="klab">{t('dashboardV2.turnReady', 'Turn-ready')}</div>
                <div className="kfoot" style={{ flexWrap: 'wrap' }}>
                  <span className={`status-chip ${ringTone(tr?.avgScore)}`}>
                    {t('dashboardV2.readyCount', '{{count}} ready', { count: tr?.ready ?? 0 })}
                  </span>
                  {tr?.blocked ? (
                    <span className="status-chip danger">
                      {t('dashboardV2.blockedCount', '{{count}} blocked', { count: tr.blocked })}
                    </span>
                  ) : null}
                  {(tr?.watch || 0) + (tr?.attention || 0) > 0 ? (
                    <span className="status-chip warn">
                      {t('dashboardV2.watchCount', '{{count}} to review', { count: (tr?.watch || 0) + (tr?.attention || 0) })}
                    </span>
                  ) : null}
                </div>
                <p className="kpi-note">{t('dashboardV2.turnReadyNote', 'Wash, damage, telematics and holds — fleet average, explained per unit on its profile.')}</p>
              </div>
            </button>

            <div className="kpi">
              <div className="klab">{t('dashboardV2.utilization', 'Utilization · 7d')}</div>
              <div className="kval">{util?.pct == null ? '–' : `${util.pct}%`}</div>
              <div className="kfoot">
                {util?.deltaPts == null ? (
                  <span className="ui-muted">{t('dashboardV2.noPriorWeek', 'No prior-week data')}</span>
                ) : (
                  <>
                    <span className={`status-chip ${util.deltaPts >= 0 ? 'ok' : 'warn'}`}>
                      {util.deltaPts >= 0 ? '+' : ''}{util.deltaPts} pts
                    </span>
                    <span>{t('dashboardV2.vsLastWeek', 'vs. last week')}</span>
                  </>
                )}
              </div>
            </div>

            <button
              type="button"
              className="kpi"
              style={{ textAlign: 'left', cursor: 'pointer' }}
              onClick={() => router.push('/tolls')}
              title={t('dashboardV2.tollsTitle', 'Open tolls')}
            >
              <div className="klab">{t('dashboardV2.tolls', 'Tolls reconciled · 30d')}</div>
              <div className="kval">{tolls ? money(tolls.reconciledAmount) : '–'}</div>
              <div className="kfoot">
                <span className="status-chip neutral">{t('dashboardV2.crossings', '{{count}} crossings', { count: tolls?.crossings ?? 0 })}</span>
                {tolls?.inReview ? (
                  <span>{t('dashboardV2.inReview', '{{count}} in review', { count: tolls.inReview })}</span>
                ) : null}
              </div>
            </button>
          </div>
        )}
      </section>

      {/* Phases 6-7 land below: the fleet table with the TURN-READY column,
          then every block the current dashboard has (Hector's binding
          constraint: nothing gets deleted). Until then this page is a preview
          reached by URL only — it is deliberately NOT in the nav. */}
      <section className="glass card-lg">
        <p className="ui-muted" style={{ margin: 0 }}>
          {t('dashboardV2.wip', 'Preview build. The fleet table and the full block set from the current dashboard land here next; the main dashboard is unchanged.')}
        </p>
      </section>
    </AppShell>
  );
}
