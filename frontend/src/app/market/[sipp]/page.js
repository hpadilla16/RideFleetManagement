/**
 * Market Intelligence — SIPP Class Detail (V1).
 *
 * Drill-down view from /market. Shows:
 *   - Breadcrumb back to dashboard
 *   - Header (SIPP code + label, vendor count, Configure-pricing CTA)
 *   - 4 stat cards (your price / median / cheapest / your rank — color-coded)
 *   - Big multi-line chart: median, p25-p75 band, your price, cheapest, top 2 vendors
 *   - Vendor leaderboard table with rank pills, 14d avg, 14d delta, coverage,
 *     and a "Chase →" link that preloads the Rate edit page rule builder.
 *
 * Backend endpoints:
 *   GET /api/market/summary?airport=SJU         (for the SIPP's stat-card data)
 *   GET /api/market/history?airport=SJU&sipp=IFAR&days=14  (chart + leaderboard)
 *
 * Auth: backend enforces ADMIN|OPS + module 'settings'. Frontend uses <AuthGate>
 * (no moduleKey prop — AuthGate doesn't accept one in this codebase).
 *
 * Theme: dark surface inside AppShell (matches mockup-sipp-detail.html).
 */
'use client';

import { useEffect, useMemo, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { Line } from 'react-chartjs-2';
import { AuthGate } from '../../../components/AuthGate';
import { AppShell } from '../../../components/AppShell';
import { api } from '../../../lib/client';
import { ensureChartsRegistered } from '../../../components/reports/charts/chartjs-setup';

ensureChartsRegistered();

const SIPP_LABELS = {
  ECAR: 'Economy',
  CCAR: 'Compact',
  ICAR: 'Mid-size',
  SCAR: 'Standard',
  FCAR: 'Fullsize',
  CFAR: 'Compact SUV',
  IFAR: 'Mid-size SUV',
  SFAR: 'Standard SUV',
  FFAR: 'Full-size SUV'
};

const TIME_PILLS = [
  { value: 7, label: '7d' },
  { value: 14, label: '14d' },
  { value: 30, label: '30d' },
  { value: 90, label: '90d' }
];

function fmtMoney(value) {
  if (value == null || Number.isNaN(Number(value))) return '—';
  return `$${Number(value).toFixed(2)}`;
}

function fmtPct(pct) {
  if (pct == null || Number.isNaN(Number(pct))) return '0.0%';
  const sign = pct > 0 ? '+' : '';
  return `${sign}${pct.toFixed(1)}%`;
}

/** Last-vs-first percent delta. */
function deltaPct(series) {
  if (!Array.isArray(series) || series.length < 2) return null;
  const first = Number(series[0]);
  const last = Number(series[series.length - 1]);
  if (!Number.isFinite(first) || !Number.isFinite(last) || first === 0) return null;
  return ((last - first) / first) * 100;
}

function avg(arr) {
  const nums = arr.filter((n) => Number.isFinite(Number(n))).map(Number);
  if (!nums.length) return null;
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}

export default function SippDetailPage() {
  return <AuthGate>{({ token, me, logout }) => <SippDetail token={token} me={me} logout={logout} />}</AuthGate>;
}

function SippDetail({ token, me, logout }) {
  const params = useParams();
  const router = useRouter();
  const sipp = String(params?.sipp || '').toUpperCase();
  const label = SIPP_LABELS[sipp] || `Class ${sipp}`;

  // V1: airport is always SJU. TODO: thread airport through the URL when
  // multi-airport ships (e.g. /market/[airport]/[sipp]).
  const airport = 'SJU';

  const [days, setDays] = useState(14);
  const [summaryRow, setSummaryRow] = useState(null);
  const [history, setHistory] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [modal, setModal] = useState('');

  useEffect(() => {
    if (!token || !sipp) return;
    let cancelled = false;
    setLoading(true);
    setError('');
    (async () => {
      try {
        const [sum, hist] = await Promise.all([
          api(`/api/market/summary?airport=${encodeURIComponent(airport)}`, { bypassCache: true }, token),
          api(`/api/market/history?airport=${encodeURIComponent(airport)}&sipp=${encodeURIComponent(sipp)}&days=${days}`, { bypassCache: true }, token)
        ]);
        if (cancelled) return;
        const row = (sum?.sipps || []).find((s) => s.sipp === sipp) || null;
        setSummaryRow(row);
        setHistory(hist);
      } catch (err) {
        if (!cancelled) setError(err?.message || 'Failed to load SIPP detail');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [token, sipp, airport, days]);

  function configureRule() {
    const rateId = summaryRow?.yourRate?.id;
    if (rateId) {
      // The rate pricing panel lives at /rates/[id]/pricing (there is no /edit route).
      router.push(`/rates/${encodeURIComponent(rateId)}/pricing`);
    } else {
      setModal('attach-rate');
    }
  }

  function chaseVendor(vendorName) {
    const rateId = summaryRow?.yourRate?.id;
    if (rateId) {
      router.push(`/rates/${encodeURIComponent(rateId)}/pricing?chase=${encodeURIComponent(vendorName)}`);
    } else {
      setModal('attach-rate');
    }
  }

  return (
    <AppShell me={me} logout={logout}>
      <DarkPanel>
        <Breadcrumbs sipp={sipp} label={label} airport={airport} onBack={() => router.push('/market')} />

        {error && (
          <div role="alert" style={{
            background: 'rgba(239,68,68,0.12)',
            border: '1px solid rgba(239,68,68,0.4)',
            color: '#fca5a5',
            padding: 12,
            borderRadius: 8,
            marginBottom: 16,
            fontSize: 13
          }}>{error}</div>
        )}

        <Header
          sipp={sipp}
          label={label}
          airport={airport}
          vendorCount={summaryRow?.vendorCount}
          onConfigureRule={configureRule}
        />

        {loading && !summaryRow ? (
          <DetailSkeleton />
        ) : (
          <>
            <Stats summaryRow={summaryRow} history={history} />
            <ChartCard
              history={history}
              summaryRow={summaryRow}
              days={days}
              onDaysChange={setDays}
              loading={loading}
            />
            <Leaderboard
              summaryRow={summaryRow}
              history={history}
              onChase={chaseVendor}
              days={days}
            />
          </>
        )}

        {modal === 'attach-rate' && (
          <Modal onClose={() => setModal('')}>
            <h3 style={{ marginTop: 0, color: '#e7ebf2' }}>Attach a Rate first</h3>
            <p style={{ color: '#8a93a6', fontSize: 14, lineHeight: 1.5 }}>
              No Rate is currently mapped to <strong>{sipp}</strong> at <strong>{airport}</strong>.
              Open <em>Market Intelligence settings</em> and link a Rate to this SIPP
              class so the pricing rule builder knows which RateDailyPrice to write.
            </p>
            <div style={{ marginTop: 16, display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
              <button
                onClick={() => setModal('')}
                style={{
                  background: '#1b1f29',
                  border: '1px solid #2a2f3d',
                  color: '#e7ebf2',
                  padding: '8px 14px',
                  borderRadius: 8,
                  cursor: 'pointer',
                  fontSize: 13
                }}
              >Close</button>
              <button
                onClick={() => router.push('/market-intelligence')}
                style={{
                  background: '#2563eb',
                  border: 'none',
                  color: '#fff',
                  padding: '8px 14px',
                  borderRadius: 8,
                  cursor: 'pointer',
                  fontSize: 13,
                  fontWeight: 600
                }}
              >Open settings →</button>
            </div>
          </Modal>
        )}
      </DarkPanel>
    </AppShell>
  );
}

// ---------------------------------------------------------------------------
// Breadcrumbs + header
// ---------------------------------------------------------------------------

function Breadcrumbs({ sipp, label, airport, onBack }) {
  return (
    <div style={{ fontSize: 13, color: '#6e7587', marginBottom: 14 }}>
      <a
        href="/market"
        onClick={(e) => { e.preventDefault(); onBack(); }}
        style={{ color: '#3b82f6', textDecoration: 'none', cursor: 'pointer' }}
      >Market Intelligence</a>
      {' / '}
      <a href="/market" onClick={(e) => { e.preventDefault(); onBack(); }} style={{ color: '#3b82f6', textDecoration: 'none', cursor: 'pointer' }}>{airport}</a>
      {' / '}
      <strong style={{ color: '#e7ebf2' }}>{sipp} — {label}</strong>
    </div>
  );
}

function Header({ sipp, label, airport, vendorCount, onConfigureRule }) {
  return (
    <div style={{
      display: 'flex',
      justifyContent: 'space-between',
      alignItems: 'flex-start',
      marginBottom: 22,
      gap: 12,
      flexWrap: 'wrap'
    }}>
      <div>
        <h1 style={{ margin: 0, fontSize: 28, fontWeight: 700, letterSpacing: '-0.4px', color: '#e7ebf2' }}>
          {sipp} — {label}
        </h1>
        <div style={{ color: '#8a93a6', fontSize: 14, marginTop: 4 }}>
          {airport === 'SJU' ? `San Juan (${airport})` : airport} · 14-day window · {vendorCount != null ? `${vendorCount} competing vendors observed` : 'vendor count loading…'}
        </div>
      </div>
      <button
        type="button"
        onClick={onConfigureRule}
        style={{
          background: '#2563eb',
          color: '#fff',
          border: 'none',
          padding: '10px 18px',
          borderRadius: 8,
          fontSize: 14,
          fontWeight: 600,
          cursor: 'pointer'
        }}
      >⚡ Configure pricing rule for this class</button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Stat cards
// ---------------------------------------------------------------------------

function Stats({ summaryRow, history }) {
  const yourPrice = summaryRow?.yourRate?.daily != null ? Number(summaryRow.yourRate.daily) : null;
  const median = summaryRow?.median != null ? Number(summaryRow.median) : null;
  const cheapest = summaryRow?.min != null ? Number(summaryRow.min) : null;
  const yourRank = summaryRow?.yourRank;
  const vendorCount = summaryRow?.vendorCount || 0;

  // 14d rank delta: compare yourRank today vs derived rank 14 days ago from
  // history.series[0] vendor distribution. V1 fallback: blank.
  // TODO: compute properly once history endpoint returns rank trail.

  const medianDelta = median != null && yourPrice != null ? (median - yourPrice) : null;

  // Rank color logic per spec: green=#1, yellow=tied, red>=5.
  let rankColor = '#fbbf24';
  if (yourRank == null) rankColor = '#6e7587';
  else if (yourRank === 1) rankColor = '#4ade80';
  else if (yourRank >= 5) rankColor = '#f87171';

  const cheapestIsYou = yourPrice != null && cheapest != null && Math.abs(yourPrice - cheapest) < 0.01;

  // Your-price 14d trend (flat in V1 since summary is snapshot-only).
  const yourPriceHint = 'Snapshot — historical changes not yet tracked';

  return (
    <div style={{
      display: 'grid',
      gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
      gap: 14,
      marginBottom: 22
    }}>
      <StatCard
        label="Your price"
        value={fmtMoney(yourPrice)}
        valueColor="#fbbf24"
        hint={yourPriceHint}
      />
      <StatCard
        label="Market median"
        value={fmtMoney(median)}
        hint={medianDelta != null
          ? (medianDelta >= 0 ? `+${fmtMoney(medianDelta)} vs you` : `−${fmtMoney(Math.abs(medianDelta))} vs you`)
          : '—'}
        hintCls={medianDelta == null ? 'flat' : medianDelta > 0 ? 'up' : 'down'}
      />
      <StatCard
        label="Cheapest in market"
        value={fmtMoney(cheapest)}
        hint={cheapestIsYou ? 'Advantage (tied with you)' : (cheapest != null && yourPrice != null ? `${fmtMoney(yourPrice - cheapest)} above you` : '—')}
        hintCls={cheapestIsYou ? 'flat' : 'down'}
      />
      <StatCard
        label="Your rank"
        value={yourRank != null ? `#${yourRank}` : '—'}
        valueColor={rankColor}
        hint={vendorCount ? `of ${vendorCount} vendors` : ''}
      />
    </div>
  );
}

function StatCard({ label, value, valueColor, hint, hintCls }) {
  const hintColor = hintCls === 'up' ? '#f87171' : hintCls === 'down' ? '#4ade80' : '#94a3b8';
  return (
    <div style={{
      background: '#161922',
      border: '1px solid #232838',
      padding: 16,
      borderRadius: 12
    }}>
      <div style={{ fontSize: 11, color: '#6e7587', textTransform: 'uppercase', letterSpacing: 0.8, marginBottom: 6 }}>{label}</div>
      <div style={{ fontSize: 24, fontWeight: 700, color: valueColor || '#e7ebf2' }}>{value}</div>
      {hint && <div style={{ fontSize: 12, marginTop: 4, color: hintColor }}>{hint}</div>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Chart card
// ---------------------------------------------------------------------------

function ChartCard({ history, summaryRow, days, onDaysChange, loading }) {
  const series = Array.isArray(history?.series) ? history.series : [];
  const vendors = history?.vendors || {};
  const yourPrice = summaryRow?.yourRate?.daily != null ? Number(summaryRow.yourRate.daily) : null;

  // Pick top 2 vendors by latest price (lowest first) — these become the extra
  // colored lines. Skip ourselves if our vendor name appears in the map.
  const topTwoVendors = useMemo(() => {
    const entries = Object.entries(vendors)
      .map(([name, points]) => {
        const last = Array.isArray(points) && points.length ? Number(points[points.length - 1]?.price) : null;
        return { name, points, last };
      })
      .filter((v) => v.last != null && Number.isFinite(v.last))
      .sort((a, b) => a.last - b.last);
    return entries.slice(0, 2);
  }, [vendors]);

  // Build a date label axis off the series.
  const labels = series.map((row) => {
    if (!row?.date) return '';
    const d = new Date(row.date);
    if (Number.isNaN(d.getTime())) return String(row.date).slice(5);
    return `${d.getMonth() + 1}/${d.getDate()}`;
  });

  // Align vendor series to the main label axis by date.
  //
  // NOTE: be careful — `Number(null)` returns 0 (a finite number) which would
  // cause days where a vendor was not observed to plot as $0 in the chart.
  // Keep nulls as nulls all the way through; Chart.js then skips them with
  // `spanGaps: true` set on each vendor dataset above.
  function vendorAlignedSeries(points) {
    const byDate = new Map(
      (points || []).map((p) => [
        String(p.date).slice(0, 10),
        p?.price == null ? null : Number(p.price),
      ]),
    );
    return series.map((row) => {
      const key = String(row?.date || '').slice(0, 10);
      const v = byDate.get(key);
      return v == null || !Number.isFinite(v) ? null : v;
    });
  }

  // Null-safe conversion — see vendorAlignedSeries above for the same gotcha.
  // A row with no observations could come back with null for these fields;
  // keep them null so Chart.js skips them when spanGaps:true is set.
  const toNumOrNull = (v) => (v == null ? null : Number(v));
  const p25 = series.map((row) => toNumOrNull(row.p25));
  const p75 = series.map((row) => toNumOrNull(row.p75));
  const median = series.map((row) => toNumOrNull(row.median));
  const cheap = series.map((row) => toNumOrNull(row.min));
  const yours = series.map(() => yourPrice);

  const vendorColors = ['#a855f7', '#10b981'];

  const datasets = [
    // Percentile band — render p75 with fill: '+1' so chart.js fills down to p25.
    {
      label: '75th percentile',
      data: p75,
      borderColor: 'transparent',
      backgroundColor: 'rgba(55,65,81,0.45)',
      fill: '+1',
      pointRadius: 0,
      tension: 0.3,
      order: 99
    },
    {
      label: '25th percentile',
      data: p25,
      borderColor: 'transparent',
      backgroundColor: 'transparent',
      fill: false,
      pointRadius: 0,
      tension: 0.3,
      order: 99
    },
    { label: 'Market median', data: median, borderColor: '#3b82f6', borderWidth: 2.5, pointRadius: 0, tension: 0.3, fill: false },
    { label: 'Your price', data: yours, borderColor: '#fbbf24', borderWidth: 2.5, borderDash: [6, 4], pointRadius: 0, tension: 0, fill: false, spanGaps: true },
    { label: 'Cheapest', data: cheap, borderColor: '#ef4444', borderWidth: 2, pointRadius: 0, tension: 0.3, fill: false },
    ...topTwoVendors.map((v, i) => ({
      label: v.name,
      data: vendorAlignedSeries(v.points),
      borderColor: vendorColors[i] || '#94a3b8',
      borderWidth: 1.5,
      pointRadius: 0,
      tension: 0.3,
      fill: false,
      spanGaps: true
    }))
  ];

  const data = { labels, datasets };

  const options = {
    responsive: true,
    maintainAspectRatio: false,
    interaction: { mode: 'index', intersect: false },
    plugins: {
      legend: { display: false },
      tooltip: {
        backgroundColor: '#0f1115',
        borderColor: '#374151',
        borderWidth: 1,
        callbacks: {
          label: (ctx) => {
            const v = ctx.parsed.y;
            return `${ctx.dataset.label}: ${Number.isFinite(v) ? '$' + v.toFixed(2) : '—'}`;
          }
        }
      }
    },
    scales: {
      x: { grid: { color: '#1f2530' }, ticks: { color: '#8a93a6', font: { size: 11 } } },
      y: { grid: { color: '#1f2530' }, ticks: { color: '#8a93a6', font: { size: 11 }, callback: (v) => `$${v}` } }
    }
  };

  return (
    <div style={{
      background: '#161922',
      border: '1px solid #232838',
      borderRadius: 14,
      padding: 22,
      marginBottom: 22
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14, flexWrap: 'wrap', gap: 8 }}>
        <div style={{ fontSize: 16, fontWeight: 600, color: '#e7ebf2' }}>
          Price history — last {days} days
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          {TIME_PILLS.map((p) => (
            <button
              key={p.value}
              type="button"
              onClick={() => onDaysChange(p.value)}
              style={{
                background: days === p.value ? '#2563eb' : '#1b1f29',
                borderColor: days === p.value ? '#2563eb' : '#2a2f3d',
                color: days === p.value ? '#fff' : '#c8cfe0',
                border: '1px solid',
                padding: '6px 12px',
                borderRadius: 6,
                fontSize: 12,
                cursor: 'pointer'
              }}
            >{p.label}</button>
          ))}
        </div>
      </div>
      <div style={{ height: 380, position: 'relative' }}>
        {series.length === 0 ? (
          <div style={{ height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#6e7587' }}>
            {loading ? 'Loading chart…' : 'No history yet for this SIPP.'}
          </div>
        ) : (
          <Line data={data} options={options} />
        )}
      </div>
      <div style={{ display: 'flex', gap: 18, marginTop: 12, fontSize: 12, color: '#8a93a6', flexWrap: 'wrap' }}>
        <LegendDot color="#fbbf24" label="Your price" />
        <LegendDot color="#3b82f6" label="Market median" />
        <LegendDot color="#374151" label="25th–75th percentile band" />
        <LegendDot color="#ef4444" label="Cheapest" />
        {topTwoVendors.map((v, i) => (
          <LegendDot key={v.name} color={vendorColors[i]} label={v.name} />
        ))}
      </div>
    </div>
  );
}

function LegendDot({ color, label }) {
  return (
    <div>
      <span style={{
        display: 'inline-block', width: 10, height: 10, borderRadius: '50%',
        marginRight: 6, verticalAlign: 'middle', background: color
      }} />
      {label}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Vendor leaderboard
// ---------------------------------------------------------------------------

function Leaderboard({ summaryRow, history, onChase, days = 14 }) {
  const yourPrice = summaryRow?.yourRate?.daily != null ? Number(summaryRow.yourRate.daily) : null;
  const yourRank = summaryRow?.yourRank;
  const vendors = history?.vendors || {};
  const series = Array.isArray(history?.series) ? history.series : [];
  const dayCount = series.length || 14;

  // Build per-vendor stats: current price (last in series), 14d avg, 14d Δ%,
  // coverage (days observed / dayCount).
  const rows = useMemo(() => {
    const items = Object.entries(vendors).map(([name, points]) => {
      const pricePoints = Array.isArray(points) ? points : [];
      // IMPORTANT: filter nulls BEFORE Number() — Number(null) === 0 (finite) would
      // otherwise inject a phantom $0 "current" and rank an unobserved vendor #1.
      const prices = pricePoints
        .filter((p) => p?.price != null && Number.isFinite(Number(p.price)))
        .map((p) => Number(p.price));
      const current = prices.length ? prices[prices.length - 1] : null;
      const avgPrice = avg(prices);
      const delta = deltaPct(prices);
      return {
        vendor: name,
        current,
        avg: avgPrice,
        delta,
        coverage: prices.length,
        coverageTotal: dayCount,
        isYou: false
      };
    }).filter((r) => r.current != null);

    // Inject your own row.
    if (yourPrice != null) {
      items.push({
        vendor: 'You (RideFleet)',
        current: yourPrice,
        avg: yourPrice,
        delta: 0,
        coverage: dayCount,
        coverageTotal: dayCount,
        isYou: true
      });
    }

    items.sort((a, b) => {
      if (a.current == null) return 1;
      if (b.current == null) return -1;
      return a.current - b.current;
    });

    // Compute display rank — ties share the rank number.
    let lastPrice = null;
    let lastRank = 0;
    items.forEach((row, idx) => {
      if (lastPrice != null && Math.abs(row.current - lastPrice) < 0.005) {
        row.rank = lastRank;
      } else {
        row.rank = idx + 1;
        lastRank = idx + 1;
      }
      lastPrice = row.current;
    });

    return items;
  }, [vendors, yourPrice, dayCount]);

  return (
    <div style={{
      background: '#161922',
      border: '1px solid #232838',
      borderRadius: 14,
      padding: 22
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
        <div style={{ fontSize: 16, fontWeight: 600, color: '#e7ebf2' }}>Vendor leaderboard</div>
        <div style={{ fontSize: 12, color: '#6e7587' }}>Sorted by current price</div>
      </div>

      {rows.length === 0 ? (
        <div style={{ padding: 24, textAlign: 'center', color: '#6e7587', fontSize: 13 }}>
          No vendor history yet for this SIPP.
        </div>
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr>
                <Th>#</Th>
                <Th>Vendor</Th>
                <Th>Current</Th>
                <Th>{days}d avg</Th>
                <Th>{days}d Δ</Th>
                <Th>Coverage</Th>
                <Th>Action</Th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row, i) => (
                <tr
                  key={`${row.vendor}-${i}`}
                  style={{
                    background: row.isYou ? 'rgba(251,191,36,0.06)' : 'transparent',
                    borderBottom: '1px solid #1c2030'
                  }}
                >
                  <Td><RankPill rank={row.rank} isYou={row.isYou} isYourRankFromSummary={row.isYou ? yourRank : null} /></Td>
                  <Td><span style={{ fontWeight: 600, color: row.isYou ? '#fbbf24' : '#e7ebf2' }}>{row.vendor}</span></Td>
                  <Td>{fmtMoney(row.current)}</Td>
                  <Td>{fmtMoney(row.avg)}</Td>
                  <Td><DeltaCell pct={row.delta} /></Td>
                  <Td>{row.coverage}/{row.coverageTotal} days</Td>
                  <Td>
                    {row.isYou ? (
                      <a
                        href="#edit-rate"
                        onClick={(e) => { e.preventDefault(); onChase(row.vendor); }}
                        style={{ color: '#3b82f6', textDecoration: 'none' }}
                      >Edit rate →</a>
                    ) : (
                      <a
                        href="#chase"
                        onClick={(e) => { e.preventDefault(); onChase(row.vendor); }}
                        style={{ color: '#3b82f6', textDecoration: 'none' }}
                      >Chase →</a>
                    )}
                  </Td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function Th({ children }) {
  return (
    <th style={{
      textAlign: 'left',
      padding: '10px 12px',
      color: '#8a93a6',
      fontWeight: 600,
      borderBottom: '1px solid #232838',
      fontSize: 11,
      textTransform: 'uppercase',
      letterSpacing: 0.8,
      whiteSpace: 'nowrap'
    }}>{children}</th>
  );
}

function Td({ children }) {
  return (
    <td style={{ padding: 12, color: '#e7ebf2', whiteSpace: 'nowrap' }}>{children}</td>
  );
}

function RankPill({ rank, isYou }) {
  const base = {
    display: 'inline-block',
    width: 28,
    height: 28,
    borderRadius: '50%',
    lineHeight: '28px',
    textAlign: 'center',
    fontWeight: 700,
    fontSize: 12,
    background: '#1b1f29',
    border: '1px solid #2a2f3d',
    color: '#c8cfe0'
  };
  if (isYou) {
    return <span style={{ ...base, background: 'rgba(251,191,36,0.2)', color: '#fbbf24', borderColor: 'rgba(251,191,36,0.4)' }}>{rank}</span>;
  }
  if (rank === 1) {
    return <span style={{ ...base, background: 'rgba(34,197,94,0.15)', color: '#4ade80', borderColor: 'rgba(74,222,128,0.2)' }}>{rank}</span>;
  }
  return <span style={base}>{rank}</span>;
}

function DeltaCell({ pct }) {
  if (pct == null) return <span style={{ color: '#94a3b8' }}>—</span>;
  const cls = pct > 0.1 ? 'up' : pct < -0.1 ? 'down' : 'flat';
  const color = cls === 'up' ? '#f87171' : cls === 'down' ? '#4ade80' : '#94a3b8';
  return <span style={{ color, fontWeight: cls === 'flat' ? 400 : 600 }}>{fmtPct(pct)}</span>;
}

// ---------------------------------------------------------------------------
// Modal + skeleton + dark panel
// ---------------------------------------------------------------------------

function Modal({ children, onClose }) {
  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(15,17,21,0.7)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 100
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: '#161922',
          border: '1px solid #232838',
          borderRadius: 12,
          padding: 24,
          width: 460,
          maxWidth: '90vw'
        }}
      >{children}</div>
    </div>
  );
}

function DetailSkeleton() {
  const shimmer = {
    background: 'linear-gradient(90deg, #1b1f29 0%, #232838 50%, #1b1f29 100%)',
    backgroundSize: '200% 100%',
    borderRadius: 8,
    animation: 'rfm-detail-shimmer 1.4s ease-in-out infinite'
  };
  return (
    <div aria-busy="true">
      <style>{`@keyframes rfm-detail-shimmer { 0% { background-position: 200% 0; } 100% { background-position: -200% 0; } }`}</style>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 14, marginBottom: 22 }}>
        {[0, 1, 2, 3].map((i) => <div key={i} style={{ ...shimmer, height: 90 }} />)}
      </div>
      <div style={{ ...shimmer, height: 420, marginBottom: 22 }} />
      <div style={{ ...shimmer, height: 280 }} />
    </div>
  );
}

function DarkPanel({ children }) {
  return (
    <div style={{
      background: '#0f1115',
      color: '#e7ebf2',
      padding: 24,
      minHeight: 'calc(100vh - 120px)',
      fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'
    }}>{children}</div>
  );
}
