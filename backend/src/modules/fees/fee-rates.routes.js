/**
 * Pillar 2 — Per-tenant Fee Rate settings router (16q).
 *
 * Mounted at /api/settings/fee-rates from main.js with `requireAuth` only —
 * NOT requireModuleAccess('settings'), because the checkin wizard's live fee
 * preview (run by OPS/AGENT, who don't always have the settings module) needs
 * to read the tenant overrides to mirror what the backend will charge.
 *
 *   GET  /              — any authenticated user; the `editable` boolean
 *                         in each row tells the UI who can actually write.
 *   PUT  /              — ADMIN only (SUPER_ADMIN passes through via
 *                         requireRole's built-in super-admin bypass).
 */

import { Router } from 'express';
import { requireRole, isSuperAdmin } from '../../middleware/auth.js';
import { scopeFor } from '../../lib/tenant-scope.js';
import { feeRatesService } from './fee-rates.service.js';
import { listAuditLog as listFeeRateAuditLog } from './fee-rate-audit.service.js';
import { ValidationError } from '../../lib/errors.js';

export const feeRatesRouter = Router();

function isEditor(user) {
  return isSuperAdmin(user) || String(user?.role || '').toUpperCase() === 'ADMIN';
}

feeRatesRouter.get('/', async (req, res, next) => {
  try {
    const scope = scopeFor(req);
    const rows = await feeRatesService.listForScope(scope, { editable: isEditor(req.user) });
    res.json({ rates: rows });
  } catch (e) {
    next(e);
  }
});

feeRatesRouter.put('/', requireRole('ADMIN'), async (req, res, next) => {
  try {
    const scope = scopeFor(req);
    const rows = await feeRatesService.bulkUpsert(req.body || {}, scope, {
      actorUserId: req.user?.id || null,
      actor: {
        id: req.user?.id || null,
        email: req.user?.email || null,
        role: req.user?.role || null
      },
      editable: isEditor(req.user)
    });
    res.json({ rates: rows });
  } catch (e) {
    // Validation errors with a `details` field carry per-row error info; surface
    // it in the response body. The global appErrorHandler still applies the
    // ValidationError status (400) for everything else.
    if (e instanceof ValidationError && Array.isArray(e.details)) {
      return res.status(400).json({ error: e.message, errors: e.details });
    }
    next(e);
  }
});

// V2 (pillar2 followup): GET /audit — return the FeeRateAuditLog rows for the
// tenant scope. Same auth model as GET /: any authenticated user (settings
// module isn't required so the checkin live-preview can still resolve), but
// the route always filters by the resolved tenant scope so a tenanted user
// can never see another tenant's history.
feeRatesRouter.get('/audit', async (req, res, next) => {
  try {
    const scope = scopeFor(req);
    if (!scope || !scope.tenantId || scope.tenantId === '__no_tenant__') {
      return res.status(400).json({ error: 'tenantId required for fee rate audit log' });
    }
    const limit = Math.max(1, Math.min(500, Number(req.query?.limit) || 50));
    const offset = Math.max(0, Number(req.query?.offset) || 0);
    const feeRateId = req.query?.feeRateId ? String(req.query.feeRateId) : null;
    const entries = await listFeeRateAuditLog({
      tenantId: scope.tenantId,
      limit,
      offset,
      feeRateId
    });
    res.json({ entries, limit, offset });
  } catch (e) {
    next(e);
  }
});
