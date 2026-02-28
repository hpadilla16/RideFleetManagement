'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { AuthGate } from '../../components/AuthGate';
import { AppShell } from '../../components/AppShell';
import { api } from '../../lib/client';

const DAY_MS = 24 * 60 * 60 * 1000;
const DAY_WIDTH = 72;

function startOfDay(d) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

function addDays(d, n) {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}

function fmtDay(d) {
  return new Date(d).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function statusColor(r, locked) {
  if (locked) return '#9ca3af';
  switch (r.status) {
    case 'CONFIRMED': return '#22c55e';
    case 'NEW': return '#38bdf8';
    case 'CHECKED_OUT': return '#a78bfa';
    case 'CHECKED_IN': return '#f59e0b';
    case 'CANCELLED': return '#ef4444';
    case 'NO_SHOW': return '#f97316';
    default: return '#60a5fa';
  }
}

function dayIndexInRange(rangeStart, dt) {
  return Math.floor((startOfDay(dt) - rangeStart) / DAY_MS);
}

export default function PlannerPage() {
  return <AuthGate>{({ token, me, logout }) => <PlannerInner token={token} me={me} logout={logout} />}</AuthGate>;
}

function PlannerInner({ token, me, logout }) {
  const [reservations, setReservations] = useState([]);
  const [agreements, setAgreements] = useState([]);
  const [vehicles, setVehicles] = useState([]);
  const [vehicleTypes, setVehicleTypes] = useState([]);
  const [locations, setLocations] = useState([]);
  const [msg, setMsg] = useState('');
  const [view, setView] = useState('MONTH');
  const [cursor, setCursor] = useState(startOfDay(new Date()));
  const [filterVehicleTypeId, setFilterVehicleTypeId] = useState('');
  const [filterLocationId, setFilterLocationId] = useState('');
  const [dragItem, setDragItem] = useState(null);
  const [draggingId, setDraggingId] = useState('');
  const [selectedReservation, setSelectedReservation] = useState(null);

  const dayCount = view === 'DAY' ? 1 : view === 'WEEK' ? 7 : 30;
  const rangeStart = useMemo(() => startOfDay(cursor), [cursor]);
  const rangeEnd = useMemo(() => addDays(rangeStart, dayCount), [rangeStart, dayCount]);

  const load = async () => {
    const [r, a, v, vt, l] = await Promise.all([
      api('/api/reservations', {}, token),
      api('/api/rental-agreements', {}, token),
      api('/api/vehicles', {}, token),
      api('/api/vehicle-types', {}, token),
      api('/api/locations', {}, token)
    ]);
    setReservations(r || []);
    setAgreements(a || []);
    setVehicles(v || []);
    setVehicleTypes(vt || []);
    setLocations(l || []);
  };

  useEffect(() => { load(); }, [token]);

  const lockedReservationIds = useMemo(
    () => new Set((reservations || []).filter((r) => String(r.status || '').toUpperCase() === 'CHECKED_OUT').map((r) => r.id)),
    [reservations]
  );

  const tracks = useMemo(() => {
    const filtered = (vehicles || []).filter((v) => {
      if (filterVehicleTypeId && v.vehicleTypeId !== filterVehicleTypeId) return false;
      if (filterLocationId && v.homeLocationId !== filterLocationId) return false;
      return true;
    });

    return [
      {
        id: '__unassigned__',
        make: 'Unassigned',
        model: 'Reservations',
        year: '',
        internalNumber: '-',
        vehicleType: { code: 'N/A' }
      },
      ...filtered
    ];
  }, [vehicles, filterVehicleTypeId, filterLocationId]);

  const itemsByTrack = useMemo(() => {
    const map = new Map();
    for (const t of tracks) map.set(t.id, []);

    for (const r of reservations || []) {
      const pickup = new Date(r.pickupAt);
      const ret = new Date(r.returnAt);
      if (!(pickup < rangeEnd && ret > rangeStart)) continue;
      const vid = r.vehicleId || '__unassigned__';
      if (!map.has(vid)) continue;

      const start = Math.max(0, (pickup.getTime() - rangeStart.getTime()) / DAY_MS);
      const end = Math.min(dayCount, (ret.getTime() - rangeStart.getTime()) / DAY_MS);
      const span = Math.max(0.15, end - start);
      map.get(vid).push({ reservation: r, start, span, end });
    }

    for (const [k, arr] of map) {
      arr.sort((a, b) => a.start - b.start);
      const laneEnds = [];
      const laid = arr.map((item) => {
        let lane = laneEnds.findIndex((x) => x <= item.start);
        if (lane < 0) {
          lane = laneEnds.length;
          laneEnds.push(item.end);
        } else {
          laneEnds[lane] = item.end;
        }
        return { ...item, lane };
      });
      map.set(k, { items: laid, lanes: Math.max(1, laneEnds.length) });
    }

    return map;
  }, [tracks, reservations, rangeStart, rangeEnd, dayCount]);

  const onDropReservation = async (trackVehicleId, dayIndexRaw) => {
    if (!dragItem) return;
    const r = dragItem;
    if (lockedReservationIds.has(r.id)) return;

    const dayIndex = Number(dayIndexRaw);
    if (!Number.isFinite(dayIndex) || dayIndex < 0) return;

    try {
      const oldPickup = new Date(r.pickupAt);
      const oldReturn = new Date(r.returnAt);
      const duration = oldReturn.getTime() - oldPickup.getTime();

      const newStartDay = addDays(rangeStart, dayIndex);
      const newPickup = new Date(newStartDay);
      newPickup.setHours(oldPickup.getHours(), oldPickup.getMinutes(), 0, 0);
      const newReturn = new Date(newPickup.getTime() + duration);

      const targetVehicle = trackVehicleId === '__unassigned__'
        ? 'Unassigned'
        : (tracks.find((t) => t.id === trackVehicleId)?.internalNumber || 'Selected Vehicle');
      const ok = window.confirm(
        `Move reservation ${r.reservationNumber}?\n\n` +
        `Pickup: ${newPickup.toLocaleString()}\n` +
        `Return: ${newReturn.toLocaleString()}\n` +
        `Vehicle: ${targetVehicle}`
      );
      if (!ok) {
        setMsg('Move cancelled');
        setDragItem(null);
        setDraggingId('');
        return;
      }

      await api(`/api/reservations/${r.id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          vehicleId: trackVehicleId === '__unassigned__' ? null : trackVehicleId,
          pickupAt: newPickup.toISOString(),
          returnAt: newReturn.toISOString()
        })
      }, token);
      setMsg(`Reservation ${r.reservationNumber} moved`);
      setDragItem(null);
      setDraggingId('');
      await load();
    } catch (e) {
      setMsg(e.message);
      setDragItem(null);
      setDraggingId('');
    }
  };

  const handleTouchDrop = (ev) => {
    if (!dragItem) return;
    const touch = ev.changedTouches?.[0];
    if (!touch) return;
    const el = document.elementFromPoint(touch.clientX, touch.clientY);
    const cell = el?.closest?.('[data-drop-cell="1"]');
    if (!cell) {
      setDragItem(null);
      setDraggingId('');
      return;
    }
    onDropReservation(cell.getAttribute('data-track-id'), cell.getAttribute('data-day-index'));
  };

  const goPrev = () => setCursor((d) => addDays(d, -dayCount));
  const goNext = () => setCursor((d) => addDays(d, dayCount));
  const goToday = () => setCursor(startOfDay(new Date()));

  return (
    <AppShell me={me} logout={logout}>
      <section className="glass card-lg planner-wrap">
        <div className="row-between" style={{ alignItems: 'flex-end', flexWrap: 'wrap' }}>
          <div style={{ display: 'flex', gap: 10, alignItems: 'flex-end', flexWrap: 'wrap' }}>
            <h2>Daily Planner</h2>
            <div className="stack" style={{ minWidth: 180 }}>
              <label className="label">Vehicle Type</label>
              <select value={filterVehicleTypeId} onChange={(e) => setFilterVehicleTypeId(e.target.value)}>
                <option value="">All</option>
                {vehicleTypes.map((vt) => <option key={vt.id} value={vt.id}>{vt.name}</option>)}
              </select>
            </div>
            <div className="stack" style={{ minWidth: 180 }}>
              <label className="label">Location</label>
              <select value={filterLocationId} onChange={(e) => setFilterLocationId(e.target.value)}>
                <option value="">All</option>
                {locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
              </select>
            </div>
            <div className="stack" style={{ minWidth: 130 }}>
              <label className="label">View</label>
              <select value={view} onChange={(e) => setView(e.target.value)}>
                <option value="DAY">Day</option>
                <option value="WEEK">Week</option>
                <option value="MONTH">Month</option>
              </select>
            </div>
          </div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <button onClick={goToday}>Today</button>
            <button onClick={goPrev}>◀</button>
            <div className="label" style={{ minWidth: 180, textAlign: 'center' }}>{fmtDay(rangeStart)} - {fmtDay(addDays(rangeEnd, -1))}</div>
            <button onClick={goNext}>▶</button>
          </div>
        </div>

        {msg ? <p className="label">{msg}</p> : null}

        <div className="planner-scroll">
          <div className="planner-head" style={{ gridTemplateColumns: `260px repeat(${dayCount}, ${DAY_WIDTH}px)` }}>
            <div className="planner-cell planner-sticky">Vehicle Track</div>
            {Array.from({ length: dayCount }).map((_, i) => {
              const d = addDays(rangeStart, i);
              return <div key={i} className="planner-cell">{new Date(d).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric' })}</div>;
            })}
          </div>

          {tracks.map((v) => {
            const trackLayout = itemsByTrack.get(v.id) || { items: [], lanes: 1 };
            const rows = trackLayout.items;
            const laneCount = Math.max(1, trackLayout.lanes || 1);
            const maxRowHeight = 170;
            const lanePitch = laneCount <= 2 ? 30 : Math.max(14, Math.floor((maxRowHeight - 12) / laneCount));
            const blockHeight = Math.max(10, lanePitch - 6);
            const rowHeight = Math.max(64, Math.min(maxRowHeight, laneCount * lanePitch + 12));
            return (
              <div key={v.id} className="planner-row" style={{ gridTemplateColumns: `260px repeat(${dayCount}, ${DAY_WIDTH}px)` }}>
                <div className="planner-cell planner-sticky planner-track-meta" style={{ minHeight: rowHeight }}>
                  <div style={{ fontWeight: 700 }}>{v.make} {v.model} {v.year || ''}</div>
                  <div className="label">#{v.internalNumber} · {v.vehicleType?.code || '-'}</div>
                </div>

                {Array.from({ length: dayCount }).map((_, i) => (
                  <div
                    key={i}
                    className="planner-cell planner-drop"
                    style={{ minHeight: rowHeight }}
                    data-drop-cell="1"
                    data-track-id={v.id}
                    data-day-index={i}
                    onDragOver={(e) => e.preventDefault()}
                    onDrop={() => onDropReservation(v.id, i)}
                  />
                ))}

                <div className="planner-overlay" style={{ left: 260, width: dayCount * DAY_WIDTH, height: rowHeight }}>
                  {rows.map((rowItem) => {
                    const r = rowItem.reservation;
                    const locked = lockedReservationIds.has(r.id);
                    return (
                      <div
                        key={r.id}
                        className="planner-block"
                        draggable={!locked}
                        onDragStart={() => { setDragItem(r); setDraggingId(r.id); }}
                        onDragEnd={() => { setDragItem(null); setDraggingId(''); }}
                        onTouchStart={() => { if (!locked) { setDragItem(r); setDraggingId(r.id); } }}
                        onTouchEnd={handleTouchDrop}
                        onClick={() => setSelectedReservation({ reservation: r, locked })}
                        style={{ left: rowItem.start * DAY_WIDTH + 2, top: rowItem.lane * lanePitch + 4, height: blockHeight, width: Math.max(12, rowItem.span * DAY_WIDTH - 4), background: statusColor(r, locked), opacity: locked ? 0.7 : (draggingId === r.id ? 0.85 : 1) }}
                        title={`${r.reservationNumber} ${locked ? '(locked by agreement)' : ''}`}
                      >
                        <span className="planner-block-text">{locked ? '🔒 ' : ''}{r.reservationNumber} · {r.customer?.firstName || ''} {r.customer?.lastName || ''}</span>
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      </section>

      {selectedReservation ? (
        <aside className="planner-sidepanel glass card">
          <div className="row-between" style={{ marginBottom: 6 }}>
            <h3>Reservation</h3>
            <button onClick={() => setSelectedReservation(null)}>Close</button>
          </div>
          <div style={{ fontWeight: 700 }}>{selectedReservation.reservation.reservationNumber}</div>
          <div className="label">{selectedReservation.reservation.customer?.firstName || ''} {selectedReservation.reservation.customer?.lastName || ''}</div>
          <div className="label">From: {new Date(selectedReservation.reservation.pickupAt).toLocaleString()}</div>
          <div className="label">To: {new Date(selectedReservation.reservation.returnAt).toLocaleString()}</div>
          <div className="label" style={{ marginBottom: 8 }}>{selectedReservation.locked ? '🔒 Locked (Agreement exists)' : 'Movable Reservation'}</div>
          <div style={{ display: 'grid', gap: 8 }}>
            <Link href={`/reservations/${selectedReservation.reservation.id}`}><button>Open Reservation</button></Link>
          </div>
        </aside>
      ) : null}
    </AppShell>
  );
}
