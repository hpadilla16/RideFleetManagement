#!/usr/bin/env node
/**
 * Backfill CHECKOUT-inspection actorUserId — 2026-06-15.
 *
 * The mobile/tablet checkout flow created the CHECKOUT RentalAgreementInspection
 * WITHOUT an actorUserId (see mobile-inspection.service.js, fixed same day), so
 * counter checkouts done on the tablet had no clerk recorded → commission
 * attribution skipped them entirely (syncAgreementCommissionSnapshot returns
 * null when no CHECKOUT inspection has an actor). The staff user who ran the
 * checkout is still recoverable from the linked CheckoutSession.startedByUserId
 * (verified: 45/45 of the June counter checkouts).
 *
 * This script stamps actorUserId on every CHECKOUT inspection that is missing
 * one, sourced from the agreement's CheckoutSession.startedByUserId. After it
 * runs, re-run the commission snapshot backfill (or let the daily
 * commission-resync sweep do it) so the recovered rentals earn commission.
 *
 * SAFE: dry-run by default (no writes). Apply with --apply. Idempotent — only
 * touches inspections whose actorUserId is currently null AND whose session has
 * a startedByUserId. Optional --tenantId to scope.
 *
 * Usage (inside the droplet container, session port 5432):
 *   docker exec fleet-backend-prod sh -c 'export DATABASE_URL=$(echo "$DATABASE_URL" | sed -e "s/:6543/:5432/" -e "s/[?&]pgbouncer=true//"); node scripts/backfill-checkout-actor.mjs --dry'
 *   docker exec fleet-backend-prod sh -c 'export DATABASE_URL=$(echo "$DATABASE_URL" | sed -e "s/:6543/:5432/" -e "s/[?&]pgbouncer=true//"); node scripts/backfill-checkout-actor.mjs --apply'
 */
import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

function parseArgs(argv) {
  const a = { tenantId: null, apply: false };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--apply') a.apply = true;
    else if (argv[i] === '--dry' || argv[i] === '--dry-run') a.apply = false;
    else if (argv[i] === '--tenantId' && argv[i + 1]) a.tenantId = argv[++i];
  }
  return a;
}

async function main() {
  const { tenantId, apply } = parseArgs(process.argv);
  console.log('──────────────────────────────────────────');
  console.log(' Backfill CHECKOUT inspection actorUserId');
  console.log(`  tenant:  ${tenantId || '(all)'}`);
  console.log(`  mode:    ${apply ? 'APPLY — writes' : 'DRY-RUN — no writes'}`);
  console.log('──────────────────────────────────────────');

  // CHECKOUT inspections missing an actor, whose agreement has a checkout
  // session that knows who started it.
  const inspections = await prisma.rentalAgreementInspection.findMany({
    where: {
      phase: 'CHECKOUT',
      actorUserId: null,
      rentalAgreement: {
        ...(tenantId ? { tenantId } : {}),
        checkoutSessions: { some: { startedByUserId: { not: null } } },
      },
    },
    select: {
      id: true,
      rentalAgreement: {
        select: {
          tenantId: true,
          checkoutSessions: {
            where: { startedByUserId: { not: null } },
            orderBy: { startedAt: 'desc' },
            select: { startedByUserId: true },
          },
        },
      },
    },
  });

  console.log(`\nFound ${inspections.length} CHECKOUT inspections to backfill.\n`);
  let updated = 0;
  const byTenant = {};
  for (const ins of inspections) {
    const actor = ins.rentalAgreement?.checkoutSessions?.[0]?.startedByUserId || null;
    if (!actor) continue;
    const t = ins.rentalAgreement?.tenantId || 'null';
    byTenant[t] = (byTenant[t] || 0) + 1;
    if (apply) {
      await prisma.rentalAgreementInspection.update({ where: { id: ins.id }, data: { actorUserId: actor } });
    }
    updated += 1;
    if (updated % 100 === 0) console.log(`  ${updated} / ${inspections.length}...`);
  }

  console.log('\n── por tenant ──');
  for (const [t, n] of Object.entries(byTenant)) console.log(`  ${t}: ${n}`);
  console.log('──────────────────────────────────────────');
  console.log(` ${apply ? 'updated' : 'would update'}: ${updated}`);
  console.log('──────────────────────────────────────────');
  if (apply) {
    console.log('\nSIGUIENTE: re-correr el commission backfill para que las rentas');
    console.log('recuperadas ganen comisión (o esperar el sweep diario):');
    console.log('  node src/scripts/backfill-commission-snapshots.js');
  }
  await prisma.$disconnect();
}

main().catch((err) => { console.error('Backfill crashed:', err); process.exit(1); });
