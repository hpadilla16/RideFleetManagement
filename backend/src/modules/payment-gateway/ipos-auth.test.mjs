/**
 * Tests for the iPOSpays auto-refresh auth module.
 * Run: node --test backend/src/modules/payment-gateway/ipos-auth.test.mjs
 *
 * Pins the credentials-vs-static-token mode resolution, the JWT exp
 * parsing, the safety-window cache hit logic, the refresh-then-
 * generate fallback chain, and the AUTH_ERR_006/007 invalidation
 * retry. These are the failure modes that would silently break
 * payments in production.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  getAuthToken,
  invalidateCache,
  inspectCache,
  hasAutoRefresh,
  hasStaticToken,
} from './ipos-auth.js';

function makeJwt(payload) {
  const head = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${head}.${body}.sig`;
}

let originalFetch;
let fetchCalls;

function installFetchSpy(handler) {
  originalFetch = global.fetch;
  fetchCalls = [];
  global.fetch = async (url, init) => {
    fetchCalls.push({ url, body: init?.body ? JSON.parse(init.body) : null });
    const result = handler({ url, calls: fetchCalls.length });
    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      text: async () => JSON.stringify(result),
    };
  };
}

function restoreFetch() {
  global.fetch = originalFetch;
}

function clearEnv() {
  delete process.env.IPOS_TRANSACT_AUTH_TOKEN;
  delete process.env.IPOS_TRANSACT_API_KEY;
  delete process.env.IPOS_TRANSACT_SECRET_KEY;
  delete process.env.IPOS_TRANSACT_SCOPE;
}

describe('ipos-auth — mode resolution', () => {
  beforeEach(() => { clearEnv(); invalidateCache(); });

  it('hasStaticToken / hasAutoRefresh report correctly', () => {
    assert.equal(hasStaticToken(), false);
    assert.equal(hasAutoRefresh(), false);

    process.env.IPOS_TRANSACT_AUTH_TOKEN = 'fake-jwt';
    assert.equal(hasStaticToken(), true);

    clearEnv();
    process.env.IPOS_TRANSACT_API_KEY = 'k';
    assert.equal(hasAutoRefresh(), false, 'needs both keys');
    process.env.IPOS_TRANSACT_SECRET_KEY = 's';
    assert.equal(hasAutoRefresh(), true);
  });

  it('static token wins over auto-refresh credentials', async () => {
    process.env.IPOS_TRANSACT_AUTH_TOKEN = 'static-token';
    process.env.IPOS_TRANSACT_API_KEY = 'k';
    process.env.IPOS_TRANSACT_SECRET_KEY = 's';
    installFetchSpy(() => { throw new Error('should not be called'); });
    try {
      const tok = await getAuthToken();
      assert.equal(tok, 'static-token');
      assert.equal(fetchCalls.length, 0, 'no auth API calls when static token is set');
    } finally {
      restoreFetch();
    }
  });

  it('throws clearly when no auth is configured', async () => {
    await assert.rejects(() => getAuthToken(), /IPOS_TRANSACT_AUTH_TOKEN|IPOS_TRANSACT_API_KEY/);
  });
});

describe('ipos-auth — auto-refresh flow', () => {
  beforeEach(() => {
    clearEnv();
    invalidateCache();
    process.env.IPOS_TRANSACT_API_KEY = 'api-k';
    process.env.IPOS_TRANSACT_SECRET_KEY = 'sec-k';
  });
  afterEach(() => { restoreFetch(); });

  it('generates a fresh token on cold cache', async () => {
    const futureExp = Math.floor(Date.now() / 1000) + 3600;
    installFetchSpy(({ url }) => {
      assert.ok(url.endsWith('/v1/authenticate-token'), 'first call is generate');
      return { responseCode: '00', token: makeJwt({ exp: futureExp }) };
    });
    const tok = await getAuthToken();
    assert.ok(tok);
    assert.equal(fetchCalls.length, 1);
    // Generate body must include apiKey + secretKey + scope
    const body = fetchCalls[0].body;
    assert.equal(body.apiKey, 'api-k');
    assert.equal(body.secretKey, 'sec-k');
    assert.equal(body.scope, 'PaymentTokenization');
  });

  it('returns cached token on warm cache (no network call)', async () => {
    const futureExp = Math.floor(Date.now() / 1000) + 3600;
    let calls = 0;
    installFetchSpy(() => {
      calls += 1;
      return { responseCode: '00', token: makeJwt({ exp: futureExp }) };
    });
    await getAuthToken();
    await getAuthToken();
    await getAuthToken();
    assert.equal(calls, 1, 'cache hit on subsequent calls');
  });

  it('uses /v1/refresh-token when nearing safety window', async () => {
    // 20 min from now — INSIDE the 30 min safety window, so the
    // second getAuthToken call sees the cached token as "about to
    // expire" and triggers a refresh instead of a fresh generate.
    const nearExp = Math.floor(Date.now() / 1000) + 20 * 60;
    installFetchSpy(() => ({
      responseCode: '00',
      token: makeJwt({ exp: nearExp }),
    }));
    await getAuthToken(); // cold → generate
    await getAuthToken(); // near-expiry → refresh
    assert.equal(fetchCalls.length, 2);
    assert.ok(fetchCalls[0].url.endsWith('/v1/authenticate-token'));
    assert.ok(fetchCalls[1].url.endsWith('/v1/refresh-token'));
  });

  it('falls back to generate when refresh fails with AUTH_ERR_006', async () => {
    const nearExp = Math.floor(Date.now() / 1000) + 20 * 60;
    let refreshSeen = false;
    installFetchSpy(({ url }) => {
      if (url.endsWith('/v1/refresh-token')) {
        refreshSeen = true;
        // Refresh attempts always fail with AUTH_ERR_006 to force
        // the fallback-to-generate path.
        return { errorCode: 'AUTH_ERR_006', errorMessage: 'Invalid Token' };
      }
      // Generate returns a short-expiry token so the second call
      // sees the cache as near-expiry and tries refresh first.
      return { responseCode: '00', token: makeJwt({ exp: nearExp }) };
    });
    await getAuthToken(); // → generate (call 1)
    const tok = await getAuthToken(); // → refresh fails → generate (call 3)
    assert.ok(tok);
    assert.ok(refreshSeen, 'refresh path was attempted');
    const generateUrls = fetchCalls.filter((c) => c.url.endsWith('/v1/authenticate-token')).length;
    assert.equal(generateUrls, 2, 'two generates: initial + fallback after failed refresh');
  });

  it('invalidateCache forces a re-mint on next call', async () => {
    const futureExp = Math.floor(Date.now() / 1000) + 3600;
    installFetchSpy(() => ({ responseCode: '00', token: makeJwt({ exp: futureExp }) }));
    await getAuthToken();
    invalidateCache();
    assert.equal(inspectCache().hasCachedToken, false);
    await getAuthToken();
    assert.equal(fetchCalls.length, 2);
  });

  it('coalesces concurrent cold-start requests into one network call', async () => {
    const futureExp = Math.floor(Date.now() / 1000) + 3600;
    let pending;
    installFetchSpy(() => {
      // Simulate slow network so the second call enters while the first is in-flight
      return { responseCode: '00', token: makeJwt({ exp: futureExp }) };
    });
    pending = Promise.all([getAuthToken(), getAuthToken(), getAuthToken()]);
    const results = await pending;
    assert.equal(results[0], results[1]);
    assert.equal(results[1], results[2]);
    assert.equal(fetchCalls.length, 1, 'concurrent calls coalesced into one fetch');
  });

  it('surfaces auth errors with their error code', async () => {
    installFetchSpy(() => ({
      errorCode: 'AUTH_ERR_004',
      errorMessage: 'Invalid Credentials, Please Contact Support Team.',
    }));
    await assert.rejects(() => getAuthToken(), /Invalid Credentials/);
  });
});

describe('ipos-auth — JWT exp parsing', () => {
  beforeEach(() => {
    clearEnv();
    invalidateCache();
    process.env.IPOS_TRANSACT_API_KEY = 'k';
    process.env.IPOS_TRANSACT_SECRET_KEY = 's';
  });
  afterEach(() => { restoreFetch(); });

  it('reads exp claim from the returned JWT', async () => {
    const exp = Math.floor(Date.now() / 1000) + 3600;
    installFetchSpy(() => ({ responseCode: '00', token: makeJwt({ exp }) }));
    await getAuthToken();
    const inspected = inspectCache();
    assert.ok(inspected.hasCachedToken);
    // Should be within 1 minute of our intended exp
    assert.ok(Math.abs(inspected.expiresAt - exp * 1000) < 60_000);
  });
});
