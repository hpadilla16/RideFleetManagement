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
import { auditFromReq, AUDIT_ACTIONS } from '../audit/audit.service.js';

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
  // Sensitive-read audit (Wave 3): ONE identified customer's full record was
  // disclosed. Audited only on a FOUND record (a 404 discloses nothing), and
  // only here — the list endpoint above is deliberately NOT audited (threshold
  // rule in audit.service.js). Best-effort; never blocks the read.
  auditFromReq(req, {
    action: AUDIT_ACTIONS.CUSTOMER_RECORD_READ,
    targetType: 'CUSTOMER',
    targetId: req.params.id,
  });
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
  // Sensitive-read audit (Wave 3): a KYC document (ID photo / insurance /
  // license) was disclosed for ONE customer. Instrumented once here so all
  // three doc endpoints are covered; metadata records which kind. Audited only
  // on a FOUND doc. Best-effort.
  auditFromReq(req, {
    action: AUDIT_ACTIONS.CUSTOMER_DOCUMENT_READ,
    targetType: 'CUSTOMER',
    targetId: req.params.id,
    metadata: { kind },
  });
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
  } catch (err) {
    // Honest errors (2026-08-22). This used to answer 404 "Customer not found"
    // for EVERY failure — including the common one where the customer has a
    // reservation and a database referential-integrity rule blocks the delete.
    // Someone trying to honour an erasure request was told the record didn't
    // exist while it sat there intact. Distinguish the cases:
    //   P2025 — record genuinely not found            → 404
    //   P2003/P2014 — blocked by a related record     → 409, and say so
    // The proper erasure path (anonymisation that keeps legally-required rows)
    // is tracked separately; this stops the delete from lying in the meantime.
    // remove() pre-checks existence and throws a plain Error('Customer not
    // found') with no .code for a missing/out-of-scope customer; P2025 only
    // fires on a delete-time race. Match both so a genuine miss stays 404.
    if (err?.code === 'P2025' || err?.message === 'Customer not found') {
      return res.status(404).json({ error: 'Customer not found' });
    }
    if (err?.code === 'P2003' || err?.code === 'P2014') {
      return res.status(409).json({
        error: 'This customer has reservations or other linked records and cannot be hard-deleted. Use the erasure/anonymisation flow instead.',
        code: 'CUSTOMER_HAS_LINKED_RECORDS'
      });
    }
    return res.status(500).json({ error: 'Failed to delete customer' });
  }
});

