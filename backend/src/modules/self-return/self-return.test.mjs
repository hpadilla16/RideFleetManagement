/**
 * QR self-return = customer return timestamp (Hector, 2026-09-02).
 * Run via: npm run test:self-return
 *
 * Covers, in order:
 *  A. Migration discipline — 20260905_qr_self_return against schema.prisma
 *     (Reservation stamp columns + the SelfReturnQr table, column parity),
 *     additive/idempotent statement rules, the pinned predecessor sort, and
 *     the Supabase RLS requirement: the one table this migration creates
 *     ships with ENABLE ROW LEVEL SECURITY.
 *  B. Pure rules — token mint shape, the (number, last name) pair matching,
 *     live-stamp detection, and the invariant-(b) cap math (EARLIER applies,
 *     later/equal is a no-op — the stamp only ever caps fees downward).
 *  C. QR lifecycle — ship-inert (no row = disabled), enable mints, disable
 *     revokes, re-enable mints a NEW token (old posters die), tenant scoping.
 *  D. The public submit — token gating (unknown/revoked/re-tenanted are the
 *     same null → bare 404: the gating invariant), pair verification with
 *     ORACLE-SAFETY (wrong number, wrong last name, wrong tenant, and a
 *     not-CHECKED_OUT rental all return the IDENTICAL generic outcome),
 *     the stamp write + invariant (a) enforced mechanically (the in-memory
 *     prisma has NO agreement/vehicle/fee tables), the idempotent second
 *     scan (FIRST stamp stands), and the INFO notification deduped per
 *     reservation.
 *  E. Evidence-backed backdating + close wiring — validateBackdatedReturn
 *     accepts a CUSTOMER_SELF_RETURN-evidenced backdate from an AGENT but
 *     still enforces the sanity bounds; source assertions pin checkin-close
 *     to selfReturnOverride and to recording BOTH timestamps in the audit.
 *  F. Admin void — role roster, state rules, the stamp surviving (never
 *     deleted), once-only, and the route/audit wiring (SELF_RETURN_VOID).
 *  G. Wiring — public routes behind the rate-limit guards, admin routes
 *     mounted in main.js, the notification evt template in BOTH frontend
 *     locales.
 *
 * DB-FREE: the service takes an injected in-memory prisma (the house
 * shuttle-driver-service.test.mjs idiom); checkin-close wiring is pinned by
 * source-text assertion (that service uses the real prisma singleton — its
 * DB-backed suite covers persistence).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

import {
  mintSelfReturnToken,
  selfReturnLinkPath,
  qrState,
  normalizeReservationNumber,
  lastNameMatches,
  hasActiveSelfReturnStamp,
  selfReturnOverride,
  canVoidSelfReturn,
  selfReturnVoidNote,
  buildStampMeta,
  STAMPABLE_STATUSES,
  SELF_RETURN_VOID_ROLES,
} from './self-return.js';
import { selfReturnService } from './self-return.service.js';
import { validateBackdatedReturn, BACKDATE_EVIDENCE_SOURCES, BACKDATE_ROLES } from '../rental-agreements/backdated-return.js';
import { AUDIT_ACTIONS } from '../audit/audit.service.js';
import { NOTIFICATION_SOURCE_TYPES } from '../notifications/notifications-emit.js';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const NOW = new Date('2026-09-02T18:00:00Z');
const TOK_ACTIVE = 'tok_active_abcdefgh12345678';
const TOK_REVOKED = 'tok_revoked_abcdefgh1234567';
const TOK_FOREIGN = 'tok_foreign_abcdefgh1234567';

// ─────────────────── A. migration / model discipline ───────────────────────

const MIGRATION_DIR = '20260905_qr_self_return';
// The migration that was newest when this one shipped. Pinned predecessor,
// not "newest in repo" — see billing-model.test.mjs for why.
const MIGRATION_PREDECESSOR = '20260904_copilot_miss';
const SQL = readFileSync(join(ROOT, 'prisma', 'migrations', MIGRATION_DIR, 'migration.sql'), 'utf8');
const SCHEMA = readFileSync(join(ROOT, 'prisma', 'schema.prisma'), 'utf8');
const STATEMENTS = SQL.replace(/^\s*--.*$/gm, '');

const STAMP_COLUMNS = [
  'customerReportedReturnAt', 'customerReportedReturnLocationId', 'customerReportedReturnMetaJson',
  'customerReportedReturnVoidedAt', 'customerReportedReturnVoidedByUserId', 'customerReportedReturnVoidReason',
];

test('migration adds every Reservation stamp column idempotently and schema.prisma declares each', () => {
  const model = SCHEMA.match(/model Reservation \{([\s\S]*?)\n\}/);
  assert.ok(model, 'schema.prisma has model Reservation');
  for (const col of STAMP_COLUMNS) {
    assert.match(
      STATEMENTS,
      new RegExp(`ALTER TABLE "Reservation" ADD COLUMN IF NOT EXISTS "${col}"`),
      `migration adds ${col}`,
    );
    assert.match(model[1], new RegExp(`^\\s{2}${col}\\s`, 'm'), `schema declares ${col}`);
  }
});

test('SelfReturnQr: migration and schema.prisma declare the same columns', () => {
  const m = STATEMENTS.match(/CREATE TABLE IF NOT EXISTS "SelfReturnQr" \(([\s\S]*?)\n\);/);
  assert.ok(m, 'migration creates SelfReturnQr');
  const sqlCols = [...m[1].matchAll(/^\s*"(\w+)"/gm)].map((x) => x[1]);

  const modelMatch = SCHEMA.match(/model SelfReturnQr \{([\s\S]*?)\n\}/);
  assert.ok(modelMatch, 'schema.prisma has model SelfReturnQr');
  const schemaCols = [...modelMatch[1].matchAll(/^\s{2}(\w+)\s/gm)]
    .map((x) => x[1])
    .filter((c) => !c.startsWith('@'));

  assert.deepEqual(sqlCols.sort(), schemaCols.sort());
  assert.match(STATEMENTS, /CREATE UNIQUE INDEX IF NOT EXISTS "SelfReturnQr_locationId_key"/, 'one QR per location');
  assert.match(STATEMENTS, /CREATE UNIQUE INDEX IF NOT EXISTS "SelfReturnQr_token_key"/, 'tokens are unique');
});

test('the migration sorts after its pinned predecessor and is additive/idempotent', () => {
  assert.ok(MIGRATION_DIR > MIGRATION_PREDECESSOR, 'startup-migrate applies lexicographically');
  // Nothing destructive, ever.
  assert.doesNotMatch(STATEMENTS, /\bDROP\b|\bDELETE\b|\bTRUNCATE\b/i);
});

test('Supabase advisor rule (2026-09-02): the new table ships with RLS enabled', () => {
  assert.match(STATEMENTS, /ALTER TABLE "SelfReturnQr" ENABLE ROW LEVEL SECURITY;/);
});

// ─────────────────── B. pure rules ──────────────────────────────────────────

test('token mint: 192-bit base64url house shape; link path is /return/<token>', () => {
  const tok = mintSelfReturnToken();
  assert.match(tok, /^[A-Za-z0-9_-]{32}$/);
  assert.notEqual(mintSelfReturnToken(), tok, 'random, not constant');
  assert.equal(selfReturnLinkPath('abc'), '/return/abc');
  assert.equal(qrState(null), 'DISABLED');
  assert.equal(qrState({ revokedAt: NOW }), 'DISABLED');
  assert.equal(qrState({ revokedAt: null }), 'ACTIVE');
});

test('the verification pair: number normalized, last name accent/case/space-insensitive but EXACT', () => {
  assert.equal(normalizeReservationNumber('  r-1001 '), 'R-1001');
  assert.equal(normalizeReservationNumber(''), null);
  assert.equal(lastNameMatches('Pena', 'Peña'), true, 'airport keyboards have no ñ');
  assert.equal(lastNameMatches('  DE LA  cruz ', 'De la Cruz'), true, 'case + whitespace tolerant');
  assert.equal(lastNameMatches('Cruz', 'De la Cruz'), false, 'a partial name is NOT a match — the pair stays strong');
  assert.equal(lastNameMatches('', 'Peña'), false);
  assert.equal(lastNameMatches('Peña', ''), false);
});

test('invariant (b): selfReturnOverride applies ONLY when strictly earlier — a stamp caps fees, never extends them', () => {
  const close = new Date('2026-09-02T18:00:00Z');
  const earlier = new Date('2026-09-02T14:14:00Z');
  const later = new Date('2026-09-02T19:00:00Z');
  assert.equal(
    selfReturnOverride({ reportedAt: earlier, closeReturnedAt: close })?.getTime(),
    earlier.getTime(),
    'earlier stamp becomes the effective return time',
  );
  assert.equal(selfReturnOverride({ reportedAt: later, closeReturnedAt: close }), null, 'later stamp is a no-op');
  assert.equal(selfReturnOverride({ reportedAt: close, closeReturnedAt: close }), null, 'equal is a no-op too');
  assert.equal(selfReturnOverride({ reportedAt: 'garbage', closeReturnedAt: close }), null);
  assert.equal(selfReturnOverride({}), null);
});

test('stamp detection + stampable statuses + meta caps', () => {
  assert.deepEqual(STAMPABLE_STATUSES, ['CHECKED_OUT'], 'only an open rental can be handed back');
  const r = { customerReportedReturnAt: NOW, customerReportedReturnVoidedAt: null };
  assert.equal(hasActiveSelfReturnStamp(r), true);
  assert.equal(hasActiveSelfReturnStamp({ ...r, customerReportedReturnVoidedAt: NOW }), false, 'voided = not live');
  assert.equal(hasActiveSelfReturnStamp({}), false);
  assert.equal(hasActiveSelfReturnStamp(null), false);
  const meta = JSON.parse(buildStampMeta({ ip: '1.2.3.4', userAgent: 'x'.repeat(500) }));
  assert.equal(meta.ip, '1.2.3.4');
  assert.equal(meta.userAgent.length, 200, 'user agent capped');
});

// ─────────────────── shared in-memory prisma ────────────────────────────────

const matchVal = (val, cond) => {
  const v = val ?? null;
  if (cond && typeof cond === 'object' && !(cond instanceof Date)) {
    if ('in' in cond) return cond.in.includes(v);
    if ('not' in cond) return v !== (cond.not ?? null);
    return true;
  }
  if (v instanceof Date || cond instanceof Date) {
    return new Date(v).getTime() === new Date(cond).getTime();
  }
  return v === (cond ?? null);
};
const matches = (row, where = {}) => Object.entries(where).every(([k, cond]) => matchVal(row[k], cond));

function table(rows, { idPrefix = 'row' } = {}) {
  let seq = 0;
  return {
    rows,
    async findFirst({ where } = {}) { return rows.find((r) => matches(r, where)) || null; },
    async findUnique({ where } = {}) { return rows.find((r) => matches(r, where)) || null; },
    async findMany({ where } = {}) { return rows.filter((r) => matches(r, where)); },
    async create({ data }) {
      const row = { id: data.id || `${idPrefix}_${++seq}`, createdAt: data.createdAt || NOW, ...data };
      rows.push(row);
      return { ...row };
    },
    async update({ where, data }) {
      const row = rows.find((r) => matches(r, where));
      Object.assign(row, data);
      return { ...row };
    },
  };
}

function makeWorld({ reservationStatus = 'CHECKED_OUT' } = {}) {
  const qrs = table([
    { id: 'qr_lax', tenantId: 't1', locationId: 'lax', token: TOK_ACTIVE, revokedAt: null },
    { id: 'qr_sju', tenantId: 't1', locationId: 'sju', token: TOK_REVOKED, revokedAt: new Date('2026-09-01T00:00:00Z') },
    // Re-tenanted location: the QR row still says t2, the location says t9.
    { id: 'qr_mia', tenantId: 't2', locationId: 'mia', token: TOK_FOREIGN, revokedAt: null },
  ], { idPrefix: 'qr' });

  const reservations = table([
    {
      id: 'res_1', tenantId: 't1', reservationNumber: 'R-1001', status: reservationStatus,
      customer: { lastName: 'Peña' },
      customerReportedReturnAt: null, customerReportedReturnLocationId: null,
      customerReportedReturnMetaJson: null, customerReportedReturnVoidedAt: null,
      customerReportedReturnVoidedByUserId: null, customerReportedReturnVoidReason: null,
    },
    {
      id: 'res_other_tenant', tenantId: 't2', reservationNumber: 'R-2002', status: 'CHECKED_OUT',
      customer: { lastName: 'Osei' },
      customerReportedReturnAt: null, customerReportedReturnVoidedAt: null,
    },
    {
      id: 'res_not_out', tenantId: 't1', reservationNumber: 'R-3003', status: 'CONFIRMED',
      customer: { lastName: 'Vega' },
      customerReportedReturnAt: null, customerReportedReturnVoidedAt: null,
    },
  ], { idPrefix: 'res' });

  const world = { qrs, reservations, emits: [] };

  // INVARIANT (a) IS MECHANICAL HERE: this prisma has NO rentalAgreement, NO
  // vehicle, NO charge/fee table. If submitReturn ever touched any of them,
  // the suite would throw TypeError instead of passing.
  const prisma = {
    selfReturnQr: qrs,
    reservation: reservations,
    location: table([
      { id: 'lax', tenantId: 't1', name: 'LAX Airport' },
      { id: 'sju', tenantId: 't1', name: 'SJU Airport' },
      { id: 'mia', tenantId: 't9', name: 'MIA Airport' }, // re-tenanted (QR row says t2)
    ]),
  };

  const deps = {
    prisma,
    logger: { info() {}, warn() {}, error() {} },
    emitNotification: async (input) => { world.emits.push(input); return { id: 'evt' }; },
    now: () => NOW,
  };
  world.prisma = prisma;
  world.deps = deps;
  return world;
}

const SUBMIT_OK_PAIR = { reservationNumber: 'r-1001', lastName: 'Pena' };

// ─────────────────── C. QR lifecycle ────────────────────────────────────────

test('ship-inert: no row = disabled; enable mints; re-enable after disable mints a NEW token', async () => {
  const w = makeWorld();
  const scope = { tenantId: 't1' };

  // A location with no row at all.
  w.prisma.location.rows.push({ id: 'pse', tenantId: 't1', name: 'Ponce' });
  assert.deepEqual(await selfReturnService.qrStatus('pse', scope, w.deps), { enabled: false, linkPath: null });

  const first = await selfReturnService.enableQr('pse', scope, 'admin_1', w.deps);
  assert.equal(first.enabled, true);
  assert.match(first.linkPath, /^\/return\/[A-Za-z0-9_-]{32}$/);

  // Enable while active is idempotent — same token, posters stay valid.
  const again = await selfReturnService.enableQr('pse', scope, 'admin_1', w.deps);
  assert.equal(again.linkPath, first.linkPath);

  // Disable revokes; status reads off.
  await selfReturnService.disableQr('pse', scope, w.deps);
  assert.deepEqual(await selfReturnService.qrStatus('pse', scope, w.deps), { enabled: false, linkPath: null });

  // Re-enable mints a NEW token — the old poster is dead.
  const rotated = await selfReturnService.enableQr('pse', scope, 'admin_1', w.deps);
  assert.notEqual(rotated.linkPath, first.linkPath, 'old posters die on re-enable');
});

test('QR admin scoping: a foreign tenant cannot read or mint another tenant\'s location', async () => {
  const w = makeWorld();
  await assert.rejects(selfReturnService.qrStatus('lax', { tenantId: 't2' }, w.deps), (e) => e.status === 404);
  await assert.rejects(selfReturnService.enableQr('lax', { tenantId: 't2' }, null, w.deps), (e) => e.status === 404);
  await assert.rejects(selfReturnService.qrStatus('lax', {}, w.deps), (e) => e.status === 400, 'no tenant scope = refused');
});

// ─────────────────── D. public submit ───────────────────────────────────────

test('token gating: unknown, too-short, revoked, and re-tenanted tokens are all the same null (bare 404)', async () => {
  const w = makeWorld();
  assert.equal(await selfReturnService.publicContext('tok_unknown_abcdefgh1234', w.deps), null);
  assert.equal(await selfReturnService.publicContext('short', w.deps), null);
  assert.equal(await selfReturnService.publicContext(TOK_REVOKED, w.deps), null, 'revoked = disabled = 404');
  assert.equal(await selfReturnService.publicContext(TOK_FOREIGN, w.deps), null, 're-tenanted location kills the link');
  assert.equal(await selfReturnService.submitReturn(TOK_REVOKED, SUBMIT_OK_PAIR, w.deps), null, 'a disabled sede accepts NO stamp');
  assert.equal(w.reservations.rows[0].customerReportedReturnAt, null, 'nothing written');

  const ctx = await selfReturnService.publicContext(TOK_ACTIVE, w.deps);
  assert.deepEqual(ctx, { locationName: 'LAX Airport' }, 'picked fields only — the public-payload law');
});

test('ORACLE-SAFETY: wrong number, wrong last name, wrong tenant, and not-CHECKED_OUT are the IDENTICAL generic outcome', async () => {
  const w = makeWorld();
  const outcomes = await Promise.all([
    selfReturnService.submitReturn(TOK_ACTIVE, { reservationNumber: 'R-9999', lastName: 'Pena' }, w.deps),
    selfReturnService.submitReturn(TOK_ACTIVE, { reservationNumber: 'R-1001', lastName: 'Smith' }, w.deps),
    // R-2002 exists — but under ANOTHER tenant. Must read exactly like unknown.
    selfReturnService.submitReturn(TOK_ACTIVE, { reservationNumber: 'R-2002', lastName: 'Osei' }, w.deps),
    // R-3003 exists, right tenant, right name — but the rental never started.
    selfReturnService.submitReturn(TOK_ACTIVE, { reservationNumber: 'R-3003', lastName: 'Vega' }, w.deps),
    selfReturnService.submitReturn(TOK_ACTIVE, { reservationNumber: '', lastName: 'Pena' }, w.deps),
    selfReturnService.submitReturn(TOK_ACTIVE, { reservationNumber: 'R-1001', lastName: '' }, w.deps),
  ]);
  for (const out of outcomes) {
    assert.deepEqual(out, { notFound: true }, 'every mismatch is the same shape — no oracle');
  }
  assert.equal(w.reservations.rows.every((r) => !r.customerReportedReturnAt), true, 'nothing stamped anywhere');
  assert.equal(w.emits.length, 0, 'no notification for a mismatch');
});

test('the stamp: pair match on an open rental writes ONLY the reservation stamp columns', async () => {
  const w = makeWorld();
  const out = await selfReturnService.submitReturn(TOK_ACTIVE, {
    ...SUBMIT_OK_PAIR,
    meta: { ip: '10.0.0.9', userAgent: 'iPhone Safari' },
  }, w.deps);
  assert.equal(out.ok, true);
  assert.equal(out.already, false);
  assert.equal(out.reportedAt.getTime(), NOW.getTime());

  const row = w.reservations.rows.find((r) => r.id === 'res_1');
  assert.equal(row.customerReportedReturnAt.getTime(), NOW.getTime());
  assert.equal(row.customerReportedReturnLocationId, 'lax', 'the scanned QR names the sede');
  assert.deepEqual(JSON.parse(row.customerReportedReturnMetaJson), { ip: '10.0.0.9', userAgent: 'iPhone Safari' });
  assert.equal(row.status, 'CHECKED_OUT', 'invariant (a): the stamp NEVER moves the reservation status');
});

test('idempotent second scan: the FIRST stamp stands, one notification total', async () => {
  const w = makeWorld();
  await selfReturnService.submitReturn(TOK_ACTIVE, SUBMIT_OK_PAIR, w.deps);

  const laterDeps = { ...w.deps, now: () => new Date(NOW.getTime() + 40 * 60 * 1000) };
  const second = await selfReturnService.submitReturn(TOK_ACTIVE, SUBMIT_OK_PAIR, laterDeps);
  assert.equal(second.already, true);
  assert.equal(second.reportedAt.getTime(), NOW.getTime(), 'the ORIGINAL time is returned, not the re-scan');
  assert.equal(
    w.reservations.rows.find((r) => r.id === 'res_1').customerReportedReturnAt.getTime(),
    NOW.getTime(),
    'first stamp wins — a re-scan cannot walk the time forward or back',
  );
  assert.equal(w.emits.length, 1, 'one envelope');
});

test('notification: INFO on the check-in lane, deduped per reservation', async () => {
  const w = makeWorld();
  await selfReturnService.submitReturn(TOK_ACTIVE, SUBMIT_OK_PAIR, w.deps);
  assert.equal(w.emits.length, 1);
  const evt = w.emits[0];
  assert.equal(evt.severity, 'INFO');
  assert.equal(evt.sourceType, 'CHECKIN_AUDIT', 'reuses the check-in attention lane — no new lane invented');
  assert.ok(NOTIFICATION_SOURCE_TYPES.includes(evt.sourceType));
  assert.equal(evt.dedupeKey, 'self-return:res_1', 'dedupe anchor is the RESERVATION');
  assert.equal(evt.locationId, 'lax');
  assert.equal(evt.deepLink, '/reservations/res_1');
  assert.equal(evt.templateKey, 'selfReturn');
});

// ─────────────────── E. evidence-backed backdating + close wiring ───────────

test('validateBackdatedReturn: CUSTOMER_SELF_RETURN evidence lets an AGENT close benefit, bounds still hold', () => {
  const started = new Date('2026-09-01T10:00:00Z');
  const marked = '2026-09-02T14:14:00Z'; // ~3h45m before NOW — far past the 15-min grace

  // Without evidence, an AGENT is refused (the 2026-08-10 gate, unchanged).
  const bare = validateBackdatedReturn({ returnedAt: marked, now: NOW, role: 'AGENT', rentalStartAt: started });
  assert.equal(bare.ok, false);

  // With the machine-attested stamp, the same AGENT close passes.
  assert.deepEqual(BACKDATE_EVIDENCE_SOURCES, ['CUSTOMER_SELF_RETURN']);
  const evidenced = validateBackdatedReturn({ returnedAt: marked, now: NOW, role: 'AGENT', rentalStartAt: started, evidence: 'CUSTOMER_SELF_RETURN' });
  assert.deepEqual(evidenced, { ok: true, backdated: true });

  // Evidence skips ONLY the role rule — time still cannot run backwards.
  assert.equal(validateBackdatedReturn({
    returnedAt: '2026-08-30T00:00:00Z', now: NOW, role: 'AGENT', rentalStartAt: started, evidence: 'CUSTOMER_SELF_RETURN',
  }).ok, false, 'not before the rental started');
  assert.equal(validateBackdatedReturn({
    returnedAt: new Date(NOW.getTime() + 60 * 60 * 1000), now: NOW, role: 'AGENT', evidence: 'CUSTOMER_SELF_RETURN',
  }).ok, false, 'not in the future');

  // Unknown evidence buys nothing; the admin path is untouched.
  assert.equal(validateBackdatedReturn({ returnedAt: marked, now: NOW, role: 'AGENT', rentalStartAt: started, evidence: 'PINKY_PROMISE' }).ok, false);
  assert.deepEqual(validateBackdatedReturn({ returnedAt: marked, now: NOW, role: 'ADMIN', rentalStartAt: started }), { ok: true, backdated: true });
});

test('checkin-close wiring: stamp read off the loaded reservation, cap math in ONE place, both timestamps in the audit', () => {
  const src = readFileSync(join(ROOT, 'src', 'modules', 'rental-agreements', 'checkin-close.service.js'), 'utf8');
  assert.match(src, /from '\.\.\/self-return\/self-return\.js'/, 'imports the shared cap math');
  assert.match(src, /hasActiveSelfReturnStamp\(agreement\.reservation\)/, 'voided stamps never apply, and the read rides the row already loaded');
  assert.match(src, /selfReturnOverride\(\{ reportedAt: selfReturn\.reportedAt, closeReturnedAt: returnedAt \}\)/,
    'the earlier-only rule decides, in ONE place');
  assert.match(src, /evidence: 'CUSTOMER_SELF_RETURN'/, 'evidence-backed backdate, not a role widening');
  assert.match(src, /agentReturnedAt: agentStatedReturnedAt\.toISOString\(\)/, 'audit records BOTH timestamps');
  assert.match(src, /selfReturn: selfReturn \? \{/, 'the close response tells the wizard');
});

// ─────────────────── F. admin void ──────────────────────────────────────────

test('void roles mirror the backdate roles — both actions move the same money', () => {
  assert.deepEqual([...SELF_RETURN_VOID_ROLES].sort(), [...BACKDATE_ROLES].sort());
  assert.equal(canVoidSelfReturn('ADMIN'), true);
  assert.equal(canVoidSelfReturn('ops'), true, 'case-insensitive');
  assert.equal(canVoidSelfReturn('SUPER_ADMIN'), true);
  assert.equal(canVoidSelfReturn('AGENT'), false);
  assert.equal(canVoidSelfReturn(null), false);
  assert.match(selfReturnVoidNote({ reportedAt: NOW, reason: 'customer never came', now: NOW }), /SELF-RETURN VOIDED .* customer never came/);
});

test('voidStamp: the stamp survives (never deleted), the void records who/why, once-only, tenant-scoped', async () => {
  const w = makeWorld();
  await selfReturnService.submitReturn(TOK_ACTIVE, SUBMIT_OK_PAIR, w.deps);

  await assert.rejects(
    selfReturnService.voidStamp('res_1', { scope: { tenantId: 't2' }, userId: 'admin_x' }, w.deps),
    (e) => e.status === 404,
    'a foreign tenant cannot void',
  );

  const row = await selfReturnService.voidStamp('res_1', { scope: { tenantId: 't1' }, userId: 'admin_1', reason: 'Car was still on the road' }, w.deps);
  assert.equal(row.customerReportedReturnVoidedAt.getTime(), NOW.getTime());
  assert.equal(row.customerReportedReturnVoidedByUserId, 'admin_1');
  assert.equal(row.customerReportedReturnVoidReason, 'Car was still on the road');
  assert.equal(row.customerReportedReturnAt.getTime(), NOW.getTime(), 'the evidence timestamp is kept, not erased');
  assert.equal(hasActiveSelfReturnStamp(row), false, 'checkin-close stops honoring it');

  await assert.rejects(
    selfReturnService.voidStamp('res_1', { scope: { tenantId: 't1' }, userId: 'admin_1' }, w.deps),
    (e) => e.status === 409 && e.code === 'NOT_STAMPED',
    'a second void is a 409, not a silent overwrite',
  );

  // A re-scan after a void is a NEW claim — clean stamp, void trail cleared
  // on the row (the audit log keeps the history).
  const rescan = await selfReturnService.submitReturn(TOK_ACTIVE, SUBMIT_OK_PAIR, w.deps);
  assert.equal(rescan.already, false, 'voided stamp does not read as already-marked');
  assert.equal(w.reservations.rows.find((r) => r.id === 'res_1').customerReportedReturnVoidedAt, null);
});

test('void route wiring: ADMIN-gated before the write, audited as SELF_RETURN_VOID; QR mint/revoke audited too', () => {
  assert.equal(AUDIT_ACTIONS.SELF_RETURN_VOID, 'SELF_RETURN_VOID');
  assert.equal(AUDIT_ACTIONS.SELF_RETURN_QR_ENABLE, 'SELF_RETURN_QR_ENABLE');
  assert.equal(AUDIT_ACTIONS.SELF_RETURN_QR_DISABLE, 'SELF_RETURN_QR_DISABLE');
  const src = readFileSync(join(ROOT, 'src', 'modules', 'self-return', 'self-return.routes.js'), 'utf8');
  assert.match(src, /canVoidSelfReturn\(req\.user\?\.role\)/, 'the role gate runs before the write');
  assert.match(src, /AUDIT_ACTIONS\.SELF_RETURN_VOID/);
  assert.match(src, /AUDIT_ACTIONS\.SELF_RETURN_QR_ENABLE/);
  assert.match(src, /AUDIT_ACTIONS\.SELF_RETURN_QR_DISABLE/);
  assert.match(src, /requireRole\('SUPER_ADMIN', 'ADMIN', 'OPS'\)/, 'QR mutation takes the settings-author tier');
});

// ─────────────────── G. wiring ──────────────────────────────────────────────

test('public routes ride the house rate-limit guards; every mismatch is the same generic 404 body', () => {
  const src = readFileSync(join(ROOT, 'src', 'modules', 'self-return', 'self-return.routes.js'), 'utf8');
  assert.match(src, /createPublicRateLimitGuard\(\{ name: 'public-self-return', maxRequests: 30/);
  assert.match(src, /createPublicRateLimitGuard\(\{ name: 'public-self-return-submit', maxRequests: 5/, 'submit throttled like the public shuttle-request button');
  assert.match(src, /attachPublicRequestMeta\('public-self-return'\)/);
  // The submit's not-found and the dead token produce the SAME body.
  const notFounds = [...src.matchAll(/res\.status\(404\)\.json\(\{ error: 'Not found' \}\)/g)];
  assert.ok(notFounds.length >= 2, 'context 404 and submit 404 share one generic body');
});

test('main.js mounts the public surface bare and the admin surface behind auth + module gate', () => {
  const src = readFileSync(join(ROOT, 'src', 'main.js'), 'utf8');
  assert.match(src, /app\.use\('\/api\/public\/self-return', selfReturnPublicRouter\);/);
  assert.match(src, /app\.use\('\/api\/self-return', requireAuth, tenantRateLimit, requireModuleAccess\('reservations'\), selfReturnAdminRouter\);/);
});

test('the notification template exists in BOTH frontend locales', () => {
  for (const lang of ['en', 'es']) {
    const locale = JSON.parse(readFileSync(join(ROOT, '..', 'frontend', 'src', 'locales', `${lang}.json`), 'utf8'));
    assert.ok(locale?.notifications?.evt?.selfReturn, `${lang}.json has notifications.evt.selfReturn`);
    assert.ok(locale?.checkinWizard?.selfReturnApplied, `${lang}.json has checkinWizard.selfReturnApplied`);
  }
});
