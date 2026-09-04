// The RULE that broke, tested on the shipped function — plus the one thing about the caller that
// only the caller can tell us.
//
// `vozia-step-map.test.js` protects the table. This protects the rule that consumes it: the
// original defect was `if (!step) return`, which threw the co-presence post away for six of the
// sixteen screens the kiosk drives, so a guest who tapped Ayuda from WELCOME was invisible to the
// agent for a whole session.
//
// That rule now lives in `resolveCoPresence` (voziaBridge.js) rather than inside a React callback,
// ON PURPOSE: a rule buried in a component can only be checked by matching the TEXT of page.js,
// and a text assertion snaps on a reformat — or, far worse, goes green because its pattern stopped
// applying and it quietly stops guarding anything. These call the real function.
//
// One text assertion survives, and only because it is about the component's LIFECYCLE, which no
// pure function can express: every place that discards the conversation identity must discard the
// reported position with it. It is written as a RELATIONSHIP (one reset per wipe) rather than a
// fixed number, so a rename fails it loudly instead of silently excusing it — and it is the
// assertion that caught a third wipe site the fix had missed.
import { describe, test, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { resolveCoPresence } from '../src/lib/voziaBridge.js';

describe('the rule, on the shipped function', () => {
  /** Walks screens the way the caller does, carrying the position forward. */
  const run = (screens, { wipeAt = -1 } = {}) => {
    let last = null;
    return screens.map((s, i) => {
      if (i === wipeAt) last = null; // session wipe / conversation reset / iframe unmount
      const here = resolveCoPresence(s, last);
      if (!here) return null; // nothing true to say — the post is dropped
      last = here;
      return here.step;
    });
  };

  test('a guest who asks for help from WELCOME is reported, not dropped', () => {
    // The whole bug, in one line: this returned null for a month and a half.
    expect(resolveCoPresence('WELCOME')).toEqual({ step: 'find_reservation', stepNumber: 0 });
    expect(resolveCoPresence('BOOT')).toEqual({ step: 'find_reservation', stepNumber: 0 });
  });

  test('an escalation from the signature pad reads as signature, not as a guess', () => {
    expect(run(['LOOKUP', 'SIGN', 'ESCALATED'])).toEqual(['find_reservation', 'signature', 'signature']);
  });

  test('coming back to WELCOME resets the position honestly', () => {
    expect(run(['SIGN', 'ESCALATED', 'WELCOME'])).toEqual(['signature', 'signature', 'find_reservation']);
  });

  test('every overlay carries the last real step forward', () => {
    for (const overlay of ['ESCALATED', 'PAIRING', 'OUT_OF_SERVICE']) {
      expect(run(['PAYMENT', overlay]), overlay).toEqual(['payment', 'payment']);
    }
  });

  // QA MINOR-1: the number must travel WITH the step, or the agent watches it walk backwards.
  test('an overlay repeats the step NUMBER too, so the bar never regresses', () => {
    const atPayment = resolveCoPresence('PAYMENT');
    expect(atPayment).toEqual({ step: 'payment', stepNumber: 4 });
    expect(resolveCoPresence('ESCALATED', atPayment)).toEqual({ step: 'payment', stepNumber: 4 });
  });

  test('an overlay with NO last step reports nothing — a dead kiosk is not "finding a reservation"', () => {
    expect(resolveCoPresence('OUT_OF_SERVICE')).toBeNull();
    expect(resolveCoPresence('ESCALATED')).toBeNull();
  });

  test('after a wipe, the previous guest never surfaces as this one', () => {
    // Guest A reaches the pad; the session is wiped; guest B opens help from an overlay screen.
    expect(
      run(['SIGN', 'ESCALATED', 'OUT_OF_SERVICE'], { wipeAt: 2 }),
      "guest A's step reached guest B",
    ).toEqual(['signature', 'signature', null]);
  });
});

describe('the caller: what only the component can tell us', () => {
  const page = readFileSync(resolve('src/app/kiosk/page.js'), 'utf8');

  test('the reported position is discarded everywhere the identity is', () => {
    // Three sites today: the session wipe, the iframe reset, the iframe unmount. The third was
    // missed on the first pass — it is the only one that does not go through a session wipe, so a
    // stale position could ride into the NEXT conversation and be read as the new guest's.
    // Counted as a relationship so a fourth site tomorrow cannot land without its reset.
    const identityWipes = page.match(/voziaIdentityRef\.current = \{ conversationId: null, secret: null \}/g) || [];
    const stepResets = page.match(/lastVoziaStepRef\.current\s*=\s*null/g) || [];
    expect(
      identityWipes.length,
      'the identity-wipe pattern moved — re-check this test, it is the only guard on the third site',
    ).toBeGreaterThanOrEqual(3);
    expect(
      stepResets.length,
      `the position ref is cleared ${stepResets.length}x but the identity ${identityWipes.length}x — a wipe site is missing its reset`,
    ).toBe(identityWipes.length);
  });

  test('the caller uses the shared rule instead of re-deriving one', () => {
    // Not the SHAPE of the expression — just that the rule is not forked back into the component,
    // which is what would put it beyond the reach of the tests above.
    expect(page, 'the caller stopped using the shared rule').toMatch(/resolveCoPresence\(/);
    expect(
      /voziaStepForScreen\(/.test(page),
      'the caller re-derives the step — the rule is forked and the tests above stop protecting it',
    ).toBe(false);
  });
});
