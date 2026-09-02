/**
 * Agent Copilot — Phase 2 backend (2026-09-02).
 * Design: design/mockups/copilot-NOTES.md §2 (phases), §4 guardrail 2 (misses
 * are logged — the miss list IS the authoring backlog).
 *
 * Two halves, deliberately small:
 *
 * 1. MISS TELEMETRY. The panel's localStorage ring buffer ('copilot.misses')
 *    now also flushes here, opportunistically and fire-and-forget — the panel
 *    never waits on it. Rows land in CopilotMiss (observation table, loose
 *    ids). "Avisar a un admin" ALSO emits a notification-center envelope
 *    (sourceType COPILOT, audienceRole ADMIN, NEEDS_ACTION) deduped per
 *    normalized query per UTC day, so the same unanswered question flagged by
 *    three agents is one row on the admin's bell, not three.
 *
 * 2. AI FALLBACK — config-gated, OFF for every tenant by default. On a miss,
 *    IF the tenant's copilotAiConfig says enabled AND a credential resolves
 *    (settingsService.resolveCopilotAiCredential — the citation-OCR
 *    per-tenant encrypted-key pattern, feature 'copilot-ask'; NEVER a bare
 *    env fallback), the top-3 keyword-matched Ride University articles are
 *    sent to the model with a system prompt that forbids answering from
 *    anything else. No sources → no call. Spend guard: a per-tenant daily
 *    call cap (config.dailyCallCap, default 200) counted as kind='AI_CALL'
 *    rows in the same CopilotMiss table. Without config the miss path
 *    behaves exactly like Phase 1: askCopilotAi returns AI_DISABLED before
 *    touching anything.
 *
 * Every entry point takes injectable deps ({ db, emit, fetchImpl, ... }) so
 * the suite runs DB-free (checkin-audit.service precedent).
 */

import { prisma } from '../../lib/prisma.js';
import logger from '../../lib/logger.js';
import { emitNotificationSafe } from '../notifications/notifications-emit.js';
import { settingsService } from '../settings/settings.service.js';

// ---------------------------------------------------------------------------
// Constants — exported so routes, tests and the settings panel name them once.
// ---------------------------------------------------------------------------

export const MISS_KINDS = Object.freeze({ MISS: 'MISS', AI_CALL: 'AI_CALL' });
export const AI_OUTCOMES = Object.freeze({ ANSWERED: 'ANSWERED', NO_ANSWER: 'NO_ANSWER', ERROR: 'ERROR' });

/** Refusal reasons the ask endpoint can return WITHOUT having called out. */
export const AI_UNAVAILABLE = Object.freeze({
  DISABLED: 'AI_DISABLED',
  NO_CREDENTIAL: 'NO_CREDENTIAL',
  CAP_EXCEEDED: 'CAP_EXCEEDED',
  NO_SOURCES: 'NO_SOURCES',
  NO_ANSWER: 'NO_ANSWER',
  ERROR: 'ERROR',
});

export const MAX_BATCH_ENTRIES = 50;     // one full ring buffer per flush
export const MAX_QUERY_CHARS = 300;      // mirrors the panel's own cap
export const DEFAULT_DAILY_CALL_CAP = 200;
export const DEFAULT_COPILOT_AI_MODEL = 'claude-haiku-4-5-20251001';
export const AI_MAX_TOKENS = 300;
export const AI_TOP_ARTICLES = 3;
const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';

// ---------------------------------------------------------------------------
// Normalization — the grouping identity for "what to teach next". Mirrors the
// panel's matcher normalize() (frontend/src/lib/training/intents.js) so the
// same question typed with accents, casing or punctuation is ONE row group.
// ---------------------------------------------------------------------------

/** Uncapped text normalization — also what the retrieval tokenizer uses on
 *  full article BODIES (capping here once silently truncated every body to
 *  300 chars and blinded retrieval to the Spanish half of the corpus). */
function normalizeText(text) {
  return String(text || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function normalizeQuery(text) {
  return normalizeText(text).slice(0, MAX_QUERY_CHARS);
}

/** UTC midnight of `now` — the cap window. UTC on purpose: a fixed, timezone-
 *  free boundary beats a "correct" local midnight nobody can reason about. */
export function startOfUtcDay(now = new Date()) {
  const d = new Date(now);
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

// ---------------------------------------------------------------------------
// 1. Miss ingest — the batch flush.
// ---------------------------------------------------------------------------

/** One raw client entry → a row shape, or null when it carries no question. */
export function sanitizeMissEntry(entry, { tenantId, userId }) {
  const query = String(entry?.query ?? entry?.q ?? '').trim().slice(0, MAX_QUERY_CHARS);
  const normalizedQuery = normalizeQuery(query);
  if (!normalizedQuery) return null;
  const askedAtRaw = entry?.ts ?? entry?.at ?? null;
  const askedAt = askedAtRaw ? new Date(askedAtRaw) : null;
  return {
    tenantId,
    kind: MISS_KINDS.MISS,
    query,
    normalizedQuery,
    pathname: entry?.pathname ? String(entry.pathname).slice(0, 200) : null,
    lang: entry?.lang === 'es' ? 'es' : entry?.lang === 'en' ? 'en' : null,
    userId: userId || null,
    flagged: entry?.flagged === true,
    askedAt: askedAt && !Number.isNaN(askedAt.getTime()) ? askedAt : null,
  };
}

/**
 * Ingest a batch of panel misses. Never throws on a bad entry — it is
 * telemetry, and the panel already forgot about it. Flagged entries also
 * emit the admin notification (deduped inside notifyAdminOfMiss).
 *
 * @returns {{ accepted: number }}
 */
export async function ingestMisses(body = {}, scope = {}, deps = {}) {
  const db = deps.db || prisma;
  const emit = deps.emit || emitNotificationSafe;
  const tenantId = scope?.tenantId || null;
  if (!tenantId) return { accepted: 0 };

  const raw = Array.isArray(body?.entries) ? body.entries.slice(0, MAX_BATCH_ENTRIES) : [];
  const rows = raw
    .map((e) => sanitizeMissEntry(e, { tenantId, userId: scope?.userId || null }))
    .filter(Boolean);
  if (!rows.length) return { accepted: 0 };

  await db.copilotMiss.createMany({ data: rows });

  for (const row of rows) {
    if (row.flagged) await notifyAdminOfMiss(row, { emit, now: deps.now });
  }
  return { accepted: rows.length };
}

/**
 * The COPILOT envelope for a flagged miss. Deduped per normalized query per
 * UTC day: three agents flagging the same gap is one bell item. templateKey
 * stays null on purpose — the notification page falls back to the stored
 * title for unknown keys, and this title carries the question verbatim.
 */
export async function notifyAdminOfMiss(row, { emit = emitNotificationSafe, now } = {}) {
  const day = startOfUtcDay(now ? new Date(now) : new Date()).toISOString().slice(0, 10);
  return emit({
    tenantId: row.tenantId,
    severity: 'NEEDS_ACTION',
    sourceType: 'COPILOT',
    sourceRefId: null,
    audienceRole: 'ADMIN',
    title: `Copilot couldn't answer: "${row.query}"`,
    body: 'An agent flagged this unanswered question. Teach it: write the article or map the intent.',
    deepLink: `/knowledge-base?search=${encodeURIComponent(row.query)}`,
    dedupeKey: `copilot-miss:${row.normalizedQuery}:${day}`,
  });
}

/**
 * "Avisar a un admin" pressed AFTER the miss already flushed: flag the most
 * recent matching row (or record one) and emit the envelope.
 */
export async function flagMiss(body = {}, scope = {}, deps = {}) {
  const db = deps.db || prisma;
  const emit = deps.emit || emitNotificationSafe;
  const tenantId = scope?.tenantId || null;
  if (!tenantId) return { ok: false };
  const row = sanitizeMissEntry({ ...body, flagged: true }, { tenantId, userId: scope?.userId || null });
  if (!row) return { ok: false };

  const existing = await db.copilotMiss.findFirst({
    where: { tenantId, kind: MISS_KINDS.MISS, normalizedQuery: row.normalizedQuery },
    orderBy: { createdAt: 'desc' },
    select: { id: true },
  });
  if (existing) {
    await db.copilotMiss.update({ where: { id: existing.id }, data: { flagged: true } });
  } else {
    await db.copilotMiss.create({ data: row });
  }
  await notifyAdminOfMiss(row, { emit, now: deps.now });
  return { ok: true };
}

// ---------------------------------------------------------------------------
// 2. The admin read — top misses, grouped, "what to teach next".
// ---------------------------------------------------------------------------

export async function topMisses(query = {}, scope = {}, deps = {}) {
  const db = deps.db || prisma;
  const tenantId = scope?.tenantId || null;
  if (!tenantId) return { items: [] };

  const days = Number.isFinite(Number(query?.days)) && Number(query.days) > 0
    ? Math.min(365, Math.floor(Number(query.days)))
    : 30;
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const limit = Math.min(100, Math.max(1, Number(query?.limit) || 25));

  const groups = await db.copilotMiss.groupBy({
    by: ['normalizedQuery'],
    where: { tenantId, kind: MISS_KINDS.MISS, createdAt: { gte: since } },
    _count: { _all: true },
    _max: { createdAt: true, query: true },
    orderBy: [{ _count: { normalizedQuery: 'desc' } }, { _max: { createdAt: 'desc' } }],
    take: limit,
  });

  // Which groups carry at least one flag — one extra query, not one per group.
  const flaggedGroups = await db.copilotMiss.groupBy({
    by: ['normalizedQuery'],
    where: { tenantId, kind: MISS_KINDS.MISS, createdAt: { gte: since }, flagged: true },
    _count: { _all: true },
  });
  const flaggedSet = new Set(flaggedGroups.map((g) => g.normalizedQuery));

  return {
    days,
    items: groups.map((g) => ({
      normalizedQuery: g.normalizedQuery,
      // A representative verbatim question for the admin to read.
      query: g._max?.query || g.normalizedQuery,
      count: g._count?._all || 0,
      lastAt: g._max?.createdAt || null,
      flagged: flaggedSet.has(g.normalizedQuery),
    })),
  };
}

// ---------------------------------------------------------------------------
// 3. AI fallback — retrieval.
// ---------------------------------------------------------------------------

function tokensOf(text) {
  return normalizeText(text).split(' ').filter((w) => w.length >= 3);
}

/**
 * Keyword score of one article against the question tokens. Title hits weigh
 * 4, tag hits 3, body hits 1 (prefix-tolerant at ≥4 chars, so "conductores"
 * finds "conductor"). Zero means "this article says nothing about that".
 */
export function scoreArticleForQuery(article, qTokens) {
  if (!qTokens.length) return 0;
  const titleTokens = tokensOf(article?.title || '');
  const tagTokens = (article?.tags || []).flatMap((t) => tokensOf(t));
  const bodyTokens = new Set(tokensOf(article?.body || ''));
  const hits = (hay, q) => hay.some((h) => h === q
    || (q.length >= 4 && h.startsWith(q)) || (h.length >= 4 && q.startsWith(h)));
  let score = 0;
  for (const q of qTokens) {
    if (hits(titleTokens, q)) score += 4;
    if (hits(tagTokens, q)) score += 3;
    if (bodyTokens.has(q) || [...bodyTokens].some((b) => hits([b], q))) score += 1;
  }
  return score;
}

/** The top-N scoring articles for a question; empty when nothing scores. */
export function retrieveArticles(articles, query, n = AI_TOP_ARTICLES) {
  const qTokens = tokensOf(query);
  return (articles || [])
    .map((a) => ({ article: a, score: scoreArticleForQuery(a, qTokens) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, n)
    .map((x) => x.article);
}

// ---------------------------------------------------------------------------
// 4. AI fallback — the gated call.
// ---------------------------------------------------------------------------

/** The tight system prompt. Exported so the test pins the guardrails. */
export function buildAiSystemPrompt(lang = 'en') {
  const language = lang === 'es' ? 'Spanish' : 'English';
  return [
    "You are the fallback answerer for RideFleet's Agent Copilot, helping rental-counter staff.",
    'You receive excerpts from Ride University knowledge-base articles and one staff question.',
    'Absolute rules:',
    '- Answer ONLY from the excerpts provided. If they do not contain the answer, reply with exactly NO_ANSWER and nothing else.',
    `- Answer in ${language}, in at most 120 words, as short practical steps where possible.`,
    '- End with one final line naming the article you used: Source: <exact article title>.',
    '- Never invent steps, buttons, settings, prices or policies. Never instruct actions the interface may not actually offer.',
    '- You cannot perform actions in the product; you only explain what the articles describe.',
  ].join('\n');
}

export function buildAiUserContent(query, articles) {
  const excerpts = articles.map((a, i) => (
    `ARTICLE ${i + 1}: ${a.title}\n---\n${String(a.body || '').slice(0, 6000)}`
  )).join('\n\n');
  return `${excerpts}\n\nSTAFF QUESTION: ${String(query || '').slice(0, MAX_QUERY_CHARS)}`;
}

/**
 * The gate + the call, in data-safety order:
 *   config OFF        → AI_DISABLED     (no config read beyond the flag, no row)
 *   no credential     → NO_CREDENTIAL   (resolveCopilotAiCredential said NONE)
 *   daily cap reached → CAP_EXCEEDED    (no call, no row — capped attempts
 *                                        must not grow the very count that caps them)
 *   nothing retrieved → NO_SOURCES      (guardrail: no sources → no call)
 *   model says NO_ANSWER → NO_ANSWER    (AI_CALL row, outcome NO_ANSWER)
 *   provider error    → ERROR           (AI_CALL row, outcome ERROR)
 *   answered          → { answer, sources, model } (AI_CALL row, ANSWERED)
 */
export async function askCopilotAi(body = {}, scope = {}, deps = {}) {
  const db = deps.db || prisma;
  const settings = deps.settings || settingsService;
  const fetchImpl = deps.fetchImpl || fetch;
  const now = deps.now ? new Date(deps.now) : new Date();
  const tenantId = scope?.tenantId || null;
  const query = String(body?.query || '').trim().slice(0, MAX_QUERY_CHARS);
  const lang = body?.lang === 'es' ? 'es' : 'en';
  if (!tenantId || !normalizeQuery(query)) return { unavailable: AI_UNAVAILABLE.DISABLED };

  // 1. The flag. Absent config === disabled === Phase 1 behavior, exactly.
  const cfg = await settings.getCopilotAiConfig({ tenantId });
  if (!cfg?.enabled) return { unavailable: AI_UNAVAILABLE.DISABLED };
  // Only Anthropic is implemented; an unknown provider fails closed rather
  // than sending a tenant's key to the wrong host (citation-ocr precedent).
  if ((cfg.provider || 'anthropic') !== 'anthropic') {
    logger.warn('[copilot] unsupported AI provider configured', { tenantId, provider: cfg.provider });
    return { unavailable: AI_UNAVAILABLE.ERROR };
  }

  // 2. The credential — per-tenant, encrypted at rest, panel-entered. NONE
  //    fails closed here, before any provider call (Corpusa lesson).
  const resolved = await settings.resolveCopilotAiCredential({ tenantId });
  if (!resolved?.credential?.credential) return { unavailable: AI_UNAVAILABLE.NO_CREDENTIAL };

  // 3–7 live in askWithCredential (split so the post-credential half is
  // testable with a fake db + fetch and no settings service at all).
  return askWithCredential({ db, fetchImpl, now, tenantId, query, lang, cfg, resolved });
}

export async function askWithCredential({ db, fetchImpl, now, tenantId, query, lang, cfg, resolved }) {
  const cap = Number.isFinite(Number(cfg.dailyCallCap)) && Number(cfg.dailyCallCap) > 0
    ? Math.floor(Number(cfg.dailyCallCap))
    : DEFAULT_DAILY_CALL_CAP;
  const usedToday = await db.copilotMiss.count({
    where: { tenantId, kind: MISS_KINDS.AI_CALL, createdAt: { gte: startOfUtcDay(now) } },
  });
  if (usedToday >= cap) return { unavailable: AI_UNAVAILABLE.CAP_EXCEEDED };

  // 4. Retrieval — the tenant's own overrides plus the global corpus, same
  //    visibility rule as the KB list endpoint. No sources → no call.
  const articles = await db.knowledgeArticle.findMany({
    where: { status: 'PUBLISHED', OR: [{ tenantId }, { tenantId: null }] },
    select: { slug: true, title: true, body: true, tags: true },
  });
  const top = retrieveArticles(articles, query);
  if (!top.length) return { unavailable: AI_UNAVAILABLE.NO_SOURCES };

  const model = cfg.model || DEFAULT_COPILOT_AI_MODEL;
  const record = async (aiOutcome) => {
    try {
      await db.copilotMiss.create({
        data: {
          tenantId,
          kind: MISS_KINDS.AI_CALL,
          query,
          normalizedQuery: normalizeQuery(query),
          lang,
          aiOutcome,
        },
      });
    } catch (err) {
      logger.warn('[copilot] AI_CALL row not recorded (non-fatal)', { message: err?.message });
    }
  };

  try {
    const res = await fetchImpl(ANTHROPIC_URL, {
      method: 'POST',
      headers: {
        'x-api-key': resolved.credential.credential,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model,
        max_tokens: AI_MAX_TOKENS,
        system: buildAiSystemPrompt(lang),
        messages: [{ role: 'user', content: buildAiUserContent(query, top) }],
      }),
    });
    if (!res.ok) {
      const errBody = await res.text().catch(() => '');
      await record(AI_OUTCOMES.ERROR);
      logger.warn('[copilot] AI fallback provider error', { tenantId, status: res.status, body: errBody.slice(0, 200) });
      return { unavailable: AI_UNAVAILABLE.ERROR };
    }
    const json = await res.json();
    const text = (json?.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
    if (!text || /^NO_ANSWER\b/.test(text) || text === 'NO_ANSWER') {
      await record(AI_OUTCOMES.NO_ANSWER);
      return { unavailable: AI_UNAVAILABLE.NO_ANSWER };
    }
    await record(AI_OUTCOMES.ANSWERED);
    return {
      answer: text,
      model,
      sources: top.map((a) => ({ slug: a.slug, title: a.title })),
    };
  } catch (err) {
    await record(AI_OUTCOMES.ERROR);
    logger.warn('[copilot] AI fallback failed (non-fatal)', { tenantId, message: err?.message || String(err) });
    return { unavailable: AI_UNAVAILABLE.ERROR };
  }
}

/**
 * The cheap capability probe the panel caches per session: may this tenant's
 * panel even TRY the ask endpoint? Leaks nothing but the boolean.
 */
export async function aiStatus(scope = {}, deps = {}) {
  const settings = deps.settings || settingsService;
  const tenantId = scope?.tenantId || null;
  if (!tenantId) return { enabled: false };
  try {
    const cfg = await settings.getCopilotAiConfig({ tenantId });
    return { enabled: !!cfg?.enabled && (!!cfg?.hasKey || !!cfg?.allowPlatformKeyFallback) };
  } catch {
    return { enabled: false };
  }
}
