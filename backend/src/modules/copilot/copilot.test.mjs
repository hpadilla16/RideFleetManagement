/**
 * Agent Copilot — Phase 2 backend (2026-09-02). Run via: npm run test:copilot
 *
 * Covers, in order:
 *  A. Model discipline — the 20260904_copilot_miss migration against
 *     schema.prisma (column parity), additive/idempotent statement rules, the
 *     pinned predecessor sort, and the Supabase RLS requirement (2026-09-02):
 *     a migration that creates a table must ENABLE ROW LEVEL SECURITY on it.
 *  B. Normalization + entry sanitizing — the grouping identity.
 *  C. Miss ingest — batch cap, accepted count, tenant fail-closed, and the
 *     flagged→notification wiring (sourceType COPILOT, audienceRole ADMIN,
 *     deduped per normalized query per UTC day).
 *  D. flagMiss — flags the latest matching row, records one when none exists,
 *     always emits.
 *  E. Top misses — grouped shape + the flagged overlay.
 *  F. The AI gate, in data-safety order: OFF by default (absent config reads
 *     disabled and the ask path returns AI_DISABLED without touching the
 *     provider), NO_CREDENTIAL fails closed, the daily cap refuses BEFORE the
 *     call, no retrieved sources → no call, and the three call outcomes
 *     (ANSWERED / NO_ANSWER / ERROR) each record their AI_CALL row — the rows
 *     the cap itself counts.
 *  G. Retrieval — the keyword scorer picks the right Ride University articles
 *     for real questions, in both languages, and nothing for nonsense.
 *  H. Wiring — main.js mounts /api/copilot; the notification source whitelist
 *     knows COPILOT (and the frontend "All" lane needs no change — asserted
 *     against the lanes file itself); PLATFORM_CREDENTIAL_FEATURES registers
 *     'copilot-ask'; the settings config defaults are enabled:false / cap 200.
 *
 * DB-FREE: service calls inject a fake db; the prisma singleton is
 * monkeypatched only for the settings-config default read.
 */

// MUST be first — sets DATABASE_URL etc. before lib/prisma.js constructs.
import '../../lib/_two-factor-test-env.mjs';

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

import { prisma } from '../../lib/prisma.js';
import {
  MISS_KINDS,
  AI_OUTCOMES,
  AI_UNAVAILABLE,
  MAX_BATCH_ENTRIES,
  MAX_QUERY_CHARS,
  DEFAULT_DAILY_CALL_CAP,
  DEFAULT_COPILOT_AI_MODEL,
  AI_TOP_ARTICLES,
  normalizeQuery,
  startOfUtcDay,
  sanitizeMissEntry,
  ingestMisses,
  flagMiss,
  topMisses,
  scoreArticleForQuery,
  retrieveArticles,
  buildAiSystemPrompt,
  buildAiUserContent,
  askCopilotAi,
  askWithCredential,
  aiStatus,
} from './copilot.service.js';
import { NOTIFICATION_SOURCE_TYPES } from '../notifications/notifications-emit.js';
import { PLATFORM_CREDENTIAL_FEATURES } from '../../lib/tenant-provider-credential.js';
import { settingsService } from '../settings/settings.service.js';
import { DEFAULT_ARTICLES } from '../knowledge-base/default-articles.js';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));

// ───────────────────────── A. model / migration discipline ─────────────────

const MIGRATION_DIR = '20260904_copilot_miss';
// The migration that was newest when this one shipped. Pinned predecessor,
// not "newest in repo" — see billing-model.test.mjs for why.
const MIGRATION_PREDECESSOR = '20260903_checkin_audit';
const SQL = readFileSync(join(ROOT, 'prisma', 'migrations', MIGRATION_DIR, 'migration.sql'), 'utf8');
const SCHEMA = readFileSync(join(ROOT, 'prisma', 'schema.prisma'), 'utf8');
const STATEMENTS = SQL.replace(/^\s*--.*$/gm, '');

test('CopilotMiss: migration and schema.prisma declare the same columns', () => {
  const m = STATEMENTS.match(/CREATE TABLE IF NOT EXISTS "CopilotMiss" \(([\s\S]*?)\n\);/);
  assert.ok(m, 'migration creates CopilotMiss');
  const sqlCols = [...m[1].matchAll(/^\s*"(\w+)"/gm)].map((x) => x[1]);

  const modelMatch = SCHEMA.match(/model CopilotMiss \{([\s\S]*?)\n\}/);
  assert.ok(modelMatch, 'schema.prisma has model CopilotMiss');
  const schemaCols = [...modelMatch[1].matchAll(/^\s{2}(\w+)\s/gm)]
    .map((x) => x[1])
    .filter((c) => !c.startsWith('@'));

  assert.deepEqual(sqlCols.sort(), schemaCols.sort());
});

test('the migration sorts after its pinned predecessor and is additive/idempotent', () => {
  assert.ok(MIGRATION_DIR > MIGRATION_PREDECESSOR, 'startup-migrate applies lexicographically');
  assert.match(STATEMENTS, /CREATE TABLE IF NOT EXISTS/);
  assert.match(STATEMENTS, /CREATE INDEX IF NOT EXISTS "CopilotMiss_tenantId_kind_createdAt_idx"/);
  assert.match(STATEMENTS, /CREATE INDEX IF NOT EXISTS "CopilotMiss_tenantId_normalizedQuery_idx"/);
  // Nothing destructive, ever.
  assert.doesNotMatch(STATEMENTS, /\bDROP\b|\bDELETE\b|\bTRUNCATE\b/i);
});

test('Supabase advisor rule (2026-09-02): the new table ships with RLS enabled', () => {
  assert.match(STATEMENTS, /ALTER TABLE "CopilotMiss" ENABLE ROW LEVEL SECURITY;/);
});

// ───────────────────────── B. normalization ────────────────────────────────

test('normalizeQuery strips accents, case and punctuation into one grouping identity', () => {
  assert.equal(normalizeQuery('¿Cómo añado un CONDUCTOR adicional?'), 'como anado un conductor adicional');
  assert.equal(normalizeQuery('  cómo   añado…  '), 'como anado');
  assert.equal(normalizeQuery(''), '');
  assert.equal(normalizeQuery(null), '');
  assert.equal(normalizeQuery('x'.repeat(500)).length, MAX_QUERY_CHARS);
});

test('sanitizeMissEntry: shape, caps, and the no-question refusal', () => {
  const row = sanitizeMissEntry(
    { query: '¿Cómo configuro el descuento de AAA?', pathname: '/reservations/R-1', lang: 'es', ts: '2026-09-02T10:00:00.000Z', flagged: true },
    { tenantId: 't1', userId: 'u1' },
  );
  assert.equal(row.tenantId, 't1');
  assert.equal(row.kind, MISS_KINDS.MISS);
  assert.equal(row.query, '¿Cómo configuro el descuento de AAA?');
  assert.equal(row.normalizedQuery, 'como configuro el descuento de aaa');
  assert.equal(row.pathname, '/reservations/R-1');
  assert.equal(row.lang, 'es');
  assert.equal(row.userId, 'u1');
  assert.equal(row.flagged, true);
  assert.equal(row.askedAt.toISOString(), '2026-09-02T10:00:00.000Z');

  // Phase-1 ring-buffer field names ({q, at}) are accepted too.
  const legacy = sanitizeMissEntry({ q: 'find a car', at: '2026-09-01T00:00:00Z' }, { tenantId: 't1' });
  assert.equal(legacy.query, 'find a car');
  assert.ok(legacy.askedAt instanceof Date);

  assert.equal(sanitizeMissEntry({ query: '  ¿¿ ?? ', lang: 'es' }, { tenantId: 't1' }), null, 'no tokens = no row');
  assert.equal(sanitizeMissEntry({ lang: 'xx', query: 'hello there' }, { tenantId: 't1' }).lang, null, 'unknown lang stored as null');
});

// ───────────────────────── C. miss ingest ──────────────────────────────────

function fakeDb() {
  const state = { created: [], createManyBatches: [], updates: [], countResult: 0, findFirstResult: null, groupByResults: [], articles: [] };
  return {
    state,
    copilotMiss: {
      createMany: async ({ data }) => { state.createManyBatches.push(data); state.created.push(...data); return { count: data.length }; },
      create: async ({ data }) => { state.created.push(data); return { id: `m-${state.created.length}`, ...data }; },
      count: async () => state.countResult,
      findFirst: async () => state.findFirstResult,
      update: async ({ where, data }) => { state.updates.push({ where, data }); return { id: where.id, ...data }; },
      groupBy: async (args) => { const next = state.groupByResults.shift(); return typeof next === 'function' ? next(args) : (next || []); },
    },
    knowledgeArticle: {
      findMany: async () => state.articles,
    },
  };
}

function captureEmit() {
  const calls = [];
  const emit = async (input) => { calls.push(input); return { id: `n-${calls.length}` }; };
  return { calls, emit };
}

test('ingestMisses: rows land with the caller identity, junk entries drop, batch is capped', async () => {
  const db = fakeDb();
  const { calls, emit } = captureEmit();
  const entries = [
    { query: 'como configuro el descuento de AAA', pathname: '/reservations', lang: 'es', ts: Date.now() },
    { query: '', lang: 'es' },                       // no question — dropped
    { query: 'how do I export the fleet roster', lang: 'en' },
  ];
  const out = await ingestMisses({ entries }, { tenantId: 't1', userId: 'u9' }, { db, emit });
  assert.equal(out.accepted, 2);
  assert.equal(db.state.created.length, 2);
  assert.equal(db.state.created[0].userId, 'u9');
  assert.equal(db.state.created[0].kind, MISS_KINDS.MISS);
  assert.equal(calls.length, 0, 'nothing flagged, nothing emitted');

  // The batch cap: one full ring buffer, no more.
  const big = Array.from({ length: MAX_BATCH_ENTRIES + 30 }, (_, i) => ({ query: `question number ${i}` }));
  const capped = await ingestMisses({ entries: big }, { tenantId: 't1' }, { db: fakeDb(), emit });
  assert.equal(capped.accepted, MAX_BATCH_ENTRIES);
});

test('ingestMisses fails closed without a tenant and never writes', async () => {
  const db = fakeDb();
  const out = await ingestMisses({ entries: [{ query: 'anything at all' }] }, {}, { db });
  assert.deepEqual(out, { accepted: 0 });
  assert.equal(db.state.created.length, 0);
});

test('a flagged entry ALSO emits the admin notification — COPILOT source, ADMIN audience, per-day dedupe', async () => {
  const db = fakeDb();
  const { calls, emit } = captureEmit();
  await ingestMisses(
    { entries: [{ query: '¿Cómo configuro el descuento de AAA?', lang: 'es', flagged: true }] },
    { tenantId: 't1', userId: 'u1' },
    { db, emit, now: '2026-09-02T15:30:00Z' },
  );
  assert.equal(calls.length, 1);
  const evt = calls[0];
  assert.equal(evt.tenantId, 't1');
  assert.equal(evt.sourceType, 'COPILOT');
  assert.equal(evt.severity, 'NEEDS_ACTION');
  assert.equal(evt.audienceRole, 'ADMIN');
  assert.equal(evt.dedupeKey, 'copilot-miss:como configuro el descuento de aaa:2026-09-02');
  assert.match(evt.title, /¿Cómo configuro el descuento de AAA\?/);
  assert.match(evt.deepLink, /^\/knowledge-base\?search=/);
});

// ───────────────────────── D. flagMiss ─────────────────────────────────────

test('flagMiss flags the latest matching row and emits; records a row when none exists', async () => {
  const db = fakeDb();
  db.state.findFirstResult = { id: 'm-77' };
  const { calls, emit } = captureEmit();
  const out = await flagMiss({ query: 'descuento de AAA', lang: 'es' }, { tenantId: 't1', userId: 'u1' }, { db, emit });
  assert.deepEqual(out, { ok: true });
  assert.deepEqual(db.state.updates, [{ where: { id: 'm-77' }, data: { flagged: true } }]);
  assert.equal(db.state.created.length, 0, 'existing row updated, not duplicated');
  assert.equal(calls.length, 1);

  const db2 = fakeDb();
  await flagMiss({ query: 'descuento de AAA', lang: 'es' }, { tenantId: 't1' }, { db: db2, emit });
  assert.equal(db2.state.created.length, 1, 'no prior row — the flag itself records the miss');
  assert.equal(db2.state.created[0].flagged, true);
});

// ───────────────────────── E. top misses ───────────────────────────────────

test('topMisses groups by normalized query with counts, last-seen and the flagged overlay', async () => {
  const db = fakeDb();
  db.state.groupByResults = [
    [
      { normalizedQuery: 'como configuro el descuento de aaa', _count: { _all: 7 }, _max: { createdAt: new Date('2026-09-02T12:00:00Z'), query: '¿Cómo configuro el descuento de AAA?' } },
      { normalizedQuery: 'export fleet roster', _count: { _all: 2 }, _max: { createdAt: new Date('2026-09-01T09:00:00Z'), query: 'export fleet roster' } },
    ],
    [
      { normalizedQuery: 'como configuro el descuento de aaa', _count: { _all: 1 } },
    ],
  ];
  const out = await topMisses({ days: 30 }, { tenantId: 't1' }, { db });
  assert.equal(out.days, 30);
  assert.equal(out.items.length, 2);
  assert.equal(out.items[0].query, '¿Cómo configuro el descuento de AAA?');
  assert.equal(out.items[0].count, 7);
  assert.equal(out.items[0].flagged, true);
  assert.equal(out.items[1].flagged, false);
});

test('topMisses fails closed without a tenant', async () => {
  assert.deepEqual(await topMisses({}, {}, { db: fakeDb() }), { items: [] });
});

// ───────────────────────── F. the AI gate ──────────────────────────────────

const neverFetch = async () => { throw new Error('the provider must not be called on this path'); };

test('config default is OFF: an absent AppSetting row reads enabled:false, cap 200', async () => {
  const orig = prisma.appSetting.findUnique;
  prisma.appSetting.findUnique = async () => null;
  try {
    const cfg = await settingsService.getCopilotAiConfig({ tenantId: 't1' });
    assert.equal(cfg.enabled, false);
    assert.equal(cfg.dailyCallCap, DEFAULT_DAILY_CALL_CAP);
    assert.equal(cfg.hasKey, false);
    assert.equal(cfg.allowPlatformKeyFallback, false);
  } finally {
    prisma.appSetting.findUnique = orig;
  }
});

test('askCopilotAi with the gate OFF returns AI_DISABLED before any db/provider work — Phase 1 behavior exactly', async () => {
  const settings = { getCopilotAiConfig: async () => ({ enabled: false }) };
  const out = await askCopilotAi(
    { query: 'como configuro el descuento', lang: 'es' },
    { tenantId: 't1' },
    { settings, db: null /* would crash if touched */, fetchImpl: neverFetch },
  );
  assert.deepEqual(out, { unavailable: AI_UNAVAILABLE.DISABLED });
});

test('enabled but no credential resolves → NO_CREDENTIAL, fail closed, no call', async () => {
  const settings = {
    getCopilotAiConfig: async () => ({ enabled: true, dailyCallCap: 200 }),
    resolveCopilotAiCredential: async () => ({ credential: { credential: '', source: 'NONE', reason: 'NO_TENANT_CREDENTIAL' } }),
  };
  const out = await askCopilotAi({ query: 'toll charges', lang: 'en' }, { tenantId: 't1' }, { settings, db: null, fetchImpl: neverFetch });
  assert.deepEqual(out, { unavailable: AI_UNAVAILABLE.NO_CREDENTIAL });
});

const RESOLVED = { credential: { credential: 'sk-test-key', source: 'TENANT', reason: 'TENANT_CREDENTIAL' } };

test('the daily cap refuses BEFORE the provider call and records nothing', async () => {
  const db = fakeDb();
  db.state.countResult = 200;
  const out = await askWithCredential({
    db, fetchImpl: neverFetch, now: new Date('2026-09-02T18:00:00Z'),
    tenantId: 't1', query: 'toll charges', lang: 'en',
    cfg: { dailyCallCap: 200 }, resolved: RESOLVED,
  });
  assert.deepEqual(out, { unavailable: AI_UNAVAILABLE.CAP_EXCEEDED });
  assert.equal(db.state.created.length, 0, 'a capped attempt must not grow the count that caps it');
});

test('no retrieved sources → NO_SOURCES, and no call (the never-invents guardrail)', async () => {
  const db = fakeDb();
  db.state.articles = DEFAULT_ARTICLES.map(({ title, slug, body, tags }) => ({ title, slug, body, tags }));
  const out = await askWithCredential({
    db, fetchImpl: neverFetch, now: new Date(),
    tenantId: 't1', query: 'zzz qqq xyzzy plugh', lang: 'en',
    cfg: {}, resolved: RESOLVED,
  });
  assert.deepEqual(out, { unavailable: AI_UNAVAILABLE.NO_SOURCES });
  assert.equal(db.state.created.length, 0);
});

function anthropicOk(text) {
  return async (url, init) => {
    anthropicOk.lastUrl = url;
    anthropicOk.lastInit = init;
    return {
      ok: true,
      json: async () => ({ content: [{ type: 'text', text }] }),
    };
  };
}

test('an answered call returns the text + cited sources and records the AI_CALL row the cap counts', async () => {
  const db = fakeDb();
  db.state.articles = DEFAULT_ARTICLES.map(({ title, slug, body, tags }) => ({ title, slug, body, tags }));
  db.state.countResult = 3; // under the cap
  const fetchImpl = anthropicOk('Los peajes se procesan desde la pantalla de Tolls.\nSource: Processing Toll Charges');
  const out = await askWithCredential({
    db, fetchImpl, now: new Date('2026-09-02T18:00:00Z'),
    tenantId: 't1', query: 'how do I process toll charges', lang: 'es',
    cfg: { model: '' }, resolved: RESOLVED,
  });
  assert.match(out.answer, /Tolls/);
  assert.equal(out.model, DEFAULT_COPILOT_AI_MODEL);
  assert.ok(out.sources.length >= 1 && out.sources.length <= AI_TOP_ARTICLES);
  assert.equal(out.sources[0].slug, 'processing-toll-charges', 'the top-scored article leads the citations');

  // The spend-guard row.
  assert.equal(db.state.created.length, 1);
  assert.equal(db.state.created[0].kind, MISS_KINDS.AI_CALL);
  assert.equal(db.state.created[0].aiOutcome, AI_OUTCOMES.ANSWERED);

  // The call itself: tenant key in the header, cap on output tokens, and the
  // tight system prompt.
  const body = JSON.parse(anthropicOk.lastInit.body);
  assert.equal(anthropicOk.lastInit.headers['x-api-key'], 'sk-test-key');
  assert.equal(body.max_tokens, 300);
  assert.match(body.system, /Answer ONLY from the excerpts provided/);
  assert.match(body.system, /NO_ANSWER/);
  assert.match(body.system, /Spanish/);
  assert.match(body.system, /cannot perform actions/);
});

test('a NO_ANSWER reply degrades to unavailable and records outcome NO_ANSWER', async () => {
  const db = fakeDb();
  db.state.articles = DEFAULT_ARTICLES.map(({ title, slug, body, tags }) => ({ title, slug, body, tags }));
  const out = await askWithCredential({
    db, fetchImpl: anthropicOk('NO_ANSWER'), now: new Date(),
    tenantId: 't1', query: 'toll charges', lang: 'en',
    cfg: {}, resolved: RESOLVED,
  });
  assert.deepEqual(out, { unavailable: AI_UNAVAILABLE.NO_ANSWER });
  assert.equal(db.state.created[0].aiOutcome, AI_OUTCOMES.NO_ANSWER);
});

test('a provider error is swallowed into unavailable:ERROR and recorded — the panel falls back to Phase 1', async () => {
  const db = fakeDb();
  db.state.articles = DEFAULT_ARTICLES.map(({ title, slug, body, tags }) => ({ title, slug, body, tags }));
  const fetchImpl = async () => ({ ok: false, status: 529, text: async () => 'overloaded' });
  const out = await askWithCredential({
    db, fetchImpl, now: new Date(),
    tenantId: 't1', query: 'toll charges', lang: 'en',
    cfg: {}, resolved: RESOLVED,
  });
  assert.deepEqual(out, { unavailable: AI_UNAVAILABLE.ERROR });
  assert.equal(db.state.created[0].aiOutcome, AI_OUTCOMES.ERROR);

  const db2 = fakeDb();
  db2.state.articles = db.state.articles;
  const thrown = await askWithCredential({
    db: db2, fetchImpl: async () => { throw new Error('ECONNRESET'); }, now: new Date(),
    tenantId: 't1', query: 'toll charges', lang: 'en',
    cfg: {}, resolved: RESOLVED,
  });
  assert.deepEqual(thrown, { unavailable: AI_UNAVAILABLE.ERROR });
  assert.equal(db2.state.created[0].aiOutcome, AI_OUTCOMES.ERROR);
});

test('aiStatus leaks only the boolean, and only says yes when a key could actually resolve', async () => {
  const mk = (cfg) => ({ getCopilotAiConfig: async () => cfg });
  assert.deepEqual(await aiStatus({ tenantId: 't1' }, { settings: mk({ enabled: false, hasKey: true }) }), { enabled: false });
  assert.deepEqual(await aiStatus({ tenantId: 't1' }, { settings: mk({ enabled: true, hasKey: false, allowPlatformKeyFallback: false }) }), { enabled: false });
  assert.deepEqual(await aiStatus({ tenantId: 't1' }, { settings: mk({ enabled: true, hasKey: true }) }), { enabled: true });
  assert.deepEqual(await aiStatus({ tenantId: 't1' }, { settings: mk({ enabled: true, hasKey: false, allowPlatformKeyFallback: true }) }), { enabled: true });
  assert.deepEqual(await aiStatus({}, {}), { enabled: false });
});

// ───────────────────────── G. retrieval ────────────────────────────────────

const CORPUS = DEFAULT_ARTICLES.map(({ title, slug, body, tags }) => ({ title, slug, body, tags }));

test('retrieval picks the right articles for real questions, both languages', () => {
  const tolls = retrieveArticles(CORPUS, 'how do I process toll charges');
  assert.equal(tolls[0]?.slug, 'processing-toll-charges');

  const checkout = retrieveArticles(CORPUS, 'como hago el checkout de un vehiculo');
  assert.equal(checkout[0]?.slug, 'how-to-checkout');

  const citations = retrieveArticles(CORPUS, 'multa de transito del carro');
  assert.ok(citations.some((a) => a.slug === 'handling-citations'), 'citations article retrieved');

  const monthly = retrieveArticles(CORPUS, 'monthly long term rental billing');
  assert.equal(monthly[0]?.slug, 'long-term-and-monthly-rentals');
});

test('retrieval returns at most top-3 and nothing for nonsense', () => {
  assert.ok(retrieveArticles(CORPUS, 'vehicle payment checkout process').length <= AI_TOP_ARTICLES);
  assert.deepEqual(retrieveArticles(CORPUS, 'xyzzy plugh frobnicate'), []);
  assert.deepEqual(retrieveArticles(CORPUS, ''), []);
  assert.equal(scoreArticleForQuery(CORPUS[0], []), 0);
});

test('the user content carries the excerpts and the question, capped', () => {
  const content = buildAiUserContent('how do I process tolls', CORPUS.slice(0, 2));
  assert.match(content, /ARTICLE 1: /);
  assert.match(content, /STAFF QUESTION: how do I process tolls/);
  const en = buildAiSystemPrompt('en');
  assert.match(en, /English/);
  assert.doesNotMatch(en, /Spanish/);
});

// ───────────────────────── H. wiring ───────────────────────────────────────

test('main.js mounts /api/copilot with requireAuth + tenantRateLimit and no module gate', () => {
  const main = readFileSync(join(ROOT, 'src', 'main.js'), 'utf8');
  assert.match(main, /app\.use\('\/api\/copilot', requireAuth, tenantRateLimit, copilotRouter\);/);
});

test('the notification source whitelist knows COPILOT', () => {
  assert.ok(NOTIFICATION_SOURCE_TYPES.includes('COPILOT'));
});

test("the frontend lanes file needs no COPILOT lane — the 'all' lane filter is {} and shows every source", () => {
  // The Phase 2 instruction was explicit: do NOT touch notification-lanes.js.
  // This pins the assumption that makes that safe: the everything/all lane
  // filters by nothing, so unknown sourceTypes surface there.
  const lanes = readFileSync(join(ROOT, '..', 'frontend', 'src', 'lib', 'notification-lanes.js'), 'utf8');
  assert.match(lanes, /id: 'all', filter: \{\}/);
  assert.doesNotMatch(lanes, /COPILOT/);
});

test("PLATFORM_CREDENTIAL_FEATURES registers 'copilot-ask' — the provider-call inventory stays complete", () => {
  const feature = PLATFORM_CREDENTIAL_FEATURES['copilot-ask'];
  assert.ok(feature, 'feature registered');
  assert.equal(feature.envVar, 'ANTHROPIC_API_KEY');
});

test('normalizeQuery day-key helper: the UTC day boundary the dedupe and the cap share', () => {
  const d = startOfUtcDay(new Date('2026-09-02T23:59:59.999Z'));
  assert.equal(d.toISOString(), '2026-09-02T00:00:00.000Z');
});

test('settings routes expose the copilot-ai config panel (GET open, PUT admin)', () => {
  const routes = readFileSync(join(ROOT, 'src', 'modules', 'settings', 'settings.routes.js'), 'utf8');
  assert.match(routes, /settingsRouter\.get\('\/copilot-ai'/);
  assert.match(routes, /settingsRouter\.put\('\/copilot-ai', requireRole\('ADMIN'\)/);
});
