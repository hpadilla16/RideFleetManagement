import test from 'node:test';
import assert from 'node:assert/strict';
import {
  validateVoziaCustomerPatch,
  applyVoziaCustomerPatch,
  maskEmail,
  VOZIA_CUSTOMER_FIELDS
} from './vozia-customer-patch.js';

// ── validator ────────────────────────────────────────────────────────────────

test('valid single-field payloads pass for every whitelisted field', () => {
  const samples = {
    email: 'maria@example.com',
    address1: '123 Calle Sol',
    address2: 'Apt 4B',
    city: 'San Juan',
    state: 'PR',
    zip: '00901'
  };
  for (const field of VOZIA_CUSTOMER_FIELDS) {
    const { errors, value } = validateVoziaCustomerPatch({
      [field]: samples[field], author: 'Sofía via VozIA', ticketId: 'TKT-1'
    });
    assert.deepEqual(errors, [], `${field}: ${errors}`);
    assert.equal(value.field, field);
  }
});

test('exactly one field per request', () => {
  const none = validateVoziaCustomerPatch({ author: 'a', ticketId: 'TKT-1' });
  assert.ok(none.errors.some((e) => /Exactly one editable field/.test(e)));
  const two = validateVoziaCustomerPatch({
    city: 'x', state: 'y', author: 'a', ticketId: 'TKT-1'
  });
  assert.ok(two.errors.some((e) => /Exactly one field per request/.test(e)));
});

test('stray fields rejected — phone/licencia/money can never ride through', () => {
  for (const stray of ['phone', 'licenseNumber', 'creditBalance', 'firstName']) {
    const { errors } = validateVoziaCustomerPatch({
      city: 'SJ', [stray]: 'x', author: 'a', ticketId: 'TKT-1'
    });
    assert.ok(errors.some((e) => e.includes(stray)), `expected rejection for ${stray}`);
  }
});

test('email format is validated; address2 may be cleared', () => {
  const bad = validateVoziaCustomerPatch({
    email: 'not-an-email', author: 'a', ticketId: 'TKT-1'
  });
  assert.ok(bad.errors.some((e) => /valid email/.test(e)));
  const clear = validateVoziaCustomerPatch({
    address2: '', author: 'a', ticketId: 'TKT-1'
  });
  assert.deepEqual(clear.errors, []);
});

test('attribution required', () => {
  const { errors } = validateVoziaCustomerPatch({ city: 'SJ' });
  assert.ok(errors.some((e) => /author is required/.test(e)));
  assert.ok(errors.some((e) => /ticketId is required/.test(e)));
});

// ── apply (fake prisma + email spy) ─────────────────────────────────────────

function fakeDeps() {
  const calls = { customerUpdates: [], audits: [], emails: [] };
  const prisma = {
    customer: {
      update: async (args) => { calls.customerUpdates.push(args); return {}; }
    },
    auditLog: {
      create: async (args) => { calls.audits.push(args); return {}; }
    }
  };
  const sendEmail = async (args) => { calls.emails.push(args); };
  return { prisma, sendEmail, calls };
}

const CUSTOMER = {
  id: 'cus1', tenantId: 'ten1', firstName: 'Maria',
  email: 'old@example.com', address1: null, address2: null,
  city: null, state: null, zip: null
};

test('apply email change: writes column, notifies OLD email, audits before/after', async () => {
  const { prisma, sendEmail, calls } = fakeDeps();
  const out = await applyVoziaCustomerPatch(
    { field: 'email', value: 'new@example.com', author: 'Sofía', ticketId: 'TKT-9' },
    CUSTOMER, { prisma, sendEmail }, 'svc-user-1'
  );
  assert.equal(out.ok, true);
  assert.equal(out.before, 'old@example.com');
  assert.equal(out.after, 'new@example.com');
  assert.equal(out.oldEmailNotified, true);

  assert.equal(calls.customerUpdates[0].data.email, 'new@example.com');
  // the notice goes to the OLD address and only MASKS the new one
  assert.equal(calls.emails[0].to, 'old@example.com');
  assert.ok(calls.emails[0].text.includes('n•••@example.com'));
  assert.ok(!calls.emails[0].text.includes('new@example.com'));

  const meta = JSON.parse(calls.audits[0].data.metadata);
  assert.equal(meta.source, 'vozia');
  assert.equal(meta.before, 'old@example.com');
  assert.equal(meta.after, 'new@example.com');
  assert.equal(meta.oldEmailNotified, true);
  assert.equal(calls.audits[0].data.actorUserId, 'svc-user-1');
});

test('apply email change: a bounced notice does NOT block the change, audit says so', async () => {
  const { prisma, calls } = fakeDeps();
  const failingSend = async () => { throw new Error('smtp down'); };
  const out = await applyVoziaCustomerPatch(
    { field: 'email', value: 'new@example.com', author: 'S', ticketId: 'T-1' },
    CUSTOMER, { prisma, sendEmail: failingSend }, null
  );
  assert.equal(out.ok, true);
  assert.equal(out.oldEmailNotified, false);
  const meta = JSON.parse(calls.audits[0].data.metadata);
  assert.equal(meta.oldEmailNotified, false);
});

test('apply address change: no email notice, audit written', async () => {
  const { prisma, sendEmail, calls } = fakeDeps();
  const out = await applyVoziaCustomerPatch(
    { field: 'city', value: 'Orlando', author: 'S', ticketId: 'T-2' },
    CUSTOMER, { prisma, sendEmail }, null
  );
  assert.equal(out.ok, true);
  assert.equal(calls.emails.length, 0);
  assert.equal(calls.customerUpdates[0].data.city, 'Orlando');
  const meta = JSON.parse(calls.audits[0].data.metadata);
  assert.equal(meta.field, 'city');
  assert.equal(meta.oldEmailNotified, undefined);
});

test('maskEmail masks the user part', () => {
  assert.equal(maskEmail('carmen@example.com'), 'c•••@example.com');
  assert.equal(maskEmail('garbage'), '•••');
});
