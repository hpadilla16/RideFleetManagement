// VozIA Cap 6 / W1 (2026-07-19) — validation matrix + apply against injected fakes
// (no postgres). Run: npm run test:reservations
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  VOZIA_PATCH_FIELDS,
  validateVoziaPatchPayload,
  applyVoziaReservationPatch
} from './vozia-reservation-patch.js';

const OK_BASE = { author: 'USR-2 Hector (via VozIA)', ticketId: 'ACT-77' };

// ── validation matrix ──

test('accepts exactly one whitelisted field + author + ticketId', () => {
  for (const field of VOZIA_PATCH_FIELDS) {
    const value = field === 'contactPhone' ? '(787) 555-1234' : 'AA123';
    const { errors, value: v } = validateVoziaPatchPayload({ ...OK_BASE, [field]: value });
    assert.deepEqual(errors, [], `${field} should validate`);
    assert.equal(v.field, field);
    assert.equal(v.value, value);
  }
});

test('rejects money/status/date fields by name (default-deny)', () => {
  for (const bad of ['dailyRate', 'estimatedTotal', 'status', 'pickupAt', 'vehicleId', 'paymentStatus', 'contactEmail']) {
    const { errors } = validateVoziaPatchPayload({ ...OK_BASE, flightNumber: 'AA123', [bad]: 'x' });
    assert.ok(errors.some((e) => e.includes(bad)), `${bad} must be rejected`);
  }
});

test('rejects zero fields and multiple fields', () => {
  assert.ok(validateVoziaPatchPayload({ ...OK_BASE }).errors.length > 0);
  const multi = validateVoziaPatchPayload({ ...OK_BASE, flightNumber: 'AA1', contactPhone: '7875551234' });
  assert.ok(multi.errors.some((e) => /Exactly one field/.test(e)));
});

test('requires author and valid ticketId', () => {
  assert.ok(validateVoziaPatchPayload({ flightNumber: 'AA123', ticketId: 'ACT-1' }).errors.some((e) => /author/.test(e)));
  assert.ok(validateVoziaPatchPayload({ flightNumber: 'AA123', author: 'X' }).errors.some((e) => /ticketId/.test(e)));
  assert.ok(validateVoziaPatchPayload({ ...OK_BASE, ticketId: 'bad ticket!', flightNumber: 'AA123' }).errors.some((e) => /ticketId/.test(e)));
});

test('value rules: empty, too long, email shape, phone digits', () => {
  assert.ok(validateVoziaPatchPayload({ ...OK_BASE, flightNumber: '  ' }).errors.some((e) => /non-empty/.test(e)));
  assert.ok(validateVoziaPatchPayload({ ...OK_BASE, flightNumber: 'X'.repeat(21) }).errors.some((e) => /20 characters/.test(e)));
  assert.ok(validateVoziaPatchPayload({ ...OK_BASE, contactPhone: '12-34' }).errors.some((e) => /7 digits/.test(e)));
});

// ── apply with fakes ──

function fakeDeps({ customers = [], failCustomer = false } = {}) {
  const audits = [];
  const customerUpdates = [];
  const reservationUpdates = [];
  return {
    audits,
    customerUpdates,
    reservationUpdates,
    prisma: {
      reservation: {
        async update({ where, data }) { reservationUpdates.push({ where, data }); return { id: where.id, ...data }; }
      },
      customer: {
        async findFirst({ where }) {
          if (failCustomer) return null;
          return customers.find((c) => c.id === where.id && (!where.tenantId || c.tenantId === where.tenantId)) || null;
        },
        async update({ where, data }) {
          customerUpdates.push({ where, data });
          return { id: where.id, ...data };
        }
      },
      auditLog: {
        async create({ data }) { audits.push(data); return data; }
      }
    },
  };
}

const RES = { id: 'res1', tenantId: 't1', customerId: 'cus1', flightNumber: null, pickupInstructions: 'old text' };
const SCOPE = { tenantId: 't1' };

test('flightNumber writes the column DIRECTLY (MC-1) + audits before/after with real actor', async () => {
  const deps = fakeDeps();
  const out = await applyVoziaReservationPatch(
    { field: 'flightNumber', value: 'AA123', author: 'A', ticketId: 'T-1' },
    RES, SCOPE, deps, 'svc-user-1'
  );
  assert.deepEqual(out, { ok: true, field: 'flightNumber', before: null, after: 'AA123', reservationId: 'res1' });
  // MC-1: write directo de columna, jamás via reservationsService.update()
  assert.deepEqual(deps.reservationUpdates[0], { where: { id: 'res1' }, data: { flightNumber: 'AA123' } });
  const meta = JSON.parse(deps.audits[0].metadata);
  assert.equal(meta.source, 'vozia');
  assert.equal(meta.ticketId, 'T-1');
  assert.equal(meta.after, 'AA123');
  assert.equal(deps.audits[0].actorUserId, 'svc-user-1'); // MC-2: atribución real del service account
  assert.equal(deps.audits[0].action, 'UPDATE');
});

test('pickupInstructions captures the previous value as before', async () => {
  const deps = fakeDeps();
  const out = await applyVoziaReservationPatch(
    { field: 'pickupInstructions', value: 'meet at curb 3', author: 'A', ticketId: 'T-2' },
    RES, SCOPE, deps
  );
  assert.equal(out.before, 'old text');
});

test('contactPhone updates the CUSTOMER record (tenant-scoped), never the reservation', async () => {
  const deps = fakeDeps({ customers: [{ id: 'cus1', tenantId: 't1', phone: '(111) 111-1111', email: 'old@x.co' }] });
  const out = await applyVoziaReservationPatch(
    { field: 'contactPhone', value: '(787) 555-1234', author: 'A', ticketId: 'T-3' },
    RES, SCOPE, deps
  );
  assert.equal(out.before, '(111) 111-1111');
  assert.deepEqual(deps.customerUpdates[0].data, { phone: '(787) 555-1234' });
  assert.equal(deps.reservationUpdates.length, 0);
});

test('contactEmail is REJECTED (Hector 2026-07-19 — email changes escalate to a human)', () => {
  const { errors } = validateVoziaPatchPayload({ ...OK_BASE, contactEmail: 'new@x.co' });
  assert.ok(errors.some((e) => e.includes('contactEmail')));
});

test('customer outside the tenant → 422 CUSTOMER_NOT_FOUND, nothing written', async () => {
  const deps = fakeDeps({ failCustomer: true });
  await assert.rejects(
    applyVoziaReservationPatch(
      { field: 'contactPhone', value: '(787) 555-1234', author: 'A', ticketId: 'T-5' },
      RES, SCOPE, deps
    ),
    (e) => e.code === 'CUSTOMER_NOT_FOUND' && e.status === 422
  );
  assert.equal(deps.customerUpdates.length, 0);
  assert.equal(deps.audits.length, 0);
});

test('reservation without customer → 422 NO_CUSTOMER for contact fields', async () => {
  const deps = fakeDeps();
  await assert.rejects(
    applyVoziaReservationPatch(
      { field: 'contactPhone', value: '(787) 555-1234', author: 'A', ticketId: 'T-6' },
      { ...RES, customerId: null }, SCOPE, deps
    ),
    (e) => e.code === 'NO_CUSTOMER'
  );
});

test('nasty inputs: null/number/array/object values and __proto__ key are rejected', () => {
  assert.ok(validateVoziaPatchPayload({ ...OK_BASE, flightNumber: null }).errors.length > 0);
  assert.ok(validateVoziaPatchPayload({ ...OK_BASE, flightNumber: 123 }).errors.length > 0);
  assert.ok(validateVoziaPatchPayload({ ...OK_BASE, flightNumber: ['AA123'] }).errors.length > 0);
  assert.ok(validateVoziaPatchPayload({ ...OK_BASE, flightNumber: { set: 'AA123' } }).errors.length > 0);
  const proto = JSON.parse('{"author":"A","ticketId":"T-1","flightNumber":"AA1","__proto__":{"x":1}}');
  const { errors } = validateVoziaPatchPayload(proto);
  assert.ok(errors.some((e) => e.includes('__proto__')), '__proto__ debe reportarse como stray');
});
