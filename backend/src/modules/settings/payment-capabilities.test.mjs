/**
 * GET /api/settings/payment-capabilities (2026-08-30, View Payments redesign).
 * Run via: npm run test:payment-capabilities
 *
 * The endpoint exists because the ONLY other read of paymentGatewayConfig
 * (GET /api/settings/payment-gateway) is ADMIN-gated and credential-bearing.
 * This suite pins the three properties that make the new one safe and useful:
 *
 *  1. NO CREDENTIAL LEAKAGE — a config saturated with secret material in every
 *     field must serialize to a response containing none of it, and the key
 *     set is a closed whitelist (no has* booleans beyond ipos.linkReady).
 *  2. GATEWAY TRUTH — ipos / authorizenet / unconfigured tenants each produce
 *     the gateway value the frontend gates on.
 *  3. TENANT SCOPING + MOUNT ORDER — the read uses the caller's tenant-scoped
 *     AppSetting key, and main.js mounts the route BEFORE the
 *     requireModuleAccess('settings') gate (OPS/AGENT have settings:false; a
 *     module-gated mount would 403 exactly the staff the endpoint exists for).
 *
 * DB-FREE: prisma.appSetting is monkeypatched per test (same technique as
 * checkout-payment-policy.test.mjs); the Prisma client never connects.
 */

// MUST be first — sets DATABASE_URL etc. before lib/prisma.js constructs.
import '../../lib/_two-factor-test-env.mjs';

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { prisma } from '../../lib/prisma.js';
import { settingsService, derivePaymentCapabilities } from './settings.service.js';
import { paymentCapabilitiesRouter } from './settings.routes.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Run fn with prisma.appSetting.findUnique returning `value` (raw string column) and recording keys read. */
async function withStoredValue(value, fn) {
  const orig = prisma.appSetting.findUnique;
  const reads = [];
  prisma.appSetting.findUnique = async ({ where } = {}) => {
    reads.push(String(where?.key || ''));
    return value === null ? null : { value };
  };
  try {
    return await fn(reads);
  } finally {
    prisma.appSetting.findUnique = orig;
  }
}

// A config where EVERY credential-shaped field carries a distinctive marker
// string. If any of these survive into the response, the endpoint leaks.
const SECRET_MARKERS = {
  loginId: 'LEAK-authnet-login-77xy',
  transactionKey: 'LEAK-authnet-txnkey-77xy',
  clientKey: 'LEAK-authnet-clientkey-77xy',
  signatureKey: 'LEAK-authnet-sigkey-77xy',
  stripeSecret: 'sk_live_LEAK77xy',
  stripePublishable: 'pk_live_LEAK77xy',
  stripeWebhook: 'whsec_LEAK77xy',
  squareToken: 'LEAK-square-token-77xy',
  spinAuthKey: 'enci:LEAK-spin-authkey-77xy',
  spinTpn: '224466880011',
  hppToken: 'enci:LEAK-ipos-hpp-77xy',
  iposApiKey: 'enci:LEAK-ipos-api-77xy',
  iposSecretKey: 'enci:LEAK-ipos-secret-77xy',
  payarcBearer: 'LEAK-payarc-bearer-77xy',
};

const IPOS_TENANT_CONFIG = JSON.stringify({
  gateway: 'ipos',
  label: 'IRC iPOS',
  autocharge: { mode: 'MANUAL', delayHours: 24 },
  authorizenet: { enabled: true, loginId: '', transactionKey: '' }, // enabled flag on, no creds — must NOT count as enabled
  spin: { enabled: true, authKey: SECRET_MARKERS.spinAuthKey, tpn: SECRET_MARKERS.spinTpn, merchantNumber: '1' },
  ipos: { enabled: true, hppToken: SECRET_MARKERS.hppToken, apiKey: SECRET_MARKERS.iposApiKey, secretKey: SECRET_MARKERS.iposSecretKey, tpn: '' },
  stripe: { enabled: false, secretKey: '' },
  square: { enabled: false },
  payarc: { enabled: false }
});

const AUTHNET_TENANT_CONFIG = JSON.stringify({
  gateway: 'authorizenet',
  autocharge: { mode: 'AUTO', delayHours: 24 },
  authorizenet: {
    enabled: true,
    loginId: SECRET_MARKERS.loginId,
    transactionKey: SECRET_MARKERS.transactionKey,
    clientKey: SECRET_MARKERS.clientKey,
    signatureKey: SECRET_MARKERS.signatureKey
  },
  stripe: { enabled: true, secretKey: SECRET_MARKERS.stripeSecret, publishableKey: SECRET_MARKERS.stripePublishable, webhookSecret: SECRET_MARKERS.stripeWebhook },
  square: { enabled: true, accessToken: SECRET_MARKERS.squareToken, locationId: 'L123' },
  spin: { enabled: false },
  ipos: { enabled: false },
  payarc: { enabled: true, bearerToken: SECRET_MARKERS.payarcBearer }
});

// ---------------------------------------------------------------------------
// 1. Gateway truth per tenant state
// ---------------------------------------------------------------------------

test('ipos tenant: gateway=ipos, spin/ipos on, authorizenet OFF despite enabled flag (no creds)', async () => {
  const caps = await withStoredValue(IPOS_TENANT_CONFIG, () =>
    settingsService.getPaymentCapabilities({ tenantId: 'irc' }));
  assert.equal(caps.gateway, 'ipos');
  assert.equal(caps.spin.enabled, true);
  assert.equal(caps.ipos.enabled, true);
  assert.equal(caps.ipos.linkReady, true, 'stored hppToken → linkReady');
  assert.equal(caps.authorizenet.enabled, false, 'enabled flag without loginId+transactionKey must read false');
  assert.equal(caps.stripe.enabled, false);
  assert.equal(caps.square.enabled, false);
  assert.equal(caps.payarc.enabled, false);
  assert.equal(caps.autocharge.mode, 'MANUAL');
});

test('authorizenet tenant: gateway=authorizenet, authorizenet enabled, ipos/spin off', async () => {
  const caps = await withStoredValue(AUTHNET_TENANT_CONFIG, () =>
    settingsService.getPaymentCapabilities({ tenantId: 't-an' }));
  assert.equal(caps.gateway, 'authorizenet');
  assert.equal(caps.authorizenet.enabled, true);
  assert.equal(caps.spin.enabled, false);
  assert.equal(caps.ipos.enabled, false);
  assert.equal(caps.ipos.linkReady, false);
  assert.equal(caps.stripe.enabled, true, 'stripe enabled + secretKey present');
  assert.equal(caps.square.enabled, true);
  assert.equal(caps.payarc.enabled, true);
  assert.equal(caps.autocharge.mode, 'AUTO');
});

test('unconfigured tenant (no AppSetting row): env-default gateway, nothing falsely enabled', async () => {
  // The test env sets none of the gateway env vars, so defaults resolve to
  // gateway 'authorizenet' with authorizenet.enabled=false (no env creds).
  const caps = await withStoredValue(null, () =>
    settingsService.getPaymentCapabilities({ tenantId: 't-new' }));
  assert.equal(caps.gateway, String(process.env.PAYMENT_GATEWAY || 'authorizenet').toLowerCase());
  assert.equal(caps.authorizenet.enabled, !!(process.env.AUTHNET_API_LOGIN_ID && process.env.AUTHNET_TRANSACTION_KEY));
  assert.equal(caps.spin.enabled, false);
  assert.equal(caps.ipos.enabled, false);
  assert.equal(caps.ipos.linkReady, false);
});

test('ipos enabled but NO hppToken stored: linkReady=false (send-link would fail closed)', async () => {
  const cfg = JSON.parse(IPOS_TENANT_CONFIG);
  cfg.ipos.hppToken = '';
  const caps = await withStoredValue(JSON.stringify(cfg), () =>
    settingsService.getPaymentCapabilities({ tenantId: 'irc' }));
  assert.equal(caps.ipos.enabled, true);
  assert.equal(caps.ipos.linkReady, false);
});

// ---------------------------------------------------------------------------
// 2. No credential leakage — closed key whitelist, no secret bytes
// ---------------------------------------------------------------------------

test('response NEVER contains credential material, even when every field is configured', async () => {
  for (const stored of [IPOS_TENANT_CONFIG, AUTHNET_TENANT_CONFIG]) {
    const caps = await withStoredValue(stored, () =>
      settingsService.getPaymentCapabilities({ tenantId: 't-leak' }));
    const serialized = JSON.stringify(caps);
    for (const [name, marker] of Object.entries(SECRET_MARKERS)) {
      assert.ok(!serialized.includes(marker), `secret '${name}' leaked into the capabilities response`);
    }
    // Belt and braces: no key anywhere in the tree smells like credential
    // material or a has* configuration probe (linkReady is the one derived
    // readiness boolean the page needs).
    const FORBIDDEN_KEY = /key|token|secret|tpn|login|password|credential/i;
    const walk = (node, trail) => {
      if (!node || typeof node !== 'object') return;
      for (const [k, v] of Object.entries(node)) {
        assert.ok(!FORBIDDEN_KEY.test(k), `forbidden key '${trail}${k}' in capabilities response`);
        assert.ok(!/^has[A-Z]/.test(k), `has* boolean '${trail}${k}' must not be exposed`);
        walk(v, `${trail}${k}.`);
      }
    };
    walk(caps, '');
  }
});

test('exact shape: closed whitelist of keys, booleans only (plus gateway string + autocharge mode)', async () => {
  const caps = await withStoredValue(IPOS_TENANT_CONFIG, () =>
    settingsService.getPaymentCapabilities({ tenantId: 't-shape' }));
  assert.deepEqual(Object.keys(caps).sort(), ['authorizenet', 'autocharge', 'gateway', 'ipos', 'payarc', 'spin', 'square', 'stripe']);
  assert.deepEqual(Object.keys(caps.authorizenet), ['enabled']);
  assert.deepEqual(Object.keys(caps.spin), ['enabled']);
  assert.deepEqual(Object.keys(caps.ipos).sort(), ['enabled', 'linkReady']);
  assert.deepEqual(Object.keys(caps.stripe), ['enabled']);
  assert.deepEqual(Object.keys(caps.square), ['enabled']);
  assert.deepEqual(Object.keys(caps.payarc), ['enabled']);
  assert.deepEqual(Object.keys(caps.autocharge), ['mode']);
  assert.equal(typeof caps.gateway, 'string');
  for (const block of ['authorizenet', 'spin', 'ipos', 'stripe', 'square', 'payarc']) {
    for (const v of Object.values(caps[block])) assert.equal(typeof v, 'boolean', `${block} values must be booleans`);
  }
});

test('derivePaymentCapabilities treats non-literal-true enabled flags as OFF', () => {
  for (const raw of ['true', 1, 'yes', {}, []]) {
    const caps = derivePaymentCapabilities({ gateway: 'ipos', spin: { enabled: raw }, ipos: { enabled: raw, hasHppToken: true } });
    assert.equal(caps.spin.enabled, false, `spin.enabled=${JSON.stringify(raw)} must be OFF`);
    assert.equal(caps.ipos.enabled, false);
    assert.equal(caps.ipos.linkReady, false);
  }
});

// ---------------------------------------------------------------------------
// 3. Tenant scoping + route wiring
// ---------------------------------------------------------------------------

test('reads the CALLER-tenant-scoped AppSetting key, never another tenant or the global key', async () => {
  await withStoredValue(IPOS_TENANT_CONFIG, async (reads) => {
    await settingsService.getPaymentCapabilities({ tenantId: 'tenant-A' });
    assert.deepEqual(reads, ['tenant:tenant-A:paymentGatewayConfig']);
  });
});

test('router responds with the derived capabilities for the request scope', async () => {
  await withStoredValue(IPOS_TENANT_CONFIG, async () => {
    // Drive the mounted GET / handler directly with a minimal req/res pair —
    // scopeFor(req) derives the tenant from req.user like every other route.
    const layer = paymentCapabilitiesRouter.stack.find((l) => l.route?.path === '/' && l.route?.methods?.get);
    assert.ok(layer, 'GET / handler must be registered on paymentCapabilitiesRouter');
    const handler = layer.route.stack[0].handle;
    let sent = null;
    const req = { user: { id: 'u1', role: 'AGENT', tenantId: 'irc' } };
    const res = { json: (body) => { sent = body; } };
    await handler(req, res, (err) => { throw err || new Error('next() without error'); });
    assert.equal(sent.gateway, 'ipos');
    assert.equal(sent.authorizenet.enabled, false);
  });
});

test('main.js mounts payment-capabilities with requireAuth but WITHOUT the settings module gate, before the gated mount', () => {
  const src = readFileSync(path.join(__dirname, '../../main.js'), 'utf8');
  const capsIdx = src.indexOf("app.use('/api/settings/payment-capabilities'");
  const gatedIdx = src.indexOf("app.use('/api/settings', requireAuth, tenantRateLimit, requireModuleAccess('settings'), settingsRouter)");
  assert.ok(capsIdx > -1, 'payment-capabilities mount missing from main.js');
  assert.ok(gatedIdx > -1, 'gated settings mount missing from main.js');
  assert.ok(capsIdx < gatedIdx, 'payment-capabilities must be mounted BEFORE the module-gated /api/settings mount');
  const mountLine = src.slice(capsIdx, src.indexOf('\n', capsIdx));
  assert.match(mountLine, /requireAuth/, 'mount must require authentication');
  assert.doesNotMatch(mountLine, /requireModuleAccess/, "mount must NOT be gated on the 'settings' module (OPS/AGENT have it off)");
  assert.doesNotMatch(mountLine, /requireRole/, 'mount must not be role-gated — any authenticated staff may read booleans');
});
