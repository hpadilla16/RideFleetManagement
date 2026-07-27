/**
 * Internal ingest provider-pinning (2026-07-27). Pure — no DB, no network.
 * Pins the sourceType -> provider inference that stops the internal /ingest push
 * from mis-attributing a batch to resolveActiveProvider's "most recently updated
 * account" guess (the SunPass-droplet-lands-on-TollBridge bug).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { providerForIngest, parseDisabledIngestProviders } from './tolls-ingest-provider.js';

test('explicit provider wins and is upper-cased', () => {
  assert.equal(providerForIngest({ provider: 'sunpass', sourceType: 'AUTOEXPRESO_SYNC' }), 'SUNPASS');
});

test('sourceType infers the provider when none is given', () => {
  assert.equal(providerForIngest({ sourceType: 'SUNPASS_SYNC' }), 'SUNPASS');
  assert.equal(providerForIngest({ sourceType: 'AUTOEXPRESO_SYNC' }), 'AUTOEXPRESO');
  assert.equal(providerForIngest({ sourceType: 'TOLLBRIDGE_POLL' }), 'TOLLBRIDGE');
});

test('unknown or empty sourceType -> null (legacy resolution)', () => {
  assert.equal(providerForIngest({ sourceType: 'MYSTERY' }), null);
  assert.equal(providerForIngest({}), null);
  assert.equal(providerForIngest(), null);
});

test('parseDisabledIngestProviders parses CSV, trims + upper-cases', () => {
  const set = parseDisabledIngestProviders(' sunpass , AutoExpreso ');
  assert.equal(set.has('SUNPASS'), true);
  assert.equal(set.has('AUTOEXPRESO'), true);
  assert.equal(set.has('TOLLBRIDGE'), false);
  assert.equal(set.size, 2);
});

test('parseDisabledIngestProviders empty/undefined -> nothing blocked', () => {
  assert.equal(parseDisabledIngestProviders('').size, 0);
  assert.equal(parseDisabledIngestProviders(undefined).size, 0);
  assert.equal(parseDisabledIngestProviders(',,  ,').size, 0);
});

test('kill-switch blocks the disabled provider only', () => {
  const disabled = parseDisabledIngestProviders('SUNPASS');
  assert.equal(disabled.has(providerForIngest({ sourceType: 'SUNPASS_SYNC' })), true);
  assert.equal(disabled.has(providerForIngest({ sourceType: 'TOLLBRIDGE_POLL' })), false);
});
