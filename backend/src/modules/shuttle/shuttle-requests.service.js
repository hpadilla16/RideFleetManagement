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

const OPEN_STATUSES = ['READY', 'VIEWED'];

function scopeWhere(scope = {}) {
  const where = {};
  if (scope?.tenantId) where.tenantId = scope.tenantId;
  const locationIds = Array.isArray(scope?.allowedLocationIds) ? scope.allowedLocationIds.filter(Boolean) : [];
  // Location-scoped users see their sedes only; an empty list means unscoped
  // (tenant-wide), matching userAllowedLocationIds semantics elsewhere.
  if (locationIds.length) where.locationId = { in: locationIds.map(String) };
  return where;
}

export const shuttleRequestsService = {
  /**
   * Create — or absorb into the existing open request for the reservation.
   * Caller (the route) has already resolved+validated tenant/reservation.
   */
  async create({ tenantId, locationId, reservationId, customerName, customerPhone, partySize, pickupNote }) {
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
        pickupNote: String(pickupNote || '').trim() || null
      }
    });
    return { request, deduplicated: false };
  },

  /** The sede queue. `open` (default) = READY + VIEWED, newest first. */
  async list(scope = {}, { status = 'open', limit = 50 } = {}) {
    const where = scopeWhere(scope);
    const wanted = String(status || 'open').toLowerCase();
    if (wanted === 'open') where.status = { in: OPEN_STATUSES };
    else if (wanted !== 'all') where.status = String(status).toUpperCase();
    const rows = await prisma.shuttleRequest.findMany({
      where,
      orderBy: [{ createdAt: 'asc' }],
      take: Math.min(200, Math.max(1, Number(limit) || 50)),
      include: {
        reservation: { select: { reservationNumber: true } },
        location: { select: { id: true, name: true, code: true } }
      }
    });
    return { rows, openCount: rows.filter((r) => OPEN_STATUSES.includes(r.status)).length };
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
