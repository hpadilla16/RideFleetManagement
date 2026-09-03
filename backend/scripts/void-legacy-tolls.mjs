/**
 * Void legacy tolls for one tenant (2026-09-03).
 *
 * Asked for by Rent & Go: their tolls from July and earlier belong to rentals
 * that lived in their OLD system, so RFM can never attribute them to an RFM
 * reservation and they sit in the review queue forever.
 *
 *   node scripts/void-legacy-tolls.mjs --tenant "Rent & Go by VPH Motors"
 *   node scripts/void-legacy-tolls.mjs --tenant "..." --apply --actor-email x@y.com
 *
 *   --before YYYY-MM-DD   void tolls with transactionAt STRICTLY BEFORE this.
 *                         Default 2026-08-01 (= "July and earlier").
 *   --include-billed      ALSO void tolls already posted to a reservation.
 *                         OFF by default — see the warning below.
 *   --limit N             stop after N tolls, for a cautious first run.
 *
 * WHAT IT DOES, AND WHY NOT DELETE
 *
 * It does exactly what the Admin Corrections "Mark not billable" button does:
 *   status = VOID, billingStatus = WAIVED, needsReview = false,
 *   any live TollAssignment rejected, and a note saying who did it and why.
 *
 * That status is not cosmetic: tolls.service.js excludes VOID rows from every
 * re-match sweep (RES-849093 FIX 2a), so a voided toll never comes back to
 * haunt the queue. And unlike a DELETE, the row survives — the provider
 * charged real money for these crossings, the tenant can still reconcile
 * against the provider statement, and a mistake here is reversible by hand.
 * A deleted toll is only recoverable from a database restore.
 *
 * THE --include-billed WARNING
 *
 * A toll with billingStatus POSTED_TO_RESERVATION was already charged to a
 * customer's contract. Voiding the toll row does NOT remove that charge line
 * from the agreement — the charge lives on the reservation and must be voided
 * from Admin Corrections if it is genuinely wrong. So --include-billed leaves
 * the books and the toll ledger disagreeing unless a human handles the
 * charges too. The dry run always prints the affected reservations so that
 * decision is made with the list in hand, not blind.
 *
 * IDEMPOTENT. Rows already VOID are not in the selection, so a re-run after a
 * partial failure finishes the job rather than doubling anything.
 */
import { prisma } from '../src/lib/prisma.js';

const APPLY = process.argv.includes('--apply');
const INCLUDE_BILLED = process.argv.includes('--include-billed');

function arg(flag, fallback = null) {
  const i = process.argv.indexOf(flag);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const TENANT_NAME = arg('--tenant');
const TENANT_ID = arg('--tenant-id');
const BEFORE = arg('--before', '2026-08-01');
const ACTOR_EMAIL = arg('--actor-email');
const LIMIT = Number(arg('--limit', '0')) || 0;

// The marker. It is what an operator will search for later when they ask
// "why is this toll voided?", and it names the reason, not just the action.
const NOTE = 'Voided — pre-RFM toll (rental lived in the previous system)';

function money(n) { return Number(n || 0).toFixed(2); }

async function main() {
  if (!TENANT_NAME && !TENANT_ID) {
    throw new Error('Pass --tenant "<name>" or --tenant-id <id>.');
  }
  const cutoff = new Date(`${BEFORE}T00:00:00.000Z`);
  if (Number.isNaN(cutoff.getTime())) throw new Error(`--before is not a date: ${BEFORE}`);

  const tenant = await prisma.tenant.findFirst({
    where: TENANT_ID ? { id: TENANT_ID } : { name: TENANT_NAME },
    select: { id: true, name: true }
  });
  if (!tenant) throw new Error(`Tenant not found: ${TENANT_ID || TENANT_NAME}`);

  let actor = null;
  if (ACTOR_EMAIL) {
    actor = await prisma.user.findFirst({
      where: { email: ACTOR_EMAIL, tenantId: tenant.id },
      select: { id: true, email: true }
    });
    if (!actor) throw new Error(`No user ${ACTOR_EMAIL} in ${tenant.name}`);
  }
  if (APPLY && !actor) throw new Error('--apply requires --actor-email (the audit rows need a name).');

  // VOID is excluded: those are already done, which is what makes a re-run safe.
  const where = {
    tenantId: tenant.id,
    transactionAt: { lt: cutoff },
    status: { not: 'VOID' },
    ...(INCLUDE_BILLED ? {} : { billingStatus: { notIn: ['POSTED_TO_RESERVATION', 'POSTED_TO_AGREEMENT'] } })
  };

  const rows = await prisma.tollTransaction.findMany({
    where,
    select: {
      id: true, transactionAt: true, amount: true, status: true, billingStatus: true,
      reservationId: true, plateRaw: true
    },
    orderBy: { transactionAt: 'asc' },
    ...(LIMIT ? { take: LIMIT } : {})
  });

  const total = rows.reduce((s, r) => s + Number(r.amount || 0), 0);
  const byStatus = new Map();
  for (const r of rows) {
    const k = `${r.status}/${r.billingStatus}`;
    const cur = byStatus.get(k) || { n: 0, amount: 0 };
    cur.n += 1; cur.amount += Number(r.amount || 0);
    byStatus.set(k, cur);
  }
  const postedReservations = [...new Set(rows.filter((r) => r.reservationId).map((r) => r.reservationId))];

  console.log(`\nTenant:        ${tenant.name}`);
  console.log(`Cutoff:        transactionAt < ${BEFORE}`);
  console.log(`Billed rows:   ${INCLUDE_BILLED ? 'INCLUDED (--include-billed)' : 'excluded (default)'}`);
  console.log(`Selected:      ${rows.length} tolls, $${money(total)}`);
  for (const [k, v] of [...byStatus.entries()].sort()) {
    console.log(`  ${k.padEnd(34)} ${String(v.n).padStart(6)}  $${money(v.amount)}`);
  }
  if (postedReservations.length) {
    console.log(`\n  ⚠ ${postedReservations.length} reservation(s) carry these tolls. Voiding the toll does`);
    console.log(`    NOT remove the charge already posted to those contracts:`);
    console.log(`    ${postedReservations.slice(0, 40).join(' ')}${postedReservations.length > 40 ? ' …' : ''}`);
  }
  if (!APPLY) {
    console.log(`\nDRY RUN — nothing written. Re-run with --apply --actor-email <email> to void.\n`);
    return;
  }

  let done = 0; let failed = 0;
  for (const row of rows) {
    try {
      await prisma.$transaction(async (tx) => {
        await tx.tollAssignment.updateMany({
          where: { tollTransactionId: row.id, status: { in: ['SUGGESTED', 'AUTO_CONFIRMED', 'CONFIRMED'] } },
          data: { status: 'REJECTED' }
        });
        await tx.tollTransaction.update({
          where: { id: row.id },
          data: { status: 'VOID', billingStatus: 'WAIVED', needsReview: false, reviewNotes: NOTE }
        });
        // AuditLog.reservationId is required, so only reservation-anchored rows
        // get an audit entry; the rest are traceable by the note above.
        if (row.reservationId) {
          await tx.auditLog.create({
            data: {
              tenantId: tenant.id,
              reservationId: row.reservationId,
              actorUserId: actor.id,
              action: 'UPDATE',
              metadata: JSON.stringify({
                tollReviewAction: 'MARK_NOT_BILLABLE',
                tollTransactionId: row.id,
                amount: money(row.amount),
                script: 'void-legacy-tolls',
                note: NOTE
              })
            }
          });
        }
      });
      done += 1;
    } catch (e) {
      failed += 1;
      console.error(`  FAILED ${row.id}: ${e?.message || e}`);
    }
  }
  console.log(`\nVoided ${done} toll(s), $${money(total)}. Failed: ${failed}.\n`);
}

main()
  .catch((e) => { console.error(e?.message || e); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
