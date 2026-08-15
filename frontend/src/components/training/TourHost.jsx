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
import { TOUR_TRACKS, stepsForTrack, stepsForModule, findModule } from '../../lib/training/curriculum.js';
import { stepKey, moduleKey as mKeyOf, trainingText } from '../../lib/training/i18n-keys.js';
import {
  TOUR_STORAGE_KEY, TOUR_END,
  startTour, settleStart, currentStep, advance, retreat, dismiss,
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
const CARD_WIDTH = 340;
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

  const isPresent = useCallback((name) => !!anchorEl(name), []);

  const persist = useCallback((next) => {
    setState(next);
    try {
      if (!next || next.endedAs) window.localStorage.setItem(TOUR_STORAGE_KEY, serialize(next) || '');
      else window.localStorage.setItem(TOUR_STORAGE_KEY, serialize(next));
    } catch { /* private browsing — the tour still works, it just won't resume */ }
  }, []);

  // ── launch ────────────────────────────────────────────────────────────────
  useEffect(() => {
    const onStart = (event) => {
      const { track = TOUR_TRACKS.ONBOARDING, moduleKey = null } = event?.detail || {};
      const list = moduleKey ? stepsForModule(moduleKey) : stepsForTrack(track, viewer || {});
      const fresh = startTour({ track, steps: list, moduleKey });
      if (!fresh) return;
      setSteps(list);
      lastFocused.current = document.activeElement;
      walkedModules.current = new Set();
      // The showcase runs itself until a person takes over.
      setAutoPlay(track === TOUR_TRACKS.SHOWCASE);
      persist(settleStart(fresh, list, isPresent));
    };
    window.addEventListener(TOUR_START_EVENT, onStart);
    return () => window.removeEventListener(TOUR_START_EVENT, onStart);
  }, [viewer, isPresent, persist]);

  // ── resume across navigation ──────────────────────────────────────────────
  useEffect(() => {
    if (state || typeof window === 'undefined') return;
    let saved = null;
    try { saved = deserialize(window.localStorage.getItem(TOUR_STORAGE_KEY)); } catch { saved = null; }
    if (!saved || saved.endedAs) return;
    const list = saved.moduleKey ? stepsForModule(saved.moduleKey) : stepsForTrack(saved.track, viewer || {});
    if (!list.length) return;
    setSteps(list);
    setState(saved);
  }, [state, viewer]);

  const step = currentStep(state, steps);

  // ── navigate, then find the element ───────────────────────────────────────
  useEffect(() => {
    if (!step) return undefined;
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
      // Still absent after the route settled — let the state machine decide
      // whether that is expected (optional) or a broken step.
      setRect(null);
      persist(advance(state, steps, isPresent, state.index - 1));
    };
    raf = requestAnimationFrame(look);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step?.anchor, step?.route, pathname]);

  // ── keep the spotlight on the element ─────────────────────────────────────
  useLayoutEffect(() => {
    if (!step) return undefined;
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
    persist(after);
  }, [state, steps, isPresent, persist]);

  // Any manual move stops the showcase advancing on its own — a person is
  // driving now.
  const next = useCallback(() => { setAutoPlay(false); goNext(); }, [goNext]);
  const back = useCallback(() => { setAutoPlay(false); persist(retreat(state, steps, isPresent)); }, [state, steps, isPresent, persist]);

  // ── showcase autoplay ─────────────────────────────────────────────────────
  useEffect(() => {
    if (!autoPlay || !step) return undefined;
    if (typeof window !== 'undefined'
      && window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches) return undefined;
    const timer = setTimeout(goNext, SHOWCASE_STEP_MS);
    return () => clearTimeout(timer);
  }, [autoPlay, step?.anchor, goNext]);

  // ── keyboard: Escape closes, arrows drive the showcase ────────────────────
  useEffect(() => {
    if (!step) return undefined;
    const onKey = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); close(); return; }
      if (e.key === 'ArrowRight') { e.preventDefault(); next(); return; }
      if (e.key === 'ArrowLeft') { e.preventDefault(); back(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [step, close, next, back]);

  // ── focus the card so a screen reader lands on the step ───────────────────
  useEffect(() => {
    if (step && cardRef.current) cardRef.current.focus();
  }, [step?.anchor]);

  if (!step || typeof document === 'undefined') return null;

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
  const below = rect ? rect.bottom + GAP : vh / 3;
  const roomBelow = rect ? vh - rect.bottom > 220 : true;
  const top = rect ? (roomBelow ? below : Math.max(GAP, rect.top - 200 - GAP)) : vh / 3;
  const left = rect
    ? Math.min(Math.max(GAP, rect.left), Math.max(GAP, vw - CARD_WIDTH - GAP))
    : Math.max(GAP, (vw - CARD_WIDTH) / 2);

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
          position: 'fixed', top, left, width: CARD_WIDTH, maxWidth: 'calc(100vw - 24px)',
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
          <button type="button" onClick={next} style={btn(true)}>
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
