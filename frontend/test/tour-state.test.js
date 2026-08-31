import { describe, it, expect } from 'vitest';
import {
  startTour, currentStep, advance, retreat, dismiss, settleStart,
  progressOf, isSettled, serialize, deserialize, TOUR_END, TOUR_STATE_VERSION,
  waitForRecord, resumeAt, stopWaiting,
} from '../src/lib/training/tour-state.js';
import {
  stepsForTrack, findModule, moduleForStep, moduleRunEnd, recordScopedRunEnd, TOUR_TRACKS,
} from '../src/lib/training/curriculum.js';

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

describe('parking, and the window a parked tour may resume into', () => {
  const steps = [S('a'), S('b'), S('c'), S('d'), S('e')];

  it('records where it parked and how far it may look', () => {
    const parked = waitForRecord({ index: 2, endedAs: TOUR_END.BROKEN }, { midTour: true, from: 2, through: 3 });
    expect(parked.waiting).toBe(true);
    expect(parked.endedAs).toBeNull();
    expect(parked.resumeFrom).toBe(2);
    expect(parked.resumeThrough).toBe(3);
  });

  it('NEVER resumes before where it parked', () => {
    // The bug this pins: `a` is a sidebar link present on every route, so an
    // unfenced scan from zero sent a tour parked at step 3 back to step 1 and
    // walked the same stretch forever.
    const parked = waitForRecord({ index: 2 }, { midTour: true, from: 2, through: 3 });
    expect(resumeAt(parked, steps, present('a', 'c')).index).toBe(2);
  });

  it('never resumes past the end of the run it was waiting on', () => {
    // `e` is present but lives beyond the window — resuming there would skip
    // whole modules the person never saw.
    const parked = waitForRecord({ index: 2 }, { midTour: true, from: 2, through: 3 });
    expect(resumeAt(parked, steps, present('e'))).toBeNull();
  });

  it('keeps waiting while nothing in the window is showable', () => {
    const parked = waitForRecord({ index: 2 }, { midTour: true, from: 2, through: 3 });
    expect(resumeAt(parked, steps, none)).toBeNull();
  });

  it('resumes at a later step of the same run when the person moved on', () => {
    const parked = waitForRecord({ index: 2 }, { midTour: true, from: 2, through: 4 });
    expect(resumeAt(parked, steps, present('d')).index).toBe(3);
  });

  it('drops every trace of parking when it resumes', () => {
    const parked = waitForRecord({ index: 2 }, { midTour: true, from: 2, through: 4, skipThrough: 4 });
    const back = resumeAt(parked, steps, present('c'));
    expect(back.waiting).toBeUndefined();
    expect(back.midTour).toBeUndefined();
    expect(back.resumeFrom).toBeUndefined();
    expect(back.resumeThrough).toBeUndefined();
    expect(back.skipThrough).toBeUndefined();
  });

  it('the skip mark can reach past the resume fence', () => {
    // Resuming stays inside the module; skipping clears every record-scoped
    // module after it.
    const parked = waitForRecord({ index: 2 }, { midTour: false, from: 2, through: 2, skipThrough: 4 });
    expect(parked.resumeThrough).toBe(2);
    expect(parked.skipThrough).toBe(4);
    expect(resumeAt(parked, steps, present('d'))).toBeNull();
  });

  it('an unfenced state (older build) still scans the whole list', () => {
    expect(resumeAt({ index: 0, waiting: true }, steps, present('d')).index).toBe(3);
  });

  it('stopWaiting strips the parking fields and keeps the rest', () => {
    const parked = waitForRecord({ track: 'T', index: 2 }, { midTour: true, from: 2, through: 3 });
    expect(stopWaiting(parked)).toEqual({ track: 'T', index: 2, endedAs: null });
  });
});

/**
 * The step-11 regression, driven off the REAL curriculum rather than fixtures —
 * the bug was invisible to fixtures because it depended on the onboarding
 * track carrying no moduleKey of its own.
 */
describe('the onboarding track does not die at a module boundary', () => {
  const viewer = { role: 'ADMIN', isModuleEnabled: () => true };
  const steps = stepsForTrack(TOUR_TRACKS.ONBOARDING, viewer);
  // Anchors that live in the sidebar/topbar and so exist on every route.
  const CHROME = ['nav-dashboard', 'global-search', 'nav-reservations', 'nav-university',
    'nav-reports', 'nav-people', 'nav-settings', 'nav-market'];

  const parkIfRecordScoped = (next, list) => {
    if (next?.endedAs !== TOUR_END.BROKEN) return next;
    const at = next.index || 0;
    const mod = moduleForStep(list?.[at]) || (next.moduleKey ? findModule(next.moduleKey) : null);
    if (!mod?.needsRecord) return next;
    const first = at === 0 || list?.[at - 1]?.moduleKey !== list?.[at]?.moduleKey;
    return waitForRecord(next, {
      midTour: !first, from: at, through: moduleRunEnd(list, at), skipThrough: recordScopedRunEnd(list, at),
    });
  };

  it('every step knows its module, even though the track does not', () => {
    expect(steps.every((s) => !!moduleForStep(s))).toBe(true);
  });

  it('parks at the check-out boundary instead of ending BROKEN', () => {
    // Standing on the new-reservation wizard, having just pressed Next on the
    // last step of "Create a reservation".
    const onWizard = (a) => CHROME.includes(a)
      || ['wizard-step-dates', 'wizard-step-vehicle', 'wizard-step-customer', 'wizard-step-review'].includes(a);
    const atReview = steps.findIndex((s) => s.anchor === 'wizard-step-review');
    const after = parkIfRecordScoped(
      advance({ track: 'ONBOARDING', moduleKey: null, index: atReview, endedAs: null }, steps, onWizard),
      steps,
    );
    expect(after.endedAs).toBeNull();
    expect(after.waiting).toBe(true);
    // Parked on the FIRST step of check-out, so the person is told to open a
    // reservation rather than to "open the next screen".
    expect(after.midTour).toBe(false);
    expect(steps[after.index].anchor).toBe('reservation-checkout');
    expect(moduleForStep(steps[after.index]).key).toBe('check-out');
  });

  it('the skip mark covers every record-scoped module and stops there', () => {
    const from = steps.findIndex((s) => s.anchor === 'reservation-checkout');
    const through = recordScopedRunEnd(steps, from);
    const covered = steps.slice(from, through + 1).map((s) => s.moduleKey);
    expect([...new Set(covered)]).toEqual(['check-out', 'check-in', 'take-payment']);
    // The step after the run is not record-scoped, so the tour can walk on.
    expect(moduleForStep(steps[through + 1])?.needsRecord).toBeFalsy();
  });

  it('the resume fence stays inside one module, so no module is skipped', () => {
    // A reservation page shows check-out's, check-in's AND payments' first
    // step at once. Parked inside check-out, the tour must not resume on
    // check-in just because its button happens to be visible.
    const terms = steps.findIndex((s) => s.anchor === 'checkout-terms');
    const fence = moduleRunEnd(steps, terms);
    expect(steps.slice(terms, fence + 1).every((s) => s.moduleKey === 'check-out')).toBe(true);
    const parked = waitForRecord({ index: terms }, { midTour: true, from: terms, through: fence });
    const onRecordPage = (a) => ['reservation-checkout', 'reservation-checkin', 'reservation-payments'].includes(a);
    expect(resumeAt(parked, steps, onRecordPage)).toBeNull();
  });

  it('a trainee with no live rental can still reach the final step', () => {
    // Skipping the parked run must land the tour back on real steps, not end it.
    const from = steps.findIndex((s) => s.anchor === 'reservation-checkout');
    const parked = waitForRecord({ track: 'ONBOARDING', moduleKey: null, index: from, endedAs: null },
      { midTour: false, from, through: moduleRunEnd(steps, from), skipThrough: recordScopedRunEnd(steps, from) });
    const resumed = advance(stopWaiting(parked), steps, () => true, parked.skipThrough);
    expect(resumed.endedAs).toBeNull();
    expect(resumed.index).toBe(parked.skipThrough + 1);
    expect(resumed.index).toBeLessThan(steps.length);
  });
});
