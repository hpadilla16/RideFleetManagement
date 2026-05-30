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

// Hard offsets for IANA zones used in tests. Both Puerto Rico (AST)
// and the equivalents we care about don't observe DST, so a fixed
// hour offset is sufficient for unit-test day bucketing.
const TZ_OFFSET_HOURS = {
  'America/Puerto_Rico': -4,
  'UTC': 0,
};

/**
 * Build a tiny stub of `prisma.$queryRaw`. We capture the tagged-template
 * fragments + values so each test can decide what to return based on the
 * shape of the call, and emulate the SQL semantics (LOWER+TRIM, day
 * truncation in tenant TZ, NOT EXISTS link guard).
 *
 * 2026-05-30 — Query shape updated. The detector now interpolates the
 * tenant time zone before truncating, so the values array is:
 *   [0] tenantId
 *   [1] firstName (lower+trim)
 *   [2] lastName  (lower+trim)
 *   [3] tz        (first AT TIME ZONE in the comparison)
 *   [4] pickup    (Date)
 *   [5] tz        (second AT TIME ZONE in the comparison; same value as [3])
 */
function makePrismaStub({ reservations = [], links = new Set() } = {}) {
  const calls = [];
  return {
    calls,
    async $queryRaw(strings, ...values) {
      calls.push({ strings, values });
      const [tenantId, fn, ln, tz, pickup] = values;
      // Reduce a timestamp to its tenant-TZ calendar day (YYYY-MM-DD).
      const tzDay = (value) => {
        const d = value instanceof Date ? value : new Date(value);
        const offset = TZ_OFFSET_HOURS[tz] ?? 0;
        const shifted = new Date(d.getTime() + offset * 60 * 60 * 1000);
        return `${shifted.getUTCFullYear()}-${String(shifted.getUTCMonth() + 1).padStart(2, '0')}-${String(shifted.getUTCDate()).padStart(2, '0')}`;
      };
      const norm = (s) => String(s || '').trim().toLowerCase();
      const out = reservations.filter(
        (r) =>
          r.tenantId === tenantId &&
          norm(r.customerFirstName) === fn &&
          norm(r.customerLastName) === ln &&
          tzDay(r.pickupAt) === tzDay(pickup) &&
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

describe('findDuplicateReservation — tenant TZ day bucketing', () => {
  // 2026-05-30 regression — RES-986873 Willy Acosta. A manually-created
  // reservation at 2pm AST May 29 (18:00Z) and a TL pickup at 8pm AST
  // May 29 (00:00Z May 30) are the SAME AST calendar day, but in UTC
  // they straddle midnight. The pre-fix detector compared UTC days and
  // returned null, so the worker created a duplicate Reservation. The
  // tz-aware comparison must group them on the same AST day.
  it('matches same-AST-day pickups that span a UTC midnight (Willy Acosta regression)', async () => {
    const prisma = makePrismaStub({
      reservations: [RES({
        customerFirstName: 'WILLY',
        customerLastName: 'ACOSTA',
        pickupAt: new Date('2026-05-29T18:00:00Z'), // 2pm AST May 29
      })],
    });
    const id = await findDuplicateReservation(
      prisma,
      EXT({
        customerFirstName: 'Willy',
        customerLastName: 'Acosta',
        pickupAt: new Date('2026-05-30T00:00:00Z'), // 8pm AST May 29
      }),
    );
    assert.equal(id, 'res-1');
  });

  it('still rejects pickups on different AST days', async () => {
    const prisma = makePrismaStub({
      reservations: [RES({
        pickupAt: new Date('2026-05-29T18:00:00Z'), // 2pm AST May 29
      })],
    });
    // 2pm AST May 30 — clearly a different day
    const id = await findDuplicateReservation(
      prisma,
      EXT({ pickupAt: new Date('2026-05-30T18:00:00Z') }),
    );
    assert.equal(id, null);
  });

  it('honors a non-default tz override (UTC)', async () => {
    // With timeZone: 'UTC', the AST-day-bucketing convenience is
    // turned off — pickups must match on UTC day to be considered
    // duplicates. Used by tests + multi-tenant deployments.
    const prisma = makePrismaStub({
      reservations: [RES({ pickupAt: new Date('2026-05-29T18:00:00Z') })],
    });
    const id = await findDuplicateReservation(
      prisma,
      EXT({ pickupAt: new Date('2026-05-30T00:00:00Z') }),
      { timeZone: 'UTC' },
    );
    assert.equal(id, null, 'in UTC mode the 8pm AST pickup falls on May 30');
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
