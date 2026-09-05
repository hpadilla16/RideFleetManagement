'use client';

/**
 * Ride University — the tour overlay.
 *
 * MOUNTED IN app/layout.js, NOT AppShell. AppShell is imported by each page
 * individually (74 of them), so it remounts on every navigation and would
 * destroy the tour's state at exactly the moment a cross-route tour needs it.
 * The layout persists across App Router navigation; SentryBoot and I18nBoot
 * already live there for the same reason.
 *
 * WHAT IT OWNS: the DOM and the timers. Every decision — which step is next,
 * what to do when an element is missing, when the tour is finished — lives in
 * lib/training/tour-state.js, which is pure and directly tested.
 *
 * PORTALS TO document.body. Inline z-index reaches 9999 in this app, and a
 * fixed overlay rendered inside a page can still be trapped by an ancestor
 * stacking context. The portal makes the overlay a sibling of everything.
 *
 * LAUNCHED BY EVENT: any page fires window.dispatchEvent(new CustomEvent(
 * 'ride-university:start', { detail: { track, moduleKey } })). Nothing has to
 * import this component or thread props through the tree.
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useRouter, usePathname } from 'next/navigation';
import { useTranslation } from 'react-i18next';
import {
  TOUR_TRACKS, stepsForTrack, stepsForModule, findModule,
  moduleForStep, moduleRunEnd, recordScopedRunEnd, isVirtualStep,
} from '../../lib/training/curriculum.js';
import { figureFor } from './figures/index.js';
import { stepKey, moduleKey as mKeyOf, trainingText } from '../../lib/training/i18n-keys.js';
import {
  TOUR_STORAGE_KEY, TOUR_END,
  startTour, settleStart, currentStep, advance, retreat, dismiss,
  waitForRecord, resumeAt, stopWaiting,
  progressOf, serialize, deserialize,
} from '../../lib/training/tour-state.js';

export const TOUR_START_EVENT = 'ride-university:start';
/** Fired when a MODULE-track tour reaches the end — Ride University listens. */
export const TOUR_MODULE_DONE_EVENT = 'ride-university:module-walked';

/** How long to wait for a route's elements before judging an anchor missing. */
const SETTLE_MS = 700;
/**
 * Showcase advances on its own (Hector, 2026-08-15): at a convention the
 * laptop is usually across the table, so the deck should run unattended and
 * only stop when someone decides to talk about a step. Any interaction —
 * arrows, Next, Back, the pause button — halts it, because that means a person
 * took over.
 */
const SHOWCASE_STEP_MS = 9000;
// How long the showcase lingers on a parked stretch before skipping it —
// long enough to read the bar once, far shorter than a step.
const SHOWCASE_PARKED_SKIP_MS = 2500;
/** How often a parked tour checks whether its record is finally open. */
const WAIT_POLL_MS = 700;
const CARD_WIDTH = 340;
/** A drawn or asked step has no element to sit beside; it gets a wider, centred card. */
const WIDE_CARD_WIDTH = 560;
const GAP = 12;

const findAnchor = (name) => (typeof document === 'undefined'
  ? null
  : document.querySelector(`[data-tour="${CSS.escape(name)}"]`));

/**
 * Present in the DOM is NOT the same as visible to the person.
 *
 * Caught in the browser, not by a test: at narrow widths the nav lives in a
 * collapsed drawer that is translated off-screen (left: -240px) while staying
 * queryable. Trusting querySelector alone dimmed the page and drew the
 * spotlight outside the viewport, on an element nobody could see.
 *
 * Vertical position is deliberately NOT checked — something below the fold is
 * fine, we scroll to it. Horizontal absence is the tell for a closed drawer,
 * because scrolling will never bring it back.
 */
function isUsable(el) {
  if (!el) return false;
  if (typeof el.checkVisibility === 'function'
    && !el.checkVisibility({ checkVisibilityCSS: true, checkOpacity: true })) return false;
  const r = el.getBoundingClientRect();
  if (r.width <= 0 || r.height <= 0) return false;
  return r.right > 0 && r.left < window.innerWidth;
}

/** The element for an anchor, only if the person could actually see it. */
const anchorEl = (name) => {
  const el = findAnchor(name);
  return isUsable(el) ? el : null;
};

/**
 * A COLLAPSED SIDEBAR SECTION MUST NOT KILL A NAV STEP (2026-08-26).
 *
 * The sectioned sidebar (ac789836) hides a closed group with
 * `.nav-sec.closed .nav-sec-items { display: none }`. The link is still in the
 * DOM, so querySelector finds it — but isUsable() correctly rejects it, and the
 * step is judged missing. Anyone who had collapsed "Dinero" lost the whole
 * Reports step of the onboarding tour, silently.
 *
 * Rather than click the section open (which writes the person's own
 * `ui.nav.section.<key>` preference and would leave their sidebar rearranged
 * after the tour), a tour in progress stamps the document and CSS un-hides
 * collapsed sections for its duration. The rail mode already overrides exactly
 * this rule the same way, so the mechanism is not new — see globals.css.
 *
 * Set SYNCHRONOUSLY, before any isPresent()/settleStart() decision runs.
 */
const TOUR_ACTIVE_ATTR = 'data-tour-active';
const setTourActive = (on) => {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  if (on) root.setAttribute(TOUR_ACTIVE_ATTR, '1');
  else root.removeAttribute(TOUR_ACTIVE_ATTR);
};

export function TourHost({ viewer }) {
  const router = useRouter();
  const pathname = usePathname();
  const { t } = useTranslation();

  const [state, setState] = useState(null);
  const [steps, setSteps] = useState([]);
  const [rect, setRect] = useState(null);
  const [autoPlay, setAutoPlay] = useState(false);
  const cardRef = useRef(null);
  const lastFocused = useRef(null);
  const walkedModules = useRef(new Set());
  /**
   * Anchors that are ALWAYS present: the steps that draw a screen (`figure`)
   * or ask a question (`check`) instead of pointing at an element. tour-state
   * only ever asks isPresent(anchor), so the set is kept here and filled from
   * the step list before the first decision is made — onStart runs before
   * setSteps has applied, which is why it is a ref and not derived state.
   */
  const virtualAnchors = useRef(new Set());
  const rememberVirtual = (list) => {
    virtualAnchors.current = new Set((list || []).filter(isVirtualStep).map((s) => s.anchor));
  };
  const isPresent = useCallback((name) => virtualAnchors.current.has(name) || !!anchorEl(name), []);
  // The answer picked on a check step. Reset whenever the step changes. The
  // ref mirrors "Next is locked" for the keyboard handler, which is bound once.
  const [pick, setPick] = useState(null);
  const nextLockedRef = useRef(false);

  /**
   * A missing anchor is only BROKEN when the step should have been there.
   *
   * For a module that walks a record, it usually means the person has not
   * moved to the next screen yet: step one is the button on the reservation,
   * steps two and three live inside the check-out wizard it opens. Ending the
   * tour there told them to "open a reservation" while they were looking at
   * one (Hector, 2026-08-17). Park instead, and the watcher picks the guide
   * back up wherever they land.
   *
   * THE MODULE COMES FROM THE STEP, NOT THE TOUR (2026-08-28). Asking
   * `state.moduleKey` works only for a MODULE-track tour launched from Ride
   * University. The ONBOARDING track has no moduleKey — it is all the modules
   * in one sequence — so this returned null there, never parked, and the tour
   * died at step 11 of 33, on the boundary into check-out. The step knows
   * which module it belongs to; the tour does not.
   *
   * `list` is passed rather than closed over: onStart parks before setSteps
   * has applied, so the `steps` state is still the PREVIOUS tour's (empty on
   * the first launch) at that moment.
   */
  const parkIfRecordScoped = useCallback((next, list) => {
    if (next?.endedAs !== TOUR_END.BROKEN) return next;
    const at = next.index || 0;
    const mod = moduleForStep(list?.[at]) || (next.moduleKey ? findModule(next.moduleKey) : null);
    if (!mod?.needsRecord) return next;
    // "Already inside the record" is a question about the STEP, not the index.
    // Parked on a module's FIRST step, the person still has to open a
    // reservation. Parked on a later one they are in a reservation already and
    // only have to move to the next screen. Index > 0 conflated the two, and on
    // the onboarding track every record-scoped module begins mid-list — so the
    // boundary into check-out told them to "open the next screen" and hid the
    // one button that would have helped.
    const first = at === 0 || list?.[at - 1]?.moduleKey !== list?.[at]?.moduleKey;
    return waitForRecord(next, {
      midTour: !first,
      from: at,
      // Resume only within this module (see moduleRunEnd) …
      through: moduleRunEnd(list, at),
      // … but let one press of "Skip this part" clear every record-scoped
      // module that follows, not just this one.
      skipThrough: recordScopedRunEnd(list, at),
    });
  }, []);

  const persist = useCallback((next) => {
    setState(next);
    try {
      if (!next || next.endedAs) window.localStorage.setItem(TOUR_STORAGE_KEY, serialize(next) || '');
      else window.localStorage.setItem(TOUR_STORAGE_KEY, serialize(next));
    } catch { /* private browsing — the tour still works, it just won't resume */ }
  }, []);

  /**
   * Keep the document stamp in step with the tour. Declared BEFORE the
   * anchor-locating effect on purpose: effects run in declaration order within
   * a commit, so the stamp is on the element by the time anchorEl() looks. A
   * PARKED tour (state.waiting) still counts as running — its watcher is
   * polling isPresent() and needs the same sections open.
   */
  useEffect(() => {
    setTourActive(!!state && !state.endedAs);
  }, [state]);
  useEffect(() => () => setTourActive(false), []);

  // ── launch ────────────────────────────────────────────────────────────────
  useEffect(() => {
    const onStart = (event) => {
      const { track = TOUR_TRACKS.ONBOARDING, moduleKey = null } = event?.detail || {};
      const list = moduleKey ? stepsForModule(moduleKey) : stepsForTrack(track, viewer || {});
      const fresh = startTour({ track, steps: list, moduleKey });
      if (!fresh) return;
      rememberVirtual(list);
      setSteps(list);
      lastFocused.current = document.activeElement;
      walkedModules.current = new Set();
      // The showcase runs itself until a person takes over.
      setAutoPlay(track === TOUR_TRACKS.SHOWCASE);
      // Before settleStart, which asks isPresent() about the first step: a nav
      // link inside a collapsed section must already be revealed by now, or the
      // tour would start by skipping it.
      setTourActive(true);
      const settled = settleStart(fresh, list, isPresent);
      // A module that walks through one record (a reservation's own page)
      // finds nothing from Ride University. Park the tour instead of ending
      // it, and pick up the moment the person opens one.
      persist(parkIfRecordScoped(settled, list));
    };
    window.addEventListener(TOUR_START_EVENT, onStart);
    return () => window.removeEventListener(TOUR_START_EVENT, onStart);
  }, [viewer, isPresent, persist, parkIfRecordScoped]);

  // ── resume across navigation ──────────────────────────────────────────────
  useEffect(() => {
    if (state || typeof window === 'undefined') return;
    let saved = null;
    try { saved = deserialize(window.localStorage.getItem(TOUR_STORAGE_KEY)); } catch { saved = null; }
    if (!saved || saved.endedAs) return;
    const list = saved.moduleKey ? stepsForModule(saved.moduleKey) : stepsForTrack(saved.track, viewer || {});
    if (!list.length) return;
    rememberVirtual(list);
    setSteps(list);
    setState(saved);
  }, [state, viewer]);

  /**
   * A parked tour WATCHES for its record — it does not check once and give up.
   *
   * The first version fired a single timer on route change (Hector,
   * 2026-08-17: "se queda esperando"). A reservation page still fetching at
   * that instant meant the anchors were not there yet, and nothing ever looked
   * again. So this polls, and resumeAt takes whichever step is actually on
   * screen: the button on the reservation page, or — if they pressed it and
   * moved into the wizard — the step that lives there.
   *
   * The cost is one querySelector per tick against a page we are already
   * waiting on, and it stops the moment the tour resumes.
   */
  useEffect(() => {
    if (!state?.waiting || !steps.length) return undefined;
    const look = () => {
      const resumed = resumeAt(state, steps, isPresent);
      if (resumed) persist(resumed);
    };
    const timer = setInterval(look, WAIT_POLL_MS);
    const settle = setTimeout(look, SETTLE_MS);
    return () => { clearInterval(timer); clearTimeout(settle); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state?.waiting, pathname, steps.length]);

  const step = currentStep(state, steps);
  const virtual = isVirtualStep(step);
  if (!step?.check) nextLockedRef.current = false;

  useEffect(() => { setPick(null); }, [step?.anchor]);

  // ── navigate, then find the element ───────────────────────────────────────
  useEffect(() => {
    if (!step) return undefined;
    // A drawn or asked step lives in the card itself: nothing to navigate to,
    // nothing to find, nothing to judge missing.
    if (isVirtualStep(step)) { setRect(null); return undefined; }
    if (step.route && pathname !== step.route) {
      router.push(step.route);
      return undefined;
    }
    let tries = 0;
    let raf = 0;
    const look = () => {
      const el = anchorEl(step.anchor);
      if (el) {
        el.scrollIntoView({ block: 'center', behavior: 'smooth' });
        setRect(el.getBoundingClientRect());
        return;
      }
      if ((tries += 16) < SETTLE_MS) { raf = requestAnimationFrame(look); return; }
      setRect(null);
      // THE ROUTE EXCUSE IS SPENT (2026-08-28). scanFrom trusts any step that
      // carries a route, because its element lives on a page we have not
      // loaded yet. We are now ON that page and the element is still missing,
      // so that trust cannot be re-applied: re-scanning from index - 1 landed
      // on this same step again, and the tour sat there showing a card with no
      // spotlight and no way forward but Next. Judge it on presence alone.
      const judged = step.optional
        ? advance(state, steps, isPresent, state.index)
        : { ...state, endedAs: TOUR_END.BROKEN };
      persist(parkIfRecordScoped(judged, steps));
    };
    raf = requestAnimationFrame(look);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step?.anchor, step?.route, pathname]);

  // ── keep the spotlight on the element ─────────────────────────────────────
  useLayoutEffect(() => {
    if (!step || isVirtualStep(step)) return undefined;
    const track = () => {
      const el = anchorEl(step.anchor);
      if (el) setRect(el.getBoundingClientRect());
    };
    window.addEventListener('scroll', track, true);
    window.addEventListener('resize', track);
    return () => {
      window.removeEventListener('scroll', track, true);
      window.removeEventListener('resize', track);
    };
  }, [step?.anchor]);

  const close = useCallback(() => {
    persist(dismiss(state));
    setRect(null);
    try { lastFocused.current?.focus?.(); } catch { /* element went away */ }
  }, [state, persist]);

  const goNext = useCallback(() => {
    const after = advance(state, steps, isPresent);
    // A module-track tour that ran off the end has been WALKED. Announce it
    // once so Ride University can complete it — modules with real work behind
    // them ignore this and wait for the record (the server decides which).
    if (state?.moduleKey && after?.endedAs === TOUR_END.COMPLETED && !walkedModules.current.has(state.moduleKey)) {
      walkedModules.current.add(state.moduleKey);
      window.dispatchEvent(new CustomEvent(TOUR_MODULE_DONE_EVENT, { detail: { moduleKey: state.moduleKey } }));
    }
    persist(parkIfRecordScoped(after, steps));
  }, [state, steps, isPresent, persist, parkIfRecordScoped]);

  // Any manual move stops the showcase advancing on its own — a person is
  // driving now.
  const next = useCallback(() => { setAutoPlay(false); goNext(); }, [goNext]);
  const back = useCallback(() => { setAutoPlay(false); persist(parkIfRecordScoped(retreat(state, steps, isPresent), steps)); }, [state, steps, isPresent, persist, parkIfRecordScoped]);

  /**
   * Leave a parked stretch without abandoning the tour.
   *
   * A trainee walking the onboarding track at their desk has no live rental,
   * so check-out, check-in and payments cannot be demonstrated — and before
   * this the tour simply stopped there, which is the whole complaint. Skipping
   * the record-scoped run resumes at the first step after it, so the remaining
   * modules are still reachable. It does NOT count those modules as done: they
   * are OPPORTUNISTIC and only the backend's record check completes them.
   */
  const skipParked = useCallback(() => {
    if (!state?.waiting) return;
    const end = [state.skipThrough, state.resumeThrough, state.index]
      .find((n) => Number.isInteger(n));
    persist(parkIfRecordScoped(advance(stopWaiting(state), steps, isPresent, end), steps));
  }, [state, steps, isPresent, persist, parkIfRecordScoped]);

  // ── showcase autoplay ─────────────────────────────────────────────────────
  useEffect(() => {
    if (!autoPlay || !step) return undefined;
    if (typeof window !== 'undefined'
      && window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches) return undefined;
    const timer = setTimeout(goNext, SHOWCASE_STEP_MS);
    return () => clearTimeout(timer);
  }, [autoPlay, step?.anchor, goNext]);

  // A PARKED stretch would strand the showcase forever: parking waits for a
  // person to open a record, and in attract mode there is no person. Found
  // live 2026-08-29 — the parking fix (d459928d) taught record-scoped modules
  // to wait instead of dying, which onboarding needed, but the showcase then
  // sat on the "open any reservation" bar until the end of time (currentStep
  // returns null while waiting, so the step-autoplay above never arms). While
  // autoplay is driving, a parked run is skipped the way a person would press
  // "Skip this part" — after a beat, so the bar reads as a transition rather
  // than a flicker. Any manual move has already set autoPlay=false, so a real
  // person's parked tour still waits for their record.
  useEffect(() => {
    if (!autoPlay || !state?.waiting) return undefined;
    if (typeof window !== 'undefined'
      && window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches) return undefined;
    const timer = setTimeout(skipParked, SHOWCASE_PARKED_SKIP_MS);
    return () => clearTimeout(timer);
  }, [autoPlay, state?.waiting, skipParked]);

  // ── keyboard: Escape closes, arrows drive the showcase ────────────────────
  useEffect(() => {
    if (!step) return undefined;
    const onKey = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); close(); return; }
      if (e.key === 'ArrowRight') { e.preventDefault(); if (nextLockedRef.current) return; next(); return; }
      if (e.key === 'ArrowLeft') { e.preventDefault(); back(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [step, close, next, back]);

  // ── focus the card so a screen reader lands on the step ───────────────────
  useEffect(() => {
    if (step && cardRef.current) cardRef.current.focus();
  }, [step?.anchor]);

  if (typeof document === 'undefined') return null;

  /**
   * A tour that cannot start must SAY SO (Hector, 2026-08-17: "show me again
   * no está reiniciando"). Three modules — check-out, check-in, take-payment —
   * walk you through a single reservation's own page, so their anchors do not
   * exist until one is open. Launched from Ride University they ended as
   * BROKEN, and BROKEN rendered nothing at all: the button looked dead.
   * Now the same dead end explains itself and offers the way forward.
   */
  /**
   * PARKED: the walkthrough lives inside a record and the person is on their
   * way to open one. A persistent bar keeps the guide alive and tells them
   * exactly what to do next — the previous version dropped them at
   * /reservations with no thread back (Hector, 2026-08-17).
   */
  if (state?.waiting) {
    // From the step, not the tour — the onboarding track has no moduleKey.
    const waitModule = moduleForStep(steps[state.index])
      || (state.moduleKey ? findModule(state.moduleKey) : null);
    const waitName = waitModule
      ? trainingText(t, mKeyOf(waitModule, 'title'), waitModule.title)
      : '';
    return createPortal(
      <div
        role="status"
        style={{
          position: 'fixed', left: 0, right: 0, bottom: 0, zIndex: 100000,
          display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 14,
          flexWrap: 'wrap', padding: '12px 16px calc(12px + env(safe-area-inset-bottom, 0px))',
          background: '#1e1a2b', color: '#fff', boxShadow: '0 -2px 14px rgba(0,0,0,.3)',
        }}
      >
        <span aria-hidden="true">🎓</span>
        <span style={{ fontSize: 13.5, fontWeight: 600 }}>
          {state.midTour
            ? t('training.waitingNextScreen', 'Keep going — open the next screen and the guide picks up there.')
            : waitModule?.needsRecordLabel
              ? t('training.waitingForScreen', 'Open {{where}} to start “{{name}}” — the guide continues there.', { where: waitModule.needsRecordLabel, name: waitName })
              : t('training.waitingForRecord', 'Open any reservation to start “{{name}}” — the guide continues there.', { name: waitName })}
        </span>
        {!state.midTour && waitModule?.needsRecord && pathname !== waitModule.needsRecord && (
          <button
            type="button"
            onClick={() => router.push(waitModule.needsRecord)}
            style={{ background: '#fff', color: '#1e1a2b', border: 'none', borderRadius: 999, padding: '6px 14px', fontSize: 12.5, fontWeight: 700, cursor: 'pointer' }}
          >
            {waitModule?.needsRecordLabel ? t('training.goThere', 'Take me there') : t('training.needsRecordCta', 'Go to reservations')}
          </button>
        )}
        {Number.isInteger(state.skipThrough ?? state.resumeThrough)
          && (state.skipThrough ?? state.resumeThrough) < steps.length - 1 && (
          <button
            type="button"
            onClick={skipParked}
            style={{ background: 'transparent', color: '#fff', border: '1px solid #6d5f8a', borderRadius: 999, padding: '6px 12px', fontSize: 12.5, cursor: 'pointer' }}
          >
            {t('training.skipThisPart', 'Skip this part')}
          </button>
        )}
        <button
          type="button"
          onClick={close}
          style={{ background: 'transparent', color: '#cfc7dd', border: '1px solid #4a4458', borderRadius: 999, padding: '6px 12px', fontSize: 12.5, cursor: 'pointer' }}
        >
          {t('training.cancel', 'Cancel')}
        </button>
      </div>,
      document.body,
    );
  }

  if (state?.endedAs === TOUR_END.BROKEN) {
    const brokenModule = moduleForStep(steps[state.index])
      || (state.moduleKey ? findModule(state.moduleKey) : null);
    const where = brokenModule?.needsRecord;
    const modName = brokenModule
      ? trainingText(t, mKeyOf(brokenModule, 'title'), brokenModule.title)
      : '';
    return createPortal(
      <div role="dialog" aria-modal="true" style={{ position: 'fixed', inset: 0, zIndex: 100000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}>
        <Scrim style={{ inset: 0 }} onClick={close} />
        <div
          ref={cardRef}
          tabIndex={-1}
          style={{
            position: 'relative', width: 'min(380px, 100%)', background: '#fff', color: '#1e1a2b',
            borderRadius: 14, padding: '18px 20px', boxShadow: '0 10px 40px rgba(30,26,43,.3)', pointerEvents: 'auto',
          }}
        >
          <h3 style={{ margin: '0 0 6px', fontSize: 15, fontWeight: 700 }}>
            {where
              ? t('training.needsRecordTitle', 'Open a reservation first')
              : t('training.tourUnavailableTitle', 'This walkthrough is not available here')}
          </h3>
          <p style={{ margin: 0, fontSize: 13, lineHeight: 1.5, color: 'var(--text-2, #5b5266)' }}>
            {where
              ? (brokenModule?.needsRecordLabel
                ? t('training.needsScreenBody', '“{{name}}” is walked on another screen — open {{where}}, then press Start again.', { name: modName, where: brokenModule.needsRecordLabel })
                : t('training.needsRecordBody', '“{{name}}” is walked inside a reservation — that is why nothing happened. Open any reservation (or use Practice on the demo tenant), then press Start again.', { name: modName }))
              : t('training.tourUnavailableBody', 'A step in this guide points at something that is not on screen. Tell an admin so we can fix the guide.')}
          </p>
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 14 }}>
            <button type="button" className="button-subtle" onClick={close}>
              {t('training.close', 'Close')}
            </button>
            {where && (
              <button type="button" onClick={() => { close(); router.push(where); }}>
                {brokenModule?.needsRecordLabel ? t('training.goThere', 'Take me there') : t('training.needsRecordCta', 'Go to reservations')}
              </button>
            )}
          </div>
        </div>
      </div>,
      document.body,
    );
  }

  if (!step) return null;

  const { position, total, fraction } = progressOf(state, steps);
  const isShowcase = state.track === TOUR_TRACKS.SHOWCASE;
  const title = trainingText(t, stepKey(step.moduleKey, step, 'title'), step.title);
  const body = trainingText(t, stepKey(step.moduleKey, step, 'body'), step.body);
  // The gotcha surfaces on a module's LAST step — the mistake people actually
  // make, shown at the moment the walkthrough wraps that task. Boundary =
  // the next step belongs to a different module, or there is no next step.
  const nextStep = steps[state.index + 1];
  const atModuleEnd = !nextStep || nextStep.moduleKey !== step.moduleKey;
  const gotchaModule = atModuleEnd ? findModule(step.moduleKey) : null;
  const gotcha = gotchaModule?.gotcha
    ? trainingText(t, mKeyOf(gotchaModule, 'gotcha'), gotchaModule.gotcha)
    : null;

  // Card goes below the element, or above when there is no room beneath.
  const vh = window.innerHeight;
  const vw = window.innerWidth;
  const cardWidth = virtual ? Math.min(WIDE_CARD_WIDTH, vw - 2 * GAP) : CARD_WIDTH;
  const below = rect ? rect.bottom + GAP : vh / 3;
  const roomBelow = rect ? vh - rect.bottom > 220 : true;
  const top = rect
    ? (roomBelow ? below : Math.max(GAP, rect.top - 200 - GAP))
    : (virtual ? Math.max(GAP, Math.round(vh * 0.06)) : vh / 3);
  const left = rect
    ? Math.min(Math.max(GAP, rect.left), Math.max(GAP, vw - cardWidth - GAP))
    : Math.max(GAP, (vw - cardWidth) / 2);

  // Drawn step: the figure component from the registry, plus its callouts.
  const Figure = step.figure ? figureFor(step.figure) : null;
  const callouts = Array.isArray(step.callouts)
    ? step.callouts.map((text, i) => trainingText(t, stepKey(step.moduleKey, step, `callouts.${i}`), text))
    : [];
  // Asked step: Next is locked until the right answer is picked; a wrong pick
  // explains itself and costs nothing.
  const check = step.check || null;
  const picked = check ? (check.options || []).find((o) => o.key === pick) || null : null;
  const answered = !!picked?.correct;
  const nextLocked = !!check && !answered;
  nextLockedRef.current = nextLocked;

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label={title}
      style={{ position: 'fixed', inset: 0, zIndex: 100000, pointerEvents: 'none' }}
    >
      {/* Scrim with a hole cut over the anchor. Four rectangles rather than a
          box-shadow so the highlighted element stays fully interactive. */}
      {rect ? (
        <>
          <Scrim style={{ top: 0, left: 0, right: 0, height: Math.max(0, rect.top - 4) }} onClick={close} />
          <Scrim style={{ top: Math.max(0, rect.bottom + 4), left: 0, right: 0, bottom: 0 }} onClick={close} />
          <Scrim style={{ top: Math.max(0, rect.top - 4), left: 0, width: Math.max(0, rect.left - 4), height: rect.height + 8 }} onClick={close} />
          <Scrim style={{ top: Math.max(0, rect.top - 4), left: rect.right + 4, right: 0, height: rect.height + 8 }} onClick={close} />
          <div
            aria-hidden="true"
            style={{
              position: 'fixed',
              top: rect.top - 4, left: rect.left - 4,
              width: rect.width + 8, height: rect.height + 8,
              border: '2px solid #8752FE', borderRadius: 10,
              boxShadow: '0 0 0 3px rgba(135,82,254,0.28)',
              pointerEvents: 'none',
            }}
          />
        </>
      ) : (
        <Scrim style={{ inset: 0 }} onClick={close} />
      )}

      <div
        ref={cardRef}
        tabIndex={-1}
        style={{
          position: 'fixed', top, left, width: cardWidth, maxWidth: 'calc(100vw - 24px)',
          maxHeight: 'calc(100vh - 24px)', overflowY: 'auto',
          background: 'var(--surface-1, #fff)', color: 'var(--text-1, #1e1a2b)',
          border: '1px solid var(--border-2, #d9d2ea)', borderRadius: 12,
          padding: '14px 16px', boxShadow: '0 12px 32px rgba(30,20,60,0.22)',
          pointerEvents: 'auto', outline: 'none',
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, marginBottom: 6 }}>
          <span style={{ fontSize: 11, letterSpacing: '0.08em', textTransform: 'uppercase', color: '#6d3de0', fontWeight: 700 }}>
            {isShowcase ? `${position} / ${total}` : t('training.stepOf', `Step ${position} of ${total}`, { position, total })}
          </span>
          <button
            type="button"
            onClick={close}
            aria-label={t('common.close', 'Close')}
            style={{ border: 'none', background: 'transparent', cursor: 'pointer', fontSize: 16, color: 'var(--text-3, #736a8b)', lineHeight: 1 }}
          >×</button>
        </div>

        <h3 style={{ margin: '0 0 4px', fontSize: 15, fontWeight: 700 }}>{title}</h3>
        <p style={{ margin: 0, fontSize: 13, lineHeight: 1.5, color: 'var(--text-2, #4a4258)' }}>{body}</p>

        {Figure && (
          <div data-testid="tour-figure" style={{ margin: '10px 0 0', border: '1px solid var(--border-2, #e6e0f2)', borderRadius: 10, overflow: 'hidden', maxHeight: '38vh' }}>
            <Figure />
          </div>
        )}
        {callouts.length > 0 && (
          <ol data-testid="tour-callouts" style={{ margin: '10px 0 0', padding: 0, listStyle: 'none', display: 'grid', gap: 6 }}>
            {callouts.map((text, i) => (
              <li key={i} style={{ display: 'flex', gap: 9, alignItems: 'flex-start', fontSize: 12.5, lineHeight: 1.45, color: 'var(--text-2, #4a4258)' }}>
                <span aria-hidden="true" style={{ flex: '0 0 20px', height: 20, borderRadius: '50%', background: '#8752FE', color: '#fff', fontSize: 11, fontWeight: 700, display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}>{i + 1}</span>
                <span>{text}</span>
              </li>
            ))}
          </ol>
        )}

        {check && (
          <div data-testid="tour-check" role="group" aria-label={trainingText(t, stepKey(step.moduleKey, step, 'check.question'), check.question)} style={{ marginTop: 10 }}>
            <p style={{ margin: '0 0 8px', fontSize: 13.5, fontWeight: 600, lineHeight: 1.45 }}>
              {trainingText(t, stepKey(step.moduleKey, step, 'check.question'), check.question)}
            </p>
            <div style={{ display: 'grid', gap: 6 }}>
              {(check.options || []).map((o) => {
                const isPick = pick === o.key;
                const tone = !isPick ? null : o.correct ? 'ok' : 'bad';
                return (
                  <button
                    key={o.key}
                    type="button"
                    onClick={() => setPick(o.key)}
                    aria-pressed={isPick}
                    data-testid={`tour-check-option-${o.key}`}
                    style={{
                      display: 'flex', gap: 10, alignItems: 'flex-start', textAlign: 'left', cursor: 'pointer',
                      padding: '8px 11px', borderRadius: 9, fontSize: 13, lineHeight: 1.4,
                      border: `1px solid ${tone === 'ok' ? '#1f8a5f' : tone === 'bad' ? '#b3261e' : 'var(--border-2, #d9d2ea)'}`,
                      background: tone === 'ok' ? 'rgba(31,138,95,0.08)' : tone === 'bad' ? 'rgba(179,38,30,0.06)' : 'var(--surface-1, #fff)',
                      color: 'var(--text-1, #1e1a2b)',
                    }}
                  >
                    <span style={{ fontFamily: 'ui-monospace, monospace', fontSize: 11.5, fontWeight: 700, color: 'var(--text-3, #736a8b)', marginTop: 2 }}>{o.key}</span>
                    <span>{trainingText(t, stepKey(step.moduleKey, step, `check.options.${o.key}.text`), o.text)}</span>
                  </button>
                );
              })}
            </div>
            {picked && (
              <p
                role="status"
                data-testid="tour-check-why"
                style={{ margin: '10px 0 0', borderRadius: 8, padding: '8px 10px', fontSize: 12.5, lineHeight: 1.5,
                  background: picked.correct ? 'rgba(31,138,95,0.08)' : '#f8efe0', color: 'var(--text-2, #4a4258)' }}
              >
                <span style={{ display: 'block', fontSize: 10, letterSpacing: '0.1em', textTransform: 'uppercase', fontWeight: 700, marginBottom: 2, color: picked.correct ? '#1f8a5f' : '#9a5b12' }}>
                  {picked.correct ? t('training.checkRight', 'Right') : t('training.checkNotQuite', 'Not quite')}
                </span>
                {trainingText(t, stepKey(step.moduleKey, step, `check.options.${picked.key}.why`), picked.why)}
              </p>
            )}
          </div>
        )}
        {gotcha && (
          <p style={{ margin: '10px 0 0', background: '#f8efe0', borderRadius: 8, padding: '8px 10px', fontSize: 12, lineHeight: 1.5, color: 'var(--text-2, #4a4258)' }}>
            <span style={{ display: 'block', fontSize: 10, letterSpacing: '0.1em', textTransform: 'uppercase', color: '#9a5b12', fontWeight: 700, marginBottom: 2 }}>
              {t('training.gotchaLabel', 'Where people trip')}
            </span>
            {gotcha}
          </p>
        )}

        <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 12 }}>
          <button type="button" onClick={back} disabled={position <= 1} style={btn(false)}>
            {t('common.back', 'Back')}
          </button>
          <button type="button" onClick={next} disabled={nextLocked} style={{ ...btn(true), opacity: nextLocked ? 0.5 : 1, cursor: nextLocked ? 'not-allowed' : 'pointer' }}>
            {position >= total ? t('common.done', 'Done') : t('common.next', 'Next')}
          </button>
          <span style={{ flex: 1 }} />
          {isShowcase ? (
            <button
              type="button"
              onClick={() => setAutoPlay((on) => !on)}
              aria-pressed={autoPlay}
              title={autoPlay
                ? t('training.pauseHint', 'Stop advancing on its own')
                : t('training.playHint', 'Advance on its own again')}
              style={btn(false)}
            >
              {autoPlay ? t('training.pause', 'Pause') : t('training.play', 'Play')}
            </button>
          ) : (
            <button type="button" onClick={close} style={{ ...btn(false), border: 'none', color: 'var(--text-3, #736a8b)' }}>
              {t('training.skip', 'Skip')}
            </button>
          )}
        </div>

        <div style={{ marginTop: 10, height: 3, background: 'var(--surface-2, #f0edf9)', borderRadius: 2, overflow: 'hidden' }}>
          <i style={{ display: 'block', height: '100%', width: `${Math.round(fraction * 100)}%`, background: '#8752FE', borderRadius: 2 }} />
        </div>
      </div>
    </div>,
    document.body
  );
}

function Scrim({ style, onClick }) {
  return (
    <div
      onClick={onClick}
      style={{ position: 'fixed', background: 'rgba(20,14,40,0.45)', pointerEvents: 'auto', ...style }}
    />
  );
}

function btn(primary) {
  return {
    padding: '5px 12px', borderRadius: 8, fontSize: 12.5, fontWeight: 600, cursor: 'pointer',
    border: primary ? 'none' : '1px solid var(--border-2, #d9d2ea)',
    background: primary ? '#8752FE' : 'var(--surface-2, #f7f5fd)',
    color: primary ? '#fff' : 'var(--text-2, #4a4258)',
  };
}
