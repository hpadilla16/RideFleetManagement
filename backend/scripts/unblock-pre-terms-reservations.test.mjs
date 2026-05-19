// 16g — Tests for the unblock-pre-terms-reservations script.
//
// Drives runUnblock() with a stubbed prisma client so we can verify both
// dry-run (default) and commit modes without touching the database.
//
// Run: `node --test scripts/unblock-pre-terms-reservations.test.mjs`
// from backend/.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { runUnblock } from './unblock-pre-terms-reservations.mjs';
import { TC_EFFECTIVE_DATE } from '../src/lib/terms/version.js';

function makeStubPrisma({ candidates = [], totalCount = null } = {}) {
  const calls = {
    findMany: [],
    count: [],
    updateMany: []
  };
  return {
    calls,
    reservation: {
      async findMany(args) {
        calls.findMany.push(args);
        return candidates.slice(0, args?.take || candidates.length);
      },
      async count(args) {
        calls.count.push(args);
        return totalCount == null ? candidates.length : totalCount;
      },
      async updateMany(args) {
        calls.updateMany.push(args);
        return { count: totalCount == null ? candidates.length : totalCount };
      }
    }
  };
}

function makeSilentLogger() {
  const lines = [];
  return {
    lines,
    log: (...args) => lines.push(args.map(String).join(' '))
  };
}

function makeCandidate(n) {
  const created = new Date(TC_EFFECTIVE_DATE.getTime() - (n + 1) * 86400000);
  return {
    id: `res_${n}`,
    reservationNumber: `R-${1000 + n}`,
    createdAt: created,
    pickupAt: new Date(created.getTime() + 7 * 86400000),
    returnAt: new Date(created.getTime() + 10 * 86400000),
    tenantId: `tenant_${n % 3}`,
    paymentStatus: 'PENDING'
  };
}

describe('runUnblock — dry-run mode (default)', () => {
  it('does NOT call updateMany when commit=false', async () => {
    const stub = makeStubPrisma({ candidates: [makeCandidate(0), makeCandidate(1)] });
    const logger = makeSilentLogger();

    const result = await runUnblock(stub, { commit: false, logger });

    assert.equal(stub.calls.updateMany.length, 0, 'updateMany must not be called in dry-run');
    assert.equal(result.candidateCount, 2);
    assert.equal(result.updatedCount, 0);
    assert.equal(result.sample.length, 2);
  });

  it('queries with autochargeBlocked=true AND createdAt < TC_EFFECTIVE_DATE', async () => {
    const stub = makeStubPrisma({ candidates: [makeCandidate(0)] });
    const logger = makeSilentLogger();

    await runUnblock(stub, { commit: false, logger });

    assert.equal(stub.calls.findMany.length, 1);
    const where = stub.calls.findMany[0].where;
    assert.equal(where.autochargeBlocked, true);
    assert.ok(where.createdAt && where.createdAt.lt instanceof Date);
    assert.equal(where.createdAt.lt.getTime(), TC_EFFECTIVE_DATE.getTime());
  });

  it('handles the empty candidate case gracefully', async () => {
    const stub = makeStubPrisma({ candidates: [], totalCount: 0 });
    const logger = makeSilentLogger();

    const result = await runUnblock(stub, { commit: false, logger });

    assert.equal(stub.calls.updateMany.length, 0);
    assert.equal(result.candidateCount, 0);
    assert.equal(result.updatedCount, 0);
    assert.ok(logger.lines.some((l) => l.includes('nothing to do')));
  });

  it('logs the dry-run banner without "committing"', async () => {
    const stub = makeStubPrisma({ candidates: [makeCandidate(0)] });
    const logger = makeSilentLogger();

    await runUnblock(stub, { commit: false, logger });

    assert.ok(logger.lines.some((l) => l.includes('DRY-RUN')));
    assert.ok(!logger.lines.some((l) => l.includes('committing')));
    assert.ok(logger.lines.some((l) => l.includes('re-run with --commit')));
  });
});

describe('runUnblock — commit mode', () => {
  it('calls updateMany exactly once with autochargeBlocked=false', async () => {
    const candidates = Array.from({ length: 281 }, (_, i) => makeCandidate(i));
    const stub = makeStubPrisma({ candidates, totalCount: 281 });
    const logger = makeSilentLogger();

    const result = await runUnblock(stub, { commit: true, logger });

    assert.equal(stub.calls.updateMany.length, 1);
    assert.equal(stub.calls.updateMany[0].where.autochargeBlocked, true);
    assert.equal(stub.calls.updateMany[0].data.autochargeBlocked, false);
    assert.equal(result.updatedCount, 281);
  });

  it('logs "committing" + final count in commit mode', async () => {
    const stub = makeStubPrisma({ candidates: [makeCandidate(0)], totalCount: 1 });
    const logger = makeSilentLogger();

    await runUnblock(stub, { commit: true, logger });

    assert.ok(logger.lines.some((l) => l.includes('committing')));
    assert.ok(logger.lines.some((l) => l.includes('1 reservation')));
  });
});
