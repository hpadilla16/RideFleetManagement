// Staff 2FA policy settings guard (2026-08-22, QA FIX 4): enabling a 2FA policy
// while INTEGRATION_ENC_KEY is unset would compel required users to enroll when
// enrollment is impossible (secrets can't be encrypted → enroll 503s). The
// service must REFUSE the flip. Disabling is always allowed.
import '../../lib/_two-factor-test-env.mjs'; // MUST be first — sets env before prisma.js constructs

import test from 'node:test';
import assert from 'node:assert/strict';
import { settingsService } from './settings.service.js';
import { _resetKeyCacheForTests } from '../../lib/integration-crypto.js';
import { prisma } from '../../lib/prisma.js';

const KEY = process.env.INTEGRATION_ENC_KEY;

function withoutKey(fn) {
  delete process.env.INTEGRATION_ENC_KEY;
  _resetKeyCacheForTests();
  return Promise.resolve(fn()).finally(() => {
    process.env.INTEGRATION_ENC_KEY = KEY;
    _resetKeyCacheForTests();
  });
}
function withKey(fn) {
  process.env.INTEGRATION_ENC_KEY = KEY;
  _resetKeyCacheForTests();
  return Promise.resolve(fn());
}

test('enabling a policy WITHOUT INTEGRATION_ENC_KEY is rejected', async () => {
  await withoutKey(async () => {
    await assert.rejects(
      () => settingsService.updateTwoFactorPolicy({ enabled: true, requiredRoles: ['ADMIN'] }, {}),
      (e) => {
        assert.equal(e.code, 'ENCRYPTION_NOT_CONFIGURED');
        assert.match(String(e.message), /encryption key/i);
        return true;
      }
    );
  });
});

test('disabling a policy WITHOUT the key is still allowed', async () => {
  const origUpsert = prisma.appSetting.upsert;
  prisma.appSetting.upsert = async () => ({});
  try {
    await withoutKey(async () => {
      const out = await settingsService.updateTwoFactorPolicy({ enabled: false, requiredRoles: [] }, {});
      assert.equal(out.enabled, false);
    });
  } finally {
    prisma.appSetting.upsert = origUpsert;
  }
});

test('enabling a policy WITH the key configured succeeds', async () => {
  const origUpsert = prisma.appSetting.upsert;
  prisma.appSetting.upsert = async () => ({});
  try {
    await withKey(async () => {
      const out = await settingsService.updateTwoFactorPolicy({ enabled: true, requiredRoles: ['ADMIN'] }, {});
      assert.equal(out.enabled, true);
      assert.deepEqual(out.requiredRoles, ['ADMIN']);
    });
  } finally {
    prisma.appSetting.upsert = origUpsert;
  }
});
