import { Router } from 'express';
import { customersService } from './customers.service.js';
import { isSuperAdmin } from '../../middleware/auth.js';

export const customersRouter = Router();

function scopeFor(req) {
  if (isSuperAdmin(req.user)) return { allowCrossTenant: true };
  return { tenantId: req.user?.tenantId || null, allowCrossTenant: false };
}

customersRouter.get('/', async (_req, res) => {
  res.json(await customersService.list(scopeFor(_req), {
    query: _req.query?.q,
    limit: _req.query?.limit
  }));
});

customersRouter.post('/bulk/validate', async (req, res) => {
  const rows = Array.isArray(req.body?.rows) ? req.body.rows : [];
  const report = await customersService.validateBulk(rows, scopeFor(req));
  res.json(report);
});

customersRouter.post('/bulk/import', async (req, res) => {
  const rows = Array.isArray(req.body?.rows) ? req.body.rows : [];
  const out = await customersService.importBulk(rows, scopeFor(req));
  res.json(out);
});

customersRouter.get('/:id', async (req, res) => {
  const row = await customersService.getById(req.params.id, scopeFor(req));
  if (!row) return res.status(404).json({ error: 'Customer not found' });
  res.json(row);
});

customersRouter.post('/', async (req, res) => {
  const required = ['firstName', 'lastName', 'phone'];
  const missing = required.filter((k) => !req.body?.[k]);
  if (missing.length) return res.status(400).json({ error: `Missing required fields: ${missing.join(', ')}` });

  const row = await customersService.create(req.body, scopeFor(req));
  res.status(201).json(row);
});

customersRouter.patch('/:id', async (req, res) => {
  try {
    if (Object.prototype.hasOwnProperty.call(req.body || {}, 'creditBalance') && req.user?.role !== 'ADMIN') {
      return res.status(403).json({ error: 'Admin approval required to update credit balance' });
    }
    const row = await customersService.update(req.params.id, req.body || {}, scopeFor(req));
    res.json(row);
  } catch {
    res.status(404).json({ error: 'Customer not found' });
  }
});

customersRouter.post('/:id/password-reset', async (req, res) => {
  try {
    if (req.user?.role !== 'ADMIN') return res.status(403).json({ error: 'Admin approval required' });
    const out = await customersService.issuePasswordReset(req.params.id, process.env.CUSTOMER_PORTAL_BASE_URL || 'http://localhost:3000', scopeFor(req));
    res.json(out);
  } catch {
    res.status(404).json({ error: 'Customer not found' });
  }
});

customersRouter.delete('/:id', async (req, res) => {
  try {
    await customersService.remove(req.params.id, scopeFor(req));
    res.status(204).send();
  } catch {
    res.status(404).json({ error: 'Customer not found' });
  }
});

