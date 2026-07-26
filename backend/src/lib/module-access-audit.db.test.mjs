/**
 * Module-access audit trail — DB-BACKED tests against real Postgres.
 * Run via: npm run test:module-access-audit
 *   DATABASE_URL=postgresql://$(whoami)@localhost:5432/fleet_management?schema=public
 *
 * THESE MUST RUN AGAINST REAL POSTGRES, NOT A MOCK.
 * The bug this file exists to prevent is invisible to a mock: the first version
 * of the grant audit wrote to `AuditLog`, whose `reservationId` is a REQUIRED
 * String with a required relation. A permission change has no reservation, so
 * every insert threw PrismaClientValidationError straight into a best-effort
 * catch — zero rows, forever, with the code and its comments claiming it worked.
 * A stubbed prisma would have accepted the call and the suite would have been
 * green. Same family as this repo's `prisma-relation-null-trap` lesson and the
 * beta.154 "reservationId null on a required field + silent catch" incident.
 *
 * The first test below is a NEGATIVE CONTROL: it asserts that the old approach
 * still fails, so nobody "simplifies" the standalone table back into AuditLog.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { prisma } from './prisma.js';
import { recordModuleAccessAudit } from './module-access.js';

const TAG = 'test-maal-' + Date.now();
const TARGET_USER = `${TAG}-user`;
const TENANT = `${TAG}-tenant`;

async function rowsFor(targetUserId) {
  return prisma.moduleAccessAuditLog.findMany({
    where: { targetUserId },
    orderBy: { changedAt: 'desc' }
  });
}

before(async () => {
  await prisma.$queryRaw`SELECT 1`;
});

after(async () => {
  await prisma.moduleAccessAuditLog.deleteMany({ where: { tenantId: TENANT } });
  await prisma.$disconnect();
});

test('NEGATIVE CONTROL: AuditLog genuinely cannot hold a module-access row', async () => {
  // This is what the first implementation did. If this ever stops throwing,
  // AuditLog gained an optional reservation and the standalone table could be
  // revisited — but until then, "just use AuditLog" is not an option.
  await assert.rejects(
    () =>
      prisma.auditLog.create({
        data: {
          tenantId: null,
          action: 'ADMIN_OVERRIDE',
          actorUserId: null,
          reason: 'module access changed',
          metadata: JSON.stringify({ changed: [] })
        }
      }),
    (err) => {
      const msg = String(err?.message || '');
      assert.match(
        msg,
        /reservation/i,
        `expected a missing-reservation error, got: ${msg.slice(0, 200)}`
      );
      return true;
    },
    'AuditLog.reservationId is required — a permission change has no reservation to attach'
  );
});

test('a USER grant writes a real, queryable row', async () => {
  const changed = await recordModuleAccessAudit({
    scope: 'USER',
    tenantId: TENANT,
    targetUserId: TARGET_USER,
    actor: { sub: `${TAG}-actor`, role: 'ADMIN' },
    before: { paymentActions: false, reservations: true },
    after: { paymentActions: true, reservations: true }
  });

  assert.deepEqual(changed, [{ module: 'paymentActions', from: false, to: true }]);

  const rows = await rowsFor(TARGET_USER);
  assert.equal(rows.length, 1, 'exactly one audit row must have been PERSISTED');
  assert.equal(rows[0].scope, 'USER');
  assert.equal(rows[0].tenantId, TENANT);
  assert.equal(rows[0].actorUserId, `${TAG}-actor`);
  assert.equal(rows[0].actorRole, 'ADMIN');
  assert.deepEqual(rows[0].changed, [{ module: 'paymentActions', from: false, to: true }]);
  assert.ok(rows[0].changedAt instanceof Date);
});

test('the row carries NO email or name — IDs only', async () => {
  const rows = await rowsFor(TARGET_USER);
  const serialized = JSON.stringify(rows[0]);
  assert.doesNotMatch(serialized, /@/, 'no email address may be copied into an audit row');
  const columns = Object.keys(rows[0]);
  assert.deepEqual(
    columns.filter((c) => /email|name|phone/i.test(c)),
    [],
    'the table must not carry PII columns'
  );
});

test('a revoke is recorded with the direction the right way round', async () => {
  await recordModuleAccessAudit({
    scope: 'USER',
    tenantId: TENANT,
    targetUserId: TARGET_USER,
    actor: { sub: `${TAG}-actor`, role: 'ADMIN' },
    before: { paymentActions: true },
    after: { paymentActions: false }
  });
  const rows = await rowsFor(TARGET_USER);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0].changed, [{ module: 'paymentActions', from: true, to: false }]);
});

test('a no-op save writes nothing (People PUTs the whole map on every edit)', async () => {
  const beforeCount = (await rowsFor(TARGET_USER)).length;
  const changed = await recordModuleAccessAudit({
    scope: 'USER',
    tenantId: TENANT,
    targetUserId: TARGET_USER,
    actor: { sub: `${TAG}-actor`, role: 'ADMIN' },
    before: { paymentActions: true, reservations: true },
    after: { paymentActions: true, reservations: true }
  });
  assert.deepEqual(changed, []);
  assert.equal(
    (await rowsFor(TARGET_USER)).length,
    beforeCount,
    'editing a phone number must not spam the audit table'
  );
});

test('TENANT scope writes a row with no target user', async () => {
  await recordModuleAccessAudit({
    scope: 'TENANT',
    tenantId: TENANT,
    actor: { sub: `${TAG}-actor`, role: 'ADMIN' },
    before: { paymentActions: true },
    after: { paymentActions: false }
  });
  const rows = await prisma.moduleAccessAuditLog.findMany({
    where: { tenantId: TENANT, scope: 'TENANT' }
  });
  assert.equal(rows.length, 1, 'the tenant-wide switch must be audited too');
  assert.equal(rows[0].targetUserId, null);
  assert.deepEqual(rows[0].changed, [{ module: 'paymentActions', from: true, to: false }]);
});

test('STORED-vs-STORED: an absent key is not a change to false', async () => {
  // The second defect in the first implementation: it compared the EFFECTIVE
  // map (role ∧ tenant ∧ stored) against the STORED map. A user with no stored
  // override has {} — comparing that to an effective map full of role-derived
  // trues invents a phantom "revoked everything" row on a save that changed
  // nothing. Both sides must come from the same layer.
  const target = `${TARGET_USER}-stored`;
  const changed = await recordModuleAccessAudit({
    scope: 'USER',
    tenantId: TENANT,
    targetUserId: target,
    actor: { sub: `${TAG}-actor`, role: 'ADMIN' },
    before: {}, // no stored override yet
    after: {} // still none
  });
  assert.deepEqual(changed, [], 'empty stored -> empty stored is not a change');
  assert.equal((await rowsFor(target)).length, 0);
});

test('REMOVING an explicit override is a change, not a no-op', async () => {
  // The value-only diff read this as `false -> false` and wrote nothing. But
  // dropping an explicit {paymentActions:false} hands the user back the ROLE
  // DEFAULT, which is `true` for ADMIN/OPS — i.e. it GRANTS the ability to
  // charge and refund a card, silently and untraceably. Absent is a third
  // state, not a synonym for false.
  const target = `${TARGET_USER}-removed`;
  const changed = await recordModuleAccessAudit({
    scope: 'USER',
    tenantId: TENANT,
    targetUserId: target,
    actor: { sub: `${TAG}-actor`, role: 'ADMIN' },
    before: { paymentActions: false, reservations: true },
    after: { reservations: true }
  });
  assert.deepEqual(changed, [{ module: 'paymentActions', from: false, to: null }]);

  const rows = await rowsFor(target);
  assert.equal(rows.length, 1, 'the removal must be PERSISTED');
  assert.deepEqual(rows[0].changed, [{ module: 'paymentActions', from: false, to: null }]);
});

test('ADDING an explicit override where there was none is a change too', async () => {
  // Mirror direction: pinning `false` on an ADMIN who was following the role
  // default REVOKES the capability. Same tri-state reasoning.
  const target = `${TARGET_USER}-added`;
  const changed = await recordModuleAccessAudit({
    scope: 'USER',
    tenantId: TENANT,
    targetUserId: target,
    actor: { sub: `${TAG}-actor`, role: 'ADMIN' },
    before: { reservations: true },
    after: { paymentActions: false, reservations: true }
  });
  assert.deepEqual(changed, [{ module: 'paymentActions', from: null, to: false }]);
  assert.equal((await rowsFor(target)).length, 1);
});

test('audit failure never blocks the permission change', async () => {
  // Best-effort by design. Force a write error and assert it resolves.
  const original = prisma.moduleAccessAuditLog.create;
  prisma.moduleAccessAuditLog.create = async () => {
    throw new Error('simulated DB outage');
  };
  try {
    await assert.doesNotReject(() =>
      recordModuleAccessAudit({
        scope: 'USER',
        tenantId: TENANT,
        targetUserId: `${TARGET_USER}-fail`,
        actor: { sub: `${TAG}-actor`, role: 'ADMIN' },
        before: { paymentActions: false },
        after: { paymentActions: true }
      })
    );
  } finally {
    prisma.moduleAccessAuditLog.create = original;
  }
});
