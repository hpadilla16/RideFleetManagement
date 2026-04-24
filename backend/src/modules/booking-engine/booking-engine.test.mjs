import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { filterMandatoryFeesForChannel } from './fee-channel-filter.js';

// filterMandatoryFeesForChannel is the single source of truth for deciding
// which mandatory fees get auto-applied to a reservation. It's used both by
// the public booking quote path (booking-engine.service.js) and by the
// reservation pricing sync (reservation-pricing.service.js). These tests
// exercise the channel-based exclusion that keeps website-only fees
// (displayOnline=true) off STAFF and CAR_SHARING reservations.

const feeActiveMandatory = {
  id: 'fee-1',
  name: 'Cleaning Fee',
  isActive: true,
  mandatory: true,
  displayOnline: false
};

const feeWebsiteOnly = {
  id: 'fee-2',
  name: 'Website Service Charge',
  isActive: true,
  mandatory: true,
  displayOnline: true
};

const feeInactive = {
  id: 'fee-3',
  name: 'Deprecated Fee',
  isActive: false,
  mandatory: true,
  displayOnline: false
};

const feeOptional = {
  id: 'fee-4',
  name: 'Optional Add-On',
  isActive: true,
  mandatory: false,
  displayOnline: false
};

describe('filterMandatoryFeesForChannel', () => {
  it('includes regular mandatory fees for WEBSITE channel', () => {
    const result = filterMandatoryFeesForChannel([feeActiveMandatory], 'WEBSITE');
    assert.equal(result.length, 1);
    assert.equal(result[0].id, 'fee-1');
  });

  it('includes website-only fees for WEBSITE channel', () => {
    const result = filterMandatoryFeesForChannel([feeWebsiteOnly], 'WEBSITE');
    assert.equal(result.length, 1);
    assert.equal(result[0].id, 'fee-2');
  });

  it('includes BOTH regular and website-only fees for WEBSITE channel', () => {
    const result = filterMandatoryFeesForChannel([feeActiveMandatory, feeWebsiteOnly], 'WEBSITE');
    assert.equal(result.length, 2);
  });

  it('EXCLUDES website-only fees for STAFF channel', () => {
    const result = filterMandatoryFeesForChannel([feeActiveMandatory, feeWebsiteOnly], 'STAFF');
    assert.equal(result.length, 1);
    assert.equal(result[0].id, 'fee-1');
  });

  it('EXCLUDES website-only fees for CAR_SHARING channel', () => {
    const result = filterMandatoryFeesForChannel([feeActiveMandatory, feeWebsiteOnly], 'CAR_SHARING');
    assert.equal(result.length, 1);
    assert.equal(result[0].id, 'fee-1');
  });

  it('defaults to WEBSITE channel when bookingChannel is null', () => {
    const result = filterMandatoryFeesForChannel([feeActiveMandatory, feeWebsiteOnly], null);
    assert.equal(result.length, 2);
  });

  it('defaults to WEBSITE channel when bookingChannel is undefined', () => {
    const result = filterMandatoryFeesForChannel([feeActiveMandatory, feeWebsiteOnly], undefined);
    assert.equal(result.length, 2);
  });

  it('defaults to WEBSITE channel when bookingChannel is empty string', () => {
    const result = filterMandatoryFeesForChannel([feeActiveMandatory, feeWebsiteOnly], '');
    assert.equal(result.length, 2);
  });

  it('is case-insensitive for bookingChannel matching', () => {
    const websiteLowerResult = filterMandatoryFeesForChannel([feeWebsiteOnly], 'website');
    assert.equal(websiteLowerResult.length, 1);

    const staffLowerResult = filterMandatoryFeesForChannel([feeWebsiteOnly], 'staff');
    assert.equal(staffLowerResult.length, 0);
  });

  it('excludes inactive fees regardless of channel', () => {
    assert.equal(filterMandatoryFeesForChannel([feeInactive], 'WEBSITE').length, 0);
    assert.equal(filterMandatoryFeesForChannel([feeInactive], 'STAFF').length, 0);
  });

  it('excludes non-mandatory fees regardless of channel', () => {
    assert.equal(filterMandatoryFeesForChannel([feeOptional], 'WEBSITE').length, 0);
    assert.equal(filterMandatoryFeesForChannel([feeOptional], 'STAFF').length, 0);
  });

  it('returns empty array when input is null or undefined', () => {
    assert.deepEqual(filterMandatoryFeesForChannel(null, 'WEBSITE'), []);
    assert.deepEqual(filterMandatoryFeesForChannel(undefined, 'STAFF'), []);
  });

  it('returns empty array for empty input', () => {
    assert.deepEqual(filterMandatoryFeesForChannel([], 'WEBSITE'), []);
  });

  it('skips null/undefined entries in the fee list', () => {
    const result = filterMandatoryFeesForChannel([null, undefined, feeActiveMandatory], 'WEBSITE');
    assert.equal(result.length, 1);
    assert.equal(result[0].id, 'fee-1');
  });

  it('regression: website-only fee on a STAFF reservation is the BUG this fix prevents', () => {
    // Pre-fix, a fee with displayOnline=true would leak onto STAFF reservations
    // via syncMandatoryLocationFees. This test encodes the post-fix expectation.
    const fees = [feeActiveMandatory, feeWebsiteOnly];
    const websiteReservationFees = filterMandatoryFeesForChannel(fees, 'WEBSITE');
    const staffReservationFees = filterMandatoryFeesForChannel(fees, 'STAFF');
    assert.equal(websiteReservationFees.length, 2, 'website reservation sees both fees');
    assert.equal(staffReservationFees.length, 1, 'staff reservation sees only the non-website fee');
    assert.equal(staffReservationFees[0].id, 'fee-1', 'the leaked fee must be fee-1, not fee-2');
  });
});
