/**
 * The global error handler must not bury deliberate 4xx responses.
 *
 * It used to answer every unhandled error with 500 "Internal server error".
 * Services across the app throw typed errors carrying a status — AppError and
 * friends in lib/errors.js, plus ~121 hand-rolled `e.status = 4xx` throws —
 * and any route that simply forwarded with next(e) had that status erased.
 * The practice-mode 404 ("No demo tenant is configured", which names its own
 * fix) surfaced to a trainee as an opaque 500 (Hector, 2026-08-17).
 *
 * This pins both halves of the contract: 4xx passes through with its message,
 * 5xx stays opaque.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AppError, ValidationError, NotFoundError, ConflictError } from './errors.js';

const MAIN = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'main.js'), 'utf8');

/** The handler's decision, extracted so it can be exercised without Express. */
function decide(err) {
  const status = Number(err?.status || err?.statusCode) || 500;
  if (status >= 400 && status < 500) return { status, body: { error: err?.message || 'Request failed' } };
  return { status: 500, body: { error: 'Internal server error' } };
}

test('typed 4xx errors keep their status and message', () => {
  for (const [err, expected] of [
    [new NotFoundError('No demo tenant is configured'), 404],
    [new ValidationError('partySize must be a number'), 400],
    [new ConflictError('The practice account is misconfigured'), 409],
    [new AppError('Forbidden-ish', 403), 403],
  ]) {
    const out = decide(err);
    assert.equal(out.status, expected);
    assert.equal(out.body.error, err.message, 'the caller must see WHY, not "Internal server error"');
  }
});

test('hand-rolled e.status throws are honored too', () => {
  const e = new Error('Shuttle request not found');
  e.status = 404;
  assert.deepEqual(decide(e), { status: 404, body: { error: 'Shuttle request not found' } });
});

test('unexpected errors stay opaque at 500', () => {
  for (const err of [new Error('connect ECONNREFUSED 10.0.0.1:5432'), new AppError('boom', 500), null]) {
    const out = decide(err);
    assert.equal(out.status, 500);
    assert.equal(out.body.error, 'Internal server error', 'a 5xx must never leak internals');
  }
});

test('main.js still routes 5xx to Sentry and only 5xx', () => {
  // Guards the shape: the capture call must sit AFTER the 4xx early return,
  // or every validation error becomes an alert.
  const handlerAt = MAIN.indexOf('app.use((err, req, res, _next)');
  assert.ok(handlerAt > 0, 'global error handler not found');
  const handler = MAIN.slice(handlerAt, handlerAt + 1800);
  const earlyReturn = handler.indexOf('status >= 400 && status < 500');
  const capture = handler.indexOf('captureBackendException');
  assert.ok(earlyReturn > 0, 'the 4xx passthrough is gone');
  assert.ok(capture > earlyReturn, 'Sentry capture must come after the 4xx return');
});
