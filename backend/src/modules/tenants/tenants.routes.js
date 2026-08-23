import { Router } from 'express';
import { isSuperAdmin } from '../../middleware/auth.js';
import { tenantsService } from './tenants.service.js';
import { demoResetService } from './demo-reset.service.js';

export const tenantsRouter = Router();

function requireSuperAdmin(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
  if (!isSuperAdmin(req.user)) return res.status(403).json({ error: 'Super admin only' });
  next();
}

tenantsRouter.use(requireSuperAdmin);

tenantsRouter.get('/', async (_req, res, next) => {
  try {
    res.json(await tenantsService.list());
  } catch (e) {
    next(e);
  }
});

tenantsRouter.get('/plan-catalog', async (_req, res, next) => {
  try {
    res.json(await tenantsService.getPlanCatalog());
  } catch (e) {
    next(e);
  }
});

tenantsRouter.put('/plan-catalog', async (req, res) => {
  try {
    res.json(await tenantsService.savePlanCatalog(req.body?.plans || []));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

tenantsRouter.post('/', async (req, res, next) => {
  try {
    const tenant = await tenantsService.createTenant(req.body || {});
    res.status(201).json(tenant);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

tenantsRouter.patch('/:id', async (req, res, next) => {
  try {
    const tenant = await tenantsService.updateTenant(req.params.id, req.body || {});
    res.json(tenant);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

/**
 * Reset the demo tenant — Ride University's practice mode leaves trainee
 * bookings behind, and the same tenant is what sales demos run on.
 *
 * SUPER_ADMIN only, and the service refuses any tenant whose isDemo is not
 * exactly true, so the worst a wrong id can do is 403. The confirmation
 * phrase in the body is the second lock: this deletes data.
 */
tenantsRouter.post('/:id/reset-demo', requireSuperAdmin, async (req, res, next) => {
  try {
    res.json(await demoResetService.reset(req.params.id, req.body?.confirm, {
      userId: req.user?.id || req.user?.sub || null,
      email: req.user?.email || null,
    }));
  } catch (e) { next(e); }
});

tenantsRouter.get('/:id/admins', async (req, res, next) => {
  try {
    const admins = await tenantsService.listTenantAdmins(req.params.id);
    res.json(admins);
  } catch (e) {
    next(e);
  }
});

tenantsRouter.post('/:id/admins', async (req, res, next) => {
  try {
    const user = await tenantsService.createTenantAdmin(req.params.id, req.body || {}, { actor: req.user });
    res.status(201).json(user);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

tenantsRouter.post('/:id/admins/:userId/reset-password', async (req, res) => {
  try {
    const out = await tenantsService.resetTenantAdminPassword(req.params.id, req.params.userId, req.body?.password, { actor: req.user });
    res.json(out);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Wave 3 (2026-08-24): AUDIT_ACTIONS.IMPERSONATION_START is recorded inside the
// service (success + failure). There is deliberately NO IMPERSONATION_END
// marker: an impersonation is a plain short-lived JWT with the `imp` claim and
// no server-side session to close, and the impersonated session is the TENANT
// admin — it cannot reach this super-admin-guarded router to signal an end.
// The window is therefore bounded by the token's own expiry (getJwtExpiresIn),
// and everything done within it is attributable via the `imp` claim on each
// request (requestLogger + auditFromReq both surface it).
tenantsRouter.post('/:id/impersonate', async (req, res) => {
  try {
    const out = await tenantsService.impersonateTenantAdmin(req.params.id, req.body?.userId || null, { actor: req.user });
    res.json(out);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});
