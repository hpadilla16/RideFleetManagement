/**
 * The SUPER_ADMIN billing panel's HTTP surface — Phase 4.
 *
 * Mounted under the tenants router at `/api/tenants/billing`, which is what puts
 * it behind `requireAuth` + the tenant rate limit + `requireModuleAccess`
 * ('tenants') + the router-level `requireSuperAdmin`. Every route re-applies
 * `requireSuperAdmin` explicitly anyway, following the house idiom for money and
 * destructive routes (`tenants.routes.js`): a guard that is load-bearing should
 * be visible at the route that depends on it, not only three files away.
 *
 * NOT `requireRole('SUPER_ADMIN')` — it short-circuits on `isSuperAdmin` BEFORE
 * checking the list, so it reads like a role check and is really a bypass
 * (design §8).
 *
 * Refusals are 400 with the service's own sentence, because every one of them is
 * something the operator can act on and they arrive while he is looking at the
 * row he just clicked. Unexpected errors go to `next(e)` and become a 500.
 */
import { Router } from 'express';
import { isSuperAdmin } from '../../middleware/auth.js';
import { billingAdmin } from './billing-admin.service.js';
import { billingPlanChange } from './billing-plan-change.service.js';

export const billingAdminRouter = Router();

function requireSuperAdmin(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
  if (!isSuperAdmin(req.user)) return res.status(403).json({ error: 'Super admin only' });
  next();
}

billingAdminRouter.use(requireSuperAdmin);

/** Who acted. Read from the verified session only — never from the body. */
function actorFrom(req) {
  return {
    actorUserId: req.user?.id || req.user?.sub || null,
    actorEmail: req.user?.email || null,
    actorRole: req.user?.role || null,
  };
}

/**
 * A refusal the operator can fix (`e.status` in the 4xx range) is returned with
 * its message intact. Anything else is a bug and goes to the central handler,
 * which does not leak internals.
 */
function fail(res, next, e) {
  const status = Number(e?.status || e?.statusCode || 0);
  if (status >= 400 && status < 500) return res.status(status).json({ error: e.message });
  return next(e);
}

// ── Reads ──────────────────────────────────────────────────────────────────

billingAdminRouter.get('/overview', async (_req, res, next) => {
  try {
    res.json(await billingAdmin.getBillingOverview());
  } catch (e) {
    next(e);
  }
});

billingAdminRouter.get('/health', async (_req, res, next) => {
  try {
    res.json(await billingAdmin.getBillingHealth());
  } catch (e) {
    next(e);
  }
});

// ── Subscription-scoped writes ─────────────────────────────────────────────
// Registered before `/:tenantId` so a literal path segment always wins over the
// parameter, regardless of how the routes are reordered later.

/**
 * Cancel. The one action here that changes anything at Authorize.Net.
 *
 * `confirm` is the typed second lock (`CANCEL SUBSCRIPTION`), mirroring the
 * demo-reset phrase. `reason` is mandatory. The service calls ARB FIRST and only
 * marks our row on success — see the block comment there; the ordering is the
 * feature, not an implementation detail.
 */
billingAdminRouter.post('/subscriptions/:subscriptionId/cancel', requireSuperAdmin, async (req, res, next) => {
  try {
    res.json(await billingAdmin.cancelSubscriptionForTenant({
      subscriptionId: req.params.subscriptionId,
      confirm: req.body?.confirm,
      reason: req.body?.reason,
      ...actorFrom(req),
    }));
  } catch (e) {
    fail(res, next, e);
  }
});

/**
 * Mint an update-payment link. THE RESPONSE CARRIES THE PLAINTEXT TOKEN EXACTLY
 * ONCE — only the sha256 is stored, so there is no "show me that link again".
 * Never logged, never audited; the audit row carries the 8-char prefix.
 */
billingAdminRouter.post('/subscriptions/:subscriptionId/update-link', requireSuperAdmin, async (req, res, next) => {
  try {
    const out = await billingAdmin.sendUpdatePaymentLink({
      subscriptionId: req.params.subscriptionId,
      email: req.body?.email,
      companyName: req.body?.companyName,
      validForDays: req.body?.validForDays,
      ...actorFrom(req),
    });
    res.status(201).json({
      url: out.url,
      tokenPrefix: out.invite.tokenPrefix,
      expiresAt: out.invite.expiresAt,
      email: out.invite.email,
      mode: out.invite.mode,
    });
  } catch (e) {
    fail(res, next, e);
  }
});

billingAdminRouter.post('/subscriptions/:subscriptionId/revoke-invites', requireSuperAdmin, async (req, res, next) => {
  try {
    res.json(await billingAdmin.revokeOutstandingInvites({
      subscriptionId: req.params.subscriptionId,
      ...actorFrom(req),
    }));
  } catch (e) {
    fail(res, next, e);
  }
});

/**
 * "Is it through yet?" — a READ at Authorize.Net that may adopt what ARB reports.
 *
 * This is what the panel offers where a naive design would put a "Retry" button.
 * It forces no charge and claims none; see the standing comment in
 * billing-admin.service.js for why a retry button cannot honestly exist.
 */
billingAdminRouter.post('/subscriptions/:subscriptionId/refresh', requireSuperAdmin, async (req, res, next) => {
  try {
    res.json(await billingAdmin.refreshFromAuthorizeNet({
      subscriptionId: req.params.subscriptionId,
      ...actorFrom(req),
    }));
  } catch (e) {
    fail(res, next, e);
  }
});

// ── Plan changes (Phase 6) ─────────────────────────────────────────────────

/**
 * Preview only — nothing written, nothing charged. Returns the exact number
 * and the exact stored-sentence the commit would produce, which is what the
 * dialog shows BEFORE the operator commits (§7.2). POST rather than GET
 * because it carries a body, but it is a pure read.
 */
billingAdminRouter.post('/subscriptions/:subscriptionId/plan-change/preview', requireSuperAdmin, async (req, res, next) => {
  try {
    res.json(await billingPlanChange.previewPlanChange({
      subscriptionId: req.params.subscriptionId,
      planCode: req.body?.planCode,
      amount: req.body?.amount,
    }));
  } catch (e) {
    fail(res, next, e);
  }
});

/**
 * The plan/amount change. TWO SHAPES, one route:
 *
 *   default            → SCHEDULED for the next period boundary (or an explicit
 *                        effectiveDate). No money moves today; no ARB call is
 *                        made until the boundary; fully undoable below.
 *   prorateNow: true   → upgrade-only mid-cycle apply with a proration charge,
 *                        gated on `expectedProration` echoing the previewed
 *                        number so a stale preview cannot charge blind.
 */
billingAdminRouter.post('/subscriptions/:subscriptionId/plan-change', requireSuperAdmin, async (req, res, next) => {
  try {
    const input = {
      subscriptionId: req.params.subscriptionId,
      planCode: req.body?.planCode,
      amount: req.body?.amount,
      effectiveDate: req.body?.effectiveDate,
      prorateNow: req.body?.prorateNow === true,
      expectedProration: req.body?.expectedProration,
      ...actorFrom(req),
    };
    res.json(input.prorateNow
      ? await billingPlanChange.changePlanWithProrationNow(input)
      : await billingPlanChange.scheduleSubscriptionPlanChange(input));
  } catch (e) {
    fail(res, next, e);
  }
});

/** Undo a scheduled change before its boundary. Nothing has happened yet. */
billingAdminRouter.post('/subscriptions/:subscriptionId/plan-change/cancel', requireSuperAdmin, async (req, res, next) => {
  try {
    res.json(await billingPlanChange.cancelPendingPlanChange({
      subscriptionId: req.params.subscriptionId,
      ...actorFrom(req),
    }));
  } catch (e) {
    fail(res, next, e);
  }
});

// ── Tenant-scoped ──────────────────────────────────────────────────────────

billingAdminRouter.get('/:tenantId', async (req, res, next) => {
  try {
    res.json(await billingAdmin.getTenantBillingDetail(req.params.tenantId));
  } catch (e) {
    fail(res, next, e);
  }
});

/**
 * Cut a non-payer off. `reason` is mandatory — it is what answers "why is this
 * tenant switched off?" three months from now.
 *
 * Sets `Tenant.status='SUSPENDED'` + `billingSuspendedAt`. That darkens their
 * public booking site and stops their integration syncs TODAY. It does NOT log
 * their staff out — `requireAuth` does not read tenant status yet, and that gate
 * is Phase 5 on purpose. The panel copy says so.
 */
billingAdminRouter.post('/:tenantId/suspend', requireSuperAdmin, async (req, res, next) => {
  try {
    res.json(await billingAdmin.suspendTenantAccess({
      tenantId: req.params.tenantId,
      reason: req.body?.reason,
      ...actorFrom(req),
    }));
  } catch (e) {
    fail(res, next, e);
  }
});

/** Refuses to lift a suspension billing did not set. See the service. */
billingAdminRouter.post('/:tenantId/restore', requireSuperAdmin, async (req, res, next) => {
  try {
    res.json(await billingAdmin.restoreTenantAccess({
      tenantId: req.params.tenantId,
      reason: req.body?.reason,
      ...actorFrom(req),
    }));
  } catch (e) {
    fail(res, next, e);
  }
});

/**
 * The ONLY path by which billing and entitlement ever get reconciled, and always
 * a deliberate click. Moves `Tenant.plan` only — no price, no ARB call, no money.
 */
billingAdminRouter.post('/:tenantId/apply-plan', requireSuperAdmin, async (req, res, next) => {
  try {
    res.json(await billingAdmin.applyPlanToEntitlements({
      tenantId: req.params.tenantId,
      ...actorFrom(req),
    }));
  } catch (e) {
    fail(res, next, e);
  }
});
