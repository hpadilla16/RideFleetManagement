import { PrismaClient } from '@prisma/client';
import logger from './logger.js';
import { appendPoolParams } from './prisma-url.js';

export { appendPoolParams };

// Slow-query threshold (ms). Set PRISMA_SLOW_QUERY_MS=0 to disable the warn.
const SLOW_QUERY_MS = parseInt(process.env.PRISMA_SLOW_QUERY_MS || '200', 10);

// We always emit `query` as an event so we can inspect duration; `error` and
// `warn` are still mirrored to stderr like before. The only behavioral change
// is that slow queries now produce a warn-level log line through Winston.
const logOptions = [
  { emit: 'event', level: 'query' },
  { emit: 'stdout', level: 'error' },
  { emit: 'stdout', level: 'warn' }
];

export const prisma = new PrismaClient({
  log: logOptions,
  datasources: {
    db: {
      url: process.env.DATABASE_URL
        ? appendPoolParams(process.env.DATABASE_URL, process.env)
        : undefined
    }
  }
});

// beta.116 PII-log hardening: Prisma slow-query lines used to dump full
// query PARAMS (customer name, phone, DOB, driver license, etc.) into the
// production logs. We keep the timing/duration + (parameterized) SQL text for
// slow-query visibility, but the bound param VALUES are only emitted outside
// production where logs are local and short-lived.
const LOG_QUERY_PARAMS = process.env.NODE_ENV !== 'production';

if (SLOW_QUERY_MS > 0) {
  prisma.$on('query', (event) => {
    if (typeof event?.duration === 'number' && event.duration > SLOW_QUERY_MS) {
      logger.warn(`prisma slow query ${event.duration}ms`, {
        durationMs: event.duration,
        query: typeof event?.query === 'string' ? event.query.slice(0, 500) : undefined,
        // PII guard: never emit bound param values in production.
        params: LOG_QUERY_PARAMS && typeof event?.params === 'string'
          ? event.params.slice(0, 500)
          : undefined,
        target: event?.target
      });
    }
  });
}

