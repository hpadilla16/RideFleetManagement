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
 * The model DROPDOWN and the "group by model" switch are the same question at
 * two depths: filter to the XC40s, or break every class into the models inside
 * it. The dropdown is built from the tenant's own fleet rather than being a
 * text box, so a selection can never miss and nobody has to guess at spelling;
 * each option carries its unit count, because a per-unit figure computed from
 * three cars deserves to be read as such. Both controls flow into the
 * PDF/Excel export through extraExportParams, so a filtered view never exports
 * unfiltered data (the LAWA lesson).
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
  // The options come back WITH the report (scoped by branch, never by the
  // current model selection), so the list cannot drift from what the table is
  // showing and cannot collapse to the one model already picked. Held
  // separately from `data` so it survives a filtered response.
  const [modelOptions, setModelOptions] = useState([]);
  // One control, three depths: the class, the model inside it, the individual
  // car. A checkbox could only ever express two of them.
  const [view, setView] = useState('type');
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
    // The option carries make and model separately, so they go over as
    // separate params rather than as the joined label: the server matches each
    // with `contains`, and "Volvo XC40" as one string is contained in neither
    // the make nor the model. Sending both is also exact — no fuzzy match can
    // pull in a second model that happens to share a word.
    // The whole label goes over as ONE param. Make and model sent separately
    // cannot survive this data: the fleet stores "FORD TRANSIT " with a
    // trailing space, so an exact match on the trimmed label the picker shows
    // returned zero cars. The server normalises both sides and resolves the
    // selection to vehicle ids, which no stray whitespace can distort.
    if (modelQuery) params.set('vehicleModel', modelQuery);
    if (view !== 'type') params.set('groupBy', view);
    (async () => {
      try {
        const out = await api(`/api/reports/revenue-by-vehicle-type?${params.toString()}`, { bypassCache: true }, token);
        if (!cancelled) {
          setData(out);
          if (Array.isArray(out?.modelOptions)) setModelOptions(out.modelOptions);
        }
      } catch (err) {
        if (!cancelled) setError(err?.message || 'Failed to load report');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
    // modelOptions is in the deps because the first render has none: the list
    // arrives WITH the report, so a selection restored before it loads would
    // otherwise silently fetch unfiltered.
  }, [token, range.from, range.to, locationId, modelQuery, view]);

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
      <select
        value={modelQuery}
        onChange={(e) => setModelQuery(e.target.value)}
        disabled={!modelOptions.length}
        style={{ fontSize: 13, padding: '6px 8px', minWidth: 190, borderRadius: 8, border: '0.5px solid #d3d1c7', background: 'white' }}
      >
        {/* Picking from the fleet means a selection can never miss. The unit
            count sits on each option so the reader knows how thin a model is
            before reading a per-unit figure computed from three cars. */}
        <option value="">All models</option>
        {modelOptions.map((m) => (
          <option key={m.label} value={m.label}>
            {m.label}{m.units ? ` (${m.units})` : ''}
          </option>
        ))}
      </select>

      <span style={{ fontSize: 13, color: '#6f668f', marginLeft: 8 }}>Break down by</span>
      <select
        value={view}
        onChange={(e) => setView(e.target.value)}
        style={{ fontSize: 13, padding: '6px 8px', minWidth: 130, borderRadius: 8, border: '0.5px solid #d3d1c7', background: 'white' }}
      >
        <option value="type">Vehicle type</option>
        <option value="model">Make and model</option>
        <option value="vehicle">Individual car</option>
      </select>
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

  const HEADERS = {
    type: ['Code', 'Vehicle type', 'Revenue', 'Share', 'Rentals', 'Days', 'Avg / rental', 'Per day', 'Units', 'Per unit'],
    model: ['Make & model', 'Class', 'Revenue', 'Share', 'Rentals', 'Days', 'Avg / rental', 'Per day', 'Units', 'Per unit'],
    // No Units or Per-unit column here: the row IS one car, so per-unit would
    // only repeat revenue. Days on rent takes their place.
    vehicle: ['Unit', 'Plate', 'VIN', 'Vehicle', 'Year', 'Class', 'Revenue', 'Share', 'Rentals', 'Days', 'Per day'],
  }[view];

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
        extraExportParams={{
          locationId,
          vehicleModel: modelQuery,
          groupBy: view === 'type' ? '' : view,
        }}
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
                  {view === 'vehicle' ? `${fmtInt(t.vehicleCount)} vehicles`
                    : view === 'model' ? `${fmtInt(t.modelCount)} models`
                    : `${fmtInt(t.typeCount)} classes`}
                </span>
              </div>

              <div style={{ overflowX: 'auto', padding: '0 8px 12px' }}>
                {rows.length ? (
                  <table style={{ width: '100%' }}>
                    <thead><tr>{HEADERS.map((h, i) => th(h, i >= 2))}</tr></thead>
                    <tbody>
                      {rows.map((r, i) => (view === 'vehicle' ? (
                        <tr key={r.vehicleId || i}>
                          {td(r.unit || '—', false, 'a')}
                          {td(r.plate || '—', false, 'b')}
                          {td(r.vin || '—', false, 'c')}
                          {td([r.make, r.model].filter(Boolean).join(' ') || '—', false, 'd')}
                          {td(r.year || '—', true, 'e')}
                          {td(r.typeCode || '—', false, 'f')}
                          {td(fmtMoney(r.revenue), true, 'g', true)}
                          {td(r.sharePct == null ? '—' : `${r.sharePct}%`, true, 'h')}
                          {td(fmtInt(r.rentals), true, 'i')}
                          {td(fmtInt(r.days), true, 'j')}
                          {td(fmtMoney(r.revenuePerDay), true, 'k')}
                        </tr>
                      ) : (
                        <tr key={`${r.typeId || r.label}-${i}`}>
                          {td(view === 'model' ? (r.label || '—') : (r.code || '—'), false, 'a')}
                          {td(view === 'model' ? (r.typeCode || '—') : r.name, false, 'b')}
                          {td(fmtMoney(r.revenue), true, 'c')}
                          {td(r.sharePct == null ? '—' : `${r.sharePct}%`, true, 'd')}
                          {td(fmtInt(r.rentals), true, 'e')}
                          {td(fmtInt(r.days), true, 'f')}
                          {td(fmtMoney(r.avgPerRental), true, 'g')}
                          {td(fmtMoney(r.revenuePerDay), true, 'h')}
                          {td(r.units ? fmtInt(r.units) : '—', true, 'i')}
                          {td(fmtMoney(r.revenuePerUnit), true, 'j', true)}
                        </tr>
                      )))}
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
