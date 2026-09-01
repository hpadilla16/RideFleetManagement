/**
 * Operating hours are a WALL-CLOCK promise, and the container's clock is UTC.
 *
 * Live incident 2026-08-26: a 5:53 PM pickup at a location open 08:00–18:00
 * was rejected as "outside operating hours". The old inline check read the
 * instant with getHours()/getDay()/toISOString(), so 5:53 PM AST arrived as
 * 21:53 and lost. Every assertion below fails against that implementation and
 * passes against the tz-aware one.
 *
 * Deliberately DB-free (pure module) so it runs in the laptop chain.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  evaluateLocationWindow,
  resolveHoursForWeekday,
  wallClockInTz,
  formatLocalTime,
} from './location-window.js';

const PR = 'America/Puerto_Rico'; // UTC-4, no DST — the incident's tenant
const NY = 'America/New_York';    // UTC-4/-5, DST — the harder neighbor

const HOURS_8_TO_18 = { operationsOpenTime: '08:00', operationsCloseTime: '18:00' };

// 2026-08-26 is a Wednesday. 17:53 AST == 21:53Z.
const AT_1753_LOCAL = new Date('2026-08-26T21:53:00Z');
// 19:30 AST == 23:30Z — genuinely after close.
const AT_1930_LOCAL = new Date('2026-08-27T23:30:00Z');
// 09:15 AST == 13:15Z — comfortably open, and the same UTC hour is also open,
// so this one would pass even with the bug. It is here as the control.
const AT_0915_LOCAL = new Date('2026-08-26T13:15:00Z');

test('THE REGRESSION: 5:53 PM local inside 08:00-18:00 is ACCEPTED', () => {
  const v = evaluateLocationWindow(HOURS_8_TO_18, AT_1753_LOCAL, PR);
  assert.equal(v.ok, true, 'a 5:53 PM pickup at a location open until 6 PM must not be refused');
  assert.equal(v.reason, null);
  assert.equal(v.localTime, '5:53 PM');
  assert.equal(v.timeZone, PR);
  // The UTC reading of the same instant is 21:53 — the value that used to lose.
  assert.equal(wallClockInTz(AT_1753_LOCAL, 'UTC').hour, 21);
});

test('a genuinely late local time is still REFUSED, and says why', () => {
  const v = evaluateLocationWindow(HOURS_8_TO_18, AT_1930_LOCAL, PR);
  assert.equal(v.ok, false);
  assert.equal(v.reason, 'OUTSIDE_HOURS');
  assert.equal(v.localTime, '7:30 PM');
  // The message the service builds needs all three facts.
  assert.equal(v.openTime, '08:00');
  assert.equal(v.closeTime, '18:00');
  assert.equal(v.timeZone, PR);
});

test('a within-hours morning stays accepted (control)', () => {
  assert.equal(evaluateLocationWindow(HOURS_8_TO_18, AT_0915_LOCAL, PR).ok, true);
});

test('before opening is refused', () => {
  // 06:40 AST == 10:40Z.
  const v = evaluateLocationWindow(HOURS_8_TO_18, new Date('2026-08-26T10:40:00Z'), PR);
  assert.equal(v.ok, false);
  assert.equal(v.reason, 'OUTSIDE_HOURS');
  assert.equal(v.localTime, '6:40 AM');
});

test('the calendar DAY is the local one, not the UTC one', () => {
  // 20:30 AST on the 26th is 00:30Z on the 27th. A closedDates entry for the
  // 27th must NOT catch a booking that is still the 26th where the sede is.
  const at = new Date('2026-08-27T00:30:00Z');
  const cfg = { ...HOURS_8_TO_18, operationsCloseTime: '23:00', closedDates: ['2026-08-27'] };
  const v = evaluateLocationWindow(cfg, at, PR);
  assert.equal(v.ymd, '2026-08-26');
  assert.equal(v.ok, true);
  // ...and the sede's own closed date does catch it.
  const closed = evaluateLocationWindow({ ...cfg, closedDates: ['2026-08-26'] }, at, PR);
  assert.equal(closed.ok, false);
  assert.equal(closed.reason, 'CLOSED');
  assert.equal(closed.ymd, '2026-08-26');
});

test('the WEEKDAY is the local one', () => {
  // Sunday 2026-08-30 20:30 AST == Monday 00:30Z. closedWeekdays [0] = Sunday.
  const at = new Date('2026-08-31T00:30:00Z');
  const cfg = { operationsOpenTime: '08:00', operationsCloseTime: '23:00', closedWeekdays: [0] };
  const v = evaluateLocationWindow(cfg, at, PR);
  assert.equal(v.ok, false, 'still Sunday in Puerto Rico — the sede is closed');
  assert.equal(v.reason, 'CLOSED');
});

test('per-day weeklyHours override wins over the flat window', () => {
  const cfg = {
    ...HOURS_8_TO_18,
    weeklyHours: { wednesday: { open: '10:00', close: '14:00' } },
  };
  // 09:15 local: inside the flat 08:00-18:00, outside Wednesday's 10-14.
  assert.equal(evaluateLocationWindow(cfg, AT_0915_LOCAL, PR).ok, false);
  // 12:00 AST == 16:00Z.
  assert.equal(evaluateLocationWindow(cfg, new Date('2026-08-26T16:00:00Z'), PR).ok, true);
});

test('weeklyHours enabled:false closes the day', () => {
  const cfg = { ...HOURS_8_TO_18, weeklyHours: { wednesday: { enabled: false } } };
  const v = evaluateLocationWindow(cfg, AT_0915_LOCAL, PR);
  assert.equal(v.ok, false);
  assert.equal(v.reason, 'CLOSED');
});

test('allowOutsideHours waives the window but never the closed day', () => {
  assert.equal(evaluateLocationWindow({ ...HOURS_8_TO_18, allowOutsideHours: true }, AT_1930_LOCAL, PR).ok, true);
  const closed = evaluateLocationWindow(
    { ...HOURS_8_TO_18, allowOutsideHours: true, closedWeekdays: [3] },
    AT_0915_LOCAL,
    PR,
  );
  assert.equal(closed.ok, false);
  assert.equal(closed.reason, 'CLOSED');
});

test('a half-configured window has no opinion', () => {
  assert.equal(evaluateLocationWindow({ operationsOpenTime: '08:00' }, AT_1930_LOCAL, PR).ok, true);
  assert.equal(evaluateLocationWindow({}, AT_1930_LOCAL, PR).ok, true);
});

test('a DST tenant is evaluated on the offset in force that day', () => {
  // 2026-01-15 17:30 EST == 22:30Z (UTC-5).
  const winter = evaluateLocationWindow(HOURS_8_TO_18, new Date('2026-01-15T22:30:00Z'), NY);
  assert.equal(winter.ok, true);
  assert.equal(winter.localTime, '5:30 PM');
  // 2026-07-15 17:30 EDT == 21:30Z (UTC-4). Same wall clock, different offset.
  const summer = evaluateLocationWindow(HOURS_8_TO_18, new Date('2026-07-15T21:30:00Z'), NY);
  assert.equal(summer.ok, true);
  assert.equal(summer.localTime, '5:30 PM');
});

test('an unknown IANA name falls back to UTC rather than guessing', () => {
  const v = evaluateLocationWindow(HOURS_8_TO_18, AT_1753_LOCAL, 'Mars/Olympus_Mons');
  assert.equal(v.ok, false, 'a misconfigured tz must surface, not be papered over');
});

test('resolveHoursForWeekday maps 0..6 to sunday..saturday', () => {
  const cfg = { weeklyHours: { sunday: { open: '09:00', close: '13:00' }, saturday: { open: '07:00', close: '19:00' } } };
  assert.equal(resolveHoursForWeekday(cfg, 0).openTime, '09:00');
  assert.equal(resolveHoursForWeekday(cfg, 6).closeTime, '19:00');
  assert.deepEqual(resolveHoursForWeekday({ operationsOpenTime: '08:00' }, 3), {
    closed: false, openTime: '08:00', closeTime: undefined,
  });
});

test('formatLocalTime renders the 12-hour edges', () => {
  assert.equal(formatLocalTime(0), '12:00 AM');
  assert.equal(formatLocalTime(12 * 60), '12:00 PM');
  assert.equal(formatLocalTime(23 * 60 + 5), '11:05 PM');
});

test('an unparseable instant yields no opinion instead of throwing', () => {
  assert.equal(evaluateLocationWindow(HOURS_8_TO_18, 'not-a-date', PR).ok, true);
});
