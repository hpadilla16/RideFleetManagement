/**
 * No network call on a request path may be unbounded — DB-free.
 *
 * The 2026-08-08 outage was not a rejection anyone forgot to catch. It was a
 * promise that NEVER SETTLED: DigitalOcean maintenance left the singleton
 * ioredis client reconnecting, `incr` hung, every non-SUPER_ADMIN request
 * stalled in the rate limiter, and nginx cut them at 60s. Postgres was
 * completely idle throughout — the requests never got that far.
 *
 * The same fix had been written after the identical 2026-06-20 incident and
 * never committed. So the rule lives in a test, not a comment.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { withTimeout } from './with-timeout.js';

const hangsForever = () => new Promise(() => {});

test('THE BUG: a promise that never settles is bounded anyway', async () => {
  const started = Date.now();
  await assert.rejects(
    () => withTimeout(hangsForever(), 40, 'zombie redis'),
    /zombie redis timed out after 40ms/,
  );
  assert.ok(Date.now() - started < 1000, 'it returns, which is the entire point');
});

test('a try/catch alone would NOT have saved us', async () => {
  // What the old code effectively did. Proving the gap the incident exposed:
  // the catch never runs because nothing ever rejects.
  let caught = false;
  const raced = await Promise.race([
    (async () => { try { await hangsForever(); } catch { caught = true; } return 'handler-returned'; })(),
    new Promise((r) => setTimeout(() => r('still-hanging'), 60)),
  ]);
  assert.equal(raced, 'still-hanging');
  assert.equal(caught, false, 'a catch fires on rejection, never on a hang');
});

test('a fast success passes straight through and clears its timer', async () => {
  assert.equal(await withTimeout(Promise.resolve(42), 1000, 'fast'), 42);
  // If the timer leaked, node would stay alive past the test; --test-force-exit
  // would mask that, so assert the handle count instead.
  const before = process._getActiveHandles?.().length ?? 0;
  await withTimeout(Promise.resolve('x'), 5000, 'leak check');
  const after = process._getActiveHandles?.().length ?? 0;
  assert.ok(after <= before, 'the 5s timer must not outlive the call');
});

test('a real rejection still rejects with its own error, not the timeout', async () => {
  await assert.rejects(
    () => withTimeout(Promise.reject(new Error('ECONNREFUSED')), 1000, 'hard error'),
    /ECONNREFUSED/,
  );
});

test('the label names the caller, so a log says which call stalled', async () => {
  await assert.rejects(() => withTimeout(hangsForever(), 10, 'autocharge enqueue'),
    /autocharge enqueue timed out/);
  await assert.rejects(() => withTimeout(hangsForever(), 10),
    /operation timed out/);
});

test('callers that merely accelerate work must fail OPEN', async () => {
  // The shape every caller uses: rate limit, throttle, job enqueue. A timeout
  // means "carry on without it", never "reject the customer's request".
  const allow = async () => {
    try {
      await withTimeout(hangsForever(), 20, 'rate-limit incr');
      return 'counted';
    } catch {
      return 'allowed anyway';
    }
  };
  assert.equal(await allow(), 'allowed anyway');
});
