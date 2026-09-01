/**
 * Citation OCR — a tenant with no key of its own makes NO external call.
 * (2026-08-27, the Corpusa incident.) DATA-PROTECTION PATH.
 *
 * The resolver's own unit tests (lib/tenant-provider-credential.test.mjs) pin
 * the DECISION. These pin the CONSEQUENCE, at the layer where it went wrong:
 * the scheduler sweep. The only assertion that actually settles the GDPR
 * question is "fetch was never called", so that is what this file asserts —
 * against a real `runOnce()` with a stubbed DB, not against a re-implementation
 * of the resolution logic.
 *
 * Two doors were open before the fix and both are checked here:
 *   • the scheduler's own `cfg.apiKey || process.env.ANTHROPIC_API_KEY`, and
 *   • extractCitationFields()'s SECOND, independent `|| process.env...`, which
 *     meant that even a caller that resolved "no key" still reached
 *     api.anthropic.com by passing `apiKey: null` down.
 */
import test, { beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://u:p@localhost:5432/testdb';

import { prisma } from '../../lib/prisma.js';
import logger from '../../lib/logger.js';
import { settingsService } from '../settings/settings.service.js';
import { runOnce } from './citation-ocr.scheduler.js';
import { extractCitationFields } from './citation-ocr.extract.js';

const PLATFORM_KEY = 'PLATFORM-HOUSE-CREDENTIAL-0001';
const RENT_AND_GO = { id: 'tenant-rent-and-go', name: 'Rent & Go', key: 'TENANT-OWN-CREDENTIAL-0002' };
const CORPUSA = { id: 'tenant-corpusa', name: 'Corpusa' };

// ---------------------------------------------------------------------------
// Harness — real scheduler, stubbed DB, spied fetch.
// ---------------------------------------------------------------------------

let fetchCalls = [];
let warns = [];
let ocrConfigByTenant = {};
let pendingDocsByTenant = {};
let originals = {};

function stubPrisma() {
  originals.tenantFindMany = prisma.tenant.findMany;
  originals.tenantFindUnique = prisma.tenant.findUnique;
  originals.appSettingFindUnique = prisma.appSetting.findUnique;
  originals.docFindMany = prisma.citationDocument.findMany;
  originals.docGroupBy = prisma.citationDocument.groupBy;

  prisma.tenant.findMany = async () => [{ id: RENT_AND_GO.id }, { id: CORPUSA.id }];
  prisma.tenant.findUnique = async ({ where }) => {
    if (where?.id === RENT_AND_GO.id) return { name: RENT_AND_GO.name };
    if (where?.id === CORPUSA.id) return { name: CORPUSA.name };
    return null;
  };
  // settings.service reads the tenant-scoped citationOcrConfig AppSetting row.
  prisma.appSetting.findUnique = async ({ where }) => {
    const m = /^tenant:(.+):citationOcrConfig$/.exec(String(where?.key || ''));
    if (!m) return null;
    const cfg = ocrConfigByTenant[m[1]];
    return cfg ? { key: where.key, value: JSON.stringify(cfg) } : null;
  };
  prisma.citationDocument.findMany = async ({ where }) => pendingDocsByTenant[where?.tenantId] || [];
  prisma.citationDocument.groupBy = async ({ where }) => (where?.tenantId?.in || [])
    .map((id) => ({ tenantId: id, _count: { _all: (pendingDocsByTenant[id] || []).length } }))
    .filter((r) => r._count._all > 0);
}

beforeEach(() => {
  fetchCalls = [];
  warns = [];
  ocrConfigByTenant = {};
  pendingDocsByTenant = {};
  originals = {};

  process.env.INSPECTION_PHOTOS_STORAGE_ENABLED = 'true'; // scheduler gate
  process.env.ANTHROPIC_API_KEY = PLATFORM_KEY;           // the house key IS present
  delete process.env.PLATFORM_KEY_ALLOW_CITATION_OCR;

  originals.fetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    fetchCalls.push({ url: String(url), init });
    throw new Error(`REFUSED: the test asserted no external call, but one was made to ${url}`);
  };

  originals.warn = logger.warn;
  logger.warn = (msg, meta) => { warns.push({ msg: String(msg), meta: meta || {} }); };

  stubPrisma();
});

afterEach(() => {
  globalThis.fetch = originals.fetch;
  logger.warn = originals.warn;
  prisma.tenant.findMany = originals.tenantFindMany;
  prisma.tenant.findUnique = originals.tenantFindUnique;
  prisma.appSetting.findUnique = originals.appSettingFindUnique;
  prisma.citationDocument.findMany = originals.docFindMany;
  prisma.citationDocument.groupBy = originals.docGroupBy;
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.INSPECTION_PHOTOS_STORAGE_ENABLED;
  delete process.env.PLATFORM_KEY_ALLOW_CITATION_OCR;
});

// ---------------------------------------------------------------------------
// THE ASSERTION. This is the incident, in one test.
// ---------------------------------------------------------------------------

/**
 * Counts every write the document pipeline makes. The CLAIM
 * (`citationDocument.updateMany` → status EXTRACTING) is the first thing
 * processDoc does and it happens BEFORE the storage download and before the
 * provider call — so "zero claims" is the assertion that discriminates the
 * fixed code from the broken code. `fetchCalls` alone would not: on the old
 * code the sweep also died at the un-stubbed storage layer, one step short of
 * the network, and the test would have passed for the wrong reason.
 */
function countDocWrites() {
  const state = { writes: 0 };
  state.orig = { update: prisma.citationDocument.update, updateMany: prisma.citationDocument.updateMany };
  prisma.citationDocument.update = async () => { state.writes += 1; return {}; };
  prisma.citationDocument.updateMany = async () => { state.writes += 1; return { count: 1 }; };
  state.restore = () => {
    prisma.citationDocument.update = state.orig.update;
    prisma.citationDocument.updateMany = state.orig.updateMany;
  };
  return state;
}

test('a tenant with no key of its own makes NO external call and does not even claim its documents', async () => {
  // Corpusa: citationsEnabled, documents waiting, key deliberately removed
  // 2026-08-27, no opt-in. Exactly the state that leaked 14 documents.
  pendingDocsByTenant[CORPUSA.id] = [
    { id: 'doc-1', tenantId: CORPUSA.id, bucketPath: 'citations:corpusa/1.pdf', contentType: 'application/pdf' },
  ];

  const docs = countDocWrites();
  try {
    await runOnce();
    assert.equal(docs.writes, 0, 'the pipeline never started — no claim, no download, no provider call');
    assert.deepEqual(fetchCalls, [], 'Corpusa must reach no third party at all');
  } finally {
    docs.restore();
  }
});

test('POSITIVE CONTROL: a tenant WITH a key does claim its documents — so the assertion above means something', async () => {
  // Same harness, same stubs, one difference: this tenant has a key. If this
  // test ever stops claiming, the "zero writes" assertion above has gone
  // vacuous and stops protecting anything.
  ocrConfigByTenant[CORPUSA.id] = {
    provider: 'anthropic', model: '', confidenceMin: 70,
    apiKeyEncrypted: null, allowPlatformKeyFallback: true, // opted in → PLATFORM
  };
  pendingDocsByTenant[CORPUSA.id] = [
    { id: 'doc-1', tenantId: CORPUSA.id, bucketPath: 'citations:corpusa/1.pdf', contentType: 'application/pdf' },
  ];

  const docs = countDocWrites();
  try {
    await runOnce();
    assert.ok(docs.writes > 0, 'an entitled tenant still processes its backlog');
  } finally {
    docs.restore();
  }
});

test('the skip is VISIBLE — a backlog behind a missing key is warned about by tenant', async () => {
  pendingDocsByTenant[CORPUSA.id] = [
    { id: 'doc-1', tenantId: CORPUSA.id, bucketPath: 'citations:corpusa/1.pdf', contentType: 'application/pdf' },
    { id: 'doc-2', tenantId: CORPUSA.id, bucketPath: 'citations:corpusa/2.pdf', contentType: 'application/pdf' },
  ];

  await runOnce();

  const backlog = warns.find((w) => /WAITING for tenants with no OCR credential/i.test(w.msg));
  assert.ok(backlog, 'silence is what hid the original bug — the skip must be logged');
  assert.deepEqual(backlog.meta.tenants, [{ tenantId: CORPUSA.id, pending: 2 }]);
});

test('a tenant with NO pending documents is skipped quietly — no log spam every 5 minutes', async () => {
  await runOnce();
  assert.equal(warns.filter((w) => /WAITING for tenants/i.test(w.msg)).length, 0);
});

// ---------------------------------------------------------------------------
// Do not break the working tenant.
// ---------------------------------------------------------------------------

test('Rent & Go, which has its own key, still resolves it — and never the platform key', async () => {
  ocrConfigByTenant[RENT_AND_GO.id] = { provider: 'anthropic', model: '', confidenceMin: 70, apiKeyEncrypted: null };

  // The encrypted-at-rest key is decrypted by settings.service; stub that one
  // read so this test is about resolution, not about integration-crypto (which
  // has its own suite).
  const origResolved = settingsService.getCitationOcrResolved;
  settingsService.getCitationOcrResolved = async (scope) => ({
    provider: 'anthropic',
    model: '',
    confidenceMin: 70,
    apiKey: scope?.tenantId === RENT_AND_GO.id ? RENT_AND_GO.key : null,
    allowPlatformKeyFallback: false,
  });
  try {
    const resolved = await settingsService.resolveCitationOcrCredential({ tenantId: RENT_AND_GO.id });
    assert.equal(resolved.credential.source, 'TENANT');
    assert.equal(resolved.credential.credential, RENT_AND_GO.key);

    const corpusa = await settingsService.resolveCitationOcrCredential({ tenantId: CORPUSA.id });
    assert.equal(corpusa.credential.source, 'NONE');
    assert.equal(corpusa.credential.credential, '');
  } finally {
    settingsService.getCitationOcrResolved = origResolved;
  }
});

// ---------------------------------------------------------------------------
// The opt-in doors work, and they warn.
// ---------------------------------------------------------------------------

test('the env allowlist re-opens the platform key for a named tenant, loudly', async () => {
  process.env.PLATFORM_KEY_ALLOW_CITATION_OCR = CORPUSA.id;

  const resolved = await settingsService.resolveCitationOcrCredential({ tenantId: CORPUSA.id });
  assert.equal(resolved.credential.source, 'PLATFORM');
  assert.equal(resolved.credential.credential, PLATFORM_KEY);

  const warn = warns.find((w) => /USING THE PLATFORM CREDENTIAL/i.test(w.msg));
  assert.ok(warn, 'every platform-key resolution must be named in the log');
  assert.equal(warn.meta.tenantId, CORPUSA.id);
  assert.equal(warn.meta.tenantName, CORPUSA.name, 'the tenant NAME, so a human can act on it');
  assert.equal(warn.meta.feature, 'citation-ocr');
  assert.ok(!JSON.stringify(warn).includes(PLATFORM_KEY), 'masked, never in the clear');
});

test('the per-tenant setting flag re-opens it too, and survives a partial settings PUT', async () => {
  ocrConfigByTenant[CORPUSA.id] = {
    provider: 'anthropic', model: '', confidenceMin: 70,
    apiKeyEncrypted: null, allowPlatformKeyFallback: true,
  };
  const resolved = await settingsService.resolveCitationOcrCredential({ tenantId: CORPUSA.id });
  assert.equal(resolved.credential.source, 'PLATFORM');
  assert.equal(resolved.credential.reason, 'PLATFORM_TENANT_OPT_IN');
});

test('an old AppSetting row with no flag at all reads as opted OUT', async () => {
  // Every tenant configured before 2026-08-27 is in this state. They must land
  // on the safe side of the default, not be grandfathered into the old
  // behaviour.
  ocrConfigByTenant[CORPUSA.id] = { provider: 'anthropic', model: '', confidenceMin: 70, apiKeyEncrypted: null };
  const resolved = await settingsService.resolveCitationOcrCredential({ tenantId: CORPUSA.id });
  assert.equal(resolved.credential.source, 'NONE');
});

// ---------------------------------------------------------------------------
// The extractor's own second door.
// ---------------------------------------------------------------------------

test('the extractor refuses to invent a key from env when the caller supplies none', async () => {
  await assert.rejects(
    () => extractCitationFields({
      buffer: Buffer.from('%PDF-1.4 fake'),
      contentType: 'application/pdf',
      apiKey: null,          // what a fail-closed caller passes down
      provider: 'anthropic',
    }),
    /no OCR credential supplied/i,
  );
  assert.deepEqual(fetchCalls, [], 'and it must refuse BEFORE the provider call, not after');
});

test('POSITIVE CONTROL: the extractor DOES call the provider when a key is supplied', async () => {
  // Proves the fetch spy is wired to the path under test, so "fetchCalls is
  // empty" above is a real observation and not a dead assertion.
  await assert.rejects(() => extractCitationFields({
    buffer: Buffer.from('%PDF-1.4 fake'),
    contentType: 'application/pdf',
    apiKey: RENT_AND_GO.key,
    provider: 'anthropic',
  }));
  assert.equal(fetchCalls.length, 1);
  assert.match(fetchCalls[0].url, /api\.anthropic\.com/);
  assert.equal(fetchCalls[0].init.headers['x-api-key'], RENT_AND_GO.key, 'the TENANT key, not the platform key');
});
