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

// =============================================================================
// Worker registrations
// =============================================================================

// Pillar 2 — auto-charge after CHECKED_IN_UNPAID.
// Handler lives in the reservations module to keep domain logic together.
import('./modules/reservations/autocharge.worker.js').then(({ autochargeHandler }) => {
  registerWorker('reservation.autocharge-after-checkin', autochargeHandler, {
    concurrency: 3
  });
}).catch((err) => {
  logger.warn('[worker] autocharge handler not yet implemented', { message: err.message });
});

// =============================================================================
// Bootstrap
// =============================================================================

async function main() {
  if (!queueEnabled()) {
    logger.error('[worker] REDIS_URL not set — worker process cannot start');
    process.exit(1);
  }

  const started = await startWorkers();
  logger.info('[worker] started', { count: started.length, names: started });

  // Graceful shutdown
  const shutdown = async (signal) => {
    logger.info('[worker] shutting down', { signal });
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
