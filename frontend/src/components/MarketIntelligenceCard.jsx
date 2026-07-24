'use client';

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { api } from '../lib/client';
import { isModuleEnabled } from '../lib/moduleAccess';

/**
 * Market Intelligence card — lives on the home dashboard between
 * Pickups/Returns and the Operations Timeline. Renders:
 *   - Pending suggestions notification banner (live count, polls every 60s)
 *   - 6 SIPP mini-cards with your price, market rank, and a sparkline of
 *     the last 7 days of market median
 *   - Footer with auto-applied count for today + link to the full dashboard
 *
 * Gating (3 layers — all enforced):
 *   1. Hidden entirely if the user's role lacks `marketIntelligence` access
 *      (`isModuleEnabled` mirrors AppShell's nav-tab gate).
 *   2. The backend APIs (/api/market/*, /api/pricing-suggestions) are
 *      already tenant-scoped via `scopeFor(req)`, so even if a user from a
 *      different tenant somehow rendered this component they couldn't see
 *      another tenant's data.
 *   3. The tenant-level `Tenant.marketIntelligenceEnabled` flag gates the
 *      backend module-access middleware. When false the APIs return 403
 *      and this component degrades to hidden.
 *
 * Airport selector behavior:
 *   - Lists the airports the tenant actually SCRAPES, from
 *     /api/market/airports (its active MarketScrapeProfiles) — not its
 *     Locations. A Location's `code` is a free-form label that often isn't the
 *     IATA code the market endpoints key on, so a Location-driven picker asks
 *     for an airport no profile has and silently renders empty. See
 *     listMarketAirports() in market-observations.service.js.
 *   - For tenants that scrape a single airport the dropdown collapses to a
 *     plain label.
 *   - The selected airport persists per tenant in localStorage so it
 *     doesn't bleed across tenants in the same browser session.
 */

const SIPP_NAMES = {
  ECAR: 'Economy', CCAR: 'Compact', ICAR: 'Mid-size', SCAR: 'Standard',
  FCAR: 'Fullsize', CFAR: 'Compact SUV', IFAR: 'Mid-size SUV',
  SFAR: 'Standard SUV', FFAR: 'Fullsize SUV', PCAR: 'Premium',
  PFAR: 'Premium SUV', LCAR: 'Luxury', LFAR: 'Luxury SUV',
  MVAR: 'Minivan', SPAR: 'Special', STAR: 'Sports/Convertible',
  PUAR: 'Pickup', XFAR: 'Open-Air All-Terrain', RFAR: 'Recreational',
};

// Dashboard SIPP picker (beta.134): when the tenant has pinned SIPP codes
// (summary.preferredSipps from Settings → Market Intelligence), show those in
// the tenant's order. Otherwise fall back to the top 6 by market volume. If the
// pinned codes have no market data yet, fall back too so the card isn't empty.
function selectDashboardSipps(summary) {
  const all = Array.isArray(summary?.sipps) ? summary.sipps : [];
  const preferred = Array.isArray(summary?.preferredSipps)
    ? summary.preferredSipps.map((s) => String(s || '').trim().toUpperCase()).filter(Boolean)
    : [];
  if (preferred.length) {
    const byCode = new Map(all.map((s) => [String(s.sipp || '').toUpperCase(), s]));
    const picked = preferred.map((code) => byCode.get(code)).filter(Boolean);
    if (picked.length) return picked.slice(0, 6);
  }
  return all.slice(0, 6);
}

function rankClass(rank, total) {
  if (rank == null) return { className: 'rank-mid', bg: '#fef9c3', color: '#854d0e' };
  if (rank <= 3) return { className: 'rank-good', bg: '#ecfdf5', color: '#166534' };
  if (rank <= 7) return { className: 'rank-mid', bg: '#fef9c3', color: '#854d0e' };
  return { className: 'rank-bad', bg: '#fee2e2', color: '#991b1b' };
}

function fmtRelative(iso) {
  if (!iso) return '—';
  const then = new Date(iso).getTime();
  const now = Date.now();
  const minutes = Math.round((now - then) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}

// Render a small SVG sparkline. `points` is an array of numbers (or null
// for gaps). The y-axis is auto-scaled to the min/max of non-null values.
function Sparkline({ points, color = '#4f46e5', median = null }) {
  if (!Array.isArray(points) || points.length === 0) return null;
  const nums = points.map((p) => (p == null ? null : Number(p))).filter((n) => Number.isFinite(n));
  if (nums.length === 0) return null;
  const min = Math.min(...nums, ...(median != null ? [median] : []));
  const max = Math.max(...nums, ...(median != null ? [median] : []));
  const range = max - min || 1;
  const W = 100, H = 22;
  const step = W / Math.max(1, points.length - 1);
  const path = points
    .map((p, i) => {
      if (p == null) return null;
      const x = i * step;
      const y = H - 2 - ((Number(p) - min) / range) * (H - 4);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .filter(Boolean)
    .join(' ');
  const medianY = median != null ? H - 2 - ((median - min) / range) * (H - 4) : null;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" style={{ width: '100%', height: H, marginTop: 2 }}>
      {medianY != null && (
        <line x1="0" y1={medianY} x2={W} y2={medianY} stroke="#fbbf24" strokeWidth="1" strokeDasharray="2,2" />
      )}
      <polyline fill="none" stroke={color} strokeWidth="1.5" points={path} />
    </svg>
  );
}

export default function MarketIntelligenceCard({ me, token }) {
  const router = useRouter();
  const enabled = isModuleEnabled(me, 'marketIntelligence');
  const [locations, setLocations] = useState([]);
  const [airport, setAirport] = useState(null);
  const [summary, setSummary] = useState(null);
  const [historiesBySipp, setHistoriesBySipp] = useState({});
  const [pendingCount, setPendingCount] = useState(0);
  const [autoAppliedTodayCount, setAutoAppliedTodayCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [hidden, setHidden] = useState(false);

  // Fetch the airports this tenant scrapes + restore the selection.
  //
  // Reads /api/market/airports (the tenant's ACTIVE scrape profiles), NOT
  // /api/locations. `Location.code` is a free-form label that often isn't the
  // IATA code the market endpoints key on — Corpusa's LAX branch is coded
  // `LAXA01`, so this card asked for `?airport=LAXA01`, matched no profile, and
  // rendered empty forever while 1,249 rows of LAX data sat in the table. It
  // only worked for the first tenant because they named their location `SJU`.
  useEffect(() => {
    if (!enabled || !token) return undefined;
    let cancelled = false;
    api('/api/market/airports', { bypassCache: true }, token)
      .then((data) => {
        if (cancelled) return;
        const usable = Array.isArray(data?.airports) ? data.airports : [];
        setLocations(usable);
        const storageKey = `marketIntelligence.location:${me?.tenantId || 'anon'}`;
        const saved = typeof window !== 'undefined' ? window.localStorage.getItem(storageKey) : null;
        const initial = saved && usable.some((a) => a.code === saved) ? saved : (usable[0]?.code || null);
        setAirport(initial);
        // No scrape profiles → nothing this card can ever show.
        if (!initial) setHidden(true);
      })
      .catch(() => {
        // If the API returns 403 because the tenant doesn't have
        // marketIntelligence enabled, just hide the whole card silently.
        if (!cancelled) setHidden(true);
      });
    return () => { cancelled = true; };
  }, [enabled, token, me?.tenantId]);

  // Fetch summary + suggestions when the airport changes.
  useEffect(() => {
    if (!enabled || !token || !airport) return undefined;
    let cancelled = false;
    setLoading(true);
    Promise.all([
      api(`/api/market/summary?airport=${encodeURIComponent(airport)}`, { bypassCache: true }, token).catch(() => null),
      api('/api/pricing-suggestions?status=PENDING', { bypassCache: true }, token).catch(() => []),
      api('/api/pricing-suggestions?status=AUTO_APPLIED', { bypassCache: true }, token).catch(() => []),
    ])
      .then(([sum, pending, auto]) => {
        if (cancelled) return null;
        // Any 403 along the way → hide. The Promise.all .catch above turns
        // it into null/[] so this just falls through gracefully but the
        // card has no usable data.
        if (sum === null) { setHidden(true); return null; }
        setSummary(sum);
        setPendingCount(Array.isArray(pending) ? pending.length : 0);
        const today = new Date().toISOString().slice(0, 10);
        const todayAuto = (Array.isArray(auto) ? auto : []).filter(
          (s) => String(s.createdAt || '').slice(0, 10) === today
        ).length;
        setAutoAppliedTodayCount(todayAuto);
        // Fetch sparkline history for the dashboard SIPPs (tenant-pinned or top 6).
        const top6 = selectDashboardSipps(sum).map((s) => s.sipp).filter(Boolean);
        return Promise.all(
          top6.map((sipp) =>
            api(`/api/market/history?airport=${encodeURIComponent(airport)}&sipp=${encodeURIComponent(sipp)}&days=7`,
                { bypassCache: true }, token)
              .then((h) => [sipp, h])
              .catch(() => [sipp, null])
          )
        );
      })
      .then((histories) => {
        if (cancelled || !histories) return;
        const map = {};
        for (const [sipp, h] of histories) map[sipp] = h;
        setHistoriesBySipp(map);
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [enabled, token, airport]);

  // Poll pending count every 60s for live badge updates.
  useEffect(() => {
    if (!enabled || !token || hidden) return undefined;
    const id = setInterval(() => {
      api('/api/pricing-suggestions?status=PENDING', { bypassCache: true }, token)
        .then((data) => setPendingCount(Array.isArray(data) ? data.length : 0))
        .catch(() => {});
    }, 60_000);
    return () => clearInterval(id);
  }, [enabled, token, hidden]);

  const top6 = useMemo(() => selectDashboardSipps(summary), [summary]);

  if (!enabled || hidden) return null;
  if (locations.length === 0 && !loading) return null;

  const handleAirportChange = (code) => {
    setAirport(code);
    if (typeof window !== 'undefined') {
      window.localStorage.setItem(`marketIntelligence.location:${me?.tenantId || 'anon'}`, code);
    }
  };

  const goToSuggestions = (e) => {
    if (e) e.stopPropagation();
    router.push('/suggestions');
  };
  const goToSippDetail = (sipp) => {
    router.push(`/market/${sipp}?airport=${encodeURIComponent(airport || '')}`);
  };

  const hasPending = pendingCount > 0;
  const refreshedLabel = summary?.updatedAt ? `Last scrape · ${fmtRelative(summary.updatedAt)}` : '—';
  const moreSippsCount = Math.max(0, (summary?.sipps || []).length - 6);

  return (
    <section
      className="glass card-lg"
      style={{ padding: 0, overflow: 'hidden', marginBottom: 14 }}
    >
      {/* Header */}
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '14px 18px 12px', borderBottom: '1px solid #f1edff',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 16, fontWeight: 700 }}>
          <span style={{
            width: 28, height: 28, borderRadius: 8,
            background: 'linear-gradient(135deg, #4f46e5, #7c3aed)',
            color: 'white', display: 'inline-flex', alignItems: 'center',
            justifyContent: 'center', fontSize: 14,
          }}>📈</span>
          Market Intelligence
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          {locations.length > 1 ? (
            <select
              value={airport || ''}
              onChange={(e) => handleAirportChange(e.target.value)}
              style={{
                background: 'white', border: '1px solid var(--line, #e3def0)',
                color: 'var(--charcoal, #211a38)', padding: '5px 10px',
                borderRadius: 6, fontSize: 12, cursor: 'pointer',
              }}
            >
              {/* `label` is prebuilt by the API ("LAX — Los Angeles", or just
                  the code when the tenant's Location doesn't carry that code). */}
              {locations.map((l) => (
                <option key={l.code} value={l.code}>📍 {l.label || l.code}</option>
              ))}
            </select>
          ) : locations[0] ? (
            <span style={{ fontSize: 12, color: 'var(--muted, #6f668f)' }}>
              📍 {locations[0].label || locations[0].code}
            </span>
          ) : null}
          <span style={{ fontSize: 11, color: 'var(--muted, #6f668f)' }}>
            {refreshedLabel}
          </span>
        </div>
      </div>

      {/* Pending banner */}
      <div
        onClick={goToSuggestions}
        style={{
          background: hasPending
            ? 'linear-gradient(90deg, #fff5e0, #fff9eb)'
            : 'linear-gradient(90deg, #f0fdf4, #ecfdf5)',
          borderBottom: `1px solid ${hasPending ? '#f5d987' : '#c1e9ce'}`,
          display: 'flex', alignItems: 'center', gap: 10,
          padding: '12px 18px',
          color: hasPending ? '#7c5b00' : '#166534',
          fontSize: 13, cursor: 'pointer',
        }}
      >
        <span style={{ fontSize: 16 }}>{hasPending ? '⚠️' : '✓'}</span>
        <span style={{
          background: hasPending ? '#f59e0b' : '#16a34a',
          color: 'white', fontWeight: 700, fontSize: 12,
          padding: '2px 8px', borderRadius: 10,
        }}>{pendingCount}</span>
        <span>
          {hasPending
            ? `pricing suggestion${pendingCount === 1 ? '' : 's'} waiting for your approval`
            : 'pending — all caught up'}
        </span>
        <span style={{
          marginLeft: 'auto', fontSize: 16,
          color: hasPending ? '#b07d00' : '#4b8a5e',
        }}>→</span>
      </div>

      {/* SIPP grid */}
      {loading && top6.length === 0 ? (
        <div style={{ padding: 24, textAlign: 'center', color: 'var(--muted, #6f668f)', fontSize: 13 }}>
          Loading market data…
        </div>
      ) : top6.length === 0 ? (
        <div style={{ padding: 24, textAlign: 'center', color: 'var(--muted, #6f668f)', fontSize: 13 }}>
          No market observations yet for {airport || 'this location'}. Configure a scrape profile in{' '}
          <a href="/market-intelligence" style={{ color: 'var(--brand, #4f46e5)' }}>Market Intelligence settings</a>.
        </div>
      ) : (
        <div style={{
          display: 'grid',
          gridTemplateColumns: `repeat(${top6.length}, 1fr)`,
          gap: 1, background: '#f1edff',
        }}>
          {top6.map((s) => {
            const yourPrice = s.yourRate?.daily != null ? Number(s.yourRate.daily) : null;
            const minPrice = s.min != null ? Number(s.min) : null;
            const median = s.median != null ? Number(s.median) : null;
            const rank = s.yourRank;
            const total = s.vendorCount || 0;
            const r = rankClass(rank, total);
            const history = historiesBySipp[s.sipp];
            const sparkPoints = (history?.series || []).map((row) => (row.median == null ? null : Number(row.median)));
            const vsMarket = (() => {
              if (yourPrice == null || minPrice == null) return null;
              const diff = yourPrice - minPrice;
              const sign = diff >= 0 ? '+' : '−';
              return { text: `${sign}$${Math.abs(diff).toFixed(2)} vs min`, isOver: diff > 0 };
            })();
            return (
              <div
                key={s.sipp}
                onClick={() => goToSippDetail(s.sipp)}
                style={{
                  background: 'white', padding: '14px 14px 10px',
                  display: 'flex', flexDirection: 'column', gap: 6,
                  cursor: 'pointer',
                }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
                  <div>
                    <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--brand, #4f46e5)', letterSpacing: '0.8px' }}>
                      {s.sipp}
                    </span>
                    <br />
                    <span style={{ fontSize: 10, color: 'var(--muted, #6f668f)' }}>
                      {SIPP_NAMES[s.sipp] || `Class ${s.sipp}`}
                    </span>
                  </div>
                  {rank != null && (
                    <span style={{
                      display: 'inline-flex', alignItems: 'center', gap: 3,
                      fontSize: 10, fontWeight: 700,
                      padding: '2px 6px', borderRadius: 9,
                      background: r.bg, color: r.color,
                    }}>
                      #{rank}{total ? ` of ${total}` : ''}
                    </span>
                  )}
                </div>
                <div style={{ display: 'flex', alignItems: 'end', justifyContent: 'space-between' }}>
                  <div style={{ fontSize: 17, fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>
                    {yourPrice != null ? `$${yourPrice.toFixed(2)}` : '—'}
                  </div>
                  {vsMarket && (
                    <div style={{
                      fontSize: 10,
                      color: vsMarket.isOver ? '#991b1b' : '#166534',
                    }}>
                      {vsMarket.text}
                    </div>
                  )}
                </div>
                <Sparkline points={sparkPoints} median={median} />
              </div>
            );
          })}
        </div>
      )}

      {/* Footer */}
      <div style={{
        borderTop: '1px solid #f1edff', padding: '10px 18px',
        display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 12,
      }}>
        <span style={{
          color: '#166534', background: '#ecfdf5',
          padding: '3px 10px', borderRadius: 6, fontWeight: 600, fontSize: 11,
        }}>
          ✓ {autoAppliedTodayCount} auto-applied today
        </span>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          {moreSippsCount > 0 && (
            <span style={{ color: 'var(--muted, #6f668f)' }}>
              {moreSippsCount} more SIPP{moreSippsCount === 1 ? '' : 's'} available →
            </span>
          )}
          <a href="/market" style={{ color: 'var(--brand, #4f46e5)', textDecoration: 'none', fontWeight: 600 }}>
            Full dashboard
          </a>
        </div>
      </div>
    </section>
  );
}
