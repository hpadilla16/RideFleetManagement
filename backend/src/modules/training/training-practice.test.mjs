import test from 'node:test';
import assert from 'node:assert/strict';

// The service (transitively) constructs PrismaClient at import time. These
// tests inject a fake prisma and never touch a database, but the constructor
// still demands a URL — give it a throwaway one BEFORE the dynamic import
// (a static import would hoist above this line). CI's real URL wins.
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://test:test@localhost:5432/test';
const { trainingService } = await import('./training.service.js');

const DEMO = { id: 'demo1', name: 'Demo' };
const ACTOR = { userId: 'u9', email: 'agent@irc.com', tenantId: 't-real' };

const HEALTHY = {
  id: 'prac1', tenantId: 'demo1', email: 'practica@ride.university',
  role: 'AGENT', isActive: true, mustChangePassword: false,
  isServiceAccount: false, screenLockExempt: true,
};

function world({ tenants = [DEMO], practiceUser = null, failCreateOnce = false } = {}) {
  const created = [];
  const updated = [];
  let user = practiceUser;
  let createTried = false;
  const prisma = {
    tenant: { findFirst: async () => tenants[0] || null },
    user: {
      findFirst: async () => user,
      create: async ({ data }) => {
        if (failCreateOnce && !createTried) {
          createTried = true;
          // Simulate the losing side of the unique(email) race — the winner's
          // row becomes visible for the retry lookup.
          user = { ...HEALTHY, id: 'prac-winner' };
          const e = new Error('unique'); e.code = 'P2002'; throw e;
        }
        user = { id: 'prac-new', ...data };
        created.push(user);
        return user;
      },
      update: async ({ where, data }) => { updated.push({ where, data }); user = { ...user, ...data }; return user; },
    },
  };
  return { prisma, created, updated };
}

const issueToken = (u) => `tok:${u.id}`;

test('happy path: existing healthy account mints without writes', async () => {
  const w = world({ practiceUser: HEALTHY });
  const out = await trainingService.practiceSession(ACTOR, { prisma: w.prisma, issueToken });
  assert.equal(out.token, 'tok:prac1');
  assert.equal(out.tenantName, 'Demo');
  assert.equal(w.created.length, 0);
  assert.equal(w.updated.length, 0);
});

test('first use creates the account screen-lock exempt and password-stable', async () => {
  const w = world();
  const out = await trainingService.practiceSession(ACTOR, { prisma: w.prisma, issueToken });
  assert.equal(out.token, 'tok:prac-new');
  assert.equal(w.created.length, 1);
  assert.equal(w.created[0].screenLockExempt, true);
  assert.equal(w.created[0].mustChangePassword, false);
  assert.equal(w.created[0].role, 'AGENT');
  assert.equal(w.created[0].tenantId, 'demo1');
});

test('no demo tenant is a 404, never a create elsewhere', async () => {
  const w = world({ tenants: [] });
  await assert.rejects(
    () => trainingService.practiceSession(ACTOR, { prisma: w.prisma, issueToken }),
    (e) => e.status === 404,
  );
  assert.equal(w.created.length, 0);
});

for (const [label, bad] of [
  ['squatted on another tenant', { ...HEALTHY, tenantId: 't-otro' }],
  ['deactivated', { ...HEALTHY, isActive: false }],
  ['repurposed to ADMIN', { ...HEALTHY, role: 'ADMIN' }],
  ['password-reset (mustChangePassword)', { ...HEALTHY, mustChangePassword: true }],
  ['converted to a service account', { ...HEALTHY, isServiceAccount: true }],
]) {
  test(`guard refuses a practice account ${label} with a 409`, async () => {
    const w = world({ practiceUser: bad });
    await assert.rejects(
      () => trainingService.practiceSession(ACTOR, { prisma: w.prisma, issueToken }),
      (e) => e.status === 409,
    );
  });
}

test('losing the first-use race falls back to the winner row (no 500)', async () => {
  const w = world({ failCreateOnce: true });
  const out = await trainingService.practiceSession(ACTOR, { prisma: w.prisma, issueToken });
  assert.equal(out.token, 'tok:prac-winner');
});

test('a pre-exemption row is healed to screenLockExempt', async () => {
  const w = world({ practiceUser: { ...HEALTHY, screenLockExempt: false } });
  const out = await trainingService.practiceSession(ACTOR, { prisma: w.prisma, issueToken });
  assert.equal(w.updated.length, 1);
  assert.equal(w.updated[0].data.screenLockExempt, true);
  assert.equal(out.token, 'tok:prac1');
});
