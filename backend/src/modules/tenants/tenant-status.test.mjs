/**
 * Tenant.status is a closed vocabulary.
 *
 * `Tenant.status` is a free-text String in the schema and used to be written
 * with a bare `String(x).toUpperCase()`, so ANY string was accepted. That is a
 * production hazard in both directions:
 *
 *   - a typo ('ACTIVEE') fails the exact `status: 'ACTIVE'` match that gates the
 *     public booking site, the car-sharing marketplace and the integration
 *     schedulers — silently darkening a paying tenant with no error anywhere;
 *   - the reverse, flipping the DEMO tenant to ACTIVE, publishes demo inventory
 *     into the public marketplace.
 *
 * So these tests care about REFUSING far more than about accepting.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://test:test@localhost:5432/test';
const { TENANT_STATUSES, normalizeTenantStatus, tenantsService } = await import('./tenants.service.js');

// ── the vocabulary itself ───────────────────────────────────────────────────

test('the vocabulary is exactly what production contains', () => {
  // Census against the production database, 2026-08-28: ACTIVE (4 tenants),
  // SUSPENDED (3), DEMO (1). Widening this list is a product decision, not a
  // refactor — every value here is a value the public-surface gates must cope
  // with, so a new one needs its blast radius checked first.
  assert.deepEqual(TENANT_STATUSES, ['ACTIVE', 'SUSPENDED', 'DEMO']);
});

test('DEMO is in the vocabulary because a production tenant has it', () => {
  // cmn6d5ax80002s10izy80l4ei is DEMO. Omitting it would make that tenant's
  // status unsettable from the only screen that edits it.
  //
  // NOT because anything restores it: AdminAuditLog carries a real
  // TENANT_SUSPEND with previousTenantStatus='DEMO', but nothing reads that key
  // back — restoreTenantAccess hardcodes 'ACTIVE'. That gap is real and open;
  // this list does not close it.
  assert.ok(TENANT_STATUSES.includes('DEMO'));
});

// ── rejecting ───────────────────────────────────────────────────────────────

test('a typo is rejected, not written', () => {
  // The whole point: 'ACTIVEE' is one keystroke from 'ACTIVE' and used to be
  // accepted, darkening the tenant everywhere at once.
  for (const bad of ['ACTIVEE', 'ACTIV', 'active!', 'PAUSED', 'DELETED', 'NONE', '0', 'ACTIVE ACTIVE']) {
    assert.throws(
      () => normalizeTenantStatus(bad),
      (e) => /status must be one of ACTIVE, SUSPENDED, DEMO/.test(e.message),
      `${JSON.stringify(bad)} must be refused`,
    );
  }
});

test('the refusal names the legal values so the admin can fix it', () => {
  assert.throws(
    () => normalizeTenantStatus('ACTIVEE'),
    (e) => e.message.includes('ACTIVE') && e.message.includes('SUSPENDED') && e.message.includes('DEMO'),
  );
});

test('rejects rather than silently coercing to a fallback', () => {
  // A fallback here would tell the admin the save worked while the tenant kept
  // its old status — the same invisible failure the allowlist exists to end.
  assert.throws(() => normalizeTenantStatus('ACTIVEE', 'ACTIVE'));
});

// ── accepting ───────────────────────────────────────────────────────────────

test('accepts every legal value, and normalises case and padding', () => {
  for (const status of TENANT_STATUSES) {
    assert.equal(normalizeTenantStatus(status), status);
    assert.equal(normalizeTenantStatus(status.toLowerCase()), status);
    assert.equal(normalizeTenantStatus(`  ${status}  `), status);
  }
});

test('absent status yields the caller fallback, not a write', () => {
  // createTenant defaults to ACTIVE; updateTenant passes no fallback, so an
  // absent status must come back undefined — Prisma omits undefined fields,
  // which is what leaves the stored status untouched.
  for (const empty of [undefined, null, '']) {
    assert.equal(normalizeTenantStatus(empty, 'ACTIVE'), 'ACTIVE');
    assert.equal(normalizeTenantStatus(empty), undefined);
  }
});

// ── through the service, which is where the 400 comes from ──────────────────

test('updateTenant refuses a bad status before it reaches the database', async () => {
  // Throws while building the patch, so no DB is needed to prove it — and more
  // importantly, no partial write happens.
  await assert.rejects(
    () => tenantsService.updateTenant('cmn6d5ax80002s10izy80l4ei', { status: 'ACTIVEE' }),
    (e) => /status must be one of/.test(e.message),
  );
});

test('createTenant refuses a bad status before it reaches the database', async () => {
  await assert.rejects(
    () => tenantsService.createTenant({ name: 'Acme', slug: 'acme', status: 'ACTIVEE' }),
    (e) => /status must be one of/.test(e.message),
  );
});

test('an empty status on update leaves the stored status alone', async () => {
  // Regression guard: the old code wrote String('' ).toUpperCase() === '' into
  // the column, which is not ACTIVE and therefore darkens the tenant.
  assert.equal(normalizeTenantStatus(''), undefined);
});

// ── the frontend half must not drift ────────────────────────────────────────
//
// The dropdown and the allowlist are two copies of one vocabulary. If they
// disagree the screen offers a status the API refuses, or hides one it accepts.
// This is the only place both halves load in one process: the frontend file is
// deliberately dependency-free plain ESM and CI checks out the whole repo before
// running the backend suites. Same shape as
// lib/module-access-frontend-defaults.test.mjs. Keep frontend/src/lib/tenant-status.js
// free of `next/*` and React imports or this guard stops loading.

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FRONTEND_TENANT_STATUS = path.resolve(HERE, '../../../../frontend/src/lib/tenant-status.js');
const { TENANT_STATUS_OPTIONS, statusOptionsFor, statusChipTone, isKnownStatus } = await import(
  pathToFileURL(FRONTEND_TENANT_STATUS).href
);

test('the dropdown offers exactly the statuses the API accepts', () => {
  assert.deepEqual(TENANT_STATUS_OPTIONS, TENANT_STATUSES);
});

test('every option the dropdown offers survives the allowlist', () => {
  // The real invariant: anything selectable must be savable.
  for (const status of TENANT_STATUS_OPTIONS) {
    assert.equal(normalizeTenantStatus(status), status);
  }
});

test('an unrecognized stored status is preserved, not dropped', () => {
  // Dropping it is the original bug: the select would render as nothing-selected
  // and the next save would silently submit ACTIVE.
  const options = statusOptionsFor('LEGACY_THING');
  assert.ok(options.includes('LEGACY_THING'));
  assert.deepEqual(options.slice(0, 3), TENANT_STATUSES);
});

test('a known status is not duplicated into the option list', () => {
  for (const status of TENANT_STATUSES) {
    assert.deepEqual(statusOptionsFor(status), TENANT_STATUS_OPTIONS);
  }
  assert.deepEqual(statusOptionsFor(''), TENANT_STATUS_OPTIONS);
  assert.deepEqual(statusOptionsFor(null), TENANT_STATUS_OPTIONS);
});

test('an off-case stored value is preserved with its exact spelling', () => {
  // The <select> binds the RAW column value. Appending an upper-cased entry
  // would not match it, reproducing the nothing-selected render this prevents.
  assert.deepEqual(statusOptionsFor('Active'), [...TENANT_STATUS_OPTIONS, 'Active']);
  // ...and it is still savable, because the API upper-cases before validating.
  assert.equal(normalizeTenantStatus('Active'), 'ACTIVE');
  assert.ok(isKnownStatus('Active'));
});

test('savability, not list membership, decides the "unrecognized" label', () => {
  assert.ok(isKnownStatus('  demo  '));
  assert.ok(!isKnownStatus('LEGACY_THING'));
  // The label predicate must agree with what the API will actually accept.
  for (const value of ['Active', 'demo', 'SUSPENDED']) {
    assert.equal(isKnownStatus(value), true);
    assert.doesNotThrow(() => normalizeTenantStatus(value));
  }
  assert.equal(isKnownStatus('LEGACY_THING'), false);
  assert.throws(() => normalizeTenantStatus('LEGACY_THING'));
});

test('DEMO is not painted as a warning', () => {
  // A showcase tenant is not a fault. Amber on a "Review tenant health" banner
  // would be the same misrepresentation the dropdown fix removes.
  assert.equal(statusChipTone({ status: 'DEMO' }), '');
  assert.equal(statusChipTone({ status: 'ACTIVE' }), 'good');
  assert.equal(statusChipTone({ status: 'SUSPENDED' }), 'warn');
  assert.equal(statusChipTone({ status: 'LEGACY_THING' }), 'warn');
  assert.equal(statusChipTone(null), 'neutral');
});

// ── the audit half ──────────────────────────────────────────────────────────
//
// A status flip from the Tenants screen is a lockout lever: auth.service.js
// hydrates tenant.status on every request and SUSPENDED locks a tenant's staff
// out. It used to leave no trace at all. These stub prisma directly (same shape
// as modules/audit/audit.test.mjs withAuditCreate) so no database is needed.

const { prisma } = await import('../../lib/prisma.js');

async function withTenantStubs({ prior, onAudit }, fn) {
  const orig = {
    findUnique: prisma.tenant.findUnique,
    update: prisma.tenant.update,
    create: prisma.adminAuditLog.create,
  };
  let reads = 0;
  prisma.tenant.findUnique = async () => { reads += 1; return prior; };
  prisma.tenant.update = async ({ data }) => ({ id: 't1', ...prior, ...data });
  prisma.adminAuditLog.create = async ({ data }) => { onAudit(data); return data; };
  try {
    return { result: await fn(), reads: () => reads };
  } finally {
    prisma.tenant.findUnique = orig.findUnique;
    prisma.tenant.update = orig.update;
    prisma.adminAuditLog.create = orig.create;
  }
}

test('a real status change writes one row carrying the previous value', async () => {
  const rows = [];
  await withTenantStubs(
    { prior: { status: 'DEMO', marketIntelligenceEnabled: false }, onAudit: (d) => rows.push(d) },
    () => tenantsService.updateTenant('t1', { status: 'SUSPENDED' }),
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].action, 'TENANT_STATUS_CHANGE');
  assert.equal(rows[0].targetType, 'Tenant');
  // Filed against the TARGET tenant, not the super-admin's own.
  assert.equal(rows[0].tenantId, 't1');
  assert.equal(rows[0].metadata.previousTenantStatus, 'DEMO');
  assert.equal(rows[0].metadata.newTenantStatus, 'SUSPENDED');
});

test('the row records who, from where, and impersonating whom', async () => {
  // The whole point of auditing a lockout lever.
  const rows = [];
  const req = {
    user: { id: 'super-1', email: 'boss@ride.com', role: 'SUPERADMIN', imp: 'imp-9', tenantId: 'other' },
    headers: { 'x-forwarded-for': '203.0.113.7, 10.0.0.1', 'user-agent': 'Firefox/1' },
  };
  await withTenantStubs(
    { prior: { status: 'ACTIVE', marketIntelligenceEnabled: false }, onAudit: (d) => rows.push(d) },
    () => tenantsService.updateTenant('t1', { status: 'SUSPENDED' }, { req }),
  );
  assert.equal(rows[0].actorUserId, 'super-1');
  assert.equal(rows[0].actorEmail, 'boss@ride.com');
  assert.equal(rows[0].impersonatedByUserId, 'imp-9');
  assert.equal(rows[0].ip, '203.0.113.7');
  assert.equal(rows[0].userAgent, 'Firefox/1');
  // The actor's own tenantId must NOT win over the target.
  assert.equal(rows[0].tenantId, 't1');
});

test('re-saving the same status writes no row', async () => {
  // The screen sends the whole row on every save, so an unchanged status must
  // not manufacture a trail of non-events.
  const rows = [];
  await withTenantStubs(
    { prior: { status: 'ACTIVE', marketIntelligenceEnabled: false }, onAudit: (d) => rows.push(d) },
    () => tenantsService.updateTenant('t1', { status: 'ACTIVE', name: 'Renamed' }),
  );
  assert.equal(rows.length, 0);
});

test('a save that omits status reads nothing and writes no row', async () => {
  // The extra read must not be levied on saves that cannot change the status.
  const rows = [];
  const { reads } = await withTenantStubs(
    { prior: { status: 'ACTIVE', marketIntelligenceEnabled: false }, onAudit: (d) => rows.push(d) },
    () => tenantsService.updateTenant('t1', { name: 'Renamed' }),
  );
  assert.equal(reads(), 0);
  assert.equal(rows.length, 0);
});

test('a failing audit never fails the save', async () => {
  // recordAudit swallows its own errors; the tenant write has already committed
  // by then, so a dropped trail must not surface as a failed save.
  const { result } = await withTenantStubs(
    { prior: { status: 'ACTIVE', marketIntelligenceEnabled: false },
      onAudit: () => { throw new Error('audit db down'); } },
    () => tenantsService.updateTenant('t1', { status: 'SUSPENDED' }),
  );
  assert.equal(result.status, 'SUSPENDED');
});

test('a rejected status never reaches the database and writes no row', async () => {
  const rows = [];
  const { reads } = await withTenantStubs(
    { prior: { status: 'ACTIVE', marketIntelligenceEnabled: false }, onAudit: (d) => rows.push(d) },
    async () => {
      await assert.rejects(
        () => tenantsService.updateTenant('t1', { status: 'ACTIVEE' }),
        (e) => /status must be one of/.test(e.message),
      );
    },
  );
  assert.equal(reads(), 0);
  assert.equal(rows.length, 0);
});
