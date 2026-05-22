/**
 * Tenant feature-flag admin routes (2026-05-21 — project convention).
 *
 * Mounted in main.js as:
 *   app.use('/api/admin/tenants', requireAuth, requireRole('SUPER_ADMIN'), tenantFlagsAdminRouter);
 *   app.use('/api/me', requireAuth, currentUserFlagsRouter);
 *
 * Final paths:
 *   GET    /api/admin/tenants/:id/feature-flags
 *     Returns { flags: { flagName: state }, audit: TenantAuditLog[] }
 *   PATCH  /api/admin/tenants/:id/feature-flags
 *     Body: { flagName: 'OFF'|'TEST'|'LIVE', otherFlag: 'OFF', ... }
 *     Returns { changes: [{ flag, from, to, at, noop }, ...] }
 *   GET    /api/me/feature-flags
 *     For frontend resolver. Returns { flags: { flagName: bool }, effectiveStates: { flagName: state } }
 *     The boolean already applies the TEST-mode role gate.
 *
 * Spec: doc/feature-flag-convention.md
 */

import { Router } from 'express';
import {
  getTenantFlags,
  setTenantFlag,
  listTenantAuditLog,
  resolveFlag,
  FeatureFlagError,
  AUDIT_ACTION_FLAG_CHANGED,
} from '../../lib/feature-flags.js';

// ===========================================================================
// SUPER_ADMIN router — mounted under /api/admin/tenants
// ===========================================================================

export const tenantFlagsAdminRouter = Router();

function sendError(res, err) {
  if (err instanceof FeatureFlagError) {
    return res.status(err.status || 400).json({ error: err.message });
  }
  return res.status(500).json({ error: err?.message || 'Internal server error' });
}

tenantFlagsAdminRouter.get('/:id/feature-flags', async (req, res) => {
  try {
    const tenantId = req.params.id;
    const [flags, audit] = await Promise.all([
      getTenantFlags(tenantId),
      listTenantAuditLog(tenantId, {
        action: AUDIT_ACTION_FLAG_CHANGED,
        limit: 20,
        includeActor: true,
      }),
    ]);
    res.json({ flags, audit });
  } catch (err) {
    sendError(res, err);
  }
});

tenantFlagsAdminRouter.patch('/:id/feature-flags', async (req, res) => {
  try {
    const tenantId = req.params.id;
    const body = req.body || {};
    if (typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length === 0) {
      return res.status(400).json({
        error: 'Body must be a non-empty object of { flagName: state } pairs',
      });
    }
    // Apply each flag sequentially. The transaction is per-flag (atomic);
    // if a later flag fails, earlier ones are already persisted. For V1
    // this is fine — bulk-set is rare. If we need full-or-nothing later,
    // we can wrap the whole PATCH in an outer transaction.
    const changes = [];
    const actorUserId = req.user?.sub || req.user?.id || null;
    for (const [flagName, value] of Object.entries(body)) {
      const change = await setTenantFlag(tenantId, flagName, value, { actorUserId });
      changes.push(change);
    }
    res.json({ changes });
  } catch (err) {
    sendError(res, err);
  }
});

// ===========================================================================
// Current-user router — mounted under /api/me
// ===========================================================================

export const currentUserFlagsRouter = Router();

/**
 * GET /api/me/feature-flags
 *
 * The frontend resolver. Returns:
 *   {
 *     flags: { interactiveTC: false, dejavooCounter: true, ... },   // bool — TEST role gate applied
 *     effectiveStates: { interactiveTC: 'TEST', dejavooCounter: 'LIVE', ... }
 *   }
 *
 * `flags.*` is what the UI should branch on for routing/rendering decisions.
 * `effectiveStates.*` is shown only for SUPER_ADMINs (debug banner) — non-admins
 * receive the same structure but with values they can't act on.
 */
currentUserFlagsRouter.get('/feature-flags', async (req, res) => {
  try {
    // Round 25 (2026-05-22): SUPER_ADMIN can pass ?tenantId= to view a specific
    // tenant's flags. Without this, SUPER_ADMIN with tenantId=null in JWT got
    // empty flags and was forced to flip flags to LIVE just to test TEST-mode
    // features. Now SUPER_ADMIN can preview any tenant's flag state by passing
    // ?tenantId=<id>, matching the tenant-scoping pattern used in
    // /api/admin/integrations/tl-international and other admin endpoints.
    let tenantId = req.user?.tenantId;
    if (!tenantId && req.user?.role === 'SUPER_ADMIN' && req.query?.tenantId) {
      tenantId = String(req.query.tenantId);
    }
    if (!tenantId) {
      return res.json({ flags: {}, effectiveStates: {} });
    }
    const states = await getTenantFlags(tenantId);
    const flags = {};
    for (const [name, state] of Object.entries(states)) {
      flags[name] = resolveFlag(state, req.user);
    }
    res.json({ flags, effectiveStates: states });
  } catch (err) {
    sendError(res, err);
  }
});
