import { Router } from 'express';
import { settingsService } from './settings.service.js';
import { requireRole, isSuperAdmin } from '../../middleware/auth.js';
import { scopeFor } from '../../lib/tenant-scope.js';

import { prisma } from '../../lib/prisma.js';

export const settingsRouter = Router();

async function enforceUserModuleScope(req, res, next) {
  try {
    const target = await prisma.user.findUnique({
      where: { id: req.params.userId },
      select: { id: true, tenantId: true, createdByUserId: true }
    });
    if (!target) return res.status(404).json({ error: 'User not found' });
    if (!isSuperAdmin(req.user)) {
      if (!req.user?.tenantId || req.user.tenantId !== target.tenantId) return res.status(403).json({ error: 'Forbidden' });
    }
    req.targetUser = target;
    next();
  } catch (e) {
    next(e);
  }
}

settingsRouter.get('/tenant-modules', requireRole('ADMIN'), async (req, res, next) => {
  try {
    res.json(await settingsService.getTenantModuleAccess(scopeFor(req)));
  } catch (e) {
    next(e);
  }
});

settingsRouter.put('/tenant-modules', requireRole('ADMIN'), async (req, res, next) => {
  try {
    res.json(await settingsService.updateTenantModuleAccess(req.body || {}, scopeFor(req)));
  } catch (e) {
    next(e);
  }
});

settingsRouter.get('/users/:userId/module-access', requireRole('ADMIN'), enforceUserModuleScope, async (req, res, next) => {
  try {
    res.json(await settingsService.getUserModuleAccess(req.targetUser.id));
  } catch (e) {
    next(e);
  }
});

settingsRouter.put('/users/:userId/module-access', requireRole('ADMIN'), enforceUserModuleScope, async (req, res, next) => {
  try {
    res.json(await settingsService.updateUserModuleAccess(req.targetUser.id, req.body || {}));
  } catch (e) {
    next(e);
  }
});

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

settingsRouter.get('/payment-gateway', requireRole('ADMIN'), async (_req, res, next) => {
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

settingsRouter.post('/payment-gateway/health-check', requireRole('ADMIN'), async (req, res, next) => {
  try {
    const cfg = await settingsService.getPaymentGatewayConfig(scopeFor(req));
    const gateway = String(cfg?.gateway || 'authorizenet').toLowerCase();
    const portalBaseUrl = (process.env.CUSTOMER_PORTAL_BASE_URL || process.env.APP_BASE_URL || process.env.FRONTEND_BASE_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');
    const authNetWebhookUrl = `${portalBaseUrl}/api/public/payment-gateway/authorizenet/webhook`;
    const checks = {
      authorizenet: {
        selected: gateway === 'authorizenet',
        enabled: !!cfg?.authorizenet?.enabled,
        ready: !!(cfg?.authorizenet?.enabled && cfg?.authorizenet?.loginId && cfg?.authorizenet?.transactionKey),
        webhookReady: !!(cfg?.authorizenet?.enabled && cfg?.authorizenet?.signatureKey),
        environment: cfg?.authorizenet?.environment || 'sandbox',
        webhookUrl: authNetWebhookUrl,
        missing: [
          ...(!cfg?.authorizenet?.loginId ? ['API Login ID'] : []),
          ...(!cfg?.authorizenet?.transactionKey ? ['Transaction Key'] : [])
        ],
        webhookMissing: [
          ...(!cfg?.authorizenet?.signatureKey ? ['Signature Key'] : [])
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
        ? gateway === 'authorizenet' && !active.webhookReady
          ? `${String(gateway).toUpperCase()} checkout is ready, but webhook auto-confirm still needs Signature Key`
          : `${String(gateway).toUpperCase()} is configured and ready for this tenant`
        : `${String(gateway).toUpperCase()} is missing required credentials for this tenant`,
      checks
    });
  } catch (e) {
    next(e);
  }
});

settingsRouter.get('/planner-copilot', requireRole('ADMIN'), async (req, res, next) => {
  try {
    const cfg = await settingsService.getPlannerCopilotConfig(scopeFor(req));
    res.json(cfg);
  } catch (e) {
    if (/tenantId is required/i.test(String(e?.message || ''))) {
      return res.status(400).json({ error: 'tenantId is required for planner copilot settings' });
    }
    next(e);
  }
});

settingsRouter.put('/planner-copilot', requireRole('ADMIN'), async (req, res, next) => {
  try {
    const cfg = await settingsService.updatePlannerCopilotConfig(req.body || {}, scopeFor(req));
    res.json(cfg);
  } catch (e) {
    if (/tenantId is required/i.test(String(e?.message || ''))) {
      return res.status(400).json({ error: 'tenantId is required for planner copilot settings' });
    }
    next(e);
  }
});

settingsRouter.get('/planner-copilot/usage', requireRole('ADMIN'), async (req, res, next) => {
  try {
    const usage = await settingsService.getPlannerCopilotUsage(scopeFor(req));
    res.json(usage);
  } catch (e) {
    if (/tenantId is required/i.test(String(e?.message || ''))) {
      return res.status(400).json({ error: 'tenantId is required for planner copilot usage' });
    }
    next(e);
  }
});

settingsRouter.get('/telematics', async (req, res, next) => {
  try {
    const cfg = await settingsService.getTelematicsConfig(scopeFor(req));
    res.json(cfg);
  } catch (e) {
    if (/tenantId is required/i.test(String(e?.message || ''))) {
      return res.status(400).json({ error: 'tenantId is required for telematics settings' });
    }
    next(e);
  }
});

settingsRouter.get('/car-sharing-search-places', requireRole('ADMIN'), async (req, res, next) => {
  try {
    res.json(await settingsService.listCarSharingSearchPlacePresets(scopeFor(req)));
  } catch (e) {
    if (/tenantId is required/i.test(String(e?.message || ''))) {
      return res.status(400).json({ error: 'tenantId is required for car sharing presets' });
    }
    next(e);
  }
});

settingsRouter.post('/car-sharing-search-places', requireRole('ADMIN'), async (req, res, next) => {
  try {
    res.status(201).json(await settingsService.createCarSharingSearchPlacePreset(req.body || {}, scopeFor(req)));
  } catch (e) {
    if (/tenantId is required|label is required|invalid|anchor location/i.test(String(e?.message || ''))) {
      return res.status(400).json({ error: e.message });
    }
    next(e);
  }
});

settingsRouter.patch('/car-sharing-search-places/:id', requireRole('ADMIN'), async (req, res, next) => {
  try {
    res.json(await settingsService.updateCarSharingSearchPlacePreset(req.params.id, req.body || {}, scopeFor(req)));
  } catch (e) {
    if (/tenantId is required|not found|invalid|anchor location/i.test(String(e?.message || ''))) {
      return res.status(400).json({ error: e.message });
    }
    next(e);
  }
});

settingsRouter.delete('/car-sharing-search-places/:id', requireRole('ADMIN'), async (req, res, next) => {
  try {
    res.json(await settingsService.deleteCarSharingSearchPlacePreset(req.params.id, scopeFor(req)));
  } catch (e) {
    if (/tenantId is required|not found/i.test(String(e?.message || ''))) {
      return res.status(400).json({ error: e.message });
    }
    next(e);
  }
});

settingsRouter.put('/telematics', requireRole('ADMIN'), async (req, res, next) => {
  try {
    const cfg = await settingsService.updateTelematicsConfig(req.body || {}, scopeFor(req));
    res.json(cfg);
  } catch (e) {
    if (/tenantId is required/i.test(String(e?.message || ''))) {
      return res.status(400).json({ error: 'tenantId is required for telematics settings' });
    }
    next(e);
  }
});

settingsRouter.get('/revenue-pricing', requireRole('ADMIN'), async (req, res, next) => {
  try {
    const cfg = await settingsService.getRevenuePricingConfig(scopeFor(req));
    res.json(cfg);
  } catch (e) {
    if (/tenantId is required/i.test(String(e?.message || ''))) {
      return res.status(400).json({ error: 'tenantId is required for revenue pricing settings' });
    }
    next(e);
  }
});

settingsRouter.put('/revenue-pricing', requireRole('ADMIN'), async (req, res, next) => {
  try {
    const cfg = await settingsService.updateRevenuePricingConfig(req.body || {}, scopeFor(req));
    res.json(cfg);
  } catch (e) {
    if (/tenantId is required/i.test(String(e?.message || ''))) {
      return res.status(400).json({ error: 'tenantId is required for revenue pricing settings' });
    }
    next(e);
  }
});

settingsRouter.get('/precheckin-discount', requireRole('ADMIN'), async (req, res, next) => {
  try {
    res.json(await settingsService.getPrecheckinDiscount(scopeFor(req)));
  } catch (e) {
    next(e);
  }
});

settingsRouter.put('/precheckin-discount', requireRole('ADMIN'), async (req, res, next) => {
  try {
    res.json(await settingsService.updatePrecheckinDiscount(req.body || {}, scopeFor(req)));
  } catch (e) {
    next(e);
  }
});

settingsRouter.get('/self-service', requireRole('ADMIN'), async (req, res, next) => {
  try {
    const cfg = await settingsService.getSelfServiceConfig(scopeFor(req));
    res.json(cfg);
  } catch (e) {
    if (/tenantId is required/i.test(String(e?.message || ''))) {
      return res.status(400).json({ error: 'tenantId is required for self-service settings' });
    }
    next(e);
  }
});

settingsRouter.put('/self-service', requireRole('ADMIN'), async (req, res, next) => {
  try {
    const cfg = await settingsService.updateSelfServiceConfig(req.body || {}, scopeFor(req));
    res.json(cfg);
  } catch (e) {
    if (/tenantId is required/i.test(String(e?.message || ''))) {
      return res.status(400).json({ error: 'tenantId is required for self-service settings' });
    }
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
