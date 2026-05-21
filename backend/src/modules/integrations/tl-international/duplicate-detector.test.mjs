// duplicate-detector.test.mjs
//
// Unit tests for findDuplicateReservation. We stub prisma.$queryRaw and
// assert the helper:
//   * builds the right "should I even ask the DB?" gate
//   * normalizes name (trim + lower) and date (Date instance)
//   * returns the first row id, null otherwise
//   * is resilient to $queryRaw throwing
//
// Run: `node --test src/modules/integrations/tl-international/duplicate-detector.test.mjs`

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { findDuplicateReservation } from './duplicate-detector.service.js';

const TENANT = 'tenant-1';

/**
 * Build a tiny stub of `prisma.$queryRaw`. We capture the tagged-template
 * fragments + values so each test can decide what to return based on the
 * shape of the call, and emulate the SQL semantics (LOWER+TRIM, day
 * truncation, NOT EXISTS link guard).
 */
function makePrismaStub({ reservations = [], links = new Set() } = {}) {
  const calls = [];
  return {
    calls,
    async $queryRaw(strings, ...values) {
      calls.push({ strings, values });
      // values, in order from duplicate-detector.service.js:
      //   [0] tenantId
      //   [1] fn   (lower+trim)
      //   [2] ln   (lower+trim)
      //   [3] pickup (Date)
      const [tenantId, fn, ln, pickup] = values;
      const sameDay = (a, b) => {
        const da = a instanceof Date ? a : new Date(a);
        const db = b instanceof Date ? b : new Date(b);
        return (
          da.getUTCFullYear() === db.getUTCFullYear() &&
          da.getUTCMonth() === db.getUTCMonth() &&
          da.getUTCDate() === db.getUTCDate()
        );
      };
      const norm = (s) => String(s || '').trim().toLowerCase();
      const out = reservations.filter(
        (r) =>
          r.tenantId === tenantId &&
          norm(r.customerFirstName) === fn &&
          norm(r.customerLastName) === ln &&
          sameDay(r.pickupAt, pickup) &&
          !links.has(r.id),
      );
      return out
        .slice()
        .sort((a, b) => +new Date(a.createdAt || 0) - +new Date(b.createdAt || 0))
        .slice(0, 2)
        .map((r) => ({ id: r.id }));
    },
  };
}

const RES = (overrides = {}) => ({
  id: 'res-1',
  tenantId: TENANT,
  customerFirstName: 'Jahleya',
  customerLastName: 'Smith',
  pickupAt: new Date('2026-05-21T15:00:00Z'),
  createdAt: new Date('2026-05-19T10:00:00Z'),
  ...overrides,
});

const EXT = (overrides = {}) => ({
  id: 'ext-1',
  tenantId: TENANT,
  customerFirstName: 'Jahleya',
  customerLastName: 'Smith',
  pickupAt: new Date('2026-05-21T15:00:00Z'),
  ...overrides,
});

describe('findDuplicateReservation — happy path', () => {
  it('returns the id when name + day match exactly', async () => {
    const prisma = makePrismaStub({ reservations: [RES()] });
    const id = await findDuplicateReservation(prisma, EXT());
    assert.equal(id, 'res-1');
    assert.equal(prisma.calls.length, 1);
  });
});

describe('findDuplicateReservation — normalization', () => {
  it('matches across mixed case + leading/trailing spaces', async () => {
    const prisma = makePrismaStub({
      reservations: [RES({ customerFirstName: '  jahleya ', customerLastName: 'SMITH' })],
    });
    const id = await findDuplicateReservation(
      prisma,
      EXT({ customerFirstName: 'JAHLEYA', customerLastName: ' smith ' }),
    );
    assert.equal(id, 'res-1');
  });

  it('treats Date and ISO string inputs the same', async () => {
    const prisma = makePrismaStub({ reservations: [RES()] });
    const id = await findDuplicateReservation(
      prisma,
      EXT({ pickupAt: '2026-05-21T09:00:00Z' }), // earlier in the same UTC day
    );
    assert.equal(id, 'res-1');
  });
});

describe('findDuplicateReservation — no match', () => {
  it('returns null on different calendar day', async () => {
    const prisma = makePrismaStub({ reservations: [RES()] });
    const id = await findDuplicateReservation(
      prisma,
      EXT({ pickupAt: new Date('2026-05-22T15:00:00Z') }),
    );
    assert.equal(id, null);
  });

  it('returns null on different tenant', async () => {
    const prisma = makePrismaStub({ reservations: [RES()] });
    const id = await findDuplicateReservation(prisma, EXT({ tenantId: 'tenant-2' }));
    assert.equal(id, null);
  });

  it('returns null when target Reservation is already linked to another ExternalReservation', async () => {
    const prisma = makePrismaStub({
      reservations: [RES()],
      links: new Set(['res-1']),
    });
    const id = await findDuplicateReservation(prisma, EXT());
    assert.equal(id, null);
  });
});

describe('findDuplicateReservation — defensive guards (no DB hit)', () => {
  it('returns null when tenantId is missing', async () => {
    const prisma = makePrismaStub({ reservations: [RES()] });
    const id = await findDuplicateReservation(prisma, EXT({ tenantId: null }));
    assert.equal(id, null);
    assert.equal(prisma.calls.length, 0);
  });

  it('returns null when firstName is missing', async () => {
    const prisma = makePrismaStub({ reservations: [RES()] });
    const id = await findDuplicateReservation(prisma, EXT({ customerFirstName: '' }));
    assert.equal(id, null);
    assert.equal(prisma.calls.length, 0);
  });

  it('returns null when lastName is missing', async () => {
    const prisma = makePrismaStub({ reservations: [RES()] });
    const id = await findDuplicateReservation(prisma, EXT({ customerLastName: null }));
    assert.equal(id, null);
    assert.equal(prisma.calls.length, 0);
  });

  it('returns null when pickupAt is missing', async () => {
    const prisma = makePrismaStub({ reservations: [RES()] });
    const id = await findDuplicateReservation(prisma, EXT({ pickupAt: null }));
    assert.equal(id, null);
    assert.equal(prisma.calls.length, 0);
  });

  it('returns null when externalReservation is null', async () => {
    const prisma = makePrismaStub({ reservations: [RES()] });
    const id = await findDuplicateReservation(prisma, null);
    assert.equal(id, null);
    assert.equal(prisma.calls.length, 0);
  });

  it('returns null when pickupAt is unparseable', async () => {
    const prisma = makePrismaStub({ reservations: [RES()] });
    const id = await findDuplicateReservation(prisma, EXT({ pickupAt: 'not-a-date' }));
    assert.equal(id, null);
    assert.equal(prisma.calls.length, 0);
  });

  it('returns null when firstName is just whitespace', async () => {
    const prisma = makePrismaStub({ reservations: [RES()] });
    const id = await findDuplicateReservation(prisma, EXT({ customerFirstName: '   ' }));
    assert.equal(id, null);
    assert.equal(prisma.calls.length, 0);
  });
});

describe('findDuplicateReservation — multiple matches', () => {
  it('returns the first (oldest createdAt) when more than one candidate matches', async () => {
    const olderRes = RES({ id: 'res-older', createdAt: new Date('2026-05-18T10:00:00Z') });
    const newerRes = RES({ id: 'res-newer', createdAt: new Date('2026-05-20T10:00:00Z') });
    const prisma = makePrismaStub({ reservations: [newerRes, olderRes] });
    const id = await findDuplicateReservation(prisma, EXT());
    assert.equal(id, 'res-older');
  });
});

describe('findDuplicateReservation — resilience', () => {
  it('returns null (not throws) when $queryRaw rejects', async () => {
    const prisma = {
      $queryRaw: async () => {
        throw new Error('connection refused');
      },
    };
    const id = await findDuplicateReservation(prisma, EXT());
    assert.equal(id, null);
  });
});
