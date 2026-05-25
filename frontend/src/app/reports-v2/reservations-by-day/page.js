'use client';

/**
 * Reservations by Day — Round 27 (2026-05-23).
 *
 * Daily pickup load broken out by status bucket (OPEN / OUT / RETURNED / LOST),
 * for the selected period.
 *
 *   ┌───────────────────────────────────────────────────────────┐
 *   │ Title · Description · Filter bar (range + location)       │
 *   ├───────────────────────────────────────────────────────────┤
 *   │ Snapshot strip (reservations · completed · busiest day ·  │
 *   │                 cancel + no-show %)                       │
 *   ├───────────────────────────────────────────────────────────┤
 *   │ Stacked bar chart (one bar per day, 4 status stacks)      │
 *   ├───────────────────────────────────────────────────────────┤
 *   │ Day-by-day table (clickable rows → ReservationListDrawer) │
 *   └───────────────────────────────────────────────────────────┘
 *
 * Drill-down: clicking a chart bar OR a table row opens the side panel,
 * which hits `/api/reports/reservations-by-day/day?day=…&locationId=…`.
 */

import { useEffect, useMemo, useState } from 'react';
import { AuthGate } from '../../../components/AuthGate';
import { AppShell } from '../../../components/AppShell';
import { api } from '../../../lib/client';
import { ReportPageLayout } from '../../../components/reports/ReportPageLayout';
import { ReservationListDrawer } from '../../../components/reports/ReservationListDrawer';
import { StackedDayBarChart } from '../../../components/reports/charts/StackedDayBarChart';

const STATUS_LABEL = { OPEN: 'Open', OUT: 'Out', RETURNED: 'Returned', LOST: 'Lost' };
const STATUS_COLOR = {
  OPEN:     '#7F77DD', // brand purple light
  OUT:      '#534AB7', // brand purple
  RETURNED: '#1fc7aa', // brand mint
  LOST:     '#888780', // gray
};

function isoDay(d) { return d.toISOString().slice(0, 10); }

function defaultRange() {
  const t = new Date();
  const from = new Date(t.getFullYear(), t.getMonth(), 1);
  return { from: isoDay(from), to: isoDay(t) };
}

function buildDayEndpoint(dayIso, locationId) {
  if (!dayIso) return null;
  const params = new URLSearchParams();
  params.set('day', dayIso);
  if (locationId) params.set('locationId', locationId);
  return `/api/reports/reservations-by-day/day?${params.toString()}`;
}

export default function Page() {
  return <AuthGate>{({ token, me, logout }) => <ReservationsByDayReport token={token} me={me} logout={logout} />}</AuthGate>;
}

function ReservationsByDayReport({ token, me, logout }) {
  const [range, setRange] = useState(defaultRange);
  const [locationId, setLocationId] = useState('');
  const [locations, setLocations] = useState([]);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [drillDay, setDrillDay] = useState(null); // { iso, label, total } | null

  // Load locations
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

  // Load report
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
        const out = await api(`/api/reports/reservations-by-day?${params.toString()}`, { bypassCache: true }, token);
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
        slug="reservations-by-day"
        title="Reservations by Day"
        description="Daily pickup load broken out by status, for the selected period."
        category="Management"
        token={token}
        range={range}
        onRangeChange={setRange}
        extraFilters={locationFilter}
      >
        {loading && !data ? (
          <Skeleton />
        ) : error ? (
          <div role="alert" style={{ background: '#FCEBEB', color: '#791F1F', padding: 12, borderRadius: 8 }}>{error}</div>
        ) : data ? (
          <ReportBody data={data} onDayClick={setDrillDay} />
        ) : null}

        <ReservationListDrawer
          open={!!drillDay}
          endpoint={drillDay ? buildDayEndpoint(drillDay.iso, locationId) : null}
          title={drillDay ? `${drillDay.label}` : ''}
          subtitle={drillDay ? `${drillDay.total} pickup${drillDay.total === 1 ? '' : 's'} this day` : undefined}
          token={token}
          onClose={() => setDrillDay(null)}
        />
      </ReportPageLayout>
    </AppShell>
  );
}

// ---------------------------------------------------------------------------
// Body
// ---------------------------------------------------------------------------

function ReportBody({ data, onDayClick }) {
  const { days, totals, peak, completedPickups, completedRate, cancelRate, truncated, bucketOrder } = data;

  const peakIdx = useMemo(() => {
    return days.findIndex((d) => d.iso === peak.iso);
  }, [days, peak.iso]);

  const series = useMemo(() => {
    const order = Array.isArray(bucketOrder) ? bucketOrder : ['OPEN', 'OUT', 'RETURNED', 'LOST'];
    return order.map((key) => ({
      key,
      label: STATUS_LABEL[key] || key,
      color: STATUS_COLOR[key] || '#888780',
      data: days.map((d) => d.counts?.[key] || 0),
    }));
  }, [days, bucketOrder]);

  const handleBarClick = (idx) => {
    const d = days[idx];
    if (!d) return;
    onDayClick({ iso: d.iso, label: d.label, total: d.total });
  };

  const fmtPct = (v) => `${(v * 100).toFixed(1)}%`;

  return (
    <div>
      {truncated ? (
        <div style={{ background: '#FAEEDA', color: '#412402', padding: 10, borderRadius: 8, marginBottom: 12, fontSize: 12 }}>
          Range capped at 92 days — narrow the date window to see more detail.
        </div>
      ) : null}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: 10, marginBottom: 18 }}>
        <Card label="Reservations" value={String(totals.total)} hint="pickups in window" />
        <Card label="Completed pickups" value={String(completedPickups)} hint={`${fmtPct(completedRate)} of total`} />
        <Card
          label="Busiest day"
          value={peak.label}
          valueSize={14}
          hint={`${peak.total} pickup${peak.total === 1 ? '' : 's'}`}
          bg="#FAEEDA" fg="#412402"
        />
        <Card
          label="Cancel + no-show"
          value={fmtPct(cancelRate)}
          hint={`${totals.LOST} of ${totals.total}`}
          bg={totals.LOST > 0 ? '#FCEBEB' : undefined}
          fg={totals.LOST > 0 ? '#501313' : undefined}
        />
      </div>

      <section style={{ marginBottom: 22 }}>
        <SectionHeader>Daily pickups by status</SectionHeader>
        <div style={{ background: 'white', border: '0.5px solid #d3d1c7', borderRadius: 8, padding: 14 }}>
          {days.length === 0 ? (
            <EmptyState>No reservations in the selected window.</EmptyState>
          ) : (
            <StackedDayBarChart
              days={days}
              series={series}
              highlightIdx={peakIdx}
              onBarClick={handleBarClick}
              height={240}
            />
          )}
        </div>
        <div style={{ fontSize: 11, color: '#6f668f', marginTop: 6, paddingLeft: 4 }}>
          Click any bar or row below to see the reservations for that day.
        </div>
      </section>

      <section>
        <SectionHeader>Day-by-day breakdown</SectionHeader>
        <div style={{ border: '0.5px solid #d3d1c7', borderRadius: 8, overflowX: 'auto', background: 'white' }}>
          <table style={{ width: '100%', fontSize: 12, borderCollapse: 'collapse', minWidth: 540 }}>
            <thead>
              <tr style={{ background: '#f1efe8' }}>
                <Th align="left">Day</Th>
                <Th align="right">Open</Th>
                <Th align="right">Out</Th>
                <Th align="right">Returned</Th>
                <Th align="right">Lost</Th>
                <Th align="right" emphasis>Total</Th>
              </tr>
            </thead>
            <tbody>
              {days.map((d) => {
                const isPeak = d.iso === peak.iso;
                return (
                  <tr
                    key={d.iso}
                    onClick={() => onDayClick({ iso: d.iso, label: d.label, total: d.total })}
                    style={{
                      cursor: 'pointer',
                      background: isPeak ? '#FAEEDA' : undefined,
                      color: isPeak ? '#412402' : undefined,
                      transition: 'filter 0.1s',
                    }}
                    onMouseEnter={(e) => { e.currentTarget.style.filter = 'brightness(0.96)'; }}
                    onMouseLeave={(e) => { e.currentTarget.style.filter = ''; }}
                  >
                    <Td>
                      {d.label}
                      {isPeak ? <span style={{ marginLeft: 6, fontSize: 10, fontWeight: 500, opacity: 0.8 }}>(peak)</span> : null}
                    </Td>
                    <Td align="right">{d.counts.OPEN}</Td>
                    <Td align="right">{d.counts.OUT}</Td>
                    <Td align="right">{d.counts.RETURNED}</Td>
                    <Td align="right">{d.counts.LOST}</Td>
                    <Td align="right" emphasis>{d.total}</Td>
                  </tr>
                );
              })}
              <tr style={{ background: '#EEEDFE', color: '#26215C' }}>
                <Td emphasis>TOTAL</Td>
                <Td align="right" emphasis>{totals.OPEN}</Td>
                <Td align="right" emphasis>{totals.OUT}</Td>
                <Td align="right" emphasis>{totals.RETURNED}</Td>
                <Td align="right" emphasis>{totals.LOST}</Td>
                <Td align="right" emphasis>{totals.total}</Td>
              </tr>
            </tbody>
          </table>
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

function Td({ children, align = 'left', emphasis }) {
  return (
    <td style={{
      textAlign: align,
      padding: '6px 12px',
      borderTop: '0.5px solid #d3d1c7',
      fontWeight: emphasis ? 500 : 400,
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
    animation: 'rfm-rxd-shimmer 1.4s ease-in-out infinite',
    borderRadius: 6,
  };
  return (
    <div aria-busy="true" aria-live="polite" aria-label="Loading report">
      <style>{`@keyframes rfm-rxd-shimmer { 0% { background-position: 200% 0; } 100% { background-position: -200% 0; } }`}</style>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: 10, marginBottom: 18 }}>
        {[0, 1, 2, 3].map((i) => <div key={i} style={{ ...shimmer, height: 64 }} />)}
      </div>
      <div style={{ ...shimmer, height: 260, marginBottom: 22 }} />
      <div style={{ ...shimmer, height: 280 }} />
    </div>
  );
}
