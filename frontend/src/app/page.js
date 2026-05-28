'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { AuthGate } from '../components/AuthGate';
import { AppShell } from '../components/AppShell';
import { api } from '../lib/client';
import { DEFAULT_TENANT_TIMEZONE } from '../lib/tenant-time';

// 2026-05-26: both helpers used to read the raw "YYYY-MM-DD" / "HH:mm"
// prefix of an ISO string as if those digits were already the wall-clock
// value in the tenant TZ. That hack matched the pre-fix backend's
// local-as-UTC storage; after the storage was migrated to correct UTC the
// dashboard rendered every time in UTC (e.g. 16:00 UTC as 4 PM rather than
// 12 PM AST) and silently dropped any return between 8 PM AST and midnight
// from "today" because the UTC date had already rolled to tomorrow.
// Both now do proper UTC→tenant-TZ conversion via Intl.
const DASHBOARD_TZ = DEFAULT_TENANT_TIMEZONE;

function fmtWallClockTime(value) {
  if (!value) return '-';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '-';
  return d.toLocaleString('en-US', {
    timeZone: DASHBOARD_TZ,
    hour: 'numeric',
    minute: '2-digit',
    hour12: true
  });
}

function wallClockDate(value) {
  if (!value) return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  // Use Intl to extract the tenant-TZ date components so e.g. an 11 PM AST
  // return whose storage UTC is 03:00 the next calendar day still maps to
  // the AST date the agent expects.
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: DASHBOARD_TZ,
    year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(d).reduce((acc, p) => {
    if (p.type !== 'literal') acc[p.type] = p.value;
    return acc;
  }, {});
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function VehicleStatusDonut({ metrics }) {
  const counts = useMemo(() => {
    const available = Number(metrics?.availableFleet || 0);
    const onRent = Number(metrics?.onRent || 0);
    const out = Number(metrics?.vehiclesInMaintenance || 0) + Number(metrics?.vehiclesOutOfService || 0);
    const total = Math.max(available + onRent + out, 1);
    return { available, onRent, out, total };
  }, [metrics]);

  const size = 168;
  const stroke = 20;
  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  const portions = [counts.available, counts.onRent, counts.out].map((n) => n / counts.total);
  const colors = ['#30D5C8', '#6C8FF6', '#3F3F3F'];

  let offsetAcc = 0;
  const circles = portions.map((p, idx) => {
    const dash = `${Math.max(4, p * circumference)} ${circumference}`;
    const c = (
      <circle
        key={idx}
        cx={size / 2}
        cy={size / 2}
        r={radius}
        fill="none"
        stroke={colors[idx]}
        strokeWidth={stroke}
        strokeDasharray={dash}
        strokeDashoffset={-offsetAcc}
        strokeLinecap="round"
        transform={`rotate(-90 ${size / 2} ${size / 2})`}
      />
    );
    offsetAcc += p * circumference;
    return c;
  });

  return (
    <div className="donut-wrap">
      <svg width={size} height={size}>
        <circle cx={size / 2} cy={size / 2} r={radius} fill="none" stroke="#eee8ff" strokeWidth={stroke} />
        {circles}
      </svg>
      <div className="donut-center">
        <div className="value" style={{ fontSize: 28 }}>{counts.onRent}</div>
        <div className="label">On Rent</div>
      </div>
      <div className="stack" style={{ minWidth: 150 }}>
        <div className="row"><span className="label">● Available</span><strong>{counts.available}</strong></div>
        <div className="row"><span className="label">● On Rent</span><strong>{counts.onRent}</strong></div>
        <div className="row"><span className="label">● Out Of Service</span><strong>{counts.out}</strong></div>
      </div>
    </div>
  );
}

function deriveKpisFromVehicles(vehicles = []) {
  const rows = Array.isArray(vehicles) ? vehicles : [];
  const activeBlocks = rows
    .map((vehicle) => ({
      vehicle,
      block: (Array.isArray(vehicle?.availabilityBlocks) ? vehicle.availabilityBlocks : []).find((block) => !block?.releasedAt) || null
    }))
    .filter((row) => !!row.block);
  const fleetTotal = rows.length;
  const vehiclesInMaintenance = rows.filter((vehicle) => String(vehicle?.status || '').toUpperCase() === 'IN_MAINTENANCE').length;
  const vehiclesOutOfService = rows.filter((vehicle) => String(vehicle?.status || '').toUpperCase() === 'OUT_OF_SERVICE').length;
  const migrationHeld = activeBlocks.filter((row) => String(row?.block?.blockType || '').toUpperCase() === 'MIGRATION_HOLD').length;
  const washHeld = activeBlocks.filter((row) => String(row?.block?.blockType || '').toUpperCase() === 'WASH_HOLD').length;
  const availableFleet = rows.filter((vehicle) => {
    const status = String(vehicle?.status || '').toUpperCase();
    return !['ON_RENT', 'IN_MAINTENANCE', 'OUT_OF_SERVICE'].includes(status) && !activeBlocks.some((row) => row?.vehicle?.id === vehicle.id);
  }).length;
  const onRent = rows.filter((vehicle) => String(vehicle?.status || '').toUpperCase() === 'ON_RENT').length + migrationHeld;
  return {
    fleetTotal,
    availableFleet,
    migrationHeld,
    washHeld,
    vehiclesInMaintenance,
    vehiclesOutOfService,
    onRent
  };
}

function SalesRevenueChart({ reservations }) {
  const svgRef = useRef(null);
  const [activeIdx, setActiveIdx] = useState(11);

  const data = useMemo(() => {
    const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const nowYear = new Date().getFullYear();
    const current = new Array(12).fill(0);
    const previous = new Array(12).fill(0);

    reservations.forEach((r) => {
      const d = new Date(r.pickupAt);
      const m = d.getMonth();
      const val = Number(r.estimatedTotal || r.dailyRate || 0);
      if (d.getFullYear() === nowYear) current[m] += val;
      if (d.getFullYear() === nowYear - 1) previous[m] += val;
    });

    // Keep line continuous through Jan..Dec even when month has no value.
    const forwardFill = (arr) => {
      let last = 0;
      const out = arr.map((n) => {
        if (n > 0) {
          last = n;
          return n;
        }
        return last;
      });
      const firstNonZero = out.find((n) => n > 0) || 0;
      return out.map((n) => (n === 0 ? firstNonZero : n));
    };

    const currentFilled = forwardFill(current);
    const previousFilled = forwardFill(previous);

    const max = Math.max(1, ...currentFilled, ...previousFilled);
    return monthNames.map((label, i) => ({
      label,
      current: currentFilled[i],
      previous: previousFilled[i],
      rawCurrent: current[i],
      rawPrevious: previous[i],
      max
    }));
  }, [reservations]);

  const W = 720; const H = 240; const pad = 22;
  const x = (i) => pad + (i * (W - pad * 2)) / 11;
  const y = (v, max) => H - pad - (v / max) * (H - pad * 2);
  const areaPath = (series) => {
    const start = `M ${x(0)} ${H - pad}`;
    const line = data.map((d, i) => `L ${x(i)} ${y(d[series], d.max)}`).join(' ');
    const end = `L ${x(11)} ${H - pad} Z`;
    return `${start} ${line} ${end}`;
  };
  const linePath = (series) => data.map((d, i) => `${i === 0 ? 'M' : 'L'} ${x(i)} ${y(d[series], d.max)}`).join(' ');

  const updateByClientX = (clientX) => {
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect) return;

    const clamped = Math.min(Math.max(rect.left, clientX), rect.right);
    const rel = clamped - rect.left;
    const padPx = (pad / W) * rect.width;
    const usable = Math.max(1, rect.width - padPx * 2);

    let nearestIdx = 0;
    let best = Number.POSITIVE_INFINITY;
    for (let i = 0; i < 12; i += 1) {
      const px = padPx + (i * usable) / 11;
      const dist = Math.abs(rel - px);
      if (dist < best) {
        best = dist;
        nearestIdx = i;
      }
    }
    setActiveIdx(nearestIdx);
  };

  const active = data[activeIdx] || data[0];

  const tipX = x(activeIdx);
  const tipY = Math.min(y(active.current, active.max), y(active.previous, active.max));

  return (
    <div>
      <div className="row-between" style={{ marginBottom: 4 }}>
        <div className="label">Sales Revenue</div>
        <div className="label"><strong>{active.label}</strong> · Total ${active.rawCurrent.toFixed(2)} · Previous ${active.rawPrevious.toFixed(2)}</div>
      </div>
      <svg
        ref={svgRef}
        viewBox={`0 0 ${W} ${H}`}
        className="sales-chart"
        onPointerDown={(e) => updateByClientX(e.clientX)}
        onPointerMove={(e) => updateByClientX(e.clientX)}
      >
        <defs>
          <linearGradient id="gCurrent" x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stopColor="#30D5C8" stopOpacity="0.55" />
            <stop offset="100%" stopColor="#30D5C8" stopOpacity="0.05" />
          </linearGradient>
          <linearGradient id="gPrev" x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stopColor="#6C8FF6" stopOpacity="0.45" />
            <stop offset="100%" stopColor="#6C8FF6" stopOpacity="0.05" />
          </linearGradient>
        </defs>
        <path d={areaPath('previous')} fill="url(#gPrev)" />
        <path d={areaPath('current')} fill="url(#gCurrent)" />
        <path d={linePath('previous')} stroke="#6C8FF6" strokeWidth="2" fill="none" />
        <path d={linePath('current')} stroke="#30D5C8" strokeWidth="2.4" fill="none" />
        <line x1={x(activeIdx)} x2={x(activeIdx)} y1={pad} y2={H - pad} stroke="#8752FE" strokeDasharray="4 4" opacity="0.7" />

        <g transform={`translate(${tipX}, ${Math.max(18, tipY - 14)})`}>
          <rect x={-72} y={-34} rx={8} width={144} height={28} fill="rgba(63,63,63,0.86)" />
          <text x="0" y="-15" textAnchor="middle" fill="#fff" fontSize="10">{`${active.label} · $${active.rawCurrent.toFixed(0)} / $${active.rawPrevious.toFixed(0)}`}</text>
          <circle cx="0" cy="0" r="4" fill="#8752FE" stroke="#fff" strokeWidth="2" />
        </g>
      </svg>
      <div className="chart-months">{data.map((d) => <span key={d.label}>{d.label}</span>)}</div>
    </div>
  );
}

export default function DashboardPage() {
  return (
    <AuthGate>
      {({ token, me, logout }) => <DashboardInner token={token} me={me} logout={logout} />}
    </AuthGate>
  );
}

function DashboardInner({ token, me, logout }) {
  const router = useRouter();
  const [reservations, setReservations] = useState([]);
  const [overview, setOverview] = useState(null);
  const [resSummary, setResSummary] = useState(null);
  const [msg, setMsg] = useState('');
  const canSeeOverview = me?.moduleAccess?.reports !== false;
  const canSeeVehicles = me?.moduleAccess?.vehicles !== false;

  const load = async () => {
    const [reservationsResult, overviewResult, vehiclesResult, summaryResult] = await Promise.allSettled([
      // The dashboard's Operations Board derives its visible Pickups/Returns
      // lists from this array. The default limit is 100 ordered by most-recent
      // created, which silently dropped today's returns whose reservations
      // were booked weeks in advance (so the header showed "Returns: 20" while
      // the list only rendered 3). Bump to the max page size (500) so today's
      // window is fully covered. Long-term, this should switch to a targeted
      // ?returnDateOn=today query plus a separate timeline fetch.
      api('/api/reservations?limit=500', {}, token),
      canSeeOverview ? api('/api/reports/overview', {}, token) : Promise.resolve(null),
      !canSeeOverview && canSeeVehicles ? api('/api/vehicles', {}, token) : Promise.resolve([]),
      api('/api/reservations/summary', {}, token)
    ]);

    if (reservationsResult.status === 'fulfilled') {
      const val = reservationsResult.value;
      setReservations(Array.isArray(val) ? val : (Array.isArray(val?.items) ? val.items : []));
    } else setReservations([]);

    if (overviewResult.status === 'fulfilled' && overviewResult.value) {
      setOverview(overviewResult.value || null);
    } else if (!canSeeOverview && vehiclesResult.status === 'fulfilled') {
      setOverview({ kpis: deriveKpisFromVehicles(vehiclesResult.value || []) });
    } else {
      setOverview(null);
    }

    if (summaryResult.status === 'fulfilled') setResSummary(summaryResult.value || null);

    if (reservationsResult.status === 'rejected' && overviewResult.status === 'rejected' && vehiclesResult.status === 'rejected') {
      setMsg(reservationsResult.reason?.message || overviewResult.reason?.message || vehiclesResult.reason?.message || 'Unable to load dashboard');
    } else if (reservationsResult.status === 'rejected') {
      setMsg('Dashboard loaded with limited reservation data');
    } else if (canSeeOverview && overviewResult.status === 'rejected') {
      setMsg('Dashboard loaded with limited KPI data');
    } else if (!canSeeOverview && canSeeVehicles && vehiclesResult.status === 'rejected') {
      setMsg('Dashboard loaded with limited fleet metrics');
    } else {
      setMsg('');
    }
  };

  useEffect(() => {
    load();
  }, [token, canSeeOverview]);

  const startCheckout = async (id) => {
    router.push(`/reservations/${id}/checkout-wizard`);
  };

  const markCancelled = async (id) => {
    const reason = window.prompt('Enter a reason for cancellation (required):');
    if (!reason || !reason.trim()) { if (reason !== null) setMsg('Cancellation requires a reason'); return; }
    try {
      await api(`/api/reservations/${id}`, { method: 'PATCH', body: JSON.stringify({ status: 'CANCELLED', cancellationReason: reason.trim() }) }, token);
      setMsg('Reservation cancelled');
      await load();
    } catch (e) {
      setMsg(e.message);
    }
  };

  const markNoShow = async (id) => {
    if (!window.confirm('Mark this reservation as no-show? The guest will be charged the full amount.')) return;
    try {
      await api(`/api/reservations/${id}`, { method: 'PATCH', body: JSON.stringify({ status: 'NO_SHOW' }) }, token);
      setMsg('Reservation marked as no show');
      await load();
    } catch (e) {
      setMsg(e.message);
    }
  };

  const requestCustomerInfo = async (id) => {
    try {
      const out = await api(`/api/reservations/${id}/request-customer-info`, { method: 'POST', body: JSON.stringify({}) }, token);
      const link = out?.link || '';
      if (link && navigator?.clipboard) {
        try { await navigator.clipboard.writeText(link); } catch {}
      }
      setMsg(link ? `Customer info link copied to clipboard: ${link}` : 'Customer info link issued');
    } catch (e) {
      setMsg(e.message);
    }
  };

  const startCheckin = (id) => {
    router.push(`/reservations/${id}/checkin-wizard`);
  };

  const openReservation = (id) => {
    router.push(`/reservations/${id}`);
  };

  const unpaidBalance = (r) => {
    const balance = Number(r?.rentalAgreement?.balance);
    return Number.isFinite(balance) && balance > 0 ? balance : 0;
  };

  const moneyShort = (n) => `$${Number(n || 0).toFixed(2)}`;

  const kpis = overview?.kpis || {};
  const totalVehicles = Number(kpis.fleetTotal || 0) + Number(kpis.vehiclesInMaintenance || 0) + Number(kpis.vehiclesOutOfService || 0);
  const available = Number(kpis.availableFleet || 0);
  const migrationHeld = Number(kpis.migrationHeld || 0);
  const washHeld = Number(kpis.washHeld || 0);
  const serviceHeld = Number(kpis.vehiclesInMaintenance || 0) + Number(kpis.vehiclesOutOfService || 0);
  // Active = CHECKED_OUT with returnAt > now (still within plan). Backend
  // computes the canonical count tenant-wide; FE falls back to its own
  // strict filter if the KPI isn't available yet (e.g. pre-deploy).
  // Previously this counted NEW + CONFIRMED + all CHECKED_OUT which
  // ballooned to 298 by mixing future bookings + overdue rentals into
  // the 'active' bucket.
  const activeReservations = Number(
    kpis.activeReservations ?? reservations.filter((r) =>
      r.status === 'CHECKED_OUT' &&
      r.returnAt && new Date(r.returnAt) > new Date()
    ).length
  );
  // Overdue = CHECKED_OUT past planned returnAt. Backend computes the
  // canonical count (filtered by tenant + location server-side); FE falls
  // back to its own list filter in case the backend KPI isn't available
  // yet (e.g. pre-deploy).
  //
  // 2026-05-27: client-side fallback also respects overdueIgnored=true
  // (grandfathered stale data). Without this, the fallback over-counted
  // by ~400 whenever the backend dropped the kpi from its response,
  // since the FE list view doesn't filter ignored rows out of
  // `reservations` by default.
  const overdueReservations = Number(
    kpis.overdueReservations ?? reservations.filter((r) =>
      r.status === 'CHECKED_OUT' && r.returnAt &&
      new Date(r.returnAt) <= new Date() && !r.overdueIgnored
    ).length
  );
  const feeAdvisoryCount = reservations.filter((r) => /\[FEE_ADVISORY_OPEN\s+/i.test(String(r.notes || ''))).length;
  // Anchor "today" in the tenant timezone — not the browser's — so the
  // Operations Board agrees with the rest of the app for agents loading
  // from a non-PR browser. Both functions return "YYYY-MM-DD" in DASHBOARD_TZ.
  const [boardDate, setBoardDate] = useState(() => wallClockDate(new Date()));
  const todayStr = useMemo(() => wallClockDate(new Date()), []);
  const isToday = boardDate === todayStr;
  const boardLabel = isToday ? 'Today' : new Date(boardDate + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' });
  const pickups = reservations.filter((r) => wallClockDate(r.pickupAt) === boardDate && ['NEW', 'CONFIRMED'].includes(r.status));
  // Today's returns panel: vehicles still expected back. Drops:
  //   • CANCELLED / NO_SHOW — customer never showed; nothing to return
  //   • CHECKED_IN / CHECKED_IN_UNPAID — vehicle is already back, the
  //     agent doesn't need to be reminded to receive it (was surfacing
  //     already-closed rentals as "Next Return" — bug 2026-05-27)
  // This also fixes the count/list mismatch in the Operations Board
  // header by replacing the backend `resSummary.returnsToday` count
  // with `returns.length` (see below) — the two queries disagreed when
  // a return had been received earlier in the day.
  const returns = reservations.filter((r) =>
    wallClockDate(r.returnAt) === boardDate &&
    !['CANCELLED', 'NO_SHOW', 'CHECKED_IN', 'CHECKED_IN_UNPAID'].includes(r.status)
  );
  const timeline = reservations.slice().sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt)).slice(0, 10);
  const workspaceOpsHub = useMemo(() => {
    const nextItems = [
      pickups[0]
        ? {
            id: `pickup-${pickups[0].id}`,
            title: 'Next Pickup',
            detail: `#${pickups[0].reservationNumber} - ${pickups[0].customer?.firstName || ''} ${pickups[0].customer?.lastName || ''}`.trim(),
            note: `Pickup ${new Date(pickups[0].pickupAt).toLocaleString('en-US', { timeZone: DASHBOARD_TZ })}`,
            action: () => startCheckout(pickups[0].id),
            actionLabel: 'Start Check-out'
          }
        : null,
      returns[0]
        ? {
            id: `return-${returns[0].id}`,
            title: 'Next Return',
            detail: `#${returns[0].reservationNumber} - ${returns[0].customer?.firstName || ''} ${returns[0].customer?.lastName || ''}`.trim(),
            note: `Return ${new Date(returns[0].returnAt).toLocaleString('en-US', { timeZone: DASHBOARD_TZ })}`,
            action: () => router.push(`/reservations/${returns[0].id}/checkin-wizard`),
            actionLabel: 'Open Check-in'
          }
        : null,
      feeAdvisoryCount > 0
        ? {
            id: 'fee-advisory',
            title: 'Fee Advisory Watch',
            detail: `${feeAdvisoryCount} booking${feeAdvisoryCount === 1 ? '' : 's'}`,
            note: 'Additional fee advisories are still open and may need team review.',
            action: () => router.push('/reservations'),
            actionLabel: 'Open Reservations'
          }
        : null,
      // Loaner Lane card only renders for tenants that have the dealership
      // loaner module enabled. moduleAccess.loaner is set by the backend in
      // lib/module-access.js based on tenant.dealershipLoanerEnabled (it's
      // false by default — loaner is opt-in).
      (me?.moduleAccess?.loaner === true)
        ? {
            id: 'loaner',
            title: 'Loaner Lane',
            detail: 'Service lane, billing, and alerts',
            note: 'Jump straight into the dealership loaner workspace when service ops need attention.',
            action: () => router.push('/loaner'),
            actionLabel: 'Open Loaner'
          }
        : null
    ].filter(Boolean);

    return {
      totalVehicles,
      available,
      migrationHeld,
      washHeld,
      serviceHeld,
      activeReservations,
      overdueReservations,
      feeAdvisoryCount,
      nextItems
    };
  }, [pickups, returns, feeAdvisoryCount, totalVehicles, available, migrationHeld, serviceHeld, activeReservations, overdueReservations, router, me?.moduleAccess?.loaner]);

  return (
    <AppShell me={me} logout={logout}>
      <section className="glass card-lg section-card" style={{ marginBottom: 16 }}>
        <div className="app-banner">
          <div className="row-between" style={{ alignItems: 'start', marginBottom: 0 }}>
            <div>
              <span className="eyebrow">Workspace Ops Hub</span>
              <h2 className="page-title" style={{ marginTop: 6 }}>
                Keep today&apos;s pickups, returns, and service-lane work in view.
              </h2>
              <p className="ui-muted">A mobile-first launch point before you scroll into the full dashboard cards and charts.</p>
            </div>
            <span className="status-chip neutral">Workspace</span>
          </div>
          <div className="app-card-grid compact">
            <div className="info-tile">
              <span className="label">Vehicles</span>
              <strong>{workspaceOpsHub.totalVehicles}</strong>
              <span className="ui-muted">Total units across the workspace.</span>
            </div>
            <div className="info-tile">
              <span className="label">Available</span>
              <strong>{workspaceOpsHub.available}</strong>
              <span className="ui-muted">Units ready to move today.</span>
            </div>
            <div className="info-tile">
              <span className="label">Migration Holds</span>
              <strong>{workspaceOpsHub.migrationHeld}</strong>
              <span className="ui-muted">Legacy-contract units still committed to fleet usage.</span>
            </div>
            <div className="info-tile">
              <span className="label">Maintenance / OOS</span>
              <strong>{workspaceOpsHub.serviceHeld}</strong>
              <span className="ui-muted">Units blocked for maintenance or out-of-service work.</span>
            </div>
            <div className="info-tile">
              <span className="label">Wash Holds</span>
              <strong>{workspaceOpsHub.washHeld}</strong>
              <span className="ui-muted">Units temporarily blocked for wash and turnaround prep.</span>
            </div>
            <div className="info-tile">
              <span className="label">Active Reservations</span>
              <strong>{workspaceOpsHub.activeReservations}</strong>
              <span className="ui-muted">Bookings currently in motion.</span>
            </div>
            <button
              type="button"
              className="info-tile"
              onClick={() => router.push('/reservations?filter=overdue')}
              style={{
                textAlign: 'left',
                cursor: 'pointer',
                background: workspaceOpsHub.overdueReservations > 0 ? 'rgba(239, 68, 68, 0.08)' : undefined,
                borderColor: workspaceOpsHub.overdueReservations > 0 ? 'rgba(239, 68, 68, 0.35)' : undefined,
              }}
              title="Click to view overdue reservations"
            >
              <span className="label">Overdue Returns</span>
              <strong style={{ color: workspaceOpsHub.overdueReservations > 0 ? '#dc2626' : undefined }}>
                {workspaceOpsHub.overdueReservations}
              </strong>
              <span className="ui-muted">Checked-out past their planned return. Click to triage.</span>
            </button>
            <div className="info-tile">
              <span className="label">Fee Advisories</span>
              <strong>{workspaceOpsHub.feeAdvisoryCount}</strong>
              <span className="ui-muted">Bookings still carrying advisory follow-up.</span>
            </div>
          </div>
          <div className="app-card-grid compact">
            {workspaceOpsHub.nextItems.map((item) => (
              <section key={item.id} className="glass card section-card">
                <div className="section-title" style={{ fontSize: 15 }}>{item.title}</div>
                <div className="ui-muted">{item.detail}</div>
                <div className="surface-note">{item.note}</div>
                <div className="inline-actions">
                  <button type="button" onClick={item.action}>{item.actionLabel}</button>
                </div>
              </section>
            ))}
          </div>
        </div>
      </section>
      <section className="grid4">
        <div className="glass card"><div className="label">Total Vehicles</div><div className="value">{totalVehicles}</div></div>
        <div className="glass card"><div className="label">Available Vehicles</div><div className="value">{available}</div></div>
        <div className="glass card"><div className="label">Reservations</div><div className="value">{reservations.length}</div></div>
        <div className="glass card"><div className="label">Active</div><div className="value">{activeReservations}</div></div>
        <div className="glass card"><div className="label">Fee Advisories</div><div className="value">{feeAdvisoryCount}</div></div>
      </section>
      {msg ? <p className="label" style={{ margin: '4px 0 10px 2px' }}>{msg}</p> : null}

      <section className="glass card-lg" style={{ marginBottom: 12 }}>
        <div className="row-between" style={{ alignItems: 'center' }}>
          <h3 style={{ margin: 0 }}>Operations Board</h3>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <button onClick={() => { const d = new Date(boardDate + 'T00:00:00'); d.setDate(d.getDate() - 1); setBoardDate(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`); }} style={{ padding: '4px 8px', minWidth: 0 }}>&larr;</button>
            <input type="date" value={boardDate} onChange={(e) => setBoardDate(e.target.value)} style={{ padding: '4px 8px', borderRadius: 8, border: '1px solid var(--border-soft)', background: 'var(--bg-soft)', color: 'var(--charcoal)', fontSize: 13, fontWeight: 600 }} />
            <button onClick={() => { const d = new Date(boardDate + 'T00:00:00'); d.setDate(d.getDate() + 1); setBoardDate(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`); }} style={{ padding: '4px 8px', minWidth: 0 }}>&rarr;</button>
            {!isToday && <button onClick={() => { const d = new Date(); setBoardDate(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`); }} style={{ padding: '4px 10px', fontSize: 12 }}>Today</button>}
          </div>
        </div>
        <p className="label" style={{ marginTop: 6, marginBottom: 0 }}>
          {/* Counts mirror the filtered list shown below — using
              resSummary.{pickups,returns}Today caused the header to
              disagree with the list (e.g. "10 returns" but 9 cards)
              because the backend summary doesn't drop already-received
              returns. */}
          {boardLabel} — Pickups: <strong>{pickups.length}</strong> · Returns: <strong>{returns.length}</strong>
        </p>
      </section>

      <section className="grid2">
        <div className="glass card-lg">
          <div className="label" style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.05em', color: 'var(--brand)', marginBottom: 8 }}>Pickups ({pickups.length})</div>
          {pickups.length === 0 ? (
            <p className="ui-muted" style={{ textAlign: 'center', padding: 20, margin: 0 }}>No pickups scheduled.</p>
          ) : (
            <div className="stack">
              {pickups.sort((a, b) => String(a.pickupAt).localeCompare(String(b.pickupAt))).map((r) => {
                const balance = unpaidBalance(r);
                return (
                  <div
                    key={r.id}
                    role="button"
                    tabIndex={0}
                    onClick={() => openReservation(r.id)}
                    onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openReservation(r.id); } }}
                    className="row"
                    style={{ alignItems: 'center', gap: 8, cursor: 'pointer', padding: '6px 4px', borderRadius: 8, transition: 'background 0.15s' }}
                    onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--bg-soft)'; }}
                    onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
                  >
                    <span style={{ minWidth: 70, fontWeight: 600, fontSize: 13, color: 'var(--charcoal)' }}>{fmtWallClockTime(r.pickupAt)}</span>
                    <span style={{ flex: 1 }}>
                      #{r.reservationNumber} · {r.customer?.firstName} {r.customer?.lastName}{r.vehicle ? ` · ${r.vehicle.year || ''} ${r.vehicle.make || ''} ${r.vehicle.model || ''}`.trim() : ''}
                      {balance > 0 ? <span className="status-chip warn" style={{ fontSize: 10, marginLeft: 6 }}>Unpaid {moneyShort(balance)}</span> : null}
                    </span>
                    <div style={{ display: 'flex', gap: 6 }} onClick={(e) => e.stopPropagation()}>
                      <button onClick={(e) => { e.stopPropagation(); startCheckout(r.id); }}>Start Check-out</button>
                      <button onClick={(e) => { e.stopPropagation(); requestCustomerInfo(r.id); }}>Request Info</button>
                      <button onClick={(e) => { e.stopPropagation(); markNoShow(r.id); }}>No Show</button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        <div className="glass card-lg">
          <div className="label" style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.05em', color: '#30D5C8', marginBottom: 8 }}>Returns ({returns.length})</div>
          {returns.length === 0 ? (
            <p className="ui-muted" style={{ textAlign: 'center', padding: 20, margin: 0 }}>No returns scheduled.</p>
          ) : (
            <div className="stack">
              {returns.sort((a, b) => String(a.returnAt).localeCompare(String(b.returnAt))).map((r) => {
                const balance = unpaidBalance(r);
                // Already-returned rentals (CHECKED_IN / CHECKED_IN_UNPAID)
                // shouldn't keep prompting the agent for check-in. Show a
                // status badge in place of the action button so the row stays
                // visible (the count still includes them) but the actionable
                // affordance only renders for rentals that still need work.
                const alreadyCheckedIn = ['CHECKED_IN', 'CHECKED_IN_UNPAID'].includes(r.status);
                return (
                  <div
                    key={`ret-${r.id}`}
                    role="button"
                    tabIndex={0}
                    onClick={() => openReservation(r.id)}
                    onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openReservation(r.id); } }}
                    className="row"
                    style={{ alignItems: 'center', gap: 8, cursor: 'pointer', padding: '6px 4px', borderRadius: 8, transition: 'background 0.15s' }}
                    onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--bg-soft)'; }}
                    onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
                  >
                    <span style={{ minWidth: 70, fontWeight: 600, fontSize: 13, color: 'var(--charcoal)' }}>{fmtWallClockTime(r.returnAt)}</span>
                    <span style={{ flex: 1 }}>
                      #{r.reservationNumber} · {r.customer?.firstName} {r.customer?.lastName}{r.vehicle ? ` · ${r.vehicle.year || ''} ${r.vehicle.make || ''} ${r.vehicle.model || ''}`.trim() : ''}
                      {balance > 0 ? <span className="status-chip warn" style={{ fontSize: 10, marginLeft: 6 }}>Unpaid {moneyShort(balance)}</span> : null}
                    </span>
                    <div style={{ display: 'flex', gap: 6 }} onClick={(e) => e.stopPropagation()}>
                      {alreadyCheckedIn ? (
                        <span
                          className="status-chip"
                          style={{
                            fontSize: 11, fontWeight: 700, padding: '4px 10px', borderRadius: 999,
                            background: '#dcfce7', color: '#166534'
                          }}
                        >
                          Checked in
                        </span>
                      ) : (
                        <button onClick={(e) => { e.stopPropagation(); startCheckin(r.id); }}>Start Check-in</button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </section>

      <section className="glass card-lg">
        <h3>Sales Status</h3>
        <SalesRevenueChart reservations={reservations} />
      </section>

      <section className="glass card-lg">
        <h3>Operations Timeline</h3>
        <div className="stack">
          {timeline.map((r) => <div key={r.id} className="row"><span>{new Date(r.updatedAt).toLocaleString()}</span><span>Reservation #{r.reservationNumber} · {r.status}</span></div>)}
        </div>
      </section>
    </AppShell>
  );
}
