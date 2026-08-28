import { Router } from 'express';
import { isSuperAdmin } from '../../middleware/auth.js';
import { tenantsService } from './tenants.service.js';
import { demoResetService } from './demo-reset.service.js';
import { billingService } from '../billing/billing.service.js';
import { billingAdminRouter } from '../billing/billing-admin.routes.js';
import { auditFromReq, AUDIT_ACTIONS } from '../audit/audit.service.js';

export const tenantsRouter = Router();

function requireSuperAdmin(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
  if (!isSuperAdmin(req.user)) return res.status(403).json({ error: 'Super admin only' });
  next();
}

tenantsRouter.use(requireSuperAdmin);

tenantsRouter.get('/', async (_req, res, next) => {
  try {
    res.json(await tenantsService.list());
  } catch (e) {
    next(e);
  }
});

tenantsRouter.get('/plan-catalog', async (_req, res, next) => {
  try {
    res.json(await tenantsService.getPlanCatalog());
  } catch (e) {
    next(e);
  }
});

/**
 * The catalog now carries PRICES as well as entitlements (tenant subscriptions,
 * 2026-08-27), so editing it decides what the next enrollment invite offers.
 * Not itself a charge — a live subscriber's price is snapshotted on their
 * subscription and cannot be moved from here — but "who changed the price list,
 * and when" has to be answerable from the trail alone.
 *
 * Metadata carries plan codes and prices only. No PII, no credentials.
 */
tenantsRouter.put('/plan-catalog', async (req, res) => {
  try {
    const saved = await tenantsService.savePlanCatalog(req.body?.plans || []);
    auditFromReq(req, {
      action: AUDIT_ACTIONS.BILLING_PLAN_CATALOG_CHANGE,
      targetType: 'AppSetting',
      targetId: 'tenantPlanCatalog',
      metadata: {
        plans: saved.map((p) => ({
          code: p.code,
          billable: p.billable,
          priceMonthly: p.priceMonthly,
          priceAnnual: p.priceAnnual,
          currency: p.currency,
          trialDays: p.trialDays,
          isActive: p.isActive,
        })),
      },
    });
    res.json(saved);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

/**
 * The SUPER_ADMIN billing panel (Phase 4) — /api/tenants/billing/**.
 *
 * Mounted HERE rather than as its own top-level app.use so it inherits this
 * router's guard stack unchanged: requireAuth + tenantRateLimit +
 * requireModuleAccess('tenants') from main.js, and requireSuperAdmin above.
 * Reusing the `tenants` module key is deliberate (design §7.1) — a new key would
 * ripple through lib/module-access.js and trip test:module-defaults-drift for no
 * gain, since anyone who can see Tenants should see Tenant Billing.
 *
 * Registered BEFORE `/:id` so the literal `billing` segment is never swallowed
 * by the parameter route, exactly as `/plan-catalog` is above.
 */
tenantsRouter.use('/billing', billingAdminRouter);

tenantsRouter.post('/', async (req, res, next) => {
  try {
    const tenant = await tenantsService.createTenant(req.body || {});
    res.status(201).json(tenant);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

tenantsRouter.patch('/:id', async (req, res, next) => {
  try {
    const tenant = await tenantsService.updateTenant(req.params.id, req.body || {});
    res.json(tenant);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

/**
 * Mint an autopay enrollment link for this tenant — Phase 3's ONE write.
 *
 * Not a panel. Design §7 gives billing its own screens in Phase 4; this is the
 * single "Send enroll link" action hung off the existing /tenants row, and it
 * is deliberately the only billing mutation that exists before that panel does.
 * There is no cancel here, no plan change, no manual charge: each of those has
 * an invariant attached (§2.2, §6) that a convenience button must not be able
 * to trip by implication.
 *
 * SUPER_ADMIN only, by the router-level guard above — NOT `requireRole`, which
 * short-circuits on isSuperAdmin before it checks the list and would therefore
 * let an ADMIN through if the list ever changed (design §8).
 *
 * THE RESPONSE CARRIES THE PLAINTEXT TOKEN, EXACTLY ONCE, INSIDE THE URL. It is
 * stored only as a sha256 hash, so this response is the only chance to capture
 * it and there is no "show me that link again". That is a deliberate cost of
 * hashing (autopay-invites.service.js) and the reason the caller is expected to
 * put it straight into an email. It is never logged and never audited — the
 * audit row carries the 8-character tokenPrefix so support can answer "is this
 * the link I sent?" without the trail itself becoming a way in.
 *
 * 400, not 500, on a refusal: "this tenant already has a live subscription" and
 * "that plan has no price" are both things the operator can act on, and they
 * arrive while he is looking at the row he just clicked.
 */
tenantsRouter.post('/:id/billing/enroll-link', requireSuperAdmin, async (req, res) => {
  try {
    const body = req.body || {};
    const out = await billingService.issueEnrollInvite({
      tenantId: req.params.id,
      planCode: body.planCode,
      cycle: body.cycle || 'monthly',
      email: body.email,
      companyName: body.companyName,
      // A negotiated per-tenant price. Passed through as an OVERRIDE so the
      // catalog is not edited and no other tenant's default moves — the price
      // lands on this subscription and nowhere else (design §1.7).
      amountOverride: body.amount == null || body.amount === '' ? null : Number(body.amount),
      // An explicit first-charge date is a DEFERRED START, not a trial: it
      // suppresses the catalog's trialDays and the row activates to ACTIVE
      // rather than TRIALING. See issueEnrollInvite for why that wording
      // matters more than it looks like it should.
      startDate: body.startDate || null,
      trialDays: body.trialDays == null || body.trialDays === '' ? null : Number(body.trialDays),
      validForDays: body.validForDays,
      notes: body.notes || null,
      actorUserId: req.user?.id || req.user?.sub || null,
      actorEmail: req.user?.email || null,
      actorRole: req.user?.role || null,
    });

    res.status(201).json({
      url: out.url,
      tokenPrefix: out.invite.tokenPrefix,
      expiresAt: out.invite.expiresAt,
      // True when an unauthorised PENDING row was reused and its old links
      // revoked, rather than a new subscription being created.
      resent: !!out.resent,
      subscription: {
        id: out.subscription.id,
        status: out.subscription.status,
        planCode: out.subscription.planCode,
        planName: out.subscription.planNameSnapshot,
        amount: String(out.subscription.amount),
        currency: out.subscription.currency,
        intervalUnit: out.subscription.intervalUnit,
        intervalLength: out.subscription.intervalLength,
        startDate: out.subscription.startDate,
        trialEndsAt: out.subscription.trialEndsAt,
      },
    });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

/**
 * Reset the demo tenant — Ride University's practice mode leaves trainee
 * bookings behind, and the same tenant is what sales demos run on.
 *
 * SUPER_ADMIN only, and the service refuses any tenant whose isDemo is not
 * exactly true, so the worst a wrong id can do is 403. The confirmation
 * phrase in the body is the second lock: this deletes data.
 */
tenantsRouter.post('/:id/reset-demo', requireSuperAdmin, async (req, res, next) => {
  try {
    res.json(await demoResetService.reset(req.params.id, req.body?.confirm, {
      userId: req.user?.id || req.user?.sub || null,
      email: req.user?.email || null,
    }));
  } catch (e) { next(e); }
});

tenantsRouter.get('/:id/admins', async (req, res, next) => {
  try {
    const admins = await tenantsService.listTenantAdmins(req.params.id);
    res.json(admins);
  } catch (e) {
    next(e);
  }
});

tenantsRouter.post('/:id/admins', async (req, res, next) => {
  try {
    const user = await tenantsService.createTenantAdmin(req.params.id, req.body || {}, { actor: req.user });
    res.status(201).json(user);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

tenantsRouter.post('/:id/admins/:userId/reset-password', async (req, res) => {
  try {
    const out = await tenantsService.resetTenantAdminPassword(req.params.id, req.params.userId, req.body?.password, { actor: req.user });
    res.json(out);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Wave 3 (2026-08-24): AUDIT_ACTIONS.IMPERSONATION_START is recorded inside the
// service (success + failure). There is deliberately NO IMPERSONATION_END
// marker: an impersonation is a plain short-lived JWT with the `imp` claim and
// no server-side session to close, and the impersonated session is the TENANT
// admin — it cannot reach this super-admin-guarded router to signal an end.
// The window is therefore bounded by the token's own expiry (getJwtExpiresIn),
// and everything done within it is attributable via the `imp` claim on each
// request (requestLogger + auditFromReq both surface it).
tenantsRouter.post('/:id/impersonate', async (req, res) => {
  try {
    const out = await tenantsService.impersonateTenantAdmin(req.params.id, req.body?.userId || null, { actor: req.user });
    res.json(out);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});
