'use client';

/**
 * Availability Forecast per Vehicle Type — Round 26 Hybrid (2026-05-23).
 *
 * Layout: shared headline (KPI strip + peak-risk callout) always visible above
 * three tabs (At a glance / Forecast★ / Trends). Always-on filters: 30-day
 * default range + location dropdown.
 *
 *   ┌─────────────────────────────────────────────────────────────────┐
 *   │ Title · Description · Filter bar (range + location + exports)   │
 *   ├─────────────────────────────────────────────────────────────────┤
 *   │ Shared headline                                                 │
 *   │   • Snapshot strip (capacity · utilization · peak day · sold-out) │
 *   │   • Peak risk callout                                           │
 *   ├─────────────────────────────────────────────────────────────────┤
 *   │ Tabs: At a glance | Forecast★ | Trends                          │
 *   ├─────────────────────────────────────────────────────────────────┤
 *   │ Tab body (varies)                                               │
 *   │   At a glance → 7-day compact heat + Available-now-by-type      │
 *   │   Forecast    → Full heat grid (clickable cells) + bar chart    │
 *   │   Trends      → Utilization line (LY toggle) + booking pace +   │
 *   │                 sold-out incidence bars                         │
 *   └─────────────────────────────────────────────────────────────────┘
 *
 * Cells in the Forecast tab heat grid are clickable. Clicking opens a
 * slide-in side panel that hits `/api/reports/availability-forecast/cell`
 * for the underlying reservations.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { AuthGate } from '../../../components/AuthGate';
import { AppShell } from '../../../components/AppShell';
import { api } from '../../../lib/client';
import { ReportPageLayout } from '../../../components/reports/ReportPageLayout';
import { ReservationListDrawer } from '../../../components/reports/ReservationListDrawer';
import { UtilizationBarChart } from '../../../components/reports/charts/UtilizationBarChart';
import { UtilizationLineChart } from '../../../components/reports/charts/UtilizationLineChart';
import { BookingPaceChart } from '../../../components/reports/charts/BookingPaceChart';
import { SoldOutIncidenceChart } from '../../../components/reports/charts/SoldOutIncidenceChart';
import { DEFAULT_TENANT_TIMEZONE, tenantDayKey } from '../../../lib/tenant-time';

const TABS = [
  { key: 'glance', label: 'At a glance' },
  { key: 'forecast', label: 'Forecast' },
  { key: 'trends', label: 'Trends' },
];

const DEFAULT_TAB = 'forecast';

// Tab persistence (per-user, per-report) — read on mount only, ignored otherwise.
const TAB_STORAGE_KEY = 'reports-v2:availability-forecast:tab';

// "YYYY-MM-DD" in tenant TZ. Replaces toISOString().slice(0, 10) so the
// range string matches what the backend uses for bucketing (which is now
// tenant-TZ anchored). Without this, late-evening agents (or anyone in a
// non-PR browser) could see a default range that's off by a day at the
// boundary.
function isoDayInTenantTz(d) {
  return tenantDayKey(d, DEFAULT_TENANT_TIMEZONE);
}

// Forward-looking range presets (30-day default).
function makePresets() {
  const mk = (n, label) => ({
    label,
    compute: () => {
      const t = new Date();
      const to = new Date(t.getTime() + (n - 1) * 86400000);
      return { from: isoDayInTenantTz(t), to: isoDayInTenantTz(to) };
    },
  });
  return [mk(7, 'Next 7 days'), mk(14, 'Next 14 days'), mk(30, 'Next 30 days'), mk(60, 'Next 60 days')];
}

// Build the drill-down endpoint URL for the heat-grid cell drawer. The page
// owns URL construction so the drawer stays endpoint-agnostic.
function buildCellEndpoint(cell, locationId) {
  if (!cell?.typeId || !cell?.dayIso) return null;
  const params = new URLSearchParams();
  params.set('type', cell.typeId);
  params.set('day', cell.dayIso);
  if (locationId) params.set('locationId', locationId);
  return `/api/reports/availability-forecast/cell?${params.toString()}`;
}

export default function Page() {
  return <AuthGate>{({ token, me, logout }) => <ForecastReport token={token} me={me} logout={logout} />}</AuthGate>;
}

function ForecastReport({ token, me, logout }) {
  const [range, setRange] = useState(() => {
    const t = new Date();
    const to = new Date(t.getTime() + 29 * 86400000);
    return { from: isoDayInTenantTz(t), to: isoDayInTenantTz(to) };
  });
  const [locationId, setLocationId] = useState('');
  const [locations, setLocations] = useState([]);
  const [activeTab, setActiveTab] = useState(DEFAULT_TAB);
  const [compareLastYear, setCompareLastYear] = useState(false);

  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [drillCell, setDrillCell] = useState(null);

  // Restore last-used tab once (per user)
  useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      const saved = window.localStorage?.getItem(TAB_STORAGE_KEY);
      if (saved && TABS.some((t) => t.key === saved)) setActiveTab(saved);
    } catch { /* ignore */ }
  }, []);

  const onTabChange = (key) => {
    setActiveTab(key);
    try { window.localStorage?.setItem(TAB_STORAGE_KEY, key); } catch { /* ignore */ }
  };

  // Load locations once
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

  // Load report data on range / location / LY toggle / tab change.
  //
  // 2026-05-26: the 12-month sold-out scan can take 30+ seconds for tenants
  // with deep history and gateway-times out at 60s. It's only consumed by
  // the Trends tab, so we now only ask for it when that tab is active.
  // Switching between locations on the At-a-glance / Forecast tabs is fast
  // because the slow scan is skipped entirely.
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
    if (activeTab === 'trends') params.set('includeSoldOutHistory', 'true');
    (async () => {
      try {
        const out = await api(`/api/reports/availability-forecast?${params.toString()}`, { bypassCache: true }, token);
        if (!cancelled) setData(out);
      } catch (err) {
        if (!cancelled) setError(err?.message || 'Failed to load report');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [token, range.from, range.to, locationId, compareLastYear, activeTab]);

  const presets = useMemo(() => makePresets(), []);

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
        slug="availability-forecast"
        title="Availability Forecast — per Vehicle Type"
        description="Day-by-day projected inventory based on confirmed bookings."
        category="Fleet"
        token={token}
        range={range}
        onRangeChange={setRange}
        presets={presets}
        extraFilters={locationFilter}
      >
        {loading && !data ? (
          <ForecastSkeleton />
        ) : error ? (
          <div role="alert" style={{ background: '#FCEBEB', color: '#791F1F', padding: 12, borderRadius: 8 }}>{error}</div>
        ) : data ? (
          <ReportBody
            data={data}
            activeTab={activeTab}
            onTabChange={onTabChange}
            compareLastYear={compareLastYear}
            onToggleLastYear={setCompareLastYear}
            onCellClick={setDrillCell}
          />
        ) : null}

        <ReservationListDrawer
          open={!!drillCell}
          endpoint={drillCell ? buildCellEndpoint(drillCell, locationId) : null}
          title={drillCell ? `${drillCell.typeName} · ${drillCell.dayLabel}` : ''}
          subtitle={
            drillCell && typeof drillCell.available === 'number' && typeof drillCell.capacity === 'number'
              ? `${drillCell.available} available · ${drillCell.capacity - drillCell.available} reserved of ${drillCell.capacity} capacity`
              : undefined
          }
          token={token}
          onClose={() => setDrillCell(null)}
        />
      </ReportPageLayout>
    </AppShell>
  );
}

// ---------------------------------------------------------------------------
// Body
// ---------------------------------------------------------------------------

function ReportBody({ data, activeTab, onTabChange, compareLastYear, onToggleLastYear, onCellClick }) {
  const { days, fleet, types, peakRisk, bookingPace, lastYear, soldOutByMonth, truncated } = data;
  const peakIdx = useMemo(() => {
    if (!fleet?.reservedByDay?.length) return -1;
    let idx = 0;
    for (let i = 1; i < fleet.reservedByDay.length; i++) {
      if (fleet.reservedByDay[i] > fleet.reservedByDay[idx]) idx = i;
    }
    return idx;
  }, [fleet]);

  return (
    <div>
      {truncated ? (
        <div style={{ background: '#FAEEDA', color: '#412402', padding: 10, borderRadius: 8, marginBottom: 12, fontSize: 12 }}>
          Range capped at 60 days — narrow the date window to see more detail.
        </div>
      ) : null}

      <SnapshotStrip fleet={fleet} />
      <PeakRiskCallout peakRisk={peakRisk} onCellClick={onCellClick} />

      <TabBar tabs={TABS} active={activeTab} onChange={onTabChange} />

      {activeTab === 'glance' && (
        <div role="tabpanel" id="forecast-panel-glance" aria-labelledby="forecast-tab-glance">
          <GlanceTab days={days} types={types} fleet={fleet} />
        </div>
      )}

      {activeTab === 'forecast' && (
        <div role="tabpanel" id="forecast-panel-forecast" aria-labelledby="forecast-tab-forecast">
          <ForecastTab
            days={days} types={types} fleet={fleet} peakIdx={peakIdx}
            onCellClick={onCellClick}
          />
        </div>
      )}

      {activeTab === 'trends' && (
        <div role="tabpanel" id="forecast-panel-trends" aria-labelledby="forecast-tab-trends">
          <TrendsTab
            days={days} fleet={fleet}
            bookingPace={bookingPace} lastYear={lastYear}
            soldOutByMonth={soldOutByMonth}
            compareLastYear={compareLastYear}
            onToggleLastYear={onToggleLastYear}
          />
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Loading skeleton
// ---------------------------------------------------------------------------

function ForecastSkeleton() {
  const shimmer = {
    background: 'linear-gradient(90deg, #f1efe8 0%, #e8e6df 50%, #f1efe8 100%)',
    backgroundSize: '200% 100%',
    animation: 'rfm-shimmer 1.4s ease-in-out infinite',
    borderRadius: 6,
  };
  return (
    <div aria-busy="true" aria-live="polite" aria-label="Loading forecast">
      <style>{`@keyframes rfm-shimmer { 0% { background-position: 200% 0; } 100% { background-position: -200% 0; } }`}</style>
      {/* Snapshot strip skeleton */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: 10, marginBottom: 12 }}>
        {[0, 1, 2, 3].map((i) => (
          <div key={i} style={{ ...shimmer, height: 64 }} />
        ))}
      </div>
      {/* Peak risk skeleton */}
      <div style={{ ...shimmer, height: 64, marginBottom: 18 }} />
      {/* Tab bar skeleton */}
      <div style={{ display: 'flex', gap: 16, borderBottom: '1px solid #d3d1c7', marginBottom: 18, paddingBottom: 8 }}>
        <div style={{ ...shimmer, height: 18, width: 80 }} />
        <div style={{ ...shimmer, height: 18, width: 70 }} />
        <div style={{ ...shimmer, height: 18, width: 60 }} />
      </div>
      {/* Body skeleton */}
      <div style={{ ...shimmer, height: 220, marginBottom: 14 }} />
      <div style={{ ...shimmer, height: 180 }} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Shared headline
// ---------------------------------------------------------------------------

function SnapshotStrip({ fleet }) {
  return (
    <div style={{
      display: 'grid',
      gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))',
      gap: 10,
      marginBottom: 12,
    }}>
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

function PeakRiskCallout({ peakRisk, onCellClick }) {
  if (!Array.isArray(peakRisk) || peakRisk.length === 0) return null;
  const VISIBLE = 4;
  const visible = peakRisk.slice(0, VISIBLE);
  const overflow = peakRisk.length - visible.length;

  // Pick the worst type for click-drill — lowest available/capacity ratio.
  const worstType = (pr) => {
    if (!pr?.atRiskTypes?.length) return null;
    return [...pr.atRiskTypes].sort((a, b) => {
      const ra = a.capacity > 0 ? a.available / a.capacity : 1;
      const rb = b.capacity > 0 ? b.available / b.capacity : 1;
      return ra - rb;
    })[0];
  };

  return (
    <div
      role="region"
      aria-label="Peak risk days"
      style={{
        background: '#FCEBEB', borderLeft: '3px solid #A32D2D',
        padding: '10px 14px', borderRadius: 8, marginBottom: 18,
      }}>
      <div style={{ fontSize: 11, fontWeight: 500, color: '#501313', textTransform: 'uppercase', letterSpacing: 0.3, marginBottom: 6 }}>
        Peak risk · {peakRisk.length} day{peakRisk.length === 1 ? '' : 's'} at risk
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
        {visible.map((pr) => {
          const worst = worstType(pr);
          const clickable = !!onCellClick && worst;
          const handleClick = clickable ? () => onCellClick({
            typeId: worst.id, typeName: worst.name,
            dayIso: pr.iso, dayLabel: pr.label,
            available: worst.available, capacity: worst.capacity,
          }) : undefined;
          return (
            <button
              key={pr.iso}
              type="button"
              onClick={handleClick}
              disabled={!clickable}
              style={{
                textAlign: 'left',
                background: 'transparent',
                border: 'none',
                padding: '2px 6px',
                margin: '0 -6px',
                borderRadius: 4,
                cursor: clickable ? 'pointer' : 'default',
                color: '#501313',
                fontSize: 12,
                lineHeight: 1.5,
                fontFamily: 'inherit',
                transition: 'background 0.1s',
              }}
              onMouseEnter={clickable ? (e) => { e.currentTarget.style.background = 'rgba(163, 45, 45, 0.08)'; } : undefined}
              onMouseLeave={clickable ? (e) => { e.currentTarget.style.background = 'transparent'; } : undefined}
              aria-label={clickable ? `${pr.label}: view reservations for ${worst.name}` : undefined}
            >
              <strong style={{ fontWeight: 500 }}>{pr.label}</strong>
              {' — '}
              {pr.atRiskTypes.map((t, idx) => (
                <span key={t.id}>
                  {idx > 0 ? ', ' : ''}
                  {t.name} {t.available === 0 ? 'sold out' : `at ${t.available} left`}
                </span>
              ))}
              <span style={{ color: '#791F1F', opacity: 0.8 }}>
                {' '}({pr.pctFleetFree}% fleet free)
              </span>
              {clickable ? (
                <span aria-hidden="true" style={{ color: '#791F1F', opacity: 0.5, marginLeft: 6, fontSize: 11 }}>→</span>
              ) : null}
            </button>
          );
        })}
        {overflow > 0 ? (
          <div style={{ fontSize: 12, color: '#791F1F', opacity: 0.7, padding: '2px 6px' }}>
            …and {overflow} more risk day{overflow === 1 ? '' : 's'}
          </div>
        ) : null}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tab bar
// ---------------------------------------------------------------------------

function TabBar({ tabs, active, onChange }) {
  const refs = useRef([]);

  const onKeyDown = (e, idx) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight' && e.key !== 'Home' && e.key !== 'End') return;
    e.preventDefault();
    let next = idx;
    if (e.key === 'ArrowLeft') next = (idx - 1 + tabs.length) % tabs.length;
    else if (e.key === 'ArrowRight') next = (idx + 1) % tabs.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = tabs.length - 1;
    onChange(tabs[next].key);
    // Defer focus to next paint so the active style applies first
    setTimeout(() => refs.current[next]?.focus(), 0);
  };

  return (
    <div
      role="tablist"
      aria-label="Forecast views"
      style={{ display: 'flex', gap: 0, borderBottom: '1px solid #d3d1c7', marginBottom: 18 }}
    >
      {tabs.map((t, idx) => {
        const isActive = t.key === active;
        return (
          <button
            key={t.key}
            ref={(el) => { refs.current[idx] = el; }}
            role="tab"
            id={`forecast-tab-${t.key}`}
            aria-selected={isActive}
            aria-controls={`forecast-panel-${t.key}`}
            tabIndex={isActive ? 0 : -1}
            onClick={() => onChange(t.key)}
            onKeyDown={(e) => onKeyDown(e, idx)}
            style={{
              padding: '10px 16px', fontSize: 13,
              background: 'transparent', cursor: 'pointer',
              border: 'none',
              color: isActive ? '#211a38' : '#6f668f',
              fontWeight: isActive ? 500 : 400,
              borderBottom: isActive ? '2px solid #534AB7' : '2px solid transparent',
              marginBottom: -1,
              outlineOffset: 2,
            }}
          >
            {t.label}
          </button>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tab: At a glance
// ---------------------------------------------------------------------------

function GlanceTab({ days, types, fleet }) {
  // Show only the next 7 days (subset of provided days)
  const horizon = Math.min(7, days.length);
  const slice = days.slice(0, horizon);

  return (
    <div>
      {/* Available right now (= day 0) */}
      <section style={{ marginBottom: 22 }}>
        <SectionHeader>Available right now</SectionHeader>
        {types.length === 0 ? (
          <EmptyState>No vehicle types configured for this tenant.</EmptyState>
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 10 }}>
            {types.map((t) => {
              const av = t.availableByDay?.[0] ?? 0;
              const cap = t.capacity || 0;
              const pct = cap > 0 ? av / cap : 0;
              const ring = pct === 0 && cap > 0 ? '#501313' : pct < 0.2 ? '#F7C1C1' : pct < 0.5 ? '#FAC775' : '#C0DD97';
              return (
                <div key={t.id} style={{ background: 'white', border: `0.5px solid #d3d1c7`, borderLeft: `4px solid ${ring}`, borderRadius: 8, padding: '10px 12px' }}>
                  <div style={{ fontSize: 11, color: '#6f668f', textTransform: 'uppercase', letterSpacing: 0.3 }}>{t.code}</div>
                  <div style={{ fontWeight: 500, color: '#211a38' }}>{t.name}</div>
                  <div style={{ fontSize: 20, fontWeight: 500, color: '#211a38', marginTop: 4 }}>
                    {av}<span style={{ fontSize: 12, color: '#6f668f', fontWeight: 400 }}> / {cap}</span>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>

      {/* Compact 7-day heat grid */}
      <section>
        <SectionHeader>Next 7 days</SectionHeader>
        <HeatGrid days={slice} types={types} fleet={fleet} compact onCellClick={null} />
      </section>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tab: Forecast (default)
// ---------------------------------------------------------------------------

function ForecastTab({ days, types, fleet, peakIdx, onCellClick }) {
  return (
    <div>
      <section style={{ marginBottom: 22 }}>
        <SectionHeader>Daily available by vehicle type</SectionHeader>
        <div style={{ fontSize: 11, color: '#6f668f', marginBottom: 8 }}>
          Cell value = units still available ·
          <Pill bg="#C0DD97" fg="#173404">green ≥50%</Pill>
          <Pill bg="#FAC775" fg="#412402">amber 20–50%</Pill>
          <Pill bg="#F7C1C1" fg="#501313">red &lt;20%</Pill>
          <Pill bg="#501313" fg="white">black sold out</Pill>
          <span style={{ marginLeft: 8 }}>· click a cell to see reservations</span>
        </div>
        <HeatGrid days={days} types={types} fleet={fleet} onCellClick={onCellClick} />
      </section>

      <section>
        <SectionHeader>Demand pressure — daily utilization</SectionHeader>
        <div style={{ background: 'white', border: '0.5px solid #d3d1c7', borderRadius: 8, padding: 16 }}>
          <UtilizationBarChart
            days={days}
            utilizationByDay={fleet.utilizationByDay || fleet.reservedByDay?.map((r) => fleet.capacity > 0 ? r / fleet.capacity : 0) || []}
            peakIdx={peakIdx}
            height={200}
          />
        </div>
      </section>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tab: Trends
// ---------------------------------------------------------------------------

function TrendsTab({ days, fleet, bookingPace, lastYear, soldOutByMonth, compareLastYear, onToggleLastYear }) {
  const utilizationByDay = fleet.utilizationByDay
    || fleet.reservedByDay?.map((r) => fleet.capacity > 0 ? r / fleet.capacity : 0)
    || [];
  const lyAvailable = !!lastYear && lastYear.hasData;
  const showLY = compareLastYear && lyAvailable;

  return (
    <div>
      <section style={{ marginBottom: 22 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 8 }}>
          <div style={{ fontSize: 12, color: '#6f668f', fontWeight: 500, textTransform: 'uppercase' }}>Utilization over time</div>
          <label style={{
            marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8,
            fontSize: 12, color: lastYear?.hasData === false && compareLastYear ? '#6f668f' : '#211a38',
            cursor: 'pointer',
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
            No last-year data for this window — toggle reverts to forecast-only.
          </div>
        ) : null}
        <div style={{ background: 'white', border: '0.5px solid #d3d1c7', borderRadius: 8, padding: 16 }}>
          <UtilizationLineChart
            days={days}
            utilizationByDay={utilizationByDay}
            lastYearByDay={lastYear?.utilizationByDay || null}
            showLastYear={showLY}
            height={240}
          />
        </div>
      </section>

      <section style={{ marginBottom: 22 }}>
        <SectionHeader>Booking pace — how full the period is filling up</SectionHeader>
        <div style={{ background: 'white', border: '0.5px solid #d3d1c7', borderRadius: 8, padding: 16 }}>
          <BookingPaceChart
            binsDaysOut={bookingPace?.binsDaysOut || []}
            thisPct={bookingPace?.pct || []}
            lastYearPct={lastYear?.bookingPace?.pct || null}
            showLastYear={showLY}
            height={220}
          />
          <PaceNarrative bookingPace={bookingPace} lastYearPace={showLY ? lastYear?.bookingPace : null} />
        </div>
      </section>

      <section>
        <SectionHeader>Sold-out incidence — last 12 months</SectionHeader>
        <div style={{ background: 'white', border: '0.5px solid #d3d1c7', borderRadius: 8, padding: 16 }}>
          {Array.isArray(soldOutByMonth) && soldOutByMonth.length > 0 ? (
            <SoldOutIncidenceChart soldOutByMonth={soldOutByMonth} height={170} />
          ) : (
            <div style={{ padding: 30, textAlign: 'center', color: '#6f668f', fontSize: 12 }}>
              Not enough history to chart sold-out incidence.
            </div>
          )}
        </div>
      </section>
    </div>
  );
}

// Narrative blurb beneath the booking-pace chart — compares this period's pace at
// 7 days out vs LY's pace at the same lead time. Falls back to a neutral message
// when LY data is unavailable.
function PaceNarrative({ bookingPace, lastYearPace }) {
  const thisAt7 = bookingPace?.pct?.[7];
  if (typeof thisAt7 !== 'number') return null;

  if (lastYearPace?.pct?.[7] !== undefined) {
    const lyAt7 = lastYearPace.pct[7];
    const delta = thisAt7 - lyAt7;
    if (Math.abs(delta) < 0.03) {
      return (
        <div style={{ background: '#f1efe8', color: '#5F5E5A', padding: '6px 10px', borderRadius: 6, fontSize: 12, marginTop: 8 }}>
          Booking pace matches last year — about {Math.round(thisAt7 * 100)}% of capacity booked at T-7 days, same as historical.
        </div>
      );
    }
    const ahead = delta > 0;
    return (
      <div style={{
        background: ahead ? '#EAF3DE' : '#FCEBEB',
        color: ahead ? '#173404' : '#791F1F',
        padding: '6px 10px', borderRadius: 6, fontSize: 12, marginTop: 8,
      }}>
        <strong>{ahead ? 'Filling ahead of pace.' : 'Filling behind pace.'}</strong>{' '}
        {Math.round(thisAt7 * 100)}% of capacity booked at T-7 vs typical {Math.round(lyAt7 * 100)}%.
      </div>
    );
  }

  return (
    <div style={{ background: '#f1efe8', color: '#5F5E5A', padding: '6px 10px', borderRadius: 6, fontSize: 12, marginTop: 8 }}>
      {Math.round(thisAt7 * 100)}% of capacity booked at T-7 days. Toggle "Compare to last year" to see typical pace.
    </div>
  );
}

// ---------------------------------------------------------------------------
// Heat grid (used by At-a-glance and Forecast tabs)
// ---------------------------------------------------------------------------

function HeatGrid({ days, types, fleet, compact, onCellClick }) {
  if (types.length === 0) {
    return <EmptyState>No vehicle types configured for this tenant.</EmptyState>;
  }
  const cellPad = compact ? '4px 6px' : '6px 8px';
  return (
    <div style={{ border: '0.5px solid #d3d1c7', borderRadius: 8, overflowX: 'auto', background: 'white' }}>
      <table style={{ width: '100%', fontSize: 12, borderCollapse: 'collapse', minWidth: compact ? 480 : 700 }}>
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
              <Td align="center" muted padding={cellPad}>{t.capacity}</Td>
              {t.availableByDay.slice(0, days.length).map((av, i) => {
                const cap = t.capacity;
                const handleClick = onCellClick ? () => onCellClick({
                  typeId: t.id, typeName: t.name, dayIso: days[i].iso, dayLabel: days[i].label,
                  available: av, capacity: cap,
                }) : null;
                return (
                  <Td
                    key={i}
                    align="center"
                    heat={heatColor(av, cap)}
                    fg={av === 0 && cap > 0 ? 'white' : undefined}
                    bold={av === 0 && cap > 0}
                    onClick={handleClick}
                    padding={cellPad}
                  >
                    {av}
                  </Td>
                );
              })}
            </tr>
          ))}
          <tr style={{ background: '#f1efe8' }}>
            <Td stickyLeft emphasis>Fleet total</Td>
            <Td align="center" emphasis padding={cellPad}>{fleet.capacity}</Td>
            {fleet.availableByDay.slice(0, days.length).map((av, i) => (
              <Td key={i} align="center" emphasis padding={cellPad}>{av}</Td>
            ))}
          </tr>
        </tbody>
      </table>
    </div>
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

function EmptyState({ children }) {
  return (
    <div style={{ padding: 40, textAlign: 'center', color: '#6f668f', background: '#f1efe8', borderRadius: 8 }}>
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

function Td({ children, align = 'left', heat, emphasis, muted, fg, bold, stickyLeft, onClick, padding }) {
  const clickable = !!onClick;
  return (
    <td
      onClick={onClick}
      style={{
        textAlign: align,
        padding: padding || '6px 8px',
        borderTop: '0.5px solid #d3d1c7',
        background: heat || undefined,
        fontWeight: (emphasis || bold) ? 500 : 400,
        color: fg || (muted ? '#6f668f' : undefined),
        fontSize: 12,
        cursor: clickable ? 'pointer' : 'default',
        transition: clickable ? 'filter 0.1s' : undefined,
        ...(stickyLeft ? { position: 'sticky', left: 0, background: heat || 'white', zIndex: 1 } : {}),
      }}
      onMouseEnter={clickable ? (e) => { e.currentTarget.style.filter = 'brightness(0.92)'; } : undefined}
      onMouseLeave={clickable ? (e) => { e.currentTarget.style.filter = ''; } : undefined}
    >{children}</td>
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
