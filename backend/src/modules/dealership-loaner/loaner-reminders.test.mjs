import test from 'node:test';
import assert from 'node:assert/strict';

const { runLoanerRemindersSweep, _internal } = await import('./loaner-reminders.scheduler.js');

function makeCache() {
  const m = new Map();
  return { store: m, async get(k) { return m.get(k); }, async set(k, v) { m.set(k, v); } };
}
const NOW = new Date('2026-06-01T12:00:00Z');
function deps(rows, sent) {
  return {
    now: () => NOW,
    prisma: { loanerAgreement: { findMany: async () => rows } },
    mailer: { sendEmail: async (args) => { sent.push(args); } },
    parseLocationConfig: (raw) => { try { return raw ? JSON.parse(raw) : {}; } catch { return {}; } },
    cache: makeCache(),
    resolveBrand: async () => ({ companyName: 'Test Co', brandColor: '#8752FE' }),
  };
}

test('emails due-soon + overdue borrowers (and location), skips those with no email', async () => {
  const rows = [
    { id: 'a1', tenantId: 't1', customerEmail: 'a1@x.com', returnAt: new Date(NOW.getTime() + 2 * 3600e3), agreementNumber: 'LA-1',
      reservation: { pickupLocation: { name: 'Kennedy', locationConfig: JSON.stringify({ locationEmail: 'ken@vph.com' }) } } }, // due soon -> customer + location
    { id: 'a2', tenantId: 't1', customerEmail: 'a2@x.com', returnAt: new Date(NOW.getTime() - 3 * 3600e3), agreementNumber: 'LA-2',
      reservation: { pickupLocation: { name: 'Ponce', locationConfig: null } } }, // overdue -> customer only
    { id: 'a3', tenantId: 't1', customerEmail: '', returnAt: new Date(NOW.getTime() + 1 * 3600e3), agreementNumber: 'LA-3',
      reservation: { pickupLocation: { name: 'X', locationConfig: null } } }, // no email anywhere -> skipped
  ];
  const sent = [];
  const counts = await runLoanerRemindersSweep(deps(rows, sent));
  assert.equal(counts.sent, 2, 'two agreements reminded');
  assert.equal(counts.skippedNoEmail, 1);
  // a1 -> customer + location (2 emails); a2 -> customer only (1) => 3 total
  assert.equal(sent.length, 3);
  assert.ok(sent.some((s) => s.to === 'a1@x.com' && /due back/i.test(s.subject + s.text)));
  assert.ok(sent.some((s) => s.to === 'ken@vph.com'), 'location copy sent');
  assert.ok(sent.some((s) => s.to === 'a2@x.com' && /past due/i.test(s.subject + s.text)));
});

test('dedupes — a second sweep with the same cache sends nothing', async () => {
  const rows = [
    { id: 'a1', tenantId: 't1', customerEmail: 'a1@x.com', returnAt: new Date(NOW.getTime() + 2 * 3600e3), agreementNumber: 'LA-1',
      reservation: { pickupLocation: { name: 'K', locationConfig: null } } },
  ];
  const sent = [];
  const d = deps(rows, sent);
  const first = await runLoanerRemindersSweep(d);
  const second = await runLoanerRemindersSweep(d);
  assert.equal(first.sent, 1);
  assert.equal(second.sent, 0);
  assert.equal(second.deduped, 1);
  assert.equal(sent.length, 1);
});

test('buildEmail distinguishes overdue vs due-soon', () => {
  const due = _internal.buildEmail('DUE_SOON', { returnAt: NOW });
  const over = _internal.buildEmail('OVERDUE', { returnAt: NOW });
  assert.match(due.subject + due.text, /due back/i);
  assert.match(over.subject + over.text, /past due/i);
});
