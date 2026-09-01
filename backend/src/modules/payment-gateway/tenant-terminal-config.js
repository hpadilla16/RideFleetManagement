/**
 * tenant-terminal-config.js — the ONE resolver for "which Dejavoo/SPIn
 * terminal does THIS tenant charge through".
 *
 * ── WHY THIS EXISTS ────────────────────────────────────────────────────────
 * Until 2026-08-26 every tenant charged through whatever terminal the PLATFORM
 * env named (SPIN_AUTH_KEY / SPIN_TPN). The checkout wizard's
 * loadTenantSpinConfig() selected `{ id: true }` and returned effectively `{}`,
 * so spin-client.js fell through to the env vars on EVERY charge, for EVERY
 * tenant. With one live merchant (International Rental Corp) that was invisible.
 * The moment a second tenant plugs in their own iPOS merchant account it is a
 * wrong-merchant charge: tenant B's customer taps, tenant A's bank account
 * settles. This module is the fix.
 *
 * ── THE ONE HOME ───────────────────────────────────────────────────────────
 * Canonical store: AppSetting row `tenant:<tenantId>:paymentGatewayConfig`,
 * `spin` block. That key is NOT invented here — it is what the Settings page
 * (Settings → Payment Gateway → SPIn Terminal) has always written via
 * settings.service.updatePaymentGatewayConfig(). The shape is:
 *
 *   { spin: { enabled, environment, authKey, tpn, merchantNumber,
 *             callbackUrl, proxyTimeout } }
 *
 * Two other candidate homes existed and are deliberately NOT read here:
 *   • Tenant.settingsJson (`dejavoo` / `spin*` keys) — nothing writes terminal
 *     credentials there; IRC's only holds an orphaned preAuthAmountCents.
 *   • payment-gateway.service.getTenantSpinConfig — reads Tenant.settingsJson
 *     and is reachable only from /api/payment-gateway/* routes that have no
 *     frontend caller. Left alone; it is not on the live charge path.
 * One home, one resolver. Adding a second is how the wrong-merchant bug comes
 * back wearing a different hat.
 *
 * ── PRECEDENCE (money-safety order, not convenience order) ─────────────────
 *   1. TENANT — the tenant's own spin block carries BOTH authKey AND tpn.
 *   2. NONE   — the tenant's spin block is PARTIAL (one of the two set).
 *               We do NOT fall back to env here even when env fallback is
 *               allowed: somebody started configuring this tenant's terminal,
 *               and pairing their half-entered credential with the platform's
 *               other half is precisely the ambiguity that charges the wrong
 *               merchant. Fail closed and make a human finish the job.
 *   3. ENV    — the tenant has NO spin config at all, env fallback is allowed
 *               and the platform env carries both values. Logged LOUDLY, by
 *               tenant name, on every single resolution (see below).
 *   4. NONE   — everything else.
 *
 * `spin.enabled` is deliberately NOT part of resolution. If a tenant has an
 * authKey + TPN on file, that is their terminal, checkbox or no checkbox.
 * Treating an unchecked box as "not configured" would route that tenant's
 * charge to the ENV terminal — i.e. the unchecked box would cause the exact
 * wrong-merchant charge this module exists to prevent. The flag is carried in
 * the result for observability only.
 *
 * ── FAIL-CLOSED, AND WHY THE DEFAULT IS WHAT IT IS ────────────────────────
 * SPIN_ALLOW_ENV_FALLBACK gates step 3. It ships ALLOWED (the default) because
 * International Rental Corp is live TODAY on the platform env vars and has no
 * AppSetting spin block yet; defaulting to deny would take a working merchant
 * offline at deploy time — an outage dressed up as a security control. So the
 * deployable default keeps IRC charging, and every ENV-sourced charge writes a
 * WARN naming the tenant so the migration backlog is visible in the logs
 * instead of in a chargeback. Once each tenant's terminal is configured, set
 * SPIN_ALLOW_ENV_FALLBACK=false and the platform terminal becomes unreachable
 * from the charge path entirely.
 *
 * What is NEVER allowed, in either mode: a silent fallback. source is always
 * reported, always logged, and a NONE resolution fails the charge before any
 * provider call (see spin-charge.service.loadTenantSpinConfig).
 *
 * ── CREDENTIALS AT REST ────────────────────────────────────────────────────
 * spin.authKey is a live payment credential and is stored as `enci:` ciphertext
 * via lib/setting-secret-crypto.js (AES-256-GCM under INTEGRATION_ENC_KEY).
 * decryptSettingSecret() is dual-read forever: anything stored before this
 * change (plaintext) passes through untouched, and any save through the
 * Settings page upgrades it in place. The TPN is NOT a secret — it is a
 * terminal identifier the operator has to be able to eyeball — so it stays
 * plaintext and is masked only in logs.
 */

import { prisma } from '../../lib/prisma.js';
import logger from '../../lib/logger.js';
import { cache } from '../../lib/cache.js';
import { tenantKey } from '../../lib/cache/tenantKey.js';
import { decryptSettingSecret } from '../../lib/setting-secret-crypto.js';

/** Base AppSetting key. Tenant-scoped form is `tenant:<id>:<base>`. */
export const PAYMENT_GATEWAY_SETTING_BASE_KEY = 'paymentGatewayConfig';

/** The tenant-scoped AppSetting key this resolver reads. */
export function terminalConfigSettingKey(tenantId) {
  return `tenant:${tenantId}:${PAYMENT_GATEWAY_SETTING_BASE_KEY}`;
}

// Short TTL. The charge path reads this on every sale/hold, and a stale read
// after an operator fixes a typo'd TPN is a support call — so it is a cache to
// spare the DB a per-tap round trip, not a cache to lean on. Writes invalidate
// immediately (invalidateTenantTerminalConfig), TTL is just the safety net for
// a write that happened somewhere this process never saw.
const CACHE_TTL_MS = 60 * 1000;

function cacheKeyFor(tenantId) {
  return tenantKey(tenantId, 'payment', 'terminal-config');
}

/** Drop the cached DB read for one tenant. Called on every settings save. */
export function invalidateTenantTerminalConfig(tenantId) {
  if (!tenantId) return;
  try {
    cache.del(cacheKeyFor(tenantId));
  } catch (err) {
    // A cache key that can't be built must never break a settings save.
    logger.warn('[tenant-terminal-config] cache invalidation failed', {
      tenantId, err: String(err?.message || err),
    });
  }
}

/**
 * Mask a TPN for logs/audit: first 4 + last 4, everything else stars. Short or
 * absent values collapse to a constant so nothing partial ever leaks.
 */
export function maskTpn(tpn) {
  const raw = String(tpn || '').trim();
  if (!raw) return '(none)';
  if (raw.length <= 8) return '****';
  return `${raw.slice(0, 4)}****${raw.slice(-4)}`;
}

/** SPIN_DRY_RUN=true — the client returns synthetic approvals, no terminal. */
export function isSpinDryRun() {
  return String(process.env.SPIN_DRY_RUN || '').toLowerCase() === 'true';
}

/**
 * Whether a tenant with NO terminal config of their own may charge through the
 * platform env terminal. Default ALLOWED — see the header for why. Only the
 * explicit string 'false' tightens it.
 */
export function isEnvFallbackAllowed() {
  const raw = String(process.env.SPIN_ALLOW_ENV_FALLBACK ?? '').trim().toLowerCase();
  if (raw === 'false' || raw === '0' || raw === 'no') return false;
  return true;
}

function envTerminal() {
  return {
    authKey: String(process.env.SPIN_AUTH_KEY || '').trim(),
    tpn: String(process.env.SPIN_TPN || '').trim(),
    merchantNumber: String(process.env.SPIN_MERCHANT_NUMBER || '1').trim(),
    callbackUrl: String(process.env.SPIN_CALLBACK_URL || '').trim(),
    proxyTimeout: String(process.env.SPIN_PROXY_TIMEOUT || '120').trim(),
  };
}

/**
 * Read + decrypt the tenant's own spin block. NEVER throws: a missing row, a
 * dead DB, malformed JSON and a failed decrypt all degrade to "this tenant has
 * no terminal config", which the precedence above then handles explicitly
 * (fail closed or an audited env fallback) rather than guessing.
 *
 * Cached for CACHE_TTL_MS. Only THIS half is cached — the env-fallback decision
 * is recomputed per call so the warning fires on every charge and a flag flip
 * takes effect without waiting out a TTL.
 */
async function readTenantTerminalRow(tenantId) {
  return cache.getOrSet(cacheKeyFor(tenantId), async () => {
    let tenantName = '';
    let spin = null;
    try {
      const [tenant, row] = await Promise.all([
        prisma.tenant.findUnique({ where: { id: tenantId }, select: { name: true } }),
        prisma.appSetting.findUnique({ where: { key: terminalConfigSettingKey(tenantId) } }),
      ]);
      tenantName = String(tenant?.name || '');
      if (row?.value) {
        const parsed = JSON.parse(row.value);
        const block = parsed?.spin;
        if (block && typeof block === 'object') {
          spin = {
            enabled: !!block.enabled,
            environment: String(block.environment || 'production').trim().toLowerCase(),
            // Dual-read: `enci:` ciphertext decrypts, legacy plaintext passes
            // through, an undecryptable value comes back '' (never raw bytes).
            authKey: String(decryptSettingSecret(block.authKey) || '').trim(),
            tpn: String(block.tpn || '').trim(),
            merchantNumber: String(block.merchantNumber || '1').trim(),
            callbackUrl: String(block.callbackUrl || '').trim(),
            proxyTimeout: String(block.proxyTimeout || '120').trim(),
          };
        }
      }
    } catch (err) {
      logger.warn('[tenant-terminal-config] could not read tenant terminal config — treating as unconfigured', {
        tenantId, err: String(err?.message || err),
      });
      return { tenantName: '', spin: null };
    }
    return { tenantName, spin };
  }, CACHE_TTL_MS);
}

/**
 * Resolve the terminal this tenant charges through.
 *
 * @param {string} tenantId
 * @param {{ allowEnvFallback?: boolean }} [options] — override for tests /
 *        callers that want to probe the tightened posture without mutating env.
 * @returns {Promise<{
 *   authKey: string, tpn: string, merchantNumber: string, callbackUrl: string,
 *   proxyTimeout: string, sandbox: boolean, enabled: boolean,
 *   source: 'TENANT'|'ENV'|'NONE', reason: string,
 *   tenantId: string|null, tenantName: string, maskedTpn: string
 * }>}
 */
export async function resolveTenantTerminalConfig(tenantId, options = {}) {
  const allowEnvFallback = options.allowEnvFallback === undefined
    ? isEnvFallbackAllowed()
    : !!options.allowEnvFallback;

  const none = (reason, extra = {}) => ({
    authKey: '', tpn: '', merchantNumber: '1', callbackUrl: '', proxyTimeout: '120',
    sandbox: false, enabled: false,
    source: 'NONE', reason,
    tenantId: tenantId || null, tenantName: '', maskedTpn: maskTpn(''),
    ...extra,
  });

  if (!tenantId) return none('NO_TENANT_ID');

  const { tenantName, spin } = await readTenantTerminalRow(tenantId);

  const hasAuthKey = !!spin?.authKey;
  const hasTpn = !!spin?.tpn;

  if (hasAuthKey && hasTpn) {
    return {
      authKey: spin.authKey,
      tpn: spin.tpn,
      merchantNumber: spin.merchantNumber || '1',
      callbackUrl: spin.callbackUrl || '',
      proxyTimeout: spin.proxyTimeout || '120',
      // Informational only. spin-client.js is production-endpoint-only by
      // design (the sandbox plumbing was deliberately removed 2026-05-29), so
      // nothing routes on this — it is here so the resolved shape can answer
      // "what did the operator pick" without a second read.
      sandbox: spin.environment !== 'production',
      enabled: spin.enabled,
      source: 'TENANT',
      reason: 'TENANT_CONFIG',
      tenantId,
      tenantName,
      maskedTpn: maskTpn(spin.tpn),
    };
  }

  if (hasAuthKey || hasTpn) {
    // Half-configured. Never pair it with the platform's other half.
    logger.error('[tenant-terminal-config] tenant terminal config is INCOMPLETE — refusing to pair it with the platform terminal', {
      tenantId, tenantName, hasAuthKey, hasTpn, maskedTpn: maskTpn(spin?.tpn),
    });
    return none('INCOMPLETE_TENANT_CONFIG', { tenantId, tenantName });
  }

  const env = envTerminal();
  const envUsable = !!(env.authKey && env.tpn);

  if (!allowEnvFallback) {
    return none('ENV_FALLBACK_DISABLED', { tenantId, tenantName });
  }
  if (!envUsable) {
    return none('NO_CONFIG_ANYWHERE', { tenantId, tenantName });
  }

  // LOUD, every time, by name. This is the migration backlog made visible: any
  // tenant appearing here is charging through the PLATFORM merchant account.
  logger.warn('[tenant-terminal-config] FALLING BACK TO THE PLATFORM TERMINAL — this tenant has no terminal of their own', {
    tenantId,
    tenantName: tenantName || '(unknown)',
    maskedTpn: maskTpn(env.tpn),
    action: 'Configure Settings → Payment Gateway → SPIn Terminal for this tenant, then set SPIN_ALLOW_ENV_FALLBACK=false',
  });

  return {
    authKey: env.authKey,
    tpn: env.tpn,
    merchantNumber: env.merchantNumber || '1',
    callbackUrl: env.callbackUrl || '',
    proxyTimeout: env.proxyTimeout || '120',
    sandbox: false,
    enabled: true,
    source: 'ENV',
    reason: 'ENV_FALLBACK',
    tenantId,
    tenantName,
    maskedTpn: maskTpn(env.tpn),
  };
}

/**
 * Adapt a resolved config into the `tenantConfig` shape spin-client.getConfig()
 * reads. Per-field env fallback inside the client stays intact for the fields
 * we don't carry (clientTimeoutMs, dry-run), which is the tenant → env → nothing
 * order the client already implements.
 *
 * For source ENV we return `{}` on purpose: the client then reads the env vars
 * itself, byte for byte the pre-2026-08-26 behaviour, so IRC's live path is
 * unchanged rather than re-derived.
 */
export function toSpinClientConfig(resolved) {
  if (!resolved || resolved.source !== 'TENANT') return {};
  return {
    spinAuthKey: resolved.authKey,
    spinTpn: resolved.tpn,
    spinMerchantNumber: resolved.merchantNumber,
    spinCallbackUrl: resolved.callbackUrl,
    spinProxyTimeout: resolved.proxyTimeout,
  };
}

/**
 * Build the audit metadata for a payment-gateway settings save.
 *
 * Lives here (and is unit-tested here) rather than inline in the route so the
 * "the auth key never reaches the audit trail" rule is a testable function
 * instead of a promise in a comment. Booleans and a masked TPN only.
 *
 * @param {object} cfg  — the READ-shaped config returned after the save
 * @param {object} body — the raw request body (never stored, only inspected)
 */
export function buildTerminalAuditMetadata(cfg = {}, body = {}, tenantId = null) {
  return {
    tenantId: tenantId || null,
    gateway: cfg?.gateway || null,
    spinEnabled: !!cfg?.spin?.enabled,
    spinTpnMasked: maskTpn(cfg?.spin?.tpn),
    spinAuthKeyOnFile: !!cfg?.spin?.hasAuthKey,
    // "did this request supply a new key", NOT the key.
    spinAuthKeyReplaced: !!String(body?.spin?.authKey || '').trim(),
    spinAuthKeyCleared: !!body?.spin?.clearAuthKey,
  };
}

export const tenantTerminalConfig = {
  resolveTenantTerminalConfig,
  invalidateTenantTerminalConfig,
  toSpinClientConfig,
  terminalConfigSettingKey,
  isEnvFallbackAllowed,
  isSpinDryRun,
  maskTpn,
  buildTerminalAuditMetadata,
};
