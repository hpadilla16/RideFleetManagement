/**
 * Shuttle Requests (Valet arc, 2026-08-05).
 *
 * Chloe — the VozIA voice agent — has already validated the reservation
 * (exists, right sede, name matches) before calling create; RFM's job is the
 * floor side: alert the agents, dispatch the bus, close the loop.
 *
 * The rule that shapes everything here: an anxious customer who calls three
 * times is ONE bus, not three. Creation is idempotent per reservation — an
 * open request absorbs the repeat call as callCount+1 and snaps back to READY
 * so the banner fires again, even if someone had already viewed it.
 */
import { prisma } from '../../lib/prisma.js';
import { sendEmail } from '../../lib/mailer.js';
import logger from '../../lib/logger.js';
import { emitNotificationSafe } from '../notifications/notifications-emit.js';
// The list/notice DECISIONS live in a pure module so CI's DB-free step can
// guard them — this suite needs embedded postgres and does not run there.
import {
  OPEN_STATUSES,
  scopeWhere,
  buildListQuery,
  buildDelayNotice,
  appendNotice,
  markNoticeFailed
} from './shuttle-query.js';
import { configVehicleIds } from './shuttle-tracker-position.js';
import { clearCustomerLocation } from './shuttle-tracker.service.js';
import { parseAlertRecipients, buildNoShowSms, buildNoShowStaffEmail } from './shuttle-zone-alerts.js';

/** Phase-3 deps, injectable for the DB-free suites; production passes none.
 *  smsSend/resolveBrand resolve lazily inside the fan-out (same idiom as the
 *  alert scheduler) so this module stays importable without the SMS module. */
function phase3Deps(overrides = {}) {
  return {
    prisma,
    logger,
    sendEmail,
    clearCustomerLocation,
    smsSend: null,
    resolveBrand: null,
    now: () => new Date(),
    ...overrides
  };
}
async function resolveSms(deps) {
  if (deps.smsSend) return deps.smsSend;
  const mod = await import('../sms/sms.service.js');
  return (args) => mod.smsService.sendCustom(args);
}
async function resolveBrandFn(deps) {
  if (deps.resolveBrand) return deps.resolveBrand;
  const mod = await import('../../lib/email-template.js');
  return mod.resolveEmailBrand;
}

export const shuttleRequestsService = {
  /**
   * Create — or absorb into the existing open request for the reservation.
   * Caller (the route) has already resolved+validated tenant/reservation.
   */
  async create({ tenantId, locationId, reservationId, customerName, customerPhone, partySize, pickupNote, source = null, smsOptIn = undefined, bags = undefined, pickupSpotZoneId = undefined }) {
    if (!tenantId || !locationId || !reservationId) throw new Error('tenantId, locationId and reservationId are required');

    // Phase 3 intake (Screen 7): bags/spot are already validated by the
    // caller against the location's intake config; this is only the
    // defensive normalization every other field gets. Absent = untouched.
    const cleanBags = Number.isFinite(Number(bags)) && Number(bags) >= 0 ? Math.min(200, Math.floor(Number(bags))) : null;
    const cleanSpotId = String(pickupSpotZoneId || '').trim() || null;

    const existing = await prisma.shuttleRequest.findFirst({
      where: { tenantId, reservationId, status: { in: OPEN_STATUSES } },
      orderBy: { createdAt: 'desc' }
    });
    if (existing) {
      const updated = await prisma.shuttleRequest.update({
        where: { id: existing.id },
        data: {
          callCount: { increment: 1 },
          // Back to READY so the banner re-fires — a second call means the
          // customer is still standing at the curb.
          status: 'READY',
          partySize: Number.isFinite(Number(partySize)) && Number(partySize) > 0 ? Number(partySize) : existing.partySize,
          pickupNote: String(pickupNote || '').trim() || existing.pickupNote,
          customerPhone: String(customerPhone || '').trim() || existing.customerPhone,
          // Arrival-SMS consent (Phase 2): an explicit boolean on the repeat
          // call updates it either way; absent = the original choice stands.
          ...(typeof smsOptIn === 'boolean' ? { smsOptIn } : {}),
          // Same blank-repeat rule as pickupNote: a repeat call that says
          // nothing about bags/spot must not erase what we know.
          ...(cleanBags !== null ? { bags: cleanBags } : {}),
          ...(cleanSpotId ? { pickupSpotZoneId: cleanSpotId } : {})
        }
      });
      return { request: updated, deduplicated: true };
    }

    const request = await prisma.shuttleRequest.create({
      data: {
        tenantId,
        locationId,
        reservationId,
        customerName: String(customerName || '').trim(),
        customerPhone: String(customerPhone || '').trim() || null,
        partySize: Number.isFinite(Number(partySize)) && Number(partySize) > 0 ? Math.min(50, Number(partySize)) : 1,
        pickupNote: String(pickupNote || '').trim() || null,
        // VOICE (VozIA) | VALET | PUBLIC_LINK — where the request came from.
        // On absorb (above) the ORIGINAL source stands: the first call named it.
        source: source ? String(source).trim() : null,
        // Strictly opt-IN: anything but an explicit true is false.
        smsOptIn: smsOptIn === true,
        bags: cleanBags,
        pickupSpotZoneId: cleanSpotId
      }
    });
    return { request, deduplicated: false };
  },

  /**
   * The sede queue AND the history view (2026-08-07 spec).
   *
   * `open` (default) keeps its original live-queue semantics untouched — no
   * date window, oldest first, exactly what the banner polls. Any other
   * status (or `all`) is the HISTORY view: date-windowed (defaults to today),
   * newest first, real pagination.
   *
   * `locationId` narrows within the caller's scope, never widens it: a
   * scoped user asking for a sede outside their list gets an empty page, not
   * another sede's queue.
   */
  async list(scope = {}, { status = 'open', limit = 50, page = 1, from = null, to = null, locationId = null } = {}) {
    const q = buildListQuery(scope, { status, limit, page, from, to, locationId });
    const [rows, total] = await Promise.all([
      prisma.shuttleRequest.findMany({
        where: q.where,
        orderBy: q.orderBy,
        take: q.take,
        skip: q.skip,
        include: {
          reservation: { select: { reservationNumber: true } },
          location: { select: { id: true, name: true, code: true } }
        }
      }),
      prisma.shuttleRequest.count({ where: q.where })
    ]);

    // "Who viewed it, who closed it" — the model has no User relations, so
    // names come from one keyed lookup. Cosmetic: a failed lookup never
    // fails the list.
    const userIds = [...new Set(rows.flatMap((r) => [r.viewedByUserId, r.closedByUserId]).filter(Boolean))];
    let usersById = {};
    if (userIds.length) {
      try {
        const users = await prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, fullName: true, email: true } });
        usersById = Object.fromEntries(users.map((u) => [u.id, u.fullName || u.email || u.id]));
      } catch { usersById = {}; }
    }
    // Phase 3: assignment labels for the queue UI ("Van 2 · IKT-482") — the
    // same cosmetic keyed-lookup rule as the user names, and tenant-guarded
    // even here so a stale cross-tenant id resolves to null, not a label.
    const assignedIds = [...new Set(rows.map((r) => r.assignedVehicleId).filter(Boolean))];
    let assignedById = {};
    if (assignedIds.length) {
      try {
        const vehicles = await prisma.vehicle.findMany({
          where: { id: { in: assignedIds }, ...(scope?.tenantId ? { tenantId: scope.tenantId } : {}) },
          select: { id: true, make: true, model: true, plate: true }
        });
        assignedById = Object.fromEntries(vehicles.map((v) => [v.id, {
          id: v.id,
          name: [v.make, v.model].map((p) => String(p || '').trim()).filter(Boolean).join(' ') || null,
          plate: v.plate || null
        }]));
      } catch { assignedById = {}; }
    }
    const enriched = rows.map((r) => ({
      ...r,
      viewedByName: r.viewedByUserId ? usersById[r.viewedByUserId] || null : null,
      closedByName: r.closedByUserId ? usersById[r.closedByUserId] || null : null,
      assignedVehicle: r.assignedVehicleId ? assignedById[r.assignedVehicleId] || null : null
    }));

    return {
      rows: enriched,
      openCount: enriched.filter((r) => OPEN_STATUSES.includes(r.status)).length,
      total,
      page: q.page,
      pageSize: q.pageSize
    };
  },

  /** READY → VIEWED, stamping who. Clearing the banner goes through here. */
  async markViewed(id, scope = {}, userId = null) {
    const row = await prisma.shuttleRequest.findFirst({ where: { id, ...scopeWhere(scope) } });
    if (!row) { const e = new Error('Shuttle request not found'); e.status = 404; throw e; }
    if (!OPEN_STATUSES.includes(row.status)) return row;
    return prisma.shuttleRequest.update({
      where: { id: row.id },
      data: { status: 'VIEWED', viewedAt: row.viewedAt || new Date(), viewedByUserId: userId || row.viewedByUserId }
    });
  },

  /**
   * Delay notice (2026-08-07 spec): email the waiting customer that the bus
   * is late. The email comes from the reservation's Customer — ShuttleRequest
   * only carries a phone. No email → a 409 the UI can act on (it offers the
   * phone instead); never a silent failure.
   *
   * THE EXPENSIVE LESSON (beta.335→336) applies: the send is fire-and-forget.
   * The notice is LOGGED first with status SENT and downgraded to FAILED
   * asynchronously if the provider rejects — so the screen always shows that
   * someone tried, and three agents don't email the same customer blind.
   */
  async notifyDelay(id, { reason = null, etaMinutes = null } = {}, scope = {}, userId = null, deps = {}) {
    const row = await prisma.shuttleRequest.findFirst({
      where: { id, ...scopeWhere(scope) },
      include: {
        reservation: { select: { reservationNumber: true, customer: { select: { firstName: true, lastName: true, email: true } } } },
        location: { select: { name: true, code: true } }
      }
    });
    if (!row) { const e = new Error('Shuttle request not found'); e.status = 404; throw e; }
    if (!OPEN_STATUSES.includes(row.status)) { const e = new Error(`Request is ${row.status} — no delay notice needed`); e.status = 409; throw e; }

    const email = String(row.reservation?.customer?.email || '').trim();
    if (!email) {
      const e = new Error('Customer has no email on file — call them instead');
      e.status = 409;
      e.code = 'NO_EMAIL';
      e.customerPhone = row.customerPhone || null;
      throw e;
    }

    const notice = buildDelayNotice({ reason, etaMinutes, to: email, userId });
    const notices = appendNotice(row.delayNoticesJson, notice);

    const updated = await prisma.shuttleRequest.update({
      where: { id: row.id },
      data: { delayNoticesJson: JSON.stringify(notices) }
    }).catch((err) => {
      // A Prisma client predating the column (rolling deploy): the log is the
      // point of this feature, so REFUSE rather than send unrecorded email.
      const e = new Error(`Could not record the delay notice: ${err.message}`);
      e.status = 503;
      throw e;
    });

    const firstName = row.reservation?.customer?.firstName || row.customerName || 'customer';
    const sede = row.location?.name || row.location?.code || 'our location';
    const etaLine = notice.etaMinutes ? ` We estimate about ${notice.etaMinutes} minutes.` : '';
    const reasonLine = notice.reason ? ` (${notice.reason})` : '';
    const send = deps.sendEmail || sendEmail;
    // Fire-and-forget — NEVER awaited inside the request (beta.335→336:
    // awaiting SMTP added 4-5s, VozIA retried, duplicates shipped).
    send({
      to: email,
      subject: `Shuttle update — ${row.reservation?.reservationNumber || sede}`,
      text: `Hi ${firstName},\n\nOur shuttle is running a little late${reasonLine}.${etaLine} We apologize for the wait — the bus is on its way to you.\n\n${sede}`,
      html: `<p style="font-family:Arial,sans-serif">Hi ${firstName},</p><p style="font-family:Arial,sans-serif">Our shuttle is running a little late${reasonLine}.${etaLine} We apologize for the wait &mdash; the bus is on its way to you.</p><p style="font-family:Arial,sans-serif">${sede}</p>`
    }).catch(async (err) => {
      try {
        const fresh = await prisma.shuttleRequest.findUnique({ where: { id: row.id }, select: { delayNoticesJson: true } });
        const list = markNoticeFailed(fresh?.delayNoticesJson, notice, err);
        await prisma.shuttleRequest.update({ where: { id: row.id }, data: { delayNoticesJson: JSON.stringify(list) } });
      } catch { /* the SENT row stands; the provider log has the truth */ }
    });

    return { ok: true, request: updated, notice };
  },

  async close(id, outcome, scope = {}, userId = null, reason = null, depsOverride = {}) {
    const deps = phase3Deps(depsOverride);
    const status = String(outcome || '').toUpperCase();
    if (!['CANCELLED', 'NO_SHOW', 'COMPLETED'].includes(status)) throw new Error(`Invalid close outcome ${outcome}`);
    const row = await deps.prisma.shuttleRequest.findFirst({ where: { id, ...scopeWhere(scope) } });
    if (!row) { const e = new Error('Shuttle request not found'); e.status = 404; throw e; }
    if (!OPEN_STATUSES.includes(row.status)) return row;
    const updated = await deps.prisma.shuttleRequest.update({
      where: { id: row.id },
      data: { status, closedAt: new Date(), closedByUserId: userId || null, closeReason: reason ? String(reason).trim() : null }
    });
    // Ephemeral location sharing stops the moment the wait ends (Screen 9
    // binding constraint): any close deletes the Redis key. Best-effort —
    // the TTL is the backstop, and a failed delete must not fail the close.
    Promise.resolve(deps.clearCustomerLocation(row.id)).catch(() => {});
    return updated;
  },

  /**
   * Manual staff assignment (Phase 3, Screen 8a): pin ONE shuttle vehicle to
   * an open request. FAIL-CLOSED on every edge: the vehicle must belong to
   * the request's tenant AND be in the location's tracker-config vehicle
   * list — anything else is a 400/404, never a silent write. The public
   * tracker re-verifies ownership again on read, so even a stale assignment
   * can never leak another tenant's GPS.
   */
  async assign(id, vehicleId, scope = {}, userId = null, depsOverride = {}) {
    const deps = phase3Deps(depsOverride);
    const cleanVehicleId = String(vehicleId || '').trim();
    if (!cleanVehicleId) { const e = new Error('vehicleId is required'); e.status = 400; throw e; }

    const row = await deps.prisma.shuttleRequest.findFirst({ where: { id, ...scopeWhere(scope) } });
    if (!row) { const e = new Error('Shuttle request not found'); e.status = 404; throw e; }
    if (!OPEN_STATUSES.includes(row.status)) {
      const e = new Error(`Request is ${row.status} — nothing to assign`); e.status = 409; throw e;
    }

    const [vehicle, config] = await Promise.all([
      deps.prisma.vehicle.findFirst({ where: { id: cleanVehicleId, tenantId: row.tenantId }, select: { id: true } }),
      deps.prisma.shuttleTrackerConfig.findFirst({ where: { locationId: row.locationId, tenantId: row.tenantId } })
    ]);
    if (!vehicle || !config || !configVehicleIds(config).includes(cleanVehicleId)) {
      const e = new Error('Vehicle is not a configured shuttle at this location'); e.status = 400; throw e;
    }

    return deps.prisma.shuttleRequest.update({
      where: { id: row.id },
      data: { assignedVehicleId: cleanVehicleId }
    });
  },

  /** Undo the assignment. Same scoping; idempotent on an already-bare row. */
  async unassign(id, scope = {}, userId = null, depsOverride = {}) {
    const deps = phase3Deps(depsOverride);
    const row = await deps.prisma.shuttleRequest.findFirst({ where: { id, ...scopeWhere(scope) } });
    if (!row) { const e = new Error('Shuttle request not found'); e.status = 404; throw e; }
    if (!row.assignedVehicleId) return row;
    return deps.prisma.shuttleRequest.update({
      where: { id: row.id },
      data: { assignedVehicleId: null }
    });
  },

  /**
   * No-show fan-out (Phase 3, Screen 17) — the one service function the
   * staff endpoint calls today and the driver-token surface will call later.
   *
   * Chain: NO_SHOW transition (the existing close, so the idempotency rule
   * is inherited — an already-closed request returns as-is with ZERO
   * re-notification) → customer SMS (mode-aware copy, bilingual, opt-in
   * consent + phone required, best-effort) → ShuttleAlert row typed
   * REQUEST_NO_SHOW so the existing monitor feed/toast shows it (deduped by
   * the providerRef unique — one no-show, one alert, ever) → optional staff
   * recipients email (EMAIL channel of the Phase-2 list).
   *
   * Every fan-out leg is best-effort: the state change is the truth, a dead
   * SMS provider must not resurrect the request. No coordinates and no
   * customer phone ever reach logs from here.
   */
  async markNoShow(id, { scope = {}, userId = null, reason = null, actorContext = null } = {}, depsOverride = {}) {
    const deps = phase3Deps(depsOverride);

    const before = await deps.prisma.shuttleRequest.findFirst({ where: { id, ...scopeWhere(scope) } });
    if (!before) { const e = new Error('Shuttle request not found'); e.status = 404; throw e; }
    if (!OPEN_STATUSES.includes(before.status)) return { request: before, notified: false };

    const request = await this.close(id, 'NO_SHOW', scope, userId, reason, depsOverride);

    let notified = false;
    try {
      const [config, location, zone, reservation] = await Promise.all([
        deps.prisma.shuttleTrackerConfig.findFirst({ where: { locationId: request.locationId, tenantId: request.tenantId } }),
        deps.prisma.location.findFirst({
          where: { id: request.locationId, tenantId: request.tenantId },
          select: { name: true, locationConfig: true }
        }),
        request.pickupSpotZoneId
          ? deps.prisma.shuttleZone.findFirst({
            where: { id: request.pickupSpotZoneId, tenantId: request.tenantId },
            select: { name: true }
          })
          : null,
        deps.prisma.reservation.findFirst({
          where: { id: request.reservationId },
          select: { customer: { select: { locale: true } } }
        })
      ]);

      const mode = config?.mode === 'NON_STOP' ? 'NON_STOP' : 'ON_DEMAND';
      const occurredAt = deps.now();

      // Counter phone: the sede's own number first (same locCfg rule the
      // tracker uses) — global-config fallback deliberately skipped here to
      // keep the fan-out one query lighter; the SMS simply omits the call
      // line when the sede has no number saved.
      let counterPhone = null;
      try {
        const parsed = location?.locationConfig ? JSON.parse(location.locationConfig) : null;
        const phone = String(parsed?.locationPhone || parsed?.companyPhone || '').trim();
        counterPhone = phone && phone !== '(787) 000-0000' ? phone : null;
      } catch { counterPhone = null; }

      // 1) Customer SMS — consent (smsOptIn) + a phone on the request, same
      //    gate as the Phase-2 arrival SMS.
      if (request.smsOptIn === true && String(request.customerPhone || '').trim()) {
        try {
          const smsSend = await resolveSms(deps);
          let brand = null;
          try { brand = await (await resolveBrandFn(deps))({ tenantId: request.tenantId }); } catch { brand = null; }
          await smsSend({
            to: request.customerPhone,
            body: buildNoShowSms({
              mode,
              spotName: zone?.name || null,
              headwayMinutes: config?.headwayMinutes,
              counterPhone,
              brandName: brand?.companyName,
              locale: reservation?.customer?.locale
            }),
            tenantId: request.tenantId
          });
          notified = true;
        } catch (err) {
          deps.logger.info('[shuttle-no-show] customer sms not sent', { tenantId: request.tenantId, requestId: request.id, message: err.message });
        }
      }

      // 2) Staff alert row — the existing feed + toast surface (Screen 17c).
      //    providerRef `noshow:<requestId>` + the (tenantId, providerRef)
      //    unique = one alert per request no matter how many times anything
      //    retries. rawJson carries ids/counts ONLY — no phone, no coords.
      try {
        await deps.prisma.shuttleAlert.create({
          data: {
            tenantId: request.tenantId,
            zoneId: request.pickupSpotZoneId || null,
            vehicleId: request.assignedVehicleId || null,
            type: 'REQUEST_NO_SHOW',
            occurredAt,
            providerRef: `noshow:${request.id}`,
            rawJson: JSON.stringify({
              requestId: request.id,
              customerName: request.customerName,
              partySize: request.partySize,
              bags: request.bags ?? null,
              markedBy: actorContext ? String(actorContext).slice(0, 40) : 'staff'
            })
          }
        });
      } catch (err) {
        if (err?.code !== 'P2002') {
          deps.logger.warn('[shuttle-no-show] alert row insert failed', { tenantId: request.tenantId, requestId: request.id, message: err.message });
        }
      }

      // 2b) Notification Center emitter (2026-09-01) — the envelope for the
      //     staff bell/center. Deduped on the request id (same anchor as the
      //     ShuttleAlert providerRef above), and the OPEN_STATUSES gate at
      //     the top of this function already guarantees one no-show per
      //     request. Safe emit — never breaks the fan-out. The shuttles page
      //     feed/toast above stays untouched; the center only records.
      await (depsOverride.emitNotification || emitNotificationSafe)({
        tenantId: request.tenantId,
        locationId: request.locationId || null,
        severity: 'NEEDS_ACTION',
        sourceType: 'SHUTTLE',
        sourceRefId: request.id,
        title: `Shuttle request no-show${zone?.name ? ` — ${zone.name}` : ''}`,
        body: [
          request.customerName || null,
          request.partySize ? `party of ${request.partySize}` : null,
          location?.name || null,
        ].filter(Boolean).join(' · ') || null,
        deepLink: '/shuttles',
        dedupeKey: `shuttle-noshow:${request.id}`,
        templateKey: 'noShow',
        paramsJson: { stop: zone?.name || location?.name || '' },
      });

      // 3) Optional staff email — EMAIL-channel recipients of the location's
      //    Phase-2 alert list. Best-effort per mailbox.
      const recipients = parseAlertRecipients(config?.alertRecipientsJson).filter((r) => r.channels.includes('EMAIL') && r.email);
      if (recipients.length) {
        const msg = buildNoShowStaffEmail({
          customerName: request.customerName,
          partySize: request.partySize,
          bags: request.bags,
          spotName: zone?.name || null,
          vehicleLabel: null,
          locationName: location?.name || null,
          occurredAt
        });
        for (const r of recipients) {
          try {
            await deps.sendEmail({ tenantId: request.tenantId, to: r.email, subject: msg.subject, text: msg.text });
          } catch (err) {
            deps.logger.warn('[shuttle-no-show] staff email failed', { tenantId: request.tenantId, requestId: request.id, message: err.message });
          }
        }
      }
    } catch (err) {
      deps.logger.warn('[shuttle-no-show] fan-out failed', { requestId: id, message: err.message });
    }

    return { request, notified };
  },

  /**
   * "✓ Recogido" (Screen 17a) — the driver/staff picked the customer up.
   * Thin, named wrapper over the existing COMPLETED close so the future
   * driver surface and today's queue button share one path (and one
   * location-key cleanup).
   */
  async markPickedUp(id, scope = {}, userId = null, reason = null, depsOverride = {}) {
    return this.close(id, 'COMPLETED', scope, userId, reason, depsOverride);
  }
};

/**
 * Check-out closes the loop automatically: the customer is holding the keys,
 * so any open shuttle request for the reservation flips to COMPLETED — nobody
 * has to remember anything. Runs inside the SAME transaction that marks the
 * reservation CHECKED_OUT.
 *
 * Defensive on purpose: `tx.shuttleRequest` is undefined for the few seconds
 * of a rolling deploy where the old Prisma client is still serving — a shuttle
 * row nobody closes is an annoyance, a failed check-out is an incident.
 */
export async function autoCompleteShuttleRequestsOnCheckout(tx, reservationId) {
  if (!reservationId || !tx?.shuttleRequest?.updateMany) return 0;
  const out = await tx.shuttleRequest.updateMany({
    where: { reservationId, status: { in: OPEN_STATUSES } },
    data: { status: 'COMPLETED', closedAt: new Date(), closeReason: 'auto: reservation checked out' }
  });
  return out.count;
}
