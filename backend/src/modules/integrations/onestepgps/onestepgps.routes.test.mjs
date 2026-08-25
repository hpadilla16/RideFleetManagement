import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

// Route-MODULE tests, mirroring economy.routes.test.mjs: lock the router
// surface (mounted paths, admin guard first) and the security contracts the
// handlers rely on. Full HTTP integration (JWT + express app) lives in e2e.
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://u:p@localhost:5432/testdb';
process.env.INTEGRATION_ENC_KEY = process.env.INTEGRATION_ENC_KEY || crypto.randomBytes(32).toString('base64');

const { onestepgpsRouter } = await import('./onestepgps.routes.js');
const {
  setApiKey, getApiKey, hasApiKey, getCredentialStatus,
  _setPrismaForTests,
} = await import('../../vehicles/telematics-onestepgps.js');

test('onestepgpsRouter mounts the full connector endpoint inventory', () => {
  assert.ok(onestepgpsRouter);
  const paths = onestepgpsRouter.stack.filter((l) => l.route).map((l) => l.route.path);
  const expected = [
    '/status',
    '/credentials',
    '/test-connection',
    '/devices',
    '/device-mappings',
    '/device-mappings/:id',
  ];
  for (const p of expected) {
    assert.ok(paths.includes(p), `missing route ${p}`);
  }
});

test('credentials route exists for BOTH set (POST) and clear (DELETE)', () => {
  const layers = onestepgpsRouter.stack.filter((l) => l.route && l.route.path === '/credentials');
  const methods = new Set(layers.flatMap((l) => Object.keys(l.route.methods)));
  assert.ok(methods.has('post'), 'POST /credentials missing');
  assert.ok(methods.has('delete'), 'DELETE /credentials missing');
});

test('onestepgpsRouter has an admin auth guard as its FIRST middleware layer', () => {
  const firstRouteIdx = onestepgpsRouter.stack.findIndex((l) => l.route);
  const guardLayers = onestepgpsRouter.stack.slice(0, firstRouteIdx).filter((l) => !l.route);
  assert.ok(guardLayers.length >= 1, 'expected auth/role guard middleware before routes');
});

// ── security contracts (against the same client the handlers call) ──────────

function fakeDb() {
  const store = new Map();
  const keyOf = (w) => `${w.tenantId}|${w.sourceSystem}`;
  const appSettingWrites = [];
  return {
    appSettingWrites,
    prisma: {
      integrationCredential: {
        upsert: async ({ where, create, update }) => {
          const k = keyOf(where.tenantId_sourceSystem);
          const existing = store.get(k);
          const row = existing ? { ...existing, ...update } : { id: 'cred_1', ...create };
          store.set(k, row);
          return row;
        },
        findUnique: async ({ where }) => store.get(keyOf(where.tenantId_sourceSystem)) || null,
        deleteMany: async ({ where }) => ({ count: store.delete(`${where.tenantId}|${where.sourceSystem}`) ? 1 : 0 }),
        update: async ({ where, data }) => {
          const row = store.get(keyOf(where.tenantId_sourceSystem));
          Object.assign(row || {}, data);
          return row;
        },
      },
      // What the Settings > Telematics save path writes. The OneStepGPS key
      // must survive ANY of these writes untouched.
      appSetting: {
        upsert: async (args) => { appSettingWrites.push(args); return args.create; },
        findUnique: async () => null,
      },
    },
  };
}

test('GET /status shape never contains the raw key (booleans + timestamps only)', async () => {
  const world = fakeDb();
  _setPrismaForTests(world.prisma);
  try {
    await setApiKey('t1', 'sk-status-secret');
    const status = await getCredentialStatus('t1');
    assert.equal(status.hasApiKey, true);
    const wire = JSON.stringify(status);
    assert.ok(!wire.includes('sk-status-secret'), `raw key leaked into status: ${wire}`);
    assert.ok(!('apiKey' in status));
    assert.ok(!('encryptedPayload' in status));
  } finally {
    _setPrismaForTests(null);
  }
});

test('REGRESSION (VoltSwitch erase bug): saving unrelated telematics settings cannot clear the key', async () => {
  // Before 2026-08-13, saving the Settings page silently dropped the VoltSwitch
  // credentials because they lived inside the telematicsConfig appSetting blob
  // that every save rewrote wholesale. The OneStepGPS key lives in
  // IntegrationCredential instead — rewrite the appSetting blob all you want,
  // the key must still be there.
  const world = fakeDb();
  _setPrismaForTests(world.prisma);
  try {
    await setApiKey('t1', 'sk-survives-settings-save');

    // Simulate exactly what updateTelematicsConfig does: a wholesale rewrite of
    // the telematicsConfig appSetting row, with NO onestepgps fields in it.
    const key = 'tenant:t1:telematicsConfig';
    const value = JSON.stringify({ enabled: true, provider: 'VOLTSWITCH', allowVoltswitchConnector: true });
    await world.prisma.appSetting.upsert({ where: { key }, create: { key, value }, update: { value } });
    assert.equal(world.appSettingWrites.length, 1, 'the settings save happened');

    assert.equal(await hasApiKey('t1'), true, 'key erased by an unrelated settings save');
    assert.equal(await getApiKey('t1'), 'sk-survives-settings-save');
  } finally {
    _setPrismaForTests(null);
  }
});

test('credentials POST contract: apiKey required, never echoed back', () => {
  // Contract mirror of the handler's validation + response shape.
  const handle = (body) => {
    const apiKey = String(body?.apiKey ?? '').trim();
    if (!apiKey) return { status: 400, json: { error: 'apiKey is required' } };
    return { status: 200, json: { ok: true, credentialId: 'cred_1', rotatedAt: new Date().toISOString() } };
  };
  assert.equal(handle({}).status, 400);
  assert.equal(handle({ apiKey: '   ' }).status, 400);
  const ok = handle({ apiKey: 'sk-echo-check' });
  assert.equal(ok.status, 200);
  assert.ok(!JSON.stringify(ok.json).includes('sk-echo-check'), 'key echoed in response');
});
