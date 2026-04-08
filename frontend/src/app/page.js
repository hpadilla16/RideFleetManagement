'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { AuthGate } from '../components/AuthGate';
import { AppShell } from '../components/AppShell';
import { api } from '../lib/client';

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
  const [msg, setMsg] = useState('');
  const canSeeOverview = me?.moduleAccess?.reports !== false;
  const canSeeVehicles = me?.moduleAccess?.vehicles !== false;

  const load = async () => {
    const [reservationsResult, overviewResult, vehiclesResult] = await Promise.allSettled([
      api('/api/reservations', {}, token),
      canSeeOverview ? api('/api/reports/overview', {}, token) : Promise.resolve(null),
      !canSeeOverview && canSeeVehicles ? api('/api/vehicles', {}, token) : Promise.resolve([])
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
    router.push(`/reservations/${id}/checkout`);
  };

  const markCancelled = async (id) => {
    try {
      await api(`/api/reservations/${id}`, { method: 'PATCH', body: JSON.stringify({ status: 'CANCELLED' }) }, token);
      setMsg('Reservation cancelled');
      await load();
    } catch (e) {
      setMsg(e.message);
    }
  };

  const markNoShow = async (id) => {
    try {
      await api(`/api/reservations/${id}`, { method: 'PATCH', body: JSON.stringify({ status: 'NO_SHOW' }) }, token);
      setMsg('Reservation marked as no show');
      await load();
    } catch (e) {
      setMsg(e.message);
    }
  };

  const kpis = overview?.kpis || {};
  const totalVehicles = Number(kpis.fleetTotal || 0) + Number(kpis.vehiclesInMaintenance || 0) + Number(kpis.vehiclesOutOfService || 0);
  const available = Number(kpis.availableFleet || 0);
  const migrationHeld = Number(kpis.migrationHeld || 0);
  const washHeld = Number(kpis.washHeld || 0);
  const serviceHeld = Number(kpis.vehiclesInMaintenance || 0) + Number(kpis.vehiclesOutOfService || 0);
  const activeReservations = reservations.filter((r) => ['NEW', 'CONFIRMED', 'CHECKED_OUT'].includes(r.status)).length;
  const feeAdvisoryCount = reservations.filter((r) => /\[FEE_ADVISORY_OPEN\s+/i.test(String(r.notes || ''))).length;
  const today = new Date();
  const dayEq = (d) => d.getDate() === today.getDate() && d.getMonth() === today.getMonth() && d.getFullYear() === today.getFullYear();
  const pickups = reservations.filter((r) => dayEq(new Date(r.pickupAt)) && ['NEW', 'CONFIRMED'].includes(r.status));
  const returns = reservations.filter((r) => dayEq(new Date(r.returnAt)) && ['CHECKED_OUT', 'CONFIRMED'].includes(r.status));
  const timeline = reservations.slice().sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt)).slice(0, 10);
  const workspaceOpsHub = useMemo(() => {
    const nextItems = [
      pickups[0]
        ? {
            id: `pickup-${pickups[0].id}`,
            title: 'Next Pickup',
            detail: `#${pickups[0].reservationNumber} - ${pickups[0].customer?.firstName || ''} ${pickups[0].customer?.lastName || ''}`.trim(),
            note: `Pickup ${new Date(pickups[0].pickupAt).toLocaleString()}`,
            action: () => startCheckout(pickups[0].id),
            actionLabel: 'Start Check-out'
          }
        : null,
      returns[0]
        ? {
            id: `return-${returns[0].id}`,
            title: 'Next Return',
            detail: `#${returns[0].reservationNumber} - ${returns[0].customer?.firstName || ''} ${returns[0].customer?.lastName || ''}`.trim(),
            note: `Return ${new Date(returns[0].returnAt).toLocaleString()}`,
            action: () => router.push(`/reservations/${returns[0].id}/checkin`),
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
      {
        id: 'loaner',
        title: 'Loaner Lane',
        detail: 'Service lane, billing, and alerts',
        note: 'Jump straight into the dealership loaner workspace when service ops need attention.',
        action: () => router.push('/loaner'),
        actionLabel: 'Open Loaner'
      }
    ].filter(Boolean);

    return {
      totalVehicles,
      available,
      migrationHeld,
      washHeld,
      serviceHeld,
      activeReservations,
      feeAdvisoryCount,
      nextItems
    };
  }, [pickups, returns, feeAdvisoryCount, totalVehicles, available, migrationHeld, serviceHeld, activeReservations, router]);

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

      <section className="grid2">
        <div className="glass card-lg">
          <h3>Operations Board</h3>
          <p className="label">Pickups Today: <strong>{pickups.length}</strong> · Returns Today: <strong>{returns.length}</strong></p>
          <div className="stack">
            {pickups.slice(0, 6).map((r) => (
              <div key={r.id} className="row" style={{ alignItems: 'center' }}>
                <span>#{r.reservationNumber} · {r.customer?.firstName} {r.customer?.lastName}</span>
                <div style={{ display: 'flex', gap: 6 }}>
                  <button onClick={() => startCheckout(r.id)}>Start Check-out</button>
                  <button onClick={() => markCancelled(r.id)}>Cancel</button>
                  <button onClick={() => markNoShow(r.id)}>No Show</button>
                </div>
              </div>
            ))}
            {returns.slice(0, 6).map((r) => (
              <div key={`ret-${r.id}`} className="row">
                <span>Returning: #{r.reservationNumber} · {r.customer?.firstName} {r.customer?.lastName}</span>
                <span className="label">Awaiting return processing</span>
              </div>
            ))}
          </div>
        </div>
        <div className="glass card-lg">
          <h3>Vehicle Status</h3>
          <VehicleStatusDonut metrics={kpis} />
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
