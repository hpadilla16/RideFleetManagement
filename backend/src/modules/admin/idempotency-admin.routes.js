/**
 * VozIA Fase 6 re-scope (Hector approved, 2026-07-04) — SUPER_ADMIN ops endpoint
 * to resolve a WEDGED idempotency key.
 *
 * A money-kind key (payment/refund) that got stuck IN_PROGRESS past its TTL is
 * deliberately NOT auto-recycled by the idempotency middleware — a retry gets a
 * 409 reconcile. This is correct (it prevents a double-charge / double-refund),
 * but it also means the key stays wedged until a human confirms the true gateway
 * outcome. This endpoint is that manual release valve: AFTER an operator has
 * verified at the gateway whether the money actually moved, they free the key so
 * the customer/agent can proceed.
 *
 * Mounted in main.js as:
 *   app.use('/api/admin/idempotency', requireAuth, requireRole('SUPER_ADMIN'),
 *           idempotencyAdminRouter);
 * (requireRole('SUPER_ADMIN') at the mount is what 403s non-super-admins — the
 * handler below assumes it already ran.)
 *
 * POST /api/admin/idempotency/resolve  { userId, key, force? }
 *   Deletes the WEDGED IdempotencyKey row (userId, key) so the key can be re-used.
 *   - 400 if userId/key missing
 *   - By default only an IN_PROGRESS (stuck) row is freed. Deleting a COMPLETED
 *     row would make the next same-key retry RE-RUN instead of replay — that is
 *     the exact double-money door this whole design closes — so a COMPLETED row
 *     is left intact unless `force:true` is passed explicitly (Innovation review
 *     2026-07-04).
 *   - 200 { ok:true, deleted:<0|1>, skipped?:'completed' } — idempotent: unknown
 *     key returns deleted:0
 *   Every call is logged (who resolved which wedged key).
 *   NOTE: SUPER_ADMIN is the platform-operator role (carries allowCrossTenant), so
 *   this resolve is intentionally cross-tenant — a wedged key is freed by userId+key
 *   regardless of tenant. Consistent with the existing super-admin trust model.
 */
import { Router } from 'express';
import { prisma as defaultPrisma } from '../../lib/prisma.js';
import defaultLogger from '../../lib/logger.js';

// Factory keeps prod usage a one-liner while letting the test inject a fake
// prisma + logger (no query-engine binary, deterministic assertions).
export function createIdempotencyAdminRouter(deps = {}) {
  const prisma = deps.prisma || defaultPrisma;
  const logger = deps.logger || defaultLogger;
  const router = Router();

  router.post('/resolve', async (req, res, next) => {
    try {
      const userId = String(req.body?.userId || '').trim();
      const key = String(req.body?.key || '').trim();
      const force = req.body?.force === true;
      if (!userId || !key) {
        return res.status(400).json({ error: 'userId and key are required' });
      }

      // Default: only free a STUCK (IN_PROGRESS) row. A COMPLETED row is the
      // stored result that makes a retry REPLAY (not re-run) — deleting it
      // re-opens the double-money door, so require an explicit force:true.
      const where = force ? { userId, key } : { userId, key, status: 'IN_PROGRESS' };
      const result = await prisma.idempotencyKey.deleteMany({ where });
      const deleted = Number(result?.count || 0);

      // Distinguish "nothing there" from "left a COMPLETED row alone".
      let skipped;
      if (deleted === 0 && !force) {
        const existing = await prisma.idempotencyKey.findFirst({ where: { userId, key }, select: { status: true } });
        if (existing) skipped = String(existing.status || '').toLowerCase();
      }

      logger.warn('[idempotency-admin] wedged key resolve', {
        targetUserId: userId,
        key,
        deleted,
        force,
        skipped: skipped || null,
        actorUserId: req.user?.id || req.user?.sub || null
      });

      res.json({ ok: true, deleted, ...(skipped ? { skipped } : {}) });
    } catch (e) {
      next(e);
    }
  });

  return router;
}

// Default export used by main.js.
export const idempotencyAdminRouter = createIdempotencyAdminRouter();
