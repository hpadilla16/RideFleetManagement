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
 * ── REGISTERS: ONE TERMINAL PER COUNTER (2026-09-04) ──────────────────────
 * Everything above resolves per TENANT. That was correct and insufficient the
 * moment Corpusa arrived: five locations, one credential pair. LAX was only the
 * first — configuring Orlando meant overwriting LAX, and the Settings panel had
 * nowhere to say WHICH counter a TPN belonged to.
 *
 * So the same AppSetting row now also carries a `registers` ARRAY:
 *
 *   { registers: [ { id, name, locationId, tpn, authKey, merchantNumber,
 *                    callbackUrl, proxyTimeout, enabled } ] }
 *
 * SAME ROW, deliberately. A separate Prisma model would mean a second read on
 * every tap, a second cache, a second invalidation path and a second answer to
 * "which terminal charges this" — the exact shape of the bug this module was
 * written to kill. One row, one read, one resolver.
 *
 * The register array SUPERSEDES the legacy single `spin` block for a tenant
 * that has at least one ENABLED register. A tenant with none (IRC today, and
 * every tenant that never opens the new section) resolves byte for byte the way
 * it did before this change.
 *
 * `enabled` IS part of register resolution, unlike `spin.enabled` (see below).
 * The asymmetry is deliberate and is a money-safety argument, not a taste one:
 * unchecking the single tenant block would route that tenant to the PLATFORM
 * env terminal — a different merchant. Disabling a register can only ever
 * narrow the answer to another register of the SAME tenant, to the same
 * tenant's legacy block, or to a fail-closed refusal. It never crosses a
 * merchant boundary, so it is safe to honour as an on/off switch — which is
 * what an operator taking one counter's device out of service needs.
 *
 * ── PRECEDENCE (money-safety order, not convenience order) ─────────────────
 * Registers first, when the tenant has any enabled ones:
 *   R0. TENANT — `options.registerId` names an enabled, complete register.
 *                reason REGISTER_PINNED. For the two-counters-one-branch case
 *                the mockup draws (LAX Counter 1 / Counter 2), where a location
 *                alone cannot say which device is in front of the agent.
 *   R1. TENANT — `options.locationId` matches an enabled, complete register.
 *                reason REGISTER_MATCH.
 *   R2. NONE   — a locationId was given, the tenant HAS enabled registers, and
 *                none of them is at that location. reason
 *                NO_REGISTER_FOR_LOCATION. This is the whole point of the
 *                feature: falling through to another register, or to the legacy
 *                block, would run counter A's sale on counter B's device.
 *                Somebody at Orlando would be tapping LAX's terminal. Fail
 *                closed and make a human configure Orlando.
 *   R3. TENANT — no locationId given and the tenant has EXACTLY ONE enabled
 *                register. reason SOLE_REGISTER. There is no ambiguity to
 *                resolve, so a path that genuinely has no location keeps
 *                working.
 *   R4. NONE   — no locationId given, MORE than one enabled register. reason
 *                AMBIGUOUS_REGISTER_NO_LOCATION. Picking one would be guessing
 *                which counter, on a money path.
 *   R5. NONE   — the register we picked is half-configured (authKey xor tpn).
 *                reason INCOMPLETE_REGISTER, same argument as the tenant-level
 *                INCOMPLETE_TENANT_CONFIG below.
 *
 * Then, for a tenant with NO enabled registers, unchanged since 2026-08-26:
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
 * A locationId passed to a tenant with no registers at all is IGNORED, not an
 * error. Callers thread the pickup location unconditionally; a tenant that
 * never adopted registers must not start failing because of it.
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
 * spin.authKey — and every register's authKey, on exactly the same contract —
 * is a live payment credential and is stored as `enci:` ciphertext
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
/**
 * Normalize ONE stored register into the resolved shape. Mirrors the spin
 * block's rules exactly: the authKey dual-reads `enci:` ciphertext and legacy
 * plaintext, the TPN stays plaintext (it is an identifier the operator has to
 * eyeball), and an undecryptable key degrades to '' rather than raw bytes —
 * which the completeness check below then treats as half-configured.
 *
 * Returns null for anything without an id: a register with no stable id cannot
 * be pinned, audited or health-checked, so it is not a register.
 */
function normalizeStoredRegister(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const id = String(raw.id || '').trim();
  if (!id) return null;
  return {
    id,
    name: String(raw.name || '').trim(),
    locationId: String(raw.locationId || '').trim(),
    authKey: String(decryptSettingSecret(raw.authKey) || '').trim(),
    tpn: String(raw.tpn || '').trim(),
    merchantNumber: String(raw.merchantNumber || '1').trim(),
    // NOT defaulted here. An empty callbackUrl/proxyTimeout must stay empty so
    // resolution can tell "this register says nothing" from "this register says
    // 120", and inherit the tenant block's value in the first case.
    callbackUrl: String(raw.callbackUrl || '').trim(),
    proxyTimeout: String(raw.proxyTimeout || '').trim(),
    // Absent means ON. A register that exists at all was added by an operator
    // to be used; only an explicit `false` takes it out of service.
    enabled: raw.enabled !== false,
  };
}

/** A register may only be charged through when BOTH halves are present. */
function isRegisterComplete(reg) {
  return !!(reg?.authKey && reg?.tpn);
}

async function readTenantTerminalRow(tenantId) {
  return cache.getOrSet(cacheKeyFor(tenantId), async () => {
    let tenantName = '';
    let spin = null;
    let registers = [];
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
        if (Array.isArray(parsed?.registers)) {
          registers = parsed.registers.map(normalizeStoredRegister).filter(Boolean);
        }
      }
    } catch (err) {
      logger.warn('[tenant-terminal-config] could not read tenant terminal config — treating as unconfigured', {
        tenantId, err: String(err?.message || err),
      });
      return { tenantName: '', spin: null, registers: [] };
    }
    return { tenantName, spin, registers };
  }, CACHE_TTL_MS);
}

/**
 * Resolve the terminal this tenant charges through — and, when the tenant runs
 * registers, WHICH counter's device.
 *
 * @param {string} tenantId
 * @param {{
 *   locationId?: string,   — the reservation's PICKUP location. Threaded by every
 *                            live charge path. Ignored for a tenant with no
 *                            registers; decisive for one that has them.
 *   registerId?: string,   — pin an exact register, for a branch with two counters.
 *   allowEnvFallback?: boolean — override for tests / callers that want to probe
 *                            the tightened posture without mutating env.
 * }} [options]
 * @returns {Promise<{
 *   authKey: string, tpn: string, merchantNumber: string, callbackUrl: string,
 *   proxyTimeout: string, sandbox: boolean, enabled: boolean,
 *   source: 'TENANT'|'ENV'|'NONE', reason: string,
 *   tenantId: string|null, tenantName: string, maskedTpn: string,
 *   registerId: string|null, registerName: string, locationId: string|null
 * }>}
 */
export async function resolveTenantTerminalConfig(tenantId, options = {}) {
  const allowEnvFallback = options.allowEnvFallback === undefined
    ? isEnvFallbackAllowed()
    : !!options.allowEnvFallback;
  const wantLocationId = String(options.locationId || '').trim();
  const wantRegisterId = String(options.registerId || '').trim();

  const none = (reason, extra = {}) => ({
    authKey: '', tpn: '', merchantNumber: '1', callbackUrl: '', proxyTimeout: '120',
    sandbox: false, enabled: false,
    source: 'NONE', reason,
    tenantId: tenantId || null, tenantName: '', maskedTpn: maskTpn(''),
    registerId: null, registerName: '', locationId: wantLocationId || null,
    ...extra,
  });

  if (!tenantId) return none('NO_TENANT_ID');

  const { tenantName, spin, registers } = await readTenantTerminalRow(tenantId);

  // ── Registers ───────────────────────────────────────────────────────────
  // Only ENABLED registers count. A tenant with none of them has not adopted
  // registers (or has taken them all out of service) and drops through to the
  // pre-2026-09-04 tenant-level path below, unchanged.
  const enabledRegisters = (registers || []).filter((r) => r.enabled);

  if (enabledRegisters.length > 0) {
    const fromRegister = (reg, reason) => ({
      authKey: reg.authKey,
      tpn: reg.tpn,
      merchantNumber: reg.merchantNumber || '1',
      // A register with no callback/timeout of its own inherits the tenant
      // block's — those are deployment plumbing, not merchant identity, and an
      // operator adding a second counter should not have to retype them.
      callbackUrl: reg.callbackUrl || spin?.callbackUrl || '',
      proxyTimeout: reg.proxyTimeout || spin?.proxyTimeout || '120',
      sandbox: false,
      enabled: true,
      source: 'TENANT',
      reason,
      tenantId,
      tenantName,
      maskedTpn: maskTpn(reg.tpn),
      registerId: reg.id,
      registerName: reg.name,
      locationId: reg.locationId || null,
    });

    // Half-configured register — same refusal as the tenant-level block. Never
    // pair one register's key with another register's TPN, or with the env's.
    const guardComplete = (reg, reason) => {
      if (isRegisterComplete(reg)) return fromRegister(reg, reason);
      logger.error('[tenant-terminal-config] register is INCOMPLETE — refusing to pair it with any other terminal', {
        tenantId, tenantName, registerId: reg.id, registerName: reg.name,
        hasAuthKey: !!reg.authKey, hasTpn: !!reg.tpn, maskedTpn: maskTpn(reg.tpn),
      });
      return none('INCOMPLETE_REGISTER', {
        tenantId, tenantName, registerId: reg.id, registerName: reg.name,
        locationId: reg.locationId || null,
      });
    };

    // R0 — an exact register was named.
    if (wantRegisterId) {
      const pinned = enabledRegisters.find((r) => r.id === wantRegisterId);
      if (!pinned) {
        logger.error('[tenant-terminal-config] no enabled register with that id — refusing to substitute another', {
          tenantId, tenantName, registerId: wantRegisterId,
        });
        return none('NO_REGISTER_FOR_ID', { tenantId, tenantName });
      }
      return guardComplete(pinned, 'REGISTER_PINNED');
    }

    // R1 / R2 — resolve by the counter the customer is standing at.
    if (wantLocationId) {
      const matches = enabledRegisters.filter((r) => r.locationId === wantLocationId);
      if (matches.length === 0) {
        // THE case this feature exists for. There IS a register list, so this
        // tenant runs per-counter terminals — and this counter is not on it.
        // Anything other than a refusal here charges at counter A on counter
        // B's device.
        logger.error('[tenant-terminal-config] this tenant runs per-location registers and has NONE for this location — refusing to charge on another counter\'s terminal', {
          tenantId, tenantName, locationId: wantLocationId,
          enabledRegisterCount: enabledRegisters.length,
        });
        return none('NO_REGISTER_FOR_LOCATION', { tenantId, tenantName });
      }
      if (matches.length > 1) {
        // Two counters at one branch — the mockup's LAX Counter 1 / Counter 2.
        // Same location means same merchant, so this is a wrong-DEVICE risk,
        // not a wrong-merchant one: we take the first and say so, loudly, so
        // the fix (pass registerId) is visible instead of silent.
        logger.warn('[tenant-terminal-config] more than one enabled register at this location — using the first; pass registerId to pick a counter', {
          tenantId, tenantName, locationId: wantLocationId,
          candidates: matches.map((r) => ({ registerId: r.id, name: r.name, maskedTpn: maskTpn(r.tpn) })),
        });
      }
      return guardComplete(matches[0], 'REGISTER_MATCH');
    }

    // R3 — no location, but there is only one possible answer.
    if (enabledRegisters.length === 1) {
      return guardComplete(enabledRegisters[0], 'SOLE_REGISTER');
    }

    // R4 — no location, several registers. Guessing a counter is guessing a
    // terminal; on a money path that is not a convenience we may take.
    logger.error('[tenant-terminal-config] several enabled registers and no location to choose between them — refusing to guess a counter', {
      tenantId, tenantName, enabledRegisterCount: enabledRegisters.length,
    });
    return none('AMBIGUOUS_REGISTER_NO_LOCATION', { tenantId, tenantName });
  }

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
      // The legacy block is not a register and has no location of its own —
      // it is the tenant's single terminal, wherever the counter is.
      registerId: null,
      registerName: '',
      locationId: null,
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
    registerId: null,
    registerName: '',
    locationId: null,
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
  const registers = Array.isArray(cfg?.registers) ? cfg.registers : [];
  const submitted = Array.isArray(body?.registers) ? body.registers : [];
  const submittedById = new Map(
    submitted.filter((r) => r && r.id).map((r) => [String(r.id), r]),
  );
  return {
    tenantId: tenantId || null,
    gateway: cfg?.gateway || null,
    spinEnabled: !!cfg?.spin?.enabled,
    spinTpnMasked: maskTpn(cfg?.spin?.tpn),
    spinAuthKeyOnFile: !!cfg?.spin?.hasAuthKey,
    // "did this request supply a new key", NOT the key.
    spinAuthKeyReplaced: !!String(body?.spin?.authKey || '').trim(),
    spinAuthKeyCleared: !!body?.spin?.clearAuthKey,
    // Registers, on exactly the same contract: names, ids, locations, a MASKED
    // TPN and booleans. A register auth key is the same live credential as
    // spin.authKey and must never reach the audit trail either.
    registerCount: registers.length,
    registers: registers.map((r) => ({
      id: String(r?.id || ''),
      name: String(r?.name || ''),
      locationId: String(r?.locationId || '') || null,
      enabled: r?.enabled !== false,
      tpnMasked: maskTpn(r?.tpn),
      authKeyOnFile: !!r?.hasAuthKey,
      authKeyReplaced: !!String(submittedById.get(String(r?.id || ''))?.authKey || '').trim(),
      authKeyCleared: !!submittedById.get(String(r?.id || ''))?.clearAuthKey,
    })),
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
