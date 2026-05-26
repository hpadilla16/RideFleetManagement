/**
 * mapDetailToRow — dedicated test suite against REAL TL JSON shapes.
 *
 * Keys verified from production booking ZE40774901BA (synced 2026-05-20).
 * If TL changes their JSON shape we want these to fail loudly.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { mapDetailToRow } from './tl-international.service.js';

// Real TL detail payload (anonymized to match what we saw in the wild).
// Field order matches what TL returns so future diffs stay readable.
const REAL_TL_DETAIL = {
  firstname: 'Ilyana',
  lastname: 'Valentin',
  tele: '',
  mobile: '',
  email: null,
  country: 'US',
  flight: 'DL1961',
  acriss: 'CFAR',
  vehname: null,
  vmake: null,
  pickupdate: 1800378000,   // 2027-01-19T17:00:00Z (UNIX seconds)
  pickuploc: 'SJUA01',
  dropoffdate: 1800723600,  // 2027-01-23T17:00:00Z
  dropoffloc: 'SJUA01',
  amount: '60.00',
  royalty: '3.77',
  currency: 'USD',
  sourcex: 'BookingGroupLtd3996',
  yourref: 'B97366297',
  status: null,
};

test('mapDetailToRow: maps the real ZE40774901BA payload onto every column', () => {
  const row = mapDetailToRow(REAL_TL_DETAIL, 'ZE40774901BA');

  assert.equal(row.externalRef, 'ZE40774901BA');
  assert.equal(row.customerFirstName, 'Ilyana');
  assert.equal(row.customerLastName, 'Valentin');
  assert.equal(row.customerEmail, null);
  assert.equal(row.customerPhone, null);    // tele="" + mobile="" → null
  assert.equal(row.customerCountry, 'US');
  assert.equal(row.flightNumber, 'DL1961');
  assert.equal(row.vehicleAcriss, 'CFAR');
  assert.equal(row.vehicleDescription, null);
  assert.equal(row.pickupLocation, 'SJUA01');
  assert.equal(row.dropoffLocation, 'SJUA01');
  assert.equal(row.totalAmount, '60.00');
  assert.equal(row.currency, 'USD');
  assert.equal(row.channel, 'BookingGroupLtd3996');
  assert.equal(row.supplierRef, 'B97366297');
  assert.equal(row.status, null);
  assert.equal(row.rawJson, REAL_TL_DETAIL); // preserved by reference
});

test('mapDetailToRow: UNIX-seconds pickupdate → correct UTC Date', () => {
  const row = mapDetailToRow(REAL_TL_DETAIL, 'ZE40774901BA');
  assert.ok(row.pickupAt instanceof Date);
  // 2026-05-26: production data showed TL's UNIX seconds encode the
  // wall-clock time in PR as if the components were UTC. So 1800378000
  // (whose `new Date()` would naively be 2027-01-19T17:00:00Z) is
  // re-interpreted as 17:00 in America/Puerto_Rico = 21:00 UTC.
  assert.equal(row.pickupAt.toISOString(), '2027-01-19T21:00:00.000Z');
  assert.equal(row.dropoffAt.toISOString(), '2027-01-23T21:00:00.000Z');
});

test('mapDetailToRow: empty-string tele falls through to mobile, then null', () => {
  const a = mapDetailToRow({ tele: '', mobile: '+17875551234' }, 'X');
  assert.equal(a.customerPhone, '+17875551234');

  const b = mapDetailToRow({ tele: '   ', mobile: '   ' }, 'X');
  assert.equal(b.customerPhone, null);

  const c = mapDetailToRow({ tele: '7875559999' }, 'X');
  assert.equal(c.customerPhone, '7875559999');
});

test('mapDetailToRow: amount decimal-string handling', () => {
  assert.equal(mapDetailToRow({ amount: '60.00' }, 'X').totalAmount, '60.00');
  assert.equal(mapDetailToRow({ amount: '0' }, 'X').totalAmount, null);
  assert.equal(mapDetailToRow({ amount: '0.00' }, 'X').totalAmount, null);
  assert.equal(mapDetailToRow({ amount: '' }, 'X').totalAmount, null);
  assert.equal(mapDetailToRow({ amount: null }, 'X').totalAmount, null);
  assert.equal(mapDetailToRow({ amount: '  247.50 ' }, 'X').totalAmount, '247.50');
});

test('mapDetailToRow: ms timestamps and ISO strings still work (defensive)', () => {
  // ms timestamp gets the same TL-local-as-UTC reinterpretation as seconds.
  const ms = mapDetailToRow({ pickupdate: 1800378000000 }, 'X');
  assert.equal(ms.pickupAt.toISOString(), '2027-01-19T21:00:00.000Z');

  // ISO strings carrying explicit Z stay as-is (passes through parseDateTimeInTz
  // unchanged) — caller-supplied UTC means UTC.
  const iso = mapDetailToRow({ pickupdate: '2027-01-19T17:00:00Z' }, 'X');
  assert.equal(iso.pickupAt.toISOString(), '2027-01-19T17:00:00.000Z');

  // Numeric-string seconds get the same reinterpretation as numeric seconds.
  const numStr = mapDetailToRow({ pickupdate: '1800378000' }, 'X');
  assert.equal(numStr.pickupAt.toISOString(), '2027-01-19T21:00:00.000Z');
});

test('mapDetailToRow: malformed/empty dates → null without throwing', () => {
  const row = mapDetailToRow(
    { pickupdate: 'not-a-date', dropoffdate: '', flight: 'AA1' },
    'X',
  );
  assert.equal(row.pickupAt, null);
  assert.equal(row.dropoffAt, null);
  assert.equal(row.flightNumber, 'AA1'); // other fields still mapped
});

test('mapDetailToRow: legacy key fallbacks still work (back-compat)', () => {
  // Caller might pass our older guessed shape (e.g. test fixtures).
  const row = mapDetailToRow(
    {
      firstName: 'Carlos',
      last_name: 'Vega',
      phone: '7875550000',
      vehicleClass: 'ECAR',
      pickup: '2026-06-01T08:00:00Z',
      pickup_location: 'BQNA01',
      dropoff: '2026-06-05T08:00:00Z',
      dropoff_location: 'BQNA01',
      total: '99.99',
      channel: 'EXPEDIA02',
      supplierRef: 'EXP-1',
    },
    'X',
  );
  assert.equal(row.customerFirstName, 'Carlos');
  assert.equal(row.customerLastName, 'Vega');
  assert.equal(row.customerPhone, '7875550000');
  assert.equal(row.vehicleAcriss, 'ECAR');
  assert.equal(row.pickupLocation, 'BQNA01');
  assert.equal(row.dropoffLocation, 'BQNA01');
  assert.equal(row.totalAmount, '99.99');
  assert.equal(row.channel, 'EXPEDIA02');
  assert.equal(row.supplierRef, 'EXP-1');
  assert.ok(row.pickupAt instanceof Date);
});

test('mapDetailToRow: real key takes precedence over legacy key', () => {
  // If both `sourcex` (real) and `channel` (legacy) are present, real wins.
  const row = mapDetailToRow(
    { sourcex: 'REAL', channel: 'LEGACY', yourref: 'R1', supplierRef: 'L1', acriss: 'CFAR', vehicleClass: 'XXXX' },
    'X',
  );
  assert.equal(row.channel, 'REAL');
  assert.equal(row.supplierRef, 'R1');
  assert.equal(row.vehicleAcriss, 'CFAR');
});

test('mapDetailToRow: vehname preferred over vmake', () => {
  const a = mapDetailToRow({ vehname: 'Toyota Corolla', vmake: 'Toyota' }, 'X');
  assert.equal(a.vehicleDescription, 'Toyota Corolla');

  const b = mapDetailToRow({ vehname: null, vmake: 'Toyota' }, 'X');
  assert.equal(b.vehicleDescription, 'Toyota');
});

test('mapDetailToRow: currency defaults to USD when omitted', () => {
  const row = mapDetailToRow({ firstname: 'X' }, 'X');
  assert.equal(row.currency, 'USD');
});

test('mapDetailToRow: null/undefined input returns stub with rawJson preserved', () => {
  const a = mapDetailToRow(null, 'ZE_NULL');
  assert.equal(a.externalRef, 'ZE_NULL');
  assert.ok(a.rawJson);

  const b = mapDetailToRow(undefined, 'ZE_UNDEF');
  assert.equal(b.externalRef, 'ZE_UNDEF');
  assert.ok(b.rawJson);

  // Non-object primitives (defensive)
  const c = mapDetailToRow('oops', 'ZE_STR');
  assert.equal(c.externalRef, 'ZE_STR');
});

test('mapDetailToRow: royalty is preserved in rawJson for payout reconciliation', () => {
  // Royalty (TL commission per booking) is intentionally NOT a column; we
  // pull it from rawJson when computing monthly payouts.
  const row = mapDetailToRow(REAL_TL_DETAIL, 'ZE40774901BA');
  assert.equal(row.rawJson.royalty, '3.77');
});
