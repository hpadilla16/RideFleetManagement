#!/usr/bin/env node
/**
 * Repair deposit-inflated agreement balances (deposit-balance bug, 2026-06-06).
 *
 * Recomputes RentalAgreement.total/balance/paidAmount the SAME way the code fix
 * does, from the ACTUAL charges:
 *   total      = sum of selected charges where chargeType != 'DEPOSIT'
 *   paidAmount = sum of PAID payments where method != 'AUTH_HOLD' (real money)
 *   balance    = max(0, total - paidAmount)
 * Deposit charge ROWS are left untouched (kept for the record). subtotal/fees
 * are left as-is and self-heal on the next code-driven sync; this script only
 * fixes the money-critical fields (total / paidAmount / balance).
 *
 * Computing total from real charges (NOT stored_total - deposit) is important:
 * a few agreements have a deposit charge LARGER than their stored total (the
 * deposit was never in the total), so the naive subtraction would go negative
 * and wipe a real balance. Summing the non-deposit charges is correct in both
 * cases and matches the deployed code exactly.
 *
 * SCOPE (per Hector 2026-06-06): reservation status ACTIVE
 * (CONFIRMED/CHECKED_OUT/CHECKED_IN/CHECKED_IN_UNPAID) + NO_SHOW + CANCELLED.
 * EXCLUDES car-sharing (reservationNumber 'CS-…'), test rows (name has TEST),
 * and penny rows (stored total < $5).
 *
 * SAFETY: DRY-RUN by default (--apply or APPLY=1 to write). Additive — only
 * updates money fields, never deletes charges, clamps balance >= 0, skips
 * CLOSED. Writes an AuditLog row per change. Idempotent. Run AFTER the code fix
 * is deployed and AFTER ops/backup.sh.
 */
import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

const APPLY = process.argv.includes('--apply') || process.env.APPLY === '1';
const m = (n) => '$' + Number(n).toFixed(2);
const round2 = (n) => Number(Number(n).toFixed(2));

const ACTIVE = new Set(['CONFIRMED', 'CHECKED_OUT', 'CHECKED_IN', 'CHECKED_IN_UNPAID']);
const ALLOWED_EXTRA = new Set(['NO_SHOW', 'CANCELLED']);

function eligible(resNo, status, storedTotal) {
  const n = String(resNo || '').toUpperCase();
  if (n === 'TEST' || n.includes('TEST')) return false;   // test rows
  if (n.startsWith('CS-')) return false;                  // car-sharing (separate repo)
  if (Number(storedTotal) < 5) return false;              // penny / junk rows
  return ACTIVE.has(status) || ALLOWED_EXTRA.has(status);
}

const candidates = await prisma.$queryRawUnsafe(`
  WITH dep AS (
    SELECT c."rentalAgreementId" AS aid, SUM(c."total")::numeric(12,2) AS deposit_total
    FROM "RentalAgreementCharge" c
    WHERE c."selected" = true AND c."chargeType" = 'DEPOSIT'
    GROUP BY c."rentalAgreementId"
  )
  SELECT a."id" AS agr_id, a."status" AS agr_status,
         r."reservationNumber" AS res_no, r."status" AS res_status,
         a."total"::numeric(12,2) AS total, a."paidAmount"::numeric(12,2) AS paid,
         a."balance"::numeric(12,2) AS balance,
         COALESCE(dep.deposit_total,0)::numeric(12,2) AS deposit_total
  FROM "RentalAgreement" a
  JOIN "Reservation" r ON r."id" = a."reservationId"
  LEFT JOIN dep ON dep.aid = a."id"
  WHERE COALESCE(dep.deposit_total,0) > 0.01 AND a."balance" > 0.01
    AND ROUND(a."balance" - GREATEST(a."total" - COALESCE(dep.deposit_total,0) - a."paidAmount", 0), 2) > 0.01
  ORDER BY r."status", r."reservationNumber";
`);

let applied = 0, wouldUpdate = 0, skippedBucket = 0, skippedClosed = 0, noChange = 0;
let totalRemoved = 0;
const notes = [];

console.log(`\n=== Deposit balance repair — ${APPLY ? 'APPLY (writing)' : 'DRY-RUN (no writes)'} ===\n`);
console.log(['RES', 'STATUS', 'OLD_TOT', 'OLD_BAL', 'NEW_TOT', 'NEW_PAID', 'NEW_BAL', 'ACTION']
  .map((h, i) => h.padEnd([16, 18, 10, 10, 10, 10, 10, 0][i])).join(''));

for (const c of candidates) {
  const resNo = c.res_no, status = c.res_status;
  if (!eligible(resNo, status, c.total)) { skippedBucket++; continue; }
  if (String(c.agr_status).toUpperCase() === 'CLOSED') { skippedClosed++; continue; }

  // Recompute from ACTUAL charges (matches the code fix): total = all selected
  // non-deposit charges; paid = real (non-AUTH_HOLD) payments.
  const [charges, paidRows] = await Promise.all([
    prisma.rentalAgreementCharge.findMany({
      where: { rentalAgreementId: c.agr_id, selected: true },
      select: { chargeType: true, total: true },
    }),
    prisma.rentalAgreementPayment.findMany({
      where: { rentalAgreementId: c.agr_id, status: 'PAID', method: { not: 'AUTH_HOLD' } },
      select: { amount: true },
    }),
  ]);

  const newTotal = round2(charges
    .filter((x) => String(x.chargeType || '').toUpperCase() !== 'DEPOSIT')
    .reduce((s, x) => s + Number(x.total || 0), 0));
  const newPaid = round2(paidRows.reduce((s, p) => s + Number(p.amount || 0), 0));
  const newBalance = Math.max(0, round2(newTotal - newPaid));

  const oldTotal = Number(c.total), oldBalance = Number(c.balance), oldPaid = Number(c.paid);

  const changed = Math.abs(newTotal - oldTotal) > 0.01
    || Math.abs(newPaid - oldPaid) > 0.01
    || Math.abs(newBalance - oldBalance) > 0.01;
  if (!changed) { noChange++; continue; }

  console.log([
    String(resNo).padEnd(16), String(status).padEnd(18),
    m(oldTotal).padEnd(10), m(oldBalance).padEnd(10),
    m(newTotal).padEnd(10), m(newPaid).padEnd(10), m(newBalance).padEnd(10),
    (APPLY ? 'UPDATED' : 'would update'),
  ].join(''));
  wouldUpdate++;

  if (Math.abs(newPaid - oldPaid) > 0.01) {
    notes.push(`${resNo}: paidAmount ${m(oldPaid)} → ${m(newPaid)} (excluded $${(oldPaid - newPaid).toFixed(2)} of AUTH_HOLD from paid)`);
  }
  if (newPaid - newTotal > 0.01) {
    notes.push(`${resNo}: real paid ${m(newPaid)} > deposit-free total ${m(newTotal)} → possible $${(newPaid - newTotal).toFixed(2)} credit/refund (balance clamped to $0)`);
  }

  if (APPLY) {
    await prisma.$transaction(async (tx) => {
      const fresh = await tx.rentalAgreement.findUnique({
        where: { id: c.agr_id },
        select: { total: true, paidAmount: true, balance: true, status: true },
      });
      if (!fresh || String(fresh.status).toUpperCase() === 'CLOSED') return;
      await tx.rentalAgreement.update({
        where: { id: c.agr_id },
        data: { total: newTotal, paidAmount: newPaid, balance: newBalance },
      });
      await tx.auditLog.create({
        data: {
          actorUserId: null,
          action: 'UPDATE',
          reason: `Deposit-balance repair: recomputed total/paid/balance excluding deposit + AUTH_HOLD (${resNo})`,
          metadata: JSON.stringify({
            script: 'repair-deposit-balances',
            reservationNumber: resNo,
            before: { total: Number(fresh.total), paidAmount: Number(fresh.paidAmount), balance: Number(fresh.balance) },
            after: { total: newTotal, paidAmount: newPaid, balance: newBalance },
          }),
        },
      }).catch(() => {});
    });
    applied++;
  }
  totalRemoved += Math.max(0, round2(oldBalance - newBalance));
}

console.log(`\n=== Summary ===`);
console.log(`  candidates scanned (all buckets): ${candidates.length}`);
console.log(`  ${APPLY ? 'updated' : 'would update'}:           ${APPLY ? applied : wouldUpdate}`);
console.log(`  no change needed:                 ${noChange}`);
console.log(`  skipped (CS-/test/penny bucket):  ${skippedBucket}`);
console.log(`  skipped (CLOSED agreement):       ${skippedClosed}`);
console.log(`  ~balance removed from scope:      ${m(totalRemoved)}`);
if (notes.length) { console.log(`\n  Notes:`); for (const n of notes) console.log(`   - ${n}`); }
console.log(`\n  NOTE: RES-748258 still carries its $9,925 late fee (deposit removed only).`);
console.log(`        Zero the late fee separately.`);
console.log(APPLY ? '\n  DONE (applied).\n' : '\n  Dry-run only. Re-run with --apply to write.\n');

await prisma.$disconnect();
