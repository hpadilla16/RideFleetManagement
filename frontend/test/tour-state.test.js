import { describe, it, expect } from 'vitest';
import {
  startTour, currentStep, advance, retreat, dismiss, settleStart,
  progressOf, isSettled, serialize, deserialize, TOUR_END, TOUR_STATE_VERSION,
} from '../src/lib/training/tour-state.js';

const S = (anchor, extra = {}) => ({ anchor, title: anchor, body: anchor, ...extra });
const present = (...names) => (a) => names.includes(a);
const all = () => true;
const none = () => false;

describe('starting', () => {
  it('starts at the first step', () => {
    const st = startTour({ track: 'ONBOARDING', steps: [S('a'), S('b')] });
    expect(st.index).toBe(0);
    expect(st.total).toBe(2);
    expect(st.endedAs).toBeNull();
  });

  it('refuses to start with nothing to show', () => {
    expect(startTour({ track: 'ONBOARDING', steps: [] })).toBeNull();
    expect(startTour({ track: 'ONBOARDING', steps: null })).toBeNull();
  });

  it('skips past a missing optional first step', () => {
    const steps = [S('gone', { optional: true }), S('here')];
    const st = settleStart(startTour({ track: 'T', steps }), steps, present('here'));
    expect(currentStep(st, steps).anchor).toBe('here');
  });

  it('a missing REQUIRED first step ends the tour rather than pointing at nothing', () => {
    const steps = [S('gone'), S('here')];
    const st = settleStart(startTour({ track: 'T', steps }), steps, present('here'));
    expect(st.endedAs).toBe(TOUR_END.BROKEN);
    expect(currentStep(st, steps)).toBeNull();
  });
});

describe('advancing', () => {
  const steps = [S('a'), S('b'), S('c')];

  it('walks forward one step at a time', () => {
    let st = startTour({ track: 'T', steps });
    st = advance(st, steps, all);
    expect(st.index).toBe(1);
    st = advance(st, steps, all);
    expect(st.index).toBe(2);
  });

  it('completes after the last step', () => {
    let st = { track: 'T', index: 2, total: 3, endedAs: null };
    st = advance(st, steps, all);
    expect(st.endedAs).toBe(TOUR_END.COMPLETED);
    expect(currentStep(st, steps)).toBeNull();
  });

  it('jumps over an optional step whose element is absent', () => {
    const withOptional = [S('a'), S('hidden', { optional: true }), S('c')];
    const st = advance(startTour({ track: 'T', steps: withOptional }), withOptional, present('a', 'c'));
    expect(st.index).toBe(2);
    expect(st.endedAs).toBeNull();
  });

  it('completes when every remaining step is optional and absent', () => {
    const withOptional = [S('a'), S('x', { optional: true }), S('y', { optional: true })];
    const st = advance(startTour({ track: 'T', steps: withOptional }), withOptional, present('a'));
    expect(st.endedAs).toBe(TOUR_END.COMPLETED);
  });

  it('a step that navigates is trusted without checking the DOM', () => {
    // Its element lives on the next page, so it cannot be present yet.
    const nav = [S('a'), S('elsewhere', { route: '/reservations' })];
    const st = advance(startTour({ track: 'T', steps: nav }), nav, present('a'));
    expect(st.index).toBe(1);
    expect(st.endedAs).toBeNull();
  });

  it('a missing required step stops the tour, and says why', () => {
    const st = advance(startTour({ track: 'T', steps }), steps, present('a'));
    expect(st.endedAs).toBe(TOUR_END.BROKEN);
  });

  it('advancing an ended tour changes nothing', () => {
    const ended = { track: 'T', index: 1, total: 3, endedAs: TOUR_END.COMPLETED };
    expect(advance(ended, steps, all)).toBe(ended);
  });
});

describe('going back', () => {
  const steps = [S('a'), S('b'), S('c')];

  it('steps backwards', () => {
    const st = retreat({ track: 'T', index: 2, total: 3, endedAs: null }, steps, all);
    expect(st.index).toBe(1);
  });

  it('stays put at the first step', () => {
    const st = { track: 'T', index: 0, total: 3, endedAs: null };
    expect(retreat(st, steps, all).index).toBe(0);
  });

  it('skips back over something no longer on screen', () => {
    const st = retreat({ track: 'T', index: 2, total: 3, endedAs: null }, steps, present('a', 'c'));
    expect(st.index).toBe(0);
  });
});

describe('dismissing', () => {
  it('marks it dismissed, not completed — they are different facts', () => {
    const st = dismiss(startTour({ track: 'T', steps: [S('a')] }));
    expect(st.endedAs).toBe(TOUR_END.DISMISSED);
    expect(isSettled(st)).toBe(true);
  });

  it('dismissing nothing is safe', () => {
    expect(dismiss(null)).toBeNull();
  });
});

describe('progress', () => {
  it('reports a 1-based position and a fraction', () => {
    const steps = [S('a'), S('b'), S('c'), S('d')];
    expect(progressOf({ index: 0, total: 4 }, steps)).toEqual({ position: 1, total: 4, fraction: 0.25 });
    expect(progressOf({ index: 3, total: 4 }, steps)).toEqual({ position: 4, total: 4, fraction: 1 });
  });

  it('handles no tour', () => {
    expect(progressOf(null, [])).toEqual({ position: 0, total: 0, fraction: 0 });
  });
});

describe('persistence', () => {
  it('round-trips', () => {
    const st = startTour({ track: 'ONBOARDING', steps: [S('a'), S('b')] });
    expect(deserialize(serialize(st))).toEqual(st);
  });

  it('drops state written by a different version', () => {
    const stale = JSON.stringify({ v: TOUR_STATE_VERSION + 1, track: 'T', index: 4 });
    expect(deserialize(stale)).toBeNull();
  });

  it('survives garbage without throwing', () => {
    expect(deserialize('not json')).toBeNull();
    expect(deserialize('')).toBeNull();
    expect(deserialize(null)).toBeNull();
    expect(deserialize('{"v":1}')).toBeNull(); // no index
  });
});

describe('the failure that matters most', () => {
  it('a tour never renders a step whose element is not there', () => {
    // Every path out of a missing anchor either moves on or ends. Nothing
    // leaves the tour pointing at an element the person cannot see.
    const steps = [S('a'), S('missing-optional', { optional: true }), S('missing-required'), S('d')];
    const st = advance(startTour({ track: 'T', steps }), steps, present('a', 'd'));
    const shown = currentStep(st, steps);
    if (shown) expect(present('a', 'd')(shown.anchor) || !!shown.route).toBe(true);
    else expect(isSettled(st)).toBe(true);
  });

  it('a tour with nothing showable at all ends instead of hanging', () => {
    const steps = [S('x', { optional: true }), S('y', { optional: true })];
    const st = settleStart(startTour({ track: 'T', steps }), steps, none);
    expect(isSettled(st)).toBe(true);
    expect(currentStep(st, steps)).toBeNull();
  });
});
