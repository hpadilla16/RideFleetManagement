import { Router } from 'express';
import { storeBoardService } from './store-board.service.js';
import { crossTenantScopeFor as scopeFor } from '../../lib/tenant-scope.js';

/**
 * Authenticated admin CRUD for kiosk tokens.
 *
 * Mounted at `/api/store-board` from main.js (behind requireAuth +
 * requireRole('SUPER_ADMIN', 'ADMIN', 'OPS') — set at the route mount).
 *
 *   POST   /api/store-board/tokens           — mint new token for { locationId, label }
 *   GET    /api/store-board/tokens           — list this tenant's tokens
 *   POST   /api/store-board/tokens/:id/revoke — revoke a token
 *
 * SUPER_ADMIN may pass ?tenantId= to operate cross-tenant. Otherwise
 * the JWT's tenantId is used.
 */
export const storeBoardRouter = Router();

function resolveTenantId(req) {
  const scope = scopeFor(req);
  // crossTenantScopeFor returns {} for SUPER_ADMIN with no tenant filter.
  // Refuse mint/list without an explicit tenantId in that case — kiosk
  // tokens are tenant-scoped data; we don't want a SUPER_ADMIN to create
  // them in the void.
  if (scope?.tenantId) return scope.tenantId;
  if (req.query?.tenantId) return String(req.query.tenantId);
  if (req.body?.tenantId) return String(req.body.tenantId);
  return null;
}

storeBoardRouter.post('/tokens', async (req, res, next) => {
  try {
    const tenantId = resolveTenantId(req);
    if (!tenantId) {
      return res.status(400).json({ error: 'tenantId is required (super-admin must pass ?tenantId=)' });
    }
    const { locationId, label } = req.body || {};
    if (!locationId) return res.status(400).json({ error: 'locationId is required' });
    if (!label) return res.status(400).json({ error: 'label is required' });

    const row = await storeBoardService.mintToken({
      tenantId,
      locationId: String(locationId),
      label: String(label),
      createdBy: req.user?.sub || null
    });
    res.status(201).json(row);
  } catch (e) {
    if (e?.statusCode === 404) return res.status(404).json({ error: e.message });
    if (/required/i.test(String(e?.message || ''))) return res.status(400).json({ error: e.message });
    next(e);
  }
});

storeBoardRouter.get('/tokens', async (req, res, next) => {
  try {
    const tenantId = resolveTenantId(req);
    if (!tenantId) {
      return res.status(400).json({ error: 'tenantId is required (super-admin must pass ?tenantId=)' });
    }
    const includeRevoked = String(req.query?.includeRevoked || '').toLowerCase() === 'true';
    const rows = await storeBoardService.listTokens({ tenantId, includeRevoked });
    res.json(rows);
  } catch (e) {
    next(e);
  }
});

storeBoardRouter.post('/tokens/:id/revoke', async (req, res, next) => {
  try {
    const tenantId = resolveTenantId(req);
    if (!tenantId) {
      return res.status(400).json({ error: 'tenantId is required (super-admin must pass ?tenantId=)' });
    }
    const row = await storeBoardService.revokeToken({ id: req.params.id, tenantId });
    res.json(row);
  } catch (e) {
    if (e?.statusCode === 404) return res.status(404).json({ error: e.message });
    next(e);
  }
});
