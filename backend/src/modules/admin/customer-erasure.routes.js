/**
 * Admin GDPR customer-erasure route.
 *
 *   POST /api/admin/customers/:id/erase
 *     body: { reason: string (required, non-empty), dryRun?: boolean (default true) }
 *     → 200 { report }        the structured erasure plan (dry-run) or result (live)
 *     → 400 reason missing / bad id
 *     → 404 customer not found (within the caller's tenant scope)
 *     → 503 GDPR_ERASURE_ENABLED is off  (SACRED INVARIANT #1)
 *
 * Mounted in main.js:
 *   app.use('/api/admin/customers',
 *     requireAuth, requireRole('ADMIN'), tenantRateLimit, customerErasureRouter);
 *
 * SACRED INVARIANTS enforced here + in the service:
 *   1. OFF BY DEFAULT — while GDPR_ERASURE_ENABLED is off, this endpoint 503s
 *      and the service refuses to mutate.
 *   2. DRY-RUN BY DEFAULT — dryRun defaults to true; only an explicit
 *      dryRun:false (AND the flag on) mutates.
 *
 * Tenant scope is fail-closed via scopeFor(req): a tenant ADMIN can only reach
 * customers in their own tenant; SUPER_ADMIN may target a tenant via ?tenantId.
 */

import { Router } from 'express';
import { scopeFor } from '../../lib/tenant-scope.js';
import {
  eraseCustomer,
  gdprErasureEnabled,
  ErasureNotEnabledError,
  CustomerNotFoundError,
} from '../customers/customer-erasure.service.js';

export const customerErasureRouter = Router();

customerErasureRouter.post('/:id/erase', async (req, res) => {
  try {
    // SACRED INVARIANT #1 — endpoint 503s while the flag is off, before any
    // work (so even a dry-run request cannot probe a disabled service).
    if (!gdprErasureEnabled()) {
      return res.status(503).json({ error: 'erasure not enabled', code: 'ERASURE_NOT_ENABLED' });
    }

    const customerId = String(req.params.id || '').trim();
    if (!customerId) {
      return res.status(400).json({ error: 'customer id is required' });
    }

    const reason = typeof req.body?.reason === 'string' ? req.body.reason.trim() : '';
    if (!reason) {
      return res.status(400).json({ error: 'reason is required (non-empty) — erasure is audited' });
    }

    // DRY-RUN BY DEFAULT — only an explicit boolean false turns it into a
    // real mutation. Any other value (including undefined) stays a dry run.
    const dryRun = req.body?.dryRun !== false;

    const report = await eraseCustomer(customerId, {
      actor: req.user?.email || req.user?.id || 'admin',
      reason,
      dryRun,
      scope: scopeFor(req),
    });

    return res.status(200).json({ report });
  } catch (err) {
    if (err instanceof ErasureNotEnabledError) {
      return res.status(503).json({ error: err.message, code: err.code });
    }
    if (err instanceof CustomerNotFoundError) {
      return res.status(404).json({ error: err.message, code: err.code });
    }
    const status = err.statusCode || err.status || 500;
    return res.status(status).json({ error: err.message || 'Internal server error' });
  }
});

export default customerErasureRouter;
