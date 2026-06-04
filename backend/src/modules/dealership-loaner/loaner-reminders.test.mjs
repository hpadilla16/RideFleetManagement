import test from 'node:test';
import assert from 'node:assert/strict';

const { runLoanerRemindersSweep, _internal } = await import('./loaner-reminders.scheduler.js');

function makeCache() {
  const m = new Map();
  return {
    store: m,
    async get(k) { return m.get(k); },
    async set(k, v) { m.set(k, v); }
  };
}

const NOW = new Date('2026-06-01T12:00:00Z');
function deps(rows, sent) {
  return {
    now: () => NOW,
    prisma: { loanerAgreement: { findMany: async () => rows } },
    sms: { sendCustom: async (args) => { sent.push(args); } },
    cache: makeCache()
  };
}

test('texts due-soon and overdue borrowers, skips those without a phone', async () => {
  const rows = [
    { id: 'a1', tenantId: 't1', customerPhone: '+15550001', returnAt: new Date(NOW.getTime() + 2 * 3600e3), agreementNumber: 'LA-1' }, // due soon
    { id: 'a2', tenantId: 't1', customerPhone: '+15550002', returnAt: new Date(NOW.getTime() - 3 * 3600e3), agreementNumber: 'LA-2' }, // overdue
    { id: 'a3', tenantId: 't1', customerPhone: '', returnAt: new Date(NOW.getTime() + 1 * 3600e3), agreementNumber: 'LA-3' } // no phone
  ];
  const sent = [];
  const counts = await runLoanerRemindersSweep(deps(rows, sent));
  assert.equal(counts.sent, 2);
  assert.equal(counts.skippedNoPhone, 1);
  assert.equal(sent.length, 2);
  const a1 = sent.find((s) => s.to === '+15550001');
  const a2 = sent.find((s) => s.to === '+15550002');
  assert.match(a1.body, /due back/i);
  assert.match(a2.body, /past due/i);
  assert.equal(a1.tenantId, 't1');
});

test('dedupes — a second sweep with the same cache sends nothing', async () => {
  const rows = [
    { id: 'a1', tenantId: 't1', customerPhone: '+15550001', returnAt: new Date(NOW.getTime() + 2 * 3600e3), agreementNumber: 'LA-1' }
  ];
  const sent = [];
  const d = deps(rows, sent);
  const first = await runLoanerRemindersSweep(d);
  const second = await runLoanerRemindersSweep(d); // same cache instance
  assert.equal(first.sent, 1);
  assert.equal(second.sent, 0);
  assert.equal(second.deduped, 1);
  assert.equal(sent.length, 1);
});

test('buildBody distinguishes overdue vs due-soon', () => {
  const due = _internal.buildBody('DUE_SOON', { returnAt: NOW });
  const over = _internal.buildBody('OVERDUE', { returnAt: NOW });
  assert.match(due, /due back/i);
  assert.match(over, /past due/i);
});
