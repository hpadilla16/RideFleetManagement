// VozIA Fase 1 (2026-07-03) — pure tests for reservationIdWhere.
// A param with a short alphabetic prefix + hyphen is a human reservation
// number; anything else (cuids in particular) is treated as an id.
import test from 'node:test';
import assert from 'node:assert/strict';
import { reservationIdWhere } from './reservation-id.js';

test('RES- prefix resolves to reservationNumber', () => {
  assert.deepEqual(reservationIdWhere('RES-00123'), { reservationNumber: 'RES-00123' });
});

test('TL- prefix resolves to reservationNumber', () => {
  assert.deepEqual(reservationIdWhere('TL-ZE40809640BA'), { reservationNumber: 'TL-ZE40809640BA' });
});

test('lowercase tl- prefix also resolves to reservationNumber (regex is case-tolerant)', () => {
  assert.deepEqual(reservationIdWhere('tl-ze40809640ba'), { reservationNumber: 'tl-ze40809640ba' });
});

test('cuid resolves to id', () => {
  assert.deepEqual(reservationIdWhere('cmcklz2ov0001abcd1234wxyz'), { id: 'cmcklz2ov0001abcd1234wxyz' });
});

test('empty string resolves to id (matches nothing, 404 semantics unchanged)', () => {
  assert.deepEqual(reservationIdWhere(''), { id: '' });
});

test('null/undefined coerce to empty id, never throw', () => {
  assert.deepEqual(reservationIdWhere(null), { id: '' });
  assert.deepEqual(reservationIdWhere(undefined), { id: '' });
});

test('weird hyphens: leading hyphen is an id, not a number', () => {
  assert.deepEqual(reservationIdWhere('-RES123'), { id: '-RES123' });
});

test('weird hyphens: single-letter prefix is an id (prefix needs 2-6 letters)', () => {
  assert.deepEqual(reservationIdWhere('A-123'), { id: 'A-123' });
});

test('weird hyphens: 7+ letter prefix is an id', () => {
  assert.deepEqual(reservationIdWhere('ABCDEFG-1'), { id: 'ABCDEFG-1' });
});

test('digits in the prefix disqualify it (e.g. "C1-..." is an id)', () => {
  assert.deepEqual(reservationIdWhere('C1-000'), { id: 'C1-000' });
});

test('hyphen-only tail still counts as a reservation number ("RES-")', () => {
  assert.deepEqual(reservationIdWhere('RES-'), { reservationNumber: 'RES-' });
});
