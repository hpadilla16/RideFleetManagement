/**
 * Shuttle Requests routes (Valet arc, 2026-08-05).
 *
 * POST / is Chloe's write — it runs under a service account, so it follows the
 * VozIA write contract: author + ticketId required, body replaced by a
 * whitelist (the email-agreement QA round proved that deleting one field and
 * trusting the rest leaves the remainder injectable), and the reservation is
 * re-validated server-side even though Valet validates before calling. Trust
 * their validation for UX; never for writes.
 *
 * Reads and the view/cancel/no-show actions are for RFM floor staff, scoped by
 * User.locationIds — a Mayagüez agent never sees Ponce's queue.
 */
import { Router } from 'express';
import { scopeFor, userAllowedLocationIds } from '../../lib/tenant-scope.js';
import { shuttleRequestsService } from './shuttle-requests.service.js';
import { prisma } from '../../lib/prisma.js';
import { auditFromReq, AUDIT_ACTIONS } from '../audit/audit.service.js';

export const shuttleRequestsRouter = Router();

function staffScope(req) {
  return {
    ...scopeFor(req),
    allowedLocationIds: userAllowedLocationIds(req.user)
  };
}

shuttleRequestsRouter.post('/', async (req, res, next) => {
  try {
    const body = req.body || {};
    if (req.user?.isServiceAccount) {
      const author = String(body.author || '').trim();
      const ticketId = String(body.ticketId || '').trim();
      if (!author || !ticketId) {
        return res.status(400).json({ error: 'author and ticketId are required for service accounts' });
      }
    }

    const reservationId = String(body.reservationId || '').trim();
    const locationId = String(body.locationId || '').trim();
    if (!reservationId || !locationId) {
      return res.status(400).json({ error: 'reservationId and locationId are required' });
    }

    // Re-validate what Chloe already checked. The reservation must exist, be
    // pickup-able (not cancelled/closed) and belong to the sede that will
    // dispatch — a mismatch sends an empty bus to a curb.
    const reservation = await prisma.reservation.findFirst({
      where: { id: reservationId },
      select: {
        id: true,
        tenantId: true,
        status: true,
        pickupLocationId: true,
        reservationNumber: true,
        customer: { select: { firstName: true, lastName: true } }
      }
    });
    if (!reservation) return res.status(404).json({ error: 'Reservation not found' });
    const scope = scopeFor(req);
    if (scope?.tenantId && reservation.tenantId !== scope.tenantId) {
      return res.status(404).json({ error: 'Reservation not found' });
    }
    if (['CANCELLED', 'NO_SHOW', 'CHECKED_IN', 'CHECKED_IN_UNPAID'].includes(String(reservation.status || '').toUpperCase())) {
      return res.status(409).json({ error: `Reservation is ${reservation.status} — no shuttle needed` });
    }
    if (reservation.pickupLocationId && String(reservation.pickupLocationId) !== locationId) {
      return res.status(409).json({ error: 'Reservation pickup location does not match the requested sede' });
    }

    const customerName = [reservation.customer?.firstName, reservation.customer?.lastName].filter(Boolean).join(' ')
      || String(body.customerName || '').trim();

    const { request, deduplicated } = await shuttleRequestsService.create({
      tenantId: reservation.tenantId,
      locationId,
      reservationId,
      customerName,
      customerPhone: body.customerPhone,
      partySize: body.partySize,
      pickupNote: body.pickupNote
    });

    await prisma.auditLog.create({
      data: {
        reservationId,
        actorUserId: req.user?.sub || null,
        action: deduplicated ? 'SHUTTLE_REQUEST_REPEAT_CALL' : 'SHUTTLE_REQUEST_CREATED',
        reason: JSON.stringify({
          source: req.user?.isServiceAccount ? 'vozia' : 'staff',
          author: String(body.author || '').trim() || null,
          ticketId: String(body.ticketId || '').trim() || null,
          partySize: request.partySize,
          callCount: request.callCount
        })
      }
    }).catch(() => null);

    res.status(deduplicated ? 200 : 201).json({
      id: request.id,
      status: request.status,
      callCount: request.callCount,
      deduplicated,
      reservationNumber: reservation.reservationNumber
    });
  } catch (e) {
    next(e);
  }
});

shuttleRequestsRouter.get('/', async (req, res, next) => {
  try {
    res.json(await shuttleRequestsService.list(staffScope(req), {
      status: req.query?.status,
      limit: req.query?.limit,
      page: req.query?.page,
      from: req.query?.from,
      to: req.query?.to,
      locationId: req.query?.locationId
    }));
  } catch (e) {
    next(e);
  }
});

shuttleRequestsRouter.post('/:id/view', async (req, res, next) => {
  try {
    res.json(await shuttleRequestsService.markViewed(String(req.params.id), staffScope(req), req.user?.sub || null));
  } catch (e) {
    if (e?.status === 404) return res.status(404).json({ error: e.message });
    next(e);
  }
});

// COMPLETED by a human (2026-08-07 spec): the driver picked the customer up
// and the contract has not checked out yet. The service's close() already
// knew the outcome — only this route was missing. closedByUserId is ALWAYS
// the authenticated user; nothing from the payload can impersonate.
shuttleRequestsRouter.post('/:id/complete', async (req, res, next) => {
  try {
    res.json(await shuttleRequestsService.close(String(req.params.id), 'COMPLETED', staffScope(req), req.user?.sub || null, req.body?.reason));
  } catch (e) {
    if (e?.status === 404) return res.status(404).json({ error: e.message });
    next(e);
  }
});

// Delay notice: email the waiting customer. 409 NO_EMAIL carries the phone so
// the UI can offer the call instead of failing silently.
shuttleRequestsRouter.post('/:id/notify-delay', async (req, res, next) => {
  try {
    res.json(await shuttleRequestsService.notifyDelay(
      String(req.params.id),
      { reason: req.body?.reason, etaMinutes: req.body?.etaMinutes },
      staffScope(req),
      req.user?.sub || null
    ));
  } catch (e) {
    if (e?.status === 404) return res.status(404).json({ error: e.message });
    if (e?.status === 409) return res.status(409).json({ error: e.message, code: e.code || null, customerPhone: e.customerPhone || null });
    if (e?.status === 503) return res.status(503).json({ error: e.message });
    next(e);
  }
});

shuttleRequestsRouter.post('/:id/cancel', async (req, res, next) => {
  try {
    res.json(await shuttleRequestsService.close(String(req.params.id), 'CANCELLED', staffScope(req), req.user?.sub || null, req.body?.reason));
  } catch (e) {
    if (e?.status === 404) return res.status(404).json({ error: e.message });
    next(e);
  }
});

// Phase 3 (Screen 17): the same close, now with the fan-out behind it —
// mode-aware customer SMS, a REQUEST_NO_SHOW row in the alert feed, and the
// optional staff recipients email. The response keeps the row shape the
// queue UI already reads (fan-out details stay server-side).
shuttleRequestsRouter.post('/:id/no-show', async (req, res, next) => {
  try {
    const out = await shuttleRequestsService.markNoShow(String(req.params.id), {
      scope: staffScope(req),
      userId: req.user?.sub || null,
      reason: req.body?.reason,
      actorContext: 'staff',
    });
    res.json(out.request);
  } catch (e) {
    if (e?.status === 404) return res.status(404).json({ error: e.message });
    next(e);
  }
});

// Alias of /complete in driver vocabulary ("✓ Recogido", Screen 17a) — the
// Phase-3 driver surface will speak this name; both hit markPickedUp.
shuttleRequestsRouter.post('/:id/picked-up', async (req, res, next) => {
  try {
    res.json(await shuttleRequestsService.markPickedUp(String(req.params.id), staffScope(req), req.user?.sub || null, req.body?.reason));
  } catch (e) {
    if (e?.status === 404) return res.status(404).json({ error: e.message });
    next(e);
  }
});

/**
 * Manual assignment (Phase 3, Screen 8a) — staff pins one configured shuttle
 * to an open request. Same gate as every queue action (requireAuth + module
 * access via main.js; scope narrows by User.locationIds). The service is
 * fail-closed on tenant/config; the audit row records who pinned what —
 * assignment decides which vehicle's GPS a customer page shows, so it is a
 * mutation worth a trail (same reasoning as ZONE_*).
 */
shuttleRequestsRouter.post('/:id/assign', async (req, res, next) => {
  try {
    const row = await shuttleRequestsService.assign(String(req.params.id), req.body?.vehicleId, staffScope(req), req.user?.sub || null);
    auditFromReq(req, {
      action: AUDIT_ACTIONS.SHUTTLE_ASSIGN,
      targetType: 'SHUTTLE_REQUEST',
      targetId: row.id,
      metadata: { vehicleId: row.assignedVehicleId, locationId: row.locationId },
    });
    res.json(row);
  } catch (e) {
    if (e?.status === 404) return res.status(404).json({ error: e.message });
    if (e?.status === 400 || e?.status === 409) return res.status(e.status).json({ error: e.message });
    next(e);
  }
});

shuttleRequestsRouter.delete('/:id/assign', async (req, res, next) => {
  try {
    const row = await shuttleRequestsService.unassign(String(req.params.id), staffScope(req), req.user?.sub || null);
    auditFromReq(req, {
      action: AUDIT_ACTIONS.SHUTTLE_UNASSIGN,
      targetType: 'SHUTTLE_REQUEST',
      targetId: row.id,
      metadata: { locationId: row.locationId },
    });
    res.json(row);
  } catch (e) {
    if (e?.status === 404) return res.status(404).json({ error: e.message });
    next(e);
  }
});
