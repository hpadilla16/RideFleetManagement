/**
 * M2 P2 — optimistic versioning tests (2026-08-17). DB-free (in-memory prisma
 * stubs, dummy DATABASE_URL convention from beta-ci.yml).
 *
 * The retrocompat contract under test, in order of importance:
 *   1. NO expectedVersion → byte-for-byte the pre-P2 behavior (web wizard,
 *      kiosk and precheckin never send it — they must notice nothing)
 *   2. stateVersion bumps on transition / stampSideEffect / customer signature
 *   3. stale expectedVersion → 409 STALE_VERSION carrying the FRESH row
 *   4. matching expectedVersion → proceeds normally
 * Run: npm run test:checkout-multisurface
 */
import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { prisma } from '../../lib/prisma.js';
import { checkoutSessionService, CheckoutSessionError } from './checkout-session.service.js';

// ── minimal in-memory stubs (kiosk-checkout.test.mjs style) ─────────────────

let db;

function applyData(row, data) {
  for (const [key, val] of Object.entries(data || {})) {
    if (val && typeof val === 'object' && !(val instanceof Date) && 'increment' in val) {
      row[key] = (row[key] || 0) + val.increment;
    } else {
      row[key] = val;
    }
  }
  return row;
}

function stub(rows) {
  return {
    findFirst: async ({ where } = {}) => rows().find((r) => r.id === where?.id) || null,
    findUnique: async ({ where } = {}) => rows().find((r) => r.id === where?.id) || null,
    update: async ({ where, data } = {}) => {
      const row = rows().find((r) => r.id === where.id);
      if (!row) throw new Error('stub update: no match');
      return applyData(row, data);
    },
  };
}

beforeEach(() => {
  db = { checkoutSessions: [], agreements: [] };
  Object.assign(prisma.checkoutSession, stub(() => db.checkoutSessions));
  Object.assign(prisma.rentalAgreement, stub(() => db.agreements));
  prisma.$transaction = async (arg) => (Array.isArray(arg) ? Promise.all(arg) : arg(prisma));
});

const SIG = 'data:image/png;base64,' + 'A'.repeat(400);

function seedSession(overrides = {}) {
  const row = {
    id: 'cs1', reservationId: 'res1', agreementId: 'ra1', tenantId: 't1',
    currentStep: 'CONFIRMING', events: '[]', stateVersion: 0,
    tcCompletedAt: null, paymentCompletedAt: null, inspectionCompletedAt: null,
    customerSignedAt: null, finishedAt: null,
    ...overrides,
  };
  db.checkoutSessions.push(row);
  db.agreements.push({ id: 'ra1', reservationId: 'res1' });
  return row;
}

// ── 1. retrocompat: omitted expectedVersion behaves exactly as before ───────

test('no expectedVersion: transition/stamp/signature work unchanged and bump stateVersion', async () => {
  const row = seedSession();

  const t = await checkoutSessionService.transition({ id: 'cs1', toStep: 'TC_PENDING', actorUserId: 'u1' });
  assert.equal(t.currentStep, 'TC_PENDING');
  assert.equal(row.stateVersion, 1, 'transition bumps the version');

  await checkoutSessionService.stampSideEffect({ id: 'cs1', field: 'tcCompletedAt' });
  assert.ok(row.tcCompletedAt instanceof Date);
  assert.equal(row.stateVersion, 2, 'stamp bumps the version');

  await checkoutSessionService.saveCustomerSignature({ id: 'cs1', signatureDataUrl: SIG, signerName: 'Ana' });
  assert.ok(row.customerSignedAt instanceof Date);
  assert.equal(row.stateVersion, 3, 'signature bumps the version');

  // Legacy rows predating the migration read as version 0 via the column
  // default; a null in a stub row must not explode either.
  const legacy = seedSession({ id: 'cs2', stateVersion: undefined });
  await checkoutSessionService.transition({ id: 'cs2', toStep: 'TC_PENDING' });
  assert.equal(legacy.stateVersion, 1);
});

// ── 2. stale snapshot → 409 STALE_VERSION with the fresh row ────────────────

test('stale expectedVersion: 409 STALE_VERSION, fresh row attached, NOTHING written', async () => {
  const row = seedSession({ stateVersion: 3, currentStep: 'TC_PENDING', tcCompletedAt: new Date() });

  const expectStale = (fn) => assert.rejects(fn, (e) => {
    assert.ok(e instanceof CheckoutSessionError);
    assert.equal(e.status, 409);
    assert.equal(e.code, 'STALE_VERSION');
    assert.equal(e.session?.stateVersion, 3, '409 carries the fresh row for re-render');
    return true;
  });

  await expectStale(() => checkoutSessionService.transition({ id: 'cs1', toStep: 'TC_SIGNED', expectedVersion: 2 }));
  await expectStale(() => checkoutSessionService.stampSideEffect({ id: 'cs1', field: 'paymentCompletedAt', expectedVersion: 0 }));
  await expectStale(() => checkoutSessionService.saveCustomerSignature({ id: 'cs1', signatureDataUrl: SIG, expectedVersion: 99 }));

  assert.equal(row.currentStep, 'TC_PENDING', 'no transition happened');
  assert.equal(row.paymentCompletedAt, null, 'no stamp happened');
  assert.equal(row.customerSignedAt, null, 'no signature happened');
  assert.equal(row.stateVersion, 3, 'version untouched by refused writes');
});

test('stale check runs BEFORE the legality check — stale beats ILLEGAL_TRANSITION', async () => {
  seedSession({ stateVersion: 5, currentStep: 'PAID' });
  // CONFIRMING→TC_PENDING is illegal from PAID, but the caller's snapshot is
  // stale — it must learn STALE_VERSION (with the fresh row), not a
  // coincidental ILLEGAL_TRANSITION computed against state it never saw.
  await assert.rejects(
    () => checkoutSessionService.transition({ id: 'cs1', toStep: 'TC_PENDING', expectedVersion: 1 }),
    (e) => e.code === 'STALE_VERSION',
  );
});

// ── 3. matching expectedVersion proceeds; junk is a 400 ─────────────────────

test('matching expectedVersion proceeds normally', async () => {
  const row = seedSession();
  const t = await checkoutSessionService.transition({ id: 'cs1', toStep: 'TC_PENDING', expectedVersion: 0 });
  assert.equal(t.currentStep, 'TC_PENDING');
  assert.equal(row.stateVersion, 1);

  await checkoutSessionService.stampSideEffect({ id: 'cs1', field: 'tcCompletedAt', expectedVersion: 1 });
  assert.equal(row.stateVersion, 2);

  await checkoutSessionService.saveCustomerSignature({ id: 'cs1', signatureDataUrl: SIG, expectedVersion: 2 });
  assert.equal(row.stateVersion, 3);
});

test('malformed expectedVersion: 400 BAD_EXPECTED_VERSION (never a silent pass)', async () => {
  seedSession();
  for (const bad of ['abc', -1, 1.5]) {
    await assert.rejects(
      () => checkoutSessionService.transition({ id: 'cs1', toStep: 'TC_PENDING', expectedVersion: bad }),
      (e) => e.status === 400 && e.code === 'BAD_EXPECTED_VERSION',
      `expectedVersion=${bad} must 400`,
    );
  }
  // Numeric STRING is accepted (JSON clients sometimes stringify) — '0' == 0.
  const t = await checkoutSessionService.transition({ id: 'cs1', toStep: 'TC_PENDING', expectedVersion: '0' });
  assert.equal(t.currentStep, 'TC_PENDING');
});
