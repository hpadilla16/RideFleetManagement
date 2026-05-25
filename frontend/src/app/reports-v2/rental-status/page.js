'use client';

/**
 * Rental Status — Round 27 (2026-05-23).
 *
 * Right-now ops triage. No date picker — this is a current-snapshot view.
 *
 *   ┌─────────────────────────────────────────────────────────────────┐
 *   │ Title · Description · Filter bar (As of <ts> · Location · Refresh)│
 *   ├─────────────────────────────────────────────────────────────────┤
 *   │ 5 KPI cards: Currently out · Overdue · Due today · Pickup today │
 *   │              · Unpaid at checkin                                │
 *   ├─────────────────────────────────────────────────────────────────┤
 *   │ Status-mix horizontal bar (Open / Out / Returned counts)        │
 *   ├─────────────────────────────────────────────────────────────────┤
 *   │ Triage table grouped by section in urgency order                │
 *   │   OVERDUE → UNPAID → DUE TODAY → PICKING UP TODAY → CURRENTLY OUT│
 *   │   (rows are links to /reservations/<id>)                        │
 *   └─────────────────────────────────────────────────────────────────┘
 */

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { AuthGate } from '../../../components/AuthGate';
import { AppShell } from '../../../components/AppShell';
import { api } from '../../../lib/client';
import { ReportPageLayout } from '../../../components/reports/ReportPageLayout';

const GROUP_TONE = {
  danger:  { headerBg: '#FCEBEB', headerFg: '#501313', rowBg: 'transparent' },
  warning: { headerBg: '#FAEEDA', headerFg: '#412402', rowBg: 'transparent' },
  info:    { headerBg: '#EEEDFE', headerFg: '#26215C', rowBg: 'transparent' },
  neutral: { headerBg: '#f1efe8', headerFg: '#211a38', rowBg: 'transparent' },
};

const STATUS_PILL = {
  NEW:                       { bg: '#EEEDFE', fg: '#26215C', label: 'New' },
  CONFIRMED:                 { bg: '#EAF3DE', fg: '#173404', label: 'Confirmed' },
  CHECKED_OUT:               { bg: '#FAEEDA', fg: '#412402', label: 'Checked out' },
  CHECKED_IN_UNPAID:         { bg: '#FCEBEB', fg: '#501313', label: 'Checked in · unpaid' },
};

function fmtMoney(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return '$0.00';
  return `$${v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function timeAgoLabel(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

// "Range" is required by ReportPageLayout for the export URLs but this report
// ignores from/to entirely. Use a degenerate today/today range so the picker
// (which we hide) has stable values if anything reads it.
function todayRange() {
  const iso = new Date().toISOString().slice(0, 10);
  return { from: iso, to: iso };
}

export default function Page() {
  return <AuthGate>{({ token, me, logout }) => <RentalStatusReport token={token} me={me} logout={logout} />}</AuthGate>;
}

function RentalStatusReport({ token, me, logout }) {
  const [locationId, setLocationId] = useState('');
  const [locations, setLocations] = useState([]);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [reloadKey, setReloadKey] = useState(0);
  const range = todayRange();

  // Load locations
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

  // Load report
  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    setLoading(true);
    setError('');
    const params = new URLSearchParams();
    if (locationId) params.set('locationId', locationId);
    (async () => {
      try {
        const out = await api(`/api/reports/rental-status?${params.toString()}`, { bypassCache: true }, token);
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
      <span style={{ fontSize: 13, color: '#211a38', fontWeight: 500 }}>{data.asOfLabel || timeAgoLabel(data.asOf)}</span>
    </div>
  ) : null;

  return (
    <AppShell me={me} logout={logout}>
      <ReportPageLayout
        slug="rental-status"
        title="Rental Status"
        description="Right-now snapshot of every active rental. Triage view."
        category="Management"
        token={token}
        range={range}
        onRangeChange={() => { /* no-op; date range is hidden */ }}
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
  const { callouts, statusMix, groups, totalActive } = data;
  const visibleGroups = groups.filter((g) => g.count > 0);

  return (
    <div>
      {/* KPI strip — 5 cards */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: 10, marginBottom: 18 }}>
        <Card label="Currently out" value={String(callouts.currentlyOut)} hint="cars with customers" />
        <Card
          label="Overdue"
          value={String(callouts.overdue)}
          hint="past return date"
          bg={callouts.overdue > 0 ? '#FCEBEB' : undefined}
          fg={callouts.overdue > 0 ? '#501313' : undefined}
        />
        <Card
          label="Due back today"
          value={String(callouts.dueBackToday)}
          hint="expected returns"
          bg={callouts.dueBackToday > 0 ? '#FAEEDA' : undefined}
          fg={callouts.dueBackToday > 0 ? '#412402' : undefined}
        />
        <Card
          label="Picking up today"
          value={String(callouts.pickingUpToday)}
          hint="incoming customers"
          bg={callouts.pickingUpToday > 0 ? '#EEEDFE' : undefined}
          fg={callouts.pickingUpToday > 0 ? '#26215C' : undefined}
        />
        <Card
          label="Unpaid at checkin"
          value={String(callouts.unpaidAtCheckin)}
          hint="balance > 0"
          bg={callouts.unpaidAtCheckin > 0 ? '#FCEBEB' : undefined}
          fg={callouts.unpaidAtCheckin > 0 ? '#501313' : undefined}
        />
      </div>

      {/* Status mix horizontal bar */}
      <StatusMixBar statusMix={statusMix} total={totalActive} />

      {/* Triage table */}
      {visibleGroups.length === 0 ? (
        <div style={{
          background: '#EAF3DE', color: '#173404',
          padding: 24, borderRadius: 8, textAlign: 'center',
          marginTop: 16, fontSize: 13,
        }}>
          All clear — no rentals need triage right now.
        </div>
      ) : (
        <section>
          <SectionHeader>Rentals by status · triage order</SectionHeader>
          <div style={{ border: '0.5px solid #d3d1c7', borderRadius: 8, overflow: 'hidden', background: 'white' }}>
            {visibleGroups.map((g) => <GroupBlock key={g.key} group={g} />)}
          </div>
        </section>
      )}
    </div>
  );
}

function StatusMixBar({ statusMix, total }) {
  if (!total) return null;
  const segs = [
    { key: 'OPEN',     label: 'Open',     count: statusMix.OPEN,     fg: 'white',    bg: '#7F77DD' },
    { key: 'OUT',      label: 'Out',      count: statusMix.OUT,      fg: 'white',    bg: '#534AB7' },
    { key: 'RETURNED', label: 'Returned', count: statusMix.RETURNED, fg: '#04342C',  bg: '#1fc7aa' },
  ].filter((s) => s.count > 0);

  return (
    <div style={{ background: 'white', border: '0.5px solid #d3d1c7', borderRadius: 8, padding: 14, marginBottom: 18 }}>
      <div style={{ fontSize: 11, color: '#6f668f', textTransform: 'uppercase', fontWeight: 500, marginBottom: 8 }}>
        Status mix · currently active reservations
      </div>
      <div style={{ display: 'flex', height: 24, borderRadius: 4, overflow: 'hidden', border: '0.5px solid #d3d1c7' }}>
        {segs.map((s) => (
          <div key={s.key}
            style={{
              background: s.bg, color: s.fg, flex: s.count,
              fontSize: 10, padding: '4px 8px', display: 'flex', alignItems: 'center',
              minWidth: 0, whiteSpace: 'nowrap', overflow: 'hidden',
            }}
          >
            {s.label} · {s.count}
          </div>
        ))}
      </div>
      <div style={{ fontSize: 10, color: '#6f668f', marginTop: 6 }}>
        {total} active reservations total · Lost (cancelled/no-show) not shown
      </div>
    </div>
  );
}

function GroupBlock({ group }) {
  const tone = GROUP_TONE[group.tone] || GROUP_TONE.neutral;
  return (
    <div>
      <div style={{
        background: tone.headerBg, color: tone.headerFg,
        padding: '6px 12px', fontSize: 11, fontWeight: 500,
        textTransform: 'uppercase', letterSpacing: 0.3,
        borderBottom: '0.5px solid #d3d1c7',
      }}>
        {group.label} · {group.count}
      </div>
      <table style={{ width: '100%', fontSize: 12, borderCollapse: 'collapse' }}>
        <tbody>
          {group.reservations.map((r) => <Row key={r.id} r={r} groupKey={group.key} />)}
        </tbody>
      </table>
    </div>
  );
}

function Row({ r, groupKey }) {
  const pill = STATUS_PILL[r.status] || { bg: '#f1efe8', fg: '#5F5E5A', label: r.status };
  const vehicleLabel = r.vehicle?.plate
    ? `[${r.vehicle.plate}] ${r.vehicle.label || ''}`
    : (r.vehicle?.label || r.vehicleType || '—');

  let dateNote = r.returnLabel;
  let dateNoteStrong = '';
  if (groupKey === 'OVERDUE') {
    const n = Math.abs(r.daysFromReturn);
    dateNoteStrong = `${n} day${n === 1 ? '' : 's'} late`;
  } else if (groupKey === 'DUE_TODAY') {
    dateNoteStrong = 'today';
  } else if (groupKey === 'PICKING_UP_TODAY') {
    dateNote = r.pickupLabel;
    dateNoteStrong = 'pickup today';
  } else if (groupKey === 'CURRENTLY_OUT' && r.daysFromReturn > 0) {
    dateNoteStrong = `${r.daysFromReturn} day${r.daysFromReturn === 1 ? '' : 's'} left`;
  } else if (groupKey === 'UNPAID_AT_CHECKIN') {
    dateNote = `Returned ${r.returnLabel}`;
  }

  return (
    <tr style={{ borderTop: '0.5px solid #d3d1c7' }}>
      <td style={{ padding: '8px 12px', minWidth: 180 }}>
        <Link
          href={`/reservations/${r.id}`}
          style={{ color: '#211a38', textDecoration: 'none', fontWeight: 500 }}
        >
          {r.customerName || '(no customer)'}
        </Link>
        <div style={{ fontSize: 10, color: '#6f668f', marginTop: 1 }}>
          #{r.reservationNumber || r.id}
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
        {dateNote}
        {dateNoteStrong ? (
          <div style={{ fontSize: 11, fontWeight: 500, marginTop: 1, color: groupKey === 'OVERDUE' ? '#501313' : groupKey === 'UNPAID_AT_CHECKIN' ? '#501313' : groupKey === 'DUE_TODAY' ? '#412402' : '#211a38' }}>
            {dateNoteStrong}
          </div>
        ) : null}
      </td>
      <td style={{ padding: '8px 12px', textAlign: 'right', whiteSpace: 'nowrap' }}>
        {r.balance > 0 ? (
          <div style={{ fontSize: 13, fontWeight: 500, color: '#501313', marginBottom: 4 }}>
            {fmtMoney(r.balance)}
          </div>
        ) : null}
        <span style={{
          background: pill.bg, color: pill.fg, fontSize: 10,
          padding: '2px 8px', borderRadius: 999, whiteSpace: 'nowrap',
        }}>{pill.label}</span>
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
    animation: 'rfm-rs-shimmer 1.4s ease-in-out infinite',
    borderRadius: 6,
  };
  return (
    <div aria-busy="true" aria-live="polite" aria-label="Loading report">
      <style>{`@keyframes rfm-rs-shimmer { 0% { background-position: 200% 0; } 100% { background-position: -200% 0; } }`}</style>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: 10, marginBottom: 18 }}>
        {[0, 1, 2, 3, 4].map((i) => <div key={i} style={{ ...shimmer, height: 70 }} />)}
      </div>
      <div style={{ ...shimmer, height: 70, marginBottom: 18 }} />
      <div style={{ ...shimmer, height: 380 }} />
    </div>
  );
}
