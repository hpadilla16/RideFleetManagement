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
import { DEFAULT_TENANT_TIMEZONE } from '../../lib/tenant-time';

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
  const [fleet, setFleet] = useState(null);
  const [state, setState] = useState('loading'); // loading | ready | forbidden | error

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [out, fleetOut] = await Promise.all([
          api('/api/reports/dashboard-v2-kpis', {}, token),
          api('/api/reports/dashboard-v2-fleet?limit=8', {}, token),
        ]);
        if (!cancelled) { setKpis(out); setFleet(fleetOut); setState('ready'); }
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

      {state === 'ready' ? <FleetTable fleet={fleet} router={router} t={t} /> : null}

      {/* Phase 7 lands below: every block the current dashboard has (Hector's
          binding constraint: nothing gets deleted). Until then this page is a
          preview reached by URL only — it is deliberately NOT in the nav. */}
      <section className="glass card-lg">
        <p className="ui-muted" style={{ margin: 0 }}>
          {t('dashboardV2.wip', 'Preview build. The full block set from the current dashboard lands here next; the main dashboard is unchanged.')}
        </p>
      </section>
    </AppShell>
  );
}

const VEHICLE_STATUS_TONE = {
  AVAILABLE: 'ok',
  RESERVED: 'neutral',
  ON_RENT: 'neutral',
  IN_MAINTENANCE: 'warn',
  OUT_OF_SERVICE: 'danger',
  SOLD: 'neutral',
};

function turnReadyTone(status) {
  const value = String(status || '').toUpperCase();
  if (value === 'READY') return 'ok';
  if (value === 'BLOCKED') return 'danger';
  if (value === 'WATCH' || value === 'ATTENTION') return 'warn';
  return 'neutral';
}

function wallClock(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const sameDay = new Date().toDateString() === date.toDateString();
  return date.toLocaleString('en-US', {
    timeZone: DEFAULT_TENANT_TIMEZONE,
    ...(sameDay ? {} : { month: 'short', day: 'numeric' }),
    hour: 'numeric',
    minute: '2-digit',
  });
}

function nextActionLabel(action, t) {
  switch (action?.kind) {
    case 'return': return t('dashboardV2.actionReturn', 'Returns {{time}}', { time: wallClock(action.at) });
    case 'pickup': return t('dashboardV2.actionPickup', 'Pickup {{time}}', { time: wallClock(action.at) });
    case 'block': return t('dashboardV2.actionBlocked', 'Held until {{time}}', { time: wallClock(action.until) });
    case 'assign': return t('dashboardV2.actionAssign', 'Assign');
    default: return t('dashboardV2.actionReview', 'Review');
  }
}

/**
 * Worst-Turn-Ready-first slice of the fleet — "what needs a human", not an
 * inventory (that is /vehicles, one click away on any row).
 */
function FleetTable({ fleet, router, t }) {
  const rows = Array.isArray(fleet?.rows) ? fleet.rows : [];
  return (
    <section className="glass card-lg section-card" style={{ marginBottom: 16 }}>
      <div className="row-between" style={{ marginBottom: 10 }}>
        <h3 style={{ margin: 0 }}>{t('dashboardV2.fleetTitle', 'Units needing attention')}</h3>
        <span className="ui-muted">
          {t('dashboardV2.fleetCount', '{{shown}} of {{total}} units', { shown: rows.length, total: fleet?.totalCount ?? rows.length })}
        </span>
      </div>
      {rows.length === 0 ? (
        <p className="ui-muted" style={{ margin: 0 }}>{t('dashboardV2.fleetEmpty', 'No units to show yet.')}</p>
      ) : (
        <div className="table-shell">
          <table>
            <thead>
              <tr>
                <th>{t('dashboardV2.colPlate', 'Plate')}</th>
                <th>{t('dashboardV2.colVehicle', 'Vehicle')}</th>
                <th>{t('dashboardV2.colStatus', 'Status')}</th>
                <th>{t('dashboardV2.colLocation', 'Location')}</th>
                <th>{t('dashboardV2.colTurnReady', 'Turn-ready')}</th>
                <th>{t('dashboardV2.colNextAction', 'Next action')}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr
                  key={row.id}
                  style={{ cursor: 'pointer' }}
                  onClick={() => router.push(`/vehicles/${row.id}`)}
                  title={row.turnReady?.summary || ''}
                >
                  <td><span className="plate">{row.plate || row.internalNumber || '—'}</span></td>
                  <td>
                    <span className="cell-veh">
                      <span>
                        <b>{[row.make, row.model].filter(Boolean).join(' ') || row.internalNumber || '—'}</b>
                        <small>{[row.year, row.internalNumber].filter(Boolean).join(' · ')}</small>
                      </span>
                    </span>
                  </td>
                  <td>
                    <span className={`status-chip ${VEHICLE_STATUS_TONE[row.status] || 'neutral'}`}>
                      {t(`dashboardV2.status.${row.status}`, row.status)}
                    </span>
                  </td>
                  <td>{row.location?.name || '—'}</td>
                  <td>
                    <span className={`status-chip ${turnReadyTone(row.turnReady?.status)}`}>
                      {row.turnReady?.score ?? '—'}
                    </span>
                  </td>
                  <td>{nextActionLabel(row.nextAction, t)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
