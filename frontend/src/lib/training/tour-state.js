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

/**
 * The step a state points at — or null when the tour has ended, OR while it
 * is WAITING for the person to open the record it walks through.
 *
 * Waiting is not a step: the host must not hunt for an anchor, time out, and
 * declare the tour broken while the person is still on their way to a
 * reservation (Hector, 2026-08-17: "no me guía paso por paso").
 */
export function currentStep(state, steps) {
  if (!state || state.endedAs || state.waiting) return null;
  return steps?.[state.index] || null;
}

/**
 * Park a tour until its record is open, instead of ending it BROKEN.
 *
 * Only meaningful for modules that declare where the record lives: check-out,
 * check-in and take-payment happen inside one reservation's page, so starting
 * them from Ride University finds nothing. Rather than fail, the tour waits
 * and springs to life the moment those anchors appear.
 */
export function waitForRecord(state, { midTour = false } = {}) {
  if (!state) return null;
  // `midTour` separates the two moments this happens, because they need
  // different words: before anything has been shown the person must OPEN a
  // reservation, but once the walkthrough is running they are already in one
  // and simply have to move to the next screen (the check-out wizard), where
  // the remaining steps live.
  return { ...state, endedAs: null, waiting: true, midTour };
}

/**
 * Where a parked tour should pick up: the FIRST step whose anchor is on
 * screen right now — not necessarily step one.
 *
 * Both halves matter (Hector, 2026-08-17). Landing on the reservation page
 * finds step one. But pressing "Start Check-out" navigates into the wizard,
 * where step one's button no longer exists and steps two and three do — a
 * scan that only ever checked step one would wait there forever, watching a
 * page full of its own anchors.
 *
 * Returns null when nothing is showable yet, which means: keep waiting.
 */
export function resumeAt(state, steps, isPresent) {
  if (!state || !Array.isArray(steps)) return null;
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    if (!step) continue;
    if (isPresent(step.anchor)) {
      const { waiting, ...rest } = state;
      return { ...rest, index: i, endedAs: null };
    }
  }
  return null;
}

/** Resume a parked tour — the host calls this when the route changes. */
export function stopWaiting(state) {
  if (!state) return null;
  const { waiting, ...rest } = state;
  return rest;
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
