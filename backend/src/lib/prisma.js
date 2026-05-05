import { PrismaClient } from '@prisma/client';
import logger from './logger.js';

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
        ? appendPoolParams(process.env.DATABASE_URL)
        : undefined
    }
  }
});

if (SLOW_QUERY_MS > 0) {
  prisma.$on('query', (event) => {
    if (typeof event?.duration === 'number' && event.duration > SLOW_QUERY_MS) {
      logger.warn(`prisma slow query ${event.duration}ms`, {
        durationMs: event.duration,
        query: typeof event?.query === 'string' ? event.query.slice(0, 500) : undefined,
        params: typeof event?.params === 'string' ? event.params.slice(0, 500) : undefined,
        target: event?.target
      });
    }
  });
}

function appendPoolParams(url) {
  const separator = url.includes('?') ? '&' : '?';
  // Default raised from 20 -> 30 to absorb concurrent staff hits on the
  // reservation list / detail pages without saturating the pool. Override
  // with DATABASE_POOL_SIZE in env if Supabase pgbouncer caps lower.
  const poolSize = process.env.DATABASE_POOL_SIZE || '30';
  const timeout = process.env.DATABASE_POOL_TIMEOUT || '10';
  // If the URL already has its own connection_limit (e.g. Supabase pooler URLs
  // bake one in), respect it but make the effective value visible at startup
  // so the pool size never becomes a mystery in prod (cf. Sentry pool-timeout
  // incident on /api/public/booking/bootstrap, 2026-05-05). DATABASE_POOL_SIZE
  // is intentionally NOT overridden in this branch — changing the URL's value
  // out from under the deploy platform would mask configuration drift.
  if (url.includes('connection_limit=')) {
    const limitMatch = url.match(/[?&]connection_limit=(\d+)/);
    const timeoutMatch = url.match(/[?&]pool_timeout=(\d+)/);
    const baked = limitMatch ? limitMatch[1] : '?';
    const bakedTimeout = timeoutMatch ? timeoutMatch[1] : 'default';
    console.log(
      `[prisma] DATABASE_URL has connection_limit=${baked} pool_timeout=${bakedTimeout} ` +
      `(DATABASE_POOL_SIZE env ignored — strip ?connection_limit= from URL to use env)`
    );
    return url;
  }
  console.log(`[prisma] appending connection_limit=${poolSize}&pool_timeout=${timeout} to DATABASE_URL`);
  return `${url}${separator}connection_limit=${poolSize}&pool_timeout=${timeout}`;
}
