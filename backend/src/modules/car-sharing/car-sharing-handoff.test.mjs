import test from 'node:test';
import assert from 'node:assert/strict';
import {
  canRevealExactHandoff,
  resolveTripHandoffPreset,
  resolveTripAutoRevealEligibility,
  serializePublicTripFulfillmentPlan
} from './car-sharing-handoff.js';

test('canRevealExactHandoff returns true for public exact reveal mode', () => {
  assert.equal(canRevealExactHandoff({ pickupRevealMode: 'PUBLIC_EXACT', confirmedAt: null }), true);
});

test('canRevealExactHandoff returns true when host confirmed exact handoff', () => {
  assert.equal(canRevealExactHandoff({ pickupRevealMode: 'REVEAL_AFTER_BOOKING', confirmedAt: new Date().toISOString() }), true);
});

test('serializePublicTripFulfillmentPlan hides exact address until confirmation', () => {
  const plan = serializePublicTripFulfillmentPlan({
    fulfillmentChoice: 'PICKUP',
    pickupRevealMode: 'REVEAL_AFTER_BOOKING',
    handoffMode: 'LOCKBOX',
    exactAddress1: '123 Hidden St',
    city: 'San Juan',
    instructions: 'Use gate code 2222',
    confirmedAt: null,
    searchPlace: { id: 'place_1' },
    pickupSpot: { id: 'spot_1' },
    serviceArea: null
  });

  assert.equal(plan.exactHandoffVisible, false);
  assert.equal(plan.exactHandoffConfirmed, false);
  assert.equal(plan.exactHandoffPending, true);
  assert.equal(plan.exactHandoff, null);
  assert.equal(plan.instructions, null);
});

test('canRevealExactHandoff auto-reveals self-service lockbox details inside the configured window', () => {
  const pickupAt = '2026-04-08T18:00:00.000Z';
  const visible = canRevealExactHandoff({
    pickupRevealMode: 'REVEAL_AFTER_BOOKING',
    handoffMode: 'LOCKBOX',
    exactAddress1: '123 Hidden St',
    city: 'San Juan',
    confirmedAt: null
  }, {
    pickupAt,
    now: '2026-04-08T08:30:00.000Z',
    selfServiceConfig: {
      carSharingAutoRevealEnabled: true,
      carSharingAutoRevealModes: ['LOCKBOX'],
      carSharingHostPickupRevealWindowHours: 12
    }
  });

  assert.equal(visible, true);
});

test('resolveTripAutoRevealEligibility explains when host confirmation is still required', () => {
  const eligibility = resolveTripAutoRevealEligibility({
    pickupRevealMode: 'REVEAL_AFTER_BOOKING',
    handoffMode: 'IN_PERSON',
    exactAddress1: '123 Hidden St',
    city: 'San Juan',
    searchPlace: { placeType: 'HOTEL' }
  }, '2026-04-08T18:00:00.000Z', {
    carSharingAutoRevealEnabled: true,
    carSharingAutoRevealModes: ['LOCKBOX', 'REMOTE_UNLOCK', 'SELF_SERVICE']
  });

  assert.equal(eligibility.eligible, false);
  assert.match(eligibility.reason, /requires host confirmation/i);
});

test('resolveTripHandoffPreset returns suggested mode and instructions by place type', () => {
  const preset = resolveTripHandoffPreset({
    searchPlace: { placeType: 'AIRPORT' }
  }, {
    carSharingDefaultHandoffMode: 'IN_PERSON',
    carSharingAirportHandoffMode: 'LOCKBOX',
    carSharingAirportInstructionsTemplate: 'Share garage level and stall.'
  });

  assert.equal(preset.placeType, 'AIRPORT');
  assert.equal(preset.suggestedHandoffMode, 'LOCKBOX');
  assert.equal(preset.suggestedInstructions, 'Share garage level and stall.');
});

test('serializePublicTripFulfillmentPlan reveals exact address after confirmation', () => {
  const plan = serializePublicTripFulfillmentPlan({
    fulfillmentChoice: 'PICKUP',
    pickupRevealMode: 'REVEAL_AFTER_BOOKING',
    handoffMode: 'LOCKBOX',
    exactAddress1: '123 Hidden St',
    city: 'San Juan',
    instructions: 'Use gate code 2222',
    confirmedAt: '2026-04-07T12:00:00.000Z',
    searchPlace: { id: 'place_1' },
    pickupSpot: { id: 'spot_1' },
    serviceArea: null
  });

  assert.equal(plan.exactHandoffVisible, true);
  assert.equal(plan.exactHandoffConfirmed, true);
  assert.equal(plan.exactHandoffPending, false);
  assert.equal(plan.exactHandoff.address1, '123 Hidden St');
  assert.equal(plan.instructions, 'Use gate code 2222');
});

test('serializePublicTripFulfillmentPlan exposes auto reveal metadata for guest messaging', () => {
  const plan = serializePublicTripFulfillmentPlan({
    fulfillmentChoice: 'PICKUP',
    pickupRevealMode: 'REVEAL_AFTER_BOOKING',
    handoffMode: 'LOCKBOX',
    exactAddress1: '123 Hidden St',
    city: 'San Juan',
    searchPlace: { placeType: 'AIRPORT' },
    confirmedAt: null
  }, {
    pickupAt: '2026-04-08T18:00:00.000Z',
    now: '2026-04-08T01:00:00.000Z',
    selfServiceConfig: {
      enabled: true,
      allowPickup: true,
      carSharingAutoRevealEnabled: true,
      carSharingAutoRevealModes: ['LOCKBOX', 'REMOTE_UNLOCK', 'SELF_SERVICE'],
      carSharingAirportRevealWindowHours: 12
    }
  });

  assert.equal(plan.exactHandoffVisible, false);
  assert.equal(plan.autoRevealEligible, true);
  assert.equal(plan.autoRevealWindowHours, 12);
  assert.equal(plan.selfServiceReady, true);
  assert.equal(plan.handoffPreset?.placeType, 'AIRPORT');
  assert.equal(plan.handoffPreset?.suggestedHandoffMode, 'IN_PERSON');
  assert.match(plan.exactHandoffPendingReason, /unlock automatically/i);
});
