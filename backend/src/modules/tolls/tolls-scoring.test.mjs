import test from 'node:test';
import assert from 'node:assert/strict';

import { scoreCandidate } from './tolls.service.js';
import {
  DEFAULT_AUTO_CONFIRM_SCORE,
  MAX_AUTO_CONFIRM_SCORE,
  MIN_AUTO_CONFIRM_SCORE,
  autoConfirmCapFor,
  matchStatusForScore,
  normalizeAutoConfirmScore
} from './tolls-match-config.js';

// The auto-confirm threshold is per-tenant and configurable (default 70). These
// tests assert THRESHOLD SEMANTICS rather than the old literal 85: every
// invariant is checked at BOTH the new default (70) and the historical value
// (85), because the whole hazard of making the threshold configurable is that a
// safety cap written as a magic number silently stops working at another value.
const THRESHOLDS = [DEFAULT_AUTO_CONFIRM_SCORE, 85];

// Build a reservation that intentionally has NO formal checkout signal:
//   - status = CONFIRMED (not CHECKED_OUT)
//   - rentalAgreement.finalizedAt = null
//   - no checkout inspection
// This is the loaner-shaped reservation pattern that triggers
// dispatchConfirmationRequired = true under the current responsibility resolver.
function loanerStyleReservation(overrides = {}) {
  return {
    status: 'CONFIRMED',
    pickupAt: new Date('2026-04-07T10:00:00.000Z'),
    returnAt: new Date('2026-04-09T10:00:00.000Z'),
    vehicleId: 'veh-1',
    workflowMode: 'DEALERSHIP_LOANER',
    readyForPickupAt: new Date('2026-04-07T09:45:00.000Z'),
    rentalAgreement: {
      vehicleId: 'veh-1',
      finalizedAt: null,
      inspections: [],
      vehicleSwaps: []
    },
    ...overrides
  };
}

const VEH_BASE = {
  id: 'veh-1',
  internalNumber: 'L-101',
  plate: 'ABC123',
  tollTagNumber: 'TAG-9988',
  tollStickerNumber: 'SELLO-7711'
};

// ── config normalization ────────────────────────────────────────────────────

test('normalizeAutoConfirmScore defaults to 70 and rejects junk / out-of-band', () => {
  assert.equal(DEFAULT_AUTO_CONFIRM_SCORE, 70, 'the shipped default is 70');

  // Missing / empty / junk all read as the default.
  for (const junk of [undefined, null, '', '   ', 'abc', {}, [], NaN, Infinity, -Infinity]) {
    assert.equal(
      normalizeAutoConfirmScore(junk),
      DEFAULT_AUTO_CONFIRM_SCORE,
      `junk value ${JSON.stringify(junk)} must fall back to the default`
    );
  }

  // Out of band falls back to the DEFAULT, never to a clamped edge — a
  // fat-fingered 8500 must not silently disable auto-confirm, and a 5 must not
  // turn the review queue into a rubber stamp.
  for (const outOfBand of [0, 5, 49, 101, 8500, -70]) {
    assert.equal(
      normalizeAutoConfirmScore(outOfBand),
      DEFAULT_AUTO_CONFIRM_SCORE,
      `${outOfBand} is out of band and must fall back to the default`
    );
  }

  // In-band values are honored (numeric strings too, since config arrives as JSON).
  assert.equal(normalizeAutoConfirmScore(MIN_AUTO_CONFIRM_SCORE), MIN_AUTO_CONFIRM_SCORE);
  assert.equal(normalizeAutoConfirmScore(MAX_AUTO_CONFIRM_SCORE), MAX_AUTO_CONFIRM_SCORE);
  assert.equal(normalizeAutoConfirmScore(85), 85);
  assert.equal(normalizeAutoConfirmScore('70'), 70);
  assert.equal(normalizeAutoConfirmScore(70.4), 70, 'rounded, not truncated toward a lower bar');
});

test('autoConfirmCapFor is always one point below the effective threshold', () => {
  // This is the property that replaced the magic number 79. It must hold for
  // EVERY in-band threshold, not just the two we ship with.
  for (let threshold = MIN_AUTO_CONFIRM_SCORE; threshold <= MAX_AUTO_CONFIRM_SCORE; threshold += 1) {
    const cap = autoConfirmCapFor(threshold);
    assert.equal(cap, threshold - 1, `cap for ${threshold} should be ${threshold - 1}`);
    assert.ok(cap < threshold, `a capped score must never satisfy score >= ${threshold}`);
  }
  // A junk threshold caps against the default, not against NaN.
  assert.equal(autoConfirmCapFor('nonsense'), DEFAULT_AUTO_CONFIRM_SCORE - 1);
});

// ── the auto-confirm boundary ───────────────────────────────────────────────

test('matchStatusForScore: the threshold itself auto-confirms (inclusive boundary)', () => {
  for (const autoConfirmScore of THRESHOLDS) {
    assert.equal(
      matchStatusForScore(autoConfirmScore, { autoConfirmScore }),
      'AUTO_CONFIRMED',
      `exactly ${autoConfirmScore} must auto-confirm`
    );
    assert.equal(
      matchStatusForScore(autoConfirmScore - 1, { autoConfirmScore }),
      'SUGGESTED',
      `one below ${autoConfirmScore} must NOT auto-confirm`
    );
  }

  // Hector's relaxed bar: 70 confirms at the new default but is only a
  // suggestion under the historical 85.
  assert.equal(matchStatusForScore(70, { autoConfirmScore: 70 }), 'AUTO_CONFIRMED');
  assert.equal(matchStatusForScore(70, { autoConfirmScore: 85 }), 'SUGGESTED');

  // A junk configured threshold behaves as the default rather than confirming
  // everything or nothing.
  assert.equal(matchStatusForScore(70, { autoConfirmScore: 'junk' }), 'AUTO_CONFIRMED');
  assert.equal(matchStatusForScore(69, { autoConfirmScore: 'junk' }), 'SUGGESTED');

  // The dispatch gate outranks the score entirely.
  assert.equal(
    matchStatusForScore(100, { dispatchConfirmationRequired: true, autoConfirmScore: 70 }),
    'SUGGESTED',
    'a dispatch-confirmation candidate never auto-confirms, whatever it scores'
  );
});

// ── dispatch-confirmation cap ───────────────────────────────────────────────

test('dispatch cap holds a loaner toll below the threshold at EVERY threshold', () => {
  const reservation = loanerStyleReservation();
  const transaction = {
    transactionAt: new Date('2026-04-07T12:00:00.000Z'),
    plateRaw: 'ABC123',
    tagRaw: '',
    selloRaw: ''
  };

  for (const autoConfirmScore of THRESHOLDS) {
    const result = scoreCandidate({
      transaction,
      vehicle: VEH_BASE,
      reservation,
      siblingCandidates: 1,
      autoConfirmScore
    });

    // Only one strong identifier (plate) — multi-signal override does NOT apply.
    assert.equal(result.multiSignalOverride, false, 'override should be off with 1 identifier');
    assert.equal(result.dispatchConfirmationRequired, true, 'dispatch flag stays on without override');
    assert.ok(
      result.score <= autoConfirmCapFor(autoConfirmScore),
      `expected score capped at ${autoConfirmCapFor(autoConfirmScore)} for threshold ${autoConfirmScore}, got ${result.score}`
    );
    assert.ok(
      result.score < autoConfirmScore,
      `capped score ${result.score} must stay below threshold ${autoConfirmScore}`
    );
    assert.notEqual(
      matchStatusForScore(result.score, {
        dispatchConfirmationRequired: result.dispatchConfirmationRequired,
        autoConfirmScore
      }),
      'AUTO_CONFIRMED',
      `a dispatch-gated loaner toll must never auto-confirm at threshold ${autoConfirmScore}`
    );
  }
});

test('scoreCandidate WITH multi-signal override (plate + tag) bypasses dispatch cap', () => {
  const reservation = loanerStyleReservation();
  const transaction = {
    transactionAt: new Date('2026-04-07T12:00:00.000Z'),
    plateRaw: 'ABC123',
    tagRaw: 'TAG-9988',
    selloRaw: ''
  };

  for (const autoConfirmScore of THRESHOLDS) {
    const result = scoreCandidate({
      transaction,
      vehicle: VEH_BASE,
      reservation,
      siblingCandidates: 1,
      autoConfirmScore
    });

    assert.equal(result.multiSignalOverride, true, 'override should fire with 2 identifiers + windows');
    assert.equal(result.dispatchConfirmationRequired, false, 'dispatch flag suppressed by override');
    assert.equal(result.reviewCategory, null, 'reviewCategory cleared by override');
    assert.ok(
      result.score >= autoConfirmScore,
      `expected auto-confirm score at threshold ${autoConfirmScore} with multi-signal override, got ${result.score}`
    );
    assert.ok(
      result.matchReason.includes('multiSignalOverride'),
      `expected matchReason to include multiSignalOverride token, got "${result.matchReason}"`
    );
  }
});

test('scoreCandidate multi-signal override requires inside-trip-window', () => {
  const reservation = loanerStyleReservation();
  // Toll fires before the trip window (and outside the responsibility window)
  const transaction = {
    transactionAt: new Date('2026-04-05T12:00:00.000Z'),
    plateRaw: 'ABC123',
    tagRaw: 'TAG-9988',
    selloRaw: ''
  };

  const result = scoreCandidate({
    transaction,
    vehicle: VEH_BASE,
    reservation,
    siblingCandidates: 1
  });

  // Even with both identifiers matching, no trip-window means no override.
  assert.equal(result.multiSignalOverride, false, 'override should NOT fire outside trip window');
});

test('scoreCandidate multi-signal override with three identifiers maxes confidence', () => {
  const reservation = loanerStyleReservation();
  const transaction = {
    transactionAt: new Date('2026-04-07T12:00:00.000Z'),
    plateRaw: 'ABC123',
    tagRaw: 'TAG-9988',
    selloRaw: 'SELLO-7711'
  };

  for (const autoConfirmScore of THRESHOLDS) {
    const result = scoreCandidate({
      transaction,
      vehicle: VEH_BASE,
      reservation,
      siblingCandidates: 1,
      autoConfirmScore
    });

    assert.equal(result.multiSignalOverride, true);
    assert.equal(result.dispatchConfirmationRequired, false);
    assert.ok(
      result.score >= autoConfirmScore,
      `expected auto-confirm-grade score at threshold ${autoConfirmScore}, got ${result.score}`
    );
  }
});

test('scoreCandidate without dispatch-confirmation-needed reservation behaves identically (regression)', () => {
  // status = CHECKED_OUT means no dispatch-confirmation gate is triggered at all.
  // The override path should be a no-op here — current behavior must be preserved.
  const reservation = loanerStyleReservation({
    status: 'CHECKED_OUT',
    rentalAgreement: {
      vehicleId: 'veh-1',
      finalizedAt: new Date('2026-04-07T10:00:00.000Z'),
      inspections: [],
      vehicleSwaps: []
    }
  });
  const transaction = {
    transactionAt: new Date('2026-04-07T12:00:00.000Z'),
    plateRaw: 'ABC123',
    tagRaw: 'TAG-9988',
    selloRaw: ''
  };

  for (const autoConfirmScore of THRESHOLDS) {
    const result = scoreCandidate({
      transaction,
      vehicle: VEH_BASE,
      reservation,
      siblingCandidates: 1,
      autoConfirmScore
    });

    assert.equal(result.dispatchConfirmationRequired, false, 'no dispatch gate when reservation is checked out');
    assert.ok(
      result.score >= autoConfirmScore,
      `should auto-confirm a normal checked-out match at threshold ${autoConfirmScore}`
    );
  }
});

// ── RES-849093 FIX 1b ───────────────────────────────────────────────────────
// A toll with NO strong identifier (empty plate/tag/sello) must NEVER reach the
// auto-confirm threshold, even on a perfect time-window match against a
// normally-checked-out reservation. It must be capped into the SUGGESTED /
// needs-review band so a human attributes it. This is precisely the invariant
// that the old hardcoded `Math.min(score, 79)` would have broken the moment the
// threshold dropped to 70 — 79 >= 70 would have auto-attributed a
// zero-identifier toll to a real customer.
function checkedOutReservation(overrides = {}) {
  return {
    status: 'CHECKED_OUT',
    pickupAt: new Date('2026-04-07T10:00:00.000Z'),
    returnAt: new Date('2026-04-09T10:00:00.000Z'),
    vehicleId: 'veh-1',
    rentalAgreement: {
      vehicleId: 'veh-1',
      finalizedAt: new Date('2026-04-07T10:05:00.000Z'),
      inspections: [{ kind: 'CHECKOUT' }],
      vehicleSwaps: []
    },
    ...overrides
  };
}

test('FIX 1b: a zero-identifier toll NEVER auto-confirms, at any threshold', () => {
  const reservation = checkedOutReservation();
  const transaction = {
    transactionAt: new Date('2026-04-07T12:00:00.000Z'), // squarely inside the trip window
    plateRaw: '',
    tagRaw: '',
    selloRaw: ''
  };

  // Swept across the whole configurable band, not just 70 and 85: the cap is
  // derived, so the invariant must hold everywhere a tenant could set it.
  for (let autoConfirmScore = MIN_AUTO_CONFIRM_SCORE; autoConfirmScore <= MAX_AUTO_CONFIRM_SCORE; autoConfirmScore += 1) {
    const result = scoreCandidate({
      transaction,
      vehicle: VEH_BASE,
      reservation,
      siblingCandidates: 1,
      autoConfirmScore
    });

    assert.equal(result.strongIdentifierMatches, 0, 'no plate/tag/sello matched');
    assert.ok(
      result.score <= autoConfirmCapFor(autoConfirmScore),
      `expected score capped at ${autoConfirmCapFor(autoConfirmScore)} with no identifier, got ${result.score}`
    );
    assert.ok(
      result.score < autoConfirmScore,
      `zero-identifier score ${result.score} must stay under threshold ${autoConfirmScore}`
    );
    assert.notEqual(
      matchStatusForScore(result.score, {
        dispatchConfirmationRequired: result.dispatchConfirmationRequired,
        autoConfirmScore
      }),
      'AUTO_CONFIRMED',
      `a pure time-window match must never auto-confirm at threshold ${autoConfirmScore}`
    );
    assert.ok(result.matchReason.includes('noStrongIdentifier'), 'reason should flag missing identifier');
  }
});

test('FIX 1b: a single plate match on a checked-out reservation still AUTO_CONFIRMS', () => {
  const reservation = checkedOutReservation();
  const transaction = {
    transactionAt: new Date('2026-04-07T12:00:00.000Z'),
    plateRaw: 'ABC123',
    tagRaw: '',
    selloRaw: ''
  };

  for (const autoConfirmScore of THRESHOLDS) {
    const result = scoreCandidate({
      transaction,
      vehicle: VEH_BASE,
      reservation,
      siblingCandidates: 1,
      autoConfirmScore
    });
    assert.equal(result.strongIdentifierMatches, 1, 'plate matched');
    assert.ok(
      result.score >= autoConfirmScore,
      `expected auto-confirm with a plate match at threshold ${autoConfirmScore}, got ${result.score}`
    );
  }
});

// ── the rows Hector actually looked at ──────────────────────────────────────

test("Hector's screenshot row (+15 +10 +25 +10 = 60) stays SUGGESTED at 70", () => {
  // The row from the /tolls screenshot that prompted relaxing the threshold:
  // current vehicle (+15), agreement vehicle (+10), plate (+25) and a toll just
  // OUTSIDE the trip window but inside the grace window (+10). It totals 60 —
  // still short of 70, so relaxing the bar must NOT start auto-confirming it.
  const reservation = checkedOutReservation();
  const transaction = {
    transactionAt: new Date('2026-04-07T09:00:00.000Z'), // 1h before pickup: grace, not trip
    plateRaw: 'ABC123',
    tagRaw: '',
    selloRaw: ''
  };

  const result = scoreCandidate({
    transaction,
    vehicle: VEH_BASE,
    reservation,
    siblingCandidates: 1,
    autoConfirmScore: DEFAULT_AUTO_CONFIRM_SCORE
  });

  assert.equal(result.score, 60, 'the ledger still adds up to 60');
  assert.deepEqual(
    result.matchReason.split(','),
    ['currentVehicleId', 'agreementVehicleId', 'plate', 'withinGraceWindow'],
    'the same four tokens the evidence pane renders'
  );
  assert.equal(
    matchStatusForScore(result.score, {
      dispatchConfirmationRequired: result.dispatchConfirmationRequired,
      autoConfirmScore: DEFAULT_AUTO_CONFIRM_SCORE
    }),
    'SUGGESTED',
    '60 is below 70 — it stays a suggestion for a human'
  );
});

test('a row scoring exactly 70 auto-confirms at 70 and only suggests at 85', () => {
  // current vehicle (+15) + agreement vehicle (+10) + plate (+25) + tag (+20),
  // with the toll outside every window, totals exactly 70. Two identifiers, but
  // no trip window means no multi-signal override, and one identifier is enough
  // that FIX 1b does not cap it — so this lands on the boundary uncapped.
  const reservation = checkedOutReservation();
  const transaction = {
    transactionAt: new Date('2026-04-20T12:00:00.000Z'),
    plateRaw: 'ABC123',
    tagRaw: 'TAG-9988',
    selloRaw: ''
  };

  const atSeventy = scoreCandidate({
    transaction,
    vehicle: VEH_BASE,
    reservation,
    siblingCandidates: 1,
    autoConfirmScore: 70
  });

  assert.equal(atSeventy.score, 70, 'the boundary row scores exactly 70');
  assert.equal(atSeventy.multiSignalOverride, false, 'no override — outside the trip window');
  assert.equal(
    matchStatusForScore(atSeventy.score, {
      dispatchConfirmationRequired: atSeventy.dispatchConfirmationRequired,
      autoConfirmScore: 70
    }),
    'AUTO_CONFIRMED',
    'exactly 70 clears a threshold of 70'
  );

  const atEightyFive = scoreCandidate({
    transaction,
    vehicle: VEH_BASE,
    reservation,
    siblingCandidates: 1,
    autoConfirmScore: 85
  });
  assert.equal(
    matchStatusForScore(atEightyFive.score, {
      dispatchConfirmationRequired: atEightyFive.dispatchConfirmationRequired,
      autoConfirmScore: 85
    }),
    'SUGGESTED',
    'the same row is only a suggestion under the historical 85'
  );
});

test('scoreCandidate defaults to the 70 threshold when none is passed', () => {
  // Callers that omit autoConfirmScore must get the shipped default, not a
  // stale 85 and not an undefined-driven NaN comparison.
  const reservation = checkedOutReservation();
  const transaction = {
    transactionAt: new Date('2026-04-07T12:00:00.000Z'),
    plateRaw: '',
    tagRaw: '',
    selloRaw: ''
  };

  const explicit = scoreCandidate({ transaction, vehicle: VEH_BASE, reservation, siblingCandidates: 1, autoConfirmScore: DEFAULT_AUTO_CONFIRM_SCORE });
  const implicit = scoreCandidate({ transaction, vehicle: VEH_BASE, reservation, siblingCandidates: 1 });
  assert.equal(implicit.score, explicit.score, 'omitting the threshold matches passing the default');
  assert.equal(implicit.score, autoConfirmCapFor(DEFAULT_AUTO_CONFIRM_SCORE), 'capped at 69, the derived cap');
});
