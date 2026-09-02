/**
 * Agent Copilot — Phase 2 client plumbing (2026-09-02).
 *
 * Everything the panel does that touches the network, plus the pure helpers
 * that make it testable without one:
 *
 *  - MISS FLUSH: the localStorage ring buffer ('copilot.misses', Phase 1) is
 *    flushed to POST /api/copilot/misses opportunistically — on panel open
 *    and after a new miss. Batch, fire-and-forget, NEVER blocks or throws
 *    into the panel: a failed flush leaves the buffer alone and tries again
 *    next time. "Avisar a un admin" goes through its own endpoint so a flag
 *    pressed after the entry already flushed still reaches the admin.
 *
 *  - ARTICLE BODIES: the panel's KB answers now render the real Ride
 *    University article body (the same GET /api/knowledge-base/article/:slug
 *    the KB page uses), split into the asker's language half by the corpus's
 *    own hard convention (default-articles.js: one bilingual body, the
 *    Spanish half under its own "## … (Español)" heading). Cached per
 *    session; any error falls back to the curated summary the card already
 *    shows — the fetch only ever ADDS.
 *
 *  - AI FALLBACK: on a miss, IF the tenant's copilotAiConfig is enabled
 *    (GET /api/copilot/ai-status, cached per session — a tenant with the
 *    default OFF costs one request per session, not one per miss), the panel
 *    asks POST /api/copilot/ask. Every refusal shape degrades to Phase 1
 *    silence; only a real sourced answer adds the AI bubble.
 *
 * All network entry points accept { apiImpl, token } for tests; defaults go
 * through lib/client.api with the stored JWT.
 */

import { api, readStoredToken } from '../client.js';
import { MISS_LOG_KEY, readMisses } from './intents.js';

// ---------------------------------------------------------------------------
// Pure: the bilingual article split + a light block parser for panel styling.
// ---------------------------------------------------------------------------

const ES_HEADING = /^##\s.*\(espa[nñ]ol\)/i;

/**
 * One bilingual body → { en, es }. The Spanish half starts at its own
 * "## … (Español)" heading; the "---" separator above it belongs to neither.
 * A body without the heading (a tenant's own monolingual edit) is shown
 * whole in both languages — never hidden.
 */
export function splitBilingualBody(body) {
  const text = String(body || '');
  const lines = text.split('\n');
  const idx = lines.findIndex((l) => ES_HEADING.test(l.trim()));
  if (idx < 0) {
    const whole = text.trim();
    return { en: whole, es: whole };
  }
  let enEnd = idx;
  while (enEnd > 0 && !lines[enEnd - 1].trim()) enEnd -= 1;
  if (enEnd > 0 && lines[enEnd - 1].trim() === '---') enEnd -= 1;
  return {
    en: lines.slice(0, enEnd).join('\n').trim(),
    es: lines.slice(idx).join('\n').trim(),
  };
}

export function articleHalf(body, lang) {
  const halves = splitBilingualBody(body);
  return lang === 'es' ? halves.es : halves.en;
}

/**
 * Markdown-lite → typed blocks the panel styles itself. Only the shapes the
 * corpus actually uses: ## headings, numbered steps, dashed bullets, plain
 * paragraphs. "---" rules are dropped; **bold** markers are stripped (the
 * panel styles blocks, not spans).
 */
export function articleBlocks(md) {
  const blocks = [];
  let para = [];
  const flush = () => {
    if (para.length) {
      blocks.push({ type: 'para', text: para.join(' ') });
      para = [];
    }
  };
  for (const raw of String(md || '').split('\n')) {
    const line = raw.trim().replace(/\*\*/g, '');
    if (!line) { flush(); continue; }
    if (line === '---') { flush(); continue; }
    const heading = /^#{1,4}\s+(.*)$/.exec(line);
    if (heading) { flush(); blocks.push({ type: 'heading', text: heading[1] }); continue; }
    const item = /^\d+[.)]\s+(.*)$/.exec(line);
    if (item) { flush(); blocks.push({ type: 'item', text: item[1] }); continue; }
    const bullet = /^[-*]\s+(.*)$/.exec(line);
    if (bullet) { flush(); blocks.push({ type: 'bullet', text: bullet[1] }); continue; }
    para.push(line);
  }
  flush();
  return blocks;
}

// ---------------------------------------------------------------------------
// The miss flush.
// ---------------------------------------------------------------------------

const FLUSH_BATCH = 50;
let flushInFlight = false;

/** Entry identity inside the ring buffer — timestamp + text is unique enough
 *  for telemetry, and stable across the flush round-trip. */
const sameEntry = (a, b) => a.at === b.at && a.q === b.q;

/**
 * Flush the ring buffer to the server. Resolves { sent } and never rejects.
 * On success the sent entries leave the buffer (entries logged while the
 * request was in flight stay); on any failure the buffer is untouched.
 */
export async function flushMisses({ storage, apiImpl = api, token } = {}) {
  if (flushInFlight) return { sent: 0 };
  const store = storage || (typeof window !== 'undefined' ? window.localStorage : null);
  if (!store) return { sent: 0 };
  const list = readMisses(store);
  if (!list.length) return { sent: 0 };
  const jwt = token !== undefined ? token : readStoredToken();
  if (!jwt) return { sent: 0 };

  flushInFlight = true;
  try {
    const batch = list.slice(0, FLUSH_BATCH);
    const entries = batch.map((m) => ({
      query: m.q,
      lang: m.lang || null,
      pathname: m.pathname || null,
      flagged: m.flagged === true,
      ts: m.at || null,
    }));
    await apiImpl('/api/copilot/misses', { method: 'POST', body: JSON.stringify({ entries }) }, jwt);
    try {
      const remaining = readMisses(store).filter((m) => !batch.some((s) => sameEntry(s, m)));
      store.setItem(MISS_LOG_KEY, JSON.stringify(remaining));
    } catch { /* private browsing — the server has them either way */ }
    return { sent: entries.length };
  } catch {
    return { sent: 0 };
  } finally {
    flushInFlight = false;
  }
}

/**
 * "Avisar a un admin", server side. Its own endpoint rather than a re-flush:
 * the miss row may already be on the server (flushed unflagged seconds
 * earlier), and this flips THAT row instead of double-counting the question.
 * Fire-and-forget; resolves a boolean, never rejects.
 */
export async function flagMissServer({ query, lang, pathname, apiImpl = api, token } = {}) {
  const q = String(query || '').trim();
  if (!q) return false;
  const jwt = token !== undefined ? token : readStoredToken();
  if (!jwt) return false;
  try {
    await apiImpl('/api/copilot/misses/flag', {
      method: 'POST',
      body: JSON.stringify({ query: q, lang: lang || null, pathname: pathname || null }),
    }, jwt);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Article bodies — cached per session, fallback-only-adds.
// ---------------------------------------------------------------------------

const articleCache = new Map();

/** Session cache reset — tests only. */
export function resetCopilotLiveCaches() {
  articleCache.clear();
  aiStatusCache = undefined;
}

/**
 * The full article for a slug, cached per session (cache holds the promise,
 * so ten cards asking at once is one request). Throws on failure — the card
 * catches and keeps its curated summary.
 */
export async function fetchArticle(slug, { apiImpl = api, token } = {}) {
  const key = String(slug || '');
  if (!key) throw new Error('no slug');
  if (articleCache.has(key)) return articleCache.get(key);
  const jwt = token !== undefined ? token : readStoredToken();
  if (!jwt) throw new Error('no session');
  const p = apiImpl(`/api/knowledge-base/article/${encodeURIComponent(key)}`, {}, jwt);
  articleCache.set(key, p);
  try {
    return await p;
  } catch (err) {
    articleCache.delete(key); // a failed fetch may be retried on the next ask
    throw err;
  }
}

// ---------------------------------------------------------------------------
// The AI fallback — capability probe + ask.
// ---------------------------------------------------------------------------

let aiStatusCache; // undefined = not asked yet; otherwise a promise of boolean

/**
 * May this tenant's panel even try /ask? One request per session — with the
 * default config (OFF for every tenant) the answer is a cached false and the
 * miss path stays byte-identical to Phase 1.
 */
export function aiEnabled({ apiImpl = api, token } = {}) {
  if (aiStatusCache === undefined) {
    aiStatusCache = (async () => {
      try {
        const jwt = token !== undefined ? token : readStoredToken();
        if (!jwt) return false;
        const out = await apiImpl('/api/copilot/ai-status', {}, jwt);
        return out?.enabled === true;
      } catch {
        return false;
      }
    })();
  }
  return aiStatusCache;
}

/**
 * Ask the gated AI fallback. Resolves the server shape ({ answer, sources,
 * model } or { unavailable }) and never rejects — every failure is an
 * `unavailable`, which the panel treats as Phase 1 silence.
 */
export async function askAi({ query, lang, apiImpl = api, token } = {}) {
  const q = String(query || '').trim();
  if (!q) return { unavailable: 'ERROR' };
  try {
    const jwt = token !== undefined ? token : readStoredToken();
    if (!jwt) return { unavailable: 'ERROR' };
    const out = await apiImpl('/api/copilot/ask', {
      method: 'POST',
      body: JSON.stringify({ query: q, lang: lang === 'es' ? 'es' : 'en' }),
    }, jwt);
    if (out && typeof out.answer === 'string' && out.answer.trim()) return out;
    return { unavailable: out?.unavailable || 'ERROR' };
  } catch {
    return { unavailable: 'ERROR' };
  }
}
