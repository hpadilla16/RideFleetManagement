/**
 * SMS credential inheritance (2026-08-27). Same defect shape as the SPIn
 * terminal and the Anthropic OCR key, third provider family.
 *
 * Before this change getTenantSmsConfig was six lines of
 * `settings.x || process.env.Y || ''`. A tenant that had configured no SMS at
 * all therefore sent its guests' messages through the PLATFORM's carrier
 * account: the platform's number on the guest's phone, the platform's bill,
 * and the guest's mobile number handed to a carrier account that tenant never
 * signed up for.
 *
 * Pinned here:
 *   • a tenant with no SMS config resolves to NONE and SMS is disabled;
 *   • a tenant with its own credentials is untouched;
 *   • a half-configured Twilio tenant is never completed from the platform's
 *     env — the wrong-account signature the SPIn bug taught us about;
 *   • the FROM number follows the credentials it was issued against;
 *   • an opted-in tenant works, and warns by name.
 */
import test, { beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://u:p@localhost:5432/testdb';

import { prisma } from '../../lib/prisma.js';
import logger from '../../lib/logger.js';
import { cache } from '../../lib/cache.js';
import { __test as smsInternals } from './sms.service.js';

const TENANT = { id: 'tenant-sms-under-test', name: 'Nada Cars' };

const PLATFORM = {
  telnyxKey: 'KEY-platform-telnyx-0001',
  twilioSid: 'ACplatformsid0001',
  twilioToken: 'platform-twilio-token-0001',
  fromNumber: '+15550000000',
};

let warns = [];
let errors = [];
let settingsJson = {};
let orig = {};

beforeEach(() => {
  warns = [];
  errors = [];
  settingsJson = {};

  process.env.TELNYX_API_KEY = PLATFORM.telnyxKey;
  process.env.TWILIO_ACCOUNT_SID = PLATFORM.twilioSid;
  process.env.TWILIO_AUTH_TOKEN = PLATFORM.twilioToken;
  process.env.SMS_FROM_NUMBER = PLATFORM.fromNumber;
  delete process.env.PLATFORM_KEY_ALLOW_SMS;
  delete process.env.SMS_PROVIDER;

  orig.warn = logger.warn;
  orig.error = logger.error;
  logger.warn = (msg, meta) => { warns.push({ msg: String(msg), meta: meta || {} }); };
  logger.error = (msg, meta) => { errors.push({ msg: String(msg), meta: meta || {} }); };

  orig.findUnique = prisma.tenant.findUnique;
  prisma.tenant.findUnique = async ({ where }) => (where?.id === TENANT.id
    ? { id: TENANT.id, name: TENANT.name, settingsJson: JSON.stringify(settingsJson) }
    : null);

  cache.clear();
});

afterEach(() => {
  logger.warn = orig.warn;
  logger.error = orig.error;
  prisma.tenant.findUnique = orig.findUnique;
  for (const v of ['TELNYX_API_KEY', 'TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'SMS_FROM_NUMBER', 'PLATFORM_KEY_ALLOW_SMS', 'SMS_PROVIDER']) {
    delete process.env[v];
  }
  cache.clear();
});

const config = () => smsInternals.getTenantSmsConfig(TENANT.id);

// ---------------------------------------------------------------------------
// THE DEFAULT.
// ---------------------------------------------------------------------------

test('a tenant with no SMS config of its own gets no credentials and no from-number', async () => {
  const cfg = await config();

  assert.equal(cfg.credentialSource, 'NONE');
  assert.deepEqual(cfg.credentials, {}, 'not one field of the platform account leaks through');
  assert.equal(cfg.fromNumber, '', 'the platform number must not appear on a guest’s phone');
  assert.equal(cfg.enabled, false, 'SMS is simply off for this tenant — no send is attempted');
  assert.equal(warns.length, 0);
});

test('a tenant with only a from-number and no credentials is still off', async () => {
  settingsJson = { smsFromNumber: '+17875551234' };
  const cfg = await config();
  assert.equal(cfg.credentialSource, 'NONE');
  assert.equal(cfg.enabled, false);
});

// ---------------------------------------------------------------------------
// A working tenant keeps working.
// ---------------------------------------------------------------------------

test('a tenant with its own Telnyx key and number is untouched', async () => {
  settingsJson = { smsProvider: 'telnyx', smsApiKey: 'KEY-rentandgo-OWN', smsFromNumber: '+17875551234' };

  const cfg = await config();
  assert.equal(cfg.credentialSource, 'TENANT');
  assert.equal(cfg.credentials.apiKey, 'KEY-rentandgo-OWN');
  assert.notEqual(cfg.credentials.apiKey, PLATFORM.telnyxKey);
  assert.equal(cfg.fromNumber, '+17875551234');
  assert.equal(cfg.enabled, true);
  assert.equal(warns.length, 0);
});

test('a tenant on its own Twilio pair is untouched', async () => {
  settingsJson = {
    smsProvider: 'twilio',
    smsAccountSid: 'ACtenantsid', smsAuthToken: 'tenant-twilio-token',
    smsFromNumber: '+17875551234',
  };

  const cfg = await config();
  assert.equal(cfg.credentialSource, 'TENANT');
  assert.deepEqual(cfg.credentials, { accountSid: 'ACtenantsid', authToken: 'tenant-twilio-token' });
  assert.equal(cfg.enabled, true);
});

// ---------------------------------------------------------------------------
// Half-configured — the SPIn wrong-merchant lesson.
// ---------------------------------------------------------------------------

test('a half-configured Twilio tenant is never completed from the platform env', async () => {
  // A tenant SID paired with the platform's auth token is not a partly-working
  // config — it is a request signed by the wrong account.
  settingsJson = { smsProvider: 'twilio', smsAccountSid: 'ACtenantsid', smsFromNumber: '+17875551234' };

  const cfg = await config();
  assert.equal(cfg.credentialSource, 'NONE');
  assert.deepEqual(cfg.credentials, {});
  assert.equal(cfg.enabled, false);
  assert.equal(errors.length, 1, 'a half-config is an operator mistake — logged at error');
  assert.equal(errors[0].meta.tenantId, TENANT.id);
});

test('a half-configured tenant is refused even WITH the opt-in on', async () => {
  settingsJson = {
    smsProvider: 'twilio', smsAccountSid: 'ACtenantsid',
    smsFromNumber: '+17875551234', smsAllowPlatformKeyFallback: true,
  };
  const cfg = await config();
  assert.equal(cfg.credentialSource, 'NONE');
});

// ---------------------------------------------------------------------------
// The opt-in doors.
// ---------------------------------------------------------------------------

test('an opted-in tenant uses the platform account, warns by name, and gets the platform number', async () => {
  settingsJson = { smsProvider: 'telnyx', smsAllowPlatformKeyFallback: true };

  const cfg = await config();
  assert.equal(cfg.credentialSource, 'PLATFORM');
  assert.equal(cfg.credentials.apiKey, PLATFORM.telnyxKey);
  assert.equal(cfg.fromNumber, PLATFORM.fromNumber, 'the number must match the account it was issued on');
  assert.equal(cfg.enabled, true);

  const warn = warns.find((w) => /USING THE PLATFORM CREDENTIAL/i.test(w.msg));
  assert.ok(warn);
  assert.equal(warn.meta.tenantId, TENANT.id);
  assert.equal(warn.meta.tenantName, TENANT.name);
  assert.equal(warn.meta.feature, 'sms');
  assert.ok(!JSON.stringify(warn).includes(PLATFORM.telnyxKey), 'masked, never in the clear');
});

test('the env allowlist is the other door', async () => {
  process.env.PLATFORM_KEY_ALLOW_SMS = TENANT.id;
  settingsJson = { smsProvider: 'telnyx' };

  const cfg = await config();
  assert.equal(cfg.credentialSource, 'PLATFORM');
  assert.equal(warns.find((w) => /USING THE PLATFORM CREDENTIAL/i.test(w.msg)).meta.optInSource, 'ENV_ALLOWLIST');
});

test('an SMS opt-in does not opt the tenant in to the Anthropic features', async () => {
  process.env.PLATFORM_KEY_ALLOW_SMS = TENANT.id;
  const { resolveTenantProviderCredential } = await import('../../lib/tenant-provider-credential.js');
  const ocr = resolveTenantProviderCredential({
    tenantId: TENANT.id, feature: 'citation-ocr', platformCredential: 'sk-ant-house',
  });
  assert.equal(ocr.source, 'NONE');
});
