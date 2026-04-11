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
