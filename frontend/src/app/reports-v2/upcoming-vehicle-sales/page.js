'use client';

/**
 * Upcoming Vehicle Sales — Round 29 (2026-05-23).
 *
 * Vehicles approaching the "time to sell" threshold. Defaults to 60,000 mi
 * and 4 years old; the page exposes both knobs so the user can dial them
 * for the current fleet's economics.
 *
 *   ┌───────────────────────────────────────────────────────────────┐
 *   │ Title · Filter bar (As of · Location · Mileage · Age · Refresh)│
 *   ├───────────────────────────────────────────────────────────────┤
 *   │ 4 KPIs: Candidates · Over · Approaching · Avg mileage         │
 *   ├───────────────────────────────────────────────────────────────┤
 *   │ Triage table grouped by bucket (OVER first → APPROACHING)     │
 *   │   Rows link to /vehicles/<id>                                 │
 *   └───────────────────────────────────────────────────────────────┘
 */

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { AuthGate } from '../../../components/AuthGate';
import { AppShell } from '../../../components/AppShell';
import { api } from '../../../lib/client';
import { ReportPageLayout } from '../../../components/reports/ReportPageLayout';

const BUCKET_VISUAL = {
  OVER:        { headerBg: '#FCEBEB', headerFg: '#501313' },
  APPROACHING: { headerBg: '#FAEEDA', headerFg: '#412402' },
};

const STATUS_PILL = {
  AVAILABLE:      { bg: '#EAF3DE', fg: '#173404', label: 'Available' },
  RESERVED:       { bg: '#EEEDFE', fg: '#26215C', label: 'Reserved' },
  ON_RENT:        { bg: '#FAEEDA', fg: '#412402', label: 'On rent' },
  IN_MAINTENANCE: { bg: '#F1EFE8', fg: '#444441', label: 'Maintenance' },
  OUT_OF_SERVICE: { bg: '#FCEBEB', fg: '#501313', label: 'Out of service' },
};

function todayRange() {
  const iso = new Date().toISOString().slice(0, 10);
  return { from: iso, to: iso };
}

export default function Page() {
  return <AuthGate>{({ token, me, logout }) => <UpcomingSalesReport token={token} me={me} logout={logout} />}</AuthGate>;
}

function UpcomingSalesReport({ token, me, logout }) {
  const [locationId, setLocationId] = useState('');
  const [maxMileage, setMaxMileage] = useState(60000);
  const [maxAge, setMaxAge] = useState(4);
  const [locations, setLocations] = useState([]);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [reloadKey, setReloadKey] = useState(0);
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
    if (maxMileage) params.set('maxMileage', String(maxMileage));
    if (maxAge)     params.set('maxAge',     String(maxAge));
    (async () => {
      try {
        const out = await api(`/api/reports/upcoming-vehicle-sales?${params.toString()}`, { bypassCache: true }, token);
        if (!cancelled) setData(out);
      } catch (err) {
        if (!cancelled) setError(err?.message || 'Failed to load report');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [token, locationId, maxMileage, maxAge, reloadKey]);

  const refresh = useCallback(() => setReloadKey((k) => k + 1), []);

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
      <span style={{ fontSize: 13, color: '#6f668f' }}>Max miles</span>
      <input
        type="number"
        min="0" step="1000"
        value={maxMileage}
        onChange={(e) => setMaxMileage(Math.max(0, Number(e.target.value) || 0))}
        style={{ fontSize: 13, padding: '6px 8px', width: 96, borderRadius: 8, border: '0.5px solid #d3d1c7', background: 'white' }}
      />
      <span style={{ fontSize: 13, color: '#6f668f' }}>Max age</span>
      <input
        type="number"
        min="0" step="1"
        value={maxAge}
        onChange={(e) => setMaxAge(Math.max(0, Number(e.target.value) || 0))}
        style={{ fontSize: 13, padding: '6px 8px', width: 60, borderRadius: 8, border: '0.5px solid #d3d1c7', background: 'white' }}
      />
      <span style={{ fontSize: 11, color: '#6f668f' }}>yrs</span>
      <button
        type="button"
        onClick={refresh}
        style={{
          fontSize: 13, padding: '6px 12px',
          background: 'white', border: '0.5px solid #d3d1c7',
          borderRadius: 8, cursor: 'pointer',
          display: 'flex', alignItems: 'center', gap: 6, color: '#211a38',
        }}
      >↻</button>
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
        slug="upcoming-vehicle-sales"
        title="Upcoming Vehicle Sales"
        description="Vehicles approaching the sale threshold by mileage or age."
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
  const { totals, buckets, thresholds, truncated } = data;
  const visibleBuckets = buckets.filter((b) => b.count > 0);

  return (
    <div>
      {truncated ? (
        <div style={{ background: '#FAEEDA', color: '#412402', padding: 10, borderRadius: 8, marginBottom: 12, fontSize: 12 }}>
          Showing the first 500 candidates — tighten the thresholds to see fewer.
        </div>
      ) : null}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: 10, marginBottom: 18 }}>
        <Card label="Candidates" value={String(totals.candidateCount)} hint="over + approaching" />
        <Card
          label="Sell now"
          value={String(totals.overCount)}
          hint="over threshold"
          bg={totals.overCount > 0 ? '#FCEBEB' : undefined}
          fg={totals.overCount > 0 ? '#501313' : undefined}
        />
        <Card
          label="Approaching"
          value={String(totals.approachingCount)}
          hint={`within ${Math.round(thresholds.approachingPct * 100)}% of threshold`}
          bg={totals.approachingCount > 0 ? '#FAEEDA' : undefined}
          fg={totals.approachingCount > 0 ? '#412402' : undefined}
        />
        <Card
          label="Avg mileage"
          value={totals.averageMileage.toLocaleString()}
          hint="across surfaced vehicles"
        />
      </div>

      <div style={{ fontSize: 11, color: '#6f668f', marginBottom: 8, paddingLeft: 4 }}>
        Thresholds: ≥ {thresholds.maxMileage.toLocaleString()} miles · ≥ {thresholds.maxAge} years.
        Click any row to open the vehicle.
      </div>

      {visibleBuckets.length === 0 ? (
        <div style={{
          background: '#EAF3DE', color: '#173404',
          padding: 24, borderRadius: 8, textAlign: 'center', fontSize: 13,
        }}>
          No vehicles are approaching the sale threshold. Fleet is healthy.
        </div>
      ) : (
        <section>
          <div style={{ border: '0.5px solid #d3d1c7', borderRadius: 8, overflow: 'hidden', background: 'white' }}>
            {visibleBuckets.map((b) => <BucketBlock key={b.key} bucket={b} />)}
          </div>
        </section>
      )}
    </div>
  );
}

function BucketBlock({ bucket }) {
  const v = BUCKET_VISUAL[bucket.key] || { headerBg: '#f1efe8', headerFg: '#211a38' };
  return (
    <div>
      <div style={{
        background: v.headerBg, color: v.headerFg,
        padding: '6px 12px', fontSize: 11, fontWeight: 500,
        textTransform: 'uppercase', letterSpacing: 0.3,
        borderBottom: '0.5px solid #d3d1c7',
      }}>
        {bucket.label} · {bucket.count}
      </div>
      <table style={{ width: '100%', fontSize: 12, borderCollapse: 'collapse' }}>
        <thead>
          <tr style={{ background: '#f1efe8' }}>
            <Th align="left">Plate</Th>
            <Th align="left">Vehicle</Th>
            <Th align="left">Class</Th>
            <Th align="right">Mileage</Th>
            <Th align="right">Age</Th>
            <Th align="left">Status</Th>
            <Th align="left">Reasons</Th>
          </tr>
        </thead>
        <tbody>
          {bucket.vehicles.map((v) => <Row key={v.id} v={v} bucketKey={bucket.key} />)}
        </tbody>
      </table>
    </div>
  );
}

function Row({ v, bucketKey }) {
  const pill = STATUS_PILL[v.status] || { bg: '#f1efe8', fg: '#5F5E5A', label: v.status };
  return (
    <tr style={{ borderTop: '0.5px solid #d3d1c7' }}>
      <td style={{ padding: '8px 12px', fontWeight: 500 }}>
        <Link href={`/vehicles/${v.id}`} style={{ color: '#211a38', textDecoration: 'none' }}>
          {v.plate || '—'}
        </Link>
        <div style={{ fontSize: 10, color: '#6f668f', marginTop: 1 }}>#{v.internalNumber}</div>
      </td>
      <td style={{ padding: '8px 12px', color: '#211a38' }}>
        {v.label || '—'}
        {v.color ? <span style={{ color: '#6f668f' }}> · {v.color}</span> : null}
      </td>
      <td style={{ padding: '8px 12px', color: '#6f668f' }}>{v.vehicleType || '—'}</td>
      <td style={{
        padding: '8px 12px', textAlign: 'right', fontVariantNumeric: 'tabular-nums',
        color: bucketKey === 'OVER' ? '#501313' : '#211a38',
        fontWeight: bucketKey === 'OVER' ? 500 : 400,
      }}>
        {v.mileage.toLocaleString()}
      </td>
      <td style={{ padding: '8px 12px', textAlign: 'right', color: '#211a38' }}>
        {v.age == null ? '—' : `${v.age}y`}
      </td>
      <td style={{ padding: '8px 12px' }}>
        <span style={{
          background: pill.bg, color: pill.fg, fontSize: 10,
          padding: '2px 8px', borderRadius: 999, whiteSpace: 'nowrap',
        }}>{pill.label}</span>
      </td>
      <td style={{ padding: '8px 12px', color: bucketKey === 'OVER' ? '#501313' : '#412402', fontSize: 11 }}>
        {v.reasons.join(' · ') || '—'}
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

function Th({ children, align = 'left' }) {
  return (
    <th style={{
      textAlign: align,
      padding: '8px 12px',
      fontWeight: 500,
      fontSize: 12,
      background: '#f1efe8',
      color: '#211a38',
      borderBottom: '0.5px solid #d3d1c7',
      whiteSpace: 'nowrap',
    }}>{children}</th>
  );
}

// ---------------------------------------------------------------------------
// Skeleton
// ---------------------------------------------------------------------------

function Skeleton() {
  const shimmer = {
    background: 'linear-gradient(90deg, #f1efe8 0%, #e8e6df 50%, #f1efe8 100%)',
    backgroundSize: '200% 100%',
    animation: 'rfm-uvs-shimmer 1.4s ease-in-out infinite',
    borderRadius: 6,
  };
  return (
    <div aria-busy="true" aria-live="polite" aria-label="Loading report">
      <style>{`@keyframes rfm-uvs-shimmer { 0% { background-position: 200% 0; } 100% { background-position: -200% 0; } }`}</style>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: 10, marginBottom: 18 }}>
        {[0, 1, 2, 3].map((i) => <div key={i} style={{ ...shimmer, height: 70 }} />)}
      </div>
      <div style={{ ...shimmer, height: 320 }} />
    </div>
  );
}
