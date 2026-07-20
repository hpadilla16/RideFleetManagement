// S30 — smart-matcher unit tests (DB-free: injected fake prisma).
// Run directly: node --test backend/src/lib/reservation-smart-match.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  KNOWN_PREFIXES,
  generateCodeVariants,
  smartMatchReservation,
  maskCandidate,
  candidateMatchesVerification,
} from './reservation-smart-match.js';

// ── generateCodeVariants ─────────────────────────────────────────────────────

test('bare OTA ref generates every import prefix, input first', () => {
  const v = generateCodeVariants('ZE40809640BA');
  assert.equal(v[0], 'ZE40809640BA');
  assert.ok(v.includes('TL-ZE40809640BA')); // the canonical Hector example
  for (const p of KNOWN_PREFIXES) assert.ok(v.includes(`${p}ZE40809640BA`), `missing ${p}`);
});

test('prefixed system number also tries the bare source ref', () => {
  const v = generateCodeVariants('TL-ZE40809640BA');
  assert.deepEqual(v, ['TL-ZE40809640BA', 'ZE40809640BA']);
});

test('dashless spoken prefix ("TLZE…") restores the dash', () => {
  const v = generateCodeVariants('TLZE40809640BA');
  assert.ok(v.includes('TL-ZE40809640BA'));
});

test('normalizes case and spaces', () => {
  const v = generateCodeVariants('  ze 4080 9640 ba ');
  assert.equal(v[0], 'ZE40809640BA');
  assert.ok(v.includes('TL-ZE40809640BA'));
});

test('junk shapes are rejected outright (fail closed)', () => {
  // Interior junk survives the edge-strip and fails the shape check.
  assert.deepEqual(generateCodeVariants('ZE@40809'), []);
  assert.deepEqual(generateCodeVariants('ZE 123; DROP TABLE x'), []); // interior ; survives
  assert.deepEqual(generateCodeVariants('ab'), []); // too short
  assert.deepEqual(generateCodeVariants('x'.repeat(41)), []);
  assert.deepEqual(generateCodeVariants(''), []);
  assert.deepEqual(generateCodeVariants('...'), []); // pure punctuation strips to nothing
  assert.deepEqual(generateCodeVariants(null), []);
  assert.deepEqual(generateCodeVariants(12345), []);
});

test('variants are unique and bounded', () => {
  const v = generateCodeVariants('RES-00123');
  assert.equal(new Set(v).size, v.length);
  assert.ok(v.length <= KNOWN_PREFIXES.length + 2);
});

// ── smartMatchReservation (fake prisma) ──────────────────────────────────────

const ROWS = {
  'TL-ZE40809640BA': {
    id: 'cuid_tl_1', reservationNumber: 'TL-ZE40809640BA', status: 'CONFIRMED',
    pickupAt: new Date('2026-07-21T14:00:00Z'),
    customer: { firstName: 'Juan', lastName: 'Pérez' },
  },
  'RES-00123': {
    id: 'cuid_res_1', reservationNumber: 'RES-00123', status: 'NEW',
    pickupAt: new Date('2026-07-22T15:00:00Z'),
    customer: { firstName: 'Maria', lastName: 'Hernandez' },
  },
};

function fakePrisma(log = []) {
  return {
    reservation: {
      async findMany(args) {
        log.push(args);
        const { where } = args;
        if (where.OR) {
          const wanted = where.OR.map((c) => String(c.reservationNumber.equals).toUpperCase());
          return Object.values(ROWS).filter(
            (r) => wanted.includes(r.reservationNumber.toUpperCase()),
          );
        }
        if (where.customer) {
          // crude name fake: match tokens against the seeded customers
          return Object.values(ROWS).filter((r) =>
            where.customer.AND.every((cond) =>
              cond.OR.some((f) => {
                const field = f.firstName ? 'firstName' : 'lastName';
                const needle = (f.firstName ?? f.lastName).contains.toLowerCase();
                return r.customer[field].toLowerCase().includes(needle);
              }),
            ),
          );
        }
        return [];
      },
    },
  };
}

test('tenantId is a hard requirement', async () => {
  await assert.rejects(
    () => smartMatchReservation({ code: 'ZE1' }, { prisma: fakePrisma() }),
    /tenantId is required/,
  );
});

test('every query is tenant-scoped and read-only (findMany only)', async () => {
  const log = [];
  await smartMatchReservation({ code: 'ZE40809640BA', tenantId: 't1' }, { prisma: fakePrisma(log) });
  assert.ok(log.length >= 1);
  for (const q of log) assert.equal(q.where.tenantId, 't1');
});

test('OTA bare ref finds the prefixed import as matchType variant', async () => {
  const out = await smartMatchReservation(
    { code: 'ZE40809640BA', tenantId: 't1' },
    { prisma: fakePrisma() },
  );
  assert.equal(out.length, 1);
  assert.equal(out[0].reservation.id, 'cuid_tl_1');
  assert.equal(out[0].matchType, 'variant');
  assert.ok(out[0].confidence < 100 && out[0].confidence >= 60);
});

test('typing the exact stored number ranks as exact/100', async () => {
  const out = await smartMatchReservation(
    { code: 'tl-ze40809640ba', tenantId: 't1' },
    { prisma: fakePrisma() },
  );
  assert.equal(out[0].matchType, 'exact');
  assert.equal(out[0].confidence, 100);
});

test('name fallback fires only when the code misses, ranked as name/60', async () => {
  const out = await smartMatchReservation(
    { code: 'NOPE999', name: 'Maria Hernandez', tenantId: 't1' },
    { prisma: fakePrisma() },
  );
  assert.equal(out.length, 1);
  assert.equal(out[0].reservation.id, 'cuid_res_1');
  assert.equal(out[0].matchType, 'name');
  assert.equal(out[0].confidence, 60);
});

test('code hit suppresses the name query entirely', async () => {
  const log = [];
  const out = await smartMatchReservation(
    { code: 'ZE40809640BA', name: 'Maria Hernandez', tenantId: 't1' },
    { prisma: fakePrisma(log) },
  );
  assert.equal(out.length, 1);
  assert.equal(log.length, 1); // one findMany — no name query
});

// ── masking + verification gate ──────────────────────────────────────────────

test('maskCandidate: no id, no exact date, no status — MC1/MC2 regression', () => {
  const m = maskCandidate({
    reservation: ROWS['TL-ZE40809640BA'], matchType: 'variant', confidence: 90,
  });
  assert.deepEqual(m, {
    matchType: 'variant', confidence: 90,
    maskedName: 'Juan P.', pickupMonth: '2026-07',
  });
  const raw = JSON.stringify(m);
  assert.ok(!raw.includes('Pérez'));
  assert.ok(!raw.includes('TL-ZE'));
  assert.ok(!raw.includes('cuid_tl_1'));   // MC2: a leaked cuid is one GET /:id from the full row
  assert.ok(!raw.includes('2026-07-21'));  // MC1: the exact date IS the verification proof
  assert.ok(!raw.includes('CONFIRMED'));
});

test('verification: full last name or pickup date (±1 day tz tolerance); fail closed otherwise', () => {
  const r = ROWS['TL-ZE40809640BA'];
  assert.equal(candidateMatchesVerification(r, { lastName: 'pérez' }), true);
  assert.equal(candidateMatchesVerification(r, { pickupDate: '2026-07-21' }), true);
  // SC1: Florida-local vs UTC rollover — the adjacent day still verifies…
  assert.equal(candidateMatchesVerification(r, { pickupDate: '2026-07-20' }), true);
  assert.equal(candidateMatchesVerification(r, { pickupDate: '2026-07-22' }), true);
  // …but 2+ days off does not.
  assert.equal(candidateMatchesVerification(r, { pickupDate: '2026-07-19' }), false);
  assert.equal(candidateMatchesVerification(r, { pickupDate: '2026-07-23' }), false);
  assert.equal(candidateMatchesVerification(r, { lastName: 'P' }), false); // no prefixes
  assert.equal(candidateMatchesVerification(r, { lastName: 'Gonzalez' }), false);
  assert.equal(candidateMatchesVerification(r, {}), false); // nothing provided → NOT verified
  assert.equal(candidateMatchesVerification(r), false);
  // one right + one wrong = NOT verified (every provided datum must match)
  assert.equal(candidateMatchesVerification(r, { lastName: 'Pérez', pickupDate: '2026-07-25' }), false);
});

test('leading/trailing punctuation is stripped, not fatal (OCR/keyboard noise)', () => {
  assert.equal(generateCodeVariants('ZE40809640BA.')[0], 'ZE40809640BA');
  assert.equal(generateCodeVariants("'ZE40809640BA'")[0], 'ZE40809640BA');
});

test('name fallback requires 2+ tokens (a bare "mar" must not page through customers)', async () => {
  const out = await smartMatchReservation(
    { code: 'NOPE999', name: 'Maria', tenantId: 't1' },
    { prisma: fakePrisma() },
  );
  assert.deepEqual(out, []);
});

test('KNOWN_PREFIXES stays in sync with every live booking-source (prefix-drift guard)', async () => {
  const sources = [
    '../modules/integrations/nu/nu.constants.js',
    '../modules/integrations/economy/economy.constants.js',
    '../modules/integrations/flexways/flexways.constants.js',
    '../modules/integrations/advantage/advantage.constants.js',
  ];
  for (const rel of sources) {
    const mod = await import(new URL(rel, import.meta.url));
    assert.ok(
      KNOWN_PREFIXES.includes(mod.RESERVATION_PREFIX),
      `KNOWN_PREFIXES is missing ${mod.RESERVATION_PREFIX} from ${rel} — new source landed without updating the shared matcher`,
    );
  }
  assert.ok(KNOWN_PREFIXES.includes('TL-')); // hardcoded in tl-international.worker.js
  assert.ok(KNOWN_PREFIXES.includes('RES-')); // native
});
