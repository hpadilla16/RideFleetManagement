/**
 * Shared HTTP/stealth/credential plumbing for booking-source integrations
 * (R0 extraction, 2026-07-13).
 *
 * economy.service.js and nu.service.js each carry a UA pool, pickUserAgent,
 * randomDelay, sleep, an AuthExpiredError class and an AES-256-GCM
 * IntegrationCredential store that differ ONLY by env key / sourceSystem /
 * label / log prefix. This module hosts the parametrized versions so a future
 * source gets them for free and the existing pair can converge on one copy.
 *
 * NOT wired into economy/nu yet — R0 ships the shared code + tests only.
 *
 * DIVERGENCE ADOPTED: the Economy pool carries a 6th UA (Safari 17.6) that the
 * NU pool lacks; the shared pool is the Economy superset. Harmless by design —
 * both portals have no anti-bot and the pool exists only to vary the UA.
 */

import { prisma } from '../../../lib/prisma.js';
import logger from '../../../lib/logger.js';
import { decrypt, encrypt } from '../../../lib/integration-crypto.js';

// ---------------------------------------------------------------------------
// Stealth / UA helpers. Rotate UA per sync run, randomize sleeps.
// ---------------------------------------------------------------------------
export const USER_AGENT_POOL = Object.freeze([
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:132.0) Gecko/20100101 Firefox/132.0',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:132.0) Gecko/20100101 Firefox/132.0',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Safari/605.1.15',
]);

/**
 * Build a source's pickUserAgent: a fixed env override wins (so ops can pin a
 * UA per source, e.g. NU_USER_AGENT), otherwise a random pool pick per call.
 */
export function makePickUserAgent(envKey, pool = USER_AGENT_POOL) {
  return function pickUserAgent() {
    if (envKey && process.env[envKey]) return process.env[envKey];
    const idx = Math.floor(Math.random() * pool.length);
    return pool[idx];
  };
}

export function randomDelay(minMs, maxMs) {
  const lo = Math.max(0, Number(minMs) || 0);
  const hi = Math.max(lo, Number(maxMs) || 0);
  if (hi <= lo) return lo;
  return Math.floor(lo + Math.random() * (hi - lo));
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Base class for a source's "session expired / invalid" signal. Subclasses
 * (NuAuthExpiredError, EconomyAuthExpiredError) keep their own name so worker
 * instanceof checks and Sentry grouping stay per-source.
 */
export class AuthExpiredError extends Error {
  constructor(message = 'Integration session expired or invalid') {
    super(message);
    this.name = this.constructor.name;
  }
}

// ---------------------------------------------------------------------------
// Credential storage (Postgres-backed, AES-256-GCM). Stores a JSON
// {username, password} blob in IntegrationCredential.encryptedPayload.
// Parametrized by sourceSystem/label; `onRotated` lets the caller nuke its
// per-source session state (cookie jar) when credentials change.
// ---------------------------------------------------------------------------
export function createCredentialStore({
  sourceSystem,
  sourceLabel,
  logPrefix,
  AuthError = AuthExpiredError,
  onRotated = null,
  prismaClient = prisma,
}) {
  if (!sourceSystem) throw new Error('createCredentialStore: sourceSystem required');
  const label = sourceLabel || sourceSystem;

  async function setCredentials(tenantId, creds, userId = null) {
    if (!tenantId) throw new Error('tenantId required');
    const username = (creds?.username ?? '').toString().trim();
    const password = (creds?.password ?? '').toString();
    if (!username) throw new Error('username required');
    if (!password) throw new Error('password required');

    const encryptedPayload = encrypt(JSON.stringify({ username, password }));
    const row = await prismaClient.integrationCredential.upsert({
      where: { tenantId_sourceSystem: { tenantId, sourceSystem } },
      create: {
        tenantId,
        sourceSystem,
        encryptedPayload,
        rotatedAt: new Date(),
        rotatedByUserId: userId,
      },
      update: {
        encryptedPayload,
        rotatedAt: new Date(),
        rotatedByUserId: userId,
        // Reset test status — caller should re-test after rotation.
        lastTestedAt: null,
        lastTestStatus: null,
      },
    });
    // Let the source drop any stale session (cookie jar) so the next request
    // re-logs-in with the new credentials.
    if (onRotated) onRotated(tenantId);
    logger.info(`${logPrefix} credentials rotated`, { tenantId, credentialId: row.id });
    return row;
  }

  // Test seam: tests can inject a credentials resolver so login/authedFetch
  // can be exercised without a live DB. Production path unchanged (null).
  let _credentialsResolver = null;

  function setCredentialsResolver(fn) {
    _credentialsResolver = typeof fn === 'function' ? fn : null;
  }

  async function getCredentials(tenantId) {
    if (_credentialsResolver) return _credentialsResolver(tenantId);
    if (!tenantId) throw new AuthError(`tenantId required to load ${label} credentials`);
    const row = await prismaClient.integrationCredential.findUnique({
      where: { tenantId_sourceSystem: { tenantId, sourceSystem } },
    });
    if (!row) throw new AuthError(`No IntegrationCredential row for tenant ${tenantId}`);
    if (!row.encryptedPayload) {
      throw new AuthError(`IntegrationCredential.encryptedPayload empty for tenant ${tenantId}`);
    }
    let parsed;
    try {
      parsed = JSON.parse(decrypt(row.encryptedPayload));
    } catch (err) {
      throw new AuthError(
        `Failed to decrypt/parse ${label} credentials for tenant ${tenantId}: ${err.message}`
      );
    }
    if (!parsed?.username || !parsed?.password) {
      throw new AuthError(`${label} credentials for tenant ${tenantId} missing username/password`);
    }
    return { username: parsed.username, password: parsed.password };
  }

  async function recordTestStatus(tenantId, status) {
    await prismaClient.integrationCredential.update({
      where: { tenantId_sourceSystem: { tenantId, sourceSystem } },
      data: { lastTestedAt: new Date(), lastTestStatus: status },
    }).catch(() => {/* swallow — caller already reporting */});
  }

  return { setCredentials, getCredentials, recordTestStatus, setCredentialsResolver };
}
