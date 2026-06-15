/**
 * commission-resync.poll — periodic self-heal for AgreementCommission snapshots.
 *
 * 2026-06-15: prod audit found every CHECKED_OUT/CHECKED_IN agreement's
 * commission snapshot frozen at $0 — the snapshots were written before the
 * SERVICE_CATALOG commission logic existed and nothing ever recomputed them.
 * The one-time backfill (src/scripts/backfill-commission-snapshots.js) fixed
 * the historical rows; THIS sweep is the belt-and-suspenders so it can never
 * silently drift again, for ANY tenant or employee:
 *
 *   - Every SWEEP_INTERVAL_MS it re-runs syncAgreementCommissionSnapshot for
 *     every agreement with a CHECKOUT inspection (FINALIZED/CHECKED_OUT/
 *     CHECKED_IN/CHECKED_IN_UNPAID/CLOSED), across all tenants, in batches.
 *   - The sync is idempotent and PRESERVES workflow status (PAID/APPROVED) —
 *     it only refreshes the calculated dollar amounts. So re-running is safe.
 *   - If any agreement's commission total CHANGES, it logs a WARN (surfaced by
 *     the droplet log monitor) — a change means some checkout path didn't
 *     snapshot, or a commission config changed without a recompute. That's the
 *     signal to hunt the cause, exactly like the vehicle-status drift sweep.
 *
 * Same pattern as vehicle-status-sweep.poll.js: plain setInterval in the worker
 * process, no queue dependency, safe to run alongside the API. Default cadence
 * is daily (off-hours load); override with COMMISSION_RESYNC_SWEEP_MS.
 */

import { prisma } from '../../lib/prisma.js';
import logger from '../../lib/logger.js';
import { syncAgreementCommissionSnapshot } from '../rental-agreements/rental-agreements.service.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const SWEEP_INTERVAL_MS = Math.max(
  60 * 60 * 1000, // never faster than hourly
  parseInt(process.env.COMMISSION_RESYNC_SWEEP_MS || String(DAY_MS), 10) || DAY_MS
);
const BATCH_SIZE = 100;

let timerHandle = null;
let running = false;

const sum2 = (n) => Number(Number(n || 0).toFixed(2));

async function commissionTotal(agreementId) {
  const agg = await prisma.agreementCommission.aggregate({
    where: { rentalAgreementId: agreementId },
    _sum: { commissionAmount: true },
  });
  return sum2(agg._sum.commissionAmount || 0);
}

async function runOnce() {
  if (running) return;
  running = true;
  const startedAt = Date.now();
  let processed = 0;
  let changed = 0;
  let failed = 0;
  const changedExamples = [];
  try {
    const where = {
      inspections: { some: { phase: 'CHECKOUT', actorUserId: { not: null } } },
    };
    let cursor = null;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const batch = await prisma.rentalAgreement.findMany({
        where,
        orderBy: { id: 'asc' },
        take: BATCH_SIZE,
        ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
        select: { id: true, agreementNumber: true },
      });
      if (batch.length === 0) break;
      cursor = batch[batch.length - 1].id;

      for (const ag of batch) {
        processed += 1;
        try {
          const before = await commissionTotal(ag.id);
          const result = await syncAgreementCommissionSnapshot(ag.id);
          if (result == null) continue; // no checkout actor / not eligible
          const after = await commissionTotal(ag.id);
          if (after !== before) {
            changed += 1;
            if (changedExamples.length < 10) {
              changedExamples.push({ agreement: ag.agreementNumber || ag.id, before, after });
            }
          }
        } catch (err) {
          failed += 1;
          logger.warn('[commission-resync] agreement failed', { agreementId: ag.id, message: err.message });
        }
      }
    }

    const base = { processed, changed, failed, ms: Date.now() - startedAt };
    if (changed > 0) {
      // WARN on purpose: in steady state nothing should change. A change means
      // drift was repaired — a checkout path missed the snapshot or a
      // commission config changed without a recompute.
      logger.warn('[commission-resync] repaired commission drift', { ...base, examples: changedExamples });
    } else {
      logger.info('[commission-resync] clean — no drift', base);
    }
  } catch (err) {
    logger.warn('[commission-resync] sweep failed', { message: err.message });
  } finally {
    running = false;
  }
}

export function startCommissionResyncSweep() {
  if (timerHandle) return;
  // First pass a couple minutes after boot (let the pool warm + avoid racing
  // the other boot-time sweeps), then steady.
  setTimeout(() => { runOnce().catch(() => {}); }, 2 * 60 * 1000);
  timerHandle = setInterval(() => { runOnce().catch(() => {}); }, SWEEP_INTERVAL_MS);
  logger.info('[commission-resync] started', { intervalMs: SWEEP_INTERVAL_MS });
}

export function stopCommissionResyncSweep() {
  if (timerHandle) {
    clearInterval(timerHandle);
    timerHandle = null;
  }
}
