import { Router } from 'express';
import { rentalAgreementsService } from './rental-agreements.service.js';
import { compactAgreementResponse } from './rental-agreements-compact.js';
import logger from '../../lib/logger.js';

export const rentalAgreementsRouter = Router();

function isAdminRole(user) {
  const role = String(user?.role || '').toUpperCase();
  return ['SUPER_ADMIN', 'ADMIN'].includes(role);
}

async function ensureEditable(id, user) {
  const row = await rentalAgreementsService.getById(id, user);
  if (!row) {
    const err = new Error('Rental agreement not found');
    err.statusCode = 404;
    throw err;
  }
  if (row.locked && !['ADMIN', 'SUPER_ADMIN', 'OPS', 'AGENT'].includes(String(user?.role || '').toUpperCase())) {
    const err = new Error('Agreement is closed and locked. Staff access required for changes.');
    err.statusCode = 403;
    throw err;
  }
  return row;
}

async function ensureAccessible(id, user) {
  const row = await rentalAgreementsService.getAccessibleAgreement(id, user);
  if (!row) {
    const err = new Error('Rental agreement not found');
    err.statusCode = 404;
    throw err;
  }
  return row;
}

rentalAgreementsRouter.get('/', async (req, res, next) => {
  try {
    const rows = await rentalAgreementsService.list(req.user);
    res.json(rows);
  } catch (e) {
    next(e);
  }
});

rentalAgreementsRouter.post('/start-from-reservation/:reservationId', async (req, res, next) => {
  try {
    const row = await rentalAgreementsService.startFromReservation(req.params.reservationId, req.user);
    res.status(201).json(row);
  } catch (e) {
    if (/not found/i.test(e.message)) return res.status(404).json({ error: e.message });
    if (/cannot start/i.test(e.message)) return res.status(400).json({ error: e.message });
    next(e);
  }
});

rentalAgreementsRouter.get('/:id', async (req, res, next) => {
  try {
    const row = await rentalAgreementsService.getById(req.params.id, req.user);
    if (!row) return res.status(404).json({ error: 'Rental agreement not found' });
    res.json(row);
  } catch (e) {
    next(e);
  }
});

rentalAgreementsRouter.put('/:id/customer', async (req, res, next) => {
  try {
    await ensureEditable(req.params.id, req.user);
    const required = ['customerFirstName', 'customerLastName'];
    const missing = required.filter((k) => !req.body?.[k]);
    if (missing.length) return res.status(400).json({ error: `Missing required fields: ${missing.join(', ')}` });

    const row = await rentalAgreementsService.updateCustomer(req.params.id, req.body || {});
    res.json(row);
  } catch (e) {
    if (/record to update not found/i.test(e.message)) return res.status(404).json({ error: 'Rental agreement not found' });
    next(e);
  }
});

rentalAgreementsRouter.post('/:id/drivers', async (req, res, next) => {
  try {
    await ensureEditable(req.params.id, req.user);
    const required = ['firstName', 'lastName'];
    const missing = required.filter((k) => !req.body?.[k]);
    if (missing.length) return res.status(400).json({ error: `Missing required fields: ${missing.join(', ')}` });

    const row = await rentalAgreementsService.addDriver(req.params.id, req.body || {});
    res.status(201).json(row);
  } catch (e) {
    if (/foreign key constraint/i.test(e.message)) return res.status(404).json({ error: 'Rental agreement not found' });
    next(e);
  }
});

rentalAgreementsRouter.put('/:id/rental', async (req, res, next) => {
  try {
    await ensureEditable(req.params.id, req.user);
    const row = await rentalAgreementsService.updateRentalDetails(req.params.id, req.body || {});
    res.json(row);
  } catch (e) {
    if (/record to update not found/i.test(e.message)) return res.status(404).json({ error: 'Rental agreement not found' });
    next(e);
  }
});

rentalAgreementsRouter.post('/:id/charges', async (req, res, next) => {
  try {
    await ensureEditable(req.params.id, req.user);
    const charges = Array.isArray(req.body?.charges) ? req.body.charges : [];
    const row = await rentalAgreementsService.replaceCharges(req.params.id, charges);
    res.json(row);
  } catch (e) {
    if (/record to update not found/i.test(e.message)) return res.status(404).json({ error: 'Rental agreement not found' });
    next(e);
  }
});

rentalAgreementsRouter.post('/:id/credit', async (req, res, next) => {
  try {
    if (req.user?.role !== 'ADMIN') return res.status(403).json({ error: 'Admin approval required' });
    const amount = Number(req.body?.amount || 0);
    if (!Number.isFinite(amount) || amount === 0) return res.status(400).json({ error: 'amount must be a non-zero number' });
    const out = await rentalAgreementsService.adjustCustomerCreditFromAgreement(req.params.id, amount, req.body?.reason || null);
    res.json(out);
  } catch (e) {
    if (/not found/i.test(e.message)) return res.status(404).json({ error: e.message });
    next(e);
  }
});

rentalAgreementsRouter.get('/:id/print', async (req, res, next) => {
  try {
    await ensureAccessible(req.params.id, req.user);
    const html = await rentalAgreementsService.renderAgreementHtml(req.params.id);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(html);
  } catch (e) {
    if (/not found/i.test(e.message)) return res.status(404).json({ error: e.message });
    next(e);
  }
});

rentalAgreementsRouter.post('/:id/email-agreement', async (req, res, next) => {
  try {
    await ensureAccessible(req.params.id, req.user);
    // Fire-and-forget: Puppeteer PDF render + SMTP send used to block the
    // response for 4-5s on checkout. The service schedules the heavy work via
    // setImmediate (interim; SCALING_ROADMAP.md plans a Redis/BullMQ queue).
    // We pass tenantId as defense-in-depth so the async findAgreement default
    // can never cross tenants, even if ensureAccessible is later refactored.
    // Super-admins get null → no tenant filter (matches crossTenantScopeFor).
    const isSuperAdmin = String(req.user?.role || '').toUpperCase() === 'SUPER_ADMIN';
    const tenantId = isSuperAdmin ? null : (req.user?.tenantId || null);
    const out = await rentalAgreementsService.scheduleEmailDelivery(
      req.params.id,
      req.body || {},
      req.user?.sub || null,
      tenantId,
      { logger }
    );
    res.status(202).json(out);
  } catch (e) {
    if (e?.statusCode === 400) return res.status(400).json({ error: e.message });
    if (/not found/i.test(e.message)) return res.status(404).json({ error: e.message });
    if (/required/i.test(e.message)) return res.status(400).json({ error: e.message });
    next(e);
  }
});

rentalAgreementsRouter.post('/:id/signature', async (req, res, next) => {
  try {
    await ensureEditable(req.params.id, req.user);
    const row = await rentalAgreementsService.signAgreement(req.params.id, req.body || {}, req.user?.sub || null, req.ip || null);
    res.json(compactAgreementResponse(row));
  } catch (e) {
    if (/not found/i.test(e.message)) return res.status(404).json({ error: e.message });
    if (/required/i.test(e.message)) return res.status(400).json({ error: e.message });
    next(e);
  }
});

rentalAgreementsRouter.post('/:id/status', async (req, res, next) => {
  try {
    const action = String(req.body?.action || '');
    await ensureEditable(req.params.id, req.user);
    const row = await rentalAgreementsService.updateStatus(req.params.id, action, req.user?.sub || null);
    res.json(row);
  } catch (e) {
    if (/not found/i.test(e.message)) return res.status(404).json({ error: e.message });
    if (/Unsupported|Only cancelled/i.test(e.message)) return res.status(400).json({ error: e.message });
    next(e);
  }
});

rentalAgreementsRouter.post('/:id/close', async (req, res, next) => {
  try {
    await ensureEditable(req.params.id, req.user);
    const row = await rentalAgreementsService.closeAgreement(req.params.id, req.body || {}, req.user?.sub || null, req.user?.role || 'AGENT', req.ip || null);
    res.json(row);
  } catch (e) {
    if (/not found/i.test(e.message)) return res.status(404).json({ error: e.message });
    if (/cannot be closed|required/i.test(e.message)) return res.status(400).json({ error: e.message });
    next(e);
  }
});

rentalAgreementsRouter.post('/:id/payments/manual', async (req, res, next) => {
  try {
    await ensureEditable(req.params.id, req.user);
    const row = await rentalAgreementsService.addManualPayment(req.params.id, req.body || {}, req.user?.sub || null);
    res.json(row);
  } catch (e) {
    if (/not found/i.test(e.message)) return res.status(404).json({ error: e.message });
    if (/amount|required|entrytype/i.test(e.message)) return res.status(400).json({ error: e.message });
    next(e);
  }
});

rentalAgreementsRouter.post('/:id/customer/card-on-file', async (req, res, next) => {
  try {
    await ensureEditable(req.params.id, req.user);
    const row = await rentalAgreementsService.captureCustomerCardOnFile(req.params.id, req.body || {}, req.user?.sub || null);
    res.json(row);
  } catch (e) {
    if (/not found/i.test(e.message)) return res.status(404).json({ error: e.message });
    if (/required|profile/i.test(e.message)) return res.status(400).json({ error: e.message });
    next(e);
  }
});

rentalAgreementsRouter.post('/:id/payments/charge-card-on-file', async (req, res, next) => {
  try {
    await ensureEditable(req.params.id, req.user);
    const row = await rentalAgreementsService.chargeCardOnFile(req.params.id, req.body || {}, req.user?.sub || null);
    res.json(row);
  } catch (e) {
    if (/not found/i.test(e.message)) return res.status(404).json({ error: e.message });
    if (/configured|profile|amount|failed/i.test(e.message)) return res.status(400).json({ error: e.message });
    next(e);
  }
});

rentalAgreementsRouter.post('/:id/security-deposit/capture', async (req, res, next) => {
  try {
    await ensureEditable(req.params.id, req.user);
    const row = await rentalAgreementsService.captureSecurityDeposit(req.params.id, req.body || {}, req.user?.sub || null);
    res.json(row);
  } catch (e) {
    if (/not found/i.test(e.message)) return res.status(404).json({ error: e.message });
    if (/already|amount|configured|profile|failed/i.test(e.message)) return res.status(400).json({ error: e.message });
    next(e);
  }
});

rentalAgreementsRouter.post('/:id/security-deposit/release', async (req, res, next) => {
  try {
    await ensureEditable(req.params.id, req.user);
    const row = await rentalAgreementsService.releaseSecurityDeposit(req.params.id, req.body || {}, req.user?.sub || null);
    res.json(row);
  } catch (e) {
    if (/not found/i.test(e.message)) return res.status(404).json({ error: e.message });
    if (/not captured|already released|failed/i.test(e.message)) return res.status(400).json({ error: e.message });
    next(e);
  }
});

rentalAgreementsRouter.post('/:id/inspection', async (req, res, next) => {
  try {
    await ensureEditable(req.params.id, req.user);
    const out = await rentalAgreementsService.saveInspection(
      req.params.id,
      req.body || {},
      req.user?.sub || null,
      req.ip || null,
      req.user?.role || 'AGENT'
    );
    res.json(out);
  } catch (e) {
    if (/not found/i.test(e.message)) return res.status(404).json({ error: e.message });
    if (/phase/i.test(e.message)) return res.status(400).json({ error: e.message });
    if (/only admin can reassign|admin role required/i.test(String(e?.message || ''))) return res.status(403).json({ error: e.message });
    next(e);
  }
});

rentalAgreementsRouter.post('/:id/commission-owner', async (req, res, next) => {
  try {
    if (!isAdminRole(req.user)) {
      return res.status(403).json({ error: 'Admin role required for commission reassignment' });
    }
    const employeeUserId = String(req.body?.employeeUserId || '').trim();
    if (!employeeUserId) return res.status(400).json({ error: 'employeeUserId is required' });
    const row = await rentalAgreementsService.overrideCommissionOwner(
      req.params.id,
      employeeUserId,
      req.user?.sub || null,
      req.user?.role || 'ADMIN',
      req.user
    );
    res.json(row);
  } catch (e) {
    if (/not found/i.test(String(e?.message || ''))) return res.status(404).json({ error: e.message });
    if (/same tenant|employeeuserid is required/i.test(String(e?.message || ''))) return res.status(400).json({ error: e.message });
    if (/admin role required/i.test(String(e?.message || ''))) return res.status(403).json({ error: e.message });
    next(e);
  }
});

rentalAgreementsRouter.get('/:id/commission-owner', async (req, res, next) => {
  try {
    if (!isAdminRole(req.user)) {
      return res.status(403).json({ error: 'Admin role required for commission reassignment' });
    }
    const out = await rentalAgreementsService.commissionOwnerContext(req.params.id, req.user);
    res.json(out);
  } catch (e) {
    if (/not found/i.test(String(e?.message || ''))) return res.status(404).json({ error: e.message });
    if (/admin role required/i.test(String(e?.message || ''))) return res.status(403).json({ error: e.message });
    next(e);
  }
});

rentalAgreementsRouter.get('/:id/inspection-report', async (req, res, next) => {
  try {
    await ensureEditable(req.params.id, req.user);
    const out = await rentalAgreementsService.inspectionReport(req.params.id);
    res.json(out);
  } catch (e) {
    if (/not found/i.test(e.message)) return res.status(404).json({ error: e.message });
    next(e);
  }
});

rentalAgreementsRouter.delete('/:id', async (req, res, next) => {
  try {
    await ensureEditable(req.params.id, req.user);
    const out = await rentalAgreementsService.deleteDraft(req.params.id);
    res.json(out);
  } catch (e) {
    if (/not found/i.test(e.message)) return res.status(404).json({ error: e.message });
    if (/Only draft agreements/i.test(e.message)) return res.status(400).json({ error: e.message });
    next(e);
  }
});



rentalAgreementsRouter.post('/:id/payments/:paymentId/void', async (req, res, next) => {
  try {
    await ensureEditable(req.params.id, req.user);
    const row = await rentalAgreementsService.deletePaymentHard(req.params.id, req.params.paymentId, req.body || {}, req.user?.sub || null);
    res.json(row);
  } catch (e) {
    if (/not found/i.test(e.message)) return res.status(404).json({ error: e.message });
    if (/cannot|invalid|already/i.test(e.message)) return res.status(400).json({ error: e.message });
    next(e);
  }
});

rentalAgreementsRouter.post('/:id/payments/:paymentId/refund', async (req, res, next) => {
  try {
    await ensureEditable(req.params.id, req.user);
    const row = await rentalAgreementsService.refundPayment(req.params.id, req.params.paymentId, req.body || {}, req.user?.sub || null);
    res.json(row);
  } catch (e) {
    if (/not found/i.test(e.message)) return res.status(404).json({ error: e.message });
    if (/cannot|invalid|already|amount/i.test(e.message)) return res.status(400).json({ error: e.message });
    next(e);
  }
});

rentalAgreementsRouter.post('/:id/charge-card-on-file', async (req, res, next) => {
  try {
    await ensureEditable(req.params.id, req.user);
    const row = await rentalAgreementsService.chargeCardOnFile(req.params.id, req.body || {}, req.user?.sub || null);
    res.json(row);
  } catch (e) {
    if (/not found/i.test(e.message)) return res.status(404).json({ error: e.message });
    if (/cannot|invalid|missing|failed|amount/i.test(e.message)) return res.status(400).json({ error: e.message });
    next(e);
  }
});
rentalAgreementsRouter.post('/:id/finalize', async (req, res, next) => {
  try {
    await ensureEditable(req.params.id, req.user);
    const row = await rentalAgreementsService.finalize(req.params.id, req.body || {});
    res.json(compactAgreementResponse(row));
  } catch (e) {
    if (/not found/i.test(e.message)) return res.status(404).json({ error: e.message });
    if (/required|payment at booking\/pickup|selected charge|minimum age|maximum age|below minimum age|exceeds maximum age/i.test(String(e?.message || ''))) {
      return res.status(400).json({ error: e.message });
    }
    next(e);
  }
});


// PAYMENT_ACTION_COMPAT_ROUTES
rentalAgreementsRouter.post('/:id/payments/:paymentId/delete', async (req, res, next) => {
  try {
    await ensureEditable(req.params.id, req.user);
    const row = await rentalAgreementsService.deletePaymentHard(req.params.id, req.params.paymentId, req.body || {}, req.user?.sub || null);
    res.json(row);
  } catch (e) {
    if (/not found/i.test(e.message)) return res.status(404).json({ error: e.message });
    if (/cannot|invalid|already/i.test(e.message)) return res.status(400).json({ error: e.message });
    next(e);
  }
});
