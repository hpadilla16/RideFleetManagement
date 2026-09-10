/**
 * Per-run day coverage (2026-09-10).
 *
 * Hector, after watching a manual SJU run: "un aviso cuando un día vuelve
 * vacío". That run asked Kayak for five pickup dates; one returned ZERO offers
 * and another needed a retry after a read timeout, and the run still recorded
 * SUCCESS with 104 offers. Nothing anywhere said a fifth of the window was
 * missing — and the pricing engine treats whatever landed as "the market".
 *
 * The load-bearing case is the first: OK requests minus days that produced rows
 * is the number of days that came back empty. The second is that the number can
 * never go negative, because a nonsense count on a dashboard poisons trust in
 * every other number on it.
 *
 * Pure: no DB.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

const { describeRunCoverage } = await import('./market-scrape-profile.service.js');

const day = (d) => new Date(`2026-09-${d}T00:00:00.000Z`);

test('THE ONE THAT MATTERS: an OK request that produced no rows is an empty day', () => {
  // The real run: 5 days asked, 4 with offers, day 2026-09-12 silent.
  const c = describeRunCoverage({ requestsOk: 5, requestsErr: 0 }, [day(11), day(13), day(14), day(15)]);
  assert.equal(c.daysWithOffers, 4);
  assert.equal(c.emptyDays, 1);
  assert.equal(c.hasEmptyDays, true);
  assert.deepEqual(c.pickupDatesWithOffers, ['2026-09-11', '2026-09-13', '2026-09-14', '2026-09-15']);
});

test('a complete run reports no empty days', () => {
  const c = describeRunCoverage({ requestsOk: 3, requestsErr: 0 }, [day(11), day(12), day(13)]);
  assert.equal(c.emptyDays, 0);
  assert.equal(c.hasEmptyDays, false);
});

test('a run that produced NOTHING is all empty days, not an error', () => {
  // This is the state every SJU run was in before the RateOffer cutover was
  // understood: healthy counters, no rows the dashboard could find.
  const c = describeRunCoverage({ requestsOk: 14, requestsErr: 0 }, []);
  assert.equal(c.emptyDays, 14);
  assert.equal(c.daysWithOffers, 0);
});

test('never negative: extra days from a retry do not invert the count', () => {
  // A retry can land rows for a day the OK counter never incremented.
  const c = describeRunCoverage({ requestsOk: 2, requestsErr: 1 }, [day(11), day(12), day(13)]);
  assert.equal(c.emptyDays, 0, 'clamped, not -1');
  assert.equal(c.daysWithOffers, 3);
});

test('failed requests are counted separately — they already report themselves', () => {
  // An errored day is visible as requestsErr and in errorMessage. Folding it
  // into emptyDays would double-report one problem and hide the silent kind.
  const c = describeRunCoverage({ requestsOk: 4, requestsErr: 1 }, [day(11), day(12), day(13), day(14)]);
  assert.equal(c.emptyDays, 0);
  assert.equal(c.requestsErr, 1);
});

test('the same pickup date twice counts once', () => {
  // One supplier per provider means many rows per day; days are distinct dates.
  const c = describeRunCoverage({ requestsOk: 2 }, [day(11), day(11), day(11), day(12)]);
  assert.equal(c.daysWithOffers, 2);
  assert.equal(c.emptyDays, 0);
});

test('ISO strings and Date objects are the same day', () => {
  const c = describeRunCoverage({ requestsOk: 2 }, ['2026-09-11', '2026-09-11T00:00:00.000Z', day(12)]);
  assert.equal(c.daysWithOffers, 2);
});

test('junk dates are ignored, not counted as coverage', () => {
  const c = describeRunCoverage({ requestsOk: 3 }, [null, undefined, '', 'not-a-date', new Date('nope'), day(11)]);
  assert.equal(c.daysWithOffers, 1);
  assert.equal(c.emptyDays, 2);
});

test('a RUNNING run has no counters yet and must not claim empty days', () => {
  // The scraper writes requestsOk only when the run closes. Until then the
  // honest answer is zero, not "everything is empty".
  const c = describeRunCoverage({ requestsOk: 0, requestsErr: 0 }, [day(11)]);
  assert.equal(c.emptyDays, 0);
  assert.equal(c.hasEmptyDays, false);
  assert.equal(c.daysWithOffers, 1);
});

test('never throws on junk', () => {
  for (const args of [[], [null], [{}, null], [{ requestsOk: 'x' }, 'nope'], [undefined, undefined]]) {
    const c = describeRunCoverage(...args);
    assert.equal(typeof c.emptyDays, 'number');
    assert.ok(c.emptyDays >= 0);
  }
});
