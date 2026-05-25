'use client';

/**
 * Commission — Round 31 (2026-05-23).
 *
 * Dollars-out-the-door from the AgreementCommission ledger. Per-employee
 * breakdown plus a daily chart. Simpler sibling of commission-sales-performance
 * (which is per-clerk attach % by service).
 *
 *   ┌───────────────────────────────────────────────────────────┐
 *   │ Title · Filter bar (Period + Location + Status)           │
 *   ├───────────────────────────────────────────────────────────┤
 *   │ 4 KPIs: Total · Paid · Approved · Pending                 │
 *   ├───────────────────────────────────────────────────────────┤
 *   │ Chart.js bar — commission $ per day                       │
 *   ├───────────────────────────────────────────────────────────┤
 *   │ Per-employee table (clickable rows → drill drawer)        │
 *   └───────────────────────────────────────────────────────────┘
 */

import { useEffect, useMemo, useState } from 'react';
import { AuthGate } from '../../../components/AuthGate';
import { AppShell } from '../../../components/AppShell';
import { api } from '../../../lib/client';
import { ReportPageLayout } from '../../../components/reports/ReportPageLayout';
import { CommissionListDrawer } from '../../../components/reports/CommissionListDrawer';
import { StackedDayBarChart } from '../../../components/reports/charts/StackedDayBarChart';

function isoDay(d) { return d.toISOString().slice(0, 10); }
function fmtMoney(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return '$0.00';
  return `$${v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function defaultRange() {
  const t = new Date();
  const from = new Date(t.getFullYear(), t.getMonth(), 1);
  return { from: isoDay(from), to: isoDay(t) };
}

function buildEmployeeEndpoint(employee, range, locationId, status) {
  if (!employee?.employeeUserId) return null;
  const params = new URLSearchParams();
  params.set('employeeUserId', employee.employeeUserId);
  if (range?.from) params.set('from', range.from);
  if (range?.to)   params.set('to',   range.to);
  if (locationId)  params.set('locationId', locationId);
  if (status)      params.set('status', status);
  return `/api/reports/commission/employee?${params.toString()}`;
}

export default function Page() {
  return <AuthGate>{({ token, me, logout }) => <CommissionReport token={token} me={me} logout={logout} />}</AuthGate>;
}

function CommissionReport({ token, me, logout }) {
  const [range, setRange] = useState(defaultRange);
  const [locationId, setLocationId] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [locations, setLocations] = useState([]);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [drillEmployee, setDrillEmployee] = useState(null);

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
    if (statusFilter) params.set('status', statusFilter);
    (async () => {
      try {
        const out = await api(`/api/reports/commission?${params.toString()}`, { bypassCache: true }, token);
        if (!cancelled) setData(out);
      } catch (err) {
        if (!cancelled) setError(err?.message || 'Failed to load report');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [token, range.from, range.to, locationId, statusFilter]);

  const locationFilter = (
    <>
      <span style={{ fontSize: 13, color: '#6f668f' }}>Location</span>
      <select
        value={locationId}
        onChange={(e) => setLocationId(e.target.value || '')}
        style={{ fontSize: 13, padding: '6px 8px', minWidth: 140, borderRadius: 8, border: '0.5px solid #d3d1c7', background: 'white' }}
      >
        <option value="">All</option>
        {locations.map((loc) => (
          <option key={loc.id} value={loc.id}>{loc.name || loc.code || loc.id}</option>
        ))}
      </select>
      <span style={{ fontSize: 13, color: '#6f668f' }}>Status</span>
      <select
        value={statusFilter}
        onChange={(e) => setStatusFilter(e.target.value || '')}
        style={{ fontSize: 13, padding: '6px 8px', minWidth: 120, borderRadius: 8, border: '0.5px solid #d3d1c7', background: 'white' }}
      >
        <option value="">All (non-void)</option>
        <option value="PAID">Paid</option>
        <option value="APPROVED">Approved</option>
        <option value="PENDING">Pending</option>
      </select>
    </>
  );

  const drillEndpoint = drillEmployee
    ? buildEmployeeEndpoint(drillEmployee, range, locationId, statusFilter)
    : null;
  const drillTitle = drillEmployee ? (drillEmployee.employeeName || drillEmployee.employeeUserId) : '';
  const drillSubtitle = drillEmployee
    ? `${fmtMoney(drillEmployee.amount)} across ${drillEmployee.rentalCount} rental${drillEmployee.rentalCount === 1 ? '' : 's'}`
    : undefined;

  return (
    <AppShell me={me} logout={logout}>
      <ReportPageLayout
        slug="commission"
        title="Commission Payouts"
        description="Commission paid + accrued per period, per employee. (Per-clerk sales-attach breakdown lives in the Commission & Sales Performance report.)"
        category="Operations"
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
          <ReportBody data={data} onEmployeeClick={setDrillEmployee} />
        ) : null}

        <CommissionListDrawer
          open={!!drillEmployee}
          endpoint={drillEndpoint}
          title={drillTitle}
          subtitle={drillSubtitle}
          token={token}
          onClose={() => setDrillEmployee(null)}
        />
      </ReportPageLayout>
    </AppShell>
  );
}

// ---------------------------------------------------------------------------
// Body
// ---------------------------------------------------------------------------

function ReportBody({ data, onEmployeeClick }) {
  const { totals, byEmployee, byDay, peakDay, truncated } = data;

  // Re-shape byDay into the StackedDayBarChart input — single $ series
  const chartDays = useMemo(() => byDay.map((d) => ({ iso: d.iso, label: d.label })), [byDay]);
  const chartSeries = useMemo(() => [{
    key: 'AMOUNT',
    label: 'Commission $',
    color: '#534AB7',
    data: byDay.map((d) => d.amount),
  }], [byDay]);
  const peakIdx = useMemo(() => peakDay ? byDay.findIndex((d) => d.iso === peakDay.iso) : -1, [byDay, peakDay]);

  return (
    <div>
      {truncated ? (
        <div style={{ background: '#FAEEDA', color: '#412402', padding: 10, borderRadius: 8, marginBottom: 12, fontSize: 12 }}>
          Range capped at 365 days — narrow the window to see more detail.
        </div>
      ) : null}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: 10, marginBottom: 18 }}>
        <Card label="Total commission" value={fmtMoney(totals.amount)} hint={`${totals.count} commission line${totals.count === 1 ? '' : 's'}`} />
        <Card
          label="Paid"
          value={fmtMoney(totals.paidAmount)}
          hint="check cut"
          bg={totals.paidAmount > 0 ? '#EAF3DE' : undefined}
          fg={totals.paidAmount > 0 ? '#173404' : undefined}
        />
        <Card
          label="Approved"
          value={fmtMoney(totals.approvedAmount)}
          hint="ready to pay"
          bg="#EEEDFE" fg="#26215C"
        />
        <Card
          label="Pending"
          value={fmtMoney(totals.pendingAmount)}
          hint="awaiting approval"
          bg={totals.pendingAmount > 0 ? '#FAEEDA' : undefined}
          fg={totals.pendingAmount > 0 ? '#412402' : undefined}
        />
      </div>

      {byDay.length > 0 ? (
        <section style={{ marginBottom: 22 }}>
          <SectionHeader>Commission by day</SectionHeader>
          <div style={{ background: 'white', border: '0.5px solid #d3d1c7', borderRadius: 8, padding: 14 }}>
            {totals.amount === 0 ? (
              <EmptyState>No commission in this window.</EmptyState>
            ) : (
              <StackedDayBarChart
                days={chartDays}
                series={chartSeries}
                highlightIdx={peakIdx}
                height={200}
              />
            )}
            {peakDay ? (
              <div style={{ fontSize: 11, color: '#6f668f', marginTop: 6 }}>
                Peak day: <strong style={{ color: '#211a38' }}>{peakDay.label}</strong> · {fmtMoney(peakDay.amount)}
              </div>
            ) : null}
          </div>
        </section>
      ) : null}

      <section>
        <SectionHeader>By employee</SectionHeader>
        <div style={{ border: '0.5px solid #d3d1c7', borderRadius: 8, overflowX: 'auto', background: 'white' }}>
          {byEmployee.length === 0 ? (
            <EmptyState>
              No commissions matched these filters. If you expected to see data here, run{' '}
              <code style={{ background: '#f1efe8', padding: '1px 4px', borderRadius: 3 }}>backend/scripts/audit-commissions.mjs</code>{' '}
              to diagnose whether the trigger is firing.
            </EmptyState>
          ) : (
            <table style={{ width: '100%', fontSize: 12, borderCollapse: 'collapse', minWidth: 700 }}>
              <thead>
                <tr style={{ background: '#f1efe8' }}>
                  <Th align="left">Employee</Th>
                  <Th align="right">Rentals</Th>
                  <Th align="right">Avg / rental</Th>
                  <Th align="right">Paid</Th>
                  <Th align="right">Approved</Th>
                  <Th align="right">Pending</Th>
                  <Th align="right" emphasis>Total</Th>
                </tr>
              </thead>
              <tbody>
                {byEmployee.map((e) => (
                  <tr
                    key={e.employeeUserId}
                    onClick={() => onEmployeeClick(e)}
                    style={{ cursor: 'pointer', transition: 'filter 0.1s' }}
                    onMouseEnter={(ev) => { ev.currentTarget.style.filter = 'brightness(0.97)'; }}
                    onMouseLeave={(ev) => { ev.currentTarget.style.filter = ''; }}
                  >
                    <Td>
                      <div style={{ fontWeight: 500 }}>{e.employeeName || e.employeeUserId}</div>
                      {e.employeeEmail ? <div style={{ fontSize: 10, color: '#6f668f' }}>{e.employeeEmail}</div> : null}
                    </Td>
                    <Td align="right" muted>{e.rentalCount}</Td>
                    <Td align="right" muted>{fmtMoney(e.averagePerRental)}</Td>
                    <Td align="right" style={{ color: e.paidAmount > 0 ? '#173404' : undefined }}>{fmtMoney(e.paidAmount)}</Td>
                    <Td align="right" style={{ color: e.approvedAmount > 0 ? '#26215C' : undefined }}>{fmtMoney(e.approvedAmount)}</Td>
                    <Td align="right" style={{ color: e.pendingAmount > 0 ? '#412402' : undefined }}>{fmtMoney(e.pendingAmount)}</Td>
                    <Td align="right" emphasis>{fmtMoney(e.amount)}</Td>
                  </tr>
                ))}
                <tr style={{ background: '#EEEDFE', color: '#26215C' }}>
                  <Td emphasis>TOTAL</Td>
                  <Td align="right" emphasis>{totals.rentalCount}</Td>
                  <Td align="right" emphasis>{fmtMoney(totals.averagePerRental)}</Td>
                  <Td align="right" emphasis>{fmtMoney(totals.paidAmount)}</Td>
                  <Td align="right" emphasis>{fmtMoney(totals.approvedAmount)}</Td>
                  <Td align="right" emphasis>{fmtMoney(totals.pendingAmount)}</Td>
                  <Td align="right" emphasis>{fmtMoney(totals.amount)}</Td>
                </tr>
              </tbody>
            </table>
          )}
        </div>
        {byEmployee.length > 0 ? (
          <div style={{ fontSize: 11, color: '#6f668f', marginTop: 6, paddingLeft: 4 }}>
            Click any employee to see their individual commission rows.
          </div>
        ) : null}
      </section>
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

function EmptyState({ children }) {
  return (
    <div style={{ padding: 30, textAlign: 'center', color: '#6f668f', background: '#f1efe8', borderRadius: 8, fontSize: 12, lineHeight: 1.6 }}>
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
    animation: 'rfm-comm-shimmer 1.4s ease-in-out infinite',
    borderRadius: 6,
  };
  return (
    <div aria-busy="true" aria-live="polite" aria-label="Loading report">
      <style>{`@keyframes rfm-comm-shimmer { 0% { background-position: 200% 0; } 100% { background-position: -200% 0; } }`}</style>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: 10, marginBottom: 18 }}>
        {[0, 1, 2, 3].map((i) => <div key={i} style={{ ...shimmer, height: 70 }} />)}
      </div>
      <div style={{ ...shimmer, height: 240, marginBottom: 22 }} />
      <div style={{ ...shimmer, height: 280 }} />
    </div>
  );
}
