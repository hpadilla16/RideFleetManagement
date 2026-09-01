/**
 * Notification Center MVP (2026-09-01). Run via: npm run test:notifications
 *
 * Covers, in order:
 *  A. Model discipline — the 20260901_notification_center migration against
 *     schema.prisma (column parity for both tables), additive/idempotent
 *     statement rules, and the pinned-predecessor sort (same mechanism as
 *     billing-model.test.mjs: pinned against the migration that was newest
 *     when this one shipped, NOT against "newest in repo").
 *  B. The emit side — envelope create, dedupe upsert semantics, severity and
 *     sourceType validation, the Safe wrapper never throwing.
 *  C. Scope + role visibility — tenant fail-closed, effectiveLocationIds with
 *     tenant-wide (null-location) rows, billing → ADMIN filtering at the API.
 *  D. Read vs acknowledge — read is per-user (NotificationRead only), ack is
 *     per-tenant with WHO+WHEN, delegation map (GEOFENCE → dismiss write,
 *     TOLL → tollsService.acknowledgeTollAlert), badge = unread
 *     CRITICAL+NEEDS_ACTION only (INFO never badges).
 *  E. The five emitters — each wired at its existing choke point (source
 *     assertions on the exact host functions), plus a real DI invocation of
 *     the dunning sweep and the daily maintenance/registration sweep.
 *  F. The mount — requireAuth + tenantRateLimit, NO requireModuleAccess
 *     (payment-capabilities precedent), scheduler registered in worker.js.
 *
 * DB-FREE: prisma model methods are monkeypatched per test (same technique as
 * payment-capabilities.test.mjs); the Prisma client never connects.
 */

// MUST be first — sets DATABASE_URL etc. before lib/prisma.js constructs.
import '../../lib/_two-factor-test-env.mjs';

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { join } from 'node:path';

import { prisma } from '../../lib/prisma.js';
import {
  emitNotification,
  emitNotificationSafe,
  ackNotificationBySourceRefSafe,
  NOTIFICATION_SEVERITIES,
  NOTIFICATION_SOURCE_TYPES,
} from './notifications-emit.js';
import {
  notificationsService,
  visibilityWhere,
  BADGE_SEVERITIES,
} from './notifications.service.js';
import { notificationsRouter } from './notifications.routes.js';
import {
  emitMaintenanceOverdueForTenant,
  emitRegistrationExpiryForTenant,
  msUntilNextRun,
} from './notifications.scheduler.js';
import { runDunningSweep } from '../billing/billing-dunning.service.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = fileURLToPath(new URL('../../../', import.meta.url));

// ───────────────────────── A. model / migration discipline ─────────────────

const MIGRATION_DIR = '20260901_notification_center';
// The migration that was newest when this one shipped. Pinned predecessor,
// not "newest in repo" — see billing-model.test.mjs for why.
const MIGRATION_PREDECESSOR = '20260828_tenant_billing_previous_status_backfill';
const SQL = readFileSync(join(ROOT, 'prisma', 'migrations', MIGRATION_DIR, 'migration.sql'), 'utf8');
const SCHEMA = readFileSync(join(ROOT, 'prisma', 'schema.prisma'), 'utf8');
// Comment-stripped for statement-level assertions (the prose names the very
// things the assertions forbid).
const STATEMENTS = SQL.replace(/^\s*--.*$/gm, '');

function sqlColumns(table) {
  const re = new RegExp(`CREATE TABLE IF NOT EXISTS "${table}" \\(([\\s\\S]*?)\\n\\);`);
  const body = re.exec(SQL)?.[1];
  assert.ok(body, `migration has no CREATE TABLE for ${table}`);
  const cols = new Set();
  for (const line of body.split('\n')) {
    const m = /^\s*"(\w+)"\s/.exec(line);
    if (m) cols.add(m[1]);
  }
  return cols;
}

function prismaFields(model) {
  const re = new RegExp(`\\nmodel ${model} \\{([\\s\\S]*?)\\n\\}`);
  const body = re.exec(SCHEMA)?.[1];
  assert.ok(body, `schema.prisma has no model ${model}`);
  const fields = new Set();
  for (const line of body.split('\n')) {
    const m = /^\s{2}(\w+)\s+\S+/.exec(line);
    if (m && !m[1].startsWith('@')) fields.add(m[1]);
  }
  return fields;
}

for (const table of ['NotificationEvent', 'NotificationRead']) {
  test(`${table}: the migration and schema.prisma declare the same columns`, () => {
    const sql = sqlColumns(table);
    const fields = prismaFields(table);
    const missingInSql = [...fields].filter((k) => !sql.has(k));
    const missingInPrisma = [...sql].filter((k) => !fields.has(k));
    assert.deepEqual(missingInSql, [], `in schema.prisma but not in the migration: ${missingInSql}`);
    assert.deepEqual(missingInPrisma, [], `in the migration but not in schema.prisma: ${missingInPrisma}`);
  });
}

test('migration is additive and idempotent — no DROP/ALTER of existing tables, IF NOT EXISTS everywhere', () => {
  assert.doesNotMatch(STATEMENTS, /\bDROP\b/i, 'no DROP of any kind');
  assert.doesNotMatch(STATEMENTS, /\bALTER TABLE\b/i, 'creates its own tables only — never alters an existing one');
  assert.doesNotMatch(STATEMENTS, /\bCREATE TYPE\b/i, 'severity is TEXT, never a Postgres enum (additive rule)');
  const creates = STATEMENTS.match(/CREATE TABLE/gi) || [];
  const createsGuarded = STATEMENTS.match(/CREATE TABLE IF NOT EXISTS/gi) || [];
  assert.equal(creates.length, createsGuarded.length, 'every CREATE TABLE is IF NOT EXISTS');
  const idx = STATEMENTS.match(/CREATE (UNIQUE )?INDEX/gi) || [];
  const idxGuarded = STATEMENTS.match(/CREATE (UNIQUE )?INDEX IF NOT EXISTS/gi) || [];
  assert.equal(idx.length, idxGuarded.length, 'every CREATE INDEX is IF NOT EXISTS');
  assert.ok(/CREATE UNIQUE INDEX IF NOT EXISTS "NotificationEvent_tenantId_dedupeKey_key"/.test(STATEMENTS),
    'the (tenantId, dedupeKey) unique — the emitters\' idempotency anchor — must exist');
});

test(`${MIGRATION_DIR} sorts after its pinned predecessor`, () => {
  const dirs = readdirSync(join(ROOT, 'prisma', 'migrations'), { withFileTypes: true })
    .filter((d) => d.isDirectory()).map((d) => d.name).sort();
  const at = dirs.indexOf(MIGRATION_DIR);
  const predecessorAt = dirs.indexOf(MIGRATION_PREDECESSOR);
  assert.ok(at !== -1, `${MIGRATION_DIR} is missing from prisma/migrations`);
  assert.ok(predecessorAt !== -1, `${MIGRATION_PREDECESSOR} is missing from prisma/migrations`);
  assert.ok(at > predecessorAt,
    `${MIGRATION_DIR} sorts before ${MIGRATION_PREDECESSOR} and would be skipped on a baselined DB`);
});

// ───────────────────────── helpers: prisma monkeypatching ───────────────────

function patch(model, method, impl) {
  const orig = prisma[model][method];
  prisma[model][method] = impl;
  return () => { prisma[model][method] = orig; };
}

async function withPatches(patches, fn) {
  const restores = patches.map(([m, meth, impl]) => patch(m, meth, impl));
  try {
    return await fn();
  } finally {
    restores.reverse().forEach((r) => r());
  }
}

// ───────────────────────── B. the emit side ─────────────────────────────────

test('emitNotification upserts on (tenantId, dedupeKey) with update:{} — re-detection is a no-op', async () => {
  let call = null;
  await withPatches([
    ['notificationEvent', 'upsert', async (args) => { call = args; return { id: 'n1', ...args.create }; }],
  ], async () => {
    await emitNotification({
      tenantId: 't1', severity: 'CRITICAL', sourceType: 'GEOFENCE',
      title: 'x', dedupeKey: 'geofence:a1', paramsJson: { unit: 'U1' },
    });
  });
  assert.ok(call, 'upsert was called');
  assert.deepEqual(call.where, { tenantId_dedupeKey: { tenantId: 't1', dedupeKey: 'geofence:a1' } });
  assert.deepEqual(call.update, {}, 're-detection must never overwrite (or re-unread) the first emission');
  assert.equal(call.create.severity, 'CRITICAL');
  assert.equal(call.create.paramsJson, JSON.stringify({ unit: 'U1' }));
});

test('emitNotification validates severity and sourceType against the fixed contracts', async () => {
  await assert.rejects(() => emitNotification({ tenantId: 't', severity: 'URGENT', sourceType: 'TOLL', title: 'x', dedupeKey: 'k' }), /invalid severity/);
  await assert.rejects(() => emitNotification({ tenantId: 't', severity: 'INFO', sourceType: 'EMAIL', title: 'x', dedupeKey: 'k' }), /invalid sourceType/);
  await assert.rejects(() => emitNotification({ severity: 'INFO', sourceType: 'TOLL', title: 'x', dedupeKey: 'k' }), /tenantId/);
  assert.deepEqual([...NOTIFICATION_SEVERITIES], ['CRITICAL', 'NEEDS_ACTION', 'INFO'], 'fixed enum');
  assert.ok(NOTIFICATION_SOURCE_TYPES.includes('DOCUMENTS'), 'registration/marbete rides sourceType DOCUMENTS');
});

test('emitNotificationSafe never throws — an emitter must never break its host flow', async () => {
  await withPatches([
    ['notificationEvent', 'upsert', async () => { throw new Error('db down'); }],
  ], async () => {
    const out = await emitNotificationSafe({ tenantId: 't1', severity: 'INFO', sourceType: 'TOLL', title: 'x', dedupeKey: 'k' });
    assert.equal(out, null, 'swallowed, returned null');
  });
  // Invalid input is swallowed too.
  const out2 = await emitNotificationSafe({});
  assert.equal(out2, null);
});

// ───────────────────────── C. scope + role visibility ───────────────────────

test('visibilityWhere fails closed without a tenant (SUPER_ADMIN without ?tenantId sees nothing)', () => {
  const where = visibilityWhere({}, {}, { role: 'SUPER_ADMIN' });
  assert.deepEqual(where.AND[0], { tenantId: '__no_tenant__' });
});

test('visibilityWhere: location-scoped caller sees own sedes PLUS tenant-wide (null-location) rows', () => {
  const where = visibilityWhere({}, { tenantId: 't1', allowedLocationIds: ['sju', 'cnd'] }, { role: 'AGENT' });
  const locClause = where.AND.find((c) => c.OR);
  assert.deepEqual(locClause, { OR: [{ locationId: { in: ['sju', 'cnd'] } }, { locationId: null }] });
});

test('visibilityWhere: a ?locationId outside the caller\'s allowed set never widens the scope', () => {
  const where = visibilityWhere({ locationId: 'other' }, { tenantId: 't1', allowedLocationIds: ['sju'] }, { role: 'AGENT' });
  const locClause = where.AND.find((c) => c.OR);
  assert.deepEqual(locClause.OR[0], { locationId: { in: ['sju'] } }, 'falls back to own sedes');
});

test('billing rows (audienceRole ADMIN) are filtered at the API for non-admin roles', () => {
  const agent = visibilityWhere({}, { tenantId: 't1' }, { role: 'AGENT' });
  assert.ok(agent.AND.some((c) => c.audienceRole === null), 'AGENT: audienceRole=null rows only');
  const admin = visibilityWhere({}, { tenantId: 't1' }, { role: 'ADMIN' });
  assert.ok(!admin.AND.some((c) => c.audienceRole === null), 'ADMIN sees role-gated rows too');
});

// ───────────────────────── D. read vs acknowledge ───────────────────────────

test('badge severities are CRITICAL + NEEDS_ACTION — INFO never badges', () => {
  assert.deepEqual([...BADGE_SEVERITIES], ['CRITICAL', 'NEEDS_ACTION']);
});

test('unreadCount counts badge-severity, unresolved, unacked rows minus this user\'s reads', async () => {
  let eventWhere = null;
  const count = await withPatches([
    ['notificationEvent', 'findMany', async (args) => {
      eventWhere = args.where;
      return [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
    }],
    ['notificationRead', 'findMany', async ({ where }) => {
      assert.equal(where.userId, 'u1');
      return [{ notificationId: 'b' }];
    }],
  ], () => notificationsService.unreadCount({}, { tenantId: 't1' }, { id: 'u1', role: 'AGENT' }));
  assert.equal(count, 2, '3 visible minus 1 read');
  const sevClause = eventWhere.AND.find((c) => c.severity);
  assert.deepEqual(sevClause, { severity: { in: ['CRITICAL', 'NEEDS_ACTION'] } }, 'INFO never counts');
  assert.ok(eventWhere.AND.some((c) => c.resolvedAt === null), 'self-resolved rows never badge');
  assert.ok(eventWhere.AND.some((c) => c.ackAt === null), 'acknowledged work never badges');
});

test('markRead writes ONLY the per-user read row — never the envelope (read ≠ acknowledge)', async () => {
  let readUpsert = null;
  let eventWrites = 0;
  await withPatches([
    ['notificationEvent', 'findFirst', async () => ({ id: 'n1' })],
    ['notificationEvent', 'update', async () => { eventWrites += 1; return {}; }],
    ['notificationRead', 'upsert', async (args) => { readUpsert = args; return {}; }],
  ], () => notificationsService.markRead('n1', {}, { tenantId: 't1' }, { id: 'u1', role: 'AGENT' }));
  assert.deepEqual(readUpsert.where, { userId_notificationId: { userId: 'u1', notificationId: 'n1' } });
  assert.equal(eventWrites, 0, 'reading is personal — the team-visible envelope is untouched');
});

test('markRead 404s for a row outside the caller\'s visibility', async () => {
  await withPatches([
    ['notificationEvent', 'findFirst', async () => null],
  ], async () => {
    await assert.rejects(
      () => notificationsService.markRead('n-other-tenant', {}, { tenantId: 't1' }, { id: 'u1', role: 'AGENT' }),
      (e) => e.status === 404,
    );
  });
});

test('markAllRead clears the personal badge only — createMany on reads, zero envelope writes', async () => {
  let created = null;
  let eventWrites = 0;
  await withPatches([
    ['notificationEvent', 'findMany', async () => [{ id: 'a' }, { id: 'b' }]],
    ['notificationEvent', 'update', async () => { eventWrites += 1; return {}; }],
    ['notificationEvent', 'updateMany', async () => { eventWrites += 1; return {}; }],
    ['notificationRead', 'createMany', async (args) => { created = args; return { count: 2 }; }],
  ], () => notificationsService.markAllRead({}, { tenantId: 't1' }, { id: 'u1', role: 'AGENT' }));
  assert.equal(created.skipDuplicates, true);
  assert.equal(created.data.length, 2);
  assert.equal(eventWrites, 0, '"Mark all read" never acknowledges on behalf of the team');
});

test('acknowledge (GEOFENCE) delegates to the SAME dismiss write as the dashboard, then stamps WHO+WHEN', async () => {
  let dismiss = null;
  let stamp = null;
  const out = await withPatches([
    ['notificationEvent', 'findFirst', async () => ({
      id: 'n1', tenantId: 't1', sourceType: 'GEOFENCE', sourceRefId: 'alert9', ackAt: null,
    })],
    ['overdueVehicleAlert', 'updateMany', async (args) => { dismiss = args; return { count: 1 }; }],
    ['notificationEvent', 'update', async (args) => { stamp = args; return {}; }],
    ['notificationRead', 'upsert', async () => ({})],
  ], () => notificationsService.acknowledge('n1', {}, { tenantId: 't1' }, { id: 'u1', role: 'OPS', name: 'M. Ortiz' }));
  assert.deepEqual(dismiss.where, { id: 'alert9', tenantId: 't1', status: 'OPEN' }, 'the source endpoint\'s own statement');
  assert.equal(dismiss.data.status, 'DISMISSED', 'never a parallel resolution state');
  assert.equal(stamp.data.ackByUserId, 'u1');
  assert.equal(stamp.data.ackByName, 'M. Ortiz', 'the center shows WHO acknowledged');
  assert.ok(stamp.data.ackAt instanceof Date, '...and WHEN');
  assert.equal(out.alreadyAcknowledged, false);
});

test('acknowledge is per-tenant: a second ack short-circuits with the original stamp', async () => {
  const firstAck = new Date('2026-09-01T13:44:00Z');
  let writes = 0;
  const out = await withPatches([
    ['notificationEvent', 'findFirst', async () => ({
      id: 'n1', tenantId: 't1', sourceType: 'SHUTTLE', sourceRefId: 'r1',
      ackAt: firstAck, ackByName: 'M. Ortiz',
    })],
    ['notificationEvent', 'update', async () => { writes += 1; return {}; }],
  ], () => notificationsService.acknowledge('n1', {}, { tenantId: 't1' }, { id: 'u2', role: 'AGENT', name: 'J. Rivera' }));
  assert.equal(out.alreadyAcknowledged, true);
  assert.equal(out.ackByName, 'M. Ortiz', 'the first acknowledger stands');
  assert.equal(writes, 0);
});

test('acknowledge (center-local sources) stamps the envelope without touching any source table', async () => {
  let stamp = null;
  let alertWrites = 0;
  await withPatches([
    ['notificationEvent', 'findFirst', async () => ({
      id: 'n2', tenantId: 't1', sourceType: 'KIOSK', sourceRefId: 's1', ackAt: null,
    })],
    ['overdueVehicleAlert', 'updateMany', async () => { alertWrites += 1; return { count: 0 }; }],
    ['notificationEvent', 'update', async (args) => { stamp = args; return {}; }],
    ['notificationRead', 'upsert', async () => ({})],
  ], () => notificationsService.acknowledge('n2', {}, { tenantId: 't1' }, { id: 'u1', role: 'OPS', name: 'A' }));
  assert.equal(alertWrites, 0, 'no delegation for sources without a resolution endpoint');
  assert.ok(stamp.data.ackAt instanceof Date);
});

test('source-side ack mirrors onto the envelope (toll tray / dashboard dismiss stay the owners)', async () => {
  let mirrored = null;
  await withPatches([
    ['notificationEvent', 'updateMany', async (args) => { mirrored = args; return { count: 1 }; }],
  ], () => ackNotificationBySourceRefSafe({ tenantId: 't1', sourceType: 'TOLL', sourceRefId: 'tx1', userId: 'u9' }));
  assert.deepEqual(mirrored.where, { tenantId: 't1', sourceType: 'TOLL', sourceRefId: 'tx1', ackAt: null });
  assert.equal(mirrored.data.ackByUserId, 'u9');
});

test('archiveOldNotifications: 30-day cutoff, bounded batch, prunes the read rows', async () => {
  const now = new Date('2026-09-01T09:10:00Z');
  let findArgs = null; let archived = null; let pruned = null;
  const out = await withPatches([
    ['notificationEvent', 'findMany', async (args) => { findArgs = args; return [{ id: 'old1' }, { id: 'old2' }]; }],
    ['notificationEvent', 'updateMany', async (args) => { archived = args; return { count: 2 }; }],
    ['notificationRead', 'deleteMany', async (args) => { pruned = args; return { count: 3 }; }],
  ], () => notificationsService.archiveOldNotifications({ now }));
  assert.equal(findArgs.take, 1000, 'bounded — never an unbounded mass update');
  const cutoff = findArgs.where.createdAt.lt;
  assert.equal(Math.round((now - cutoff) / 86400000), 30);
  assert.deepEqual(archived.where, { id: { in: ['old1', 'old2'] } });
  assert.deepEqual(pruned.where, { notificationId: { in: ['old1', 'old2'] } });
  assert.equal(out.archived, 2);
});

// ───────────────────────── E. the five emitters ─────────────────────────────

function moduleSource(rel) {
  return readFileSync(path.join(__dirname, rel), 'utf8');
}

test('emitter 1 (overdue geofence) fires on the CREATE branch only, with per-alert dedupe + self-resolve', () => {
  const src = moduleSource('../vehicles/overdue-locate.service.js');
  assert.match(src, /emitNotificationSafe\(/, 'emitter present');
  assert.match(src, /dedupeKey: `geofence:\$\{createdAlert\.id\}`/, 'deduped per alert birth');
  assert.match(src, /severity: 'CRITICAL'/);
  // The emit must reference the CREATED alert — impossible from the position-
  // refresh update branch, which would re-notify every sweep tick.
  assert.match(src, /const createdAlert = await prisma\.overdueVehicleAlert\.create/);
  assert.match(src, /resolveNotificationSafe\(\{ tenantId, sourceType: 'GEOFENCE', sourceRefId: existing\.id \}\)/,
    'back-inside-geofence marks the envelope self-resolved');
});

test('emitter 2 (toll staff alert) fires after the staffNotifiedAt claim, ABOVE the alertEmailFor guard', () => {
  const src = moduleSource('../tolls/tolls.service.js');
  const claim = src.indexOf('if (claimed.count !== 1) continue;');
  const emit = src.indexOf("dedupeKey: `toll:${toll.id}`");
  const emailGuard = src.indexOf('const to = await alertEmailFor(toll.locationId);');
  assert.ok(claim > -1 && emit > -1 && emailGuard > -1);
  assert.ok(claim < emit, 'only a claimed (exactly-once) toll emits');
  assert.ok(emit < emailGuard, 'a sede without alertEmail still gets the envelope — the email guard must not gate it');
  assert.match(src, /sourceType: 'TOLL',\s*\n\s*sourceRefId: toll\.id/, 'sourceRef = the transaction (ack delegation anchor)');
  // ...and the tray ack mirrors back onto the envelope.
  assert.match(src, /ackNotificationBySourceRefSafe\(\{\s*\n\s*tenantId: row\.tenantId,\s*\n\s*sourceType: 'TOLL'/);
});

test('emitter 3 (shuttle no-show) fires inside markNoShow with the request-id dedupe; the banner/feed stay', () => {
  const src = moduleSource('../shuttle/shuttle-requests.service.js');
  assert.match(src, /dedupeKey: `shuttle-noshow:\$\{request\.id\}`/);
  assert.match(src, /sourceType: 'SHUTTLE'/);
  assert.match(src, /severity: 'NEEDS_ACTION'/);
  // AGGREGATES, REPLACES NOTHING: the existing ShuttleAlert row (feed+toast)
  // and the staff email fan-out still run.
  assert.match(src, /type: 'REQUEST_NO_SHOW'/, 'existing alert row untouched');
  assert.match(src, /buildNoShowStaffEmail/, 'existing staff email untouched');
});

test('emitter 4 (kiosk escalation) fires beside the escalate write — CRITICAL, per-session dedupe', () => {
  const src = moduleSource('../kiosk/kiosk-session.service.js');
  assert.match(src, /dedupeKey: `kiosk-escalation:\$\{session\.id\}`/);
  assert.match(src, /sourceType: 'KIOSK'/);
  const write = src.indexOf("outcome: 'ESCALATED'");
  const emit = src.indexOf('kiosk-escalation:');
  assert.ok(write > -1 && emit > write, 'emit sits after the one ESCALATED write site');
  assert.match(src, /deepLink: '\/kiosks\?outcome=ESCALATED'/);
});

test('emitter 5 (billing dunning) — DI invocation: suspend emits an ADMIN-only CRITICAL envelope', async () => {
  const emitted = [];
  const pastDueSince = new Date('2026-08-20T00:00:00Z');
  const counts = await runDunningSweep({
    env: { BILLING_DUNNING_ENABLED: 'true' },
    now: () => new Date('2026-09-01T09:00:00Z'),
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    prisma: {
      tenantSubscription: { findMany: async () => [{ id: 'sub1', tenantId: 't1', pastDueSince, lastFailureCode: 'ARB_SUSPENDED' }] },
      tenant: { findUnique: async () => ({ id: 't1', status: 'ACTIVE' }) },
    },
    suspendTenantAccess: async () => ({ ok: true }),
    notifyOwner: async () => ({ ok: true }),
    emitNotification: async (input) => { emitted.push(input); return { id: 'n' }; },
  });
  assert.equal(counts.suspended, 1);
  assert.equal(emitted.length, 1);
  const e = emitted[0];
  assert.equal(e.tenantId, 't1');
  assert.equal(e.severity, 'CRITICAL');
  assert.equal(e.sourceType, 'BILLING');
  assert.equal(e.audienceRole, 'ADMIN', 'billing → ADMIN, filtered at the API');
  assert.equal(e.dedupeKey, 'dunning-suspended:sub1:2026-08-20', 'one per delinquency episode');
});

test('daily sweep: maintenance OVERDUE emits per (schedule, baseline); due-soon stays on the dashboards', async () => {
  const emitted = [];
  const stub = {
    due: async (query, scope) => {
      assert.equal(scope.tenantId, 't1', 'sweep must pass an explicit tenant — due() is cross-tenant on empty scope');
      return {
        items: [
          { id: 's1', serviceType: 'LOF', state: 'OVERDUE', lastServiceMiles: 47500, dueByMiles: -1230, vehicle: { internalNumber: 'UNIT-025', homeLocationId: 'sju' } },
          { id: 's2', serviceType: 'TIRE_ROTATION', state: 'SOON', lastServiceMiles: 1, dueByMiles: 370, vehicle: { internalNumber: 'UNIT-025', homeLocationId: 'sju' } },
        ],
      };
    },
  };
  const n = await emitMaintenanceOverdueForTenant('t1', {
    maintenanceService: stub,
    emit: async (input) => { emitted.push(input); },
  });
  assert.equal(n, 1, 'only the OVERDUE row emits');
  assert.equal(emitted[0].severity, 'NEEDS_ACTION');
  assert.equal(emitted[0].sourceType, 'MAINTENANCE');
  assert.equal(emitted[0].locationId, 'sju', 'routed to the vehicle\'s sede');
  assert.equal(emitted[0].dedupeKey, 'maint-overdue:s1:47500', 'baseline in the key re-arms after the next service');
});

test('daily sweep: registration expiry — INFO inside the 30-day window, NEEDS_ACTION once expired', async () => {
  const emitted = [];
  const now = new Date('2026-09-01T00:00:00Z');
  const fakePrisma = {
    vehicle: {
      findMany: async ({ where }) => {
        assert.equal(where.tenantId, 't1');
        assert.ok(where.registrationExpiresAt.not === null || 'not' in where.registrationExpiresAt, 'null expiry never chased');
        return [
          { id: 'v1', internalNumber: 'UNIT-031', registrationExpiresAt: new Date('2026-09-10T00:00:00Z'), homeLocationId: 'cnd' },
          { id: 'v2', internalNumber: 'UNIT-007', registrationExpiresAt: new Date('2026-08-25T00:00:00Z'), homeLocationId: null },
        ];
      },
    },
  };
  const n = await emitRegistrationExpiryForTenant('t1', { prisma: fakePrisma, now, emit: async (i) => { emitted.push(i); } });
  assert.equal(n, 2);
  const windowEvt = emitted.find((e) => e.dedupeKey.startsWith('reg-expiry:'));
  const expiredEvt = emitted.find((e) => e.dedupeKey.startsWith('reg-expired:'));
  assert.equal(windowEvt.severity, 'INFO', 'due-soon is awareness — never badges');
  assert.equal(windowEvt.dedupeKey, 'reg-expiry:v1:2026-09-10', 'one per vehicle per expiry date');
  assert.equal(expiredEvt.severity, 'NEEDS_ACTION', 'crossing into expired is owned work');
  assert.equal(expiredEvt.sourceType, 'DOCUMENTS');
});

test('sweep runs daily (next run always within 24h)', () => {
  const ms = msUntilNextRun(new Date('2026-09-01T09:10:00.001Z'));
  assert.ok(ms > 0 && ms <= 24 * 60 * 60 * 1000);
});

// ───────────────────────── F. mount + wiring ────────────────────────────────

test('main.js mounts /api/notifications with requireAuth + tenantRateLimit and WITHOUT any module gate', () => {
  const src = readFileSync(path.join(__dirname, '../../main.js'), 'utf8');
  const idx = src.indexOf("app.use('/api/notifications'");
  assert.ok(idx > -1, 'mount missing from main.js');
  const mountLine = src.slice(idx, src.indexOf('\n', idx));
  assert.match(mountLine, /requireAuth/, 'mount must require authentication');
  assert.match(mountLine, /tenantRateLimit/);
  assert.doesNotMatch(mountLine, /requireModuleAccess/, 'reachable by every staff role (payment-capabilities precedent)');
  assert.doesNotMatch(mountLine, /requireRole/, 'role-gated CATEGORIES filter in the service, not the mount');
});

test('worker.js registers the notifications sweep with the dynamic-import fail-isolation idiom', () => {
  const src = readFileSync(path.join(__dirname, '../../worker.js'), 'utf8');
  assert.match(src, /import\('\.\/modules\/notifications\/notifications\.scheduler\.js'\)/);
  assert.match(src, /startNotificationsSweepScheduler\(\)/);
});

test('GET / route handler returns the feed through scopeFor + the service (driven without supertest)', async () => {
  const layer = notificationsRouter.stack.find((l) => l.route?.path === '/' && l.route?.methods?.get);
  assert.ok(layer, 'GET / handler registered');
  const handler = layer.route.stack[0].handle;
  let sent = null;
  await withPatches([
    ['notificationEvent', 'findMany', async () => [{
      id: 'n1', tenantId: 't1', locationId: null, severity: 'CRITICAL', sourceType: 'KIOSK',
      sourceRefId: 's1', title: 'Guest waiting — kiosk session escalated', body: null,
      deepLink: '/kiosks?outcome=ESCALATED', templateKey: 'kiosk', paramsJson: '{"reason":"OTHER"}',
      audienceRole: null, ackAt: null, ackByName: null, resolvedAt: null, createdAt: new Date(),
    }]],
    ['notificationEvent', 'count', async () => 1],
    ['notificationEvent', 'groupBy', async ({ by }) => (by[0] === 'severity'
      ? [{ severity: 'CRITICAL', _count: { _all: 1 } }]
      : [{ sourceType: 'KIOSK', _count: { _all: 1 } }])],
    ['notificationRead', 'findMany', async () => []],
  ], async () => {
    const req = { user: { id: 'u1', role: 'AGENT', tenantId: 't1' }, query: {} };
    const res = { json: (body) => { sent = body; } };
    await handler(req, res, (err) => { throw err || new Error('next() without error'); });
  });
  assert.equal(sent.total, 1);
  assert.equal(sent.items[0].read, false);
  assert.deepEqual(sent.items[0].params, { reason: 'OTHER' }, 'paramsJson parsed for the client-side i18n render');
  assert.equal(sent.counts.severity.CRITICAL, 1, 'lane counts are DB-counted, like tolls queueCounts');
});
