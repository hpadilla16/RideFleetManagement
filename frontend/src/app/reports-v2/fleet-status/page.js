'use client';

/**
 * Fleet Status — Round 29 (2026-05-23).
 *
 * Flat sortable list of every vehicle. Right-now snapshot, same chrome as
 * availability / rental-status but in detail-list form rather than rolled up.
 *
 *   ┌───────────────────────────────────────────────────────────────┐
 *   │ Title · Filter bar (As of · Location · Status · Search · ↻)   │
 *   ├───────────────────────────────────────────────────────────────┤
 *   │ 4 KPIs: Fleet · Available · On rent · Out of service          │
 *   ├───────────────────────────────────────────────────────────────┤
 *   │ Sortable vehicle table (click column headers to sort)         │
 *   │   Rows link to /vehicles/<id>                                 │
 *   └───────────────────────────────────────────────────────────────┘
 *
 * Filters: location + status are sent to the backend; the search box filters
 * client-side across plate / vehicle / class / customer name so it stays
 * responsive without re-fetching on every keystroke.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { AuthGate } from '../../../components/AuthGate';
import { AppShell } from '../../../components/AppShell';
import { api } from '../../../lib/client';
import { ReportPageLayout } from '../../../components/reports/ReportPageLayout';

// Status -> additive chip classes from the token layer (design/UI-MIGRATION.md).
const STATUS_PILL = {
  AVAILABLE:      { cls: 'chip chip--ok',      label: 'Available' },
  RESERVED:       { cls: 'chip chip--brand',   label: 'Reserved' },
  ON_RENT:        { cls: 'chip chip--warn',    label: 'On rent' },
  IN_MAINTENANCE: { cls: 'chip chip--neutral', label: 'Maintenance' },
  OUT_OF_SERVICE: { cls: 'chip chip--danger',  label: 'Out of service' },
};

// Sort order used when sorting by `status` column — urgency-first.
const STATUS_RANK = {
  ON_RENT: 0,
  IN_MAINTENANCE: 1,
  OUT_OF_SERVICE: 2,
  RESERVED: 3,
  AVAILABLE: 4,
};

const COLUMNS = [
  { key: 'plate',    label: 'Plate',     align: 'left',  accessor: (v) => v.plate || '' },
  { key: 'vehicle',  label: 'Vehicle',   align: 'left',  accessor: (v) => v.label || '' },
  { key: 'class',    label: 'Class',     align: 'left',  accessor: (v) => v.vehicleType?.name || '' },
  { key: 'mileage',  label: 'Mileage',   align: 'right', accessor: (v) => v.mileage || 0,  numeric: true },
  { key: 'location', label: 'Location',  align: 'left',  accessor: (v) => v.homeLocation?.name || '' },
  { key: 'status',   label: 'Status',    align: 'left',  accessor: (v) => STATUS_RANK[v.status] ?? 99, custom: true },
  { key: 'customer', label: 'Current customer', align: 'left',
    accessor: (v) => v.currentReservation?.customerName || '￿' /* sort no-customer last */ },
];

function fmtPct(v) { return `${(Number(v) * 100).toFixed(1)}%`; }

function todayRange() {
  const iso = new Date().toISOString().slice(0, 10);
  return { from: iso, to: iso };
}

export default function Page() {
  return <AuthGate>{({ token, me, logout }) => <FleetStatusReport token={token} me={me} logout={logout} />}</AuthGate>;
}

function FleetStatusReport({ token, me, logout }) {
  const [locationId, setLocationId] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [search, setSearch] = useState('');
  const [locations, setLocations] = useState([]);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [reloadKey, setReloadKey] = useState(0);
  const [sort, setSort] = useState({ key: 'status', dir: 'asc' });
  const range = todayRange();

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
    if (locationId) params.set('locationId', locationId);
    if (statusFilter) params.set('status', statusFilter);
    (async () => {
      try {
        const out = await api(`/api/reports/fleet-status?${params.toString()}`, { bypassCache: true }, token);
        if (!cancelled) setData(out);
      } catch (err) {
        if (!cancelled) setError(err?.message || 'Failed to load report');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [token, locationId, statusFilter, reloadKey]);

  const refresh = useCallback(() => setReloadKey((k) => k + 1), []);

  // Client-side: search + sort. Re-derive per render — cheap for typical
  // fleets (≤500 vehicles).
  const visibleVehicles = useMemo(() => {
    const rows = data?.vehicles || [];
    const term = search.trim().toLowerCase();
    let filtered = rows;
    if (term) {
      filtered = rows.filter((v) => {
        const haystack = [
          v.plate, v.internalNumber, v.label, v.color,
          v.vehicleType?.name, v.homeLocation?.name,
          v.currentReservation?.customerName,
        ].filter(Boolean).join(' ').toLowerCase();
        return haystack.includes(term);
      });
    }
    const col = COLUMNS.find((c) => c.key === sort.key) || COLUMNS[0];
    const factor = sort.dir === 'asc' ? 1 : -1;
    return [...filtered].sort((a, b) => {
      const av = col.accessor(a);
      const bv = col.accessor(b);
      if (col.numeric || col.custom) {
        return ((av || 0) - (bv || 0)) * factor || (a.plate || '').localeCompare(b.plate || '');
      }
      return (av || '').localeCompare(bv || '') * factor;
    });
  }, [data, search, sort]);

  const toggleSort = (key) => {
    setSort((prev) => {
      if (prev.key === key) return { key, dir: prev.dir === 'asc' ? 'desc' : 'asc' };
      return { key, dir: 'asc' };
    });
  };

  const locationFilter = (
    <>
      <span style={{ fontSize: 13, color: 'var(--text-3)' }}>Location</span>
      <select
        value={locationId}
        onChange={(e) => setLocationId(e.target.value || '')}
        style={{ fontSize: 13, padding: '6px 8px', minWidth: 140, width: 'auto', minHeight: 40 }}
      >
        <option value="">All</option>
        {locations.map((loc) => (
          <option key={loc.id} value={loc.id}>{loc.name || loc.code || loc.id}</option>
        ))}
      </select>
      <span style={{ fontSize: 13, color: 'var(--text-3)' }}>Status</span>
      <select
        value={statusFilter}
        onChange={(e) => setStatusFilter(e.target.value || '')}
        style={{ fontSize: 13, padding: '6px 8px', minWidth: 130, width: 'auto', minHeight: 40 }}
      >
        <option value="">Any</option>
        {Object.entries(STATUS_PILL).map(([key, p]) => (
          <option key={key} value={key}>{p.label}</option>
        ))}
      </select>
      <input
        type="search"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        placeholder="plate / model / customer"
        style={{ fontSize: 13, padding: '6px 10px', minWidth: 200, width: 'auto', minHeight: 40 }}
      />
      <button type="button" className="report-export-btn" onClick={refresh}>
        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M21 12a9 9 0 1 1-2.64-6.36" /><path d="M21 3v6h-6" /></svg>
        Refresh
      </button>
    </>
  );

  const leftSlot = data ? (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
      <span style={{ fontSize: 13, color: 'var(--text-3)' }}>As of</span>
      <span className="tnum" style={{ fontSize: 13, color: 'var(--text-1)', fontWeight: 600 }}>{data.asOfLabel}</span>
    </div>
  ) : null;

  return (
    <AppShell me={me} logout={logout}>
      <ReportPageLayout
        slug="fleet-status"
        title="Fleet Status"
        description="Every vehicle, current state. Filterable, sortable."
        category="Fleet"
        token={token}
        range={range}
        onRangeChange={() => {}}
        hideDateRange
        leftSlot={leftSlot}
        extraFilters={locationFilter}
      >
        {loading && !data ? (
          <Skeleton />
        ) : error ? (
          <div role="alert" style={{ background: 'var(--danger-bg)', color: 'var(--danger-tx)', border: '1px solid var(--danger-bd)', padding: 12, borderRadius: 'var(--r-md)' }}>{error}</div>
        ) : data ? (
          <ReportBody
            data={data}
            visibleVehicles={visibleVehicles}
            sort={sort}
            onSort={toggleSort}
            searchActive={!!search.trim()}
            statusFilter={statusFilter}
          />
        ) : null}
      </ReportPageLayout>
    </AppShell>
  );
}

// ---------------------------------------------------------------------------
// Body
// ---------------------------------------------------------------------------

function ReportBody({ data, visibleVehicles, sort, onSort, searchActive, statusFilter }) {
  const { totals } = data;
  const isFiltered = searchActive || !!statusFilter;

  return (
    <div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: 10, marginBottom: 18 }}>
        <Card label="Fleet total" value={String(totals.capacity)} hint="vehicles" />
        <Card
          label="Available"
          value={String(totals.AVAILABLE)}
          hint={`${fmtPct(totals.availablePct)} of fleet`}
          accent={totals.AVAILABLE > 0 ? 'ok' : undefined}
        />
        <Card
          label="On rent"
          value={String(totals.ON_RENT)}
          hint={`${fmtPct(totals.onRentPct)} of fleet`}
          accent="brand"
        />
        <Card
          label="Out of service"
          value={String(totals.outOfServiceTotal)}
          hint={`${totals.IN_MAINTENANCE} maint. · ${totals.OUT_OF_SERVICE} OOS`}
          accent={totals.outOfServiceTotal > 0 ? 'warn' : undefined}
        />
      </div>

      <div style={{ fontSize: 11, color: 'var(--text-3)', textTransform: 'uppercase', fontWeight: 600, letterSpacing: '.05em', marginBottom: 6 }}>
        {visibleVehicles.length} of {data.totalCount} vehicle{data.totalCount === 1 ? '' : 's'} shown
        {isFiltered ? ' · filters active' : ''}
        {' · click a column header to sort'}
      </div>
      <div className="table-shell">
        <table style={{ width: '100%', fontSize: 13, borderCollapse: 'collapse', minWidth: 800 }}>
          <thead>
            <tr>
              {COLUMNS.map((c) => (
                <Th key={c.key} align={c.align} sortKey={c.key} sort={sort} onClick={onSort}>{c.label}</Th>
              ))}
            </tr>
          </thead>
          <tbody>
            {visibleVehicles.length === 0 ? (
              <tr><Td colSpan={COLUMNS.length} muted center>
                {isFiltered ? 'No vehicles match the current filters.' : 'No vehicles configured for this tenant.'}
              </Td></tr>
            ) : visibleVehicles.map((v) => <Row key={v.id} v={v} />)}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Row({ v }) {
  const pill = STATUS_PILL[v.status] || { cls: 'chip chip--neutral', label: v.status };
  return (
    <tr>
      <td style={{ fontWeight: 500 }}>
        <Link href={`/vehicles/${v.id}`} style={{ textDecoration: 'none' }}>
          <span className="plate">{v.plate || '—'}</span>
        </Link>
        <div style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 2 }}>#{v.internalNumber}</div>
      </td>
      <td style={{ color: 'var(--text-1)' }}>
        {v.label || '—'}
        {v.color ? <span style={{ color: 'var(--text-3)' }}> · {v.color}</span> : null}
      </td>
      <td style={{ color: 'var(--text-3)' }}>{v.vehicleType?.name || '—'}</td>
      <td className="tnum" style={{ textAlign: 'right', color: 'var(--text-1)' }}>
        {v.mileage > 0 ? v.mileage.toLocaleString() : '—'}
      </td>
      <td style={{ color: 'var(--text-3)' }}>{v.homeLocation?.name || '—'}</td>
      <td>
        <span className={pill.cls}>{pill.label}</span>
      </td>
      <td>
        {v.currentReservation ? (
          <>
            <div style={{ color: 'var(--text-1)' }}>{v.currentReservation.customerName || '(no customer)'}</div>
            <div style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 1 }}>
              due {v.currentReservation.returnLabel || 'unknown'}
            </div>
          </>
        ) : (
          <span style={{ color: 'var(--text-3)' }}>—</span>
        )}
      </td>
    </tr>
  );
}

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

// Flat KPI card on the token layer; `accent` tints the VALUE only — labels
// and hints never drop below the 5.04:1 state-text floor.
const CARD_ACCENTS = {
  ok:    'var(--ok-tx)',
  warn:  'var(--warn-tx)',
  brand: 'var(--p-700)',
};
function Card({ label, value, hint, accent }) {
  return (
    <div className="kpi">
      <div className="klab">{label}</div>
      <div className="kval" style={accent ? { color: CARD_ACCENTS[accent] } : undefined}>{value}</div>
      {hint ? <div className="kfoot">{hint}</div> : null}
    </div>
  );
}

function Th({ children, align = 'left', sortKey, sort, onClick }) {
  const isActive = sort?.key === sortKey;
  const arrow = isActive ? (sort.dir === 'asc' ? ' ↑' : ' ↓') : '';
  return (
    <th
      onClick={() => onClick?.(sortKey)}
      style={{
        textAlign: align,
        whiteSpace: 'nowrap',
        cursor: 'pointer',
        userSelect: 'none',
      }}
    >
      {children}
      <span style={{ color: 'var(--p-700)', fontWeight: 600 }}>{arrow}</span>
    </th>
  );
}

function Td({ children, align = 'left', muted, center, colSpan }) {
  return (
    <td colSpan={colSpan} style={{
      textAlign: center ? 'center' : align,
      padding: muted || center ? '24px 12px' : undefined,
      color: muted ? 'var(--text-3)' : undefined,
    }}>{children}</td>
  );
}

// ---------------------------------------------------------------------------
// Skeleton
// ---------------------------------------------------------------------------

function Skeleton() {
  const shimmer = {
    background: 'linear-gradient(90deg, var(--n-100) 0%, var(--n-50) 50%, var(--n-100) 100%)',
    backgroundSize: '200% 100%',
    animation: 'rfm-fs-shimmer 1.4s ease-in-out infinite',
    borderRadius: 6,
  };
  return (
    <div aria-busy="true" aria-live="polite" aria-label="Loading report">
      <style>{`@keyframes rfm-fs-shimmer { 0% { background-position: 200% 0; } 100% { background-position: -200% 0; } }`}</style>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: 10, marginBottom: 18 }}>
        {[0, 1, 2, 3].map((i) => <div key={i} style={{ ...shimmer, height: 70 }} />)}
      </div>
      <div style={{ ...shimmer, height: 380 }} />
    </div>
  );
}
