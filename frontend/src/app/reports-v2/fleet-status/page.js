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

const STATUS_PILL = {
  AVAILABLE:      { bg: '#EAF3DE', fg: '#173404', label: 'Available' },
  RESERVED:       { bg: '#EEEDFE', fg: '#26215C', label: 'Reserved' },
  ON_RENT:        { bg: '#FAEEDA', fg: '#412402', label: 'On rent' },
  IN_MAINTENANCE: { bg: '#F1EFE8', fg: '#444441', label: 'Maintenance' },
  OUT_OF_SERVICE: { bg: '#FCEBEB', fg: '#501313', label: 'Out of service' },
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
        style={{ fontSize: 13, padding: '6px 8px', minWidth: 130, borderRadius: 8, border: '0.5px solid #d3d1c7', background: 'white' }}
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
        style={{
          fontSize: 13, padding: '6px 10px', minWidth: 200,
          borderRadius: 8, border: '0.5px solid #d3d1c7', background: 'white',
        }}
      />
      <button
        type="button"
        onClick={refresh}
        style={{
          fontSize: 13, padding: '6px 12px',
          background: 'white', border: '0.5px solid #d3d1c7',
          borderRadius: 8, cursor: 'pointer',
          display: 'flex', alignItems: 'center', gap: 6, color: '#211a38',
        }}
      >↻ Refresh</button>
    </>
  );

  const leftSlot = data ? (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
      <span style={{ fontSize: 13, color: '#6f668f' }}>As of</span>
      <span style={{ fontSize: 13, color: '#211a38', fontWeight: 500 }}>{data.asOfLabel}</span>
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
          <div role="alert" style={{ background: '#FCEBEB', color: '#791F1F', padding: 12, borderRadius: 8 }}>{error}</div>
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
          bg={totals.AVAILABLE > 0 ? '#EAF3DE' : undefined}
          fg={totals.AVAILABLE > 0 ? '#173404' : undefined}
        />
        <Card
          label="On rent"
          value={String(totals.ON_RENT)}
          hint={`${fmtPct(totals.onRentPct)} of fleet`}
          bg="#EEEDFE" fg="#26215C"
        />
        <Card
          label="Out of service"
          value={String(totals.outOfServiceTotal)}
          hint={`${totals.IN_MAINTENANCE} maint. · ${totals.OUT_OF_SERVICE} OOS`}
          bg={totals.outOfServiceTotal > 0 ? '#FAEEDA' : undefined}
          fg={totals.outOfServiceTotal > 0 ? '#412402' : undefined}
        />
      </div>

      <div style={{ fontSize: 11, color: '#6f668f', textTransform: 'uppercase', fontWeight: 500, marginBottom: 6 }}>
        {visibleVehicles.length} of {data.totalCount} vehicle{data.totalCount === 1 ? '' : 's'} shown
        {isFiltered ? ' · filters active' : ''}
        {' · click a column header to sort'}
      </div>
      <div style={{ background: 'white', border: '0.5px solid #d3d1c7', borderRadius: 8, overflowX: 'auto' }}>
        <table style={{ width: '100%', fontSize: 12, borderCollapse: 'collapse', minWidth: 800 }}>
          <thead>
            <tr style={{ background: '#f1efe8' }}>
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
  const pill = STATUS_PILL[v.status] || { bg: '#f1efe8', fg: '#5F5E5A', label: v.status };
  return (
    <tr style={{ borderTop: '0.5px solid #d3d1c7' }}>
      <td style={{ padding: '8px 12px', fontWeight: 500 }}>
        <Link
          href={`/vehicles/${v.id}`}
          style={{ color: '#211a38', textDecoration: 'none' }}
        >
          {v.plate || '—'}
        </Link>
        <div style={{ fontSize: 10, color: '#6f668f', marginTop: 1 }}>#{v.internalNumber}</div>
      </td>
      <td style={{ padding: '8px 12px', color: '#211a38' }}>
        {v.label || '—'}
        {v.color ? <span style={{ color: '#6f668f' }}> · {v.color}</span> : null}
      </td>
      <td style={{ padding: '8px 12px', color: '#6f668f' }}>{v.vehicleType?.name || '—'}</td>
      <td style={{ padding: '8px 12px', textAlign: 'right', color: '#211a38', fontVariantNumeric: 'tabular-nums' }}>
        {v.mileage > 0 ? v.mileage.toLocaleString() : '—'}
      </td>
      <td style={{ padding: '8px 12px', color: '#6f668f' }}>{v.homeLocation?.name || '—'}</td>
      <td style={{ padding: '8px 12px' }}>
        <span style={{
          background: pill.bg, color: pill.fg, fontSize: 10,
          padding: '2px 8px', borderRadius: 999, whiteSpace: 'nowrap',
        }}>{pill.label}</span>
      </td>
      <td style={{ padding: '8px 12px' }}>
        {v.currentReservation ? (
          <>
            <div style={{ color: '#211a38' }}>{v.currentReservation.customerName || '(no customer)'}</div>
            <div style={{ fontSize: 11, color: '#6f668f', marginTop: 1 }}>
              due {v.currentReservation.returnLabel || 'unknown'}
            </div>
          </>
        ) : (
          <span style={{ color: '#6f668f' }}>—</span>
        )}
      </td>
    </tr>
  );
}

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

function Card({ label, value, hint, bg, fg }) {
  return (
    <div style={{ background: bg || '#f1efe8', padding: '12px 14px', borderRadius: 8, color: fg }}>
      <div style={{ fontSize: 12, color: fg || '#6f668f' }}>{label}</div>
      <div style={{ fontSize: 24, fontWeight: 500, marginTop: 2, color: fg || '#211a38' }}>{value}</div>
      {hint ? <div style={{ fontSize: 11, color: fg || '#6f668f', marginTop: 2 }}>{hint}</div> : null}
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
        padding: '8px 12px',
        fontWeight: 500,
        fontSize: 12,
        background: '#f1efe8',
        color: '#211a38',
        borderBottom: '0.5px solid #d3d1c7',
        whiteSpace: 'nowrap',
        cursor: 'pointer',
        userSelect: 'none',
      }}
    >
      {children}
      <span style={{ color: '#534AB7', fontWeight: 500 }}>{arrow}</span>
    </th>
  );
}

function Td({ children, align = 'left', muted, center, colSpan }) {
  return (
    <td colSpan={colSpan} style={{
      textAlign: center ? 'center' : align,
      padding: muted || center ? '24px 12px' : '6px 12px',
      borderTop: '0.5px solid #d3d1c7',
      color: muted ? '#6f668f' : undefined,
      fontSize: 12,
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
