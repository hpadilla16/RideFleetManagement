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

export const shuttleRequestsService = {
  /**
   * Create — or absorb into the existing open request for the reservation.
   * Caller (the route) has already resolved+validated tenant/reservation.
   */
  async create({ tenantId, locationId, reservationId, customerName, customerPhone, partySize, pickupNote, source = null }) {
    if (!tenantId || !locationId || !reservationId) throw new Error('tenantId, locationId and reservationId are required');

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
          customerPhone: String(customerPhone || '').trim() || existing.customerPhone
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
        source: source ? String(source).trim() : null
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
    const enriched = rows.map((r) => ({
      ...r,
      viewedByName: r.viewedByUserId ? usersById[r.viewedByUserId] || null : null,
      closedByName: r.closedByUserId ? usersById[r.closedByUserId] || null : null
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

  async close(id, outcome, scope = {}, userId = null, reason = null) {
    const status = String(outcome || '').toUpperCase();
    if (!['CANCELLED', 'NO_SHOW', 'COMPLETED'].includes(status)) throw new Error(`Invalid close outcome ${outcome}`);
    const row = await prisma.shuttleRequest.findFirst({ where: { id, ...scopeWhere(scope) } });
    if (!row) { const e = new Error('Shuttle request not found'); e.status = 404; throw e; }
    if (!OPEN_STATUSES.includes(row.status)) return row;
    return prisma.shuttleRequest.update({
      where: { id: row.id },
      data: { status, closedAt: new Date(), closedByUserId: userId || null, closeReason: reason ? String(reason).trim() : null }
    });
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
