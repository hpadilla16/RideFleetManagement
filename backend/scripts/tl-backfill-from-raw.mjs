#!/usr/bin/env node
/**
 * tl-backfill-from-raw.mjs
 *
 * Re-runs mapDetailToRow over every ExternalReservation where
 * sourceSystem='TL_INTERNATIONAL' and updates the structured columns
 * (customerFirstName, customerPhone, pickupAt, totalAmount, etc.) from
 * the existing rawJson blob.
 *
 * Why: rows captured before 2026-05-20 were mapped with guessed key names
 * that didn't match TL's actual JSON shape. The raw payload is preserved
 * untouched in rawJson, so we can rehydrate the structured fields without
 * hitting TL again.
 *
 * Idempotent: re-running on already-correct rows yields the same values
 * (we always write what mapDetailToRow produces from rawJson).
 *
 * Usage:
 *   node backend/scripts/tl-backfill-from-raw.mjs              # dry run
 *   node backend/scripts/tl-backfill-from-raw.mjs --commit     # apply
 *   node backend/scripts/tl-backfill-from-raw.mjs --commit --limit 50
 */

import { prisma } from '../src/lib/prisma.js';
import { mapDetailToRow, SOURCE_SYSTEM } from '../src/modules/integrations/tl-international/tl-international.service.js';

const COMMIT = process.argv.includes('--commit');
const limitArg = process.argv.find((a) => a.startsWith('--limit='));
const LIMIT = limitArg ? Number(limitArg.split('=')[1]) : null;

// Fields owned by the mapper. We never overwrite rawJson, externalRef,
// sourceSystem, tenantId, or anything not in this list.
const MAPPABLE_FIELDS = [
  'channel',
  'supplierRef',
  'status',
  'customerFirstName',
  'customerLastName',
  'customerEmail',
  'customerPhone',
  'customerCountry',
  'flightNumber',
  'vehicleAcriss',
  'vehicleDescription',
  'pickupAt',
  'pickupLocation',
  'dropoffAt',
  'dropoffLocation',
  'totalAmount',
  'currency',
];

function diffRow(current, mapped) {
  const out = {};
  for (const k of MAPPABLE_FIELDS) {
    const a = current[k];
    const b = mapped[k];
    // Compare Date objects by ISO; everything else strict.
    if (a instanceof Date || b instanceof Date) {
      const aIso = a instanceof Date ? a.toISOString() : a;
      const bIso = b instanceof Date ? b.toISOString() : b;
      if (aIso !== bIso) out[k] = b;
    } else if (a !== b) {
      // Treat null/undefined as equivalent
      if (!(a == null && b == null)) out[k] = b;
    }
  }
  return out;
}

async function main() {
  console.log(`[tl-backfill] mode: ${COMMIT ? 'COMMIT' : 'DRY RUN'}`);
  if (LIMIT != null) console.log(`[tl-backfill] limit: ${LIMIT}`);

  const rows = await prisma.externalReservation.findMany({
    where: { sourceSystem: SOURCE_SYSTEM },
    orderBy: { createdAt: 'asc' },
    ...(LIMIT ? { take: LIMIT } : {}),
  });

  console.log(`[tl-backfill] candidates: ${rows.length}`);

  let updated = 0;
  let unchanged = 0;
  let skipped = 0;
  let errors = 0;

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (!row.rawJson || typeof row.rawJson !== 'object') {
      skipped++;
      continue;
    }
    try {
      const mapped = mapDetailToRow(row.rawJson, row.externalRef);
      const diff = diffRow(row, mapped);
      const changedKeys = Object.keys(diff);
      if (changedKeys.length === 0) {
        unchanged++;
      } else {
        if (COMMIT) {
          await prisma.externalReservation.update({
            where: { id: row.id },
            data: diff,
          });
        }
        updated++;
        if (updated <= 5 || updated % 25 === 0) {
          console.log(
            `[tl-backfill] ${COMMIT ? 'updated' : 'would update'} ${row.externalRef}: ` +
              `${changedKeys.join(', ')}`,
          );
        }
      }
    } catch (err) {
      errors++;
      console.error(`[tl-backfill] error on ${row.externalRef}:`, err.message);
    }

    if ((i + 1) % 25 === 0) {
      console.log(`[tl-backfill] progress ${i + 1}/${rows.length}`);
    }
  }

  console.log('\n[tl-backfill] summary:');
  console.log(`  scanned:    ${rows.length}`);
  console.log(`  ${COMMIT ? 'updated' : 'would update'}: ${updated}`);
  console.log(`  unchanged:  ${unchanged}`);
  console.log(`  skipped:    ${skipped} (no rawJson)`);
  console.log(`  errors:     ${errors}`);
  if (!COMMIT && updated > 0) {
    console.log('\n[tl-backfill] re-run with --commit to apply.');
  }
}

main()
  .catch((err) => {
    console.error('[tl-backfill] fatal:', err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

// Export for tests / programmatic invocation
export { diffRow, MAPPABLE_FIELDS };
