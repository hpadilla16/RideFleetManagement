'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { AuthGate } from '../components/AuthGate';
import { AppShell } from '../components/AppShell';
import { api } from '../lib/client';

function VehicleStatusDonut({ vehicles }) {
  const counts = useMemo(() => {
    const available = vehicles.filter((v) => v.status === 'AVAILABLE').length;
    const onRent = vehicles.filter((v) => ['RESERVED', 'ON_RENT'].includes(v.status)).length;
    const out = vehicles.filter((v) => ['OUT_OF_SERVICE', 'IN_MAINTENANCE'].includes(v.status)).length;
    return { available, onRent, out, total: Math.max(vehicles.length, 1) };
  }, [vehicles]);

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
  const [vehicles, setVehicles] = useState([]);
  const [msg, setMsg] = useState('');

  const load = async () => {
    const [r, v] = await Promise.all([api('/api/reservations', {}, token), api('/api/vehicles', {}, token)]);
    setReservations(r);
    setVehicles(v);
  };

  useEffect(() => {
    load();
  }, [token]);

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

  const available = vehicles.filter((v) => v.status === 'AVAILABLE').length;
  const activeReservations = reservations.filter((r) => ['NEW', 'CONFIRMED', 'CHECKED_OUT'].includes(r.status)).length;
  const feeAdvisoryCount = reservations.filter((r) => /\[FEE_ADVISORY_OPEN\s+/i.test(String(r.notes || ''))).length;
  const today = new Date();
  const dayEq = (d) => d.getDate() === today.getDate() && d.getMonth() === today.getMonth() && d.getFullYear() === today.getFullYear();
  const pickups = reservations.filter((r) => dayEq(new Date(r.pickupAt)) && ['NEW', 'CONFIRMED'].includes(r.status));
  const returns = reservations.filter((r) => dayEq(new Date(r.returnAt)) && ['CHECKED_OUT', 'CONFIRMED'].includes(r.status));
  const timeline = reservations.slice().sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt)).slice(0, 10);

  return (
    <AppShell me={me} logout={logout}>
      <section className="grid4">
        <div className="glass card"><div className="label">Total Vehicles</div><div className="value">{vehicles.length}</div></div>
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
          <VehicleStatusDonut vehicles={vehicles} />
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
