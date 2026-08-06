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
import MarketIntelligenceCard from '../../components/MarketIntelligenceCard';
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
  // Ops-hub tile data (phase 7a) — mirrors the v1 dashboard's sources tile
  // for tile so the two screens can never disagree on a number. Every fetch
  // is soft-fail: a 403 or an off module hides that tile, never the page.
  const [overviewKpis, setOverviewKpis] = useState(null);
  const [todayKpis, setTodayKpis] = useState(null);
  const [mismatchCount, setMismatchCount] = useState(null);
  const [citSummary, setCitSummary] = useState(null);
  const [maintSummary, setMaintSummary] = useState(null);
  const [docAlert, setDocAlert] = useState(null);
  const [reservations, setReservations] = useState(null);
  const [shuttleOpen, setShuttleOpen] = useState(0);
  const [resSummary, setResSummary] = useState(null);
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

      // Tile data, each independent and soft-fail — same endpoints, same
      // gating conditions as the v1 dashboard.
      const soft = (promise, set, map = (x) => x) =>
        promise.then((v) => { if (!cancelled) set(map(v)); }).catch(() => { if (!cancelled) set(null); });
      soft(api('/api/reports/overview', {}, token), setOverviewKpis, (o) => o?.kpis || null);
      soft(api('/api/inventory/reconciliation/open', { bypassCache: true }, token), setMismatchCount, (v) => Number(v?.count || 0));
      if (me?.moduleAccess?.citations !== false) {
        soft(api('/api/citations/summary', {}, token), setCitSummary);
      }
      if (me?.moduleAccess?.maintenance !== false) {
        soft(api('/api/maintenance/summary', { bypassCache: true }, token), setMaintSummary);
        soft(api('/api/reports/today-kpis', { bypassCache: true }, token), setTodayKpis, (k) => (k && k.collectedToday != null ? k : null));
      }
      if (me?.moduleAccess?.settings !== false) {
        soft(api('/api/locations/documents/expiring', { bypassCache: true }, token), setDocAlert, (d) => (d && (d.expiringCount || d.expiredCount) ? d : null));
      }
      // The recent-reservations list feeds three v1 blocks at once: the
      // fee-advisory note scan, the grid4 row and the operations timeline.
      soft(api('/api/reservations?limit=500', {}, token), setReservations, (val) =>
        (Array.isArray(val) ? val : (Array.isArray(val?.items) ? val.items : [])));
      soft(api('/api/reservations/summary', {}, token), setResSummary);
      soft(api('/api/shuttle-requests?status=open', { bypassCache: true }, token), setShuttleOpen, (o) => (Array.isArray(o?.rows) ? o.rows.length : 0));
    })();
    return () => { cancelled = true; };
  }, [token, me]);

  // Ops board (phase 7b) — same date-scoped queries as v1 (the old capped
  // client-side filter showed 0 pickups for non-today dates; dateOn /
  // returnDateOn are server-side and volume-proof).
  const [boardDate, setBoardDate] = useState(() => wallClockDate(new Date()));
  const [boardPickups, setBoardPickups] = useState([]);
  const [boardReturns, setBoardReturns] = useState([]);
  const [boardMsg, setBoardMsg] = useState('');
  const [boardRefresh, setBoardRefresh] = useState(0);
  const todayStr = wallClockDate(new Date());
  const isToday = boardDate === todayStr;

  useEffect(() => {
    if (!token) return undefined;
    let cancelled = false;
    const rowsOf = (res) => {
      if (res.status !== 'fulfilled') return [];
      const v = res.value;
      return Array.isArray(v?.rows) ? v.rows : (Array.isArray(v?.items) ? v.items : (Array.isArray(v) ? v : []));
    };
    (async () => {
      const [pk, rt] = await Promise.allSettled([
        api(`/api/reservations/page?dateOn=${boardDate}&limit=500`, {}, token),
        api(`/api/reservations/page?returnDateOn=${boardDate}&limit=500`, {}, token),
      ]);
      if (cancelled) return;
      setBoardPickups(rowsOf(pk));
      setBoardReturns(rowsOf(rt));
    })();
    return () => { cancelled = true; };
  }, [token, boardDate, boardRefresh]);

  // Same filters as v1: pickups still pending; returns drop cancelled /
  // no-show / already-received (bug 2026-05-27: closed rentals kept prompting
  // the agent for check-in).
  const pickups = boardPickups.filter((r) => ['NEW', 'CONFIRMED'].includes(r.status))
    .sort((a, b) => String(a.pickupAt).localeCompare(String(b.pickupAt)));
  const returns = boardReturns.filter((r) => !['CANCELLED', 'NO_SHOW', 'CHECKED_IN', 'CHECKED_IN_UNPAID'].includes(r.status))
    .sort((a, b) => String(a.returnAt).localeCompare(String(b.returnAt)));

  const markNoShow = async (id) => {
    if (!window.confirm(t('dashboard.confirmNoShow'))) return;
    try {
      await api(`/api/reservations/${id}`, { method: 'PATCH', body: JSON.stringify({ status: 'NO_SHOW' }) }, token);
      setBoardMsg(t('dashboard.reservationNoShow'));
      setBoardRefresh((n) => n + 1);
    } catch (e) { setBoardMsg(e.message); }
  };
  const requestCustomerInfo = async (id) => {
    try {
      const out = await api(`/api/reservations/${id}/request-customer-info`, { method: 'POST', body: JSON.stringify({}) }, token);
      const link = out?.link || '';
      if (link && navigator?.clipboard) { try { await navigator.clipboard.writeText(link); } catch {} }
      setBoardMsg(link ? t('dashboard.customerInfoCopied', { link }) : t('dashboard.customerInfoIssued'));
    } catch (e) { setBoardMsg(e.message); }
  };

  const feeAdvisoryCount = reservations == null
    ? null
    : reservations.filter((r) => /\[FEE_ADVISORY_OPEN\s+/i.test(String(r.notes || ''))).length;

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
              <UtilizationSpark days={util?.days} />
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


      {state === 'ready' ? (
        <OpsTiles
          router={router}
          t={t}
          overviewKpis={overviewKpis}
          todayKpis={todayKpis}
          mismatchCount={mismatchCount}
          citSummary={citSummary}
          maintSummary={maintSummary}
          docAlert={docAlert}
          feeAdvisoryCount={feeAdvisoryCount}
        />
      ) : null}

      {state === 'ready' ? (
        <AttentionRail
          router={router}
          t={t}
          me={me}
          overviewKpis={overviewKpis}
          pickups={pickups}
          returns={returns}
          shuttleOpen={shuttleOpen}
        />
      ) : null}

      {state === 'ready' ? (
        <OpsBoard
          router={router}
          t={t}
          boardDate={boardDate}
          setBoardDate={setBoardDate}
          isToday={isToday}
          pickups={pickups}
          returns={returns}
          boardMsg={boardMsg}
          markNoShow={markNoShow}
          requestCustomerInfo={requestCustomerInfo}
        />
      ) : null}


      {state === 'ready' ? <FleetTable fleet={fleet} router={router} t={t} /> : null}

      {state === 'ready' && overviewKpis ? (
        <section className="grid4" style={{ marginBottom: 12 }}>
          <div className="glass card"><div className="label">{t('dashboard.totalVehicles')}</div><div className="value">{Number(overviewKpis.fleetTotal || 0)}</div></div>
          <div className="glass card"><div className="label">{t('dashboard.availableVehicles')}</div><div className="value">{Number(overviewKpis.availableFleet || 0)}</div></div>
          <div className="glass card"><div className="label">{t('dashboard.reservations')}</div><div className="value">{Number.isFinite(Number(resSummary?.totalReservations)) ? Number(resSummary.totalReservations).toLocaleString() : (reservations?.length ?? 0)}</div></div>
          <div className="glass card"><div className="label">{t('dashboard.active')}</div><div className="value">{Number(overviewKpis.activeReservations || 0)}</div></div>
          <div className="glass card"><div className="label">{t('dashboard.tileFeeAdvisories')}</div><div className="value">{feeAdvisoryCount ?? 0}</div></div>
        </section>
      ) : null}

      {/* Per-tenant gated — the component itself returns null when the role
          lacks marketIntelligence access or the tenant flag is off. */}
      <MarketIntelligenceCard me={me} token={token} />

      {state === 'ready' && reservations?.length ? (
        <section className="glass card-lg">
          <h3>{t('dashboard.operationsTimeline')}</h3>
          <div className="stack">
            {reservations
              .slice()
              .sort((a, b) => (new Date(b.updatedAt || b.createdAt || b.pickupAt || 0).getTime() || 0) - (new Date(a.updatedAt || a.createdAt || a.pickupAt || 0).getTime() || 0))
              .slice(0, 10)
              .map((r) => (
                <div key={r.id} className="row">
                  <span>{(() => { const v = r.updatedAt || r.createdAt || r.pickupAt; const d = v ? new Date(v) : null; return d && !Number.isNaN(d.getTime()) ? d.toLocaleString() : '—'; })()}</span>
                  <span>{t('dashboard.reservationLine', { number: r.reservationNumber, status: r.status })}</span>
                </div>
              ))}
          </div>
        </section>
      ) : null}
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

function isOverdue(action) {
  return action?.kind === 'return' && action.at && new Date(action.at).getTime() < Date.now();
}

function nextActionLabel(action, t) {
  switch (action?.kind) {
    case 'return':
      // A planned return in the past is not a schedule item, it is an alarm —
      // an open contract nobody closed. Say so (the cell renders it red).
      if (action.at && new Date(action.at).getTime() < Date.now()) {
        return t('dashboardV2.actionOverdue', 'Overdue since {{time}}', { time: wallClock(action.at) });
      }
      return t('dashboardV2.actionReturn', 'Returns {{time}}', { time: wallClock(action.at) });
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
                  <td style={isOverdue(row.nextAction) ? { color: 'var(--danger-tx)', fontWeight: 600 } : undefined}>
                    {nextActionLabel(row.nextAction, t)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

/**
 * The v1 dashboard's ops-hub tile wall, ported whole (phase 7a — Hector's
 * binding constraint: every tile survives). Numbers come from the SAME
 * endpoints as v1 and labels reuse the SAME `dashboard.*` locale keys, so the
 * two screens cannot drift apart while they coexist. Conditional tiles keep
 * their v1 conditions: citations/maintenance/docs render only when their
 * module answers, red tints fire on the same thresholds.
 */
function OpsTiles({ router, t, overviewKpis, todayKpis, mismatchCount, citSummary, maintSummary, docAlert, feeAdvisoryCount }) {
  const k = overviewKpis || {};
  const totalVehicles = Number(k.fleetTotal || 0);
  const available = Number(k.availableFleet || 0);
  const migrationHeld = Number(k.migrationHeld || 0);
  const serviceHeld = Number(k.vehiclesInMaintenance || 0) + Number(k.vehiclesOutOfService || 0);
  const activeReservations = Number(k.activeReservations || 0);
  const overdueReservations = Number(k.overdueReservations || 0);
  const money = (n) => `$${Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

  const tile = (key, onClick, label, value, desc, tone = null) => (
    <button
      type="button"
      key={key}
      className="info-tile"
      onClick={onClick}
      style={{
        textAlign: 'left',
        cursor: 'pointer',
        ...(tone === 'danger' ? { background: 'var(--danger-bg)', borderColor: 'var(--danger-bd)' } : {}),
        ...(tone === 'warn' ? { background: 'var(--warn-bg)', borderColor: 'var(--warn-bd)' } : {}),
      }}
    >
      <span className="label">{label}</span>
      <strong style={{ fontVariantNumeric: 'tabular-nums', ...(tone === 'danger' ? { color: 'var(--danger-tx)' } : tone === 'warn' ? { color: 'var(--warn-tx)' } : tone === 'ok' ? { color: 'var(--ok-tx)' } : {}) }}>
        {value}
      </strong>
      <span className="ui-muted">{desc}</span>
    </button>
  );

  return (
    <section className="glass card-lg section-card" style={{ marginBottom: 16 }}>
      <h3 style={{ marginTop: 0 }}>{t('dashboard.opsHubTitle')}</h3>
      <div className="app-card-grid compact">
        {overviewKpis ? tile('vehicles', () => router.push('/vehicles'), t('dashboard.tileVehicles'), totalVehicles, t('dashboard.tileVehiclesDesc')) : null}
        {overviewKpis ? tile('available', () => router.push('/vehicles?status=available'), t('dashboard.tileAvailable'), available, t('dashboard.tileAvailableDesc')) : null}
        {overviewKpis ? tile('migration', () => router.push('/vehicles?status=migration'), t('dashboard.tileMigrationHolds'), migrationHeld, t('dashboard.tileMigrationHoldsDesc')) : null}
        {overviewKpis ? tile('maintOos', () => router.push('/vehicles?status=maintenance'), t('dashboard.tileMaintenanceOos'), serviceHeld, t('dashboard.tileMaintenanceOosDesc')) : null}
        {todayKpis ? tile('collected', () => router.push('/reports-v2/payments-by-day'), t('dashboard.tileCollectedToday'), money(todayKpis.collectedToday),
          // Per-location split (2026-08-06). Location codes are data, not
          // translatable copy; falls back to the generic caption until the
          // day's first payment gives the split something to say.
          (Array.isArray(todayKpis.byLocation) && todayKpis.byLocation.length
            ? todayKpis.byLocation.map((l) => `${l.code || l.name || '—'} ${money(l.amount)}`).join(' · ')
            : t('dashboard.tileCollectedTodayDesc'))) : null}
        {todayKpis ? tile('pendingTolls', () => router.push('/tolls'), t('dashboard.tilePendingTolls'), Number(todayKpis.pendingTolls || 0), t('dashboard.tilePendingTollsDesc'), Number(todayKpis.pendingTolls || 0) > 0 ? 'danger' : 'ok') : null}
        {docAlert ? tile('docs', () => router.push('/settings'),
          t('dashboard.tileDocsExpiring', { defaultValue: 'Documents expiring' }),
          Number(docAlert.expiredCount || 0) + Number(docAlert.expiringCount || 0),
          Number(docAlert.expiredCount || 0) > 0
            ? t('dashboard.tileDocsExpiredDesc', { defaultValue: '{{expired}} already expired', expired: Number(docAlert.expiredCount || 0) })
            : t('dashboard.tileDocsExpiringDesc', { defaultValue: 'within {{days}} days', days: Number(docAlert.warnDays || 30) }),
          Number(docAlert.expiredCount || 0) > 0 ? 'danger' : 'warn') : null}
        {maintSummary ? tile('maintDue', () => router.push('/maintenance'), t('dashboard.tileMaintenanceDue'), Number(maintSummary.overdue || 0), (() => {
          const overdueN = Number(maintSummary.overdue || 0);
          const soonN = Number(maintSummary.dueSoonOnly ?? Math.max(0, Number(maintSummary.dueSoon || 0) - overdueN));
          if (overdueN > 0) return t('dashboard.tileMaintenanceDueDesc', { soon: soonN });
          if (soonN > 0) return t('dashboard.tileMaintenanceDueSoonDesc', { soon: soonN });
          return t('dashboard.tileMaintenanceDueOk');
        })(), Number(maintSummary.overdue || 0) > 0 ? 'danger' : null) : null}
        {mismatchCount != null ? tile('mismatch', () => router.push('/vehicles/reconciliation'), t('dashboard.tileStatusMismatches'), mismatchCount, t('dashboard.tileStatusMismatchesDesc'), mismatchCount > 0 ? 'danger' : null) : null}
        {overviewKpis ? tile('active', () => router.push('/reservations?filter=active'), t('dashboard.tileActiveReservations'), activeReservations, t('dashboard.tileActiveReservationsDesc')) : null}
        {overviewKpis ? tile('overdue', () => router.push('/reservations?filter=overdue'), t('dashboard.tileOverdueReturns'), overdueReservations, t('dashboard.tileOverdueReturnsDesc'), overdueReservations > 0 ? 'danger' : null) : null}
        {feeAdvisoryCount != null ? (
          <div className="info-tile" key="feeAdv">
            <span className="label">{t('dashboard.tileFeeAdvisories')}</span>
            <strong>{feeAdvisoryCount}</strong>
            <span className="ui-muted">{t('dashboard.tileFeeAdvisoriesDesc')}</span>
          </div>
        ) : null}
        {citSummary ? tile('citations', () => router.push('/citations'), t('dashboard.tileCitations'), Number(citSummary.needsReview || 0), t('dashboard.tileCitationsDesc', { outstanding: Number(citSummary.outstanding || 0).toFixed(2) })) : null}
      </div>
    </section>
  );
}

function wallClockDate(value) {
  const d = new Date(value);
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: DEFAULT_TENANT_TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(d);
  return parts; // en-CA gives YYYY-MM-DD
}

function shiftDate(dateStr, delta) {
  const d = new Date(`${dateStr}T00:00:00`);
  d.setDate(d.getDate() + delta);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * 7-day utilization line (Hector, 2026-08-04). Pure SVG — the points are the
 * backend's per-day buckets, computed with the same formula as the headline
 * percentage, so the line cannot tell a different story than the number.
 * Y-scale is 0..100 fixed: a flat-low week must LOOK flat-low, not zoomed
 * into fake drama.
 */
function UtilizationSpark({ days }) {
  const points = Array.isArray(days) ? days.filter((d) => d && d.pct != null) : [];
  if (points.length < 2) return null;
  const W = 100;
  const H = 34;
  const step = W / (points.length - 1);
  const y = (pct) => H - 2 - (Math.max(0, Math.min(100, pct)) / 100) * (H - 4);
  const path = points.map((d, i) => `${i === 0 ? 'M' : 'L'}${(i * step).toFixed(1)},${y(d.pct).toFixed(1)}`).join(' ');
  const last = points[points.length - 1];
  return (
    <svg
      className="spark"
      viewBox={`0 0 ${W} ${H}`}
      preserveAspectRatio="none"
      role="img"
      aria-label={points.map((d) => `${d.pct}%`).join(', ')}
    >
      <path d={path} fill="none" stroke="var(--brand)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
      <circle cx={(points.length - 1) * step} cy={y(last.pct)} r="2.5" fill="var(--brand)" />
    </svg>
  );
}

/**
 * The v1 attention rail, ported whole (phase 7b): next pickup, next return,
 * kiosk escalations, inspections to review, registrations expiring, ready to
 * rotate, loaner requests, loaner lane. Same derivations from the same
 * overview KPIs, same module gates, same `dashboard.*` locale keys — cards
 * self-clear when their queue empties, exactly as on v1.
 */
function AttentionRail({ router, t, me, overviewKpis, pickups, returns, shuttleOpen = 0 }) {
  const k = overviewKpis || {};
  const kioskEscalations = Number(k.kioskEscalations || 0);
  const inspectionsToReview = Number(k.inspectionsToReview || 0);
  const registrationsExpiring30d = Number(k.registrationsExpiring30d || 0);
  const readyToRotate = Number(k.readyToRotate || 0);
  const loanerRequestsPending = Number(k.loanerRequestsPending || 0);
  const rotationRuleLabel = k.fleetRotationRule === 'MILEAGE' ? t('dashboard.rotationRuleMileage') : t('dashboard.rotationRuleTime');
  const clock = (v) => new Date(v).toLocaleString('en-US', { timeZone: DEFAULT_TENANT_TIMEZONE });

  const items = [
    shuttleOpen > 0 ? {
      id: 'shuttle-requests',
      title: t('shuttle.railTitle', { defaultValue: 'Shuttle requests' }),
      detail: t('shuttle.railDetail', { defaultValue: '{{count}} customer(s) waiting for airport pickup', count: shuttleOpen }),
      note: t('shuttle.railNote', { defaultValue: 'Chloe validated the reservation; the floor dispatches the bus.' }),
      action: () => router.push('/shuttle'),
      actionLabel: t('shuttle.railOpen', { defaultValue: 'Open queue' }),
    } : null,
    pickups[0] ? {
      id: `pickup-${pickups[0].id}`,
      title: t('dashboard.nextPickup'),
      detail: `#${pickups[0].reservationNumber} - ${pickups[0].customer?.firstName || ''} ${pickups[0].customer?.lastName || ''}`.trim(),
      note: t('dashboard.pickupAt', { time: clock(pickups[0].pickupAt) }),
      action: () => router.push(`/reservations/${pickups[0].id}/checkout-wizard-v2`),
      actionLabel: t('dashboard.startCheckout'),
    } : null,
    returns[0] ? {
      id: `return-${returns[0].id}`,
      title: t('dashboard.nextReturn'),
      detail: `#${returns[0].reservationNumber} - ${returns[0].customer?.firstName || ''} ${returns[0].customer?.lastName || ''}`.trim(),
      note: t('dashboard.returnAt', { time: clock(returns[0].returnAt) }),
      action: () => router.push(`/reservations/${returns[0].id}/checkin-wizard`),
      actionLabel: t('dashboard.openCheckin'),
    } : null,
    (kioskEscalations > 0 && me?.moduleAccess?.kiosk !== false) ? {
      id: 'kiosk-escalations',
      title: t('dashboard.kioskEscalations'),
      detail: t('dashboard.kioskEscalationsDetail', { count: kioskEscalations }),
      note: t('dashboard.kioskEscalationsNote'),
      action: () => router.push('/kiosks?outcome=ESCALATED'),
      actionLabel: t('dashboard.openKiosks'),
    } : null,
    inspectionsToReview > 0 ? {
      id: 'inspections-to-review',
      title: t('dashboard.inspectionsToReview'),
      detail: t('dashboard.inspectionsToReviewDetail', { count: inspectionsToReview }),
      note: t('dashboard.inspectionsToReviewNote'),
      action: () => router.push('/inspections/review'),
      actionLabel: t('dashboard.reviewNow'),
    } : null,
    registrationsExpiring30d > 0 ? {
      id: 'registrations-expiring',
      title: t('dashboard.registrationsExpiring'),
      detail: t('dashboard.vehicleCount', { count: registrationsExpiring30d }),
      note: t('dashboard.registrationsExpiringNote'),
      action: () => router.push('/vehicles?registration=expiring'),
      actionLabel: t('dashboard.reviewVehicles'),
    } : null,
    readyToRotate > 0 ? {
      id: 'ready-to-rotate',
      title: t('dashboard.readyToRotate'),
      detail: t('dashboard.vehicleCount', { count: readyToRotate }),
      note: t('dashboard.readyToRotateNote', { rule: rotationRuleLabel }),
      action: () => router.push('/vehicles?rotation=ready'),
      actionLabel: t('dashboard.viewBatch'),
    } : null,
    (me?.moduleAccess?.loaner === true && loanerRequestsPending > 0) ? {
      id: 'loaner-requests-pending',
      title: t('dashboard.loanerRequests'),
      detail: t('dashboard.loanerRequestsDetail', { count: loanerRequestsPending }),
      note: t('dashboard.loanerRequestsNote'),
      action: () => router.push('/loaner#loaner-queues'),
      actionLabel: t('dashboard.reviewRequests'),
    } : null,
    (me?.moduleAccess?.loaner === true) ? {
      id: 'loaner',
      title: t('dashboard.loanerLane'),
      detail: t('dashboard.loanerLaneDetail'),
      note: t('dashboard.loanerLaneNote'),
      action: () => router.push('/loaner'),
      actionLabel: t('dashboard.openLoaner'),
    } : null,
  ].filter(Boolean);

  if (!items.length) return null;
  return (
    <section className="glass card-lg section-card" style={{ marginBottom: 16 }}>
      <div className="app-card-grid compact">
        {items.map((item) => (
          <section key={item.id} className="glass card section-card">
            <div className="section-title" style={{ fontSize: 15 }}>{item.title}</div>
            <div className="ui-muted">{item.detail}</div>
            <div className="surface-note">{item.note}</div>
            <div className="inline-actions">
              <button type="button" onClick={item.action}>{item.actionLabel}</button>
            </div>
          </section>
        ))}
      </div>
    </section>
  );
}

/**
 * The v1 ops board, ported whole (phase 7b): date-navigable pickups and
 * returns for the selected day, with the same actions (check-out, request
 * info, no-show; check-in or the received chip) and the same unpaid-balance
 * warning chips. Header counts mirror the filtered lists on purpose — the
 * backend summary counts disagreed with the cards (v1 bug note).
 */
function OpsBoard({ router, t, boardDate, setBoardDate, isToday, pickups, returns, boardMsg, markNoShow, requestCustomerInfo }) {
  const boardLabel = isToday
    ? t('dashboard.today')
    : new Date(`${boardDate}T12:00:00`).toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' });
  const timeOf = (v) => {
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? '-' : d.toLocaleString('en-US', { timeZone: DEFAULT_TENANT_TIMEZONE, hour: 'numeric', minute: '2-digit', hour12: true });
  };
  const moneyShort = (n) => `$${Number(n || 0).toFixed(2)}`;
  const unpaidBalance = (r) => {
    const balance = Number(r?.rentalAgreement?.balance);
    return Number.isFinite(balance) && balance > 0 ? balance : 0;
  };
  const open = (id) => router.push(`/reservations/${id}`);

  const row = (r, when, actions) => {
    const balance = unpaidBalance(r);
    return (
      <div
        key={`${when}-${r.id}`}
        role="button"
        tabIndex={0}
        onClick={() => open(r.id)}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(r.id); } }}
        className="row"
        style={{ alignItems: 'center', gap: 8, cursor: 'pointer', padding: '6px 4px', borderRadius: 8 }}
      >
        <span style={{ minWidth: 70, fontWeight: 600, fontSize: 13, color: 'var(--text-1)' }}>{timeOf(when === 'pickup' ? r.pickupAt : r.returnAt)}</span>
        <span style={{ flex: 1 }}>
          #{r.reservationNumber} · {r.customer?.firstName} {r.customer?.lastName}
          {r.vehicle ? ` · ${r.vehicle.year || ''} ${r.vehicle.make || ''} ${r.vehicle.model || ''}`.trim() : ''}
          {balance > 0 ? <span className="status-chip warn" style={{ marginLeft: 6 }}>{t('dashboard.unpaid', { amount: moneyShort(balance) })}</span> : null}
        </span>
        <div style={{ display: 'flex', gap: 6 }} onClick={(e) => e.stopPropagation()}>{actions(r)}</div>
      </div>
    );
  };

  return (
    <>
      <section className="glass card-lg" style={{ marginBottom: 12 }}>
        <div className="row-between" style={{ alignItems: 'center' }}>
          <h3 style={{ margin: 0 }}>{t('dashboard.opsBoard')}</h3>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <button type="button" onClick={() => setBoardDate(shiftDate(boardDate, -1))} style={{ padding: '4px 8px', minWidth: 0 }}>&larr;</button>
            <input type="date" value={boardDate} onChange={(e) => setBoardDate(e.target.value)} style={{ padding: '4px 8px', borderRadius: 8, border: '1px solid var(--border-soft)', background: 'var(--bg-soft)', color: 'var(--text-1)', fontSize: 13, fontWeight: 600 }} />
            <button type="button" onClick={() => setBoardDate(shiftDate(boardDate, 1))} style={{ padding: '4px 8px', minWidth: 0 }}>&rarr;</button>
            {!isToday && <button type="button" onClick={() => setBoardDate(wallClockDate(new Date()))} style={{ padding: '4px 10px', fontSize: 12 }}>{t('dashboard.today')}</button>}
          </div>
        </div>
        <p className="label" style={{ marginTop: 6, marginBottom: 0 }}>
          {boardLabel} — {t('dashboard.pickupsLabel')}: <strong>{pickups.length}</strong> · {t('dashboard.returnsLabel')}: <strong>{returns.length}</strong>
        </p>
        {boardMsg ? <p className="ui-muted" style={{ marginTop: 6, marginBottom: 0 }}>{boardMsg}</p> : null}
      </section>

      <section className="grid2" style={{ marginBottom: 16 }}>
        <div className="glass card-lg">
          <div className="label" style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.05em', color: 'var(--brand)', marginBottom: 8 }}>{t('dashboard.pickupsCount', { count: pickups.length })}</div>
          {pickups.length === 0 ? (
            <p className="ui-muted" style={{ textAlign: 'center', padding: 20, margin: 0 }}>{t('dashboard.noPickups')}</p>
          ) : (
            <div className="stack">
              {pickups.map((r) => row(r, 'pickup', (res) => (
                <>
                  <button type="button" onClick={(e) => { e.stopPropagation(); router.push(`/reservations/${res.id}/checkout-wizard-v2`); }}>{t('dashboard.startCheckout')}</button>
                  <button type="button" onClick={(e) => { e.stopPropagation(); requestCustomerInfo(res.id); }}>{t('dashboard.requestInfo')}</button>
                  <button type="button" onClick={(e) => { e.stopPropagation(); markNoShow(res.id); }}>{t('dashboard.noShow')}</button>
                </>
              )))}
            </div>
          )}
        </div>

        <div className="glass card-lg">
          <div className="label" style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.05em', color: 'var(--teal-tx)', marginBottom: 8 }}>{t('dashboard.returnsCount', { count: returns.length })}</div>
          {returns.length === 0 ? (
            <p className="ui-muted" style={{ textAlign: 'center', padding: 20, margin: 0 }}>{t('dashboard.noReturns')}</p>
          ) : (
            <div className="stack">
              {returns.map((r) => row(r, 'return', (res) => (
                ['CHECKED_IN', 'CHECKED_IN_UNPAID'].includes(res.status)
                  ? <span className="status-chip good">{t('dashboard.checkedIn')}</span>
                  : <button type="button" onClick={(e) => { e.stopPropagation(); router.push(`/reservations/${res.id}/checkin-wizard`); }}>{t('dashboard.startCheckin')}</button>
              )))}
            </div>
          )}
        </div>
      </section>
    </>
  );
}
