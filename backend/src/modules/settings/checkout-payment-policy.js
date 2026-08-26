/**
 * Per-tenant "is the checkout wizard's payment step mandatory?" policy.
 *
 * WHY (Hector, 2026-08-26): Rent & Go by VPH Motors does not collect payment at
 * the counter — their money is settled elsewhere — so forcing step 3 of the
 * check-out wizard through the Spin terminal blocks every one of their
 * check-outs. This makes that step optional PER TENANT.
 *
 * MECHANISM — deliberately a DATA-LEVEL skip, not a graph change. The
 * state machine (checkout-session/state-machine.js) still runs
 * CONFIRMING → … → PAYMENT_PENDING → PAID, and PAID still requires
 * `paymentCompletedAt` to be stamped before the transition is accepted. When a
 * tenant has payment turned off we PRE-STAMP `paymentCompletedAt` at session
 * creation, exactly the way DEALERSHIP_LOANER check-outs already do. Nothing in
 * the step graph, the ENTRY_REQUIRES guards, the Spin/iPOS clients, or any
 * charge/refund path is touched — which is the whole reason this is safe to
 * ship on the money path.
 *
 * FAIL-SAFE BY CONSTRUCTION. `checkoutPaymentRequired` defaults to TRUE and
 * only an EXPLICIT boolean `false` turns it off. Absent key, unparseable JSON,
 * a DB error, `"no"`, `null`, `0`, `"false"` — every one of those resolves to
 * REQUIRED, i.e. today's behavior for every tenant that never touches this
 * switch. There is no input that accidentally disables the payment step.
 *
 * STORAGE — AppSetting, keyed `tenant:<id>:checkoutPaymentPolicy`, value a JSON
 * blob `{"checkoutPaymentRequired": false}`. This is the same scoped-AppSetting
 * shape every other tenant toggle on the Settings page uses (customerInspection
 * Config, fleetRotationConfig, twoFactorPolicy, …) via settings.service.js's
 * `scopedKey`. It is deliberately NOT `Tenant.settingsJson`: that column does
 * not exist on the Tenant model (see the note in the report / the latent bug in
 * sms.service.js + payment-gateway.service.js, which both `select` it), so
 * using it would have required a migration on the hot tenant table to store one
 * boolean. The PARSE shape here — JSON string, try/catch, tenant-scoped cache
 * with a short TTL — mirrors `getTenantSmsConfig` / `getTenantSpinConfig`.
 *
 * CACHING — `tenantKey(tenantId, 'checkout', 'payment-policy')`, 60s TTL, and
 * `invalidateCheckoutPaymentPolicy` is called by the settings write path. Without
 * that invalidation an admin flips the switch and nothing appears to happen for
 * a minute, which reads as "the toggle is broken".
 *
 * This module is a LEAF on purpose: it imports prisma + cache only, so
 * checkout-session.service.js can read the policy without pulling
 * settings.service.js (and its transitive graph) into the checkout import cycle.
 */

import { prisma } from '../../lib/prisma.js';
import { cache } from '../../lib/cache.js';
import { tenantKey } from '../../lib/cache/tenantKey.js';
import logger from '../../lib/logger.js';

/** AppSetting base key (tenant-scoped by `settingKeyFor`). */
export const CHECKOUT_PAYMENT_POLICY_SETTING = 'checkoutPaymentPolicy';

/** The boolean field inside the stored JSON blob. */
export const CHECKOUT_PAYMENT_REQUIRED_FIELD = 'checkoutPaymentRequired';

const CACHE_TTL_MS = 60 * 1000;

/**
 * The single fail-safe rule, exported so tests can pin it without a DB.
 * ONLY a real boolean `false` disables the payment step.
 */
export function normalizeCheckoutPaymentRequired(raw) {
  return raw === false ? false : true;
}

function settingKeyFor(tenantId) {
  // Mirrors settings.service.js scopedKey(): unscoped base key when there is no
  // tenant. A null tenant can never reach here from the resolver (it returns the
  // default first) — this exists so the writer and the reader agree.
  return tenantId ? `tenant:${tenantId}:${CHECKOUT_PAYMENT_POLICY_SETTING}` : CHECKOUT_PAYMENT_POLICY_SETTING;
}

function cacheKeyFor(tenantId) {
  return tenantKey(tenantId, 'checkout', 'payment-policy');
}

/**
 * Resolve the policy for one tenant. Returns TRUE (payment required — today's
 * behavior) for a null tenant, a missing row, malformed JSON, or a DB failure.
 *
 * Never throws: a checkout must not fail to start because a settings row is
 * unreadable, and the safe direction when we cannot tell is "still ask for
 * payment" (the agent can always fall back to the manual-payment override).
 */
export async function isCheckoutPaymentRequired(tenantId) {
  if (!tenantId) return true;
  try {
    return await cache.getOrSet(cacheKeyFor(tenantId), async () => {
      let parsed = {};
      try {
        const row = await prisma.appSetting.findUnique({ where: { key: settingKeyFor(tenantId) } });
        const value = row?.value;
        parsed = value ? JSON.parse(value) : {};
      } catch (err) {
        // Unreadable row / bad JSON → REQUIRED. Logged, not thrown.
        logger.warn('[checkout-payment-policy] unreadable policy, defaulting to REQUIRED', {
          tenantId, error: err?.message || String(err),
        });
        parsed = {};
      }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) parsed = {};
      return normalizeCheckoutPaymentRequired(parsed[CHECKOUT_PAYMENT_REQUIRED_FIELD]);
    }, CACHE_TTL_MS);
  } catch (err) {
    logger.warn('[checkout-payment-policy] resolver failed, defaulting to REQUIRED', {
      tenantId, error: err?.message || String(err),
    });
    return true;
  }
}

/**
 * Drop the cached value for a tenant. MUST be called by every write path — see
 * the CACHING note in the header.
 */
export function invalidateCheckoutPaymentPolicy(tenantId) {
  if (!tenantId) return;
  cache.del(cacheKeyFor(tenantId));
}

/**
 * Persist the policy and invalidate the cache. `required` is normalized through
 * the same fail-safe rule as the reader, so no write can store a value that
 * resolves to something other than what the caller asked for.
 */
export async function setCheckoutPaymentRequired(tenantId, required) {
  if (!tenantId) throw new Error('tenantId is required');
  const value = normalizeCheckoutPaymentRequired(required);
  const key = settingKeyFor(tenantId);
  await prisma.appSetting.upsert({
    where: { key },
    create: { key, value: JSON.stringify({ [CHECKOUT_PAYMENT_REQUIRED_FIELD]: value }) },
    update: { value: JSON.stringify({ [CHECKOUT_PAYMENT_REQUIRED_FIELD]: value }) },
  });
  invalidateCheckoutPaymentPolicy(tenantId);
  return value;
}
