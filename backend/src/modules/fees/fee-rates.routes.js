/**
 * Pillar 2 — Per-tenant Fee Rate settings router (16q).
 *
 * Mounted at /api/settings/fee-rates from main.js. The outer settings mount
 * already applies `requireAuth` + `requireModuleAccess('settings')`, so we
 * only need to layer role gates here.
 *
 *   GET  /              — any authenticated user with `settings` access; the
 *                         `editable` boolean in each row tells the UI who can
 *                         actually write.
 *   PUT  /              — ADMIN only (SUPER_ADMIN passes through via
 *                         requireRole's built-in super-admin bypass).
 */

import { Router } from 'express';
import { requireRole, isSuperAdmin } from '../../middleware/auth.js';
import { scopeFor } from '../../lib/tenant-scope.js';
import { feeRatesService } from './fee-rates.service.js';
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
