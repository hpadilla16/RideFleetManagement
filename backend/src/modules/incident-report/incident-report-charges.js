/**
 * §6 Charge Summary math for incident reports — PURE module (no prisma),
 * unit-tested in incident-report-charges.test.mjs.
 *
 * Bug TL-ZE40809640BA (2026-07-02): the agreement keeps ONE aggregated TAX
 * row computed over the WHOLE contract's taxable subtotal. Copying that row
 * into a partial-charge document overstates the incident total — e.g. a $200
 * cleaning fee on an agreement whose earlier (already-paid) lines pushed the
 * aggregated tax to $33.46 rendered "$233.46" instead of $200 + $23.00 =
 * $223.00.
 *
 * Rules:
 *   - TAX and DEPOSIT rows never appear as report lines (the deposit is
 *     already handled separately via depositApplied).
 *   - The tax shown is recomputed as: taxable picked lines × effective rate.
 *     Effective rate = aggregated TAX total ÷ the taxable base it was
 *     computed over; falls back to the "(11.50%)" embedded in the row name.
 *   - Document-only: this never writes charges or balances anywhere.
 *
 * @param {object} params
 * @param {Array}  params.rows           RentalAgreementCharge rows (full objects)
 * @param {Set<string>|null} params.pickedIds  per-report selection (chargeIdsJson), or null for "all selected"
 * @param {number|null} params.depositApplied  deposit applied toward this report's total
 * @returns {{ lines: Array<{name:string,total:number}>, total: number,
 *            depositApplied: number|null, balanceDue: number|null,
 *            feeNames: string[] }}
 */
export function computeChargeSection({ rows = [], pickedIds = null, depositApplied = null }) {
  const typeOf = (c) => String(c?.chargeType || '').toUpperCase();
  const money = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
  const round2 = (n) => Math.round(n * 100) / 100;

  const taxRow = rows.find((c) => typeOf(c) === 'TAX' && c.selected !== false) || null;
  const taxableBase = rows
    .filter((c) => typeOf(c) !== 'TAX' && typeOf(c) !== 'DEPOSIT' && c.selected !== false && c.taxable !== false)
    .reduce((s, c) => s + money(c.total), 0);
  let taxRate = 0;
  if (taxRow) {
    if (taxableBase > 0) taxRate = money(taxRow.total) / taxableBase;
    if (!(taxRate > 0)) {
      const m = /\(([0-9.]+)\s*%\s*\)/.exec(String(taxRow.name || ''));
      if (m) taxRate = Number(m[1]) / 100;
    }
  }

  const picked = rows
    .filter((c) => typeOf(c) !== 'TAX' && typeOf(c) !== 'DEPOSIT')
    .filter((c) => (pickedIds ? pickedIds.has(String(c.id)) : c.selected !== false));

  const feeNames = picked.map((c) => c.name);
  const lines = picked.map((c) => ({ name: c.name, total: money(c.total) }));
  const pickedTaxable = picked
    .filter((c) => c.taxable !== false)
    .reduce((s, c) => s + money(c.total), 0);
  const tax = taxRate > 0 && pickedTaxable > 0 ? round2(pickedTaxable * taxRate) : 0;
  if (tax > 0) lines.push({ name: taxRow?.name || 'Sales Tax', total: tax });

  const total = round2(lines.reduce((s, l) => s + l.total, 0));
  const deposit = depositApplied == null ? null : money(depositApplied);
  const balanceDue = lines.length ? Math.max(0, round2(total - (deposit || 0))) : null;
  return { lines, total, depositApplied: deposit, balanceDue, feeNames };
}
