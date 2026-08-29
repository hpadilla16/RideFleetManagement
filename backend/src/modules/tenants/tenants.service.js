import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import { prisma } from '../../lib/prisma.js';
import { authService } from '../auth/auth.service.js';
import { recordAudit, auditFromReq, AUDIT_ACTIONS, AUDIT_OUTCOME } from '../audit/audit.service.js';
import {
  assertTenantUserCapacity,
  getTenantPlanCatalog,
  getTenantPlanUsage,
  resolveTenantPlanConfig,
  saveTenantPlanCatalog
} from '../../lib/tenant-plan-limits.js';
import { summariseTenantBilling } from '../billing/billing.service.js';

const SALT_ROUNDS = 10;

// 2026-08-23: crypto-strong temp password for super-admin-minted secrets
// (was the hardcoded 'TempPass123!' literal — trivially guessable). Mirrors
// people.service.js randomTempPassword: same 12-char-plus shape, satisfies the
// auth password policy (upper, lower, digit, special — see auth.routes.js
// validatePassword). One-shot secrets — mustChangePassword forces replacement
// on first login — but they travel to the super-admin, so they must not be
// guessable. 64 bits of entropy.
function randomTempPassword() {
  return `Temp${crypto.randomBytes(8).toString('hex')}!9`;
}

function normalizePrismaTarget(error) {
  const raw = error?.meta?.target;
  if (Array.isArray(raw)) return raw.map((value) => String(value || '').toLowerCase());
  if (typeof raw === 'string') return [raw.toLowerCase()];
  return [];
}

function mapTenantWriteError(error, fallback = 'Unable to save tenant changes') {
  if (error?.code === 'P2002') {
    const target = normalizePrismaTarget(error);
    if (target.includes('email')) {
      throw new Error('A user with that email already exists. Use a different admin email or reset the existing user password.');
    }
    if (target.includes('slug')) {
      throw new Error('That tenant slug is already in use. Choose a different slug.');
    }
  }
  throw new Error(error?.message || fallback);
}

/**
 * THE TENANT STATUS VOCABULARY. Closed set — anything else is rejected.
 *
 * `Tenant.status` is a free-text String in the schema, but it is a load-bearing
 * POSITIVE gate: an exact `status: 'ACTIVE'` match is what lets a tenant's
 * public booking site resolve (middleware/public-tenant-token.js), what puts it
 * in the car-sharing marketplace and the booking engine
 * (booking-engine.service.js, public-booking.service.js), and what lets the
 * booking-source / economy / nu integration schedulers sync it. Nothing
 * validated writes to it, so a typo like 'ACTIVEE' used to be accepted happily
 * and would silently darken a paying tenant everywhere at once, with no error
 * raised anywhere. That is what this list closes.
 *
 * DEMO IS NOT OPTIONAL HERE. A production census on 2026-08-28 found the live
 * vocabulary to be exactly ACTIVE / SUSPENDED / DEMO — one tenant
 * (cmn6d5ax80002s10izy80l4ei) is DEMO, so omitting it would make that tenant's
 * status unsettable from the only screen that edits it.
 *
 * AND AN OPEN HAZARD THIS LIST DOES NOT CLOSE. On the same day, a real
 * TENANT_SUSPEND recorded `previousTenantStatus: 'DEMO'` into AdminAuditLog.
 * NOTHING READS THAT VALUE BACK: billing-admin.service.js restoreTenantAccess
 * hardcodes `status: 'ACTIVE'`, so restoring that tenant from the billing screen
 * flips DEMO -> ACTIVE. Because `isDemo` gates no public surface, the only thing
 * keeping the demo tenant out of the public car-sharing marketplace is
 * `status !== 'ACTIVE'` — so that restore would publish it. Owned by
 * fix/billing-restore-previous-status; do not assume it is handled here.
 */
export const TENANT_STATUSES = ['ACTIVE', 'SUSPENDED', 'DEMO'];

/**
 * Reject rather than coerce. A silent fallback would leave the admin looking at
 * a screen that says the save worked while the tenant sits on the old status —
 * the same invisible failure this allowlist exists to end. Mirrors normalizeEnum
 * in issue-center/issue-center-claims-fields.js; the tenants routes already turn
 * a thrown Error into a 400.
 */
export function normalizeTenantStatus(value, fallback = undefined) {
  if (value == null || value === '') return fallback;
  const normalized = String(value).trim().toUpperCase();
  if (!TENANT_STATUSES.includes(normalized)) {
    throw new Error(`status must be one of ${TENANT_STATUSES.join(', ')}`);
  }
  return normalized;
}

export const tenantsService = {
  async list() {
    const [tenants, catalog] = await Promise.all([
      prisma.tenant.findMany({
        orderBy: { createdAt: 'desc' },
        include: {
          _count: {
            select: {
              users: true,
              locations: true,
              customers: true,
              vehicles: true,
              reservations: true
            }
          }
        }
      }),
      getTenantPlanCatalog()
    ]);

    const usageEntries = await Promise.all(
      tenants.map(async (tenant) => [tenant.id, await getTenantPlanUsage(tenant.id)]),
    );
    const usageByTenantId = new Map(usageEntries);

    // One query for the whole list, not one per row. `NONE` for a tenant with no
    // subscription at all — the row that matters most, because it is revenue
    // nobody remembered to collect rather than revenue that is merely late.
    const billingByTenantId = await summariseTenantBilling(tenants.map((t) => t.id));

    return tenants.map((tenant) => {
      const planConfig = resolveTenantPlanConfig(tenant.plan, catalog);
      const planUsage = usageByTenantId.get(tenant.id) || { admins: 0, users: 0, vehicles: 0 };
      const billing = billingByTenantId.get(tenant.id) || { status: 'NONE' };
      return {
        ...tenant,
        planConfig,
        planUsage,
        billing: {
          ...billing,
          // Tenant.plan is the ENTITLEMENT key; billing.planCode is the BILLING
          // key. They should normally match, and activating a subscription
          // deliberately does NOT rewrite entitlements (design open question 9,
          // answered "by hand"). Billed at PRO while entitled at STARTER is a
          // revenue leak; the reverse is a freebie. Neither should be invisible.
          planDiverges: !!billing.planCode && billing.planCode !== tenant.plan,
        },
        planStatus: {
          overAdmins: planConfig.maxAdmins != null && planUsage.admins > planConfig.maxAdmins,
          overUsers: planConfig.maxUsers != null && planUsage.users > planConfig.maxUsers,
          overVehicles: planConfig.maxVehicles != null && planUsage.vehicles > planConfig.maxVehicles
        }
      };
    });
  },

  getPlanCatalog() {
    return getTenantPlanCatalog();
  },

  savePlanCatalog(plans = []) {
    return saveTenantPlanCatalog(plans);
  },

  async createTenant(data = {}) {
    const name = String(data.name || '').trim();
    const slug = String(data.slug || '').trim().toLowerCase();
    if (!name || !slug) throw new Error('name and slug are required');
    // Validated OUT here, not inside the try: that catch exists to translate
    // Prisma write errors (mapTenantWriteError), and routing a plain validation
    // failure through it only survives because the mapper happens to pass
    // error.message along. updateTenant already validates outside its try.
    const status = normalizeTenantStatus(data.status, 'ACTIVE');
    try {
      const pct = data.platformFeePct !== undefined ? Number(data.platformFeePct || 0) : 10;
      const min = data.platformFeeMin !== undefined ? Number(data.platformFeeMin || 0) : 7;
      const max = data.platformFeeMax !== undefined ? Number(data.platformFeeMax || 0) : 35;
      if (pct < 0 || pct > 100) throw new Error('platformFeePct must be between 0 and 100');
      if (min < 0) throw new Error('platformFeeMin must be non-negative');
      if (max < 0) throw new Error('platformFeeMax must be non-negative');
      return await prisma.tenant.create({
        data: {
          name,
          slug,
          status,
          plan: String(data.plan || 'BETA').toUpperCase(),
          carSharingEnabled: !!data.carSharingEnabled,
          dealershipLoanerEnabled: !!data.dealershipLoanerEnabled,
          tollsEnabled: !!data.tollsEnabled,
          citationsEnabled: !!data.citationsEnabled,
          marketIntelligenceEnabled: !!data.marketIntelligenceEnabled,
          // Showcase/practice tenant marker — see schema. Opt-in on create.
          isDemo: !!data.isDemo,
          platformFeeEnabled: data.platformFeeEnabled !== false,
          platformFeePct: pct,
          platformFeeMin: min,
          platformFeeMax: max
        }
      });
    } catch (error) {
      mapTenantWriteError(error, 'Unable to create tenant');
    }
  },

  async updateTenant(id, patch = {}, options = {}) {
    const data = {};
    if (patch.name !== undefined) data.name = String(patch.name || '').trim();
    if (patch.slug !== undefined) data.slug = String(patch.slug || '').trim().toLowerCase();
    if (patch.status !== undefined) data.status = normalizeTenantStatus(patch.status);
    if (patch.plan !== undefined) data.plan = String(patch.plan || '').toUpperCase();
    if (patch.carSharingEnabled !== undefined) data.carSharingEnabled = !!patch.carSharingEnabled;
    if (patch.dealershipLoanerEnabled !== undefined) data.dealershipLoanerEnabled = !!patch.dealershipLoanerEnabled;
    if (patch.tollsEnabled !== undefined) data.tollsEnabled = !!patch.tollsEnabled;
    if (patch.citationsEnabled !== undefined) data.citationsEnabled = !!patch.citationsEnabled;
    if (patch.marketIntelligenceEnabled !== undefined) data.marketIntelligenceEnabled = !!patch.marketIntelligenceEnabled;
    // Settable after creation too — otherwise an EXISTING tenant could never
    // be marked as the demo, which is the whole use case (QA, 2026-08-14).
    if (patch.isDemo !== undefined) data.isDemo = !!patch.isDemo;
    if (patch.platformFeeEnabled !== undefined) data.platformFeeEnabled = !!patch.platformFeeEnabled;
    if (patch.platformFeePct !== undefined) {
      const pct = Number(patch.platformFeePct || 0);
      if (pct < 0 || pct > 100) throw new Error('platformFeePct must be between 0 and 100');
      data.platformFeePct = pct;
    }
    if (patch.platformFeeMin !== undefined) {
      const min = Number(patch.platformFeeMin || 0);
      if (min < 0) throw new Error('platformFeeMin must be non-negative');
      data.platformFeeMin = min;
    }
    if (patch.platformFeeMax !== undefined) {
      const max = Number(patch.platformFeeMax || 0);
      if (max < 0) throw new Error('platformFeeMax must be non-negative');
      data.platformFeeMax = max;
    }

    try {
      // Cascade-disable Market Intelligence when the super-admin flips the
      // flag from on → off. Otherwise: (a) the droplet keeps scraping for
      // active profiles and burns Browserbase minutes ($20/mo cap shared
      // across the whole fleet), and (b) the suggestion engine keeps
      // evaluating active PricingRule rows and writes orphan suggestions
      // that nobody can see (the API is module-gated, but the worker isn't
      // — that defensive gate is the second piece of beta.125 below).
      //
      // We do NOT auto-reactivate on the reverse transition (off → on).
      // The tenant has to flip each MarketScrapeProfile / PricingRule back
      // on themselves so they don't get surprised by old profiles waking up.

      // ONE read serves both the cascade check below and the status audit after
      // the write — the status is only needed to say what it WAS, which is
      // unrecoverable once the update lands.
      const needsPrior = patch.marketIntelligenceEnabled === false || data.status !== undefined;
      const prior = needsPrior
        ? await prisma.tenant.findUnique({
          where: { id },
          select: { marketIntelligenceEnabled: true, status: true }
        })
        : null;

      let shouldCascadeDisable = false;
      if (patch.marketIntelligenceEnabled === false && prior?.marketIntelligenceEnabled === true) {
        shouldCascadeDisable = true;
      }

      const updated = await prisma.tenant.update({ where: { id }, data });

      // A status change from THIS screen is a lockout lever — auth.service.js
      // hydrates tenant.status on every request and SUSPENDED locks staff out —
      // and until now it left no trace at all, while the identical transition
      // through the billing panel was fully audited. The census that established
      // the DEMO vocabulary only worked because billing had recorded the previous
      // status; a flip through here would have been invisible. Best-effort:
      // recordAudit swallows its own failures, so the trail never blocks the save.
      if (data.status !== undefined && prior && prior.status !== data.status) {
        // auditFromReq, not bare recordAudit: it also captures ip, user-agent and
        // the impersonator (req.user.imp). For a lever that locks a whole tenant's
        // staff out, "which super-admin, from where, impersonating whom" is the
        // point of the row. It optional-chains `req` throughout, so a caller that
        // has no request still gets a valid row with those fields null.
        //
        // tenantId is overridden deliberately: auditFromReq defaults it to the
        // ACTOR's tenant, and the actor here is a super-admin acting on someone
        // else's tenant. The row must be filed against the TARGET.
        await auditFromReq(options.req, {
          tenantId: id,
          action: AUDIT_ACTIONS.TENANT_STATUS_CHANGE,
          targetType: 'Tenant',
          targetId: id,
          outcome: AUDIT_OUTCOME.SUCCESS,
          // `previousTenantStatus` is spelled exactly as billing-admin.service.js
          // spells it, so one query answers "what was this tenant before" across
          // both paths.
          metadata: { previousTenantStatus: prior.status, newTenantStatus: data.status },
        });
      }

      if (shouldCascadeDisable) {
        await prisma.$transaction([
          prisma.marketScrapeProfile.updateMany({
            where: { tenantId: id, active: true },
            data: { active: false }
          }),
          prisma.pricingRule.updateMany({
            where: { tenantId: id, active: true },
            data: { active: false }
          })
        ]);
      }

      return updated;
    } catch (error) {
      mapTenantWriteError(error, 'Unable to update tenant');
    }
  },

  // Wave 3 (2026-08-24): `actor` (the super-admin req.user from the route) is
  // threaded through so USER_CREATE is auditable with WHO created the admin —
  // the SUPER_ADMIN equivalent of people.service.createPerson's audit.
  async createTenantAdmin(tenantId, payload = {}, { actor } = {}) {
    const email = String(payload.email || '').trim().toLowerCase();
    const fullName = String(payload.fullName || '').trim();
    const password = String(payload.password || randomTempPassword());
    if (!email || !fullName) throw new Error('email and fullName are required');

    await assertTenantUserCapacity(tenantId, { userDelta: 1, adminDelta: 1 });

    const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);
    let user;
    try {
      user = await prisma.user.create({
        data: {
          email,
          fullName,
          role: 'ADMIN',
          passwordHash,
          // First-login onboarding (2026-07-25): the creating SUPER_ADMIN
          // receives this generated temp password (returned as tempPassword) —
          // force the new admin to replace it on first login.
          mustChangePassword: true,
          tenant: { connect: { id: tenantId } }
        },
        select: { id: true, email: true, fullName: true, role: true, tenantId: true }
      });
    } catch (error) {
      mapTenantWriteError(error, 'Unable to create tenant admin');
    }

    // USER_CREATE audit (best-effort, fire-and-forget). Never records the temp
    // password. actor = the super-admin from the route.
    recordAudit({
      tenantId: user?.tenantId || tenantId || null,
      actorUserId: actor?.id ?? actor?.sub ?? null,
      actorEmail: actor?.email ?? null,
      actorRole: actor?.role ?? null,
      impersonatedByUserId: actor?.imp ?? null,
      action: AUDIT_ACTIONS.USER_CREATE,
      targetType: 'USER',
      targetId: user?.id || null,
      metadata: { role: user?.role || 'ADMIN' },
    });

    return { ...user, tempPassword: password };
  },

  listTenantAdmins(tenantId) {
    return prisma.user.findMany({
      where: { tenantId, role: { in: ['ADMIN', 'OPS', 'AGENT'] } },
      orderBy: { createdAt: 'desc' },
      select: { id: true, email: true, fullName: true, role: true, createdAt: true }
    });
  },

  // Wave 3 (2026-08-24): `actor` threaded through for USER_PASSWORD_RESET audit —
  // the SUPER_ADMIN equivalent of people.service.resetPassword's audit.
  async resetTenantAdminPassword(tenantId, userId, password, { actor } = {}) {
    const user = await prisma.user.findFirst({ where: { id: userId, tenantId } });
    if (!user) throw new Error('Tenant admin not found');
    // Fall back to a crypto-strong temp password when the super-admin did not
    // supply one (was the hardcoded 'TempPass123!' literal).
    const tempPassword = String(password || randomTempPassword());
    const passwordHash = await bcrypt.hash(tempPassword, SALT_ROUNDS);
    // First-login onboarding (2026-07-25): admin reset = temp password again.
    // Session cache busted so an open session gates immediately on this
    // worker (siblings converge within the 30s TTL).
    await prisma.user.update({ where: { id: user.id }, data: { passwordHash, mustChangePassword: true } });
    authService.invalidateSessionCache(user.id);

    // USER_PASSWORD_RESET audit (best-effort, fire-and-forget). Never records the
    // temp password. actor = the super-admin from the route.
    recordAudit({
      tenantId: user.tenantId || tenantId || null,
      actorUserId: actor?.id ?? actor?.sub ?? null,
      actorEmail: actor?.email ?? null,
      actorRole: actor?.role ?? null,
      impersonatedByUserId: actor?.imp ?? null,
      action: AUDIT_ACTIONS.USER_PASSWORD_RESET,
      targetType: 'USER',
      targetId: user.id,
    });

    return { ok: true, userId: user.id, email: user.email, tempPassword };
  },

  // Wave 3 (2026-08-24): `actor` (the super-admin req.user from the route) is
  // threaded through so the minted session carries the impersonation marker AND
  // the event is auditable with WHO initiated it. Optional/back-compatible: an
  // absent actor mints a plain token and audits with a null actor.
  async impersonateTenantAdmin(tenantId, targetUserId, { actor } = {}) {
    let user = null;
    if (targetUserId) {
      user = await prisma.user.findFirst({ where: { id: targetUserId, tenantId, isActive: true } });
    } else {
      user = await prisma.user.findFirst({ where: { tenantId, role: 'ADMIN', isActive: true }, orderBy: { createdAt: 'asc' } });
      if (!user) user = await prisma.user.findFirst({ where: { tenantId, isActive: true }, orderBy: { createdAt: 'asc' } });
    }
    if (!user) {
      // FAILURE branch: no target found. Audit the attempt (best-effort) with the
      // super-admin as actor and the target TENANT, then rethrow unchanged.
      await recordAudit({
        tenantId,
        actorUserId: actor?.id ?? actor?.sub ?? null,
        actorEmail: actor?.email ?? null,
        actorRole: actor?.role ?? null,
        action: AUDIT_ACTIONS.IMPERSONATION_START,
        targetType: 'TENANT',
        targetId: tenantId,
        outcome: AUDIT_OUTCOME.FAILURE,
        metadata: { requestedUserId: targetUserId || null, reason: 'no active tenant user found' },
      });
      throw new Error('No active tenant user found for impersonation');
    }

    const impersonatedBy = actor?.id ?? actor?.sub ?? null;
    const token = impersonatedBy
      ? authService.issueImpersonationToken(user, { impersonatedBy })
      : authService.issueTokenForUser(user);

    // SUCCESS: actor = super-admin; tenantId = the TARGET tenant; target = the
    // impersonated user. Best-effort — a dropped audit row never blocks the
    // impersonation itself.
    await recordAudit({
      tenantId: user.tenantId || tenantId || null,
      actorUserId: impersonatedBy,
      actorEmail: actor?.email ?? null,
      actorRole: actor?.role ?? null,
      action: AUDIT_ACTIONS.IMPERSONATION_START,
      targetType: 'USER',
      targetId: user.id,
      outcome: AUDIT_OUTCOME.SUCCESS,
      metadata: { targetEmail: user.email, targetRole: user.role },
    });

    return {
      token,
      user: { id: user.id, email: user.email, fullName: user.fullName, role: user.role, tenantId: user.tenantId || null }
    };
  }
};
