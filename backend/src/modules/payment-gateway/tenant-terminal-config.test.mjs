/**
 * Per-tenant Dejavoo/SPIn terminal configuration (2026-08-26). MONEY PATH.
 *
 * The bug these tests exist to keep dead: every tenant charged through the
 * PLATFORM env terminal (SPIN_AUTH_KEY / SPIN_TPN) because the wizard's
 * loadTenantSpinConfig returned `{}` and spin-client fell through to env. With
 * a second tenant on their own iPOS merchant account that is a wrong-merchant
 * charge — tenant B's customer taps, tenant A's bank settles.
 *
 * Pinned here, hardest first:
 *   • two tenants with different configs get their OWN tpn/authKey, and the
 *     EXACT values reach the spin client call (the regression itself);
 *   • a tenant with no config never silently borrows another terminal —
 *     either an audited, loudly-logged env fallback, or a fail-fast refusal
 *     with no provider call at all;
 *   • a HALF-configured tenant is refused outright, never paired with the
 *     platform's other half;
 *   • the authKey is ciphertext at rest, dual-reads legacy plaintext, and
 *     never appears in a log line or in audit metadata.
 */
import '../../lib/_two-factor-test-env.mjs'; // MUST be first — env before prisma.js constructs

import test, { beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { prisma } from '../../lib/prisma.js';
import logger from '../../lib/logger.js';
import { cache } from '../../lib/cache.js';
import { redactSensitive } from '../../lib/logger.js';
import {
  encryptSettingSecret,
  isSettingSecretEncrypted,
} from '../../lib/setting-secret-crypto.js';
import { _resetKeyCacheForTests } from '../../lib/integration-crypto.js';

import {
  resolveTenantTerminalConfig,
  invalidateTenantTerminalConfig,
  toSpinClientConfig,
  terminalConfigSettingKey,
  buildTerminalAuditMetadata,
  maskTpn,
} from './tenant-terminal-config.js';
import { spinClient } from './spin-client.js';
import { spinChargeService } from '../checkout-session/spin-charge.service.js';
import { settingsService } from '../settings/settings.service.js';

// ---------------------------------------------------------------------------
// Fixtures — two tenants with genuinely different terminals, plus the platform
// env terminal that International Rental Corp is live on today.
// ---------------------------------------------------------------------------

const T_A = { id: 'tenant-alpha', name: 'Alpha Rentals', tpn: '111122223333', authKey: 'alpha-auth-key-AAAA' };
const T_B = { id: 'tenant-bravo', name: 'Bravo Mobility', tpn: '999988887777', authKey: 'bravo-auth-key-BBBB' };
const T_NONE = { id: 'tenant-nada', name: 'Nada Cars' };
const T_HALF = { id: 'tenant-half', name: 'Half Baked' };

const ENV_TPN = '816026739983';
const ENV_AUTH_KEY = 'platform-env-auth-key-PPPP';

// ---------------------------------------------------------------------------
// In-memory prisma fakes. The client never connects; every query in this file
// goes through these.
// ---------------------------------------------------------------------------

let settingRows;   // Map<appSettingKey, jsonString>
let tenantRows;    // Map<tenantId, { name }>
let dbReads;       // { appSetting, tenant }
let savedPrisma;

function spinBlob(spin) {
  return JSON.stringify({ gateway: 'spin', label: 'x', spin });
}

function seedTenantTerminal(t, { encrypted = true, extra = {} } = {}) {
  tenantRows.set(t.id, { name: t.name });
  settingRows.set(terminalConfigSettingKey(t.id), spinBlob({
    enabled: true,
    environment: 'production',
    authKey: encrypted ? encryptSettingSecret(t.authKey) : t.authKey,
    tpn: t.tpn,
    merchantNumber: '1',
    callbackUrl: '',
    proxyTimeout: '120',
    ...extra,
  }));
}

function installPrismaFakes() {
  savedPrisma = {
    appSettingFindUnique: prisma.appSetting.findUnique,
    appSettingUpsert: prisma.appSetting.upsert,
    tenantFindUnique: prisma.tenant.findUnique,
  };
  prisma.appSetting.findUnique = async ({ where }) => {
    dbReads.appSetting += 1;
    const value = settingRows.get(where?.key);
    return value == null ? null : { key: where.key, value };
  };
  prisma.appSetting.upsert = async (args) => {
    const key = args?.where?.key;
    const value = args?.update?.value ?? args?.create?.value ?? null;
    settingRows.set(key, value);
    return { key, value };
  };
  prisma.tenant.findUnique = async ({ where }) => {
    dbReads.tenant += 1;
    const row = tenantRows.get(where?.id);
    return row ? { id: where.id, name: row.name, plan: 'BETA' } : null;
  };
}

function restorePrismaFakes() {
  prisma.appSetting.findUnique = savedPrisma.appSettingFindUnique;
  prisma.appSetting.upsert = savedPrisma.appSettingUpsert;
  prisma.tenant.findUnique = savedPrisma.tenantFindUnique;
}

// ---------------------------------------------------------------------------
// Env + logger + fetch harness
// ---------------------------------------------------------------------------

const ENV_KEYS = ['SPIN_AUTH_KEY', 'SPIN_TPN', 'SPIN_MERCHANT_NUMBER', 'SPIN_CALLBACK_URL', 'SPIN_PROXY_TIMEOUT', 'SPIN_ALLOW_ENV_FALLBACK', 'SPIN_DRY_RUN'];
let savedEnv;

function setEnvTerminal({ present = true, allowFallback = true } = {}) {
  if (present) {
    process.env.SPIN_AUTH_KEY = ENV_AUTH_KEY;
    process.env.SPIN_TPN = ENV_TPN;
  } else {
    delete process.env.SPIN_AUTH_KEY;
    delete process.env.SPIN_TPN;
  }
  process.env.SPIN_ALLOW_ENV_FALLBACK = allowFallback ? 'true' : 'false';
  delete process.env.SPIN_DRY_RUN;
}

let logLines;
let savedLogger;
function installLoggerSpy() {
  logLines = [];
  savedLogger = { info: logger.info, warn: logger.warn, error: logger.error };
  const capture = (level) => (msg, meta) => { logLines.push({ level, msg, meta }); };
  logger.info = capture('info');
  logger.warn = capture('warn');
  logger.error = capture('error');
}
function restoreLogger() {
  logger.info = savedLogger.info;
  logger.warn = savedLogger.warn;
  logger.error = savedLogger.error;
}
/** Everything the spy saw, flattened — what a log sink would actually receive. */
function loggedText() {
  return JSON.stringify(logLines);
}

let fetchCalls;
let savedFetch;
function installFetchSpy() {
  fetchCalls = [];
  savedFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    fetchCalls.push({ url: String(url), init });
    return { ok: true, status: 200, text: async () => JSON.stringify({ GeneralResponse: { StatusCode: '0000', ResultCode: 0 }, AuthCode: 'SPY' }) };
  };
}
function restoreFetch() { globalThis.fetch = savedFetch; }

beforeEach(() => {
  settingRows = new Map();
  tenantRows = new Map();
  dbReads = { appSetting: 0, tenant: 0 };
  cache.clear();
  installPrismaFakes();
  installFetchSpy();
  setEnvTerminal();
  _resetKeyCacheForTests();
});

afterEach(() => {
  restorePrismaFakes();
  restoreFetch();
  if (savedLogger) { restoreLogger(); savedLogger = null; }
  for (const k of ENV_KEYS) delete process.env[k];
});

// ===========================================================================
// 1. THE REGRESSION — two tenants, two terminals, no crossing over
// ===========================================================================

test('two tenants with different configs each resolve to their OWN terminal', async () => {
  seedTenantTerminal(T_A);
  seedTenantTerminal(T_B);

  const a = await resolveTenantTerminalConfig(T_A.id);
  const b = await resolveTenantTerminalConfig(T_B.id);

  assert.equal(a.source, 'TENANT');
  assert.equal(b.source, 'TENANT');
  assert.equal(a.tpn, T_A.tpn);
  assert.equal(b.tpn, T_B.tpn);
  assert.equal(a.authKey, T_A.authKey);
  assert.equal(b.authKey, T_B.authKey);
  assert.notEqual(a.tpn, b.tpn);
  // And neither one is the platform terminal.
  assert.notEqual(a.tpn, ENV_TPN);
  assert.notEqual(b.tpn, ENV_TPN);
});

test('toSpinClientConfig carries the tenant credentials; ENV source carries nothing (client reads env itself)', async () => {
  seedTenantTerminal(T_A);
  const a = toSpinClientConfig(await resolveTenantTerminalConfig(T_A.id));
  assert.equal(a.spinTpn, T_A.tpn);
  assert.equal(a.spinAuthKey, T_A.authKey);

  tenantRows.set(T_NONE.id, { name: T_NONE.name });
  const env = toSpinClientConfig(await resolveTenantTerminalConfig(T_NONE.id));
  assert.deepEqual(env, {}, 'ENV source must leave the client on its own env read — byte-identical to the old behaviour');
});

// ===========================================================================
// 2. THE LIVE CHARGE PATH — the exact values must reach the spin client
// ===========================================================================

let chargeCalls;
let savedCharge;

/** Minimal prisma surface for spinChargeService.runSale(). */
function installChargeFakes({ tenantId }) {
  chargeCalls = { sale: [], payments: [], agreementUpdates: [], sessionUpdates: [] };
  savedCharge = {
    sessionFindUnique: prisma.checkoutSession.findUnique,
    sessionUpdate: prisma.checkoutSession.update,
    chargeFindMany: prisma.rentalAgreementCharge.findMany,
    payCreate: prisma.rentalAgreementPayment.create,
    payAggregate: prisma.rentalAgreementPayment.aggregate,
    agreementUpdate: prisma.rentalAgreement.update,
    resPayCreate: prisma.reservationPayment.create,
    spinSale: spinClient.sale,
  };
  prisma.checkoutSession.findUnique = async () => ({
    id: 's1',
    currentStep: 'TC_SIGNED',
    events: '[]',
    reservation: { id: 'r1', reservationNumber: 'RES-1', tenantId },
    agreement: { id: 'a1', agreementNumber: 'RA-1', paidAmount: 0, charges: [] },
  });
  prisma.checkoutSession.update = async ({ data }) => { chargeCalls.sessionUpdates.push(data); return {}; };
  prisma.rentalAgreementCharge.findMany = async () => ([{ source: 'RENTAL', total: 100 }]);
  prisma.rentalAgreementPayment.create = async ({ data }) => { chargeCalls.payments.push(data); return { id: 'p1', ...data }; };
  prisma.rentalAgreementPayment.aggregate = async () => ({ _sum: { amount: 100 } });
  prisma.rentalAgreement.update = async ({ data }) => { chargeCalls.agreementUpdates.push(data); return {}; };
  prisma.reservationPayment.create = async ({ data }) => ({ id: 'rp1', ...data });
  // Capture the tenantConfig the orchestrator hands the client — this second
  // argument IS the fix. Asserting on it is asserting on the money.
  spinClient.sale = async (body, tenantConfig) => {
    chargeCalls.sale.push({ body, tenantConfig });
    return {
      GeneralResponse: { StatusCode: '0000', ResultCode: 0 },
      AuthCode: 'AUTH1', IPosToken: 'tok-1', CardData: { CardType: 'VISA', Last4: '4242' },
    };
  };
}
function restoreChargeFakes() {
  prisma.checkoutSession.findUnique = savedCharge.sessionFindUnique;
  prisma.checkoutSession.update = savedCharge.sessionUpdate;
  prisma.rentalAgreementCharge.findMany = savedCharge.chargeFindMany;
  prisma.rentalAgreementPayment.create = savedCharge.payCreate;
  prisma.rentalAgreementPayment.aggregate = savedCharge.payAggregate;
  prisma.rentalAgreement.update = savedCharge.agreementUpdate;
  prisma.reservationPayment.create = savedCharge.resPayCreate;
  spinClient.sale = savedCharge.spinSale;
}

test('charge path: a configured tenant\'s OWN tpn + authKey reach spinClient.sale', async () => {
  seedTenantTerminal(T_A);
  installChargeFakes({ tenantId: T_A.id });
  try {
    await spinChargeService.runSale({ sessionId: 's1', amount: 100 });
    assert.equal(chargeCalls.sale.length, 1);
    const cfg = chargeCalls.sale[0].tenantConfig;
    assert.equal(cfg.spinTpn, T_A.tpn, 'the TPN that reaches the gateway decides which merchant gets paid');
    assert.equal(cfg.spinAuthKey, T_A.authKey);
  } finally {
    restoreChargeFakes();
  }
});

test('charge path: tenant B never charges through tenant A\'s terminal (the wrong-merchant regression)', async () => {
  seedTenantTerminal(T_A);
  seedTenantTerminal(T_B);

  installChargeFakes({ tenantId: T_A.id });
  try {
    await spinChargeService.runSale({ sessionId: 's1', amount: 100 });
  } finally {
    restoreChargeFakes();
  }
  const aCfg = chargeCalls.sale[0].tenantConfig;

  installChargeFakes({ tenantId: T_B.id });
  try {
    await spinChargeService.runSale({ sessionId: 's1', amount: 100 });
  } finally {
    restoreChargeFakes();
  }
  const bCfg = chargeCalls.sale[0].tenantConfig;

  assert.equal(aCfg.spinTpn, T_A.tpn);
  assert.equal(bCfg.spinTpn, T_B.tpn);
  assert.notEqual(aCfg.spinTpn, bCfg.spinTpn);
  assert.notEqual(aCfg.spinAuthKey, bCfg.spinAuthKey);
});

// ===========================================================================
// 3. NO TENANT CONFIG — audited fallback, or fail fast. Never silent.
// ===========================================================================

test('no tenant config + fallback ALLOWED: env terminal is used and a WARN names the tenant', async () => {
  tenantRows.set(T_NONE.id, { name: T_NONE.name });
  setEnvTerminal({ present: true, allowFallback: true });
  installLoggerSpy();

  const resolved = await resolveTenantTerminalConfig(T_NONE.id);

  assert.equal(resolved.source, 'ENV');
  assert.equal(resolved.reason, 'ENV_FALLBACK');
  assert.equal(resolved.tpn, ENV_TPN);

  const warn = logLines.find((l) => l.level === 'warn' && /FALLING BACK TO THE PLATFORM TERMINAL/.test(l.msg));
  assert.ok(warn, 'the fallback must be loud, not silent');
  assert.equal(warn.meta.tenantId, T_NONE.id);
  assert.equal(warn.meta.tenantName, T_NONE.name, 'the warning must NAME the tenant');
  assert.equal(warn.meta.maskedTpn, maskTpn(ENV_TPN));
  assert.ok(!loggedText().includes(ENV_AUTH_KEY), 'never the auth key');
});

test('the fallback WARN fires on EVERY resolution, not just the first (the cache must not silence it)', async () => {
  tenantRows.set(T_NONE.id, { name: T_NONE.name });
  installLoggerSpy();
  await resolveTenantTerminalConfig(T_NONE.id);
  await resolveTenantTerminalConfig(T_NONE.id);
  await resolveTenantTerminalConfig(T_NONE.id);
  const warns = logLines.filter((l) => l.level === 'warn' && /FALLING BACK TO THE PLATFORM TERMINAL/.test(l.msg));
  assert.equal(warns.length, 3, 'a migration backlog you only hear about once is a backlog you forget');
});

test('no tenant config + fallback DENIED: source NONE', async () => {
  tenantRows.set(T_NONE.id, { name: T_NONE.name });
  setEnvTerminal({ present: true, allowFallback: false });
  const resolved = await resolveTenantTerminalConfig(T_NONE.id);
  assert.equal(resolved.source, 'NONE');
  assert.equal(resolved.reason, 'ENV_FALLBACK_DISABLED');
  assert.equal(resolved.authKey, '');
  assert.equal(resolved.tpn, '');
});

test('charge path with the tighten-flag ON fails fast: 409 TERMINAL_NOT_CONFIGURED, NO provider call, NO payment row', async () => {
  tenantRows.set(T_NONE.id, { name: T_NONE.name });
  setEnvTerminal({ present: true, allowFallback: false });
  installChargeFakes({ tenantId: T_NONE.id });
  // Use the REAL spin client so a leak would have to go through fetch.
  spinClient.sale = savedCharge.spinSale;
  try {
    await assert.rejects(
      () => spinChargeService.runSale({ sessionId: 's1', amount: 100 }),
      (err) => {
        assert.equal(err.code, 'TERMINAL_NOT_CONFIGURED');
        assert.equal(err.status, 409);
        assert.match(err.message, /no payment terminal configured/i);
        return true;
      },
    );
    assert.equal(fetchCalls.length, 0, 'nothing may reach the gateway');
    assert.equal(chargeCalls.payments.length, 0, 'no payment row');
    assert.equal(chargeCalls.agreementUpdates.length, 0, 'nothing persisted');
  } finally {
    restoreChargeFakes();
  }
});

test('charge path with fallback ALLOWED keeps the env-only tenant working (IRC must not go dark on deploy)', async () => {
  tenantRows.set(T_NONE.id, { name: T_NONE.name });
  setEnvTerminal({ present: true, allowFallback: true });
  installChargeFakes({ tenantId: T_NONE.id });
  try {
    await spinChargeService.runSale({ sessionId: 's1', amount: 100 });
    assert.equal(chargeCalls.sale.length, 1, 'the charge still runs');
    assert.deepEqual(chargeCalls.sale[0].tenantConfig, {}, 'client falls through to env exactly as before');
  } finally {
    restoreChargeFakes();
  }
});

test('nothing configured anywhere fails fast even with fallback allowed', async () => {
  tenantRows.set(T_NONE.id, { name: T_NONE.name });
  setEnvTerminal({ present: false, allowFallback: true });
  const resolved = await resolveTenantTerminalConfig(T_NONE.id);
  assert.equal(resolved.source, 'NONE');
  assert.equal(resolved.reason, 'NO_CONFIG_ANYWHERE');
});

// ===========================================================================
// 4. HALF-CONFIGURED — the ambiguity that must never be resolved by guessing
// ===========================================================================

test('a tenant with a TPN but no authKey is REFUSED, never paired with the platform key', async () => {
  tenantRows.set(T_HALF.id, { name: T_HALF.name });
  settingRows.set(terminalConfigSettingKey(T_HALF.id), spinBlob({
    enabled: true, environment: 'production', authKey: '', tpn: '555544443333',
  }));
  setEnvTerminal({ present: true, allowFallback: true });

  const resolved = await resolveTenantTerminalConfig(T_HALF.id);
  assert.equal(resolved.source, 'NONE');
  assert.equal(resolved.reason, 'INCOMPLETE_TENANT_CONFIG');
  assert.notEqual(resolved.authKey, ENV_AUTH_KEY, 'must NOT borrow the platform auth key');
  assert.equal(resolved.tpn, '');
});

test('a tenant with an authKey but no TPN is REFUSED with an actionable message at the counter', async () => {
  tenantRows.set(T_HALF.id, { name: T_HALF.name });
  settingRows.set(terminalConfigSettingKey(T_HALF.id), spinBlob({
    enabled: true, environment: 'production', authKey: encryptSettingSecret('half-key'), tpn: '',
  }));
  installChargeFakes({ tenantId: T_HALF.id });
  spinClient.sale = savedCharge.spinSale;
  try {
    await assert.rejects(
      () => spinChargeService.runSale({ sessionId: 's1', amount: 100 }),
      (err) => {
        assert.equal(err.code, 'TERMINAL_NOT_CONFIGURED');
        assert.match(err.message, /half configured/i);
        return true;
      },
    );
    assert.equal(fetchCalls.length, 0);
  } finally {
    restoreChargeFakes();
  }
});

test('spin.enabled=false does NOT demote a configured tenant to the platform terminal', async () => {
  // Treating the checkbox as "unconfigured" would route this tenant's charge to
  // the ENV terminal — i.e. the checkbox would CAUSE the wrong-merchant charge.
  seedTenantTerminal(T_A, { extra: { enabled: false } });
  settingRows.set(terminalConfigSettingKey(T_A.id), spinBlob({
    enabled: false, environment: 'production',
    authKey: encryptSettingSecret(T_A.authKey), tpn: T_A.tpn,
  }));
  const resolved = await resolveTenantTerminalConfig(T_A.id);
  assert.equal(resolved.source, 'TENANT');
  assert.equal(resolved.tpn, T_A.tpn);
  assert.equal(resolved.enabled, false, 'reported for observability, not used for routing');
});

// ===========================================================================
// 5. ENCRYPTION AT REST + DUAL-READ
// ===========================================================================

test('saving a terminal stores the authKey as ciphertext, never plaintext', async () => {
  const scope = { tenantId: T_A.id };
  tenantRows.set(T_A.id, { name: T_A.name });

  await settingsService.updatePaymentGatewayConfig({
    gateway: 'spin',
    spin: { enabled: true, environment: 'production', authKey: T_A.authKey, tpn: T_A.tpn },
  }, scope);

  const raw = settingRows.get(terminalConfigSettingKey(T_A.id));
  assert.ok(!raw.includes(T_A.authKey), 'the auth key must not sit in the row in plaintext');
  const blob = JSON.parse(raw);
  assert.ok(isSettingSecretEncrypted(blob.spin.authKey));
  assert.equal(blob.spin.tpn, T_A.tpn, 'the TPN is an identifier, not a secret — stays readable');

  // …and the resolver decrypts it back for the charge path.
  const resolved = await resolveTenantTerminalConfig(T_A.id);
  assert.equal(resolved.source, 'TENANT');
  assert.equal(resolved.authKey, T_A.authKey);
});

test('legacy PLAINTEXT authKey still resolves (dual-read: no big-bang migration)', async () => {
  seedTenantTerminal(T_B, { encrypted: false });
  const raw = JSON.parse(settingRows.get(terminalConfigSettingKey(T_B.id)));
  assert.equal(raw.spin.authKey, T_B.authKey, 'fixture really is legacy plaintext');

  const resolved = await resolveTenantTerminalConfig(T_B.id);
  assert.equal(resolved.source, 'TENANT');
  assert.equal(resolved.authKey, T_B.authKey);
});

test('a save upgrades a legacy plaintext row in place, and blank-means-keep never erases it', async () => {
  const scope = { tenantId: T_B.id };
  seedTenantTerminal(T_B, { encrypted: false });

  // Blank authKey in the payload = the UI round-trip (the read never returns it).
  await settingsService.updatePaymentGatewayConfig({
    gateway: 'spin',
    spin: { enabled: true, environment: 'production', authKey: '', tpn: T_B.tpn },
  }, scope);

  const blob = JSON.parse(settingRows.get(terminalConfigSettingKey(T_B.id)));
  assert.ok(isSettingSecretEncrypted(blob.spin.authKey), 'lazily upgraded on save');
  invalidateTenantTerminalConfig(T_B.id);
  const resolved = await resolveTenantTerminalConfig(T_B.id);
  assert.equal(resolved.authKey, T_B.authKey, 'and it still decrypts to the same key');
});

test('the read path never returns the authKey — it returns hasAuthKey instead', async () => {
  const scope = { tenantId: T_A.id };
  await settingsService.updatePaymentGatewayConfig({
    gateway: 'spin',
    spin: { enabled: true, authKey: T_A.authKey, tpn: T_A.tpn },
  }, scope);

  const read = await settingsService.getPaymentGatewayConfig(scope);
  assert.equal(read.spin.authKey, '', 'not the plaintext');
  assert.equal(read.spin.hasAuthKey, true);
  assert.equal(read.spin.tpn, T_A.tpn);
  assert.ok(!JSON.stringify(read).includes(T_A.authKey));
  assert.ok(!JSON.stringify(read).includes('enci:'), 'not the ciphertext either');
});

test('an unconfigured tenant no longer sees the PLATFORM env credentials pre-filled in the form', async () => {
  // Pre-filling them handed the platform key to any tenant ADMIN — and a Save
  // from that form would have COPIED the platform TPN into the tenant's own
  // config, pinning their charges to somebody else's merchant permanently.
  const read = await settingsService.getPaymentGatewayConfig({ tenantId: T_NONE.id });
  assert.equal(read.spin.authKey, '');
  assert.equal(read.spin.hasAuthKey, false);
  assert.equal(read.spin.tpn, '', 'must NOT be the platform TPN');
});

test('clearAuthKey erases the stored key', async () => {
  const scope = { tenantId: T_A.id };
  seedTenantTerminal(T_A);
  await settingsService.updatePaymentGatewayConfig({
    gateway: 'spin',
    spin: { enabled: true, tpn: T_A.tpn, clearAuthKey: true },
  }, scope);
  const blob = JSON.parse(settingRows.get(terminalConfigSettingKey(T_A.id)));
  assert.equal(blob.spin.authKey, '');
  assert.equal(blob.spin.clearAuthKey, undefined, 'command flags never persist');
  assert.equal(blob.spin.hasAuthKey, undefined, 'read-shape fields never persist');
});

test('a NEW key with no INTEGRATION_ENC_KEY is refused, not stored plaintext', async () => {
  const scope = { tenantId: T_A.id };
  const saved = process.env.INTEGRATION_ENC_KEY;
  delete process.env.INTEGRATION_ENC_KEY;
  _resetKeyCacheForTests();
  try {
    await assert.rejects(
      () => settingsService.updatePaymentGatewayConfig({
        gateway: 'spin', spin: { enabled: true, authKey: 'brand-new-key', tpn: T_A.tpn },
      }, scope),
      (e) => e.code === 'ENCRYPTION_NOT_CONFIGURED',
    );
    assert.equal(settingRows.get(terminalConfigSettingKey(T_A.id)), undefined, 'nothing was written');
  } finally {
    process.env.INTEGRATION_ENC_KEY = saved;
    _resetKeyCacheForTests();
  }
});

// ===========================================================================
// 6. THE AUTH KEY NEVER LEAKS — logs, audit metadata, redactor
// ===========================================================================

test('a full charge logs the config SOURCE and a MASKED tpn, and never the auth key', async () => {
  seedTenantTerminal(T_A);
  installChargeFakes({ tenantId: T_A.id });
  installLoggerSpy();
  try {
    await spinChargeService.runSale({ sessionId: 's1', amount: 100 });
  } finally {
    restoreChargeFakes();
  }

  const line = logLines.find((l) => /terminal config resolved/.test(l.msg));
  assert.ok(line, 'every charge records which config it used');
  assert.equal(line.meta.source, 'TENANT');
  assert.equal(line.meta.tenantId, T_A.id);
  assert.equal(line.meta.tpn, maskTpn(T_A.tpn));
  assert.ok(!line.meta.tpn.includes(T_A.tpn), 'the TPN is masked, not printed');
  assert.ok(!loggedText().includes(T_A.authKey), 'the auth key must never appear in any log line');
});

test('audit metadata carries booleans and a masked TPN — never the auth key', () => {
  const meta = buildTerminalAuditMetadata(
    { gateway: 'spin', spin: { enabled: true, tpn: T_A.tpn, hasAuthKey: true } },
    { spin: { authKey: T_A.authKey } },
    T_A.id,
  );
  assert.equal(meta.tenantId, T_A.id);
  assert.equal(meta.spinEnabled, true);
  assert.equal(meta.spinTpnMasked, maskTpn(T_A.tpn));
  assert.equal(meta.spinAuthKeyOnFile, true);
  assert.equal(meta.spinAuthKeyReplaced, true, 'that a key was supplied is auditable; the key is not');
  assert.ok(!JSON.stringify(meta).includes(T_A.authKey));
  // Belt and braces: the shared redactor also masks anything literally named
  // authKey, in case a future call site is careless.
  assert.equal(redactSensitive({ authKey: 'oops' }).authKey, '[redacted]');
});

test('maskTpn never leaks a short or absent TPN', () => {
  assert.equal(maskTpn(''), '(none)');
  assert.equal(maskTpn(null), '(none)');
  assert.equal(maskTpn('1234'), '****');
  assert.equal(maskTpn('12345678'), '****');
  assert.equal(maskTpn('816026739983'), '8160****9983');
});

// ===========================================================================
// 7. CACHE — cheap reads, but never stale after a save
// ===========================================================================

test('a second read hits the cache instead of the database', async () => {
  seedTenantTerminal(T_A);
  await resolveTenantTerminalConfig(T_A.id);
  const afterFirst = dbReads.appSetting;
  assert.ok(afterFirst >= 1, 'the first read goes to the DB');
  await resolveTenantTerminalConfig(T_A.id);
  await resolveTenantTerminalConfig(T_A.id);
  assert.equal(dbReads.appSetting, afterFirst, 'subsequent reads are served from cache');
});

test('saving the settings invalidates the cache IMMEDIATELY — the next charge uses the new TPN', async () => {
  const scope = { tenantId: T_A.id };
  seedTenantTerminal(T_A);
  const before = await resolveTenantTerminalConfig(T_A.id);
  assert.equal(before.tpn, T_A.tpn);

  // Operator fixes a typo'd TPN in Settings → Payment Gateway.
  await settingsService.updatePaymentGatewayConfig({
    gateway: 'spin',
    spin: { enabled: true, environment: 'production', authKey: '', tpn: '000011112222' },
  }, scope);

  const after = await resolveTenantTerminalConfig(T_A.id);
  assert.equal(after.tpn, '000011112222', 'no TTL wait — a stale terminal is a support call at the counter');
  assert.equal(after.authKey, T_A.authKey, 'and blank-means-keep preserved the key across the edit');
});

test('a dead database resolves to NONE rather than guessing a terminal', async () => {
  tenantRows.set(T_NONE.id, { name: T_NONE.name });
  prisma.appSetting.findUnique = async () => { throw new Error('connection refused'); };
  setEnvTerminal({ present: true, allowFallback: false });
  const resolved = await resolveTenantTerminalConfig(T_NONE.id);
  assert.equal(resolved.source, 'NONE');
});

test('a malformed settings row resolves to NONE rather than throwing on the charge path', async () => {
  tenantRows.set(T_NONE.id, { name: T_NONE.name });
  settingRows.set(terminalConfigSettingKey(T_NONE.id), '{not json');
  setEnvTerminal({ present: true, allowFallback: false });
  const resolved = await resolveTenantTerminalConfig(T_NONE.id);
  assert.equal(resolved.source, 'NONE');
});
