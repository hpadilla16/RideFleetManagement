/**
 * Feature flags — shared lib (project convention, 2026-05-21)
 *
 * Every new tenant-facing feature ships behind a per-tenant flag in one of
 * three states:
 *
 *   OFF   — legacy flow for everyone (default when absent)
 *   TEST  — new flow only for users with role 'SUPER_ADMIN'
 *   LIVE  — new flow for everyone at the tenant
 *
 * Storage: Tenant.settingsJson.featureFlags = { flagName: 'OFF'|'TEST'|'LIVE' }
 * Audit:   each set writes a TenantAuditLog row (action='FEATURE_FLAG_CHANGED')
 * Cache:   reads cached 3 min via tenantKey; writes invalidate the cache
 *
 * Full spec: doc/feature-flag-convention.md
 *
 * Usage in a resolver:
 *   import { getTenantFlag, resolveFlag } from '../../lib/feature-flags.js';
 *   const state = await getTenantFlag(tenantId, 'dejavooCounter');
 *   const isOn = resolveFlag(state, req.user);
 */

import { cache } from './cache.js';
import { tenantKey } from './cache/tenantKey.js';

// Lazy prisma — keeps unit tests from spinning up the engine.
let _defaultPrisma = null;
async function resolveDefaultPrisma() {
  if (_defaultPrisma) return _defaultPrisma;
  const mod = await import('./prisma.js');
  _defaultPrisma = mod.prisma;
  return _defaultPrisma;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const FLAG_STATE = Object.freeze({
  OFF: 'OFF',
  TEST: 'TEST',
  LIVE: 'LIVE',
});

export const VALID_STATES = Object.freeze(Object.keys(FLAG_STATE));

// Flag names must match this pattern. camelCase, alphanumeric.
// See doc/feature-flag-convention.md §8.
const FLAG_NAME_RE = /^[a-z][a-zA-Z0-9]*$/;

// Audit action used for flag changes. Other tenant-level admin actions
// should use a different action name (we share the TenantAuditLog table).
export const AUDIT_ACTION_FLAG_CHANGED = 'FEATURE_FLAG_CHANGED';

// Cache TTL — same 3 minutes as other tenant settings caches.
const CACHE_TTL_MS = 3 * 60 * 1000;

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class FeatureFlagError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = 'FeatureFlagError';
    this.status = status;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function assertFlagName(name) {
  if (!name || typeof name !== 'string' || !FLAG_NAME_RE.test(name)) {
    throw new FeatureFlagError(
      `Invalid flag name '${name}'. Must match ${FLAG_NAME_RE} (camelCase, alphanumeric).`,
      400
    );
  }
}

function assertFlagState(state) {
  if (!VALID_STATES.includes(state)) {
    throw new FeatureFlagError(
      `Invalid flag state '${state}'. Must be one of ${VALID_STATES.join(', ')}.`,
      400
    );
  }
}

function parseSettingsJson(raw) {
  if (!raw) return {};
  if (typeof raw === 'object') return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

/**
 * Get all feature flags for a tenant. Returns an object map of
 * { flagName: 'OFF'|'TEST'|'LIVE' }. Cached 3 min.
 *
 * Use this when you need to render the admin UI with all flags at once.
 * For a single flag check, prefer getTenantFlag().
 */
export async function getTenantFlags(tenantId, { prisma } = {}) {
  if (!tenantId) return {};
  return cache.getOrSet(
    tenantKey(tenantId, 'feature-flags'),
    async () => {
      const client = prisma || (await resolveDefaultPrisma());
      const tenant = await client.tenant.findUnique({
        where: { id: tenantId },
        select: { settingsJson: true },
      });
      if (!tenant) return {};
      const settings = parseSettingsJson(tenant.settingsJson);
      const flags = settings.featureFlags || {};
      // Sanity: drop any non-canonical values (handle data drift defensively).
      const out = {};
      for (const [k, v] of Object.entries(flags)) {
        if (VALID_STATES.includes(v)) out[k] = v;
      }
      return out;
    },
    CACHE_TTL_MS
  );
}

/**
 * Get a single feature flag for a tenant. Returns 'OFF' if absent.
 */
export async function getTenantFlag(tenantId, name, opts = {}) {
  if (!tenantId || !name) return FLAG_STATE.OFF;
  const flags = await getTenantFlags(tenantId, opts);
  return flags[name] || FLAG_STATE.OFF;
}

// ---------------------------------------------------------------------------
// Resolver — apply the TEST-mode role gate
// ---------------------------------------------------------------------------

/**
 * Apply the canonical "feature is active for this user" logic:
 *   LIVE → always on
 *   TEST → on ONLY for SUPER_ADMIN
 *   OFF  → always off
 *
 * @param {string} state
 * @param {{ role?: string }} user
 * @returns {boolean}
 */
export function resolveFlag(state, user) {
  if (state === FLAG_STATE.LIVE) return true;
  if (state === FLAG_STATE.TEST && user && user.role === 'SUPER_ADMIN') return true;
  return false;
}

/**
 * Convenience: combine getTenantFlag + resolveFlag.
 */
export async function isFeatureOnForUser(tenantId, name, user, opts = {}) {
  const state = await getTenantFlag(tenantId, name, opts);
  return resolveFlag(state, user);
}

// ---------------------------------------------------------------------------
// Write
// ---------------------------------------------------------------------------

/**
 * Set a feature flag for a tenant. Atomic read-modify-write via $transaction.
 * Writes a TenantAuditLog row. Invalidates the tenant's feature-flags cache.
 *
 * Throws FeatureFlagError on invalid inputs or unknown tenant.
 *
 * @param {string} tenantId
 * @param {string} name             — must match FLAG_NAME_RE
 * @param {string} value            — OFF | TEST | LIVE
 * @param {object} opts
 * @param {string} [opts.actorUserId] — for the audit row
 * @param {object} [opts.prisma]
 * @returns {Promise<{ flag, from, to, at }>}
 */
export async function setTenantFlag(tenantId, name, value, opts = {}) {
  if (!tenantId) throw new FeatureFlagError('tenantId is required', 400);
  assertFlagName(name);
  assertFlagState(value);

  const client = opts.prisma || (await resolveDefaultPrisma());
  const actorUserId = opts.actorUserId || null;

  const result = await client.$transaction(async (tx) => {
    const tenant = await tx.tenant.findUnique({
      where: { id: tenantId },
      select: { id: true, settingsJson: true },
    });
    if (!tenant) {
      throw new FeatureFlagError(`Tenant ${tenantId} not found`, 404);
    }
    const settings = parseSettingsJson(tenant.settingsJson);
    const flags = settings.featureFlags || {};
    const previous = flags[name] || FLAG_STATE.OFF;

    // No-op if state hasn't changed — still write an audit row so we have
    // a record of who confirmed the state, but skip the Tenant update.
    let didWrite = false;
    if (previous !== value) {
      flags[name] = value;
      settings.featureFlags = flags;
      await tx.tenant.update({
        where: { id: tenantId },
        data: { settingsJson: settings },
      });
      didWrite = true;
    }

    const at = new Date().toISOString();
    await tx.tenantAuditLog.create({
      data: {
        tenantId,
        actorUserId,
        action: AUDIT_ACTION_FLAG_CHANGED,
        resource: name,
        payload: { flag: name, from: previous, to: value, at, noop: !didWrite },
      },
    });

    return { flag: name, from: previous, to: value, at, noop: !didWrite };
  });

  // Invalidate. Use both the specific feature-flags key AND broader settings
  // patterns that other modules may have cached against tenant.settingsJson.
  // The convention doc explicitly notes this is a heavy invalidation; flips
  // are rare so the cost is acceptable.
  cache.del(tenantKey(tenantId, 'feature-flags'));
  cache.invalidate(`t:${tenantId}:`);

  return result;
}

// ---------------------------------------------------------------------------
// Audit history
// ---------------------------------------------------------------------------

/**
 * List recent audit entries for a tenant. Used by the admin UI to render
 * the "who flipped what when" panel below the toggles.
 *
 * @param {string} tenantId
 * @param {object} [opts]
 * @param {number} [opts.limit=20]
 * @param {string} [opts.action]  — defaults to FEATURE_FLAG_CHANGED
 * @param {object} [opts.prisma]
 */
export async function listTenantAuditLog(tenantId, opts = {}) {
  if (!tenantId) return [];
  const client = opts.prisma || (await resolveDefaultPrisma());
  const limit = Math.min(Math.max(parseInt(opts.limit, 10) || 20, 1), 100);
  return client.tenantAuditLog.findMany({
    where: {
      tenantId,
      ...(opts.action ? { action: opts.action } : {}),
    },
    orderBy: { createdAt: 'desc' },
    take: limit,
    include: opts.includeActor
      ? { actorUser: { select: { id: true, fullName: true, email: true } } }
      : undefined,
  });
}
