#!/usr/bin/env node
// scripts/seed-tank-capacity.mjs
//
// Seed Vehicle.fuelTankCapacityGallons (2026-06-10, #51) from a make/model →
// gallons map of common fleet vehicles. Only fills vehicles where the column
// is NULL — a manually-set value always wins and is never overwritten.
//
// Run (inside fleet-backend-prod, AFTER the 20260610_vehicle_fuel_tank_capacity
// migration):
//   node scripts/seed-tank-capacity.mjs            # dry run (default)
//   node scripts/seed-tank-capacity.mjs --apply    # write matches
//
// The dry run prints BOTH the planned updates and the vehicles it could not
// match — that second list is the manual to-do for the team (fill from the
// vehicle profile → Edit vehicle → Fuel tank capacity).

import { prisma } from '../src/lib/prisma.js';

const APPLY = process.argv.includes('--apply');

// Approximate OEM tank sizes (gallons) for common rental-fleet models.
// Matched by case-insensitive substring against `${make} ${model}`.
// Order matters: more specific keys first.
const CAPACITY_MAP = [
  ['suburban', 28.0], ['tahoe', 24.0], ['traverse', 19.4], ['equinox', 14.9],
  ['malibu', 15.8], ['trax', 13.2], ['spark', 9.0],
  ['expedition', 23.2], ['explorer', 17.9], ['escape', 14.8], ['fusion', 16.5],
  ['focus', 12.4], ['fiesta', 12.4], ['edge', 18.5], ['transit', 25.0],
  ['highlander', 17.9], ['rav4', 14.5], ['camry', 15.8], ['corolla cross', 12.4],
  ['corolla', 13.2], ['sienna', 18.0], ['tacoma', 21.1], ['4runner', 23.0], ['yaris', 11.6],
  ['pilot', 19.5], ['cr-v', 14.0], ['crv', 14.0], ['accord', 14.8], ['civic', 12.4],
  ['hr-v', 14.0], ['hrv', 14.0], ['odyssey', 19.5],
  ['pathfinder', 19.5], ['rogue sport', 14.5], ['rogue', 14.5], ['altima', 16.2],
  ['sentra', 12.4], ['versa', 10.8], ['kicks', 10.8], ['murano', 19.0], ['frontier', 21.0],
  ['santa fe', 17.7], ['tucson', 14.3], ['sonata', 15.9], ['elantra', 12.4],
  ['accent', 11.9], ['venue', 11.9], ['palisade', 18.8], ['kona', 13.2],
  ['sorento', 17.7], ['sportage', 14.2], ['telluride', 18.8], ['forte', 14.0],
  ['k5', 15.8], ['rio', 11.9], ['soul', 14.3], ['seltos', 13.2], ['carnival', 19.0],
  ['grand cherokee', 23.0], ['cherokee', 15.8], ['wrangler', 17.5], ['compass', 13.5],
  ['renegade', 12.7], ['gladiator', 22.0],
  ['durango', 24.6], ['charger', 18.5], ['challenger', 18.5], ['hornet', 13.5],
  ['grand caravan', 20.0], ['pacifica', 19.0], ['voyager', 19.0],
  ['outlander sport', 16.6], ['outlander', 14.8], ['mirage', 9.2], ['eclipse cross', 15.8],
  ['jetta', 13.2], ['tiguan', 15.3], ['passat', 18.5], ['atlas', 18.6], ['taos', 13.2],
];

// EVs have no fuel tank — never seed, never list as "missing" actionable.
const EV_HINTS = ['tesla', 'model 3', 'model y', 'model s', 'model x', 'bolt', 'leaf', 'ioniq 5', 'ioniq 6', 'ev6', 'id.4', 'mach-e'];

function matchCapacity(make, model) {
  const hay = `${make || ''} ${model || ''}`.toLowerCase();
  if (!hay.trim()) return { kind: 'unmatched' };
  if (EV_HINTS.some((h) => hay.includes(h))) return { kind: 'ev' };
  for (const [key, gal] of CAPACITY_MAP) {
    if (hay.includes(key)) return { kind: 'match', gallons: gal, key };
  }
  return { kind: 'unmatched' };
}

async function main() {
  console.log(`[seed-tank-capacity] mode = ${APPLY ? 'APPLY' : 'DRY RUN'}`);

  const vehicles = await prisma.vehicle.findMany({
    where: { fuelTankCapacityGallons: null },
    select: { id: true, tenantId: true, internalNumber: true, make: true, model: true, year: true },
    orderBy: { internalNumber: 'asc' },
  });
  console.log(`[seed-tank-capacity] ${vehicles.length} vehicle(s) without capacity`);

  let planned = 0;
  let written = 0;
  const unmatched = [];
  const evs = [];

  for (const v of vehicles) {
    const m = matchCapacity(v.make, v.model);
    if (m.kind === 'ev') { evs.push(v); continue; }
    if (m.kind !== 'match') { unmatched.push(v); continue; }
    planned += 1;
    console.log(`  PLAN ${v.internalNumber} (${v.year || '?'} ${v.make || ''} ${v.model || ''}) → ${m.gallons} gal [${m.key}]`);
    if (!APPLY) continue;
    await prisma.vehicle.update({
      where: { id: v.id },
      data: { fuelTankCapacityGallons: m.gallons },
    });
    written += 1;
  }

  if (evs.length) {
    console.log(`[seed-tank-capacity] ${evs.length} EV(s) skipped (no fuel tank):`);
    for (const v of evs) console.log(`  EV   ${v.internalNumber} (${v.year || '?'} ${v.make || ''} ${v.model || ''})`);
  }
  if (unmatched.length) {
    console.log(`[seed-tank-capacity] ${unmatched.length} vehicle(s) NOT matched — set manually from the vehicle profile:`);
    for (const v of unmatched) console.log(`  TODO ${v.internalNumber} (${v.year || '?'} ${v.make || ''} ${v.model || ''})`);
  }
  console.log(`[seed-tank-capacity] planned: ${planned}`);
  console.log(`[seed-tank-capacity] ${APPLY ? `updated: ${written}` : 'DRY RUN — nothing written. Re-run with --apply.'}`);
}

main()
  .catch((err) => {
    console.error('[seed-tank-capacity] FAILED', err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
