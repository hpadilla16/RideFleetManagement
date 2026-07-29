'use client';

/**
 * Airport Report (LAWA) — 2026-07-29. Airport-concession compliance view:
 * one row per picked-up rental, RAReporting column layout. The Excel export
 * matches LAWA's intake format header-for-header; location + range flow into
 * the export via ReportPageLayout's extraExportParams.
 */

import { useEffect, useState } from 'react';
import { AuthGate } from '../../../components/AuthGate';
import { AppShell } from '../../../components/AppShell';
import { api } from '../../../lib/client';
import { ReportPageLayout } from '../../../components/reports/ReportPageLayout';

function isoDay(d) { return d.toISOString().slice(0, 10); }
function fmtMoney(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return '$0.00';
  return `$${v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
function defaultRange() {
  const t = new Date();
  const from = new Date(t.getFullYear(), t.getMonth(), 1);
  return { from: isoDay(from), to: isoDay(t) };
}

const HEADERS = [
  'R/A Number', 'PO Number', 'Source', 'Postal Code', 'Agent Out',
  'Days', 'Optional Services', 'Total Bill', 'Tax', 'Renter Payments', 'Extension Extra',
];

export default function Page() {
  return <AuthGate>{({ token, me, logout }) => <AirportReport token={token} me={me} logout={logout} />}</AuthGate>;
}

function AirportReport({ token, me, logout }) {
  const [range, setRange] = useState(defaultRange);
  const [locationId, setLocationId] = useState('');
  const [locations, setLocations] = useState([]);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

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
    params.set('from', range.from);
    params.set('to', range.to);
    if (locationId) params.set('locationId', locationId);
    (async () => {
      try {
        const out = await api(`/api/reports/airport-lawa?${params.toString()}`, { bypassCache: true }, token);
        if (!cancelled) setData(out);
      } catch (err) {
        if (!cancelled) setError(err?.message || 'Failed to load report');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [token, range.from, range.to, locationId]);

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

  const rows = Array.isArray(data?.rows) ? data.rows : [];
  const th = (label, right) => (
    <th key={label} style={{ textAlign: right ? 'right' : 'left', padding: '8px 10px', fontSize: 12, whiteSpace: 'nowrap' }}>{label}</th>
  );
  const td = (value, right, key) => (
    <td key={key} style={{ textAlign: right ? 'right' : 'left', padding: '6px 10px', fontSize: 13, ...(right ? { fontVariantNumeric: 'tabular-nums' } : {}) }}>{value}</td>
  );

  return (
    <AppShell me={me} logout={logout}>
      <ReportPageLayout
        slug="airport-lawa"
        title="Airport Report (LAWA)"
        description="Airport concession compliance — one row per picked-up rental, RAReporting format. The Excel export matches LAWA's intake headers exactly."
        category="Operations"
        token={token}
        range={range}
        onRangeChange={setRange}
        extraFilters={locationFilter}
        extraExportParams={{ locationId }}
      >
        {loading && !data ? (
          <div className="surface-note" style={{ margin: 16 }}>Loading…</div>
        ) : error ? (
          <div className="surface-note" style={{ margin: 16, color: '#b3261e' }}>{error}</div>
        ) : (
          <div className="glass card" style={{ padding: 0 }}>
            <div className="row-between" style={{ padding: '12px 16px', borderBottom: '1px solid rgba(0,0,0,0.08)' }}>
              <div style={{ fontWeight: 700 }}>{data?.locationLabel || 'All locations'}</div>
              <span className="label" style={{ textTransform: 'none' }}>{data?.count ?? 0} rentals</span>
            </div>
            <div style={{ overflowX: 'auto', padding: '0 8px 12px' }}>
              {rows.length ? (
                <table style={{ width: '100%' }}>
                  <thead>
                    <tr>{HEADERS.map((h, i) => th(h, i >= 5 && h !== 'Optional Services'))}</tr>
                  </thead>
                  <tbody>
                    {rows.map((r, i) => (
                      <tr key={i}>
                        {td(r.raNumber, false, 'ra')}
                        {td(r.poNumber || '—', false, 'po')}
                        {td(r.source, false, 'src')}
                        {td(r.postalCode || '—', false, 'zip')}
                        {td(r.agentOut || '—', false, 'agent')}
                        {td(r.rentalDays, true, 'days')}
                        {td(r.services || '—', false, 'svc')}
                        {td(fmtMoney(r.totalBill), true, 'bill')}
                        {td(fmtMoney(r.totalTax), true, 'tax')}
                        {td(fmtMoney(r.renterPayments), true, 'paid')}
                        {td(fmtMoney(r.extensionExtra), true, 'ext')}
                      </tr>
                    ))}
                    <tr style={{ fontWeight: 700, borderTop: '2px solid rgba(0,0,0,0.15)' }}>
                      {td('Totals', false, 't0')}
                      {td('', false, 't1')}{td('', false, 't2')}{td('', false, 't3')}{td('', false, 't4')}{td('', false, 't5')}{td('', false, 't6')}
                      {td(fmtMoney(data?.totals?.totalBill), true, 't7')}
                      {td(fmtMoney(data?.totals?.totalTax), true, 't8')}
                      {td(fmtMoney(data?.totals?.renterPayments), true, 't9')}
                      {td(fmtMoney(data?.totals?.extensionExtra), true, 't10')}
                    </tr>
                  </tbody>
                </table>
              ) : (
                <div className="surface-note" style={{ margin: 16 }}>No picked-up rentals in this range.</div>
              )}
            </div>
          </div>
        )}
      </ReportPageLayout>
    </AppShell>
  );
}
