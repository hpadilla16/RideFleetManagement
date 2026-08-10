/**
 * Backdating a check-in — DB-free.
 *
 * Hector, 2026-08-10: the customer returned the car on the scheduled day but
 * staff recorded the check-in later, and the late fee computed from "now" —
 * billing the customer for the staff's delay.
 *
 * The plumbing (payload.returnedAt) always existed, UNGATED: any API caller
 * could silently backdate any check-in. These tests are the gate.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { validateBackdatedReturn, backdatedReturnNote, BACKDATE_GRACE_MS } from './backdated-return.js';

const NOW = new Date('2026-08-10T20:00:00.000Z');
const STARTED = new Date('2026-08-01T14:00:00.000Z');

test('THE CASE: an admin backdates to when the car actually came back', () => {
  const r = validateBackdatedReturn({
    returnedAt: '2026-08-08T15:00:00.000Z',   // two days ago — the real return
    now: NOW, role: 'ADMIN', rentalStartAt: STARTED,
  });
  assert.deepEqual(r, { ok: true, backdated: true });
});

test('an AGENT cannot backdate beyond the grace', () => {
  const r = validateBackdatedReturn({
    returnedAt: '2026-08-08T15:00:00.000Z', now: NOW, role: 'AGENT', rentalStartAt: STARTED,
  });
  assert.equal(r.ok, false);
  assert.match(r.error, /Only an admin/);
});

test('the grace belongs to everyone — walking from the car is not backdating', () => {
  // 10 minutes ago, an AGENT: clock skew and the walk to the counter.
  const r = validateBackdatedReturn({
    returnedAt: new Date(NOW.getTime() - 10 * 60000), now: NOW, role: 'AGENT', rentalStartAt: STARTED,
  });
  assert.deepEqual(r, { ok: true, backdated: false });
});

test('a car cannot come back before it left — even for an admin', () => {
  const r = validateBackdatedReturn({
    returnedAt: '2026-07-30T10:00:00.000Z', now: NOW, role: 'ADMIN', rentalStartAt: STARTED,
  });
  assert.equal(r.ok, false);
  assert.match(r.error, /before the rental started/);
});

test('a check-in records the past, never the future', () => {
  const r = validateBackdatedReturn({
    returnedAt: new Date(NOW.getTime() + 2 * 3600000), now: NOW, role: 'ADMIN', rentalStartAt: STARTED,
  });
  assert.equal(r.ok, false);
  assert.match(r.error, /future/);
});

test('but a few minutes of clock skew forward is tolerated', () => {
  const r = validateBackdatedReturn({
    returnedAt: new Date(NOW.getTime() + BACKDATE_GRACE_MS - 60000), now: NOW, role: 'AGENT', rentalStartAt: STARTED,
  });
  assert.equal(r.ok, true);
});

test('garbage dates are refused, not coerced into a fee waiver', () => {
  const r = validateBackdatedReturn({ returnedAt: 'yesterday-ish', now: NOW, role: 'ADMIN' });
  assert.equal(r.ok, false);
});

test('no rental start on record disables only that bound, not the others', () => {
  // A legacy agreement without finalizedAt: backdating still works for an
  // admin, and the future bound still holds.
  assert.equal(validateBackdatedReturn({
    returnedAt: '2026-08-08T15:00:00.000Z', now: NOW, role: 'OPS', rentalStartAt: null,
  }).ok, true);
});

test('the note names the moment, the actor and the consequence', () => {
  const note = backdatedReturnNote({ returnedAt: '2026-08-08T15:00:00.000Z', actorRole: 'admin', now: NOW });
  assert.match(note, /BACKDATED CHECK-IN/);
  assert.match(note, /2026-08-08T15:00:00.000Z/);
  assert.match(note, /ADMIN/);
  assert.match(note, /late-fee math/);
});
