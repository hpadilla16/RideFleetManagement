/**
 * The wizard's terminal picker — service-level rules (2026-09-04).
 *
 * A pickup location can run more than one Dejavoo device. The pick is stored
 * on the CheckoutSession and every terminal op of the session reads it. What
 * these tests pin is the guard rail, not the plumbing:
 *
 *   • a register from ANOTHER location is refused at selection time — the
 *     resolver refuses it again at charge time (REGISTER_LOCATION_MISMATCH,
 *     terminal-registers.test.mjs), so the wrong-device path is closed twice;
 *   • a half-configured register cannot be picked;
 *   • the selector only offers a real choice (`selectable`), so legacy
 *     single-terminal tenants render nothing;
 *   • the pick lands on the column AND in the events log, and clearing works.
 */
import '../../lib/_two-factor-test-env.mjs'; // MUST be first — env before prisma.js constructs

import test, { beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { prisma } from '../../lib/prisma.js';
import { cache } from '../../lib/cache.js';
import { encryptSettingSecret } from '../../lib/setting-secret-crypto.js';
import { _resetKeyCacheForTests } from '../../lib/integration-crypto.js';
import { terminalConfigSettingKey } from '../payment-gateway/tenant-terminal-config.js';
import { checkoutSessionService } from './checkout-session.service.js';

const TENANT = { id: 'tenant-corpusa', name: 'Corpusa Rentals' };
const LOC_LAX = 'loc-lax';
const LOC_MCO = 'loc-mco';

const REG_LAX = { id: 'reg-lax-1', name: 'LAX Counter 1', locationId: LOC_LAX, tpn: '441900002071', authKey: 'lax-key-AA' };
const REG_LAX2 = { id: 'reg-lax-2', name: 'LAX Counter 2', locationId: LOC_LAX, tpn: '441900002072', authKey: 'lax2-key-BB' };
const REG_MCO = { id: 'reg-mco-1', name: 'Orlando Counter', locationId: LOC_MCO, tpn: '551900003080', authKey: 'mco-key-CC' };

let settingRows;
let sessionRow;
let savedPrisma;

function storedRegister(r, { enabled = true, extra = {} } = {}) {
  return {
    id: r.id, name: r.name, locationId: r.locationId, tpn: r.tpn,
    authKey: encryptSettingSecret(r.authKey),
    merchantNumber: '1', callbackUrl: '', proxyTimeout: '120', enabled,
    ...extra,
  };
}

function seedRegisters(registers) {
  settingRows.set(
    terminalConfigSettingKey(TENANT.id),
    JSON.stringify({ gateway: 'spin', registers }),
  );
}

function seedSession({ terminalRegisterId = null } = {}) {
  sessionRow = {
    id: 'cs1',
    events: '[]',
    stateVersion: 0,
    terminalRegisterId,
    reservation: { tenantId: TENANT.id, pickupLocationId: LOC_LAX },
  };
}

beforeEach(() => {
  settingRows = new Map();
  cache.clear();
  _resetKeyCacheForTests();
  seedSession();
  savedPrisma = {
    csFindUnique: prisma.checkoutSession.findUnique,
    csUpdate: prisma.checkoutSession.update,
    settingFindUnique: prisma.appSetting.findUnique,
    tenantFindUnique: prisma.tenant.findUnique,
  };
  prisma.checkoutSession.findUnique = async ({ where }) => (where?.id === 'cs1' ? { ...sessionRow } : null);
  prisma.checkoutSession.update = async ({ where, data }) => {
    assert.equal(where.id, 'cs1');
    if ('terminalRegisterId' in data) sessionRow.terminalRegisterId = data.terminalRegisterId;
    if (data.stateVersion?.increment) sessionRow.stateVersion += data.stateVersion.increment;
    if (data.events) sessionRow.events = data.events;
    return { ...sessionRow };
  };
  prisma.appSetting.findUnique = async ({ where }) => {
    const value = settingRows.get(where?.key);
    return value == null ? null : { key: where.key, value };
  };
  prisma.tenant.findUnique = async ({ where }) => (where?.id === TENANT.id ? { id: TENANT.id, name: TENANT.name } : null);
});

afterEach(() => {
  prisma.checkoutSession.findUnique = savedPrisma.csFindUnique;
  prisma.checkoutSession.update = savedPrisma.csUpdate;
  prisma.appSetting.findUnique = savedPrisma.settingFindUnique;
  prisma.tenant.findUnique = savedPrisma.tenantFindUnique;
});

test('options are scoped to the session\'s own counter, and selectable only with a real choice', async () => {
  seedRegisters([storedRegister(REG_LAX), storedRegister(REG_LAX2), storedRegister(REG_MCO)]);

  const out = await checkoutSessionService.getTerminalOptions({ id: 'cs1' });
  assert.equal(out.selectable, true);
  assert.deepEqual(out.options.map((o) => o.id), [REG_LAX.id, REG_LAX2.id], 'Orlando\'s device is not offered');
  assert.equal(out.selectedRegisterId, null);
  const flat = JSON.stringify(out);
  assert.ok(!flat.includes(REG_LAX.authKey) && !flat.includes(REG_LAX.tpn), 'no credential, no full TPN');

  // One register at the counter → nothing to choose.
  seedRegisters([storedRegister(REG_LAX), storedRegister(REG_MCO)]);
  cache.clear();
  const sole = await checkoutSessionService.getTerminalOptions({ id: 'cs1' });
  assert.equal(sole.selectable, false);

  // Legacy tenant (no registers at all) → selector renders nothing.
  settingRows.clear();
  cache.clear();
  const legacy = await checkoutSessionService.getTerminalOptions({ id: 'cs1' });
  assert.equal(legacy.hasRegisters, false);
  assert.equal(legacy.selectable, false);
});

test('a valid pick lands on the column and in the events log; clearing works', async () => {
  seedRegisters([storedRegister(REG_LAX), storedRegister(REG_LAX2)]);

  const out = await checkoutSessionService.selectTerminalRegister({ id: 'cs1', registerId: REG_LAX2.id, actorUserId: 'u1' });
  assert.equal(sessionRow.terminalRegisterId, REG_LAX2.id);
  assert.equal(out.selectedRegisterId, REG_LAX2.id);
  assert.equal(sessionRow.stateVersion, 1, 'material change bumps the version');

  const events = JSON.parse(sessionRow.events);
  const picked = events.find((e) => e.kind === 'TERMINAL_REGISTER_SELECTED');
  assert.ok(picked, 'the pick is on the record');
  assert.equal(picked.registerId, REG_LAX2.id);
  assert.ok(!JSON.stringify(picked).includes(REG_LAX2.tpn), 'the event carries a MASKED tpn only');

  await checkoutSessionService.selectTerminalRegister({ id: 'cs1', registerId: null, actorUserId: 'u1' });
  assert.equal(sessionRow.terminalRegisterId, null);
  assert.ok(JSON.parse(sessionRow.events).some((e) => e.kind === 'TERMINAL_REGISTER_CLEARED'));
});

test('another location\'s register is refused — the wrong-device path closes at selection time too', async () => {
  seedRegisters([storedRegister(REG_LAX), storedRegister(REG_LAX2), storedRegister(REG_MCO)]);

  await assert.rejects(
    () => checkoutSessionService.selectTerminalRegister({ id: 'cs1', registerId: REG_MCO.id }),
    (err) => err.code === 'REGISTER_NOT_AT_LOCATION',
  );
  assert.equal(sessionRow.terminalRegisterId, null, 'nothing was pinned');
});

test('a half-configured register cannot be picked', async () => {
  seedRegisters([
    storedRegister(REG_LAX),
    storedRegister({ ...REG_LAX2, authKey: '' }, { extra: { authKey: '' } }),
  ]);

  await assert.rejects(
    () => checkoutSessionService.selectTerminalRegister({ id: 'cs1', registerId: REG_LAX2.id }),
    (err) => err.code === 'INCOMPLETE_REGISTER',
  );
  assert.equal(sessionRow.terminalRegisterId, null);
});
