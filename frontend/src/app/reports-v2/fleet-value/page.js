'use client';

/**
 * Fleet Value & Rotation — 2026-06-10 (Vehicle Profile pack follow-up).
 *
 * "Valor de inventario": total invested vs current (declining-balance) value,
 * plus the per-vehicle list — cost in, depreciation, value today, and when
 * each unit is due for sale under the tenant rotation rule (TIME | MILEAGE).
 *
 *   ┌──────────────────────────────────────────────────────────────┐
 *   │ Title · Filter bar (As of · Location · Refresh)              │
 *   ├──────────────────────────────────────────────────────────────┤
 *   │ 4 KPIs: Invested · Value today · Depreciated · Ready to sell │
 *   ├──────────────────────────────────────────────────────────────┤
 *   │ Table: ready → approaching → in window. Rows link to vehicle │
 *   └──────────────────────────────────────────────────────────────┘
 *
 * Data source: GET /api/reports/fleet-value (fleet-value.report.js). Uses the
 * SAME vehicle-value helpers as the dashboard tile so numbers never disagree.
 */

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { AuthGate } from '../../../components/AuthGate';
import { AppShell } from '../../../components/AppShell';
import { api } from '../../../lib/client';
import { ReportPageLayout } from '../../../components/reports/ReportPageLayout';

const ROTATION_PILL = {
  ready:       { bg: '#FCEBEB', fg: '#501313', label: 'Ready to sell' },
  approaching: { bg: '#FAEEDA', fg: '#412402', label: 'Approaching' },
  ok:          { bg: '#EAF3DE', fg: '#173404', label: 'In window' },
};

const money = (v) => (v == null ? '—' : `$${Number(v).toLocaleString('en-US', { maximumFractionDigits: 0 })}`);

function todayRange() {
  const iso = new Date().toISOString().slice(0, 10);
  return { from: iso, to: iso };
}

export default function Page() {
  return <AuthGate>{({ token, me, logout }) => <FleetValueReport token={token} me={me} logout={logout} />}</AuthGate>;
}

function FleetValueReport({ token, me, logout }) {
  const [locationId, setLocationId] = useState('');
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
    (async () => {
      try {
        const out = await api(`/api/reports/fleet-value?${params.toString()}`, { bypassCache: true }, token);
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
        style={{ fontSize: 13, padding: '6px 8px', minWidth: 140, borderRadius: 8, border: '0.5px solid #d3d1c7', background: 'white' }}
      >
        <option value="">All</option>
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
      >↻</button>
    </>
  );

  const leftSlot = data ? (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
      <span style={{ fontSize: 13, color: '#6f668f' }}>As of</span>
      <span style={{ fontSize: 13, color: '#211a38', fontWeight: 500 }}>{data.asOfLabel}</span>
      <span style={{ fontSize: 13, color: '#6f668f' }}>· rule:</span>
      <span style={{ fontSize: 13, color: '#211a38', fontWeight: 500 }}>{data.rule === 'MILEAGE' ? 'Mileage' : 'Time in fleet'}</span>
    </div>
  ) : null;

  return (
    <AppShell me={me} logout={logout}>
      <ReportPageLayout
        slug="fleet-value"
        title="Fleet Value & Rotation"
        description="Invested vs current value, depreciation, and when each unit is due for sale."
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

function ReportBody({ data }) {
  const { totals, rows, rule, truncated } = data;

  return (
    <div>
      {truncated ? (
        <div style={{ background: '#FAEEDA', color: '#412402', padding: 10, borderRadius: 8, marginBottom: 12, fontSize: 12 }}>
          Showing the first 1,000 vehicles.
        </div>
      ) : null}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: 10, marginBottom: 18 }}>
        <Card label="Invested" value={money(totals.totalAcquisitionCost)} hint={`${totals.trackedCount} tracked vehicle${totals.trackedCount === 1 ? '' : 's'}`} />
        <Card label="Value today" value={money(totals.totalCurrentValue)} hint="declining balance" />
        <Card
          label="Depreciated"
          value={money(totals.totalDepreciated)}
          hint="invested − value today"
          bg={totals.totalDepreciated > 0 ? '#FAEEDA' : undefined}
          fg={totals.totalDepreciated > 0 ? '#412402' : undefined}
        />
        <Card
          label="Ready to sell"
          value={String(totals.readyCount)}
          hint={`${totals.approachingCount} approaching`}
          bg={totals.readyCount > 0 ? '#FCEBEB' : undefined}
          fg={totals.readyCount > 0 ? '#501313' : undefined}
        />
      </div>

      {totals.untrackedCount > 0 ? (
        <div style={{ fontSize: 11, color: '#6f668f', marginBottom: 8, paddingLeft: 4 }}>
          {totals.untrackedCount} vehicle{totals.untrackedCount === 1 ? '' : 's'} without value data — set cost, depreciation % and acquisition date from Edit Vehicle to include them.
        </div>
      ) : null}

      {rows.length === 0 ? (
        <div style={{ background: '#EAF3DE', color: '#173404', padding: 24, borderRadius: 8, textAlign: 'center', fontSize: 13 }}>
          No vehicles have value-tracker data yet. Set cost, depreciation and targets from each vehicle&apos;s Edit form.
        </div>
      ) : (
        <div style={{ border: '0.5px solid #d3d1c7', borderRadius: 8, overflow: 'hidden', background: 'white' }}>
          <table style={{ width: '100%', fontSize: 12, borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ background: '#f1efe8' }}>
                <Th align="left">Unit</Th>
                <Th align="left">Vehicle</Th>
                <Th align="left">Acquired</Th>
                <Th align="right">Cost</Th>
                <Th align="right">%/yr</Th>
                <Th align="right">Value today</Th>
                <Th align="right">Depreciated</Th>
                <Th align="left">{rule === 'MILEAGE' ? 'Sale due (miles)' : 'Sale due'}</Th>
                <Th align="left">Rotation</Th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const pill = r.rotation ? ROTATION_PILL[r.rotation] : null;
                return (
                  <tr key={r.id} style={{ borderTop: '0.5px solid #ece9df' }}>
                    <Td>
                      <Link href={`/vehicles/${r.id}`} style={{ fontWeight: 600, color: '#5b3df5', textDecoration: 'none' }}>
                        {r.internalNumber || r.plate || '—'}
                      </Link>
                    </Td>
                    <Td>{r.label || '—'}{r.plate && r.internalNumber ? <span style={{ color: '#6f668f' }}> · {r.plate}</span> : null}</Td>
                    <Td>{r.acquisitionDateLabel || '—'}</Td>
                    <Td align="right">{money(r.acquisitionCost)}</Td>
                    <Td align="right">{r.depreciationAnnualPct == null ? '—' : `${r.depreciationAnnualPct}%`}</Td>
                    <Td align="right"><strong>{money(r.currentValue)}</strong></Td>
                    <Td align="right">{r.depreciatedPct == null ? '—' : `${money(r.depreciatedAmount)} (${r.depreciatedPct}%)`}</Td>
                    <Td>{r.saleDueLabel || '—'}</Td>
                    <Td>
                      {pill ? (
                        <span style={{ background: pill.bg, color: pill.fg, fontSize: 11, padding: '2px 8px', borderRadius: 999, whiteSpace: 'nowrap' }}>
                          {pill.label}
                        </span>
                      ) : '—'}
                    </Td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function Card({ label, value, hint, bg, fg }) {
  return (
    <div style={{ background: bg || 'white', color: fg || '#211a38', border: '0.5px solid #d3d1c7', borderRadius: 8, padding: '12px 14px' }}>
      <div style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.4, opacity: 0.7 }}>{label}</div>
      <div style={{ fontSize: 22, fontWeight: 600, margin: '2px 0' }}>{value}</div>
      {hint ? <div style={{ fontSize: 11, opacity: 0.7 }}>{hint}</div> : null}
    </div>
  );
}

function Th({ children, align }) {
  return <th style={{ textAlign: align || 'left', padding: '8px 10px', fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.3, color: '#5d566f' }}>{children}</th>;
}

function Td({ children, align }) {
  return <td style={{ textAlign: align || 'left', padding: '8px 10px' }}>{children}</td>;
}

function Skeleton() {
  return (
    <div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: 10, marginBottom: 18 }}>
        {[0, 1, 2, 3].map((i) => (
          <div key={i} style={{ height: 74, background: '#f1efe8', borderRadius: 8 }} />
        ))}
      </div>
      <div style={{ height: 320, background: '#f1efe8', borderRadius: 8 }} />
    </div>
  );
}
