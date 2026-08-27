/**
 * Economy (RezLight) — dropoff time regression suite.
 *
 * Driven by economy-detail.fixture.json: a REAL production payload captured
 * from ExternalReservation.rawJson (reservation EEXPA149407E, LAX), PII
 * scrubbed, key names and casing untouched.
 *
 * WHY THIS FILE EXISTS. The importer read `resDropOffFullDate` (capital "O").
 * The portal sends `resDropoffFullDate` (lowercase "o"). The key the code read
 * never existed, so every dropoff fell through to the date-only field and
 * landed at local midnight — 4,661 production rows, ~18 hours early each.
 *
 * It survived a month because the existing tests asserted against a
 * hand-written fixture that spelled the key the way the CODE expected. Such a
 * test passes no matter which spelling is wrong. So: assert against the
 * captured payload, and additionally assert the ABSENCE of the keys we know
 * the portal does not send — that is the part a hand-written fixture cannot do.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

process.env.INTEGRATION_ENC_KEY = crypto.randomBytes(32).toString('base64');
// economy.worker.js imports lib/prisma.js, which constructs a PrismaClient at
// module load. Nothing here touches the DB — this just satisfies the
// constructor. Same guard as economy-stop-sale.test.mjs.
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://u:p@127.0.0.1:5432/none';

const FIXTURE = JSON.parse(
  readFileSync(fileURLToPath(new URL('./economy-detail.fixture.json', import.meta.url)), 'utf8')
);

const { mapRowToExternalReservation } = await import('./economy.worker.js');

const LAX_TZ = 'America/Los_Angeles';
const clone = (v) => JSON.parse(JSON.stringify(v));

// ---------------------------------------------------------------------------
// Guard the fixture itself. If someone "tidies" the capture into the spelling
// the code wants, the regression test silently stops testing anything.
// ---------------------------------------------------------------------------
test('fixture: is the real portal payload, with the portal\'s own inconsistent casing', () => {
  const d = FIXTURE.detail;
  assert.equal(d.resDropoffFullDate, '08/31/2026 18:00', 'lowercase-o full date is what the portal sends');
  assert.ok(!('resDropOffFullDate' in d), 'the capital-O spelling must NOT be in the captured payload');

  // The rest of the dropoff family really does use a capital O — this is the
  // portal being inconsistent with itself, not a transcription slip.
  assert.equal(d.resDropOffDate, '08/31/2026');
  assert.equal(d.resDropOffTime, '18:00');
  assert.equal(d.resDropOffLocation, 'LAXO01');

  assert.equal(d.resPickupFullDate, '08/27/2026 18:00');
});

// ---------------------------------------------------------------------------
// The bug.
// ---------------------------------------------------------------------------
test('dropoffAt: keeps the portal time from resDropoffFullDate (lowercase o)', () => {
  const mapped = mapRowToExternalReservation(FIXTURE.list, {
    detail: FIXTURE.detail,
    timeZone: LAX_TZ,
  });

  // 08/31/2026 18:00 America/Los_Angeles (PDT, UTC-7) === 2026-09-01T01:00:00Z
  assert.equal(mapped.dropoffAt.toISOString(), '2026-09-01T01:00:00.000Z');

  // The pre-fix behaviour was local midnight — assert we are NOT back there.
  assert.notEqual(mapped.dropoffAt.toISOString(), '2026-08-31T07:00:00.000Z');
});

test('dropoffAt: is 18 hours later than the broken date-only value it used to get', () => {
  const mapped = mapRowToExternalReservation(FIXTURE.list, {
    detail: FIXTURE.detail,
    timeZone: LAX_TZ,
  });
  const brokenMidnight = Date.parse('2026-08-31T07:00:00.000Z'); // what prod stored
  const deltaHours = (mapped.dropoffAt.getTime() - brokenMidnight) / 3_600_000;
  assert.equal(deltaHours, 18);
});

test('pickupAt: still correct from resPickupFullDate (must not regress)', () => {
  const mapped = mapRowToExternalReservation(FIXTURE.list, {
    detail: FIXTURE.detail,
    timeZone: LAX_TZ,
  });
  // 08/27/2026 18:00 PDT === 2026-08-28T01:00:00Z
  assert.equal(mapped.pickupAt.toISOString(), '2026-08-28T01:00:00.000Z');
});

test('MIA payload resolves in America/New_York, not the LAX zone', () => {
  const detail = clone(FIXTURE.detail);
  detail.resPickupLocation = 'MIAO01';
  detail.resDropOffLocation = 'MIAO01';
  const list = { ...FIXTURE.list, rgLocPickup: 'MIAO01', rgLocDropOff: 'MIAO01' };

  const mapped = mapRowToExternalReservation(list, { detail, timeZone: 'America/New_York' });
  // 08/31/2026 18:00 EDT (UTC-4) === 2026-08-31T22:00:00Z
  assert.equal(mapped.dropoffAt.toISOString(), '2026-08-31T22:00:00.000Z');
});

// ---------------------------------------------------------------------------
// Tolerated alternate spelling — the portal has proven it may rename this.
// ---------------------------------------------------------------------------
test('dropoffAt: the capital-O spelling is still accepted if the portal ever switches', () => {
  const detail = clone(FIXTURE.detail);
  delete detail.resDropoffFullDate;
  detail.resDropOffFullDate = '08/31/2026 18:00';

  const mapped = mapRowToExternalReservation(FIXTURE.list, { detail, timeZone: LAX_TZ });
  assert.equal(mapped.dropoffAt.toISOString(), '2026-09-01T01:00:00.000Z');
});

test('dropoffAt: lowercase wins when the portal sends BOTH spellings', () => {
  const detail = clone(FIXTURE.detail);
  detail.resDropOffFullDate = '08/31/2026 09:00'; // decoy
  const mapped = mapRowToExternalReservation(FIXTURE.list, { detail, timeZone: LAX_TZ });
  assert.equal(mapped.dropoffAt.toISOString(), '2026-09-01T01:00:00.000Z');
});

// ---------------------------------------------------------------------------
// The fallback must leave a trace (requirement: no more silent degradation).
// ---------------------------------------------------------------------------
test('onDateFallback: silent on the happy path', () => {
  const seen = [];
  mapRowToExternalReservation(FIXTURE.list, {
    detail: FIXTURE.detail,
    timeZone: LAX_TZ,
    onDateFallback: (info) => seen.push(info),
  });
  assert.deepEqual(seen, [], 'no warning when both dates come from their full-date keys');
});

test('onDateFallback: fires with timeLost when the full-date key disappears', () => {
  const detail = clone(FIXTURE.detail);
  delete detail.resDropoffFullDate; // simulate the next portal rename

  const seen = [];
  const mapped = mapRowToExternalReservation(FIXTURE.list, {
    detail,
    timeZone: LAX_TZ,
    onDateFallback: (info) => seen.push(info),
  });

  assert.equal(seen.length, 1);
  assert.deepEqual(seen[0], {
    field: 'dropoffAt',
    source: 'resDropOffDate',
    degraded: true,
    externalRef: 'EEXPA149407E',
  });
  // ...and this is the midnight value the warning is telling us about.
  assert.equal(mapped.dropoffAt.toISOString(), '2026-08-31T07:00:00.000Z');
});

test('onDateFallback: reports the alternate spelling as NOT degraded', () => {
  const detail = clone(FIXTURE.detail);
  delete detail.resDropoffFullDate;
  detail.resDropOffFullDate = '08/31/2026 18:00';

  const seen = [];
  mapRowToExternalReservation(FIXTURE.list, {
    detail, timeZone: LAX_TZ, onDateFallback: (i) => seen.push(i),
  });

  assert.equal(seen.length, 1);
  assert.equal(seen[0].source, 'resDropOffFullDate');
  assert.equal(seen[0].degraded, false, 'time was preserved — worth noting, not a data-loss alarm');
});

test('onDateFallback: falls back to the list column when detail is missing entirely', () => {
  const seen = [];
  const mapped = mapRowToExternalReservation(FIXTURE.list, {
    timeZone: LAX_TZ,
    onDateFallback: (i) => seen.push(i),
  });

  const sources = seen.map((s) => `${s.field}:${s.source}`).sort();
  assert.deepEqual(sources, ['dropoffAt:rgDateDropOff', 'pickupAt:rgDatePickup']);
  assert.ok(seen.every((s) => s.degraded === true));
  // List columns are date-only → local midnight, correctly flagged.
  assert.equal(mapped.dropoffAt.toISOString(), '2026-08-31T07:00:00.000Z');
});

// ---------------------------------------------------------------------------
// Same class of defect found during the audit of this mapper.
// ---------------------------------------------------------------------------
test('vehicleDescription: comes from resVehClassDescription, the key the portal sends', () => {
  const d = FIXTURE.detail;
  // Proof the old keys were never real: absent from the captured payload.
  assert.ok(!('resVehDescription' in d), 'resVehDescription is not a portal key');
  assert.ok(!('resDescription' in d), 'resDescription is not a portal key');

  const mapped = mapRowToExternalReservation(FIXTURE.list, { detail: d, timeZone: LAX_TZ });
  assert.equal(mapped.vehicleDescription, 'Nissan Versa or Similar');
});

test('audit: keys the mapper reads that the portal has never sent stay documented', () => {
  const d = FIXTURE.detail;
  // No country field exists anywhere in the payload — customerCountry cannot be
  // populated from Economy, and no amount of renaming will fix it.
  assert.ok(!('resCustomerCountry' in d));
  assert.equal(
    Object.keys(d).filter((k) => /country/i.test(k)).length, 0,
    'if the portal ever adds a country field, point customerCountry at it'
  );

  // Dead-but-harmless fallbacks: the primary key is present, so values are right.
  assert.ok(!('Currency' in d) && d.resCurrency === 'USD');
  assert.ok(!('RateTotal' in d) && d.resRateTotal === '53.88');

  const mapped = mapRowToExternalReservation(FIXTURE.list, { detail: d, timeZone: LAX_TZ });
  assert.equal(mapped.customerCountry, null);
  assert.equal(mapped.currency, 'USD');
  assert.equal(mapped.totalAmount, '53.88');
});
