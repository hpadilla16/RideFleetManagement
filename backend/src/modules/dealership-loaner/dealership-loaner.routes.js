import { Router } from 'express';
import { prisma } from '../../lib/prisma.js';
import { isSuperAdmin, requireRole } from '../../middleware/auth.js';
import { dealershipLoanerService } from './dealership-loaner.service.js';

export const dealershipLoanerRouter = Router();

async function ensureLoanerEnabled(req, res, next) {
  try {
    if (isSuperAdmin(req.user)) return next();
    const tenantId = req.user?.tenantId || null;
    if (!tenantId) return res.status(403).json({ error: 'Dealership loaner is not enabled for this tenant' });
    const tenant = await prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { dealershipLoanerEnabled: true }
    });
    if (!tenant?.dealershipLoanerEnabled) {
      return res.status(403).json({ error: 'Dealership loaner is not enabled for this tenant' });
    }
    next();
  } catch (error) {
    next(error);
  }
}

dealershipLoanerRouter.use(requireRole('ADMIN', 'OPS', 'AGENT'));

dealershipLoanerRouter.get('/config', async (req, res, next) => {
  try {
    const tenantId = isSuperAdmin(req.user) ? (req.query?.tenantId ? String(req.query.tenantId) : null) : null;
    res.json(await dealershipLoanerService.getConfig(req.user, tenantId));
  } catch (error) {
    next(error);
  }
});

dealershipLoanerRouter.use(ensureLoanerEnabled);

dealershipLoanerRouter.get('/intake-options', async (req, res, next) => {
  try {
    res.json(await dealershipLoanerService.getIntakeOptions(req.user));
  } catch (error) {
    next(error);
  }
});

dealershipLoanerRouter.get('/dashboard', async (req, res, next) => {
  try {
    res.json(await dealershipLoanerService.getDashboard(req.user, {
      query: req.query?.q ? String(req.query.q) : ''
    }));
  } catch (error) {
    next(error);
  }
});

dealershipLoanerRouter.get('/billing-export', async (req, res, next) => {
  try {
    const csv = await dealershipLoanerService.exportBillingCsv(req.user, {
      query: req.query?.q ? String(req.query.q) : '',
      billingStatus: req.query?.billingStatus ? String(req.query.billingStatus) : '',
      billingMode: req.query?.billingMode ? String(req.query.billingMode) : '',
      startDate: req.query?.startDate ? String(req.query.startDate) : '',
      endDate: req.query?.endDate ? String(req.query.endDate) : ''
    });
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="loaner-billing-export.csv"`);
    res.send(csv);
  } catch (error) {
    next(error);
  }
});

dealershipLoanerRouter.get('/statement-export', async (req, res, next) => {
  try {
    const csv = await dealershipLoanerService.exportStatementCsv(req.user, {
      query: req.query?.q ? String(req.query.q) : '',
      billingStatus: req.query?.billingStatus ? String(req.query.billingStatus) : '',
      billingMode: req.query?.billingMode ? String(req.query.billingMode) : '',
      startDate: req.query?.startDate ? String(req.query.startDate) : '',
      endDate: req.query?.endDate ? String(req.query.endDate) : ''
    });
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="loaner-dealer-statement.csv"');
    res.send(csv);
  } catch (error) {
    next(error);
  }
});

dealershipLoanerRouter.get('/statement-print', async (req, res, next) => {
  try {
    const html = await dealershipLoanerService.renderStatementPrint(req.user, {
      query: req.query?.q ? String(req.query.q) : '',
      billingStatus: req.query?.billingStatus ? String(req.query.billingStatus) : '',
      billingMode: req.query?.billingMode ? String(req.query.billingMode) : '',
      startDate: req.query?.startDate ? String(req.query.startDate) : '',
      endDate: req.query?.endDate ? String(req.query.endDate) : ''
    });
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    // Anti-clickjacking (DAST 2026-08-23): a server-rendered print view with no
    // embedded third-party content and no reason to be framed — same treatment
    // as the public-booking payment terminal pages.
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Content-Security-Policy', "frame-ancestors 'none'");
    res.send(html);
  } catch (error) {
    next(error);
  }
});

dealershipLoanerRouter.get('/reservations/:id', async (req, res, next) => {
  try {
    res.json(await dealershipLoanerService.getReservation(req.user, req.params.id));
  } catch (error) {
    res.status(404).json({ error: error.message });
  }
});

dealershipLoanerRouter.get('/reservations/:id/handoff-print', async (req, res, next) => {
  try {
    const html = await dealershipLoanerService.renderHandoffPrint(req.user, req.params.id);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(html);
  } catch (error) {
    res.status(404).json({ error: error.message });
  }
});

dealershipLoanerRouter.get('/reservations/:id/billing-print', async (req, res, next) => {
  try {
    const html = await dealershipLoanerService.renderBillingPrint(req.user, req.params.id);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(html);
  } catch (error) {
    res.status(404).json({ error: error.message });
  }
});

dealershipLoanerRouter.get('/reservations/:id/purchase-order-print', async (req, res, next) => {
  try {
    const html = await dealershipLoanerService.renderPurchaseOrderPrint(req.user, req.params.id);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(html);
  } catch (error) {
    res.status(404).json({ error: error.message });
  }
});

dealershipLoanerRouter.post('/reservations/:id/borrower-packet', async (req, res, next) => {
  try {
    res.json(await dealershipLoanerService.saveBorrowerPacket(req.user, req.params.id, req.body || {}));
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

dealershipLoanerRouter.post('/reservations/:id/billing', async (req, res, next) => {
  try {
    res.json(await dealershipLoanerService.saveBilling(req.user, req.params.id, req.body || {}));
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

dealershipLoanerRouter.post('/reservations/:id/accounting-closeout', async (req, res, next) => {
  try {
    res.json(await dealershipLoanerService.saveAccountingCloseout(req.user, req.params.id, req.body || {}));
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

dealershipLoanerRouter.post('/reservations/:id/advisor-ops', async (req, res, next) => {
  try {
    res.json(await dealershipLoanerService.saveAdvisorOps(req.user, req.params.id, req.body || {}));
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

dealershipLoanerRouter.post('/reservations/:id/return-exception', async (req, res, next) => {
  try {
    res.json(await dealershipLoanerService.saveReturnException(req.user, req.params.id, req.body || {}));
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

dealershipLoanerRouter.post('/reservations/:id/extend', async (req, res, next) => {
  try {
    res.json(await dealershipLoanerService.extendLoaner(req.user, req.params.id, req.body || {}));
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

dealershipLoanerRouter.post('/reservations/:id/swap-vehicle', async (req, res, next) => {
  try {
    res.json(await dealershipLoanerService.swapVehicle(req.user, req.params.id, req.body || {}));
  } catch (error) {
    // resolveSwapPhotoOverride tags its refusals (403 non-admin, 400 empty
    // reason). Everything else keeps this route's existing 400-with-message
    // behavior — including "Vehicle swap blocked: ..." from the photo gate,
    // which is operator-actionable.
    res.status(error?.status || 400).json({ error: error.message });
  }
});

dealershipLoanerRouter.post('/reservations/:id/send-prearrival', async (req, res, next) => {
  try {
    res.json(await dealershipLoanerService.sendPreArrivalLink(req.user, req.params.id));
  } catch (error) {
    res.status(error.statusCode || 400).json({ error: error.message });
  }
});

dealershipLoanerRouter.post('/reservations/:id/complete-service', async (req, res, next) => {
  try {
    res.json(await dealershipLoanerService.completeService(req.user, req.params.id, req.body || {}));
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

dealershipLoanerRouter.post('/intake', async (req, res, next) => {
  try {
    const row = await dealershipLoanerService.intake(req.user, req.body || {});
    res.status(201).json(row);
  } catch (error) {
    // Pass a MACHINE code through when the error carries one. Intake is the one
    // capture surface where the counter never saw CUSTOMER_EMAIL_INVALID: this
    // handler flattens everything to a bare 400, so the form could not tell
    // "that email is not an address" from "that vehicle is already out" and had
    // no field to highlight. Errors without a code are unchanged.
    //
    // The STATUS deliberately stays a hard 400. Honouring error.status would
    // also re-route every OTHER typed failure this handler currently flattens,
    // and re-statusing an endpoint the counter UI already reads is a separate
    // change with its own blast radius. The email refusal is a 400 either way,
    // so nothing is lost by leaving that alone.
    res.status(400).json({
      error: error.message,
      ...(error.code ? { code: error.code } : {})
    });
  }
});

// Courtesy-car requests (public "request a loaner" leads) — list + status update for the advisor queue.
dealershipLoanerRouter.get('/requests', async (req, res, next) => {
  try {
    res.json(await dealershipLoanerService.listLoanerRequests(req.user, {
      status: req.query?.status ? String(req.query.status) : '',
      query: req.query?.q ? String(req.query.q) : ''
    }));
  } catch (error) {
    next(error);
  }
});

dealershipLoanerRouter.patch('/requests/:id', async (req, res, next) => {
  try {
    res.json(await dealershipLoanerService.updateLoanerRequest(req.user, req.params.id, req.body || {}));
  } catch (error) {
    res.status(error.statusCode || 400).json({ error: error.message });
  }
});

// Customer Requests queue (portal-initiated extension / scheduled-return).
dealershipLoanerRouter.get('/customer-requests', async (req, res, next) => {
  try { res.json(await dealershipLoanerService.listCustomerRequests(req.user)); }
  catch (error) { next(error); }
});

dealershipLoanerRouter.post('/customer-requests/:id/resolve', async (req, res, next) => {
  try { res.json(await dealershipLoanerService.resolveCustomerRequest(req.user, req.params.id, req.body || {})); }
  catch (error) { res.status(error.statusCode || 400).json({ error: error.message }); }
});
