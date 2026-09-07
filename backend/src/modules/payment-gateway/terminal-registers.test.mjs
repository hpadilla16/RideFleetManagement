/**
 * PER-LOCATION TERMINAL REGISTERS (2026-09-04). MONEY PATH.
 *
 * The gap these tests close: the terminal was resolved per TENANT. Corpusa has
 * five locations and one credential pair, so configuring Orlando meant
 * overwriting LAX — and any tenant with two branches on one `spin` block was
 * running every counter's sales through whichever terminal happened to be
 * saved. tenant-terminal-config.test.mjs already keeps the WRONG-MERCHANT bug
 * dead; this file keeps the WRONG-COUNTER one dead.
 *
 * Hardest first:
 *   • a pickup location with NO register of its own is REFUSED, never quietly
 *     served by another branch's terminal and never by the legacy tenant block
 *     — that is charging at counter A on counter B's device;
 *   • a register that DOES match wins over the legacy block;
 *   • the legacy single-terminal path is untouched for a tenant with no
 *     registers, whatever location is passed (IRC today);
 *   • sole-register convenience for the paths that genuinely have no location,
 *     and a refusal instead of a guess once there is more than one;
 *   • every register authKey is ciphertext at rest, dual-reads legacy
 *     plaintext, is never echoed on read, survives blank-means-keep, and never
 *     reaches a log line or the audit trail;
 *   • a save invalidates the charge path's cache immediately.
 */
import '../../lib/_two-factor-test-env.mjs'; // MUST be first — env before prisma.js constructs

import test, { beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { prisma } from '../../lib/prisma.js';
import logger from '../../lib/logger.js';
import { cache } from '../../lib/cache.js';
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
  listTerminalRegisters,
  spinAuthKeyShape,
} from './tenant-terminal-config.js';
import { settingsService } from '../settings/settings.service.js';
import { resolveTenantHppConfig } from './ipos-hpp-client.js';

// ---------------------------------------------------------------------------
// Fixtures — Corpusa's real shape: one tenant, several branches, one terminal
// each. LAX is the branch that was configured first; Orlando is the one that
// got forgotten, which is the case that must fail closed.
// ---------------------------------------------------------------------------

const TENANT = { id: 'tenant-corpusa', name: 'Corpusa Rentals' };
const OTHER = { id: 'tenant-irc', name: 'International Rental Corp' };

const LOC_LAX = 'loc-lax';
const LOC_MCO = 'loc-mco';
const LOC_MIA = 'loc-mia';

const REG_LAX = {
  id: 'reg-lax-1', name: 'LAX Counter 1', locationId: LOC_LAX,
  tpn: '441900002071', authKey: 'lax-key-AA',
};
const REG_LAX2 = {
  id: 'reg-lax-2', name: 'LAX Counter 2', locationId: LOC_LAX,
  tpn: '441900002072', authKey: 'lax2-key-BB',
};
const REG_MCO = {
  id: 'reg-mco-1', name: 'Orlando Counter', locationId: LOC_MCO,
  tpn: '551900003080', authKey: 'mco-key-CC',
};

const LEGACY = { tpn: '999900009999', authKey: 'legacy-key-ZZ' };

const ENV_TPN = '816026739983';
const ENV_AUTH_KEY = 'platform-env-auth-key-PPPP';

// ---------------------------------------------------------------------------
// In-memory prisma fakes. The client never connects.
// ---------------------------------------------------------------------------

let settingRows;
let tenantRows;
let locationRows;
let dbReads;
let savedPrisma;

function blob({ spin = null, registers = null } = {}) {
  const out = { gateway: 'spin', label: 'x' };
  if (spin) out.spin = spin;
  if (registers) out.registers = registers;
  return JSON.stringify(out);
}

function storedRegister(r, { encrypted = true, enabled = true, extra = {} } = {}) {
  return {
    id: r.id,
    name: r.name,
    locationId: r.locationId,
    tpn: r.tpn,
    authKey: encrypted ? encryptSettingSecret(r.authKey) : r.authKey,
    merchantNumber: '1',
    callbackUrl: '',
    proxyTimeout: '120',
    enabled,
    ...extra,
  };
}

function legacySpin() {
  return {
    enabled: true,
    environment: 'production',
    authKey: encryptSettingSecret(LEGACY.authKey),
    tpn: LEGACY.tpn,
    merchantNumber: '1',
    callbackUrl: 'https://legacy.example/callback',
    proxyTimeout: '90',
  };
}

/** Seed the tenant row + its paymentGatewayConfig in one go. */
function seed(tenant, { spin = null, registers = null } = {}) {
  tenantRows.set(tenant.id, { name: tenant.name });
  settingRows.set(terminalConfigSettingKey(tenant.id), blob({ spin, registers }));
}

function installPrismaFakes() {
  savedPrisma = {
    appSettingFindUnique: prisma.appSetting.findUnique,
    appSettingUpsert: prisma.appSetting.upsert,
    tenantFindUnique: prisma.tenant.findUnique,
    locationFindFirst: prisma.location.findFirst,
  };
  // Locations, so the promote path can check a location belongs to the tenant
  // asking for it — the cross-tenant half of the wrong-counter rule.
  prisma.location.findFirst = async ({ where }) => {
    const row = locationRows.get(where?.id);
    if (!row) return null;
    if (where?.tenantId && row.tenantId !== where.tenantId) return null;
    return { id: where.id, name: row.name, code: row.code };
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
  prisma.location.findFirst = savedPrisma.locationFindFirst;
  prisma.appSetting.findUnique = savedPrisma.appSettingFindUnique;
  prisma.appSetting.upsert = savedPrisma.appSettingUpsert;
  prisma.tenant.findUnique = savedPrisma.tenantFindUnique;
}

const ENV_KEYS = ['SPIN_AUTH_KEY', 'SPIN_TPN', 'SPIN_MERCHANT_NUMBER', 'SPIN_CALLBACK_URL', 'SPIN_PROXY_TIMEOUT', 'SPIN_ALLOW_ENV_FALLBACK', 'SPIN_DRY_RUN'];

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
function loggedText() { return JSON.stringify(logLines); }

beforeEach(() => {
  settingRows = new Map();
  tenantRows = new Map();
  locationRows = new Map([
    [LOC_LAX, { tenantId: TENANT.id, name: 'Los Angeles', code: 'LAX' }],
    [LOC_MCO, { tenantId: TENANT.id, name: 'Orlando', code: 'MCO' }],
    [LOC_MIA, { tenantId: TENANT.id, name: 'Miami', code: 'MIA' }],
    ['loc-other-tenant', { tenantId: OTHER.id, name: 'IRC San Juan', code: 'SJU' }],
  ]);
  dbReads = { appSetting: 0, tenant: 0 };
  cache.clear();
  installPrismaFakes();
  setEnvTerminal();
  _resetKeyCacheForTests();
});

afterEach(() => {
  restorePrismaFakes();
  if (savedLogger) { restoreLogger(); savedLogger = null; }
  for (const k of ENV_KEYS) delete process.env[k];
});

// ===========================================================================
// 1. THE FAIL-CLOSED CASE — a location with no register of its own
// ===========================================================================

test('a locationId with NO matching register resolves NONE — never another counter\'s terminal', async () => {
  // LAX and Orlando are registered. Miami is not — the branch somebody has not
  // configured yet, which is exactly the state Corpusa is in mid-rollout.
  seed(TENANT, { registers: [storedRegister(REG_LAX), storedRegister(REG_MCO)] });

  const resolved = await resolveTenantTerminalConfig(TENANT.id, { locationId: LOC_MIA });

  assert.equal(resolved.source, 'NONE');
  assert.equal(resolved.reason, 'NO_REGISTER_FOR_LOCATION');
  assert.equal(resolved.authKey, '', 'no credential may escape');
  assert.equal(resolved.tpn, '');
  // The specific failure: NOT LAX's terminal, NOT Orlando's.
  assert.notEqual(resolved.tpn, REG_LAX.tpn);
  assert.notEqual(resolved.tpn, REG_MCO.tpn);
  assert.equal(toSpinClientConfig(resolved).spinTpn, undefined,
    'and nothing reaches the SPIn client, so it cannot fall through to env either');
});

test('an unregistered location does NOT fall back to the tenant\'s legacy single terminal', async () => {
  // The nastiest variant: the tenant has BOTH a legacy block (LAX's old
  // credentials, still on file) and registers. An unregistered branch must not
  // inherit the legacy block — that is the same wrong-counter charge wearing
  // the old shape.
  seed(TENANT, { spin: legacySpin(), registers: [storedRegister(REG_LAX)] });

  const resolved = await resolveTenantTerminalConfig(TENANT.id, { locationId: LOC_MIA });

  assert.equal(resolved.source, 'NONE');
  assert.equal(resolved.reason, 'NO_REGISTER_FOR_LOCATION');
  assert.notEqual(resolved.tpn, LEGACY.tpn, 'the legacy block is superseded, not a safety net');
});

test('an unregistered location does NOT fall back to the PLATFORM env terminal either', async () => {
  seed(TENANT, { registers: [storedRegister(REG_LAX)] });
  setEnvTerminal({ present: true, allowFallback: true }); // fallback is ALLOWED

  const resolved = await resolveTenantTerminalConfig(TENANT.id, { locationId: LOC_MIA });

  assert.equal(resolved.source, 'NONE');
  assert.equal(resolved.reason, 'NO_REGISTER_FOR_LOCATION');
  assert.notEqual(resolved.tpn, ENV_TPN,
    'env fallback is for a tenant with NOTHING; this tenant has terminals, just not here');
});

test('the refusal is LOUD and names the location, without leaking a credential', async () => {
  seed(TENANT, { registers: [storedRegister(REG_LAX), storedRegister(REG_MCO)] });
  installLoggerSpy();

  await resolveTenantTerminalConfig(TENANT.id, { locationId: LOC_MIA });

  const err = logLines.find((l) => l.level === 'error' && /NONE for this location/.test(l.msg));
  assert.ok(err, 'a silent refusal is a support ticket nobody can diagnose');
  assert.equal(err.meta.tenantId, TENANT.id);
  assert.equal(err.meta.tenantName, TENANT.name);
  assert.equal(err.meta.locationId, LOC_MIA);
  assert.equal(err.meta.enabledRegisterCount, 2);
  for (const key of [REG_LAX.authKey, REG_MCO.authKey]) {
    assert.ok(!loggedText().includes(key), 'never a register auth key');
  }
});

test('a DISABLED register for that location is not a register for that location', async () => {
  // Taking one counter's device out of service must not silently promote
  // another branch's terminal in its place.
  seed(TENANT, {
    registers: [storedRegister(REG_LAX, { enabled: false }), storedRegister(REG_MCO)],
  });

  const resolved = await resolveTenantTerminalConfig(TENANT.id, { locationId: LOC_LAX });
  assert.equal(resolved.source, 'NONE');
  assert.equal(resolved.reason, 'NO_REGISTER_FOR_LOCATION');
  assert.notEqual(resolved.tpn, REG_MCO.tpn);
});

// ===========================================================================
// 2. RESOLUTION ORDER — the table, case by case
// ===========================================================================

test('(a) an enabled register matching the location wins: source TENANT, reason REGISTER_MATCH', async () => {
  seed(TENANT, { registers: [storedRegister(REG_LAX), storedRegister(REG_MCO)] });

  const lax = await resolveTenantTerminalConfig(TENANT.id, { locationId: LOC_LAX });
  const mco = await resolveTenantTerminalConfig(TENANT.id, { locationId: LOC_MCO });

  assert.equal(lax.source, 'TENANT');
  assert.equal(lax.reason, 'REGISTER_MATCH');
  assert.equal(lax.tpn, REG_LAX.tpn);
  assert.equal(lax.authKey, REG_LAX.authKey);
  assert.equal(lax.registerId, REG_LAX.id);
  assert.equal(lax.registerName, REG_LAX.name);
  assert.equal(lax.locationId, LOC_LAX);

  assert.equal(mco.tpn, REG_MCO.tpn);
  assert.equal(mco.authKey, REG_MCO.authKey);
  assert.notEqual(lax.tpn, mco.tpn, 'two branches, two terminals — the whole point');
});

test('(a) a matching register OUTRANKS the legacy single spin block', async () => {
  seed(TENANT, { spin: legacySpin(), registers: [storedRegister(REG_LAX)] });

  const resolved = await resolveTenantTerminalConfig(TENANT.id, { locationId: LOC_LAX });
  assert.equal(resolved.reason, 'REGISTER_MATCH');
  assert.equal(resolved.tpn, REG_LAX.tpn);
  assert.notEqual(resolved.tpn, LEGACY.tpn);
});

test('(b) no locationId + exactly ONE enabled register: that one, reason SOLE_REGISTER', async () => {
  seed(TENANT, { registers: [storedRegister(REG_LAX)] });

  const resolved = await resolveTenantTerminalConfig(TENANT.id);
  assert.equal(resolved.source, 'TENANT');
  assert.equal(resolved.reason, 'SOLE_REGISTER');
  assert.equal(resolved.tpn, REG_LAX.tpn);
  assert.equal(resolved.registerId, REG_LAX.id);
});

test('(b) sole-register also applies when the others are disabled', async () => {
  seed(TENANT, {
    registers: [storedRegister(REG_LAX), storedRegister(REG_MCO, { enabled: false })],
  });
  const resolved = await resolveTenantTerminalConfig(TENANT.id);
  assert.equal(resolved.reason, 'SOLE_REGISTER');
  assert.equal(resolved.tpn, REG_LAX.tpn);
});

test('no locationId + SEVERAL enabled registers refuses instead of guessing a counter', async () => {
  seed(TENANT, { registers: [storedRegister(REG_LAX), storedRegister(REG_MCO)] });

  const resolved = await resolveTenantTerminalConfig(TENANT.id);
  assert.equal(resolved.source, 'NONE');
  assert.equal(resolved.reason, 'AMBIGUOUS_REGISTER_NO_LOCATION');
  assert.equal(resolved.tpn, '');
});

test('(c) LEGACY UNTOUCHED: a tenant with no registers resolves exactly as before', async () => {
  // IRC today. This is the compatibility guarantee the whole change rests on.
  seed(OTHER, { spin: legacySpin() });

  const bare = await resolveTenantTerminalConfig(OTHER.id);
  assert.equal(bare.source, 'TENANT');
  assert.equal(bare.reason, 'TENANT_CONFIG');
  assert.equal(bare.tpn, LEGACY.tpn);
  assert.equal(bare.authKey, LEGACY.authKey);
  assert.equal(bare.registerId, null, 'the legacy block is not a register');
});

test('(c) LEGACY UNTOUCHED even when a locationId IS passed', async () => {
  // Callers now thread the pickup location unconditionally. A tenant that never
  // adopted registers must not start failing because of it.
  seed(OTHER, { spin: legacySpin() });

  const resolved = await resolveTenantTerminalConfig(OTHER.id, { locationId: LOC_MIA });
  assert.equal(resolved.source, 'TENANT');
  assert.equal(resolved.reason, 'TENANT_CONFIG');
  assert.equal(resolved.tpn, LEGACY.tpn, 'an unknown location is IGNORED, not an error, without registers');
});

test('(c) an EMPTY registers array is the same as no registers at all', async () => {
  seed(OTHER, { spin: legacySpin(), registers: [] });
  const resolved = await resolveTenantTerminalConfig(OTHER.id, { locationId: LOC_LAX });
  assert.equal(resolved.reason, 'TENANT_CONFIG');
  assert.equal(resolved.tpn, LEGACY.tpn);
});

test('(c) ALL registers disabled falls back to the legacy block — same tenant, never a different merchant', async () => {
  seed(TENANT, {
    spin: legacySpin(),
    registers: [storedRegister(REG_LAX, { enabled: false }), storedRegister(REG_MCO, { enabled: false })],
  });
  const resolved = await resolveTenantTerminalConfig(TENANT.id, { locationId: LOC_LAX });
  assert.equal(resolved.source, 'TENANT');
  assert.equal(resolved.reason, 'TENANT_CONFIG');
  assert.equal(resolved.tpn, LEGACY.tpn);
});

test('(d) ENV fallback is unchanged for a tenant with neither registers nor a spin block', async () => {
  tenantRows.set(OTHER.id, { name: OTHER.name });
  setEnvTerminal({ present: true, allowFallback: true });

  const resolved = await resolveTenantTerminalConfig(OTHER.id, { locationId: LOC_LAX });
  assert.equal(resolved.source, 'ENV');
  assert.equal(resolved.reason, 'ENV_FALLBACK');
  assert.equal(resolved.tpn, ENV_TPN);
});

test('(e) NONE when there is nothing anywhere', async () => {
  tenantRows.set(OTHER.id, { name: OTHER.name });
  setEnvTerminal({ present: false, allowFallback: true });

  const resolved = await resolveTenantTerminalConfig(OTHER.id, { locationId: LOC_LAX });
  assert.equal(resolved.source, 'NONE');
  assert.equal(resolved.reason, 'NO_CONFIG_ANYWHERE');
});

// ===========================================================================
// 3. HALF-CONFIGURED REGISTERS — the same refusal, one level down
// ===========================================================================

test('a register with a TPN but no auth key is refused, never completed from elsewhere', async () => {
  seed(TENANT, {
    spin: legacySpin(),
    registers: [
      { ...storedRegister(REG_LAX), authKey: '' },
      storedRegister(REG_MCO),
    ],
  });

  const resolved = await resolveTenantTerminalConfig(TENANT.id, { locationId: LOC_LAX });
  assert.equal(resolved.source, 'NONE');
  assert.equal(resolved.reason, 'INCOMPLETE_REGISTER');
  assert.equal(resolved.registerId, REG_LAX.id, 'and it says WHICH register needs finishing');
  assert.notEqual(resolved.authKey, LEGACY.authKey, 'never paired with the legacy half');
  assert.notEqual(resolved.authKey, REG_MCO.authKey, 'never paired with another counter\'s half');
});

test('a register with an auth key but no TPN is refused too', async () => {
  seed(TENANT, { registers: [{ ...storedRegister(REG_LAX), tpn: '' }] });
  const resolved = await resolveTenantTerminalConfig(TENANT.id, { locationId: LOC_LAX });
  assert.equal(resolved.source, 'NONE');
  assert.equal(resolved.reason, 'INCOMPLETE_REGISTER');
});

test('a register with no id is dropped rather than resolved — it cannot be pinned or audited', async () => {
  seed(TENANT, {
    spin: legacySpin(),
    registers: [{ ...storedRegister(REG_LAX), id: '' }],
  });
  // With that row dropped there are no enabled registers, so the tenant is back
  // on its legacy block rather than charging through an unaddressable terminal.
  const resolved = await resolveTenantTerminalConfig(TENANT.id, { locationId: LOC_LAX });
  assert.equal(resolved.reason, 'TENANT_CONFIG');
  assert.equal(resolved.tpn, LEGACY.tpn);
});

// ===========================================================================
// 4. TWO COUNTERS AT ONE BRANCH — the mockup's LAX Counter 1 / Counter 2
// ===========================================================================

test('registerId pins an exact counter: reason REGISTER_PINNED', async () => {
  seed(TENANT, { registers: [storedRegister(REG_LAX), storedRegister(REG_LAX2)] });

  const one = await resolveTenantTerminalConfig(TENANT.id, { registerId: REG_LAX.id });
  const two = await resolveTenantTerminalConfig(TENANT.id, { registerId: REG_LAX2.id });

  assert.equal(one.reason, 'REGISTER_PINNED');
  assert.equal(one.tpn, REG_LAX.tpn);
  assert.equal(two.tpn, REG_LAX2.tpn);
  assert.notEqual(one.tpn, two.tpn);
});

test('an unknown or disabled registerId refuses rather than substituting another device', async () => {
  seed(TENANT, { registers: [storedRegister(REG_LAX), storedRegister(REG_LAX2, { enabled: false })] });

  const gone = await resolveTenantTerminalConfig(TENANT.id, { registerId: 'reg-nope' });
  assert.equal(gone.source, 'NONE');
  assert.equal(gone.reason, 'NO_REGISTER_FOR_ID');

  const off = await resolveTenantTerminalConfig(TENANT.id, { registerId: REG_LAX2.id });
  assert.equal(off.source, 'NONE');
  assert.equal(off.reason, 'NO_REGISTER_FOR_ID');
  assert.notEqual(off.tpn, REG_LAX.tpn, 'the other counter is not a stand-in');
});

test('a pin does not outrank the counter: registerId from ANOTHER location refuses (2026-09-04)', async () => {
  // The stale-selection case: a checkout pinned LAX Counter 1, then the
  // reservation's pickup location was edited to Orlando. Honouring the pin
  // would charge at Orlando on LAX's device.
  seed(TENANT, { registers: [storedRegister(REG_LAX), storedRegister(REG_MCO)] });

  const stale = await resolveTenantTerminalConfig(TENANT.id, {
    locationId: LOC_MCO, registerId: REG_LAX.id,
  });
  assert.equal(stale.source, 'NONE');
  assert.equal(stale.reason, 'REGISTER_LOCATION_MISMATCH');
  assert.equal(stale.authKey, '', 'no credential may escape');

  // The same pin WITH its own location still resolves — and a pinned register
  // that carries no location of its own is location-agnostic and pins fine.
  const fine = await resolveTenantTerminalConfig(TENANT.id, {
    locationId: LOC_LAX, registerId: REG_LAX.id,
  });
  assert.equal(fine.reason, 'REGISTER_PINNED');
  assert.equal(fine.tpn, REG_LAX.tpn);

  seed(TENANT, { registers: [storedRegister({ ...REG_LAX, locationId: '' }), storedRegister(REG_MCO)] });
  invalidateTenantTerminalConfig(TENANT.id);
  const agnostic = await resolveTenantTerminalConfig(TENANT.id, {
    locationId: LOC_MCO, registerId: REG_LAX.id,
  });
  assert.equal(agnostic.reason, 'REGISTER_PINNED');
  assert.equal(agnostic.tpn, REG_LAX.tpn);
});

// ===========================================================================
// 4b. THE AGENT'S SELECTOR READ — listTerminalRegisters (2026-09-04)
// ===========================================================================

test('listTerminalRegisters carries names and MASKED TPNs only — never a key, never a full TPN', async () => {
  seed(TENANT, { registers: [storedRegister(REG_LAX), storedRegister(REG_LAX2), storedRegister(REG_MCO)] });

  const { hasRegisters, registers } = await listTerminalRegisters(TENANT.id, { locationId: LOC_LAX });

  assert.equal(hasRegisters, true);
  assert.deepEqual(registers.map((r) => r.id), [REG_LAX.id, REG_LAX2.id],
    'scoped to the counter — Orlando\'s device is not on the list');
  for (const r of registers) {
    assert.equal(r.complete, true);
    assert.match(r.maskedTpn, /\*/, 'TPN is masked');
    const flat = JSON.stringify(r);
    assert.ok(!flat.includes(REG_LAX.authKey) && !flat.includes(REG_LAX2.authKey), 'no auth key in the payload');
    assert.ok(!flat.includes(REG_LAX.tpn) && !flat.includes(REG_LAX2.tpn), 'no full TPN in the payload');
  }
});

test('listTerminalRegisters: disabled registers are absent, half-configured ones are flagged, legacy tenants list nothing', async () => {
  seed(TENANT, {
    registers: [
      storedRegister(REG_LAX),
      storedRegister(REG_LAX2, { enabled: false }),
      storedRegister({ ...REG_MCO, id: 'reg-lax-3', name: 'LAX Counter 3', locationId: LOC_LAX, authKey: '' }, { encrypted: false }),
    ],
  });
  const { registers } = await listTerminalRegisters(TENANT.id, { locationId: LOC_LAX });
  assert.deepEqual(registers.map((r) => [r.id, r.complete]), [[REG_LAX.id, true], ['reg-lax-3', false]],
    'the disabled counter is gone; the half-configured one is listed but flagged');

  // A legacy single-terminal tenant (no registers) renders no selector at all.
  seed(OTHER, { spin: legacySpin() });
  const legacy = await listTerminalRegisters(OTHER.id, { locationId: LOC_LAX });
  assert.equal(legacy.hasRegisters, false);
  assert.deepEqual(legacy.registers, []);
});

test('two registers at ONE location: the first is used and the ambiguity is logged', async () => {
  // Same location means same merchant, so this is a wrong-DEVICE risk rather
  // than a wrong-merchant one. It resolves, but never quietly.
  seed(TENANT, { registers: [storedRegister(REG_LAX), storedRegister(REG_LAX2)] });
  installLoggerSpy();

  const resolved = await resolveTenantTerminalConfig(TENANT.id, { locationId: LOC_LAX });
  assert.equal(resolved.reason, 'REGISTER_MATCH');
  assert.equal(resolved.tpn, REG_LAX.tpn);

  const warn = logLines.find((l) => l.level === 'warn' && /more than one enabled register/.test(l.msg));
  assert.ok(warn, 'the operator must be able to see that a counter was picked for them');
  assert.equal(warn.meta.candidates.length, 2);
  assert.ok(!loggedText().includes(REG_LAX.authKey));
  assert.ok(!loggedText().includes(REG_LAX2.authKey));
  for (const c of warn.meta.candidates) {
    assert.match(c.maskedTpn, /\*\*\*\*/, 'candidate TPNs are masked');
  }
});

// ===========================================================================
// 5. TENANT ISOLATION — registers do not cross tenants
// ===========================================================================

test('one tenant\'s registers never answer for another tenant\'s location', async () => {
  seed(TENANT, { registers: [storedRegister(REG_LAX), storedRegister(REG_MCO)] });
  seed(OTHER, { spin: legacySpin() });

  const mine = await resolveTenantTerminalConfig(TENANT.id, { locationId: LOC_LAX });
  const theirs = await resolveTenantTerminalConfig(OTHER.id, { locationId: LOC_LAX });

  assert.equal(mine.tpn, REG_LAX.tpn);
  assert.equal(theirs.tpn, LEGACY.tpn, 'same locationId string, different tenant, different answer');
  assert.notEqual(mine.authKey, theirs.authKey);
});

// ===========================================================================
// 6. STORAGE — encryption round-trip, write-only, blank-means-keep
// ===========================================================================

test('saving a register stores its auth key as ciphertext and resolves back to the plaintext', async () => {
  const scope = { tenantId: TENANT.id };
  tenantRows.set(TENANT.id, { name: TENANT.name });

  await settingsService.updatePaymentGatewayConfig({
    gateway: 'spin',
    registers: [
      { id: REG_LAX.id, name: REG_LAX.name, locationId: LOC_LAX, tpn: REG_LAX.tpn, authKey: REG_LAX.authKey, enabled: true },
    ],
  }, scope);

  const raw = settingRows.get(terminalConfigSettingKey(TENANT.id));
  assert.ok(!raw.includes(REG_LAX.authKey), 'no register key may sit in the row in plaintext');
  const stored = JSON.parse(raw);
  assert.equal(stored.registers.length, 1);
  assert.ok(isSettingSecretEncrypted(stored.registers[0].authKey));
  assert.equal(stored.registers[0].tpn, REG_LAX.tpn, 'the TPN is an identifier, not a secret');

  const resolved = await resolveTenantTerminalConfig(TENANT.id, { locationId: LOC_LAX });
  assert.equal(resolved.source, 'TENANT');
  assert.equal(resolved.reason, 'REGISTER_MATCH');
  assert.equal(resolved.authKey, REG_LAX.authKey, 'round-trips');
});

test('a legacy PLAINTEXT register auth key still resolves (dual-read)', async () => {
  seed(TENANT, { registers: [storedRegister(REG_LAX, { encrypted: false })] });
  const stored = JSON.parse(settingRows.get(terminalConfigSettingKey(TENANT.id)));
  assert.equal(stored.registers[0].authKey, REG_LAX.authKey, 'fixture really is plaintext');

  const resolved = await resolveTenantTerminalConfig(TENANT.id, { locationId: LOC_LAX });
  assert.equal(resolved.authKey, REG_LAX.authKey);
});

test('the read path never returns a register auth key — hasAuthKey instead', async () => {
  const scope = { tenantId: TENANT.id };
  tenantRows.set(TENANT.id, { name: TENANT.name });
  await settingsService.updatePaymentGatewayConfig({
    gateway: 'spin',
    registers: [{ id: REG_LAX.id, name: REG_LAX.name, locationId: LOC_LAX, tpn: REG_LAX.tpn, authKey: REG_LAX.authKey }],
  }, scope);

  const read = await settingsService.getPaymentGatewayConfig(scope);
  assert.equal(read.registers.length, 1);
  assert.equal(read.registers[0].authKey, '', 'not the plaintext');
  assert.ok(!JSON.stringify(read).includes(REG_LAX.authKey), 'and not the ciphertext either');
  assert.equal(read.registers[0].hasAuthKey, true);
  assert.equal(read.registers[0].tpn, REG_LAX.tpn, 'the TPN is shown — the operator must eyeball it');
  assert.equal(read.registers[0].locationId, LOC_LAX);
  assert.equal(read.registers[0].name, REG_LAX.name);
});

test('blank-means-keep: a plain form round-trip does not erase a register credential', async () => {
  const scope = { tenantId: TENANT.id };
  seed(TENANT, { registers: [storedRegister(REG_LAX)] });

  // The UI never gets the key back, so it saves a blank one. Renaming the
  // counter must not wipe its terminal.
  await settingsService.updatePaymentGatewayConfig({
    gateway: 'spin',
    registers: [{ id: REG_LAX.id, name: 'LAX Counter 1 (rear)', locationId: LOC_LAX, tpn: REG_LAX.tpn, authKey: '' }],
  }, scope);

  const resolved = await resolveTenantTerminalConfig(TENANT.id, { locationId: LOC_LAX });
  assert.equal(resolved.authKey, REG_LAX.authKey, 'the saved key survived');
  assert.equal(resolved.registerName, 'LAX Counter 1 (rear)', 'and the rename landed');
});

test('blank-means-keep is keyed per register — one row\'s key never lands on another row', async () => {
  const scope = { tenantId: TENANT.id };
  seed(TENANT, { registers: [storedRegister(REG_LAX), storedRegister(REG_MCO)] });

  // Reorder them and blank both keys, the way a form round-trip would.
  await settingsService.updatePaymentGatewayConfig({
    gateway: 'spin',
    registers: [
      { id: REG_MCO.id, name: REG_MCO.name, locationId: LOC_MCO, tpn: REG_MCO.tpn, authKey: '' },
      { id: REG_LAX.id, name: REG_LAX.name, locationId: LOC_LAX, tpn: REG_LAX.tpn, authKey: '' },
    ],
  }, scope);

  const lax = await resolveTenantTerminalConfig(TENANT.id, { locationId: LOC_LAX });
  const mco = await resolveTenantTerminalConfig(TENANT.id, { locationId: LOC_MCO });
  assert.equal(lax.authKey, REG_LAX.authKey, 'matched by id, not by position');
  assert.equal(mco.authKey, REG_MCO.authKey);
});

test('clearAuthKey erases one register\'s key — and it then refuses rather than borrowing one', async () => {
  const scope = { tenantId: TENANT.id };
  seed(TENANT, { registers: [storedRegister(REG_LAX), storedRegister(REG_MCO)] });

  await settingsService.updatePaymentGatewayConfig({
    gateway: 'spin',
    registers: [
      { id: REG_LAX.id, name: REG_LAX.name, locationId: LOC_LAX, tpn: REG_LAX.tpn, clearAuthKey: true },
      { id: REG_MCO.id, name: REG_MCO.name, locationId: LOC_MCO, tpn: REG_MCO.tpn, authKey: '' },
    ],
  }, scope);

  const lax = await resolveTenantTerminalConfig(TENANT.id, { locationId: LOC_LAX });
  assert.equal(lax.source, 'NONE');
  assert.equal(lax.reason, 'INCOMPLETE_REGISTER');
  const mco = await resolveTenantTerminalConfig(TENANT.id, { locationId: LOC_MCO });
  assert.equal(mco.authKey, REG_MCO.authKey, 'the other register is untouched');
});

test('the legacy spin block survives a registers-only save, and vice versa', async () => {
  const scope = { tenantId: TENANT.id };
  seed(TENANT, { spin: legacySpin() });

  await settingsService.updatePaymentGatewayConfig({
    gateway: 'spin',
    spin: { enabled: true, environment: 'production', authKey: '', tpn: LEGACY.tpn },
    registers: [{ id: REG_LAX.id, name: REG_LAX.name, locationId: LOC_LAX, tpn: REG_LAX.tpn, authKey: REG_LAX.authKey }],
  }, scope);

  const stored = JSON.parse(settingRows.get(terminalConfigSettingKey(TENANT.id)));
  assert.ok(isSettingSecretEncrypted(stored.spin.authKey), 'the legacy key is still on file');
  assert.equal(stored.spin.tpn, LEGACY.tpn);
  assert.equal(stored.registers.length, 1);

  // The register now wins for LAX, but the block is still there for a tenant
  // that disables every register.
  const read = await settingsService.getPaymentGatewayConfig(scope);
  assert.equal(read.spin.hasAuthKey, true);
  assert.equal(read.registers[0].hasAuthKey, true);
});

test('a payload with NO registers key leaves the stored registers alone', async () => {
  // An older client, or a partial PUT, must not delete a tenant's terminals.
  const scope = { tenantId: TENANT.id };
  seed(TENANT, { registers: [storedRegister(REG_LAX)] });

  await settingsService.updatePaymentGatewayConfig({ gateway: 'spin' }, scope);

  const resolved = await resolveTenantTerminalConfig(TENANT.id, { locationId: LOC_LAX });
  assert.equal(resolved.tpn, REG_LAX.tpn);
  assert.equal(resolved.authKey, REG_LAX.authKey);
});

test('an explicitly EMPTY registers array does delete them — removal has to be possible', async () => {
  const scope = { tenantId: TENANT.id };
  seed(TENANT, { spin: legacySpin(), registers: [storedRegister(REG_LAX)] });

  await settingsService.updatePaymentGatewayConfig({
    gateway: 'spin',
    spin: { enabled: true, environment: 'production', authKey: '', tpn: LEGACY.tpn },
    registers: [],
  }, scope);

  const read = await settingsService.getPaymentGatewayConfig(scope);
  assert.equal(read.registers.length, 0);
  const resolved = await resolveTenantTerminalConfig(TENANT.id, { locationId: LOC_LAX });
  assert.equal(resolved.reason, 'TENANT_CONFIG', 'and the tenant is back on its single terminal');
});

test('a NEW register with no id gets one minted, so the next save can keep its key', async () => {
  const scope = { tenantId: TENANT.id };
  tenantRows.set(TENANT.id, { name: TENANT.name });

  await settingsService.updatePaymentGatewayConfig({
    gateway: 'spin',
    registers: [{ name: 'Miami Counter', locationId: LOC_MIA, tpn: '661900004090', authKey: 'mia-key-DD' }],
  }, scope);

  const read = await settingsService.getPaymentGatewayConfig(scope);
  assert.equal(read.registers.length, 1);
  assert.ok(read.registers[0].id, 'an id was minted');
  const mintedId = read.registers[0].id;

  // Round-trip with a blank key, as the form would.
  await settingsService.updatePaymentGatewayConfig({
    gateway: 'spin',
    registers: [{ id: mintedId, name: 'Miami Counter', locationId: LOC_MIA, tpn: '661900004090', authKey: '' }],
  }, scope);

  const resolved = await resolveTenantTerminalConfig(TENANT.id, { locationId: LOC_MIA });
  assert.equal(resolved.authKey, 'mia-key-DD');
});

// ===========================================================================
// 6b. ipos.locations — the payment-link entries ride the SAME save contract
// (2026-09-04). Resolution behaviour lives in ipos-hpp-client.test.mjs; what
// is pinned here is the settings round-trip: encrypted at rest, never echoed,
// blank-means-keep per row, unsubmitted-means-untouched.
// ===========================================================================

test('an ipos location entry saves encrypted, reads as booleans, and blank-means-keep holds per row', async () => {
  const scope = { tenantId: TENANT.id };
  tenantRows.set(TENANT.id, { name: TENANT.name });

  await settingsService.updatePaymentGatewayConfig({
    gateway: 'ipos',
    ipos: {
      enabled: true,
      locations: [
        { locationId: LOC_LAX, label: 'LAX', tpn: '441900002071', hppToken: 'lax-hpp-token', apiKey: 'lax-api', secretKey: 'lax-sec' },
      ],
    },
  }, scope);

  // At rest: ciphertext, all three credentials.
  const stored = JSON.parse(settingRows.get(terminalConfigSettingKey(TENANT.id)));
  assert.equal(stored.ipos.locations.length, 1);
  assert.ok(isSettingSecretEncrypted(stored.ipos.locations[0].hppToken));
  assert.ok(isSettingSecretEncrypted(stored.ipos.locations[0].apiKey));
  assert.ok(isSettingSecretEncrypted(stored.ipos.locations[0].secretKey));

  // On read: booleans, never bytes.
  const read = await settingsService.getPaymentGatewayConfig(scope);
  assert.equal(read.ipos.locations.length, 1);
  assert.equal(read.ipos.locations[0].hppToken, '');
  assert.equal(read.ipos.locations[0].hasHppToken, true);
  assert.equal(read.ipos.locations[0].hasApiKey, true);
  assert.equal(read.ipos.locations[0].hasSecretKey, true);
  const flat = JSON.stringify(read);
  assert.ok(!flat.includes('lax-hpp-token') && !flat.includes('lax-api') && !flat.includes('lax-sec'));

  // Blank round-trip (the form never gets the credentials back) keeps them.
  const rowId = read.ipos.locations[0].id;
  await settingsService.updatePaymentGatewayConfig({
    gateway: 'ipos',
    ipos: {
      enabled: true,
      locations: [{ id: rowId, locationId: LOC_LAX, label: 'LAX front desk', tpn: '441900002071', hppToken: '', apiKey: '', secretKey: '' }],
    },
  }, scope);
  const resolved = await resolveTenantHppConfig(TENANT.id, { locationId: LOC_LAX });
  assert.equal(resolved.source, 'TENANT');
  assert.equal(resolved.reason, 'LOCATION_CONFIG');
  assert.equal(resolved.hppToken, 'lax-hpp-token', 'the saved token survived the blank round-trip');
  assert.equal(resolved.apiKey, 'lax-api');
  assert.equal(resolved.secretKey, 'lax-sec');
});

test('a payload with NO ipos.locations key leaves the stored entries alone', async () => {
  const scope = { tenantId: TENANT.id };
  tenantRows.set(TENANT.id, { name: TENANT.name });
  await settingsService.updatePaymentGatewayConfig({
    gateway: 'ipos',
    ipos: {
      enabled: true,
      locations: [{ locationId: LOC_LAX, tpn: '441900002071', hppToken: 'lax-hpp-token' }],
    },
  }, scope);

  // An older client saves the ipos block without knowing about locations.
  await settingsService.updatePaymentGatewayConfig({
    gateway: 'ipos',
    ipos: { enabled: true, tpn: '', hppToken: '' },
  }, scope);

  const resolved = await resolveTenantHppConfig(TENANT.id, { locationId: LOC_LAX });
  assert.equal(resolved.hppToken, 'lax-hpp-token', 'the branch\'s links survived a partial save');
});

// ===========================================================================
// 7. AUDIT — booleans, ids and masked TPNs. Never a credential.
// ===========================================================================

test('audit metadata for a register save carries no secret', () => {
  const cfg = {
    gateway: 'spin',
    spin: { enabled: true, tpn: LEGACY.tpn, hasAuthKey: true },
    registers: [
      { id: REG_LAX.id, name: REG_LAX.name, locationId: LOC_LAX, tpn: REG_LAX.tpn, hasAuthKey: true, enabled: true },
      { id: REG_MCO.id, name: REG_MCO.name, locationId: LOC_MCO, tpn: REG_MCO.tpn, hasAuthKey: false, enabled: false },
    ],
  };
  const body = {
    spin: {},
    registers: [
      { id: REG_LAX.id, authKey: REG_LAX.authKey },
      { id: REG_MCO.id, clearAuthKey: true },
    ],
  };
  const meta = buildTerminalAuditMetadata(cfg, body, TENANT.id);

  assert.equal(meta.registerCount, 2);
  assert.equal(meta.registers[0].id, REG_LAX.id);
  assert.equal(meta.registers[0].name, REG_LAX.name);
  assert.equal(meta.registers[0].locationId, LOC_LAX);
  assert.equal(meta.registers[0].tpnMasked, maskTpn(REG_LAX.tpn));
  assert.equal(meta.registers[0].authKeyOnFile, true);
  assert.equal(meta.registers[0].authKeyReplaced, true, 'that a key was supplied is auditable; the key is not');
  assert.equal(meta.registers[1].enabled, false);
  assert.equal(meta.registers[1].authKeyCleared, true);

  const serialized = JSON.stringify(meta);
  assert.ok(!serialized.includes(REG_LAX.authKey), 'no register key may reach the audit trail');
  assert.ok(!serialized.includes(REG_MCO.authKey));
  assert.ok(!serialized.includes(REG_LAX.tpn), 'and the raw TPN is masked, not printed');
});

test('audit metadata is unchanged in shape for a tenant with no registers', () => {
  const meta = buildTerminalAuditMetadata(
    { gateway: 'spin', spin: { enabled: true, tpn: LEGACY.tpn, hasAuthKey: true } },
    { spin: { authKey: LEGACY.authKey } },
    OTHER.id,
  );
  assert.equal(meta.spinTpnMasked, maskTpn(LEGACY.tpn));
  assert.equal(meta.spinAuthKeyReplaced, true);
  assert.equal(meta.registerCount, 0);
  assert.deepEqual(meta.registers, []);
  assert.ok(!JSON.stringify(meta).includes(LEGACY.authKey));
});

// ===========================================================================
// 8. CACHE — registers ride the same row, so the same invalidation
// ===========================================================================

test('registers are served from the SAME cached row — no second read per tap', async () => {
  seed(TENANT, { registers: [storedRegister(REG_LAX), storedRegister(REG_MCO)] });
  await resolveTenantTerminalConfig(TENANT.id, { locationId: LOC_LAX });
  const afterFirst = dbReads.appSetting;
  assert.ok(afterFirst >= 1);
  await resolveTenantTerminalConfig(TENANT.id, { locationId: LOC_MCO });
  await resolveTenantTerminalConfig(TENANT.id, { locationId: LOC_LAX });
  assert.equal(dbReads.appSetting, afterFirst,
    'a different location must not cost another query — one row holds them all');
});

test('saving a register invalidates the cache immediately — the next charge uses the new TPN', async () => {
  const scope = { tenantId: TENANT.id };
  seed(TENANT, { registers: [storedRegister(REG_LAX)] });
  const before = await resolveTenantTerminalConfig(TENANT.id, { locationId: LOC_LAX });
  assert.equal(before.tpn, REG_LAX.tpn);

  await settingsService.updatePaymentGatewayConfig({
    gateway: 'spin',
    registers: [{ id: REG_LAX.id, name: REG_LAX.name, locationId: LOC_LAX, tpn: '123412341234', authKey: '' }],
  }, scope);

  const after = await resolveTenantTerminalConfig(TENANT.id, { locationId: LOC_LAX });
  assert.equal(after.tpn, '123412341234', 'no TTL wait — a stale terminal is a support call at the counter');
  assert.equal(after.authKey, REG_LAX.authKey, 'and blank-means-keep held across the edit');
});

test('adding a register for the missing branch turns the refusal into a charge', async () => {
  // The end-to-end story: Miami fails closed, an admin adds its register, and
  // the very next resolution succeeds — without a restart or a TTL wait.
  const scope = { tenantId: TENANT.id };
  seed(TENANT, { registers: [storedRegister(REG_LAX)] });

  const before = await resolveTenantTerminalConfig(TENANT.id, { locationId: LOC_MIA });
  assert.equal(before.reason, 'NO_REGISTER_FOR_LOCATION');

  await settingsService.updatePaymentGatewayConfig({
    gateway: 'spin',
    registers: [
      { id: REG_LAX.id, name: REG_LAX.name, locationId: LOC_LAX, tpn: REG_LAX.tpn, authKey: '' },
      { name: 'Miami Counter', locationId: LOC_MIA, tpn: '661900004090', authKey: 'mia-key-DD' },
    ],
  }, scope);

  const after = await resolveTenantTerminalConfig(TENANT.id, { locationId: LOC_MIA });
  assert.equal(after.source, 'TENANT');
  assert.equal(after.reason, 'REGISTER_MATCH');
  assert.equal(after.tpn, '661900004090');
  // …and LAX still answers with its own.
  const lax = await resolveTenantTerminalConfig(TENANT.id, { locationId: LOC_LAX });
  assert.equal(lax.tpn, REG_LAX.tpn);
});

// ===========================================================================
// 9. WHAT REACHES THE SPIN CLIENT
// ===========================================================================

test('toSpinClientConfig carries the RESOLVED register\'s credentials, not the tenant block\'s', async () => {
  seed(TENANT, { spin: legacySpin(), registers: [storedRegister(REG_MCO)] });

  const cfg = toSpinClientConfig(await resolveTenantTerminalConfig(TENANT.id, { locationId: LOC_MCO }));
  assert.equal(cfg.spinTpn, REG_MCO.tpn);
  assert.equal(cfg.spinAuthKey, REG_MCO.authKey);
  assert.notEqual(cfg.spinTpn, LEGACY.tpn);
});

test('a register inherits the tenant block\'s callback + timeout when it sets none of its own', async () => {
  // Deployment plumbing, not merchant identity — an operator adding a second
  // counter should not have to retype the callback URL, and getting it wrong
  // there is its own outage.
  seed(TENANT, {
    spin: legacySpin(),
    registers: [{ ...storedRegister(REG_LAX), callbackUrl: '', proxyTimeout: '' }],
  });

  const resolved = await resolveTenantTerminalConfig(TENANT.id, { locationId: LOC_LAX });
  assert.equal(resolved.callbackUrl, 'https://legacy.example/callback');
  assert.equal(resolved.proxyTimeout, '90');
  assert.equal(resolved.tpn, REG_LAX.tpn, 'but the credentials are still the register\'s own');
});

test('a register\'s OWN callback + timeout win when it sets them', async () => {
  seed(TENANT, {
    spin: legacySpin(),
    registers: [{ ...storedRegister(REG_LAX), callbackUrl: 'https://lax.example/cb', proxyTimeout: '45' }],
  });

  const resolved = await resolveTenantTerminalConfig(TENANT.id, { locationId: LOC_LAX });
  assert.equal(resolved.callbackUrl, 'https://lax.example/cb');
  assert.equal(resolved.proxyTimeout, '45');
});


// ===========================================================================
// 8. PROMOTE — moving the legacy single terminal INTO a register (2026-09-06)
//
// The migration a tenant makes right before opening its second counter. Doing
// it by hand means re-typing a write-only Auth Key; the risk is not typing it
// wrong, it is the ORDER: the moment any register is enabled, a location with
// no register is refused rather than served by the legacy block, so the
// terminal already in use has to become a register FIRST.
// ===========================================================================

test('promote carries the stored credential into the register — no re-typing, same charges', async () => {
  const scope = { tenantId: TENANT.id };
  seed(TENANT, { spin: legacySpin() });

  const out = await settingsService.promoteSpinTerminalToRegister({ locationId: LOC_LAX }, scope);

  assert.equal(out.promoted.locationId, LOC_LAX);
  assert.match(out.promoted.maskedTpn, /\*/, 'the caller is told which TPN moved, masked');
  assert.ok(!JSON.stringify(out).includes(LEGACY.authKey), 'the credential never travels back');

  // The point of the whole exercise: the counter charges through the SAME
  // merchant it did a moment ago, now resolved BY LOCATION.
  const resolved = await resolveTenantTerminalConfig(TENANT.id, { locationId: LOC_LAX });
  assert.equal(resolved.reason, 'REGISTER_MATCH');
  assert.equal(resolved.tpn, LEGACY.tpn);
  assert.equal(resolved.authKey, LEGACY.authKey, 'the moved key still decrypts');
  assert.equal(resolved.callbackUrl, 'https://legacy.example/callback', 'deployment plumbing came along');
  assert.equal(resolved.proxyTimeout, '90');

  // At rest it is ciphertext, and the read path still never returns it.
  const stored = JSON.parse(settingRows.get(terminalConfigSettingKey(TENANT.id)));
  assert.ok(isSettingSecretEncrypted(stored.registers[0].authKey));
  assert.equal(out.config.registers[0].authKey, '');
  assert.equal(out.config.registers[0].hasAuthKey, true);
});

test('THE ORDERING CASE: after promoting, adding the second counter leaves the first one charging', async () => {
  const scope = { tenantId: TENANT.id };
  seed(TENANT, { spin: legacySpin() });
  await settingsService.promoteSpinTerminalToRegister({ locationId: LOC_LAX }, scope);

  // Now Orlando opens. Its register is added the ordinary way, with its own key.
  const promoted = (await settingsService.getPaymentGatewayConfig(scope)).registers[0];
  await settingsService.updatePaymentGatewayConfig({
    gateway: 'spin',
    // The settings form posts the whole config back, blanks and all.
    spin: { enabled: true, environment: 'production', authKey: '', tpn: LEGACY.tpn },
    registers: [
      { id: promoted.id, name: promoted.name, locationId: LOC_LAX, tpn: LEGACY.tpn, authKey: '' },
      { name: REG_MCO.name, locationId: LOC_MCO, tpn: REG_MCO.tpn, authKey: REG_MCO.authKey },
    ],
  }, scope);

  const lax = await resolveTenantTerminalConfig(TENANT.id, { locationId: LOC_LAX });
  const mco = await resolveTenantTerminalConfig(TENANT.id, { locationId: LOC_MCO });
  assert.equal(lax.tpn, LEGACY.tpn, 'the original counter never stopped charging');
  assert.equal(lax.authKey, LEGACY.authKey, 'and its key survived the blank round-trip');
  assert.equal(mco.tpn, REG_MCO.tpn);
  assert.notEqual(lax.tpn, mco.tpn);
});

test('the legacy block is LEFT INTACT, so disabling the register rolls back with no credential', async () => {
  const scope = { tenantId: TENANT.id };
  seed(TENANT, { spin: legacySpin() });
  await settingsService.promoteSpinTerminalToRegister({ locationId: LOC_LAX }, scope);

  const promoted = (await settingsService.getPaymentGatewayConfig(scope)).registers[0];
  await settingsService.updatePaymentGatewayConfig({
    gateway: 'spin',
    spin: { enabled: true, environment: 'production', authKey: '', tpn: LEGACY.tpn },
    registers: [{ id: promoted.id, name: promoted.name, locationId: LOC_LAX, tpn: LEGACY.tpn, authKey: '', enabled: false }],
  }, scope);

  const resolved = await resolveTenantTerminalConfig(TENANT.id, { locationId: LOC_LAX });
  assert.equal(resolved.reason, 'TENANT_CONFIG', 'every register disabled → the single terminal governs again');
  assert.equal(resolved.authKey, LEGACY.authKey);
});

test('promote refuses a location that belongs to ANOTHER tenant', async () => {
  seed(TENANT, { spin: legacySpin() });
  await assert.rejects(
    () => settingsService.promoteSpinTerminalToRegister({ locationId: 'loc-other-tenant' }, { tenantId: TENANT.id }),
    (err) => err.code === 'LOCATION_NOT_FOUND',
  );
  const stored = JSON.parse(settingRows.get(terminalConfigSettingKey(TENANT.id)));
  assert.equal((stored.registers || []).length, 0, 'nothing was written');
});

test('promote refuses without a location, with no terminal to move, and when already promoted', async () => {
  const scope = { tenantId: TENANT.id };

  seed(TENANT, { spin: legacySpin() });
  await assert.rejects(
    () => settingsService.promoteSpinTerminalToRegister({}, scope),
    (err) => err.code === 'LOCATION_REQUIRED',
  );

  // Half-configured legacy block: an Auth Key with no TPN is not a terminal.
  seed(TENANT, { spin: { ...legacySpin(), tpn: '' } });
  invalidateTenantTerminalConfig(TENANT.id);
  await assert.rejects(
    () => settingsService.promoteSpinTerminalToRegister({ locationId: LOC_LAX }, scope),
    (err) => err.code === 'NO_LEGACY_TERMINAL',
  );

  // Same TPN already in a register — one device, registered twice, is 2005.
  seed(TENANT, { spin: legacySpin(), registers: [storedRegister({ ...REG_LAX, tpn: LEGACY.tpn })] });
  invalidateTenantTerminalConfig(TENANT.id);
  await assert.rejects(
    () => settingsService.promoteSpinTerminalToRegister({ locationId: LOC_LAX }, scope),
    (err) => err.code === 'ALREADY_PROMOTED',
  );
});


// ===========================================================================
// 9. THE AUTH KEY'S SHAPE (2026-09-07)
//
// The gateway's own rule: "The field Authkey must be a string with a minimum
// length of 10 and a maximum length of 10." It enforces it on every POST and
// NOT on the TerminalStatus GET, so a wrong-length key reads as a healthy
// terminal that refuses to charge. It has cost twice — IRC ten days of manual
// entries, LAX an evening — so the save refuses it while the operator still
// has the portal open.
// ===========================================================================

test('a supplied Auth Key of the wrong length is refused — on the tenant block and per register', async () => {
  const scope = { tenantId: TENANT.id };
  tenantRows.set(TENANT.id, { name: TENANT.name });

  // 12 characters: the exact shape that broke IRC and LAX.
  await assert.rejects(
    () => settingsService.updatePaymentGatewayConfig({
      gateway: 'spin',
      spin: { enabled: true, environment: 'production', authKey: 'abcd1234efgh', tpn: LEGACY.tpn },
    }, scope),
    (err) => err.code === 'INVALID_SPIN_AUTH_KEY' && /12 characters/.test(err.message),
  );

  await assert.rejects(
    () => settingsService.updatePaymentGatewayConfig({
      gateway: 'spin',
      registers: [{ name: 'LAX Counter 1', locationId: LOC_LAX, tpn: REG_LAX.tpn, authKey: 'way-too-long-to-be-a-key' }],
    }, scope),
    (err) => err.code === 'INVALID_SPIN_AUTH_KEY' && /LAX Counter 1/.test(err.message),
  );

  assert.equal(settingRows.get(terminalConfigSettingKey(TENANT.id)), undefined, 'nothing was written');
});

test('a ten-character key saves, and blank-means-keep is never re-validated', async () => {
  const scope = { tenantId: TENANT.id };
  tenantRows.set(TENANT.id, { name: TENANT.name });

  await settingsService.updatePaymentGatewayConfig({
    gateway: 'spin',
    registers: [{ name: REG_LAX.name, locationId: LOC_LAX, tpn: REG_LAX.tpn, authKey: 'AbC123dEf4' }],
  }, scope);
  const resolved = await resolveTenantTerminalConfig(TENANT.id, { locationId: LOC_LAX });
  assert.equal(resolved.authKey, 'AbC123dEf4');

  // A form round-trip sends a BLANK key; carrying stored bytes must not be
  // re-checked, or a tenant whose stored key is legacy-shaped could never save
  // anything again — including the fix.
  const saved = (await settingsService.getPaymentGatewayConfig(scope)).registers[0];
  await settingsService.updatePaymentGatewayConfig({
    gateway: 'spin',
    registers: [{ id: saved.id, name: 'Renamed', locationId: LOC_LAX, tpn: REG_LAX.tpn, authKey: '' }],
  }, scope);
  const after = await resolveTenantTerminalConfig(TENANT.id, { locationId: LOC_LAX });
  assert.equal(after.authKey, 'AbC123dEf4', 'the stored key survived');
  assert.equal(after.registerName, 'Renamed');
});

test('spinAuthKeyShape reports length and class without judging anything else', () => {
  assert.deepEqual(spinAuthKeyShape('AbC123dEf4'), { length: 10, lengthOk: true, alphanumeric: true });
  assert.equal(spinAuthKeyShape('abcd1234efgh').lengthOk, false);
  assert.equal(spinAuthKeyShape('ab-123-cd4').alphanumeric, false);
  // Ten characters with punctuation still passes: the gateway asserts LENGTH,
  // and guessing a stricter rule would refuse a credential that works.
  assert.equal(spinAuthKeyShape('ab-123-cd4').lengthOk, true);
  assert.equal(spinAuthKeyShape('').length, 0);
});

test('promote reports the shape of the key it carried, and carries it either way', async () => {
  const scope = { tenantId: TENANT.id };
  // A legacy block holding the wrong-length key — LAX at 01:19 on 2026-09-07.
  seed(TENANT, { spin: { ...legacySpin(), authKey: encryptSettingSecret('abcd1234efgh') } });

  const out = await settingsService.promoteSpinTerminalToRegister({ locationId: LOC_LAX }, scope);
  assert.equal(out.promoted.authKeyShapeOk, false);
  assert.equal(out.promoted.authKeyLength, 12);
  assert.match(out.promoted.authKeyWarning, /exactly 10/);
  // It still moved: refusing would block a migration whose bytes are usually
  // fine, and the operator is told rather than stopped.
  const resolved = await resolveTenantTerminalConfig(TENANT.id, { locationId: LOC_LAX });
  assert.equal(resolved.reason, 'REGISTER_MATCH');
  assert.equal(resolved.authKey, 'abcd1234efgh');
  assert.ok(!JSON.stringify(out).includes('abcd1234efgh'), 'the key itself never travels back');
});
