#!/usr/bin/env node
// scripts/unblock-pre-terms-reservations.mjs
//
// 16g — One-shot operational script.
//
// Background
// ----------
// 281 reservations currently sit with autochargeBlocked=true because
// they were signed BEFORE the 2026-05-19 Terms & Conditions revision
// added explicit card-on-file pre-authorization (Section 11), delayed
// charges procedure (Section 12), and post-rental data retention
// (Section 13). Without those clauses the system refuses to auto-charge
// them after check-in — the autocharge.worker explicitly gates on
// autochargeBlocked.
//
// Now that the T&C has been updated AND the customer-portal sign flow
// stamps reservation.termsVersion = TC_VERSION on every new signature,
// the pre-update backlog is safe to release: the new terms are
// retroactive in the sense that any future autocharge attempt will be
// supported by the version currently in effect (Section 21 — RIGHT TO
// MODIFY).
//
// What this script does
// ---------------------
// 1. Find every reservation where:
//      - autochargeBlocked = true, AND
//      - createdAt < TC_EFFECTIVE_DATE (2026-05-19 UTC).
// 2. Print a count + a small sample (10 rows) for sanity check.
// 3. If --commit is passed, set autochargeBlocked=false on those rows
//    in a single updateMany call and log the resulting count.
// 4. Otherwise (default), exit without writing anything.
//
// Usage
// -----
//   # safe — prints what it WOULD do, writes nothing
//   node scripts/unblock-pre-terms-reservations.mjs
//
//   # actually apply
//   node scripts/unblock-pre-terms-reservations.mjs --commit
//
// Safe to re-run. The query is bounded by autochargeBlocked=true so
// once a row has been unblocked it falls out of the candidate set on
// subsequent runs.

import { TC_EFFECTIVE_DATE, TC_VERSION } from '../src/lib/terms/version.js';

const SAMPLE_SIZE = 10;

/**
 * Core logic — exported so the test harness can drive it with a stubbed
 * Prisma client. The CLI entrypoint at the bottom of this file wires in
 * the real prisma instance and reads --commit from argv.
 *
 * @param {object} prismaLike - object exposing reservation.findMany,
 *     reservation.count, reservation.updateMany
 * @param {object} [opts]
 * @param {boolean} [opts.commit=false]
 * @param {{log:Function}} [opts.logger=console]
 * @returns {Promise<{candidateCount:number, updatedCount:number, sample:Array}>}
 */
export async function runUnblock(prismaLike, opts = {}) {
  const commit = !!opts.commit;
  const logger = opts.logger || console;
  const log = (...args) => logger.log('[unblock-pre-terms]', ...args);

  log(`mode: ${commit ? 'COMMIT' : 'DRY-RUN'}`);
  log(`canonical TC_VERSION: ${TC_VERSION}`);
  log(`effective date: ${TC_EFFECTIVE_DATE.toISOString()}`);

  const where = {
    autochargeBlocked: true,
    createdAt: { lt: TC_EFFECTIVE_DATE }
  };

  const candidates = await prismaLike.reservation.findMany({
    where,
    select: {
      id: true,
      reservationNumber: true,
      createdAt: true,
      pickupAt: true,
      returnAt: true,
      tenantId: true,
      paymentStatus: true
    },
    orderBy: { createdAt: 'asc' },
    take: SAMPLE_SIZE
  });

  const total = await prismaLike.reservation.count({ where });

  log(`candidates found: ${total}`);
  if (total === 0) {
    log('nothing to do — no reservations match the unblock criteria.');
    return { candidateCount: 0, updatedCount: 0, sample: [] };
  }

  log(`sample (first ${Math.min(SAMPLE_SIZE, total)} by createdAt):`);
  for (const r of candidates) {
    log(
      `  - ${String(r.reservationNumber).padEnd(12)} ` +
      `tenant=${(r.tenantId || '-').slice(0, 8).padEnd(8)} ` +
      `created=${r.createdAt.toISOString().slice(0, 10)} ` +
      `pickup=${r.pickupAt?.toISOString().slice(0, 10) || '-'} ` +
      `paymentStatus=${r.paymentStatus}`
    );
  }

  if (!commit) {
    log('');
    log(`dry-run complete. ${total} reservation(s) would be unblocked.`);
    log('re-run with --commit to apply.');
    return { candidateCount: total, updatedCount: 0, sample: candidates };
  }

  log('committing — setting autochargeBlocked=false on all candidates...');
  const result = await prismaLike.reservation.updateMany({
    where,
    data: { autochargeBlocked: false }
  });
  log(`done — ${result.count} reservation(s) unblocked.`);
  return { candidateCount: total, updatedCount: result.count, sample: candidates };
}

// ── CLI entrypoint ────────────────────────────────────────────────────
// Only executes when the file is run directly (`node scripts/...mjs`).
// Suppressed when the file is imported (e.g. from the test harness) so
// the test can drive runUnblock() against a stub without touching the
// real database.
const isDirectInvocation = import.meta.url === `file://${process.argv[1]}`;
if (isDirectInvocation) {
  const { prisma } = await import('../src/lib/prisma.js');
  const commit = process.argv.includes('--commit');
  try {
    await runUnblock(prisma, { commit });
  } catch (err) {
    console.error('[unblock-pre-terms] error:', err);
    await prisma.$disconnect().catch(() => {});
    process.exit(1);
  }
  await prisma.$disconnect();
  console.log('');
  console.log(
    'Run `node scripts/unblock-pre-terms-reservations.mjs --commit` ' +
    'after deploy to unblock these reservations.'
  );
}
