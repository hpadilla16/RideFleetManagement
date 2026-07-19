/**
 * VozIA gap #4 (2026-07-15) — backfill Customer.phoneNormalized for existing rows.
 *
 * New/updated customers get phoneNormalized from the Prisma extension (lib/prisma.js);
 * this fills rows that predate the column. Idempotent + safe to re-run.
 *
 *   node scripts/backfill-customer-phone-normalized.mjs            # dry-run (default)
 *   node scripts/backfill-customer-phone-normalized.mjs --apply    # write changes
 *
 * Only touches phoneNormalized (never phone or any other field). Uses the SAME
 * normalizePhone() the extension uses, so backfilled rows match live-derived rows.
 */
import { prisma } from '../src/lib/prisma.js';
import { normalizePhone } from '../src/lib/customer-phone-normalize.js';

const APPLY = process.argv.includes('--apply');
const BATCH = 500;

async function main() {
  console.log(`[backfill-phone-normalized] mode=${APPLY ? 'APPLY' : 'DRY-RUN'}`);
  let cursor = null;
  let scanned = 0;
  let toUpdate = 0;
  let updated = 0;

  for (;;) {
    const rows = await prisma.customer.findMany({
      take: BATCH,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
      orderBy: { id: 'asc' },
      select: { id: true, phone: true, phoneNormalized: true },
    });
    if (rows.length === 0) break;
    cursor = rows[rows.length - 1].id;
    scanned += rows.length;

    for (const row of rows) {
      const want = normalizePhone(row.phone);
      if ((row.phoneNormalized ?? null) === (want ?? null)) continue;
      toUpdate += 1;
      if (APPLY) {
        // The phone-derive extension is a no-op here (we pass phoneNormalized, not phone),
        // so this writes exactly the value normalizePhone() produced above.
        await prisma.customer.update({
          where: { id: row.id },
          data: { phoneNormalized: want },
        });
        updated += 1;
      }
    }
    console.log(`  scanned=${scanned} needsUpdate=${toUpdate} updated=${updated}`);
  }

  console.log(`[backfill-phone-normalized] done. scanned=${scanned} needsUpdate=${toUpdate} updated=${updated}${APPLY ? '' : ' (dry-run — re-run with --apply)'}`);
  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error('[backfill-phone-normalized] FAILED', e);
  await prisma.$disconnect();
  process.exit(1);
});
