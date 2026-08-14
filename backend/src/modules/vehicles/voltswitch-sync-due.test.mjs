import test from 'node:test';
import assert from 'node:assert/strict';
import { isVoltswitchSyncDue, tenantIdFromTelematicsKey } from './voltswitch-sync-due.js';

const MIN = 60 * 1000;
const readyConfig = (over = {}) => ({
  ready: true,
  voltswitchConnectorReady: true,
  voltswitchSyncIntervalMinutes: 5,
  ...over,
});

test('not due when telematics is not ready (disabled or plan-blocked)', () => {
  assert.equal(isVoltswitchSyncDue({ config: readyConfig({ ready: false }), now: 0 }), false);
});

test('not due when the connector is not fully configured', () => {
  assert.equal(isVoltswitchSyncDue({ config: readyConfig({ voltswitchConnectorReady: false }), now: 0 }), false);
});

test('due immediately on first attempt', () => {
  assert.equal(isVoltswitchSyncDue({ config: readyConfig(), lastAttemptAt: null, now: 1000 }), true);
});

test('not due before the interval elapses, due after', () => {
  const config = readyConfig({ voltswitchSyncIntervalMinutes: 5 });
  const t0 = 1_000_000;
  assert.equal(isVoltswitchSyncDue({ config, lastAttemptAt: t0, now: t0 + 4 * MIN }), false);
  assert.equal(isVoltswitchSyncDue({ config, lastAttemptAt: t0, now: t0 + 5 * MIN }), true);
});

test('interval is clamped: garbage falls back to 5, huge values cap at 60', () => {
  const t0 = 0;
  // NaN interval -> 5 min default
  assert.equal(isVoltswitchSyncDue({ config: readyConfig({ voltswitchSyncIntervalMinutes: 'x' }), lastAttemptAt: t0, now: 4 * MIN }), false);
  assert.equal(isVoltswitchSyncDue({ config: readyConfig({ voltswitchSyncIntervalMinutes: 'x' }), lastAttemptAt: t0, now: 5 * MIN }), true);
  // 999 min -> capped at 60
  assert.equal(isVoltswitchSyncDue({ config: readyConfig({ voltswitchSyncIntervalMinutes: 999 }), lastAttemptAt: t0, now: 60 * MIN }), true);
});

test('a failed attempt still counts as an attempt (no tight retry loop)', () => {
  // The scheduler stamps lastAttemptAt BEFORE calling sync; the due check
  // only sees the stamp, so failure vs success cannot change the cadence.
  const config = readyConfig({ voltswitchSyncIntervalMinutes: 1 });
  const t0 = 5_000;
  assert.equal(isVoltswitchSyncDue({ config, lastAttemptAt: t0, now: t0 + 30 * 1000 }), false);
});

test('tenantIdFromTelematicsKey parses only the tenant-scoped form', () => {
  assert.equal(tenantIdFromTelematicsKey('tenant:cmb123:telematicsConfig'), 'cmb123');
  assert.equal(tenantIdFromTelematicsKey('telematicsConfig'), null);
  assert.equal(tenantIdFromTelematicsKey('tenant:cmb123:brandingConfig'), null);
  assert.equal(tenantIdFromTelematicsKey(''), null);
});
