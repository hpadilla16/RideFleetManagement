/**
 * The extension return date must mean what the person typed — DB-free.
 *
 * Hector, 2026-08-07: staff at San Juan set an evening return on
 * TL-ZE40806355BA and it kept jumping backwards into the afternoon.
 *
 * The extend dialog submits the raw <input type="datetime-local"> value, a
 * naive "2026-08-07T19:00" with no zone. `new Date()` reads a naive string as
 * the SERVER's local time and the container runs in UTC, so 7 PM was stored as
 * 19:00Z and rendered back to San Juan (UTC-4) as 3 PM. create() and update()
 * had been fixed for this exact thing; extendReservation was missed.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseDateTimeInTz } from '../../lib/date-utils.js';

const PR = 'America/Puerto_Rico'; // UTC-4 year round, no DST

/**
 * What the code used to do, pinned to a UTC server clock.
 *
 * NOT `new Date(v)` — a naive string is read in the RUNNER's timezone, so on a
 * laptop in Puerto Rico the old code produced the right answer and the bug was
 * invisible. It only ever appeared in production, where the container clock is
 * UTC. Appending the Z models that server deterministically, wherever this
 * test runs.
 */
const oldWay = (v) => new Date(`${v}Z`);
/** What it does now. */
const newWay = (v) => parseDateTimeInTz(v, PR);

test('THE BUG: 7 PM in San Juan was stored as 7 PM UTC', () => {
  const typed = '2026-08-07T19:00';
  assert.equal(oldWay(typed).toISOString(), '2026-08-07T19:00:00.000Z',
    'the old path read the naive string as UTC (container clock)');
  assert.equal(newWay(typed).toISOString(), '2026-08-07T23:00:00.000Z',
    '7 PM AST is 23:00Z');
});

test('and the difference is exactly what staff saw on screen', () => {
  const hourInPr = (d) => Number(new Intl.DateTimeFormat('en-US', {
    timeZone: PR, hour: '2-digit', hour12: false,
  }).format(d));
  assert.equal(hourInPr(oldWay('2026-08-07T19:00')), 15, 'typed 7 PM, displayed 3 PM');
  assert.equal(hourInPr(newWay('2026-08-07T19:00')), 19, 'typed 7 PM, displays 7 PM');
});

test('the shift is the tenant offset, so it hits every hour of the day', () => {
  for (const h of ['00', '08', '14', '19', '23']) {
    const typed = `2026-08-07T${h}:30`;
    const drift = (newWay(typed).getTime() - oldWay(typed).getTime()) / 36e5;
    assert.equal(drift, 4, `${h}:30 drifted by 4h`);
  }
});

test('explicit-TZ payloads pass through untouched — VozIA is unaffected', () => {
  for (const iso of ['2026-08-07T23:00:00.000Z', '2026-08-07T19:00:00-04:00']) {
    assert.equal(newWay(iso).toISOString(), '2026-08-07T23:00:00.000Z', iso);
  }
});

test('a garbage value is rejected, not silently coerced', () => {
  for (const bad of ['', null, undefined, 'not-a-date']) {
    const out = newWay(bad);
    assert.ok(out == null || Number.isNaN(out.getTime()), JSON.stringify(bad));
  }
});

test('an extension that only moves the clock forward still moves forward', () => {
  // The service rejects newReturnAt <= current. Under the old parse, extending
  // an 8 PM return to 9 PM produced 21:00Z — BEFORE the stored 00:00Z — and
  // the extension was refused as "must be after the current return date".
  const currentReturn = newWay('2026-08-07T20:00'); // 00:00Z on the 8th
  assert.equal(oldWay('2026-08-07T21:00') > currentReturn, false, 'the old path refused a real extension');
  assert.equal(newWay('2026-08-07T21:00') > currentReturn, true, 'now it is accepted');
});
