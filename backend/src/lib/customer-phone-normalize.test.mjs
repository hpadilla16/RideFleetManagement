// VozIA gap #4 (2026-07-15) — normalizePhone + applyPhoneNormalized derivation matrix.
// Pure (no Prisma/DB). Run: node --test src/lib/customer-phone-normalize.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizePhone,
  applyPhoneNormalized,
  customerPhoneNormalizeExtension,
} from './customer-phone-normalize.js';

test('normalizePhone strips all non-digits', () => {
  assert.equal(normalizePhone('(787) 555-1234'), '7875551234');
  assert.equal(normalizePhone('787-555-1234'), '7875551234');
  assert.equal(normalizePhone('+1 787 555 1234'), '17875551234');
  assert.equal(normalizePhone('7875551234'), '7875551234');
});

test('normalizePhone returns null for empty/no-digit/nullish', () => {
  assert.equal(normalizePhone(''), null);
  assert.equal(normalizePhone('   '), null);
  assert.equal(normalizePhone('n/a'), null);
  assert.equal(normalizePhone(null), null);
  assert.equal(normalizePhone(undefined), null);
});

test('normalizePhone coerces non-strings', () => {
  assert.equal(normalizePhone(7875551234), '7875551234');
});

test('applyPhoneNormalized derives on a create-shaped data (plain scalar)', () => {
  const data = { firstName: 'Maria', phone: '(787) 555-1234' };
  applyPhoneNormalized(data);
  assert.equal(data.phoneNormalized, '7875551234');
});

test('applyPhoneNormalized unwraps a Prisma { set } update value', () => {
  const data = { phone: { set: '787.555.1234' } };
  applyPhoneNormalized(data);
  assert.equal(data.phoneNormalized, '7875551234');
});

test('applyPhoneNormalized is a no-op when phone is absent (update not touching phone)', () => {
  const data = { email: { set: 'x@y.com' } };
  applyPhoneNormalized(data);
  assert.equal('phoneNormalized' in data, false);
});

test('applyPhoneNormalized sets null when phone cleared to null', () => {
  const data = { phone: null };
  applyPhoneNormalized(data);
  assert.equal(data.phoneNormalized, null);
});

test('applyPhoneNormalized leaves phoneNormalized untouched when phone is undefined', () => {
  // Prisma semantics: `phone: undefined` = "don't change phone" → don't touch mirror.
  const data = { phone: undefined, city: 'X' };
  applyPhoneNormalized(data);
  assert.equal('phoneNormalized' in data, false);
});

test('applyPhoneNormalized leaves phoneNormalized untouched for { set: undefined }', () => {
  const data = { phone: { set: undefined } };
  applyPhoneNormalized(data);
  assert.equal('phoneNormalized' in data, false);
});

test('applyPhoneNormalized tolerates nullish/array data', () => {
  assert.equal(applyPhoneNormalized(null), null);
  assert.equal(applyPhoneNormalized(undefined), undefined);
  const arr = [];
  assert.equal(applyPhoneNormalized(arr), arr);
});

// --- extension wiring: verify each operation derives before delegating to query() ---

function runOp(op, args) {
  let received = null;
  const query = (a) => { received = a; return Promise.resolve('ok'); };
  const p = customerPhoneNormalizeExtension.query.customer[op]({ args, query });
  return { received, p };
}

test('extension create/update/updateMany derive on args.data', async () => {
  for (const op of ['create', 'update', 'updateMany']) {
    const { received, p } = runOp(op, { data: { phone: '(305) 111-2222' } });
    await p;
    assert.equal(received.data.phoneNormalized, '3051112222', `${op} should derive`);
  }
});

test('extension upsert derives on both create and update', async () => {
  const { received, p } = runOp('upsert', {
    where: { id: 'c1' },
    create: { phone: '111-111-1111' },
    update: { phone: { set: '222-222-2222' } },
  });
  await p;
  assert.equal(received.create.phoneNormalized, '1111111111');
  assert.equal(received.update.phoneNormalized, '2222222222');
});

test('extension createMany derives across an array', async () => {
  const { received, p } = runOp('createMany', {
    data: [{ phone: '111-111-1111' }, { phone: '(222) 222-2222' }, { firstName: 'NoPhone' }],
  });
  await p;
  assert.equal(received.data[0].phoneNormalized, '1111111111');
  assert.equal(received.data[1].phoneNormalized, '2222222222');
  assert.equal('phoneNormalized' in received.data[2], false);
});
