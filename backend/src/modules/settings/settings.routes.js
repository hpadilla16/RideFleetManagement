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

settingsRouter.post('/payment-gateway/health-check', async (req, res, next) => {
  try {
    const cfg = await settingsService.getPaymentGatewayConfig(scopeFor(req));
    const gateway = String(cfg?.gateway || 'authorizenet').toLowerCase();
    const checks = {
      authorizenet: {
        selected: gateway === 'authorizenet',
        enabled: !!cfg?.authorizenet?.enabled,
        ready: !!(cfg?.authorizenet?.enabled && cfg?.authorizenet?.loginId && cfg?.authorizenet?.transactionKey),
        environment: cfg?.authorizenet?.environment || 'sandbox',
        missing: [
          ...(!cfg?.authorizenet?.loginId ? ['API Login ID'] : []),
          ...(!cfg?.authorizenet?.transactionKey ? ['Transaction Key'] : [])
        ]
      },
      stripe: {
        selected: gateway === 'stripe',
        enabled: !!cfg?.stripe?.enabled,
        ready: !!(cfg?.stripe?.enabled && cfg?.stripe?.secretKey),
        missing: [
          ...(!cfg?.stripe?.secretKey ? ['Secret Key'] : []),
          ...(!cfg?.stripe?.publishableKey ? ['Publishable Key'] : [])
        ]
      },
      square: {
        selected: gateway === 'square',
        enabled: !!cfg?.square?.enabled,
        ready: !!(cfg?.square?.enabled && cfg?.square?.accessToken && cfg?.square?.locationId),
        environment: cfg?.square?.environment || 'production',
        missing: [
          ...(!cfg?.square?.accessToken ? ['Access Token'] : []),
          ...(!cfg?.square?.locationId ? ['Location ID'] : [])
        ]
      }
    };
    const active = checks[gateway] || checks.authorizenet;
    res.json({
      gateway,
      ready: !!active.ready,
      summary: active.ready
        ? `${String(gateway).toUpperCase()} is configured and ready for this tenant`
        : `${String(gateway).toUpperCase()} is missing required credentials for this tenant`,
      checks
    });
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

