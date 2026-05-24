#!/usr/bin/env node
/**
 * audit-commissions.mjs
 *
 * Diagnostic: figure out why AgreementCommission rows aren't being created
 * for some closed agreements. Runs the same three gates that
 * syncAgreementCommissionSnapshot() applies and reports how many agreements
 * fail each one.
 *
 * Run:
 *   node backend/scripts/audit-commissions.mjs [--tenantId=<id>]
 *
 * Output: a plain-text report grouped by gate, with counts and a few sample
 * agreement IDs for spot-checking.
 */

import { prisma } from '../src/lib/prisma.js';

function parseArgs(argv) {
  const out = {};
  for (const a of argv.slice(2)) {
    const m = a.match(/^--([^=]+)=(.*)$/);
    if (m) out[m[1]] = m[2];
    else if (a.startsWith('--')) out[a.slice(2)] = true;
  }
  return out;
}

function fmtMoney(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return '$0.00';
  return `$${v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

async function main() {
  const args = parseArgs(process.argv);
  const tenantFilter = args.tenantId ? { tenantId: args.tenantId } : {};
  const tenantNote = args.tenantId ? ` (tenant ${args.tenantId})` : ' (all tenants)';

  console.log(`\n=== Commission registration audit${tenantNote} ===\n`);

  // 1. Agreement status distribution
  const byStatus = await prisma.rentalAgreement.groupBy({
    by: ['status'],
    where: tenantFilter,
    _count: { id: true },
  });
  console.log('1. RentalAgreement status distribution');
  for (const row of byStatus.sort((a, b) => b._count.id - a._count.id)) {
    console.log(`   ${String(row.status).padEnd(22)} ${row._count.id}`);
  }
  const closedCount = byStatus.find((r) => r.status === 'CLOSED')?._count.id || 0;
  console.log(`   → ${closedCount} CLOSED agreement${closedCount === 1 ? '' : 's'} are eligible for commission.\n`);

  // 2. Commission rows vs closed agreements
  const commissionTotal = await prisma.agreementCommission.count({ where: tenantFilter });
  const zeroDollarRows = await prisma.agreementCommission.count({
    where: { ...tenantFilter, commissionAmount: { equals: 0 } },
  });
  console.log('2. AgreementCommission row counts');
  console.log(`   CLOSED agreements:       ${closedCount}`);
  console.log(`   Commission rows total:   ${commissionTotal}`);
  console.log(`   ↳ zero-dollar rows:      ${zeroDollarRows}`);
  console.log(`   ↳ implied gap:           ${Math.max(0, closedCount - commissionTotal)} closed agreements with no commission row\n`);

  // 3. Closed agreements with no salesOwnerUserId AND no actor on CHECKOUT inspection
  const closedAgreements = await prisma.rentalAgreement.findMany({
    where: { ...tenantFilter, status: 'CLOSED' },
    select: {
      id: true,
      agreementNumber: true,
      salesOwnerUserId: true,
      inspections: {
        where: { phase: 'CHECKOUT', actorUserId: { not: null } },
        select: { actorUserId: true },
        take: 1,
      },
    },
  });

  const noOwnerNoActor = closedAgreements.filter(
    (a) => !a.salesOwnerUserId && a.inspections.length === 0,
  );
  console.log('3. Gate 2 — no commissionEmployeeUserId resolvable');
  console.log(`   Closed agreements with NEITHER salesOwnerUserId NOR a CHECKOUT inspection actor:  ${noOwnerNoActor.length}`);
  if (noOwnerNoActor.length > 0) {
    console.log('   Sample agreements:');
    for (const a of noOwnerNoActor.slice(0, 5)) {
      console.log(`     ${(a.agreementNumber || a.id).padEnd(20)}  id=${a.id}`);
    }
  }
  console.log('');

  // 4. Closed agreements whose resolved employee can't be looked up (gate 3)
  const candidatesWithEmployee = closedAgreements
    .map((a) => ({
      id: a.id,
      agreementNumber: a.agreementNumber,
      resolved: (a.inspections[0]?.actorUserId || a.salesOwnerUserId || '').trim(),
    }))
    .filter((a) => a.resolved);

  const resolvedIds = Array.from(new Set(candidatesWithEmployee.map((a) => a.resolved)));
  const users = resolvedIds.length
    ? await prisma.user.findMany({
        where: { id: { in: resolvedIds }, ...tenantFilter },
        select: { id: true },
      })
    : [];
  const userIdSet = new Set(users.map((u) => u.id));
  const missingUsers = candidatesWithEmployee.filter((a) => !userIdSet.has(a.resolved));
  console.log('4. Gate 3 — resolved employee not found in tenant');
  console.log(`   Closed agreements where the resolved actor/owner is NOT a User in this tenant:  ${missingUsers.length}`);
  if (missingUsers.length > 0) {
    console.log('   Sample agreements (with the user-id that failed lookup):');
    for (const a of missingUsers.slice(0, 5)) {
      console.log(`     ${(a.agreementNumber || a.id).padEnd(20)}  attempted-userId=${a.resolved}`);
    }
  }
  console.log('');

  // 5. Commission plan presence
  const activePlanCount = await prisma.commissionPlan.count({
    where: { ...tenantFilter, isActive: true },
  });
  const activeRulesCount = await prisma.commissionRule.count({
    where: { ...tenantFilter, isActive: true },
  });
  console.log('5. Commission plan + rule presence');
  console.log(`   Active commission plans: ${activePlanCount}`);
  console.log(`   Active commission rules: ${activeRulesCount}`);
  if (activePlanCount === 0) {
    console.log('   ⚠ No active commission plan — every snapshot will be $0.00.');
  } else if (activeRulesCount === 0) {
    console.log('   ⚠ Plans exist but no active rules — every snapshot will be $0.00.');
  }
  console.log('');

  // 6. Recently calculated commissions (sanity check the trigger is firing)
  const recent = await prisma.agreementCommission.findMany({
    where: tenantFilter,
    select: { id: true, calculatedAt: true, commissionAmount: true, status: true, employeeUserId: true, rentalAgreementId: true },
    orderBy: { calculatedAt: 'desc' },
    take: 5,
  });
  console.log('6. Most-recent 5 AgreementCommission rows');
  if (recent.length === 0) {
    console.log('   (none)');
  } else {
    for (const r of recent) {
      console.log(`   ${r.calculatedAt.toISOString().slice(0, 19).replace('T', ' ')}  ${String(r.status).padEnd(8)}  ${fmtMoney(r.commissionAmount).padStart(10)}  emp=${r.employeeUserId}`);
    }
  }
  console.log('');

  // Summary
  console.log('=== Summary ===');
  const explanation = [];
  if (closedCount === 0) {
    explanation.push('No CLOSED agreements exist — commission trigger will never fire. Check whether your close flow is actually setting status=CLOSED (vs FINALIZED).');
  } else if (commissionTotal < closedCount) {
    const gap = closedCount - commissionTotal;
    explanation.push(`${gap} closed agreement${gap === 1 ? '' : 's'} ${gap === 1 ? 'is' : 'are'} missing a commission row.`);
    if (noOwnerNoActor.length > 0) {
      explanation.push(`  • ${noOwnerNoActor.length} fail gate 2 (no actor/owner).`);
    }
    if (missingUsers.length > 0) {
      explanation.push(`  • ${missingUsers.length} fail gate 3 (resolved actor not a tenant user).`);
    }
    const unexplained = gap - noOwnerNoActor.length - missingUsers.length;
    if (unexplained > 0) {
      explanation.push(`  • ${unexplained} unexplained — likely a code path that closes agreements without calling syncAgreementCommissionSnapshot.`);
    }
  } else if (zeroDollarRows > commissionTotal * 0.5) {
    explanation.push(`Half or more of commission rows are $0 — the rule engine isn't matching your charges. Confirm CommissionPlan.rules cover your actual charge codes/names.`);
  } else {
    explanation.push('Commission registration looks healthy. ✓');
  }
  for (const line of explanation) console.log(line);
  console.log('');
}

main()
  .catch((err) => {
    console.error('Audit failed:', err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
