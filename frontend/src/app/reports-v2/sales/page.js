'use client';

/**
 * Sales by Category — Round 28 (2026-05-23).
 *
 * Revenue grouped by line-item name. Source: RentalAgreementCharge filtered
 * to selected charges, date axis = rental pickup day. Tax separated from
 * sales for the headline figures.
 *
 *   ┌───────────────────────────────────────────────────────────┐
 *   │ Title · Description · Filter bar (period + location)      │
 *   ├───────────────────────────────────────────────────────────┤
 *   │ KPIs: Sales · Tax · Top category · Best day               │
 *   ├───────────────────────────────────────────────────────────┤
 *   │ Donut chart (top categories) | Category breakdown table   │
 *   ├───────────────────────────────────────────────────────────┤
 *   │ Tax breakdown table                                       │
 *   └───────────────────────────────────────────────────────────┘
 *
 * Click any category row → drill-down drawer with the individual charges
 * in that bucket. "Other" sends the full list of hidden category names.
 */

import { useEffect, useMemo, useState } from 'react';
import { AuthGate } from '../../../components/AuthGate';
import { AppShell } from '../../../components/AppShell';
import { api } from '../../../lib/client';
import { ReportPageLayout } from '../../../components/reports/ReportPageLayout';
import { ChargeListDrawer } from '../../../components/reports/ChargeListDrawer';
import {
  CategoryDonutChart,
  CATEGORY_DONUT_PALETTE,
} from '../../../components/reports/charts/CategoryDonutChart';

function isoDay(d) { return d.toISOString().slice(0, 10); }

function defaultRange() {
  const t = new Date();
  const from = new Date(t.getFullYear(), t.getMonth(), 1);
  return { from: isoDay(from), to: isoDay(t) };
}

function fmtMoney(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return '$0.00';
  return `$${v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
function fmtPct(v) { return `${(Number(v) * 100).toFixed(1)}%`; }

function buildCategoryEndpoint(category, range, locationId) {
  if (!category) return null;
  const names = category.isOther && Array.isArray(category.hiddenCategories)
    ? category.hiddenCategories.join(',')
    : category.name;
  if (!names) return null;
  const params = new URLSearchParams();
  params.set('names', names);
  if (range?.from) params.set('from', range.from);
  if (range?.to)   params.set('to',   range.to);
  if (locationId)  params.set('locationId', locationId);
  return `/api/reports/sales/category?${params.toString()}`;
}

export default function Page() {
  return <AuthGate>{({ token, me, logout }) => <SalesReport token={token} me={me} logout={logout} />}</AuthGate>;
}

function SalesReport({ token, me, logout }) {
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
        const out = await api(`/api/reports/sales?${params.toString()}`, { bypassCache: true }, token);
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
        slug="sales"
        title="Sales by Category"
        description="Revenue grouped by line-item category. Tax shown separately."
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
          title={drillCategory ? drillCategory.name : ''}
          subtitle={drillCategory ? `${fmtMoney(drillCategory.amount)} · ${fmtPct(drillCategory.pctOfSales)} of sales` : undefined}
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
  const { totals, topCategories, taxBreakdown, peakDay, categoryCount, truncated } = data;
  const topCat = topCategories[0] || null;

  // Slices: assign a palette colour per category in display order. The
  // "Other" bucket (always last) gets the reserved gray.
  const slices = useMemo(() => {
    return topCategories.map((c, i) => ({
      key: c.name,
      label: c.name,
      value: c.amount,
      color: c.isOther
        ? CATEGORY_DONUT_PALETTE[CATEGORY_DONUT_PALETTE.length - 1]
        : CATEGORY_DONUT_PALETTE[i % (CATEGORY_DONUT_PALETTE.length - 1)],
    }));
  }, [topCategories]);

  return (
    <div>
      {truncated ? (
        <div style={{ background: '#FAEEDA', color: '#412402', padding: 10, borderRadius: 8, marginBottom: 12, fontSize: 12 }}>
          Range capped — narrow the date window to see more detail.
        </div>
      ) : null}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: 10, marginBottom: 18 }}>
        <Card label="Sales" value={fmtMoney(totals.salesAmount)} hint={`pre-tax · ${totals.salesChargeCount} line items`} />
        <Card
          label="Tax collected"
          value={fmtMoney(totals.taxAmount)}
          hint={`${totals.taxChargeCount} lines`}
          bg="#FAEEDA" fg="#412402"
        />
        <Card
          label="Top category"
          value={topCat ? `${topCat.name} · ${fmtPct(topCat.pctOfSales)}` : '—'}
          valueSize={14}
          hint={topCat ? fmtMoney(topCat.amount) : ''}
          bg="#EEEDFE" fg="#26215C"
        />
        <Card
          label="Best day"
          value={peakDay.label}
          valueSize={14}
          hint={peakDay.amount > 0 ? fmtMoney(peakDay.amount) : '—'}
          bg="#FAEEDA" fg="#412402"
        />
      </div>

      <section style={{ marginBottom: 18 }}>
        <DonutAndTable
          slices={slices}
          topCategories={topCategories}
          totals={totals}
          onCategoryClick={onCategoryClick}
        />
      </section>
      <div style={{ fontSize: 11, color: '#6f668f', margin: '-8px 0 18px', paddingLeft: 4 }}>
        Click any category to see the individual charges in that bucket.
        {categoryCount > topCategories.filter((c) => !c.isOther).length
          ? ` ${categoryCount} distinct categories in total.`
          : ''}
      </div>

      {taxBreakdown.length > 0 ? (
        <section>
          <SectionHeader>Tax collected (separate from sales)</SectionHeader>
          <div style={{ border: '0.5px solid #d3d1c7', borderRadius: 8, overflow: 'hidden', background: 'white' }}>
            <table style={{ width: '100%', fontSize: 12, borderCollapse: 'collapse' }}>
              <thead>
                <tr style={{ background: '#f1efe8' }}>
                  <Th align="left">Tax category</Th>
                  <Th align="right">Count</Th>
                  <Th align="right" emphasis>Collected</Th>
                </tr>
              </thead>
              <tbody>
                {taxBreakdown.map((t) => (
                  <tr key={t.name}>
                    <Td>{t.name}</Td>
                    <Td align="right" muted>{t.count}</Td>
                    <Td align="right" emphasis>{fmtMoney(t.amount)}</Td>
                  </tr>
                ))}
                <tr style={{ background: '#FAEEDA', color: '#412402' }}>
                  <Td emphasis>TAX TOTAL</Td>
                  <Td align="right" emphasis>{totals.taxChargeCount}</Td>
                  <Td align="right" emphasis>{fmtMoney(totals.taxAmount)}</Td>
                </tr>
              </tbody>
            </table>
          </div>
        </section>
      ) : null}
    </div>
  );
}

function DonutAndTable({ slices, topCategories, totals, onCategoryClick }) {
  const hasData = totals.salesAmount > 0;
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '240px 1fr', gap: 14 }} className="rfm-sales-split">
      <div style={{ background: 'white', border: '0.5px solid #d3d1c7', borderRadius: 8, padding: 14 }}>
        <div style={{ fontSize: 11, color: '#6f668f', textTransform: 'uppercase', fontWeight: 500, marginBottom: 8 }}>Mix</div>
        {hasData ? (
          <CategoryDonutChart
            slices={slices}
            centerLabel="Sales"
            centerValue={fmtMoney(totals.salesAmount)}
            onSliceClick={(idx) => {
              const cat = topCategories[idx];
              if (cat) onCategoryClick(cat);
            }}
            height={200}
            formatValue={fmtMoney}
          />
        ) : (
          <div style={{ padding: 40, textAlign: 'center', color: '#6f668f', fontSize: 12 }}>
            No sales in the selected window.
          </div>
        )}
      </div>

      <div style={{ background: 'white', border: '0.5px solid #d3d1c7', borderRadius: 8, overflowX: 'auto' }}>
        <table style={{ width: '100%', fontSize: 12, borderCollapse: 'collapse', minWidth: 460 }}>
          <thead>
            <tr style={{ background: '#f1efe8' }}>
              <Th align="left">Category</Th>
              <Th align="right">Count</Th>
              <Th align="right">Total</Th>
              <Th align="right">Avg</Th>
              <Th align="right" emphasis>% mix</Th>
            </tr>
          </thead>
          <tbody>
            {topCategories.map((c, i) => (
              <tr
                key={c.name}
                onClick={() => onCategoryClick(c)}
                style={{ cursor: 'pointer', transition: 'filter 0.1s' }}
                onMouseEnter={(e) => { e.currentTarget.style.filter = 'brightness(0.97)'; }}
                onMouseLeave={(e) => { e.currentTarget.style.filter = ''; }}
              >
                <Td>
                  <span style={{
                    display: 'inline-block', width: 8, height: 8,
                    background: slices[i]?.color || '#888780',
                    borderRadius: 2, marginRight: 8, verticalAlign: 'middle',
                  }} aria-hidden="true" />
                  {c.name}
                  {!c.isOther && c.chargeType ? (
                    <span style={{ marginLeft: 6, fontSize: 10, color: '#6f668f' }}>{c.chargeType}</span>
                  ) : null}
                </Td>
                <Td align="right" muted>{c.count}</Td>
                <Td align="right" emphasis>{fmtMoney(c.amount)}</Td>
                <Td align="right" muted>{fmtMoney(c.avgPerSale)}</Td>
                <Td align="right" emphasis>{fmtPct(c.pctOfSales)}</Td>
              </tr>
            ))}
            <tr style={{ background: '#EEEDFE', color: '#26215C' }}>
              <Td emphasis>SALES TOTAL</Td>
              <Td align="right" emphasis>{totals.salesChargeCount}</Td>
              <Td align="right" emphasis>{fmtMoney(totals.salesAmount)}</Td>
              <Td align="right" emphasis>—</Td>
              <Td align="right" emphasis>100%</Td>
            </tr>
          </tbody>
        </table>
      </div>

      {/* Mobile: stack the donut on top of the table when narrow */}
      <style>{`
        @media (max-width: 720px) {
          .rfm-sales-split { grid-template-columns: 1fr !important; }
        }
      `}</style>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

function Card({ label, value, hint, valueSize, bg, fg }) {
  return (
    <div style={{ background: bg || '#f1efe8', padding: '12px 14px', borderRadius: 8, color: fg }}>
      <div style={{ fontSize: 12, color: fg || '#6f668f' }}>{label}</div>
      <div style={{ fontSize: valueSize || 22, fontWeight: 500, marginTop: 2, color: fg || '#211a38' }}>{value}</div>
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

function Th({ children, align = 'left', emphasis }) {
  return (
    <th style={{
      textAlign: align,
      padding: '8px 12px',
      fontWeight: 500,
      fontSize: 12,
      background: emphasis ? '#EEEDFE' : '#f1efe8',
      color: emphasis ? '#26215C' : '#211a38',
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
    animation: 'rfm-sales-shimmer 1.4s ease-in-out infinite',
    borderRadius: 6,
  };
  return (
    <div aria-busy="true" aria-live="polite" aria-label="Loading report">
      <style>{`@keyframes rfm-sales-shimmer { 0% { background-position: 200% 0; } 100% { background-position: -200% 0; } }`}</style>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: 10, marginBottom: 18 }}>
        {[0, 1, 2, 3].map((i) => <div key={i} style={{ ...shimmer, height: 64 }} />)}
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '240px 1fr', gap: 14, marginBottom: 18 }}>
        <div style={{ ...shimmer, height: 240 }} />
        <div style={{ ...shimmer, height: 240 }} />
      </div>
      <div style={{ ...shimmer, height: 120 }} />
    </div>
  );
}
