/**
 * Counter checkin BullMQ worker — Interactive T&C + Dejavoo P1 (2026-05-21).
 *
 * Queue: `counter.checkin`
 *
 * Wraps `runCounterCheckinFlow` so the HTTP route can return immediately
 * after enqueuing. The full terminal flow takes 30-90s (Disclaimer +
 * GetSignature per field + AUTH). Running it sync in the request handler
 * would tie up Express workers + hit browser timeouts.
 *
 * Job payload:
 *   { reservationId, terminalId, userSnapshot: { sub, role, tenantId } }
 *
 * Async pattern:
 *   1. Route enqueues with HIGH priority + returns { jobId, signingId }
 *   2. Worker picks up immediately, runs the orchestrator
 *   3. Each terminal step writes a ReservationSigningField + DejavooTransaction
 *   4. Frontend polls `GET /api/reservations/:id/signing` for progress
 *   5. When signing.completedAt is set, the flow is done
 *
 * Priority: HIGH (1) — customer is physically standing at the counter.
 * Concurrency: 4 — multiple counters can run in parallel. Tunable via
 * COUNTER_CHECKIN_CONCURRENCY env var.
 *
 * Design doc: doc/interactive-tc-and-dejavoo-unified-2026-05-21.md §10 P3
 */

import { enqueueJob, registerWorker } from '../../lib/queue/index.js';
import { AUTOCHARGE_PRIORITY } from '../../lib/queue/priorities.js';
import { runCounterCheckinFlow } from './counter-orchestrator.service.js';

export const QUEUE_NAME = 'counter.checkin';

// Lazy logger
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

/**
 * Enqueue a counter checkin job. The route handler calls this after
 * creating (or finding) the ReservationSigning row.
 *
 * @param {object} args
 * @param {string} args.reservationId
 * @param {string} args.terminalId
 * @param {object} args.userSnapshot   — { sub, role, tenantId, id? }
 * @param {string} [args.ipAddress]
 * @param {string} [args.userAgent]
 * @returns {Promise<{ jobId: string|null }>}
 */
export async function enqueueCounterCheckin({
  reservationId,
  terminalId,
  userSnapshot,
  preAuthOverrideCents,
  preAuthOverrideReason,
  ipAddress,
  userAgent,
} = {}) {
  if (!reservationId || !terminalId) {
    throw new Error('enqueueCounterCheckin: reservationId + terminalId required');
  }
  if (!userSnapshot || !userSnapshot.tenantId) {
    throw new Error('enqueueCounterCheckin: userSnapshot.tenantId required');
  }
  const job = await enqueueJob(
    QUEUE_NAME,
    {
      reservationId,
      terminalId,
      userSnapshot,
      preAuthOverrideCents:
        typeof preAuthOverrideCents === 'number' ? preAuthOverrideCents : null,
      preAuthOverrideReason: preAuthOverrideReason || null,
      ipAddress: ipAddress || null,
      userAgent: userAgent || null,
    },
    {
      priority: AUTOCHARGE_PRIORITY, // HIGH — customer is physically at the counter
      attempts: 1, // Do NOT retry. Each step is already crash-safe + idempotent on resume.
      removeOnComplete: 50,
      removeOnFail: 50,
    }
  );
  return { jobId: job?.id || null };
}

/**
 * Worker handler. Exported separately so unit tests can call it without
 * BullMQ. The deps seam mirrors the orchestrator's.
 *
 * @param {{ data: { reservationId, terminalId, userSnapshot, ipAddress?, userAgent? } }} job
 * @param {object} [deps]  — DI for tests
 *   { runOrchestrator } — override the orchestrator call
 */
export async function counterCheckinHandler(job, deps = {}) {
  const data = job?.data || {};
  const { reservationId, terminalId, userSnapshot } = data;
  if (!reservationId || !terminalId) {
    throw new Error('counterCheckinHandler: missing reservationId/terminalId');
  }
  if (!userSnapshot || !userSnapshot.tenantId) {
    throw new Error('counterCheckinHandler: missing userSnapshot.tenantId');
  }
  const logger = await getLogger();
  const run = deps.runOrchestrator || runCounterCheckinFlow;

  logger.info?.('[counter-checkin] starting', { reservationId, terminalId });
  const t0 = Date.now();
  try {
    const result = await run({
      reservationId,
      terminalId,
      user: userSnapshot,
      preAuthOverrideCents:
        typeof data.preAuthOverrideCents === 'number' ? data.preAuthOverrideCents : undefined,
      preAuthOverrideReason: data.preAuthOverrideReason || undefined,
      deps: {
        ipAddress: data.ipAddress,
        userAgent: data.userAgent,
      },
    });
    logger.info?.('[counter-checkin] completed', {
      reservationId,
      terminalId,
      durationMs: Date.now() - t0,
      signingId: result.signingId,
      cardLast4: result.cardLast4,
    });
    return result;
  } catch (err) {
    logger.warn?.('[counter-checkin] failed', {
      reservationId,
      terminalId,
      durationMs: Date.now() - t0,
      code: err.code || null,
      msg: err.message,
    });
    throw err;
  }
}

/**
 * Register the worker with BullMQ. Called from backend/src/worker.js
 * during boot — the API process never registers handlers, only enqueues.
 */
export function registerCounterCheckinWorker() {
  const concurrency = Math.max(
    1,
    parseInt(process.env.COUNTER_CHECKIN_CONCURRENCY || '4', 10) || 4
  );
  registerWorker(QUEUE_NAME, counterCheckinHandler, {
    concurrency,
    priority: AUTOCHARGE_PRIORITY,
  });
}
