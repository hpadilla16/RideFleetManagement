import { Router } from 'express';
import { rentalAgreementsService } from './rental-agreements.service.js';

export const rentalAgreementsRouter = Router();

async function ensureEditable(id, user) {
  const row = await rentalAgreementsService.getById(id, user);
  if (!row) {
    const err = new Error('Rental agreement not found');
    err.statusCode = 404;
    throw err;
  }
  if (row.locked && user?.role !== 'ADMIN') {
    const err = new Error('Agreement is closed and locked. Admin access required for changes.');
    err.statusCode = 403;
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
    await ensureEditable(req.params.id, req.user);
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
    await ensureEditable(req.params.id, req.user);
    const out = await rentalAgreementsService.emailAgreement(req.params.id, req.body || {}, req.user?.id || null);
    res.json(out);
  } catch (e) {
    if (/not found/i.test(e.message)) return res.status(404).json({ error: e.message });
    if (/required/i.test(e.message)) return res.status(400).json({ error: e.message });
    next(e);
  }
});

rentalAgreementsRouter.post('/:id/signature', async (req, res, next) => {
  try {
    await ensureEditable(req.params.id, req.user);
    const row = await rentalAgreementsService.signAgreement(req.params.id, req.body || {}, req.user?.id || null, req.ip || null);
    res.json(row);
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
    const row = await rentalAgreementsService.updateStatus(req.params.id, action, req.user?.id || null);
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
    const row = await rentalAgreementsService.closeAgreement(req.params.id, req.body || {}, req.user?.id || null, req.user?.role || 'AGENT', req.ip || null);
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
    const row = await rentalAgreementsService.addManualPayment(req.params.id, req.body || {}, req.user?.id || null);
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
    const row = await rentalAgreementsService.captureCustomerCardOnFile(req.params.id, req.body || {}, req.user?.id || null);
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
    const row = await rentalAgreementsService.chargeCardOnFile(req.params.id, req.body || {}, req.user?.id || null);
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
    const row = await rentalAgreementsService.captureSecurityDeposit(req.params.id, req.body || {}, req.user?.id || null);
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
    const row = await rentalAgreementsService.releaseSecurityDeposit(req.params.id, req.body || {}, req.user?.id || null);
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
    const out = await rentalAgreementsService.saveInspection(req.params.id, req.body || {}, req.user?.id || null, req.ip || null);
    res.json(out);
  } catch (e) {
    if (/not found/i.test(e.message)) return res.status(404).json({ error: e.message });
    if (/phase/i.test(e.message)) return res.status(400).json({ error: e.message });
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
    const row = await rentalAgreementsService.deletePaymentHard(req.params.id, req.params.paymentId, req.body || {}, req.user?.id || null);
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
    const row = await rentalAgreementsService.refundPayment(req.params.id, req.params.paymentId, req.body || {}, req.user?.id || null);
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
    await ensureEditable(req.params.id, req.user);
    const row = await rentalAgreementsService.chargeCardOnFile(req.params.id, req.body || {}, req.user?.id || null);
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
    res.json(row);
  } catch (e) {
    if (/not found/i.test(e.message)) return res.status(404).json({ error: e.message });
    next(e);
  }
});


// PAYMENT_ACTION_COMPAT_ROUTES
rentalAgreementsRouter.post('/:id/payments/:paymentId/void', async (req, res, next) => {
  try {
    await ensureEditable(req.params.id, req.user);
    const row = await rentalAgreementsService.deletePaymentHard(req.params.id, req.params.paymentId, req.body || {}, req.user?.id || null);
    res.json(row);
  } catch (e) {
    if (/not found/i.test(e.message)) return res.status(404).json({ error: e.message });
    if (/cannot|invalid|already/i.test(e.message)) return res.status(400).json({ error: e.message });
    next(e);
  }
});

rentalAgreementsRouter.post('/:id/payments/:paymentId/delete', async (req, res, next) => {
  try {
    await ensureEditable(req.params.id, req.user);
    const row = await rentalAgreementsService.deletePaymentHard(req.params.id, req.params.paymentId, req.body || {}, req.user?.id || null);
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
    const row = await rentalAgreementsService.refundPayment(req.params.id, req.params.paymentId, req.body || {}, req.user?.id || null);
    res.json(row);
  } catch (e) {
    if (/not found/i.test(e.message)) return res.status(404).json({ error: e.message });
    if (/cannot|invalid|already|amount/i.test(e.message)) return res.status(400).json({ error: e.message });
    next(e);
  }
});
