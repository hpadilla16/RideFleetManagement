/**
 * Unit tests for the cron-side stealth mitigations in the TL
 * International worker:
 *   - isWithinQuietHours()      — 2am-6am AST window
 *   - tlSyncHandler skip logic  — cron honors quiet hours, manual bypasses
 *
 * Network / Prisma are NOT exercised here. The handler exits early when
 * the quiet-hours guard fires, so we can test that branch without any
 * database wiring. For the non-skip branch we just verify the manual
 * code path goes PAST the guard (we don't run the full handler since
 * that needs Prisma + Puppeteer).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

process.env.INTEGRATION_ENC_KEY = crypto.randomBytes(32).toString('base64');

const { isWithinQuietHours, tlSyncHandler, JITTER_MAX_MS } = await import('./tl-international.worker.js');

// ----------------------------------------------------------------------------
// isWithinQuietHours() — pure function, AST = UTC-4 year-round
// ----------------------------------------------------------------------------

function utcAt(prHour, prMinute = 0) {
  // PR (UTC-4) hour H corresponds to UTC hour (H+4) % 24.
  const utcHour = (prHour + 4) % 24;
  const d = new Date(Date.UTC(2026, 4, 20, utcHour, prMinute, 0));
  return d;
}

test('isWithinQuietHours returns true at 02:00 AST (window start)', () => {
  assert.equal(isWithinQuietHours(utcAt(2, 0)), true);
});

test('isWithinQuietHours returns true at 03:30 AST', () => {
  assert.equal(isWithinQuietHours(utcAt(3, 30)), true);
});

test('isWithinQuietHours returns true at 05:59 AST (just before window end)', () => {
  assert.equal(isWithinQuietHours(utcAt(5, 59)), true);
});

test('isWithinQuietHours returns false at 06:00 AST (exclusive upper bound)', () => {
  assert.equal(isWithinQuietHours(utcAt(6, 0)), false);
});

test('isWithinQuietHours returns false at 01:59 AST (just before window start)', () => {
  assert.equal(isWithinQuietHours(utcAt(1, 59)), false);
});

test('isWithinQuietHours returns false at noon AST', () => {
  assert.equal(isWithinQuietHours(utcAt(12, 0)), false);
});

test('isWithinQuietHours returns false at midnight AST', () => {
  assert.equal(isWithinQuietHours(utcAt(0, 0)), false);
});

test('isWithinQuietHours returns false at 23:00 AST', () => {
  assert.equal(isWithinQuietHours(utcAt(23, 0)), false);
});

// ----------------------------------------------------------------------------
// tlSyncHandler quiet-hours skip — cron triggered
// ----------------------------------------------------------------------------
//
// We control "now" indirectly: when the system clock is OUTSIDE the
// quiet window, force the env flag on and rely on the handler's
// `isWithinQuietHours()` call. To make the test deterministic across
// build clocks, we instead set the env flag and call the handler with
// triggeredBy='manual' (which MUST bypass quiet hours), and separately
// test that the handler reads triggeredBy correctly by inspecting
// behavior at a known cron run.
//
// The cleanest hermetic test: monkey-patch Date.now / new Date globally
// for the duration of the call. Node's `node:test` doesn't ship fake
// timers, so we patch the Date constructor minimally — just enough that
// `new Date()` inside the handler returns our fixed instant.

function withFakeNow(utcDate, fn) {
  const RealDate = global.Date;
  const fixedMs = utcDate.getTime();
  class FakeDate extends RealDate {
    constructor(...args) {
      if (args.length === 0) {
        super(fixedMs);
      } else {
        super(...args);
      }
    }
    static now() { return fixedMs; }
  }
  global.Date = FakeDate;
  try {
    return fn();
  } finally {
    global.Date = RealDate;
  }
}

test('tlSyncHandler skips at 03:00 AST when triggered by cron (schedule)', async () => {
  // 03:00 AST = 07:00 UTC
  const at3am = new Date(Date.UTC(2026, 4, 20, 7, 0, 0));
  const result = await withFakeNow(at3am, () =>
    tlSyncHandler({ data: { tenantId: 'tnt_x', triggeredBy: 'schedule' } })
  );
  assert.deepEqual(result, { skipped: true, reason: 'quiet_hours' });
});

test('tlSyncHandler does NOT skip at 03:00 AST when triggered manually', async () => {
  // Manual runs must bypass the quiet-hours guard. The handler will
  // proceed past the guard and try real prisma/puppeteer — we don't
  // want that. Instead we verify by inspecting the EARLY exit shape:
  // skipped:true is ONLY returned by the quiet-hours branch, so any
  // other outcome (thrown error from prisma, or skipped:false) is
  // proof the guard didn't fire. We expect a throw because there's no
  // DB; we catch and assert the error is NOT the quiet-hours skip.
  const at3am = new Date(Date.UTC(2026, 4, 20, 7, 0, 0));
  let outcome;
  try {
    outcome = await withFakeNow(at3am, () =>
      tlSyncHandler({ data: { tenantId: 'tnt_x', triggeredBy: 'manual' } })
    );
  } catch (e) {
    outcome = { thrown: true, message: e.message };
  }
  // Whatever happened, it CANNOT be the quiet-hours skip return shape.
  if (outcome && typeof outcome === 'object' && 'skipped' in outcome && outcome.skipped === true) {
    assert.fail(`Manual run was skipped — should have bypassed quiet hours. Got: ${JSON.stringify(outcome)}`);
  }
});

test('tlSyncHandler skip respects TL_INTERNATIONAL_QUIET_HOURS_ENABLED=false', async () => {
  const prev = process.env.TL_INTERNATIONAL_QUIET_HOURS_ENABLED;
  process.env.TL_INTERNATIONAL_QUIET_HOURS_ENABLED = 'false';
  try {
    const at3am = new Date(Date.UTC(2026, 4, 20, 7, 0, 0));
    let outcome;
    try {
      outcome = await withFakeNow(at3am, () =>
        tlSyncHandler({ data: { tenantId: 'tnt_x', triggeredBy: 'schedule' } })
      );
    } catch (e) {
      outcome = { thrown: true, message: e.message };
    }
    if (outcome && typeof outcome === 'object' && 'skipped' in outcome && outcome.skipped === true) {
      assert.fail(`Cron run was skipped even with quiet hours disabled. Got: ${JSON.stringify(outcome)}`);
    }
  } finally {
    if (prev === undefined) delete process.env.TL_INTERNATIONAL_QUIET_HOURS_ENABLED;
    else process.env.TL_INTERNATIONAL_QUIET_HOURS_ENABLED = prev;
  }
});

// ----------------------------------------------------------------------------
// Jitter knob is sane
// ----------------------------------------------------------------------------

test('JITTER_MAX_MS defaults to 180000ms (3 min)', () => {
  // Only assert when env hasn't been overridden in this process.
  if (process.env.TL_INTERNATIONAL_JITTER_MAX_MS === undefined) {
    assert.equal(JITTER_MAX_MS, 180_000);
  }
});
