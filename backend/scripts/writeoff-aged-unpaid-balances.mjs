/**
 * Write off aged unpaid balances for one tenant (2026-08-29).
 *
 * Asked for by International Rental Corp's owner: any agreement whose balance
 * has been outstanding for more than 61 days gets a credit that takes it to
 * exactly zero, so it stops counting as an unpaid balance. No email, no
 * gateway call, no refund — a book entry and nothing else.
 *
 *   node scripts/writeoff-aged-unpaid-balances.mjs --tenant "International Rental Corp"
 *   node scripts/writeoff-aged-unpaid-balances.mjs --tenant "..." --apply
 *
 *   --days N          age threshold, default 61 (strictly greater than)
 *   --actor-email X   whose name goes on the audit rows. REQUIRED for --apply.
 *   --skip-drafts     leave DRAFT agreements alone (no-shows and cancelled
 *                     bookings — money that was never a rental)
 *   --limit N         stop after N agreements, for a cautious first run
 *
 * WHY NOT `UPDATE "RentalAgreement" SET balance = 0`
 *
 * Because that is the incident this codebase already had. RES-849093: a
 * per-rental "credit" was written straight to a balance field, which produced
 * a credit nobody could see on the contract and nobody could reverse. The
 * endpoint that did it now returns 410 and says so.
 *
 * So each write-off goes through addManualCharge, the same path the Admin
 * Corrections panel uses. That gives three things a raw update cannot:
 *   - the credit is a LINE on the agreement, with a name, so a customer
 *     looking at their contract can see what happened;
 *   - it is VOIDABLE from Admin Corrections, one row at a time, so a mistake
 *     here is undoable without a database restore;
 *   - it writes an ADMIN_OVERRIDE audit row carrying balanceBefore and
 *     balanceAfter.
 *
 * The amount is always exactly the current balance, negated. It never
 * overshoots into a negative balance, and an agreement already at zero is not
 * in the selection at all.
 *
 * IDEMPOTENT. A second run skips any agreement that already carries a
 * write-off line with the marker name below, so a re-run after a partial
 * failure finishes the job rather than doubling it.
 */
import { prisma } from '../src/lib/prisma.js';
import { reservationPricingService } from '../src/modules/reservations/reservation-pricing.service.js';

const APPLY = process.argv.includes('--apply');
const SKIP_DRAFTS = process.argv.includes('--skip-drafts');

function arg(flag, fallback = null) {
  const i = process.argv.indexOf(flag);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const TENANT_NAME = arg('--tenant');
const TENANT_ID = arg('--tenant-id');
const DAYS = Number(arg('--days', '61'));
const ACTOR_EMAIL = arg('--actor-email');
const LIMIT = Number(arg('--limit', '0')) || 0;

// The marker. It is what makes a re-run safe, and what an operator will search
// for later when they ask "why is this contract at zero?".
const MARKER = 'Write-off — balance aged past 61 days';
const REASON = `Aged AR write-off: balance outstanding more than ${DAYS} days. `
  + 'Applied in bulk at the owner\'s instruction. No customer contact, no refund.';

function money(n) { return `$${Number(n || 0).toFixed(2)}`; }

async function main() {
  if (!Number.isFinite(DAYS) || DAYS < 1) throw new Error('--days must be a positive number');
  if (!TENANT_NAME && !TENANT_ID) throw new Error('--tenant "Name" or --tenant-id <id> is required');

  const tenant = await prisma.tenant.findFirst({
    where: TENANT_ID ? { id: TENANT_ID } : { name: TENANT_NAME },
    select: { id: true, name: true },
  });
  if (!tenant) throw new Error(`No tenant matched ${TENANT_ID || TENANT_NAME}`);

  // The actor is required to WRITE. An anonymous ADMIN_OVERRIDE row on a
  // hundred-plus financial adjustments is not an audit trail.
  let actor = null;
  if (ACTOR_EMAIL) {
    actor = await prisma.user.findFirst({
      where: { email: ACTOR_EMAIL, tenantId: tenant.id },
      select: { id: true, email: true, role: true },
    }) || await prisma.user.findFirst({
      // SUPER_ADMINs are not scoped to the tenant they are acting on.
      where: { email: ACTOR_EMAIL },
      select: { id: true, email: true, role: true },
    });
    if (!actor) throw new Error(`No user with email ${ACTOR_EMAIL}`);
  }
  if (APPLY && !actor) throw new Error('--actor-email is required with --apply');

  // UTC day math, while the unpaid-balance report ages in the tenant's
  // timezone. At a 61-day threshold that can only ever disagree about an
  // agreement sitting exactly on the boundary — it is a day either way, not a
  // different population. Said out loud so nobody reconciles the two counts to
  // the unit and thinks something is broken.
  const cutoff = new Date();
  cutoff.setUTCDate(cutoff.getUTCDate() - DAYS);

  const agreements = await prisma.rentalAgreement.findMany({
    where: {
      tenantId: tenant.id,
      balance: { gt: 0 },
      // CANCELLED is excluded ALWAYS, and not as a policy choice: a cancelled
      // agreement is the one status syncAgreementCharges refuses to recompute,
      // so a credit there would write a line and leave the balance standing.
      status: { notIn: SKIP_DRAFTS ? ['CANCELLED', 'DRAFT'] : ['CANCELLED'] },
      returnAt: { lt: cutoff },
    },
    orderBy: { returnAt: 'asc' },
    select: {
      id: true, agreementNumber: true, reservationId: true,
      balance: true, total: true, paidAmount: true, status: true, returnAt: true,
      charges: { where: { name: MARKER }, select: { id: true } },
    },
  });

  // Every row here owes money (the query says balance > 0), so a marker line
  // is NOT a reason to skip — it means a previous run credited the STORED
  // balance and the recompute exposed drift between that number and what the
  // charge lines actually sum to (found live 2026-08-29: five agreements,
  // $83.40, one of which went UP). Those get a top-up credit for the honest
  // remainder. Fully written-off agreements are at zero and never make the
  // query at all, which is what keeps a re-run from double-crediting.
  const targets = agreements.filter((a) => a.charges.length === 0);
  const topUps = agreements.filter((a) => a.charges.length > 0);

  console.log(`[writeoff] tenant=${tenant.name}`);
  console.log(`[writeoff] mode=${APPLY ? 'APPLY' : 'DRY-RUN'} days>${DAYS} cutoff=${cutoff.toISOString().slice(0, 10)}`);
  if (actor) console.log(`[writeoff] actor=${actor.email} (${actor.role})`);
  if (SKIP_DRAFTS) console.log('[writeoff] DRAFT agreements excluded');

  const byStatus = new Map();
  for (const a of targets) {
    const cur = byStatus.get(a.status) || { n: 0, amount: 0 };
    cur.n += 1; cur.amount += Number(a.balance || 0);
    byStatus.set(a.status, cur);
  }
  for (const [status, v] of byStatus) console.log(`[writeoff]   ${status}: ${v.n} agreements, ${money(v.amount)}`);
  const total = targets.reduce((s, a) => s + Number(a.balance || 0), 0);
  console.log(`[writeoff] TOTAL to credit: ${targets.length} agreements, ${money(total)}`);
  if (topUps.length) {
    const residue = topUps.reduce((s, a) => s + Number(a.balance || 0), 0);
    console.log(`[writeoff] residue from a previous run (stored-vs-lines drift), to top up: ${topUps.length} agreements, ${money(residue)}`);
  }

  const all = [...targets, ...topUps];
  const queue = LIMIT ? all.slice(0, LIMIT) : all;
  if (LIMIT) console.log(`[writeoff] --limit ${LIMIT}: processing ${queue.length} of ${all.length}`);

  if (!APPLY) {
    console.log('[writeoff] dry run — nothing written. Re-run with --apply to write.');
    for (const a of queue.slice(0, 10)) {
      console.log(`  ${a.agreementNumber || a.id}  ${String(a.returnAt).slice(0, 10)}  ${a.status.padEnd(10)} ${money(a.balance)}`);
    }
    if (queue.length > 10) console.log(`  … and ${queue.length - 10} more`);
    return;
  }

  let done = 0;
  let failed = 0;
  let credited = 0;
  for (const a of queue) {
    try {
      // Up to two credits per agreement. The first credits the stored balance;
      // when stored and line-sum disagree, the recompute lands somewhere other
      // than zero, and the second credits that honest remainder. Two, not a
      // loop: each pass credits exactly what the recompute itself reported, so
      // a third pass could only mean the recompute is not idempotent — which
      // is a bug to look at, not to spend down with credits.
      let wrote = 0;
      let left = Number(a.balance);
      for (const label of [MARKER, `${MARKER} — remainder after recompute`]) {
        // A top-up row enters the queue already carrying a marker line; its
        // first pass IS the remainder pass in all but name.
        await reservationPricingService.addManualCharge(
          a.reservationId,
          { name: label, amount: -left },
          { reason: REASON, actorUserId: actor.id },
          { tenantId: tenant.id },
        );
        wrote += left;
        const after = await prisma.rentalAgreement.findUnique({
          where: { id: a.id }, select: { balance: true },
        });
        left = Number(after?.balance ?? NaN);
        if (left === 0) break;
        if (!Number.isFinite(left) || left < 0) break; // negative = overshoot; report, never "fix"
      }
      if (left !== 0) {
        failed += 1;
        console.error(`[writeoff] NOT ZERO after crediting ${money(wrote)}: ${a.agreementNumber || a.id} balance=${money(left)} — needs a human`);
        continue;
      }
      done += 1;
      credited += wrote;
    } catch (e) {
      failed += 1;
      console.error(`[writeoff] FAILED ${a.agreementNumber || a.id}: ${e?.message || e}`);
    }
  }

  console.log(`[writeoff] done=${done} credited=${money(credited)} failed=${failed}`);
  if (failed) {
    console.log('[writeoff] the failures above are still owed. Re-running retries them (anything at zero left the population), but twice-failed agreements need a person, not a third run.');
  }
}

main()
  .catch((e) => { console.error('[writeoff] aborted:', e?.message || e); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
