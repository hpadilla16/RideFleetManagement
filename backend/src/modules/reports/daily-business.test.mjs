import test from 'node:test';
import assert from 'node:assert/strict';
import {
  groupOf, groupKeysFor, summarizeDay, buildJournal, assignPlaceholderAccounts, sumMoney,
  DEFERRAL_KEY,
} from './daily-business.math.js';

/** Charge names taken verbatim from Rent & Go's own books (2026-08-17). */
const REAL_CHARGES = [
  { name: 'Daily', chargeType: 'DAILY', total: 396.54 },
  { name: 'Service: AE', chargeType: 'UNIT', total: 30.00 },
  { name: 'Service: Road 24/7', chargeType: 'UNIT', total: 29.85 },
  { name: 'Service: Wind&Tire', chargeType: 'UNIT', total: 29.85 },
  { name: 'Insurance: CDW', chargeType: 'UNIT', total: 44.85 },
  { name: 'Fee: Vehicle License Fee', chargeType: 'UNIT', total: 11.94 },
  { name: 'Sales Tax (11.50%)', chargeType: 'TAX', total: 68.79 },
  { name: 'Security Deposit', chargeType: 'DEPOSIT', total: 250.00 },
];

// ── grouping ────────────────────────────────────────────────────────────────

test('the forty toll plazas collapse into ONE ledger line', () => {
  // The reason this module exists. Rent & Go has 40+ distinct toll charge
  // names; mapped one by one the journal would be unreadable.
  const tolls = [
    'Toll Charge - Bayamon Sb 1', 'Toll Charge - Buchanan Wb 2',
    'Toll Charge - Teodoro Moscoso Nb 4', 'Toll Charge - Manati Wb 2',
    'Toll Charge - Arecibo Wb 2', 'Fee: Tolls', 'Tolls',
  ].map((name) => ({ name, chargeType: 'UNIT', total: 1 }));

  const keys = groupKeysFor(tolls);
  assert.equal(keys.length, 1, `expected one toll group, got ${keys.join(', ')}`);
  assert.equal(groupOf(tolls[0]).label, 'Tolls');
});

test('service, insurance and fee prefixes each keep their own line', () => {
  assert.equal(groupOf({ name: 'Service: AE', chargeType: 'UNIT' }).label, 'Service - AE');
  assert.equal(groupOf({ name: 'Insurance: CDW', chargeType: 'UNIT' }).label, 'Insurance - CDW');
  assert.equal(groupOf({ name: 'Fee: Airport Dropoff Fee', chargeType: 'UNIT' }).label, 'Fee - Airport Dropoff Fee');
  // Distinct keys, so an accountant can map them to different accounts.
  const keys = groupKeysFor([
    { name: 'Service: AE', chargeType: 'UNIT' },
    { name: 'Insurance: CDW', chargeType: 'UNIT' },
    { name: 'Fee: Airport Dropoff Fee', chargeType: 'UNIT' },
  ]);
  assert.equal(keys.length, 3);
});

test('an unrecognised charge keeps its own name instead of vanishing', () => {
  // Money must never be swept into an unnamed "other" bucket.
  const g = groupOf({ name: 'Cleaning penalty', chargeType: 'UNIT' });
  assert.equal(g.section, 'MISC');
  assert.equal(g.label, 'Cleaning penalty');
});

test('time, tax and deposit land in their own sections', () => {
  assert.equal(groupOf({ name: 'Daily', chargeType: 'DAILY' }).section, 'TIME');
  assert.equal(groupOf({ name: 'Extension (4 days @ $35.00/day)', chargeType: 'DAILY' }).key, 'TIME');
  assert.equal(groupOf({ name: 'Sales Tax (11.50%)', chargeType: 'TAX' }).section, 'TAX');
  assert.equal(groupOf({ name: 'Security Deposit', chargeType: 'DEPOSIT' }).section, 'DEPOSIT');
});

test('each distinct tax keeps its own line — they post to different accounts', () => {
  const keys = groupKeysFor([
    { name: 'Sales Tax (11.50%)', chargeType: 'TAX' },
    { name: 'Municipal', chargeType: 'TAX' },
  ]);
  assert.equal(keys.length, 2);
});

// ── summary ─────────────────────────────────────────────────────────────────

test('the day summary adds up the way the old report printed it', () => {
  const s = summarizeDay({
    charges: REAL_CHARGES,
    payments: [
      { method: 'CARD', amount: 500.00 },
      { method: 'ATH_MOVIL', amount: 331.97 },
    ],
  });
  assert.equal(s.rentalRevenue.timeCharges, 396.54);
  assert.equal(s.rentalRevenue.netTimeAndMileage, 396.54);
  assert.equal(s.misc.total, sumMoney([30, 29.85, 29.85, 44.85, 11.94]));
  assert.equal(s.taxes.total, 68.79);
  assert.equal(s.depositsTaken, 250);
  assert.equal(
    s.totalChargesAndDeposits,
    sumMoney([396.54, s.misc.total, 68.79, 250]),
  );
  assert.equal(s.totalReceipts, 831.97);
});

test('discounts reduce net time, not the gross figure', () => {
  const s = summarizeDay({ charges: [{ name: 'Daily', chargeType: 'DAILY', total: 100 }], discounts: 25 });
  assert.equal(s.rentalRevenue.timeCharges, 100);
  assert.equal(s.rentalRevenue.discounts, 25);
  assert.equal(s.rentalRevenue.netTimeAndMileage, 75);
});

test('an authorization hold is not a receipt — no money was captured', () => {
  const s = summarizeDay({
    charges: [],
    payments: [{ method: 'AUTH_HOLD', amount: 500 }, { method: 'CASH', amount: 40 }],
  });
  assert.equal(s.totalReceipts, 40);
  assert.deepEqual(s.receipts.map((r) => r.method), ['CASH']);
});

// ── the journal ─────────────────────────────────────────────────────────────

function journalFor(charges, payments) {
  const s = summarizeDay({ charges, payments });
  const groups = [
    { key: 'TIME', label: 'Time charges', section: 'TIME', total: s.rentalRevenue.netTimeAndMileage },
    ...s.misc.lines, ...s.taxes.lines,
    { key: 'DEPOSIT', label: 'Deposits held', section: 'DEPOSIT', total: s.depositsTaken },
  ];
  const accounts = assignPlaceholderAccounts([
    ...groups.map((g) => g.key),
    ...s.receipts.map((r) => `RECEIPT:${r.method}`),
    DEFERRAL_KEY,
  ]);
  return buildJournal({ groups, receipts: s.receipts, accounts, locationCode: 'SJU' });
}

test('the journal balances when receipts cover the charges and deposits', () => {
  const s = summarizeDay({ charges: REAL_CHARGES, payments: [] });
  const j = journalFor(REAL_CHARGES, [{ method: 'CARD', amount: s.totalChargesAndDeposits }]);
  assert.equal(j.balanced, true, j.balanceNote || '');
  assert.equal(j.totalDebit, j.totalCredit);
  assert.equal(j.balanceNote, null);
});

test('a gap between cash and revenue is NAMED, never swallowed', () => {
  // Before the timing account existed this simply reported "out of balance".
  // It still must not disappear quietly: the entry balances, and the amount
  // that got there by timing is stated.
  const j = journalFor(REAL_CHARGES, [{ method: 'CARD', amount: 1 }]);
  assert.equal(j.balanced, true, 'the timing account closes the entry');
  assert.ok(Math.abs(j.deferral) > 0, 'and reports how much went to timing');
  const line = j.lines.find((l) => l.accountKey === DEFERRAL_KEY);
  assert.ok(line, 'as a line an accountant can see and map');
  assert.equal(j.totalDebit, j.totalCredit);
});

test('receipts are debits; revenue, taxes AND deposits are credits', () => {
  const j = journalFor(REAL_CHARGES, [{ method: 'CASH', amount: 100 }]);
  const by = (needle) => j.lines.find((l) => l.description.includes(needle));
  assert.ok(by('Deposits held').credit > 0, 'a deposit is owed back — a credit; the cash is already in receipts');
  assert.ok(by('CASH').debit > 0, 'a receipt is money in — a debit');
  assert.ok(by('Time charges').credit > 0, 'revenue is earned — a credit');
  assert.ok(by('Sales Tax').credit > 0, 'tax is owed — a credit');
});

test('the location code rides on every description', () => {
  const j = journalFor(REAL_CHARGES, [{ method: 'CASH', amount: 10 }]);
  for (const line of j.lines) assert.match(line.description, /\(Loc SJU\)$/);
});

test('zero-value groups never reach the journal', () => {
  const j = buildJournal({
    groups: [{ key: 'TIME', label: 'Time charges', section: 'TIME', total: 0 }],
    receipts: [{ method: 'CASH', total: 0 }],
    accounts: { TIME: '0001' },
  });
  assert.deepEqual(j.lines, []);
});

// ── placeholder accounts ────────────────────────────────────────────────────

test('placeholder numbers are stable across runs, not run-order dependent', () => {
  const a = assignPlaceholderAccounts(['MISC:TOLLS', 'TIME', 'TAX:Sales Tax (11.50%)']);
  const b = assignPlaceholderAccounts(['TIME', 'TAX:Sales Tax (11.50%)', 'MISC:TOLLS']);
  assert.deepEqual(a, b, 'the same books must number the same way every time');
  assert.equal(Object.values(a).every((n) => /^\d{4}$/.test(n)), true);
});

test('cents add up exactly — a close cannot drift on float error', () => {
  const many = Array.from({ length: 300 }, () => 0.1);
  assert.equal(sumMoney(many), 30);
});

// ── timing: cash and revenue do not land on the same day ────────────────────

test('cash taken on a still-open rental lands in unearned, and the entry balances', () => {
  // Rent & Go, Kennedy, 2026-08-10..18: payments on contracts that had not
  // closed yet left the journal short by 3,782.55. That is a liability, not
  // an error, and it must have a named line.
  const j = buildJournal({
    groups: [{ key: 'TIME', label: 'Time charges', section: 'TIME', total: 100 }],
    receipts: [{ method: 'CARD', total: 400 }],
    accounts: { TIME: '0001', 'RECEIPT:CARD': '0002', UNEARNED: '0003' },
    locationCode: 'KEN',
  });
  assert.equal(j.balanced, true, j.balanceNote || '');
  assert.equal(j.deferral, 300, 'the 300 not yet earned goes to unearned');
  const line = j.lines.find((l) => l.accountKey === DEFERRAL_KEY);
  assert.ok(line, 'the timing must be a NAMED line, never a silent plug');
  assert.equal(line.credit, 300, 'more cash than revenue grows the liability — a credit');
  assert.match(line.description, /Unearned rental/);
});

test('revenue earned against an earlier deposit draws the liability DOWN', () => {
  const j = buildJournal({
    groups: [{ key: 'TIME', label: 'Time charges', section: 'TIME', total: 500 }],
    receipts: [{ method: 'CARD', total: 120 }],
    accounts: { TIME: '0001', 'RECEIPT:CARD': '0002', UNEARNED: '0003' },
  });
  assert.equal(j.balanced, true);
  assert.equal(j.deferral, -380);
  const line = j.lines.find((l) => l.accountKey === DEFERRAL_KEY);
  assert.equal(line.debit, 380, 'earning out a deposit is a debit to the liability');
});

test('a day where cash and revenue match needs no timing line at all', () => {
  // Mayaguez and Ponce did exactly this on the first real run.
  const j = buildJournal({
    groups: [{ key: 'TIME', label: 'Time charges', section: 'TIME', total: 64.66 }],
    receipts: [{ method: 'CARD', total: 64.66 }],
    accounts: { TIME: '0001', 'RECEIPT:CARD': '0002' },
  });
  assert.equal(j.deferral, 0);
  assert.equal(j.lines.some((l) => l.accountKey === DEFERRAL_KEY), false);
  assert.equal(j.balanced, true);
});

test('the timing account is named for the view it appears in', () => {
  // Hector asked what a 220.21 line meant in the closed-only view. It was
  // labelled "open contracts" — in a report whose filter EXCLUDES open
  // contracts. The number was right; the word sent him looking for rentals
  // that were not there.
  const args = {
    groups: [{ key: 'TIME', label: 'Time charges', section: 'TIME', total: 100 }],
    receipts: [{ method: 'CARD', total: 320 }],
    accounts: { TIME: '0001', 'RECEIPT:CARD': '0002', UNEARNED: '0013' },
    locationCode: 'KEN',
  };
  const all = buildJournal({ ...args, scope: 'all' });
  const closed = buildJournal({ ...args, scope: 'closed' });

  const lineOf = (j) => j.lines.find((l) => l.accountKey === DEFERRAL_KEY);
  assert.match(lineOf(all).description, /open contracts/);
  assert.match(lineOf(closed).description, /Collected vs billed/);
  assert.doesNotMatch(
    lineOf(closed).description, /open contracts/,
    'the closed-only view must not name contracts it excluded',
  );
  // Same account either way — only the wording changes.
  assert.equal(lineOf(all).account, lineOf(closed).account);
  assert.equal(all.deferral, closed.deferral);
});
