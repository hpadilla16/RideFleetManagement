/**
 * Pre-auth release scheduler (2026-05-21).
 *
 * Card-issuer pre-authorization holds typically auto-expire 5-30 days
 * depending on the issuer. If a customer never returns the vehicle, the
 * hold falls off the customer's card but our DejavooTransaction.AUTH row
 * stays orphaned (no CAPTURE / VOID child). That's an audit + reporting
 * mess.
 *
 * This sweep runs daily and explicitly voids any approved AUTH older than
 * `RELEASE_AFTER_DAYS` (default 25) that has no settled child. The void
 * call is idempotent on the Dejavoo side — re-voiding an already-expired
 * hold returns success without effect.
 *
 * Pattern mirrors backend/src/modules/tolls/tolls.scheduler.js — interval
 * timer with overlap guard + startup delay.
 *
 * Design doc: doc/interactive-tc-and-dejavoo-unified-2026-05-21.md §12
 */

import { spinClient } from './spin-client.js';

const DEFAULT_RELEASE_AFTER_DAYS = 25;
const DEFAULT_INTERVAL_HOURS = 24;
const DEFAULT_STARTUP_DELAY_SECONDS = 120;

let timer = null;
let startupTimer = null;
let sweepInProgress = false;

let _defaultPrisma = null;
async function resolveDefaultPrisma() {
  if (_defaultPrisma) return _defaultPrisma;
  const mod = await import('../../lib/prisma.js');
  _defaultPrisma = mod.prisma;
  return _defaultPrisma;
}

let _logger = null;
async function getLogger() {
  if (_logger) return _logger;
  try {
    const mod = await import('../../lib/logger.js');
    _logger = mod.default || mod;
  } catch {
    _logger = { info: () => {}, warn: () => {}, error: () => {} };
  }
  return _logger;
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

function autoEnabled() {
  return String(process.env.PREAUTH_RELEASE_ENABLED || 'true').toLowerCase() !== 'false';
}

function releaseAfterDays() {
  const n = Number(process.env.PREAUTH_RELEASE_AFTER_DAYS || DEFAULT_RELEASE_AFTER_DAYS);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_RELEASE_AFTER_DAYS;
}

function intervalMs() {
  const hours = Number(process.env.PREAUTH_RELEASE_INTERVAL_HOURS || DEFAULT_INTERVAL_HOURS);
  return (Number.isFinite(hours) && hours > 0 ? hours : DEFAULT_INTERVAL_HOURS) * 60 * 60 * 1000;
}

function startupDelayMs() {
  const s = Number(process.env.PREAUTH_RELEASE_STARTUP_SECONDS || DEFAULT_STARTUP_DELAY_SECONDS);
  return (Number.isFinite(s) && s >= 0 ? s : DEFAULT_STARTUP_DELAY_SECONDS) * 1000;
}

// ---------------------------------------------------------------------------
// Core: list stale AUTHs and void them
// ---------------------------------------------------------------------------

/**
 * Find DejavooTransaction rows of type=AUTH that:
 *   - are approved=true
 *   - have NO child of type CAPTURE / VOID / SALE
 *   - are older than `cutoff`
 *
 * Returns the rows ready for voiding.
 */
export async function findStaleAuths(prisma, cutoff) {
  // Raw query for the NOT EXISTS subquery — Prisma's relation filter is
  // expressive enough for `none` semantics, but raw is clearer:
  return prisma.$queryRaw`
    SELECT t.*
    FROM "DejavooTransaction" t
    WHERE t.type = 'AUTH'
      AND t.approved = true
      AND t."startedAt" < ${cutoff}
      AND NOT EXISTS (
        SELECT 1 FROM "DejavooTransaction" c
        WHERE c."parentTransactionId" = t.id
          AND c.type IN ('CAPTURE', 'VOID', 'SALE')
      )
    ORDER BY t."startedAt" ASC
    LIMIT 200
  `;
}

/**
 * Resolve the SPIn config for a given terminal (decrypted authKey).
 * Shared with the orchestrator — duplicated here to avoid coupling
 * across modules.
 */
async function resolveTenantConfigForTerminal(prisma, terminalId) {
  const terminal = await prisma.dejavooTerminal.findUnique({ where: { id: terminalId } });
  if (!terminal) return null;
  let authKey = terminal.authKeyEnc || '';
  if (authKey.startsWith('enc:v1:')) {
    const { decrypt } = await import('../../lib/integration-crypto.js');
    authKey = decrypt(authKey.slice('enc:v1:'.length));
  }
  if (!authKey) return null;
  return {
    spinAuthKey: authKey,
    spinTpn: terminal.tpn,
    spinMerchantNumber: terminal.merchantNumber || 1,
    spinSandbox: terminal.sandbox !== false,
  };
}

/**
 * Run one sweep. Returns a summary of what happened.
 *
 * @param {object} [deps]  — DI for tests
 *   { prisma, spin, now }
 */
export async function runPreAuthReleaseSweep(deps = {}) {
  const prisma = deps.prisma || (await resolveDefaultPrisma());
  const spin = deps.spin || spinClient;
  const now = deps.now ? deps.now() : new Date();
  const logger = await getLogger();
  const days = releaseAfterDays();
  const cutoff = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);

  logger.info?.('[pre-auth-release] sweep starting', { cutoffISO: cutoff.toISOString(), days });

  const stale = await findStaleAuths(prisma, cutoff);
  logger.info?.('[pre-auth-release] candidates', { count: stale.length });

  const counts = { processed: 0, voided: 0, failed: 0, skippedNoTerminal: 0 };

  for (const tx of stale) {
    counts.processed += 1;
    try {
      const tenantConfig = deps.resolveTenantConfig
        ? await deps.resolveTenantConfig(prisma, tx.terminalId)
        : await resolveTenantConfigForTerminal(prisma, tx.terminalId);
      if (!tenantConfig) {
        counts.skippedNoTerminal += 1;
        logger.warn?.('[pre-auth-release] skipping — no terminal config', { txId: tx.id });
        continue;
      }
      const voidRef = `VOID-AUTOEXP-${tx.id.slice(-8)}`;
      // Record the void as a child transaction
      const child = await prisma.dejavooTransaction.create({
        data: {
          tenantId: tx.tenantId,
          terminalId: tx.terminalId,
          reservationId: tx.reservationId,
          type: 'VOID',
          referenceId: voidRef,
          customLabel: `Auto-release of unclaimed pre-auth (>${days}d)`,
          parentTransactionId: tx.id,
          approved: false,
          requestJson: { authReferenceId: tx.referenceId, autoRelease: true, days },
          statusCode: 'PENDING',
        },
      });
      try {
        const raw = await spin.void({ referenceId: tx.referenceId }, tenantConfig);
        const normalized = spin.normalizeResponse(raw);
        await prisma.dejavooTransaction.update({
          where: { id: child.id },
          data: {
            responseJson: normalized,
            rawResponse: raw,
            statusCode: normalized.statusCode || null,
            approved: !!normalized.approved,
            errorMessage: normalized.approved ? null : (normalized.message || null),
            completedAt: new Date(),
          },
        });
        if (normalized.approved) counts.voided += 1;
        else counts.failed += 1;
      } catch (err) {
        await prisma.dejavooTransaction.update({
          where: { id: child.id },
          data: {
            statusCode: err?.spinStatusCode || 'ERROR',
            errorMessage: err?.message || 'unknown error',
            completedAt: new Date(),
          },
        });
        counts.failed += 1;
      }
    } catch (err) {
      counts.failed += 1;
      logger.warn?.('[pre-auth-release] tx failed', { txId: tx.id, msg: err.message });
    }
  }

  logger.info?.('[pre-auth-release] sweep done', counts);
  return counts;
}

// ---------------------------------------------------------------------------
// Scheduler control
// ---------------------------------------------------------------------------

async function tick() {
  if (sweepInProgress) return;
  sweepInProgress = true;
  try {
    await runPreAuthReleaseSweep();
  } catch (err) {
    const logger = await getLogger();
    logger.warn?.('[pre-auth-release] tick error', { msg: err.message });
  } finally {
    sweepInProgress = false;
  }
}

export function startPreAuthReleaseScheduler() {
  if (!autoEnabled()) {
    return; // disabled
  }
  if (startupTimer || timer) return; // already started
  startupTimer = setTimeout(() => {
    startupTimer = null;
    tick();
    timer = setInterval(tick, intervalMs());
  }, startupDelayMs());
}

export function stopPreAuthReleaseScheduler() {
  if (startupTimer) {
    clearTimeout(startupTimer);
    startupTimer = null;
  }
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

// Exported for tests
export const _internal = {
  releaseAfterDays,
  intervalMs,
  resolveTenantConfigForTerminal,
};
