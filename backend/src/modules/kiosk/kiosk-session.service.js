/**
 * Ride Kiosk — session service (Fase B1, 2026-07-05).
 * Spec: doc/kiosk-e2e-spec-2026-07-04.md.
 *
 * A KioskSession is one customer interaction on a paired tablet. Its `step`
 * and eventsJson are funnel TELEMETRY only — every business transition goes
 * through checkoutSessionService, and resume derives truth from the
 * checkout-session, never from `step` (no dual-state-machine drift).
 *
 * Flow order (Innovation-corrected): attach reservation → atomic vehicle
 * auto-pick → create checkout-session → upsell (B2) → payment (B5) → sign.
 * The car is secured BEFORE any money changes hands.
 *
 * Every session read here is scoped by (id, deviceId, tenantId) — a stolen
 * device token can never reach another kiosk's sessions (404 on mismatch).
 */

import { prisma } from '../../lib/prisma.js';
import logger from '../../lib/logger.js';
import { KioskError } from './kiosk-device.service.js';
import { checkoutSessionService, CheckoutSessionError } from '../checkout-session/checkout-session.service.js';
import { ensureNoVehicleConflict } from '../reservations/reservations.service.js';
import { activeVehicleBlockOverlapWhere } from '../vehicles/vehicle-blocks.js';

export const MAX_SESSION_EVENTS = 500;
export const MAX_LOOKUP_MISSES = 5;
export const LOOKUP_LOCKOUT_MIN = 15;
// A kiosk only surfaces reservations picking up "around now": from 12h back
// (late arrivals) to 36h ahead (tomorrow's early birds). Server-side gate —
// the lookup can never fish the whole book.
export const LOOKUP_WINDOW_BACK_HOURS = 12;
export const LOOKUP_WINDOW_FORWARD_HOURS = 36;

const SESSION_KINDS = ['PICKUP', 'WALKUP'];
const LOOKUP_STATUSES = ['NEW', 'CONFIRMED'];
const MAX_EVENT_DATA_JSON_CHARS = 2000;

function pickupWindowBounds(now = new Date()) {
  return {
    from: new Date(now.getTime() - LOOKUP_WINDOW_BACK_HOURS * 60 * 60 * 1000),
    to: new Date(now.getTime() + LOOKUP_WINDOW_FORWARD_HOURS * 60 * 60 * 1000),
  };
}

/** "Maria Gonzalez" → "Maria G." — the only name form a lobby screen ever sees. */
export function maskCustomerName(firstName, lastName) {
  const first = String(firstName || '').trim();
  const lastInitial = String(lastName || '').trim().charAt(0);
  const masked = [first, lastInitial ? `${lastInitial.toUpperCase()}.` : ''].filter(Boolean).join(' ');
  return masked || 'Guest';
}

function digitsOnly(value) {
  return String(value || '').replace(/\D+/g, '');
}

function phonesMatch(inputPhone, storedPhone) {
  const input = digitsOnly(inputPhone);
  const stored = digitsOnly(storedPhone);
  if (input.length < 7 || stored.length < 7) return false;
  return input.slice(-10) === stored.slice(-10);
}

/**
 * The MASKED reservation stub — the ONLY reservation shape kiosk endpoints
 * return. Never full name, phone, email, DOB, license or address.
 */
export function reservationStub(resv) {
  return {
    reservationId: resv.id,
    maskedName: maskCustomerName(resv.customer?.firstName, resv.customer?.lastName),
    pickupWindow: { pickupAt: resv.pickupAt, returnAt: resv.returnAt },
    vehicleClassName: resv.vehicleType?.name || null,
    channel: resv.bookingChannel || null,
  };
}

function sessionView(session) {
  return {
    id: session.id,
    kind: session.kind,
    step: session.step,
    outcome: session.outcome,
    reservationId: session.reservationId,
    checkoutSessionId: session.checkoutSessionId,
    startedAt: session.startedAt,
    lastActivityAt: session.lastActivityAt,
  };
}

function parseEvents(session) {
  return Array.isArray(session?.eventsJson) ? session.eventsJson : [];
}

/**
 * Device-binding gate: (id, deviceId, tenantId) must all match → else 404.
 * Exported so sibling kiosk services (offers, B2) share the exact same check.
 */
export async function getSessionForDevice(sessionId, device) {
  if (!sessionId) throw new KioskError('Session not found', 404, 'SESSION_NOT_FOUND');
  const session = await prisma.kioskSession.findFirst({
    where: { id: sessionId, deviceId: device.id, tenantId: device.tenantId },
  });
  if (!session) throw new KioskError('Session not found', 404, 'SESSION_NOT_FOUND');
  return session;
}

export function requireInProgress(session) {
  if (session.outcome !== 'IN_PROGRESS') {
    throw new KioskError(`Session is ${session.outcome.toLowerCase()}`, 409, 'SESSION_NOT_IN_PROGRESS');
  }
}

/**
 * Shared server-side telemetry appender (fire-and-forget, respects the event
 * cap — at cap it still bumps lastActivityAt/step without appending).
 */
export async function recordSessionTelemetry(session, { step = null, event, data = null } = {}) {
  const events = parseEvents(session);
  const atCap = events.length >= MAX_SESSION_EVENTS;
  const next = atCap ? events : [...events, {
    at: new Date().toISOString(),
    step: step ? String(step).slice(0, 40) : null,
    event: String(event || '').slice(0, 80),
    data,
  }];
  await prisma.kioskSession.update({
    where: { id: session.id },
    data: {
      eventsJson: next,
      lastActivityAt: new Date(),
      ...(step ? { step: String(step).slice(0, 40) } : {}),
    },
  }).catch(() => {});
}

async function createSession({ kind } = {}, device) {
  const cleanKind = String(kind || '').toUpperCase();
  if (!SESSION_KINDS.includes(cleanKind)) {
    throw new KioskError(`kind must be one of ${SESSION_KINDS.join(', ')}`, 400);
  }
  if (cleanKind === 'WALKUP' && !device.walkupEnabled) {
    throw new KioskError('Walk-up rentals are disabled on this kiosk', 403, 'WALKUP_DISABLED');
  }
  const session = await prisma.kioskSession.create({
    data: {
      tenantId: device.tenantId,
      deviceId: device.id,
      kind: cleanKind,
      eventsJson: [],
    },
  });
  logger.info('[kiosk] session started', { sessionId: session.id, deviceId: device.id, tenantId: device.tenantId, kind: cleanKind });
  return sessionView(session);
}

function normalizeIncomingEvents(rawEvents) {
  const list = Array.isArray(rawEvents) ? rawEvents : [rawEvents];
  const now = new Date().toISOString();
  const out = [];
  for (const raw of list) {
    if (!raw || typeof raw !== 'object' || !raw.event) continue;
    let data = raw.data === undefined ? null : raw.data;
    if (data !== null) {
      try {
        if (JSON.stringify(data).length > MAX_EVENT_DATA_JSON_CHARS) data = { truncated: true };
      } catch {
        data = null;
      }
    }
    out.push({
      at: now,
      step: raw.step ? String(raw.step).slice(0, 40) : null,
      event: String(raw.event).slice(0, 80),
      data,
    });
  }
  return out;
}

/**
 * Telemetry ingest (batch ok). Caps the stored array at MAX_SESSION_EVENTS
 * (overflow is dropped, not rotated — the funnel head is what B6 analyzes),
 * mirrors the latest step onto KioskSession.step, bumps lastActivityAt.
 */
async function appendEvents(sessionId, device, rawEvents) {
  const session = await getSessionForDevice(sessionId, device);
  const incoming = normalizeIncomingEvents(rawEvents);
  if (!incoming.length) throw new KioskError('events[] with an event name is required', 400);

  const existing = parseEvents(session);
  const room = Math.max(0, MAX_SESSION_EVENTS - existing.length);
  const accepted = incoming.slice(0, room);
  const dropped = incoming.length - accepted.length;
  if (dropped > 0) {
    logger.warn('[kiosk] session event cap reached', { sessionId: session.id, deviceId: device.id, dropped });
  }

  const lastStep = [...accepted].reverse().find((e) => e.step)?.step || null;
  const updated = await prisma.kioskSession.update({
    where: { id: session.id },
    data: {
      eventsJson: [...existing, ...accepted],
      lastActivityAt: new Date(),
      ...(lastStep ? { step: lastStep } : {}),
    },
  });
  return { ok: true, eventCount: parseEvents(updated).length, dropped };
}

function lookupWhere(device, now) {
  const { from, to } = pickupWindowBounds(now);
  return {
    tenantId: device.tenantId,
    pickupLocationId: device.locationId,
    status: { in: LOOKUP_STATUSES },
    workflowMode: 'RENTAL',
    pickupAt: { gte: from, lte: to },
  };
}

const LOOKUP_SELECT = {
  id: true,
  pickupAt: true,
  returnAt: true,
  bookingChannel: true,
  vehicleId: true,
  vehicleType: { select: { name: true } },
  customer: { select: { firstName: true, lastName: true, phone: true } },
};

/** Telemetry only — the ENFORCED miss counter lives on KioskDevice. */
async function recordLookupMissEvent(session) {
  await recordSessionTelemetry(session, { step: 'LOOKUP', event: 'LOOKUP_MISS' });
}

/**
 * On a miss: atomic per-DEVICE increment (a per-session counter would reset
 * on every idle-wipe → unlimited enumeration). MAX_LOOKUP_MISSES misses →
 * device locked for LOOKUP_LOCKOUT_MIN and the counter rearms. Returns
 * attemptsRemaining for the kiosk UI.
 *
 * Exported (B3c): the staff-assist PIN unlock SHARES this counter/lock —
 * lookup misses and PIN misses are both brute-force signals from the same
 * physical tablet, and the admin pairing-code reissue clears both at once.
 */
export async function registerDeviceLookupMiss(device) {
  const bumped = await prisma.kioskDevice.update({
    where: { id: device.id },
    data: { lookupMisses: { increment: 1 } },
  });
  if ((bumped?.lookupMisses || 0) >= MAX_LOOKUP_MISSES) {
    await prisma.kioskDevice.update({
      where: { id: device.id },
      data: { lookupMisses: 0, lookupLockedUntil: new Date(Date.now() + LOOKUP_LOCKOUT_MIN * 60 * 1000) },
    });
    logger.warn('[kiosk] device lookup locked', {
      deviceId: device.id, tenantId: device.tenantId, lockoutMinutes: LOOKUP_LOCKOUT_MIN,
    });
    return 0;
  }
  return Math.max(0, MAX_LOOKUP_MISSES - bumped.lookupMisses);
}

/**
 * Find the customer's reservation. Match is fully server-side and scoped to
 * this device's tenant + location + the pickup window; the response is the
 * masked stub ONLY. Miss lockout is per DEVICE (KioskDevice.lookupMisses /
 * lookupLockedUntil) and checked BEFORE any reservation query; a hit — or an
 * admin pairing-code reissue — resets it.
 */
async function lookupReservation(sessionId, device, { confirmationNumber, lastName, phone } = {}) {
  const session = await getSessionForDevice(sessionId, device);
  requireInProgress(session);

  const now = new Date();
  const deviceRow = await prisma.kioskDevice.findFirst({
    where: { id: device.id, tenantId: device.tenantId },
    select: { lookupMisses: true, lookupLockedUntil: true },
  });
  if (deviceRow?.lookupLockedUntil && new Date(deviceRow.lookupLockedUntil) > now) {
    throw new KioskError('Too many lookup attempts — please see a staff member', 429, 'LOOKUP_LOCKED');
  }

  const confirmation = String(confirmationNumber || '').trim();
  const cleanLastName = String(lastName || '').trim();
  let match = null;

  if (confirmation) {
    match = await prisma.reservation.findFirst({
      where: { ...lookupWhere(device, now), reservationNumber: { equals: confirmation, mode: 'insensitive' } },
      select: LOOKUP_SELECT,
    });
  } else if (cleanLastName && phone) {
    const candidates = await prisma.reservation.findMany({
      where: {
        ...lookupWhere(device, now),
        customer: { is: { lastName: { equals: cleanLastName, mode: 'insensitive' } } },
      },
      select: LOOKUP_SELECT,
      orderBy: { pickupAt: 'asc' },
      take: 25,
    });
    match = candidates.find((r) => phonesMatch(phone, r.customer?.phone)) || null;
  } else {
    throw new KioskError('confirmationNumber or lastName+phone is required', 400);
  }

  if (!match) {
    await recordLookupMissEvent(session); // telemetry
    const attemptsRemaining = await registerDeviceLookupMiss(device); // enforcement
    throw new KioskError('No matching reservation found', 404, 'RESERVATION_NOT_FOUND', { attemptsRemaining });
  }

  // Hit → rearm the device counter (and clear any expired lock).
  if (deviceRow && (deviceRow.lookupMisses > 0 || deviceRow.lookupLockedUntil)) {
    await prisma.kioskDevice.update({
      where: { id: device.id },
      data: { lookupMisses: 0, lookupLockedUntil: null },
    }).catch(() => {});
  }

  return reservationStub(match);
}

/**
 * Bind the found reservation to this session. Re-validates tenant, location,
 * status and pickup window server-side (the client's reservationId is not
 * trusted). Returns the masked summary + bookingChannel for the upsell step.
 */
async function attachReservation(sessionId, device, { reservationId } = {}) {
  const session = await getSessionForDevice(sessionId, device);
  requireInProgress(session);
  if (!reservationId) throw new KioskError('reservationId is required', 400);
  if (session.reservationId && session.reservationId !== reservationId) {
    throw new KioskError('Session already has a different reservation attached', 409, 'RESERVATION_ALREADY_ATTACHED');
  }

  const now = new Date();
  const resv = await prisma.reservation.findFirst({
    where: { ...lookupWhere(device, now), id: reservationId },
    select: LOOKUP_SELECT,
  });
  if (!resv) {
    throw new KioskError('Reservation not found or not eligible for kiosk pickup here', 404, 'RESERVATION_NOT_FOUND');
  }

  const updated = await prisma.kioskSession.update({
    where: { id: session.id },
    data: {
      reservationId: resv.id,
      lastActivityAt: new Date(),
      // M2 (B3a review): the ID-verify stamp belongs to ONE reservation —
      // binding a different one invalidates any prior verification.
      ...(session.reservationId !== resv.id ? { idVerifiedAt: null } : {}),
    },
  });
  logger.info('[kiosk] reservation attached', {
    sessionId: session.id, deviceId: device.id, tenantId: device.tenantId, reservationId: resv.id,
  });

  return {
    ...reservationStub(resv),
    bookingChannel: resv.bookingChannel || null,
    vehicleAssigned: !!resv.vehicleId,
    session: sessionView(updated),
  };
}

async function candidateVehicles(device, resv) {
  const candidates = await prisma.vehicle.findMany({
    where: {
      tenantId: device.tenantId,
      status: 'AVAILABLE',
      vehicleTypeId: resv.vehicleTypeId,
      homeLocationId: device.locationId,
    },
    select: { id: true, make: true, model: true, year: true, color: true, plate: true, internalNumber: true },
    orderBy: { mileage: 'asc' },
  });
  if (!candidates.length) return [];

  const start = new Date(resv.pickupAt);
  const end = new Date(resv.returnAt);
  const ids = candidates.map((c) => c.id);

  // Pre-filter (mirrors reservations.service pickAvailableVehicle): drop
  // date-overlapping reservations + active availability blocks up front so
  // the transactional claim below rarely has to fall through.
  const [conflicts, blocks] = await Promise.all([
    prisma.reservation.findMany({
      where: {
        tenantId: device.tenantId,
        vehicleId: { in: ids },
        id: { not: resv.id },
        status: { in: ['NEW', 'CONFIRMED', 'CHECKED_OUT'] },
        pickupAt: { lt: end },
        returnAt: { gt: start },
      },
      select: { vehicleId: true },
    }),
    prisma.vehicleAvailabilityBlock.findMany({
      where: {
        tenantId: device.tenantId,
        vehicleId: { in: ids },
        ...activeVehicleBlockOverlapWhere({ start, end }),
      },
      select: { vehicleId: true },
    }),
  ]);
  const blocked = new Set([...conflicts, ...blocks].map((row) => row.vehicleId).filter(Boolean));
  return candidates.filter((c) => !blocked.has(c.id));
}

function vehicleView(vehicle) {
  return {
    id: vehicle.id,
    make: vehicle.make,
    model: vehicle.model,
    year: vehicle.year,
    color: vehicle.color,
    plate: vehicle.plate,
    internalNumber: vehicle.internalNumber,
  };
}

/**
 * Server-side atomic vehicle auto-pick (the customer never chooses a unit).
 * Per candidate: transaction { conditional updateMany on vehicleId IS NULL +
 * ensureNoVehicleConflict re-check } — losing the race (2 kiosks + counter
 * selling the last car) rolls back and falls to the next candidate. Then the
 * checkout-session is created (createForReservation's NO_VEHICLE_ASSIGNED
 * 422 guard can no longer fire). Runs BEFORE upsell/payment by design.
 */
async function assignVehicle(sessionId, device) {
  const session = await getSessionForDevice(sessionId, device);
  requireInProgress(session);
  if (!session.reservationId) throw new KioskError('Attach a reservation first', 422, 'NO_RESERVATION_ATTACHED');

  const loadReservation = () => prisma.reservation.findFirst({
    where: { id: session.reservationId, tenantId: device.tenantId },
    select: { id: true, status: true, vehicleId: true, vehicleTypeId: true, pickupAt: true, returnAt: true },
  });

  let resv = await loadReservation();
  if (!resv) throw new KioskError('Reservation not found', 404, 'RESERVATION_NOT_FOUND');
  if (!LOOKUP_STATUSES.includes(String(resv.status))) {
    throw new KioskError(`Reservation is ${String(resv.status).toLowerCase()} — see a staff member`, 409, 'RESERVATION_NOT_OPEN');
  }

  let assignedVehicleId = resv.vehicleId || null;

  if (!assignedVehicleId) {
    if (!resv.vehicleTypeId) throw new KioskError('Reservation has no vehicle class — see a staff member', 422, 'NO_VEHICLE_CLASS');

    const candidates = await candidateVehicles(device, resv);
    for (const candidate of candidates) {
      try {
        await prisma.$transaction(async (tx) => {
          const claimed = await tx.reservation.updateMany({
            where: { id: resv.id, tenantId: device.tenantId, vehicleId: null, status: { in: LOOKUP_STATUSES } },
            data: { vehicleId: candidate.id },
          });
          if (claimed.count !== 1) {
            throw new KioskError('Reservation already claimed', 409, 'RESERVATION_ALREADY_CLAIMED');
          }
          // Same re-check the counter wizard runs — inside the tx so a lost
          // race rolls the conditional write back.
          await ensureNoVehicleConflict({
            vehicleId: candidate.id,
            pickupAt: resv.pickupAt,
            returnAt: resv.returnAt,
            ignoreReservationId: resv.id,
          }, { tenantId: device.tenantId }, tx);
        });
        assignedVehicleId = candidate.id;
        break;
      } catch (err) {
        if (err instanceof KioskError && err.code === 'RESERVATION_ALREADY_CLAIMED') {
          // Counter / another kiosk assigned meanwhile — use whatever they picked.
          resv = await loadReservation();
          assignedVehicleId = resv?.vehicleId || null;
          break;
        }
        // Vehicle conflict on this candidate — fall through to the next one.
        logger.warn('[kiosk] assign candidate lost race', {
          sessionId: session.id, reservationId: resv.id, vehicleId: candidate.id, message: err?.message,
        });
      }
    }

    if (!assignedVehicleId) {
      throw new KioskError('No vehicles available for this class right now — see a staff member', 409, 'NO_VEHICLE_AVAILABLE');
    }
  }

  // Vehicle secured — now (and only now) open the checkout-session.
  // T&C decision (spec #6, resolved here in B1): the kiosk renders the normal
  // per-section initials flow (terms-signing service) at the sign step — we
  // deliberately do NOT pre-stamp tcCompletedAt (only the loaner path is
  // sanctioned to pre-stamp, and only paymentCompletedAt). The kiosk session
  // walks the standard state machine end to end.
  let checkoutSession;
  try {
    checkoutSession = await checkoutSessionService.createForReservation({
      reservationId: resv.id,
      tenantId: device.tenantId,
      actorUserId: null,
    });
  } catch (err) {
    if (err instanceof CheckoutSessionError) throw new KioskError(err.message, err.status, err.code);
    // Adopt/converge race: both racers can pass createForReservation's
    // existence check at once; the loser hits the unique(reservationId)
    // constraint (P2002). Re-fetch the winner's session instead of 500ing.
    if (err?.code === 'P2002') {
      checkoutSession = await prisma.checkoutSession.findUnique({ where: { reservationId: resv.id } });
      if (!checkoutSession) throw err;
    } else {
      throw err;
    }
  }

  const updated = await prisma.kioskSession.update({
    where: { id: session.id },
    data: { checkoutSessionId: checkoutSession.id, lastActivityAt: new Date() },
  });

  const vehicle = await prisma.vehicle.findFirst({
    where: { id: assignedVehicleId, tenantId: device.tenantId },
    select: { id: true, make: true, model: true, year: true, color: true, plate: true, internalNumber: true },
  });

  logger.info('[kiosk] vehicle assigned', {
    sessionId: session.id, deviceId: device.id, tenantId: device.tenantId,
    reservationId: resv.id, vehicleId: assignedVehicleId, checkoutSessionId: checkoutSession.id,
  });

  return {
    vehicle: vehicle ? vehicleView(vehicle) : { id: assignedVehicleId },
    checkoutSessionId: checkoutSession.id,
    session: sessionView(updated),
  };
}

// Escalation reasons are a closed ENUM (B3 acceptance rider) — no free text
// from a lobby tablet ever lands in staff-facing surfaces.
export const ESCALATE_REASONS = Object.freeze([
  'ID_SCAN_FAILED',
  'ID_MISMATCH',
  'PAYMENT_TROUBLE',
  'CUSTOMER_REQUEST',
  'LOOKUP_FAILED',
  'OTHER',
]);

/**
 * Customer is stuck → outcome ESCALATED. v1 staff surfaces: the admin
 * sessions list (GET /api/kiosk/sessions?outcome=ESCALATED) + the dashboard
 * overview KPI `kioskEscalations` (reports.service.js overview) — the
 * banner itself is Fase B3b.
 */
async function escalate(sessionId, device, { reason } = {}) {
  const session = await getSessionForDevice(sessionId, device);
  requireInProgress(session);

  const cleanReason = String(reason || '').trim().toUpperCase();
  if (!ESCALATE_REASONS.includes(cleanReason)) {
    throw new KioskError(`reason must be one of ${ESCALATE_REASONS.join(', ')}`, 422, 'INVALID_ESCALATE_REASON');
  }

  const updated = await prisma.kioskSession.update({
    where: { id: session.id },
    data: {
      outcome: 'ESCALATED',
      escalatedReason: cleanReason,
      endedAt: new Date(),
      lastActivityAt: new Date(),
    },
  });
  logger.warn('[kiosk] session escalated', {
    sessionId: session.id, deviceId: device.id, tenantId: device.tenantId,
    locationId: device.locationId, reason: updated.escalatedReason,
  });
  return { ok: true, session: sessionView(updated) };
}

/** Admin list (+ per-outcome counts) for /kiosks and the B6 funnel work. */
async function listSessions(scope = {}, { outcome, deviceId, locationId, take } = {}) {
  if (!scope?.tenantId) throw new KioskError('A tenant scope is required (super-admins pass ?tenantId=)', 400, 'TENANT_SCOPE_REQUIRED');
  const where = {
    tenantId: scope.tenantId,
    ...(outcome ? { outcome: String(outcome).toUpperCase() } : {}),
    ...(deviceId ? { deviceId } : {}),
    ...(locationId ? { device: { is: { locationId } } } : {}),
  };
  const [sessions, grouped] = await Promise.all([
    prisma.kioskSession.findMany({
      where,
      orderBy: { startedAt: 'desc' },
      take: Math.min(Number(take) || 100, 500),
      select: {
        id: true, deviceId: true, kind: true, step: true, outcome: true,
        escalatedReason: true, reservationId: true, checkoutSessionId: true,
        startedAt: true, endedAt: true, lastActivityAt: true,
        device: { select: { name: true, locationId: true } },
      },
    }),
    prisma.kioskSession.groupBy({
      by: ['outcome'],
      where: { tenantId: scope.tenantId, ...(deviceId ? { deviceId } : {}) },
      _count: { _all: true },
    }),
  ]);
  const counts = Object.fromEntries(grouped.map((g) => [g.outcome, g._count._all]));
  return { sessions, counts };
}

export const kioskSessionService = {
  createSession,
  appendEvents,
  lookupReservation,
  attachReservation,
  assignVehicle,
  escalate,
  listSessions,
};
