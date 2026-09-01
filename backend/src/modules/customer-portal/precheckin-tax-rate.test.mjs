/**
 * WHICH TAX RATE THE OTA PRE-CHECK-IN APPLIES — the DB-FREE half.
 *
 * WHY THIS FILE EXISTS AT ALL, given precheckin-charges.embedded.test.mjs
 * already has four cases on the same rule.
 *
 * Those four go through Postgres, and Postgres is exactly what makes the
 * important one undiscriminating. `ReservationPricingSnapshot.taxRate` is
 * `Decimal?`, so Prisma hands the row back with a Decimal OBJECT in that field,
 * and `new Decimal(0)` is an object: truthy. The embedded case named "writes no
 * tax row when the snapshot rate is a deliberate zero" therefore passes
 * IDENTICALLY whether the code under it coalesces on `??` or on `||` — it looks
 * like a guard on the zero rule and guards nothing. (Reverted `== null` back to
 * `||` and re-ran it to be sure: still green. That is three times this month a
 * green test has asserted something false.)
 *
 * A PRIMITIVE 0 is the only input that tells the two apart, and no query in
 * this codebase produces one for that column. So the rule lives in a pure
 * function, resolveTaxRate(), and the discriminating case is fed to it by hand,
 * here, with no database in the way. Same shape as insuranceBaseFrom() next to
 * it, and same reason.
 *
 * The second describe() is a source-level guard on the WRITER, for the mirror
 * reason: no behavioural case in either suite can see what a route stores when
 * the pickup location does not resolve.
 *
 * DB-free, milliseconds, and wired into the money-guard step of beta-ci.yml.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { resolveTaxRate } from './precheckin-charges.js';

/**
 * Stands in for a Prisma Decimal: an OBJECT that numifies to its value. The
 * point is `Boolean(decimalLike(0)) === true`, which is what hides the bug from
 * every database-backed case.
 */
const decimalLike = (value) => ({
  valueOf: () => value,
  toString: () => String(value),
});

describe('resolveTaxRate: a stored zero is a rate, not a missing value', () => {
  it('THE DISCRIMINATING CASE — a primitive 0 snapshot rate beats a nonzero location', () => {
    // The one assertion in the repo that separates `??`/`== null` from `||`.
    // With a falsy coalesce this returns 10 and the customer is charged tax the
    // snapshot said not to charge; car-sharing.service.js:253 writes exactly
    // this shape (literal 0) on reservations whose pickup location has a rate.
    assert.equal(resolveTaxRate({ snapshotRate: 0, locationRate: 10 }), 0);
  });

  it('and a Decimal-shaped 0 too — the shape the database actually returns', () => {
    // Green under `||` as well. Kept BECAUSE it is undiscriminating: it is the
    // production shape, and it documents that the case above is the one doing
    // the work.
    assert.equal(resolveTaxRate({ snapshotRate: decimalLike(0), locationRate: 10 }), 0);
  });

  it('falls back to the location only when the snapshot rate is null', () => {
    assert.equal(resolveTaxRate({ snapshotRate: null, locationRate: 10 }), 10);
  });

  it('treats undefined like null — a reservation with no snapshot row at all', () => {
    // findUnique({ include: { pricingSnapshot: true } }) yields null, and
    // `null?.taxRate` is undefined, not null. `!= null` has to catch both.
    assert.equal(resolveTaxRate({ snapshotRate: undefined, locationRate: 7.5 }), 7.5);
    assert.equal(resolveTaxRate({ locationRate: 7.5 }), 7.5);
  });

  it('the snapshot wins whenever it has anything to say', () => {
    assert.equal(resolveTaxRate({ snapshotRate: 7.5, locationRate: 10 }), 7.5);
    assert.equal(resolveTaxRate({ snapshotRate: decimalLike(7.5), locationRate: 10 }), 7.5);
    // Strings: the JSON/cache round-trip shape. Still the snapshot's number.
    assert.equal(resolveTaxRate({ snapshotRate: '7.50', locationRate: 10 }), 7.5);
    assert.equal(resolveTaxRate({ snapshotRate: '0.00', locationRate: 10 }), 0);
  });

  it('is 0 when there is nothing to read anywhere — never NaN', () => {
    // 0 means "write no tax row". NaN would fail the `taxRate > 0` guard too,
    // but it would also reach `taxRate.toFixed(2)` in the row NAME on any path
    // that skipped that guard, and "Sales Tax (NaN%)" is worse than no row.
    assert.equal(resolveTaxRate({ snapshotRate: null, locationRate: null }), 0);
    assert.equal(resolveTaxRate({}), 0);
    assert.equal(resolveTaxRate(), 0);
    assert.equal(resolveTaxRate({ snapshotRate: 'not a rate' }), 0);
  });
});

describe('nothing writes a snapshot tax rate of 0 to mean "I do not know"', () => {
  it('reservations.routes.js stores NULL when the pickup location does not resolve', async () => {
    // MONEY, and source-level because it has to be. The value written here is
    // only observable much later, on a different route, as a tax row that never
    // appears — no case in either suite can see it at the moment it is decided.
    //
    // pickupLoc is null when req.body.pickupLocationId does not resolve inside
    // the caller's tenant scope, and validateLocationWindow() returns silently
    // instead of refusing (reservations.service.js:873), so the reservation is
    // created anyway. `?? 0` there invented a rate of zero, and every reader now
    // honours a stored zero as a real rate — so it suppressed sales tax on that
    // reservation permanently, on this route and on the two agreement paths.
    const src = await readFile(
      new URL('../reservations/reservations.routes.js', import.meta.url), 'utf8',
    );
    assert.ok(
      src.includes('taxRate: pickupLoc?.taxRate ?? null'),
      'reservations.routes.js must write `pickupLoc?.taxRate ?? null` in the pricing snapshot',
    );
    assert.ok(
      !src.includes('taxRate: pickupLoc?.taxRate ?? 0'),
      'a snapshot taxRate of `?? 0` is a rate of zero to every reader — write null for "unknown"',
    );
  });
});
