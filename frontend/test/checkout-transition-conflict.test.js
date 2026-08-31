/**
 * M2-H8 (2026-08-17) — the wizard's 409 swallow rule.
 *
 * This one rule decides whether an agent at the counter ever SEES a failed
 * transition, so it gets a test of its own rather than living inline in a
 * 1000-line page component.
 *
 * The regression it exists to stop: H8 re-labelled a half-finished finalize as
 * 409 FINALIZE_INCOMPLETE (so RideOps gets a usable code instead of a raw
 * PRECHECKIN_REQUIRED on a visibly closed session). But the wizard does not
 * swallow 409s unconditionally — it refetches and compares step order, `at >=
 * want`. FINALIZE_INCOMPLETE is raised ONLY when the session is already AT
 * toStep, so that comparison is satisfied by construction and every one of
 * them would vanish without a toast. Before the re-label those failures were
 * 422s, which fell straight through to the toast: confusing, but visible.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { shouldSwallowTransitionConflict, STEP_ORDER } from '@/lib/checkout-session';

const conflict = (code) => ({ status: 409, code, message: 'boom' });

describe('shouldSwallowTransitionConflict', () => {
  it('swallows the classic double-fire: session already AT the requested step', () => {
    expect(shouldSwallowTransitionConflict({
      err: conflict('ILLEGAL_TRANSITION'),
      fresh: { currentStep: 'TC_PENDING' },
      toStep: 'TC_PENDING',
    })).toBe(true);
  });

  it('swallows when the session is already PAST the requested step', () => {
    expect(shouldSwallowTransitionConflict({
      err: conflict('ILLEGAL_TRANSITION'),
      fresh: { currentStep: 'PAID' },
      toStep: 'TC_PENDING',
    })).toBe(true);
  });

  it('does NOT swallow a genuine conflict from behind the requested step', () => {
    expect(shouldSwallowTransitionConflict({
      err: conflict('ENTRY_GUARD'),
      fresh: { currentStep: 'TC_PENDING' },
      toStep: 'PAID',
    })).toBe(false);
  });

  // The point of the file.
  it('NEVER swallows FINALIZE_INCOMPLETE, even though the step comparison passes', () => {
    const fresh = { currentStep: 'CLOSED' };
    const toStep = 'CLOSED';

    // The step rule on its own would hide it — same step, so at === want.
    expect(STEP_ORDER.indexOf(fresh.currentStep)).toBe(STEP_ORDER.indexOf(toStep));
    expect(shouldSwallowTransitionConflict({
      err: conflict('ILLEGAL_TRANSITION'), fresh, toStep,
    })).toBe(true);

    // ...but this code has to reach the agent: the checkout is closed while
    // the reservation is still CONFIRMED, the contract DRAFT, the car unmarked.
    expect(shouldSwallowTransitionConflict({
      err: conflict('FINALIZE_INCOMPLETE'), fresh, toStep,
    })).toBe(false);
  });

  it('leaves non-409s alone (they were always toasted)', () => {
    for (const status of [400, 404, 422, 500]) {
      expect(shouldSwallowTransitionConflict({
        err: { status, code: 'PRECHECKIN_REQUIRED' },
        fresh: { currentStep: 'CLOSED' },
        toStep: 'CLOSED',
      })).toBe(false);
    }
  });

  it('does not swallow when the fresh step is unknown/missing', () => {
    expect(shouldSwallowTransitionConflict({
      err: conflict('ILLEGAL_TRANSITION'), fresh: null, toStep: 'CLOSED',
    })).toBe(false);
    expect(shouldSwallowTransitionConflict({
      err: conflict('ILLEGAL_TRANSITION'), fresh: { currentStep: 'CANCELLED' }, toStep: 'CLOSED',
    })).toBe(false);
  });
});

/**
 * The CALL SITE, pinned (2026-08-28).
 *
 * Everything above tests a pure function. Nothing above proves the wizard
 * actually CALLS it — and that gap is not theoretical. Merging main into this
 * branch conflicts in page.js, and main still carries the pre-H8 inline
 * `STEP_ORDER` / `at >= want` version of `advance()`. Resolving that hunk the
 * natural way — "take the side of the file main kept editing" — silently
 * restores the unconditional swallow, leaves `shouldSwallowTransitionConflict`
 * exported-but-unused, and every test above KEEPS PASSING. The exemption would
 * be gone from the only surface an agent ever looks at, with nothing red.
 *
 * So the wiring gets pinned by source, the same way checkout-payment-optional
 * pins its own wizard branch. Mounting the 2k-line page would need auth, a
 * router, the api client and QR codes to assert one `if`; this is the smallest
 * thing that goes red on the bad resolution.
 */
describe('the wizard actually delegates the swallow decision', () => {
  const WIZARD = join(
    dirname(fileURLToPath(import.meta.url)),
    '..', 'src', 'app', 'reservations', '[id]', 'checkout-wizard-v2', 'page.js',
  );
  const src = () => readFileSync(WIZARD, 'utf8');
  // advance() is the only place a transition 409 is handled.
  const advanceBody = () => {
    const s = src();
    const start = s.indexOf('const advance = async (toStep, metadata)');
    expect(start, 'advance() not found in the wizard').toBeGreaterThan(-1);
    const end = s.indexOf('const pauseAndExit', start);
    expect(end, 'could not bound advance()').toBeGreaterThan(start);
    return s.slice(start, end);
  };

  it('imports shouldSwallowTransitionConflict from the lib', () => {
    expect(src()).toMatch(/import\s*\{[^}]*\bshouldSwallowTransitionConflict\b[^}]*\}\s*from\s*'[^']*lib\/checkout-session'/s);
  });

  it('asks the library, passing the error so FINALIZE_INCOMPLETE can be seen', () => {
    // `err` must be in the payload: the exemption keys off err.code, so a call
    // that only forwarded { fresh, toStep } would swallow it again.
    expect(advanceBody()).toMatch(
      /shouldSwallowTransitionConflict\(\{\s*err,\s*fresh,\s*toStep\s*\}\)/,
    );
  });

  it('keeps NO inline step-order comparison of its own', () => {
    const s = src();
    // The pre-H8 gate, in any of the shapes it has worn.
    expect(s).not.toMatch(/const STEP_ORDER\s*=\s*\[/);
    expect(s).not.toMatch(/at\s*>=\s*want/);
    expect(s).not.toMatch(/STEP_ORDER\.indexOf/);
  });

  it('reconciles the screen to server truth before toasting the error', () => {
    // On FINALIZE_INCOMPLETE the session really IS closed. The agent has to see
    // the closed session AND the reason the finalize did not finish.
    const body = advanceBody();
    const reconcile = body.search(/if\s*\(freshSession\)\s*setSession\(freshSession\)/);
    const toast = body.search(/setToast\(\{\s*kind:\s*'error'/);
    expect(reconcile, 'the reconcile-before-toast line is gone').toBeGreaterThan(-1);
    expect(toast, 'the error toast is gone').toBeGreaterThan(-1);
    expect(reconcile).toBeLessThan(toast);
  });
});
