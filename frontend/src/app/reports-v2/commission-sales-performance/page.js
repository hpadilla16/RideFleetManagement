'use client';

/**
 * Commission & Sales Performance Report — Round 24b (2026-05-22).
 *
 * Frontend page for /reports-v2/commission-sales-performance.
 *
 * Sections (top to bottom):
 *   1. Snapshot strip: rentals · revenue · commissions · avg $/rental
 *   2. Per-clerk metrics table
 *   3. Sales attach % by service heatmap (red/amber/green)
 *   4. Counter $ generated per service
 *
 * Date range picker + PDF/Excel export buttons come from ReportPageLayout.
 */

import { useEffect, useMemo, useState } from 'react';
import { AuthGate } from '../../../components/AuthGate';
import { AppShell } from '../../../components/AppShell';
import { api } from '../../../lib/client';
import { ReportPageLayout } from '../../../components/reports/ReportPageLayout';

export default function Page() {
  return <AuthGate>{({ token, me, logout }) => <CommissionReport token={token} me={me} logout={logout} />}</AuthGate>;
}

function CommissionReport({ token, me, logout }) {
  const [range, setRange] = useState(() => {
    // Default: previous full calendar month (so the report has data right away)
    const t = new Date();
    const from = new Date(t.getFullYear(), t.getMonth() - 1, 1);
    const to = new Date(t.getFullYear(), t.getMonth(), 0);
    return {
      from: from.toISOString().slice(0, 10),
      to: to.toISOString().slice(0, 10),
    };
  });
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    setLoading(true);
    setError('');
    (async () => {
      try {
        const out = await api(
          `/api/reports/commission-sales-performance?from=${range.from}&to=${range.to}`,
          { bypassCache: true },
          token,
        );
        if (!cancelled) setData(out);
      } catch (err) {
        if (!cancelled) setError(err?.message || 'Failed to load report');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [token, range.from, range.to]);

  return (
    <AppShell me={me} logout={logout}>
      <ReportPageLayout
        slug="commission-sales-performance"
        title="Commission & Sales Performance Report"
        description="Per-clerk attach + commission performance for the selected period."
        category="Operations"
        token={token}
        range={range}
        onRangeChange={setRange}
      >
        {loading && !data ? (
          <div style={{ padding: 60, textAlign: 'center', color: '#6f668f' }}>Loading report…</div>
        ) : error ? (
          <div style={{ background: '#FCEBEB', color: '#791F1F', padding: 12, borderRadius: 8 }}>{error}</div>
        ) : data ? (
          <ReportBody data={data} />
        ) : null}
      </ReportPageLayout>
    </AppShell>
  );
}

// ---------------------------------------------------------------------------
// Body
// ---------------------------------------------------------------------------

function ReportBody({ data }) {
  const { clerks, team, services } = data;
  return (
    <div>
      <SnapshotStrip team={team} />
      <PerClerkMetrics clerks={clerks} team={team} />
      <AttachHeatmap clerks={clerks} team={team} services={services} />
      <CounterDollars team={team} services={services} />
    </div>
  );
}

function SnapshotStrip({ team }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 10, marginBottom: 22 }}>
      <Card label="Rentals closed" value={int(team.rentals)} />
      <Card label="Counter revenue" value={money(team.paidAtCounter)} />
      <Card label="Commissions" value={money(team.commissions)} />
      <Card label="Avg $/rental" value={money(team.avgPaid)} />
    </div>
  );
}

function Card({ label, value }) {
  return (
    <div style={{ background: '#f1efe8', padding: '12px 14px', borderRadius: 8 }}>
      <div style={{ fontSize: 12, color: '#6f668f' }}>{label}</div>
      <div style={{ fontSize: 22, fontWeight: 500 }}>{value}</div>
    </div>
  );
}

function PerClerkMetrics({ clerks, team }) {
  const rows = [
    ['Rentals closed',     (c) => int(c.rentals),               int(team.rentals)],
    ['Total rental days',  (c) => int(c.totalDays),             int(team.totalDays)],
    ['Avg days / rental',  (c) => c.avgDays.toFixed(2),         team.avgDays.toFixed(2)],
    ['Paid at counter',    (c) => money(c.paidAtCounter),       money(team.paidAtCounter)],
    ['Avg $/rental',       (c) => money(c.avgPaid),             money(team.avgPaid)],
    ['Commissions',        (c) => money(c.commissions),         money(team.commissions)],
    ['Commission $/rental',(c) => money(c.commissionPerRental), money(team.commissionPerRental)],
    ['% Share of rentals', (c) => pct(c.shareRentals),          '100%'],
    ['% Share of revenue', (c) => pct(c.shareRevenue),          '100%'],
  ];
  return (
    <section style={{ marginBottom: 22 }}>
      <SectionHeader>Per-clerk metrics</SectionHeader>
      <Table>
        <thead>
          <tr>
            <Th align="left">Metric</Th>
            {clerks.map((c) => <Th key={c.id} align="right">{c.name}</Th>)}
            <Th align="right" emphasis>Team</Th>
          </tr>
        </thead>
        <tbody>
          {rows.map(([label, fn, total]) => (
            <tr key={label}>
              <Td>{label}</Td>
              {clerks.map((c) => <Td key={c.id} align="right">{fn(c)}</Td>)}
              <Td align="right" emphasis>{total}</Td>
            </tr>
          ))}
        </tbody>
      </Table>
    </section>
  );
}

function AttachHeatmap({ clerks, team, services }) {
  return (
    <section style={{ marginBottom: 22 }}>
      <SectionHeader>Sales attach % by service</SectionHeader>
      <div style={{ fontSize: 11, color: '#6f668f', marginBottom: 8 }}>
        <Pill bg="#F7C1C1" fg="#501313">&lt; 30%</Pill>
        <Pill bg="#FAC775" fg="#412402">30–60%</Pill>
        <Pill bg="#C0DD97" fg="#173404">≥ 60%</Pill>
      </div>
      <Table>
        <thead>
          <tr>
            <Th align="left">Service</Th>
            <Th align="right">$/Sale</Th>
            {clerks.map((c) => <Th key={c.id} align="right">{c.name}</Th>)}
            <Th align="right" emphasis>Team</Th>
            <Th align="right">Benchmark</Th>
          </tr>
        </thead>
        <tbody>
          {services.map((s) => (
            <tr key={s.slug}>
              <Td>{s.label}</Td>
              <Td align="right">${s.commPerSale}</Td>
              {clerks.map((c) => (
                <Td key={c.id} align="right" heat={heatColor(c.attach[s.slug])}>
                  {pct(c.attach[s.slug])}
                </Td>
              ))}
              <Td align="right" heat={heatColor(team.attach[s.slug])} emphasis>
                {pct(team.attach[s.slug])}
              </Td>
              <Td align="right" muted>{s.benchmark}</Td>
            </tr>
          ))}
        </tbody>
      </Table>
    </section>
  );
}

function CounterDollars({ team, services }) {
  const rows = services.map((s) => {
    const dollars = Number(team.serviceDollars[s.slug] || 0);
    const count = Number(team.serviceCounts[s.slug] || 0);
    return { service: s.label, dollars, count, avg: count > 0 ? dollars / count : 0 };
  });
  const total$ = rows.reduce((acc, r) => acc + r.dollars, 0);
  const totalCnt = rows.reduce((acc, r) => acc + r.count, 0);
  return (
    <section style={{ marginBottom: 22 }}>
      <SectionHeader>Counter $ generated per service (team)</SectionHeader>
      <Table>
        <thead>
          <tr>
            <Th align="left">Service</Th>
            <Th align="right">Counter $</Th>
            <Th align="right">Sales</Th>
            <Th align="right">Avg $/Sale</Th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.service}>
              <Td>{r.service}</Td>
              <Td align="right">{money(r.dollars)}</Td>
              <Td align="right">{int(r.count)}</Td>
              <Td align="right">{money(r.avg)}</Td>
            </tr>
          ))}
          <tr style={{ background: '#f1efe8' }}>
            <Td emphasis>TOTAL</Td>
            <Td align="right" emphasis>{money(total$)}</Td>
            <Td align="right" emphasis>{int(totalCnt)}</Td>
            <Td align="right" emphasis>{money(totalCnt > 0 ? total$ / totalCnt : 0)}</Td>
          </tr>
        </tbody>
      </Table>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

function SectionHeader({ children }) {
  return (
    <div style={{ fontSize: 12, color: '#6f668f', fontWeight: 500, marginBottom: 8, textTransform: 'uppercase' }}>
      {children}
    </div>
  );
}

function Table({ children }) {
  return (
    <div style={{
      border: '0.5px solid #d3d1c7', borderRadius: 8, overflow: 'hidden',
      background: 'white',
    }}>
      <table style={{ width: '100%', fontSize: 13, borderCollapse: 'collapse' }}>{children}</table>
    </div>
  );
}

function Th({ children, align = 'left', emphasis }) {
  return (
    <th style={{
      textAlign: align,
      padding: '8px 12px',
      fontWeight: 500,
      background: emphasis ? '#EEEDFE' : '#f1efe8',
      color: emphasis ? '#26215C' : '#211a38',
      borderBottom: '0.5px solid #d3d1c7',
    }}>{children}</th>
  );
}

function Td({ children, align = 'left', heat, emphasis, muted }) {
  return (
    <td style={{
      textAlign: align,
      padding: '6px 12px',
      borderTop: '0.5px solid #d3d1c7',
      background: heat || undefined,
      fontWeight: emphasis ? 500 : 400,
      color: muted ? '#6f668f' : (emphasis ? '#211a38' : undefined),
      fontSize: muted ? 12 : 13,
    }}>{children}</td>
  );
}

function Pill({ bg, fg, children }) {
  return (
    <span style={{
      display: 'inline-block', background: bg, color: fg, padding: '1px 8px',
      borderRadius: 4, marginRight: 6, fontSize: 11,
    }}>{children}</span>
  );
}

// ---------------------------------------------------------------------------
// Formatters
// ---------------------------------------------------------------------------

function num(v) { const n = Number(v); return Number.isFinite(n) ? n : 0; }
function int(v) { return num(v).toLocaleString(); }
function money(v) { return `$${num(v).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`; }
function pct(v) { return `${(num(v) * 100).toFixed(0)}%`; }
function heatColor(attachFrac) {
  const p = num(attachFrac);
  if (p >= 0.6) return '#C0DD97';
  if (p >= 0.3) return '#FAC775';
  return '#F7C1C1';
}
