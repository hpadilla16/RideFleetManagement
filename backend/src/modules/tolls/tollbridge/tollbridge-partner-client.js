/**
 * TollBridge partner API client (2026-07-27). Pulls every page of
 * GET /api/partner/tolls?from&to&cursor&limit with Authorization: Bearer <key>.
 * Plain global fetch — no new dependency. Cursor pagination on id (stable
 * under inserts, per their contract).
 */
import { TOLLBRIDGE_BASE, TOLLBRIDGE_PARTNER_PATH, TOLLBRIDGE_PAGE_LIMIT, tollbridgePartnerKey } from './tollbridge.constants.js';

export class TollBridgePartnerError extends Error {
  constructor(message, status = 0) { super(message); this.status = status; }
}

const _sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Fetch all transactions in [from, to). `deps.fetchImpl` is injectable for
 * tests. Returns { transactions, pages }. A single page failure after retries
 * throws (the caller ingests nothing rather than a partial window).
 */
export async function fetchPartnerTolls({ from, to, plate = null } = {}, deps = {}) {
  const key = deps.key || tollbridgePartnerKey();
  if (!key) throw new TollBridgePartnerError('TOLLBRIDGE_PARTNER_KEY is not set', 0);
  const fetchImpl = deps.fetchImpl || fetch;
  const base = deps.base || TOLLBRIDGE_BASE;
  const path = deps.path || TOLLBRIDGE_PARTNER_PATH;
  const limit = deps.limit || TOLLBRIDGE_PAGE_LIMIT;
  const maxPages = deps.maxPages || 200; // 200 * 500 = 100k rows/run backstop

  const all = [];
  let cursor = null;
  let pages = 0;
  for (; pages < maxPages; pages += 1) {
    const qs = new URLSearchParams();
    if (from) qs.set('from', from instanceof Date ? from.toISOString() : String(from));
    if (to) qs.set('to', to instanceof Date ? to.toISOString() : String(to));
    if (plate) qs.set('plate', String(plate));
    if (cursor) qs.set('cursor', String(cursor));
    qs.set('limit', String(limit));
    const url = `${base}${path}?${qs.toString()}`;

    let res;
    let lastErr = null;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        res = await fetchImpl(url, { headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' } });
        if (res.status === 429 || res.status >= 500) { lastErr = new TollBridgePartnerError(`upstream ${res.status}`, res.status); await _sleep(400 * (attempt + 1)); continue; }
        break;
      } catch (err) {
        lastErr = err;
        await _sleep(400 * (attempt + 1));
      }
    }
    if (!res || !res.ok) throw new TollBridgePartnerError(`partner fetch failed: ${lastErr?.message || res?.status}`, res?.status || 0);

    const body = await res.json();
    const rows = Array.isArray(body?.transactions) ? body.transactions : [];
    all.push(...rows);
    cursor = body?.nextCursor || null;
    if (!cursor) { pages += 1; break; }
  }
  return { transactions: all, pages };
}
