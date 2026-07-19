import test from 'node:test';
import assert from 'node:assert/strict';
import {
  validateVoziaCancelPayload,
  validateVoziaReschedulePayload,
  assertPrePickup,
  VOZIA_PRE_PICKUP_STATUSES
} from './vozia-reservation-ops.js';

// ── cancel ───────────────────────────────────────────────────────────────────

test('cancel: valid payload passes and normalizes', () => {
  const { errors, value } = validateVoziaCancelPayload({
    status: 'CANCELLED',
    cancellationReason: '  customer travel cancelled  ',
    author: 'Sofía L. via VozIA',
    ticketId: 'TKT-1007'
  });
  assert.deepEqual(errors, []);
  assert.equal(value.reason, 'customer travel cancelled');
  assert.equal(value.ticketId, 'TKT-1007');
});

test('cancel: reason is mandatory', () => {
  const { errors } = validateVoziaCancelPayload({
    status: 'CANCELLED', author: 'a', ticketId: 'TKT-1'
  });
  assert.ok(errors.some((e) => /cancellationReason is required/.test(e)));
});

test('cancel: only CANCELLED status is accepted', () => {
  const { errors } = validateVoziaCancelPayload({
    status: 'CONFIRMED', cancellationReason: 'x', author: 'a', ticketId: 'TKT-1'
  });
  assert.ok(errors.some((e) => /must be 'CANCELLED'/.test(e)));
});

test('cancel: stray fields are rejected (no money/dates can ride along)', () => {
  const { errors } = validateVoziaCancelPayload({
    status: 'CANCELLED', cancellationReason: 'x', author: 'a', ticketId: 'TKT-1',
    estimatedTotal: 0, pickupAt: '2026-08-01'
  });
  assert.ok(errors.some((e) => /not allowed on a VozIA cancel/.test(e)));
});

test('cancel: attribution required (author + ticketId format)', () => {
  const { errors } = validateVoziaCancelPayload({
    status: 'CANCELLED', cancellationReason: 'x', ticketId: 'bad ticket!'
  });
  assert.ok(errors.some((e) => /author is required/.test(e)));
  assert.ok(errors.some((e) => /ticketId is required/.test(e)));
});

// ── reschedule ───────────────────────────────────────────────────────────────

const goodReschedule = {
  pickupAt: '2026-08-01T10:00:00.000Z',
  returnAt: '2026-08-05T10:00:00.000Z',
  expectedNewTotal: 512.9,
  author: 'Sofía L. via VozIA',
  ticketId: 'TKT-1007'
};

test('reschedule: valid payload passes; dates stay RAW strings (tenant-tz parse happens downstream — Innovation MC-1)', () => {
  const { errors, value } = validateVoziaReschedulePayload(goodReschedule);
  assert.deepEqual(errors, []);
  assert.equal(value.pickupAt, '2026-08-01T10:00:00.000Z');
  assert.equal(typeof value.pickupAt, 'string');
  assert.equal(value.returnAt, '2026-08-05T10:00:00.000Z');
  assert.equal(value.expectedNewTotal, 512.9);
  assert.equal(value.pickupLocationId, undefined);
});

test('reschedule: NAIVE datetime strings pass validation untouched (the engine parses them as tenant wall-clock)', () => {
  const { errors, value } = validateVoziaReschedulePayload({
    ...goodReschedule, pickupAt: '2026-08-01T10:00', returnAt: '2026-08-05T10:00'
  });
  assert.deepEqual(errors, []);
  assert.equal(value.pickupAt, '2026-08-01T10:00'); // raw, NOT normalized to UTC
});

test('reschedule: returnAt must be after pickupAt', () => {
  const { errors } = validateVoziaReschedulePayload({
    ...goodReschedule, returnAt: '2026-07-31T10:00:00.000Z'
  });
  assert.ok(errors.some((e) => /returnAt must be after pickupAt/.test(e)));
});

test('reschedule: expectedNewTotal is mandatory (staleness guard)', () => {
  const { errors } = validateVoziaReschedulePayload({
    ...goodReschedule, expectedNewTotal: undefined
  });
  assert.ok(errors.some((e) => /expectedNewTotal is required/.test(e)));
  const bad = validateVoziaReschedulePayload({ ...goodReschedule, expectedNewTotal: -5 });
  assert.ok(bad.errors.some((e) => /expectedNewTotal is required/.test(e)));
});

test('reschedule: stray fields are rejected', () => {
  const { errors } = validateVoziaReschedulePayload({
    ...goodReschedule, status: 'CANCELLED', dailyRate: 1
  });
  assert.ok(errors.some((e) => /not allowed on a VozIA reschedule/.test(e)));
});

test('reschedule: optional pickupLocationId must be non-empty when present', () => {
  const { errors } = validateVoziaReschedulePayload({
    ...goodReschedule, pickupLocationId: '   '
  });
  assert.ok(errors.some((e) => /pickupLocationId/.test(e)));
  const ok = validateVoziaReschedulePayload({ ...goodReschedule, pickupLocationId: 'loc2' });
  assert.deepEqual(ok.errors, []);
  assert.equal(ok.value.pickupLocationId, 'loc2');
});

// ── pre-pickup gate ──────────────────────────────────────────────────────────

test('assertPrePickup: NEW/CONFIRMED pass; everything else 409 NOT_PRE_PICKUP', () => {
  for (const s of VOZIA_PRE_PICKUP_STATUSES) {
    assert.equal(assertPrePickup(s, 'cancel'), null);
  }
  for (const s of ['CHECKED_OUT', 'CHECKED_IN', 'CANCELLED', 'NO_SHOW', 'COMPLETED']) {
    const err = assertPrePickup(s, 'cancel');
    assert.ok(err, `expected error for ${s}`);
    assert.equal(err.status, 409);
    assert.equal(err.code, 'NOT_PRE_PICKUP');
  }
});
