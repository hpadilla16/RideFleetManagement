#!/usr/bin/env node
// scripts/backfill-mileage-history.mjs
//
// Backfill the VehicleMileageEntry timeline (2026-06-09) from the odometer
// readings already stored on RentalAgreement (odometerOut / odometerIn). Gives
// every vehicle a mileage history from day one instead of starting empty.
//
// Run:
//   node scripts/backfill-mileage-history.mjs            # dry run (default)
//   node scripts/backfill-mileage-history.mjs --apply    # actually insert rows
//
// IDEMPOTENT: each backfilled row uses a deterministic id
// ("bf_<agreementId>_OUT" / "_IN") and upsert, so re-running never duplicates.
//
// HISTORY ONLY: this does NOT touch Vehicle.mileage / lastOdometerSource — the
// live "last entry wins" sync (check-in/check-out/manual) remains the source of
// truth for the current number. Backfill rows are inserted with their original
// timestamps purely to populate the timeline.
//
// Run AFTER `prisma migrate deploy` has created the VehicleMileageEntry table.
// On the droplet, exec inside fleet-backend-prod.

import { prisma } from '../src/lib/prisma.js';

const APPLY = process.argv.includes('--apply');

function pickMileage(value) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.round(n) : null;
}

async function main() {
  console.log(`[backfill-mileage] mode = ${APPLY ? 'APPLY' : 'DRY RUN'}`);

  // Only agreements that actually carry an odometer reading and a vehicle.
  const agreements = await prisma.rentalAgreement.findMany({
    where: {
      vehicleId: { not: null },
      OR: [{ odometerOut: { not: null } }, { odometerIn: { not: null } }],
    },
    select: {
      id: true,
      tenantId: true,
      vehicleId: true,
      odometerOut: true,
      odometerIn: true,
      finalizedAt: true,
      closedAt: true,
      createdAt: true,
      updatedAt: true,
      reservation: { select: { reservationNumber: true } },
    },
    orderBy: { createdAt: 'asc' },
  });

  console.log(`[backfill-mileage] ${agreements.length} agreement(s) with odometer data`);

  let planned = 0;
  let written = 0;

  for (const a of agreements) {
    const reservationNumber = a.reservation?.reservationNumber || null;
    const rows = [];

    const out = pickMileage(a.odometerOut);
    if (out != null) {
      rows.push({
        id: `bf_${a.id}_OUT`,
        source: 'CHECKOUT',
        mileage: out,
        recordedAt: a.finalizedAt || a.createdAt,
      });
    }

    const inn = pickMileage(a.odometerIn);
    if (inn != null) {
      rows.push({
        id: `bf_${a.id}_IN`,
        source: 'CHECKIN',
        mileage: inn,
        recordedAt: a.closedAt || a.updatedAt,
      });
    }

    for (const r of rows) {
      planned += 1;
      if (!APPLY) continue;
      await prisma.vehicleMileageEntry.upsert({
        where: { id: r.id },
        update: {}, // never rewrite an existing backfilled row
        create: {
          id: r.id,
          vehicleId: a.vehicleId,
          tenantId: a.tenantId ?? null,
          mileage: r.mileage,
          source: r.source,
          reservationId: null,
          rentalAgreementId: a.id,
          reservationNumber,
          note: 'Backfilled from rental agreement odometer',
          actorUserId: null,
          recordedAt: r.recordedAt,
        },
      });
      written += 1;
    }
  }

  console.log(`[backfill-mileage] planned entries: ${planned}`);
  console.log(`[backfill-mileage] ${APPLY ? `inserted/kept: ${written}` : 'DRY RUN — no rows written. Re-run with --apply.'}`);
}

main()
  .catch((err) => {
    console.error('[backfill-mileage] FAILED', err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
