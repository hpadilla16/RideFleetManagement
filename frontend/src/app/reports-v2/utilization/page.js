'use client';

/**
 * Utilization — Round 29 (2026-05-23).
 *
 * Historical fleet utilization over a date range. Backward-looking sibling of
 * the Trends tab in availability-forecast.
 *
 *   ┌───────────────────────────────────────────────────────────────┐
 *   │ Title · Filter bar (Period + presets · Location)              │
 *   ├───────────────────────────────────────────────────────────────┤
 *   │ 4 KPIs: Avg utilization · Peak · Trough · Rental days         │
 *   ├───────────────────────────────────────────────────────────────┤
 *   │ Chart.js line · auto-bucketed by range size                   │
 *   │   ☐ Compare to same period last year                          │
 *   ├───────────────────────────────────────────────────────────────┤
 *   │ Per-vehicle-class utilization table                           │
 *   └───────────────────────────────────────────────────────────────┘
 *
 * Default range: last 30 days (daily). Range up to 60d → daily, 60–365 →
 * weekly, > 365 → monthly. The chart axis re-labels accordingly.
 */

import { useEffect, useMemo, useState } from 'react';
import { AuthGate } from '../../../components/AuthGate';
import { AppShell } from '../../../components/AppShell';
import { api } from '../../../lib/client';
import { ReportPageLayout } from '../../../components/reports/ReportPageLayout';
import { BACKWARD_PRESETS } from '../../../components/reports/DateRangePicker';
import { UtilizationLineChart } from '../../../components/reports/charts/UtilizationLineChart';

function isoDay(d) { return d.toISOString().slice(0, 10); }
function fmtPct(v) { return `${(Number(v) * 100).toFixed(1)}%`; }

function defaultRange() {
  const t = new Date();
  const to = isoDay(t);
  const from = new Date(t.getTime() - 29 * 86400000);
  return { from: isoDay(from), to };
}

// Backward-looking preset pack lives in DateRangePicker.js (BACKWARD_PRESETS).

export default function Page() {
  return <AuthGate>{({ token, me, logout }) => <UtilizationReport token={token} me={me} logout={logout} />}</AuthGate>;
}

function UtilizationReport({ token, me, logout }) {
  const [range, setRange] = useState(defaultRange);
  const [locationId, setLocationId] = useState('');
  const [compareLastYear, setCompareLastYear] = useState(false);
  const [locations, setLocations] = useState([]);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

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
    if (compareLastYear) params.set('compareLastYear', 'true');
    (async () => {
      try {
        const out = await api(`/api/reports/utilization?${params.toString()}`, { bypassCache: true }, token);
        if (!cancelled) setData(out);
      } catch (err) {
        if (!cancelled) setError(err?.message || 'Failed to load report');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [token, range.from, range.to, locationId, compareLastYear]);

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
        slug="utilization"
        title="Utilization"
        description="Historical fleet utilization over time. Chart auto-buckets by range size."
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
          <ReportBody
            data={data}
            compareLastYear={compareLastYear}
            onToggleLastYear={setCompareLastYear}
          />
        ) : null}
      </ReportPageLayout>
    </AppShell>
  );
}

// ---------------------------------------------------------------------------
// Body
// ---------------------------------------------------------------------------

function ReportBody({ data, compareLastYear, onToggleLastYear }) {
  const { fleet, byType, granularity, lastYear, truncated, rangeDays } = data;
  const lyAvailable = !!lastYear && lastYear.hasData;
  const showLY = compareLastYear && lyAvailable;

  // Re-shape buckets into the days/utilizationByDay shape UtilizationLineChart expects.
  const chartDays = useMemo(
    () => fleet.buckets.map((b) => ({ iso: b.iso, label: granularity === 'day' ? b.label : `_ ${b.label}` })),
    [fleet.buckets, granularity],
  );
  const utilizationByDay = useMemo(() => fleet.buckets.map((b) => b.utilization), [fleet.buckets]);
  const lastYearByDay = useMemo(
    () => (lastYear?.buckets ? lastYear.buckets.map((b) => b.utilization) : null),
    [lastYear],
  );

  return (
    <div>
      {truncated ? (
        <div style={{ background: '#FAEEDA', color: '#412402', padding: 10, borderRadius: 8, marginBottom: 12, fontSize: 12 }}>
          Range capped at 2 years — narrow the window to see more detail.
        </div>
      ) : null}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: 10, marginBottom: 18 }}>
        <Card
          label="Average utilization"
          value={fmtPct(fleet.averageUtilization)}
          hint={`across ${rangeDays} day${rangeDays === 1 ? '' : 's'}`}
        />
        <Card
          label="Peak bucket"
          value={fleet.peakBucket ? fmtPct(fleet.peakBucket.utilization) : '—'}
          valueSize={20}
          hint={fleet.peakBucket?.label || ''}
          bg="#FAEEDA" fg="#412402"
        />
        <Card
          label="Trough bucket"
          value={fleet.troughBucket ? fmtPct(fleet.troughBucket.utilization) : '—'}
          valueSize={20}
          hint={fleet.troughBucket?.label || ''}
          bg="#EAF3DE" fg="#173404"
        />
        <Card
          label="Rental days"
          value={fleet.totalRentalDays.toLocaleString()}
          hint={`of ${fleet.capacityUnitDays.toLocaleString()} capacity-days`}
        />
      </div>

      <section style={{ marginBottom: 22 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 8 }}>
          <div style={{ fontSize: 12, color: '#6f668f', fontWeight: 500, textTransform: 'uppercase' }}>
            Utilization by {granularity}
          </div>
          <label style={{
            marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8,
            fontSize: 12, color: '#211a38', cursor: 'pointer',
          }}>
            <input
              type="checkbox"
              checked={compareLastYear}
              onChange={(e) => onToggleLastYear(e.target.checked)}
              style={{ accentColor: '#534AB7' }}
            />
            Compare to same period last year
          </label>
        </div>
        {compareLastYear && lastYear && !lyAvailable ? (
          <div style={{ background: '#f1efe8', color: '#5F5E5A', padding: 8, borderRadius: 6, fontSize: 11, marginBottom: 8 }}>
            No last-year data for this window — chart shows current period only.
          </div>
        ) : null}
        <div style={{ background: 'white', border: '0.5px solid #d3d1c7', borderRadius: 8, padding: 16 }}>
          {chartDays.length === 0 || fleet.capacity === 0 ? (
            <EmptyState>No utilization data in the selected window.</EmptyState>
          ) : (
            <UtilizationLineChart
              days={chartDays}
              utilizationByDay={utilizationByDay}
              lastYearByDay={lastYearByDay}
              showLastYear={showLY}
              height={260}
            />
          )}
        </div>
      </section>

      <section>
        <SectionHeader>By vehicle class</SectionHeader>
        <div style={{ border: '0.5px solid #d3d1c7', borderRadius: 8, overflowX: 'auto', background: 'white' }}>
          {byType.length === 0 ? (
            <EmptyState>No vehicle classes configured for this tenant.</EmptyState>
          ) : (
            <table style={{ width: '100%', fontSize: 12, borderCollapse: 'collapse', minWidth: 500 }}>
              <thead>
                <tr style={{ background: '#f1efe8' }}>
                  <Th align="left">Class</Th>
                  <Th align="right">Capacity</Th>
                  <Th align="right">Rental days</Th>
                  <Th align="right" emphasis>Utilization</Th>
                </tr>
              </thead>
              <tbody>
                {byType.map((t) => (
                  <tr key={t.id}>
                    <Td>
                      <div style={{ fontWeight: 500 }}>{t.name}</div>
                      {t.code ? <div style={{ fontSize: 10, color: '#6f668f' }}>{t.code}</div> : null}
                    </Td>
                    <Td align="right" muted>{t.capacity}</Td>
                    <Td align="right" muted>{t.rentalDays.toLocaleString()}</Td>
                    <Td align="right" emphasis>{fmtPct(t.utilizationPct)}</Td>
                  </tr>
                ))}
                <tr style={{ background: '#EEEDFE', color: '#26215C' }}>
                  <Td emphasis>FLEET TOTAL</Td>
                  <Td align="right" emphasis>{fleet.capacity}</Td>
                  <Td align="right" emphasis>{fleet.totalRentalDays.toLocaleString()}</Td>
                  <Td align="right" emphasis>{fmtPct(fleet.averageUtilization)}</Td>
                </tr>
              </tbody>
            </table>
          )}
        </div>
      </section>
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

function EmptyState({ children }) {
  return (
    <div style={{ padding: 40, textAlign: 'center', color: '#6f668f', background: '#f1efe8', borderRadius: 8 }}>
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

function Td({ children, align = 'left', emphasis, muted }) {
  return (
    <td style={{
      textAlign: align,
      padding: '6px 12px',
      borderTop: '0.5px solid #d3d1c7',
      fontWeight: emphasis ? 500 : 400,
      color: muted ? '#6f668f' : undefined,
      fontSize: 12,
      whiteSpace: 'nowrap',
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
    animation: 'rfm-util-shimmer 1.4s ease-in-out infinite',
    borderRadius: 6,
  };
  return (
    <div aria-busy="true" aria-live="polite" aria-label="Loading report">
      <style>{`@keyframes rfm-util-shimmer { 0% { background-position: 200% 0; } 100% { background-position: -200% 0; } }`}</style>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: 10, marginBottom: 18 }}>
        {[0, 1, 2, 3].map((i) => <div key={i} style={{ ...shimmer, height: 70 }} />)}
      </div>
      <div style={{ ...shimmer, height: 290, marginBottom: 22 }} />
      <div style={{ ...shimmer, height: 220 }} />
    </div>
  );
}
