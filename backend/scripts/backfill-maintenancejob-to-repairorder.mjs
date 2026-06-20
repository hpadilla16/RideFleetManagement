// Backfill: migrate legacy MaintenanceJob rows → RepairOrder (Maintenance Module Fase 4).
// Each MaintenanceJob becomes a RepairOrder (source=MANUAL) with a single line for its cost.
// Idempotent: a marker "[mj:<id>]" in RepairOrder.notes prevents re-migrating.
// Dry-run by default; pass --apply to write. History-only (does NOT touch Vehicle.status).
//
//   node scripts/backfill-maintenancejob-to-repairorder.mjs            # dry-run
//   node scripts/backfill-maintenancejob-to-repairorder.mjs --apply    # write

import { prisma } from '../src/lib/prisma.js';

const APPLY = process.argv.includes('--apply');
const num = (v) => (v == null ? null : Number(v));

async function main() {
  const jobs = await prisma.maintenanceJob.findMany({
    include: { vehicle: { select: { id: true, tenantId: true, homeLocationId: true } } },
    orderBy: { openedAt: 'asc' },
  });
  console.log(`MaintenanceJob rows: ${jobs.length}  (mode: ${APPLY ? 'APPLY' : 'dry-run'})`);

  let created = 0; let skipped = 0; let noTenant = 0;
  // Track the next roNumber per vehicle as we go (so a batch doesn't collide).
  const nextRo = new Map();

  for (const j of jobs) {
    const tenantId = j.vehicle?.tenantId;
    if (!tenantId) { noTenant += 1; continue; }
    const marker = `[mj:${j.id}]`;
    const already = await prisma.repairOrder.findFirst({ where: { vehicleId: j.vehicleId, notes: { contains: marker } }, select: { id: true } });
    if (already) { skipped += 1; continue; }

    if (!nextRo.has(j.vehicleId)) {
      const last = await prisma.repairOrder.findFirst({ where: { vehicleId: j.vehicleId }, orderBy: { roNumber: 'desc' }, select: { roNumber: true } });
      nextRo.set(j.vehicleId, (last?.roNumber || 0) + 1);
    }
    const roNumber = nextRo.get(j.vehicleId);
    nextRo.set(j.vehicleId, roNumber + 1);

    const cost = num(j.finalCost) ?? num(j.costEstimate);
    const notes = `${j.title || 'Maintenance'}${j.description ? ` — ${j.description}` : ''} ${marker}`.trim();
    const lineAmount = cost != null ? Number(cost) : 0;

    if (APPLY) {
      await prisma.repairOrder.create({
        data: {
          tenantId, vehicleId: j.vehicleId, roNumber,
          locationId: j.vehicle?.homeLocationId || null,
          status: j.status, // MaintenanceStatus and RepairOrderStatus share the same values
          source: 'MANUAL',
          odometerAtOpen: j.odometerAtOpen ?? null,
          openedAt: j.openedAt || new Date(),
          completedAt: j.completedAt || null,
          notes,
          ...(cost != null ? { lines: { create: [{ type: 'OTHER', description: j.title || 'Migrated cost', qty: 1, unitCost: lineAmount, amount: lineAmount }] } } : {}),
        },
      });
    }
    created += 1;
  }

  console.log(`${APPLY ? 'Created' : 'Would create'}: ${created}  ·  skipped (already migrated): ${skipped}  ·  no tenant: ${noTenant}`);
  if (!APPLY) console.log('Dry-run only. Re-run with --apply to write.');
  await prisma.$disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); });
