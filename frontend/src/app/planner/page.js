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

function blockColor(block) {
  const blockType = String(block?.blockType || '').toUpperCase();
  if (blockType === 'MAINTENANCE_HOLD') return '#f59e0b';
  if (blockType === 'OUT_OF_SERVICE_HOLD') return '#ef4444';
  const sourceType = String(block?.sourceType || '').toUpperCase();
  return sourceType === 'BULK_IMPORT' ? '#64748b' : '#6b7280';
}

function activeAvailabilityBlock(vehicle) {
  const now = Date.now();
  return (Array.isArray(vehicle?.availabilityBlocks) ? vehicle.availabilityBlocks : []).find((block) => {
    const releasedAt = block?.releasedAt ? new Date(block.releasedAt).getTime() : null;
    const blockedFrom = block?.blockedFrom ? new Date(block.blockedFrom).getTime() : now;
    const availableFrom = block?.availableFrom ? new Date(block.availableFrom).getTime() : null;
    return !releasedAt && blockedFrom <= now && availableFrom && availableFrom > now;
  }) || null;
}

function blockTypeLabel(value) {
  switch (String(value || '').toUpperCase()) {
    case 'MAINTENANCE_HOLD': return 'Maintenance Hold';
    case 'OUT_OF_SERVICE_HOLD': return 'Out Of Service';
    default: return 'Migration Hold';
  }
}

function isMigrationHold(block) {
  return String(block?.blockType || '').toUpperCase() === 'MIGRATION_HOLD';
}

function isServiceHold(block) {
  return ['MAINTENANCE_HOLD', 'OUT_OF_SERVICE_HOLD'].includes(String(block?.blockType || '').toUpperCase());
}

function toLocalDateTimeInput(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  return `${year}-${month}-${day}T${hours}:${minutes}`;
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
  const [dragMeta, setDragMeta] = useState(null);
  const [draggingId, setDraggingId] = useState('');
  const [selectedReservation, setSelectedReservation] = useState(null);
  const [selectedBlock, setSelectedBlock] = useState(null);
  const [showBlockVehicle, setShowBlockVehicle] = useState(false);
  const [selectedVehicleForBlock, setSelectedVehicleForBlock] = useState(null);
  const [blockForm, setBlockForm] = useState({
    blockType: 'MIGRATION_HOLD',
    blockedFrom: toLocalDateTimeInput(new Date()),
    availableFrom: '',
    reason: '',
    notes: ''
  });
  const [plannerFocus, setPlannerFocus] = useState('ALL');

  const dayCount = view === 'DAY' ? 1 : view === 'WEEK' ? 7 : 30;
  const rangeStart = useMemo(() => startOfDay(cursor), [cursor]);
  const rangeEnd = useMemo(() => addDays(rangeStart, dayCount), [rangeStart, dayCount]);

  const load = async () => {
    const [r, a, v, vt, l] = await Promise.allSettled([
      api('/api/reservations', {}, token),
      api('/api/rental-agreements', {}, token),
      api('/api/vehicles', {}, token),
      api('/api/vehicle-types', {}, token),
      api('/api/locations', {}, token)
    ]);
    if (r.status === 'fulfilled') setReservations(r.value || []);
    else setReservations([]);
    if (a.status === 'fulfilled') setAgreements(a.value || []);
    else setAgreements([]);
    if (v.status === 'fulfilled') setVehicles(v.value || []);
    else setVehicles([]);
    if (vt.status === 'fulfilled') setVehicleTypes(vt.value || []);
    else setVehicleTypes([]);
    if (l.status === 'fulfilled') setLocations(l.value || []);
    else setLocations([]);

    if (r.status === 'rejected' || v.status === 'rejected') {
      setMsg(r.status === 'rejected' ? (r.reason?.message || 'Unable to load planner') : (v.reason?.message || 'Unable to load planner'));
    } else if ([a, vt, l].some((row) => row.status === 'rejected')) {
      setMsg('Planner loaded with limited supporting data');
    } else {
      setMsg('');
    }
  };

  useEffect(() => { load(); }, [token]);

  const replaceReservationInState = (updatedReservation) => {
    if (!updatedReservation?.id) return;
    setReservations((current) => current.map((row) => (
      row.id === updatedReservation.id
        ? { ...row, ...updatedReservation }
        : row
    )));
    setSelectedReservation((current) => (
      current?.reservation?.id === updatedReservation.id
        ? { ...current, reservation: { ...current.reservation, ...updatedReservation } }
        : current
    ));
  };

  const upsertVehicleBlockInState = (vehicleId, block) => {
    if (!vehicleId || !block?.id) return;
    setVehicles((current) => current.map((vehicle) => {
      if (vehicle.id !== vehicleId) return vehicle;
      const existing = Array.isArray(vehicle.availabilityBlocks) ? vehicle.availabilityBlocks : [];
      const nextBlocks = existing.some((row) => row.id === block.id)
        ? existing.map((row) => (row.id === block.id ? { ...row, ...block } : row))
        : [...existing, block];
      return { ...vehicle, availabilityBlocks: nextBlocks };
    }));
    setSelectedBlock((current) => (
      current?.block?.id === block.id
        ? { ...current, block: { ...current.block, ...block } }
        : current
    ));
  };

  const openBlockVehicle = (vehicle) => {
    const activeBlock = activeAvailabilityBlock(vehicle);
    const baseStart = activeBlock?.blockedFrom ? toLocalDateTimeInput(activeBlock.blockedFrom) : toLocalDateTimeInput(new Date());
    setSelectedReservation(null);
    setSelectedBlock(null);
    setSelectedVehicleForBlock(vehicle);
    setBlockForm({
      blockType: activeBlock?.blockType || 'MIGRATION_HOLD',
      blockedFrom: baseStart,
      availableFrom: activeBlock?.availableFrom ? toLocalDateTimeInput(activeBlock.availableFrom) : '',
      reason: activeBlock?.reason || '',
      notes: activeBlock?.notes || ''
    });
    setShowBlockVehicle(true);
  };

  const saveVehicleBlock = async (e) => {
    e.preventDefault();
    if (!selectedVehicleForBlock) return;
    try {
      const createdBlock = await api(`/api/vehicles/${selectedVehicleForBlock.id}/availability-blocks`, {
        method: 'POST',
        body: JSON.stringify(blockForm)
      }, token);
      upsertVehicleBlockInState(selectedVehicleForBlock.id, createdBlock);
      setMsg(`Vehicle ${selectedVehicleForBlock.internalNumber} blocked until ${new Date(blockForm.availableFrom).toLocaleString()}`);
      setShowBlockVehicle(false);
      setSelectedVehicleForBlock(null);
    } catch (error) {
      setMsg(error.message);
    }
  };

  const releaseVehicleBlock = async (blockId) => {
    try {
      const releasedBlock = await api(`/api/vehicles/availability-blocks/${blockId}/release`, {
        method: 'POST',
        body: JSON.stringify({})
      }, token);
      upsertVehicleBlockInState(releasedBlock?.vehicleId || selectedBlock?.vehicle?.id || selectedVehicleForBlock?.id || null, releasedBlock);
      setMsg('Vehicle block released');
      setSelectedBlock(null);
      setShowBlockVehicle(false);
      setSelectedVehicleForBlock(null);
    } catch (error) {
      setMsg(error.message);
    }
  };

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
      map.get(vid).push({ kind: 'reservation', reservation: r, start, span, end });
    }

    for (const vehicle of vehicles || []) {
      if (!map.has(vehicle.id)) continue;
      for (const block of Array.isArray(vehicle.availabilityBlocks) ? vehicle.availabilityBlocks : []) {
        const blockedFrom = new Date(block.blockedFrom || block.createdAt || new Date());
        const availableFrom = new Date(block.availableFrom);
        const releasedAt = block?.releasedAt ? new Date(block.releasedAt) : null;
        if (releasedAt || Number.isNaN(blockedFrom.getTime()) || Number.isNaN(availableFrom.getTime())) continue;
        if (!(blockedFrom < rangeEnd && availableFrom > rangeStart)) continue;

        const start = Math.max(0, (blockedFrom.getTime() - rangeStart.getTime()) / DAY_MS);
        const end = Math.min(dayCount, (availableFrom.getTime() - rangeStart.getTime()) / DAY_MS);
        const span = Math.max(0.15, end - start);
        map.get(vehicle.id).push({ kind: 'block', block, vehicle, start, span, end });
      }
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
  }, [tracks, reservations, vehicles, rangeStart, rangeEnd, dayCount]);

  const onDropReservation = async (trackVehicleId, dayIndexRaw, dropMetrics = null) => {
    if (!dragItem) return;
    const r = dragItem;
    if (lockedReservationIds.has(r.id)) return;

    const dayIndex = Number(dayIndexRaw);
    if (!Number.isFinite(dayIndex) || dayIndex < 0) return;

    try {
      const oldPickup = new Date(r.pickupAt);
      const oldReturn = new Date(r.returnAt);
      const duration = oldReturn.getTime() - oldPickup.getTime();

      let startDayIndex = dayIndex;
      if (dropMetrics && Number.isFinite(dropMetrics.pointerOffsetWithinCellPx) && Number.isFinite(dragMeta?.grabOffsetPx)) {
        const rawLeftPx = dayIndex * DAY_WIDTH + dropMetrics.pointerOffsetWithinCellPx - dragMeta.grabOffsetPx;
        const preciseStart = Math.max(0, rawLeftPx) / DAY_WIDTH;
        startDayIndex = Math.max(0, Math.floor(preciseStart));
      }

      const newStartDay = addDays(rangeStart, startDayIndex);
      const newPickup = new Date(newStartDay);
      newPickup.setHours(oldPickup.getHours(), oldPickup.getMinutes(), oldPickup.getSeconds(), oldPickup.getMilliseconds());
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
        setDragMeta(null);
        setDraggingId('');
        return;
      }

      const updatedReservation = await api(`/api/reservations/${r.id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          vehicleId: trackVehicleId === '__unassigned__' ? null : trackVehicleId,
          pickupAt: newPickup.toISOString(),
          returnAt: newReturn.toISOString()
        })
      }, token);
      replaceReservationInState(updatedReservation);
      setMsg(`Reservation ${r.reservationNumber} moved`);
      setDragItem(null);
      setDragMeta(null);
      setDraggingId('');
    } catch (e) {
      setMsg(e.message);
      setDragItem(null);
      setDragMeta(null);
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
    const rect = cell.getBoundingClientRect();
    onDropReservation(cell.getAttribute('data-track-id'), cell.getAttribute('data-day-index'), {
      pointerOffsetWithinCellPx: touch.clientX - rect.left
    });
  };

  const goPrev = () => setCursor((d) => addDays(d, -dayCount));
  const goNext = () => setCursor((d) => addDays(d, dayCount));
  const goToday = () => setCursor(startOfDay(new Date()));

  const plannerOpsBoard = useMemo(() => {
    const sameDay = (value) => {
      const date = new Date(value);
      const today = startOfDay(new Date());
      const check = startOfDay(date);
      return check.getTime() === today.getTime();
    };

    const upcoming = (reservations || [])
      .filter((r) => ['CONFIRMED', 'NEW'].includes(String(r?.status || '').toUpperCase()))
      .sort((a, b) => new Date(a.pickupAt) - new Date(b.pickupAt));
    const returns = (reservations || [])
      .filter((r) => String(r?.status || '').toUpperCase() === 'CHECKED_OUT')
      .sort((a, b) => new Date(a.returnAt) - new Date(b.returnAt));
    const unassigned = (reservations || []).filter((r) => !r?.vehicleId);
    const movable = upcoming.find((r) => !lockedReservationIds.has(r.id)) || unassigned[0] || returns[0] || null;

    const nextItems = [
      upcoming[0]
        ? {
            id: `pickup-${upcoming[0].id}`,
            focus: 'PICKUPS',
            title: 'Next Pickup',
            detail: `${upcoming[0].reservationNumber} - ${upcoming[0].customer?.firstName || ''} ${upcoming[0].customer?.lastName || ''}`.trim(),
            note: `Pickup ${new Date(upcoming[0].pickupAt).toLocaleString()}`,
            href: `/reservations/${upcoming[0].id}/checkout`,
            actionLabel: 'Open Check-out'
          }
        : null,
      returns[0]
        ? {
            id: `return-${returns[0].id}`,
            focus: 'RETURNS',
            title: 'Next Return',
            detail: `${returns[0].reservationNumber} - ${returns[0].customer?.firstName || ''} ${returns[0].customer?.lastName || ''}`.trim(),
            note: `Return ${new Date(returns[0].returnAt).toLocaleString()}`,
            href: `/reservations/${returns[0].id}/checkin`,
            actionLabel: 'Open Check-in'
          }
        : null,
      unassigned[0]
        ? {
            id: `unassigned-${unassigned[0].id}`,
            focus: 'UNASSIGNED',
            title: 'Unassigned Unit',
            detail: `${unassigned[0].reservationNumber} - ${unassigned[0].customer?.firstName || ''} ${unassigned[0].customer?.lastName || ''}`.trim(),
            note: 'This booking still needs a vehicle assignment in the planner.',
            href: `/reservations/${unassigned[0].id}`,
            actionLabel: 'Open Workflow'
          }
        : null,
      movable
        ? {
            id: `move-${movable.id}`,
            focus: 'MOVABLE',
            title: 'Next Movable Booking',
            detail: `${movable.reservationNumber} - ${movable.customer?.firstName || ''} ${movable.customer?.lastName || ''}`.trim(),
            note: movable.vehicleId ? 'Booking can be dragged on the planner if the lane needs to rebalance inventory.' : 'Best candidate to place onto a vehicle track.',
            href: `/reservations/${movable.id}`,
            actionLabel: 'Review Booking'
          }
        : null
    ].filter(Boolean);

    return {
      pickupsToday: (reservations || []).filter((r) => sameDay(r.pickupAt)).length,
      returnsToday: (reservations || []).filter((r) => sameDay(r.returnAt)).length,
      checkedOut: (reservations || []).filter((r) => String(r?.status || '').toUpperCase() === 'CHECKED_OUT').length,
      migrationHolds: (vehicles || []).filter((vehicle) => isMigrationHold(activeAvailabilityBlock(vehicle))).length,
      serviceHolds: (vehicles || []).filter((vehicle) => isServiceHold(activeAvailabilityBlock(vehicle))).length,
      unassigned: unassigned.length,
      nextItems
    };
  }, [reservations, lockedReservationIds, vehicles]);

  const plannerFocusOptions = useMemo(() => ([
    { id: 'ALL', label: 'All Queues', count: plannerOpsBoard.nextItems.length },
    { id: 'PICKUPS', label: 'Pickups', count: plannerOpsBoard.nextItems.filter((item) => item.focus === 'PICKUPS').length },
    { id: 'RETURNS', label: 'Returns', count: plannerOpsBoard.nextItems.filter((item) => item.focus === 'RETURNS').length },
    { id: 'UNASSIGNED', label: 'Unassigned', count: plannerOpsBoard.nextItems.filter((item) => item.focus === 'UNASSIGNED').length },
    { id: 'MOVABLE', label: 'Movable', count: plannerOpsBoard.nextItems.filter((item) => item.focus === 'MOVABLE').length }
  ]), [plannerOpsBoard]);

  const plannerFocusSummary = useMemo(() => {
    switch (plannerFocus) {
      case 'PICKUPS':
        return 'Focus the lane on departures that still need keys, documents, or unit readiness before release.';
      case 'RETURNS':
        return 'Keep only return work visible so the shift can receive vehicles faster from phone or tablet.';
      case 'UNASSIGNED':
        return 'Show only bookings still waiting on a vehicle assignment before they hit the counter.';
      case 'MOVABLE':
        return 'Highlight the best booking to drag next when rebalancing inventory across the timeline.';
      default:
        return 'Quick counters and next bookings to touch before dragging units around the planner grid.';
    }
  }, [plannerFocus]);

  const plannerFocusItems = useMemo(() => {
    if (plannerFocus === 'ALL') return plannerOpsBoard.nextItems;
    return plannerOpsBoard.nextItems.filter((item) => item.focus === plannerFocus);
  }, [plannerFocus, plannerOpsBoard]);

  return (
    <AppShell me={me} logout={logout}>
      <section className="glass card-lg section-card" style={{ marginBottom: 16 }}>
        <div className="app-banner">
          <div className="row-between" style={{ alignItems: 'start', marginBottom: 0 }}>
            <div>
              <span className="eyebrow">Planner Ops Board</span>
              <h2 className="page-title" style={{ marginTop: 6 }}>
                Keep the yard balanced before you drop into the timeline.
              </h2>
              <p className="ui-muted">{plannerFocusSummary}</p>
            </div>
            <span className="status-chip neutral">Planner Hub</span>
          </div>
          <div className="app-card-grid compact">
            <div className="info-tile">
              <span className="label">Pickups Today</span>
              <strong>{plannerOpsBoard.pickupsToday}</strong>
              <span className="ui-muted">Reservations scheduled to leave today.</span>
            </div>
            <div className="info-tile">
              <span className="label">Returns Today</span>
              <strong>{plannerOpsBoard.returnsToday}</strong>
              <span className="ui-muted">Bookings expected back today.</span>
            </div>
            <div className="info-tile">
              <span className="label">Checked Out</span>
              <strong>{plannerOpsBoard.checkedOut}</strong>
              <span className="ui-muted">Bookings currently out and locked by agreement.</span>
            </div>
            <div className="info-tile">
              <span className="label">Migration Holds</span>
              <strong>{plannerOpsBoard.migrationHolds}</strong>
              <span className="ui-muted">Vehicles blocked until legacy contracts are expected back.</span>
            </div>
            <div className="info-tile">
              <span className="label">Service Holds</span>
              <strong>{plannerOpsBoard.serviceHolds}</strong>
              <span className="ui-muted">Maintenance and out-of-service windows on the board.</span>
            </div>
            <div className="info-tile">
              <span className="label">Unassigned</span>
              <strong>{plannerOpsBoard.unassigned}</strong>
              <span className="ui-muted">Reservations still waiting for a vehicle track.</span>
            </div>
          </div>
          {plannerFocusOptions.length ? (
            <div className="app-banner-list">
              {plannerFocusOptions.map((option) => (
                <button
                  key={option.id}
                  type="button"
                  className={plannerFocus === option.id ? '' : 'button-subtle'}
                  onClick={() => setPlannerFocus(option.id)}
                  style={{ minHeight: 36, paddingInline: 14 }}
                >
                  {option.label} | {option.count}
                </button>
              ))}
            </div>
          ) : null}
          {plannerFocusItems.length ? (
            <div className="app-card-grid compact">
              {plannerFocusItems.map((item) => (
                <section key={item.id} className="glass card section-card">
                  <div className="section-title" style={{ fontSize: 15 }}>{item.title}</div>
                  <div className="ui-muted">{item.detail}</div>
                  <div className="surface-note">{item.note}</div>
                  <div className="inline-actions">
                    <Link href={item.href}><button type="button">{item.actionLabel}</button></Link>
                  </div>
                </section>
              ))}
            </div>
          ) : plannerOpsBoard.nextItems.length ? (
            <div className="surface-note">No bookings match this planner focus right now. Switch filters to review another lane.</div>
          ) : null}
        </div>
      </section>
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
            <button onClick={goPrev}>Previous</button>
            <div className="label" style={{ minWidth: 180, textAlign: 'center' }}>{fmtDay(rangeStart)} - {fmtDay(addDays(rangeEnd, -1))}</div>
            <button onClick={goNext}>Next</button>
          </div>
        </div>

        {msg ? <p className="label">{msg}</p> : null}
        <div className="app-banner-list" style={{ marginBottom: 12 }}>
          <span className="app-banner-pill">Green = Confirmed</span>
          <span className="app-banner-pill">Blue = New</span>
          <span className="app-banner-pill">Purple = Checked Out</span>
          <span className="app-banner-pill">Gray = Migration Hold</span>
          <span className="app-banner-pill">Orange = Maintenance</span>
          <span className="app-banner-pill">Red = Out Of Service</span>
        </div>

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
                  {activeAvailabilityBlock(v) ? (
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                      <span className="status-chip warning">Blocked</span>
                      <span className="label" style={{ textTransform: 'none', letterSpacing: 0 }}>
                        Free {new Date(activeAvailabilityBlock(v).availableFrom).toLocaleString()}
                      </span>
                    </div>
                  ) : null}
                  <div style={{ fontWeight: 700 }}>{v.make} {v.model} {v.year || ''}</div>
                  <div className="label">#{v.internalNumber} | {v.vehicleType?.code || '-'}</div>
                  {v.id !== '__unassigned__' ? (
                    <>
                      {activeAvailabilityBlock(v) ? (
                        <div className="surface-note" style={{ marginTop: 6 }}>
                          {blockTypeLabel(activeAvailabilityBlock(v).blockType)} | {activeAvailabilityBlock(v).reason || 'Legacy contract migration hold'}
                        </div>
                      ) : null}
                      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 8 }}>
                        <button type="button" className="button-subtle" onClick={() => openBlockVehicle(v)}>
                          {activeAvailabilityBlock(v) ? 'Adjust Hold' : 'Add Hold'}
                        </button>
                        {activeAvailabilityBlock(v) ? (
                          <button type="button" className="button-subtle" onClick={() => releaseVehicleBlock(activeAvailabilityBlock(v).id)}>
                            Release
                          </button>
                        ) : null}
                      </div>
                    </>
                  ) : null}
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
                    onDrop={(e) => {
                      const rect = e.currentTarget.getBoundingClientRect();
                      onDropReservation(v.id, i, {
                        pointerOffsetWithinCellPx: e.clientX - rect.left
                      });
                    }}
                  />
                ))}

                <div className="planner-overlay" style={{ left: 260, width: dayCount * DAY_WIDTH, height: rowHeight }}>
                  {rows.map((rowItem) => {
                    if (rowItem.kind === 'block') {
                      const block = rowItem.block;
                      return (
                        <div
                          key={`block-${block.id}`}
                          className="planner-block"
                          onClick={() => {
                            setSelectedReservation(null);
                            setSelectedBlock({ block, vehicle: rowItem.vehicle });
                          }}
                          style={{
                            left: rowItem.start * DAY_WIDTH + 2,
                            top: rowItem.lane * lanePitch + 4,
                            height: blockHeight,
                            width: Math.max(12, rowItem.span * DAY_WIDTH - 4),
                            background: blockColor(block),
                            opacity: 0.92,
                            cursor: 'pointer'
                          }}
                          title={`Blocked until ${new Date(block.availableFrom).toLocaleString()}`}
                        >
                          <span className="planner-block-text">{blockTypeLabel(block.blockType)} | {block.reason || 'Legacy contract'} | Free {new Date(block.availableFrom).toLocaleDateString()}</span>
                        </div>
                      );
                    }

                    const r = rowItem.reservation;
                    const locked = lockedReservationIds.has(r.id);
                    return (
                      <div
                        key={r.id}
                        className="planner-block"
                        draggable={!locked}
                        onDragStart={(e) => {
                          const rect = e.currentTarget.getBoundingClientRect();
                          setDragItem(r);
                          setDragMeta({ grabOffsetPx: Math.max(0, e.clientX - rect.left) });
                          setDraggingId(r.id);
                        }}
                        onDragEnd={() => { setDragItem(null); setDragMeta(null); setDraggingId(''); }}
                        onTouchStart={(e) => {
                          if (locked) return;
                          const touch = e.touches?.[0];
                          const rect = e.currentTarget.getBoundingClientRect();
                          setDragItem(r);
                          setDragMeta({ grabOffsetPx: touch ? Math.max(0, touch.clientX - rect.left) : 0 });
                          setDraggingId(r.id);
                        }}
                        onTouchEnd={handleTouchDrop}
                        onClick={() => {
                          setSelectedBlock(null);
                          setSelectedReservation({ reservation: r, locked });
                        }}
                        style={{ left: rowItem.start * DAY_WIDTH + 2, top: rowItem.lane * lanePitch + 4, height: blockHeight, width: Math.max(12, rowItem.span * DAY_WIDTH - 4), background: statusColor(r, locked), opacity: locked ? 0.7 : (draggingId === r.id ? 0.85 : 1) }}
                        title={`${r.reservationNumber} ${locked ? '(locked by agreement)' : ''}`}
                      >
                        <span className="planner-block-text">{locked ? 'Locked | ' : ''}{r.reservationNumber} | {r.customer?.firstName || ''} {r.customer?.lastName || ''}</span>
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
          <div className="label" style={{ marginBottom: 8 }}>{selectedReservation.locked ? 'Locked by agreement' : 'Movable reservation'}</div>
          <div style={{ display: 'grid', gap: 8 }}>
            <Link href={`/reservations/${selectedReservation.reservation.id}`}><button>Open Reservation</button></Link>
          </div>
        </aside>
      ) : null}

      {selectedBlock ? (
        <aside className="planner-sidepanel glass card">
          <div className="row-between" style={{ marginBottom: 6 }}>
            <h3>Vehicle Block</h3>
            <button onClick={() => setSelectedBlock(null)}>Close</button>
          </div>
          <div style={{ fontWeight: 700 }}>{selectedBlock.vehicle?.internalNumber || 'Vehicle'}</div>
          <div className="label">{selectedBlock.vehicle?.year || ''} {selectedBlock.vehicle?.make || ''} {selectedBlock.vehicle?.model || ''}</div>
          <div className="label">Type: {blockTypeLabel(selectedBlock.block.blockType)}</div>
          <div className="label">Blocked from: {new Date(selectedBlock.block.blockedFrom).toLocaleString()}</div>
          <div className="label">Available again: {new Date(selectedBlock.block.availableFrom).toLocaleString()}</div>
          <div className="label">Reason: {selectedBlock.block.reason || 'Legacy contract migration hold'}</div>
          {selectedBlock.block.notes ? <div className="label" style={{ marginBottom: 8 }}>Notes: {selectedBlock.block.notes}</div> : null}
          <div className="label" style={{ marginBottom: 8 }}>Source: {selectedBlock.block.sourceType || 'MANUAL'}</div>
          <div style={{ display: 'grid', gap: 8 }}>
            <button type="button" onClick={() => releaseVehicleBlock(selectedBlock.block.id)}>Release Block</button>
            <button type="button" className="button-subtle" onClick={() => openBlockVehicle(selectedBlock.vehicle)}>Edit Block</button>
          </div>
        </aside>
      ) : null}

      {showBlockVehicle && selectedVehicleForBlock ? (
        <div className="modal-backdrop" onClick={() => { setShowBlockVehicle(false); setSelectedVehicleForBlock(null); }}>
          <div className="rent-modal glass" onClick={(e) => e.stopPropagation()}>
            <h3>Temporary Hold | {selectedVehicleForBlock.internalNumber}</h3>
            <form className="stack" onSubmit={saveVehicleBlock}>
              <div className="grid2">
                <select value={blockForm.blockType} onChange={(e) => setBlockForm({ ...blockForm, blockType: e.target.value })}>
                  <option value="MIGRATION_HOLD">Migration Hold</option>
                  <option value="MAINTENANCE_HOLD">Maintenance Hold</option>
                  <option value="OUT_OF_SERVICE_HOLD">Out Of Service Hold</option>
                </select>
                <div />
              </div>
              <div className="grid2">
                <div className="stack">
                  <label className="label">Blocked From</label>
                  <input type="datetime-local" value={blockForm.blockedFrom} onChange={(e) => setBlockForm({ ...blockForm, blockedFrom: e.target.value })} />
                </div>
                <div className="stack">
                  <label className="label">Available Again*</label>
                  <input required type="datetime-local" value={blockForm.availableFrom} onChange={(e) => setBlockForm({ ...blockForm, availableFrom: e.target.value })} />
                </div>
              </div>
              <input placeholder="Reason (migration hold, legacy contract, etc.)" value={blockForm.reason} onChange={(e) => setBlockForm({ ...blockForm, reason: e.target.value })} />
              <textarea rows={4} placeholder="Notes" value={blockForm.notes} onChange={(e) => setBlockForm({ ...blockForm, notes: e.target.value })} />
              <div className="surface-note">Migration holds count as already committed fleet. Maintenance and out-of-service holds remove units from rentable service until the selected release date.</div>
              <div className="row-between">
                <button type="button" onClick={() => { setShowBlockVehicle(false); setSelectedVehicleForBlock(null); }}>Cancel</button>
                <button type="submit">Save Hold</button>
              </div>
            </form>
          </div>
        </div>
      ) : null}
    </AppShell>
  );
}
