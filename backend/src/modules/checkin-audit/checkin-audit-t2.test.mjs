/**
 * Post-check-in audit — Tier 2 photo AI (2026-09-02). Run via:
 * npm run test:checkin-audit (chained after the T1 file).
 *
 * Covers, in order:
 *  A. The extractor contract — prompt carries the angle, the strict JSON
 *     shape, the known-damage context ("do NOT report these" + KNOWN_DAMAGE/
 *     matchedKnownIds) only when entries exist; verdict normalization clamps
 *     garbage to UNREADABLE instead of throwing; the credential is refused
 *     when absent (NO provider call) and there is no env fallback anywhere in
 *     the file (the Corpusa discipline, tested the way
 *     citation-ocr-no-platform-key does).
 *  B. Severity mapping — >=70 ERROR, 40-69 WARN, <40 discard.
 *  C. Pairing — angle-keyed dictionary join over photoStorageRefs; angles
 *     missing on either side are named, external URLs are not downloadable
 *     bytes, canonical-slot normalization applies.
 *  D. Known-damage context — HARD_APPROVED-for-this-view only, capped.
 *  E. The sweep (fake db, mock LLM — no real API calls):
 *     kill switch, config-off silence, credential-missing clean skip,
 *     the happy path (findings + notification + scan record), WARN band,
 *     sub-40 discard-but-record, KNOWN_DAMAGE lastVerifiedAt stamping
 *     (annotate never suppress), budget stop with the explicit SKIPPED_BUDGET
 *     marker, idempotence (no double verdict per close), missing-photo skip.
 *  F. Queue projection — buildT2Summary; T2_SCAN is metadata, not a lane row.
 *  G. The dismiss fork on a REAL T2 finding — one-click PREEXISTING derives
 *     view/dot/description/photo from the finding's own details (region
 *     center, check-in photo bytes → data URL) through the existing
 *     manual-damage path.
 *  H. Wiring — worker starts the scheduler, settings routes expose the
 *     config, the credential feature registry names 'checkin-audit', and the
 *     config surface defaults photo AI OFF.
 */

// MUST be first — sets DATABASE_URL etc. before lib/prisma.js constructs.
import '../../lib/_two-factor-test-env.mjs';

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

import {
  buildPairPrompt,
  normalizeVerdict,
  analyzePhotoPair,
  estimateCostUsd,
  PAIR_VERDICTS,
} from './checkin-audit-t2.extract.js';
import {
  T2_SCAN_CHECK_KEY,
  DAMAGE_SUSPECTED_PREFIX,
  ANGLE_TO_VIEW,
  DEFAULT_T2_CONFIG,
  normalizeCheckinAuditT2Config,
  severityForConfidence,
  pairInspectionRefs,
  knownDamagesForAngle,
  runT2SweepOnce,
} from './checkin-audit-t2.service.js';
import { buildT2Summary, dismissFinding } from './checkin-audit.service.js';
import { PLATFORM_CREDENTIAL_FEATURES } from '../../lib/tenant-provider-credential.js';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const SRC = join(ROOT, 'src');

// ───────────────────────── A. extractor contract ────────────────────────────

test('prompt: names the angle, demands minified JSON with the verdict schema, forbids inventing', () => {
  const p = buildPairPrompt({ angle: 'rear' });
  assert.match(p, /SAME vehicle angle \(rear\)/);
  assert.match(p, /NO_CHANGE\|POSSIBLE_DAMAGE\|KNOWN_DAMAGE\|UNREADABLE/);
  assert.match(p, /"confidence":0-100/);
  assert.match(p, /matchedKnownIds/);
  assert.match(p, /Never invent/);
  assert.match(p, /pointer, not a measurement/);
  assert.match(p, /Never estimate cost/);
  assert.ok(!p.includes('Known pre-existing damage'), 'no known block when the ledger is empty');
});

test('prompt: the known-damage ledger context ANNOTATES — listed with ids, routed to KNOWN_DAMAGE, never a silent filter', () => {
  const p = buildPairPrompt({
    angle: 'rear',
    knownDamages: [
      { id: 'kd-1', description: '15 cm scuff, lower-left rear bumper', sinceDate: '2026-06-12' },
      { id: 'kd-2', description: 'door-edge chip', sinceDate: null },
    ],
  });
  assert.match(p, /Known pre-existing damage on this vehicle, this view — these are already documented, do NOT report them as new:/);
  assert.match(p, /\[kd-1\] 15 cm scuff, lower-left rear bumper, on record since 2026-06-12/);
  assert.match(p, /\[kd-2\] door-edge chip/);
  assert.match(p, /return verdict "KNOWN_DAMAGE" with its id\(s\) in matchedKnownIds/);
  assert.match(p, /neither in photo 1 nor in the known list/);
});

test('normalizeVerdict: clamps confidence/region, filters kinds, degrades garbage to UNREADABLE', () => {
  const good = normalizeVerdict({
    verdict: 'possible_damage', confidence: 77.6,
    description: 'scuff', region: { x: 0.1, y: 1.4, w: 0.2, h: -0.1 },
    kind: 'scuff', matchedKnownIds: ['a', '', 3],
  });
  assert.equal(good.verdict, 'POSSIBLE_DAMAGE');
  assert.equal(good.confidence, 78);
  assert.deepEqual(good.region, { x: 0.1, y: 1, w: 0.2, h: 0 });
  assert.equal(good.kind, 'scuff');
  assert.deepEqual(good.matchedKnownIds, ['a', '3']);

  const junk = normalizeVerdict({ verdict: 'MAYBE', confidence: 'lots', kind: 'vibes', region: { x: 'a' } });
  assert.equal(junk.verdict, 'UNREADABLE');
  assert.equal(junk.confidence, 0);
  assert.equal(junk.region, null);
  assert.equal(junk.kind, null);
  assert.deepEqual(PAIR_VERDICTS.slice().sort(), ['KNOWN_DAMAGE', 'NO_CHANGE', 'POSSIBLE_DAMAGE', 'UNREADABLE']);
});

test('analyzePhotoPair: refuses with no credential — the provider is never reached', async () => {
  let fetched = 0;
  await assert.rejects(
    analyzePhotoPair({
      checkoutBuffer: Buffer.from('a'), checkinBuffer: Buffer.from('b'),
      angle: 'front', apiKey: '', fetchImpl: async () => { fetched += 1; },
    }),
    /no photo-AI credential supplied/,
  );
  assert.equal(fetched, 0);
  await assert.rejects(
    analyzePhotoPair({ checkoutBuffer: Buffer.alloc(0), checkinBuffer: Buffer.from('b'), apiKey: 'k' }),
    /empty photo buffer/,
  );
});

test('analyzePhotoPair: sends both images + prompt, returns normalized verdict with usage and cost estimate', async () => {
  let captured = null;
  const out = await analyzePhotoPair({
    checkoutBuffer: Buffer.from('out-bytes'), checkoutContentType: 'image/jpeg',
    checkinBuffer: Buffer.from('in-bytes'), checkinContentType: 'image/png',
    angle: 'rear',
    knownDamages: [{ id: 'kd-1', description: 'old scuff', sinceDate: '2026-06-12' }],
    apiKey: 'sk-test', model: 'claude-haiku-4-5-20251001',
    fetchImpl: async (url, opts) => {
      captured = { url, body: JSON.parse(opts.body), headers: opts.headers };
      return {
        ok: true,
        json: async () => ({
          content: [{ type: 'text', text: '{"verdict":"POSSIBLE_DAMAGE","confidence":78,"description":"light scuff","region":{"x":0.14,"y":0.59,"w":0.24,"h":0.19},"kind":"scuff","matchedKnownIds":[]}' }],
          usage: { input_tokens: 3000, output_tokens: 100 },
        }),
      };
    },
  });
  assert.equal(captured.url, 'https://api.anthropic.com/v1/messages');
  assert.equal(captured.headers['x-api-key'], 'sk-test');
  const content = captured.body.messages[0].content;
  assert.equal(content[0].type, 'image');
  assert.equal(content[0].source.media_type, 'image/jpeg');
  assert.equal(content[1].type, 'image');
  assert.equal(content[1].source.media_type, 'image/png');
  assert.match(content[2].text, /\[kd-1\] old scuff/);
  assert.equal(out.verdict, 'POSSIBLE_DAMAGE');
  assert.equal(out.confidence, 78);
  assert.deepEqual(out.usage, { inputTokens: 3000, outputTokens: 100 });
  assert.equal(out.estimatedCostUsd, estimateCostUsd('claude-haiku-4-5-20251001', 3000, 100));
});

test('analyzePhotoPair: model prose (not JSON) degrades to UNREADABLE — never throws mid-sweep', async () => {
  const out = await analyzePhotoPair({
    checkoutBuffer: Buffer.from('a'), checkinBuffer: Buffer.from('b'),
    angle: 'front', apiKey: 'k',
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({ content: [{ type: 'text', text: 'I see two photos of a car.' }], usage: { input_tokens: 10, output_tokens: 5 } }),
    }),
  });
  assert.equal(out.verdict, 'UNREADABLE');
});

test('cost estimate follows the NOTES rate table (haiku $1/$5, sonnet $3/$15 per M)', () => {
  assert.equal(estimateCostUsd('claude-haiku-4-5-20251001', 1_000_000, 0), 1);
  assert.equal(estimateCostUsd('claude-haiku-4-5-20251001', 0, 1_000_000), 5);
  assert.equal(estimateCostUsd('claude-sonnet-4-6', 1_000_000, 1_000_000), 18);
  // Unknown model estimates at the Haiku floor rather than lying with $0.
  assert.ok(estimateCostUsd('some-future-model', 1_000_000, 0) > 0);
});

test('DISCIPLINE: no env credential fallback in any T2 file — the resolver is the only door', () => {
  const stripComments = (s) => s.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
  for (const rel of [
    'modules/checkin-audit/checkin-audit-t2.extract.js',
    'modules/checkin-audit/checkin-audit-t2.service.js',
  ]) {
    const src = stripComments(readFileSync(join(SRC, rel), 'utf8'));
    assert.ok(!src.includes('process.env.ANTHROPIC_API_KEY'), `${rel} must never read the platform key from env`);
  }
  const svc = readFileSync(join(SRC, 'modules/checkin-audit/checkin-audit-t2.service.js'), 'utf8');
  assert.match(svc, /resolveCitationOcrCredential\(scope, \{ feature: 'checkin-audit' \}\)/, 'the one credential read, with the audit feature key');
});

// ───────────────────────── B. severity mapping ──────────────────────────────

test('severity from confidence: >=70 ERROR, 40-69 WARN, <40 discard', () => {
  assert.equal(severityForConfidence(100), 'ERROR');
  assert.equal(severityForConfidence(70), 'ERROR');
  assert.equal(severityForConfidence(69), 'WARN');
  assert.equal(severityForConfidence(40), 'WARN');
  assert.equal(severityForConfidence(39), null);
  assert.equal(severityForConfidence(0), null);
  assert.equal(severityForConfidence('x'), null);
});

test('T2 config defaults: photo AI OFF, 100 check-ins/day, Haiku', () => {
  assert.deepEqual(normalizeCheckinAuditT2Config(null), { ...DEFAULT_T2_CONFIG });
  assert.equal(DEFAULT_T2_CONFIG.photoAiEnabled, false);
  assert.equal(DEFAULT_T2_CONFIG.dailyPhotoBudget, 100);
  assert.equal(DEFAULT_T2_CONFIG.photoAiModel, 'claude-haiku-4-5-20251001');
  const c = normalizeCheckinAuditT2Config({ photoAiEnabled: true, dailyPhotoBudget: '25.9', photoAiModel: ' custom ' });
  assert.deepEqual(c, { photoAiEnabled: true, dailyPhotoBudget: 25, photoAiModel: 'custom' });
  // photoAiEnabled must be literal true — 'yes'/1 read as OFF (fail closed).
  assert.equal(normalizeCheckinAuditT2Config({ photoAiEnabled: 'yes' }).photoAiEnabled, false);
});

// ───────────────────────── C. pairing ───────────────────────────────────────

const ref = (key, path) => ({ key, path, contentType: 'image/jpeg', uploadedAt: '2026-08-29T13:42:00Z' });

test('pairing: dictionary join by canonical angle; missing sides are NAMED, never guessed', () => {
  const checkout = { photoStorageRefs: [ref('front', 'o/front.jpg'), ref('rear', 'o/rear.jpg'), ref('left', 'o/left.jpg')] };
  const checkin = { photoStorageRefs: [ref('front', 'i/front.jpg'), ref('rear', 'i/rear.jpg'), ref('trunk', 'i/trunk.jpg')] };
  const { pairs, missing } = pairInspectionRefs(checkout, checkin);
  assert.deepEqual(pairs.map((p) => p.angle), ['front', 'rear']);
  assert.equal(pairs[1].checkoutRef.path, 'o/rear.jpg');
  assert.equal(pairs[1].checkinRef.path, 'i/rear.jpg');
  assert.deepEqual(missing, ['left', 'right', 'frontSeat', 'rearSeat', 'dashboard', 'trunk']);
});

test('pairing: snake_case slots canonicalize; external URL refs are not downloadable bytes; null inspections pair nothing', () => {
  const checkout = { photoStorageRefs: [ref('front_seat', 'o/fs.jpg')] };
  const checkin = { photoStorageRefs: [ref('frontSeat', 'i/fs.jpg'), { key: 'rear', url: 'https://x/y.jpg', external: true }] };
  const { pairs, missing } = pairInspectionRefs(checkout, checkin);
  assert.deepEqual(pairs.map((p) => p.angle), ['frontSeat']);
  assert.ok(missing.includes('rear'));
  assert.deepEqual(pairInspectionRefs(null, null).pairs, []);
  assert.equal(pairInspectionRefs(null, null).missing.length, 8);
});

// ───────────────────────── D. known-damage context ──────────────────────────

test('knownDamagesForAngle: filters by the angle→view map, caps at 6', () => {
  const mk = (id, view) => ({ id, view, description: `d-${id}`, createdAt: '2026-06-12T00:00:00Z' });
  const ledger = [mk('a', 'REAR'), mk('b', 'FRONT'), mk('c', 'INTERIOR'), mk('d', 'REAR')];
  const rear = knownDamagesForAngle(ledger, 'rear');
  assert.deepEqual(rear.map((k) => k.id), ['a', 'd']);
  assert.equal(rear[0].sinceDate, '2026-06-12');
  assert.deepEqual(knownDamagesForAngle(ledger, 'dashboard').map((k) => k.id), ['c']);
  assert.deepEqual(knownDamagesForAngle(ledger, 'nope'), []);
  const many = Array.from({ length: 10 }, (_, i) => mk(`m${i}`, 'REAR'));
  assert.equal(knownDamagesForAngle(many, 'rear').length, 6);
  assert.equal(ANGLE_TO_VIEW.frontSeat, 'INTERIOR');
});

// ───────────────────────── E. the sweep ─────────────────────────────────────

function makeSweepDb({ settings = [], t1Rows = [], inspections = [], ledger = [], scanRows = [] } = {}) {
  const state = {
    findings: new Map(), // `${reservationId}|${checkKey}` → row
    ledgerUpdates: [],
    nextId: 1,
  };
  for (const s of scanRows) state.findings.set(`${s.reservationId}|${s.checkKey}`, { ...s });
  const rowsArr = () => [...state.findings.values()];
  const db = {
    appSetting: { findMany: async () => settings },
    rentalAgreementInspection: {
      findMany: async ({ where }) => inspections.filter((i) => i.rentalAgreementId === where.rentalAgreementId)
        .map(({ rentalAgreementId, ...rest }) => rest),
    },
    vehicleDamageReport: {
      findMany: async ({ where }) => ledger.filter((l) => l.vehicleId === where.vehicleId && l.status === where.status),
      updateMany: async (args) => { state.ledgerUpdates.push(args); return { count: 1 }; },
    },
    checkinAuditFinding: {
      count: async ({ where }) => rowsArr().filter((r) => (
        r.tenantId === where.tenantId
        && r.checkKey === where.checkKey
        && (!where.createdAt?.gte || new Date(r.createdAt) >= new Date(where.createdAt.gte))
        && (!where.resolution?.notIn || !where.resolution.notIn.includes(r.resolution))
      )).length,
      findMany: async ({ where }) => {
        if (where.tier === 'T1') {
          const seen = new Set();
          return t1Rows.filter((r) => r.tenantId === where.tenantId && (seen.has(r.reservationId) ? false : seen.add(r.reservationId)));
        }
        if (where.checkKey === T2_SCAN_CHECK_KEY) {
          return rowsArr().filter((r) => r.checkKey === T2_SCAN_CHECK_KEY
            && (!where.reservationId?.in || where.reservationId.in.includes(r.reservationId)));
        }
        return [];
      },
      create: async ({ data }) => {
        const key = `${data.reservationId}|${data.checkKey}`;
        if (state.findings.has(key)) {
          const e = new Error('Unique constraint failed'); e.code = 'P2002'; throw e;
        }
        const row = { id: `f-${state.nextId++}`, createdAt: new Date().toISOString(), ...data };
        state.findings.set(key, row);
        return row;
      },
      update: async ({ where, data }) => {
        const row = rowsArr().find((r) => r.id === where.id);
        if (!row) throw new Error('not found');
        Object.assign(row, data);
        return row;
      },
      upsert: async ({ where, create }) => {
        const key = `${where.reservationId_checkKey.reservationId}|${where.reservationId_checkKey.checkKey}`;
        if (state.findings.has(key)) return state.findings.get(key); // update:{} — first wins
        const row = { id: `f-${state.nextId++}`, createdAt: new Date().toISOString(), ...create };
        state.findings.set(key, row);
        return row;
      },
    },
  };
  return { db, state };
}

const TENANT_CFG_ROW = { key: 'tenant:t1:checkinAuditConfig', value: JSON.stringify({ photoAiEnabled: true, dailyPhotoBudget: 100 }) };
const T1_ROW = {
  tenantId: 't1', reservationId: 'res-2417', rentalAgreementId: 'ra-1', vehicleId: 'veh-1',
  locationId: 'loc-1', reservationNumber: 'RSV-2417', vehicleLabel: 'Toyota Corolla · ABC-124',
  closedByUserId: 'u-1', closedByName: 'M. Rivera', returnedAt: '2026-08-29T13:42:00Z',
};
const BOTH_SIDES = [
  { rentalAgreementId: 'ra-1', phase: 'CHECKOUT', photoStorageRefs: [ref('front', 'o/front.jpg'), ref('rear', 'o/rear.jpg')], capturedAt: '2026-08-24T19:15:00Z' },
  { rentalAgreementId: 'ra-1', phase: 'CHECKIN', photoStorageRefs: [ref('front', 'i/front.jpg'), ref('rear', 'i/rear.jpg')], capturedAt: '2026-08-29T13:42:00Z' },
];

const okDeps = (db, overrides = {}) => ({
  db,
  storageEnabled: () => true,
  bucket: 'test-bucket',
  download: async ({ path }) => ({ body: Buffer.from(`bytes:${path}`), contentType: 'image/jpeg' }),
  resolveCredential: async () => ({ provider: 'anthropic', model: '', credential: { credential: 'sk-tenant', source: 'TENANT' } }),
  analyze: async () => ({ verdict: 'NO_CHANGE', confidence: 95, description: null, region: null, kind: null, matchedKnownIds: [], usage: { inputTokens: 100, outputTokens: 10 }, estimatedCostUsd: 0.001 }),
  emit: async () => {},
  ...overrides,
});

test('sweep: kill switch CHECKIN_AUDIT_T2_ENABLED=false is a hard no-op', async () => {
  const { db } = makeSweepDb({ settings: [TENANT_CFG_ROW], t1Rows: [T1_ROW] });
  process.env.CHECKIN_AUDIT_T2_ENABLED = 'false';
  try {
    let analyzed = 0;
    const out = await runT2SweepOnce(okDeps(db, { analyze: async () => { analyzed += 1; } }));
    assert.equal(out, null);
    assert.equal(analyzed, 0);
  } finally {
    delete process.env.CHECKIN_AUDIT_T2_ENABLED;
  }
});

test('sweep: config-off silence — no tenant opted in (incl. the UNSCOPED key) → zero provider calls, zero rows', async () => {
  const { db, state } = makeSweepDb({
    settings: [
      { key: 'tenant:t1:checkinAuditConfig', value: JSON.stringify({ rulesEnabled: true }) }, // T1-only tenant
      { key: 'checkinAuditConfig', value: JSON.stringify({ photoAiEnabled: true }) }, // global key is NOT an opt-in
      { key: 'tenant:t2:checkinAuditConfig', value: 'not-json{' }, // unparseable reads OFF
    ],
    t1Rows: [T1_ROW],
  });
  let analyzed = 0;
  const out = await runT2SweepOnce(okDeps(db, { analyze: async () => { analyzed += 1; } }));
  assert.deepEqual(out, { tenants: 0 });
  assert.equal(analyzed, 0);
  assert.equal(state.findings.size, 0);
});

test('sweep: credential NONE = clean skip — no scan row, no provider call, closes stay pending', async () => {
  const { db, state } = makeSweepDb({ settings: [TENANT_CFG_ROW], t1Rows: [T1_ROW], inspections: BOTH_SIDES });
  let analyzed = 0;
  const out = await runT2SweepOnce(okDeps(db, {
    resolveCredential: async () => ({ provider: 'anthropic', model: '', credential: { credential: '', source: 'NONE', reason: 'NO_TENANT_CREDENTIAL' } }),
    analyze: async () => { analyzed += 1; },
  }));
  assert.equal(out.waitingOnCredential, 1);
  assert.equal(analyzed, 0);
  assert.equal(state.findings.size, 0, 'nothing claimed — the close processes the moment a key exists');
});

test('sweep happy path: pairs analyzed with ledger context, DAMAGE_SUSPECTED finding at 78% = ERROR + NEEDS_ACTION notification, scan record keeps EVERY verdict', async () => {
  const { db, state } = makeSweepDb({
    settings: [TENANT_CFG_ROW],
    t1Rows: [T1_ROW],
    inspections: BOTH_SIDES,
    ledger: [{ id: 'kd-1', vehicleId: 'veh-1', status: 'HARD_APPROVED', view: 'REAR', description: 'old scuff', createdAt: '2026-06-12T00:00:00Z' }],
  });
  const calls = [];
  const emitted = [];
  const out = await runT2SweepOnce(okDeps(db, {
    analyze: async (args) => {
      calls.push(args);
      if (args.angle === 'rear') {
        return {
          verdict: 'POSSIBLE_DAMAGE', confidence: 78,
          description: 'light scuff, lower-left bumper',
          region: { x: 0.14, y: 0.59, w: 0.24, h: 0.19 },
          kind: 'scuff', matchedKnownIds: [],
          usage: { inputTokens: 3000, outputTokens: 90 }, estimatedCostUsd: 0.00345,
        };
      }
      return { verdict: 'NO_CHANGE', confidence: 92, description: null, region: null, kind: null, matchedKnownIds: [], usage: { inputTokens: 2800, outputTokens: 40 }, estimatedCostUsd: 0.003 };
    },
    emit: async (e) => emitted.push(e),
  }));
  assert.equal(out.analyzed, 1);

  // The ledger context reached the model for the rear pair only.
  const rearCall = calls.find((c) => c.angle === 'rear');
  assert.deepEqual(rearCall.knownDamages.map((k) => k.id), ['kd-1']);
  assert.equal(calls.find((c) => c.angle === 'front').knownDamages.length, 0);
  assert.equal(rearCall.apiKey, 'sk-tenant');

  // The finding: per-angle checkKey, category DAMAGE, tier T2, OPEN, ERROR.
  const finding = state.findings.get(`res-2417|${DAMAGE_SUSPECTED_PREFIX}rear`);
  assert.ok(finding, 'DAMAGE_SUSPECTED:rear created');
  assert.equal(finding.category, 'DAMAGE');
  assert.equal(finding.severity, 'ERROR');
  assert.equal(finding.tier, 'T2');
  assert.equal(finding.status, 'OPEN');
  const details = JSON.parse(finding.detailsJson);
  assert.equal(details.confidence, 78);
  assert.equal(details.view, 'REAR');
  assert.equal(details.checkinPhoto.path, 'i/rear.jpg');
  assert.equal(details.checkoutPhoto.path, 'o/rear.jpg');

  // The notification (Mock 3 copy), deduped per reservation+check.
  assert.equal(emitted.length, 1);
  assert.equal(emitted[0].severity, 'NEEDS_ACTION');
  assert.equal(emitted[0].sourceType, 'CHECKIN_AUDIT');
  assert.match(emitted[0].title, /Possible damage — RSV-2417/);
  assert.match(emitted[0].title, /rear \(78%\)/);
  assert.equal(emitted[0].dedupeKey, `checkin-audit:res-2417:${DAMAGE_SUSPECTED_PREFIX}rear`);
  assert.equal(emitted[0].deepLink, '/checkin-audit?reservationId=res-2417');

  // The scan record: ANALYZED, both verdicts on file, spend counted.
  const scan = state.findings.get(`res-2417|${T2_SCAN_CHECK_KEY}`);
  assert.equal(scan.resolution, 'ANALYZED');
  assert.equal(scan.status, 'RESOLVED');
  const sd = JSON.parse(scan.detailsJson);
  assert.equal(sd.pairsAnalyzed, 2);
  assert.equal(sd.aiCalls, 2);
  assert.equal(sd.suspected, 1);
  assert.equal(sd.verdicts.length, 2, 'NO_CHANGE recorded too — annotate, never suppress');
  assert.equal(sd.estimatedCostUsd, 0.00645);
  assert.deepEqual(sd.missingAngles, ['left', 'right', 'frontSeat', 'rearSeat', 'dashboard', 'trunk']);
});

test('sweep: 40-69% = WARN finding with NO notification; <40% = no finding but the verdict is still recorded', async () => {
  const { db, state } = makeSweepDb({ settings: [TENANT_CFG_ROW], t1Rows: [T1_ROW], inspections: BOTH_SIDES });
  const emitted = [];
  await runT2SweepOnce(okDeps(db, {
    analyze: async (args) => ({
      verdict: 'POSSIBLE_DAMAGE',
      confidence: args.angle === 'rear' ? 55 : 25,
      description: 'maybe', region: null, kind: null, matchedKnownIds: [],
      usage: { inputTokens: 100, outputTokens: 10 }, estimatedCostUsd: 0.001,
    }),
    emit: async (e) => emitted.push(e),
  }));
  const warn = state.findings.get(`res-2417|${DAMAGE_SUSPECTED_PREFIX}rear`);
  assert.equal(warn.severity, 'WARN');
  assert.equal(emitted.length, 0, 'WARN never notifies');
  assert.equal(state.findings.get(`res-2417|${DAMAGE_SUSPECTED_PREFIX}front`), undefined, 'sub-40 discarded as a finding');
  const sd = JSON.parse(state.findings.get(`res-2417|${T2_SCAN_CHECK_KEY}`).detailsJson);
  const front = sd.verdicts.find((v) => v.angle === 'front');
  assert.equal(front.confidence, 25, 'discarded verdict still on the scan record');
  assert.equal(front.finding, false);
});

test('sweep: KNOWN_DAMAGE match stamps lastVerifiedAt on the ledger entry (free verification event) — and stays on the scan record', async () => {
  const { db, state } = makeSweepDb({
    settings: [TENANT_CFG_ROW], t1Rows: [T1_ROW], inspections: BOTH_SIDES,
    ledger: [{ id: 'kd-1', vehicleId: 'veh-1', status: 'HARD_APPROVED', view: 'REAR', description: 'old scuff', createdAt: '2026-06-12T00:00:00Z' }],
  });
  await runT2SweepOnce(okDeps(db, {
    analyze: async (args) => (args.angle === 'rear'
      ? { verdict: 'KNOWN_DAMAGE', confidence: 88, description: 'matches the documented scuff', region: null, kind: 'scuff', matchedKnownIds: ['kd-1'], usage: { inputTokens: 100, outputTokens: 10 }, estimatedCostUsd: 0.001 }
      : { verdict: 'NO_CHANGE', confidence: 90, description: null, region: null, kind: null, matchedKnownIds: [], usage: { inputTokens: 100, outputTokens: 10 }, estimatedCostUsd: 0.001 }),
  }));
  assert.equal(state.ledgerUpdates.length, 1);
  const upd = state.ledgerUpdates[0];
  assert.deepEqual(upd.where.id.in, ['kd-1']);
  assert.equal(upd.where.vehicleId, 'veh-1', 'stamp is vehicle-guarded');
  assert.ok(upd.data.lastVerifiedAt instanceof Date);
  assert.equal(upd.data.lastVerifiedPhotoRef.path, 'i/rear.jpg');
  const sd = JSON.parse(state.findings.get(`res-2417|${T2_SCAN_CHECK_KEY}`).detailsJson);
  assert.deepEqual(sd.verdicts.find((v) => v.angle === 'rear').matchedKnownIds, ['kd-1']);
  assert.equal(state.findings.get(`res-2417|${DAMAGE_SUSPECTED_PREFIX}rear`), undefined, 'a known match is not a new-damage finding');
});

test('sweep: budget stop — over-cap closes get the explicit SKIPPED_BUDGET marker, never a silent drop, never a provider call', async () => {
  const settings = [{ key: 'tenant:t1:checkinAuditConfig', value: JSON.stringify({ photoAiEnabled: true, dailyPhotoBudget: 1 }) }];
  const t1Rows = [
    T1_ROW,
    { ...T1_ROW, reservationId: 'res-2418', reservationNumber: 'RSV-2418' },
  ];
  const inspections = [
    ...BOTH_SIDES,
    // second reservation shares the agreement refs shape
  ];
  const { db, state } = makeSweepDb({ settings, t1Rows, inspections });
  let analyzed = 0;
  const out = await runT2SweepOnce(okDeps(db, {
    analyze: async () => { analyzed += 1; return { verdict: 'NO_CHANGE', confidence: 90, description: null, region: null, kind: null, matchedKnownIds: [], usage: { inputTokens: 1, outputTokens: 1 }, estimatedCostUsd: 0 }; },
  }));
  assert.equal(out.analyzed, 1);
  assert.equal(out.skippedBudget, 1);
  assert.equal(analyzed, 2, 'only the first close (2 pairs) reached the model');
  const skipped = state.findings.get(`res-2418|${T2_SCAN_CHECK_KEY}`);
  assert.equal(skipped.resolution, 'SKIPPED_BUDGET');
  assert.match(skipped.detailsJson, /daily photo budget/);
});

test('sweep idempotence: a second sweep neither re-analyzes nor duplicates — one verdict per close, ever', async () => {
  const { db, state } = makeSweepDb({ settings: [TENANT_CFG_ROW], t1Rows: [T1_ROW], inspections: BOTH_SIDES });
  let analyzed = 0;
  const deps = okDeps(db, {
    analyze: async () => { analyzed += 1; return { verdict: 'POSSIBLE_DAMAGE', confidence: 78, description: 'scuff', region: null, kind: 'scuff', matchedKnownIds: [], usage: { inputTokens: 1, outputTokens: 1 }, estimatedCostUsd: 0 }; },
  });
  await runT2SweepOnce(deps);
  const afterFirst = state.findings.size;
  const callsAfterFirst = analyzed;
  await runT2SweepOnce(deps);
  assert.equal(analyzed, callsAfterFirst, 'no second provider call');
  assert.equal(state.findings.size, afterFirst, 'no duplicate rows');
});

test('sweep: no photos on both sides → SKIPPED_NO_PHOTOS with the missing angles named', async () => {
  const { db, state } = makeSweepDb({
    settings: [TENANT_CFG_ROW],
    t1Rows: [T1_ROW],
    inspections: [{ rentalAgreementId: 'ra-1', phase: 'CHECKIN', photoStorageRefs: [ref('front', 'i/front.jpg')], capturedAt: null }],
  });
  let analyzed = 0;
  const out = await runT2SweepOnce(okDeps(db, { analyze: async () => { analyzed += 1; } }));
  assert.equal(out.skippedNoPhotos, 1);
  assert.equal(analyzed, 0);
  const scan = state.findings.get(`res-2417|${T2_SCAN_CHECK_KEY}`);
  assert.equal(scan.resolution, 'SKIPPED_NO_PHOTOS');
  assert.match(scan.detailsJson, /front/);
});

test('sweep: a provider failure lands on the scan row as FAILED — the sweep, and the close, survive', async () => {
  const { db, state } = makeSweepDb({ settings: [TENANT_CFG_ROW], t1Rows: [T1_ROW], inspections: BOTH_SIDES });
  const out = await runT2SweepOnce(okDeps(db, {
    analyze: async () => { throw new Error('anthropic 529: overloaded'); },
  }));
  assert.equal(out.failed, 1);
  const scan = state.findings.get(`res-2417|${T2_SCAN_CHECK_KEY}`);
  assert.equal(scan.resolution, 'FAILED');
  assert.match(scan.detailsJson, /overloaded/);
});

// ───────────────────────── F. queue projection ──────────────────────────────

test('buildT2Summary: folds scan + suspected rows per reservation; no scan row = PENDING', () => {
  const rows = [
    { reservationId: 'r1', checkKey: T2_SCAN_CHECK_KEY, resolution: 'ANALYZED' },
    { reservationId: 'r1', checkKey: `${DAMAGE_SUSPECTED_PREFIX}rear`, severity: 'ERROR', status: 'OPEN', detailsJson: JSON.stringify({ angle: 'rear', confidence: 78 }) },
    { reservationId: 'r2', checkKey: `${DAMAGE_SUSPECTED_PREFIX}front`, severity: 'WARN', status: 'OPEN', detailsJson: 'broken{' },
    { reservationId: 'r3', checkKey: T2_SCAN_CHECK_KEY, resolution: 'SKIPPED_BUDGET' },
  ];
  const t2 = buildT2Summary(rows);
  assert.equal(t2.r1.status, 'ANALYZED');
  assert.deepEqual(t2.r1.suspected[0], { checkKey: `${DAMAGE_SUSPECTED_PREFIX}rear`, angle: 'rear', confidence: 78, severity: 'ERROR', status: 'OPEN' });
  assert.equal(t2.r2.status, 'PENDING');
  assert.equal(t2.r2.suspected[0].angle, 'front', 'angle recoverable from the checkKey when details are unreadable');
  assert.equal(t2.r3.status, 'SKIPPED_BUDGET');
});

// ───────────────────────── G. the dismiss fork on a T2 finding ──────────────

test('dismiss PREEXISTING on a T2 finding: one click derives view/dot/description and attaches the check-in photo bytes', async () => {
  const finding = {
    id: 'f-t2', tenantId: 't1', reservationId: 'res-2417', reservationNumber: 'RSV-2417',
    vehicleId: 'veh-1', checkKey: `${DAMAGE_SUSPECTED_PREFIX}rear`, category: 'DAMAGE',
    severity: 'ERROR', status: 'OPEN', tier: 'T2',
    detailsJson: JSON.stringify({
      angle: 'rear', view: 'REAR', confidence: 78,
      description: 'light scuff, lower-left bumper',
      region: { x: 0.14, y: 0.59, w: 0.24, h: 0.19 },
      checkinPhoto: { key: 'rear', path: 'i/rear.jpg', contentType: 'image/jpeg' },
    }),
  };
  const updates = [];
  const db = {
    checkinAuditFinding: {
      findFirst: async () => finding,
      update: async ({ where, data }) => { updates.push({ where, data }); return { ...finding, ...data }; },
    },
    user: { findUnique: async () => ({ fullName: 'M. Rivera' }) },
  };
  const calls = [];
  const out = await dismissFinding('f-t2', { classification: 'PREEXISTING' }, { tenantId: 't1', userId: 'u-1' }, {
    db,
    customerInspection: {
      addManualDamage: async (vehicleId, body, scope, opts) => { calls.push({ vehicleId, body, scope, opts }); return { id: 'dmg-1', view: body.view }; },
    },
    download: async ({ bucket, path }) => {
      assert.equal(bucket, 'test-bucket');
      assert.equal(path, 'i/rear.jpg');
      return { body: Buffer.from('photo-bytes'), contentType: 'image/jpeg' };
    },
    bucket: 'test-bucket',
  });
  assert.equal(out.status, 'RESOLVED');
  assert.equal(out.resolution, 'PREEXISTING_BASELINED');
  const c = calls[0];
  assert.equal(c.body.view, 'REAR');
  assert.equal(c.body.xPct, 26, 'region center x = (0.14 + 0.24/2) * 100');
  assert.equal(c.body.yPct, 69, 'region center y = (0.59 + 0.19/2) * 100');
  assert.equal(c.body.description, 'light scuff, lower-left bumper');
  assert.equal(c.body.photoDataUrl, `data:image/jpeg;base64,${Buffer.from('photo-bytes').toString('base64')}`);
  assert.deepEqual(c.opts, { source: 'AUDIT_PREEXISTING', sourceAuditFindingId: 'f-t2' });
  assert.equal(updates[0].data.linkedDamageReportId, 'dmg-1');
});

test('dismiss PREEXISTING: explicit body values beat the derivation', async () => {
  const finding = {
    id: 'f-t2', tenantId: 't1', reservationId: 'res-2417', vehicleId: 'veh-1',
    checkKey: `${DAMAGE_SUSPECTED_PREFIX}rear`, category: 'DAMAGE', status: 'OPEN', tier: 'T2',
    detailsJson: JSON.stringify({ angle: 'rear', view: 'REAR', region: { x: 0.1, y: 0.1, w: 0.1, h: 0.1 }, checkinPhoto: { path: 'i/rear.jpg' } }),
  };
  const db = {
    checkinAuditFinding: { findFirst: async () => finding, update: async () => finding },
    user: { findUnique: async () => null },
  };
  const calls = [];
  await dismissFinding('f-t2', {
    classification: 'PREEXISTING', view: 'LEFT', xPct: 10, yPct: 90,
    description: 'agent says left door', photoDataUrl: 'data:image/jpeg;base64,YWdlbnQ=',
  }, { tenantId: 't1' }, {
    db,
    customerInspection: { addManualDamage: async (v, body) => { calls.push(body); return { id: 'dmg-2', view: body.view }; } },
    download: async () => { throw new Error('must not download — the agent supplied a photo'); },
    bucket: 'test-bucket',
  });
  assert.equal(calls[0].view, 'LEFT');
  assert.equal(calls[0].xPct, 10);
  assert.equal(calls[0].photoDataUrl, 'data:image/jpeg;base64,YWdlbnQ=');
});

// ───────────────────────── H. wiring ────────────────────────────────────────

test('wiring: worker starts the T2 scheduler; settings routes expose /checkin-audit; the feature registry names checkin-audit', () => {
  const worker = readFileSync(join(SRC, 'worker.js'), 'utf8');
  assert.match(worker, /checkin-audit-t2\.service\.js/);
  assert.match(worker, /startCheckinAuditT2Scheduler\(\)/);

  const routes = readFileSync(join(SRC, 'modules/settings/settings.routes.js'), 'utf8');
  assert.match(routes, /settingsRouter\.get\('\/checkin-audit'/);
  assert.match(routes, /settingsRouter\.put\('\/checkin-audit', requireRole\('ADMIN'\)/);

  assert.ok(PLATFORM_CREDENTIAL_FEATURES['checkin-audit'], 'the registry IS the inventory');
  assert.equal(PLATFORM_CREDENTIAL_FEATURES['checkin-audit'].envVar, 'ANTHROPIC_API_KEY');
});

test('wiring: settings config surface defaults photo AI OFF with budget 100 and Haiku (source-pinned, DB-free)', () => {
  const svc = readFileSync(join(SRC, 'modules/settings/settings.service.js'), 'utf8');
  assert.match(svc, /photoAiEnabled: cfg\?\.photoAiEnabled === true/, 'literal-true opt-in, fail closed');
  assert.match(svc, /dailyPhotoBudget[\s\S]{0,200}?: 100,/, 'default budget 100');
  assert.match(svc, /photoAiModel[\s\S]{0,120}?'claude-haiku-4-5-20251001'/, 'default model Haiku');
  assert.match(svc, /typeof payload\?\.photoAiEnabled === 'boolean'/, 'only an explicit boolean moves the opt-in');
});

test('SAFETY: the T2 worker never creates damage reports, charges, or repair orders — findings only', () => {
  const svc = readFileSync(join(SRC, 'modules/checkin-audit/checkin-audit-t2.service.js'), 'utf8');
  assert.ok(!/vehicleDamageReport\s*\.\s*create/.test(svc), 'no ledger creates from the AI');
  assert.ok(!/rentalAgreementCharge/.test(svc), 'no charges from the AI');
  assert.ok(!/repairOrder/i.test(svc.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '')), 'no repair orders from the AI');
  assert.match(svc, /updateMany/, 'the only ledger write is the lastVerifiedAt stamp');
});
