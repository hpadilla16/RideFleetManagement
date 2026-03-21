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

dealershipLoanerRouter.get('/reservations/:id', async (req, res, next) => {
  try {
    res.json(await dealershipLoanerService.getReservation(req.user, req.params.id));
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

dealershipLoanerRouter.post('/reservations/:id/return-exception', async (req, res, next) => {
  try {
    res.json(await dealershipLoanerService.saveReturnException(req.user, req.params.id, req.body || {}));
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

dealershipLoanerRouter.post('/intake', async (req, res, next) => {
  try {
    const row = await dealershipLoanerService.intake(req.user, req.body || {});
    res.status(201).json(row);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});
