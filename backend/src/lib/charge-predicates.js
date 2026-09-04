/**
 * Charge-row predicates — PURE, no prisma, no network.
 *
 * WHY THIS FILE EXISTS (2026-09-04, Level 3 line items). `isDepositCharge()`
 * had been copy-pasted into three services (reservation-extend.service.js:93,
 * reservation-pricing.service.js:282, rental-agreements.service.js:1416). The
 * Level 3 builder needs the SAME predicate — a deposit that leaks into an L3
 * line item is double-counted money on the wire, because deposits ride the
 * separate PreAuth hold and are excluded from agreement total/balance.
 *
 * design/mockups/us-terminal-checkout-NOTES.md §5 gap 7 is explicit about it:
 * "the L3 builder must reuse that predicate rather than re-implement it." A
 * fourth copy is how the definitions drift apart. But the L3 builder must stay
 * pure (unit-testable with no DB), and every existing home imports prisma — so
 * the canonical implementation moved HERE, and reservation-extend.service.js
 * re-exports it so its published symbol is literally this function object.
 *
 * The two remaining private copies (pricing + rental-agreements) are byte-equal
 * and deliberately left alone; collapsing them is a separate change with its
 * own blast radius.
 *
 * History carried forward verbatim:
 *   2026-05-23 (doc/round-26-followups-2026-05-23.md §10) — the deposit
 *     double-charge. The wizard totalled $89.20 but submitted $339.20 because
 *     the SALE summed every selected charge row including the $250 security
 *     deposit, which was ALSO being held as a separate AUTH. Three signals are
 *     checked (chargeType / source / name) because production carries legacy
 *     rows where source and code are both null.
 *   2026-06-06 — widened from SECURITY_DEPOSIT only to ALL deposit rows
 *     ("Deposit Due" was leaking into total and inflated balance on 100+
 *     agreements).
 */

/** Security deposit specifically (not "deposit due now"). */
export function isSecurityDepositCharge(row = {}) {
  const source = String(row?.source || '').trim().toUpperCase();
  const name = String(row?.name || '').trim().toUpperCase();
  return source === 'SECURITY_DEPOSIT' || name === 'SECURITY DEPOSIT';
}

/**
 * ALL deposit charges (Deposit Due + Security Deposit, both chargeType
 * DEPOSIT) — excluded from agreement subtotal/total/balance, and excluded
 * from Level 3 line items entirely.
 */
export function isDepositCharge(row = {}) {
  const type = String(row?.chargeType || '').trim().toUpperCase();
  const source = String(row?.source || '').trim().toUpperCase();
  const name = String(row?.name || '').trim().toUpperCase();
  return type === 'DEPOSIT'
    || source === 'DEPOSIT_DUE'
    || source === 'SECURITY_DEPOSIT'
    || name === 'SECURITY DEPOSIT'
    || name === 'DEPOSIT (DUE NOW)';
}

/**
 * The synthesized tax row. RFM models tax as ONE row (chargeType 'TAX'), not
 * per line — see autorental-l3.builder.js for what that costs the L3 mapping.
 */
export function isTaxCharge(row = {}) {
  return String(row?.chargeType || '').trim().toUpperCase() === 'TAX';
}
