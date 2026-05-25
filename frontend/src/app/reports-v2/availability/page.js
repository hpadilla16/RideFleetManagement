'use client';

/**
 * Availability — Round 29 (2026-05-23).
 *
 * Right-now snapshot of every vehicle's state, grouped by class. Same chrome
 * pattern as rental-status / unpaid-balance — no date range, just location +
 * Refresh.
 *
 *   ┌───────────────────────────────────────────────────────────┐
 *   │ Title · Filter bar (As of <ts> · Location · Refresh)      │
 *   ├───────────────────────────────────────────────────────────┤
 *   │ 4 KPIs: Fleet · Available · On rent · Out of service      │
 *   ├───────────────────────────────────────────────────────────┤
 *   │ Per-class table (5-column status breakdown, click to drill)│
 *   └───────────────────────────────────────────────────────────┘
 *
 * Drill-down: click a class row → side panel with the specific vehicles in
 * that class, including the active reservation on each ON_RENT car.
 */

import { useCallback, useEffect, useState } from 'react';
import { AuthGate } from '../../../components/AuthGate';
import { AppShell } from '../../../components/AppShell';
import { api } from '../../../lib/client';
import { ReportPageLayout } from '../../../components/reports/ReportPageLayout';
import { VehicleListDrawer } from '../../../components/reports/VehicleListDrawer';

function fmtPct(v) { return `${(Number(v) * 100).toFixed(1)}%`; }

function todayRange() {
  const iso = new Date().toISOString().slice(0, 10);
  return { from: iso, to: iso };
}

function buildTypeEndpoint(typeId, locationId) {
  if (!typeId) return null;
  const params = new URLSearchParams();
  params.set('type', typeId);
  if (locationId) params.set('locationId', locationId);
  return `/api/reports/availability/type?${params.toString()}`;
}

export default function Page() {
  return <AuthGate>{({ token, me, logout }) => <AvailabilityReport token={token} me={me} logout={logout} />}</AuthGate>;
}

function AvailabilityReport({ token, me, logout }) {
  const [locationId, setLocationId] = useState('');
  const [locations, setLocations] = useState([]);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [reloadKey, setReloadKey] = useState(0);
  const [drillType, setDrillType] = useState(null);
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
    (async () => {
      try {
        const out = await api(`/api/reports/availability?${params.toString()}`, { bypassCache: true }, token);
        if (!cancelled) setData(out);
      } catch (err) {
        if (!cancelled) setError(err?.message || 'Failed to load report');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [token, locationId, reloadKey]);

  const refresh = useCallback(() => setReloadKey((k) => k + 1), []);

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
        slug="availability"
        title="Availability — Right Now"
        description="Live snapshot of every vehicle's state, grouped by class. (Forward-looking inventory lives in the Availability Forecast report.)"
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
          <ReportBody data={data} onTypeClick={setDrillType} />
        ) : null}

        <VehicleListDrawer
          open={!!drillType}
          endpoint={drillType ? buildTypeEndpoint(drillType.id, locationId) : null}
          title={drillType ? drillType.name : ''}
          subtitle={drillType
            ? `${drillType.capacity} in fleet · ${drillType.counts.AVAILABLE} available · ${drillType.counts.ON_RENT} on rent`
            : undefined}
          token={token}
          onClose={() => setDrillType(null)}
        />
      </ReportPageLayout>
    </AppShell>
  );
}

// ---------------------------------------------------------------------------
// Body
// ---------------------------------------------------------------------------

function ReportBody({ data, onTypeClick }) {
  const { totals, types } = data;

  return (
    <div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: 10, marginBottom: 18 }}>
        <Card label="Fleet total" value={String(totals.capacity)} hint="vehicles" />
        <Card
          label="Available now"
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
          hint={`${totals.IN_MAINTENANCE} maintenance · ${totals.OUT_OF_SERVICE} OOS`}
          bg={totals.outOfServiceTotal > 0 ? '#FAEEDA' : undefined}
          fg={totals.outOfServiceTotal > 0 ? '#412402' : undefined}
        />
      </div>

      {types.length === 0 ? (
        <div style={{
          background: '#f1efe8', color: '#444441',
          padding: 30, borderRadius: 8, textAlign: 'center', fontSize: 13,
        }}>
          No vehicles configured for this {data.filters.locationId ? 'location' : 'tenant'}.
        </div>
      ) : (
        <section>
          <SectionHeader>By vehicle class</SectionHeader>
          <div style={{ border: '0.5px solid #d3d1c7', borderRadius: 8, overflowX: 'auto', background: 'white' }}>
            <table style={{ width: '100%', fontSize: 12, borderCollapse: 'collapse', minWidth: 580 }}>
              <thead>
                <tr style={{ background: '#f1efe8' }}>
                  <Th align="left">Class</Th>
                  <Th align="right">Capacity</Th>
                  <Th align="right" fg="#173404">Available</Th>
                  <Th align="right" fg="#26215C">Reserved</Th>
                  <Th align="right" fg="#26215C">On rent</Th>
                  <Th align="right" fg="#412402">Maint.</Th>
                  <Th align="right" fg="#412402">OOS</Th>
                </tr>
              </thead>
              <tbody>
                {types.map((t) => (
                  <tr
                    key={t.id}
                    onClick={() => onTypeClick(t)}
                    style={{ cursor: 'pointer', transition: 'filter 0.1s' }}
                    onMouseEnter={(e) => { e.currentTarget.style.filter = 'brightness(0.97)'; }}
                    onMouseLeave={(e) => { e.currentTarget.style.filter = ''; }}
                  >
                    <Td>
                      <div style={{ fontWeight: 500 }}>{t.name}</div>
                      {t.code ? <div style={{ fontSize: 10, color: '#6f668f' }}>{t.code}</div> : null}
                    </Td>
                    <Td align="right" muted>{t.capacity}</Td>
                    <Td align="right" cellBg={t.counts.AVAILABLE > 0 ? '#EAF3DE' : undefined} cellFg={t.counts.AVAILABLE > 0 ? '#173404' : undefined} emphasis={t.counts.AVAILABLE > 0}>
                      {t.counts.AVAILABLE}
                    </Td>
                    <Td align="right">{t.counts.RESERVED}</Td>
                    <Td align="right" cellBg={t.counts.ON_RENT > 0 ? '#EEEDFE' : undefined} cellFg={t.counts.ON_RENT > 0 ? '#26215C' : undefined} emphasis={t.counts.ON_RENT > 0}>
                      {t.counts.ON_RENT}
                    </Td>
                    <Td align="right">{t.counts.IN_MAINTENANCE}</Td>
                    <Td align="right">{t.counts.OUT_OF_SERVICE}</Td>
                  </tr>
                ))}
                <tr style={{ background: '#EEEDFE', color: '#26215C' }}>
                  <Td emphasis>FLEET TOTAL</Td>
                  <Td align="right" emphasis>{totals.capacity}</Td>
                  <Td align="right" emphasis>{totals.AVAILABLE}</Td>
                  <Td align="right" emphasis>{totals.RESERVED}</Td>
                  <Td align="right" emphasis>{totals.ON_RENT}</Td>
                  <Td align="right" emphasis>{totals.IN_MAINTENANCE}</Td>
                  <Td align="right" emphasis>{totals.OUT_OF_SERVICE}</Td>
                </tr>
              </tbody>
            </table>
          </div>
          <div style={{ fontSize: 11, color: '#6f668f', marginTop: 6, paddingLeft: 4 }}>
            Click any class row to see the individual vehicles + who has each rented car.
          </div>
        </section>
      )}
    </div>
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

function SectionHeader({ children }) {
  return (
    <div style={{ fontSize: 12, color: '#6f668f', fontWeight: 500, marginBottom: 8, textTransform: 'uppercase' }}>
      {children}
    </div>
  );
}

function Th({ children, align = 'left', emphasis, fg }) {
  return (
    <th style={{
      textAlign: align,
      padding: '8px 12px',
      fontWeight: 500,
      fontSize: 12,
      background: emphasis ? '#EEEDFE' : '#f1efe8',
      color: fg || (emphasis ? '#26215C' : '#211a38'),
      borderBottom: '0.5px solid #d3d1c7',
      whiteSpace: 'nowrap',
    }}>{children}</th>
  );
}

function Td({ children, align = 'left', emphasis, muted, cellBg, cellFg }) {
  return (
    <td style={{
      textAlign: align,
      padding: '6px 12px',
      borderTop: '0.5px solid #d3d1c7',
      background: cellBg || undefined,
      color: cellFg || (muted ? '#6f668f' : undefined),
      fontWeight: emphasis ? 500 : 400,
      fontSize: 12,
      whiteSpace: 'nowrap',
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
    animation: 'rfm-av-shimmer 1.4s ease-in-out infinite',
    borderRadius: 6,
  };
  return (
    <div aria-busy="true" aria-live="polite" aria-label="Loading report">
      <style>{`@keyframes rfm-av-shimmer { 0% { background-position: 200% 0; } 100% { background-position: -200% 0; } }`}</style>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: 10, marginBottom: 18 }}>
        {[0, 1, 2, 3].map((i) => <div key={i} style={{ ...shimmer, height: 70 }} />)}
      </div>
      <div style={{ ...shimmer, height: 280 }} />
    </div>
  );
}
