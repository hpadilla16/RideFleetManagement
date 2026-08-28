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
  const status = Number(err?.status || err?.statusCode || err?.httpStatus) || 500;
  if (status >= 400 && status < 500) return { status, body: { error: err?.message || 'Request failed' } };
  // Malformed CLIENT input reaches Prisma as a known error — mapped to a GENERIC
  // 4xx (never the Prisma message: it names columns/types = schema leak).
  const prismaCode = err?.code;
  if (err?.name === 'PrismaClientValidationError' || prismaCode === 'P2023' || prismaCode === 'P2009' || prismaCode === 'P2000') {
    return { status: 400, body: { error: 'Invalid request' } };
  }
  if (prismaCode === 'P2025') return { status: 404, body: { error: 'Not found' } };
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

test('e.httpStatus throws are honored too (the settings/market-pricing convention)', () => {
  const e = new Error('locationCode is required');
  e.httpStatus = 400;
  assert.deepEqual(decide(e), { status: 400, body: { error: 'locationCode is required' } });
});

test('malformed-input Prisma errors become a generic 4xx, not a 500', () => {
  const badId = Object.assign(new Error('Inconsistent column data: Malformed ObjectID'), { code: 'P2023' });
  const badArg = Object.assign(new Error('Argument where: ... Unknown field `zzz` on model `Vehicle`'), { name: 'PrismaClientValidationError' });
  const missing = Object.assign(new Error('depends on records that were required but not found'), { code: 'P2025' });
  assert.deepEqual(decide(badId), { status: 400, body: { error: 'Invalid request' } });
  assert.deepEqual(decide(badArg), { status: 400, body: { error: 'Invalid request' } }, 'must NOT echo the Prisma message (schema leak)');
  assert.deepEqual(decide(missing), { status: 404, body: { error: 'Not found' } });
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
  const handler = MAIN.slice(handlerAt, handlerAt + 3400);
  const earlyReturn = handler.indexOf('status >= 400 && status < 500');
  const capture = handler.indexOf('captureBackendException');
  const prismaMap = handler.indexOf("prismaCode === 'P2023'");
  assert.ok(earlyReturn > 0, 'the 4xx passthrough is gone');
  assert.ok(prismaMap > earlyReturn, 'the Prisma client-input 4xx mapping must sit after the typed-4xx return');
  assert.ok(capture > prismaMap, 'Sentry capture must come after BOTH the 4xx return and the Prisma client-input mapping');
});
