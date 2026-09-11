'use client';

/**
 * Revenue by Vehicle Type — 2026-09-11.
 *
 * Hector: "un reporte de vehicle type, donde el tenant pueda ver cuánto está
 * generando en revenue un tipo de vehículo", and then: "que lo puedan
 * especificar por vehicle model, por ejemplo si nada más quieren ver los
 * Volvo XC40."
 *
 * The table leads on REVENUE PER UNIT rather than total revenue, because a
 * total mostly measures how many of that type you happen to own: against real
 * data, IRC's Compact SUV earns $56.2k to the Passenger Van's $7.2k, yet per
 * car the van earns $1,437 to the SUV's $1,061. A table sorted on totals says
 * the opposite of the truth, so per-unit is the emphasised column and the
 * server sorts on it.
 *
 * The make/model box and the "group by model" switch are the same question at
 * two depths: filter to the XC40s, or break every class into the models inside
 * it. Both flow into the PDF/Excel export through extraExportParams, so a
 * filtered view never exports unfiltered data (the LAWA lesson).
 */

import { useEffect, useState } from 'react';
import { AuthGate } from '../../../components/AuthGate';
import { AppShell } from '../../../components/AppShell';
import { api } from '../../../lib/client';
import { ReportPageLayout } from '../../../components/reports/ReportPageLayout';

function isoDay(d) { return d.toISOString().slice(0, 10); }
function defaultRange() {
  const t = new Date();
  return { from: isoDay(new Date(t.getFullYear(), t.getMonth(), 1)), to: isoDay(t) };
}
function fmtMoney(n) {
  if (n == null || n === '') return '—';
  const v = Number(n);
  if (!Number.isFinite(v)) return '—';
  return `$${v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
function fmtInt(n) {
  const v = Number(n);
  return Number.isFinite(v) ? v.toLocaleString() : '—';
}

export default function Page() {
  return <AuthGate>{({ token, me, logout }) => <RevenueByVehicleType token={token} me={me} logout={logout} />}</AuthGate>;
}

function RevenueByVehicleType({ token, me, logout }) {
  const [range, setRange] = useState(defaultRange);
  const [locationId, setLocationId] = useState('');
  const [locations, setLocations] = useState([]);
  const [modelQuery, setModelQuery] = useState('');
  // Typing filters on every keystroke would fire a request per letter, so the
  // box holds a draft and only a submit (or clear) becomes a query.
  const [modelDraft, setModelDraft] = useState('');
  const [byModel, setByModel] = useState(false);
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
    // One box, matched against make AND model server-side, because nobody
    // types "Volvo" when they already know it is the XC40 they want.
    if (modelQuery) params.set('model', modelQuery);
    if (byModel) params.set('groupBy', 'model');
    (async () => {
      try {
        const out = await api(`/api/reports/revenue-by-vehicle-type?${params.toString()}`, { bypassCache: true }, token);
        if (!cancelled) setData(out);
      } catch (err) {
        if (!cancelled) setError(err?.message || 'Failed to load report');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [token, range.from, range.to, locationId, modelQuery, byModel]);

  const filters = (
    <>
      <span style={{ fontSize: 13, color: '#6f668f' }}>Location</span>
      <select
        value={locationId}
        onChange={(e) => setLocationId(e.target.value || '')}
        style={{ fontSize: 13, padding: '6px 8px', minWidth: 150, borderRadius: 8, border: '0.5px solid #d3d1c7', background: 'white' }}
      >
        <option value="">All locations</option>
        {locations.map((loc) => (
          <option key={loc.id} value={loc.id}>{loc.name || loc.code || loc.id}</option>
        ))}
      </select>

      <span style={{ fontSize: 13, color: '#6f668f', marginLeft: 8 }}>Model</span>
      <form
        onSubmit={(e) => { e.preventDefault(); setModelQuery(modelDraft.trim()); }}
        style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}
      >
        <input
          value={modelDraft}
          onChange={(e) => setModelDraft(e.target.value)}
          placeholder="e.g. XC40"
          style={{ fontSize: 13, padding: '6px 8px', width: 130, borderRadius: 8, border: '0.5px solid #d3d1c7' }}
        />
        <button type="submit" className="btn" style={{ fontSize: 12, padding: '5px 10px' }}>Apply</button>
        {modelQuery && (
          <button
            type="button"
            className="btn"
            onClick={() => { setModelDraft(''); setModelQuery(''); }}
            style={{ fontSize: 12, padding: '5px 10px' }}
          >Clear</button>
        )}
      </form>

      <label style={{ display: 'inline-flex', gap: 6, alignItems: 'center', fontSize: 13, color: '#6f668f', marginLeft: 8 }}>
        <input type="checkbox" checked={byModel} onChange={(e) => setByModel(e.target.checked)} />
        Group by model
      </label>
    </>
  );

  const rows = Array.isArray(data?.rows) ? data.rows : [];
  const t = data?.totals || {};
  const th = (label, right) => (
    <th key={label} style={{ textAlign: right ? 'right' : 'left', padding: '8px 10px', fontSize: 12, whiteSpace: 'nowrap' }}>{label}</th>
  );
  const td = (value, right, key, strong) => (
    <td key={key} style={{
      textAlign: right ? 'right' : 'left', padding: '6px 10px', fontSize: 13,
      ...(right ? { fontVariantNumeric: 'tabular-nums' } : {}),
      ...(strong ? { fontWeight: 700 } : {}),
    }}>{value}</td>
  );

  const HEADERS = byModel
    ? ['Make & model', 'Class', 'Revenue', 'Share', 'Rentals', 'Days', 'Avg / rental', 'Per day', 'Units', 'Per unit']
    : ['Code', 'Vehicle type', 'Revenue', 'Share', 'Rentals', 'Days', 'Avg / rental', 'Per day', 'Units', 'Per unit'];

  return (
    <AppShell me={me} logout={logout}>
      <ReportPageLayout
        slug="revenue-by-vehicle-type"
        title="Revenue by Vehicle Type"
        description="What each class earns. Sorted by revenue per unit owned — a total mostly measures how many of that type you have. Excludes tax and security deposits; each rental counts against the vehicle actually assigned to it."
        category="Fleet"
        token={token}
        range={range}
        onRangeChange={setRange}
        extraFilters={filters}
        extraExportParams={{ locationId, model: modelQuery, groupBy: byModel ? 'model' : '' }}
      >
        {loading && !data ? (
          <div className="surface-note" style={{ margin: 16 }}>Loading…</div>
        ) : error ? (
          <div className="surface-note" style={{ margin: 16, color: '#b3261e' }}>{error}</div>
        ) : (
          <>
            <div className="glass card" style={{ padding: 0 }}>
              <div className="row-between" style={{ padding: '12px 16px', borderBottom: '1px solid rgba(0,0,0,0.08)' }}>
                <div style={{ fontWeight: 700 }}>
                  {fmtMoney(t.revenue)} across {fmtInt(t.rentals)} rental{t.rentals === 1 ? '' : 's'}
                  {modelQuery ? ` · filtered to “${modelQuery}”` : ''}
                </div>
                <span className="label" style={{ textTransform: 'none' }}>
                  {byModel ? `${fmtInt(t.modelCount)} models` : `${fmtInt(t.typeCount)} classes`}
                </span>
              </div>

              <div style={{ overflowX: 'auto', padding: '0 8px 12px' }}>
                {rows.length ? (
                  <table style={{ width: '100%' }}>
                    <thead><tr>{HEADERS.map((h, i) => th(h, i >= 2))}</tr></thead>
                    <tbody>
                      {rows.map((r, i) => (
                        <tr key={`${r.typeId || r.label}-${i}`}>
                          {td(byModel ? (r.label || '—') : (r.code || '—'), false, 'a')}
                          {td(byModel ? (r.typeCode || '—') : r.name, false, 'b')}
                          {td(fmtMoney(r.revenue), true, 'c')}
                          {td(r.sharePct == null ? '—' : `${r.sharePct}%`, true, 'd')}
                          {td(fmtInt(r.rentals), true, 'e')}
                          {td(fmtInt(r.days), true, 'f')}
                          {td(fmtMoney(r.avgPerRental), true, 'g')}
                          {td(fmtMoney(r.revenuePerDay), true, 'h')}
                          {td(r.units ? fmtInt(r.units) : '—', true, 'i')}
                          {td(fmtMoney(r.revenuePerUnit), true, 'j', true)}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                ) : (
                  <div className="surface-note" style={{ margin: 16 }}>
                    {modelQuery ? `No revenue for “${modelQuery}” in this range.` : 'No revenue in this range.'}
                  </div>
                )}
              </div>

              <div style={{ padding: '10px 16px', borderTop: '1px solid rgba(0,0,0,0.08)', fontSize: 12, color: '#6f668f' }}>
                Excludes tax ({fmtMoney(t.taxAmount)}) and security deposits ({fmtMoney(t.depositAmount)}).
                Cancelled and draft agreements are not sales.
              </div>
            </div>

            {/* Revenue that belongs to no class is a data-entry finding, not a
                rounding error — it gets said rather than folded into a total. */}
            {data?.unassigned?.revenue ? (
              <div className="glass card" style={{ marginTop: 12, padding: '12px 16px' }}>
                <div style={{ fontWeight: 700, marginBottom: 4 }}>Not attributable to a type</div>
                <div style={{ fontSize: 13, color: '#6f668f' }}>
                  {fmtMoney(data.unassigned.revenue)} across {fmtInt(data.unassigned.rentals)} rental(s) with no vehicle on
                  the agreement. Excluded from every per-type figure above.
                </div>
              </div>
            ) : null}

            {/* The other half of "what is each type doing for me", and invisible
                in a table built only from revenue rows. */}
            {data?.idleTypes?.length ? (
              <div className="glass card" style={{ marginTop: 12, padding: 0 }}>
                <div style={{ padding: '12px 16px', borderBottom: '1px solid rgba(0,0,0,0.08)', fontWeight: 700 }}>
                  In the fleet, no revenue this range
                </div>
                <div style={{ overflowX: 'auto', padding: '0 8px 12px' }}>
                  <table style={{ width: '100%' }}>
                    <thead><tr>{th('Code')}{th('Vehicle type')}{th('Units', true)}</tr></thead>
                    <tbody>
                      {data.idleTypes.map((x) => (
                        <tr key={x.id}>
                          {td(x.code || '—', false, 'c')}
                          {td(x.name, false, 'n')}
                          {td(fmtInt(x.units), true, 'u')}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            ) : null}
          </>
        )}
      </ReportPageLayout>
    </AppShell>
  );
}
