// The CALLER of the step map — the half where the bug actually lived.
//
// `vozia-step-map.test.mjs` protects the map: every screen is a funnel step or a declared overlay.
// It does NOT protect the line that consumes it. The original bug was `if (!step) return`, which
// threw the post away whenever the map said nothing — so a guest who tapped Ayuda from WELCOME was
// invisible to the agent for the entire session. Restoring that line would leave the map test green
// and the product broken, which is exactly how this survived a month and a half.
//
// (Tests requested by the RFM kiosk session, 2026-09-03, reviewing the fix.)
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { voziaStepForScreen } from './voziaBridge.js';

const page = readFileSync(new URL('../app/kiosk/page.js', import.meta.url), 'utf8');

describe('the caller keeps the fallback', () => {
  test('postVoziaState resolves the step through the last-known-step fallback', () => {
    assert.match(
      page,
      /voziaStepForScreen\(screenName\)\s*\|\|\s*lastVoziaStepRef\.current/,
      'the overlay fallback is gone — an overlay screen would report nothing again',
    );
  });

  test('no bare `if (!step) return` survives without the fallback on the same resolve', () => {
    // The exact shape of the original defect: a step resolved with NO fallback, then dropped.
    const bare = /const\s+step\s*=\s*voziaStepForScreen\([^)]*\)\s*;\s*\n\s*if\s*\(!step\)\s*return\s*;/;
    assert.ok(!bare.test(page), 'the early-return-without-fallback pattern is back');
  });

  test('the last-step ref is cleared in BOTH wipes, next to the identity', () => {
    // Guest A stuck on the pad, session wiped, guest B asks for help from an overlay: without these
    // resets the agent reads A's `signature` as B's position. Same class as the leak QA caught in
    // the F1 assist-view buffer. The ref must die with the conversation AND with the session.
    // EVERY site that discards the identity must discard the step with it. There are three: the
    // session wipe, the iframe reset, and the iframe unmount — and the third was missed on the
    // first pass, which is precisely why this counts them instead of trusting a comment.
    const identityWipes = page.match(/voziaIdentityRef\.current = \{ conversationId: null, secret: null \}/g) || [];
    const resets = page.match(/lastVoziaStepRef\.current\s*=\s*null/g) || [];
    assert.ok(identityWipes.length >= 3, `expected 3+ identity wipes, found ${identityWipes.length}`);
    assert.equal(resets.length, identityWipes.length,
      `the step ref is cleared ${resets.length}× but the identity ${identityWipes.length}× — a wipe site is missing its reset`);
  });
});

describe('the behaviour that shape produces', () => {
  // Mirrors the caller's resolve exactly (pinned to the real source by the pattern tests above).
  const run = (screens, { wipeAfter = -1 } = {}) => {
    let last = null;
    return screens.map((s, i) => {
      if (i === wipeAfter) last = null; // session wipe / conversation reset
      const step = voziaStepForScreen(s) || last;
      if (!step) return null; // nothing true to say — the post is dropped
      last = step;
      return step;
    });
  };

  test('an escalation from the signature pad reads as signature, not as a guess', () => {
    assert.deepEqual(run(['LOOKUP', 'SIGN', 'ESCALATED']), ['find_reservation', 'signature', 'signature']);
  });

  test('coming back to WELCOME resets the position honestly', () => {
    assert.deepEqual(
      run(['SIGN', 'ESCALATED', 'WELCOME']),
      ['signature', 'signature', 'find_reservation'],
    );
  });

  test('after a session wipe an overlay reports NOTHING — the previous guest never leaks', () => {
    // Guest A reaches the pad; the session is wiped; guest B opens help from an overlay screen.
    const out = run(['SIGN', 'ESCALATED', 'OUT_OF_SERVICE'], { wipeAfter: 2 });
    assert.deepEqual(out, ['signature', 'signature', null], "guest A's step reached guest B");
  });

  test('every overlay carries the last real step forward', () => {
    for (const overlay of ['ESCALATED', 'PAIRING', 'OUT_OF_SERVICE', 'WALKUP_SOON']) {
      assert.deepEqual(run(['PAYMENT', overlay]), ['payment', 'payment'], overlay);
    }
  });
});
