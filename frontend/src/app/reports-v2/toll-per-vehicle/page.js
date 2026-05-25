'use client';

/**
 * Toll Report — per Vehicle — Round 30 (2026-05-23).
 *
 * Tolls aggregated by vehicle for a date window.
 *
 *   ┌───────────────────────────────────────────────────────────┐
 *   │ Title · Filter bar (Period + Location)                    │
 *   ├───────────────────────────────────────────────────────────┤
 *   │ 4 KPIs: Total · Vehicles · Avg/vehicle · Unmatched        │
 *   ├───────────────────────────────────────────────────────────┤
 *   │ Per-vehicle table sorted by $ desc                        │
 *   ├───────────────────────────────────────────────────────────┤
 *   │ Unmatched callout (shown when count > 0)                  │
 *   └───────────────────────────────────────────────────────────┘
 *
 * Click a vehicle row OR the unmatched callout → drill drawer with the
 * individual transactions.
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

function buildVehicleEndpoint(vehicleId, range, locationId) {
  if (!vehicleId) return null;
  const params = new URLSearchParams();
  params.set('vehicleId', vehicleId);
  if (range?.from) params.set('from', range.from);
  if (range?.to)   params.set('to',   range.to);
  if (locationId)  params.set('locationId', locationId);
  return `/api/reports/toll-per-vehicle/transactions?${params.toString()}`;
}

function buildUnmatchedEndpoint(range) {
  const params = new URLSearchParams();
  params.set('unmatched', 'true');
  if (range?.from) params.set('from', range.from);
  if (range?.to)   params.set('to',   range.to);
  return `/api/reports/toll-per-vehicle/transactions?${params.toString()}`;
}

export default function Page() {
  return <AuthGate>{({ token, me, logout }) => <TollPerVehicleReport token={token} me={me} logout={logout} />}</AuthGate>;
}

function TollPerVehicleReport({ token, me, logout }) {
  const [range, setRange] = useState(defaultRange);
  const [locationId, setLocationId] = useState('');
  const [locations, setLocations] = useState([]);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [drillTarget, setDrillTarget] = useState(null); // { kind: 'vehicle'|'unmatched', vehicle?: {} }

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
        const out = await api(`/api/reports/toll-per-vehicle?${params.toString()}`, { bypassCache: true }, token);
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

  // Drill drawer endpoint + title
  const drillEndpoint = drillTarget
    ? (drillTarget.kind === 'unmatched'
        ? buildUnmatchedEndpoint(range)
        : buildVehicleEndpoint(drillTarget.vehicle?.vehicleId, range, locationId))
    : null;
  const drillTitle = drillTarget
    ? (drillTarget.kind === 'unmatched'
        ? 'Unmatched tolls'
        : `${drillTarget.vehicle?.plate || '—'} · ${drillTarget.vehicle?.label || ''}`.trim())
    : '';
  const drillSubtitle = drillTarget
    ? (drillTarget.kind === 'unmatched'
        ? `${fmtMoney(data?.unmatched?.amount || 0)} · needs reconciliation`
        : `${fmtMoney(drillTarget.vehicle?.amount || 0)} across ${drillTarget.vehicle?.count || 0} toll${drillTarget.vehicle?.count === 1 ? '' : 's'}`)
    : undefined;

  return (
    <AppShell me={me} logout={logout}>
      <ReportPageLayout
        slug="toll-per-vehicle"
        title="Toll Report — per Vehicle"
        description="Tolls aggregated by vehicle for the selected period."
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
          <ReportBody data={data} onDrillVehicle={(v) => setDrillTarget({ kind: 'vehicle', vehicle: v })} onDrillUnmatched={() => setDrillTarget({ kind: 'unmatched' })} />
        ) : null}

        <TollTransactionListDrawer
          open={!!drillTarget}
          endpoint={drillEndpoint}
          title={drillTitle}
          subtitle={drillSubtitle}
          token={token}
          onClose={() => setDrillTarget(null)}
        />
      </ReportPageLayout>
    </AppShell>
  );
}

// ---------------------------------------------------------------------------
// Body
// ---------------------------------------------------------------------------

function ReportBody({ data, onDrillVehicle, onDrillUnmatched }) {
  const { totals, vehicles, unmatched, truncated } = data;

  return (
    <div>
      {truncated ? (
        <div style={{ background: '#FAEEDA', color: '#412402', padding: 10, borderRadius: 8, marginBottom: 12, fontSize: 12 }}>
          Range capped at 365 days — narrow the window to see more detail.
        </div>
      ) : null}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: 10, marginBottom: 18 }}>
        <Card label="Total tolls" value={fmtMoney(totals.amount)} hint={`${totals.count} transactions`} />
        <Card label="Vehicles charged" value={String(totals.vehicleCount)} hint="in window" />
        <Card label="Avg per vehicle" value={fmtMoney(totals.averagePerVehicle)} hint="across charged vehicles" />
        <Card
          label="Unmatched"
          value={String(totals.unmatchedCount)}
          hint={`${fmtMoney(totals.unmatchedAmount)} pending`}
          bg={totals.unmatchedCount > 0 ? '#FAEEDA' : undefined}
          fg={totals.unmatchedCount > 0 ? '#412402' : undefined}
        />
      </div>

      {vehicles.length === 0 && totals.unmatchedCount === 0 ? (
        <div style={{ background: '#f1efe8', color: '#444441', padding: 30, borderRadius: 8, textAlign: 'center', fontSize: 13 }}>
          No tolls in this window.
        </div>
      ) : (
        <>
          <SectionHeader>By vehicle</SectionHeader>
          <div style={{ background: 'white', border: '0.5px solid #d3d1c7', borderRadius: 8, overflowX: 'auto', marginBottom: 18 }}>
            {vehicles.length === 0 ? (
              <div style={{ padding: 30, textAlign: 'center', color: '#6f668f', fontSize: 12 }}>
                No tolls credited to a vehicle in this window.
              </div>
            ) : (
              <table style={{ width: '100%', fontSize: 12, borderCollapse: 'collapse', minWidth: 700 }}>
                <thead>
                  <tr style={{ background: '#f1efe8' }}>
                    <Th align="left">Plate</Th>
                    <Th align="left">Vehicle</Th>
                    <Th align="left">Class</Th>
                    <Th align="left">Home location</Th>
                    <Th align="right">Tolls</Th>
                    <Th align="right" emphasis>Total</Th>
                    <Th align="left">Top plazas</Th>
                  </tr>
                </thead>
                <tbody>
                  {vehicles.map((v) => (
                    <tr
                      key={v.vehicleId}
                      onClick={() => onDrillVehicle(v)}
                      style={{ cursor: 'pointer', transition: 'filter 0.1s' }}
                      onMouseEnter={(e) => { e.currentTarget.style.filter = 'brightness(0.97)'; }}
                      onMouseLeave={(e) => { e.currentTarget.style.filter = ''; }}
                    >
                      <Td>
                        <strong>{v.plate || '—'}</strong>
                      </Td>
                      <Td>{v.label || '—'}</Td>
                      <Td muted>{v.vehicleType || '—'}</Td>
                      <Td muted>{v.homeLocation || '—'}</Td>
                      <Td align="right" muted>{v.count}</Td>
                      <Td align="right" emphasis>{fmtMoney(v.amount)}</Td>
                      <Td muted style={{ fontSize: 11 }}>
                        {v.topLocations.length === 0
                          ? '—'
                          : v.topLocations.map((p) => `${p.name} (${p.count})`).join(' · ')}
                      </Td>
                    </tr>
                  ))}
                  <tr style={{ background: '#EEEDFE', color: '#26215C' }}>
                    <Td emphasis>TOTAL</Td>
                    <Td emphasis colSpan={3}>{vehicles.length} vehicle{vehicles.length === 1 ? '' : 's'}</Td>
                    <Td align="right" emphasis>{vehicles.reduce((acc, v) => acc + v.count, 0)}</Td>
                    <Td align="right" emphasis>{fmtMoney(vehicles.reduce((acc, v) => acc + v.amount, 0))}</Td>
                    <Td />
                  </tr>
                </tbody>
              </table>
            )}
          </div>

          {totals.unmatchedCount > 0 ? (
            <section>
              <SectionHeader>Unmatched · needs reconciliation</SectionHeader>
              <div
                onClick={onDrillUnmatched}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onDrillUnmatched(); } }}
                style={{
                  background: '#FAEEDA', border: '0.5px solid #EF9F27',
                  padding: '14px 16px', borderRadius: 8,
                  display: 'flex', alignItems: 'center', gap: 14,
                  cursor: 'pointer',
                }}
              >
                <div style={{ fontSize: 28, fontWeight: 500, color: '#412402' }}>{totals.unmatchedCount}</div>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 13, fontWeight: 500, color: '#412402' }}>
                    Tolls without a vehicle attribution
                  </div>
                  <div style={{ fontSize: 12, color: '#412402', opacity: 0.85, marginTop: 2 }}>
                    {fmtMoney(totals.unmatchedAmount)} in tolls couldn't be tied to a vehicle in this window. Click to review.
                  </div>
                </div>
                <div style={{ fontSize: 20, color: '#412402' }}>→</div>
              </div>
            </section>
          ) : null}
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

function Card({ label, value, hint, bg, fg }) {
  return (
    <div style={{ background: bg || '#f1efe8', padding: '12px 14px', borderRadius: 8, color: fg }}>
      <div style={{ fontSize: 12, color: fg || '#6f668f' }}>{label}</div>
      <div style={{ fontSize: 22, fontWeight: 500, marginTop: 2, color: fg || '#211a38' }}>{value}</div>
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

function Td({ children, align = 'left', emphasis, muted, colSpan, style }) {
  return (
    <td colSpan={colSpan} style={{
      textAlign: align,
      padding: '6px 12px',
      borderTop: '0.5px solid #d3d1c7',
      fontWeight: emphasis ? 500 : 400,
      color: muted ? '#6f668f' : undefined,
      fontSize: 12,
      whiteSpace: 'nowrap',
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
    animation: 'rfm-toll-shimmer 1.4s ease-in-out infinite',
    borderRadius: 6,
  };
  return (
    <div aria-busy="true" aria-live="polite" aria-label="Loading report">
      <style>{`@keyframes rfm-toll-shimmer { 0% { background-position: 200% 0; } 100% { background-position: -200% 0; } }`}</style>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: 10, marginBottom: 18 }}>
        {[0, 1, 2, 3].map((i) => <div key={i} style={{ ...shimmer, height: 70 }} />)}
      </div>
      <div style={{ ...shimmer, height: 320 }} />
    </div>
  );
}
