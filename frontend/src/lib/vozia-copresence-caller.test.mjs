// The RULE that broke, tested on the shipped function — plus the one thing about the caller that
// only the caller can tell us.
//
// `vozia-step-map.test.mjs` protects the table. This protects the rule that consumes it: the
// original defect was `if (!step) return`, which threw the co-presence post away for six of the
// sixteen screens the kiosk drives, so a guest who tapped Ayuda from WELCOME was invisible to the
// agent for a whole session.
//
// That rule now lives in `resolveCoPresenceStep` (voziaBridge.js) rather than inside a React
// callback, ON PURPOSE: a rule buried in a component can only be checked by matching the TEXT of
// page.js, and a text assertion snaps on a reformat — or, far worse, goes green because its pattern
// stopped applying and it quietly stops guarding anything. These call the real function.
//
// One text assertion survives, and only because it is about the component's LIFECYCLE, which no
// pure function can express: every place that discards the conversation identity must discard the
// reported step with it. It is written as a RELATIONSHIP (one reset per wipe) rather than a fixed
// number or a shape, so a rename fails it loudly instead of silently excusing it — and it is the
// assertion that caught a third wipe site the fix had missed.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolveCoPresenceStep } from './voziaBridge.js';

describe('the rule, on the shipped function', () => {
  const run = (screens, { wipeAt = -1 } = {}) => {
    let last = null;
    return screens.map((s, i) => {
      if (i === wipeAt) last = null; // session wipe / conversation reset / iframe unmount
      const step = resolveCoPresenceStep(s, last);
      if (!step) return null; // nothing true to say — the post is dropped
      last = step;
      return step;
    });
  };

  test('a guest who asks for help from WELCOME is reported, not dropped', () => {
    // The whole bug, in one line: this returned null for a month and a half.
    assert.equal(resolveCoPresenceStep('WELCOME', null), 'find_reservation');
    assert.equal(resolveCoPresenceStep('BOOT', null), 'find_reservation');
  });

  test('an escalation from the signature pad reads as signature, not as a guess', () => {
    assert.deepEqual(run(['LOOKUP', 'SIGN', 'ESCALATED']), ['find_reservation', 'signature', 'signature']);
  });

  test('coming back to WELCOME resets the position honestly', () => {
    assert.deepEqual(run(['SIGN', 'ESCALATED', 'WELCOME']), ['signature', 'signature', 'find_reservation']);
  });

  test('every overlay carries the last real step forward', () => {
    for (const overlay of ['ESCALATED', 'PAIRING', 'OUT_OF_SERVICE', 'WALKUP_SOON']) {
      assert.deepEqual(run(['PAYMENT', overlay]), ['payment', 'payment'], overlay);
    }
  });

  test('an overlay with NO last step reports nothing — a dead kiosk is not "finding a reservation"', () => {
    assert.equal(resolveCoPresenceStep('OUT_OF_SERVICE', null), null);
    assert.equal(resolveCoPresenceStep('ESCALATED', null), null);
  });

  test('after a wipe, the previous guest never surfaces as this one', () => {
    // Guest A reaches the pad; the session is wiped; guest B opens help from an overlay screen.
    assert.deepEqual(
      run(['SIGN', 'ESCALATED', 'OUT_OF_SERVICE'], { wipeAt: 2 }),
      ['signature', 'signature', null],
      "guest A's step reached guest B",
    );
  });
});

describe('the caller: what only the component can tell us', () => {
  const page = readFileSync(new URL('../app/kiosk/page.js', import.meta.url), 'utf8');

  test('the reported step is discarded everywhere the identity is', () => {
    // Three sites today: the session wipe, the iframe reset, the iframe unmount. The third was
    // missed on the first pass — it is the only one that does not go through a session wipe, so a
    // stale step could ride into the NEXT conversation and be read as the new guest's position.
    // Counted as a relationship so a fourth site tomorrow cannot land without its reset.
    const identityWipes = page.match(/voziaIdentityRef\.current = \{ conversationId: null, secret: null \}/g) || [];
    const stepResets = page.match(/lastVoziaStepRef\.current\s*=\s*null/g) || [];
    assert.ok(identityWipes.length >= 3,
      `expected 3+ identity wipes; found ${identityWipes.length} — the pattern moved, re-check this test`);
    assert.equal(stepResets.length, identityWipes.length,
      `the step ref is cleared ${stepResets.length}× but the identity ${identityWipes.length}× — a wipe site is missing its reset`);
  });

  test('the caller uses the shared rule instead of re-deriving one', () => {
    // Not the SHAPE of the expression — just that the rule is not forked back into the component,
    // which is what would put it beyond the reach of the tests above.
    assert.match(page, /resolveCoPresenceStep\(/, 'the caller stopped using the shared rule');
    assert.ok(!/voziaStepForScreen\(/.test(page), 'the caller re-derives the step — the rule is forked');
  });
});
