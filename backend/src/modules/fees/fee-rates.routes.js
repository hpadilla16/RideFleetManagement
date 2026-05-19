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

// Helper — merge ?locationId= from the query string into the tenant scope so
// downstream service calls see it. Empty / "null" / undefined collapse to null,
// which means "tenant default". String values are trimmed.
function scopeWithLocation(req) {
  const base = scopeFor(req);
  const raw = req.query?.locationId;
  if (raw === undefined || raw === null) return base;
  const s = String(raw).trim();
  if (!s || s === 'null' || s === 'undefined') return base;
  return { ...base, locationId: s };
}

feeRatesRouter.get('/', async (req, res, next) => {
  try {
    const scope = scopeWithLocation(req);
    const rows = await feeRatesService.listForScope(scope, { editable: isEditor(req.user) });
    res.json({ rates: rows, locationId: scope.locationId || null });
  } catch (e) {
    next(e);
  }
});

// GET /effective — the merged (location > tenant > hardcoded) view used by the
// UI to preview what will actually be charged at a location. Anyone authenticated
// can read; the per-row `editable` boolean is informational only here.
feeRatesRouter.get('/effective', async (req, res, next) => {
  try {
    const scope = scopeWithLocation(req);
    const rows = await feeRatesService.listEffective(scope, { editable: isEditor(req.user) });
    res.json({ rates: rows, locationId: scope.locationId || null });
  } catch (e) {
    next(e);
  }
});

// GET /locations-with-overrides — distinct locationIds (within the tenant)
// that have at least one FeeRate row. Lets the UI flag those locations in the
// selector without fetching each location's rates.
feeRatesRouter.get('/locations-with-overrides', async (req, res, next) => {
  try {
    const scope = scopeFor(req);
    const rows = await feeRatesService.listLocationsWithOverrides(scope);
    res.json({ locations: rows });
  } catch (e) {
    next(e);
  }
});

feeRatesRouter.put('/', requireRole('ADMIN'), async (req, res, next) => {
  try {
    const scope = scopeWithLocation(req);
    const rows = await feeRatesService.bulkUpsert(req.body || {}, scope, {
      actorUserId: req.user?.id || null,
      actor: {
        id: req.user?.id || null,
        email: req.user?.email || null,
        role: req.user?.role || null
      },
      editable: isEditor(req.user)
    });
    res.json({ rates: rows, locationId: scope.locationId || null });
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
  } catch (e) { next(e); }
});

// DELETE /:feeType — remove a single per-location override row. Tenant default
// rows are NOT deletable from this endpoint (use PUT with isActive=false instead).
feeRatesRouter.delete('/:feeType', requireRole('ADMIN'), async (req, res, next) => {
  try {
    const scope = scopeWithLocation(req);
    const result = await feeRatesService.deleteOverride(
      scope,
      { feeType: String(req.params.feeType || '') },
      { actorUserId: req.user?.id || null }
    );
    res.json({ ok: true, deleted: !!result.deleted });
  } catch (e) {
    next(e);
  }
});
