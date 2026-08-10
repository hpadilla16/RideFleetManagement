import { Router } from 'express';
import { rentalAgreementsService } from './rental-agreements.service.js';
import { compactAgreementResponse } from './rental-agreements-compact.js';
import { scheduleAddendumNotification } from './addendum-notification.service.js';
import { closeAgreementWithCheckinFees } from './checkin-close.service.js';
import logger from '../../lib/logger.js';
// VozIA Fase 6 RE-SCOPE (2026-07-04) — service-account REFUND guard + idempotency.
import { prisma } from '../../lib/prisma.js';
import { idempotency } from '../../middleware/idempotency.js';
// Payment Actions gate (2026-07-25). This router is mounted with only
// requireModuleAccess('reservations') (main.js:319), so every money route below
// was reachable by any employee holding the Reservations module — and these are
// byte-for-byte the same service calls as the /api/reservations twins. Gating
// one file and not this one would have been theater.
import { requireCapability } from '../../middleware/auth.js';
import {
  assertServiceAccountRefundAllowed,
  resolveVoziaCeiling,
  checkServiceAccountAgreementEmail,
  makeSendCooldown
} from './service-payment-guards.js';

export const rentalAgreementsRouter = Router();

// VozIA Fase 6 RE-SCOPE — the REFUND route (below) reuses this payment-kind
// idempotency instance. kind:'payment' means a stuck IN_PROGRESS key past its TTL
// is NOT auto-recycled (it surfaces a 409 reconcile) — the same no-double-money
// protection now guards refunds. requireAuth already runs at the mount (main.js),
// so req.user is populated. Humans w/o an Idempotency-Key pass through untouched;
// a service account w/o a key is 400, a retried key is a no-op.
const paymentIdempotency = idempotency({ kind: 'payment' });

// VozIA — best-effort AuditLog for a service-account money operation. Written on
// BOTH success and failure so every VozIA action (or attempt) is traceable to its
// ticket. Never throws: an audit write must not roll back or mask the operation.
// `kind` distinguishes the operation ('refund' here); extra context goes in meta.
async function writeVoziaPaymentAudit(agreement, req, meta = {}, kind = 'refund') {
  try {
    await prisma.auditLog.create({
      data: {
        tenantId: agreement?.tenantId || req.user?.tenantId || null,
        reservationId: agreement.reservationId,
        actorUserId: req.user?.sub || null,
        action: 'UPDATE',
        metadata: JSON.stringify({
          source: 'vozia',
          kind,
          ticketId: req.body?.ticketId || null,
          author: req.body?.author || null,
          amount: req.body?.amount ?? null,
          idempotencyKey: req.get('Idempotency-Key') || null,
          ...meta
        })
      }
    });
  } catch (err) {
    logger.warn('[vozia] payment audit write failed (continuing)', { message: err?.message });
  }
}

function isAdminRole(user) {
  const role = String(user?.role || '').toUpperCase();
  return ['SUPER_ADMIN', 'ADMIN'].includes(role);
}

// Addendum-specific permission. Agents need to create / void / resend /
// sign-on-behalf addendums day-to-day (Hector 2026-05-12). This is a
// dedicated helper rather than widening isAdminRole because other routes
// in this file gate sensitive PII reads (e.g. GET /:id/commission-owner
// returns the tenant employee roster — names/emails/roles — and must
// stay admin-only). Codex P1 on PR #68 originally caught the over-broad
// widening of isAdminRole; this helper restores the narrower split.
function canManageAddendum(user) {
  const role = String(user?.role || '').toUpperCase();
  return ['SUPER_ADMIN', 'ADMIN', 'AGENT'].includes(role);
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

// RES-849093 FIX 3b: this route wrote ONLY Customer.creditBalance — an account-level
// balance that is INVISIBLE on the rental's charges/contract and CANNOT be voided.
// Used as a per-rental "credit" it produced exactly the incident: a credit nobody
// could see or reverse. It was ALSO the P0 #4 unscoped-tenant bug
// (adjustCustomerCreditFromAgreement took no tenant scope). Neutralized: per-rental
// credits MUST go through the visible/voidable Admin Corrections charge ledger
//   POST /api/reservations/:id/charges  { name, amount: -X, reason }  (addManualCharge).
// True account-level credit adjustments live on the customer record
//   PATCH /api/customers/:id { creditBalance }  (tenant-scoped, ADMIN-gated).
rentalAgreementsRouter.post('/:id/credit', async (req, res) => {
  res.status(410).json({
    error: 'Endpoint removed. For a per-rental credit use POST /api/reservations/:id/charges with a negative amount (visible + voidable). For account-level credit use PATCH /api/customers/:id.'
  });
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

// One agreement email per agreement per minute (QA m1) — factory lives in
// service-payment-guards.js with its truth table.
const checkAgreementEmailCooldown = makeSendCooldown(60_000);

rentalAgreementsRouter.post('/:id/email-agreement', async (req, res, next) => {
  try {
    await ensureAccessible(req.params.id, req.user);
    // VozIA (Hector 2026-08-03) — the agent console emails the customer a copy
    // of their agreement. Service accounts follow the send-request-email
    // contract: author+ticketId required (attribution to the human agent and
    // the case). The recipient is ALWAYS the on-file email and the CONTENT is
    // always the tenant template: the body is replaced with a whitelist — a
    // stripped `to` alone still left subject/html/text injectable, i.e.
    // arbitrary branded phishing with the real contract attached (QA M2).
    // Human path is UNCHANGED.
    if (req.user?.isServiceAccount) {
      const author = String(req.body?.author || '').trim();
      const ticketId = String(req.body?.ticketId || '').trim();
      const bad = checkServiceAccountAgreementEmail({ author, ticketId });
      if (bad.ok !== true) {
        return res.status(bad.statusCode).json({ error: bad.error });
      }
      req.body = { author, ticketId }; // whitelist: nothing else reaches the mailer
      // One send per agreement per minute — each send is a Puppeteer render on
      // the shared semaphore, and a retry loop would both spam the customer
      // and starve other PDF consumers (QA m1).
      if (!checkAgreementEmailCooldown(req.params.id)) {
        return res.status(429).json({ error: 'An agreement email was just sent. Please wait a moment before resending.' });
      }
      // Best-effort attribution row (same shape as writeVoziaReservationAudit,
      // which lives in reservations.routes and isn't imported here).
      try {
        const ag = await prisma.rentalAgreement.findUnique({
          where: { id: req.params.id },
          select: { reservationId: true, tenantId: true }
        });
        if (ag) {
          await prisma.auditLog.create({
            data: {
              tenantId: ag.tenantId || req.user?.tenantId || null,
              reservationId: ag.reservationId || null,
              actorUserId: req.user?.sub || null,
              action: 'UPDATE',
              metadata: JSON.stringify({ source: 'vozia', kind: 'agreement_email', ticketId, author })
            }
          });
        }
      } catch { /* audit is best-effort — never block the send */ }
    }
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

// RE-SCOPE (Hector, 2026-07-04): reverted to HUMAN-ONLY. The service account
// (VozIA) can no longer reach this route — it is REMOVED from the allowlist
// (service-account-allowlist.js), so requireAuth 403s it before any handler
// runs. VozIA now adjusts the balance + sends a self-pay link instead of
// capturing a card directly. This handler is byte-identical to its pre-Fase-6
// form (no isServiceAccount branch, no paymentIdempotency in the chain).
rentalAgreementsRouter.post('/:id/payments/manual', async (req, res, next) => {
  try {
    await ensureEditable(req.params.id, req.user);
    const row = await rentalAgreementsService.addManualPayment(req.params.id, req.body || {}, req.user?.sub || null);
    res.json(row);
  } catch (e) {
    if (/not found/i.test(e.message)) return res.status(404).json({ error: e.message });
    if (/amount|required|entrytype|reference/i.test(e.message)) return res.status(400).json({ error: e.message });
    next(e);
  }
});

rentalAgreementsRouter.post('/:id/customer/card-on-file', requireCapability('paymentActions'), async (req, res, next) => {
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

// RE-SCOPE (Hector, 2026-07-04): reverted to HUMAN-ONLY. Direct card capture by
// VozIA is removed — this route is off the allowlist, so a service account is
// 403'd upstream. Byte-identical to its pre-Fase-6 form.
rentalAgreementsRouter.post('/:id/payments/charge-card-on-file', requireCapability('paymentActions'), async (req, res, next) => {
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

rentalAgreementsRouter.post('/:id/security-deposit/capture', requireCapability('paymentActions'), async (req, res, next) => {
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

rentalAgreementsRouter.post('/:id/security-deposit/release', requireCapability('paymentActions'), async (req, res, next) => {
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

// Pillar 2 — Checkin wizard close endpoint.
// Runs fee engine (mileage/fuel/cleaning/smoking) → recomputes balance →
// routes to CHECKED_IN (balance=0) or CHECKED_IN_UNPAID + queues autocharge.
//
// Body shape:
//   {
//     odometerIn: number,
//     fuelIn: number (0..1),
//     cleanlinessIn: number (1..5),
//     smokingDetected: boolean,
//     signerName: string,
//     signatureDataUrl: string,
//     manualPayment: { amount, method, reference, last4, receiptUrl } | null
//   }
rentalAgreementsRouter.post('/:id/checkin-close', async (req, res, next) => {
  try {
    await ensureEditable(req.params.id, req.user);
    const out = await closeAgreementWithCheckinFees(
      req.params.id,
      req.body || {},
      req.user?.sub || null,
      req.ip || null,
      req.user?.role || 'AGENT'
    );
    res.json(out);
  } catch (e) {
    if (/not found/i.test(String(e?.message || ''))) return res.status(404).json({ error: e.message });
    if (/Cannot close agreement in status/i.test(String(e?.message || ''))) return res.status(409).json({ error: e.message });
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



// REMOVED 2026-07-25. This route called `rentalAgreementsService.deletePaymentHard`,
// which HAS NEVER EXISTED anywhere in the codebase — every call threw TypeError
// and returned 500. Same bug class as the removed `adjustCustomerCredit`
// (RES-849093 FIX 3c), and retired the same way rather than left as a dead
// route that 500s. No frontend calls it.
// To void a payment for bookkeeping (no refund), use the ADMIN-only
//   POST /api/reservations/:id/payments/:paymentId/void-no-refund
// which soft-voids with a mandatory reason and a full AuditLog entry.
// For a real card refund use POST /:id/payments/:paymentId/refund.
rentalAgreementsRouter.post('/:id/payments/:paymentId/void', async (req, res) => {
  res.status(410).json({
    error: 'Endpoint removed. Use POST /api/reservations/:id/payments/:paymentId/void-no-refund (admin, soft void with reason + audit), or /refund for a real card refund.'
  });
});

// CAP 2 (VozIA Fase 6 re-scope, 2026-07-04) — REFUND an existing payment.
// paymentIdempotency (kind:'payment') is REQUIRED for service accounts: it 400s a
// missing key, no-ops a retry, and holds a stuck-in-flight key as a 409 reconcile
// — the double-refund defense. Humans are byte-identical (no key → passthrough).
// The native refund<=original & cumulative<=original caps stay in refundPayment;
// the VozIA guard adds author+ticketId + an absolute ceiling on top.
rentalAgreementsRouter.post('/:id/payments/:paymentId/refund', requireCapability('paymentActions'), paymentIdempotency, async (req, res, next) => {
  try {
    const agreement = await ensureEditable(req.params.id, req.user);

    if (req.user?.isServiceAccount) {
      const maxRefund = await resolveVoziaCeiling(
        agreement?.tenantId || req.user?.tenantId || null,
        'voziaMaxRefundAmount',
        2000 // fail-safe LOW default
      );
      try {
        // Guard: author+ticket required; amount (if given) >0 and <= ceiling.
        assertServiceAccountRefundAllowed({ user: req.user, body: req.body || {}, maxRefund });
        const row = await rentalAgreementsService.refundPayment(req.params.id, req.params.paymentId, req.body || {}, req.user?.sub || null);
        // AuditLog on SUCCESS — record paymentId + the gateway ref for reconciliation.
        await writeVoziaPaymentAudit(agreement, req, { paymentId: req.params.paymentId, gatewayRef: row?.reference || null }, 'refund');
        return res.json(row);
      } catch (inner) {
        // AuditLog on FAILURE (guard rejection OR gateway error) so every VozIA
        // refund attempt stays tied to its ticket.
        await writeVoziaPaymentAudit(agreement, req, { paymentId: req.params.paymentId, error: inner?.message || 'error' }, 'refund');
        if (inner?.statusCode) return res.status(inner.statusCode).json(inner.details ? { error: inner.message, details: inner.details } : { error: inner.message });
        throw inner;
      }
    }

    const row = await rentalAgreementsService.refundPayment(req.params.id, req.params.paymentId, req.body || {}, req.user?.sub || null);
    res.json(row);
  } catch (e) {
    if (/not found/i.test(e.message)) return res.status(404).json({ error: e.message });
    if (/cannot|invalid|already|amount/i.test(e.message)) return res.status(400).json({ error: e.message });
    next(e);
  }
});

rentalAgreementsRouter.post('/:id/charge-card-on-file', requireCapability('paymentActions'), async (req, res, next) => {
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
// REMOVED 2026-07-25 — same story as /void above: `deletePaymentHard` does not
// exist, so this always 500'd. Retired as a 410 rather than left dead.
// The working equivalent is POST /api/reservations/:id/payments/:paymentId/delete.
rentalAgreementsRouter.post('/:id/payments/:paymentId/delete', async (req, res) => {
  res.status(410).json({
    error: 'Endpoint removed. Use POST /api/reservations/:id/payments/:paymentId/delete, or prefer the audited soft void at /void-no-refund.'
  });
});


// ============================================================================
// ADDENDUM_ROUTES (BUG-001 / Option C)
// Wire the addendum service methods (createAddendum, signAddendum, listAddendums,
// getAddendumById, voidAddendum, renderAddendumHtml) to HTTP. Tenant scoping is
// enforced via the existing ensureAccessible / ensureEditable helpers + scope
// `{ tenantId }` passed into service calls.
// ============================================================================

rentalAgreementsRouter.get('/:id/addendums', async (req, res, next) => {
  try {
    await ensureAccessible(req.params.id, req.user);
    const rows = await rentalAgreementsService.listAddendums(req.params.id, {
      tenantId: req.user?.tenantId || null
    });
    res.json(rows);
  } catch (e) {
    if (/not found/i.test(e.message)) return res.status(404).json({ error: e.message });
    next(e);
  }
});

rentalAgreementsRouter.get('/:id/addendums/:addendumId', async (req, res, next) => {
  try {
    await ensureAccessible(req.params.id, req.user);
    const row = await rentalAgreementsService.getAddendumById(req.params.addendumId, {
      tenantId: req.user?.tenantId || null
    });
    if (!row) return res.status(404).json({ error: 'Addendum not found' });
    if (row.rentalAgreementId !== req.params.id) {
      return res.status(404).json({ error: 'Addendum not found' });
    }
    res.json(row);
  } catch (e) {
    if (/not found/i.test(e.message)) return res.status(404).json({ error: e.message });
    next(e);
  }
});

rentalAgreementsRouter.post('/:id/addendums', async (req, res, next) => {
  try {
    if (!canManageAddendum(req.user)) {
      return res.status(403).json({ error: 'Admin or agent role required to create an addendum' });
    }
    await ensureEditable(req.params.id, req.user);

    const { newPickupAt, newReturnAt, reason, reasonCategory } = req.body || {};
    if (!newPickupAt || !newReturnAt) {
      return res.status(400).json({ error: 'newPickupAt and newReturnAt are required' });
    }

    const row = await rentalAgreementsService.createAddendum(req.params.id, {
      newPickupAt,
      newReturnAt,
      reason: reason || 'Date correction',
      reasonCategory: reasonCategory || 'admin_correction',
      initiatedBy: req.user?.sub || null,
      initiatedByRole: String(req.user?.role || 'ADMIN').toUpperCase()
    });

    // Fire-and-forget customer notification. Failures are logged inside the helper
    // and never surface to the caller — addendum creation must not roll back if
    // SMTP is down or the customer has no email on file.
    scheduleAddendumNotification(req.params.id, row.id, row.tenantId)
      .catch(() => { /* swallowed — internal logger handles failures */ });

    res.status(201).json(row);
  } catch (e) {
    if (/not found/i.test(e.message)) return res.status(404).json({ error: e.message });
    if (/required|invalid/i.test(e.message)) return res.status(400).json({ error: e.message });
    next(e);
  }
});

rentalAgreementsRouter.post('/:id/addendums/:addendumId/signature', async (req, res, next) => {
  try {
    const { signatureDataUrl, signatureSignedBy } = req.body || {};
    if (!signatureDataUrl) {
      return res.status(400).json({ error: 'signatureDataUrl is required' });
    }

    // Confirm the addendum belongs to this agreement and (when scoped) this tenant.
    const existing = await rentalAgreementsService.getAddendumById(req.params.addendumId, {
      tenantId: req.user?.tenantId || null
    });
    if (!existing || existing.rentalAgreementId !== req.params.id) {
      return res.status(404).json({ error: 'Addendum not found' });
    }

    const row = await rentalAgreementsService.signAddendum(req.params.addendumId, {
      signatureDataUrl,
      signatureSignedBy: signatureSignedBy || req.user?.fullName || req.user?.email || null,
      ip: req.ip
    });
    res.json(row);
  } catch (e) {
    if (/not found/i.test(e.message)) return res.status(404).json({ error: e.message });
    if (/cannot sign|required|invalid/i.test(e.message)) return res.status(400).json({ error: e.message });
    next(e);
  }
});

rentalAgreementsRouter.post('/:id/addendums/:addendumId/void', async (req, res, next) => {
  try {
    if (!canManageAddendum(req.user)) {
      return res.status(403).json({ error: 'Admin or agent role required to void an addendum' });
    }
    await ensureEditable(req.params.id, req.user);

    const existing = await rentalAgreementsService.getAddendumById(req.params.addendumId, {
      tenantId: req.user?.tenantId || null
    });
    if (!existing || existing.rentalAgreementId !== req.params.id) {
      return res.status(404).json({ error: 'Addendum not found' });
    }

    const reason = req.body?.reason || 'Voided by admin';
    const row = await rentalAgreementsService.voidAddendum(req.params.addendumId, reason, {
      tenantId: req.user?.tenantId || null
    });
    res.json(row);
  } catch (e) {
    if (/not found/i.test(e.message)) return res.status(404).json({ error: e.message });
    next(e);
  }
});

rentalAgreementsRouter.get('/:id/addendums/:addendumId/print', async (req, res, next) => {
  try {
    await ensureAccessible(req.params.id, req.user);

    // Tenant + agreement-membership check before render.
    const existing = await rentalAgreementsService.getAddendumById(req.params.addendumId, {
      tenantId: req.user?.tenantId || null
    });
    if (!existing || existing.rentalAgreementId !== req.params.id) {
      return res.status(404).json({ error: 'Addendum not found' });
    }

    const html = await rentalAgreementsService.renderAddendumHtml(req.params.addendumId);
    res.set('Content-Type', 'text/html').send(html);
  } catch (e) {
    if (/not found/i.test(e.message)) return res.status(404).json({ error: e.message });
    next(e);
  }
});

// Re-fire the customer signature email for a still-pending addendum. Surfaced
// from the AgreementAddendumsCard "Resend signature email" button. The email
// body is regenerated from the live row so any later edits to customerEmail
// flow through. Cooldown is intentionally absent in v1 — the admin button
// confirms before sending; if abuse becomes an issue we'll add a per-addendum
// throttle.
rentalAgreementsRouter.post('/:id/addendums/:addendumId/notify', async (req, res, next) => {
  try {
    if (!canManageAddendum(req.user)) {
      return res.status(403).json({ error: 'Admin or agent role required to resend addendum signature email' });
    }
    await ensureAccessible(req.params.id, req.user);

    const existing = await rentalAgreementsService.getAddendumById(req.params.addendumId, {
      tenantId: req.user?.tenantId || null
    });
    if (!existing || existing.rentalAgreementId !== req.params.id) {
      return res.status(404).json({ error: 'Addendum not found' });
    }
    const status = String(existing.status || '').toUpperCase();
    if (status !== 'PENDING_SIGNATURE') {
      return res.status(409).json({
        error: `Cannot resend signature email — addendum status is ${existing.status}`
      });
    }
    if (!existing.signatureToken) {
      return res.status(409).json({
        error: 'This addendum has no signature token (legacy data). Void it and create a new one to issue a fresh link.'
      });
    }
    // Sentry HIGH finding on PR #37: the customer-side public signing service
    // (addendum-signature-public.service.js) rejects with "Signature token is
    // invalid or expired" the moment now > signatureTokenExpiresAt. Without
    // this gate, /notify would email a fresh URL pointing at a dead link.
    // The token is issued for 14 days at createAddendum; long-pending addendums
    // are exactly when an admin is most likely to retry the email.
    if (
      existing.signatureTokenExpiresAt &&
      new Date(existing.signatureTokenExpiresAt).getTime() < Date.now()
    ) {
      return res.status(409).json({
        error: 'This addendum signing link has expired. Void it and create a new addendum to issue a fresh 14-day link.'
      });
    }

    // scheduleAddendumNotification never throws — failures are returned in the
    // result envelope { customer: {sent|skipped|error}, admin: {...} } so the
    // caller can show a precise toast (e.g. "no email on file").
    const result = await scheduleAddendumNotification(
      req.params.id,
      req.params.addendumId,
      req.user?.tenantId || null
    );
    res.status(202).json(result);
  } catch (e) {
    if (/not found/i.test(e.message)) return res.status(404).json({ error: e.message });
    next(e);
  }
});
