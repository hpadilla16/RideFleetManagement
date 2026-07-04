// VozIA Fase 4 (2026-07-03) — validation matrix + marker format for the
// POST /reservations/:id/notes payload helpers.
import test from 'node:test';
import assert from 'node:assert/strict';
import { validateVoziaNotePayload, buildVoziaNoteLine } from './vozia-note.js';

const VALID = { text: 'Customer called to confirm pickup time.', author: 'VozIA Agent', ticketId: 'VZ-2026-0001' };

test('valid payload → no errors, trimmed values', () => {
  const { errors, value } = validateVoziaNotePayload({ ...VALID, text: `  ${VALID.text}  `, author: ' VozIA Agent ' });
  assert.deepEqual(errors, []);
  assert.equal(value.text, VALID.text);
  assert.equal(value.author, 'VozIA Agent');
  assert.equal(value.ticketId, 'VZ-2026-0001');
});

test('text: required, non-blank, ≤2000', () => {
  assert.ok(validateVoziaNotePayload({ ...VALID, text: undefined }).errors.some((e) => /text is required/.test(e)));
  assert.ok(validateVoziaNotePayload({ ...VALID, text: '   ' }).errors.some((e) => /text is required/.test(e)));
  assert.ok(validateVoziaNotePayload({ ...VALID, text: 42 }).errors.some((e) => /text is required/.test(e)));
  assert.deepEqual(validateVoziaNotePayload({ ...VALID, text: 'x'.repeat(2000) }).errors, []);
  assert.ok(validateVoziaNotePayload({ ...VALID, text: 'x'.repeat(2001) }).errors.some((e) => /2000/.test(e)));
});

test('author: required, ≤120', () => {
  assert.ok(validateVoziaNotePayload({ ...VALID, author: undefined }).errors.some((e) => /author is required/.test(e)));
  assert.ok(validateVoziaNotePayload({ ...VALID, author: '  ' }).errors.some((e) => /author is required/.test(e)));
  assert.deepEqual(validateVoziaNotePayload({ ...VALID, author: 'a'.repeat(120) }).errors, []);
  assert.ok(validateVoziaNotePayload({ ...VALID, author: 'a'.repeat(121) }).errors.some((e) => /120/.test(e)));
});

test('ticketId: required, ^[A-Za-z0-9._-]{1,64}$', () => {
  assert.ok(validateVoziaNotePayload({ ...VALID, ticketId: undefined }).errors.some((e) => /ticketId/.test(e)));
  assert.ok(validateVoziaNotePayload({ ...VALID, ticketId: 'has space' }).errors.some((e) => /ticketId/.test(e)));
  assert.ok(validateVoziaNotePayload({ ...VALID, ticketId: 'emoji💥' }).errors.some((e) => /ticketId/.test(e)));
  assert.ok(validateVoziaNotePayload({ ...VALID, ticketId: 'x'.repeat(65) }).errors.some((e) => /ticketId/.test(e)));
  assert.deepEqual(validateVoziaNotePayload({ ...VALID, ticketId: 'a.b-c_D9' }).errors, []);
});

test('multiple failures are all reported', () => {
  const { errors } = validateVoziaNotePayload({});
  assert.equal(errors.length, 3);
});

test('marker format: [VOZIA <ticketId> <author> @<ISO>] <text>', () => {
  const at = new Date('2026-07-03T14:30:00.000Z');
  const line = buildVoziaNoteLine({ ...VALID, at });
  assert.equal(line, `[VOZIA VZ-2026-0001 VozIA Agent @2026-07-03T14:30:00.000Z] ${VALID.text}`);
});

test('marker format: defaults to now when at is absent/invalid', () => {
  const line = buildVoziaNoteLine(VALID);
  assert.match(line, /^\[VOZIA VZ-2026-0001 VozIA Agent @\d{4}-\d{2}-\d{2}T[\d:.]+Z\] /);
  const line2 = buildVoziaNoteLine({ ...VALID, at: new Date('nope') });
  assert.match(line2, /^\[VOZIA VZ-2026-0001 VozIA Agent @\d{4}-\d{2}-\d{2}T/);
});
