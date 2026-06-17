'use client';

/**
 * Reports landing page V2 — Round 24 (2026-05-22).
 *
 * Parallel route alongside the legacy /reports page. New module ships here
 * first so we can iterate without disturbing the production MVP. When all
 * the new reports are live, we'll consolidate and retire the legacy page.
 *
 * Surfaces:
 *   - Snapshot strip (MTD revenue · reservations checked out · available)
 *   - Date range picker (drives the snapshot)
 *   - Tiles grouped by category (Management / Fleet / Operations / Revenue)
 *
 * Each AVAILABLE tile links to /reports-v2/{slug}. COMING_SOON tiles render
 * dimmed — when their round lands we flip the registry status server-side
 * and the tile lights up automatically.
 */

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { AuthGate } from '../../components/AuthGate';
import { AppShell } from '../../components/AppShell';
import { api } from '../../lib/client';
import { DateRangePicker } from '../../components/reports/DateRangePicker';

export default function Page() {
  return <AuthGate>{({ token, me, logout }) => <ReportsLanding token={token} me={me} logout={logout} />}</AuthGate>;
}

const CATEGORY_LABELS = {
  MANAGEMENT: 'Management',
  FLEET:      'Fleet',
  OPERATIONS: 'Operations',
  REVENUE:    'Revenue',
};

function ReportsLanding({ token, me, logout }) {
  const router = useRouter();
  const [reports, setReports] = useState([]);
  const [snapshot, setSnapshot] = useState(null);
  const [range, setRange] = useState(() => {
    const t = new Date();
    const from = new Date(t.getFullYear(), t.getMonth(), 1);
    return { from: from.toISOString().slice(0, 10), to: t.toISOString().slice(0, 10) };
  });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    (async () => {
      try {
        const [listR, snapR] = await Promise.allSettled([
          api('/api/reports/list', {}, token),
          api(`/api/reports/snapshot?from=${range.from}&to=${range.to}`, { bypassCache: true }, token),
        ]);
        if (cancelled) return;
        if (listR.status === 'fulfilled') setReports(listR.value?.reports || []);
        if (snapR.status === 'fulfilled') setSnapshot(snapR.value || null);
      } catch (err) {
        if (!cancelled) setError(err?.message || 'Failed to load reports');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [token, range.from, range.to]);

  const grouped = useMemo(() => {
    const out = {};
    for (const r of reports) {
      const key = r.category || 'OTHER';
      if (!out[key]) out[key] = [];
      out[key].push(r);
    }
    // Inventory Reports is a saved-report archive page (/reports-v2/inventory-reports),
    // not a registry slug — surface it as a Fleet tile so it stays reachable now that
    // it's no longer in the sidebar. The tile's slug routes there via the existing onClick.
    if (!reports.some((r) => r.slug === 'inventory-reports')) {
      if (!out.FLEET) out.FLEET = [];
      out.FLEET.push({
        slug: 'inventory-reports',
        title: 'Inventory Reports',
        description: 'Saved fleet inventory session reports (PDF archive).',
        status: 'AVAILABLE',
      });
    }
    return out;
  }, [reports]);

  return (
    <AppShell me={me} logout={logout}>
      <div style={{ maxWidth: 1200, margin: '0 auto', padding: '20px 24px' }}>

        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 16, flexWrap: 'wrap', gap: 12 }}>
          <div>
            <h1 style={{ margin: 0, fontSize: 26, fontWeight: 500 }}>Reports</h1>
            <div style={{ fontSize: 12, color: '#6f668f', marginTop: 4 }}>
              New module · the legacy reports MVP still lives at <a href="/reports" style={{ color: '#534AB7' }}>/reports</a>
            </div>
          </div>
          <DateRangePicker value={range} onChange={setRange} />
        </div>

        {error ? (
          <div style={{ background: '#FCEBEB', color: '#791F1F', padding: 12, borderRadius: 8, marginBottom: 16 }}>
            {error}
          </div>
        ) : null}

        {/* Snapshot strip */}
        <div style={{ background: '#f1efe8', borderRadius: 12, padding: 18, marginBottom: 24 }}>
          <div style={{ fontSize: 12, color: '#6f668f', fontWeight: 500, marginBottom: 12 }}>
            REPORTS SNAPSHOT · {range.from} to {range.to}
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12 }}>
            <SnapshotCard
              label="Revenue in period"
              value={loading ? '—' : `$${(snapshot?.revenue ?? 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`}
              accent="#173404"
            />
            <SnapshotCard
              label="Reservations checked out"
              value={loading ? '—' : (snapshot?.reservationsCheckedOut ?? 0).toLocaleString()}
            />
            <SnapshotCard
              label="Available vehicles"
              value={loading ? '—' : `${snapshot?.availableVehicles ?? 0} / ${snapshot?.totalFleet ?? 0}`}
              hint={snapshot ? `${snapshot.utilizationPct}% utilization` : null}
            />
          </div>
        </div>

        {/* Category grids */}
        {['MANAGEMENT', 'FLEET', 'OPERATIONS', 'REVENUE'].map((catKey) => {
          const items = grouped[catKey] || [];
          if (items.length === 0) return null;
          return (
            <div key={catKey} style={{ marginBottom: 22 }}>
              <div style={{ fontSize: 12, color: '#6f668f', fontWeight: 500, marginBottom: 8, textTransform: 'uppercase' }}>
                {CATEGORY_LABELS[catKey]}
              </div>
              <div style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
                gap: 8,
              }}>
                {items.map((report) => (
                  <ReportTile
                    key={report.slug}
                    report={report}
                    onClick={() => report.status === 'AVAILABLE' && router.push(`/reports-v2/${report.slug}`)}
                  />
                ))}
              </div>
            </div>
          );
        })}

        <div style={{ marginTop: 16, fontSize: 12, color: '#6f668f', textAlign: 'center' }}>
          Every tile opens its own page with PDF + Excel export · date filter applies per report.
        </div>
      </div>
    </AppShell>
  );
}

function SnapshotCard({ label, value, hint, accent }) {
  return (
    <div style={{ background: 'white', borderRadius: 8, padding: '14px 16px' }}>
      <div style={{ fontSize: 12, color: '#6f668f' }}>{label}</div>
      <div style={{ fontSize: 26, fontWeight: 500, color: accent || '#211a38', marginTop: 2 }}>{value}</div>
      {hint ? <div style={{ fontSize: 11, color: '#6f668f', marginTop: 2 }}>{hint}</div> : null}
    </div>
  );
}

function ReportTile({ report, onClick }) {
  const available = report.status === 'AVAILABLE';
  return (
    <div
      onClick={onClick}
      role="button"
      tabIndex={0}
      style={{
        background: 'white',
        border: '0.5px solid #d3d1c7',
        borderRadius: 8,
        padding: '12px 14px',
        cursor: available ? 'pointer' : 'not-allowed',
        opacity: available ? 1 : 0.55,
        transition: 'border-color 0.15s',
      }}
      onMouseEnter={(e) => { if (available) e.currentTarget.style.borderColor = '#534AB7'; }}
      onMouseLeave={(e) => { if (available) e.currentTarget.style.borderColor = '#d3d1c7'; }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8 }}>
        <div style={{ fontWeight: 500, fontSize: 14 }}>{report.title}</div>
        {!available ? (
          <span style={{
            fontSize: 10, padding: '2px 7px', borderRadius: 999,
            background: '#f1efe8', color: '#5F5E5A', whiteSpace: 'nowrap',
          }}>Coming soon</span>
        ) : null}
      </div>
      <div style={{ fontSize: 12, color: '#6f668f', marginTop: 4 }}>{report.description}</div>
    </div>
  );
}
