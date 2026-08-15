/**
 * The tour's state machine — pure, so the decisions are testable without a
 * browser and the component is left holding only the DOM and the timers.
 *
 * Same split the rest of this codebase uses (view-location, backdated-return,
 * voltswitch-sync-due): one definition of the rule, exercised directly by
 * tests, consumed by exactly one caller.
 *
 * The rule that shapes everything here: a step whose element is NOT on the
 * page must never strand the tour. Anchors sit on real UI, and real UI is
 * conditional — the review tray hides when the queue is empty, the location
 * switcher only exists for someone with several branches, alerts only render
 * when something is wrong. A step marked `optional` is skipped when its
 * element is absent; a REQUIRED step whose element is missing is a bug in the
 * curriculum, and the tour ends cleanly rather than pointing at nothing.
 */

export const TOUR_STORAGE_KEY = 'ui.tour';

/** Reasons a tour stopped — worth distinguishing when reporting progress. */
export const TOUR_END = Object.freeze({
  COMPLETED: 'COMPLETED',   // walked every step
  DISMISSED: 'DISMISSED',   // the person closed it
  BROKEN: 'BROKEN',         // a required anchor was missing — our fault, not theirs
});

/**
 * @param {object} args
 * @param {string} args.track
 * @param {Array} args.steps    already filtered for the viewer
 * @param {string} [args.moduleKey]
 */
export function startTour({ track, steps, moduleKey = null }) {
  if (!Array.isArray(steps) || steps.length === 0) return null;
  return { track, moduleKey, index: 0, total: steps.length, endedAs: null };
}

/** The step a state points at, or null once the tour has ended. */
export function currentStep(state, steps) {
  if (!state || state.endedAs) return null;
  return steps?.[state.index] || null;
}

/**
 * Move to the next index that is actually showable.
 *
 * @param {object} state
 * @param {Array} steps
 * @param {(anchor: string) => boolean} isPresent  does this anchor exist right now
 * @param {number} [from]  index to start looking AFTER; defaults to the current one
 */
function scanFrom(state, steps, isPresent, startIndex) {
  for (let i = startIndex; i < steps.length; i++) {
    const step = steps[i];
    // A step that navigates elsewhere can't be checked from here — the element
    // will exist once the route loads. Trust it and let the host settle.
    if (step.route || isPresent(step.anchor)) return { ...state, index: i };
    // Optional and absent is expected; required and absent is our bug, and the
    // tour says so rather than quietly walking past a step it promised.
    if (!step.optional) return { ...state, index: i, endedAs: TOUR_END.BROKEN };
  }
  return { ...state, endedAs: TOUR_END.COMPLETED };
}

export function advance(state, steps, isPresent, from = undefined) {
  if (!state || state.endedAs) return state;
  return scanFrom(state, steps, isPresent, (from === undefined ? state.index : from) + 1);
}

/** Step backwards, skipping anything that would not render. */
export function retreat(state, steps, isPresent) {
  if (!state || state.endedAs) return state;
  for (let i = state.index - 1; i >= 0; i--) {
    const step = steps[i];
    if (step.route || isPresent(step.anchor)) return { ...state, index: i };
  }
  return state; // already at the first showable step
}

/** The person closed it. Never nags again for this track. */
export function dismiss(state) {
  if (!state) return null;
  return { ...state, endedAs: TOUR_END.DISMISSED };
}

/**
 * Resolve the FIRST showable step when a tour opens. Same rules as advance,
 * but it may legitimately land on index 0.
 */
export function settleStart(state, steps, isPresent) {
  if (!state) return null;
  // Scans from index 0 INCLUSIVE, under the same rule as advance — an earlier
  // version delegated to advance() and so began at index 1, silently stepping
  // over a missing required first step instead of reporting it broken.
  return scanFrom(state, steps, isPresent, 0);
}

/** 1-based position for display, and a 0..1 fraction for the progress bar. */
export function progressOf(state, steps) {
  if (!state) return { position: 0, total: 0, fraction: 0 };
  const total = steps?.length || state.total || 0;
  const position = Math.min(state.index + 1, total);
  return { position, total, fraction: total ? position / total : 0 };
}

/** Has this track already been finished or waved away? */
export function isSettled(state) {
  return !!state?.endedAs;
}

/**
 * Serialize for localStorage. Deliberately small and version-stamped: a shape
 * change must not resurrect a half-finished tour from an old build in the
 * middle of someone's shift.
 */
export const TOUR_STATE_VERSION = 1;

export function serialize(state) {
  if (!state) return null;
  return JSON.stringify({ v: TOUR_STATE_VERSION, ...state });
}

export function deserialize(raw) {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || parsed.v !== TOUR_STATE_VERSION) return null;
    const { v, ...state } = parsed;
    return typeof state.index === 'number' ? state : null;
  } catch {
    return null;
  }
}
