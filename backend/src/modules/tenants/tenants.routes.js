import { Router } from 'express';
import { isSuperAdmin } from '../../middleware/auth.js';
import { tenantsService } from './tenants.service.js';

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
    const user = await tenantsService.createTenantAdmin(req.params.id, req.body || {});
    res.status(201).json(user);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

tenantsRouter.post('/:id/admins/:userId/reset-password', async (req, res) => {
  try {
    const out = await tenantsService.resetTenantAdminPassword(req.params.id, req.params.userId, req.body?.password || 'TempPass123!');
    res.json(out);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

tenantsRouter.post('/:id/impersonate', async (req, res) => {
  try {
    const out = await tenantsService.impersonateTenantAdmin(req.params.id, req.body?.userId || null);
    res.json(out);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});