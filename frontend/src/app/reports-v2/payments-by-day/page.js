'use client';

/**
 * Payments by Day — Round 27 (2026-05-23).
 *
 * Daily collected revenue grouped by payment method bucket. Mirrors the
 * reservations-by-day layout (snapshot strip → stacked bar chart → day-by-day
 * table) but in dollars, with payment-shaped drill-downs.
 *
 * Data source: RentalAgreementPayment. AUTH_HOLD and non-PAID statuses
 * excluded server-side. Method buckets: Cash · Card · Digital · Other.
 */

import { useEffect, useMemo, useState } from 'react';
import { AuthGate } from '../../../components/AuthGate';
import { AppShell } from '../../../components/AppShell';
import { api } from '../../../lib/client';
import { ReportPageLayout } from '../../../components/reports/ReportPageLayout';
import { PaymentListDrawer } from '../../../components/reports/PaymentListDrawer';
import { StackedDayBarChart } from '../../../components/reports/charts/StackedDayBarChart';
import { DEFAULT_TENANT_TIMEZONE, tenantDayKey } from '../../../lib/tenant-time';

const METHOD_LABEL = { CASH: 'Cash', CARD: 'Card', DIGITAL: 'Digital', OTHER: 'Other' };
const METHOD_COLOR = {
  CASH:    '#1fc7aa', // mint
  CARD:    '#534AB7', // brand purple
  DIGITAL: '#7F77DD', // light purple
  OTHER:   '#888780', // gray
};

// "YYYY-MM-DD" in tenant TZ. Same fix as reservations-by-day —
// toISOString().slice(0, 10) leaked the UTC date and made the default
// "1st of month → today" range silently off-by-one at the boundary.
function isoDay(d, tz = DEFAULT_TENANT_TIMEZONE) {
  return tenantDayKey(d, tz);
}

function defaultRange() {
  const todayIso = isoDay(new Date());
  const firstOfMonth = `${todayIso.slice(0, 7)}-01`;
  return { from: firstOfMonth, to: todayIso };
}

function buildDayEndpoint(dayIso, locationId) {
  if (!dayIso) return null;
  const params = new URLSearchParams();
  params.set('day', dayIso);
  if (locationId) params.set('locationId', locationId);
  return `/api/reports/payments-by-day/day?${params.toString()}`;
}

function fmtMoney(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return '$0.00';
  return `$${v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export default function Page() {
  return <AuthGate>{({ token, me, logout }) => <PaymentsByDayReport token={token} me={me} logout={logout} />}</AuthGate>;
}

function PaymentsByDayReport({ token, me, logout }) {
  const [range, setRange] = useState(defaultRange);
  const [locationId, setLocationId] = useState('');
  const [locations, setLocations] = useState([]);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [drillDay, setDrillDay] = useState(null); // { iso, label, total } | null

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
        const out = await api(`/api/reports/payments-by-day?${params.toString()}`, { bypassCache: true }, token);
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
        slug="payments-by-day"
        title="Payments by Day"
        description="Daily collected revenue by payment method. Auth-holds excluded."
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

        <PaymentListDrawer
          open={!!drillDay}
          endpoint={drillDay ? buildDayEndpoint(drillDay.iso, locationId) : null}
          title={drillDay ? drillDay.label : ''}
          subtitle={drillDay ? `${fmtMoney(drillDay.total)} collected` : undefined}
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
  const {
    days, totals, methodTotals, peak, topMethod, dailyAverage, truncated, bucketOrder,
  } = data;

  const peakIdx = useMemo(() => days.findIndex((d) => d.iso === peak.iso), [days, peak.iso]);

  const series = useMemo(() => {
    const order = Array.isArray(bucketOrder) ? bucketOrder : ['CASH', 'CARD', 'DIGITAL', 'OTHER'];
    return order.map((key) => ({
      key,
      label: METHOD_LABEL[key] || key,
      color: METHOD_COLOR[key] || '#888780',
      data: days.map((d) => d.amounts?.[key] || 0),
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
        <Card label="Collected" value={fmtMoney(totals.amount)} hint={`${totals.count} payment${totals.count === 1 ? '' : 's'}`} />
        <Card label="Daily average" value={fmtMoney(dailyAverage)} hint={`across ${days.length} day${days.length === 1 ? '' : 's'}`} />
        <Card
          label="Top method"
          value={`${METHOD_LABEL[topMethod.key] || topMethod.key} · ${fmtPct(topMethod.pct)}`}
          valueSize={14}
          hint={fmtMoney(topMethod.amount)}
          bg="#EEEDFE" fg="#26215C"
        />
        <Card
          label="Best day"
          value={peak.label}
          valueSize={14}
          hint={fmtMoney(peak.total)}
          bg="#FAEEDA" fg="#412402"
        />
      </div>

      <section style={{ marginBottom: 22 }}>
        <SectionHeader>Daily collected by method</SectionHeader>
        <div style={{ background: 'white', border: '0.5px solid #d3d1c7', borderRadius: 8, padding: 14 }}>
          {days.length === 0 ? (
            <EmptyState>No payments in the selected window.</EmptyState>
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
          Click any bar or row below to see the individual payments for that day. Digital = ZELLE + ATH Móvil + bank transfer.
        </div>
      </section>

      <section>
        <SectionHeader>Day-by-day breakdown</SectionHeader>
        <div style={{ border: '0.5px solid #d3d1c7', borderRadius: 8, overflowX: 'auto', background: 'white' }}>
          <table style={{ width: '100%', fontSize: 12, borderCollapse: 'collapse', minWidth: 600 }}>
            <thead>
              <tr style={{ background: '#f1efe8' }}>
                <Th align="left">Day</Th>
                <Th align="right">Cash</Th>
                <Th align="right">Card</Th>
                <Th align="right">Digital</Th>
                <Th align="right">Other</Th>
                <Th align="right">Count</Th>
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
                      {isPeak ? <span style={{ marginLeft: 6, fontSize: 10, fontWeight: 500, opacity: 0.8 }}>(best)</span> : null}
                    </Td>
                    <Td align="right">{fmtMoney(d.amounts.CASH)}</Td>
                    <Td align="right">{fmtMoney(d.amounts.CARD)}</Td>
                    <Td align="right">{fmtMoney(d.amounts.DIGITAL)}</Td>
                    <Td align="right">{fmtMoney(d.amounts.OTHER)}</Td>
                    <Td align="right" muted>{d.count}</Td>
                    <Td align="right" emphasis>{fmtMoney(d.total)}</Td>
                  </tr>
                );
              })}
              <tr style={{ background: '#EEEDFE', color: '#26215C' }}>
                <Td emphasis>TOTAL</Td>
                <Td align="right" emphasis>{fmtMoney(methodTotals.CASH)}</Td>
                <Td align="right" emphasis>{fmtMoney(methodTotals.CARD)}</Td>
                <Td align="right" emphasis>{fmtMoney(methodTotals.DIGITAL)}</Td>
                <Td align="right" emphasis>{fmtMoney(methodTotals.OTHER)}</Td>
                <Td align="right" emphasis>{totals.count}</Td>
                <Td align="right" emphasis>{fmtMoney(totals.amount)}</Td>
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
    animation: 'rfm-pxd-shimmer 1.4s ease-in-out infinite',
    borderRadius: 6,
  };
  return (
    <div aria-busy="true" aria-live="polite" aria-label="Loading report">
      <style>{`@keyframes rfm-pxd-shimmer { 0% { background-position: 200% 0; } 100% { background-position: -200% 0; } }`}</style>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: 10, marginBottom: 18 }}>
        {[0, 1, 2, 3].map((i) => <div key={i} style={{ ...shimmer, height: 64 }} />)}
      </div>
      <div style={{ ...shimmer, height: 260, marginBottom: 22 }} />
      <div style={{ ...shimmer, height: 280 }} />
    </div>
  );
}
