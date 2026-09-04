/**
 * checkout-contract-mode.js — "which surface does the renter sign the rental
 * agreement on for THIS checkout?"
 *
 * Two values, and only two:
 *
 *   PHONE     — today's flow for every tenant. A QR to /sign/:token, six
 *               sections initialled on the renter's own phone. THE DEFAULT.
 *   TERMINAL  — the US terminal session (2026-09-04). Six /v2/Common/UserChoice
 *               prompts on the Dejavoo QD2, then one /v2/Common/GetSignature.
 *
 * ── WHY A POLICY MODULE AND NOT A COLUMN ────────────────────────────────────
 * This is a RENDERER SWITCH, exactly as design decision D2 in
 * design/mockups/us-terminal-checkout-NOTES.md specifies. Both modes walk the
 * same state machine, stamp the same `tcCompletedAt`, and write the same
 * AgreementSectionInitial rows. Nothing about the session row changes when the
 * mode changes, so the mode does not belong on the session row — it belongs
 * where every other Settings-page toggle lives.
 *
 * ── STORAGE ─────────────────────────────────────────────────────────────────
 * AppSetting, key `tenant:<id>:checkoutContractPolicy`, value:
 *
 *   { "mode": "TERMINAL",
 *     "locations": { "<locationId>": "PHONE" } }
 *
 * The same scoped-AppSetting shape as customerInspectionConfig,
 * checkoutPaymentPolicy, fleetRotationConfig and twoFactorPolicy. Deliberately
 * NOT Tenant.settingsJson (that is the credentials blob) and deliberately NOT a
 * new column on Location — a Location column would mean a schema migration
 * every time this feature grows a second knob, and it would put a checkout
 * presentation choice in the same row as the branch's legal clause overrides.
 *
 * ── PER-LOCATION, AND WHY THE LOCATION WINS ────────────────────────────────
 * Hector's question 5 in the NOTES is "which LAX location(s) get TERMINAL
 * first" — the rollout unit is a counter, not a company. So the tenant value is
 * the default for the tenant's branches and a location entry overrides it in
 * EITHER direction: a tenant on PHONE can pilot TERMINAL at one branch, and a
 * tenant on TERMINAL can pull one branch back to PHONE the moment its QD2 dies
 * without taking the whole company off the terminal.
 *
 * ── FAIL-SAFE BY CONSTRUCTION ───────────────────────────────────────────────
 * PHONE is the default and only the exact string 'TERMINAL' selects the
 * terminal. Missing row, unparseable JSON, a DB error, 'terminal ' with a
 * space, null, true, 1 — every one of them resolves to PHONE, i.e. the flow
 * every tenant has today. There is no input that accidentally routes a renter
 * to a device that may not be plugged in.
 *
 * Note the asymmetry with tenant-terminal-config's `spin.enabled`: there,
 * honouring an unchecked box would have routed a charge to ANOTHER MERCHANT, so
 * the box is ignored. Here the "off" direction is the pre-existing flow on the
 * renter's own phone, which is always available. Off is safe, so off is default.
 *
 * ── CACHING ─────────────────────────────────────────────────────────────────
 * tenantKey(tenantId, 'checkout', 'contract-mode'), 60 s TTL, invalidated by
 * every write. Same contract as checkout-payment-policy: without the
 * invalidation an admin flips the switch and nothing appears to happen for a
 * minute, which reads as "the toggle is broken".
 *
 * LEAF MODULE on purpose — prisma + cache + logger only, so the checkout
 * services can read the policy without dragging settings.service.js and its
 * transitive graph into the checkout import cycle.
 */

import { prisma } from '../../lib/prisma.js';
import { cache } from '../../lib/cache.js';
import { tenantKey } from '../../lib/cache/tenantKey.js';
import logger from '../../lib/logger.js';

/** AppSetting base key (tenant-scoped by `settingKeyFor`). */
export const CHECKOUT_CONTRACT_POLICY_SETTING = 'checkoutContractPolicy';

export const CONTRACT_MODES = Object.freeze({ PHONE: 'PHONE', TERMINAL: 'TERMINAL' });

/** The value every unconfigured tenant resolves to. */
export const DEFAULT_CONTRACT_MODE = CONTRACT_MODES.PHONE;

const CACHE_TTL_MS = 60 * 1000;

/**
 * The single fail-safe rule, exported so tests can pin it without a DB.
 * ONLY the exact string 'TERMINAL' selects the terminal.
 */
export function normalizeContractMode(raw) {
  return raw === CONTRACT_MODES.TERMINAL ? CONTRACT_MODES.TERMINAL : CONTRACT_MODES.PHONE;
}

function settingKeyFor(tenantId) {
  // Mirrors settings.service.js scopedKey(). A null tenant never reaches here
  // from the resolver (it returns the default first); this exists so the writer
  // and the reader agree on the key.
  return tenantId
    ? `tenant:${tenantId}:${CHECKOUT_CONTRACT_POLICY_SETTING}`
    : CHECKOUT_CONTRACT_POLICY_SETTING;
}

function cacheKeyFor(tenantId) {
  return tenantKey(tenantId, 'checkout', 'contract-mode');
}

/**
 * Normalize a stored blob into `{ mode, locations }`. Tolerant in exactly one
 * direction: anything it cannot understand becomes PHONE.
 */
export function normalizeContractPolicy(parsed) {
  const out = { mode: DEFAULT_CONTRACT_MODE, locations: {} };
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return out;
  out.mode = normalizeContractMode(parsed.mode);
  const locs = parsed.locations;
  if (locs && typeof locs === 'object' && !Array.isArray(locs)) {
    for (const [locationId, value] of Object.entries(locs)) {
      const id = String(locationId || '').trim();
      if (!id) continue;
      out.locations[id] = normalizeContractMode(value);
    }
  }
  return out;
}

/**
 * Read the tenant's whole policy. Never throws — an unreadable row degrades to
 * "this tenant is on PHONE", which is the flow that has always worked.
 */
export async function getContractPolicy(tenantId) {
  if (!tenantId) return { mode: DEFAULT_CONTRACT_MODE, locations: {} };
  try {
    return await cache.getOrSet(cacheKeyFor(tenantId), async () => {
      let parsed = {};
      try {
        const row = await prisma.appSetting.findUnique({ where: { key: settingKeyFor(tenantId) } });
        parsed = row?.value ? JSON.parse(row.value) : {};
      } catch (err) {
        logger.warn('[checkout-contract-mode] unreadable policy, defaulting to PHONE', {
          tenantId, error: err?.message || String(err),
        });
        parsed = {};
      }
      return normalizeContractPolicy(parsed);
    }, CACHE_TTL_MS);
  } catch (err) {
    logger.warn('[checkout-contract-mode] resolver failed, defaulting to PHONE', {
      tenantId, error: err?.message || String(err),
    });
    return { mode: DEFAULT_CONTRACT_MODE, locations: {} };
  }
}

/**
 * Resolve the mode for ONE checkout: the pickup location's own setting if it
 * has one, otherwise the tenant's.
 *
 * @returns {Promise<{ mode: 'PHONE'|'TERMINAL', source: 'LOCATION'|'TENANT'|'DEFAULT' }>}
 *   `source` is carried so the agent screen and the logs can say WHY this
 *   checkout is on the terminal, which is the first question anyone asks when
 *   one counter behaves differently from the one beside it.
 */
export async function resolveContractMode(tenantId, { locationId = null } = {}) {
  if (!tenantId) return { mode: DEFAULT_CONTRACT_MODE, source: 'DEFAULT' };
  const policy = await getContractPolicy(tenantId);
  const locId = String(locationId || '').trim();
  if (locId && Object.prototype.hasOwnProperty.call(policy.locations, locId)) {
    return { mode: policy.locations[locId], source: 'LOCATION' };
  }
  return { mode: policy.mode, source: policy.mode === DEFAULT_CONTRACT_MODE ? 'DEFAULT' : 'TENANT' };
}

/** Drop the cached value for a tenant. MUST be called by every write path. */
export function invalidateCheckoutContractPolicy(tenantId) {
  if (!tenantId) return;
  try {
    cache.del(cacheKeyFor(tenantId));
  } catch (err) {
    // A cache key that cannot be built must never break a settings save.
    logger.warn('[checkout-contract-mode] cache invalidation failed', {
      tenantId, error: err?.message || String(err),
    });
  }
}

/**
 * Persist the policy and invalidate the cache. Everything is normalized through
 * the same fail-safe rule as the reader, so no write can store a value that
 * resolves to something other than what the caller asked for.
 */
export async function setContractPolicy(tenantId, { mode, locations } = {}) {
  if (!tenantId) throw new Error('tenantId is required');
  const next = normalizeContractPolicy({ mode, locations });
  const key = settingKeyFor(tenantId);
  const value = JSON.stringify(next);
  await prisma.appSetting.upsert({
    where: { key },
    create: { key, value },
    update: { value },
  });
  invalidateCheckoutContractPolicy(tenantId);
  return next;
}
