/**
 * Pillar 2 — Autocharge DB safety-net poll.
 *
 * Runs inside the worker process. Every POLL_INTERVAL_MS (default 5min),
 * queries Postgres directly for reservations that are eligible for
 * auto-charge but haven't been processed yet:
 *
 *   - status = 'CHECKED_IN_UNPAID'
 *   - autochargeAt <= NOW()
 *   - autochargeBlocked = false
 *   - autochargeAttempts < MAX_ATTEMPTS
 *
 * Calls the same autochargeHandler the BullMQ worker uses. This catches:
 *
 *   1. Jobs evicted from Upstash Redis (Fixed plan uses allkeys-lru
 *      eviction). With the poll, an evicted job is recovered within
 *      ~5 minutes.
 *   2. Cases where Redis was unreachable when we tried to enqueue from
 *      checkin-close.service.js (enqueueJob returned null but the
 *      reservation still has autochargeAt set).
 *   3. Replays after a worker process crash that left jobs un-acked.
 *
 * Concurrency: the worker is a single process. Within itself, the for-loop
 * runs handlers serially. If a BullMQ job and the poll grab the same
 * reservation simultaneously, the second one will see status changed
 * (CHECKED_IN by then) when it reloads inside autochargeHandler — and skip.
 * So the race is benign.
 *
 * Cost: 1 SELECT every 5min returning ≤ POLL_BATCH_SIZE rows. Cheap.
 */

import { prisma } from '../../lib/prisma.js';
import logger from '../../lib/logger.js';
import { autochargeHandler } from './autocharge.worker.js';

const POLL_INTERVAL_MS = Number(process.env.AUTOCHARGE_POLL_INTERVAL_MS || 5 * 60 * 1000);
const POLL_BATCH_SIZE = Number(process.env.AUTOCHARGE_POLL_BATCH_SIZE || 10);
const POLL_INITIAL_DELAY_MS = Number(process.env.AUTOCHARGE_POLL_INITIAL_DELAY_MS || 60 * 1000);
const MAX_ATTEMPTS = Number(process.env.AUTOCHARGE_MAX_ATTEMPTS || 3);

let timerHandle = null;
let running = false;

async function runOnce() {
  if (running) {
    logger.warn('[autocharge-poll] previous run still in flight — skipping');
    return;
  }
  running = true;
  const startedAt = Date.now();

  try {
    const candidates = await prisma.reservation.findMany({
      where: {
        status: 'CHECKED_IN_UNPAID',
        autochargeBlocked: false,
        autochargeAt: { lte: new Date() },
        autochargeAttempts: { lt: MAX_ATTEMPTS }
      },
      take: POLL_BATCH_SIZE,
      select: { id: true, reservationNumber: true, autochargeAt: true, autochargeAttempts: true }
    });

    if (candidates.length === 0) {
      logger.debug?.('[autocharge-poll] no candidates');
      return;
    }

    logger.info('[autocharge-poll] processing', {
      count: candidates.length,
      ids: candidates.map((c) => c.reservationNumber || c.id)
    });

    for (const candidate of candidates) {
      const fakeJob = {
        id: `poll-${candidate.id}-${Date.now()}`,
        data: { reservationId: candidate.id },
        attemptsMade: candidate.autochargeAttempts || 0,
        opts: { attempts: MAX_ATTEMPTS }
      };
      try {
        await autochargeHandler(fakeJob);
      } catch (err) {
        // autochargeHandler logs + persists its own errors. We just
        // continue to the next candidate — don't let one failure halt
        // the batch.
        logger.warn('[autocharge-poll] candidate failed', {
          reservationId: candidate.id,
          reservationNumber: candidate.reservationNumber,
          message: err.message
        });
      }
    }

    logger.info('[autocharge-poll] batch complete', {
      count: candidates.length,
      durationMs: Date.now() - startedAt
    });
  } catch (err) {
    logger.error('[autocharge-poll] poll error', { message: err.message, stack: err.stack });
  } finally {
    running = false;
  }
}

export function startAutochargePoll() {
  if (timerHandle) {
    logger.warn('[autocharge-poll] already started — skipping duplicate start');
    return;
  }

  logger.info('[autocharge-poll] scheduling', {
    intervalMs: POLL_INTERVAL_MS,
    batchSize: POLL_BATCH_SIZE,
    initialDelayMs: POLL_INITIAL_DELAY_MS,
    maxAttempts: MAX_ATTEMPTS
  });

  // Delay first run so BullMQ has a chance to pick up its own delayed jobs
  // first. After the initial delay, run every POLL_INTERVAL_MS.
  setTimeout(() => {
    runOnce();
    timerHandle = setInterval(runOnce, POLL_INTERVAL_MS);
  }, POLL_INITIAL_DELAY_MS);
}

export function stopAutochargePoll() {
  if (timerHandle) {
    clearInterval(timerHandle);
    timerHandle = null;
    logger.info('[autocharge-poll] stopped');
  }
}
