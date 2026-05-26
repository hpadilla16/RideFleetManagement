/**
 * Backfill commission snapshots — 2026-05-26.
 *
 * One-time script: re-runs syncAgreementCommissionSnapshot for every existing
 * CLOSED RentalAgreement so commissionAmount picks up the new SERVICE_CATALOG
 * fallback rates (Tolls $1, Insurance $3, etc.).
 *
 * Before this fix, sync wrote $0 for any employee without a configured
 * CommissionPlan. In production that meant only Valeria had non-zero
 * commission rows; everyone else was $0 across the whole ledger.
 *
 * Status preservation: the sync update no longer touches status, so any
 * commission already marked APPROVED/PAID keeps that status. Only
 * commissionAmount + grossRevenue + serviceRevenue + eligibleRevenue +
 * calculatedAt get refreshed.
 *
 * Usage (inside the droplet container):
 *   docker compose -f docker-compose.prod.yml exec backend \\
 *     node src/scripts/backfill-commission-snapshots.js
 *
 * Optional: limit to a single tenant for safety:
 *   docker compose -f docker-compose.prod.yml exec backend \\
 *     node src/scripts/backfill-commission-snapshots.js --tenantId cmn98hc1u0085ke0i4vefujt3
 *
 * Optional: dry-run (logs counts only, makes no changes):
 *   docker compose -f docker-compose.prod.yml exec backend \\
 *     node src/scripts/backfill-commission-snapshots.js --dry
 */

import { prisma } from '../lib/prisma.js';
import { syncAgreementCommissionSnapshot } from '../modules/rental-agreements/rental-agreements.service.js';

function parseArgs(argv) {
  const args = { tenantId: null, dry: false, batchSize: 100 };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry' || a === '--dry-run') args.dry = true;
    else if (a === '--tenantId' && argv[i + 1]) { args.tenantId = argv[++i]; }
    else if (a === '--batch' && argv[i + 1]) { args.batchSize = Number(argv[++i]) || 100; }
  }
  return args;
}

async function main() {
  const { tenantId, dry, batchSize } = parseArgs(process.argv);

  console.log('────────────────────────────────────────────');
  console.log(' Commission snapshot backfill');
  console.log('────────────────────────────────────────────');
  console.log(` tenant:   ${tenantId || '(all tenants)'}`);
  console.log(` dry-run:  ${dry ? 'YES — no writes' : 'no'}`);
  console.log(` batch:    ${batchSize}`);
  console.log('────────────────────────────────────────────');

  // Snapshot is only created for CLOSED agreements (per the guard inside
  // syncAgreementCommissionSnapshot), so scope the backfill to those.
  const where = { status: 'CLOSED' };
  if (tenantId) where.tenantId = tenantId;

  const totalCount = await prisma.rentalAgreement.count({ where });
  console.log(`\nFound ${totalCount} CLOSED agreements to process.\n`);

  if (totalCount === 0) {
    console.log('Nothing to do.');
    await prisma.$disconnect();
    return;
  }

  let processed = 0;
  let succeeded = 0;
  let skipped = 0;
  let failed = 0;
  let totalCommissionBefore = 0;
  let totalCommissionAfter = 0;

  let cursor = null;
  while (processed < totalCount) {
    const batch = await prisma.rentalAgreement.findMany({
      where,
      orderBy: { id: 'asc' },
      take: batchSize,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
      select: { id: true },
    });
    if (batch.length === 0) break;
    cursor = batch[batch.length - 1].id;

    for (const ag of batch) {
      processed += 1;
      try {
        // Sum existing snapshot $ before re-sync (for the summary)
        const before = await prisma.agreementCommission.aggregate({
          where: { rentalAgreementId: ag.id },
          _sum: { commissionAmount: true },
        });
        totalCommissionBefore += Number(before._sum.commissionAmount || 0);

        if (!dry) {
          const result = await syncAgreementCommissionSnapshot(ag.id);
          if (result == null) {
            skipped += 1; // not CLOSED / no checkout actor / etc.
          } else {
            succeeded += 1;
            const after = await prisma.agreementCommission.aggregate({
              where: { rentalAgreementId: ag.id },
              _sum: { commissionAmount: true },
            });
            totalCommissionAfter += Number(after._sum.commissionAmount || 0);
          }
        } else {
          succeeded += 1;
        }
      } catch (err) {
        failed += 1;
        console.error(`[${ag.id}] failed:`, err?.message || err);
      }

      if (processed % 50 === 0) {
        console.log(`  ${processed} / ${totalCount} processed (${succeeded} synced, ${skipped} skipped, ${failed} failed)`);
      }
    }
  }

  console.log('\n────────────────────────────────────────────');
  console.log(' Summary');
  console.log('────────────────────────────────────────────');
  console.log(` processed:           ${processed}`);
  console.log(` re-synced:           ${succeeded}`);
  console.log(` skipped (no actor):  ${skipped}`);
  console.log(` failed:              ${failed}`);
  console.log(` $ total before:      $${totalCommissionBefore.toFixed(2)}`);
  if (!dry) console.log(` $ total after:       $${totalCommissionAfter.toFixed(2)}`);
  console.log('────────────────────────────────────────────');

  await prisma.$disconnect();
}

main().catch((err) => {
  console.error('Backfill crashed:', err);
  process.exit(1);
});
