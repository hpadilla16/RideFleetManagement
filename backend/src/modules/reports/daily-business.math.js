/**
 * Daily Business Report with Posting — the DECISIONS (pure, no IO).
 *
 * Replaces the report Rent & Go's previous software gave their accounting
 * department (sample: "KENN JULIO 2026", 42 pages). Two things in one
 * document, and the second is the one accounting actually consumes:
 *
 *   1. The daily DETAIL and SUMMARY — what the counter did, per location per
 *      day, in enough depth to tie any figure back to its transaction.
 *   2. The GENERAL LEDGER POSTING — a balanced journal of account numbers,
 *      debits and credits. That is the "with Posting" half. Without it the
 *      report is informative; with it, nobody re-types the entry by hand.
 *
 * THE GROUPING PROBLEM (found in Rent & Go's own data, 2026-08-17). Charges
 * are stored by their display name, and tolls are named per plaza: "Toll
 * Charge - Bayamon Sb 1", "Toll Charge - Buchanan Wb 2" — more than forty
 * distinct names. Mapping accounts name-by-name would produce a forty-line
 * toll section in the journal, which is unusable. The old software collapsed
 * them into one TOLLS line, and so does this: the ledger maps GROUPS, and
 * groupOf() is the single place that decides what belongs together.
 *
 * BALANCE IS A PRECONDITION, NOT A FOOTNOTE. An unbalanced journal breaks an
 * accountant's close, so buildJournal reports `balanced` and the difference
 * rather than quietly emitting a broken entry.
 */

/** Money in, money out — the two sides of every journal line. */
export const DEBIT = 'DEBIT';
export const CREDIT = 'CREDIT';

/**
 * Ledger sections, in the order they print. `nature` is which side of the
 * journal the group lands on: what the company RECEIVED is a debit (cash and
 * deposits are assets), what it EARNED or OWES is a credit.
 */
export const SECTION = Object.freeze({
  TIME: { key: 'TIME', label: 'Time charges', nature: CREDIT, order: 1 },
  MISC: { key: 'MISC', label: 'Miscellaneous charges', nature: CREDIT, order: 2 },
  TAX: { key: 'TAX', label: 'Fees & taxes', nature: CREDIT, order: 3 },
  // A deposit taken is NOT a debit, however much it feels like money in. The
  // cash itself already appears as a receipt (the debit); the deposit is what
  // the company now OWES the customer — a liability, so a credit. Getting
  // this backwards double-counted the cash and left the journal out of
  // balance by exactly twice the deposit, which is how the test caught it.
  DEPOSIT: { key: 'DEPOSIT', label: 'Deposits held', nature: CREDIT, order: 4 },
  RECEIPT: { key: 'RECEIPT', label: 'Receipts', nature: DEBIT, order: 5 },
});

const money = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0;
};
/** Sum in cents, then convert once — floats do not add up to a close. */
export const sumMoney = (values) => money(
  values.reduce((cents, v) => cents + Math.round(money(v) * 100), 0) / 100,
);

const clean = (s) => String(s == null ? '' : s).trim();

/**
 * Which ledger group a charge belongs to.
 *
 * Reads the naming conventions the app already writes ("Service: Road 24/7",
 * "Insurance: CDW", "Fee: Tolls", "Toll Charge - <plaza>") rather than
 * requiring anyone to re-tag their catalog. Anything unrecognised keeps its
 * own name — visible and mappable, never silently swept into an "other" pile
 * where money goes missing.
 */
export function groupOf(charge) {
  const name = clean(charge?.name);
  const type = clean(charge?.chargeType).toUpperCase();

  if (type === 'DEPOSIT') return { section: 'DEPOSIT', key: 'DEPOSIT', label: 'Deposits held' };
  if (type === 'TAX') return { section: 'TAX', key: `TAX:${name}`, label: name || 'Tax' };
  if (type === 'DAILY' || type === 'PERCENT') {
    return { section: 'TIME', key: 'TIME', label: 'Time charges' };
  }

  // UNIT — the mixed bag, and where the forty toll names live.
  if (/^toll charge\b/i.test(name) || /^fee:\s*tolls?$/i.test(name) || /^tolls?$/i.test(name)) {
    return { section: 'MISC', key: 'MISC:TOLLS', label: 'Tolls' };
  }
  const prefixed = name.match(/^(service|insurance|fee|charge)\s*:\s*(.+)$/i);
  if (prefixed) {
    const kind = prefixed[1].toLowerCase();
    const rest = clean(prefixed[2]);
    const label = kind === 'insurance' ? `Insurance - ${rest}`
      : kind === 'service' ? `Service - ${rest}`
        : `Fee - ${rest}`;
    return { section: 'MISC', key: `MISC:${kind.toUpperCase()}:${rest.toUpperCase()}`, label };
  }
  return { section: 'MISC', key: `MISC:${name.toUpperCase()}`, label: name || 'Miscellaneous' };
}

/** Payment methods that are not money in the drawer. */
export const NON_CASH_METHODS = Object.freeze(['AUTH_HOLD']);

/**
 * Roll a day's charges and payments into the summary block the old report
 * printed. `charges` are selected agreement charges; `payments` are settled.
 */
export function summarizeDay({ charges = [], payments = [], discounts = 0 } = {}) {
  const groups = new Map();
  for (const c of charges) {
    const g = groupOf(c);
    const cur = groups.get(g.key) || { ...g, total: 0 };
    cur.total = money(cur.total + money(c.total));
    groups.set(g.key, cur);
  }
  const bySection = (s) => [...groups.values()]
    .filter((g) => g.section === s)
    .sort((a, b) => a.label.localeCompare(b.label));

  const timeTotal = sumMoney(bySection('TIME').map((g) => g.total));
  const misc = bySection('MISC');
  const taxes = bySection('TAX');
  const deposits = sumMoney(bySection('DEPOSIT').map((g) => g.total));

  const receipts = new Map();
  for (const p of payments) {
    if (NON_CASH_METHODS.includes(clean(p?.method).toUpperCase())) continue;
    const method = clean(p?.method).toUpperCase() || 'OTHER';
    receipts.set(method, money((receipts.get(method) || 0) + money(p.amount)));
  }

  const netTimeAndMileage = money(timeTotal - money(discounts));
  const miscTotal = sumMoney(misc.map((g) => g.total));
  const taxTotal = sumMoney(taxes.map((g) => g.total));

  return {
    rentalRevenue: {
      timeCharges: timeTotal,
      discounts: money(discounts),
      netTimeAndMileage,
    },
    misc: { lines: misc, total: miscTotal },
    taxes: { lines: taxes, total: taxTotal },
    depositsTaken: deposits,
    totalChargesAndDeposits: sumMoney([netTimeAndMileage, miscTotal, taxTotal, deposits]),
    receipts: [...receipts.entries()]
      .map(([method, total]) => ({ method, total }))
      .sort((a, b) => a.method.localeCompare(b.method)),
    totalReceipts: sumMoney([...receipts.values()]),
  };
}

/**
 * Placeholder account numbers (0001, 0002, …) until Rent & Go's accountant
 * hands over the real chart of accounts (Hector, 2026-08-17).
 *
 * Assigned over a SORTED key list so the same books produce the same numbers
 * on every run — a placeholder that shuffles between runs would be worse than
 * none, because someone would post one and reconcile against another.
 */
export function assignPlaceholderAccounts(groupKeys = []) {
  const map = {};
  [...new Set(groupKeys)].sort().forEach((key, i) => {
    map[key] = String(i + 1).padStart(4, '0');
  });
  return map;
}

/**
 * The journal. Debits are what came in (deposits held, payments received),
 * credits are what was earned or is owed (revenue, services, taxes).
 *
 * @param {object} args
 * @param {Array}  args.groups    [{ key, label, section, total }]
 * @param {Array}  args.receipts  [{ method, total }]
 * @param {object} args.accounts  { [groupKeyOrMethodKey]: '0001' }
 * @param {string} [args.locationCode] appended to each description, as the
 *                 old report did — one journal can cover several branches.
 */
/**
 * The account that absorbs TIMING, and why it has to exist.
 *
 * Cash and revenue do not land on the same day. Run this against Rent & Go's
 * real books (2026-08-17) and Kennedy is out by 3,782.55 — every cent of it
 * payments taken on rentals that had not closed yet. Mayaguez and Ponce, where
 * every payment belonged to a contract that closed inside the window, balanced
 * to the cent on the first try.
 *
 * That money is not revenue and it is not an error: it is cash received for
 * a rental not yet earned, which is a liability. So it gets a NAMED line
 * rather than a plug, and the report states the amount out loud — an
 * accountant needs to see how much of today's cash is still owed as service.
 */
export const DEFERRAL_KEY = 'UNEARNED';
export const DEFERRAL_LABEL = 'Unearned rental / open contracts';

/**
 * The same account, but the two views mean different things and the label
 * must not lie (Hector, 2026-08-19: "de que son esos 220.21").
 *
 * In the ALL view the gap is timing — cash taken on rentals still running.
 * In CLOSED-ONLY the open contracts are excluded by definition, so whatever
 * remains is a mismatch between what was collected and what was billed on
 * contracts that already closed: an over-collection with no charge line
 * behind it, or an unpaid balance. Calling that "open contracts" sent
 * somebody looking for rentals that were not in the report.
 */
export const DEFERRAL_LABEL_CLOSED = 'Collected vs billed on closed contracts';
export const deferralLabelFor = (scope) => (
  scope === 'closed' ? DEFERRAL_LABEL_CLOSED : DEFERRAL_LABEL
);

export function buildJournal({ groups = [], receipts = [], accounts = {}, locationCode = '', scope = 'all' } = {}) {
  const suffix = locationCode ? ` (Loc ${locationCode})` : '';
  const lines = [];

  const push = (key, label, amount, nature) => {
    const value = money(amount);
    // A zero line is noise in a journal — accountants read these by eye.
    if (value === 0) return;
    lines.push({
      account: accounts[key] || '0000',
      accountKey: key,
      description: `${label}${suffix}`,
      debit: nature === DEBIT ? value : 0,
      credit: nature === CREDIT ? value : 0,
    });
  };

  for (const g of groups) {
    const section = SECTION[g.section];
    if (!section) continue;
    push(g.key, g.label, g.total, section.nature);
  }
  for (const r of receipts) {
    push(`RECEIPT:${r.method}`, r.method, r.total, DEBIT);
  }

  lines.sort((a, b) => (a.account === b.account
    ? a.description.localeCompare(b.description)
    : a.account.localeCompare(b.account)));

  // Timing goes to its own account, on whichever side balances the entry:
  // more cash than revenue means the liability GREW (credit); more revenue
  // than cash means an earlier deposit was earned out (debit).
  const rawDebit = sumMoney(lines.map((l) => l.debit));
  const rawCredit = sumMoney(lines.map((l) => l.credit));
  const deferral = money(rawDebit - rawCredit);
  if (deferral !== 0) {
    push(DEFERRAL_KEY, deferralLabelFor(scope), Math.abs(deferral), deferral > 0 ? CREDIT : DEBIT);
    lines.sort((a, b) => (a.account === b.account
      ? a.description.localeCompare(b.description)
      : a.account.localeCompare(b.account)));
  }

  const totalDebit = sumMoney(lines.map((l) => l.debit));
  const totalCredit = sumMoney(lines.map((l) => l.credit));
  const difference = money(totalDebit - totalCredit);

  return {
    lines,
    totalDebit,
    totalCredit,
    difference,
    // What went to timing, surfaced rather than buried: positive means cash
    // collected on rentals still running.
    deferral,
    balanced: difference === 0,
    // Said plainly, because this is the sentence an accountant needs to see
    // when it goes wrong — not a stack trace. With the timing account in
    // place this should never fire; if it does, the arithmetic is wrong.
    balanceNote: difference === 0
      ? null
      : `Debits and credits differ by ${difference.toFixed(2)}. The entry is not postable until this is resolved.`,
  };
}

/** Every group key a set of charges will produce — for account mapping UI. */
export function groupKeysFor(charges = []) {
  const keys = new Set();
  for (const c of charges) keys.add(groupOf(c).key);
  return [...keys].sort();
}
