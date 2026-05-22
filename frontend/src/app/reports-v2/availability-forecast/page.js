'use client';

/**
 * Availability Forecast per Vehicle Type — Round 24d (2026-05-22).
 *
 * Sections:
 *   1. Snapshot strip — fleet capacity · utilization · peak day · sold-out count
 *   2. Heat-grid table: vehicle types × days, cells colored by availability
 *   3. Demand pressure bar chart — daily fleet utilization
 */

import { useEffect, useState } from 'react';
import { AuthGate } from '../../../components/AuthGate';
import { AppShell } from '../../../components/AppShell';
import { api } from '../../../lib/client';
import { ReportPageLayout } from '../../../components/reports/ReportPageLayout';

export default function Page() {
  return <AuthGate>{({ token, me, logout }) => <ForecastReport token={token} me={me} logout={logout} />}</AuthGate>;
}

function ForecastReport({ token, me, logout }) {
  const [range, setRange] = useState(() => {
    const t = new Date();
    const to = new Date(t.getTime() + 13 * 24 * 60 * 60 * 1000);
    return { from: t.toISOString().slice(0, 10), to: to.toISOString().slice(0, 10) };
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
          `/api/reports/availability-forecast?from=${range.from}&to=${range.to}`,
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

  // Custom presets for forecast (future-leaning)
  const presets = [
    { label: 'Next 7 days',  compute: () => { const t = new Date(); const to = new Date(t.getTime() + 7 * 86400000); return { from: t.toISOString().slice(0,10), to: to.toISOString().slice(0,10) }; } },
    { label: 'Next 14 days', compute: () => { const t = new Date(); const to = new Date(t.getTime() + 14 * 86400000); return { from: t.toISOString().slice(0,10), to: to.toISOString().slice(0,10) }; } },
    { label: 'Next 30 days', compute: () => { const t = new Date(); const to = new Date(t.getTime() + 30 * 86400000); return { from: t.toISOString().slice(0,10), to: to.toISOString().slice(0,10) }; } },
  ];

  return (
    <AppShell me={me} logout={logout}>
      <ReportPageLayout
        slug="availability-forecast"
        title="Availability Forecast — per Vehicle Type"
        description="Day-by-day projected inventory based on confirmed bookings."
        category="Fleet"
        token={token}
        range={range}
        onRangeChange={setRange}
        presets={presets}
      >
        {loading && !data ? (
          <div style={{ padding: 60, textAlign: 'center', color: '#6f668f' }}>Loading forecast…</div>
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
  const { days, fleet, types, truncated } = data;
  return (
    <div>
      {truncated ? (
        <div style={{ background: '#FAEEDA', color: '#412402', padding: 10, borderRadius: 8, marginBottom: 12, fontSize: 12 }}>
          Range capped at 60 days — narrow the date window to see more detail.
        </div>
      ) : null}
      <SnapshotStrip fleet={fleet} />
      <HeatGrid days={days} types={types} fleet={fleet} />
      <DemandChart fleet={fleet} days={days} />
    </div>
  );
}

function SnapshotStrip({ fleet }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 10, marginBottom: 22 }}>
      <Card label="Fleet capacity" value={String(fleet.capacity)} />
      <Card label="Period utilization" value={`${fleet.utilizationPct}%`} />
      <Card
        label="Peak demand day"
        value={fleet.peakDay.label}
        valueSize={14}
        hint={`${fleet.peakDay.reserved}/${fleet.capacity} booked (${fleet.capacity > 0 ? Math.round(fleet.peakDay.reserved / fleet.capacity * 100) : 0}%)`}
        bg="#FAEEDA"
        fg="#412402"
      />
      <Card
        label="Sold-out days"
        value={String(fleet.soldOutDayCount)}
        hint="any vehicle type at 0"
        bg={fleet.soldOutDayCount > 0 ? '#FCEBEB' : undefined}
        fg={fleet.soldOutDayCount > 0 ? '#501313' : undefined}
      />
    </div>
  );
}

function Card({ label, value, hint, valueSize, bg, fg }) {
  return (
    <div style={{ background: bg || '#f1efe8', padding: '12px 14px', borderRadius: 8, color: fg }}>
      <div style={{ fontSize: 12, color: fg || '#6f668f' }}>{label}</div>
      <div style={{ fontSize: valueSize || 22, fontWeight: 500, marginTop: 2, color: fg || '#211a38' }}>{value}</div>
      {hint ? <div style={{ fontSize: 11, color: fg || '#6f668f', marginTop: 2 }}>{hint}</div> : null}
    </div>
  );
}

function HeatGrid({ days, types, fleet }) {
  if (types.length === 0) {
    return (
      <div style={{ padding: 40, textAlign: 'center', color: '#6f668f', background: '#f1efe8', borderRadius: 8 }}>
        No vehicle types configured for this tenant.
      </div>
    );
  }
  return (
    <section style={{ marginBottom: 22 }}>
      <SectionHeader>Daily available by vehicle type</SectionHeader>
      <div style={{ fontSize: 11, color: '#6f668f', marginBottom: 8 }}>
        Cell value = units still available ·
        <Pill bg="#C0DD97" fg="#173404">green ≥50%</Pill>
        <Pill bg="#FAC775" fg="#412402">amber 20–50%</Pill>
        <Pill bg="#F7C1C1" fg="#501313">red &lt;20%</Pill>
        <Pill bg="#501313" fg="white">black sold out</Pill>
      </div>
      <div style={{ border: '0.5px solid #d3d1c7', borderRadius: 8, overflowX: 'auto', background: 'white' }}>
        <table style={{ width: '100%', fontSize: 12, borderCollapse: 'collapse', minWidth: 700 }}>
          <thead>
            <tr style={{ background: '#f1efe8' }}>
              <Th align="left" stickyLeft>Vehicle type</Th>
              <Th align="center">Fleet</Th>
              {days.map((d) => <Th key={d.iso} align="center" small>{d.label}</Th>)}
            </tr>
          </thead>
          <tbody>
            {types.map((t) => (
              <tr key={t.id}>
                <Td stickyLeft>
                  <div style={{ fontWeight: 500 }}>{t.name}</div>
                  <div style={{ fontSize: 10, color: '#6f668f' }}>{t.code}</div>
                </Td>
                <Td align="center" muted>{t.capacity}</Td>
                {t.availableByDay.map((av, i) => (
                  <Td key={i} align="center" heat={heatColor(av, t.capacity)} fg={av === 0 && t.capacity > 0 ? 'white' : undefined} bold={av === 0 && t.capacity > 0}>
                    {av}
                  </Td>
                ))}
              </tr>
            ))}
            <tr style={{ background: '#f1efe8' }}>
              <Td stickyLeft emphasis>Fleet total</Td>
              <Td align="center" emphasis>{fleet.capacity}</Td>
              {fleet.availableByDay.map((av, i) => (
                <Td key={i} align="center" emphasis>{av}</Td>
              ))}
            </tr>
          </tbody>
        </table>
      </div>
    </section>
  );
}

function DemandChart({ fleet, days }) {
  if (!days.length || fleet.capacity === 0) return null;
  const W = 600, H = 180;
  const PAD_L = 40, PAD_R = 20, PAD_T = 20, PAD_B = 40;
  const innerW = W - PAD_L - PAD_R;
  const innerH = H - PAD_T - PAD_B;
  const barGap = 4;
  const barW = Math.max(8, (innerW / days.length) - barGap);
  const utilByDay = fleet.reservedByDay.map((r) => r / fleet.capacity);
  let peakIdx = 0;
  for (let i = 1; i < utilByDay.length; i++) if (utilByDay[i] > utilByDay[peakIdx]) peakIdx = i;
  return (
    <section style={{ marginBottom: 22 }}>
      <SectionHeader>Demand pressure — daily utilization</SectionHeader>
      <div style={{ background: 'white', border: '0.5px solid #d3d1c7', borderRadius: 8, padding: 16 }}>
        <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', height: H }} aria-label="Daily utilization">
          <line x1={PAD_L} y1={PAD_T} x2={PAD_L} y2={PAD_T + innerH} stroke="#888780" strokeWidth="0.5" />
          <line x1={PAD_L} y1={PAD_T + innerH} x2={W - PAD_R} y2={PAD_T + innerH} stroke="#888780" strokeWidth="0.5" />
          <line x1={PAD_L} y1={PAD_T} x2={W - PAD_R} y2={PAD_T} stroke="#A32D2D" strokeWidth="0.5" strokeDasharray="3,3" />
          <text x={W - PAD_R + 2} y={PAD_T + 3} fontSize="9" fill="#A32D2D">100%</text>
          <text x={PAD_L - 4} y={PAD_T + 5} textAnchor="end" fontSize="10" fill="#888780">100%</text>
          <text x={PAD_L - 4} y={PAD_T + innerH / 2} textAnchor="end" fontSize="10" fill="#888780">50%</text>
          <text x={PAD_L - 4} y={PAD_T + innerH + 4} textAnchor="end" fontSize="10" fill="#888780">0%</text>
          {utilByDay.map((u, i) => {
            const x = PAD_L + i * (barW + barGap);
            const h = u * innerH;
            const y = PAD_T + innerH - h;
            const peak = i === peakIdx;
            return (
              <g key={i}>
                <rect x={x} y={y} width={barW} height={h} fill={peak ? '#A32D2D' : (u >= 0.75 ? '#534AB7' : '#7F77DD')} />
                {peak && h > 18 ? (
                  <text x={x + barW / 2} y={y + 12} textAnchor="middle" fontSize="10" fill="white" fontWeight="500">{Math.round(u * 100)}%</text>
                ) : null}
                <text x={x + barW / 2} y={H - 18} textAnchor="middle" fontSize="9" fill={peak ? '#A32D2D' : '#5F5E5A'} fontWeight={peak ? 500 : 400}>
                  {days[i].label.split(' ').slice(1).join(' ')}
                </text>
              </g>
            );
          })}
        </svg>
      </div>
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

function Th({ children, align = 'left', stickyLeft, small }) {
  return (
    <th style={{
      textAlign: align,
      padding: small ? '6px 4px' : '8px 12px',
      fontWeight: 500,
      fontSize: small ? 11 : 13,
      whiteSpace: small ? 'nowrap' : undefined,
      borderBottom: '0.5px solid #d3d1c7',
      ...(stickyLeft ? { position: 'sticky', left: 0, background: '#f1efe8', zIndex: 1, minWidth: 130 } : {}),
    }}>{children}</th>
  );
}

function Td({ children, align = 'left', heat, emphasis, muted, fg, bold, stickyLeft }) {
  return (
    <td style={{
      textAlign: align,
      padding: '6px 8px',
      borderTop: '0.5px solid #d3d1c7',
      background: heat || undefined,
      fontWeight: (emphasis || bold) ? 500 : 400,
      color: fg || (muted ? '#6f668f' : undefined),
      fontSize: 12,
      ...(stickyLeft ? { position: 'sticky', left: 0, background: heat || 'white', zIndex: 1 } : {}),
    }}>{children}</td>
  );
}

function Pill({ bg, fg, children }) {
  return (
    <span style={{
      display: 'inline-block', background: bg, color: fg, padding: '1px 6px',
      borderRadius: 4, marginLeft: 6, fontSize: 10,
    }}>{children}</span>
  );
}

function heatColor(available, capacity) {
  if (capacity <= 0) return undefined;
  if (available === 0) return '#501313';
  const pct = available / capacity;
  if (pct < 0.2) return '#F7C1C1';
  if (pct < 0.5) return '#FAC775';
  return '#C0DD97';
}
