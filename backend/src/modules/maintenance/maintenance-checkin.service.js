// Maintenance detection at check-in (Feature A, 2026-09-01).
// Design: design/mockups/maintenance-checkin-mockup.html + notifications-NOTES.md
// (Feature A sections; gaps A1/A2/A4).
//
// The check-in wizard's Step 3 banner ARMS a decision (send-to-maintenance or
// snooze-until-next-rental-event); checkin-close.service.js FIRES it here,
// AFTER the close's own status sync has run — the sync sets the returned car
// AVAILABLE, which is exactly the state setVehicleInMaintenance (RO open,
// repair-orders.service.js) can flip to the locked IN_MAINTENANCE.
//
// Contract:
// - executeCheckinMaintenanceDecisionSafe NEVER throws: if the RO-open fails
//   at close, the check-in still completes (money first) and the wizard shows
//   "couldn't move to maintenance — open manually" with a retry that lands on
//   retryCheckinDecision below.
// - The snooze stamp (who · reservation · odometer · when) records
//   automatically as a MaintenanceCheckinDecision row; the active snooze
//   MARKER is a SNOOZE row with clearedAt=null, consumed (cleared) by the
//   vehicle's next check-out or check-in wizard open — an event marker, not a
//   timer. The Maintenance Due list never snoozes (due() reads schedules, not
//   this table).
// - Notifications: SNOOZE emits a NEEDS_ACTION envelope (deduped per
//   vehicle+event); a successful SEND emits an INFO envelope naming the RO.

import { prisma } from '../../lib/prisma.js';
import logger from '../../lib/logger.js';
import { scopeAllowedLocationIds } from '../../lib/tenant-scope.js';
import { emitNotificationSafe } from '../notifications/notifications-emit.js';
import { repairOrdersService } from './repair-orders.service.js';

export const CHECKIN_DECISIONS = Object.freeze(['SEND', 'SNOOZE']);
const SERVICE_TYPES = ['LOF', 'TIRE_ROTATION', 'BRAKES', 'INSPECTION', 'OTHER'];

// Same EN labels as notifications.scheduler.js — the stored-title fallback
// language of the notification center (client i18n renders from templateKey).
const SERVICE_LABELS = {
  LOF: 'Oil change',
  TIRE_ROTATION: 'Tire rotation',
  BRAKES: 'Brakes',
  INSPECTION: 'Inspection',
  OTHER: 'Service',
};

function unitLabel(vehicle) {
  return vehicle?.internalNumber || vehicle?.plate || vehicle?.id || 'vehicle';
}

function normalizeServiceTypes(list) {
  const seen = new Set();
  for (const raw of Array.isArray(list) ? list : []) {
    const t = String(raw || '').toUpperCase();
    if (SERVICE_TYPES.includes(t)) seen.add(t);
  }
  return [...seen];
}

/** Best-effort actor display name for the silent stamp. */
async function resolveActorName(db, actorUserId) {
  if (!actorUserId) return null;
  try {
    const u = await db.user.findUnique({
      where: { id: String(actorUserId) },
      select: { fullName: true, email: true },
    });
    return u?.fullName || u?.email || null;
  } catch {
    return null;
  }
}

/**
 * Open the SCHEDULED repair order for a recorded SEND decision. Throws on
 * failure — the Safe executor (and the retry endpoint) own the catch. Reuses
 * repairOrdersService.create so the RO open keeps its canonical side effect:
 * setVehicleInMaintenance flips AVAILABLE/RESERVED → IN_MAINTENANCE, the
 * locked status the reservation sync never clobbers.
 */
async function openScheduledRepairOrder({ decisionRow, deps = {} }) {
  const repairOrders = deps.repairOrders || repairOrdersService;
  const scope = { tenantId: decisionRow.tenantId, userId: decisionRow.byUserId || null };
  const serviceTypes = normalizeServiceTypes(safeParseJson(decisionRow.serviceTypesJson));
  const odo = decisionRow.odometer != null ? Number(decisionRow.odometer) : null;
  const noteParts = [
    `Opened from check-in${decisionRow.reservationNumber ? ` (${decisionRow.reservationNumber})` : ''}${odo != null ? ` at ${odo.toLocaleString('en-US')} mi` : ''}.`,
  ];
  if (decisionRow.note) noteParts.push(decisionRow.note);
  const ro = await repairOrders.create({
    vehicleId: decisionRow.vehicleId,
    source: 'SCHEDULED',
    odometerAtOpen: odo,
    notes: noteParts.join('\n'),
  }, scope);
  // One free-text line per flagged service (A4: lines are free-text; the
  // type code rides in the description so the shop and reports can grep it).
  for (const type of serviceTypes) {
    const label = SERVICE_LABELS[type] || type;
    try {
      await repairOrders.addLine(ro.id, {
        type: 'LABOR',
        description: `${label} (${type}) — flagged at check-in${odo != null ? ` @ ${odo.toLocaleString('en-US')} mi` : ''}`,
        qty: 1,
        unitCost: 0,
        amount: 0,
      }, scope);
    } catch (err) {
      // A missing line must not undo a successfully opened RO.
      logger.warn('[maintenance-checkin] RO line write failed (non-fatal)', {
        repairOrderId: ro.id, type, message: err?.message || String(err),
      });
    }
  }
  return ro;
}

function safeParseJson(s) {
  try { return s ? JSON.parse(s) : []; } catch { return []; }
}

/**
 * Record + execute the Step-3 decision at check-in close. Called from
 * checkin-close.service.js AFTER the close's status sync. Never throws.
 *
 * Returns one of:
 *   { status: 'SENT',    decisionId, repairOrderId, roLabel }
 *   { status: 'SNOOZED', decisionId }
 *   { status: 'FAILED',  decisionId?, error }   — RO could not open (or the
 *                                                 stamp itself failed); the
 *                                                 check-in has already
 *                                                 completed regardless.
 *   null — nothing to do (invalid/absent decision).
 */
export async function executeCheckinMaintenanceDecisionSafe({
  tenantId,
  vehicleId,
  reservationId = null,
  rentalAgreementId = null,
  reservationNumber = null,
  locationId = null,
  action,
  serviceTypes = [],
  note = null,
  odometer = null,
  actorUserId = null,
} = {}, deps = {}) {
  const db = deps.db || prisma;
  const emit = deps.emit || emitNotificationSafe;
  const now = deps.now ? new Date(deps.now) : new Date();
  let decisionRow = null;
  try {
    const decision = String(action || '').toUpperCase();
    if (!tenantId || !vehicleId || !CHECKIN_DECISIONS.includes(decision)) return null;
    const types = normalizeServiceTypes(serviceTypes);

    const [vehicle, byName] = await Promise.all([
      db.vehicle.findUnique({
        where: { id: String(vehicleId) },
        select: { id: true, plate: true, internalNumber: true, homeLocationId: true },
      }).catch(() => null),
      resolveActorName(db, actorUserId),
    ]);
    const unit = unitLabel(vehicle);

    // A new decision supersedes any still-active snooze marker for this
    // vehicle (belt to the wizard-open consume's suspenders).
    await db.maintenanceCheckinDecision.updateMany({
      where: { tenantId, vehicleId: String(vehicleId), decision: 'SNOOZE', clearedAt: null },
      data: { clearedAt: now, clearedEvent: 'CHECKIN' },
    }).catch(() => {});

    // The silent stamp — who · reservation · odometer · when. For SNOOZE the
    // same row IS the marker (clearedAt stays null).
    decisionRow = await db.maintenanceCheckinDecision.create({
      data: {
        tenantId,
        vehicleId: String(vehicleId),
        reservationId: reservationId || null,
        rentalAgreementId: rentalAgreementId || null,
        reservationNumber: reservationNumber || null,
        decision,
        odometer: odometer != null && Number.isFinite(Number(odometer)) ? Math.round(Number(odometer)) : null,
        note: String(note || '').trim() || null,
        serviceTypesJson: JSON.stringify(types),
        byUserId: actorUserId || null,
        byName,
        // SEND rows are execution records, not markers — mark them cleared at
        // birth so the marker query stays a plain clearedAt IS NULL.
        ...(decision === 'SEND' ? { clearedAt: now, clearedEvent: 'CHECKIN' } : {}),
      },
    });

    const effLocationId = locationId || vehicle?.homeLocationId || null;

    if (decision === 'SNOOZE') {
      await emit({
        tenantId,
        locationId: effLocationId,
        severity: 'NEEDS_ACTION',
        sourceType: 'MAINTENANCE',
        sourceRefId: decisionRow.id,
        title: `Maintenance snoozed at check-in — ${unit}`,
        body: `Snoozed by ${byName || 'staff'} — re-prompts at next rental event`,
        deepLink: '/maintenance',
        // Deduped per vehicle+event: the same check-in re-submitting is a
        // no-op; a snooze at a LATER rental event is a new envelope.
        dedupeKey: `maint-snooze:${vehicleId}:${reservationId || decisionRow.id}`,
        templateKey: 'maintSnoozed',
        paramsJson: { unit, name: byName || 'staff' },
      });
      return { status: 'SNOOZED', decisionId: decisionRow.id };
    }

    // SEND — open the RO now that the close's sync left the car AVAILABLE.
    const ro = await openScheduledRepairOrder({ decisionRow, deps });
    await db.maintenanceCheckinDecision.update({
      where: { id: decisionRow.id },
      data: { repairOrderId: ro.id, lastError: null },
    }).catch(() => {});
    await emit({
      tenantId,
      locationId: effLocationId,
      severity: 'INFO',
      sourceType: 'MAINTENANCE',
      sourceRefId: ro.id,
      title: `Sent to maintenance at check-in — ${unit} · ${ro.label}`,
      body: types.length ? types.map((t) => SERVICE_LABELS[t] || t).join(' + ') : null,
      deepLink: '/maintenance',
      dedupeKey: `maint-checkin-sent:${vehicleId}:${ro.id}`,
      templateKey: 'maintCheckinSent',
      paramsJson: { unit, ro: ro.label },
    });
    logger.info('[maintenance-checkin] send-to-maintenance executed at close', {
      tenantId, vehicleId, decisionId: decisionRow.id, repairOrderId: ro.id,
    });
    return { status: 'SENT', decisionId: decisionRow.id, repairOrderId: ro.id, roLabel: ro.label };
  } catch (err) {
    // Money first: the check-in close already succeeded — record the failure
    // and hand the wizard a retry handle, never a throw.
    const message = err?.message || String(err);
    logger.error('[maintenance-checkin] decision execution failed (check-in unaffected)', {
      tenantId, vehicleId, decisionId: decisionRow?.id || null, message,
    });
    if (decisionRow?.id) {
      await db.maintenanceCheckinDecision.update({
        where: { id: decisionRow.id },
        data: { lastError: message },
      }).catch(() => {});
    }
    return { status: 'FAILED', decisionId: decisionRow?.id || null, error: message };
  }
}

/**
 * Consume the per-vehicle snooze marker on wizard open (check-out AND
 * check-in call this — whichever comes first wins). Marker present → clear it
 * and return the stamp so the wizard can re-prompt fresh against the current
 * odometer; absent → { snoozed: false }. Same tenant + location gate as
 * listSchedules: an out-of-scope vehicle 404s instead of leaking its trail.
 */
export async function consumeSnooze(vehicleId, event, scope = {}, deps = {}) {
  const db = deps.db || prisma;
  const now = deps.now ? new Date(deps.now) : new Date();
  const clearedEvent = String(event || '').toUpperCase() === 'CHECKOUT' ? 'CHECKOUT' : 'CHECKIN';
  const tenantId = scope?.tenantId && scope.tenantId !== '__no_tenant__' ? scope.tenantId : null;
  if (scope?.tenantId === '__no_tenant__') { const e = new Error('tenantId required'); e.status = 400; throw e; }
  const allowedLoc = scopeAllowedLocationIds(scope);
  const veh = await db.vehicle.findFirst({
    where: {
      id: String(vehicleId),
      ...(tenantId ? { tenantId } : {}),
      ...(allowedLoc ? { homeLocationId: { in: allowedLoc } } : {}),
    },
    select: { id: true, tenantId: true },
  });
  if (!veh) { const e = new Error('Vehicle not found'); e.status = 404; throw e; }

  const markerWhere = {
    vehicleId: String(vehicleId),
    tenantId: tenantId || veh.tenantId,
    decision: 'SNOOZE',
    clearedAt: null,
  };
  const latest = await db.maintenanceCheckinDecision.findFirst({
    where: markerWhere,
    orderBy: { createdAt: 'desc' },
  });
  if (!latest) return { snoozed: false, stamp: null };
  await db.maintenanceCheckinDecision.updateMany({
    where: markerWhere,
    data: { clearedAt: now, clearedEvent },
  });
  return {
    snoozed: true,
    stamp: {
      decisionId: latest.id,
      byName: latest.byName || null,
      byUserId: latest.byUserId || null,
      reservationNumber: latest.reservationNumber || null,
      odometer: latest.odometer,
      note: latest.note || null,
      at: latest.createdAt,
      serviceTypes: normalizeServiceTypes(safeParseJson(latest.serviceTypesJson)),
    },
  };
}

/**
 * Retry a SEND whose RO-open failed at close ("couldn't move to maintenance —
 * open manually" → the wizard's retry link). Idempotent: a decision that
 * already has its RO answers with it instead of opening a second one.
 */
export async function retryCheckinDecision(decisionId, scope = {}, deps = {}) {
  const db = deps.db || prisma;
  const emit = deps.emit || emitNotificationSafe;
  if (scope?.tenantId === '__no_tenant__') { const e = new Error('tenantId required'); e.status = 400; throw e; }
  const tenantId = scope?.tenantId || null;
  const row = await db.maintenanceCheckinDecision.findFirst({
    where: { id: String(decisionId), ...(tenantId ? { tenantId } : {}) },
  });
  if (!row) { const e = new Error('Decision not found'); e.status = 404; throw e; }
  if (row.decision !== 'SEND') { const e = new Error('Only send-to-maintenance decisions can be retried'); e.status = 400; throw e; }
  if (row.repairOrderId) {
    return { status: 'SENT', decisionId: row.id, repairOrderId: row.repairOrderId, roLabel: null, alreadyOpen: true };
  }
  // Same location gate as the maintenance siblings — a scoped caller may only
  // act on a vehicle homed at one of their locations.
  const allowedLoc = scopeAllowedLocationIds(scope);
  if (allowedLoc) {
    const veh = await db.vehicle.findFirst({
      where: { id: row.vehicleId, homeLocationId: { in: allowedLoc } },
      select: { id: true },
    });
    if (!veh) { const e = new Error('Vehicle not found'); e.status = 404; throw e; }
  }
  try {
    const ro = await openScheduledRepairOrder({ decisionRow: row, deps });
    await db.maintenanceCheckinDecision.update({
      where: { id: row.id },
      data: { repairOrderId: ro.id, lastError: null },
    }).catch(() => {});
    const vehicle = await db.vehicle.findUnique({
      where: { id: row.vehicleId },
      select: { plate: true, internalNumber: true, homeLocationId: true },
    }).catch(() => null);
    const unit = unitLabel(vehicle);
    await emit({
      tenantId: row.tenantId,
      locationId: vehicle?.homeLocationId || null,
      severity: 'INFO',
      sourceType: 'MAINTENANCE',
      sourceRefId: ro.id,
      title: `Sent to maintenance at check-in — ${unit} · ${ro.label}`,
      body: null,
      deepLink: '/maintenance',
      dedupeKey: `maint-checkin-sent:${row.vehicleId}:${ro.id}`,
      templateKey: 'maintCheckinSent',
      paramsJson: { unit, ro: ro.label },
    });
    return { status: 'SENT', decisionId: row.id, repairOrderId: ro.id, roLabel: ro.label };
  } catch (err) {
    const message = err?.message || String(err);
    await db.maintenanceCheckinDecision.update({
      where: { id: row.id },
      data: { lastError: message },
    }).catch(() => {});
    const e = new Error(message);
    e.status = err?.status || 502;
    throw e;
  }
}

export const maintenanceCheckinService = {
  executeCheckinMaintenanceDecisionSafe,
  consumeSnooze,
  retryCheckinDecision,
};
