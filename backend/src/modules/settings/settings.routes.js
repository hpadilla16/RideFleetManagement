import { Router } from 'express';
import { settingsService } from './settings.service.js';
import { requireRole, isSuperAdmin } from '../../middleware/auth.js';

export const settingsRouter = Router();

function scopeFor(req) {
  if (isSuperAdmin(req.user)) return req.query?.tenantId ? { tenantId: String(req.query.tenantId) } : {};
  return { tenantId: req.user?.tenantId || null };
}

settingsRouter.get('/email-templates', async (_req, res, next) => {
  try {
    const tpl = await settingsService.getEmailTemplates(scopeFor(_req));
    res.json(tpl);
  } catch (e) {
    next(e);
  }
});

settingsRouter.put('/email-templates', requireRole('ADMIN'), async (req, res, next) => {
  try {
    const tpl = await settingsService.updateEmailTemplates(req.body || {}, scopeFor(req));
    res.json(tpl);
  } catch (e) {
    next(e);
  }
});

settingsRouter.get('/insurance-plans', async (_req, res, next) => {
  try {
    const plans = await settingsService.getInsurancePlans(scopeFor(_req));
    res.json(plans);
  } catch (e) {
    next(e);
  }
});

settingsRouter.put('/insurance-plans', requireRole('ADMIN'), async (req, res, next) => {
  try {
    const plans = await settingsService.updateInsurancePlans(req.body?.plans || [], scopeFor(req));
    res.json(plans);
  } catch (e) {
    next(e);
  }
});

settingsRouter.get('/reservation-options', async (_req, res, next) => {
  try {
    const cfg = await settingsService.getReservationOptions(scopeFor(_req));
    res.json(cfg);
  } catch (e) {
    next(e);
  }
});

settingsRouter.put('/reservation-options', requireRole('ADMIN'), async (req, res, next) => {
  try {
    const cfg = await settingsService.updateReservationOptions(req.body || {}, scopeFor(req));
    res.json(cfg);
  } catch (e) {
    next(e);
  }
});

settingsRouter.get('/payment-gateway', async (_req, res, next) => {
  try {
    const cfg = await settingsService.getPaymentGatewayConfig(scopeFor(_req));
    res.json(cfg);
  } catch (e) {
    next(e);
  }
});

settingsRouter.put('/payment-gateway', requireRole('ADMIN'), async (req, res, next) => {
  try {
    const cfg = await settingsService.updatePaymentGatewayConfig(req.body || {}, scopeFor(req));
    res.json(cfg);
  } catch (e) {
    next(e);
  }
});

settingsRouter.get('/rental-agreement', async (_req, res, next) => {
  try {
    const cfg = await settingsService.getRentalAgreementConfig(scopeFor(_req));
    res.json(cfg);
  } catch (e) {
    next(e);
  }
});

settingsRouter.put('/rental-agreement', requireRole('ADMIN'), async (req, res, next) => {
  try {
    const cfg = await settingsService.updateRentalAgreementConfig(req.body || {}, scopeFor(req));
    res.json(cfg);
  } catch (e) {
    next(e);
  }
});

