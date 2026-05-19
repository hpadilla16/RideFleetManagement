/**
 * Worker process entry point.
 *
 * Runs in a separate container from the API server. Same image, different
 * command — `node src/worker.js` instead of `node src/main.js`. Workers
 * register job handlers with the queue module and process jobs until
 * SIGTERM.
 *
 * Add new workers by importing them here and calling registerWorker(name, fn).
 * Keep this file thin — registration only, no job logic.
 */

import logger from './lib/logger.js';
import { registerWorker, startWorkers, shutdownQueues, queueEnabled } from './lib/queue/index.js';
import { startAutochargePoll, stopAutochargePoll } from './modules/reservations/autocharge.poll.js';

// =============================================================================
// Bootstrap
// =============================================================================

async function registerAllHandlers() {
  // Pillar 2 — auto-charge after CHECKED_IN_UNPAID.
  // Dynamic import so a broken handler file doesn't crash the whole worker
  // boot. If the handler fails to load, log and continue — other handlers
  // can still run.
  try {
    const mod = await import('./modules/reservations/autocharge.worker.js');
    if (typeof mod.autochargeHandler !== 'function') {
      throw new Error('autocharge.worker.js does not export autochargeHandler');
    }
    registerWorker('reservation.autocharge-after-checkin', mod.autochargeHandler, {
      concurrency: 3
    });
    logger.info('[worker] registered handler: reservation.autocharge-after-checkin');
  } catch (err) {
    logger.warn('[worker] autocharge handler not registered', {
      message: err.message, stack: err.stack
    });
  }

  // TL International franchise sync (round 5)
  // Feature-flagged — registers only if TL_INTEGRATION_ENABLED=true.
  // Workers are cheap so we register unconditionally and let the
  // orchestrator decide whether to enqueue jobs; but keep the guard
  // here so failed imports of TL crypto don't break the whole worker.
  if (String(process.env.TL_INTEGRATION_ENABLED || 'false').toLowerCase() === 'true') {
    try {
      const tlMod = await import('./modules/integrations/tl-international/tl-international.worker.js');
      tlMod.registerTlSyncWorker();
      logger.info('[worker] registered handler: tl-international.sync');
    } catch (err) {
      logger.warn('[worker] tl-international sync worker not registered', {
        message: err.message, stack: err.stack
      });
    }
  }

  // Future handlers go here. Each in its own try/catch so a broken one
  // doesn't poison the others.
}

async function main() {
  if (!queueEnabled()) {
    logger.error('[worker] REDIS_URL not set — worker process cannot start');
    process.exit(1);
  }

  // Register handlers BEFORE startWorkers — otherwise handlers map is empty
  // when startWorkers reads it and no Worker instances are created.
  await registerAllHandlers();

  const started = await startWorkers();
  logger.info('[worker] started', { count: started.length, names: started });

  // Pillar 2 — DB safety-net poll for autocharge.
  // Catches jobs evicted from Upstash Redis (Fixed plan uses allkeys-lru).
  // Runs every 5min by default, checks DB directly, calls the same handler.
  startAutochargePoll();

  // Graceful shutdown
  const shutdown = async (signal) => {
    logger.info('[worker] shutting down', { signal });
    stopAutochargePoll();
    await shutdownQueues();
    process.exit(0);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT',  () => shutdown('SIGINT'));

  // Keep the process alive — BullMQ workers run on their own connection
  // but the Node event loop doesn't have anything else queued. A long
  // setInterval is the conventional way to keep the process alive cheaply.
  setInterval(() => {}, 1 << 30);
}

main().catch((err) => {
  logger.error('[worker] fatal startup error', { message: err.message, stack: err.stack });
  process.exit(1);
});
