/**
 * Agent Copilot Phase 2 — the client plumbing (lib/training/copilot-live.js).
 * Pins, in order:
 *  (1) the bilingual split: the corpus's own "## … (Español)" convention,
 *      exercised against the REAL backend corpus, and the monolingual
 *      fallback (a tenant's own edit is shown whole, never hidden)
 *  (2) the block parser: headings, numbered steps, bullets, paragraphs;
 *      "---" rules dropped; ** markers stripped
 *  (3) the miss flush: batch out, sent entries leave the buffer, entries
 *      logged mid-flight stay, failure leaves the buffer untouched, and no
 *      session token means no request at all
 *  (4) the flag endpoint: fires with the question, refuses empties
 *  (5) the AI probe: cached per session (one request), failure = false
 *  (6) askAi: answer passthrough, every failure shape → unavailable
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  splitBilingualBody, articleHalf, articleBlocks,
  flushMisses, flagMissServer, aiEnabled, askAi,
  resetCopilotLiveCaches,
} from '../src/lib/training/copilot-live.js';
import { logMiss, readMisses, MISS_LOG_KEY } from '../src/lib/training/intents.js';
import { DEFAULT_ARTICLES } from '../../backend/src/modules/knowledge-base/default-articles.js';

function fakeStorage() {
  const bag = new Map();
  return {
    getItem: (k) => (bag.has(k) ? bag.get(k) : null),
    setItem: (k, v) => bag.set(k, String(v)),
  };
}

function fakeApi(handler) {
  const calls = [];
  const impl = async (path, opts = {}) => {
    calls.push({ path, opts });
    return handler ? handler(path, opts) : {};
  };
  return { calls, impl };
}

beforeEach(() => {
  resetCopilotLiveCaches();
});

describe('the bilingual split — the corpus convention, against the real corpus', () => {
  it('every default article splits into a distinct EN and ES half', () => {
    for (const a of DEFAULT_ARTICLES) {
      const { en, es } = splitBilingualBody(a.body);
      expect(en.length, `${a.slug} EN half`).toBeGreaterThan(0);
      expect(es.length, `${a.slug} ES half`).toBeGreaterThan(0);
      expect(es, `${a.slug} ES half starts at its own heading`).toMatch(/^##\s.*\(Español\)/i);
      expect(en, `${a.slug} EN half must not contain the Spanish section`).not.toMatch(/\(Español\)/i);
      expect(en.endsWith('---'), `${a.slug} EN half keeps the separator`).toBe(false);
    }
  });

  it('articleHalf picks by language', () => {
    const body = DEFAULT_ARTICLES[0].body;
    expect(articleHalf(body, 'es')).toMatch(/Español/i);
    expect(articleHalf(body, 'en')).not.toMatch(/Español/i);
  });

  it('a monolingual body (a tenant edit) is shown whole in both languages — never hidden', () => {
    const { en, es } = splitBilingualBody('## Only English\n\nJust this.');
    expect(en).toBe('## Only English\n\nJust this.');
    expect(es).toBe(en);
  });
});

describe('the block parser', () => {
  it('parses the shapes the corpus uses and drops the noise', () => {
    const blocks = articleBlocks([
      '## Checkout Process',
      '',
      '1. Open the reservation',
      '2. Click **Start Check-out**',
      '',
      'The system will automatically:',
      '- Create the rental agreement',
      '- Send the email',
      '',
      '---',
      '',
      '**Las fotos son lo único que te defiende después.** Si sale un daño,',
      'lo deciden las fotos.',
    ].join('\n'));
    expect(blocks).toEqual([
      { type: 'heading', text: 'Checkout Process' },
      { type: 'item', text: 'Open the reservation' },
      { type: 'item', text: 'Click Start Check-out' },
      { type: 'para', text: 'The system will automatically:' },
      { type: 'bullet', text: 'Create the rental agreement' },
      { type: 'bullet', text: 'Send the email' },
      { type: 'para', text: 'Las fotos son lo único que te defiende después. Si sale un daño, lo deciden las fotos.' },
    ]);
  });

  it('empty in, empty out', () => {
    expect(articleBlocks('')).toEqual([]);
    expect(articleBlocks(null)).toEqual([]);
  });
});

describe('the miss flush — opportunistic, batch, never breaks the buffer', () => {
  it('sends the buffer and removes exactly what was sent', async () => {
    const store = fakeStorage();
    logMiss('¿Cómo configuro el descuento?', { lang: 'es', pathname: '/reservations', storage: store });
    logMiss('how do I export the roster', { lang: 'en', storage: store });
    const { calls, impl } = fakeApi();

    const out = await flushMisses({ storage: store, apiImpl: impl, token: 'jwt' });
    expect(out.sent).toBe(2);
    expect(calls).toHaveLength(1);
    expect(calls[0].path).toBe('/api/copilot/misses');
    const body = JSON.parse(calls[0].opts.body);
    expect(body.entries).toHaveLength(2);
    expect(body.entries[0]).toMatchObject({ query: '¿Cómo configuro el descuento?', lang: 'es', pathname: '/reservations', flagged: false });
    expect(typeof body.entries[0].ts).toBe('string');
    expect(readMisses(store)).toEqual([]);
  });

  it('an entry logged while the flush is in flight survives it', async () => {
    const store = fakeStorage();
    logMiss('first question', { storage: store });
    const impl = async () => {
      // The server is slow; the agent asks something else meanwhile.
      logMiss('second question, mid-flight', { storage: store });
      return {};
    };
    await flushMisses({ storage: store, apiImpl: impl, token: 'jwt' });
    const left = readMisses(store);
    expect(left).toHaveLength(1);
    expect(left[0].q).toBe('second question, mid-flight');
  });

  it('a failed flush leaves the buffer untouched — it will try again next time', async () => {
    const store = fakeStorage();
    logMiss('a question', { storage: store });
    const out = await flushMisses({ storage: store, apiImpl: async () => { throw new Error('offline'); }, token: 'jwt' });
    expect(out.sent).toBe(0);
    expect(readMisses(store)).toHaveLength(1);
  });

  it('no session token → no request at all; empty buffer → no request', async () => {
    const store = fakeStorage();
    logMiss('a question', { storage: store });
    const { calls, impl } = fakeApi();
    expect((await flushMisses({ storage: store, apiImpl: impl, token: null })).sent).toBe(0);
    expect((await flushMisses({ storage: fakeStorage(), apiImpl: impl, token: 'jwt' })).sent).toBe(0);
    expect(calls).toHaveLength(0);
  });

  it('a corrupt buffer degrades to a no-op instead of throwing into the panel', async () => {
    const store = fakeStorage();
    store.setItem(MISS_LOG_KEY, '{not json');
    const { calls, impl } = fakeApi();
    expect((await flushMisses({ storage: store, apiImpl: impl, token: 'jwt' })).sent).toBe(0);
    expect(calls).toHaveLength(0);
  });
});

describe('"Avisar a un admin", server side', () => {
  it('posts the question to the flag endpoint', async () => {
    const { calls, impl } = fakeApi();
    expect(await flagMissServer({ query: 'descuento de AAA', lang: 'es', pathname: '/x', apiImpl: impl, token: 'jwt' })).toBe(true);
    expect(calls[0].path).toBe('/api/copilot/misses/flag');
    expect(JSON.parse(calls[0].opts.body)).toEqual({ query: 'descuento de AAA', lang: 'es', pathname: '/x' });
  });

  it('refuses empties and swallows failures', async () => {
    const { calls, impl } = fakeApi();
    expect(await flagMissServer({ query: '   ', apiImpl: impl, token: 'jwt' })).toBe(false);
    expect(calls).toHaveLength(0);
    expect(await flagMissServer({ query: 'q', apiImpl: async () => { throw new Error('x'); }, token: 'jwt' })).toBe(false);
  });
});

describe('the AI probe and the ask', () => {
  it('aiEnabled asks once per session and caches the boolean', async () => {
    const { calls, impl } = fakeApi(() => ({ enabled: true }));
    expect(await aiEnabled({ apiImpl: impl, token: 'jwt' })).toBe(true);
    expect(await aiEnabled({ apiImpl: impl, token: 'jwt' })).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].path).toBe('/api/copilot/ai-status');
  });

  it('a failed probe reads as disabled — Phase 1 behavior', async () => {
    expect(await aiEnabled({ apiImpl: async () => { throw new Error('x'); }, token: 'jwt' })).toBe(false);
  });

  it('askAi passes a real answer through and folds every failure into unavailable', async () => {
    const ok = await askAi({
      query: 'como cobro un deposito',
      lang: 'es',
      apiImpl: async (path, opts) => {
        expect(path).toBe('/api/copilot/ask');
        expect(JSON.parse(opts.body)).toEqual({ query: 'como cobro un deposito', lang: 'es' });
        return { answer: 'Desde la reserva…', sources: [{ slug: 's', title: 'T' }], model: 'm' };
      },
      token: 'jwt',
    });
    expect(ok.answer).toBe('Desde la reserva…');

    expect(await askAi({ query: 'q', apiImpl: async () => ({ unavailable: 'CAP_EXCEEDED' }), token: 'jwt' }))
      .toEqual({ unavailable: 'CAP_EXCEEDED' });
    expect(await askAi({ query: 'q', apiImpl: async () => { throw new Error('x'); }, token: 'jwt' }))
      .toEqual({ unavailable: 'ERROR' });
    expect(await askAi({ query: '', apiImpl: async () => ({}), token: 'jwt' }))
      .toEqual({ unavailable: 'ERROR' });
  });
});
