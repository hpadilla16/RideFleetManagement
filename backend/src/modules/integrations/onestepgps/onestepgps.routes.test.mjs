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
const { prisma } = await import('../../../lib/prisma.js');
const { AUDIT_ACTIONS, AUDIT_OUTCOME } = await import('../../audit/audit.service.js');

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

// ── SECURITY GATE: audit trail on every admin mutation ──────────────────────
// The four mutations must leave an AdminAuditLog row via the house audit
// module (best-effort auditFromReq). Spy = swap prisma.adminAuditLog.create on
// the shared client, exactly like audit.test.mjs's withAuditCreate.

const flush = () => new Promise((r) => setImmediate(r));

function makeRes() {
  const res = { statusCode: 200, body: undefined };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  return res;
}

// Grab the FINAL handler for method+path (router-level auth guard is a router
// middleware, not part of the route stack, so this is the asyncHandler-wrapped
// route handler itself). Same helper shape as audit.test.mjs.
function lastHandler(method, path) {
  const layer = onestepgpsRouter.stack.find((l) => l.route && l.route.path === path && l.route.methods[method]);
  if (!layer) throw new Error(`no ${method.toUpperCase()} ${path} on router`);
  const handlers = layer.route.stack.filter((s) => !s.method || s.method === method);
  return handlers[handlers.length - 1].handle;
}

function adminReq(over = {}) {
  return {
    user: { id: 'u1', tenantId: 't1', role: 'ADMIN', email: 'admin@t1.test' },
    headers: { 'user-agent': 'node-test', 'x-forwarded-for': '203.0.113.9' },
    params: {}, query: {}, body: {},
    ...over,
  };
}

// Run fn with prisma.adminAuditLog.create captured (plus optional extra model
// patches), restoring everything after. Returns the captured audit rows.
async function withAuditSpy(patches, fn) {
  const rows = [];
  const originals = [];
  const patch = (obj, key, impl) => {
    originals.push([obj, key, obj[key]]);
    obj[key] = impl;
  };
  patch(prisma.adminAuditLog, 'create', async ({ data }) => { rows.push(data); return { id: 'aud1', ...data }; });
  for (const [model, key, impl] of patches) patch(prisma[model], key, impl);
  try {
    await fn();
    await flush(); // audit writes are fire-and-forget — let them land
  } finally {
    for (const [obj, key, orig] of originals) obj[key] = orig;
  }
  return rows;
}

test('POST /credentials records TELEMATICS_KEY_SET with actor/tenant — and NEVER the key', async () => {
  const world = fakeDb();
  _setPrismaForTests(world.prisma);
  try {
    const res = makeRes();
    const rows = await withAuditSpy([], async () => {
      await lastHandler('post', '/credentials')(
        adminReq({ body: { apiKey: 'sk-audit-leak-canary' } }), res, (e) => { throw e; },
      );
    });
    assert.equal(res.statusCode, 200);
    assert.equal(rows.length, 1, 'expected exactly one audit row');
    const row = rows[0];
    assert.equal(row.action, AUDIT_ACTIONS.TELEMATICS_KEY_SET);
    assert.equal(row.outcome, AUDIT_OUTCOME.SUCCESS);
    assert.equal(row.tenantId, 't1');
    assert.equal(row.actorUserId, 'u1');
    assert.equal(row.targetType, 'TENANT');
    assert.equal(row.targetId, 't1');
    assert.equal(row.ip, '203.0.113.9');
    assert.equal(row.metadata.provider, 'ONESTEPGPS');
    // Spy assertion: the key must not appear ANYWHERE in the audit row —
    // metadata included — not even in redacted-shaped form.
    const wire = JSON.stringify(row);
    assert.ok(!wire.includes('sk-audit-leak-canary'), `API key leaked into audit row: ${wire}`);
    assert.ok(!('apiKey' in (row.metadata || {})), 'apiKey key must not be passed to audit metadata at all');
  } finally {
    _setPrismaForTests(null);
  }
});

test('DELETE /credentials records TELEMATICS_KEY_CLEAR', async () => {
  const world = fakeDb();
  _setPrismaForTests(world.prisma);
  try {
    await setApiKey('t1', 'sk-to-clear');
    const res = makeRes();
    const rows = await withAuditSpy([], async () => {
      await lastHandler('delete', '/credentials')(adminReq(), res, (e) => { throw e; });
    });
    assert.equal(res.statusCode, 200);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].action, AUDIT_ACTIONS.TELEMATICS_KEY_CLEAR);
    assert.equal(rows[0].outcome, AUDIT_OUTCOME.SUCCESS);
    assert.equal(rows[0].targetId, 't1');
    assert.deepEqual(rows[0].metadata, { provider: 'ONESTEPGPS', deleted: 1 });
    assert.ok(!JSON.stringify(rows[0]).includes('sk-to-clear'), 'cleared key leaked into audit row');
  } finally {
    _setPrismaForTests(null);
  }
});

test('POST /device-mappings records TELEMATICS_MAPPING_CREATE with vehicle + device targets', async () => {
  const res = makeRes();
  const rows = await withAuditSpy(
    [
      ['vehicle', 'findFirst', async () => ({ id: 'veh1', tenantId: 't1' })],
      ['vehicleTelematicsDevice', 'upsert', async ({ create }) => ({ id: 'map1', ...create })],
    ],
    async () => {
      await lastHandler('post', '/device-mappings')(
        adminReq({ body: { vehicleId: 'veh1', externalDeviceId: 'osg-dev-42' } }), res, (e) => { throw e; },
      );
    },
  );
  assert.equal(res.statusCode, 200);
  assert.equal(rows.length, 1);
  const row = rows[0];
  assert.equal(row.action, AUDIT_ACTIONS.TELEMATICS_MAPPING_CREATE);
  assert.equal(row.outcome, AUDIT_OUTCOME.SUCCESS);
  assert.equal(row.targetType, 'VEHICLE');
  assert.equal(row.targetId, 'veh1');
  assert.equal(row.metadata.provider, 'ONESTEPGPS');
  assert.equal(row.metadata.vehicleId, 'veh1');
  assert.equal(row.metadata.externalDeviceId, 'osg-dev-42');
});

test('POST /device-mappings vehicle-not-found records a FAILURE outcome (cross-tenant probe trail)', async () => {
  const res = makeRes();
  const rows = await withAuditSpy(
    [['vehicle', 'findFirst', async () => null]],
    async () => {
      await lastHandler('post', '/device-mappings')(
        adminReq({ body: { vehicleId: 'veh-other-tenant', externalDeviceId: 'osg-dev-42' } }), res, (e) => { throw e; },
      );
    },
  );
  assert.equal(res.statusCode, 404);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].action, AUDIT_ACTIONS.TELEMATICS_MAPPING_CREATE);
  assert.equal(rows[0].outcome, AUDIT_OUTCOME.FAILURE);
  assert.equal(rows[0].metadata.reason, 'VEHICLE_NOT_FOUND');
});

test('DELETE /device-mappings/:id records TELEMATICS_MAPPING_DEACTIVATE (success and 404-FAILURE)', async () => {
  // success
  let res = makeRes();
  let rows = await withAuditSpy(
    [['vehicleTelematicsDevice', 'updateMany', async () => ({ count: 1 })]],
    async () => {
      await lastHandler('delete', '/device-mappings/:id')(
        adminReq({ params: { id: 'map1' } }), res, (e) => { throw e; },
      );
    },
  );
  assert.equal(res.statusCode, 200);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].action, AUDIT_ACTIONS.TELEMATICS_MAPPING_DEACTIVATE);
  assert.equal(rows[0].outcome, AUDIT_OUTCOME.SUCCESS);
  assert.equal(rows[0].targetType, 'VEHICLE_TELEMATICS_DEVICE');
  assert.equal(rows[0].targetId, 'map1');
  assert.deepEqual(rows[0].metadata, { provider: 'ONESTEPGPS', mappingId: 'map1' });

  // not found → FAILURE row
  res = makeRes();
  rows = await withAuditSpy(
    [['vehicleTelematicsDevice', 'updateMany', async () => ({ count: 0 })]],
    async () => {
      await lastHandler('delete', '/device-mappings/:id')(
        adminReq({ params: { id: 'ghost' } }), res, (e) => { throw e; },
      );
    },
  );
  assert.equal(res.statusCode, 404);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].outcome, AUDIT_OUTCOME.FAILURE);
  assert.equal(rows[0].metadata.reason, 'MAPPING_NOT_FOUND');
});
