/**
 * Counter RETURN BullMQ worker — Interactive T&C + Dejavoo P1 (2026-05-21).
 *
 * Queue: `counter.return`. Same async pattern as counter.checkin —
 * HTTP route enqueues + returns immediately, frontend polls.
 *
 * Priority HIGH (1) — customer is physically returning the vehicle.
 * Concurrency 4 — multiple counters can run in parallel.
 *
 * Design doc: doc/interactive-tc-and-dejavoo-unified-2026-05-21.md §10 P4
 */

import { enqueueJob, registerWorker } from '../../lib/queue/index.js';
import { AUTOCHARGE_PRIORITY } from '../../lib/queue/priorities.js';
import { runCounterReturnFlow } from './counter-return-orchestrator.service.js';

export const QUEUE_NAME = 'counter.return';

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
 * Enqueue a counter return job.
 *
 * @param {object} args
 * @param {string} args.reservationId
 * @param {string} args.terminalId
 * @param {object} args.userSnapshot
 * @param {number} [args.finalAmountCents]   — total bill (rental + extras)
 * @param {number} [args.extrasAmountCents]  — explicit extras override (round 22)
 * @param {string} [args.ipAddress]
 * @param {string} [args.userAgent]
 */
export async function enqueueCounterReturn({
  reservationId, terminalId, userSnapshot,
  finalAmountCents, extrasAmountCents,
  ipAddress, userAgent,
} = {}) {
  if (!reservationId || !terminalId) {
    throw new Error('enqueueCounterReturn: reservationId + terminalId required');
  }
  if (!userSnapshot?.tenantId) {
    throw new Error('enqueueCounterReturn: userSnapshot.tenantId required');
  }
  const job = await enqueueJob(
    QUEUE_NAME,
    {
      reservationId,
      terminalId,
      userSnapshot,
      finalAmountCents: typeof finalAmountCents === 'number' ? finalAmountCents : null,
      extrasAmountCents: typeof extrasAmountCents === 'number' ? extrasAmountCents : null,
      ipAddress: ipAddress || null,
      userAgent: userAgent || null,
    },
    {
      priority: AUTOCHARGE_PRIORITY,
      attempts: 1,
      removeOnComplete: 50,
      removeOnFail: 50,
    }
  );
  return { jobId: job?.id || null };
}

/**
 * Worker handler.
 */
export async function counterReturnHandler(job, deps = {}) {
  const { reservationId, terminalId, userSnapshot, finalAmountCents, extrasAmountCents } = job?.data || {};
  if (!reservationId || !terminalId) {
    throw new Error('counterReturnHandler: missing reservationId/terminalId');
  }
  if (!userSnapshot?.tenantId) {
    throw new Error('counterReturnHandler: missing userSnapshot.tenantId');
  }
  const logger = await getLogger();
  const run = deps.runOrchestrator || runCounterReturnFlow;
  const t0 = Date.now();
  logger.info?.('[counter-return] starting', { reservationId, terminalId });
  try {
    const result = await run({
      reservationId,
      terminalId,
      user: userSnapshot,
      finalAmountCents: finalAmountCents ?? undefined,
      extrasAmountCents: extrasAmountCents ?? undefined,
    });
    logger.info?.('[counter-return] completed', {
      reservationId, terminalId, durationMs: Date.now() - t0,
      case: result.case,
      extrasCents: result.extrasCents,
      capturedCents: result.capturedAmountCents,
      additionalCents: result.additionalSaleCents,
      saleMode: result.additionalSaleMode || null,
    });
    return result;
  } catch (err) {
    logger.warn?.('[counter-return] failed', {
      reservationId, terminalId, durationMs: Date.now() - t0,
      code: err.code || null, msg: err.message,
    });
    throw err;
  }
}

export function registerCounterReturnWorker() {
  const concurrency = Math.max(
    1,
    parseInt(process.env.COUNTER_RETURN_CONCURRENCY || '4', 10) || 4
  );
  registerWorker(QUEUE_NAME, counterReturnHandler, {
    concurrency,
    priority: AUTOCHARGE_PRIORITY,
  });
}
