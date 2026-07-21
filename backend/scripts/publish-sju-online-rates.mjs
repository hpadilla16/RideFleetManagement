#!/usr/bin/env node
// scripts/publish-sju-online-rates.mjs
//
// MONEY DATA OP (2026-07-19). Fix the SJU (San Juan Airport) online-rate gap for
// tenant International Rental Corp. Audited state: only 2 of ~18 classes were
// displayOnline=true (FJAR $115, FVAR $250), so every other class quoted online
// via the HEADER-DAILY FALLBACK in resolveForRental — e.g. CFAR (real $43.69)
// quoted at $115 or $250. Cross-priced. A customer could book at the wrong price.
//
// This script does TWO things, both idempotent:
//   (a) PUBLISH 8 existing rates whose class-specific RateItem price is ALREADY
//       correct in the DB — pure displayOnline=false -> true. It writes NO price;
//       it only makes the already-correct price visible online. Each flip is
//       GUARDED: if the stored RateItem.daily no longer matches the audited
//       price, that class is SKIPPED and reported (never publish a price that
//       silently changed since the 2026-07-19 audit).
//   (b) CREATE rates for two classes that have inventory but NO rate at all,
//       by CLONING the full config of a known-good daily rate (SJU_SCAR_DAILY)
//       so they behave identically, then setting the price Hector provided:
//         SKAR  Cargo Van  -> $200.00
//         K     Truck Box  -> $250.00
//       Both created displayOnline=true with a class-specific RateItem
//       (header daily == item daily, matching every other SJU rate).
//
// It does NOT touch ICAR / STAR (rate exists but 0 active inventory at SJU) or
// the orphan rate codes (ECAR/FCAR/IFAR/RFAR/XFAR) — Hector's decision: leave.
//
// Run INSIDE fleet-backend-prod (has the prod DATABASE_URL). Dry run is default
// and prints the FULL plan; nothing is written without --apply:
//   node scripts/publish-sju-online-rates.mjs            # dry run (default)
//   node scripts/publish-sju-online-rates.mjs --apply    # write, in one tx
//
// Reversible: (a) set displayOnline=false on the 8 rateCodes; (b) delete the
// two created rates (+ their RateItems). No migration, no code — data only.
//
// Verify after --apply: GET /api/quotes/preview for SJU must return each class
// at its OWN price (CFAR ~$43.69, not $115) with pricingSource 'LOCATION'.

import { prisma } from '../src/lib/prisma.js';

const APPLY = process.argv.includes('--apply');

const TENANT_SLUG = 'internationrentalcorp-fleet';
const LOCATION_ID = 'cmnakn5w00001ok0iyhs1govp'; // San Juan Airport
const TEMPLATE_RATE_CODE = 'SJU_SCAR_DAILY';     // known-good simple daily rate to clone

// (a) Publish these existing rates. The `expect` value is the class-specific
// RateItem.daily read from prod on 2026-07-19 — a guard, not a write: if the DB
// no longer matches, we SKIP that class rather than publish a changed price.
const PUBLISH = [
  { rateCode: 'SJU_CFAR_DAILY', acriss: 'CFAR', expect: 43.69 },
  { rateCode: 'SJU_CCAR_DAILY', acriss: 'CCAR', expect: 35.36 },
  { rateCode: 'SJU_SFAR_DAILY', acriss: 'SFAR', expect: 54.14 },
  { rateCode: 'SJU_FFAR_DAILY', acriss: 'FFAR', expect: 108.78 },
  { rateCode: 'SJU_MVAR_DAILY', acriss: 'MVAR', expect: 182.34 },
  { rateCode: 'SJU_SPAR_DAILY', acriss: 'SPAR', expect: 60.72 },
  { rateCode: 'SJU_SCAR_DAILY', acriss: 'SCAR', expect: 37.66 },
  { rateCode: 'SJU_LFAR_DAILY', acriss: 'LFAR', expect: 213.07 },
];

// (b) Create rates for these classes (inventory but no rate). Prices from Hector.
const CREATE = [
  { acriss: 'SKAR', className: 'Cargo Van', rateCode: 'SJU_SKAR_DAILY', daily: 200.0 },
  { acriss: 'K',    className: 'Truck Box', rateCode: 'SJU_K_DAILY',    daily: 250.0 },
];

const money = (v) => (v == null ? 'null' : `$${Number(v).toFixed(2)}`);

async function main() {
  console.log(`\n=== publish-sju-online-rates  (${APPLY ? 'APPLY' : 'DRY RUN'}) ===\n`);

  const tenant = await prisma.tenant.findUnique({ where: { slug: TENANT_SLUG }, select: { id: true, name: true } });
  if (!tenant) throw new Error(`Tenant not found: ${TENANT_SLUG}`);
  const location = await prisma.location.findUnique({ where: { id: LOCATION_ID }, select: { id: true, name: true } });
  if (!location) throw new Error(`Location not found: ${LOCATION_ID}`);
  console.log(`Tenant:   ${tenant.name} (${tenant.id})`);
  console.log(`Location: ${location.name} (${location.id})\n`);

  const scope = { tenantId: tenant.id, locationId: LOCATION_ID };

  // ---- Plan (a): publish existing rates, guarded on price match --------------
  const publishPlan = [];
  for (const p of PUBLISH) {
    const rate = await prisma.rate.findFirst({
      where: { ...scope, rateCode: p.rateCode },
      select: { id: true, rateCode: true, daily: true, displayOnline: true,
                rateItems: { select: { daily: true, vehicleType: { select: { code: true } } } } },
    });
    if (!rate) { publishPlan.push({ ...p, action: 'MISSING', note: 'rate not found' }); continue; }
    const item = rate.rateItems.find((i) => i.vehicleType?.code === p.acriss);
    const itemDaily = item ? Number(item.daily) : null;
    if (itemDaily == null) { publishPlan.push({ ...p, action: 'SKIP', note: 'no class RateItem' }); continue; }
    if (Math.abs(itemDaily - p.expect) > 0.005) {
      publishPlan.push({ ...p, action: 'SKIP', note: `price changed since audit: DB ${money(itemDaily)} != expected ${money(p.expect)}` });
      continue;
    }
    if (rate.displayOnline === true) { publishPlan.push({ ...p, rateId: rate.id, action: 'ALREADY', itemDaily }); continue; }
    publishPlan.push({ ...p, rateId: rate.id, action: 'PUBLISH', itemDaily });
  }

  // ---- Plan (b): create rates by cloning the template ------------------------
  const template = await prisma.rate.findFirst({ where: { ...scope, rateCode: TEMPLATE_RATE_CODE } });
  if (!template) throw new Error(`Template rate not found: ${TEMPLATE_RATE_CODE}`);
  const templateItem = await prisma.rateItem.findFirst({ where: { rateId: template.id } });

  const createPlan = [];
  for (const c of CREATE) {
    const vt = await prisma.vehicleType.findFirst({ where: { tenantId: tenant.id, code: c.acriss }, select: { id: true, code: true, name: true } });
    if (!vt) { createPlan.push({ ...c, action: 'MISSING', note: `no VehicleType with code ${c.acriss}` }); continue; }
    const existing = await prisma.rate.findFirst({ where: { ...scope, rateCode: c.rateCode }, select: { id: true } });
    if (existing) { createPlan.push({ ...c, action: 'ALREADY', note: 'rate already exists' }); continue; }
    createPlan.push({ ...c, vehicleTypeId: vt.id, action: 'CREATE' });
  }

  // ---- Print the plan --------------------------------------------------------
  console.log('(a) PUBLISH existing rates (flip displayOnline -> true):');
  for (const p of publishPlan) {
    const tag = p.action.padEnd(8);
    console.log(`  ${tag} ${p.acriss.padEnd(5)} ${p.rateCode.padEnd(16)} ${p.itemDaily != null ? money(p.itemDaily) : ''} ${p.note ? '— ' + p.note : ''}`);
  }
  console.log('\n(b) CREATE rates (clone ' + TEMPLATE_RATE_CODE + ' config; header==item price):');
  for (const c of createPlan) {
    const tag = c.action.padEnd(8);
    console.log(`  ${tag} ${c.acriss.padEnd(5)} ${(c.rateCode||'').padEnd(16)} ${money(c.daily)} (${c.className}) ${c.note ? '— ' + c.note : ''}`);
  }

  const toPublish = publishPlan.filter((p) => p.action === 'PUBLISH');
  const toCreate = createPlan.filter((c) => c.action === 'CREATE');
  console.log(`\nSummary: ${toPublish.length} to publish, ${toCreate.length} to create.`);
  const skips = [...publishPlan, ...createPlan].filter((x) => x.action === 'SKIP' || x.action === 'MISSING');
  if (skips.length) console.log(`⚠️  ${skips.length} skipped/missing — review the notes above.`);

  if (!APPLY) {
    console.log('\nDRY RUN — nothing written. Re-run with --apply to execute.\n');
    return;
  }
  if (!toPublish.length && !toCreate.length) {
    console.log('\nNothing to do (idempotent) — no writes.\n');
    return;
  }

  // ---- Apply, in one transaction ---------------------------------------------
  // Fields we deliberately DO NOT copy from the template (identity/timestamps/
  // the two we override). Everything else is cloned so K/SKAR behave exactly
  // like a known-good SJU daily rate.
  const DROP = new Set(['id', 'createdAt', 'updatedAt', 'rateCode', 'name', 'daily', 'displayOnline']);
  const cloneBase = Object.fromEntries(Object.entries(template).filter(([k]) => !DROP.has(k)));
  const itemDrop = new Set(['id', 'createdAt', 'updatedAt', 'rateId', 'vehicleTypeId', 'daily']);
  const itemBase = templateItem ? Object.fromEntries(Object.entries(templateItem).filter(([k]) => !itemDrop.has(k))) : {};

  await prisma.$transaction(async (tx) => {
    for (const p of toPublish) {
      await tx.rate.update({ where: { id: p.rateId }, data: { displayOnline: true } });
      console.log(`  published ${p.acriss} ${p.rateCode} @ ${money(p.itemDaily)}`);
    }
    for (const c of toCreate) {
      const rate = await tx.rate.create({
        data: { ...cloneBase, rateCode: c.rateCode, name: `${c.className} Daily`, daily: c.daily, displayOnline: true },
      });
      await tx.rateItem.create({ data: { ...itemBase, rateId: rate.id, vehicleTypeId: c.vehicleTypeId, daily: c.daily } });
      console.log(`  created ${c.acriss} ${c.rateCode} @ ${money(c.daily)} (${c.className})`);
    }
  });

  // ---- Post-verify -----------------------------------------------------------
  console.log('\n=== VERIFY: online rates at SJU after apply ===');
  const online = await prisma.rate.findMany({
    where: { ...scope, displayOnline: true },
    select: { rateCode: true, daily: true, rateItems: { select: { daily: true, vehicleType: { select: { code: true } } } } },
    orderBy: { rateCode: 'asc' },
  });
  for (const r of online) {
    const it = r.rateItems.map((i) => `${i.vehicleType?.code}=${money(i.daily)}`).join(', ');
    console.log(`  ${r.rateCode.padEnd(16)} header ${money(r.daily)}  item[${it}]`);
  }
  console.log(`\n${online.length} rates now online at SJU.`);
  console.log('Next: GET /api/quotes/preview for SJU — each class must return its OWN price (CFAR ~$43.69) with pricingSource LOCATION.\n');
}

main()
  .catch((e) => { console.error('FAILED:', e); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
