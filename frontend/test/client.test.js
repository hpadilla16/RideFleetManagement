import { describe, it, expect, vi, beforeEach } from 'vitest';

// Test the client utility functions that don't need fetch
describe('Client utilities', () => {
  beforeEach(() => {
    vi.stubGlobal('localStorage', {
      store: {},
      getItem(key) { return this.store[key] || null; },
      setItem(key, val) { this.store[key] = val; },
      removeItem(key) { delete this.store[key]; },
    });
  });

  it('TOKEN_KEY and USER_KEY are defined', async () => {
    // Dynamic import to get the constants
    const mod = await import('../src/lib/client');
    expect(mod.TOKEN_KEY).toBe('fleet_jwt');
    expect(mod.USER_KEY).toBe('fleet_user');
  });

  it('AUTH_EXPIRED_EVENT is a string', async () => {
    const mod = await import('../src/lib/client');
    expect(typeof mod.AUTH_EXPIRED_EVENT).toBe('string');
    expect(mod.AUTH_EXPIRED_EVENT.length).toBeGreaterThan(0);
  });

  it('clearStoredAuth removes keys from localStorage', async () => {
    localStorage.setItem('fleet_jwt', 'test-token');
    localStorage.setItem('fleet_user', '{"id":"1"}');
    const mod = await import('../src/lib/client');
    mod.clearStoredAuth();
    expect(localStorage.getItem('fleet_jwt')).toBeNull();
    expect(localStorage.getItem('fleet_user')).toBeNull();
  });

  it('readStoredToken returns token from localStorage', async () => {
    localStorage.setItem('fleet_jwt', 'my-jwt-token');
    const mod = await import('../src/lib/client');
    expect(mod.readStoredToken()).toBe('my-jwt-token');
  });

  it('readStoredToken returns empty string when no token', async () => {
    const mod = await import('../src/lib/client');
    expect(mod.readStoredToken()).toBe('');
  });
});

/**
 * The ADDITIVE members on a failed request (2026-09-01).
 *
 * `reason` and `session` are lifted off a handful of checkout 409s
 * (checkout-session.routes.js spreads them only when set). parseApiResponse is
 * the shared error path for EVERY request in the app, so "additive" has to
 * mean additive: an unguarded `error.reason = reason` gives thousands of
 * unrelated errors a `reason: null` member, which is a different thing from
 * not having one for any caller using `in` or Object.keys.
 *
 * The claim was written as a comment in that file first. Comments are not
 * checked, and this one is about a path every screen depends on.
 */
describe('api() error shape', () => {
  const jsonResponse = (status, body) => ({
    ok: false,
    status,
    headers: { get: () => 'application/json' },
    text: async () => JSON.stringify(body),
  });

  const callApi = async (response) => {
    vi.stubGlobal('fetch', vi.fn(async () => response));
    const mod = await import('../src/lib/client');
    try {
      await mod.api('/api/anything', {}, 'tok');
    } catch (err) {
      return err;
    }
    throw new Error('api() resolved on a failed response');
  };

  it('leaves reason and session OFF an ordinary error', async () => {
    const err = await callApi(jsonResponse(500, { error: 'boom' }));
    expect(err.status).toBe(500);
    // `in`, not `=== undefined`: assigning null would pass the loose check and
    // is exactly the regression this pins.
    expect('reason' in err).toBe(false);
    expect('session' in err).toBe(false);
    // `code` IS always present — it predates these two and callers read it
    // unconditionally. The asymmetry is deliberate, so it gets asserted.
    expect('code' in err).toBe(true);
    expect(err.code).toBeNull();
  });

  it('carries reason through when the backend actually sends one', async () => {
    const err = await callApi(jsonResponse(409, {
      error: 'Checkout is closed but its finalize did not complete: no vehicle',
      code: 'FINALIZE_INCOMPLETE',
      reason: 'NO_VEHICLE_ASSIGNED',
    }));
    expect(err.code).toBe('FINALIZE_INCOMPLETE');
    expect(err.reason).toBe('NO_VEHICLE_ASSIGNED');
  });

  it('carries the fresh session row through on a version conflict', async () => {
    const err = await callApi(jsonResponse(409, {
      error: 'Session is being changed by another surface',
      code: 'CONCURRENT_MODIFICATION',
      session: { id: 'cs1', currentStep: 'CLOSED' },
    }));
    expect(err.session).toEqual({ id: 'cs1', currentStep: 'CLOSED' });
    expect('reason' in err).toBe(false);
  });
});
