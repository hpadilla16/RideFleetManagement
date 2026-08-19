import test from 'node:test';
import assert from 'node:assert/strict';
import {
  groupOf, groupKeysFor, summarizeDay, buildJournal, assignPlaceholderAccounts, sumMoney,
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

test('an out-of-balance journal REFUSES to look fine', () => {
  const j = journalFor(REAL_CHARGES, [{ method: 'CARD', amount: 1 }]);
  assert.equal(j.balanced, false);
  assert.ok(j.difference !== 0);
  assert.match(j.balanceNote, /not postable/);
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
