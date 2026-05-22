'use client';

/**
 * Rental Agent Track Record — Month over Month — Round 24c (2026-05-22).
 *
 * Sections:
 *   1. Monthly snapshot — team totals row-per-month
 *   2. Per-clerk track records — one section per clerk
 *   3. Attach % heatmap — team-level, with Δ first→last
 */

import { useEffect, useState } from 'react';
import { AuthGate } from '../../../components/AuthGate';
import { AppShell } from '../../../components/AppShell';
import { api } from '../../../lib/client';
import { ReportPageLayout } from '../../../components/reports/ReportPageLayout';

export default function Page() {
  return <AuthGate>{({ token, me, logout }) => <TrackRecordReport token={token} me={me} logout={logout} />}</AuthGate>;
}

function TrackRecordReport({ token, me, logout }) {
  const [range, setRange] = useState(() => {
    // Default: last 5 calendar months ending today
    const t = new Date();
    const from = new Date(t.getFullYear(), t.getMonth() - 4, 1);
    return { from: from.toISOString().slice(0, 10), to: t.toISOString().slice(0, 10) };
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
          `/api/reports/agent-track-record?from=${range.from}&to=${range.to}`,
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
        slug="agent-track-record"
        title="Rental Agent Track Record — Month over Month"
        description="Multi-month performance trends + attach drift."
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

function ReportBody({ data }) {
  const { teamMonthly, teamTotal, clerks, teamAttach, monthLabels } = data;
  return (
    <div>
      <TeamMonthlySnapshot teamMonthly={teamMonthly} teamTotal={teamTotal} />
      <AvgDollarsTrend teamMonthly={teamMonthly} />
      {clerks.map((cl) => <ClerkTrackRecord key={cl.id} clerk={cl} />)}
      <AttachHeatmap rows={teamAttach} monthLabels={monthLabels} />
    </div>
  );
}

function TeamMonthlySnapshot({ teamMonthly, teamTotal }) {
  return (
    <section style={{ marginBottom: 22 }}>
      <SectionHeader>Monthly snapshot — team</SectionHeader>
      <Table>
        <thead>
          <tr>
            <Th align="left">Month</Th>
            <Th align="right">Rentals</Th>
            <Th align="right">Days</Th>
            <Th align="right">Counter $</Th>
            <Th align="right">Avg $/Rental</Th>
            <Th align="right">Commissions</Th>
            <Th align="right">Comm $/Rental</Th>
          </tr>
        </thead>
        <tbody>
          {teamMonthly.map((m) => (
            <tr key={m.month}>
              <Td>{m.monthLabel}</Td>
              <Td align="right">{int(m.rentals)}</Td>
              <Td align="right">{int(m.totalDays)}</Td>
              <Td align="right">{money(m.counterDollars)}</Td>
              <Td align="right">{money(m.avgDollarsPerRental)}</Td>
              <Td align="right">{money(m.commissions)}</Td>
              <Td align="right">{money(m.commissionPerRental)}</Td>
            </tr>
          ))}
          <tr style={{ background: '#f1efe8' }}>
            <Td emphasis>Total</Td>
            <Td align="right" emphasis>{int(teamTotal.rentals)}</Td>
            <Td align="right" emphasis>{int(teamTotal.totalDays)}</Td>
            <Td align="right" emphasis>{money(teamTotal.counterDollars)}</Td>
            <Td align="right" emphasis>{money(teamTotal.avgDollarsPerRental)}</Td>
            <Td align="right" emphasis>{money(teamTotal.commissions)}</Td>
            <Td align="right" emphasis>{money(teamTotal.commissionPerRental)}</Td>
          </tr>
        </tbody>
      </Table>
    </section>
  );
}

function AvgDollarsTrend({ teamMonthly }) {
  if (!teamMonthly.length) return null;
  const values = teamMonthly.map((m) => m.avgDollarsPerRental || 0);
  const max = Math.max(...values, 0);
  const min = Math.min(...values, 0);
  // SVG layout
  const W = 600, H = 180;
  const PAD_L = 40, PAD_R = 20, PAD_T = 20, PAD_B = 30;
  const innerW = W - PAD_L - PAD_R;
  const innerH = H - PAD_T - PAD_B;
  const x = (i) => PAD_L + (values.length === 1 ? innerW / 2 : (i / (values.length - 1)) * innerW);
  const y = (v) => {
    if (max === min) return PAD_T + innerH / 2;
    return PAD_T + (1 - (v - min) / (max - min)) * innerH;
  };
  const pts = values.map((v, i) => `${x(i)},${y(v)}`).join(' ');
  const first = values[0] || 0;
  const last = values[values.length - 1] || 0;
  const dropPct = first > 0 ? ((last - first) / first) * 100 : 0;
  return (
    <section style={{ marginBottom: 22 }}>
      <SectionHeader>Avg $/rental trend</SectionHeader>
      <div style={{ background: 'white', border: '0.5px solid #d3d1c7', borderRadius: 8, padding: 16 }}>
        <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', height: H }} aria-label="Avg dollars per rental trend">
          <line x1={PAD_L} y1={PAD_T} x2={PAD_L} y2={PAD_T + innerH} stroke="#888780" strokeWidth="0.5" />
          <line x1={PAD_L} y1={PAD_T + innerH} x2={W - PAD_R} y2={PAD_T + innerH} stroke="#888780" strokeWidth="0.5" />
          <polyline points={pts} fill="none" stroke="#534AB7" strokeWidth="2.5" />
          {values.map((v, i) => (
            <g key={i}>
              <circle cx={x(i)} cy={y(v)} r="4" fill="#534AB7" />
              <text x={x(i)} y={H - 10} textAnchor="middle" fontSize="10" fill="#5F5E5A">{teamMonthly[i].monthLabel}</text>
            </g>
          ))}
          <text x={x(0)} y={y(first) - 10} textAnchor="middle" fontSize="11" fill="#26215C" fontWeight="500">${first.toFixed(0)}</text>
          <text x={x(values.length - 1)} y={y(last) - 10} textAnchor="middle" fontSize="11" fill={dropPct < 0 ? '#A32D2D' : '#173404'} fontWeight="500">
            ${last.toFixed(0)} {dropPct ? (dropPct < 0 ? `▼ ${Math.abs(dropPct).toFixed(0)}%` : `▲ ${dropPct.toFixed(0)}%`) : ''}
          </text>
        </svg>
      </div>
    </section>
  );
}

function ClerkTrackRecord({ clerk }) {
  return (
    <section style={{ marginBottom: 22 }}>
      <SectionHeader>{clerk.name} — track record</SectionHeader>
      <Table>
        <thead>
          <tr>
            <Th align="left">Month</Th>
            <Th align="right">Rentals</Th>
            <Th align="right">Counter $</Th>
            <Th align="right">Commissions</Th>
            <Th align="right">% of Team rentals</Th>
          </tr>
        </thead>
        <tbody>
          {clerk.monthly.map((m) => (
            <tr key={m.month}>
              <Td>{m.monthLabel}</Td>
              <Td align="right">{int(m.rentals)}</Td>
              <Td align="right">{money(m.counterDollars)}</Td>
              <Td align="right">{money(m.commissions)}</Td>
              <Td align="right">{pct(m.shareOfTeamRentals)}</Td>
            </tr>
          ))}
          <tr style={{ background: '#f1efe8' }}>
            <Td emphasis>Total</Td>
            <Td align="right" emphasis>{int(clerk.total.rentals)}</Td>
            <Td align="right" emphasis>{money(clerk.total.counterDollars)}</Td>
            <Td align="right" emphasis>{money(clerk.total.commissions)}</Td>
            <Td align="right" emphasis>{pct(clerk.total.shareOfTeamRentals)}</Td>
          </tr>
        </tbody>
      </Table>
    </section>
  );
}

function AttachHeatmap({ rows, monthLabels }) {
  return (
    <section style={{ marginBottom: 22 }}>
      <SectionHeader>Attach % heatmap — team, {monthLabels.length} months</SectionHeader>
      <div style={{ fontSize: 11, color: '#6f668f', marginBottom: 8 }}>
        Δ column shows drift first → last month.
      </div>
      <Table>
        <thead>
          <tr>
            <Th align="left">Service</Th>
            {monthLabels.map((m) => <Th key={m} align="right">{m}</Th>)}
            <Th align="right">Δ</Th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.slug}>
              <Td>{row.label}</Td>
              {row.byMonth.map((p, i) => (
                <Td key={i} align="right" heat={heatColor(p)}>{pct(p)}</Td>
              ))}
              <Td align="right" deltaColor={row.delta}>{deltaText(row.delta)}</Td>
            </tr>
          ))}
        </tbody>
      </Table>
    </section>
  );
}

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
    <div style={{ border: '0.5px solid #d3d1c7', borderRadius: 8, overflow: 'hidden', background: 'white' }}>
      <table style={{ width: '100%', fontSize: 13, borderCollapse: 'collapse' }}>{children}</table>
    </div>
  );
}

function Th({ children, align = 'left' }) {
  return (
    <th style={{
      textAlign: align, padding: '8px 12px', fontWeight: 500,
      background: '#f1efe8', borderBottom: '0.5px solid #d3d1c7',
    }}>{children}</th>
  );
}

function Td({ children, align = 'left', heat, emphasis, deltaColor }) {
  let color;
  if (deltaColor !== undefined) {
    const d = num(deltaColor);
    color = d < 0 ? '#A32D2D' : (d > 0 ? '#173404' : '#5F5E5A');
  }
  return (
    <td style={{
      textAlign: align, padding: '6px 12px',
      borderTop: '0.5px solid #d3d1c7',
      background: heat || undefined,
      fontWeight: emphasis ? 500 : 400,
      color,
    }}>{children}</td>
  );
}

function num(v) { const n = Number(v); return Number.isFinite(n) ? n : 0; }
function int(v) { return num(v).toLocaleString(); }
function money(v) { return `$${num(v).toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`; }
function pct(v) { return `${(num(v) * 100).toFixed(0)}%`; }
function heatColor(p) {
  const n = num(p);
  if (n >= 0.6) return '#C0DD97';
  if (n >= 0.3) return '#FAC775';
  return '#F7C1C1';
}
function deltaText(d) {
  const n = num(d);
  const sign = n > 0 ? '+' : '';
  return `${sign}${(n * 100).toFixed(0)}%`;
}
