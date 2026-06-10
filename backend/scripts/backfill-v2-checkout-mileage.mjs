#!/usr/bin/env node
// scripts/backfill-v2-checkout-mileage.mjs
//
// Backfill (2026-06-10) the CHECKOUT VehicleMileageEntry rows that the
// wizard-v2 cascade silently skipped before beta.152.
//
// Background: the checkout-session cascade (toStep=CLOSED) never called the
// classic finalize(), so for EVERY v2 checkout closed before beta.152 the
// mobile-captured odometer stayed only on the RentalAgreementInspection row:
//   • agreement.odometerOut was left null  → contracts now coalesce from the
//     inspection (fixed retroactively by beta.152's read path), BUT
//   • no VehicleMileageEntry(source=CHECKOUT) was ever recorded → the beta.143
//     mileage timeline has a silent gap (and the beta.143 backfill couldn't
//     see these either, because it read agreement.odometerOut).
//
// This script fills exactly that gap from the inspection rows.
//
// Run (inside fleet-backend-prod on the droplet, like the beta.143 backfill):
//   node scripts/backfill-v2-checkout-mileage.mjs            # dry run (default)
//   node scripts/backfill-v2-checkout-mileage.mjs --apply    # insert rows
//
// IDEMPOTENT: deterministic id "bf152_<agreementId>_OUT" + upsert, and skips
// any agreement that already has a CHECKOUT entry (live or backfilled).
//
// HISTORY ONLY: does NOT touch Vehicle.mileage / lastOdometerSource, and does
// NOT write agreement.odometerOut (the contract read path already coalesces).

import { prisma } from '../src/lib/prisma.js';

const APPLY = process.argv.includes('--apply');

function pickMileage(value) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.round(n) : null;
}

async function main() {
  console.log(`[backfill-v2-mileage] mode = ${APPLY ? 'APPLY' : 'DRY RUN'}`);

  // CHECKOUT inspections that carry an odometer, on agreements where the
  // cascade never copied it to the column (the pre-beta.152 signature).
  const inspections = await prisma.rentalAgreementInspection.findMany({
    where: {
      phase: 'CHECKOUT',
      odometer: { not: null },
      rentalAgreement: {
        odometerOut: null,
        vehicleId: { not: null },
      },
    },
    select: {
      id: true,
      odometer: true,
      capturedAt: true,
      rentalAgreement: {
        select: {
          id: true,
          tenantId: true,
          vehicleId: true,
          finalizedAt: true,
          createdAt: true,
          reservation: { select: { reservationNumber: true } },
        },
      },
    },
    orderBy: { capturedAt: 'asc' },
  });

  console.log(`[backfill-v2-mileage] ${inspections.length} candidate inspection(s)`);

  let planned = 0;
  let skippedExisting = 0;
  let written = 0;

  for (const insp of inspections) {
    const a = insp.rentalAgreement;
    const mileage = pickMileage(insp.odometer);
    if (!a?.vehicleId || mileage == null) continue;

    // Skip if ANY checkout entry already exists for this agreement — covers
    // live beta.152 entries, the beta.143 backfill ("bf_<id>_OUT"), and
    // re-runs of this script.
    const existing = await prisma.vehicleMileageEntry.findFirst({
      where: { rentalAgreementId: a.id, source: 'CHECKOUT' },
      select: { id: true },
    });
    if (existing) {
      skippedExisting += 1;
      continue;
    }

    planned += 1;
    if (!APPLY) continue;

    await prisma.vehicleMileageEntry.upsert({
      where: { id: `bf152_${a.id}_OUT` },
      update: {}, // never rewrite an existing backfilled row
      create: {
        id: `bf152_${a.id}_OUT`,
        vehicleId: a.vehicleId,
        tenantId: a.tenantId ?? null,
        mileage,
        source: 'CHECKOUT',
        reservationId: null,
        rentalAgreementId: a.id,
        reservationNumber: a.reservation?.reservationNumber || null,
        note: 'Backfilled from CHECKOUT inspection (pre-beta.152 v2 cascade gap)',
        actorUserId: null,
        recordedAt: a.finalizedAt || insp.capturedAt || a.createdAt,
      },
    });
    written += 1;
  }

  console.log(`[backfill-v2-mileage] skipped (already have CHECKOUT entry): ${skippedExisting}`);
  console.log(`[backfill-v2-mileage] planned entries: ${planned}`);
  console.log(`[backfill-v2-mileage] ${APPLY ? `inserted/kept: ${written}` : 'DRY RUN — no rows written. Re-run with --apply.'}`);
}

main()
  .catch((err) => {
    console.error('[backfill-v2-mileage] FAILED', err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
