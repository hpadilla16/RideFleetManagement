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
  lastNameMatches,
  isVerifiablePickupDate,
} from './reservation-smart-match.js';
import { isFailedVerifyProbe } from './verify-probe-throttle.js';
import { readFileSync } from 'node:fs';

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
  // Worst case is the zero-stripped pass doubling a bare all-digit input.
  const worst = generateCodeVariants('0107160');
  assert.equal(new Set(worst).size, worst.length);
  assert.ok(worst.length <= 2 * (KNOWN_PREFIXES.length + 2), `unbounded: ${worst.length}`);
});

test('a spoken code that picked up a leading zero still finds the real number', () => {
  // THE live failure (2026-08-06): caller said "r e s one zero seven one six
  // zero" for RES-107160; the lookup arrived as RES0107160 and matched nothing.
  assert.ok(generateCodeVariants('RES0107160').includes('RES-107160'));
  assert.ok(generateCodeVariants('RES-0107160').includes('RES-107160'));
  assert.ok(generateCodeVariants('0107160').includes('RES-107160'));
  // The real code still ranks first — the tolerance is appended, never promoted.
  assert.equal(generateCodeVariants('RES-107160')[0], 'RES-107160');
});

test('leading-zero tolerance is bounded: digits only, and never down to a stub', () => {
  // An alphanumeric tail is a real code shape, not a transcription artifact.
  assert.ok(!generateCodeVariants('TL0ZE409').some((v) => v.includes('TL-ZE409')));
  // Stripping must not manufacture a 1-2 char code that would match broadly.
  assert.ok(!generateCodeVariants('RES00012').includes('RES-12'));
  assert.ok(!generateCodeVariants('007').includes('7'));
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
  // The live 2026-08-06 reservation, kept verbatim so the regression below is
  // the real shape (native RES- number, 6 digits, no leading zero of its own).
  'RES-107160': {
    id: 'cuid_res_2', reservationNumber: 'RES-107160', status: 'CONFIRMED',
    pickupAt: new Date('2026-08-06T22:41:00Z'),
    customer: { firstName: 'Hector', lastName: 'Padilla' },
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

test('a surname verifies by TOKEN, so a compound last name is not a dead end', () => {
  // Hector's decision 2026-08-06: whole-string comparison stopped the honest
  // guest, not an attacker — half of PR carries two surnames and says one.
  assert.equal(lastNameMatches('Perez', 'Gonzalez Perez'), true);
  assert.equal(lastNameMatches('Gonzalez Perez', 'Perez'), true);
  assert.equal(lastNameMatches('PÉREZ', 'gonzalez perez'), true); // accents/case folded
  // Still fail-closed on the things that must never verify:
  assert.equal(lastNameMatches('P', 'Perez'), false);          // an initial is not a token
  assert.equal(lastNameMatches('Per', 'Perez'), false);         // no prefix matching
  assert.equal(lastNameMatches('Gonzalez', 'Perez'), false);
  assert.equal(lastNameMatches('', 'Perez'), false);
  assert.equal(lastNameMatches('Perez', ''), false);
});

test('a shared PARTICLE is not a shared identity', () => {
  // QA B1: with plain token containment, a caller giving their own truthful
  // "De Jesus" unmasked a stranger's "De La Cruz" out of the same prefix
  // fan-out — the shared token was "de". In PR that particle is everywhere,
  // so the hole was widest exactly where the change was meant to help.
  assert.equal(lastNameMatches('De Jesus', 'De La Cruz'), false);
  assert.equal(lastNameMatches('de', 'De La Cruz'), false);
  assert.equal(lastNameMatches('la', 'Santa Cruz La'), false);
  assert.equal(lastNameMatches('Del Valle', 'Del Rio'), false);
  assert.equal(lastNameMatches('Van Dyke', 'Van Halen'), false);
  // …but the real surname next to the particle still works, both directions.
  assert.equal(lastNameMatches('De La Cruz', 'Cruz'), true);
  assert.equal(lastNameMatches('Cruz', 'De La Cruz'), true);
  assert.equal(lastNameMatches('De Jesus', 'Jesus Rivera'), true);
});

test('a bag of surnames is not N guesses in one request', () => {
  // Uncapped, one call could offer every common surname in PR and match
  // almost any row. The spoken side is capped; the stored side is not.
  const bag = 'rivera perez gonzalez rodriguez torres lopez diaz santiago martinez cruz ortiz';
  const surnames = ['Rivera', 'Perez', 'Gonzalez', 'Rodriguez', 'Torres', 'Lopez',
    'Diaz', 'Santiago', 'Martinez', 'Cruz', 'Ortiz'];
  const matched = surnames.filter((s) => lastNameMatches(bag, s));
  // Eleven offered, at most two can land — the request is worth 2 guesses, not 11.
  assert.deepEqual(matched, ['Cruz', 'Ortiz'], `bag matched ${matched.length} surnames`);
  // The cap keeps the LAST tokens — a surname trails a given name.
  assert.equal(lastNameMatches('Maria Cruz Ortiz', 'Ortiz'), true);
  assert.equal(lastNameMatches('Maria Cruz Ortiz', 'Cruz'), true);
  assert.equal(lastNameMatches('Maria Cruz Ortiz', 'Maria'), false); // given name never proves
});

test('a surname made only of particles fails closed rather than matching everything', () => {
  assert.equal(lastNameMatches('De La', 'De La Cruz'), false);
  assert.equal(lastNameMatches('De La Cruz', 'De La'), false);
});

test('short real surnames still verify (the cap is on particles, not on length)', () => {
  assert.equal(lastNameMatches('Ng', 'Ng'), true);
  assert.equal(lastNameMatches('Li', 'Li Wong'), true);
});

test('ORACLE: the datum that FOUND a candidate can never be the one that proves it', () => {
  // QA 2026-08-06 demonstrated a full unmask — number, exact date, status and
  // the internal cuid — from a guessed two-token name, because the name search
  // selected the row and the same surname then verified it.
  const r = ROWS['TL-ZE40809640BA'];
  assert.equal(
    candidateMatchesVerification(r, { lastName: 'Pérez' }, { matchType: 'name' }),
    false,
  );
  // Even paired with a correct date it stays out of the tally — but the date
  // itself, which the name search never touched, does verify.
  assert.equal(
    candidateMatchesVerification(r, { lastName: 'Pérez', pickupDate: '2026-07-21' }, { matchType: 'name' }),
    true,
  );
  assert.equal(
    candidateMatchesVerification(r, { lastName: 'Pérez', pickupDate: '2026-07-25' }, { matchType: 'name' }),
    false,
  );
  // A candidate the CODE found is unaffected: that caller already proved they
  // hold the confirmation number.
  assert.equal(candidateMatchesVerification(r, { lastName: 'Pérez' }, { matchType: 'variant' }), true);
  assert.equal(candidateMatchesVerification(r, { lastName: 'Pérez' }), true); // no matchType = code path
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

test('regression: the misheard RES0107160 resolves to RES-107160 end to end', async () => {
  // Reproduces the failed live shuttle call: three of Chloe's five lookups
  // carried this exact string and every one of them returned nothing.
  const out = await smartMatchReservation(
    { code: 'RES0107160', tenantId: 't1' },
    { prisma: fakePrisma() },
  );
  assert.equal(out.length, 1);
  assert.equal(out[0].reservation.reservationNumber, 'RES-107160');
  // A tolerated variant is NEVER exact — it stays behind the privacy gate.
  assert.equal(out[0].matchType, 'variant');
  assert.ok(out[0].confidence < 100);
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

// ── throttle policy ──────────────────────────────────────────────────────────

test('a wrong guess costs a throttle slot even when another candidate verified', () => {
  // QA B2: the cheapest attack on this gate is to pin one surname token to a
  // row you already own and spend the other on a guess. Your row verifies, the
  // stranger's stays masked — and a "did anything verify?" predicate calls the
  // whole request a success and charges nothing, so guessing becomes free.
  const V = { lastName: 'Padilla' };
  assert.equal(isFailedVerifyProbe([{ matchType: 'variant', verified: true }, { matchType: 'variant', verified: false }], V), true);
  assert.equal(isFailedVerifyProbe([{ matchType: 'variant', verified: false }], V), true);
  // A clean hit costs nothing.
  assert.equal(isFailedVerifyProbe([{ matchType: 'variant', verified: true }], V), false);
  // Zero candidates is deliberately free — see isFailedVerifyProbe for why
  // charging it would 429 a whole tenant off one mistranscribed code.
  assert.equal(isFailedVerifyProbe([], V), false);
  assert.equal(isFailedVerifyProbe(undefined, V), false);
});

test('an honest guest is never charged for a verification that COULD NOT succeed', () => {
  // The name search ignores the surname, so "found by name + the caller's real
  // last name" can never verify. Charging it means the guest answering the
  // question Chloe just asked burns a slot every single time — and the whole
  // voice channel shares one bucket, so ten of those 429 the tenant, including
  // the code happy path this work exists to fix (QA, 2026-08-06).
  const nameRows = [{ matchType: 'name', verified: false }];
  assert.equal(isFailedVerifyProbe(nameRows, { lastName: 'Padilla' }), false);
  // A pickup date CAN prove a name-found candidate, so that one still counts.
  assert.equal(isFailedVerifyProbe(nameRows, { pickupDate: '2026-08-06' }), true);
  // Mixed: a surname can still prove the code-found row, so the attempt counts.
  assert.equal(
    isFailedVerifyProbe(
      [{ matchType: 'name', verified: false }, { matchType: 'variant', verified: false }],
      { lastName: 'Padilla' },
    ),
    true,
  );
});

test('a pickup date the verifier will DISCARD is never charged either', () => {
  // Two definitions of "usable date" had drifted: the verifier demanded
  // YYYY-MM-DD, the throttle only asked "is something there?". So "08/06/2026"
  // or "ayer" bought a charge for a check that could not run — and paired with
  // a surname it defeated the carve-out above. verifyPickupDate is free-form
  // text an LLM fills in, so this is a formatting slip, not an attack.
  const nameRows = [{ matchType: 'name', verified: false }];
  assert.equal(isFailedVerifyProbe(nameRows, { pickupDate: '2026-08-06' }), true);
  for (const bad of ['2026-8-6', '08/06/2026', 'ayer', '  ', '']) {
    assert.equal(isFailedVerifyProbe(nameRows, { pickupDate: bad }), false, `charged for ${JSON.stringify(bad)}`);
    assert.equal(
      isFailedVerifyProbe(nameRows, { lastName: 'Padilla', pickupDate: bad }),
      false,
      `surname carve-out defeated by ${JSON.stringify(bad)}`,
    );
  }
});

test('isVerifiablePickupDate is the SINGLE definition both sides use', () => {
  assert.equal(isVerifiablePickupDate('2026-08-06'), true);
  assert.equal(isVerifiablePickupDate(' 2026-08-06 '), true);
  for (const bad of ['2026-8-6', '08/06/2026', '2026/08/06', 'ayer', '', '   ', null, undefined, 20260806]) {
    assert.equal(isVerifiablePickupDate(bad), false, `accepted ${JSON.stringify(bad)}`);
  }
  // And the verifier agrees — same input, same answer, no second regex.
  const r = ROWS['TL-ZE40809640BA'];
  assert.equal(candidateMatchesVerification(r, { pickupDate: '2026-07-21' }), true);
  assert.equal(candidateMatchesVerification(r, { pickupDate: '2026-7-21' }), false);
});

// ── route wiring ─────────────────────────────────────────────────────────────

test('the smart-lookup route actually calls these with the arguments they need', () => {
  // Source-level, like test:money-route-gate: every unit here can be perfect
  // while the route calls none of it. Both of this arc's route-side bugs were
  // exactly that shape — one of them (`verifyProbeThrottle.isFailedVerifyProbe`,
  // a member that does not exist) I shipped into my own working tree and only
  // caught by reading the module's exports.
  const src = readFileSync(
    new URL('../modules/reservations/reservations.routes.js', import.meta.url),
    'utf8',
  );
  assert.match(
    src,
    /import \{[^}]*\bisFailedVerifyProbe\b[^}]*\} from '\.\.\/\.\.\/lib\/verify-probe-throttle\.js'/,
    'isFailedVerifyProbe must be a NAMED import — it is not a member of verifyProbeThrottle',
  );
  // Without `verify`, an impossible verification is charged to the tenant.
  assert.match(
    src,
    // The lookbehind is the point: `verifyProbeThrottle.isFailedVerifyProbe(...)`
    // must NOT satisfy this. That member does not exist, and an unanchored
    // pattern happily matched it — the assertion would have passed on the very
    // bug it was written for.
    /(?<![.\w])isFailedVerifyProbe\(\s*candidates\s*,\s*verify\s*\)/,
    'call the NAMED import, not a member of verifyProbeThrottle (which has no such property)',
  );
  // Without matchType, the name-search oracle reopens.
  assert.match(
    src,
    /candidateMatchesVerification\(\s*m\.reservation\s*,\s*verify\s*,\s*\{\s*matchType: m\.matchType\s*\}\s*\)/,
    'the verification gate needs matchType or a name match verifies itself',
  );
});

test('the date rule has exactly ONE definition, and both sides import it', () => {
  // The defect being guarded against IS re-duplication of this rule: the
  // verifier demanded YYYY-MM-DD while the throttle only asked "is something
  // there?", and an honest guest paid for the gap. A second copy passes every
  // behavioural test on the day it is written and drifts later, so pin the
  // structure, not just the behaviour (QA MINOR 2).
  const here = readFileSync(new URL('./reservation-smart-match.js', import.meta.url), 'utf8');
  const throttle = readFileSync(new URL('./verify-probe-throttle.js', import.meta.url), 'utf8');

  const DATE_SHAPE = /\/\^\\d\{4\}-\\d\{2\}-\\d\{2\}\$\//g;
  assert.equal(
    (here.match(DATE_SHAPE) || []).length,
    1,
    'the YYYY-MM-DD regex must appear exactly once, inside isVerifiablePickupDate',
  );
  assert.equal(
    (throttle.match(DATE_SHAPE) || []).length,
    0,
    'verify-probe-throttle.js must not carry its own copy of the date rule',
  );
  assert.match(
    throttle,
    /import \{[^}]*\bisVerifiablePickupDate\b[^}]*\} from '\.\/reservation-smart-match\.js'/,
    'the throttle must import the shared predicate',
  );
  // …and the verifier must actually call it, not re-test the shape inline.
  assert.match(here, /if \(isVerifiablePickupDate\(pickupDate\)\)/);
});
