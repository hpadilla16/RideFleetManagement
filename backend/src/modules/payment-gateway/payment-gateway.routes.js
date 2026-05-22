import { Router } from 'express';
import { paymentGatewayService } from './payment-gateway.service.js';
import { prisma } from '../../lib/prisma.js';
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

// Round 20 — Charge customer card-on-file via Dejavoo (card-not-present)
//
// Used for post-rental charges (tolls, late fees, damage assessments)
// where the customer has already left + their card was tokenized during
// the prior AUTH/SALE on the terminal.
//
// Mounted under /api/reservations/:id/charge-card-on-file in main.js when
// the reservation has a linked customer with a dejavooIposToken.
paymentGatewayRouter.post('/reservations/:id/charge-card-on-file', async (req, res) => {
  try {
    const role = String(req.user?.role || '').toUpperCase();
    if (!['SUPER_ADMIN', 'ADMIN', 'OPS'].includes(role)) {
      return res.status(403).json({ error: 'ADMIN or OPS only' });
    }
    const { amount, label } = req.body || {};
    if (!amount || Number(amount) <= 0) {
      return res.status(400).json({ error: 'amount must be > 0' });
    }
    const reservationId = req.params.id;
    const reservation = await prisma.reservation.findFirst({
      where: { id: reservationId, tenantId: req.user.tenantId },
      select: { id: true, customerId: true },
    });
    if (!reservation) {
      return res.status(404).json({ error: 'Reservation not found in tenant scope' });
    }
    if (!reservation.customerId) {
      return res.status(422).json({ error: 'Reservation has no linked customer' });
    }
    const result = await paymentGatewayService.chargeCardOnFileViaDejavoo({
      customerId: reservation.customerId,
      amount: Number(amount),
      reservationId,
      label,
      tenantId: req.user.tenantId,
      actorUserId: req.user?.sub || req.user?.id,
    });
    res.json(result);
  } catch (e) {
    res.status(400).json({ error: e.message, spinStatusCode: e.spinStatusCode });
  }
});

// Callback receiver (webhook from SPIn)
//
// Dejavoo cloud POSTs the result of each terminal transaction to this URL
// when the terminal config has a `CallbackInfo.Url` set. The body is the
// same JSON shape we already get from the synchronous response.
//
// What we do here:
//   1. Find the DejavooTransaction by referenceId
//   2. Stamp callbackReceivedAt (audit — confirms the terminal acknowledged)
//   3. Idempotently update any fields that the sync response missed
//      (network race, retry, partial response, etc.)
//   4. Return 200 OK so Dejavoo doesn't retry
//
// Security: this endpoint is PUBLIC (no JWT — it's a webhook). We rely on
// the obscurity of the URL + the referenceId being our own server-generated
// 50-char unique value to prevent abuse. Future hardening: validate an
// HMAC signature header if Dejavoo adds one. For now we accept any POST
// and only update rows where the referenceId matches what we already
// persisted (no creation path).
paymentGatewayRouter.post('/callback', async (req, res) => {
  const { default: logger } = await import('../../lib/logger.js');
  try {
    const payload = req.body || {};
    const referenceId =
      payload?.ReferenceId || payload?.referenceId || payload?.RefId || null;
    const statusCode =
      payload?.GeneralResponse?.StatusCode || payload?.StatusCode || null;
    const transactionType =
      payload?.TransactionType || payload?.transactionType || null;

    logger.info('SPIn callback received', {
      referenceId,
      statusCode,
      transactionType,
    });

    if (!referenceId) {
      // No referenceId — log + 200 (Dejavoo expects 200 to not retry).
      return res.json({ ok: true, received: true, matched: false, reason: 'no_referenceId' });
    }

    const { prisma } = await import('../../lib/prisma.js');
    const tx = await prisma.dejavooTransaction.findUnique({
      where: { referenceId },
    });
    if (!tx) {
      logger.warn('SPIn callback for unknown referenceId', { referenceId });
      return res.json({ ok: true, received: true, matched: false });
    }

    // Update — idempotent. We only write fields when they were absent in the
    // sync path (or when the callback carries more info). callbackReceivedAt
    // is always stamped.
    const approved = statusCode === '0000';
    const updates = {
      callbackReceivedAt: new Date(),
      // Preserve existing data; only overlay non-null fields from the callback.
    };
    if (!tx.approved && approved) updates.approved = true;
    if (!tx.statusCode && statusCode) updates.statusCode = statusCode;
    if (!tx.iposToken && payload?.IPosToken) updates.iposToken = payload.IPosToken;
    if (!tx.authCode && payload?.AuthCode) updates.authCode = payload.AuthCode;
    if (!tx.cardLast4 && payload?.CardData?.Last4) updates.cardLast4 = payload.CardData.Last4;
    if (!tx.cardBrand && payload?.CardData?.CardType) updates.cardBrand = payload.CardData.CardType;
    if (!tx.cardEntryType && payload?.CardData?.EntryType) updates.cardEntryType = payload.CardData.EntryType;
    if (!tx.errorMessage && !approved && (payload?.GeneralResponse?.Message || payload?.Message)) {
      updates.errorMessage = payload?.GeneralResponse?.DetailedMessage ||
                             payload?.GeneralResponse?.Message ||
                             payload?.Message;
    }
    // Persist the callback payload for audit. Don't overwrite rawResponse —
    // store under a new path to preserve the sync-response trail.
    if (!tx.completedAt) updates.completedAt = new Date();

    await prisma.dejavooTransaction.update({
      where: { id: tx.id },
      data: updates,
    });

    res.json({
      ok: true,
      received: true,
      matched: true,
      txId: tx.id,
      reservationId: tx.reservationId,
    });
  } catch (e) {
    logger.warn('SPIn callback processing failed', { message: e.message });
    // Still return 200 so Dejavoo doesn't retry — we have the log entry.
    res.json({ ok: true, received: true, matched: false, reason: 'processing_error' });
  }
});
