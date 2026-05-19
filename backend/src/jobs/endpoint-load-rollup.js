// PR-5 — Daily rollup of EndpointLoadObservation -> EndpointLoadObservationDaily.
//
// Called by a cron (wired up in PR-6) once per day, typically a few minutes
// after UTC midnight. Aggregates the previous UTC day into one row per
// (tenantId, route). The raw table keeps its samples; downstream charts use
// the rollup so we don't re-scan millions of rows.
//
// Percentile method: sort ascending, pick index by `Math.floor((p/100) *
// (n-1))`. Cheap and exact-enough for samples in the thousands per day; if we
// later need true streaming quantiles we'll swap in TDigest.
import { prisma as defaultPrisma } from '../lib/prisma.js';
import defaultLogger from '../lib/logger.js';

function startOfUtcDay(d) {
  const out = new Date(d);
  out.setUTCHours(0, 0, 0, 0);
  return out;
}

function yesterdayUtcRange(now = new Date()) {
  const todayStart = startOfUtcDay(now);
  const yStart = new Date(todayStart.getTime() - 24 * 60 * 60 * 1000);
  return { start: yStart, end: todayStart };
}

function percentile(sortedAsc, p) {
  if (!sortedAsc.length) return 0;
  const idx = Math.min(sortedAsc.length - 1, Math.max(0, Math.floor((p / 100) * (sortedAsc.length - 1))));
  return sortedAsc[idx];
}

/**
 * Aggregate raw EndpointLoadObservation samples for a day into
 * EndpointLoadObservationDaily rows. Exported so tests + the eventual cron
 * wrapper (PR-6) can both call it.
 */
export async function rollupYesterday({ day, prisma = defaultPrisma, logger = defaultLogger } = {}) {
  const range = day
    ? { start: startOfUtcDay(day), end: new Date(startOfUtcDay(day).getTime() + 24 * 60 * 60 * 1000) }
    : yesterdayUtcRange();

  const samples = await prisma.endpointLoadObservation.findMany({
    where: { observedAt: { gte: range.start, lt: range.end } },
    select: {
      tenantId: true,
      route: true,
      durationMs: true,
      statusCode: true,
      cacheHit: true,
    },
  });

  if (samples.length === 0) {
    logger.info?.('endpoint-load-rollup: no samples for day', { day: range.start.toISOString() });
    return { day: range.start, groups: 0, rowsAggregated: 0 };
  }

  const groups = new Map();
  for (const s of samples) {
    const key = `${s.tenantId ?? ''} ${s.route}`;
    let g = groups.get(key);
    if (!g) {
      g = {
        tenantId: s.tenantId ?? null,
        route: s.route,
        durations: [],
        errorCount: 0,
        cacheHits: 0,
        cacheTotal: 0,
      };
      groups.set(key, g);
    }
    g.durations.push(s.durationMs);
    if (s.statusCode >= 500) g.errorCount += 1;
    if (s.cacheHit !== null && s.cacheHit !== undefined) {
      g.cacheTotal += 1;
      if (s.cacheHit) g.cacheHits += 1;
    }
  }

  let written = 0;
  for (const g of groups.values()) {
    g.durations.sort((a, b) => a - b);
    const requestCount = g.durations.length;
    const p50 = percentile(g.durations, 50);
    const p95 = percentile(g.durations, 95);
    const p99 = percentile(g.durations, 99);
    const cacheHitRate = g.cacheTotal > 0 ? g.cacheHits / g.cacheTotal : null;

    await prisma.endpointLoadObservationDaily.upsert({
      where: {
        tenantId_route_day: {
          tenantId: g.tenantId,
          route: g.route,
          day: range.start,
        },
      },
      create: {
        tenantId: g.tenantId,
        route: g.route,
        day: range.start,
        requestCount,
        p50DurationMs: p50,
        p95DurationMs: p95,
        p99DurationMs: p99,
        errorCount: g.errorCount,
        cacheHitRate,
      },
      update: {
        requestCount,
        p50DurationMs: p50,
        p95DurationMs: p95,
        p99DurationMs: p99,
        errorCount: g.errorCount,
        cacheHitRate,
      },
    });
    written += 1;
  }

  logger.info?.('endpoint-load-rollup: complete', {
    day: range.start.toISOString(),
    groups: groups.size,
    rowsAggregated: samples.length,
    rowsWritten: written,
  });

  return { day: range.start, groups: groups.size, rowsAggregated: samples.length };
}

export const __test = { startOfUtcDay, yesterdayUtcRange, percentile };

export default rollupYesterday;
