'use client';

/**
 * Taxes — Round 31 (2026-05-23).
 *
 * Tax collected + taxable base, by category and by day. Source: same
 * RentalAgreementCharge ledger as the Sales report, isolated to TAX-type
 * rows (with the taxable=true non-TAX rows giving us the base for the
 * effective-rate calculation).
 *
 *   ┌───────────────────────────────────────────────────────────┐
 *   │ Title · Filter bar (Period + Location)                    │
 *   ├───────────────────────────────────────────────────────────┤
 *   │ 4 KPIs: Tax collected · Taxable base · Eff. rate · Agreements│
 *   ├───────────────────────────────────────────────────────────┤
 *   │ Chart.js bar — tax collected per day                      │
 *   ├───────────────────────────────────────────────────────────┤
 *   │ Per-tax-category table (clickable rows → drill drawer)    │
 *   └───────────────────────────────────────────────────────────┘
 */

import { useEffect, useMemo, useState } from 'react';
import { AuthGate } from '../../../components/AuthGate';
import { AppShell } from '../../../components/AppShell';
import { api } from '../../../lib/client';
import { ReportPageLayout } from '../../../components/reports/ReportPageLayout';
import { ChargeListDrawer } from '../../../components/reports/ChargeListDrawer';
import { StackedDayBarChart } from '../../../components/reports/charts/StackedDayBarChart';

function isoDay(d) { return d.toISOString().slice(0, 10); }
function fmtMoney(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return '$0.00';
  return `$${v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
function fmtPct(v) { return `${(Number(v) * 100).toFixed(2)}%`; }

function defaultRange() {
  const t = new Date();
  const from = new Date(t.getFullYear(), t.getMonth(), 1);
  return { from: isoDay(from), to: isoDay(t) };
}

function buildCategoryEndpoint(category, range, locationId) {
  if (!category?.name) return null;
  const params = new URLSearchParams();
  params.set('names', category.name);
  if (range?.from) params.set('from', range.from);
  if (range?.to)   params.set('to',   range.to);
  if (locationId)  params.set('locationId', locationId);
  return `/api/reports/taxes/category?${params.toString()}`;
}

export default function Page() {
  return <AuthGate>{({ token, me, logout }) => <TaxesReport token={token} me={me} logout={logout} />}</AuthGate>;
}

function TaxesReport({ token, me, logout }) {
  const [range, setRange] = useState(defaultRange);
  const [locationId, setLocationId] = useState('');
  const [locations, setLocations] = useState([]);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [drillCategory, setDrillCategory] = useState(null);

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
        const out = await api(`/api/reports/taxes?${params.toString()}`, { bypassCache: true }, token);
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

  return (
    <AppShell me={me} logout={logout}>
      <ReportPageLayout
        slug="taxes"
        title="Taxes"
        description="Tax collected by category, plus taxable base for your accountant."
        category="Revenue"
        token={token}
        range={range}
        onRangeChange={setRange}
        extraFilters={locationFilter}
      >
        {loading && !data ? (
          <Skeleton />
        ) : error ? (
          <div role="alert" style={{ background: '#FCEBEB', color: '#791F1F', padding: 12, borderRadius: 8 }}>{error}</div>
        ) : data ? (
          <ReportBody data={data} onCategoryClick={setDrillCategory} />
        ) : null}

        <ChargeListDrawer
          open={!!drillCategory}
          endpoint={buildCategoryEndpoint(drillCategory, range, locationId)}
          title={drillCategory?.name || ''}
          subtitle={drillCategory ? `${fmtMoney(drillCategory.amount)} collected` : undefined}
          token={token}
          onClose={() => setDrillCategory(null)}
        />
      </ReportPageLayout>
    </AppShell>
  );
}

// ---------------------------------------------------------------------------
// Body
// ---------------------------------------------------------------------------

function ReportBody({ data, onCategoryClick }) {
  const { totals, byCategory, byDay, peakDay, truncated } = data;

  const chartDays = useMemo(() => byDay.map((d) => ({ iso: d.iso, label: d.label })), [byDay]);
  const chartSeries = useMemo(() => [{
    key: 'TAX',
    label: 'Tax collected',
    color: '#EF9F27',
    data: byDay.map((d) => d.taxCollected),
  }], [byDay]);
  const peakIdx = useMemo(() => peakDay ? byDay.findIndex((d) => d.iso === peakDay.iso) : -1, [byDay, peakDay]);

  return (
    <div>
      {truncated ? (
        <div style={{ background: '#FAEEDA', color: '#412402', padding: 10, borderRadius: 8, marginBottom: 12, fontSize: 12 }}>
          Range capped at 366 days — narrow the window to see more detail.
        </div>
      ) : null}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: 10, marginBottom: 18 }}>
        <Card
          label="Tax collected"
          value={fmtMoney(totals.taxCollected)}
          hint="to remit"
          bg={totals.taxCollected > 0 ? '#FAEEDA' : undefined}
          fg={totals.taxCollected > 0 ? '#412402' : undefined}
        />
        <Card label="Taxable base" value={fmtMoney(totals.taxableBase)} hint="charges flagged taxable" />
        <Card
          label="Effective rate"
          value={fmtPct(totals.effectiveRate)}
          hint="collected ÷ taxable base"
          bg="#EEEDFE" fg="#26215C"
        />
        <Card
          label="Taxed agreements"
          value={String(totals.taxedAgreementCount)}
          hint={`of ${totals.totalAgreementCount} in window`}
        />
      </div>

      {totals.taxCollected > 0 ? (
        <section style={{ marginBottom: 22 }}>
          <SectionHeader>Tax collected by day</SectionHeader>
          <div style={{ background: 'white', border: '0.5px solid #d3d1c7', borderRadius: 8, padding: 14 }}>
            <StackedDayBarChart
              days={chartDays}
              series={chartSeries}
              highlightIdx={peakIdx}
              height={200}
            />
            {peakDay ? (
              <div style={{ fontSize: 11, color: '#6f668f', marginTop: 6 }}>
                Peak day: <strong style={{ color: '#211a38' }}>{peakDay.label}</strong> · {fmtMoney(peakDay.taxCollected)} on {fmtMoney(peakDay.taxableBase)} taxable base
              </div>
            ) : null}
          </div>
        </section>
      ) : null}

      <section>
        <SectionHeader>By tax category</SectionHeader>
        <div style={{ border: '0.5px solid #d3d1c7', borderRadius: 8, overflowX: 'auto', background: 'white' }}>
          {byCategory.length === 0 ? (
            <EmptyState>
              No tax collected in this window. Make sure your charges have a TAX-type line (or that the period has any selected charges at all).
            </EmptyState>
          ) : (
            <table style={{ width: '100%', fontSize: 12, borderCollapse: 'collapse', minWidth: 600 }}>
              <thead>
                <tr style={{ background: '#f1efe8' }}>
                  <Th align="left">Tax category</Th>
                  <Th align="right">Count</Th>
                  <Th align="right" emphasis>Collected</Th>
                  <Th align="right">Effective rate</Th>
                  <Th align="right">% of tax</Th>
                </tr>
              </thead>
              <tbody>
                {byCategory.map((c) => (
                  <tr
                    key={c.name}
                    onClick={() => onCategoryClick(c)}
                    style={{ cursor: 'pointer', transition: 'filter 0.1s' }}
                    onMouseEnter={(e) => { e.currentTarget.style.filter = 'brightness(0.97)'; }}
                    onMouseLeave={(e) => { e.currentTarget.style.filter = ''; }}
                  >
                    <Td>
                      <div style={{ fontWeight: 500 }}>{c.name}</div>
                      {c.code ? <div style={{ fontSize: 10, color: '#6f668f' }}>{c.code}</div> : null}
                    </Td>
                    <Td align="right" muted>{c.count}</Td>
                    <Td align="right" emphasis>{fmtMoney(c.amount)}</Td>
                    <Td align="right" muted>{fmtPct(c.effectiveRate)}</Td>
                    <Td align="right" muted>{fmtPct(c.pctOfTotal)}</Td>
                  </tr>
                ))}
                <tr style={{ background: '#FAEEDA', color: '#412402' }}>
                  <Td emphasis>TAX TOTAL</Td>
                  <Td align="right" emphasis>{byCategory.reduce((acc, c) => acc + c.count, 0)}</Td>
                  <Td align="right" emphasis>{fmtMoney(totals.taxCollected)}</Td>
                  <Td align="right" emphasis>{fmtPct(totals.effectiveRate)}</Td>
                  <Td align="right" emphasis>100%</Td>
                </tr>
              </tbody>
            </table>
          )}
        </div>
        {byCategory.length > 0 ? (
          <div style={{ fontSize: 11, color: '#6f668f', marginTop: 6, paddingLeft: 4 }}>
            Click any category to see the individual TAX charges in that bucket.
          </div>
        ) : null}
      </section>
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
      <div style={{ fontSize: 22, fontWeight: 500, marginTop: 2, color: fg || '#211a38' }}>{value}</div>
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

function EmptyState({ children }) {
  return (
    <div style={{ padding: 30, textAlign: 'center', color: '#6f668f', background: '#f1efe8', borderRadius: 8, fontSize: 12 }}>
      {children}
    </div>
  );
}

function Th({ children, align = 'left', emphasis }) {
  return (
    <th style={{
      textAlign: align,
      padding: '8px 12px',
      fontWeight: 500,
      fontSize: 12,
      background: emphasis ? '#FAEEDA' : '#f1efe8',
      color: emphasis ? '#412402' : '#211a38',
      borderBottom: '0.5px solid #d3d1c7',
      whiteSpace: 'nowrap',
    }}>{children}</th>
  );
}

function Td({ children, align = 'left', emphasis, muted }) {
  return (
    <td style={{
      textAlign: align,
      padding: '6px 12px',
      borderTop: '0.5px solid #d3d1c7',
      fontWeight: emphasis ? 500 : 400,
      color: muted ? '#6f668f' : undefined,
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
    animation: 'rfm-tax-shimmer 1.4s ease-in-out infinite',
    borderRadius: 6,
  };
  return (
    <div aria-busy="true" aria-live="polite" aria-label="Loading report">
      <style>{`@keyframes rfm-tax-shimmer { 0% { background-position: 200% 0; } 100% { background-position: -200% 0; } }`}</style>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: 10, marginBottom: 18 }}>
        {[0, 1, 2, 3].map((i) => <div key={i} style={{ ...shimmer, height: 70 }} />)}
      </div>
      <div style={{ ...shimmer, height: 240, marginBottom: 22 }} />
      <div style={{ ...shimmer, height: 240 }} />
    </div>
  );
}
