// Board helpers for the board-first Planner (2026-07-14 reimagining).
//
// The backend snapshot (`/api/planner/snapshot`) is the single source of truth
// for lane-packed tracks and counters. These helpers only ADAPT that payload
// for display (grouping, search, virtualization windows) and compute
// client-side drag PREVIEW legality — the server (`POST /api/planner/assign`)
// remains the authority on every real assignment.

import { DAY_MS } from './planner-utils.mjs';

export function buildLockedReservationIds(reservations) {
  return new Set((reservations || [])
    .filter((reservation) => String(reservation.status || '').toUpperCase() === 'CHECKED_OUT')
    .map((reservation) => reservation.id));
}

// ---------------------------------------------------------------------------
// Snapshot adapter — the ONE place that normalizes `snapshot.tracks` for the UI.
// Expected backend shape per track: { vehicle: {...}, items: [...], laneCount }.
// Older payloads used `lanes` instead of `laneCount`; both are accepted here.
// ---------------------------------------------------------------------------
export function adaptSnapshotTrack(track = {}) {
  return {
    vehicle: track.vehicle || {},
    items: Array.isArray(track.items) ? track.items : [],
    laneCount: Math.max(1, Number(track.laneCount ?? track.lanes ?? 1) || 1)
  };
}

function vehicleSearchHaystack(track) {
  const vehicle = track.vehicle || {};
  const parts = [
    vehicle.plate,
    vehicle.internalNumber,
    vehicle.make,
    vehicle.model,
    vehicle.vehicleType?.name,
    vehicle.vehicleType?.code
  ];
  for (const item of track.items) {
    if (item.kind === 'reservation') {
      parts.push(item.reservationNumber, item.customer?.firstName, item.customer?.lastName);
    }
  }
  return parts.filter(Boolean).join(' ').toLowerCase();
}

export function reservationMatchesSearch(reservation, query) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return true;
  const haystack = [
    reservation?.reservationNumber,
    reservation?.customer?.firstName,
    reservation?.customer?.lastName,
    reservation?.vehicleType?.code,
    reservation?.vehicleType?.name
  ].filter(Boolean).join(' ').toLowerCase();
  return haystack.includes(q);
}

// Groups adapted tracks by vehicle type into renderable rows:
// [{kind:'group', id, label, code, count}, {kind:'vehicle', id, track}, ...]
export function buildBoardRows({ tracks, search = '' } = {}) {
  const adapted = (tracks || []).map(adaptSnapshotTrack).filter((track) => track.vehicle?.id);
  const q = String(search || '').trim().toLowerCase();
  const visible = q ? adapted.filter((track) => vehicleSearchHaystack(track).includes(q)) : adapted;

  const grouped = new Map();
  for (const track of visible) {
    const type = track.vehicle.vehicleType || null;
    const typeId = String(track.vehicle.vehicleTypeId || type?.id || 'unknown');
    const bucket = grouped.get(typeId) || {
      id: typeId,
      label: type?.name || type?.code || 'Other',
      code: type?.code || '',
      tracks: []
    };
    bucket.tracks.push(track);
    grouped.set(typeId, bucket);
  }

  const rows = [];
  [...grouped.values()]
    .sort((left, right) => `${left.label} ${left.code}`.localeCompare(`${right.label} ${right.code}`))
    .forEach((group) => {
      group.tracks.sort((left, right) => {
        const a = `${left.vehicle.plate || ''} ${left.vehicle.internalNumber || ''} ${left.vehicle.make || ''} ${left.vehicle.model || ''}`.toLowerCase();
        const b = `${right.vehicle.plate || ''} ${right.vehicle.internalNumber || ''} ${right.vehicle.make || ''} ${right.vehicle.model || ''}`.toLowerCase();
        return a.localeCompare(b);
      });
      rows.push({ kind: 'group', id: `group-${group.id}`, label: group.label, code: group.code, count: group.tracks.length });
      group.tracks.forEach((track) => {
        rows.push({ kind: 'vehicle', id: `veh-${track.vehicle.id}`, track });
      });
    });

  return rows;
}

// ---------------------------------------------------------------------------
// Row virtualization (simple windowing — no deps).
// ---------------------------------------------------------------------------
export const GROUP_ROW_HEIGHT = 34;
export const LANE_PITCH = 36;
export const BASE_ROW_HEIGHT = 48;

export function boardRowHeight(row) {
  if (!row) return 0;
  if (row.kind === 'group') return GROUP_ROW_HEIGHT;
  const laneCount = Math.max(1, row.track?.laneCount || 1);
  return Math.max(BASE_ROW_HEIGHT, laneCount * LANE_PITCH + 12);
}

export function computeVirtualWindow({ heights, scrollTop = 0, viewportHeight = 800, overscan = 260 } = {}) {
  const list = Array.isArray(heights) ? heights : [];
  const offsets = new Array(list.length);
  let total = 0;
  for (let i = 0; i < list.length; i += 1) {
    offsets[i] = total;
    total += list[i];
  }
  if (!list.length) return { start: 0, end: 0, topPad: 0, bottomPad: 0, totalHeight: 0 };

  const min = Math.max(0, scrollTop - overscan);
  const max = scrollTop + viewportHeight + overscan;
  let start = 0;
  while (start < list.length - 1 && offsets[start] + list[start] < min) start += 1;
  let end = start;
  while (end < list.length && offsets[end] < max) end += 1;

  const bottomStart = end > 0 ? offsets[end - 1] + list[end - 1] : 0;
  return {
    start,
    end,
    topPad: offsets[start] || 0,
    bottomPad: Math.max(0, total - bottomStart),
    totalHeight: total
  };
}

// ---------------------------------------------------------------------------
// Drag preview legality (client-side ONLY — the /assign endpoint re-validates).
// Reason codes intentionally mirror the backend 409 codes so the UI can share
// translations: OCCUPIED | TURNAROUND | TYPE_MISMATCH | LOCKED_STATUS | CROSS_LOCATION.
// ---------------------------------------------------------------------------
const LOCKED_VEHICLE_STATUSES = new Set(['IN_MAINTENANCE', 'OUT_OF_SERVICE', 'SOLD']);

function itemInterval(item) {
  const start = new Date(item.kind === 'block' ? item.blockedFrom : item.pickupAt).getTime();
  const end = new Date(item.kind === 'block' ? item.availableFrom : item.returnAt).getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  return { start, end };
}

export function evaluateVehicleForReservation({ reservation, track, rules }) {
  const vehicle = track?.vehicle || {};
  const status = String(vehicle.status || '').toUpperCase();
  if (LOCKED_VEHICLE_STATUSES.has(status)) {
    return { legal: false, reason: 'LOCKED_STATUS' };
  }
  if (
    rules?.strictVehicleTypeMatch
    && reservation?.vehicleTypeId
    && vehicle.vehicleTypeId
    && reservation.vehicleTypeId !== vehicle.vehicleTypeId
  ) {
    return { legal: false, reason: 'TYPE_MISMATCH' };
  }
  if (
    rules
    && rules.allowCrossLocationReassignment === false
    && reservation?.pickupLocationId
    && vehicle.homeLocationId
    && reservation.pickupLocationId !== vehicle.homeLocationId
  ) {
    return { legal: false, reason: 'CROSS_LOCATION' };
  }

  const start = new Date(reservation?.pickupAt).getTime();
  const end = new Date(reservation?.returnAt).getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end)) return { legal: false, reason: 'OCCUPIED' };
  const bufferMs = Math.max(0, Number(rules?.minTurnaroundMinutes || 0)) * 60000;

  for (const item of track?.items || []) {
    if (item.kind === 'reservation' && item.id === reservation.id) continue;
    const interval = itemInterval(item);
    if (!interval) continue;
    if (start < interval.end && end > interval.start) {
      return { legal: false, reason: 'OCCUPIED', conflict: item };
    }
    if (start < interval.end + bufferMs && end > interval.start - bufferMs) {
      return { legal: false, reason: 'TURNAROUND', conflict: item };
    }
  }
  return { legal: true };
}

export function computeDragLegality({ reservation, tracks, rules }) {
  const map = {};
  for (const rawTrack of tracks || []) {
    const track = adaptSnapshotTrack(rawTrack);
    if (!track.vehicle?.id) continue;
    map[track.vehicle.id] = evaluateVehicleForReservation({ reservation, track, rules });
  }
  return map;
}

// Ghost bar position (day offsets clamped to the visible range).
export function ghostPositionForReservation(reservation, rangeStart, dayCount) {
  const start = (new Date(reservation?.pickupAt).getTime() - rangeStart.getTime()) / DAY_MS;
  const end = (new Date(reservation?.returnAt).getTime() - rangeStart.getTime()) / DAY_MS;
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  if (end <= 0 || start >= dayCount) return null;
  const clampedStart = Math.max(0, start);
  const clampedEnd = Math.min(dayCount, end);
  return { start: clampedStart, span: Math.max(0.15, clampedEnd - clampedStart) };
}

// ---------------------------------------------------------------------------
// Optimistic assignment — keeps snapshot.tracks coherent without a refetch.
// ---------------------------------------------------------------------------
function laneLayout(items) {
  const sorted = [...items].sort((left, right) => left.start - right.start);
  const laneEnds = [];
  const laid = sorted.map((item) => {
    let lane = laneEnds.findIndex((value) => value <= item.start);
    if (lane < 0) {
      lane = laneEnds.length;
      laneEnds.push(item.end);
    } else {
      laneEnds[lane] = item.end;
    }
    return { ...item, lane };
  });
  return { items: laid, laneCount: Math.max(1, laneEnds.length) };
}

function reservationToTrackItem(reservation, rangeStart) {
  const startOffset = (new Date(reservation.pickupAt).getTime() - rangeStart.getTime()) / DAY_MS;
  const endOffset = (new Date(reservation.returnAt).getTime() - rangeStart.getTime()) / DAY_MS;
  return {
    ...reservation,
    kind: 'reservation',
    start: Math.max(0, startOffset),
    end: Math.max(0.1, endOffset),
    span: Math.max(0.15, endOffset - startOffset)
  };
}

export function applyAssignmentToTracks({ tracks, reservation, vehicleId, rangeStart }) {
  let movedItem = null;
  const next = (tracks || []).map((rawTrack) => {
    const track = adaptSnapshotTrack(rawTrack);
    const hasItem = track.items.some((item) => item.kind === 'reservation' && item.id === reservation.id);
    if (!hasItem) return rawTrack;
    const remaining = track.items.filter((item) => !(item.kind === 'reservation' && item.id === reservation.id));
    movedItem = track.items.find((item) => item.kind === 'reservation' && item.id === reservation.id) || null;
    return { ...rawTrack, ...laneLayout(remaining) };
  });

  if (!vehicleId) return next;

  return next.map((rawTrack) => {
    const track = adaptSnapshotTrack(rawTrack);
    if (track.vehicle?.id !== vehicleId) return rawTrack;
    const item = {
      ...(movedItem || reservationToTrackItem(reservation, rangeStart)),
      vehicleId
    };
    return { ...rawTrack, ...laneLayout([...track.items, item]) };
  });
}

export function adjustCountersForAssignment(counters, previousVehicleId, nextVehicleId) {
  const delta = (previousVehicleId ? 0 : -1) + (nextVehicleId ? 0 : 1);
  if (!counters || !delta) return counters;
  const next = { ...counters };
  for (const key of ['unassignedCount', 'unassigned']) {
    if (typeof next[key] === 'number') next[key] = Math.max(0, next[key] + delta);
  }
  return next;
}

// ---------------------------------------------------------------------------
// KPI pills — prefer the new counter names, fall back to the legacy ones.
// ---------------------------------------------------------------------------
export function buildKpiPills(counters = {}, shortage = null) {
  // counters.shortageToday is an OBJECT `{count, vehicleTypeId, vehicleType}`
  // (or null) from the snapshot — Number(object) is NaN, which rendered a
  // "NaN" pill styled as OK (Innovation MUST-CHANGE 2026-07-14). Read .count
  // first and surface today's short TYPE for the pill label.
  const shortageObj =
    counters.shortageToday && typeof counters.shortageToday === 'object'
      ? counters.shortageToday
      : null;
  return {
    unassigned: Number(counters.unassignedCount ?? counters.unassigned ?? 0),
    overbooked: Number(counters.overbookedCount ?? counters.overbooked ?? 0),
    shortageToday: Number(shortageObj?.count ?? counters.shortageToday ?? shortage?.totalCarsNeeded ?? 0),
    shortageTodayType: shortageObj?.vehicleType || null,
    shortageTodayTypeId: shortageObj?.vehicleTypeId || null,
    pickupsToday: Number(counters.pickupsToday ?? counters.pickups ?? 0),
    returnsToday: Number(counters.returnsToday ?? counters.returns ?? 0)
  };
}

// ---------------------------------------------------------------------------
// 409 conflict parsing — the shared api() helper folds non-`error` JSON bodies
// into the Error message, so extract {code, detail} defensively.
// ---------------------------------------------------------------------------
const ASSIGN_CONFLICT_CODES = ['OCCUPIED', 'LOCKED_STATUS', 'TYPE_MISMATCH', 'TURNAROUND', 'CROSS_LOCATION'];

export function parseAssignConflict(error) {
  const message = String(error?.message || '');
  // Preferred: structured fields set by the planner assign fetch wrapper.
  if (error?.conflictCode) {
    return {
      status: error?.status ?? null,
      code: error.conflictCode,
      detail: error.conflictDetail || '',
      message
    };
  }
  // Fallback: extract from a message that carries the raw JSON body.
  const codeMatch = message.match(/"code"\s*:\s*"([A-Z_]+)"/);
  const detailMatch = message.match(/"detail"\s*:\s*"((?:[^"\\]|\\.)*)"/);
  const code = codeMatch?.[1]
    || ASSIGN_CONFLICT_CODES.find((candidate) => message.includes(candidate))
    || null;
  let detail = '';
  if (detailMatch?.[1]) {
    try { detail = JSON.parse(`"${detailMatch[1]}"`); } catch { detail = detailMatch[1]; }
  }
  return {
    status: error?.status ?? null,
    code,
    detail,
    message
  };
}
