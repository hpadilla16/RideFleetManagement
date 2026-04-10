import { Router } from 'express';
import { paymentGatewayService } from './payment-gateway.service.js';
import { isSuperAdmin } from '../../middleware/auth.js';

export const paymentGatewayRouter = Router();

function tenantIdFor(req) {
  if (isSuperAdmin(req.user)) return req.query?.tenantId ? String(req.query.tenantId) : (req.user?.tenantId || null);
  return req.user?.tenantId || null;
}

// Charge a reservation
paymentGatewayRouter.post('/charge', async (req, res, next) => {
  try {
    const { reservationId, amount } = req.body || {};
    if (!reservationId || !amount) return res.status(400).json({ error: 'reservationId and amount are required' });
    res.json(await paymentGatewayService.chargeReservation({
      reservationId,
      amount: Number(amount),
      tenantId: tenantIdFor(req),
      actorUserId: req.user?.id || req.user?.sub || null,
    }));
  } catch (e) {
    res.status(400).json({ error: e.message, spinStatusCode: e.spinStatusCode });
  }
});

// Auth hold (security deposit)
paymentGatewayRouter.post('/auth-hold', async (req, res, next) => {
  try {
    const { reservationId, amount } = req.body || {};
    if (!reservationId || !amount) return res.status(400).json({ error: 'reservationId and amount are required' });
    res.json(await paymentGatewayService.authHold({
      reservationId,
      amount: Number(amount),
      tenantId: tenantIdFor(req),
    }));
  } catch (e) {
    res.status(400).json({ error: e.message, spinStatusCode: e.spinStatusCode });
  }
});

// Capture a hold
paymentGatewayRouter.post('/capture', async (req, res, next) => {
  try {
    const { referenceId, amount } = req.body || {};
    if (!referenceId) return res.status(400).json({ error: 'referenceId is required' });
    res.json(await paymentGatewayService.captureHold({
      referenceId,
      amount: amount ? Number(amount) : undefined,
      tenantId: tenantIdFor(req),
    }));
  } catch (e) {
    res.status(400).json({ error: e.message, spinStatusCode: e.spinStatusCode });
  }
});

// Void
paymentGatewayRouter.post('/void', async (req, res, next) => {
  try {
    const { referenceId } = req.body || {};
    if (!referenceId) return res.status(400).json({ error: 'referenceId is required' });
    res.json(await paymentGatewayService.voidTransaction({ referenceId, tenantId: tenantIdFor(req) }));
  } catch (e) {
    res.status(400).json({ error: e.message, spinStatusCode: e.spinStatusCode });
  }
});

// Refund
paymentGatewayRouter.post('/refund', async (req, res, next) => {
  try {
    const { amount, referenceId } = req.body || {};
    if (!amount) return res.status(400).json({ error: 'amount is required' });
    res.json(await paymentGatewayService.refund({
      amount: Number(amount),
      referenceId,
      tenantId: tenantIdFor(req),
    }));
  } catch (e) {
    res.status(400).json({ error: e.message, spinStatusCode: e.spinStatusCode });
  }
});

// Tokenize card (card on file)
paymentGatewayRouter.post('/tokenize', async (req, res, next) => {
  try {
    res.json(await paymentGatewayService.tokenizeCard({ tenantId: tenantIdFor(req) }));
  } catch (e) {
    res.status(400).json({ error: e.message, spinStatusCode: e.spinStatusCode });
  }
});

// Terminal status
paymentGatewayRouter.get('/terminal-status', async (req, res, next) => {
  try {
    res.json(await paymentGatewayService.checkTerminal({ tenantId: tenantIdFor(req) }));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Settle batch
paymentGatewayRouter.post('/settle', async (req, res, next) => {
  try {
    res.json(await paymentGatewayService.settleBatch({ tenantId: tenantIdFor(req) }));
  } catch (e) {
    res.status(400).json({ error: e.message, spinStatusCode: e.spinStatusCode });
  }
});

// Summary report
paymentGatewayRouter.get('/summary', async (req, res, next) => {
  try {
    res.json(await paymentGatewayService.getSummaryReport({ tenantId: tenantIdFor(req) }));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Callback receiver (webhook from SPIn)
paymentGatewayRouter.post('/callback', async (req, res) => {
  try {
    const payload = req.body || {};
    // Log the callback for audit
    const { default: logger } = await import('../../lib/logger.js');
    logger.info('SPIn callback received', {
      referenceId: payload?.ReferenceId,
      statusCode: payload?.GeneralResponse?.StatusCode,
      transactionType: payload?.TransactionType,
    });
    // TODO: Process callback — update reservation payment status, trigger workflows
    res.json({ ok: true, received: true });
  } catch (e) {
    res.status(500).json({ error: 'Callback processing failed' });
  }
});
