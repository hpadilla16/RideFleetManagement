import test from 'node:test';
import assert from 'node:assert/strict';

import {
  extractZubieExternalDeviceId,
  normalizeZubieWebhookPayload
} from './telematics-zubie.js';

test('extractZubieExternalDeviceId supports nested payload variants', () => {
  assert.equal(extractZubieExternalDeviceId({ externalDeviceId: 'abc-1' }), 'abc-1');
  assert.equal(extractZubieExternalDeviceId({ device: { id: 'abc-2' } }), 'abc-2');
  assert.equal(extractZubieExternalDeviceId({ asset: { deviceId: 'abc-3' } }), 'abc-3');
});

test('normalizeZubieWebhookPayload maps common telemetry fields', () => {
  const now = new Date().toISOString();
  const mapped = normalizeZubieWebhookPayload({
    device: { id: 'zubie-001' },
    type: 'location',
    recordedAt: now,
    fuel: { percent: 42 },
    distance: { odometer: 55123 },
    battery: { percent: 88 },
    gps: { lat: 18.4655, lng: -66.1057, speedMph: 11 },
    ignition: { on: true }
  });

  assert.equal(mapped.provider, 'ZUBIE');
  assert.equal(mapped.externalDeviceId, 'zubie-001');
  assert.equal(mapped.eventType, 'LOCATION');
  assert.equal(mapped.eventAt, now);
  assert.equal(mapped.fuelPct, 42);
  assert.equal(mapped.odometer, 55123);
  assert.equal(mapped.batteryPct, 88);
  assert.equal(mapped.latitude, 18.4655);
  assert.equal(mapped.longitude, -66.1057);
  assert.equal(mapped.speedMph, 11);
  assert.equal(mapped.engineOn, true);
  assert.equal(mapped.providerMeta.provider, 'ZUBIE');
  assert.equal(mapped.providerMeta.ingestSource, 'WEBHOOK');
  assert.equal(mapped.providerMeta.payloadVersion, 'v1');
  assert.equal(mapped.mappingSummary.hasCoordinates, true);
  assert.equal(mapped.mappingSummary.hasFuel, true);
  assert.equal(mapped.mappingSummary.hasOdometer, true);
  assert.equal(mapped.mappingSummary.payloadVersion, 'v1');
});

test('normalizeZubieWebhookPayload carries provider metadata options for troubleshooting', () => {
  const mapped = normalizeZubieWebhookPayload({
    externalDeviceId: 'zubie-777',
    version: '2026-04',
    latitude: 18.4,
    longitude: -66.1
  }, {
    ingestSource: 'PUBLIC_WEBHOOK',
    requestMetadata: {
      deliveryId: 'evt_123',
      userAgent: 'Zubie-Test'
    }
  });

  assert.equal(mapped.providerMeta.ingestSource, 'PUBLIC_WEBHOOK');
  assert.equal(mapped.providerMeta.payloadVersion, '2026-04');
  assert.equal(mapped.providerMeta.requestMetadata.deliveryId, 'evt_123');
  assert.equal(mapped.providerMeta.requestMetadata.userAgent, 'Zubie-Test');
});

test('normalizeZubieWebhookPayload throws when no device identifier is present', () => {
  assert.throws(() => normalizeZubieWebhookPayload({ type: 'ping' }), /externalDeviceId is required/i);
});
