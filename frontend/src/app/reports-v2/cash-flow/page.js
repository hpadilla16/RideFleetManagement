'use client';

/**
 * Cash Flow — collected history + forward forecast (2026-08-07, Hector).
 *
 * One timeline: what landed (left of today) and what is expected (right).
 * The forecast is split into COMMITTED (money attached to real bookings) and
 * PROJECTED (the weekday run-rate for bookings not yet made) and the two are
 * never merged into a single reassuring number — an operator has to know
 * which half to bet payroll on.
 *
 * Click any day to see what made it up: the payments that landed, or the
 * pickups and returns that are expected to.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { AuthGate } from '../../../components/AuthGate';
import { AppShell } from '../../../components/AppShell';
import { api } from '../../../lib/client';
import { ReportPageLayout } from '../../../components/reports/ReportPageLayout';
import { CashFlowChart } from '../../../components/reports/charts/CashFlowChart';
import { DEFAULT_TENANT_TIMEZONE, tenantDayKey } from '../../../lib/tenant-time';

const isoDay = (d, tz = DEFAULT_TENANT_TIMEZONE) => tenantDayKey(d, tz);
const money = (n) => {
  const v = Number(n);
  return Number.isFinite(v) ? `$${v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : '$0.00';
};
const HORIZONS = [7, 14, 30, 60, 90];

function defaultRange() {
  const to = isoDay(new Date());
  const from = isoDay(new Date(Date.now() - 29 * 86400000));
  return { from, to };
}

function Tile({ label, value, hint, tone }) {
  const color = tone === 'good' ? 'var(--ok-tx)' : tone === 'muted' ? 'var(--muted-tx, #6f668f)' : undefined;
  return (
    <div className="info-tile">
      <span className="label">{label}</span>
      <strong style={{ fontVariantNumeric: 'tabular-nums', ...(color ? { color } : {}) }}>{value}</strong>
      {hint ? <span className="ui-muted">{hint}</span> : null}
    </div>
  );
}

function DayDrawer({ day, data, loading, onClose }) {
  if (!day) return null;
  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(20,12,40,.42)', zIndex: 60, display: 'flex', justifyContent: 'flex-end' }}>
      <div onClick={(e) => e.stopPropagation()} className="glass" style={{ width: 'min(520px, 96vw)', height: '100%', overflowY: 'auto', borderRadius: 0, padding: 20 }}>
        <div className="row-between">
          <h3 style={{ margin: 0 }}>{day}</h3>
          <button type="button" className="button-subtle" onClick={onClose}>✕</button>
        </div>
        {loading ? <p className="ui-muted">Loading…</p> : !data ? <p className="ui-muted">Nothing to show.</p> : (
          <>
            <p style={{ margin: '8px 0 14px' }}>
              <span className="status-chip">{data.kind === 'HISTORY' ? 'Collected' : 'Expected'}</span>{' '}
              <strong style={{ fontSize: 18, fontVariantNumeric: 'tabular-nums' }}>{money(data.total)}</strong>
            </p>
            {!data.rows?.length ? (
              <p className="ui-muted">
                {data.kind === 'HISTORY' ? 'No payments were collected on this day.' : 'Nothing booked for this day yet — anything shown on the chart is projected.'}
              </p>
            ) : (
              <div className="stack" style={{ gap: 6 }}>
                {data.rows.map((r, i) => (
                  <div key={i} className="row-between" style={{ borderBottom: '1px dashed rgba(135,82,254,.18)', padding: '6px 0', fontSize: 13 }}>
                    <span>
                      {data.kind === 'FORECAST' ? <span className="status-chip" style={{ marginRight: 6 }}>{r.kind}</span> : null}
                      {r.reservationNumber || r.agreementNumber || r.reference || '—'}
                      {r.customer ? <span className="ui-muted"> · {r.customer}</span> : null}
                      {r.method ? <span className="ui-muted"> · {r.method}</span> : null}
                      {r.location ? <span className="ui-muted"> · {r.location}</span> : null}
                    </span>
                    <strong style={{ fontVariantNumeric: 'tabular-nums' }}>{money(r.amount)}</strong>
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function CashFlowInner({ me, token, logout }) {
  const [range, setRange] = useState(defaultRange);
  const [horizon, setHorizon] = useState(30);
  const [locationId, setLocationId] = useState('');
  const [locations, setLocations] = useState([]);
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [drillDay, setDrillDay] = useState(null);
  const [drill, setDrill] = useState({ loading: false, data: null });

  useEffect(() => {
    api('/api/locations', {}, token).then((d) => {
      const list = Array.isArray(d) ? d : (d?.locations || []);
      setLocations(list.map((l) => ({ id: l.id, code: l.code, name: l.name })));
    }).catch(() => {});
  }, [token]);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    const params = new URLSearchParams({ from: range.from, to: range.to, horizon: String(horizon) });
    if (locationId) params.set('locationId', locationId);
    api(`/api/reports/cash-flow?${params}`, { bypassCache: true }, token)
      .then((d) => { if (alive) { setData(d); setError(''); } })
      .catch((e) => { if (alive) { setError(String(e?.message || e)); setData(null); } })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [token, range.from, range.to, horizon, locationId]);

  const openDay = useCallback(async (iso) => {
    setDrillDay(iso);
    setDrill({ loading: true, data: null });
    try {
      const params = new URLSearchParams({ day: iso });
      if (locationId) params.set('locationId', locationId);
      const d = await api(`/api/reports/cash-flow/day?${params}`, { bypassCache: true }, token);
      setDrill({ loading: false, data: d });
    } catch {
      setDrill({ loading: false, data: null });
    }
  }, [token, locationId]);

  const t = data?.totals || {};
  const rate = data?.runRate || {};
  const noHistory = (rate.sampleDays || 0) === 0;

  const locationFilter = useMemo(() => (
    <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
      <select value={locationId} onChange={(e) => setLocationId(e.target.value)}>
        <option value="">All locations</option>
        {locations.map((l) => <option key={l.id} value={l.id}>{l.code || l.name}</option>)}
      </select>
      <span className="label" style={{ margin: 0 }}>Forecast</span>
      <select value={horizon} onChange={(e) => setHorizon(Number(e.target.value))}>
        {HORIZONS.map((h) => <option key={h} value={h}>{h} days</option>)}
      </select>
    </div>
  ), [locationId, locations, horizon]);

  return (
    <AppShell me={me} logout={logout}>
      <ReportPageLayout
        slug="cash-flow"
        title="Cash Flow"
        description="What was collected, and what is expected next. Committed money is booked; projected is the weekday run-rate for bookings not yet made."
        category="Management"
        token={token}
        range={range}
        onRangeChange={setRange}
        extraFilters={locationFilter}
        extraExportParams={{ ...(locationId ? { locationId } : {}), horizon: String(horizon) }}
      >
        {loading && !data ? (
          <p className="ui-muted">Loading…</p>
        ) : error ? (
          <div role="alert" style={{ background: '#FCEBEB', color: '#791F1F', padding: 12, borderRadius: 8 }}>{error}</div>
        ) : data ? (
          <>
            <div className="app-card-grid compact" style={{ marginBottom: 14 }}>
              <Tile label="Collected in period" value={money(t.historyCollected)} hint={`${data.history?.length || 0} days`} />
              <Tile label="Daily average" value={money(t.historyDailyAverage)} hint={t.bestDay ? `best ${t.bestDay.iso} · ${money(t.bestDay.collected)}` : null} />
              <Tile label="Committed ahead" value={money(t.forecastCommitted)} hint={`${data.inflowCount || 0} booked pickups + returns`} tone="good" />
              <Tile label="Projected ahead" value={money(t.forecastProjected)} hint={`run-rate, ${horizon} days`} tone="muted" />
              <Tile label="Expected total" value={money(t.forecastTotal)} hint="committed + projected" />
            </div>

            {t.components ? (
              <div className="glass card" style={{ padding: 12, marginBottom: 14 }}>
                <div style={{ fontWeight: 700, marginBottom: 8 }}>What the committed money is made of</div>
                <div className="app-card-grid compact">
                  <Tile label="Estimated rate" value={money(t.components.rate)} hint="base rental at the counter" />
                  <Tile label="Estimated fees" value={money(t.components.fees)} hint="mandatory + services" />
                  <Tile label="Estimated taxes" value={money(t.components.taxes)} hint="on the taxable portion" />
                  <Tile label="Open contract balances" value={money(t.components.balances)} hint="settle at return" />
                </div>
                {Number(t.components.prepaid || 0) > 0 ? (
                  <div className="surface-note" style={{ marginTop: 10, fontSize: 12.5 }}>
                    <strong>{money(t.components.prepaid)}</strong> across {t.components.prepaidCount} booking{t.components.prepaidCount === 1 ? '' : 's'} was
                    already collected upstream (prepaid / franchise). It is <strong>not</strong> counter cash and is deliberately excluded from
                    the forecast — see the Pre-Paid Reservations report for that side.
                  </div>
                ) : null}
              </div>
            ) : null}

            {Number(data.overdue?.total || 0) > 0 ? (
              <div className="surface-note warn" style={{ marginBottom: 12 }}>
                <strong>{money(data.overdue.total)}</strong> owed on {data.overdue.count} contract{data.overdue.count === 1 ? '' : 's'} already past their return date
                {data.overdue.oldest ? ` (oldest ${data.overdue.oldest})` : ''}. Collectible now — deliberately kept OUT of the daily forecast,
                because nothing about a past-due balance predicts which day it lands.
              </div>
            ) : null}

            {noHistory ? (
              <div className="surface-note warn" style={{ marginBottom: 12 }}>
                No collected payments in the trailing 8 weeks — the forecast shows only committed bookings, with nothing projected.
              </div>
            ) : null}

            <div className="glass card" style={{ padding: 12, marginBottom: 16 }}>
              <CashFlowChart
                history={data.history || []}
                forecast={data.forecast || []}
                onPointClick={(iso) => openDay(iso)}
              />
              <p className="ui-muted" style={{ fontSize: 11.5, margin: '8px 2px 0' }}>
                Click any day for the detail. Projections fade with distance — a weekday average describes next week far better than it describes next month.
              </p>
            </div>

            {data.byLocation?.length > 1 ? (
              <div className="glass card" style={{ padding: 12, marginBottom: 16 }}>
                <div style={{ fontWeight: 700, marginBottom: 8 }}>Collected by location</div>
                {data.byLocation.map((l) => (
                  <div key={l.locationId || 'none'} className="row-between" style={{ padding: '5px 0', borderBottom: '1px dashed rgba(135,82,254,.18)', fontSize: 13 }}>
                    <span>{l.code || l.name || 'Unassigned'}</span>
                    <strong style={{ fontVariantNumeric: 'tabular-nums' }}>{money(l.amount)}</strong>
                  </div>
                ))}
              </div>
            ) : null}

            <div className="glass card" style={{ padding: 12 }}>
              <div style={{ fontWeight: 700, marginBottom: 8 }}>Next {horizon} days</div>
              <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5 }}>
                  <thead>
                    <tr>
                      <th style={{ textAlign: 'left', padding: '4px 6px' }}>Day</th>
                      <th style={{ textAlign: 'right', padding: '4px 6px' }}>Committed</th>
                      <th style={{ textAlign: 'right', padding: '4px 6px' }}>Projected</th>
                      <th style={{ textAlign: 'right', padding: '4px 6px' }}>Expected</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(data.forecast || []).map((d) => (
                      <tr key={d.iso} onClick={() => openDay(d.iso)} style={{ cursor: 'pointer', borderBottom: '1px solid var(--border-subtle)' }}>
                        <td style={{ padding: '4px 6px' }}>{d.label}</td>
                        <td style={{ padding: '4px 6px', textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{d.committed ? money(d.committed) : '—'}</td>
                        <td style={{ padding: '4px 6px', textAlign: 'right', fontVariantNumeric: 'tabular-nums', opacity: 0.7 }}>
                          {d.hasRate ? money(d.projected) : <span className="ui-muted">no history</span>}
                        </td>
                        <td style={{ padding: '4px 6px', textAlign: 'right', fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>{money(d.total)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </>
        ) : null}

        <DayDrawer day={drillDay} data={drill.data} loading={drill.loading} onClose={() => { setDrillDay(null); setDrill({ loading: false, data: null }); }} />
      </ReportPageLayout>
    </AppShell>
  );
}

export default function CashFlowPage() {
  return <AuthGate>{({ me, token, logout }) => <CashFlowInner me={me} token={token} logout={logout} />}</AuthGate>;
}
