'use client';

/**
 * Agent Copilot — Phase 1 (design/copilot-mockups, approved 2026-09-01).
 *
 * A launcher pill, a chat panel, and a chip. The copilot ANSWERS from the
 * static intent map (lib/training/intents.js — sourced summaries, article
 * links) and TEACHES by handing off to the production tour engine: its only
 * two effects on the app are router.push() and dispatching the
 * `ride-university:start` event TourHost already listens for. It never fills
 * a form, never presses a button, never calls a write API.
 *
 * PRE-FLIGHT (Hector, 2026-09-01): "Te enseño" never dispatches blind. Before
 * the event fires, preflightFor() compares where the person IS against what
 * the module needs, and the copilot says what happens next — or ASKS which
 * reservation the problem lives on — before anything moves. The four outcomes
 * and their exact mechanics are documented in design/mockups/copilot-NOTES.md
 * §5; this file implements them and nothing more:
 *
 *   HERE          say "starting right here", short beat, dispatch.
 *   NAVIGATE      say "I'll take you to X first", beat, dispatch — TourHost's
 *                 own step.route push does the moving; we only add the words.
 *   ASK_HERE      a QUESTION with two one-tap replies. "Sí, aquí" dispatches
 *                 on the open record. "Es en otra reserva" collapses the
 *                 panel, navigates to the reservation LIST, and only then
 *                 dispatches — from the list the record anchors are absent,
 *                 so the launch settle PARKS instead of arming on the wrong
 *                 record, and the engine's existing watcher follows the agent
 *                 into whichever reservation they open. Dispatching before
 *                 the route change would arm the tour on the record that is
 *                 open right now — exactly wrong when the problem lives on
 *                 another one.
 *   NEEDS_RECORD  ask which reservation the problem is on, then dispatch;
 *                 the engine's parking bar owns the wait from there.
 *
 * Z-ORDER: the panel sits at 99990 — above the app (inline z-index reaches
 * 9999) and BELOW TourHost's 100000, so a running tour always owns the
 * screen and the copilot yields to a chip. The screen-lock overlay is only
 * z-index 120, so the copilot renders null outright while locked (it hears
 * about lock changes via SCREEN_LOCK_EVENT from AppShell).
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useRouter, usePathname } from 'next/navigation';
import { useTranslation } from 'react-i18next';
import { SCREEN_LOCK_EVENT, SCREEN_LOCK_FLAG_KEY } from '../../lib/client';
import { TOUR_START_EVENT, TOUR_MODULE_DONE_EVENT } from '../training/TourHost';
import { TOUR_STORAGE_KEY, deserialize } from '../../lib/training/tour-state.js';
import { TOUR_TRACKS } from '../../lib/training/curriculum.js';
import { moduleKey as trainingModuleKey, stepKey as trainingStepKey } from '../../lib/training/i18n-keys.js';
import {
  matchIntent, findIntent, ctasFor, findModule,
  preflightFor, PREFLIGHT, screenNameFor,
  logMiss, flagLastMiss,
} from '../../lib/training/intents.js';
import {
  flushMisses, flagMissServer, aiEnabled, askAi,
  fetchArticle, articleHalf, articleBlocks,
} from '../../lib/training/copilot-live.js';

const Z = 99990;
/** How long an announced pre-flight line stays readable before the dispatch. */
const HERE_BEAT_MS = 400;
const NAVIGATE_BEAT_MS = 1200;
const NEEDS_RECORD_BEAT_MS = 1600;
/** While a tour runs, this is how often we notice it ended without telling us
 *  (dismissed via Esc, or broken) so the chip can turn back into the pill.
 *  It runs ONLY while touring — zero timers when the copilot is idle. */
const TOUR_WATCH_MS = 1000;

const TEAL = '#2dd4bf';
const TEAL_DARK = '#064e46';
const TEAL_TEXT = '#086a5e';
const INK = '#17122b';

function readLocked() {
  try { return window.localStorage.getItem(SCREEN_LOCK_FLAG_KEY) === '1'; } catch { return false; }
}

function tourIsRunning() {
  try {
    const saved = deserialize(window.localStorage.getItem(TOUR_STORAGE_KEY));
    return !!saved && !saved.endedAs;
  } catch { return false; }
}

function isTypingTarget(el) {
  if (!el) return false;
  const tag = String(el.tagName || '').toUpperCase();
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable === true;
}

let nextMsgId = 1;

export function Copilot({ viewer }) {
  const router = useRouter();
  const pathname = usePathname();
  const { i18n } = useTranslation();

  const [open, setOpen] = useState(false);
  const [mounted, setMounted] = useState(false);
  const [locked, setLocked] = useState(false);
  const [touring, setTouring] = useState(false);
  const [lang, setLang] = useState('en');
  const [msgs, setMsgs] = useState([]);
  const [draft, setDraft] = useState('');

  const inputRef = useRef(null);
  const bodyRef = useRef(null);
  const beatTimer = useRef(null);
  const launchedModule = useRef(null);
  // The "Es en otra reserva" hand-off: dispatch ONLY once the route has
  // actually changed to the reservation list, never from the record that is
  // still on screen (see the file comment).
  const pendingLaunch = useRef(null);

  // Fixed-language translator: the panel's ES/EN toggle re-renders the same
  // sourced content in the other language without touching the app language.
  const ft = useCallback((key, fallback, params) => {
    try {
      const fixed = i18n?.getFixedT ? i18n.getFixedT(lang) : null;
      if (fixed) return fixed(key, { defaultValue: fallback, ...(params || {}) });
    } catch { /* fall through to the fallback below */ }
    let out = fallback || '';
    for (const [k, v] of Object.entries(params || {})) out = out.replaceAll(`{{${k}}}`, String(v));
    return out;
  }, [i18n, lang]);

  // ── boot: language, lock flag, any tour already running ───────────────────
  // Once, on mount — re-running on renders would clobber live touring/locked
  // state with the localStorage snapshot.
  useEffect(() => {
    setMounted(true);
    setLang(String(i18n?.language || 'en').toLowerCase().startsWith('es') ? 'es' : 'en');
    setLocked(readLocked());
    setTouring(tourIsRunning());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── the screen lock says so itself (AppShell dispatches on every change) ──
  useEffect(() => {
    const onLock = (e) => setLocked(!!e?.detail?.locked);
    window.addEventListener(SCREEN_LOCK_EVENT, onLock);
    return () => window.removeEventListener(SCREEN_LOCK_EVENT, onLock);
  }, []);

  // ── yield to ANY tour, including ones Ride University started ────────────
  useEffect(() => {
    const onStart = () => { setTouring(true); setOpen(false); };
    const onDone = (e) => {
      setTouring(false);
      if (launchedModule.current && e?.detail?.moduleKey === launchedModule.current) {
        launchedModule.current = null;
        pushMsg({ kind: 'done', moduleKey: e.detail.moduleKey });
        setOpen(true);
      }
    };
    window.addEventListener(TOUR_START_EVENT, onStart);
    window.addEventListener(TOUR_MODULE_DONE_EVENT, onDone);
    return () => {
      window.removeEventListener(TOUR_START_EVENT, onStart);
      window.removeEventListener(TOUR_MODULE_DONE_EVENT, onDone);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // A dismissed or broken tour never fires the done event — notice it ended so
  // the chip turns back into the pill. Runs only WHILE touring. The
  // pendingLaunch guard covers the "Es en otra reserva" hand-off, where the
  // chip is up but the dispatch is still waiting on the route change.
  useEffect(() => {
    if (!touring) return undefined;
    const timer = setInterval(() => {
      if (!pendingLaunch.current && !tourIsRunning()) setTouring(false);
    }, TOUR_WATCH_MS);
    return () => clearInterval(timer);
  }, [touring]);

  // ── "?" opens, Escape closes ──────────────────────────────────────────────
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === '?' && !e.ctrlKey && !e.metaKey && !e.altKey && !isTypingTarget(e.target)) {
        if (!readLocked()) { e.preventDefault(); setOpen(true); }
        return;
      }
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  useEffect(() => {
    if (open) inputRef.current?.focus();
    // Opportunistic Phase 2 telemetry: opening the panel flushes whatever the
    // ring buffer holds. Fire-and-forget by contract — flushMisses never
    // rejects and never blocks the panel.
    if (open) flushMisses();
  }, [open]);

  // New message → keep the newest visible.
  useEffect(() => {
    if (bodyRef.current) bodyRef.current.scrollTop = bodyRef.current.scrollHeight;
  }, [msgs, open]);

  useEffect(() => () => { if (beatTimer.current) clearTimeout(beatTimer.current); }, []);

  const pushMsg = useCallback((msg) => {
    setMsgs((list) => [...list, { id: nextMsgId++, ...msg }]);
  }, []);

  // ── the dispatch — the copilot's entire "guide me" feature ────────────────
  const launch = useCallback((moduleKey) => {
    launchedModule.current = moduleKey;
    setTouring(true);
    setOpen(false);
    window.dispatchEvent(new CustomEvent(TOUR_START_EVENT, {
      detail: { track: TOUR_TRACKS.MODULE, moduleKey },
    }));
  }, []);

  const launchAfterBeat = useCallback((moduleKey, ms) => {
    if (beatTimer.current) clearTimeout(beatTimer.current);
    beatTimer.current = setTimeout(() => launch(moduleKey), ms);
  }, [launch]);

  // "Es en otra reserva": the route change happens first, the dispatch second.
  useEffect(() => {
    const pending = pendingLaunch.current;
    if (!pending) return;
    if (pathname === pending.route) {
      pendingLaunch.current = null;
      launch(pending.moduleKey);
    }
  }, [pathname, launch]);

  // ── ask → answer ──────────────────────────────────────────────────────────
  const send = useCallback((raw) => {
    const q = String(raw || '').trim();
    if (!q) return;
    pendingLaunch.current = null;
    pushMsg({ kind: 'user', text: q });
    const hit = matchIntent(q);
    if (hit) {
      pushMsg({ kind: 'answer', intentKey: hit.intent.key });
    } else {
      logMiss(q, { lang, pathname });
      pushMsg({ kind: 'miss', q });
      // Phase 2, both fire-and-forget: flush the buffer, and — ONLY when the
      // tenant's copilotAiConfig is on (one cached probe per session; the
      // default is OFF for every tenant) — try the retrieval-bound AI
      // fallback. Every refusal is silence: the miss card above IS the
      // Phase 1 behavior, and an AI answer only ever ADDS a bubble.
      flushMisses();
      const askedLang = lang;
      aiEnabled().then((on) => {
        if (!on) return null;
        return askAi({ query: q, lang: askedLang }).then((out) => {
          if (out && typeof out.answer === 'string' && out.answer.trim()) {
            pushMsg({ kind: 'ai', q, answer: out.answer, sources: out.sources || [], model: out.model || null });
          }
          return null;
        });
      }).catch(() => { /* never surfaces — the miss card already answered honestly */ });
    }
  }, [lang, pathname, pushMsg]);

  const submit = useCallback(() => {
    const q = draft;
    setDraft('');
    send(q);
  }, [draft, send]);

  // ── "Te enseño" — pre-flight first, always ────────────────────────────────
  const onTeach = useCallback((intent) => {
    const mod = findModule(intent.tourModuleKey);
    if (!mod) return;
    const pf = preflightFor(mod, pathname);
    if (pf.kind === PREFLIGHT.HERE) {
      pushMsg({ kind: 'preflight', note: 'here', moduleKey: mod.key });
      launchAfterBeat(mod.key, HERE_BEAT_MS);
      return;
    }
    if (pf.kind === PREFLIGHT.NAVIGATE) {
      pushMsg({ kind: 'preflight', note: 'navigate', moduleKey: mod.key, to: pf.to });
      launchAfterBeat(mod.key, NAVIGATE_BEAT_MS);
      return;
    }
    if (pf.kind === PREFLIGHT.ASK_HERE) {
      // A QUESTION, not an announcement: at the counter this is almost never
      // abstract — it is about ONE reservation, maybe not the open one.
      pushMsg({ kind: 'ask-here', moduleKey: mod.key, recordId: pf.recordId });
      return;
    }
    // NEEDS_RECORD — ask for THEIR case, then hand the wait to the engine's
    // parking bar, which follows them into whichever reservation they open.
    pushMsg({ kind: 'needs-record', moduleKey: mod.key, go: pf.go });
    launchAfterBeat(mod.key, NEEDS_RECORD_BEAT_MS);
  }, [pathname, pushMsg, launchAfterBeat]);

  const onYesHere = useCallback((moduleKey) => {
    launch(moduleKey);
  }, [launch]);

  const onOtherReservation = useCallback((moduleKey) => {
    const mod = findModule(moduleKey);
    const route = mod?.needsRecord || '/reservations';
    pushMsg({ kind: 'preflight', note: 'followThere', moduleKey });
    pendingLaunch.current = { moduleKey, route };
    setOpen(false);
    setTouring(true); // show the chip while the hand-off is in flight
    router.push(route);
  }, [pushMsg, router]);

  const onGo = useCallback((route) => {
    setOpen(false);
    router.push(route);
  }, [router]);

  const onArticle = useCallback((slug) => {
    setOpen(false);
    router.push(`/knowledge-base?article=${encodeURIComponent(slug)}`);
  }, [router]);

  const onSearchKb = useCallback((q) => {
    setOpen(false);
    router.push(`/knowledge-base?search=${encodeURIComponent(q)}`);
  }, [router]);

  const onTellAdmin = useCallback((msg) => {
    flagLastMiss();
    // Phase 2: the flag also reaches the server directly (its own endpoint,
    // not a re-flush — the entry may already have flushed unflagged). Emits
    // the COPILOT notification-center event for admins. Fire-and-forget.
    flagMissServer({ query: msg?.q, lang, pathname });
    setMsgs((list) => list.map((m) => (m.id === msg?.id ? { ...m, flagged: true } : m)));
  }, [lang, pathname]);

  if (!mounted || locked || typeof document === 'undefined') return null;

  // ── chip while a tour owns the screen ─────────────────────────────────────
  // Clicking it re-opens the conversation WITHOUT killing the tour — the
  // tour's state lives in localStorage and survives everything.
  if (touring && !open) {
    return createPortal(
      <button
        type="button"
        onClick={() => setOpen(true)}
        data-copilot="chip"
        style={{
          position: 'fixed', right: 18, bottom: 16, zIndex: Z,
          display: 'inline-flex', alignItems: 'center', gap: 8,
          background: '#e7faf6', color: TEAL_DARK, border: '1px solid #c9f2ea',
          borderRadius: 999, padding: '7px 14px 7px 10px', fontSize: 12, fontWeight: 640,
          boxShadow: '0 1px 4px rgba(24,16,54,.12)', cursor: 'pointer',
        }}
      >
        <i style={{ width: 7, height: 7, borderRadius: '50%', background: TEAL, boxShadow: '0 0 0 3px rgba(45,212,191,.25)' }} />
        {ft('copilot.touring', 'Copilot · guide running')}
      </button>,
      document.body,
    );
  }

  // ── closed: the pill ──────────────────────────────────────────────────────
  if (!open) {
    return createPortal(
      <button
        type="button"
        onClick={() => setOpen(true)}
        data-copilot="launcher"
        aria-label={ft('copilot.launcher', 'How do I…?')}
        style={{
          position: 'fixed', right: 18, bottom: 16, zIndex: Z,
          display: 'inline-flex', alignItems: 'center', gap: 9,
          background: INK, color: '#fff', border: '1px solid #4b4362',
          borderRadius: 999, padding: '9px 16px 9px 11px', fontSize: 13, fontWeight: 640,
          boxShadow: '0 8px 24px -6px rgba(23,18,43,.5)', cursor: 'pointer',
        }}
      >
        <Dot size={22} />
        {ft('copilot.launcher', 'How do I…?')}
        <kbd style={{ fontFamily: 'ui-monospace, monospace', fontSize: 10, background: 'rgba(255,255,255,.14)', borderRadius: 4, padding: '1px 6px', fontWeight: 500, color: '#d9d2ea' }}>?</kbd>
      </button>,
      document.body,
    );
  }

  // ── open: the panel ───────────────────────────────────────────────────────
  return createPortal(
    <div
      role="dialog"
      aria-label={ft('copilot.title', 'Copilot')}
      data-copilot="panel"
      style={{
        // Reopened over a running tour the panel must clear the tour's own
        // overlay (100000); idle it stays below it so a starting tour wins.
        position: 'fixed', right: 16, bottom: 16, zIndex: touring ? 100001 : Z,
        width: 'min(372px, calc(100vw - 32px))',
        maxHeight: 'min(640px, calc(100vh - 32px))',
        background: 'var(--surface-1, #fff)', color: 'var(--text-2, #4b4362)',
        border: '1px solid var(--border-2, #e9e4f4)', borderRadius: 14,
        boxShadow: '0 12px 32px rgba(30,20,60,.22)',
        display: 'flex', flexDirection: 'column', overflow: 'hidden',
        fontSize: 13,
      }}
    >
      {/* header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '12px 14px', background: INK, color: '#fff', flex: '0 0 auto' }}>
        <Dot size={26} />
        <span>
          <b style={{ display: 'block', fontSize: 13.5, fontWeight: 700, letterSpacing: '-.01em' }}>{ft('copilot.title', 'Copilot')}</b>
          <span style={{ display: 'block', fontSize: 10.5, color: '#b3aac9', fontFamily: 'ui-monospace, monospace', letterSpacing: '.08em', textTransform: 'uppercase' }}>{ft('copilot.subtitle', 'Ride University')}</span>
        </span>
        <span style={{ marginLeft: 'auto', display: 'inline-flex', border: '1px solid #4b4362', borderRadius: 999, overflow: 'hidden' }}>
          {['es', 'en'].map((code) => (
            <button
              key={code}
              type="button"
              onClick={() => setLang(code)}
              aria-pressed={lang === code}
              style={{
                fontSize: 10.5, fontWeight: 640, padding: '3px 9px', cursor: 'pointer', border: 'none',
                background: lang === code ? TEAL : 'transparent',
                color: lang === code ? TEAL_DARK : '#b3aac9',
              }}
            >{code.toUpperCase()}</button>
          ))}
        </span>
        <button
          type="button"
          onClick={() => setOpen(false)}
          aria-label={ft('common.close', 'Close')}
          style={{ marginLeft: 6, background: 'none', border: 'none', color: '#b3aac9', fontSize: 15, cursor: 'pointer', lineHeight: 1 }}
        >×</button>
      </div>

      {/* conversation */}
      <div ref={bodyRef} style={{ flex: 1, overflow: 'auto', padding: 14, display: 'flex', flexDirection: 'column', gap: 12, background: 'var(--surface-2, #fbfaff)' }}>
        {msgs.length === 0 && (
          <>
            <div style={{ fontSize: 12.5, color: 'var(--text-3, #736a8b)', lineHeight: 1.5 }}>
              {ft('copilot.hello', "Ask me how to do anything in RideFleet. I'll explain — and if you want, I'll show you on the screen itself.")}
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              {[ft('copilot.quick1', 'How do I do a check-out?'), ft('copilot.quick2', 'How do I take a payment?')].map((q) => (
                <button
                  key={q}
                  type="button"
                  onClick={() => send(q)}
                  style={{ fontSize: 11.5, fontWeight: 560, color: TEAL_TEXT, background: '#e7faf6', border: '1px solid #c9f2ea', borderRadius: 999, padding: '5px 11px', cursor: 'pointer' }}
                >{q}</button>
              ))}
            </div>
          </>
        )}
        {msgs.map((m) => (
          <Message
            key={m.id}
            msg={m}
            lang={lang}
            ft={ft}
            viewer={viewer}
            onTeach={onTeach}
            onGo={onGo}
            onArticle={onArticle}
            onSearchKb={onSearchKb}
            onTellAdmin={onTellAdmin}
            onYesHere={onYesHere}
            onOtherReservation={onOtherReservation}
          />
        ))}
      </div>

      {/* input + the standing commitment */}
      <div style={{ borderTop: '1px solid var(--border-2, #e9e4f4)', background: 'var(--surface-1, #fff)', padding: '10px 12px', flex: '0 0 auto' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 9, border: '1px solid var(--border-2, #d9d2ea)', borderRadius: 11, padding: '8px 12px', background: 'var(--surface-1, #fff)' }}>
          <input
            ref={inputRef}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); submit(); } }}
            placeholder={ft('copilot.placeholder', 'Type your question…')}
            aria-label={ft('copilot.placeholder', 'Type your question…')}
            style={{ flex: 1, border: 'none', outline: 'none', background: 'transparent', fontSize: 13, color: 'var(--text-1, #17122b)' }}
          />
          <button
            type="button"
            onClick={submit}
            aria-label={ft('copilot.send', 'Send')}
            style={{ width: 26, height: 26, borderRadius: '50%', background: '#8752FE', border: 'none', cursor: 'pointer', color: '#fff', fontSize: 13, lineHeight: 1, flex: '0 0 auto' }}
          >→</button>
        </div>
        <div style={{ fontSize: 10, color: 'var(--text-3, #8a819f)', textAlign: 'center', marginTop: 7, fontFamily: 'ui-monospace, monospace', letterSpacing: '.04em', textTransform: 'uppercase' }}>
          {ft('copilot.footer', 'Explains and guides · never performs actions')}
        </div>
      </div>
    </div>,
    document.body,
  );
}

// ---------------------------------------------------------------------------
// One message. Text derives from the stored keys at render time, so the ES/EN
// toggle re-renders the same sourced answer — never a machine translation.
// ---------------------------------------------------------------------------

function Message({ msg, lang, ft, viewer, onTeach, onGo, onArticle, onSearchKb, onTellAdmin, onYesHere, onOtherReservation }) {
  if (msg.kind === 'user') {
    return (
      <div style={{ alignSelf: 'flex-end', maxWidth: '88%', background: '#7440ea', color: '#fff', borderRadius: '14px 14px 4px 14px', padding: '9px 13px', lineHeight: 1.55 }}>
        {msg.text}
      </div>
    );
  }

  if (msg.kind === 'answer') {
    return <AnswerCard intentKey={msg.intentKey} lang={lang} ft={ft} viewer={viewer} onTeach={onTeach} onGo={onGo} onArticle={onArticle} />;
  }

  if (msg.kind === 'ai') {
    return <AiAnswerBubble msg={msg} ft={ft} onArticle={onArticle} />;
  }

  if (msg.kind === 'miss') {
    return (
      <BotBubble>
        {ft('copilot.noAnswer', "I don't have that in the articles yet, and I'd rather not invent steps.")}
        <div style={ctaRow}>
          <button type="button" onClick={() => onSearchKb(msg.q)} style={ctaSecondary}>
            {ft('copilot.searchKb', 'Search Ride University')}
          </button>
          {msg.flagged ? (
            <span style={{ fontSize: 11.5, color: 'var(--text-3, #736a8b)', alignSelf: 'center' }}>
              {ft('copilot.tellAdminDone', 'Noted — an admin will see it.')}
            </span>
          ) : (
            <button type="button" onClick={() => onTellAdmin(msg)} style={ctaGhost}>
              {ft('copilot.tellAdmin', 'Tell an admin')}
            </button>
          )}
        </div>
        <SourceChip warn label={ft('copilot.noSource', 'NO SOURCE · NOT ANSWERED')} />
      </BotBubble>
    );
  }

  if (msg.kind === 'preflight') {
    const text = msg.note === 'here'
      ? ft('copilot.preflight.here', 'Starting right here.')
      : msg.note === 'navigate'
        ? ft('copilot.preflight.navigate', "I'll take you to {{screen}} first — the guide starts there.", { screen: screenNameFor(msg.to, lang) })
        : ft('copilot.preflight.followThere', "Open the reservation where you're having the problem and I'll pick up there.");
    return <PreflightBubble label={ft('copilot.preflight.label', 'Pre-flight · before teaching')}>{text}</PreflightBubble>;
  }

  if (msg.kind === 'ask-here') {
    return (
      <PreflightBubble label={ft('copilot.preflight.label', 'Pre-flight · before teaching')}>
        {ft('copilot.preflight.askHere', 'Want me to guide you right here on {{ref}}?', { ref: msg.recordId })}
        <div style={{ display: 'flex', gap: 6, marginTop: 9, flexWrap: 'wrap' }}>
          <button type="button" onClick={() => onYesHere(msg.moduleKey)} style={{ ...replyBtn, background: TEAL, borderColor: 'transparent' }}>
            {ft('copilot.preflight.yesHere', 'Yes, here')}
          </button>
          <button type="button" onClick={() => onOtherReservation(msg.moduleKey)} style={replyBtn}>
            {ft('copilot.preflight.notThisOne', "It's a different reservation")}
          </button>
        </div>
      </PreflightBubble>
    );
  }

  if (msg.kind === 'needs-record') {
    return (
      <PreflightBubble label={ft('copilot.preflight.label', 'Pre-flight · before teaching')}>
        {ft('copilot.preflight.whichReservation', "Which reservation is the problem on? Open it and I'll pick up there.")}
        <div style={{ display: 'flex', gap: 6, marginTop: 9, flexWrap: 'wrap' }}>
          <button type="button" onClick={() => onGo(msg.go)} style={replyBtn}>
            {ft('copilot.preflight.takeMeList', 'Take me to Reservations')}
          </button>
        </div>
      </PreflightBubble>
    );
  }

  if (msg.kind === 'done') {
    const mod = findModule(msg.moduleKey);
    const opportunistic = mod?.kind === 'OPPORTUNISTIC';
    return (
      <BotBubble>
        <b style={{ color: 'var(--text-1, #17122b)', fontWeight: 660 }}>{ft('copilot.done', 'Did you get it done?')}</b>
        {opportunistic && (
          <div style={{ marginTop: 4, fontSize: 12, color: 'var(--text-3, #736a8b)' }}>
            {ft('copilot.doneOpportunistic', 'The module marks itself complete when the real record exists — walking it does not count as doing it.')}
          </div>
        )}
      </BotBubble>
    );
  }

  return null;
}

/** The sourced answer: lead, steps, gotcha, live article body, source chip, CTA row. */
function AnswerCard({ intentKey, lang, ft, viewer, onTeach, onGo, onArticle }) {
  const intent = findIntent(intentKey);
  const slug = intent?.articleSlug || null;
  // Phase 2: fetch the REAL Ride University article body (cached per session
  // in copilot-live). null = nothing extra to show — the curated summary and
  // steps above are the fallback on ANY error, so the fetch only ever adds.
  const [article, setArticle] = useState(null);
  useEffect(() => {
    if (!slug) return undefined;
    let alive = true;
    fetchArticle(slug)
      .then((data) => { if (alive && data?.body) setArticle(data); })
      .catch(() => { /* curated summary stands — guardrail: degrade, never block */ });
    return () => { alive = false; };
  }, [slug]);
  if (!intent) return null;
  const mod = intent.tourModuleKey ? findModule(intent.tourModuleKey) : null;
  const ctas = ctasFor(intent, viewer);

  const lead = intent.summary?.[lang] || intent.summary?.en || '';
  // Curated steps when the intent carries them (playbook-backed); otherwise
  // the module's own step titles — real prose, already translated under
  // training.* keys.
  const steps = intent.steps?.[lang]
    || intent.steps?.en
    || (mod ? mod.steps.map((s) => ft(trainingStepKey(mod.key, s, 'title'), s.title)) : null);
  const gotcha = intent.gotcha?.[lang]
    || intent.gotcha?.en
    || (mod?.gotcha ? ft(trainingModuleKey(mod, 'gotcha'), mod.gotcha) : null);

  return (
    <BotBubble>
      <b style={{ color: 'var(--text-1, #17122b)', fontWeight: 660 }}>{lead}</b>
      {steps && (
        <ol style={{ margin: '8px 0 0 18px', display: 'flex', flexDirection: 'column', gap: 5, padding: 0 }}>
          {steps.map((s, i) => <li key={`${i}-${s.slice(0, 24)}`}>{s}</li>)}
        </ol>
      )}
      {gotcha && (
        <div style={{ marginTop: 10, background: '#fdf6e8', border: '1px solid #fbe9c6', borderRadius: 8, padding: '8px 10px', fontSize: 12, lineHeight: 1.5, color: '#5b4a22' }}>
          <b style={{ display: 'block', fontFamily: 'ui-monospace, monospace', fontSize: 9, letterSpacing: '.12em', textTransform: 'uppercase', color: '#7d4d08', marginBottom: 3 }}>
            {ft('copilot.gotchaLabel', 'Where people trip')}
          </b>
          {gotcha}
        </div>
      )}
      {article && (
        <ArticleBody article={article} lang={lang} ft={ft} />
      )}
      <SourceChip label={`${ft('copilot.source', 'Source')} · ${intent.source.label}`} />
      {ctas.adminOnly && (
        <div style={{ marginTop: 8, fontSize: 12, color: 'var(--text-3, #736a8b)' }}>
          {ft('copilot.adminOnly', "That screen needs an admin — here's what they'll do.")}
        </div>
      )}
      {ctas.notLive && (
        <div style={{ marginTop: 8, fontSize: 12, color: 'var(--text-3, #736a8b)' }}>
          {ft('copilot.notLive', "Not live at your counter yet — here's what it will do when it is.")}
        </div>
      )}
      <div style={ctaRow}>
        {ctas.teach && (
          <button type="button" onClick={() => onTeach(intent)} style={ctaPrimary}>
            {ft('copilot.teach', 'Show me')}
          </button>
        )}
        {ctas.go && (
          <button type="button" onClick={() => onGo(ctas.go)} style={ctaSecondary}>
            {ft('copilot.takeMe', 'Take me there')}
          </button>
        )}
        {ctas.article && (
          <button type="button" onClick={() => onArticle(ctas.article)} style={ctaGhost}>
            {ft('copilot.viewArticle', 'View article')}
          </button>
        )}
      </div>
    </BotBubble>
  );
}

/**
 * The live Ride University article body (Phase 2), rendered in the asker's
 * language half of the corpus's bilingual body and scrollable inside the
 * panel. Sits ABOVE the source chip: the panel is quoting, never authoring.
 */
function ArticleBody({ article, lang, ft }) {
  const half = articleHalf(article?.body, lang);
  const blocks = articleBlocks(half);
  if (!blocks.length) return null;
  let step = 0;
  return (
    <div data-copilot="article-body" style={{ marginTop: 10, border: '1px solid var(--border-2, #e9e4f4)', borderRadius: 10, background: 'var(--surface-2, #fbfaff)', overflow: 'hidden' }}>
      <div style={{ padding: '7px 11px', borderBottom: '1px solid var(--border-2, #f2eff9)', fontFamily: 'ui-monospace, monospace', fontSize: 9.5, letterSpacing: '.1em', textTransform: 'uppercase', color: 'var(--text-3, #736a8b)' }}>
        {ft('copilot.articleLabel', 'From the article')} · {article?.title || ''}
      </div>
      <div style={{ maxHeight: 200, overflow: 'auto', padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: 6, fontSize: 12.5, lineHeight: 1.55 }}>
        {blocks.map((b, i) => {
          if (b.type === 'heading') {
            return <b key={i} style={{ color: 'var(--text-1, #17122b)', fontSize: 12.5, fontWeight: 680, marginTop: i === 0 ? 0 : 4 }}>{b.text}</b>;
          }
          if (b.type === 'item') {
            step += 1;
            return (
              <div key={i} style={{ display: 'flex', gap: 8 }}>
                <span style={{ flex: '0 0 auto', width: 17, height: 17, borderRadius: '50%', background: '#efe9fd', color: '#5a26c9', fontSize: 10, fontWeight: 700, display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}>{step}</span>
                <span>{b.text}</span>
              </div>
            );
          }
          if (b.type === 'bullet') {
            return (
              <div key={i} style={{ display: 'flex', gap: 8 }}>
                <span aria-hidden="true" style={{ flex: '0 0 auto', color: '#8752FE' }}>•</span>
                <span>{b.text}</span>
              </div>
            );
          }
          return <span key={i}>{b.text}</span>;
        })}
      </div>
    </div>
  );
}

/**
 * An AI-fallback answer (Phase 2). Visually distinct on purpose: the AI chip
 * and the disclaimer make it impossible to mistake for a curated, sourced
 * card — even though the model was only allowed to speak from the retrieved
 * articles, which are listed and clickable underneath.
 */
function AiAnswerBubble({ msg, ft, onArticle }) {
  return (
    <div data-copilot="ai-answer" style={{ alignSelf: 'flex-start', maxWidth: '92%', background: 'var(--surface-1, #fff)', color: 'var(--text-2, #4b4362)', border: `1px dashed ${TEAL}`, borderRadius: '14px 14px 14px 4px', padding: '11px 13px', lineHeight: 1.55 }}>
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontFamily: 'ui-monospace, monospace', fontSize: 9, letterSpacing: '.14em', textTransform: 'uppercase', fontWeight: 700, color: TEAL_TEXT, background: '#e7faf6', border: '1px solid #c9f2ea', borderRadius: 999, padding: '2px 9px', marginBottom: 7 }}>
        <i style={{ width: 5, height: 5, borderRadius: '50%', background: TEAL }} />
        {ft('copilot.ai.chip', 'AI')}
      </span>
      <div style={{ whiteSpace: 'pre-wrap' }}>{msg.answer}</div>
      {Array.isArray(msg.sources) && msg.sources.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 9 }}>
          {msg.sources.map((s) => (
            <button
              key={s.slug}
              type="button"
              onClick={() => onArticle(s.slug)}
              style={{ fontSize: 10.5, fontWeight: 600, color: TEAL_TEXT, background: 'var(--surface-2, #f7f5fd)', border: '1px solid var(--border-2, #e9e4f4)', borderRadius: 999, padding: '3px 10px', cursor: 'pointer' }}
            >{s.title}</button>
          ))}
        </div>
      )}
      <div style={{ marginTop: 8, fontSize: 10.5, color: 'var(--text-3, #8a819f)' }}>
        {ft('copilot.ai.disclaimer', 'AI-generated from Ride University articles — verify on the screen before acting.')}
      </div>
    </div>
  );
}

// ── tiny presentational pieces ────────────────────────────────────────────────

function Dot({ size }) {
  return (
    <span aria-hidden="true" style={{ width: size, height: size, borderRadius: '50%', background: TEAL, color: TEAL_DARK, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flex: '0 0 auto', fontWeight: 700, fontSize: Math.round(size * 0.55) }}>?</span>
  );
}

function BotBubble({ children }) {
  return (
    <div style={{ alignSelf: 'flex-start', maxWidth: '92%', background: 'var(--surface-1, #fff)', color: 'var(--text-2, #4b4362)', border: '1px solid var(--border-2, #e9e4f4)', borderRadius: '14px 14px 14px 4px', padding: '11px 13px', lineHeight: 1.55 }}>
      {children}
    </div>
  );
}

function PreflightBubble({ label, children }) {
  return (
    <div style={{ alignSelf: 'flex-start', maxWidth: '92%', borderLeft: `3px solid ${TEAL}`, background: '#e7faf6', color: TEAL_DARK, borderRadius: '14px 14px 14px 4px', padding: '11px 13px', lineHeight: 1.55 }}>
      <span style={{ display: 'block', fontFamily: 'ui-monospace, monospace', fontSize: 9, letterSpacing: '.12em', textTransform: 'uppercase', color: TEAL_TEXT, marginBottom: 3 }}>{label}</span>
      {children}
    </div>
  );
}

function SourceChip({ label, warn }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, marginTop: 10, fontFamily: 'ui-monospace, monospace', fontSize: 10, letterSpacing: '.06em', color: 'var(--text-3, #736a8b)', background: 'var(--surface-2, #f7f5fd)', border: '1px solid var(--border-2, #f2eff9)', borderRadius: 999, padding: '3px 9px' }}>
      <i style={{ width: 5, height: 5, borderRadius: '50%', background: warn ? '#b8760a' : TEAL }} />
      {label}
    </span>
  );
}

const ctaRow = { display: 'flex', gap: 8, marginTop: 11, flexWrap: 'wrap' };
const ctaPrimary = { display: 'inline-flex', alignItems: 'center', gap: 7, fontSize: 12.5, fontWeight: 660, borderRadius: 8, padding: '8px 13px', cursor: 'pointer', border: '1px solid transparent', background: '#8752FE', color: '#fff' };
const ctaSecondary = { display: 'inline-flex', alignItems: 'center', gap: 7, fontSize: 12.5, fontWeight: 660, borderRadius: 8, padding: '8px 13px', cursor: 'pointer', border: '1px solid var(--border-2, #d9d2ea)', background: 'var(--surface-1, #fff)', color: '#5a26c9' };
const ctaGhost = { display: 'inline-flex', alignItems: 'center', gap: 7, fontSize: 12.5, fontWeight: 560, borderRadius: 8, padding: '8px 13px', cursor: 'pointer', border: '1px solid transparent', background: 'transparent', color: 'var(--text-3, #736a8b)' };
const replyBtn = { fontSize: 11.5, fontWeight: 660, borderRadius: 999, padding: '5px 13px', cursor: 'pointer', border: '1px solid #c9f2ea', background: '#fff', color: TEAL_DARK };
