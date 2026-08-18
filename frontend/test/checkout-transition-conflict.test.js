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
