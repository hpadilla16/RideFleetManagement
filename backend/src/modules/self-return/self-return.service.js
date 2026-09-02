/**
 * QR self-return — the IO half (Hector, 2026-09-02). Decisions live in
 * self-return.js.
 *
 * AUTH MODEL: the per-location QR token is the whole identity of the PAGE;
 * the (reservation number, last name) pair is the identity of the STAMP.
 * Everything unusable (unknown token, revoked, re-tenanted location) and
 * every pair mismatch is the same generic not-found on the public surface —
 * an enumerator gets no oracle.
 *
 * FAIL-CLOSED CHAIN on every token resolution, mirroring the shuttle
 * surfaces: QR row ACTIVE → location still exists AND still belongs to the
 * row's tenant. Any doubt = null = 404.
 *
 * Deps are injectable for the DB-free suites; production passes none.
 */
import { prisma } from '../../lib/prisma.js';
import logger from '../../lib/logger.js';
import { emitNotificationSafe } from '../notifications/notifications-emit.js';
import {
  mintSelfReturnToken,
  qrState,
  selfReturnLinkPath,
  normalizeReservationNumber,
  lastNameMatches,
  hasActiveSelfReturnStamp,
  buildStampMeta,
  STAMPABLE_STATUSES,
} from './self-return.js';

function defaultDeps() {
  return {
    prisma,
    logger,
    emitNotification: emitNotificationSafe,
    now: () => new Date(),
  };
}

function httpError(status, message, code = null) {
  const e = new Error(message);
  e.status = status;
  if (code) e.code = code;
  return e;
}

const clean = (v) => String(v || '').trim();

export const selfReturnService = {
  /**
   * Admin read: is the QR on for this location, and what link does the
   * poster carry? The token IS re-shown here — unlike a driver link, the QR
   * is a public poster by design and staff must be able to reprint it.
   */
  async qrStatus(locationId, scope = {}, depsOverride = {}) {
    const deps = { ...defaultDeps(), ...depsOverride };
    if (!scope?.tenantId) throw httpError(400, 'tenantId scope is required');
    const location = await deps.prisma.location.findFirst({
      where: { id: clean(locationId), tenantId: scope.tenantId },
      select: { id: true },
    });
    if (!location) throw httpError(404, 'Location not found');
    const row = await deps.prisma.selfReturnQr.findUnique({ where: { locationId: location.id } });
    const active = qrState(row) === 'ACTIVE' && row.tenantId === scope.tenantId;
    return {
      enabled: active,
      linkPath: active ? selfReturnLinkPath(row.token) : null,
    };
  },

  /**
   * Enable = mint. Idempotent while active; after a disable it mints a NEW
   * token so every previously printed poster dies with the old one.
   */
  async enableQr(locationId, scope = {}, userId = null, depsOverride = {}) {
    const deps = { ...defaultDeps(), ...depsOverride };
    if (!scope?.tenantId) throw httpError(400, 'tenantId scope is required');
    const location = await deps.prisma.location.findFirst({
      where: { id: clean(locationId), tenantId: scope.tenantId },
      select: { id: true },
    });
    if (!location) throw httpError(404, 'Location not found');

    const existing = await deps.prisma.selfReturnQr.findUnique({ where: { locationId: location.id } });
    if (existing && existing.tenantId !== scope.tenantId) {
      // A re-tenanted location: the stale row must never resurrect for the
      // new tenant. Rotate it under the CURRENT owner.
      const row = await deps.prisma.selfReturnQr.update({
        where: { id: existing.id },
        data: { tenantId: scope.tenantId, token: mintSelfReturnToken(), revokedAt: null, createdByUserId: userId || null },
      });
      return { enabled: true, linkPath: selfReturnLinkPath(row.token) };
    }
    if (existing && qrState(existing) === 'ACTIVE') {
      return { enabled: true, linkPath: selfReturnLinkPath(existing.token) };
    }
    const row = existing
      ? await deps.prisma.selfReturnQr.update({
        where: { id: existing.id },
        data: { token: mintSelfReturnToken(), revokedAt: null, createdByUserId: userId || null },
      })
      : await deps.prisma.selfReturnQr.create({
        data: {
          tenantId: scope.tenantId,
          locationId: location.id,
          token: mintSelfReturnToken(),
          createdByUserId: userId || null,
        },
      });
    return { enabled: true, linkPath: selfReturnLinkPath(row.token) };
  },

  /** Disable — the poster dies now. Idempotent. */
  async disableQr(locationId, scope = {}, depsOverride = {}) {
    const deps = { ...defaultDeps(), ...depsOverride };
    if (!scope?.tenantId) throw httpError(400, 'tenantId scope is required');
    const row = await deps.prisma.selfReturnQr.findFirst({
      where: { locationId: clean(locationId), tenantId: scope.tenantId },
    });
    if (row && !row.revokedAt) {
      await deps.prisma.selfReturnQr.update({ where: { id: row.id }, data: { revokedAt: deps.now() } });
    }
    return { enabled: false };
  },

  /**
   * Token → the public page's context, or null (the route's bare 404). The
   * chain re-verifies the location still belongs to the row's tenant on
   * every call — a re-tenanted location kills the link, same as the tracker.
   */
  async resolveQr(token, depsOverride = {}) {
    const deps = { ...defaultDeps(), ...depsOverride };
    const t = clean(token);
    if (!t || t.length < 16) return null;
    const row = await deps.prisma.selfReturnQr.findUnique({ where: { token: t } });
    if (qrState(row) !== 'ACTIVE') return null;
    const location = await deps.prisma.location.findFirst({
      where: { id: row.locationId, tenantId: row.tenantId },
      select: { id: true, name: true },
    });
    if (!location) return null;
    return { qr: row, location };
  },

  /** The public page payload — PICKED fields only (public-payload law). */
  async publicContext(token, depsOverride = {}) {
    const ctx = await this.resolveQr(token, depsOverride);
    if (!ctx) return null;
    return { locationName: ctx.location.name || null };
  },

  /**
   * The customer's "Devolví el carro" submit.
   *
   * Verification is the (reservation number, last name) PAIR against an OPEN
   * rental of the QR's tenant. EVERY failure — unknown number, wrong last
   * name, wrong tenant, not CHECKED_OUT — returns the same
   * `{ notFound: true }` so the route can emit one generic 404 and the form
   * never becomes an existence oracle.
   *
   * First stamp wins: a second scan returns the original time
   * (`already: true`) and writes nothing. An ADMIN-voided stamp may be
   * re-stamped (a new scan is a new claim; the void trail survives in the
   * audit log and the agent sees both times at close).
   *
   * INVARIANT (a): this touches ONLY the Reservation stamp columns. It never
   * closes the agreement, never moves the vehicle, never computes a fee.
   */
  async submitReturn(token, { reservationNumber, lastName, meta = {} } = {}, depsOverride = {}) {
    const deps = { ...defaultDeps(), ...depsOverride };
    const ctx = await this.resolveQr(token, depsOverride);
    if (!ctx) return null;

    const resNum = normalizeReservationNumber(reservationNumber);
    const name = clean(lastName);
    if (!resNum || !name) return { notFound: true };

    // Tenant-scoped lookup; try the number as normalized, then as typed —
    // reservation numbers in the house are uppercase, but an import may not be.
    let reservation = await deps.prisma.reservation.findFirst({
      where: { tenantId: ctx.qr.tenantId, reservationNumber: resNum },
      include: { customer: { select: { lastName: true } } },
    });
    if (!reservation && clean(reservationNumber) !== resNum) {
      reservation = await deps.prisma.reservation.findFirst({
        where: { tenantId: ctx.qr.tenantId, reservationNumber: clean(reservationNumber) },
        include: { customer: { select: { lastName: true } } },
      });
    }

    if (
      !reservation
      || !lastNameMatches(name, reservation.customer?.lastName)
      || !STAMPABLE_STATUSES.includes(String(reservation.status || '').toUpperCase())
    ) {
      return { notFound: true };
    }

    // Idempotent second scan: the FIRST stamp stands, nothing is rewritten.
    if (hasActiveSelfReturnStamp(reservation)) {
      return { ok: true, already: true, reportedAt: new Date(reservation.customerReportedReturnAt) };
    }

    const reportedAt = deps.now();
    await deps.prisma.reservation.update({
      where: { id: reservation.id },
      data: {
        customerReportedReturnAt: reportedAt,
        customerReportedReturnLocationId: ctx.qr.locationId,
        customerReportedReturnMetaJson: buildStampMeta(meta),
        // A previously voided stamp: the new scan is a new claim, cleanly.
        customerReportedReturnVoidedAt: null,
        customerReportedReturnVoidedByUserId: null,
        customerReportedReturnVoidReason: null,
      },
    });

    // Notification Center INFO — the counter learns returns are stacking up
    // BEFORE anyone opens the wizard. Deduped per reservation, so a re-scan
    // after a void is still one envelope. Best-effort: a dead notification
    // write must never lose the stamp. Source reuses CHECKIN_AUDIT — the
    // check-in attention lane — rather than inventing a new one.
    try {
      await deps.emitNotification({
        tenantId: ctx.qr.tenantId,
        locationId: ctx.qr.locationId || null,
        severity: 'INFO',
        sourceType: 'CHECKIN_AUDIT',
        sourceRefId: reservation.id,
        title: `Customer marked the car returned — check-in pending (${reservation.reservationNumber})`,
        body: [
          [reservation.customer?.lastName].filter(Boolean).join(' ') || null,
          ctx.location?.name || null,
          `marked ${reportedAt.toISOString()}`,
        ].filter(Boolean).join(' · ') || null,
        deepLink: `/reservations/${reservation.id}`,
        dedupeKey: `self-return:${reservation.id}`,
        templateKey: 'selfReturn',
        paramsJson: { res: reservation.reservationNumber || '' },
      });
    } catch (err) {
      deps.logger.warn('[self-return] notification emit failed (non-fatal)', {
        reservationId: reservation.id, message: err.message,
      });
    }

    return { ok: true, already: false, reportedAt };
  },

  /**
   * ADMIN void (invariant d): the stamp is never deleted — voiding keeps the
   * timestamp and records who and why, and check-in close stops honoring it.
   * The ROLE check lives at the route (canVoidSelfReturn); this enforces
   * state and scope.
   */
  async voidStamp(reservationId, { scope = {}, userId = null, reason = null } = {}, depsOverride = {}) {
    const deps = { ...defaultDeps(), ...depsOverride };
    const reservation = await deps.prisma.reservation.findFirst({
      where: { id: clean(reservationId), ...(scope?.tenantId ? { tenantId: scope.tenantId } : {}) },
    });
    if (!reservation) throw httpError(404, 'Reservation not found');
    if (!hasActiveSelfReturnStamp(reservation)) {
      throw httpError(409, 'This reservation has no active self-return stamp to void', 'NOT_STAMPED');
    }
    return deps.prisma.reservation.update({
      where: { id: reservation.id },
      data: {
        customerReportedReturnVoidedAt: deps.now(),
        customerReportedReturnVoidedByUserId: userId || null,
        customerReportedReturnVoidReason: String(reason || '').trim().slice(0, 300) || null,
      },
    });
  },
};
