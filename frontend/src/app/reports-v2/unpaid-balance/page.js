'use client';

/**
 * Unpaid Balance — Round 28 (2026-05-23).
 *
 * Right-now AR aging snapshot. Same shape as rental-status (no date range,
 * just location filter + refresh) but for money owed instead of fleet state.
 *
 *   ┌─────────────────────────────────────────────────────────────────┐
 *   │ Title · Description · Filter bar (As of <ts> · Location · Refresh)│
 *   ├─────────────────────────────────────────────────────────────────┤
 *   │ 4 KPIs: Total · Average · Past due · Oldest debt                │
 *   ├─────────────────────────────────────────────────────────────────┤
 *   │ Aging summary — 5 colored cards (Current → 90+)                 │
 *   ├─────────────────────────────────────────────────────────────────┤
 *   │ Triage table grouped by bucket, 90+ first → Current last        │
 *   │   (rows link to /agreements/<id>)                                │
 *   └─────────────────────────────────────────────────────────────────┘
 */

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { AuthGate } from '../../../components/AuthGate';
import { AppShell } from '../../../components/AppShell';
import { api } from '../../../lib/client';
import { ReportPageLayout } from '../../../components/reports/ReportPageLayout';

const BUCKET_VISUAL = {
  CURRENT:  { headerBg: '#f1efe8', headerFg: '#211a38', cardBg: '#f1efe8', cardFg: '#444441', accent: '#888780' },
  B1_30:    { headerBg: '#FAEEDA', headerFg: '#412402', cardBg: '#FAEEDA', cardFg: '#412402', accent: '#EF9F27' },
  B31_60:   { headerBg: '#FAEEDA', headerFg: '#412402', cardBg: '#FAEEDA', cardFg: '#412402', accent: '#BA7517' },
  B61_90:   { headerBg: '#FCEBEB', headerFg: '#501313', cardBg: '#FCEBEB', cardFg: '#501313', accent: '#A32D2D' },
  B90_PLUS: { headerBg: '#FCEBEB', headerFg: '#501313', cardBg: '#FCEBEB', cardFg: '#501313', accent: '#501313' },
};

function fmtMoney(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return '$0.00';
  return `$${v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
function fmtPct(v) { return `${(Number(v) * 100).toFixed(1)}%`; }

// Aging-card display order = chronological (Current → 90+) for the summary
const SUMMARY_ORDER = ['CURRENT', 'B1_30', 'B31_60', 'B61_90', 'B90_PLUS'];

// Range required by ReportPageLayout for the export URL builder; not used
// by this report's API.
function todayRange() {
  const iso = new Date().toISOString().slice(0, 10);
  return { from: iso, to: iso };
}

export default function Page() {
  return <AuthGate>{({ token, me, logout }) => <UnpaidBalanceReport token={token} me={me} logout={logout} />}</AuthGate>;
}

function UnpaidBalanceReport({ token, me, logout }) {
  const [locationId, setLocationId] = useState('');
  // Row order within each aging bucket: 'age' (oldest first) or 'balance'
  // (largest owed first). Server-side so the PDF/Excel exports match the
  // screen — see the `sort` param on /api/reports/unpaid-balance.
  const [sort, setSort] = useState('age');
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
    if (sort && sort !== 'age') params.set('sort', sort);
    (async () => {
      try {
        const out = await api(`/api/reports/unpaid-balance?${params.toString()}`, { bypassCache: true }, token);
        if (!cancelled) setData(out);
      } catch (err) {
        if (!cancelled) setError(err?.message || 'Failed to load report');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [token, locationId, sort, reloadKey]);

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
      <span style={{ fontSize: 13, color: '#6f668f' }}>Sort</span>
      <select
        value={sort}
        onChange={(e) => setSort(e.target.value || 'age')}
        style={{ fontSize: 13, padding: '6px 8px', minWidth: 140, borderRadius: 8, border: '0.5px solid #d3d1c7', background: 'white' }}
      >
        <option value="age">Oldest first</option>
        <option value="balance">Largest balance first</option>
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
        slug="unpaid-balance"
        title="Unpaid Balance"
        description="Right-now AR aging snapshot. Money owed by customers, aged from rental return date."
        category="Revenue"
        token={token}
        range={range}
        onRangeChange={() => {}}
        hideDateRange
        leftSlot={leftSlot}
        extraFilters={locationFilter}
        // Without this the PDF/Excel buttons exported the UNFILTERED tenant —
        // same bug the LAWA report hit in 2026-07-29. The on-screen location
        // filter and sort order now carry into both exports.
        extraExportParams={{ locationId, sort }}
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
  const { totals, buckets } = data;
  const bucketByKey = new Map(buckets.map((b) => [b.key, b]));
  const summaryRows = SUMMARY_ORDER.map((k) => bucketByKey.get(k)).filter(Boolean);
  const visibleTriageBuckets = buckets.filter((b) => b.count > 0);

  return (
    <div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: 10, marginBottom: 18 }}>
        <Card label="Total outstanding" value={fmtMoney(totals.totalAmount)} hint={`${totals.accountCount} account${totals.accountCount === 1 ? '' : 's'}`} />
        <Card label="Average balance"   value={fmtMoney(totals.averageBalance)} hint="per account" />
        <Card
          label="Past due"
          value={fmtMoney(totals.pastDueAmount)}
          hint={`${fmtPct(totals.pastDuePct)} of total · ${totals.pastDueCount} account${totals.pastDueCount === 1 ? '' : 's'}`}
          bg={totals.pastDueAmount > 0 ? '#FCEBEB' : undefined}
          fg={totals.pastDueAmount > 0 ? '#501313' : undefined}
        />
        <Card
          label="Oldest debt"
          value={totals.oldestDaysLate > 0 ? `${totals.oldestDaysLate} days` : '—'}
          hint={totals.oldestDaysLate > 90 ? '90+ bucket' : totals.oldestDaysLate > 0 ? 'past return date' : 'all current'}
          bg={totals.oldestDaysLate > 60 ? '#FCEBEB' : undefined}
          fg={totals.oldestDaysLate > 60 ? '#501313' : undefined}
        />
      </div>

      <section style={{ marginBottom: 18 }}>
        <div style={{ background: 'white', border: '0.5px solid #d3d1c7', borderRadius: 8, padding: 14 }}>
          <SectionHeader>Aging summary</SectionHeader>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 8 }}>
            {summaryRows.map((b) => {
              const v = BUCKET_VISUAL[b.key] || BUCKET_VISUAL.CURRENT;
              return (
                <div key={b.key} style={{
                  borderLeft: `3px solid ${v.accent}`,
                  padding: '6px 10px',
                  background: v.cardBg,
                  borderRadius: 4,
                  color: v.cardFg,
                }}>
                  <div style={{ fontSize: 10, textTransform: 'uppercase', letterSpacing: 0.3 }}>{b.label}</div>
                  <div style={{ fontSize: 14, fontWeight: 500, marginTop: 2 }}>{fmtMoney(b.amount)}</div>
                  <div style={{ fontSize: 10, opacity: 0.85, marginTop: 2 }}>
                    {b.count} acct{b.count === 1 ? '' : 's'} · {fmtPct(b.pctOfTotal)}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </section>

      {visibleTriageBuckets.length === 0 ? (
        <div style={{
          background: '#EAF3DE', color: '#173404',
          padding: 24, borderRadius: 8, textAlign: 'center',
          fontSize: 13,
        }}>
          All accounts are paid up — no outstanding balances.
        </div>
      ) : (
        <section>
          <SectionHeader>
            Accounts · {data.filters?.sort === 'balance' ? 'largest balance first' : 'oldest first'}
          </SectionHeader>
          <div style={{ border: '0.5px solid #d3d1c7', borderRadius: 8, overflow: 'hidden', background: 'white' }}>
            {visibleTriageBuckets.map((b) => <BucketBlock key={b.key} bucket={b} />)}
          </div>
        </section>
      )}
    </div>
  );
}

function BucketBlock({ bucket }) {
  const v = BUCKET_VISUAL[bucket.key] || BUCKET_VISUAL.CURRENT;
  return (
    <div>
      <div style={{
        background: v.headerBg, color: v.headerFg,
        padding: '6px 12px', fontSize: 11, fontWeight: 500,
        textTransform: 'uppercase', letterSpacing: 0.3,
        borderBottom: '0.5px solid #d3d1c7',
      }}>
        {bucket.label} · {bucket.count} · {fmtMoney(bucket.amount)}
      </div>
      <table style={{ width: '100%', fontSize: 12, borderCollapse: 'collapse' }}>
        <tbody>
          {bucket.agreements.map((r) => <Row key={r.id} r={r} bucketKey={bucket.key} />)}
        </tbody>
      </table>
    </div>
  );
}

function Row({ r, bucketKey }) {
  const isPastDue = bucketKey !== 'CURRENT';
  const vehicleLabel = r.vehicle?.plate
    ? `[${r.vehicle.plate}] ${r.vehicle.label || ''}`
    : (r.vehicle?.label || '—');

  return (
    <tr style={{ borderTop: '0.5px solid #d3d1c7' }}>
      <td style={{ padding: '8px 12px', minWidth: 200 }}>
        <Link
          href={`/agreements/${r.id}`}
          style={{ color: '#211a38', textDecoration: 'none', fontWeight: 500 }}
        >
          {r.customerName || '(no customer)'}
        </Link>
        <div style={{ fontSize: 10, color: '#6f668f', marginTop: 1 }}>
          {r.agreementNumber ? `#${r.agreementNumber}` : `#${r.id}`}
          {r.customerPhone ? ` · ${r.customerPhone}` : ''}
        </div>
      </td>
      <td style={{ padding: '8px 12px', color: '#211a38' }}>
        {vehicleLabel}
        {r.pickupLocation ? (
          <div style={{ fontSize: 10, color: '#6f668f', marginTop: 1 }}>{r.pickupLocation}</div>
        ) : null}
      </td>
      <td style={{ padding: '8px 12px', color: '#211a38' }}>
        Returned {r.returnLabel}
        {r.pickupLabel ? (
          <div style={{ fontSize: 10, color: '#6f668f', marginTop: 1 }}>Out {r.pickupLabel}</div>
        ) : null}
        {isPastDue ? (
          <div style={{ fontSize: 11, fontWeight: 500, marginTop: 1, color: bucketKey === 'B90_PLUS' || bucketKey === 'B61_90' ? '#501313' : '#412402' }}>
            {r.daysLate} day{r.daysLate === 1 ? '' : 's'} late
          </div>
        ) : null}
      </td>
      {/* Status earns a column of its own: a CLOSED/FINALIZED agreement still
          owing money is the collectable case, while an in-progress rental
          carrying a balance is just a rental that has not been closed yet. */}
      <td style={{ padding: '8px 12px', color: '#6f668f', fontSize: 11, whiteSpace: 'nowrap' }}>
        {r.status || '—'}
      </td>
      <td style={{ padding: '8px 12px', textAlign: 'right', whiteSpace: 'nowrap' }}>
        <div style={{
          fontSize: 14, fontWeight: 500,
          color: isPastDue ? '#501313' : '#211a38',
        }}>
          {fmtMoney(r.balance)}
        </div>
        <div style={{ fontSize: 10, color: '#6f668f', marginTop: 1 }}>
          {fmtMoney(r.paid)} paid of {fmtMoney(r.total)}
        </div>
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

// ---------------------------------------------------------------------------
// Skeleton
// ---------------------------------------------------------------------------

function Skeleton() {
  const shimmer = {
    background: 'linear-gradient(90deg, #f1efe8 0%, #e8e6df 50%, #f1efe8 100%)',
    backgroundSize: '200% 100%',
    animation: 'rfm-ub-shimmer 1.4s ease-in-out infinite',
    borderRadius: 6,
  };
  return (
    <div aria-busy="true" aria-live="polite" aria-label="Loading report">
      <style>{`@keyframes rfm-ub-shimmer { 0% { background-position: 200% 0; } 100% { background-position: -200% 0; } }`}</style>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: 10, marginBottom: 18 }}>
        {[0, 1, 2, 3].map((i) => <div key={i} style={{ ...shimmer, height: 70 }} />)}
      </div>
      <div style={{ ...shimmer, height: 100, marginBottom: 18 }} />
      <div style={{ ...shimmer, height: 320 }} />
    </div>
  );
}
