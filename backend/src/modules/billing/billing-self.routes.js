/**
 * The tenant's own billing surface — Tenant Subscriptions Phase 5.
 *
 * Mounted at `/api/billing` behind `requireAuth` + `tenantRateLimit` (main.js).
 * These two routes are the ONLY entries in the suspension allowlist that do
 * anything, and they are the reason the gate is not a trap: a suspended tenant
 * can always see what they owe and always ask for the link that fixes it.
 *
 * GATING. Tenant ADMIN, plus SUPER_ADMIN (who reaches everything anyway). Not
 * OPS, not AGENT: this shows the company's price and the card on file, which is
 * an owner's business, not a counter agent's. NOT `requireRole('ADMIN')` for
 * the check itself — that helper short-circuits on isSuperAdmin BEFORE checking
 * the list (auth.js:161-163), which is fine for letting the platform owner
 * through and useless as an actual role check, so the role test is written out.
 *
 * SCOPE. `req.user.tenantId`, from the verified session. There is no tenantId
 * parameter anywhere on this router.
 */
import { Router } from 'express';
import { isSuperAdmin } from '../../middleware/auth.js';
import { billingSelf } from './billing-self.service.js';

export const billingSelfRouter = Router();

function requireTenantAdmin(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
  if (isSuperAdmin(req.user)) return next();
  if (String(req.user.role || '').toUpperCase() !== 'ADMIN') {
    return res.status(403).json({ error: 'Only an account administrator can view billing.' });
  }
  if (!req.user.tenantId) {
    return res.status(403).json({ error: 'This account is not attached to a tenant.' });
  }
  next();
}

billingSelfRouter.use(requireTenantAdmin);

function fail(res, next, e) {
  const status = Number(e?.status || e?.statusCode || 0);
  if (status >= 400 && status < 500) return res.status(status).json({ error: e.message });
  return next(e);
}

/**
 * GET /api/billing/self
 *
 * ALLOWLISTED WHILE SUSPENDED. If this route ever stops answering for a
 * suspended tenant, the hold screen goes blank and the customer's only
 * remaining channel is the phone.
 */
billingSelfRouter.get('/self', async (req, res, next) => {
  try {
    res.json(await billingSelf.getSelfBilling({ tenantId: req.user.tenantId }));
  } catch (e) {
    fail(res, next, e);
  }
});

/**
 * POST /api/billing/self/payment-link
 *
 * ALLOWLISTED WHILE SUSPENDED — this is the way out. It EMAILS the link to the
 * billing address on the subscription and returns only `{ sent, email }`; the
 * URL never comes back over this response. See the service for why.
 */
billingSelfRouter.post('/self/payment-link', async (req, res, next) => {
  try {
    res.json(await billingSelf.requestSelfPaymentLink({
      tenantId: req.user.tenantId,
      actorUserId: req.user.id || req.user.sub || null,
      actorEmail: req.user.email || null,
    }));
  } catch (e) {
    fail(res, next, e);
  }
});
