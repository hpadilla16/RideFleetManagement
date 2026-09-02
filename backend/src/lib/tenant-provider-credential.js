/**
 * tenant-provider-credential.js — the ONE resolver for "may THIS tenant use the
 * PLATFORM's credential for THIS third-party provider, and if so, say so out loud".
 *
 * ── WHY THIS EXISTS ────────────────────────────────────────────────────────
 * The same defect has now shipped twice, with two different providers:
 *
 *   2026-08-26  SPIn payment terminal. loadTenantSpinConfig() read no tenant
 *               config at all, so spin-client fell through to SPIN_TPN /
 *               SPIN_AUTH_KEY on EVERY charge for EVERY tenant. Fixed in
 *               payment-gateway/tenant-terminal-config.js, which is the shape
 *               this module generalises.
 *
 *   2026-08-27  Anthropic citation OCR. The scheduler selected every tenant
 *               with citationsEnabled and then did
 *               `cfg.apiKey || process.env.ANTHROPIC_API_KEY`. Corpusa had no
 *               key of its own, so its traffic citations — driver name, licence
 *               details, vehicle, location — went to api.anthropic.com under the
 *               PLATFORM account. 14 documents were processed before anyone
 *               noticed, and nobody noticed because nothing was logged. It
 *               surfaced during a UK GDPR due-diligence exercise that was about
 *               to state, in writing, that Anthropic could not access that data.
 *
 * Both bugs are the same line of code wearing a different provider's hat:
 *
 *     const key = tenantKey || process.env.SOME_PLATFORM_KEY;
 *
 * `||` is not a policy. It is the ABSENCE of a policy — it silently converts
 * "this tenant configured nothing" into "use the house key", which is the one
 * interpretation nobody would ever choose deliberately. This module makes that
 * decision explicit, per tenant, per feature, and loud.
 *
 * ── THE RULE ───────────────────────────────────────────────────────────────
 * A tenant that has configured nothing makes NO external call. Full stop.
 * The platform credential is reachable ONLY when something outside this
 * resolver deliberately named that tenant for that feature.
 *
 * ── PRECEDENCE (data-safety order, not convenience order) ──────────────────
 *   1. TENANT   — the tenant's own credential is present (and complete).
 *   2. NONE     — the tenant's credential is PARTIAL, for multi-part
 *                 credentials. We do NOT top it up from the platform's env
 *                 even when the opt-in is on: somebody started configuring
 *                 this tenant and pairing their half with the platform's other
 *                 half is exactly the ambiguity that produced the SPIn
 *                 wrong-merchant bug. Fail closed, make a human finish.
 *   3. PLATFORM — the tenant has NO credential of its own, an explicit opt-in
 *                 names it (see below), and the platform env carries a value.
 *                 Logged LOUDLY, by tenant AND feature, on EVERY resolution.
 *   4. NONE     — everything else. This is the DEFAULT.
 *
 * ── WHERE THE OPT-IN LIVES, AND WHY ────────────────────────────────────────
 * Two doors, both explicit, neither of them a blanket default:
 *
 *   (a) PER-TENANT, PER-FEATURE FLAG — `allowPlatformKeyFallback: true` in the
 *       feature's own tenant config block (e.g. the citationOcrConfig
 *       AppSetting). This is the primary door and it is not invented here:
 *       planner.copilot has carried exactly this shape since it shipped
 *       (`allowGlobalApiKeyFallback` plus a `credentialSource` of
 *       TENANT/GLOBAL/NONE) and it is the only AI feature in the codebase that
 *       did NOT have this bug. Reusing its shape makes the fix the codebase's
 *       own existing answer, generalised, rather than a new concept. It lives
 *       with the feature config, so it is per-tenant AND per-feature — the
 *       finest grain available — and it is settable through the same Settings
 *       API the operator already uses for the key itself.
 *
 *   (b) PER-FEATURE ENV ALLOWLIST — `PLATFORM_KEY_ALLOW_<FEATURE>` holding a
 *       comma-separated list of tenant IDs. This exists for exactly one
 *       situation: a tenant that is live on the platform key TODAY. Door (a)
 *       needs a DB write, which means deploying this change would take that
 *       tenant offline in the window between "deployed" and "operator
 *       remembered to tick the box" — an outage dressed up as a security
 *       control. The allowlist un-breaks them at deploy time, in a reviewable
 *       line of deploy config, naming them one by one.
 *
 * What is deliberately NOT offered: a global "allow all" boolean, and a `*`
 * wildcard in the allowlist. Either one re-creates blanket silent inheritance
 * with a nicer name, which is the entire thing being removed here. The SPIn
 * resolver's SPIN_ALLOW_ENV_FALLBACK is that shape and it ships ALLOWED — it
 * predates this module and is left alone on purpose (it guards a live
 * merchant's money path), but it is not the pattern to copy forward.
 *
 * ── WHAT IS NEVER ALLOWED ──────────────────────────────────────────────────
 * A silent fallback. `source` is always reported, a PLATFORM resolution always
 * WARNs by tenant and feature, and a NONE resolution must fail the operation
 * BEFORE any provider call — see requireResolvedCredential().
 */

import logger from './logger.js';

/**
 * Registry of every feature that can reach a third-party provider on a
 * tenant's behalf. Adding a provider call without adding it here is the bug
 * coming back — the registry IS the inventory.
 *
 * - `envVar`       the platform credential this feature would otherwise inherit
 * - `label`        what appears in the WARN and in the operator-facing error
 * - `settingsPath` where an operator turns the per-tenant opt-in on
 */
export const PLATFORM_CREDENTIAL_FEATURES = {
  'citation-ocr': {
    envVar: 'ANTHROPIC_API_KEY',
    label: 'Citation mail OCR (Anthropic)',
    settingsPath: 'Settings → Citations → OCR',
  },
  'kiosk-id-ocr': {
    envVar: 'ANTHROPIC_API_KEY',
    label: 'Kiosk ID photo reading (Anthropic)',
    settingsPath: 'Settings → Citations → OCR',
  },
  'review-proof': {
    envVar: 'ANTHROPIC_API_KEY',
    label: 'Commission review-proof validation (Anthropic)',
    settingsPath: 'Settings → Citations → OCR',
  },
  // Agent Copilot AI fallback (2026-09-02, copilot Phase 2). Its OWN config
  // block (copilotAiConfig), not a citationOcrConfig rider: what leaves the
  // building here is staff questions + KB article text, a different
  // data-protection story from citation scans, so the opt-in must be its own
  // checkbox.
  'copilot-ask': {
    envVar: 'ANTHROPIC_API_KEY',
    label: 'Agent Copilot AI fallback (Anthropic)',
    settingsPath: 'Settings → Copilot AI',
  },
  sms: {
    envVar: 'TELNYX_API_KEY / TWILIO_AUTH_TOKEN / PLIVO_AUTH_TOKEN',
    label: 'Outbound SMS',
    settingsPath: 'Settings → SMS',
  },
};

/** Normalise a feature key into the env-var suffix: `citation-ocr` → `CITATION_OCR`. */
function envSuffix(feature) {
  return String(feature || '').trim().toUpperCase().replace(/[^A-Z0-9]+/g, '_');
}

/** The per-feature allowlist env var name. Exported so tests name it once. */
export function allowlistEnvVar(feature) {
  return `PLATFORM_KEY_ALLOW_${envSuffix(feature)}`;
}

/**
 * Tenant IDs the operator has explicitly named for this feature, via
 * `PLATFORM_KEY_ALLOW_<FEATURE>`. A `*` is NOT a wildcard here — it is dropped
 * like any other non-ID token, deliberately, so a hopeful `*` fails closed
 * instead of re-opening blanket inheritance.
 */
export function platformKeyAllowlist(feature) {
  const raw = String(process.env[allowlistEnvVar(feature)] || '').trim();
  if (!raw) return [];
  return raw
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter((s) => s && s !== '*');
}

/** Mask any credential for logs: first 4 + last 4, nothing partial ever leaks. */
export function maskCredential(value) {
  const raw = String(value || '').trim();
  if (!raw) return '(none)';
  if (raw.length <= 8) return '****';
  return `${raw.slice(0, 4)}****${raw.slice(-4)}`;
}

/**
 * Resolve which credential a tenant-scoped operation may use.
 *
 * Pure and synchronous on purpose: every caller has already loaded its own
 * tenant config by the time it needs this, so making it async would only add a
 * second read of the same row. The caller supplies what it read; this function
 * owns the DECISION and the logging, nothing else.
 *
 * @param {object}  args
 * @param {string}  args.tenantId
 * @param {string}  args.feature             key in PLATFORM_CREDENTIAL_FEATURES
 * @param {string}  [args.tenantCredential]  the tenant's own credential, if any
 * @param {string}  [args.platformCredential] the platform env credential, if any
 * @param {boolean} [args.tenantOptIn]       the tenant's per-feature opt-in flag
 * @param {boolean} [args.tenantConfigPartial] true when the tenant's config is
 *        half-filled (multi-part credentials only) — refuses outright
 * @param {string}  [args.tenantName]        for the WARN; cosmetic only
 * @returns {{ credential: string, source: 'TENANT'|'PLATFORM'|'NONE',
 *             reason: string, feature: string|null, tenantId: string|null,
 *             tenantName: string, masked: string }}
 */
export function resolveTenantProviderCredential({
  tenantId,
  feature,
  tenantCredential = '',
  platformCredential = '',
  tenantOptIn = false,
  tenantConfigPartial = false,
  tenantName = '',
} = {}) {
  const meta = PLATFORM_CREDENTIAL_FEATURES[feature] || {};
  const none = (reason) => ({
    credential: '',
    source: 'NONE',
    reason,
    feature: feature || null,
    tenantId: tenantId || null,
    tenantName: String(tenantName || ''),
    masked: maskCredential(''),
  });

  if (!feature) return none('NO_FEATURE');
  if (!tenantId) return none('NO_TENANT_ID');

  const own = String(tenantCredential || '').trim();
  if (own) {
    return {
      credential: own,
      source: 'TENANT',
      reason: 'TENANT_CREDENTIAL',
      feature,
      tenantId,
      tenantName: String(tenantName || ''),
      masked: maskCredential(own),
    };
  }

  // Half-configured: never top it up from the platform. See the header.
  if (tenantConfigPartial) {
    logger.error('[tenant-credential] tenant provider config is INCOMPLETE — refusing to complete it with the platform credential', {
      tenantId, tenantName: tenantName || '(unknown)', feature, provider: meta.label || feature,
    });
    return none('INCOMPLETE_TENANT_CONFIG');
  }

  const platform = String(platformCredential || '').trim();
  const allowlisted = platformKeyAllowlist(feature).includes(tenantId);
  const optedIn = !!tenantOptIn || allowlisted;

  // THE DEFAULT. A tenant nobody named makes no call.
  if (!optedIn) return none('NO_TENANT_CREDENTIAL');
  if (!platform) return none('NO_PLATFORM_CREDENTIAL');

  // LOUD, every time, by tenant AND feature. This line is the whole point:
  // both incidents were invisible precisely because it did not exist.
  logger.warn('[tenant-credential] USING THE PLATFORM CREDENTIAL FOR A TENANT — this tenant has none of its own', {
    tenantId,
    tenantName: tenantName || '(unknown)',
    feature,
    provider: meta.label || feature,
    envVar: meta.envVar || null,
    optInSource: tenantOptIn ? 'TENANT_SETTING' : 'ENV_ALLOWLIST',
    masked: maskCredential(platform),
    action: `This tenant's data is being sent to a third party under the PLATFORM account. Configure ${meta.settingsPath || 'the tenant credential'}, then remove the opt-in.`,
  });

  return {
    credential: platform,
    source: 'PLATFORM',
    reason: allowlisted && !tenantOptIn ? 'PLATFORM_ENV_ALLOWLIST' : 'PLATFORM_TENANT_OPT_IN',
    feature,
    tenantId,
    tenantName: String(tenantName || ''),
    masked: maskCredential(platform),
  };
}

/**
 * Human-readable "why is this tenant not calling out" for an operator-facing
 * error body. Never mentions the platform credential's value, only its absence.
 */
export function credentialUnavailableMessage(resolved = {}) {
  const meta = PLATFORM_CREDENTIAL_FEATURES[resolved?.feature] || {};
  const where = meta.settingsPath || 'this tenant’s integration settings';
  switch (resolved?.reason) {
    case 'INCOMPLETE_TENANT_CONFIG':
      return `${meta.label || 'This feature'} is only partly configured for this tenant — finish it in ${where}.`;
    case 'NO_PLATFORM_CREDENTIAL':
      return `${meta.label || 'This feature'} is not configured for this tenant, and the platform has no credential either.`;
    default:
      return `${meta.label || 'This feature'} is not configured for this tenant — add a key in ${where}.`;
  }
}

/**
 * Fail-closed helper: throw a typed, catchable error when nothing resolved.
 *
 * The kiosk path already models the right behaviour (503 OCR_UNAVAILABLE with a
 * code the tablet UI can branch on); this generalises it so the scheduler and
 * the commissions path stop degrading into an opaque throw deep inside a loop.
 * `status` and `code` are plain properties so KioskError-shaped handlers,
 * AppError-shaped handlers and bare try/catch all read it the same way.
 *
 * @throws {Error & { status: number, code: string, feature: string, tenantId: string }}
 */
export function requireResolvedCredential(resolved, { status = 503, code = 'PROVIDER_CREDENTIAL_UNAVAILABLE' } = {}) {
  if (resolved?.source === 'TENANT' || resolved?.source === 'PLATFORM') return resolved.credential;
  const err = new Error(credentialUnavailableMessage(resolved));
  err.name = 'ProviderCredentialUnavailableError';
  err.status = status;
  err.code = code;
  err.feature = resolved?.feature || null;
  err.tenantId = resolved?.tenantId || null;
  err.reason = resolved?.reason || 'NO_TENANT_CREDENTIAL';
  throw err;
}

export default {
  PLATFORM_CREDENTIAL_FEATURES,
  resolveTenantProviderCredential,
  requireResolvedCredential,
  credentialUnavailableMessage,
  platformKeyAllowlist,
  allowlistEnvVar,
  maskCredential,
};
