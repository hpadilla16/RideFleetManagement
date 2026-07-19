import { Router } from 'express';
import { customersService } from './customers.service.js';
import { prisma } from '../../lib/prisma.js';
import { sendEmail } from '../../lib/mailer.js';
import { idempotency } from '../../middleware/idempotency.js';
import {
  validateVoziaCustomerPatch,
  applyVoziaCustomerPatch
} from './vozia-customer-patch.js';
// SECURITY (P0): use the shared FAIL-CLOSED tenant scope helper instead of a
// local one. The previous local scopeFor returned { tenantId: null } for any
// non-super-admin without a tenant claim, which made every downstream
// `...(scope?.tenantId ? { tenantId } : {})` guard vanish — i.e. global
// cross-tenant read/write. The shared helper returns a deny-all sentinel
// ({ tenantId: '__no_tenant__' }) for that case, and gives super-admins {}
// or the explicit ?tenantId narrowing.
import { scopeFor } from '../../lib/tenant-scope.js';

export const customersRouter = Router();

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

// On-demand KYC document fetch (perf-safe). These load ONE doc column, sign it
// if it's a Storage path, and return { url, contentType? }. Tenant-scoped via
// the shared fail-closed scopeFor — a user of tenant A can never fetch tenant
// B's document (findFirst is filtered by scope.tenantId; a miss -> 404). The
// raw storage path is NEVER returned; only a signed URL / passthrough URL is.
async function serveCustomerDocument(kind, req, res) {
  const doc = await customersService.getDocument(req.params.id, kind, scopeFor(req));
  if (!doc) return res.status(404).json({ error: 'Document not found' });
  res.json(doc);
}

customersRouter.get('/:id/id-photo', async (req, res) => {
  await serveCustomerDocument('id-photo', req, res);
});

customersRouter.get('/:id/insurance-doc', async (req, res) => {
  await serveCustomerDocument('insurance', req, res);
});

customersRouter.get('/:id/license-back', async (req, res) => {
  await serveCustomerDocument('license-back', req, res);
});

customersRouter.post('/', async (req, res) => {
  const required = ['firstName', 'lastName', 'phone'];
  const missing = required.filter((k) => !req.body?.[k]);
  if (missing.length) return res.status(400).json({ error: `Missing required fields: ${missing.join(', ')}` });

  const row = await customersService.create(req.body, scopeFor(req));
  res.status(201).json(row);
});

customersRouter.patch('/:id', idempotency({ kind: 'vozia-customer' }), async (req, res) => {
  try {
    // S27 W-D (2026-07-19): service accounts get a FIELD-whitelisted path —
    // exactly one of email/address1/address2/city/state/zip + author + ticketId.
    // Email changes notify the OLD address (blindaje de Hector) and everything
    // lands in AuditLog. Humans below are completely unchanged. The idempotency
    // middleware only bites service accounts (humans pass through keyless).
    if (req.user?.isServiceAccount) {
      const { errors, value } = validateVoziaCustomerPatch(req.body || {});
      if (errors.length) {
        return res.status(400).json({ error: 'Validation failed', details: errors });
      }
      const scope = scopeFor(req);
      const customer = await prisma.customer.findFirst({
        where: {
          id: req.params.id,
          ...(scope?.tenantId ? { tenantId: scope.tenantId } : {})
        },
        select: {
          id: true, tenantId: true, firstName: true, email: true,
          address1: true, address2: true, city: true, state: true, zip: true
        }
      });
      if (!customer) return res.status(404).json({ error: 'Customer not found' });
      try {
        const out = await applyVoziaCustomerPatch(
          value, customer, { prisma, sendEmail }, req.user?.sub || null
        );
        return res.json(out);
      } catch (e) {
        if (Number.isInteger(e?.status) && e.status < 500) {
          return res.status(e.status).json({ error: e.message, ...(e.code ? { code: e.code } : {}) });
        }
        throw e;
      }
    }

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

