/**
 * BullMQ queue + worker infrastructure.
 *
 * One file, one connection. All queues share the same Redis connection
 * (Upstash) to keep the connection budget tight. Workers are registered
 * lazily — they connect when the first job is enqueued or when the worker
 * process boots, whichever comes first.
 *
 * Usage (enqueue side, runs inside the API process):
 *   import { enqueueJob } from '../lib/queue/index.js';
 *   await enqueueJob('reservation.autocharge-after-checkin', {
 *     reservationId: 'cmp...'
 *   }, { delay: 24 * 60 * 60 * 1000 });
 *
 * Usage (worker side, runs in the worker process — see backend/src/worker.js):
 *   import { registerWorker } from '../lib/queue/index.js';
 *   registerWorker('reservation.autocharge-after-checkin', async (job) => {
 *     // job.data is { reservationId }
 *     await processAutocharge(job.data);
 *   });
 *   // … startWorkers() resolves once all registrations have created BullMQ Workers.
 *
 * Failure modes:
 *   - REDIS_URL unset → enqueueJob and registerWorker both no-op with a
 *     warning. Jobs are silently dropped. This matches the dev convention
 *     of the cache module (works without Redis).
 *   - Redis unreachable → BullMQ retries the connection in the background.
 *     enqueueJob calls during the outage return a rejected promise.
 */

import logger from '../logger.js';

const REDIS_URL = process.env.REDIS_URL || '';
const QUEUE_PREFIX = process.env.QUEUE_PREFIX || 'ridefleet';

let connection = null;
let bullmqModule = null;
const queues = new Map();      // name → Queue
const workers = new Map();     // name → Worker
const handlers = new Map();    // name → handler fn (used at registerWorker time)

/**
 * Lazy-load BullMQ + ioredis. Doing the import lazily keeps the API server
 * boot fast — only the worker process incurs the dependency cost.
 */
async function getBullMQ() {
  if (bullmqModule) return bullmqModule;
  if (!REDIS_URL) {
    return null;
  }
  try {
    const [{ Queue, Worker, QueueEvents }, IORedis] = await Promise.all([
      import('bullmq'),
      import('ioredis').then((m) => m.default || m)
    ]);
    if (!connection) {
      connection = new IORedis(REDIS_URL, {
        maxRetriesPerRequest: null,
        enableReadyCheck: false,
        // Upstash TLS connections — let ioredis auto-detect via rediss://
        lazyConnect: false
      });
      connection.on('error', (err) => {
        logger.warn('[queue] redis connection error', { message: err.message });
      });
    }
    bullmqModule = { Queue, Worker, QueueEvents, connection };
    return bullmqModule;
  } catch (err) {
    logger.error('[queue] failed to load bullmq/ioredis', { message: err.message });
    return null;
  }
}

/**
 * Get or create a queue by name.
 */
async function getQueue(name) {
  if (queues.has(name)) return queues.get(name);
  const bm = await getBullMQ();
  if (!bm) return null;
  const queue = new bm.Queue(name, {
    connection: bm.connection,
    prefix: QUEUE_PREFIX,
    defaultJobOptions: {
      attempts: 3,
      backoff: { type: 'exponential', delay: 60_000 },  // 1m, 6m, 36m
      removeOnComplete: { age: 24 * 60 * 60, count: 1000 },  // keep last 1k OR 24h
      removeOnFail:     { age: 7  * 24 * 60 * 60 }           // keep 7d
    }
  });
  queues.set(name, queue);
  return queue;
}

/**
 * Enqueue a job. Returns the job ID on success, null if queueing is disabled
 * (no REDIS_URL).
 *
 * @param {string} name — queue name, e.g. 'reservation.autocharge-after-checkin'
 * @param {object} data — JSON-serializable payload
 * @param {object} opts — BullMQ options: delay (ms), priority, jobId, etc.
 */
export async function enqueueJob(name, data, opts = {}) {
  if (!REDIS_URL) {
    logger.warn('[queue] REDIS_URL unset — dropping job', { name, data });
    return null;
  }
  const queue = await getQueue(name);
  if (!queue) {
    logger.error('[queue] failed to get queue', { name });
    return null;
  }
  const jobOpts = {
    ...opts,
    // Idempotent job ID — pass `jobId` to dedupe (e.g. same reservation
    // shouldn't be enqueued twice for autocharge)
    jobId: opts.jobId || undefined
  };
  const job = await queue.add(name, data, jobOpts);
  logger.info('[queue] enqueued', { name, jobId: job.id, delay: opts.delay || 0 });
  return job.id;
}

/**
 * Cancel a previously-enqueued job by jobId. Idempotent — no error if job
 * doesn't exist (already processed or never queued).
 */
export async function cancelJob(name, jobId) {
  if (!REDIS_URL || !jobId) return false;
  const queue = await getQueue(name);
  if (!queue) return false;
  const job = await queue.getJob(jobId);
  if (!job) return false;
  await job.remove();
  logger.info('[queue] cancelled', { name, jobId });
  return true;
}

/**
 * Register a worker handler. Call this from the worker process startup
 * (backend/src/worker.js). Multiple handlers can be registered before
 * startWorkers() is called.
 *
 * Handler signature: async (job) => result | throws on failure (triggers retry)
 */
export function registerWorker(name, handler, opts = {}) {
  if (handlers.has(name)) {
    throw new Error(`Worker already registered for queue: ${name}`);
  }
  handlers.set(name, { handler, opts });
}

/**
 * Start all registered workers. Returns when all are ready (connected to
 * Redis + listening for jobs). Should be called once at worker process boot.
 */
export async function startWorkers() {
  if (!REDIS_URL) {
    logger.warn('[queue] REDIS_URL unset — no workers started');
    return [];
  }
  const bm = await getBullMQ();
  if (!bm) {
    logger.error('[queue] startWorkers failed — bullmq not available');
    return [];
  }
  const started = [];
  for (const [name, { handler, opts }] of handlers) {
    const worker = new bm.Worker(name, async (job) => {
      const start = Date.now();
      try {
        const result = await handler(job);
        logger.info('[queue] job completed', {
          name, jobId: job.id, durationMs: Date.now() - start
        });
        return result;
      } catch (err) {
        logger.error('[queue] job failed', {
          name, jobId: job.id, attempt: job.attemptsMade,
          message: err.message, stack: err.stack
        });
        throw err;
      }
    }, {
      connection: bm.connection,
      prefix: QUEUE_PREFIX,
      concurrency: opts.concurrency || 5,
      ...opts
    });
    worker.on('failed', (job, err) => {
      if (job?.attemptsMade >= (job?.opts?.attempts || 3)) {
        logger.error('[queue] job exhausted retries', {
          name, jobId: job?.id, message: err.message
        });
      }
    });
    workers.set(name, worker);
    started.push(name);
    logger.info('[queue] worker started', { name, concurrency: opts.concurrency || 5 });
  }
  return started;
}

/**
 * Shutdown gracefully — close all workers + queues + Redis connection.
 * Call from SIGTERM / SIGINT handlers.
 */
export async function shutdownQueues() {
  logger.info('[queue] shutting down');
  await Promise.all([...workers.values()].map((w) => w.close().catch(() => {})));
  await Promise.all([...queues.values()].map((q) => q.close().catch(() => {})));
  if (connection) {
    await connection.quit().catch(() => {});
  }
  workers.clear();
  queues.clear();
  bullmqModule = null;
  connection = null;
}

/**
 * Stats for /health endpoint or admin dashboards.
 */
export async function queueStats(name) {
  const queue = await getQueue(name);
  if (!queue) return null;
  const [waiting, active, completed, failed, delayed] = await Promise.all([
    queue.getWaitingCount(),
    queue.getActiveCount(),
    queue.getCompletedCount(),
    queue.getFailedCount(),
    queue.getDelayedCount()
  ]);
  return { name, waiting, active, completed, failed, delayed };
}

export const queueEnabled = () => Boolean(REDIS_URL);
