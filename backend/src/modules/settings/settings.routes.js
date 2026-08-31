import { Router } from 'express';
import { settingsService } from './settings.service.js';
import { franchiseService } from './franchise.service.js';
import { requireRole, isSuperAdmin } from '../../middleware/auth.js';
import { scopeFor } from '../../lib/tenant-scope.js';

import { prisma } from '../../lib/prisma.js';
import {
  recordModuleAccessAudit,
  getStoredUserModuleConfig,
  getTenantModuleConfig
} from '../../lib/module-access.js';
import { auditFromReq, AUDIT_ACTIONS } from '../audit/audit.service.js';
import { buildTerminalAuditMetadata } from '../payment-gateway/tenant-terminal-config.js';

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
    // AUDITED for the same reason as the per-user route below — and this one
    // matters MORE: one save here can strip paymentActions from every OPS user
    // and agent in the tenant at once. Tenant-config-before vs
    // tenant-config-after, so both sides come from the same layer.
    const scope = scopeFor(req);
    const before = await getTenantModuleConfig(scope?.tenantId || null).catch(() => ({}));
    const out = await settingsService.updateTenantModuleAccess(req.body || {}, scope);

    await recordModuleAccessAudit({
      scope: 'TENANT',
      tenantId: scope?.tenantId || null,
      actor: req.user,
      before,
      after: out?.config || {}
    });

    // Wave 3: also record on the unified admin trail (ModuleAccessAuditLog stays
    // the detailed system of record; this gives one place to see all admin acts).
    auditFromReq(req, {
      action: AUDIT_ACTIONS.USER_MODULE_ACCESS_CHANGE,
      targetType: 'TENANT',
      targetId: scope?.tenantId || null,
      metadata: { scope: 'TENANT' },
    });

    res.json(out);
  } catch (e) {
    next(e);
  }
});

// Market Intelligence dashboard SIPP picker (beta.134). ADMIN-scoped per tenant.
settingsRouter.get('/dashboard-sipps', requireRole('ADMIN'), async (req, res, next) => {
  try {
    res.json(await settingsService.getDashboardSipps(scopeFor(req)));
  } catch (e) {
    next(e);
  }
});

settingsRouter.put('/dashboard-sipps', requireRole('ADMIN'), async (req, res, next) => {
  try {
    res.json(await settingsService.updateDashboardSipps(req.body || {}, scopeFor(req)));
  } catch (e) {
    next(e);
  }
});

// Market Intelligence excluded competitors (per-tenant pool hygiene). ADMIN-scoped.
settingsRouter.get('/market-excluded-vendors', requireRole('ADMIN'), async (req, res, next) => {
  try {
    res.json(await settingsService.getMarketExcludedVendors(scopeFor(req)));
  } catch (e) {
    next(e);
  }
});

settingsRouter.put('/market-excluded-vendors', requireRole('ADMIN'), async (req, res, next) => {
  try {
    res.json(await settingsService.updateMarketExcludedVendors(req.body || {}, scopeFor(req)));
  } catch (e) {
    next(e);
  }
});

// Tax-aware Market pricing config per location (Amadeus/Titanium, taxes, brokerage, floor).
settingsRouter.get('/market-pricing-config', requireRole('ADMIN'), async (req, res, next) => {
  try {
    res.json(await settingsService.listMarketPricingConfigs(scopeFor(req)));
  } catch (e) {
    next(e);
  }
});

settingsRouter.put('/market-pricing-config', requireRole('ADMIN'), async (req, res, next) => {
  try {
    res.json(await settingsService.upsertMarketPricingConfig(req.body || {}, scopeFor(req)));
  } catch (e) {
    next(e);
  }
});

settingsRouter.delete('/market-pricing-config/:locationCode', requireRole('ADMIN'), async (req, res, next) => {
  try {
    res.json(await settingsService.deleteMarketPricingConfig(req.params.locationCode, scopeFor(req)));
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
    // AUDIT (2026-07-25). paymentActions authorizes charging and refunding a
    // customer's card, so "who gave this agent the ability to refund, and when"
    // has to be answerable. These writes previously touched only an AppSetting
    // row and left no trace.
    //
    // STORED-vs-STORED. getUserModuleAccess() returns the EFFECTIVE map
    // (role ∧ tenant ∧ stored) while the update returns the STORED map;
    // diffing one against the other invents phantom changes wherever role or
    // tenant denies a module the stored blob says true, and misses real ones.
    const before = await getStoredUserModuleConfig(req.targetUser.id).catch(() => ({}));
    const out = await settingsService.updateUserModuleAccess(req.targetUser.id, req.body || {});
    const after = out?.config || {};

    await recordModuleAccessAudit({
      scope: 'USER',
      tenantId: req.targetUser.tenantId || req.user?.tenantId || null,
      targetUserId: req.targetUser.id,
      actor: req.user,
      before,
      after
    });

    // Wave 3: unified admin trail (ModuleAccessAuditLog remains the detailed record).
    auditFromReq(req, {
      action: AUDIT_ACTIONS.USER_MODULE_ACCESS_CHANGE,
      targetType: 'USER',
      targetId: req.targetUser.id,
      metadata: { scope: 'USER' },
    });

    res.json(out);
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

settingsRouter.get('/review-email', async (_req, res, next) => {
  try {
    const cfg = await settingsService.getReviewEmailConfig(scopeFor(_req));
    res.json(cfg);
  } catch (e) {
    next(e);
  }
});

settingsRouter.put('/review-email', requireRole('ADMIN'), async (req, res, next) => {
  try {
    const cfg = await settingsService.updateReviewEmailConfig(req.body || {}, scopeFor(req));
    res.json(cfg);
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

// Customer-led inspection (2026-06-11): enable/disable per tenant.
settingsRouter.get('/customer-inspection', async (_req, res, next) => {
  try {
    const cfg = await settingsService.getCustomerInspectionConfig(scopeFor(_req));
    res.json(cfg);
  } catch (e) {
    next(e);
  }
});

settingsRouter.put('/customer-inspection', requireRole('ADMIN'), async (req, res, next) => {
  try {
    const cfg = await settingsService.updateCustomerInspectionConfig(req.body || {}, scopeFor(req));
    res.json(cfg);
  } catch (e) {
    next(e);
  }
});

// Checkout payment policy (2026-08-26): does this tenant's check-out wizard
// force the payment step? Default TRUE (unchanged behavior); Rent & Go by VPH
// Motors runs it OFF. ADMIN-gated; SUPER_ADMIN targets a tenant with ?tenantId
// through the same scopeFor() super-scoping every other settings route uses.
// FAIL-CLOSED: no tenantId → 400, never a global write.
settingsRouter.get('/checkout-payment', requireRole('ADMIN'), async (req, res, next) => {
  try {
    res.json(await settingsService.getCheckoutPaymentPolicy(scopeFor(req)));
  } catch (e) {
    if (/tenantId is required/i.test(String(e?.message || ''))) {
      return res.status(400).json({ error: 'tenantId is required for checkout payment settings' });
    }
    next(e);
  }
});

settingsRouter.put('/checkout-payment', requireRole('ADMIN'), async (req, res, next) => {
  try {
    const scope = scopeFor(req);
    const out = await settingsService.updateCheckoutPaymentPolicy(req.body || {}, scope);
    // Money-path policy change — audited on the unified admin trail. Metadata is
    // the new boolean + tenantId only; no PII, no amounts.
    auditFromReq(req, {
      action: AUDIT_ACTIONS.CHECKOUT_PAYMENT_POLICY_CHANGE,
      targetType: 'TENANT',
      targetId: scope?.tenantId || null,
      metadata: { checkoutPaymentRequired: out.checkoutPaymentRequired, tenantId: scope?.tenantId || null },
    });
    res.json(out);
  } catch (e) {
    if (/tenantId is required/i.test(String(e?.message || ''))) {
      return res.status(400).json({ error: 'tenantId is required for checkout payment settings' });
    }
    if (/must be a boolean/i.test(String(e?.message || ''))) {
      return res.status(400).json({ error: e.message });
    }
    next(e);
  }
});

// Vehicle Profile pack (2026-06-10): fleet rotation rule (TIME | MILEAGE).
settingsRouter.get('/fleet-rotation', async (_req, res, next) => {
  try {
    const cfg = await settingsService.getFleetRotationConfig(scopeFor(_req));
    res.json(cfg);
  } catch (e) {
    next(e);
  }
});

settingsRouter.put('/fleet-rotation', requireRole('ADMIN'), async (req, res, next) => {
  try {
    const cfg = await settingsService.updateFleetRotationConfig(req.body || {}, scopeFor(req));
    res.json(cfg);
  } catch (e) {
    next(e);
  }
});

// Citations OCR — per-tenant vision-LLM credentials. GET returns masked config
// (provider/model/hasKey, never the key). PUT (ADMIN) sets provider/model/apiKey
// (key stored encrypted). { clearKey:true } removes the stored key.
settingsRouter.get('/citation-ocr', async (_req, res, next) => {
  try {
    res.json(await settingsService.getCitationOcrConfig(scopeFor(_req)));
  } catch (e) {
    next(e);
  }
});

settingsRouter.put('/citation-ocr', requireRole('ADMIN'), async (req, res, next) => {
  try {
    res.json(await settingsService.updateCitationOcrConfig(req.body || {}, scopeFor(req)));
  } catch (e) {
    next(e);
  }
});

// Staff 2FA policy (2026-08-22). ADMIN sets the policy for their tenant;
// SUPER_ADMIN (scopeFor → {}) sets the unscoped GLOBAL default that applies to
// every tenant without an override. Mirrors the citation-ocr scoping.
settingsRouter.get('/two-factor-policy', requireRole('ADMIN'), async (req, res, next) => {
  try {
    res.json(await settingsService.getTwoFactorPolicy(scopeFor(req)));
  } catch (e) {
    next(e);
  }
});

settingsRouter.put('/two-factor-policy', requireRole('ADMIN'), async (req, res, next) => {
  try {
    const result = await settingsService.updateTwoFactorPolicy(req.body || {}, scopeFor(req));
    // Wave 3: who changed the tenant (or global) 2FA policy, and when. A
    // super-admin (scopeFor → {}) is editing the GLOBAL default; targetId null.
    auditFromReq(req, {
      action: AUDIT_ACTIONS.TWO_FACTOR_POLICY_CHANGE,
      targetType: 'TENANT',
      targetId: scopeFor(req)?.tenantId || null,
    });
    res.json(result);
  } catch (e) {
    if (e?.code === 'ENCRYPTION_NOT_CONFIGURED') {
      return res.status(400).json({ error: e.message, code: e.code });
    }
    if (/invalid role|graceUntil|at least one required role/i.test(String(e?.message || ''))) {
      return res.status(400).json({ error: e.message });
    }
    next(e);
  }
});

// Long-term (monthly) billing — email templates + dunning/billing config.
// Stored in appSetting key 'longTermEmailTemplates' (tenant-scoped).
// Defaults + normalization live in modules/long-term/long-term-emails.js.
settingsRouter.get('/long-term-email-templates', async (_req, res, next) => {
  try {
    const { getLongTermEmailConfig } = await import('../long-term/long-term-emails.js');
    res.json(await getLongTermEmailConfig(scopeFor(_req)));
  } catch (e) {
    next(e);
  }
});

settingsRouter.put('/long-term-email-templates', requireRole('ADMIN'), async (req, res, next) => {
  try {
    const { updateLongTermEmailConfig } = await import('../long-term/long-term-emails.js');
    res.json(await updateLongTermEmailConfig(req.body || {}, scopeFor(req)));
  } catch (e) {
    next(e);
  }
});

/**
 * GET /api/settings/payment-capabilities (2026-08-30, View Payments redesign).
 *
 * Booleans-only gateway capabilities for the reservation View Payments screen.
 * Mounted in main.js BEFORE the module-gated settings mount (same precedent as
 * /api/settings/fee-rates): OPS/AGENT counter staff do not have the 'settings'
 * module, but the payments screen must know the tenant's gateway to draw the
 * right controls — an iPOS tenant must never see Authorize.Net furniture.
 *
 * DO NOT fold this into GET /payment-gateway: that route is ADMIN-gated
 * because it returns credential-bearing config. This one returns booleans
 * derived by derivePaymentCapabilities and nothing else.
 */
export const paymentCapabilitiesRouter = Router();
paymentCapabilitiesRouter.get('/', async (req, res, next) => {
  try {
    res.json(await settingsService.getPaymentCapabilities(scopeFor(req)));
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
    const scope = scopeFor(req);
    const cfg = await settingsService.updatePaymentGatewayConfig(req.body || {}, scope);
    // MONEY PATH. This row decides which merchant account a tenant's card
    // charges settle into, so the change is audited on the unified admin trail.
    // Metadata is deliberately credential-free: gateway, flags, a MASKED TPN
    // and booleans. The auth key itself never appears here.
    auditFromReq(req, {
      action: AUDIT_ACTIONS.PAYMENT_TERMINAL_CONFIG_CHANGE,
      targetType: 'TENANT',
      targetId: scope?.tenantId || null,
      metadata: buildTerminalAuditMetadata(cfg, req.body || {}, scope?.tenantId || null),
    });
    res.json(cfg);
  } catch (e) {
    // A new terminal credential cannot be stored without INTEGRATION_ENC_KEY —
    // refusing the save beats writing a live payment key in plaintext.
    if (e?.code === 'ENCRYPTION_NOT_CONFIGURED') {
      return res.status(400).json({ error: e.message, code: e.code });
    }
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
      },
      // iPOSpays Hosted Payment Page — customer payment links. The token
      // itself never reaches this read shape; `hasHppToken` says one is on
      // file. The TPN may come from the spin block (same tenant's merchant).
      ipos: {
        selected: gateway === 'ipos',
        enabled: !!cfg?.ipos?.enabled,
        ready: !!(cfg?.ipos?.hasHppToken && (cfg?.ipos?.tpn || cfg?.spin?.tpn)),
        environment: cfg?.ipos?.environment || 'production',
        missing: [
          ...(!(cfg?.ipos?.tpn || cfg?.spin?.tpn) ? ['CloudPOS TPN'] : []),
          ...(!cfg?.ipos?.hasHppToken ? ['HPP Auth Token'] : [])
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

settingsRouter.get('/precheckin-auto-email', requireRole('ADMIN'), async (req, res, next) => {
  try {
    res.json(await settingsService.getPrecheckinAutoEmail(scopeFor(req)));
  } catch (e) {
    next(e);
  }
});

settingsRouter.put('/precheckin-auto-email', requireRole('ADMIN'), async (req, res, next) => {
  try {
    res.json(await settingsService.updatePrecheckinAutoEmail(req.body || {}, scopeFor(req)));
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

// ── Franchise Management ──

settingsRouter.get('/franchises', async (req, res, next) => {
  try {
    res.json(await franchiseService.listAll(scopeFor(req)));
  } catch (e) { next(e); }
});

settingsRouter.get('/franchises/active', async (req, res, next) => {
  try {
    res.json(await franchiseService.list(scopeFor(req)));
  } catch (e) { next(e); }
});

settingsRouter.get('/franchises/:id', async (req, res, next) => {
  try {
    res.json(await franchiseService.getById(req.params.id, scopeFor(req)));
  } catch (e) { next(e); }
});

settingsRouter.post('/franchises', async (req, res, next) => {
  try {
    res.status(201).json(await franchiseService.create(req.body || {}, scopeFor(req)));
  } catch (e) { next(e); }
});

settingsRouter.patch('/franchises/:id', async (req, res, next) => {
  try {
    res.json(await franchiseService.update(req.params.id, req.body || {}, scopeFor(req)));
  } catch (e) { next(e); }
});

settingsRouter.delete('/franchises/:id', async (req, res, next) => {
  try {
    res.json(await franchiseService.delete(req.params.id, scopeFor(req)));
  } catch (e) { next(e); }
});
