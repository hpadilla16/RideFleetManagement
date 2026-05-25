'use client';

/**
 * Toll Report — per Location — Round 30 (2026-05-23).
 *
 * Tolls aggregated by plaza for a date window. Sibling of toll-per-vehicle
 * (same data, sliced the other way).
 *
 *   ┌───────────────────────────────────────────────────────────┐
 *   │ Title · Filter bar (Period + Location)                    │
 *   ├───────────────────────────────────────────────────────────┤
 *   │ 4 KPIs: Total · Plazas hit · Busiest · Unknown            │
 *   ├───────────────────────────────────────────────────────────┤
 *   │ Per-plaza table sorted by $ desc                          │
 *   │   Each row shows top-3 vehicles for that plaza            │
 *   └───────────────────────────────────────────────────────────┘
 *
 * Click any plaza row → drill drawer with the transactions at that plaza.
 * "Unknown plaza" rows behave the same way — they group transactions whose
 * `location` is null/empty.
 */

import { useEffect, useMemo, useState } from 'react';
import { AuthGate } from '../../../components/AuthGate';
import { AppShell } from '../../../components/AppShell';
import { api } from '../../../lib/client';
import { ReportPageLayout } from '../../../components/reports/ReportPageLayout';
import { BACKWARD_PRESETS } from '../../../components/reports/DateRangePicker';
import { TollTransactionListDrawer } from '../../../components/reports/TollTransactionListDrawer';

function isoDay(d) { return d.toISOString().slice(0, 10); }
function fmtMoney(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return '$0.00';
  return `$${v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function defaultRange() {
  const t = new Date();
  const to = isoDay(t);
  const from = new Date(t.getTime() - 29 * 86400000);
  return { from: isoDay(from), to };
}

// Backward-looking preset pack lives in DateRangePicker.js (BACKWARD_PRESETS).

function buildPlazaEndpoint(plazaKey, range, locationId) {
  if (!plazaKey) return null;
  const params = new URLSearchParams();
  params.set('plaza', plazaKey);
  if (range?.from) params.set('from', range.from);
  if (range?.to)   params.set('to',   range.to);
  if (locationId)  params.set('locationId', locationId);
  return `/api/reports/toll-per-location/transactions?${params.toString()}`;
}

export default function Page() {
  return <AuthGate>{({ token, me, logout }) => <TollPerLocationReport token={token} me={me} logout={logout} />}</AuthGate>;
}

function TollPerLocationReport({ token, me, logout }) {
  const [range, setRange] = useState(defaultRange);
  const [locationId, setLocationId] = useState('');
  const [locations, setLocations] = useState([]);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [drillPlaza, setDrillPlaza] = useState(null); // { key, label, amount, count }

  const presets = BACKWARD_PRESETS;

  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    (async () => {
      try {
        const out = await api('/api/locations', {}, token);
        const list = Array.isArray(out?.locations) ? out.locations : Array.isArray(out) ? out : [];
        if (!cancelled) setLocations(list);
      } catch {
        if (!cancelled) setLocations([]);
      }
    })();
    return () => { cancelled = true; };
  }, [token]);

  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    setLoading(true);
    setError('');
    const params = new URLSearchParams();
    params.set('from', range.from);
    params.set('to', range.to);
    if (locationId) params.set('locationId', locationId);
    (async () => {
      try {
        const out = await api(`/api/reports/toll-per-location?${params.toString()}`, { bypassCache: true }, token);
        if (!cancelled) setData(out);
      } catch (err) {
        if (!cancelled) setError(err?.message || 'Failed to load report');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [token, range.from, range.to, locationId]);

  const locationFilter = (
    <>
      <span style={{ fontSize: 13, color: '#6f668f' }}>Location</span>
      <select
        value={locationId}
        onChange={(e) => setLocationId(e.target.value || '')}
        style={{ fontSize: 13, padding: '6px 8px', minWidth: 160, borderRadius: 8, border: '0.5px solid #d3d1c7', background: 'white' }}
      >
        <option value="">All locations</option>
        {locations.map((loc) => (
          <option key={loc.id} value={loc.id}>{loc.name || loc.code || loc.id}</option>
        ))}
      </select>
    </>
  );

  return (
    <AppShell me={me} logout={logout}>
      <ReportPageLayout
        slug="toll-per-location"
        title="Toll Report — per Location"
        description="Tolls aggregated by plaza for the selected period."
        category="Fleet"
        token={token}
        range={range}
        onRangeChange={setRange}
        presets={presets}
        extraFilters={locationFilter}
      >
        {loading && !data ? (
          <Skeleton />
        ) : error ? (
          <div role="alert" style={{ background: '#FCEBEB', color: '#791F1F', padding: 12, borderRadius: 8 }}>{error}</div>
        ) : data ? (
          <ReportBody data={data} onPlazaClick={setDrillPlaza} />
        ) : null}

        <TollTransactionListDrawer
          open={!!drillPlaza}
          endpoint={drillPlaza ? buildPlazaEndpoint(drillPlaza.key, range, locationId) : null}
          title={drillPlaza ? drillPlaza.label : ''}
          subtitle={drillPlaza ? `${fmtMoney(drillPlaza.amount)} · ${drillPlaza.count} transaction${drillPlaza.count === 1 ? '' : 's'}` : undefined}
          token={token}
          onClose={() => setDrillPlaza(null)}
        />
      </ReportPageLayout>
    </AppShell>
  );
}

// ---------------------------------------------------------------------------
// Body
// ---------------------------------------------------------------------------

function ReportBody({ data, onPlazaClick }) {
  const { totals, plazas, truncated } = data;

  return (
    <div>
      {truncated ? (
        <div style={{ background: '#FAEEDA', color: '#412402', padding: 10, borderRadius: 8, marginBottom: 12, fontSize: 12 }}>
          Range capped at 365 days — narrow the window to see more detail.
        </div>
      ) : null}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: 10, marginBottom: 18 }}>
        <Card label="Total tolls" value={fmtMoney(totals.amount)} hint={`${totals.count} transactions`} />
        <Card label="Plazas hit" value={String(totals.plazaCount)} hint="distinct toll plazas" />
        <Card
          label="Busiest plaza"
          value={totals.busiestPlazaLabel || '—'}
          valueSize={14}
          hint={totals.busiestPlazaAmount ? fmtMoney(totals.busiestPlazaAmount) : ''}
          bg="#EEEDFE" fg="#26215C"
        />
        <Card
          label="Unknown plaza"
          value={String(totals.unknownCount)}
          hint={totals.unknownCount > 0 ? `${fmtMoney(totals.unknownAmount)} unattributed` : 'all attributed'}
          bg={totals.unknownCount > 0 ? '#FAEEDA' : undefined}
          fg={totals.unknownCount > 0 ? '#412402' : undefined}
        />
      </div>

      {plazas.length === 0 ? (
        <div style={{ background: '#f1efe8', color: '#444441', padding: 30, borderRadius: 8, textAlign: 'center', fontSize: 13 }}>
          No toll transactions in this window.
        </div>
      ) : (
        <section>
          <SectionHeader>By plaza</SectionHeader>
          <div style={{ background: 'white', border: '0.5px solid #d3d1c7', borderRadius: 8, overflowX: 'auto' }}>
            <table style={{ width: '100%', fontSize: 12, borderCollapse: 'collapse', minWidth: 640 }}>
              <thead>
                <tr style={{ background: '#f1efe8' }}>
                  <Th align="left">Plaza</Th>
                  <Th align="right">Tolls</Th>
                  <Th align="right" emphasis>Total</Th>
                  <Th align="right">Avg / toll</Th>
                  <Th align="left">Top vehicles</Th>
                </tr>
              </thead>
              <tbody>
                {plazas.map((p) => (
                  <tr
                    key={p.key}
                    onClick={() => onPlazaClick({ key: p.key, label: p.label, amount: p.amount, count: p.count })}
                    style={{
                      cursor: 'pointer',
                      transition: 'filter 0.1s',
                      background: p.isUnknown ? '#FAEEDA' : undefined,
                      color: p.isUnknown ? '#412402' : undefined,
                    }}
                    onMouseEnter={(e) => { e.currentTarget.style.filter = 'brightness(0.97)'; }}
                    onMouseLeave={(e) => { e.currentTarget.style.filter = ''; }}
                  >
                    <Td>
                      <div style={{ fontWeight: 500 }}>{p.label}</div>
                      {p.isUnknown ? (
                        <div style={{ fontSize: 10, color: '#412402', marginTop: 1 }}>no plaza name on transaction</div>
                      ) : null}
                    </Td>
                    <Td align="right" muted={!p.isUnknown}>{p.count}</Td>
                    <Td align="right" emphasis>{fmtMoney(p.amount)}</Td>
                    <Td align="right" muted={!p.isUnknown}>{fmtMoney(p.averagePerTxn)}</Td>
                    <Td muted={!p.isUnknown} style={{ fontSize: 11 }}>
                      {p.topVehicles.length === 0
                        ? '—'
                        : p.topVehicles.map((v) => `${v.plate || '—'} (${v.count})`).join(' · ')}
                    </Td>
                  </tr>
                ))}
                <tr style={{ background: '#EEEDFE', color: '#26215C' }}>
                  <Td emphasis>TOTAL</Td>
                  <Td align="right" emphasis>{plazas.reduce((acc, p) => acc + p.count, 0)}</Td>
                  <Td align="right" emphasis>{fmtMoney(plazas.reduce((acc, p) => acc + p.amount, 0))}</Td>
                  <Td />
                  <Td />
                </tr>
              </tbody>
            </table>
          </div>
          <div style={{ fontSize: 11, color: '#6f668f', marginTop: 6, paddingLeft: 4 }}>
            Click any plaza to see the transactions there. Unknown-plaza rows group transactions whose plaza name wasn't recorded.
          </div>
        </section>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

function Card({ label, value, hint, valueSize, bg, fg }) {
  return (
    <div style={{ background: bg || '#f1efe8', padding: '12px 14px', borderRadius: 8, color: fg }}>
      <div style={{ fontSize: 12, color: fg || '#6f668f' }}>{label}</div>
      <div style={{ fontSize: valueSize || 22, fontWeight: 500, marginTop: 2, color: fg || '#211a38' }}>{value}</div>
      {hint ? <div style={{ fontSize: 11, color: fg || '#6f668f', marginTop: 2 }}>{hint}</div> : null}
    </div>
  );
}

function SectionHeader({ children }) {
  return (
    <div style={{ fontSize: 12, color: '#6f668f', fontWeight: 500, marginBottom: 8, textTransform: 'uppercase' }}>
      {children}
    </div>
  );
}

function Th({ children, align = 'left', emphasis }) {
  return (
    <th style={{
      textAlign: align,
      padding: '8px 12px',
      fontWeight: 500,
      fontSize: 12,
      background: emphasis ? '#EEEDFE' : '#f1efe8',
      color: emphasis ? '#26215C' : '#211a38',
      borderBottom: '0.5px solid #d3d1c7',
      whiteSpace: 'nowrap',
    }}>{children}</th>
  );
}

function Td({ children, align = 'left', emphasis, muted, style }) {
  return (
    <td style={{
      textAlign: align,
      padding: '6px 12px',
      borderTop: '0.5px solid #d3d1c7',
      fontWeight: emphasis ? 500 : 400,
      color: muted ? '#6f668f' : undefined,
      fontSize: 12,
      ...style,
    }}>{children}</td>
  );
}

// ---------------------------------------------------------------------------
// Skeleton
// ---------------------------------------------------------------------------

function Skeleton() {
  const shimmer = {
    background: 'linear-gradient(90deg, #f1efe8 0%, #e8e6df 50%, #f1efe8 100%)',
    backgroundSize: '200% 100%',
    animation: 'rfm-tollloc-shimmer 1.4s ease-in-out infinite',
    borderRadius: 6,
  };
  return (
    <div aria-busy="true" aria-live="polite" aria-label="Loading report">
      <style>{`@keyframes rfm-tollloc-shimmer { 0% { background-position: 200% 0; } 100% { background-position: -200% 0; } }`}</style>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: 10, marginBottom: 18 }}>
        {[0, 1, 2, 3].map((i) => <div key={i} style={{ ...shimmer, height: 70 }} />)}
      </div>
      <div style={{ ...shimmer, height: 320 }} />
    </div>
  );
}
