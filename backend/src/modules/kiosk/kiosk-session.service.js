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
import { emitNotificationSafe } from '../notifications/notifications-emit.js';
import { KioskError } from './kiosk-device.service.js';
import { checkoutSessionService, CheckoutSessionError } from '../checkout-session/checkout-session.service.js';
import { ensureNoVehicleConflict } from '../reservations/reservations.service.js';
import { activeVehicleBlockOverlapWhere } from '../vehicles/vehicle-blocks.js';
import { kioskSmartMatch, isKioskSmartMatchEnabled } from './kiosk-smart-match.js';
import { isoDayInTz, DEFAULT_TENANT_TIMEZONE } from '../../lib/date-utils.js';
import { parseLocationConfig } from '../../lib/location-config.js';
import { scopedSettingKey } from '../../lib/module-access.js';

// How long a conversation binding stays usable. F1 only READ through it, so an
// unreleased binding was untidy; F3 WRITES through it, so the same stale row is
// a standing permit over a guest who has walked away. The client releases it on
// the ✕, on reset and on unmount — all best-effort, all lost if the tablet is
// offline. This is the backstop that does not depend on the tablet being alive.
// 2h: longer than any real assisted check-in, far shorter than forever.
export const VOZIA_BINDING_TTL_MIN = 120;

// Mirrors ASSIST_GRANT_TTL_MIN in kiosk-staff-assist.service.js. Duplicated
// rather than imported because that module imports THIS one, and a cycle here
// would break at boot. A test pins the two to the same value.
export const ASSIST_GRANT_TTL_MIN = 10;

// Outcomes a conversation may still be bound to. ESCALATED belongs here: it is
// the guest saying "I am stuck", which is when an agent is most needed.
export const BINDABLE_OUTCOMES = ['IN_PROGRESS', 'ESCALATED'];

/**
 * Is `conversationId` currently entitled to act on this session?
 *
 * Fail-closed on every axis: no binding, a different conversation, no stamp
 * (rows from before the TTL migration), or an expired stamp all return false.
 * Callers turn a false into the SAME 404 an unknown session gets, so a probe
 * cannot tell "expired" from "never existed".
 */
export function voziaBindingIsLive(session, conversationId, now = Date.now()) {
  if (!session?.voziaConversationId || !conversationId) return false;
  if (session.voziaConversationId !== conversationId) return false;
  if (!session.voziaBoundAt) return false;
  const age = now - new Date(session.voziaBoundAt).getTime();
  return age >= 0 && age <= VOZIA_BINDING_TTL_MIN * 60 * 1000;
}

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
 * The kiosk's Today/Tomorrow buttons compute pickupDate from the device's
 * LOCAL (location) wall clock, so the day comparison MUST happen in the
 * tenant/location timezone — not UTC. In PR (AST/UTC-4) a 10pm-local pickup
 * is the NEXT UTC day, and a UTC compare would filter the guest's real
 * reservation out of a "Today" tap (the exact failure B3g exists to kill).
 */
export function samePickupDay(pickupAt, pickupDate, tz) {
  if (!pickupAt || !pickupDate) return false;
  return isoDayInTz(pickupAt, tz || DEFAULT_TENANT_TIMEZONE) === String(pickupDate).slice(0, 10);
}

/**
 * Resolve the wall-clock timezone for pickup-day matching: the device's
 * location config timezone if set, else the tenant's configured timezone
 * (reservationOptions), else the PR default. Read-only, one lookup each, and
 * only called when a pickupDate disambiguator is actually in play.
 */
async function resolveLookupTimezone(device) {
  try {
    const [location, optRow] = await Promise.all([
      prisma.location.findFirst({
        where: { id: device.locationId, tenantId: device.tenantId },
        select: { locationConfig: true },
      }),
      prisma.appSetting.findUnique({
        where: { key: scopedSettingKey('reservationOptions', { tenantId: device.tenantId }) },
      }),
    ]);
    const cfg = parseLocationConfig(location?.locationConfig) || {};
    const locTz = String(cfg.timezone || cfg.timeZone || '').trim();
    if (locTz) return locTz;
    if (optRow?.value) {
      try {
        const tenantTz = String(JSON.parse(optRow.value)?.tenantTimeZone || '').trim();
        if (tenantTz) return tenantTz;
      } catch { /* fall through */ }
    }
  } catch { /* fall through */ }
  return DEFAULT_TENANT_TIMEZONE;
}

/**
 * Re-fetch matcher-returned candidate ids through the kiosk's OWN scoping
 * (tenant + location + pickup window + status). The shared matcher is
 * read-only and tenant-scoped, but it does NOT know the kiosk's location /
 * window; treating its output as untrusted refs and re-fetching keeps the
 * kiosk's privacy + scoping guarantees no matter what the matcher returns.
 */
async function rescopeCandidateIds(device, now, ids) {
  const clean = [...new Set((ids || []).map((id) => String(id || '')).filter(Boolean))];
  if (!clean.length) return [];
  const rows = await prisma.reservation.findMany({
    where: { ...lookupWhere(device, now), id: { in: clean } },
    select: LOOKUP_SELECT,
    orderBy: { pickupAt: 'asc' },
    take: 25,
  });
  // Preserve the matcher's ranking order.
  const byId = new Map(rows.map((r) => [r.id, r]));
  return clean.map((id) => byId.get(id)).filter(Boolean);
}

/**
 * Resolve a scoped candidate list + the resolving matchType.
 * Confirmation path: exact (as today) → variant (shared matcher, DARK until
 * the lib lands). Name path: name query + phone OR pickup-date disambiguator
 * (both DB-only, work in the interim). Returns { candidates, matchType }.
 */
async function resolveLookupCandidates(device, now, { confirmation, cleanLastName, phone, pickupDate }) {
  if (confirmation) {
    // Exact by confirmation number — the fast path, no normalizer needed.
    const exact = await prisma.reservation.findFirst({
      where: { ...lookupWhere(device, now), reservationNumber: { equals: confirmation, mode: 'insensitive' } },
      select: LOOKUP_SELECT,
    });
    if (exact) return { candidates: [exact], matchType: 'exact' };

    // Variant match via the shared matcher (OTA/import code-format drift).
    // DARK until S30's lib is wired — interim = exact-only (no fork).
    if (isKioskSmartMatchEnabled()) {
      const ranked = await kioskSmartMatch({ code: confirmation, tenantId: device.tenantId });
      const candidates = await rescopeCandidateIds(device, now, (ranked || []).map((c) => c?.reservation?.id));
      const topType = (ranked || [])[0]?.matchType || 'variant';
      return { candidates, matchType: candidates.length ? topType : 'fail' };
    }
    return { candidates: [], matchType: 'fail' };
  }

  // Name path. lastName is required here; phone / pickupDate narrow it.
  const named = await prisma.reservation.findMany({
    where: {
      ...lookupWhere(device, now),
      customer: { is: { lastName: { equals: cleanLastName, mode: 'insensitive' } } },
    },
    select: LOOKUP_SELECT,
    orderBy: { pickupAt: 'asc' },
    take: 25,
  });
  let candidates = named;
  if (phone) {
    candidates = named.filter((r) => phonesMatch(phone, r.customer?.phone));
  } else if (pickupDate) {
    // Compare the pickup day in the LOCATION/tenant timezone (the frontend
    // sends pickupDate as a local YYYY-MM-DD), never UTC.
    const tz = await resolveLookupTimezone(device);
    candidates = named.filter((r) => samePickupDay(r.pickupAt, pickupDate, tz));
  }
  return { candidates, matchType: candidates.length ? 'name' : 'fail' };
}

/**
 * SMART lookup (B3g). Match is fully server-side and scoped to this device's
 * tenant + location + pickup window; the response is the masked stub ONLY,
 * for EVERY match type (exact and non-exact are equally masked — never a full
 * confirmation number, phone, email, or vehicle pre-verify). Miss lockout is
 * per DEVICE (survives session resets); name/pickup-date lookups feed the
 * SAME counter (name-based is the larger enumeration vector). Multiple
 * candidates → NEEDS_MORE_INFO (one more datum) — NEVER a list of
 * reservations. The idVerifiedAt gate is untouched: attach/verify still
 * re-validate server-side downstream.
 */
async function lookupReservation(sessionId, device, { confirmationNumber, lastName, phone, pickupDate } = {}) {
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
  const cleanPickupDate = String(pickupDate || '').trim() || null;
  if (!confirmation && !cleanLastName) {
    throw new KioskError('confirmationNumber or lastName is required', 400);
  }

  const { candidates, matchType } = await resolveLookupCandidates(device, now, {
    confirmation, cleanLastName, phone, pickupDate: cleanPickupDate,
  });

  // matchType telemetry (no PII — matchType + count only).
  await recordSessionTelemetry(session, {
    step: 'LOOKUP', event: 'LOOKUP_RESULT', data: { matchType, candidateCount: candidates.length },
  });

  if (candidates.length === 0) {
    await recordLookupMissEvent(session); // telemetry
    const attemptsRemaining = await registerDeviceLookupMiss(device); // enforcement (per DEVICE)
    throw new KioskError('No matching reservation found', 404, 'RESERVATION_NOT_FOUND', { attemptsRemaining });
  }

  if (candidates.length > 1) {
    // Ambiguous — ask for ONE more datum, never leak a list. A code/variant
    // match with no name → ask the last name; a name match → ask the pickup
    // date (or the last name again if we already had the date). maskedHint is
    // intentionally omitted: any per-candidate hint would leak which of the
    // several this is.
    const needs = confirmation ? 'lastName' : (!cleanPickupDate ? 'pickupDate' : 'lastName');
    // Not a miss (real data matched) — don't feed the lockout, don't rearm.
    return { status: 'NEEDS_MORE_INFO', needs };
  }

  // Single candidate → the masked stub, identical shape for every matchType.
  // Hit → rearm the device counter (and clear any expired lock).
  if (deviceRow && (deviceRow.lookupMisses > 0 || deviceRow.lookupLockedUntil)) {
    await prisma.kioskDevice.update({
      where: { id: device.id },
      data: { lookupMisses: 0, lookupLockedUntil: null },
    }).catch(() => {});
  }

  return reservationStub(candidates[0]);
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
      // binding a different one invalidates any prior verification, along
      // with the B3e name-mismatch marker + pending name-update code.
      ...(session.reservationId !== resv.id ? {
        idVerifiedAt: null,
        nameMismatchAt: null,
        nameUpdateCodeHash: null,
        nameUpdateCodeExpiresAt: null,
      } : {}),
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
  // Notification Center emitter (2026-09-01) — a guest is physically waiting,
  // so this is CRITICAL (badges the bell). requireInProgress above means an
  // already-escalated session throws before reaching here, and the dedupeKey
  // on the session id makes any retry a no-op. Safe emit — the guest-facing
  // escalate must never fail on a notification write. The dashboard Ops-Hub
  // item and sessions list stay untouched; the center only records.
  await emitNotificationSafe({
    tenantId: device.tenantId,
    locationId: device.locationId || null,
    severity: 'CRITICAL',
    sourceType: 'KIOSK',
    sourceRefId: session.id,
    title: 'Guest waiting — kiosk session escalated',
    body: [
      device.name || null,
      `reason: ${updated.escalatedReason}`,
    ].filter(Boolean).join(' · '),
    deepLink: '/kiosks?outcome=ESCALATED',
    dedupeKey: `kiosk-escalation:${session.id}`,
    templateKey: 'kiosk',
    paramsJson: { reason: updated.escalatedReason },
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

// ── F1 Kiosk ↔ Valet remote assist (2026-09-03) ─────────────────────────────
//
// Plan: doc/kiosk-valet-remote-assist-plan-2026-09-03.md — MUST-CHANGE 3
// (binding BEFORE any remote read/write) + SHOULD "historial antes de Get
// Help" (read-only assist-view). Contract consumed by Valet:
// doc/kiosk-valet-remote-assist-VALET-PROMPT-2026-09-03.md §F1.

// Valet conversation ids are opaque tokens (cuid/uuid-ish). Anything else
// is rejected — the column is a lookup key, never free text.
export const VOZIA_CONVERSATION_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
// Enum-shaped names only (event names, error codes, reasons). Same regex the
// F0 kiosk uses for refusal reasons — free text is DROPPED, never normalized.
export const ASSIST_ENUM_RE = /^[A-Z][A-Z0-9_]{1,63}$/;
// The funnel steps the shell mirrors onto KioskSession.step (FUNNEL_STEP in
// frontend/src/app/kiosk/page.js) + the server-written 'ID'. Anything else → null.
export const ASSIST_STEPS = Object.freeze(['WELCOME', 'LOOKUP', 'ID', 'UPSELL', 'PAYMENT', 'SIGN', 'DONE']);
export const ASSIST_TIMELINE_CAP = 200;

/**
 * POST /sessions/:id/vozia-conversation — device-guarded binding of the
 * session to the Valet conversation the shell just received over postMessage.
 * Persists ONLY the conversation id (the secret stays in page memory).
 * null / '' clears the binding (iframe reset/close). Idempotent. Not gated on
 * IN_PROGRESS on purpose: a guest can open Get Help on an ESCALATED session
 * and the agent must still be able to read it.
 */
async function bindVoziaConversation(sessionId, device, { conversationId } = {}) {
  const session = await getSessionForDevice(sessionId, device);
  const raw = conversationId == null ? '' : String(conversationId).trim();
  if (raw && !VOZIA_CONVERSATION_ID_RE.test(raw)) {
    throw new KioskError('conversationId must be 1-64 chars of [A-Za-z0-9_-]', 422, 'INVALID_CONVERSATION_ID');
  }
  const next = raw || null;
  // Only a session the guest is still SITTING AT can be bound. getSessionForDevice
  // proves the row belongs to this device — it does NOT prove it is the one in
  // front of the person asking for help, so a tampered or buggy kiosk could
  // otherwise attach a PREVIOUS guest's finished session to the current
  // conversation and the agent would act on the wrong person's check-in
  // believing it was theirs.
  //
  // ESCALATED is bindable and that is the WHOLE POINT: escalating IS asking for
  // help, and the guest usually opens the chat immediately after. Gating on
  // IN_PROGRESS alone locked out exactly the case this feature exists for — an
  // existing test caught it. Only genuinely finished sessions are refused.
  // UNBINDING stays legal at any outcome: releasing a permit must never be
  // blocked by the state that makes releasing it necessary.
  if (next && !BINDABLE_OUTCOMES.includes(session.outcome)) {
    throw new KioskError(
      `Session is ${String(session.outcome).toLowerCase()}`,
      409, 'SESSION_NOT_BINDABLE',
    );
  }
  if (session.voziaConversationId !== next) {
    await prisma.kioskSession.update({
      where: { id: session.id },
      data: {
        voziaConversationId: next,
        voziaBoundAt: next ? new Date() : null,
        lastActivityAt: new Date(),
      },
    });
    logger.info('[kiosk] vozia conversation bound', {
      sessionId: session.id, deviceId: device.id, tenantId: device.tenantId, bound: !!next,
    });
  }
  return { ok: true, sessionId: session.id, bound: !!next };
}

function enumOrNull(value, re = ASSIST_ENUM_RE) {
  const v = value == null ? '' : String(value);
  return re.test(v) ? v : null;
}

function isoOrNull(value) {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/**
 * Pure projection of eventsJson → the agent-facing timeline. Exported for
 * tests. Rules (Valet prompt F1):
 *   - `event` must match ASSIST_ENUM_RE, else the entry is DROPPED;
 *   - `step` is whitelisted to ASSIST_STEPS (else null);
 *   - `code` comes ONLY from data.code / data.reason / data.reasons[0] and
 *     only when enum-shaped — `data` itself NEVER leaves (agreement numbers,
 *     free-text reasons, photo refs live there);
 *   - consecutive duplicates (same event+step+code) collapse into `count`,
 *     keeping the FIRST `at` of the run;
 *   - capped to the most recent ASSIST_TIMELINE_CAP entries after collapsing.
 */
export function projectAssistTimeline(events) {
  const out = [];
  for (const raw of Array.isArray(events) ? events : []) {
    if (!raw || typeof raw !== 'object') continue;
    const event = enumOrNull(raw.event);
    if (!event) continue;
    const step = ASSIST_STEPS.includes(raw.step) ? raw.step : null;
    const data = raw.data && typeof raw.data === 'object' && !Array.isArray(raw.data) ? raw.data : null;
    const code = data
      ? (enumOrNull(data.code) || enumOrNull(data.reason)
        || (Array.isArray(data.reasons) ? enumOrNull(data.reasons[0]) : null))
      : null;
    const at = isoOrNull(raw.at);
    // Innovation F1 SHOULD-2: an entry with no parseable timestamp cannot be
    // ordered or split around "asked for help", and the Valet client drops it
    // anyway — do not ship a hole the other side has to defend against.
    if (!at) continue;
    const last = out[out.length - 1];
    if (last && last.event === event && last.step === step && last.code === code) {
      last.count += 1;
      continue;
    }
    out.push({ at, step, event, count: 1, code });
  }
  return out.length > ASSIST_TIMELINE_CAP ? out.slice(out.length - ASSIST_TIMELINE_CAP) : out;
}

/**
 * GET /api/kiosk/admin/sessions/:kioskSessionId/assist-view?conversationId=
 * Read-only, enum-only, PII-free view for the Valet agent (service account).
 * 404 unless the row is in the caller's tenant AND its voziaConversationId
 * equals the query's — one indistinguishable error for wrong tenant / wrong
 * conversation / unbound session, so the endpoint never confirms that a
 * session id exists. `truth` comes from SERVER columns only (never from
 * eventsJson, which the kiosk client can write freely).
 */
async function assistView(scope = {}, kioskSessionId, { conversationId } = {}) {
  if (!scope?.tenantId) throw new KioskError('A tenant scope is required (super-admins pass ?tenantId=)', 400, 'TENANT_SCOPE_REQUIRED');
  const conv = conversationId == null ? '' : String(conversationId).trim();
  if (!VOZIA_CONVERSATION_ID_RE.test(conv)) {
    throw new KioskError('conversationId is required', 400, 'CONVERSATION_ID_REQUIRED');
  }
  // Valet polls this behind a 1.5s timeout, so every read is a PRIMARY-KEY
  // findUnique with a narrow select (never a scan, never the photo-bearing
  // columns) and the projection below is pure in-memory work. Tenant is
  // checked in JS rather than in the where-clause so the lookup stays on the
  // PK index — a cross-tenant id resolves and is then rejected as 404, the
  // same error a missing id gets.
  const session = kioskSessionId
    ? await prisma.kioskSession.findUnique({
      where: { id: String(kioskSessionId) },
      select: {
        tenantId: true, outcome: true, step: true, voziaConversationId: true, voziaBoundAt: true,
        idVerifiedAt: true, idVerifyMethod: true, idPhotosStoredAt: true,
        assistGrantedAt: true, assistAgentRef: true, assistAgentName: true,
        paymentIntentState: true, reservationId: true, checkoutSessionId: true,
        eventsJson: true,
      },
    })
    : null;
  if (!session || session.tenantId !== scope.tenantId
    || !voziaBindingIsLive(session, conv)) {
    throw new KioskError('Session not found', 404, 'SESSION_NOT_FOUND');
  }

  const [resv, cs] = await Promise.all([
    session.reservationId
      ? prisma.reservation.findUnique({
        where: { id: session.reservationId },
        select: { tenantId: true, vehicleId: true },
      })
      : null,
    session.checkoutSessionId
      ? prisma.checkoutSession.findUnique({
        where: { id: session.checkoutSessionId },
        select: { tenantId: true, currentStep: true },
      })
      : null,
  ]);
  const sameTenant = (row) => !!row && row.tenantId === scope.tenantId;

  return {
    outcome: session.outcome,
    step: ASSIST_STEPS.includes(session.step) ? session.step : null,
    truth: {
      idVerified: !!session.idVerifiedAt,
      idVerifyMethod: enumOrNull(session.idVerifyMethod),
      vehicleAssigned: sameTenant(resv) && !!resv.vehicleId,
      checkoutStep: sameTenant(cs) ? enumOrNull(cs.currentStep) : null,
      paymentIntentState: enumOrNull(session.paymentIntentState),
      idPhotosStored: !!session.idPhotosStoredAt,
    },
    // The assist grant, so the console can render it after a reload instead of
    // remembering it. `expiresAt` is an ABSOLUTE server instant, deliberately
    // not a duration: a duration counted down locally drifts against the server
    // that actually decides, and a clock that drifts eventually lies to the
    // agent about whether they still hold the permit. The clock is DISPLAYED
    // TRUTH, never authority — the server refuses an expired grant whatever the
    // panel shows. `heldBy` is what Valet asserted, and is named accordingly.
    assist: (() => {
      if (!session.assistGrantedAt) return { open: false, expiresAt: null, heldBy: null };
      const expires = new Date(new Date(session.assistGrantedAt).getTime() + ASSIST_GRANT_TTL_MIN * 60 * 1000);
      return {
        open: expires.getTime() > Date.now(),
        expiresAt: expires.toISOString(),
        heldBy: session.assistAgentRef
          ? { ref: session.assistAgentRef, name: session.assistAgentName || null, assertedByValet: true }
          : null,
      };
    })(),
    timeline: projectAssistTimeline(session.eventsJson),
  };
}

export const kioskSessionService = {
  createSession,
  appendEvents,
  lookupReservation,
  attachReservation,
  assignVehicle,
  escalate,
  listSessions,
  bindVoziaConversation,
  assistView,
};
