/**
 * Kiosk ↔ Valet remote assist F1 (2026-09-03): the shell binds the kiosk
 * session to the Valet conversation server-side so the agent's assist-view
 * can be read. Fire-and-forget, id only (never the secret), null clears.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const TOKEN_KEY = 'ride_kiosk_device_token';

function lastCall() {
  const call = global.fetch.mock.calls.at(-1);
  return { url: call[0], init: call[1], body: JSON.parse(call[1].body) };
}

describe('bindVoziaConversation (kioskClient)', () => {
  beforeEach(() => {
    window.localStorage.setItem(TOKEN_KEY, 'dev-token-1');
    global.fetch = vi.fn(() => Promise.resolve({ ok: true, json: async () => ({ ok: true, sessionId: 'ks1', bound: true }) }));
  });
  afterEach(() => {
    delete global.fetch;
    window.localStorage.removeItem(TOKEN_KEY);
  });

  it('POSTs { conversationId } to the device-guarded binding route with the device token', async () => {
    const { bindVoziaConversation } = await import('../src/lib/kioskClient.js');
    const out = await bindVoziaConversation('ks1', 'conv_abc-123');
    expect(out).toEqual({ ok: true, sessionId: 'ks1', bound: true });
    const { url, init, body } = lastCall();
    expect(url).toMatch(/\/api\/kiosk\/sessions\/ks1\/vozia-conversation$/);
    expect(init.method).toBe('POST');
    expect(init.headers['X-Kiosk-Token']).toBe('dev-token-1');
    expect(body).toEqual({ conversationId: 'conv_abc-123' });
  });

  it('null / undefined / "" clears the binding (conversationId: null) and never sends a secret', async () => {
    const { bindVoziaConversation } = await import('../src/lib/kioskClient.js');
    for (const empty of [null, undefined, '']) {
      await bindVoziaConversation('ks1', empty);
      expect(lastCall().body).toEqual({ conversationId: null });
    }
    expect(JSON.stringify(global.fetch.mock.calls)).not.toContain('secret');
  });

  it('no session id → resolves null without a request', async () => {
    const { bindVoziaConversation } = await import('../src/lib/kioskClient.js');
    await expect(bindVoziaConversation(null, 'conv_1')).resolves.toBeNull();
    await expect(bindVoziaConversation('', 'conv_1')).resolves.toBeNull();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('is fire-and-forget: network failure and non-2xx both resolve null (never throws into the wizard)', async () => {
    const { bindVoziaConversation } = await import('../src/lib/kioskClient.js');
    global.fetch = vi.fn(() => Promise.reject(new TypeError('offline')));
    await expect(bindVoziaConversation('ks1', 'conv_1')).resolves.toBeNull();
    global.fetch = vi.fn(() => Promise.resolve({ ok: false, status: 422, json: async () => ({ error: 'bad', code: 'INVALID_CONVERSATION_ID' }) }));
    await expect(bindVoziaConversation('ks1', 'bad id')).resolves.toBeNull();
  });

  it('encodes the session id in the path', async () => {
    const { bindVoziaConversation } = await import('../src/lib/kioskClient.js');
    await bindVoziaConversation('ks/1?x', 'conv_1');
    expect(lastCall().url).toContain('/api/kiosk/sessions/ks%2F1%3Fx/vozia-conversation');
  });
});
