// VoltSwitch credential encryption-at-rest (2026-08-24): the creds inside the
// telematicsConfig AppSetting blob were plaintext (masked on read only). They
// now store as `enci:v1:` AES-256-GCM ciphertext (setting-secret-crypto under
// INTEGRATION_ENC_KEY), with dual-read for legacy plaintext blobs. These tests
// pin the crypto round trip AND the save semantics the 2026-08-13 incident
// made sacred: blank-means-keep must survive every key state — a missing or
// wrong key must NEVER let a settings save erase or corrupt the stored creds.
import '../../lib/_two-factor-test-env.mjs'; // MUST be first — sets env before prisma.js constructs

import test from 'node:test';
import assert from 'node:assert/strict';
import { settingsService } from './settings.service.js';
import { prisma } from '../../lib/prisma.js';
import { _resetKeyCacheForTests } from '../../lib/integration-crypto.js';
import {
  SETTING_SECRET_PREFIX,
  isSettingSecretEncrypted,
  encryptSettingSecret,
  decryptSettingSecret,
  carrySettingSecret
} from '../../lib/setting-secret-crypto.js';

const KEY = process.env.INTEGRATION_ENC_KEY;
const OTHER_KEY = Buffer.alloc(32, 9).toString('base64'); // ≠ the test env key
const TENANT_ID = 'volt-tenant';
const SCOPE = { tenantId: TENANT_ID };
const TKEY = `tenant:${TENANT_ID}:telematicsConfig`;

const EMAIL = 'gps-ops@vphmotors.com';
const PASSWORD = 'volt-hunter2-secret';

async function withEnvKey(value, fn) {
  if (value == null) delete process.env.INTEGRATION_ENC_KEY;
  else process.env.INTEGRATION_ENC_KEY = value;
  _resetKeyCacheForTests();
  try {
    return await fn();
  } finally {
    process.env.INTEGRATION_ENC_KEY = KEY;
    _resetKeyCacheForTests();
  }
}

// In-memory appSetting fake: serves the telematics row, swallows upserts, and
// returns null for every other key (tenantPlanCatalog → defaults). The prisma
// client never connects — every query in this file goes through these fakes.
function installFakes(storedValue = null) {
  const orig = {
    findUnique: prisma.appSetting.findUnique,
    upsert: prisma.appSetting.upsert,
    tenantFindUnique: prisma.tenant.findUnique
  };
  const state = { stored: storedValue };
  prisma.appSetting.findUnique = async ({ where }) => {
    if (where?.key === TKEY) return state.stored == null ? null : { key: TKEY, value: state.stored };
    return null;
  };
  prisma.appSetting.upsert = async (args) => {
    state.stored = args?.update?.value ?? args?.create?.value ?? null;
    return { key: TKEY, value: state.stored };
  };
  prisma.tenant.findUnique = async () => ({ id: TENANT_ID, plan: 'BETA' });
  const restore = () => {
    prisma.appSetting.findUnique = orig.findUnique;
    prisma.appSetting.upsert = orig.upsert;
    prisma.tenant.findUnique = orig.tenantFindUnique;
  };
  return { state, restore };
}

function legacyPlaintextBlob() {
  return JSON.stringify({
    enabled: true,
    provider: 'VOLTSWITCH',
    allowVoltswitchConnector: true,
    voltswitchApiEmail: EMAIL,
    voltswitchApiPassword: PASSWORD,
    voltswitchSyncIntervalMinutes: 5
  });
}

function encryptedBlob() {
  return JSON.stringify({
    enabled: true,
    provider: 'VOLTSWITCH',
    allowVoltswitchConnector: true,
    voltswitchApiEmail: encryptSettingSecret(EMAIL),
    voltswitchApiPassword: encryptSettingSecret(PASSWORD),
    voltswitchSyncIntervalMinutes: 5
  });
}

// ---------------------------------------------------------------------------
// Helper unit round trip
// ---------------------------------------------------------------------------

test('encryptSettingSecret round-trips, is prefixed, idempotent, and blank-safe', () => {
  const ct = encryptSettingSecret(PASSWORD);
  assert.ok(ct.startsWith(`${SETTING_SECRET_PREFIX}v1:`));
  assert.ok(!ct.includes(PASSWORD));
  assert.equal(decryptSettingSecret(ct), PASSWORD);
  assert.equal(encryptSettingSecret(ct), ct); // never double-encrypt
  assert.equal(encryptSettingSecret(''), '');
  assert.equal(encryptSettingSecret(null), '');
});

test('decryptSettingSecret passes legacy plaintext and non-strings through', () => {
  assert.equal(decryptSettingSecret(PASSWORD), PASSWORD);
  assert.equal(decryptSettingSecret(''), '');
  assert.equal(decryptSettingSecret(undefined), undefined);
  assert.equal(decryptSettingSecret(42), 42);
});

test('carrySettingSecret: ciphertext verbatim; plaintext lazily encrypted; keyless plaintext untouched', async () => {
  const ct = encryptSettingSecret(PASSWORD);
  assert.equal(carrySettingSecret(ct), ct); // no decrypt→re-encrypt round trip
  const upgraded = carrySettingSecret(PASSWORD);
  assert.ok(isSettingSecretEncrypted(upgraded));
  assert.equal(decryptSettingSecret(upgraded), PASSWORD);
  await withEnvKey(null, () => {
    assert.equal(carrySettingSecret(PASSWORD), PASSWORD); // never throws on carry
    assert.equal(carrySettingSecret(ct), ct);
  });
});

// ---------------------------------------------------------------------------
// Service: save encrypts at rest, reads decrypt + keep masking
// ---------------------------------------------------------------------------

test('saving new credentials stores ciphertext at rest; reads decrypt and mask', async () => {
  const { state, restore } = installFakes(null);
  try {
    await settingsService.updateTelematicsConfig({
      enabled: true,
      provider: 'VOLTSWITCH',
      allowVoltswitchConnector: true,
      voltswitchApiEmail: EMAIL,
      voltswitchApiPassword: PASSWORD
    }, SCOPE);

    assert.ok(!state.stored.includes(PASSWORD), 'password must not be stored plaintext');
    assert.ok(!state.stored.includes(EMAIL), 'email must not be stored plaintext');
    const blob = JSON.parse(state.stored);
    assert.ok(isSettingSecretEncrypted(blob.voltswitchApiEmail));
    assert.ok(isSettingSecretEncrypted(blob.voltswitchApiPassword));

    const withSecret = await settingsService.getTelematicsConfig(SCOPE, { includeSecret: true });
    assert.equal(withSecret.voltswitchApiEmail, EMAIL);
    assert.equal(withSecret.voltswitchApiPassword, PASSWORD);
    assert.equal(withSecret.hasVoltswitchCredentials, true);
    assert.equal(withSecret.voltswitchConnectorReady, true);

    const masked = await settingsService.getTelematicsConfig(SCOPE);
    assert.equal(masked.voltswitchApiPassword, '', 'secret must stay hidden without includeSecret');
    assert.equal(masked.voltswitchApiPasswordMasked, `${PASSWORD.slice(0, 4)}...${PASSWORD.slice(-4)}`);
    assert.equal(masked.hasVoltswitchCredentials, true);
  } finally {
    restore();
  }
});

test('legacy plaintext blobs still read correctly (dual-read)', async () => {
  const { restore } = installFakes(legacyPlaintextBlob());
  try {
    const cfg = await settingsService.getTelematicsConfig(SCOPE, { includeSecret: true });
    assert.equal(cfg.voltswitchApiEmail, EMAIL);
    assert.equal(cfg.voltswitchApiPassword, PASSWORD);
    assert.equal(cfg.hasVoltswitchCredentials, true);
    assert.equal(cfg.voltswitchConnectorReady, true);
  } finally {
    restore();
  }
});

// ---------------------------------------------------------------------------
// Blank-means-keep across every storage/key state (the 2026-08-13 invariant)
// ---------------------------------------------------------------------------

test('blank password + absent email keep the stored ciphertext VERBATIM', async () => {
  const before = JSON.parse(encryptedBlob());
  const { state, restore } = installFakes(JSON.stringify(before));
  try {
    await settingsService.updateTelematicsConfig({
      enabled: true,
      provider: 'VOLTSWITCH',
      allowVoltswitchConnector: true,
      voltswitchApiPassword: ''
    }, SCOPE);
    const after = JSON.parse(state.stored);
    assert.equal(after.voltswitchApiEmail, before.voltswitchApiEmail, 'email ciphertext must carry byte-for-byte');
    assert.equal(after.voltswitchApiPassword, before.voltswitchApiPassword, 'password ciphertext must carry byte-for-byte');
  } finally {
    restore();
  }
});

test('a keep-save lazily re-encrypts legacy plaintext credentials', async () => {
  const { state, restore } = installFakes(legacyPlaintextBlob());
  try {
    await settingsService.updateTelematicsConfig({
      enabled: true,
      provider: 'VOLTSWITCH',
      allowVoltswitchConnector: true,
      voltswitchApiPassword: ''
    }, SCOPE);
    const after = JSON.parse(state.stored);
    assert.ok(isSettingSecretEncrypted(after.voltswitchApiEmail));
    assert.ok(isSettingSecretEncrypted(after.voltswitchApiPassword));
    assert.equal(decryptSettingSecret(after.voltswitchApiEmail), EMAIL);
    assert.equal(decryptSettingSecret(after.voltswitchApiPassword), PASSWORD);
  } finally {
    restore();
  }
});

test('clearVoltswitchCredentials erases both fields', async () => {
  const { state, restore } = installFakes(encryptedBlob());
  try {
    const out = await settingsService.updateTelematicsConfig({
      enabled: true,
      provider: 'VOLTSWITCH',
      allowVoltswitchConnector: true,
      clearVoltswitchCredentials: true
    }, SCOPE);
    const after = JSON.parse(state.stored);
    assert.equal(after.voltswitchApiEmail, '');
    assert.equal(after.voltswitchApiPassword, '');
    assert.equal(out.hasVoltswitchCredentials, false);
  } finally {
    restore();
  }
});

test('saving a NEW password without INTEGRATION_ENC_KEY is rejected loudly', async () => {
  const { restore } = installFakes(null);
  try {
    await withEnvKey(null, async () => {
      await assert.rejects(
        () => settingsService.updateTelematicsConfig({
          provider: 'VOLTSWITCH',
          voltswitchApiEmail: EMAIL,
          voltswitchApiPassword: PASSWORD
        }, SCOPE),
        (e) => {
          assert.equal(e.code, 'ENCRYPTION_NOT_CONFIGURED');
          return true;
        }
      );
    });
  } finally {
    restore();
  }
});

test('keyless keep-save leaves legacy plaintext creds working, never erased', async () => {
  const { state, restore } = installFakes(legacyPlaintextBlob());
  try {
    await withEnvKey(null, async () => {
      await settingsService.updateTelematicsConfig({
        enabled: true,
        provider: 'VOLTSWITCH',
        allowVoltswitchConnector: true,
        voltswitchApiPassword: ''
      }, SCOPE);
      const after = JSON.parse(state.stored);
      assert.equal(after.voltswitchApiEmail, EMAIL);
      assert.equal(after.voltswitchApiPassword, PASSWORD);
    });
  } finally {
    restore();
  }
});

test('wrong key: reads degrade to "no credentials", but a keep-save cannot erase the ciphertext', async () => {
  const blob = encryptedBlob(); // encrypted under the test env key
  const before = JSON.parse(blob);
  const { state, restore } = installFakes(blob);
  try {
    await withEnvKey(OTHER_KEY, async () => {
      // Read side: decrypt fails → '' creds, connector not ready — the
      // scheduler skips the tenant instead of logging in with ciphertext.
      const cfg = await settingsService.getTelematicsConfig(SCOPE, { includeSecret: true });
      assert.equal(cfg.voltswitchApiEmail, '');
      assert.equal(cfg.voltswitchApiPassword, '');
      assert.equal(cfg.hasVoltswitchCredentials, false);
      assert.equal(cfg.voltswitchConnectorReady, false);

      // Save side: blank-means-keep still carries the stored bytes verbatim.
      await settingsService.updateTelematicsConfig({
        enabled: true,
        provider: 'VOLTSWITCH',
        allowVoltswitchConnector: true,
        voltswitchApiPassword: ''
      }, SCOPE);
      const after = JSON.parse(state.stored);
      assert.equal(after.voltswitchApiEmail, before.voltswitchApiEmail);
      assert.equal(after.voltswitchApiPassword, before.voltswitchApiPassword);
    });
    // Key restored → the untouched ciphertext decrypts again.
    const recovered = await settingsService.getTelematicsConfig(SCOPE, { includeSecret: true });
    assert.equal(recovered.voltswitchApiEmail, EMAIL);
    assert.equal(recovered.voltswitchApiPassword, PASSWORD);
  } finally {
    restore();
  }
});
