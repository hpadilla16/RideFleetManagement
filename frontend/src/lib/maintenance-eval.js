// Maintenance detection at check-in (Feature A, 2026-09-01) — the client-side
// mirror of the backend's evalSchedule (maintenance.service.js). The Step-3
// banner re-evaluates on every keystroke against the TYPED return odometer —
// the reading that can cross an interval before it is ever written — so the
// arithmetic must run client-side over the schedules fetched once per wizard
// (GET /api/maintenance/vehicles/:id/schedules). Pure functions, unit-tested
// (frontend/test/maintenance-checkin-banner.test.jsx).
//
// Status is MILEAGE-DRIVEN (Hector, 2026-07-13): when the schedule has a
// miles basis, only the odometer decides ok/soon/overdue; days decide only
// when there is no mileage basis. Same thresholds as the backend:
// "soon" = within 500 mi / 14 days.

export const MILE_SOON = 500;
export const DAY_SOON = 14;

/** Mirror of backend evalSchedule(s, vehicleMileage, now). */
export function evalScheduleAt(s, vehicleMileage, now) {
  let dueByMiles = null; let nextDueMiles = null;
  if (s.intervalMiles && s.lastServiceMiles != null) {
    nextDueMiles = s.lastServiceMiles + s.intervalMiles;
    if (vehicleMileage != null) dueByMiles = vehicleMileage - nextDueMiles; // ≥0 overdue, [-SOON,0) soon
  }
  let dueByDays = null; let nextDueAt = null;
  if (s.intervalDays && s.lastServiceAt) {
    nextDueAt = new Date(new Date(s.lastServiceAt).getTime() + s.intervalDays * 86400000);
    dueByDays = Math.round((now - nextDueAt) / 86400000); // ≥0 overdue, [-SOON,0) soon
  }
  const basis = dueByMiles != null ? 'MILES' : (dueByDays != null ? 'DAYS' : null);
  let overdue = false; let soon = false;
  if (basis === 'MILES') {
    overdue = dueByMiles >= 0;
    soon = !overdue && dueByMiles >= -MILE_SOON;
  } else if (basis === 'DAYS') {
    overdue = dueByDays >= 0;
    soon = !overdue && dueByDays >= -DAY_SOON;
  }
  return { basis, nextDueMiles, nextDueAt, dueByMiles, dueByDays, overdue, soon };
}

/**
 * Evaluate a vehicle's schedules at a hypothetical (typed) odometer reading.
 * Returns only the actionable rows — overdue first, then due-soon — each
 * display-ready: state, gap in the schedule's own basis, and a 0..100 gauge.
 *
 * @param schedules rows from GET /api/maintenance/vehicles/:id/schedules
 * @param typedMileage the agent's typed return odometer (number or null)
 * @param now epoch ms (defaults to Date.now())
 */
export function buildDueItems(schedules, typedMileage, now = Date.now()) {
  const mileage = typedMileage != null && Number.isFinite(Number(typedMileage)) && Number(typedMileage) > 0
    ? Number(typedMileage) : null;
  const items = [];
  for (const s of Array.isArray(schedules) ? schedules : []) {
    if (s?.active === false) continue;
    const ev = evalScheduleAt(s, mileage, now);
    if (!ev.overdue && !ev.soon) continue;
    // Gauge: progress toward (and past, capped) the interval in the basis
    // that decides the status. Overdue always renders full.
    let gaugePct = 100;
    if (!ev.overdue) {
      if (ev.basis === 'MILES' && s.intervalMiles) {
        gaugePct = Math.max(0, Math.min(100, Math.round(((mileage - s.lastServiceMiles) / s.intervalMiles) * 100)));
      } else if (ev.basis === 'DAYS' && s.intervalDays) {
        const elapsedDays = (now - new Date(s.lastServiceAt).getTime()) / 86400000;
        gaugePct = Math.max(0, Math.min(100, Math.round((elapsedDays / s.intervalDays) * 100)));
      }
    }
    items.push({
      serviceType: s.serviceType,
      intervalMiles: s.intervalMiles ?? null,
      intervalDays: s.intervalDays ?? null,
      lastServiceMiles: s.lastServiceMiles ?? null,
      lastServiceAt: s.lastServiceAt ?? null,
      nowMileage: mileage,
      ...ev,
      state: ev.overdue ? 'OVERDUE' : 'SOON',
      // Concrete gap in the deciding basis, always a positive integer.
      gapMiles: ev.basis === 'MILES' ? Math.abs(Math.round(ev.dueByMiles)) : null,
      gapDays: ev.basis === 'DAYS' ? Math.abs(Math.round(ev.dueByDays)) : null,
      gaugePct,
    });
  }
  // Overdue first, then by how far past (same ordering as backend due()).
  items.sort((a, b) => (Number(b.overdue) - Number(a.overdue))
    || ((b.dueByMiles ?? b.dueByDays ?? 0) - (a.dueByMiles ?? a.dueByDays ?? 0)));
  return items;
}

/**
 * The Step-3 Continue gate: blocked while at least one OVERDUE item exists
 * and the agent has not chosen (send-to-maintenance armed or snoozed).
 * Due-soon rows ride along informationally — they never gate.
 */
export function maintenanceGateBlocked(items, decisionStatus) {
  const hasOverdue = (items || []).some((i) => i.state === 'OVERDUE');
  return hasOverdue && String(decisionStatus || 'PENDING') === 'PENDING';
}
