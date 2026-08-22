// Staff 2FA core service (2026-08-22): TOTP gen/verify, step-window tolerance,
// wrong code, backup-code single-use + regenerate. Runs against a fake prisma
// so no DB is needed (deps.prisma injection, same pattern as issueServiceToken).
import '../../lib/_two-factor-test-env.mjs'; // MUST be first — sets env before prisma.js constructs

import test from 'node:test';
import assert from 'node:assert/strict';
import { authenticator } from 'otplib';
import { twoFactorService } from './two-factor.service.js';
import { _resetKeyCacheForTests } from '../../lib/integration-crypto.js';

_resetKeyCacheForTests();

const STEP_MS = 30 * 1000;

function makeFakePrisma(user) {
  const users = new Map();
  users.set(user.id, { ...user });
  let backupCodes = [];
  let idc = 0;
  return {
    user: {
      async findUnique({ where, select }) {
        const u = users.get(where.id);
        if (!u) return null;
        if (!select) return { ...u };
        const out = {};
        for (const k of Object.keys(select)) out[k] = u[k] ?? null;
        return out;
      },
      async findFirst({ where }) {
        const u = users.get(where.id);
        return u ? { ...u } : null;
      },
      async update({ where, data }) {
        const u = users.get(where.id);
        Object.assign(u, data);
        return { ...u };
      }
    },
    twoFactorBackupCode: {
      async deleteMany({ where }) {
        const before = backupCodes.length;
        backupCodes = backupCodes.filter((c) => c.userId !== where.userId);
        return { count: before - backupCodes.length };
      },
      async create({ data }) {
        const row = { id: `bc${++idc}`, usedAt: null, createdAt: new Date(), ...data };
        backupCodes.push(row);
        return { ...row };
      },
      async findMany({ where }) {
        return backupCodes
          .filter((c) => c.userId === where.userId && (where.usedAt === null ? c.usedAt === null : true))
          .map((c) => ({ ...c }));
      },
      async update({ where, data }) {
        const row = backupCodes.find((c) => c.id === where.id);
        Object.assign(row, data);
        return { ...row };
      },
      // Atomic conditional claim used by consumeBackupCode: only updates rows
      // matching the FULL where (incl. usedAt:null) and reports how many. This
      // is what makes the single-use guard race-safe.
      async updateMany({ where, data }) {
        const matches = backupCodes.filter((c) =>
          (where.id === undefined || c.id === where.id) &&
          (where.userId === undefined || c.userId === where.userId) &&
          (where.usedAt === null ? c.usedAt === null : true)
        );
        for (const row of matches) Object.assign(row, data);
        return { count: matches.length };
      },
      async count({ where }) {
        return backupCodes.filter((c) => c.userId === where.userId && c.usedAt === null).length;
      }
    }
  };
}

async function enrolledSetup() {
  const db = makeFakePrisma({ id: 'u1', email: 'a@b.com', twoFactorEnabled: false });
  const deps = { prisma: db };
  const started = await twoFactorService.startEnrollment('u1', 'a@b.com', 'Ride Fleet', deps);
  const code = authenticator.generate(started.secret);
  const enabled = await twoFactorService.verifyAndEnable('u1', code, deps);
  return { db, deps, secret: started.secret, backupCodes: enabled.backupCodes };
}

test('startEnrollment stores a pending secret and returns a QR data URL', async () => {
  const db = makeFakePrisma({ id: 'u1', email: 'a@b.com', twoFactorEnabled: false });
  const out = await twoFactorService.startEnrollment('u1', 'a@b.com', 'Ride Fleet', { prisma: db });
  assert.ok(out.otpauthUri.startsWith('otpauth://totp/'));
  assert.ok(out.qrDataUrl.startsWith('data:image/png;base64,'));
  const stored = await db.user.findUnique({ where: { id: 'u1' }, select: { twoFactorPendingSecret: true, twoFactorEnabled: true } });
  assert.ok(stored.twoFactorPendingSecret, 'pending secret written');
  assert.equal(stored.twoFactorEnabled, false, 'not enabled until verify');
});

test('verifyAndEnable promotes the secret, enables 2FA, and returns backup codes', async () => {
  const { db, backupCodes } = await enrolledSetup();
  const u = await db.user.findUnique({ where: { id: 'u1' }, select: { twoFactorEnabled: true, twoFactorSecret: true, twoFactorPendingSecret: true, twoFactorEnrolledAt: true } });
  assert.equal(u.twoFactorEnabled, true);
  assert.ok(u.twoFactorSecret, 'active secret set');
  assert.equal(u.twoFactorPendingSecret, null, 'pending cleared');
  assert.ok(u.twoFactorEnrolledAt, 'enrolledAt stamped');
  assert.equal(backupCodes.length, 10);
});

test('verifyAndEnable rejects a wrong code and stays unenrolled', async () => {
  const db = makeFakePrisma({ id: 'u1', email: 'a@b.com', twoFactorEnabled: false });
  const deps = { prisma: db };
  await twoFactorService.startEnrollment('u1', 'a@b.com', 'Ride Fleet', deps);
  await assert.rejects(() => twoFactorService.verifyAndEnable('u1', '000000', deps), /Invalid authentication code/);
  const u = await db.user.findUnique({ where: { id: 'u1' }, select: { twoFactorEnabled: true } });
  assert.equal(u.twoFactorEnabled, false);
});

test('verifyCode accepts a fresh code and rejects a wrong one', async () => {
  const { deps, secret } = await enrolledSetup();
  assert.equal(await twoFactorService.verifyCode('u1', authenticator.generate(secret), deps), true);
  assert.equal(await twoFactorService.verifyCode('u1', '000000', deps), false);
});

test('verifyCode tolerates one step of clock skew but not three', async () => {
  const { deps, secret } = await enrolledSetup();
  const prevStep = authenticator.clone({ epoch: Date.now() - STEP_MS }).generate(secret);
  assert.equal(await twoFactorService.verifyCode('u1', prevStep, deps), true, 'previous 30s step accepted (window:1)');
  const wayOld = authenticator.clone({ epoch: Date.now() - 3 * STEP_MS }).generate(secret);
  assert.equal(await twoFactorService.verifyCode('u1', wayOld, deps), false, '90s-old code rejected');
});

test('backup codes are single-use', async () => {
  const { deps, backupCodes } = await enrolledSetup();
  const code = backupCodes[0];
  assert.equal(await twoFactorService.consumeBackupCode('u1', code, deps), true, 'first use accepted');
  assert.equal(await twoFactorService.consumeBackupCode('u1', code, deps), false, 'second use rejected');
});

test('concurrent consume of the SAME code wins exactly once (atomic claim)', async () => {
  // Two requests present the same code before either has committed. The
  // conditional updateMany (usedAt:null guard) must let exactly one win — a
  // plain update-by-id would let both stamp the row and both succeed.
  const { deps, backupCodes } = await enrolledSetup();
  const code = backupCodes[0];
  const results = await Promise.all([
    twoFactorService.consumeBackupCode('u1', code, deps),
    twoFactorService.consumeBackupCode('u1', code, deps)
  ]);
  assert.equal(results.filter(Boolean).length, 1, 'exactly one of the concurrent consumes succeeds');
});

test('backup codes are case-insensitive on input', async () => {
  const { deps, backupCodes } = await enrolledSetup();
  assert.equal(await twoFactorService.consumeBackupCode('u1', backupCodes[1].toLowerCase(), deps), true);
});

test('regenerate invalidates the old set and issues a new one', async () => {
  const { deps, backupCodes } = await enrolledSetup();
  const oldCode = backupCodes[2];
  const { backupCodes: fresh } = await twoFactorService.regenerateBackupCodes('u1', deps);
  assert.equal(fresh.length, 10);
  assert.equal(await twoFactorService.consumeBackupCode('u1', oldCode, deps), false, 'old code no longer valid');
  assert.equal(await twoFactorService.consumeBackupCode('u1', fresh[0], deps), true, 'new code valid');
});

test('disableFor clears secret, flags, and backup codes', async () => {
  const { db, deps } = await enrolledSetup();
  await twoFactorService.disableFor('u1', deps);
  const u = await db.user.findUnique({ where: { id: 'u1' }, select: { twoFactorEnabled: true, twoFactorSecret: true } });
  assert.equal(u.twoFactorEnabled, false);
  assert.equal(u.twoFactorSecret, null);
  const status = await twoFactorService.status('u1', deps);
  assert.equal(status.enabled, false);
  assert.equal(status.backupCodesRemaining, 0);
});

test('status reports remaining backup codes without leaking secrets', async () => {
  const { deps, backupCodes } = await enrolledSetup();
  await twoFactorService.consumeBackupCode('u1', backupCodes[0], deps);
  const status = await twoFactorService.status('u1', deps);
  assert.equal(status.enabled, true);
  assert.equal(status.backupCodesRemaining, 9);
  assert.ok(!('twoFactorSecret' in status));
});
