/**
 * How short a rental may be — DB-free.
 *
 * Hector, 2026-08-09: "nada menos de 24 horas al menos que haiga hourly rate
 * configurado."
 *
 * The old rule lived ONLY in the browser, as a `min` attribute computed as
 * pickup + 1 day. That made it both too strict and too weak at once: a desktop
 * agent could type past it, an iPhone's picker clamped hard (an International
 * agent could not save a booking at all), and an API caller never saw it.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  rentalMinimum, sellsByHour, checkRentalSpan, rentalSpanMessage, DEFAULT_MINIMUM_HOURS,
} from './rental-minimum.js';

const daily = { plan: { useHourlyRates: false }, row: { hourly: 0, minHourly: 0 } };
const hourly = (h = 1) => ({ plan: { useHourlyRates: true }, row: { hourly: 12.5, minHourly: h } });

test('THE RULE: no hourly rate configured means 24 hours', () => {
  assert.deepEqual(rentalMinimum([daily]), { minimumHours: 24, hourly: false });
  assert.deepEqual(rentalMinimum([]), { minimumHours: DEFAULT_MINIMUM_HOURS, hourly: false });
});

test('an hourly rate lifts the floor to what that plan will sell', () => {
  assert.deepEqual(rentalMinimum([hourly(4)]), { minimumHours: 4, hourly: true });
  // minHourly unset means the plan takes any length down to one hour.
  assert.deepEqual(rentalMinimum([hourly(0)]), { minimumHours: 1, hourly: true });
});

test('BOTH knobs must agree — a flag without a price does not sell by the hour', () => {
  assert.equal(sellsByHour({ useHourlyRates: true }, { hourly: 0 }), false, 'no price');
  assert.equal(sellsByHour({ useHourlyRates: false }, { hourly: 20 }), false, 'plan never enabled it');
  assert.equal(sellsByHour({ useHourlyRates: true }, { hourly: 20 }), true);
  // And a priced-but-disabled row must not quietly unlock short rentals.
  assert.equal(rentalMinimum([{ plan: { useHourlyRates: false }, row: { hourly: 20 } }]).minimumHours, 24);
});

test('with several plans covering a class, the most permissive wins', () => {
  // The engine quotes whichever is cheapest anyway; refusing a booking that
  // one of them would happily sell is the old too-strict failure again.
  assert.equal(rentalMinimum([daily, hourly(6), hourly(2)]).minimumHours, 2);
});

test('a 6-hour rental: refused on daily-only, allowed where hours are sold', () => {
  const span = { pickupAt: '2026-08-10T14:00:00Z', returnAt: '2026-08-10T20:00:00Z' };
  assert.equal(checkRentalSpan({ ...span, offerings: [daily] }).ok, false);
  assert.equal(checkRentalSpan({ ...span, offerings: [hourly(4)] }).ok, true);
  assert.equal(checkRentalSpan({ ...span, offerings: [hourly(8)] }).ok, false, 'below that plan\'s own minimum');
});

test('exactly 24 hours is allowed — the floor is inclusive', () => {
  const r = checkRentalSpan({
    pickupAt: '2026-08-10T14:00:00Z', returnAt: '2026-08-11T14:00:00Z', offerings: [daily],
  });
  assert.equal(r.ok, true);
  assert.equal(r.hours, 24);
});

test('a minute under the floor is refused, but a rounding hair is not', () => {
  assert.equal(checkRentalSpan({
    pickupAt: '2026-08-10T14:00:00Z', returnAt: '2026-08-11T13:30:00Z', offerings: [daily],
  }).ok, false, '23.5h is genuinely short');
  assert.equal(checkRentalSpan({
    pickupAt: '2026-08-10T14:00:00.000Z', returnAt: '2026-08-11T13:59:59.700Z', offerings: [daily],
  }).ok, true, 'a picker landing 300ms under a whole day is not a business decision');
});

test('garbage dates are refused, not coerced', () => {
  assert.equal(checkRentalSpan({ pickupAt: 'nope', returnAt: 'also nope', offerings: [daily] }).ok, false);
});

test('the refusal tells the agent what to DO about it', () => {
  assert.match(rentalSpanMessage({ minimumHours: 24, hourly: false }), /hourly rate has to be configured/);
  assert.match(rentalSpanMessage({ minimumHours: 4, hourly: true }), /minimum is 4 hours/);
  assert.match(rentalSpanMessage({ minimumHours: 1, hourly: true }), /minimum is 1 hour\./);
});
