/**
 * Admin GDPR customer-EXPORT route (Phase B).
 *
 *   GET /api/admin/customers/:id/export
 *     → 200 application/json   the full data-subject export (see
 *                              customer-export.service.js) — read-only
 *     → 400 bad/missing id
 *     → 404 customer not found (within the caller's tenant scope)
 *
 * Mounted in main.js as a SIBLING of the erase router, on the same base with the
 * same guards:
 *   app.use('/api/admin/customers',
 *     requireAuth, requireRole('ADMIN'), tenantRateLimit, customerExportRouter);
 *
 * SAFETY:
 *   - READ-ONLY — the service mutates nothing (no destructive flag needed).
 *   - Tenant scope is fail-closed via scopeFor(req): a tenant ADMIN can only
 *     reach customers in their own tenant (cross-tenant → 404); SUPER_ADMIN may
 *     target a tenant via ?tenantId.
 *   - No PII in the URL/query string — only the customer id travels in the path.
 *   - Storage-backed media is returned as SHORT-TTL signed URLs, never raw paths.
 */

import { Router } from 'express';
import { scopeFor } from '../../lib/tenant-scope.js';
import { exportCustomer, CustomerNotFoundError } from '../customers/customer-export.service.js';

export const customerExportRouter = Router();

customerExportRouter.get('/:id/export', async (req, res) => {
  try {
    const customerId = String(req.params.id || '').trim();
    if (!customerId) {
      return res.status(400).json({ error: 'customer id is required' });
    }

    const report = await exportCustomer(customerId, {
      actor: req.user?.email || req.user?.id || 'admin',
      scope: scopeFor(req),
    });

    // Full-PII payload: never let a browser or intermediary cache it.
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Pragma', 'no-cache');
    // Downloadable snapshot; the filename carries only the opaque id (not PII).
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="customer-${customerId}-export.json"`);
    return res.status(200).json(report);
  } catch (err) {
    if (err instanceof CustomerNotFoundError) {
      return res.status(404).json({ error: err.message, code: err.code });
    }
    const status = err.statusCode || err.status || 500;
    return res.status(status).json({ error: err.message || 'Internal server error' });
  }
});

export default customerExportRouter;
