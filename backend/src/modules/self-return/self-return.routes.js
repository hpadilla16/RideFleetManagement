/**
 * QR self-return routes (Hector, 2026-09-02).
 *
 * PUBLIC half — mounted at /api/public/self-return, NO auth: the per-location
 * QR token is the whole identity, exactly like /api/public/shuttle. Unknown,
 * revoked, disabled, re-tenanted — all the same bare 404. The submit's pair
 * mismatches are ALSO that same 404: the form is never an existence oracle.
 *
 * ADMIN half — mounted at /api/self-return behind requireAuth + module gate
 * (main.js); the mutating QR routes take the settings-author tier
 * (SUPER_ADMIN/ADMIN/OPS — same as the shuttle tracker config), and the
 * stamp void takes the backdate-tier role gate + an audit row.
 */
import { Router } from 'express';
import {
  attachPublicRequestMeta,
  createPublicRateLimitGuard,
} from '../../middleware/public-endpoint-guards.js';
import { requireRole } from '../../middleware/auth.js';
import { scopeFor } from '../../lib/tenant-scope.js';
import { auditFromReq, AUDIT_ACTIONS } from '../audit/audit.service.js';
import { selfReturnService } from './self-return.service.js';
import { canVoidSelfReturn, selfReturnVoidNote } from './self-return.js';

// ─── public ─────────────────────────────────────────────────────────────────

export const selfReturnPublicRouter = Router();

// The page loads once per scan; 30/min absorbs a parking lot of phones
// behind one NAT without inviting enumeration.
const readGuards = [
  attachPublicRequestMeta('public-self-return'),
  createPublicRateLimitGuard({ name: 'public-self-return', maxRequests: 30, windowMs: 60 * 1000 }),
];

// Submits are rare by nature (one per returned car); 5/min matches the
// public shuttle-request button and starves a pair-guessing loop.
const submitGuards = [
  attachPublicRequestMeta('public-self-return-submit'),
  createPublicRateLimitGuard({ name: 'public-self-return-submit', maxRequests: 5, windowMs: 60 * 1000 }),
];

/** Page context: the location's name, nothing else. */
selfReturnPublicRouter.get('/:token', readGuards, async (req, res, next) => {
  try {
    const out = await selfReturnService.publicContext(req.params.token);
    if (!out) return res.status(404).json({ error: 'Not found' });
    res.setHeader('Cache-Control', 'no-store');
    res.json(out);
  } catch (e) { next(e); }
});

/**
 * "Devolví el carro" — { reservationNumber, lastName }. Success returns the
 * recorded time (and `already: true` on a re-scan, which keeps the FIRST
 * stamp). EVERY mismatch is the same generic 404 body a bad token gets.
 */
selfReturnPublicRouter.post('/:token/submit', submitGuards, async (req, res, next) => {
  try {
    const out = await selfReturnService.submitReturn(req.params.token, {
      reservationNumber: req.body?.reservationNumber,
      lastName: req.body?.lastName,
      meta: {
        ip: req.publicRequestMeta?.ip || req.ip || null,
        userAgent: req.get('user-agent') || null,
      },
    });
    if (!out || out.notFound) return res.status(404).json({ error: 'Not found' });
    res.setHeader('Cache-Control', 'no-store');
    res.json({ ok: true, already: out.already === true, reportedAt: out.reportedAt });
  } catch (e) { next(e); }
});

// ─── admin ──────────────────────────────────────────────────────────────────

export const selfReturnAdminRouter = Router();

// Same tier as the shuttle-tracker config PUT: turning a public surface on
// for a sede is settings authorship, not floor work.
const requireSettingsAuthor = requireRole('SUPER_ADMIN', 'ADMIN', 'OPS');

/** Is the QR on for this location, and the poster's link when it is. */
selfReturnAdminRouter.get('/locations/:locationId/qr', async (req, res, next) => {
  try {
    res.json(await selfReturnService.qrStatus(req.params.locationId, scopeFor(req)));
  } catch (e) {
    if (e?.status === 404) return res.status(404).json({ error: e.message });
    if (e?.status === 400) return res.status(400).json({ error: e.message });
    next(e);
  }
});

/** Enable (mint). Re-enabling after a disable mints a NEW token — old
 *  posters die. Audited: this opens a public write surface for the sede. */
selfReturnAdminRouter.post('/locations/:locationId/qr', requireSettingsAuthor, async (req, res, next) => {
  try {
    const out = await selfReturnService.enableQr(req.params.locationId, scopeFor(req), req.user?.sub || null);
    auditFromReq(req, {
      action: AUDIT_ACTIONS.SELF_RETURN_QR_ENABLE,
      targetType: 'LOCATION',
      targetId: String(req.params.locationId),
      metadata: { enabled: true },
    });
    res.status(201).json(out);
  } catch (e) {
    if (e?.status === 404) return res.status(404).json({ error: e.message });
    if (e?.status === 400) return res.status(400).json({ error: e.message });
    next(e);
  }
});

/** Disable — the poster dies now. Idempotent; audited. */
selfReturnAdminRouter.delete('/locations/:locationId/qr', requireSettingsAuthor, async (req, res, next) => {
  try {
    const out = await selfReturnService.disableQr(req.params.locationId, scopeFor(req));
    auditFromReq(req, {
      action: AUDIT_ACTIONS.SELF_RETURN_QR_DISABLE,
      targetType: 'LOCATION',
      targetId: String(req.params.locationId),
      metadata: { enabled: false },
    });
    res.json(out);
  } catch (e) {
    if (e?.status === 400) return res.status(400).json({ error: e.message });
    next(e);
  }
});

/**
 * Void a customer return stamp (invariant d) — ADMIN-class only, the SAME
 * role set that may backdate a check-in (both move late-fee money). The
 * stamp is never deleted: void keeps the timestamp and the trail, and
 * check-in close simply stops honoring it. Audit-logged with the stamp time
 * and the stated reason.
 */
selfReturnAdminRouter.post('/reservations/:reservationId/void', async (req, res, next) => {
  try {
    if (!canVoidSelfReturn(req.user?.role)) {
      return res.status(403).json({ error: 'Only an admin can void a customer return stamp' });
    }
    const row = await selfReturnService.voidStamp(req.params.reservationId, {
      scope: scopeFor(req),
      userId: req.user?.sub || null,
      reason: req.body?.reason,
    });
    auditFromReq(req, {
      action: AUDIT_ACTIONS.SELF_RETURN_VOID,
      targetType: 'RESERVATION',
      targetId: row.id,
      metadata: {
        reportedAt: row.customerReportedReturnAt ? new Date(row.customerReportedReturnAt).toISOString() : null,
        reason: row.customerReportedReturnVoidReason || null,
        note: selfReturnVoidNote({ reportedAt: row.customerReportedReturnAt, reason: row.customerReportedReturnVoidReason }),
      },
    });
    res.json({
      ok: true,
      reservationId: row.id,
      voidedAt: row.customerReportedReturnVoidedAt,
    });
  } catch (e) {
    if (e?.status === 404) return res.status(404).json({ error: e.message });
    if (e?.status === 409) return res.status(409).json({ error: e.message, code: e.code || null });
    next(e);
  }
});
