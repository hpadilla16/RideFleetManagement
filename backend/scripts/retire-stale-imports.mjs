/**
 * Retire staged imports nobody can act on any more.
 *
 * Hector, 2026-09-08: "no quiero contabilidad, las quiero sacar y ya."
 *
 * THE POPULATION. A booking arrives from a franchise portal, fails a promotion
 * gate (no customer, unmapped class), and waits in MANUAL_REVIEW for a human.
 * Then its pickup date passes. The source stops returning it, so no sweep ever
 * re-evaluates it, and it sits in the review tray for ever. Measured 2026-09-08:
 * 1,130 such rows against 66 that were actually still actionable — the tray was
 * 94% noise, which is the same as having no tray.
 *
 * WHAT THIS DOES NOT DO, DELIBERATELY. It does not promote them. We do not know
 * what happened to any of these bookings: the renter may have been served at the
 * counter through another system, may never have shown up, or may have cancelled
 * without us hearing. Creating a CONFIRMED reservation with a pickup date in the
 * past would assert one of those, pollute the dashboard, and trip the
 * overdue-vehicle alerts. Any other status asserts something equally unknown.
 * So the row keeps every field it has and simply stops claiming it needs review.
 *
 * REVERSIBLE. Nothing is deleted and no Reservation is touched. Undo is a single
 * UPDATE back to MANUAL_REVIEW filtered on rejectedReason.
 *
 *   node scripts/retire-stale-imports.mjs                  # dry run (default)
 *   node scripts/retire-stale-imports.mjs --apply
 *   node scripts/retire-stale-imports.mjs --grace-hours 72
 *   node scripts/retire-stale-imports.mjs --tenant <id>
 */
import { prisma } from '../src/lib/prisma.js';

export const RETIRED_REASON = 'stale_past_pickup';

/** Hours a pickup must be PAST before the row counts as unactionable. */
const DEFAULT_GRACE_HOURS = 24;

function flag(name, fallback = null) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

async function main() {
  const apply = process.argv.includes('--apply');
  const graceHours = Number(flag('--grace-hours', DEFAULT_GRACE_HOURS));
  const tenantId = flag('--tenant', null);
  if (!Number.isFinite(graceHours) || graceHours < 0) throw new Error('--grace-hours must be a non-negative number');

  // The grace window is the whole safety margin. A pickup two hours ago may
  // still be a late walk-in the counter is waiting on; one from last week is
  // not. Without it this would sweep away bookings for people standing at the
  // desk right now.
  const cutoff = new Date(Date.now() - graceHours * 3600 * 1000);

  const where = {
    promotionStatus: 'MANUAL_REVIEW',
    pickupAt: { lt: cutoff },
    // Belt and braces: a row that already produced a live Reservation is not a
    // stale import, whatever its staged status says.
    promotedToReservationId: null,
    ...(tenantId ? { tenantId } : {}),
  };

  const rows = await prisma.externalReservation.findMany({
    where,
    select: { id: true, tenantId: true, sourceSystem: true, needsReviewReason: true, pickupAt: true },
  });

  const tenants = new Map(
    (await prisma.tenant.findMany({ select: { id: true, name: true } })).map((t) => [t.id, t.name]),
  );

  const grouped = new Map();
  for (const r of rows) {
    const key = `${tenants.get(r.tenantId) || r.tenantId} | ${r.sourceSystem} | ${r.needsReviewReason}`;
    grouped.set(key, (grouped.get(key) || 0) + 1);
  }

  console.log(`cutoff: pickup before ${cutoff.toISOString()} (${graceHours}h grace)`);
  console.log(`${apply ? 'RETIRING' : 'would retire'} ${rows.length} staged rows\n`);
  for (const [key, n] of [...grouped.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${key.padEnd(56)} ${n}`);
  }

  // What is LEFT in the tray afterwards — the number that says whether this
  // actually bought anything.
  const remaining = await prisma.externalReservation.count({
    where: { promotionStatus: 'MANUAL_REVIEW', ...(tenantId ? { tenantId } : {}) },
  });
  console.log(`\nreview tray now: ${remaining}  ->  after: ${remaining - rows.length}`);

  if (!apply) {
    console.log('\n(dry run — pass --apply to write)');
    return;
  }

  let written = 0;
  const ids = rows.map((r) => r.id);
  for (let i = 0; i < ids.length; i += 500) {
    const res = await prisma.externalReservation.updateMany({
      // The status guard is repeated in the WHERE, not just the plan: between
      // the read above and this write a sweep may have promoted one of them.
      where: { id: { in: ids.slice(i, i + 500) }, promotionStatus: 'MANUAL_REVIEW' },
      data: {
        promotionStatus: 'REJECTED',
        rejectedReason: RETIRED_REASON,
        rejectedAt: new Date(),
        needsReviewReason: null,
      },
    });
    written += res.count;
  }
  console.log(`\nRETIRED ${written}`);
  console.log(`undo: set promotionStatus back to MANUAL_REVIEW where rejectedReason = '${RETIRED_REASON}'`);
}

main()
  .catch((err) => { console.error(err); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
