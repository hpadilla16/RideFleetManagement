// Post-check-in audit — Tier 1 rules (2026-09-03).
// Design: design/mockups/checkin-audit-NOTES.md (§2 Tier 1 table, the async
// pipeline) + checkin-audit-mockup.html (Mock 1 queue, Mock 2 detail cards,
// Mock 3 notification). The damage-baseline dismiss fork comes from
// design/mockups/damage-baseline-NOTES.md (§1 "the dismiss moment", §4.2).
//
// THIS IS T1 ONLY: pure arithmetic over data the check-in close already
// persists (checkin-close.service.js). Zero AI, zero external calls, every
// tenant, on by default. The photo-AI tier (T2) is explicitly out — the
// DAMAGE category exists in the row contract so T2 plugs in later, but no T1
// check ever produces it.
//
// Pipeline posture (NOTES §2, "Async pipeline — never blocks the close"):
// T1 is <1s of arithmetic, so it runs INLINE-after-close in the same worker
// family the fee engine already occupies — enqueued by checkin-close as a
// best-effort step AFTER the maintenance hook, wrapped in the same
// never-throws contract (executeCheckinMaintenanceDecisionSafe precedent).
// A failed audit can never hold, fail, or delay a check-in that already
// settled the money.
//
// Storage: CheckinAuditFinding — an observation table with loose ids and no
// FKs (MaintenanceCheckinDecision precedent). One row per (reservation,
// checkKey), upserted, so re-detection dedupes instead of duplicating. A
// clean run writes the single checkKey='PASS' row so the queue's "Passed
// clean" lane counts real audits.
//
// Notifications: entry-error findings (severity ERROR — today that is the
// impossible-odometer check, the one the NOTES' notif.entry copy names) emit
// a NEEDS_ACTION envelope into the notification center, deduped per
// reservation+check via the center's own (tenantId, dedupeKey) upsert.

import { prisma } from '../../lib/prisma.js';
import logger from '../../lib/logger.js';
import { emitNotificationSafe } from '../notifications/notifications-emit.js';
import { settingsService } from '../settings/settings.service.js';
import { canonicalPhotoKey } from '../rental-agreements/inspection-photos-normalize.js';

// ─────────────────────────────────────────────────────────────────────────────
// Contract constants
// ─────────────────────────────────────────────────────────────────────────────

export const CHECK_KEYS = Object.freeze([
  'ODO_IMPOSSIBLE',
  'MILES_OUTLIER',
  'FUEL_UP_NO_RECORD',
  'FUEL_DROP_NO_FEE',
  'ENTRIES_INCOMPLETE',
  'BACKDATED_RETURN',
  'PASS',
]);

export const FINDING_STATUSES = Object.freeze(['OPEN', 'DISMISSED_NOT_ISSUE', 'RESOLVED']);
export const FINDING_CATEGORIES = Object.freeze(['ENTRY', 'MILEAGE_FUEL', 'DAMAGE', 'PASS']);

// Defaults straight from the NOTES' T1 table (tenant-tunable via
// checkinAuditConfig): 600 mi/day band, 0.25 tank fuel deltas. The backdate
// gap has no number in the NOTES ("far from photo timestamps") — 6h is the
// shipped default, far beyond any plausible walk-to-desk lag.
export const DEFAULT_CHECKIN_AUDIT_CONFIG = Object.freeze({
  rulesEnabled: true,
  milesPerDayBand: 600,
  fuelUpDelta: 0.25,
  fuelDropDelta: 0.25,
  backdateGapHours: 6,
});

// The 8 canonical inspection angles (PhotoCapture.jsx:30-39).
export const REQUIRED_ANGLES = Object.freeze([
  'front', 'rear', 'left', 'right', 'frontSeat', 'rearSeat', 'dashboard', 'trunk',
]);

export function normalizeCheckinAuditConfig(cfg = {}) {
  const num = (v, fallback, { min = 0 } = {}) => {
    const n = Number(v);
    return Number.isFinite(n) && n > min ? n : fallback;
  };
  const d = DEFAULT_CHECKIN_AUDIT_CONFIG;
  return {
    rulesEnabled: cfg?.rulesEnabled !== false, // default ON — it's arithmetic
    milesPerDayBand: num(cfg?.milesPerDayBand, d.milesPerDayBand),
    fuelUpDelta: num(cfg?.fuelUpDelta, d.fuelUpDelta),
    fuelDropDelta: num(cfg?.fuelDropDelta, d.fuelDropDelta),
    backdateGapHours: num(cfg?.backdateGapHours, d.backdateGapHours),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// The six T1 checks — pure functions, one per row of the NOTES table.
// Each finding cites the exact fields it read in details.fields.
// ─────────────────────────────────────────────────────────────────────────────

/** odometerIn < odometerOut — impossible; one of the two entries is wrong.
 *  Catches the manual/legacy close paths the wizard's own guard never sees. */
export function checkOdometerImpossible({ odometerOut, odometerIn }) {
  if (odometerOut == null || odometerIn == null) return null;
  const out = Number(odometerOut);
  const inn = Number(odometerIn);
  if (!Number.isFinite(out) || !Number.isFinite(inn)) return null;
  if (inn >= out) return null;
  return {
    checkKey: 'ODO_IMPOSSIBLE',
    category: 'ENTRY',
    severity: 'ERROR',
    details: {
      fields: ['RentalAgreement.odometerOut', 'RentalAgreement.odometerIn'],
      odometerOut: out,
      odometerIn: inn,
    },
  };
}

/** (odometerIn − odometerOut) / rentalDays above the tenant band (default 600). */
export function checkMilesOutlier({ odometerOut, odometerIn, rentalDays }, config = DEFAULT_CHECKIN_AUDIT_CONFIG) {
  if (odometerOut == null || odometerIn == null) return null;
  const out = Number(odometerOut);
  const inn = Number(odometerIn);
  if (!Number.isFinite(out) || !Number.isFinite(inn) || inn < out) return null;
  const days = Math.max(1, Number(rentalDays) || 1);
  const milesPerDay = Math.round((inn - out) / days);
  const band = Number(config?.milesPerDayBand) || DEFAULT_CHECKIN_AUDIT_CONFIG.milesPerDayBand;
  if (milesPerDay <= band) return null;
  return {
    checkKey: 'MILES_OUTLIER',
    category: 'MILEAGE_FUEL',
    severity: 'WARN',
    details: {
      fields: ['RentalAgreement.odometerOut', 'RentalAgreement.odometerIn', 'rentalDays'],
      odometerOut: out,
      odometerIn: inn,
      rentalDays: days,
      milesPerDay,
      band,
    },
  };
}

/** fuelIn − fuelOut sharply up with no refuel on record — probable mis-entry. */
export function checkFuelUpNoRecord({ fuelOut, fuelIn, refuelRecorded = false }, config = DEFAULT_CHECKIN_AUDIT_CONFIG) {
  if (fuelOut == null || fuelIn == null) return null;
  const out = Number(fuelOut);
  const inn = Number(fuelIn);
  if (!Number.isFinite(out) || !Number.isFinite(inn)) return null;
  const delta = inn - out;
  const threshold = Number(config?.fuelUpDelta) || DEFAULT_CHECKIN_AUDIT_CONFIG.fuelUpDelta;
  if (delta <= threshold || refuelRecorded) return null;
  return {
    checkKey: 'FUEL_UP_NO_RECORD',
    category: 'MILEAGE_FUEL',
    severity: 'WARN',
    details: {
      fields: ['RentalAgreement.fuelOut', 'RentalAgreement.fuelIn'],
      fuelOut: out,
      fuelIn: inn,
      delta: Number(delta.toFixed(3)),
      threshold,
    },
  };
}

/** fuelOut − fuelIn beyond threshold but no FUEL_REFILL charge landed —
 *  a fee-engine / FeeRate configuration gap, not a customer problem. */
export function checkFuelDropNoFee({ fuelOut, fuelIn, fuelRefillCharged = false }, config = DEFAULT_CHECKIN_AUDIT_CONFIG) {
  if (fuelOut == null || fuelIn == null) return null;
  const out = Number(fuelOut);
  const inn = Number(fuelIn);
  if (!Number.isFinite(out) || !Number.isFinite(inn)) return null;
  const delta = out - inn;
  const threshold = Number(config?.fuelDropDelta) || DEFAULT_CHECKIN_AUDIT_CONFIG.fuelDropDelta;
  if (delta <= threshold || fuelRefillCharged) return null;
  return {
    checkKey: 'FUEL_DROP_NO_FEE',
    category: 'MILEAGE_FUEL',
    severity: 'WARN',
    details: {
      fields: ['RentalAgreement.fuelOut', 'RentalAgreement.fuelIn', "RentalAgreementCharge(sourceRefId='FUEL_REFILL')"],
      fuelOut: out,
      fuelIn: inn,
      delta: Number(delta.toFixed(3)),
      threshold,
    },
  };
}

/** Missing angle photos / missing signature on the check-in. */
export function checkEntriesIncomplete({ photoKeys = [], hasSignature = false }) {
  const present = new Set((photoKeys || []).map((k) => canonicalPhotoKey(k)));
  const missingAngles = REQUIRED_ANGLES.filter((a) => !present.has(a));
  if (!missingAngles.length && hasSignature) return null;
  return {
    checkKey: 'ENTRIES_INCOMPLETE',
    category: 'ENTRY',
    severity: 'WARN',
    details: {
      fields: ['RentalAgreementInspection(CHECKIN).photoStorageRefs/photosJson', 'Reservation.signatureDataUrl'],
      missingAngles,
      photoCount: present.size,
      requiredCount: REQUIRED_ANGLES.length,
      hasSignature: !!hasSignature,
    },
  };
}

/** returnedAt far from the check-in photos' upload timestamps. INFO only —
 *  a legitimate backdate (validateBackdatedReturn) looks exactly like this. */
export function checkBackdatedReturn({ returnedAt, photoTimestamps = [] }, config = DEFAULT_CHECKIN_AUDIT_CONFIG) {
  if (!returnedAt) return null;
  const ret = new Date(returnedAt).getTime();
  if (!Number.isFinite(ret)) return null;
  const stamps = (photoTimestamps || [])
    .map((t) => new Date(t).getTime())
    .filter((t) => Number.isFinite(t));
  if (!stamps.length) return null; // nothing to compare against — skip, never guess
  const nearest = stamps.reduce((best, t) => (Math.abs(t - ret) < Math.abs(best - ret) ? t : best), stamps[0]);
  const gapHours = Math.abs(nearest - ret) / (60 * 60 * 1000);
  const maxGap = Number(config?.backdateGapHours) || DEFAULT_CHECKIN_AUDIT_CONFIG.backdateGapHours;
  if (gapHours <= maxGap) return null;
  return {
    checkKey: 'BACKDATED_RETURN',
    category: 'ENTRY',
    severity: 'INFO',
    details: {
      fields: ['RentalAgreement.returnedAt', 'RentalAgreementInspection(CHECKIN).photoStorageRefs[].uploadedAt'],
      returnedAt: new Date(ret).toISOString(),
      nearestPhotoAt: new Date(nearest).toISOString(),
      gapHours: Number(gapHours.toFixed(1)),
      maxGapHours: maxGap,
    },
  };
}

/** All six checks over one close's data. Pure — the *Safe runner feeds it. */
export function runT1Checks(input = {}, config = DEFAULT_CHECKIN_AUDIT_CONFIG) {
  return [
    checkOdometerImpossible(input),
    checkMilesOutlier(input, config),
    checkFuelUpNoRecord(input, config),
    checkFuelDropNoFee(input, config),
    checkEntriesIncomplete(input),
    checkBackdatedReturn(input, config),
  ].filter(Boolean);
}

// ─────────────────────────────────────────────────────────────────────────────
// The close-time runner — never throws (checkin-close hosts it)
// ─────────────────────────────────────────────────────────────────────────────

function photoKeysFromInspection(insp) {
  const keys = [];
  const refs = insp?.photoStorageRefs;
  if (Array.isArray(refs)) {
    for (const r of refs) if (r && r.key) keys.push(String(r.key));
  }
  if (!keys.length && insp?.photosJson) {
    try {
      const parsed = typeof insp.photosJson === 'string' ? JSON.parse(insp.photosJson) : insp.photosJson;
      if (Array.isArray(parsed)) {
        for (const p of parsed) if (p && p.key) keys.push(String(p.key));
      } else if (parsed && typeof parsed === 'object') {
        for (const [k, v] of Object.entries(parsed)) if (v) keys.push(k);
      }
    } catch { /* legacy blob unreadable — counts as no photos */ }
  }
  return keys;
}

function photoTimestampsFromInspection(insp) {
  const out = [];
  const refs = insp?.photoStorageRefs;
  if (Array.isArray(refs)) {
    for (const r of refs) if (r && r.uploadedAt) out.push(r.uploadedAt);
  }
  if (!out.length && insp?.capturedAt) out.push(insp.capturedAt);
  return out;
}

/**
 * Run the T1 audit for a just-closed check-in. Called by
 * checkin-close.service.js AFTER the maintenance hook, same never-throws
 * posture: any failure logs and returns null — the close is already done.
 *
 * `close` carries what checkin-close already has in hand (agreement row,
 * typed readings, fee items) so the runner adds at most two small reads
 * (CHECKIN inspection, reservation signature).
 */
export async function runCheckinAuditForCloseSafe({
  agreementId,
  tenantId,
  reservationId,
  vehicleId = null,
  locationId = null,
  reservationNumber = null,
  vehicleLabel = null,
  odometerOut = null,
  odometerIn = null,
  fuelOut = null,
  fuelIn = null,
  rentalDays = 1,
  returnedAt = null,
  feeItems = [],
  hasSignature = null,
  closedByUserId = null,
} = {}, deps = {}) {
  const db = deps.db || prisma;
  const emit = deps.emit || emitNotificationSafe;
  try {
    if (!tenantId || !reservationId) return null;

    let config = normalizeCheckinAuditConfig(null);
    try {
      config = await (deps.getConfig
        ? deps.getConfig({ tenantId })
        : settingsService.getCheckinAuditConfig({ tenantId }));
    } catch { /* defaults */ }
    if (!config.rulesEnabled) return null;

    // The CHECKIN inspection — photo slots + upload timestamps.
    const inspection = await db.rentalAgreementInspection.findFirst({
      where: { rentalAgreementId: String(agreementId), phase: 'CHECKIN' },
      select: { photoStorageRefs: true, photosJson: true, capturedAt: true },
    }).catch(() => null);

    // Signature: caller may already know (wizard payload); otherwise read the
    // reservation row the close just stamped.
    let signed = hasSignature;
    if (signed == null) {
      const r = await db.reservation.findUnique({
        where: { id: String(reservationId) },
        select: { signatureDataUrl: true },
      }).catch(() => null);
      signed = !!r?.signatureDataUrl;
    }

    // FUEL_REFILL: from this close's own fee items, else any persisted
    // engine/manual refill charge on the agreement.
    let fuelRefillCharged = (feeItems || []).some((i) => String(i?.feeType || '') === 'FUEL_REFILL');
    if (!fuelRefillCharged) {
      const refill = await db.rentalAgreementCharge.findFirst({
        where: { rentalAgreementId: String(agreementId), sourceRefId: 'FUEL_REFILL', selected: true },
        select: { id: true },
      }).catch(() => null);
      fuelRefillCharged = !!refill;
    }

    const findings = runT1Checks({
      odometerOut,
      odometerIn,
      fuelOut,
      fuelIn,
      rentalDays,
      refuelRecorded: false, // no refuel-receipt record exists at T1 — cited in details
      fuelRefillCharged,
      photoKeys: photoKeysFromInspection(inspection),
      hasSignature: signed,
      returnedAt,
      photoTimestamps: photoTimestampsFromInspection(inspection),
    }, config);

    // Queue display label (Mock 1: "Toyota Corolla · ABC-124").
    let label = vehicleLabel;
    if (!label && vehicleId) {
      const v = await db.vehicle.findUnique({
        where: { id: String(vehicleId) },
        select: { make: true, model: true, plate: true, internalNumber: true },
      }).catch(() => null);
      if (v) {
        const name = [v.make, v.model].filter(Boolean).join(' ');
        label = [name || null, v.plate || v.internalNumber || null].filter(Boolean).join(' · ') || null;
      }
    }

    let closedByName = null;
    if (closedByUserId) {
      const u = await db.user.findUnique({
        where: { id: String(closedByUserId) },
        select: { fullName: true, email: true },
      }).catch(() => null);
      closedByName = u?.fullName || u?.email || null;
    }

    const common = {
      tenantId,
      reservationId: String(reservationId),
      rentalAgreementId: agreementId ? String(agreementId) : null,
      vehicleId: vehicleId ? String(vehicleId) : null,
      locationId: locationId || null,
      reservationNumber: reservationNumber || null,
      vehicleLabel: label || null,
      closedByUserId: closedByUserId || null,
      closedByName,
      returnedAt: returnedAt ? new Date(returnedAt) : null,
    };

    if (!findings.length) {
      // Clean pass. Only mint the PASS row when this reservation has no prior
      // findings — a re-close that comes back clean must not bury open flags.
      const prior = await db.checkinAuditFinding.findFirst({
        where: { reservationId: String(reservationId), checkKey: { not: 'PASS' } },
        select: { id: true },
      }).catch(() => null);
      if (!prior) {
        // The PASS row carries the audited numbers so the detail view can
        // render the Mock-2 audit cards ("12,404 → 12,981 · 115/day ✓") even
        // when nothing was flagged.
        const out = Number(odometerOut); const inn = Number(odometerIn);
        const days = Math.max(1, Number(rentalDays) || 1);
        const milesPerDay = Number.isFinite(out) && Number.isFinite(inn) && inn >= out
          ? Math.round((inn - out) / days) : null;
        await db.checkinAuditFinding.upsert({
          where: { reservationId_checkKey: { reservationId: String(reservationId), checkKey: 'PASS' } },
          update: {},
          create: {
            ...common,
            checkKey: 'PASS',
            category: 'PASS',
            severity: 'NONE',
            status: 'RESOLVED',
            detailsJson: JSON.stringify({
              odometerOut, odometerIn, rentalDays: days, milesPerDay,
              fuelOut, fuelIn, fuelRefillCharged,
              photoCount: photoKeysFromInspection(inspection).length,
              hasSignature: !!signed,
            }),
          },
        });
      }
      return { findings: 0, passed: true };
    }

    // Findings exist — retire any earlier PASS row for this reservation.
    await db.checkinAuditFinding.deleteMany({
      where: { reservationId: String(reservationId), checkKey: 'PASS' },
    }).catch(() => {});

    for (const f of findings) {
      // Dedupe per reservation+check: first detection wins, a re-run is a
      // no-op (same posture as the notification center's dedupeKey upsert).
      await db.checkinAuditFinding.upsert({
        where: { reservationId_checkKey: { reservationId: String(reservationId), checkKey: f.checkKey } },
        update: {},
        create: {
          ...common,
          checkKey: f.checkKey,
          category: f.category,
          severity: f.severity,
          detailsJson: JSON.stringify(f.details),
        },
      });

      // Entry errors reach the notification center as NEEDS_ACTION
      // (checkin-audit-NOTES.md notif.entry; Mock 3). Deduped per
      // reservation+check by the center's (tenantId, dedupeKey) unique.
      if (f.severity === 'ERROR') {
        await emit({
          tenantId,
          locationId: locationId || null,
          severity: 'NEEDS_ACTION',
          sourceType: 'CHECKIN_AUDIT',
          sourceRefId: String(reservationId),
          title: `Entry error — ${reservationNumber || reservationId}. Odometer entered below checkout reading (${f.details.odometerOut?.toLocaleString?.('en-US') ?? f.details.odometerOut} → ${f.details.odometerIn?.toLocaleString?.('en-US') ?? f.details.odometerIn}).`,
          body: 'One of the two numbers is wrong.',
          deepLink: `/checkin-audit?reservationId=${reservationId}`,
          dedupeKey: `checkin-audit:${reservationId}:${f.checkKey}`,
          templateKey: 'checkinAuditEntryError',
          paramsJson: {
            res: reservationNumber || reservationId,
            out: f.details.odometerOut,
            in: f.details.odometerIn,
          },
        });
      }
    }
    logger.info('[checkin-audit] T1 findings persisted', {
      tenantId, reservationId, count: findings.length,
      checks: findings.map((f) => f.checkKey),
    });
    return { findings: findings.length, passed: false };
  } catch (err) {
    // The check-in already closed — an audit failure is a log line, never a throw.
    logger.error('[checkin-audit] T1 run failed (check-in unaffected)', {
      agreementId, reservationId, message: err?.message || String(err),
    });
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Queue reads — lanes, rows, detail (Mock 1 / Mock 2)
// ─────────────────────────────────────────────────────────────────────────────

function tenantWhere(scope = {}) {
  const tenantId = scope?.tenantId;
  if (tenantId === '__no_tenant__') { const e = new Error('tenantId required'); e.status = 400; throw e; }
  return tenantId ? { tenantId } : {};
}

/**
 * Lane counts + the rows for one lane. Lanes are saved filters over the same
 * table (the tolls/notifications rail pattern):
 *   entry        OPEN, category ENTRY
 *   mileageFuel  OPEN, category MILEAGE_FUEL
 *   damage       OPEN, category DAMAGE  (T1: always 0 — Photo AI not enabled)
 *   passed       checkKey PASS
 *   dismissed    DISMISSED_NOT_ISSUE
 *   resolved     RESOLVED (non-PASS)
 *   all          everything
 */
export async function listCheckinAudits(query = {}, scope = {}) {
  const where = tenantWhere(scope);
  const lane = String(query.lane || 'entry');
  const laneWhere = {
    entry: { status: 'OPEN', category: 'ENTRY' },
    mileageFuel: { status: 'OPEN', category: 'MILEAGE_FUEL' },
    damage: { status: 'OPEN', category: 'DAMAGE' },
    passed: { checkKey: 'PASS' },
    dismissed: { status: 'DISMISSED_NOT_ISSUE' },
    resolved: { status: 'RESOLVED', checkKey: { not: 'PASS' } },
    all: {},
  }[lane] || { status: 'OPEN', category: 'ENTRY' };

  const limit = Math.min(200, Math.max(1, Number(query.limit) || 100));
  const [rows, entry, mileageFuel, damage, passed, dismissed, resolved, all] = await Promise.all([
    prisma.checkinAuditFinding.findMany({
      where: { ...where, ...laneWhere },
      orderBy: { createdAt: 'desc' },
      take: limit,
    }),
    prisma.checkinAuditFinding.count({ where: { ...where, status: 'OPEN', category: 'ENTRY' } }),
    prisma.checkinAuditFinding.count({ where: { ...where, status: 'OPEN', category: 'MILEAGE_FUEL' } }),
    prisma.checkinAuditFinding.count({ where: { ...where, status: 'OPEN', category: 'DAMAGE' } }),
    prisma.checkinAuditFinding.count({ where: { ...where, checkKey: 'PASS' } }),
    prisma.checkinAuditFinding.count({ where: { ...where, status: 'DISMISSED_NOT_ISSUE' } }),
    prisma.checkinAuditFinding.count({ where: { ...where, status: 'RESOLVED', checkKey: { not: 'PASS' } } }),
    prisma.checkinAuditFinding.count({ where }),
  ]);

  // KPI strip (Mock 1, WITHOUT the AI-spend tile): today's audited
  // reservations, today's clean passes, open damage (always 0 in T1), open
  // entry errors. "Today" = server day; the strip is a pulse, not a report.
  const dayStart = new Date(); dayStart.setHours(0, 0, 0, 0);
  const [todayRows, passToday] = await Promise.all([
    prisma.checkinAuditFinding.findMany({
      where: { ...where, createdAt: { gte: dayStart } },
      select: { reservationId: true },
      distinct: ['reservationId'],
    }),
    prisma.checkinAuditFinding.count({ where: { ...where, checkKey: 'PASS', createdAt: { gte: dayStart } } }),
  ]);

  return {
    lane,
    rows: rows.map(projectFinding),
    counts: { entry, mileageFuel, damage, passed, dismissed, resolved, all },
    kpis: {
      auditedToday: todayRows.length,
      cleanPassToday: passToday,
      openDamage: damage,
      openEntryErrors: entry,
    },
    // Honesty flag for the empty Possible-damage lane (T2 not shipped).
    photoAiEnabled: false,
  };
}

function projectFinding(row) {
  let details = null;
  try { details = row.detailsJson ? JSON.parse(row.detailsJson) : null; } catch { details = null; }
  return {
    id: row.id,
    reservationId: row.reservationId,
    rentalAgreementId: row.rentalAgreementId,
    vehicleId: row.vehicleId,
    reservationNumber: row.reservationNumber,
    vehicleLabel: row.vehicleLabel,
    checkKey: row.checkKey,
    category: row.category,
    severity: row.severity,
    tier: row.tier,
    status: row.status,
    details,
    resolution: row.resolution,
    linkedDamageReportId: row.linkedDamageReportId,
    dismissedByName: row.dismissedByName,
    dismissedAt: row.dismissedAt,
    closedByName: row.closedByName,
    returnedAt: row.returnedAt,
    createdAt: row.createdAt,
  };
}

/** Every finding (any status) for one reservation — the detail view. */
export async function getCheckinAuditDetail(reservationId, scope = {}) {
  const where = tenantWhere(scope);
  const rows = await prisma.checkinAuditFinding.findMany({
    where: { ...where, reservationId: String(reservationId) },
    orderBy: { createdAt: 'asc' },
  });
  if (!rows.length) { const e = new Error('No audit recorded for this reservation'); e.status = 404; throw e; }
  return {
    reservationId: String(reservationId),
    reservationNumber: rows[0].reservationNumber,
    vehicleLabel: rows[0].vehicleLabel,
    returnedAt: rows[0].returnedAt,
    closedByName: rows[0].closedByName,
    findings: rows.map(projectFinding),
    photoAiEnabled: false,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// The dismiss fork (damage-baseline Mock 2) — two verbs, two destinations
// ─────────────────────────────────────────────────────────────────────────────

export const DISMISS_CLASSIFICATIONS = Object.freeze(['NOT_ISSUE', 'PREEXISTING']);

/**
 * Dismiss one finding.
 *  - NOT_ISSUE: "the check misread the data" — status DISMISSED_NOT_ISSUE,
 *    reviewer stamped. Works for any finding category.
 *  - PREEXISTING: "real damage, but old" — DAMAGE-category findings only.
 *    Creates a HARD_APPROVED VehicleDamageReport through the existing
 *    manual-damage create path (photo REQUIRED, validation unchanged) with
 *    source AUDIT_PREEXISTING + sourceAuditFindingId, then resolves the
 *    finding as PREEXISTING_BASELINED. T1 produces no DAMAGE findings, so in
 *    the shipped UI this verb waits for T2 — the API is generic so T2 plugs
 *    in without another migration (exercised by the test suite).
 */
export async function dismissFinding(findingId, body = {}, scope = {}, deps = {}) {
  const db = deps.db || prisma;
  const where = tenantWhere(scope);
  const classification = String(body?.classification || '').toUpperCase();
  if (!DISMISS_CLASSIFICATIONS.includes(classification)) {
    const e = new Error(`classification must be one of ${DISMISS_CLASSIFICATIONS.join(' | ')}`);
    e.status = 400; throw e;
  }
  const finding = await db.checkinAuditFinding.findFirst({
    where: { ...where, id: String(findingId) },
  });
  if (!finding) { const e = new Error('Finding not found'); e.status = 404; throw e; }
  if (finding.checkKey === 'PASS') { const e = new Error('A clean pass cannot be dismissed'); e.status = 400; throw e; }
  if (finding.status !== 'OPEN') {
    const e = new Error(`Only open findings can be dismissed (is ${finding.status})`); e.status = 409; throw e;
  }

  const now = deps.now ? new Date(deps.now) : new Date();
  const actorUserId = scope?.userId || null;
  let actorName = null;
  if (actorUserId) {
    const u = await db.user.findUnique({
      where: { id: String(actorUserId) },
      select: { fullName: true, email: true },
    }).catch(() => null);
    actorName = u?.fullName || u?.email || null;
  }

  if (classification === 'NOT_ISSUE') {
    await db.checkinAuditFinding.update({
      where: { id: finding.id },
      data: {
        status: 'DISMISSED_NOT_ISSUE',
        dismissedAt: now,
        dismissedByUserId: actorUserId,
        dismissedByName: actorName,
      },
    });
    return { ok: true, status: 'DISMISSED_NOT_ISSUE' };
  }

  // PREEXISTING — the baseline append. Gated to DAMAGE findings: "real but
  // pre-existing" only means something for a mark seen in a photo.
  if (finding.category !== 'DAMAGE') {
    const e = new Error('Only damage findings can be dismissed as pre-existing');
    e.status = 400; throw e;
  }
  if (!finding.vehicleId) { const e = new Error('Finding has no vehicle'); e.status = 400; throw e; }

  // The existing manual-damage create owns validation (view, 0..100 dot,
  // photo REQUIRED) and the HARD_APPROVED + reviewer stamp. The internal
  // opts ride outside body so a route caller can never spoof provenance.
  const { customerInspectionService } = deps.customerInspection
    ? { customerInspectionService: deps.customerInspection }
    : await import('../customer-inspection/customer-inspection.service.js');
  const created = await customerInspectionService.addManualDamage(
    finding.vehicleId,
    {
      view: body.view,
      xPct: body.xPct,
      yPct: body.yPct,
      description: body.description || null,
      photoDataUrl: body.photoDataUrl,
      reservationId: finding.reservationId,
      reservationNumber: finding.reservationNumber || null,
    },
    { tenantId: finding.tenantId, userId: actorUserId },
    { source: 'AUDIT_PREEXISTING', sourceAuditFindingId: finding.id },
  );

  await db.checkinAuditFinding.update({
    where: { id: finding.id },
    data: {
      status: 'RESOLVED',
      resolution: 'PREEXISTING_BASELINED',
      linkedDamageReportId: created.id,
      dismissedAt: now,
      dismissedByUserId: actorUserId,
      dismissedByName: actorName,
    },
  });
  return { ok: true, status: 'RESOLVED', resolution: 'PREEXISTING_BASELINED', damageReportId: created.id };
}

export const checkinAuditService = {
  runCheckinAuditForCloseSafe,
  listCheckinAudits,
  getCheckinAuditDetail,
  dismissFinding,
};
