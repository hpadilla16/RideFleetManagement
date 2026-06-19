/**
 * Market Intelligence — Dashboard (V1).
 *
 * Stock-market-style grid: one card per SIPP class showing your price, the
 * market median, the cheapest competitor, a 14-day sparkline, and your rank.
 *
 * Backend endpoints (both tenant-scoped, read-only):
 *   GET /api/market/summary?airport=SJU
 *     → { airport, sipps: [{ sipp, median, min, max, vendorCount,
 *         topVendors:[{vendor,price}], yourRate:{id,code,daily}|null,
 *         yourRank:int|null }], updatedAt }
 *
 *   GET /api/market/history?airport=SJU&sipp=IFAR&days=14
 *     → { airport, sipp, days, series:[{date,min,p25,median,p75,max,
 *         vendorCount}], vendors:{ "Hertz":[{date,price}], ... } }
 *
 * Auth: backend requires requireRole(ADMIN, OPS) + moduleAccess('settings').
 * Frontend gates with <AuthGate> (matches /market-intelligence pattern —
 * AuthGate itself takes no moduleKey prop; module gating is nav-display
 * only and the backend is the source of truth).
 *
 * NOTE on theme: the rest of the app uses a light theme inside AppShell.
 * The mockup specifies a dark surface (#0f1115). We render the dark theme
 * inside the AppShell content area as a self-contained "panel". This matches
 * what reports-v2 does with its own internal color scheme.
 *
 * V1 scope deviations from mockup:
 *   - Date-range pills (7d / 14d / 30d) are local state only and we always
 *     pass days=14 to the history endpoint for the sparklines. The summary
 *     endpoint returns "latest snapshot" regardless of pill state.
 *   - "Sort by" dropdown is rendered but is local-only (no reorder yet).
 *   - "+ Add airport" button is a no-op placeholder.
 *   - SIPP → label map is static — derived from the standard ACRISS codes.
 *     For SIPPs returned by the API but not in our static list, we fall back
 *     to "Class {code}".
 */
'use client';

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Line } from 'react-chartjs-2';
import { AuthGate } from '../../components/AuthGate';
import { AppShell } from '../../components/AppShell';
import { api, API_BASE } from '../../lib/client';
import { ensureChartsRegistered } from '../../components/reports/charts/chartjs-setup';

ensureChartsRegistered();

// Standard ACRISS SIPP → human label. Used for card subtitle + empty-state
// cards. Order here drives the V1 card display order (mockup spec).
const SIPP_ORDER = ['ECAR', 'CCAR', 'ICAR', 'SCAR', 'FCAR', 'CFAR', 'IFAR', 'SFAR', 'FFAR'];
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

const RANGE_PILLS = [
  { value: 7, label: '7d' },
  { value: 14, label: '14d' },
  { value: 30, label: '30d' }
];

function fmtMoney(value) {
  if (value == null || Number.isNaN(Number(value))) return '—';
  return `$${Number(value).toFixed(2)}`;
}

function fmtTimestamp(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  return d.toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' });
}

/** Compute the last-vs-first percentage delta from a series of {date, price}. */
function computeDeltaPct(series) {
  if (!Array.isArray(series) || series.length < 2) return null;
  const first = Number(series[0]?.price);
  const last = Number(series[series.length - 1]?.price);
  if (!Number.isFinite(first) || !Number.isFinite(last) || first === 0) return null;
  return ((last - first) / first) * 100;
}

export default function MarketDashboardPage() {
  return <AuthGate>{({ token, me, logout }) => <Dashboard token={token} me={me} logout={logout} />}</AuthGate>;
}

function Dashboard({ token, me, logout }) {
  const router = useRouter();
  const [airport, setAirport] = useState('SJU');
  const [rangeDays, setRangeDays] = useState(14);
  const [summary, setSummary] = useState(null);
  const [historiesBySipp, setHistoriesBySipp] = useState({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [sortBy, setSortBy] = useState('biggest_move');
  // Lightweight count of PENDING pricing suggestions for the topbar badge. We
  // poll every 60s — the inbox itself polls at the same cadence, so the badge
  // stays roughly in sync without an additional websocket.
  const [pendingCount, setPendingCount] = useState(0);

  useEffect(() => {
    if (!token) return undefined;
    let cancelled = false;
    const refreshCount = async () => {
      try {
        const items = await api('/api/pricing-suggestions?status=PENDING', { bypassCache: true }, token);
        if (cancelled) return;
        setPendingCount(Array.isArray(items) ? items.length : 0);
      } catch {
        /* silent — badge degrades to 0 */
      }
    };
    refreshCount();
    const id = setInterval(refreshCount, 60_000);
    return () => { cancelled = true; clearInterval(id); };
  }, [token]);

  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    setLoading(true);
    setError('');
    (async () => {
      try {
        const sum = await api(`/api/market/summary?airport=${encodeURIComponent(airport)}`, { bypassCache: true }, token);
        if (cancelled) return;
        setSummary(sum);

        // Fetch history per SIPP in parallel for sparkline + delta computation.
        const sipps = Array.isArray(sum?.sipps) ? sum.sipps.map((s) => s.sipp).filter(Boolean) : [];
        if (sipps.length === 0) {
          setHistoriesBySipp({});
        } else {
          const results = await Promise.all(
            sipps.map((sipp) =>
              api(`/api/market/history?airport=${encodeURIComponent(airport)}&sipp=${encodeURIComponent(sipp)}&days=${rangeDays}&mode=forward`, { bypassCache: true }, token)
                .then((data) => [sipp, data])
                .catch(() => [sipp, null])
            )
          );
          if (cancelled) return;
          const map = {};
          for (const [sipp, data] of results) map[sipp] = data;
          setHistoriesBySipp(map);
        }
      } catch (err) {
        if (!cancelled) setError(err?.message || 'Failed to load market summary');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [token, airport, rangeDays]);

  // Build the display list: union of standard order + any unknowns from API,
  // each entry either has summary data or is an empty-state placeholder.
  const cards = useMemo(() => {
    const summaryBySipp = {};
    for (const s of summary?.sipps || []) summaryBySipp[s.sipp] = s;

    const standard = SIPP_ORDER.map((code) => ({
      code,
      label: SIPP_LABELS[code] || `Class ${code}`,
      data: summaryBySipp[code] || null
    }));

    const extras = (summary?.sipps || [])
      .filter((s) => !SIPP_ORDER.includes(s.sipp))
      .map((s) => ({
        code: s.sipp,
        label: SIPP_LABELS[s.sipp] || `Class ${s.sipp}`,
        data: s
      }));

    return [...standard, ...extras];
  }, [summary]);

  async function downloadExcel() {
    try {
      const res = await fetch(`${API_BASE}/api/market/export.xlsx?airport=${encodeURIComponent(airport)}&days=${rangeDays}`, { headers: { Authorization: `Bearer ${token}` } });
      if (!res.ok) {
        let m = `Export failed (${res.status})`;
        try { const j = await res.json(); if (j?.error) m = j.error; } catch { /* ignore */ }
        setError(m); return;
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = `market-pricing-${airport}-${rangeDays}d.xlsx`;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 4000);
    } catch (e) { setError(e?.message || 'Export failed'); }
  }

  return (
    <AppShell me={me} logout={logout}>
      <DarkPanel>
        <TopBar
          airport={airport}
          updatedAt={summary?.updatedAt}
          rangeDays={rangeDays}
          onRangeChange={setRangeDays}
          router={router}
          pendingCount={pendingCount}
          onExport={downloadExcel}
        />
        <Legend sortBy={sortBy} onSortChange={setSortBy} />

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

        {loading && !summary && <DashboardSkeleton />}

        {!loading && summary && (summary.sipps || []).length === 0 && (
          <EmptyState>
            No market observations yet for {airport}. Run the scraper or wait
            for the daily 4:01 AM ET cron to populate data.
          </EmptyState>
        )}

        {summary && (summary.sipps || []).length > 0 && (
          <div style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))',
            gap: 16
          }}>
            {cards.map((card) => (
              <SippCard
                key={card.code}
                code={card.code}
                label={card.label}
                data={card.data}
                history={historiesBySipp[card.code]}
                rangeDays={rangeDays}
                onClick={() => router.push(`/market/${encodeURIComponent(card.code)}`)}
              />
            ))}
          </div>
        )}
      </DarkPanel>
    </AppShell>
  );
}

// ---------------------------------------------------------------------------
// Top bar
// ---------------------------------------------------------------------------

function TopBar({ airport, updatedAt, rangeDays, onRangeChange, router, pendingCount, onExport }) {
  return (
    <div style={{
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      marginBottom: 24,
      gap: 12,
      flexWrap: 'wrap'
    }}>
      <div>
        <h1 style={{ margin: 0, fontSize: 26, fontWeight: 700, letterSpacing: '-0.4px', color: '#e7ebf2' }}>
          Market Intelligence
        </h1>
        <div style={{ color: '#8a93a6', fontSize: 13, marginTop: 4 }}>
          {airport === 'SJU' ? 'SJU — San Juan, Puerto Rico' : airport} · Last refresh: {fmtTimestamp(updatedAt)}
        </div>
      </div>
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
        {/* Quick links to the two sibling pages — scrape profile CRUD + suggestions
            inbox — so the dashboard is the single entry point for the whole MI surface. */}
        <button
          type="button"
          onClick={() => router.push('/suggestions')}
          style={pendingCount > 0 ? topbarBtnActiveStyle : topbarBtnStyle}
          title="Open the Pricing Suggestions inbox"
        >
          📬 Suggestions{pendingCount > 0 ? <span style={badgeStyle}>{pendingCount}</span> : null}
        </button>
        <button
          type="button"
          onClick={() => router.push('/market-intelligence')}
          style={topbarBtnStyle}
          title="Configure MarketScrapeProfiles + targetRate mappings"
        >⚙️ Profiles</button>
        <button
          type="button"
          onClick={onExport}
          style={topbarBtnStyle}
          title="Download prices + suggested by vehicle class and day (Excel)"
        >⬇ Export Excel</button>
        <select
          value={airport}
          // V1: only SJU is active. Selecting placeholder is a no-op.
          // TODO: when multi-airport ships, drive this from a /api/market/airports endpoint.
          onChange={() => { /* TODO: enable when other airports go live */ }}
          style={selectStyle}
        >
          <option value="SJU">SJU — San Juan</option>
          <option value="MCO" disabled>MCO — Orlando (coming soon)</option>
        </select>
        {RANGE_PILLS.map((p) => (
          <button
            key={p.value}
            type="button"
            onClick={() => onRangeChange(p.value)}
            style={rangeDays === p.value ? pillActiveStyle : pillStyle}
          >{p.label}</button>
        ))}
        <button
          type="button"
          // TODO: hook up an Add Airport flow once we support more than SJU.
          onClick={() => { /* placeholder */ }}
          style={addAirportStyle}
        >+ Add airport</button>
      </div>
    </div>
  );
}

// Style for the two new topbar action buttons (Profiles + Suggestions). Mirrors
// the existing pill aesthetic but with a slightly heavier weight to read as
// "quick action" rather than "filter".
const topbarBtnStyle = {
  background: '#1b1f29',
  border: '1px solid #2a2f3d',
  color: '#c8cfe0',
  padding: '8px 14px',
  borderRadius: 8,
  fontSize: 13,
  fontWeight: 600,
  cursor: 'pointer',
  display: 'inline-flex',
  alignItems: 'center',
  gap: 6
};
const topbarBtnActiveStyle = {
  ...topbarBtnStyle,
  background: '#1d4ed8',
  borderColor: '#2563eb',
  color: '#fff'
};
const badgeStyle = {
  background: 'rgba(255,255,255,0.22)',
  borderRadius: 10,
  padding: '1px 7px',
  fontSize: 11,
  fontWeight: 700,
  marginLeft: 6
};

function Legend({ sortBy, onSortChange }) {
  return (
    <div style={{
      display: 'flex',
      gap: 16,
      alignItems: 'center',
      background: '#161922',
      border: '1px solid #232838',
      padding: '12px 16px',
      borderRadius: 10,
      marginBottom: 20,
      fontSize: 13,
      color: '#8a93a6',
      flexWrap: 'wrap'
    }}>
      <LegendDot color="#3b82f6" label="Market median" />
      <LegendDot color="#fbbf24" label="Your price" />
      <LegendDot color="#f87171" label="Cheapest competitor" />
      <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8 }}>
        <span>Sort by:</span>
        <select
          value={sortBy}
          onChange={(e) => onSortChange(e.target.value)}
          style={{ ...selectStyle, padding: '6px 10px' }}
        >
          <option value="biggest_move">Biggest 7d move</option>
          <option value="alpha">SIPP alphabetical</option>
          <option value="worst_rank">Worst rank first</option>
        </select>
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
// SIPP card
// ---------------------------------------------------------------------------

function SippCard({ code, label, data, history, rangeDays = 14, onClick }) {
  // Empty state when summary has no entry for this SIPP.
  if (!data) {
    return (
      <div style={emptyCardStyle}>
        <div style={cardHeadStyle}>
          <div>
            <div style={sippStyle}>{code}</div>
            <div style={sippLabelStyle}>{label}</div>
          </div>
        </div>
        <div style={{ padding: '24px 0', textAlign: 'center', color: '#6e7587', fontSize: 12 }}>
          No data yet
        </div>
      </div>
    );
  }

  const yourPrice = data.yourRate?.daily != null ? Number(data.yourRate.daily) : null;
  const yourRank = data.yourRank;
  const vendorCount = data.vendorCount || 0;

  // Delta + sparkline span the selected range (the history is fetched with days=rangeDays).
  const yourSeries = useMemo(() => {
    if (!history?.series) return [];
    return history.series.map((row) => ({ date: row.date, price: yourPrice })); // flat if no per-day source
  }, [history, yourPrice]);

  // Range delta: prefer the cheapest series since "your price" rarely changes
  // day-over-day in V1.
  const cheapestSeries = useMemo(() => {
    if (!history?.series) return [];
    return history.series.map((row) => ({ date: row.date, price: row.min }));
  }, [history]);
  const cheapestDeltaPct = computeDeltaPct(cheapestSeries);

  const rankClass = (() => {
    if (yourRank == null) return 'rank-unknown';
    if (yourRank <= 3) return 'rank-good';
    if (yourRank >= 7) return 'rank-bad';
    return 'rank-mid';
  })();
  const rankColor = rankClass === 'rank-good' ? '#4ade80'
    : rankClass === 'rank-bad' ? '#f87171'
    : rankClass === 'rank-unknown' ? '#6e7587'
    : '#fbbf24';

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick(); } }}
      style={cardStyle}
      onMouseEnter={(e) => { e.currentTarget.style.borderColor = '#3b82f6'; }}
      onMouseLeave={(e) => { e.currentTarget.style.borderColor = '#232838'; }}
    >
      <div style={cardHeadStyle}>
        <div>
          <div style={sippStyle}>{code}</div>
          <div style={sippLabelStyle}>{label}</div>
        </div>
        <div style={{ textAlign: 'right' }}>
          <div style={priceStyle}>{fmtMoney(yourPrice)}</div>
          {data.yourRate?.allIn && data.yourRate?.base != null && (
            <div style={{ fontSize: 10, color: '#6e7587' }}>all-in · base {fmtMoney(Number(data.yourRate.base))}</div>
          )}
          {cheapestDeltaPct != null && <DeltaBadge pct={cheapestDeltaPct} days={rangeDays} />}
        </div>
      </div>

      <div style={{ height: 90, marginTop: 6 }}>
        {history ? (
          <Sparkline history={history} yourPrice={yourPrice} />
        ) : (
          <div style={{ height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#3a4153', fontSize: 11 }}>
            loading chart…
          </div>
        )}
      </div>

      <div style={footerStyle}>
        <span>
          Rank: <span style={{ color: rankColor, fontWeight: 600 }}>
            {yourRank != null ? `#${yourRank} of ${vendorCount} vendors` : 'unranked'}
          </span>
        </span>
        <span>
          Median {fmtMoney(data.median)} · Low {fmtMoney(data.min)}
        </span>
      </div>
    </div>
  );
}

function DeltaBadge({ pct, days = 7 }) {
  const cls = pct > 1 ? 'up' : pct < -1 ? 'down' : 'flat';
  const bg = cls === 'up' ? 'rgba(239,68,68,0.15)'
    : cls === 'down' ? 'rgba(34,197,94,0.15)'
    : 'rgba(148,163,184,0.15)';
  const fg = cls === 'up' ? '#f87171' : cls === 'down' ? '#4ade80' : '#94a3b8';
  const txt = `${pct > 0 ? '+' : ''}${pct.toFixed(1)}% ${days}d`;
  return (
    <span style={{
      fontSize: 12,
      padding: '2px 8px',
      borderRadius: 5,
      fontWeight: 600,
      display: 'inline-block',
      marginTop: 4,
      background: bg,
      color: fg
    }}>{txt}</span>
  );
}

function Sparkline({ history, yourPrice }) {
  const series = Array.isArray(history?.series) ? history.series : [];
  const labels = series.map(() => '');
  // Null-aware: a day with no observations comes back as median:null. Number(null)
  // is 0 — which would plot a $0 spike. Keep nulls so Chart.js skips them when
  // `spanGaps:true` is set on each dataset below.
  const toNumOrNull = (v) => (v == null ? null : Number(v));
  const median = series.map((row) => toNumOrNull(row.median));
  const low = series.map((row) => toNumOrNull(row.min));
  // Your price is currently flat (snapshot only). Render as a horizontal
  // dashed line at yourPrice if present.
  const you = series.map(() => (yourPrice != null ? Number(yourPrice) : null));

  const data = {
    labels,
    datasets: [
      {
        data: median,
        borderColor: '#3b82f6',
        backgroundColor: 'rgba(59,130,246,0.08)',
        tension: 0.35,
        pointRadius: 0,
        borderWidth: 2,
        fill: true,
        spanGaps: true
      },
      {
        data: you,
        borderColor: '#fbbf24',
        tension: 0,
        pointRadius: 0,
        borderWidth: 1.8,
        borderDash: [4, 3],
        fill: false,
        spanGaps: true
      },
      {
        data: low,
        borderColor: '#f87171',
        tension: 0.35,
        pointRadius: 0,
        borderWidth: 1.4,
        fill: false,
        spanGaps: true
      }
    ]
  };

  const options = {
    responsive: true,
    maintainAspectRatio: false,
    plugins: { legend: { display: false }, tooltip: { enabled: false } },
    scales: { x: { display: false }, y: { display: false } },
    animation: { duration: 400 }
  };

  return <Line data={data} options={options} />;
}

// ---------------------------------------------------------------------------
// Loading / empty
// ---------------------------------------------------------------------------

function DashboardSkeleton() {
  return (
    <div aria-busy="true" aria-label="Loading market data" style={{
      display: 'grid',
      gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))',
      gap: 16
    }}>
      {Array.from({ length: 6 }).map((_, i) => (
        <div key={i} style={{ ...cardStyle, cursor: 'default', height: 200 }}>
          <div style={{
            background: 'linear-gradient(90deg, #1b1f29 0%, #232838 50%, #1b1f29 100%)',
            backgroundSize: '200% 100%',
            borderRadius: 6,
            height: '100%',
            animation: 'rfm-market-shimmer 1.4s ease-in-out infinite'
          }} />
          <style>{`@keyframes rfm-market-shimmer { 0% { background-position: 200% 0; } 100% { background-position: -200% 0; } }`}</style>
        </div>
      ))}
    </div>
  );
}

function EmptyState({ children }) {
  return (
    <div style={{
      padding: 40,
      textAlign: 'center',
      color: '#8a93a6',
      background: '#161922',
      border: '1px solid #232838',
      borderRadius: 12
    }}>{children}</div>
  );
}

// ---------------------------------------------------------------------------
// Dark theme wrapper + shared styles
// ---------------------------------------------------------------------------

function DarkPanel({ children }) {
  return (
    <div style={{
      background: '#0f1115',
      color: '#e7ebf2',
      padding: 24,
      minHeight: 'calc(100vh - 120px)',
      fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'
    }}>
      {children}
    </div>
  );
}

const selectStyle = {
  background: '#1b1f29',
  border: '1px solid #2a2f3d',
  color: '#e7ebf2',
  padding: '8px 12px',
  borderRadius: 8,
  fontSize: 13
};

const pillStyle = {
  background: '#1b1f29',
  border: '1px solid #2a2f3d',
  color: '#c8cfe0',
  padding: '8px 14px',
  borderRadius: 8,
  fontSize: 13,
  cursor: 'pointer'
};

const pillActiveStyle = {
  ...pillStyle,
  background: '#2563eb',
  borderColor: '#2563eb',
  color: '#fff'
};

const addAirportStyle = {
  ...pillStyle,
  background: '#1d4ed8',
  borderColor: '#1d4ed8',
  color: '#fff',
  cursor: 'not-allowed'
};

const cardStyle = {
  background: 'linear-gradient(180deg, #161922 0%, #131620 100%)',
  border: '1px solid #232838',
  borderRadius: 14,
  padding: 18,
  cursor: 'pointer',
  transition: 'border-color 0.15s'
};

const emptyCardStyle = {
  ...cardStyle,
  cursor: 'default',
  opacity: 0.7
};

const cardHeadStyle = {
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'flex-start',
  marginBottom: 12
};

const sippStyle = {
  fontSize: 18,
  fontWeight: 700,
  letterSpacing: 0.5,
  color: '#e7ebf2'
};

const sippLabelStyle = {
  fontSize: 11,
  color: '#6e7587',
  marginTop: 3,
  textTransform: 'uppercase',
  letterSpacing: 0.8
};

const priceStyle = {
  fontSize: 20,
  fontWeight: 700,
  color: '#e7ebf2'
};

const footerStyle = {
  display: 'flex',
  justifyContent: 'space-between',
  marginTop: 10,
  fontSize: 11,
  color: '#6e7587',
  flexWrap: 'wrap',
  gap: 4
};
