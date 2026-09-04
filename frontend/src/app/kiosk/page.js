'use client';

/**
 * Ride Kiosk — customer wizard (Fase B3b, 2026-07-05).
 * Mockup: doc/kiosk-mockups-2026-07-04.html (Rev 2, Hector-approved) — screens
 * K1-K10, K4b selfie, K-E1..E4. Spec: doc/kiosk-e2e-spec-2026-07-04.md.
 *
 * PUBLIC page (device-token auth via lib/kioskClient.js — the single seam for
 * every kiosk API call). Client state machine:
 *   PAIRING → WELCOME → LOOKUP → SUMMARY → ID → SELFIE → OFFERS → PAYMENT →
 *   SIGN → DONE, plus WALKUP_SOON (K9 is Fase B4), ESCALATED (K10 v1, no
 *   video) and OUT_OF_SERVICE (K-E4). Business truth always lives server-side
 *   (checkout-session state machine); this page only renders and calls.
 *
 * MONEY: the payment step is the B3 SANDBOX stamp only (clearly badged). The
 * QR/SMS payment-link UI is a visual placeholder until Fase B5.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  KIOSK_ERR_NETWORK,
  KIOSK_ERR_UNPAIRED,
  acceptOffers,
  assignVehicle,
  getAssistState,
  attachReservation,
  completeSession,
  createSession,
  bindVoziaConversation,
  escalateSession,
  getAgreement,
  getOffers,
  idPhotoExtract,
  lookupReservation,
  nameUpdateConfirm,
  nameUpdateDestinations,
  nameUpdateSendCode,
  pairDevice,
  readDeviceToken,
  sandboxPayment,
  sendEvents,
  signAgreement,
  staffAssistConfirmName,
  staffAssistList,
  staffAssistUnlock,
  staffAssistVerifyId,
  verifyId,
} from '../../lib/kioskClient';
import { LicenseScanner } from '../../components/loaner/LicenseScanner';
import { SignaturePad } from '../../components/kiosk/SignaturePad';
import { StaffAssistScreen } from '../../components/kiosk/StaffAssistScreen';
import { NameUpdateFlow } from '../../components/kiosk/NameUpdateFlow';
import { VoziaHelpOverlay } from '../../components/kiosk/VoziaHelpOverlay';
import { CAMERA_ERR_IN_FLIGHT, acquireCameraStream, cameraGrantedOnce } from '../../lib/kioskCamera';
import {
  ackKioskCommand, decideFlowCompletedAck, noteFirstRefusal, postKioskState, resolveCoPresence, voziaPendingStepKey,
} from '../../lib/voziaBridge';
import { KIOSK_UNPAIRED_EVENT, useKioskUi } from '../../components/kiosk/KioskUiContext';

const DONE_RESET_S = 30;

// screen → backend funnel step (KioskSession.step telemetry vocabulary).
const FUNNEL_STEP = {
  WELCOME: 'WELCOME',
  LOOKUP: 'LOOKUP',
  SUMMARY: 'LOOKUP',
  ID: 'ID',
  SELFIE: 'ID',
  OFFERS: 'UPSELL',
  PAYMENT: 'PAYMENT',
  SIGN: 'SIGN',
  DONE: 'DONE',
};

const PROGRESS_OF = {
  LOOKUP: 1, SUMMARY: 1, ID: 2, SELFIE: 2, OFFERS: 3, PAYMENT: 4, SIGN: 5,
};

const money = (v) => `$${Number(v || 0).toFixed(2)}`;

export default function KioskPage() {
  const { t, i18n } = useTranslation();
  const ui = useKioskUi();
  const locale = i18n.language === 'es' ? 'es-PR' : 'en-US';

  const [screen, setScreen] = useState('BOOT');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [session, setSession] = useState(null);
  const [stub, setStub] = useState(null); // masked reservation stub
  const [aamva, setAamva] = useState(null);
  const [licensePhoto, setLicensePhoto] = useState(null);
  const [selfie, setSelfie] = useState(null);
  const [verifyResult, setVerifyResult] = useState(null);
  const [vehicle, setVehicle] = useState(null);
  const [offers, setOffers] = useState(null);
  const [assistNotice, setAssistNotice] = useState(null);
  const [agreement, setAgreement] = useState(null);
  const [payState, setPayState] = useState('IDLE'); // IDLE | PAID | FAILED | DISABLED
  const [doneData, setDoneData] = useState(null);
  const [doneCountdown, setDoneCountdown] = useState(DONE_RESET_S);
  const [lookupLocked, setLookupLocked] = useState(false);
  // B3g smart lookup: multiple candidates → ask for ONE more datum (never a
  // list). null | 'pickupDate' | 'lastName' | 'HELP' (rounds exhausted).
  const [lookupNeeds, setLookupNeeds] = useState(null);
  const lookupBaseRef = useRef(null); // the payload that triggered NEEDS_MORE_INFO
  const lookupRoundsRef = useRef(0);
  const [escalatedInfo, setEscalatedInfo] = useState(null);
  const [helpOpen, setHelpOpen] = useState(false);
  // B3c Staff Assist: which screen to return to when the assist flow exits
  // (cancel / grant expiry) — 'ESCALATED' or the escalateSuggested origin.
  const [staffAssistFrom, setStaffAssistFrom] = useState('ESCALATED');
  // B3e: 'NAME' = light name-only bypass (compact confirm card, no K-S2
  // manual form); 'FULL' = the escalated-session manual-entry flow.
  const [staffAssistMode, setStaffAssistMode] = useState('FULL');
  // ── B3f VozIA embed (contract: voice-ai-customer-service/KIOSK-EMBED.md) ──
  const [voziaOpen, setVoziaOpen] = useState(false);
  const [agentMsg, setAgentMsg] = useState(''); // show_message banner (OK-dismiss)
  // Transient toast: { text, ms } — 2.5s default for the ✓ "agent updated"
  // cue; the F0 refusal toast asks for 6s (GD: only cue in a failure state).
  const [agentToast, setAgentToastRaw] = useState(null);
  const setAgentToast = useCallback((text, ms = 2500) => {
    setAgentToastRaw(text ? { text, ms } : null);
  }, []);
  // remount key for retry_step — bumping it re-enters the current screen clean
  const [stepEpoch, setStepEpoch] = useState(0);
  // Conversation identity — MEMORY ONLY (never localStorage). A stale secret
  // must never write into the next customer's conversation: discarded on the
  // iframe's null/null reset, on session wipe, and replaced on new identity.
  const voziaIdentityRef = useRef({ conversationId: null, secret: null });
  const voziaAppliedIdsRef = useRef(new Set());
  // F0: flow_completed commands whose completeSession() round-trip is still
  // in flight, keyed `${conversationId}:${commandId}` (command ids are only
  // unique per conversation). Redelivery every ~2s must not fire a second
  // /complete while the first is pending; entries self-clear on settle, so
  // this never needs the wipe/restore dance the applied-ids set gets.
  const voziaInFlightRef = useRef(new Set());
  // F0 storm guard: refused flow_completed keys (same shape) that already
  // showed the toast + wrote the VOZIA_COMMAND_REFUSED event. A redelivered
  // id (lost ack) still re-proves against /complete, silently.
  const voziaRefusedIdsRef = useRef(new Set());
  const [voziaConvActive, setVoziaConvActive] = useState(false);
  // Co-presence extras: client-side verify retry counter + last error code
  // for the active step (strict enum, consumed by the next kiosk-state post).
  const verifyAttemptsRef = useRef(0);
  const voziaErrorRef = useRef(null);
  // M1: has ANY identity path verified this session (scan confirm / selfie /
  // name-update / staff-assist)? An agent skip of the ID family without this
  // would strand a paid guest at /sign's un-forgeable idVerifiedAt gate.
  const idVerifiedRef = useRef(false);
  // Typed confirmation number (lookup success) — the iframe's `res` param;
  // the masked stub intentionally never carries it back from the server.
  const confirmationNumberRef = useRef('');

  const sessionRef = useRef(null);
  useEffect(() => { sessionRef.current = session; }, [session]);
  const screenRef = useRef('BOOT');
  // Last funnel step actually reported to Valet — an overlay screen reuses it instead of dropping
  // the co-presence post. Cleared with the conversation and with the session, like the identity.
  const lastVoziaStepRef = useRef(null);
  useEffect(() => { screenRef.current = screen; }, [screen]);
  // Stale-response guard: bumped on every wipe. Async handlers capture the
  // generation before awaiting and drop responses that land after a reset —
  // otherwise a slow lookup/verify could repopulate a wiped session right on
  // the WELCOME screen.
  const genRef = useRef(0);

  const fmtDateTime = useCallback((value) => {
    if (!value) return '—';
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return '—';
    return d.toLocaleString(locale, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  }, [locale]);

  const resetAll = useCallback(() => {
    // Honest abandonment breadcrumb until the B5 server sweep sets
    // authoritative outcomes: every client-side wipe (idle expiry, "Start
    // over", DONE auto-reset) records SESSION_WIPED. Fire-and-forget.
    if (sessionRef.current?.id) {
      sendEvents(sessionRef.current.id, { step: null, event: 'SESSION_WIPED' });
      // F1: the dead session must not stay bound to a conversation. Goes
      // through the SAME serialized chain (QA MINOR-1): a bind already in
      // flight for this very session could otherwise land AFTER this null and
      // re-bind the abandoned row, leaving the agent reading a check-in the
      // guest walked away from. Pinned to the OUTGOING id so a later bind for
      // the next session is unaffected. restart_flow keeps the conversation
      // and re-binds the NEW session when it is created (effect below).
      bindVoziaConvFor(sessionRef.current.id, null);
    }
    genRef.current += 1;
    setSession(null);
    setStub(null);
    setAamva(null);
    setLicensePhoto(null);
    setSelfie(null);
    setVerifyResult(null);
    setVehicle(null);
    setOffers(null);
    setAssistNotice(null);
    setAgreement(null);
    setPayState('IDLE');
    setDoneData(null);
    setDoneCountdown(DONE_RESET_S);
    setLookupLocked(false);
    setLookupNeeds(null);
    lookupBaseRef.current = null;
    lookupRoundsRef.current = 0;
    setEscalatedInfo(null);
    setHelpOpen(false);
    setStaffAssistFrom('ESCALATED');
    // B3f hygiene: the conversation identity dies with the session wipe —
    // a stale secret must never reach the next customer's conversation.
    // (restart_flow snapshots + restores around this call on purpose.)
    voziaIdentityRef.current = { conversationId: null, secret: null };
    voziaAppliedIdsRef.current = new Set();
    lastVoziaStepRef.current = null;
    voziaRefusedIdsRef.current = new Set(); // QA MINOR-1: refusal keys are per conversation too
    setVoziaConvActive(false);
    setVoziaOpen(false);
    setAgentMsg('');
    setAgentToast('');
    verifyAttemptsRef.current = 0;
    idVerifiedRef.current = false;
    voziaErrorRef.current = null;
    confirmationNumberRef.current = '';
    setStepEpoch(0);
    setErr('');
    setBusy(false);
    ui.setSessionActive(false);
    setScreen(readDeviceToken() ? 'WELCOME' : 'PAIRING');
  }, [ui]);

  // Boot: paired → WELCOME, otherwise pairing screen. Also listen for the
  // shell's boot refresh discovering a rotated/revoked token (401) so the
  // attract screen doesn't sit on WELCOME with a dead token.
  useEffect(() => {
    setScreen(readDeviceToken() ? 'WELCOME' : 'PAIRING');
    const onUnpaired = () => {
      if (screenRef.current === 'WELCOME' || screenRef.current === 'BOOT') setScreen('PAIRING');
    };
    window.addEventListener(KIOSK_UNPAIRED_EVENT, onUnpaired);
    return () => window.removeEventListener(KIOSK_UNPAIRED_EVENT, onUnpaired);
  }, []);

  // Shell integration: idle-reset handler + Help button. When the device
  // carries VozIA config, Get Help opens the Chloe embed; without it (dark /
  // fail-soft) the behavior is EXACTLY the pre-B3f escalate sheet.
  useEffect(() => { ui.onIdleReset(resetAll); }, [ui, resetAll]);
  useEffect(() => {
    if (ui.helpTick <= 0) return;
    if (ui.device?.vozia?.host) {
      setVoziaOpen(true);
      if (sessionRef.current?.id) sendEvents(sessionRef.current.id, { step: null, event: 'VOZIA_OPENED' });
    } else {
      setHelpOpen(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ui.helpTick]);

  // Step-transition telemetry (fire-and-forget; offer shown/accept/decline
  // events are recorded server-side by the offers endpoints).
  useEffect(() => {
    const funnel = FUNNEL_STEP[screen];
    if (funnel && sessionRef.current?.id) {
      sendEvents(sessionRef.current.id, { step: funnel, event: 'STEP' });
    }
  }, [screen]);

  // DONE auto-reset (30s, per mockup K8).
  useEffect(() => {
    if (screen !== 'DONE') return undefined;
    if (doneCountdown <= 0) { resetAll(); return undefined; }
    const timer = setTimeout(() => setDoneCountdown((v) => v - 1), 1000);
    return () => clearTimeout(timer);
  }, [screen, doneCountdown, resetAll]);

  /** Shared error routing: unpaired → PAIRING, network → K-E4; else false. */
  const routeFatal = useCallback((e) => {
    if (e?.code === KIOSK_ERR_UNPAIRED) {
      ui.setDevice(null);
      ui.setSessionActive(false);
      setScreen('PAIRING');
      return true;
    }
    if (e?.code === KIOSK_ERR_NETWORK) {
      ui.setOnline?.(false);
      ui.setSessionActive(false);
      setScreen('OUT_OF_SERVICE');
      return true;
    }
    return false;
  }, [ui]);

  // ── B3f VozIA bridge (contract: KIOSK-EMBED.md v2) ─────────────────────────

  const vozia = ui.device?.vozia || null; // {host, widgetKey} — null-safe/dark

  /**
   * Immediate co-presence post (step transitions + notable errors).
   *
   * An overlay screen (ESCALATED, PAIRING, OUT_OF_SERVICE, WALKUP_SOON) is not a position in the
   * funnel, so it reports the LAST REAL step rather than nothing: dropping the post is what left
   * the agent's tab reading "no state reported" for a whole session, and inventing a step would be
   * worse — an escalation from the signature pad must not read as "find reservation". BOOT and
   * WELCOME DO map (the guest genuinely has not found their reservation yet), so the very first
   * post — the one fired when the conversation identity arrives — always has something true to say.
   */
  // While a conversation is open, ask the SERVER whether someone currently holds a
  // permission over this check-in, and tell the guest if so.
  //
  // Why this exists: an in-person assist is self-announcing — there is a person
  // standing beside you, visibly doing something to your screen. Remotely that
  // signal is gone, and with three roles able to do it, the difference between
  // "someone is helping me" and "something happened to my account without my
  // knowing" is this banner and nothing else.
  //
  // Polled only while the chat is actually open (a bound conversation), so an idle
  // kiosk makes no requests. Server truth only: the console does not get to decide
  // what the guest is told about their own check-in.
  useEffect(() => {
    if (!voziaConvActive || !session?.id) { setAssistNotice(null); return undefined; }
    let stop = false;
    const tick = async () => {
      try {
        const out = await getAssistState(session.id);
        if (!stop) setAssistNotice(out?.open ? out : null);
      } catch {
        // Never surface this to the guest: a failed poll means we do not know, and
        // "we do not know" must read as no claim rather than as a false alarm.
        if (!stop) setAssistNotice(null);
      }
    };
    tick();
    const id = setInterval(tick, 5000);
    return () => { stop = true; clearInterval(id); };
  }, [voziaConvActive, session?.id]);

  const postVoziaState = useCallback((screenName, errorCode = null) => {
    if (!vozia?.host || !voziaIdentityRef.current.conversationId) return;
    // step and stepNumber travel TOGETHER: an overlay repeats the last real
    // step, so it must repeat that step's number too. Deriving the number from
    // the SCREEN made the agent read "4/5 · Payment" and then "0/5 · Payment"
    // for the same guest — the label right, the number walking backwards.
    // (QA MINOR-1.)
    const here = resolveCoPresence(screenName, lastVoziaStepRef.current);
    if (!here) return;
    const { step, stepNumber } = here;
    lastVoziaStepRef.current = here;
    postKioskState(vozia.host, voziaIdentityRef.current, {
      step,
      stepNumber,
      totalSteps: 5,
      attempts: Math.max(1, verifyAttemptsRef.current || 1),
      errorCode: errorCode || voziaErrorRef.current || undefined,
      // v4 additive: lets Valet bind this conversation to the RFM kiosk
      // session (plan MUST-CHANGE 3). Ignored by v3 hosts, never a 400.
      kioskSessionId: sessionRef.current?.id || undefined,
    });
    voziaErrorRef.current = null;
  }, [vozia?.host]);

  /** Capture a strict-enum error + surface it to the agent right away. */
  const reportVoziaError = useCallback((code) => {
    voziaErrorRef.current = code;
    postVoziaState(screenRef.current, code);
  }, [postVoziaState]);

  // Co-presence: every wizard step transition while a conversation is active.
  useEffect(() => {
    if (voziaConvActive) postVoziaState(screen);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [screen, voziaConvActive]);

  // Transient agent-action toast (per-call duration, non-blocking).
  useEffect(() => {
    if (!agentToast) return undefined;
    const timer = setTimeout(() => setAgentToastRaw(null), agentToast.ms || 2500);
    return () => clearTimeout(timer);
  }, [agentToast]);

  // F1 remote assist: server-side binding session ↔ conversation (plan
  // MUST-CHANGE 3). Fire-and-forget, but SERIALIZED: a reset (null) and the
  // next conversation's id can be posted back-to-back, and two independent
  // fetches could land out of order — the late null would erase the fresh
  // binding. Chaining keeps last-write-wins honest. Never rejects.
  const voziaBindChainRef = useRef(Promise.resolve());
  const bindVoziaConvFor = useCallback((sessionId, conversationId) => {
    if (!sessionId) return;
    voziaBindChainRef.current = voziaBindChainRef.current
      .then(() => bindVoziaConversation(sessionId, conversationId))
      .catch(() => null);
  }, []);
  const bindVoziaConv = useCallback((conversationId) => {
    bindVoziaConvFor(sessionRef.current?.id, conversationId);
  }, [bindVoziaConvFor]);

  const onVoziaConversation = useCallback(({ conversationId, secret }) => {
    if (!conversationId || !secret) {
      // Reset/close from the iframe → discard the identity INSTANTLY.
      voziaIdentityRef.current = { conversationId: null, secret: null };
      voziaAppliedIdsRef.current = new Set();
      voziaRefusedIdsRef.current = new Set(); // QA MINOR-1: refusal keys are per conversation too
      lastVoziaStepRef.current = null;
      setVoziaConvActive(false);
      bindVoziaConv(null); // clear the server-side binding (best-effort)
      return;
    }
    voziaIdentityRef.current = { conversationId, secret };
    voziaAppliedIdsRef.current = new Set(); // applied-ids are per conversation
    voziaRefusedIdsRef.current = new Set(); // QA MINOR-1: refusal keys are per conversation too
    setVoziaConvActive(true);
    bindVoziaConv(conversationId); // best-effort, never blocks the flow
  }, [bindVoziaConv]);

  // Get Help can be opened on WELCOME (no session yet). When the session is
  // created while a conversation is already active, bind it then — otherwise
  // the agent's assist-view would 404 for the whole check-in.
  useEffect(() => {
    if (session?.id && voziaConvActive && voziaIdentityRef.current.conversationId) {
      bindVoziaConv(voziaIdentityRef.current.conversationId);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.id]);

  /**
   * Agent → kiosk commands (§3). Redelivered ~2s until acked: apply is
   * idempotent by command.id; commands for a non-active conversation are
   * discarded without ack; everything no-ops if the session was wiped.
   */
  const applyAgentCommand = useCallback((cmd) => {
    const current = screenRef.current;
    if (!sessionRef.current?.id && cmd.command !== 'show_message') return;
    switch (cmd.command) {
      case 'retry_step':
        // Re-enter the current step clean: clear errors/verify state and
        // remount the screen component (stepEpoch is its render key).
        setErr('');
        setVerifyResult(null);
        setStepEpoch((n) => n + 1);
        setAgentToast(t('kiosk.voziaAppliedToast'));
        break;
      case 'skip_step':
        if (current === 'SIGN' || current === 'PAYMENT') {
          // Signature/payment are COMPLETED, never skipped (server rejects
          // too) — polite security-framed refusal; still ack to stop redelivery.
          setAgentMsg(t('kiosk.voziaSkipRefused'));
          break;
        }
        if (['ID', 'SELFIE', 'NAME_UPDATE', 'STAFF_ASSIST'].includes(current)) {
          if (!idVerifiedRef.current) {
            // M1: no verified identity yet → skipping would strand the guest
            // at /sign's idVerifiedAt gate after paying. Refuse (distinct
            // copy pointing at on-site staff assist) and STILL ack.
            setAgentMsg(t('kiosk.voziaSkipIdRefused'));
            break;
          }
          setVerifyResult(null);
          proceedAssign(); // → vehicle + OFFERS; hard backend gates still apply
          setAgentToast(t('kiosk.voziaAppliedToast'));
        } else if (current === 'OFFERS') {
          chooseOffer([]);
          setAgentToast(t('kiosk.voziaAppliedToast'));
        } else {
          setAgentMsg(t('kiosk.voziaSkipUnavailable'));
        }
        break;
      case 'restart_flow': {
        // Back to WELCOME but the conversation STAYS open (agent keeps
        // talking): snapshot identity around the wipe, keep the overlay up.
        const identity = { ...voziaIdentityRef.current };
        const applied = voziaAppliedIdsRef.current;
        resetAll();
        voziaIdentityRef.current = identity;
        voziaAppliedIdsRef.current = applied;
        setVoziaConvActive(!!identity.conversationId);
        setVoziaOpen(true);
        break;
      }
      case 'show_message':
        setAgentMsg(String(cmd.message || '').slice(0, 500));
        break;
      // 'flow_completed' is NOT handled here — it is async and its ack
      // depends on the server's answer (see completeFromAgent, intercepted
      // in onVoziaCommands before the idempotency set is touched).
      default:
        break; // unknown command — ack anyway so it stops redelivering
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [t, resetAll, ui]);

  /**
   * F0 (G3, 2026-09-03): honest `flow_completed`. The agent claims the
   * check-in is CLOSED in RFM; the kiosk PROVES it with completeSession()
   * (hard gate 409 CHECKOUT_NOT_CLOSED) BEFORE touching the screen, while
   * the overlay stays mounted and the session stays active.
   *   success → DONE (key handoff), countdown, overlay closed, plain ack,
   *             command marked applied.
   *   failure → screen unchanged, overlay/iframe alive, ack `refused:true`
   *             with an enum-like reason, 6s toast naming the pending step.
   *             NOT marked applied: a refused ack clears the command from
   *             Valet's queue (the agent issues a NEW one once the blocker is
   *             fixed); the same id only comes back if the ack was lost, and
   *             then we re-prove against /complete instead of blindly acking.
   * Fatal client errors (unpaired / offline) route like every other handler
   * (routeFatal) — the guest never reads "falta un paso" on a dead device.
   * Storm guard: toast + telemetry event fire once per conversation+command
   * (voziaRefusedIdsRef); silent re-proofs never fill eventsJson.
   * Conversation change mid-await (iframe reset / new identity / guest ✕)
   * does not bump genRef: on success the session DID complete → DONE, but
   * no applied-mark / toast / ack for the dead conversation; on failure →
   * nothing at all (after fatal routing, which is device truth).
   * The old behavior (DONE on ANY outcome + iframe unmount) could show
   * "listo" with nothing signed or paid and disconnect the agent.
   */
  const completeFromAgent = useCallback(async (cmd) => {
    const host = vozia?.host;
    const identity = voziaIdentityRef.current;
    const key = `${identity.conversationId}:${cmd.id}`;
    const gen = genRef.current;
    const sessionId = sessionRef.current?.id;
    const sameConversation = () => identity.conversationId === voziaIdentityRef.current.conversationId;
    const refuse = (decision) => {
      if (!sameConversation()) return;
      if (noteFirstRefusal(voziaRefusedIdsRef.current, key)) {
        const stepKey = voziaPendingStepKey(screenRef.current);
        setAgentToast(
          stepKey
            ? t('kiosk.voziaCompleteRefusedStep', { step: t(stepKey) })
            : t('kiosk.voziaCompleteRefused'),
          6000,
        );
        if (sessionId) {
          sendEvents(sessionId, { step: null, event: 'VOZIA_COMMAND_REFUSED', data: { command: 'flow_completed', reason: decision.reason } });
        }
      }
      ackKioskCommand(host, identity, cmd.id, decision);
    };

    if (!sessionId) {
      refuse(decideFlowCompletedAck({ ok: false, errorCode: 'NO_SESSION' }));
      return;
    }
    let out;
    try {
      out = await completeSession(sessionId);
    } catch (e) {
      if (gen !== genRef.current) return; // wiped mid-flight: no ack, no screen change
      const routed = routeFatal(e);
      if (!sameConversation()) return;
      const decision = decideFlowCompletedAck({ ok: false, errorCode: e?.code });
      if (routed) {
        // Device is on PAIRING / OUT_OF_SERVICE now — still tell the agent,
        // but no toast over a screen the guest can't act on.
        ackKioskCommand(host, identity, cmd.id, decision);
      } else {
        refuse(decision);
      }
      return;
    }
    if (gen !== genRef.current) return;
    // Server truth: the session is COMPLETED regardless of who is on the chat.
    setDoneData(out);
    setDoneCountdown(DONE_RESET_S);
    ui.setSessionActive(false);
    setScreen('DONE');
    setVoziaOpen(false);
    sendEvents(sessionId, { step: null, event: 'VOZIA_COMMAND_APPLIED', data: { command: 'flow_completed' } });
    if (!sameConversation()) return; // dead conversation: no applied-mark, no ack
    voziaAppliedIdsRef.current.add(cmd.id);
    ackKioskCommand(host, identity, cmd.id, null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [t, ui, routeFatal, setAgentToast, vozia?.host]);

  const onVoziaCommands = useCallback((commands, envelopeConversationId) => {
    const activeId = voziaIdentityRef.current.conversationId;
    if (!activeId) return;
    for (const cmd of commands) {
      if (!cmd || cmd.id == null || !cmd.command) continue;
      const cmdConversation = cmd.conversationId ?? envelopeConversationId ?? activeId;
      if (cmdConversation !== activeId) continue; // stale conversation — discard, no ack
      if (cmd.command === 'flow_completed' && !voziaAppliedIdsRef.current.has(cmd.id)) {
        // F0: the ack travels WITH the server's verdict (success or
        // refused:true) — never a blind ack, never applied before proof.
        // Either ack clears the command from Valet's queue; the same id only
        // shows up again if that ack was lost. After a success the id is in
        // the applied set and falls through to the plain ack below; after a
        // refusal it re-proves here (silently — see voziaRefusedIdsRef).
        const key = `${activeId}:${cmd.id}`;
        if (!voziaInFlightRef.current.has(key)) {
          voziaInFlightRef.current.add(key);
          completeFromAgent(cmd).finally(() => voziaInFlightRef.current.delete(key));
        }
        continue;
      }
      if (!voziaAppliedIdsRef.current.has(cmd.id)) {
        voziaAppliedIdsRef.current.add(cmd.id);
        applyAgentCommand(cmd);
        if (sessionRef.current?.id) {
          sendEvents(sessionRef.current.id, { step: null, event: 'VOZIA_COMMAND_APPLIED', data: { command: String(cmd.command).slice(0, 40) } });
        }
      }
      // Ack every delivery (fire-and-forget) — a lost ack self-heals on the
      // next redelivery because the apply above is idempotent by id.
      ackKioskCommand(vozia?.host, voziaIdentityRef.current, cmd.id);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [applyAgentCommand, completeFromAgent, vozia?.host]);

  const escalate = useCallback(async (reason) => {
    setHelpOpen(false);
    setErr('');
    const current = sessionRef.current;
    if (current?.id) {
      try { await escalateSession(current.id, reason); } catch (e) { if (routeFatal(e)) return; }
    }
    setEscalatedInfo({ reason });
    ui.setSessionActive(false);
    setScreen('ESCALATED');
  }, [routeFatal, ui]);

  // Get Help from any stuck state: VozIA embed when the device carries config
  // (B3f — Chloe has the SAME matcher via her service account, so the guest
  // doesn't repeat the lookup fight), else the escalate-to-staff flow.
  const openHelp = useCallback((reason) => {
    if (vozia?.host) {
      setVoziaOpen(true);
      if (sessionRef.current?.id) sendEvents(sessionRef.current.id, { step: null, event: 'VOZIA_OPENED' });
    } else {
      escalate(reason);
    }
  }, [vozia?.host, escalate]);

  // ── Flow actions ───────────────────────────────────────────────────────────

  const startPickup = async () => {
    const gen = genRef.current;
    setBusy(true); setErr('');
    try {
      const s = await createSession('PICKUP');
      if (gen !== genRef.current) return;
      ui.setOnline?.(true);
      setSession({ ...s, startedAtMs: Date.now() });
      ui.setSessionActive(true);
      setScreen('LOOKUP');
    } catch (e) {
      if (!routeFatal(e)) setErr(e.message || t('kiosk.genericError'));
    } finally { setBusy(false); }
  };

  const doLookup = async (payload) => {
    const gen = genRef.current;
    setBusy(true); setErr('');
    try {
      const out = await lookupReservation(session.id, payload);
      if (gen !== genRef.current) return;
      // B3g: multiple candidates → the server asks for ONE more datum (never
      // a list of reservations). Merge it into the base payload and re-submit.
      if (out?.status === 'NEEDS_MORE_INFO') {
        lookupBaseRef.current = payload;
        lookupRoundsRef.current += 1;
        // Cap the rounds sanely (the per-device lockout is the real backstop
        // — don't loop the guest forever): after 2 asks, offer Get Help/staff.
        setLookupNeeds(lookupRoundsRef.current > 2
          ? 'HELP'
          : (out.needs === 'lastName' ? 'lastName' : 'pickupDate'));
        return;
      }
      // Single match (exact or smart) → the masked stub. Keep the TYPED
      // confirmation number for the VozIA `res` param (B3f) — the masked stub
      // never carries it back (name/date path → none).
      setLookupNeeds(null);
      confirmationNumberRef.current = String(payload?.confirmationNumber || '');
      setStub(out);
      setScreen('SUMMARY');
    } catch (e) {
      if (gen !== genRef.current) return;
      if (routeFatal(e)) return;
      if (e.status === 429 || e.code === 'LOOKUP_LOCKED') {
        setLookupNeeds(null);
        setLookupLocked(true);
      } else if (e.code === 'RESERVATION_NOT_FOUND') {
        // Drop back to the full lookup screen so the guest can re-enter (a
        // disambiguation datum landing on 404 means the base was wrong too).
        setLookupNeeds(null);
        const left = e.data?.attemptsRemaining;
        setErr(Number.isFinite(Number(left))
          ? t('kiosk.lookupNotFoundAttempts', { count: Number(left) })
          : t('kiosk.lookupNotFound'));
      } else {
        setErr(e.message || t('kiosk.genericError'));
      }
    } finally { setBusy(false); }
  };

  // Re-submit with the extra disambiguation datum merged into the base.
  const submitLookupExtra = (extra) => doLookup({ ...(lookupBaseRef.current || {}), ...extra });

  const confirmSummary = async () => {
    const gen = genRef.current;
    setBusy(true); setErr('');
    try {
      const out = await attachReservation(session.id, stub.reservationId);
      if (gen !== genRef.current) return;
      setStub((prev) => ({ ...prev, ...out }));
      setScreen('ID');
    } catch (e) {
      if (gen !== genRef.current) return;
      if (!routeFatal(e)) setErr(e.message || t('kiosk.genericError'));
    } finally { setBusy(false); }
  };

  const submitVerify = async (selfieDataUrl) => {
    const gen = genRef.current;
    setBusy(true); setErr('');
    try {
      const out = await verifyId(session.id, {
        aamvaFields: aamva,
        licensePhoto: licensePhoto || undefined,
        selfiePhoto: selfieDataUrl || undefined,
      });
      if (gen !== genRef.current) return null;
      setVerifyResult(out);
      if (out?.verified) idVerifiedRef.current = true;
      if (out && !out.verified) {
        verifyAttemptsRef.current += 1;
        reportVoziaError(out.failureReasons?.includes('NAME_MISMATCH') ? 'ID_MISMATCH' : 'UNKNOWN');
      }
      return out;
    } catch (e) {
      if (gen !== genRef.current) return null;
      if (routeFatal(e)) return null;
      // 422 INVALID_PHOTO: junk/oversized image — retake, don't burn a verify
      // attempt on it.
      setErr(e.code === 'INVALID_PHOTO' ? t('kiosk.invalidPhoto') : (e.message || t('kiosk.genericError')));
      if (e.code === 'INVALID_PHOTO') reportVoziaError('GLARE_ERROR');
      return null;
    } finally { setBusy(false); }
  };

  /**
   * B3d — primary ID path: server-side OCR of the ID-front photo. Returns a
   * discriminated result so the ID screen can route each outcome (confirm /
   * retake / staff-assist / barcode fallback) without touching fetch.
   */
  const extractIdPhoto = async (photo) => {
    const gen = genRef.current;
    setBusy(true); setErr('');
    try {
      const out = await idPhotoExtract(session.id, photo);
      if (gen !== genRef.current) return { ok: false, code: 'STALE' };
      return { ok: true, fields: out?.fields || {}, warnings: Array.isArray(out?.warnings) ? out.warnings : [] };
    } catch (e) {
      if (gen !== genRef.current) return { ok: false, code: 'STALE' };
      if (routeFatal(e)) return { ok: false, code: 'FATAL' };
      if (e.status === 429 || e.code === 'EXTRACT_LIMIT') return { ok: false, code: 'EXTRACT_LIMIT' };
      // 503 = OCR down. 404 = backend without the endpoint yet (built in
      // parallel) — degrade the same way: barcode-scanner fallback.
      if (e.status === 503 || e.status === 404 || e.code === 'OCR_UNAVAILABLE') return { ok: false, code: 'OCR_UNAVAILABLE' };
      if (e.status === 422 || e.code === 'INVALID_PHOTO') return { ok: false, code: 'INVALID_PHOTO' };
      return { ok: false, code: 'ERROR', message: e.message };
    } finally { setBusy(false); }
  };

  /**
   * B3d — guest confirmed the extracted fields: run the EXISTING verify-id
   * NOW (fields + captured photo as licensePhoto — the backend persists the
   * photo and fills empty customer columns). Verified → SELFIE (which
   * re-submits verify-id with the selfie attached, as today). Failures keep
   * their existing handling (VerifyChecks + escalateSuggested).
   */
  const confirmIdFields = async (fields, photo) => {
    setAamva(fields);
    setLicensePhoto(photo || null);
    const gen = genRef.current;
    setBusy(true); setErr('');
    try {
      const out = await verifyId(session.id, { aamvaFields: fields, licensePhoto: photo || undefined });
      if (gen !== genRef.current) return null;
      setVerifyResult(out);
      if (out?.verified) {
        idVerifiedRef.current = true;
        setVerifyResult(null); // the selfie step starts fresh and re-verifies
        setSelfie(null);
        setScreen('SELFIE');
      } else if (out) {
        verifyAttemptsRef.current += 1;
        reportVoziaError(out.failureReasons?.includes('NAME_MISMATCH') ? 'ID_MISMATCH' : 'UNKNOWN');
      }
      return out;
    } catch (e) {
      if (gen !== genRef.current) return null;
      if (routeFatal(e)) return null;
      setErr(e.code === 'INVALID_PHOTO' ? t('kiosk.invalidPhoto') : (e.message || t('kiosk.genericError')));
      return null;
    } finally { setBusy(false); }
  };

  // ── B3c Staff Assist handlers (K-S1..S3) ───────────────────────────────────
  // The wizard never blocks on assist state: everything lives behind the
  // STAFF_ASSIST screen; exiting always lands back on staffAssistFrom.

  const openStaffAssist = (from, mode = 'FULL') => {
    setStaffAssistFrom(from);
    setStaffAssistMode(mode);
    setErr('');
    if (sessionRef.current?.id) sendEvents(sessionRef.current.id, { step: 'ID', event: 'STAFF_ASSIST_OPENED' });
    setScreen('STAFF_ASSIST');
  };

  const exitStaffAssist = (message) => {
    setErr(message || '');
    setScreen(staffAssistFrom);
  };

  const assistList = async () => {
    const gen = genRef.current;
    try {
      const out = await staffAssistList(session.id);
      if (gen !== genRef.current) return { ok: false, code: 'FATAL' };
      return { ok: true, staff: Array.isArray(out?.staff) ? out.staff : [] };
    } catch (e) {
      if (gen !== genRef.current || routeFatal(e)) return { ok: false, code: 'FATAL' };
      return { ok: false, code: e.code || 'ERROR', message: e.message };
    }
  };

  const assistUnlock = async (userId, pin) => {
    const gen = genRef.current;
    try {
      const out = await staffAssistUnlock(session.id, { userId, pin });
      if (gen !== genRef.current) return { ok: false, code: 'FATAL' };
      // The server records the canonical STAFF_ASSIST_UNLOCKED telemetry —
      // no client duplicate (funnel counts stay honest).
      return { ok: true, grant: out?.grant || null };
    } catch (e) {
      if (gen !== genRef.current || routeFatal(e)) return { ok: false, code: 'FATAL' };
      return {
        ok: false,
        code: e.code || (e.status === 429 ? 'STAFF_ASSIST_LOCKED' : 'ERROR'),
        attemptsRemaining: e.data?.attemptsRemaining,
        message: e.message,
      };
    }
  };

  const assistVerify = async (payload) => {
    const gen = genRef.current;
    try {
      const out = await staffAssistVerifyId(session.id, payload);
      if (gen !== genRef.current) return { ok: false, code: 'FATAL' };
      return { ok: true, ...out };
    } catch (e) {
      if (gen !== genRef.current || routeFatal(e)) return { ok: false, code: 'FATAL' };
      return { ok: false, code: e.code || 'ERROR', message: e.message };
    }
  };

  // B3e light bypass: staff attests the PHYSICAL license matches the guest —
  // fields/photo are the session's already-confirmed OCR values (no manual
  // re-entry, no re-photos). Server records STAFF_ASSIST_NAME_CONFIRMED.
  const assistConfirmName = async () => {
    const gen = genRef.current;
    try {
      const out = await staffAssistConfirmName(session.id, {
        fields: aamva || {},
        licensePhoto: licensePhoto || undefined,
      });
      if (gen !== genRef.current) return { ok: false, code: 'FATAL' };
      return { ok: true, ...out };
    } catch (e) {
      if (gen !== genRef.current || routeFatal(e)) return { ok: false, code: 'FATAL' };
      return { ok: false, code: e.code || 'ERROR', message: e.message };
    }
  };

  // ── B3e self-service name update (real mismatches only — the server's
  // token-subset matcher already passed the harmless cases) ──────────────────

  // Pre-send masked-destination preview. Best-effort nicety: ANY failure
  // (incl. an older backend without the endpoint) returns null and the flow
  // keeps its generic copy — never blocks the send.
  const nameUpdateDestinationsLoad = async () => {
    const gen = genRef.current;
    try {
      const out = await nameUpdateDestinations(session.id);
      if (gen !== genRef.current) return null;
      return out || null;
    } catch (e) {
      if (gen === genRef.current) routeFatal(e); // unpaired/offline still route
      return null;
    }
  };

  const nameUpdateSend = async () => {
    const gen = genRef.current;
    try {
      const out = await nameUpdateSendCode(session.id);
      if (gen !== genRef.current) return { ok: false, code: 'STALE' };
      // Telemetry (NAME_UPDATE_CODE_SENT) is recorded server-side.
      return { ok: true, sent: out?.sent || {}, expiresInMinutes: out?.expiresInMinutes };
    } catch (e) {
      if (gen !== genRef.current) return { ok: false, code: 'STALE' };
      if (routeFatal(e)) return { ok: false, code: 'FATAL' };
      return {
        ok: false,
        code: e.code || (e.status === 429 ? 'NAME_UPDATE_LOCKED' : 'ERROR'),
        // 429 NAME_UPDATE_COOLDOWN (server resend cooldown, distinct from the
        // hourly LOCKED cap) carries how long to wait.
        retryInSeconds: e.data?.retryInSeconds,
        message: e.message,
      };
    }
  };

  const nameUpdateConfirmCode = async (code) => {
    const gen = genRef.current;
    try {
      // Fields are the OCR-confirmed values held in state — never free text.
      const out = await nameUpdateConfirm(session.id, {
        code,
        fields: aamva || {},
        licensePhoto: licensePhoto || undefined,
      });
      if (gen !== genRef.current) return { ok: false, code: 'STALE' };
      if (out?.verified) idVerifiedRef.current = true;
      return { ok: true, ...out };
    } catch (e) {
      if (gen !== genRef.current) return { ok: false, code: 'STALE' };
      if (routeFatal(e)) return { ok: false, code: 'FATAL' };
      return {
        ok: false,
        code: e.code || (e.status === 429 ? 'NAME_UPDATE_LOCKED' : 'ERROR'),
        attemptsRemaining: e.data?.attemptsRemaining,
        message: e.message,
      };
    }
  };

  // K-S3 "Continue as guest": the session is IN_PROGRESS again with the ID
  // verified via STAFF_OVERRIDE — skip selfie and rejoin the wizard at the
  // next step (vehicle assign → OFFERS), exactly like a passed guest verify.
  const completeStaffAssist = async () => {
    idVerifiedRef.current = true; // reached only after a verified staff attest
    if (sessionRef.current?.id) sendEvents(sessionRef.current.id, { step: 'ID', event: 'STAFF_ASSIST_COMPLETED' });
    setEscalatedInfo(null);
    setVerifyResult(null);
    setErr('');
    ui.setSessionActive(true);
    await proceedAssign();
  };

  const proceedAssign = async () => {
    const gen = genRef.current;
    setBusy(true); setErr('');
    try {
      const out = await assignVehicle(session.id);
      if (gen !== genRef.current) return;
      setVehicle(out?.vehicle || null);
      // Offers + deposit line load on OFFERS entry.
      setScreen('OFFERS');
      loadOffers();
    } catch (e) {
      if (gen !== genRef.current) return;
      if (routeFatal(e)) return;
      if (e.code === 'NO_VEHICLE_AVAILABLE' || e.code === 'RESERVATION_NOT_OPEN' || e.code === 'NO_VEHICLE_CLASS') {
        setErr(t('kiosk.noVehicleAvailable'));
        await escalate('OTHER');
      } else {
        setErr(e.message || t('kiosk.genericError'));
      }
    } finally { setBusy(false); }
  };

  const loadOffers = async () => {
    const gen = genRef.current;
    try {
      const [offersOut, agreementOut] = await Promise.all([
        getOffers(sessionRef.current.id),
        getAgreement(sessionRef.current.id).catch(() => null),
      ]);
      if (gen !== genRef.current) return;
      setOffers(offersOut);
      if (agreementOut) setAgreement(agreementOut);
    } catch (e) {
      if (gen !== genRef.current) return;
      if (!routeFatal(e)) setErr(e.message || t('kiosk.genericError'));
    }
  };

  const chooseOffer = async (serviceIds) => {
    const gen = genRef.current;
    setBusy(true); setErr('');
    try {
      await acceptOffers(session.id, serviceIds);
      const agreementOut = await getAgreement(session.id).catch(() => null);
      if (gen !== genRef.current) return;
      if (agreementOut) setAgreement(agreementOut);
      setPayState('IDLE');
      setScreen('PAYMENT');
    } catch (e) {
      if (gen !== genRef.current) return;
      if (!routeFatal(e)) setErr(e.message || t('kiosk.genericError'));
    } finally { setBusy(false); }
  };

  const simulatePayment = async () => {
    const gen = genRef.current;
    setBusy(true); setErr('');
    try {
      await sandboxPayment(session.id);
      if (gen !== genRef.current) return;
      setPayState('PAID');
      const agreementOut = await getAgreement(session.id).catch(() => null);
      if (gen !== genRef.current) return;
      if (agreementOut) setAgreement(agreementOut);
      setScreen('SIGN');
    } catch (e) {
      if (gen !== genRef.current) return;
      if (routeFatal(e)) return;
      if (e.code === 'SANDBOX_DISABLED') setPayState('DISABLED');
      else {
        setPayState('FAILED');
        setErr(e.message || t('kiosk.genericError'));
        reportVoziaError('CARD_DECLINED');
      }
    } finally { setBusy(false); }
  };

  const finishComplete = async () => {
    const gen = genRef.current;
    const out = await completeSession(session.id);
    if (gen !== genRef.current) return;
    setDoneData(out);
    setDoneCountdown(DONE_RESET_S);
    ui.setSessionActive(false);
    setScreen('DONE');
  };

  const submitSign = async ({ sectionInitials, signature }) => {
    const gen = genRef.current;
    setBusy(true); setErr('');
    try {
      await signAgreement(session.id, { sectionInitials, signature, signerName: null });
      await finishComplete();
    } catch (e) {
      if (gen !== genRef.current) return;
      if (routeFatal(e)) return;
      if (e.code === 'CHECKOUT_TERMINAL') {
        // Already closed (retried sign) — advance to keys, same convention as
        // the counter wizard.
        try { await finishComplete(); } catch (e2) { if (!routeFatal(e2)) setErr(e2.message || t('kiosk.genericError')); }
      } else if (e.code === 'PAYMENT_REQUIRED') {
        setErr(t('kiosk.signPaymentRequired'));
        setPayState('IDLE');
        setScreen('PAYMENT');
      } else if (e.code === 'ID_VERIFY_REQUIRED') {
        setErr(t('kiosk.signIdVerifyRequired'));
        setScreen('ID');
      } else {
        setErr(e.message || t('kiosk.genericError'));
      }
    } finally { setBusy(false); }
  };

  // ── Render ─────────────────────────────────────────────────────────────────

  const progress = PROGRESS_OF[screen] || 0;

  return (
    <>
      {progress > 0 ? <ProgressSteps t={t} current={progress} /> : null}

      {screen === 'BOOT' ? <div className="kio-main center" /> : null}
      {/* Someone is helping this guest from somewhere else, and they are told so.
          An in-person assist announces itself — a person is standing there. Remotely
          nothing does, and with three roles able to open a permission, this banner is
          the only thing between "someone is helping me" and "something happened to my
          account without my knowing". Rendered above every screen because the guest may
          be on any of them while it is open. */}
      {assistNotice?.open ? (
        <div className="kio-assist-notice" role="status" aria-live="polite">
          <span aria-hidden="true">👤</span>
          <span>
            {assistNotice.helperName
              ? t('kiosk.assistNoticeNamed', { name: assistNotice.helperName })
              : t('kiosk.assistNotice')}
          </span>
        </div>
      ) : null}

      {screen === 'PAIRING' ? (
        <PairingScreen t={t} busy={busy} setBusy={setBusy} onPaired={(device) => { ui.setDevice(device); setScreen('WELCOME'); }} routeFatal={routeFatal} />
      ) : null}
      {screen === 'WELCOME' ? (
        <WelcomeScreen
          t={t}
          busy={busy}
          walkupEnabled={ui.device?.walkupEnabled !== false}
          onPickup={startPickup}
          onWalkup={() => {
            setScreen('WALKUP_SOON');
            if (sessionRef.current?.id) sendEvents(sessionRef.current.id, { step: 'WELCOME', event: 'WALKUP_COMING_SOON_SHOWN' });
          }}
          err={err}
        />
      ) : null}
      {screen === 'WALKUP_SOON' ? (
        <div className="kio-main center">
          <div className="kio-h2">🚗 {t('kiosk.walkupSoonTitle')}</div>
          <p className="kio-sub">{t('kiosk.walkupSoonBody')}</p>
          <button type="button" className="kio-btn ghost" onClick={resetAll}>‹ {t('kiosk.back')}</button>
        </div>
      ) : null}
      {screen === 'LOOKUP' ? (
        lookupLocked ? (
          <div className="kio-main center">
            <div className="kio-h2">{t('kiosk.lookupLockedTitle')}</div>
            <p className="kio-sub">{t('kiosk.lookupLockedBody')}</p>
            <div className="kio-row">
              <button type="button" className="kio-btn sm" onClick={() => openHelp('LOOKUP_FAILED')}>🎧 {t('kiosk.getHelp')}</button>
              <button type="button" className="kio-btn ghost sm" onClick={resetAll}>{t('kiosk.startOver')}</button>
            </div>
          </div>
        ) : lookupNeeds === 'HELP' ? (
          <div className="kio-main center">
            <div className="kio-h2">{t('kiosk.lookupTooManyTitle')}</div>
            <p className="kio-sub">{t('kiosk.lookupTooManyBody')}</p>
            <div className="kio-row">
              <button type="button" className="kio-btn sm" onClick={() => openHelp('LOOKUP_FAILED')}>🎧 {t('kiosk.getHelp')}</button>
              <button type="button" className="kio-btn ghost sm" onClick={() => { setLookupNeeds(null); lookupRoundsRef.current = 0; setErr(''); }}>{t('kiosk.startOver')}</button>
            </div>
          </div>
        ) : lookupNeeds ? (
          <LookupDisambiguation
            key={`lookupdisambig-${lookupNeeds}`}
            t={t}
            needs={lookupNeeds}
            repeat={lookupRoundsRef.current > 1}
            busy={busy}
            err={err}
            onSubmit={submitLookupExtra}
            onBack={() => { setLookupNeeds(null); setErr(''); }}
          />
        ) : (
          <LookupScreen key={`lookupscreen-${stepEpoch}`} t={t} busy={busy} err={err} onSubmit={doLookup} onBack={resetAll} />
        )
      ) : null}
      {screen === 'SUMMARY' && stub ? (
        <div className="kio-main">
          <div className="kio-h2">{t('kiosk.summaryTitle', { name: stub.maskedName || '' })}</div>
          <div className="kio-panel" style={{ maxWidth: 640 }}>
            <div className="kio-kv"><span className="kio-l">{t('kiosk.summaryDriver')}</span><b>{stub.maskedName || '—'}</b></div>
            <div className="kio-kv">
              <span className="kio-l">{t('kiosk.summaryDates')}</span>
              <b>{fmtDateTime(stub.pickupWindow?.pickupAt)} → {fmtDateTime(stub.pickupWindow?.returnAt)}</b>
            </div>
            <div className="kio-kv"><span className="kio-l">{t('kiosk.summaryClass')}</span><b>{stub.vehicleClassName || '—'}</b></div>
            {stub.channel ? (
              <div className="kio-kv"><span className="kio-l">{t('kiosk.summaryChannel')}</span><b>{stub.channel}</b></div>
            ) : null}
          </div>
          {err ? <div className="kio-error">{err}</div> : null}
          <div className="kio-row" style={{ marginTop: 22 }}>
            <button type="button" className="kio-btn" disabled={busy} onClick={confirmSummary}>{t('kiosk.summaryThatsMe')} ›</button>
            <button
              type="button"
              className="kio-btn ghost sm"
              disabled={busy}
              onClick={() => { setStub(null); setErr(''); setScreen('LOOKUP'); }}
            >
              {t('kiosk.summaryNotMine')}
            </button>
          </div>
        </div>
      ) : null}
      {screen === 'ID' ? (
        <IdScreen
          key={`idscreen-${stepEpoch}`}
          t={t}
          busy={busy}
          err={err}
          verifyResult={verifyResult}
          clearVerify={() => { setVerifyResult(null); setErr(''); }}
          track={(event) => { if (sessionRef.current?.id) sendEvents(sessionRef.current.id, { step: 'ID', event }); }}
          onExtract={extractIdPhoto}
          onConfirm={confirmIdFields}
          onScanned={(fields) => { setAamva(fields); setVerifyResult(null); setErr(''); setSelfie(null); setScreen('SELFIE'); }}
          onScannerPhoto={(dataUrl) => setLicensePhoto(dataUrl)}
          onEscalate={() => escalate(verifyResult?.failureReasons?.includes('NAME_MISMATCH') ? 'ID_MISMATCH' : 'ID_SCAN_FAILED')}
          onStaffAssist={() => openStaffAssist('ID')}
          onStaffAssistName={() => openStaffAssist('ID', 'NAME')}
          onNameUpdate={() => { setErr(''); setScreen('NAME_UPDATE'); }}
          onBack={() => setScreen('SUMMARY')}
        />
      ) : null}
      {screen === 'NAME_UPDATE' && session ? (
        <NameUpdateFlow
          key={`nameupdateflow-${stepEpoch}`}
          t={t}
          onSendCode={nameUpdateSend}
          onGetDestinations={nameUpdateDestinationsLoad}
          onConfirmCode={nameUpdateConfirmCode}
          onSuccess={() => {
            // idVerifiedAt is stamped server-side (SCAN_NAME_UPDATED) and the
            // reservation now carries the license name → selfie as usual.
            setVerifyResult(null);
            setSelfie(null);
            setErr('');
            setScreen('SELFIE');
          }}
          onHelp={() => escalate('ID_MISMATCH')}
          onExit={(message) => { setErr(message || ''); setScreen('ID'); }}
        />
      ) : null}
      {screen === 'SELFIE' ? (
        <SelfieScreen
          key={`selfiescreen-${stepEpoch}`}
          t={t}
          busy={busy}
          err={err}
          selfie={selfie}
          setSelfie={setSelfie}
          verifyResult={verifyResult}
          onSubmit={async (dataUrl) => {
            const out = await submitVerify(dataUrl);
            if (out?.verified) return; // result panel + continue button render from verifyResult
            if (out && out.escalateSuggested) { /* K-E3 renders from verifyResult */ }
          }}
          onContinue={proceedAssign}
          onRetryScan={() => { setVerifyResult(null); setErr(''); setScreen('ID'); }}
          onEscalate={() => escalate(verifyResult?.failureReasons?.includes('NAME_MISMATCH') ? 'ID_MISMATCH' : 'ID_SCAN_FAILED')}
          onStaffAssist={() => openStaffAssist('SELFIE')}
        />
      ) : null}
      {screen === 'OFFERS' ? (
        <OffersScreen
          key={`offersscreen-${stepEpoch}`}
          t={t}
          busy={busy}
          err={err}
          offers={offers}
          agreement={agreement}
          maskedName={stub?.maskedName}
          onChoose={chooseOffer}
        />
      ) : null}
      {screen === 'PAYMENT' ? (
        <PaymentScreen
          t={t}
          busy={busy}
          err={err}
          agreement={agreement}
          payState={payState}
          onSimulate={simulatePayment}
          onHelp={() => escalate('PAYMENT_TROUBLE')}
          onBack={() => { setErr(''); setScreen('OFFERS'); loadOffers(); }}
        />
      ) : null}
      {screen === 'SIGN' ? (
        <SignScreen
          key={`signscreen-${stepEpoch}`}
          t={t}
          busy={busy}
          err={err}
          sessionId={session?.id}
          agreement={agreement}
          setAgreement={setAgreement}
          vehicle={vehicle}
          stub={stub}
          fmtDateTime={fmtDateTime}
          onSubmit={submitSign}
          routeFatal={routeFatal}
        />
      ) : null}
      {screen === 'DONE' ? (
        <DoneScreen
          t={t}
          doneData={doneData}
          vehicle={vehicle}
          maskedName={stub?.maskedName}
          startedAtMs={session?.startedAtMs}
          countdown={doneCountdown}
        />
      ) : null}
      {screen === 'ESCALATED' ? (
        <div className="kio-main center">
          <div className="kio-h2">🎧 {t('kiosk.escalatedTitle')}</div>
          <p className="kio-sub">{t('kiosk.escalatedBody')}</p>
          <button type="button" className="kio-btn ghost" onClick={resetAll}>{t('kiosk.startOver')}</button>
          {/* Employee-facing entry (B3c) — deliberately discreet, not a guest CTA. */}
          {session ? (
            <div style={{ marginTop: 22 }}>
              <button type="button" className="kio-btn back" onClick={() => openStaffAssist('ESCALATED')}>
                🔧 {t('kiosk.assistEntry')}
              </button>
            </div>
          ) : null}
        </div>
      ) : null}
      {screen === 'STAFF_ASSIST' && session ? (
        <StaffAssistScreen
          key={`staffassistscreen-${stepEpoch}`}
          t={t}
          prefillFields={aamva || undefined}
          nameContext={staffAssistMode === 'NAME' ? {
            licenseName: [aamva?.firstName, aamva?.lastName].filter(Boolean).join(' ') || '—',
            reservationName: stub?.maskedName || '—',
          } : null}
          onList={assistList}
          onUnlock={assistUnlock}
          onVerify={assistVerify}
          onConfirmName={assistConfirmName}
          onCompleted={completeStaffAssist}
          onExit={exitStaffAssist}
        />
      ) : null}
      {screen === 'OUT_OF_SERVICE' ? (
        <div className="kio-main center">
          <div className="kio-h1" style={{ fontSize: 30 }}>😴 {t('kiosk.outOfServiceTitle')}</div>
          <p className="kio-sub">{t('kiosk.outOfServiceBody')}</p>
          <button type="button" className="kio-btn back" onClick={resetAll}>{t('kiosk.tryAgain')}</button>
        </div>
      ) : null}

      {helpOpen ? (
        <div className="kio-overlay">
          <div className="kio-overlay-card">
            <div className="kio-h2">🎧 {t('kiosk.helpTitle')}</div>
            <p className="kio-sub" style={{ margin: '0 auto 20px' }}>
              {session && screen !== 'DONE' && screen !== 'ESCALATED'
                ? t('kiosk.helpBodySession')
                : t('kiosk.helpBodyNoSession')}
            </p>
            <div className="kio-row">
              {session && screen !== 'DONE' && screen !== 'ESCALATED' ? (
                <button type="button" className="kio-btn sm" onClick={() => escalate('CUSTOMER_REQUEST')}>
                  {t('kiosk.helpCallStaff')}
                </button>
              ) : null}
              <button type="button" className="kio-btn ghost sm" onClick={() => setHelpOpen(false)}>
                {t('kiosk.helpKeepGoing')}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {/* B3f — VozIA "Get Help" embed (only when the device carries config). */}
      {voziaOpen && vozia?.host ? (
        <VoziaHelpOverlay
          t={t}
          vozia={vozia}
          locationId={ui.device?.locationId}
          reservationNumber={stub ? confirmationNumberRef.current : ''}
          hasConversation={voziaConvActive}
          onConversation={onVoziaConversation}
          onCommands={onVoziaCommands}
          onActivity={() => ui.noteActivity?.()}
          onClose={() => {
            // kiosk=1 is zero-persistence: unmounting the iframe ends the
            // conversation for good — discard the identity refs immediately
            // (the iframe's own end-call is its side of the contract).
            voziaIdentityRef.current = { conversationId: null, secret: null };
            voziaAppliedIdsRef.current = new Set();
            voziaRefusedIdsRef.current = new Set(); // QA MINOR-1: refusal keys are per conversation too
            // The reported step dies with the identity HERE too — this is the third wipe site and
            // the only one that does not go through a session wipe, so a stale step could otherwise
            // ride into the NEXT conversation and report the previous guest's position as this
            // guest's. Same reason the secret is discarded on this line. (Caught by the caller test.)
            lastVoziaStepRef.current = null;
            setVoziaConvActive(false);
            // Innovation F1 MUST-CHANGE: unmounting the iframe ends the chat, but
            // the wizard session keeps running underneath — without this the row
            // keeps its voziaConversationId and the agent goes on reading this
            // guest's timeline and truth after they closed the conversation.
            bindVoziaConv(null);
            setVoziaOpen(false);
          }}
        />
      ) : null}

      {/* Agent show_message banner — outlives the chat overlay (zIndex above it). */}
      {agentMsg ? (
        <div className="kio-overlay" style={{ zIndex: 80, alignItems: 'flex-start', paddingTop: 90 }}>
          <div className="kio-overlay-card" style={{ maxWidth: 620 }}>
            <div className="kio-h2" style={{ fontSize: 20 }}>💬 {t('kiosk.voziaAgentMsgTitle')}</div>
            <p className="kio-sub" style={{ margin: '6px auto 18px' }}>{agentMsg}</p>
            <button type="button" className="kio-btn sm" onClick={() => setAgentMsg('')}>{t('kiosk.ok')}</button>
          </div>
        </div>
      ) : null}

      {/* Transient agent-action toast — auto-dismisses, never blocks.
          Anchored at the TOP (mockup pattern, clear of the overlay's 48px ✕
          at top:10): the Valet iframe underneath keeps its composer and the
          agent's latest bubble at the bottom, where a 6s toast would sit
          right on top of what the guest needs to read. */}
      {agentToast ? (
        <div role="status" aria-live="polite" style={{ position: 'absolute', left: 0, right: 0, top: 84, display: 'flex', justifyContent: 'center', zIndex: 85, pointerEvents: 'none' }}>
          <div style={{ background: 'rgba(33,26,56,.92)', color: '#fff', borderRadius: 999, padding: '12px 22px', fontWeight: 750, fontSize: 15, boxShadow: '0 10px 24px rgba(35,21,80,.35)', maxWidth: '86%', textAlign: 'center' }}>
            {agentToast.text}
          </div>
        </div>
      ) : null}
    </>
  );
}

// ── Screen components ─────────────────────────────────────────────────────────

function ProgressSteps({ t, current }) {
  const labels = [
    t('kiosk.stepReservation'),
    t('kiosk.stepId'),
    t('kiosk.stepExtras'),
    t('kiosk.stepPayment'),
    t('kiosk.stepSign'),
  ];
  return (
    <div className="kio-steps">
      {labels.map((label, idx) => {
        const n = idx + 1;
        const cls = n < current ? 'done' : n === current ? 'on' : '';
        return (
          <span key={label} style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
            {idx > 0 ? <span className="kio-ln" /> : null}
            <span className={`kio-stp ${cls}`}>
              <span className="kio-dot">{n < current ? '✓' : n}</span> {label}
            </span>
          </span>
        );
      })}
    </div>
  );
}

function PairingScreen({ t, busy, setBusy, onPaired, routeFatal }) {
  const [code, setCode] = useState('');
  const [msg, setMsg] = useState('');

  const press = (k) => {
    setMsg('');
    if (k === 'back') setCode((c) => c.slice(0, -1));
    else if (code.length < 6) setCode((c) => c + k);
  };

  const submit = async () => {
    if (code.length !== 6 || busy) return;
    setBusy(true); setMsg('');
    try {
      const out = await pairDevice(code);
      onPaired(out.device);
    } catch (e) {
      if (e?.code === KIOSK_ERR_NETWORK) { routeFatal(e); return; }
      setCode('');
      setMsg(e?.code === 'PAIRING_LOCKED' ? t('kiosk.pairLocked') : t('kiosk.pairInvalid'));
    } finally { setBusy(false); }
  };

  return (
    <div className="kio-main center">
      <div className="kio-h2">{t('kiosk.pairTitle')}</div>
      <p className="kio-sub">{t('kiosk.pairBody')}</p>
      <div className={`kio-field ${code ? '' : 'ph'}`}>
        {code ? code.replace(/./g, '● ').trim() : t('kiosk.pairPlaceholder')}
      </div>
      <div className="kio-keypad">
        {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((k) => (
          <button key={k} type="button" className="kio-key" onClick={() => press(k)}>{k}</button>
        ))}
        <span />
        <button type="button" className="kio-key" onClick={() => press('0')}>0</button>
        <button type="button" className="kio-key" aria-label={t('kiosk.keypadDelete')} onClick={() => press('back')}>⌫</button>
      </div>
      {msg ? <div className="kio-error">{msg}</div> : null}
      <button
        type="button"
        className="kio-btn"
        style={{ marginTop: 18 }}
        disabled={code.length !== 6 || busy}
        onClick={submit}
      >
        {t('kiosk.pairSubmit')}
      </button>
    </div>
  );
}

function WelcomeScreen({ t, busy, walkupEnabled, onPickup, onWalkup, err }) {
  return (
    <div className="kio-main center">
      <div className="kio-h1">{t('kiosk.welcomeTitle')}</div>
      <p className="kio-sub">{t('kiosk.welcomeSub')}</p>
      <div className="kio-choice2" style={!walkupEnabled ? { gridTemplateColumns: '1fr', maxWidth: 460 } : undefined}>
        <button type="button" className="kio-bigcard hot" disabled={busy} onClick={onPickup}>
          <div className="kio-ic">🔑</div>
          <b>{t('kiosk.welcomePickupTitle')}</b>
          <span>{t('kiosk.welcomePickupSub')}</span>
        </button>
        {walkupEnabled ? (
          <button type="button" className="kio-bigcard" disabled={busy} onClick={onWalkup}>
            <div className="kio-ic">🚗</div>
            <b>{t('kiosk.welcomeWalkupTitle')}</b>
            <span>{t('kiosk.welcomeWalkupSub')}</span>
          </button>
        ) : null}
      </div>
      {err ? <div className="kio-error">{err}</div> : null}
    </div>
  );
}

// Alphanumeric confirmation keypad (mockup K2: digits + ABC toggle + ⌫).
// Local-time YYYY-MM-DD (the kiosk sits in the store's timezone).
function localISODate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * Friendly pickup-date chooser (B3g): big Today / Tomorrow buttons + a
 * "pick a date" reveal. Guests often lack phone/email on file, so the date
 * is the PRIMARY disambiguator.
 */
function PickupDateChooser({ t, value, onChange }) {
  const [custom, setCustom] = useState(false);
  const today = localISODate(new Date());
  const tomorrow = localISODate(new Date(Date.now() + 86400000));
  const btn = (iso, label) => (
    <button
      type="button"
      className={value === iso ? 'kio-btn sm' : 'kio-btn ghost sm'}
      onClick={() => { setCustom(false); onChange(iso); }}
    >
      {label}
    </button>
  );
  return (
    <div style={{ display: 'grid', gap: 10, justifyItems: 'center' }}>
      <div className="kio-row">
        {btn(today, t('kiosk.lookupDateToday'))}
        {btn(tomorrow, t('kiosk.lookupDateTomorrow'))}
        <button
          type="button"
          className={custom ? 'kio-btn sm' : 'kio-btn ghost sm'}
          onClick={() => setCustom(true)}
        >
          {t('kiosk.lookupDatePick')}
        </button>
      </div>
      {custom ? (
        <input
          className="kio-input"
          type="date"
          value={value && value !== today && value !== tomorrow ? value : ''}
          onChange={(e) => onChange(e.target.value)}
          style={{ maxWidth: 240, textAlign: 'center' }}
        />
      ) : null}
    </div>
  );
}

function LookupScreen({ t, busy, err, onSubmit, onBack }) {
  const [mode, setMode] = useState('confirmation'); // confirmation | name
  const [alpha, setAlpha] = useState(false);
  const [value, setValue] = useState('');
  const [lastName, setLastName] = useState('');
  const [byDate, setByDate] = useState(true); // date (primary) vs phone (secondary)
  const [pickupDate, setPickupDate] = useState('');
  const [phone, setPhone] = useState('');
  const [qrNote, setQrNote] = useState(false);

  const press = (k) => {
    if (k === 'back') setValue((v) => v.slice(0, -1));
    else if (value.length < 24) setValue((v) => v + k);
  };

  const digitKeys = ['1', '2', '3', '4', '5', '6', '7', '8', '9'];
  const letterKeys = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ-'.split('');

  return (
    <div className="kio-main">
      <div className="kio-h2">{t('kiosk.lookupTitle')}</div>
      <p className="kio-sub">{t('kiosk.lookupSub')}</p>

      {mode === 'confirmation' ? (
        <>
          <div className="kio-choice2" style={{ maxWidth: 860, alignItems: 'start' }}>
            <button type="button" className="kio-bigcard" onClick={() => setQrNote(true)}>
              <div className="kio-ic">📱</div>
              <b>{t('kiosk.lookupScanQr')}</b>
              <span>{qrNote ? t('kiosk.lookupScanQrSoon') : t('kiosk.lookupScanQrSub')}</span>
            </button>
            <div className="kio-bigcard hot" style={{ cursor: 'default' }}>
              <div className={`kio-field ${value ? '' : 'ph'}`} style={{ minWidth: 0 }}>
                {value || t('kiosk.lookupPlaceholder')}
              </div>
              <div className={`kio-keypad ${alpha ? 'wide' : ''}`}>
                {(alpha ? letterKeys : digitKeys).map((k) => (
                  <button key={k} type="button" className="kio-key" onClick={() => press(k)}>{k}</button>
                ))}
                <button type="button" className="kio-key" style={{ fontSize: 14 }} onClick={() => setAlpha((a) => !a)}>
                  {alpha ? '123' : 'ABC'}
                </button>
                {!alpha ? <button type="button" className="kio-key" onClick={() => press('0')}>0</button> : null}
                <button type="button" className="kio-key" aria-label={t('kiosk.keypadDelete')} onClick={() => press('back')}>⌫</button>
              </div>
            </div>
          </div>
          {err ? <div className="kio-error">{err}</div> : null}
          <div className="kio-row" style={{ marginTop: 16 }}>
            <button
              type="button"
              className="kio-btn"
              disabled={!value.trim() || busy}
              onClick={() => onSubmit({ confirmationNumber: value.trim() })}
            >
              {t('kiosk.lookupFind')} ›
            </button>
          </div>
          <div style={{ marginTop: 12 }}>
            <button type="button" className="kio-btn ghost sm" onClick={() => setMode('name')}>
              {t('kiosk.lookupByName')} ›
            </button>
          </div>
        </>
      ) : (
        <>
          <p className="kio-sub" style={{ marginTop: -8, fontSize: 15 }}>{t('kiosk.lookupByNameSub')}</p>
          <div className="kio-panel" style={{ maxWidth: 520 }}>
            <div style={{ display: 'grid', gap: 14 }}>
              <input
                className="kio-input"
                placeholder={t('kiosk.lookupLastName')}
                value={lastName}
                autoComplete="off"
                onChange={(e) => setLastName(e.target.value)}
              />
              {byDate ? (
                <div style={{ display: 'grid', gap: 8, justifyItems: 'center' }}>
                  <div className="kio-l" style={{ fontSize: 14 }}>{t('kiosk.lookupWhichDay')}</div>
                  <PickupDateChooser t={t} value={pickupDate} onChange={setPickupDate} />
                  <button type="button" className="kio-btn back" style={{ marginTop: 2 }} onClick={() => { setByDate(false); setPickupDate(''); }}>
                    {t('kiosk.lookupUsePhone')}
                  </button>
                </div>
              ) : (
                <div style={{ display: 'grid', gap: 8, justifyItems: 'center' }}>
                  <input
                    className="kio-input"
                    placeholder={t('kiosk.lookupPhone')}
                    value={phone}
                    inputMode="tel"
                    autoComplete="off"
                    onChange={(e) => setPhone(e.target.value)}
                  />
                  <button type="button" className="kio-btn back" onClick={() => { setByDate(true); setPhone(''); }}>
                    {t('kiosk.lookupUseDate')}
                  </button>
                </div>
              )}
            </div>
          </div>
          {err ? <div className="kio-error">{err}</div> : null}
          <div className="kio-row" style={{ marginTop: 16 }}>
            <button
              type="button"
              className="kio-btn"
              disabled={busy || !lastName.trim() || (byDate ? !pickupDate : !phone.trim())}
              onClick={() => onSubmit(byDate
                ? { lastName: lastName.trim(), pickupDate }
                : { lastName: lastName.trim(), phone: phone.trim() })}
            >
              {t('kiosk.lookupFind')} ›
            </button>
            <button type="button" className="kio-btn ghost sm" onClick={() => setMode('confirmation')}>
              {t('kiosk.lookupUseConfirmation')}
            </button>
          </div>
        </>
      )}

      <div style={{ marginTop: 18 }}>
        <button type="button" className="kio-btn back" onClick={onBack}>‹ {t('kiosk.back')}</button>
      </div>
    </div>
  );
}

/**
 * B3g disambiguation (K2b): the server found MORE THAN ONE candidate and asks
 * for ONE more datum — never a list of reservations. Calm, single-question.
 */
function LookupDisambiguation({ t, needs, repeat, busy, err, onSubmit, onBack }) {
  const [pickupDate, setPickupDate] = useState('');
  const [lastName, setLastName] = useState('');
  const isDate = needs === 'pickupDate';
  const ready = isDate ? !!pickupDate : !!lastName.trim();
  // Round 2+: a distinct reassuring title so the guest knows their first
  // answer registered (instead of re-showing "We found more than one").
  const title = repeat
    ? t('kiosk.lookupAlmostThere')
    : (isDate ? t('kiosk.lookupNeedDateTitle') : t('kiosk.lookupNeedNameTitle'));
  return (
    <div className="kio-main center">
      <div className="kio-h2">{title}</div>
      <p className="kio-sub">{isDate ? t('kiosk.lookupNeedDateBody') : t('kiosk.lookupNeedNameBody')}</p>
      <div className="kio-panel" style={{ maxWidth: 460, textAlign: 'center' }}>
        {isDate ? (
          <PickupDateChooser t={t} value={pickupDate} onChange={setPickupDate} />
        ) : (
          <input
            className="kio-input"
            placeholder={t('kiosk.lookupLastName')}
            value={lastName}
            autoComplete="off"
            onChange={(e) => setLastName(e.target.value)}
          />
        )}
      </div>
      {err ? <div className="kio-error">{err}</div> : null}
      <div className="kio-row" style={{ marginTop: 16 }}>
        <button
          type="button"
          className="kio-btn"
          disabled={busy || !ready}
          onClick={() => onSubmit(isDate ? { pickupDate } : { lastName: lastName.trim() })}
        >
          {t('kiosk.lookupFind')} ›
        </button>
        <button type="button" className="kio-btn back" onClick={onBack}>‹ {t('kiosk.back')}</button>
      </div>
    </div>
  );
}

/**
 * B3d ID step (2026-07-05, Hector's iPad verdict): PHOTO-CAPTURE is the
 * PRIMARY path — front camera (mirrored preview / raw capture), "I'm ready"
 * → 5s countdown → server-side OCR (POST id-photo-extract) → confirmation
 * panel (no guest editing: wrong data → retake or staff). The pdf417 barcode
 * scanner remains the SECONDARY path ("Scan the barcode instead" — it still
 * works great on Android kiosks), with its upload fallback intact.
 */
function IdScreen({ t, busy, err, verifyResult, clearVerify, track, onExtract, onConfirm, onScanned, onScannerPhoto, onEscalate, onStaffAssist, onStaffAssistName, onNameUpdate, onBack }) {
  const videoRef = useRef(null);
  const streamRef = useRef(null);
  const fileRef = useRef(null);
  const [mode, setMode] = useState('photo'); // photo (primary) | scanner (secondary)
  const [phase, setPhase] = useState('camera'); // camera | countdown | extracting | confirm | limit
  const [count, setCount] = useState(5);
  const [cameraOn, setCameraOn] = useState(false);
  const [cameraFailed, setCameraFailed] = useState(false);
  const [photo, setPhoto] = useState(null);
  const [fields, setFields] = useState(null);
  const [warnings, setWarnings] = useState([]);
  const [localErr, setLocalErr] = useState('');
  // Raw getUserMedia error name — shown in small muted text so we can debug
  // remotely through Hector (NotAllowedError vs NotReadableError vs Abort…).
  const [camDiag, setCamDiag] = useState('');
  const unmountedRef = useRef(false);
  useEffect(() => () => { unmountedRef.current = true; }, []);

  const stopCam = useCallback(() => {
    try { streamRef.current?.getTracks?.().forEach((track_) => track_.stop()); } catch {}
    streamRef.current = null;
    if (videoRef.current) {
      try { videoRef.current.pause(); } catch {}
      try { videoRef.current.srcObject = null; } catch {}
    }
    setCameraOn(false);
  }, []);

  // iPad fix: called from TAP handlers — acquireCameraStream reaches
  // getUserMedia with no awaits in between, keeping the gesture context iOS
  // wants for the first (permission-prompting) start. In-flight guarding and
  // orphaned-stream cleanup live in the shared helper.
  const startCam = useCallback(async () => {
    setCameraFailed(false);
    setCamDiag('');
    const out = await acquireCameraStream({
      facingMode: 'user',
      isCancelled: () => unmountedRef.current,
    });
    if (out.error) {
      if (out.error.name === CAMERA_ERR_IN_FLIGHT || out.error.name === 'Cancelled') return;
      setCameraFailed(true);
      setCamDiag(out.error.name + (out.error.message ? `: ${out.error.message}` : ''));
      return;
    }
    streamRef.current = out.stream;
    setCameraOn(true);
    // Best-effort immediate attach (video may already be mounted on retakes).
    setTimeout(() => {
      if (videoRef.current && streamRef.current && videoRef.current.srcObject !== streamRef.current) {
        videoRef.current.srcObject = streamRef.current;
        videoRef.current.play().catch(() => {});
      }
    }, 0);
  }, []);

  // iPad black-video fix: the <video> renders conditionally on cameraOn, and
  // the setTimeout(0) above can fire BEFORE React commits it on slow WebKit —
  // videoRef.current is null, the attach silently skips, and the guest sees a
  // live track feeding nothing (black box). A callback ref attaches the stream
  // at the exact moment the node mounts — no race possible.
  const attachVideo = useCallback((node) => {
    videoRef.current = node;
    if (node && streamRef.current && node.srcObject !== streamRef.current) {
      node.srcObject = streamRef.current;
      node.play().catch(() => {});
    }
  }, []);

  // Camera lifecycle: FULL teardown outside camera/countdown and on unmount
  // (WebKit single-stream rule — the selfie step is next). Effect-initiated
  // START is only a fast path once a camera has succeeded this session;
  // the first-ever start must come from the user's tap (iOS reliability).
  useEffect(() => {
    if (mode === 'photo' && (phase === 'camera' || phase === 'countdown')) {
      if (!streamRef.current && cameraGrantedOnce()) startCam();
    } else {
      stopCam();
    }
  }, [mode, phase, startCam, stopCam]);
  useEffect(() => () => stopCam(), [stopCam]);

  // Raw-frame capture (unmirrored — the CSS mirror never reaches the canvas),
  // downscaled to ≤1600px wide for a fast upload that stays OCR-readable.
  const captureFrame = () => {
    const video = videoRef.current;
    if (!video || !video.videoWidth) return null;
    const scale = Math.min(1, 1600 / video.videoWidth);
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(video.videoWidth * scale);
    canvas.height = Math.round(video.videoHeight * scale);
    canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
    try { return canvas.toDataURL('image/jpeg', 0.9); } catch { return null; }
  };

  const runExtract = async (dataUrl) => {
    setPhoto(dataUrl);
    setLocalErr('');
    setPhase('extracting');
    const out = await onExtract(dataUrl);
    if (!out || out.code === 'STALE' || out.code === 'FATAL') return;
    if (out.ok) {
      setFields(out.fields || {});
      setWarnings(Array.isArray(out.warnings) ? out.warnings : []);
      setPhase('confirm');
      return;
    }
    if (out.code === 'EXTRACT_LIMIT') { setPhase('limit'); return; }
    if (out.code === 'OCR_UNAVAILABLE') {
      // OCR down (or older backend without the endpoint) → barcode fallback.
      setLocalErr(t('kiosk.idOcrUnavailable'));
      setMode('scanner');
      setPhase('camera');
      return;
    }
    if (out.code === 'INVALID_PHOTO') { setLocalErr(t('kiosk.invalidPhoto')); setPhase('camera'); return; }
    setLocalErr(out.message || t('kiosk.genericError'));
    setPhase('camera');
  };

  // Countdown 5→1 (big kiosk-scale digits) → capture → extract.
  useEffect(() => {
    if (phase !== 'countdown') return undefined;
    if (count <= 0) {
      const dataUrl = captureFrame();
      stopCam();
      if (!dataUrl) { setLocalErr(t('kiosk.idPhotoCameraFailed')); setPhase('camera'); return undefined; }
      runExtract(dataUrl);
      return undefined;
    }
    const timer = setTimeout(() => setCount((v) => v - 1), 1000);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, count]);

  const onUploadFile = (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => { stopCam(); runExtract(String(reader.result)); };
    reader.readAsDataURL(file);
    e.target.value = '';
  };

  const retake = () => {
    track('ID_PHOTO_RETAKE');
    clearVerify();
    setFields(null);
    setWarnings([]);
    setPhoto(null);
    setLocalErr('');
    setCount(5);
    setPhase('camera');
  };

  const verifyFailed = verifyResult && !verifyResult.verified;
  // B3e: name as the ONLY failed rule → self-service name-update path (the
  // server's send-code gate enforces the same condition).
  const failReasons = Array.isArray(verifyResult?.failureReasons) ? verifyResult.failureReasons : [];
  const nameMismatchOnly = !!verifyFailed && failReasons.length === 1 && failReasons[0] === 'NAME_MISMATCH';
  const FIELD_KEYS = ['firstName', 'lastName', 'dateOfBirth', 'licenseNumber', 'licenseState', 'licenseExpiry'];
  const anyMissing = fields ? FIELD_KEYS.some((key) => !fields[key]) : false;
  // Name/DOB/expiry are the verify-critical trio — a null here guarantees a
  // verify failure, so the confirm CTA gets demoted below "Retake photo".
  const criticalMissing = fields
    ? (!fields.firstName || !fields.lastName || !fields.dateOfBirth || !fields.licenseExpiry)
    : false;

  // ── Secondary path: the pdf417 barcode scanner (Android kiosks) ────────────
  if (mode === 'scanner') {
    return (
      <div className="kio-main">
        <div className="kio-h2">{t('kiosk.idTitle')}</div>
        <p className="kio-sub">{t('kiosk.idSub')}</p>
        {localErr ? <div className="kio-note" style={{ marginBottom: 10 }}>{localErr}</div> : null}
        <div className="kio-panel" style={{ maxWidth: 560, textAlign: 'center' }}>
          <LicenseScanner
            onDecode={onScanned}
            onPhoto={onScannerPhoto}
            facingMode="user"
            labels={{
              slowScanHint: t('kiosk.scanSlowHint'),
              scanButton: `📷 ${t('kiosk.scanLicenseBtn')}`,
              stopButton: `■ ${t('kiosk.scanStopBtn')}`,
              uploadButton: `⬆ ${t('kiosk.scanUploadBtn')}`,
              holdSteady: t('kiosk.scanHoldSteady'),
              scannedPrefix: t('kiosk.scanScannedPrefix'),
              scannedFallback: t('kiosk.scanScannedFallback'),
              cameraUnavailable: t('kiosk.scanCameraUnavailable'),
              liveScanUnavailable: t('kiosk.scanLiveUnavailable'),
              readingBarcode: t('kiosk.scanReading'),
              photoNoBarcode: t('kiosk.scanPhotoNoBarcode'),
              photoReadFailed: t('kiosk.scanPhotoReadFailed'),
              helperNote: t('kiosk.scanHelperNote'),
            }}
          />
        </div>
        {err ? <div className="kio-error">{err}</div> : null}
        <div className="kio-row" style={{ marginTop: 16 }}>
          <button type="button" className="kio-btn ghost sm" onClick={() => { setLocalErr(''); setMode('photo'); setPhase('camera'); }}>
            📸 {t('kiosk.idPhotoBackToPhoto')}
          </button>
          <button type="button" className="kio-btn ghost sm" onClick={onEscalate}>
            🎧 {t('kiosk.idCantScan')}
          </button>
        </div>
        <div style={{ marginTop: 14 }}>
          <button type="button" className="kio-btn back" onClick={onBack}>‹ {t('kiosk.back')}</button>
        </div>
      </div>
    );
  }

  // ── Primary path: photo capture + server-side OCR ──────────────────────────
  return (
    <div className="kio-main">
      <div className="kio-h2">{t('kiosk.idPhotoTitle')}</div>
      <p className="kio-sub">{t('kiosk.idPhotoSub')}</p>
      {(phase === 'camera' || phase === 'confirm') ? <div className="kio-note">🔒 {t('kiosk.idPrivacy')}</div> : null}

      {(phase === 'camera' || phase === 'countdown') ? (
        <>
          <div style={{ position: 'relative', width: 'min(560px, 92vw)' }}>
            <div className="kio-scanbox" style={{ width: '100%', minHeight: 260, padding: 0, overflow: 'hidden' }}>
              {cameraOn ? (
                // Mirrored PREVIEW only — captureFrame reads raw frames.
                // minHeight + black bg: a stalled stream must be a VISIBLE
                // black box, never a 0-height invisible element (iPad debug).
                // eslint-disable-next-line jsx-a11y/media-has-caption
                <video
                  ref={attachVideo}
                  muted
                  playsInline
                  style={{ width: '100%', minHeight: 240, background: '#000', transform: 'scaleX(-1)' }}
                  onLoadedMetadata={(e) => {
                    if (!e.currentTarget.videoWidth) setCamDiag('loadedmetadata: videoWidth=0');
                  }}
                />
              ) : (
                <span style={{ fontSize: 44 }}>📷</span>
              )}
            </div>
            {phase === 'countdown' ? (
              <div style={{
                position: 'absolute', inset: 0, borderRadius: 20,
                display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
                background: 'rgba(33,26,56,.35)',
              }}>
                <div style={{ fontSize: 120, fontWeight: 850, color: '#fff', lineHeight: 1, textShadow: '0 4px 18px rgba(0,0,0,.45)' }}>
                  {count}
                </div>
                <div style={{ color: '#fff', fontWeight: 800, fontSize: 18, marginTop: 6 }}>{t('kiosk.idPhotoHoldStill')}</div>
              </div>
            ) : null}
          </div>
          {phase === 'camera' ? (
            <div className="kio-row" style={{ marginTop: 16 }}>
              {cameraOn ? (
                <button
                  type="button"
                  className="kio-btn"
                  onClick={() => { track('ID_PHOTO_READY'); setLocalErr(''); setCount(5); setPhase('countdown'); }}
                >
                  📸 {t('kiosk.idPhotoReady')}
                </button>
              ) : (
                // Gesture-initiated start — getUserMedia runs inside this tap.
                <button type="button" className="kio-btn" onClick={startCam}>
                  📷 {cameraFailed ? t('kiosk.tryAgain') : t('kiosk.selfieStartCamera')}
                </button>
              )}
              {/* Upload fallback always visible (kiosk resilience rule). */}
              <button type="button" className="kio-btn ghost sm" onClick={() => fileRef.current?.click()}>
                ⬆ {t('kiosk.idPhotoUpload')}
              </button>
            </div>
          ) : null}
          {cameraFailed ? (
            <div className="kio-error">
              {t('kiosk.idPhotoCameraFailed')}
              {camDiag ? (
                <div style={{ fontSize: 11.5, color: '#6f668f', fontWeight: 600, marginTop: 4 }}>{camDiag}</div>
              ) : null}
            </div>
          ) : null}
          {!cameraFailed && camDiag ? (
            <div style={{ fontSize: 11.5, color: '#6f668f', fontWeight: 600, marginTop: 6 }}>{camDiag}</div>
          ) : null}
        </>
      ) : null}

      {phase === 'extracting' ? (
        <div className="kio-panel" style={{ maxWidth: 560, textAlign: 'center' }}>
          <div className="kio-h2" style={{ fontSize: 22 }}>⏳ {t('kiosk.idPhotoExtracting')}</div>
          <p className="kio-sub" style={{ margin: '6px auto 0', fontSize: 14 }}>{t('kiosk.idPhotoExtractingSub')}</p>
        </div>
      ) : null}

      {phase === 'confirm' && fields ? (
        <>
          <div className="kio-h2" style={{ fontSize: 22, marginTop: 4 }}>{t('kiosk.idPhotoConfirmTitle')}</div>
          <div className="kio-panel" style={{ maxWidth: 560 }}>
            <div className="kio-kv"><span className="kio-l">{t('kiosk.idPhotoFieldName')}</span><b>{[fields.firstName, fields.lastName].filter(Boolean).join(' ') || '—'}</b></div>
            <div className="kio-kv"><span className="kio-l">{t('kiosk.idPhotoFieldDob')}</span><b>{fields.dateOfBirth || '—'}</b></div>
            <div className="kio-kv"><span className="kio-l">{t('kiosk.idPhotoFieldLicense')}</span><b>{fields.licenseNumber || '—'}</b></div>
            <div className="kio-kv"><span className="kio-l">{t('kiosk.idPhotoFieldState')}</span><b>{fields.licenseState || '—'}</b></div>
            <div className="kio-kv"><span className="kio-l">{t('kiosk.idPhotoFieldExpiry')}</span><b>{fields.licenseExpiry || '—'}</b></div>
          </div>
          {(anyMissing || warnings.length > 0) ? (
            <p className="kio-sub" style={{ fontSize: 13.5, marginTop: 10, maxWidth: 560 }}>{t('kiosk.idPhotoMissingHint')}</p>
          ) : null}
          {verifyFailed && nameMismatchOnly ? (
            // B3e: REAL name mismatch (layer-1 token matcher already passed
            // the harmless cases). Friendly explanation + self-service path.
            <div className="kio-note" style={{ marginTop: 10, maxWidth: 560, fontSize: 14 }}>
              <b>{t('kiosk.nameMismatchTitle')}</b>
              <div style={{ marginTop: 4 }}>{t('kiosk.nameMismatchBody')}</div>
            </div>
          ) : verifyFailed ? (
            <div className="kio-panel" style={{ maxWidth: 560, marginTop: 10 }}>
              <VerifyChecks t={t} result={verifyResult} />
            </div>
          ) : null}
          <div className="kio-row" style={{ marginTop: 16 }}>
            {verifyFailed && nameMismatchOnly ? (
              <>
                <button type="button" className="kio-btn" disabled={busy} onClick={onNameUpdate}>
                  ✉️ {t('kiosk.nameMismatchCta')} ›
                </button>
                <button type="button" className="kio-btn ghost sm" disabled={busy} onClick={retake}>{t('kiosk.idPhotoRetake')}</button>
                {/* Employee-facing light bypass (B3e) — discreet on purpose. */}
                {onStaffAssistName ? (
                  <button type="button" className="kio-btn back" onClick={onStaffAssistName}>🔧 {t('kiosk.assistEntry')}</button>
                ) : null}
              </>
            ) : verifyFailed ? (
              verifyResult.escalateSuggested ? (
                <>
                  <button type="button" className="kio-btn sm" onClick={onEscalate}>🎧 {t('kiosk.connectAgent')}</button>
                  <button type="button" className="kio-btn ghost sm" disabled={busy} onClick={retake}>{t('kiosk.idPhotoRetake')}</button>
                  {/* Employee-facing (B3c) — discreet on purpose. */}
                  {onStaffAssist ? (
                    <button type="button" className="kio-btn back" onClick={onStaffAssist}>🔧 {t('kiosk.assistEntry')}</button>
                  ) : null}
                </>
              ) : (
                <>
                  <button type="button" className="kio-btn sm" disabled={busy} onClick={retake}>{t('kiosk.idPhotoRetake')}</button>
                  <button type="button" className="kio-btn ghost sm" onClick={onEscalate}>🎧 {t('kiosk.getHelp')}</button>
                </>
              )
            ) : criticalMissing ? (
              // GD sign-off item: a null name/DOB/expiry means confirming just
              // burns a verify attempt on a guaranteed failure — RETAKE leads.
              <>
                <button type="button" className="kio-btn" disabled={busy} onClick={retake}>{t('kiosk.idPhotoRetake')} ›</button>
                <button
                  type="button"
                  className="kio-btn ghost sm"
                  disabled={busy}
                  onClick={() => { track('ID_PHOTO_CONFIRMED'); onConfirm(fields, photo); }}
                >
                  {t('kiosk.idPhotoConfirmYes')}
                </button>
              </>
            ) : (
              <>
                <button
                  type="button"
                  className="kio-btn"
                  disabled={busy}
                  onClick={() => { track('ID_PHOTO_CONFIRMED'); onConfirm(fields, photo); }}
                >
                  {t('kiosk.idPhotoConfirmYes')} ›
                </button>
                <button type="button" className="kio-btn ghost sm" disabled={busy} onClick={retake}>{t('kiosk.idPhotoRetake')}</button>
              </>
            )}
          </div>
        </>
      ) : null}

      {phase === 'limit' ? (
        <div style={{ maxWidth: 560 }}>
          <div className="kio-h2" style={{ fontSize: 22 }}>{t('kiosk.idPhotoLimitTitle')}</div>
          <p className="kio-sub">{t('kiosk.idPhotoLimitBody')}</p>
          <div className="kio-row">
            <button type="button" className="kio-btn sm" onClick={onEscalate}>🎧 {t('kiosk.connectAgent')}</button>
          </div>
        </div>
      ) : null}

      <input ref={fileRef} type="file" accept="image/*" capture="user" style={{ display: 'none' }} onChange={onUploadFile} />
      {localErr && phase === 'camera' ? <div className="kio-error">{localErr}</div> : null}
      {err ? <div className="kio-error">{err}</div> : null}

      {phase === 'camera' ? (
        <div className="kio-row" style={{ marginTop: 14 }}>
          {/* Secondary path — pdf417 still shines on Android kiosks. */}
          <button type="button" className="kio-btn ghost sm" onClick={() => { setLocalErr(''); stopCam(); setMode('scanner'); }}>
            {t('kiosk.idPhotoScannerLink')}
          </button>
          <button type="button" className="kio-btn ghost sm" onClick={onEscalate}>🎧 {t('kiosk.idCantScan')}</button>
        </div>
      ) : null}
      <div style={{ marginTop: 14 }}>
        <button type="button" className="kio-btn back" onClick={onBack}>‹ {t('kiosk.back')}</button>
      </div>
    </div>
  );
}

const FAILURE_REASON_KEYS = {
  NAME_MISMATCH: 'kiosk.reasonNameMismatch',
  UNDERAGE: 'kiosk.reasonUnderage',
  AGE_ABOVE_MAX: 'kiosk.reasonAgeAboveMax',
  DOB_UNREADABLE: 'kiosk.reasonDobUnreadable',
  DOB_IMPLAUSIBLE: 'kiosk.reasonDobImplausible',
  LICENSE_EXPIRY_UNREADABLE: 'kiosk.reasonExpiryUnreadable',
  LICENSE_EXPIRES_BEFORE_RETURN: 'kiosk.reasonExpiresBeforeReturn',
};

function VerifyChecks({ t, result }) {
  const checks = result?.checks || {};
  const rows = [
    { ok: checks.nameMatches, label: t('kiosk.checkName') },
    { ok: checks.ageOk, label: t('kiosk.checkAge', { age: result?.minimumAge || 21 }) },
    { ok: checks.licenseNotExpired, label: t('kiosk.checkExpiry') },
  ];
  const reasons = Array.isArray(result?.failureReasons) ? result.failureReasons : [];
  return (
    <>
      {rows.map((row) => (
        <div key={row.label} className="kio-kv">
          <span className="kio-l">{row.label}</span>
          <b style={{ color: row.ok ? '#047857' : '#be123c' }}>{row.ok ? '✓' : '✕'}</b>
        </div>
      ))}
      {reasons.length ? (
        <div style={{ marginTop: 8, fontSize: 13.5, color: '#be123c', fontWeight: 700 }}>
          {reasons.map((code) => (
            <div key={code}>
              {t(FAILURE_REASON_KEYS[code] || 'kiosk.reasonGeneric', {
                age: code === 'AGE_ABOVE_MAX' ? (result?.maximumAge ?? '') : (result?.minimumAge ?? ''),
              })}
            </div>
          ))}
        </div>
      ) : null}
    </>
  );
}

function SelfieScreen({ t, busy, err, selfie, setSelfie, verifyResult, onSubmit, onContinue, onRetryScan, onEscalate, onStaffAssist }) {
  const videoRef = useRef(null);
  const streamRef = useRef(null);
  const fileRef = useRef(null);
  const [cameraOn, setCameraOn] = useState(false);
  const [cameraFailed, setCameraFailed] = useState(false);
  // Raw getUserMedia error name — remote-debug line (iPad re-test).
  const [camDiag, setCamDiag] = useState('');
  const unmountedRef = useRef(false);
  useEffect(() => () => { unmountedRef.current = true; }, []);

  const stopCamera = useCallback(() => {
    try { streamRef.current?.getTracks?.().forEach((track) => track.stop()); } catch {}
    streamRef.current = null;
    if (videoRef.current) {
      try { videoRef.current.pause(); } catch {}
      try { videoRef.current.srcObject = null; } catch {}
    }
    setCameraOn(false);
  }, []);

  // Shared hardened acquisition: gesture-safe (no awaits before
  // getUserMedia), single in-flight request, orphan cleanup on unmount.
  const startCamera = useCallback(async () => {
    setCameraFailed(false);
    setCamDiag('');
    const out = await acquireCameraStream({
      facingMode: 'user',
      isCancelled: () => unmountedRef.current,
    });
    if (out.error) {
      if (out.error.name === CAMERA_ERR_IN_FLIGHT || out.error.name === 'Cancelled') return;
      setCameraFailed(true);
      setCamDiag(out.error.name + (out.error.message ? `: ${out.error.message}` : ''));
      return;
    }
    streamRef.current = out.stream;
    setCameraOn(true);
    // Best-effort immediate attach (element may already be mounted).
    setTimeout(() => {
      if (videoRef.current && streamRef.current && videoRef.current.srcObject !== streamRef.current) {
        videoRef.current.srcObject = streamRef.current;
        videoRef.current.play().catch(() => {});
      }
    }, 0);
  }, []);

  // iPad black-video fix — same callback-ref attach as the ID step: the
  // conditional <video> can mount AFTER the setTimeout(0) on slow WebKit.
  const attachVideo = useCallback((node) => {
    videoRef.current = node;
    if (node && streamRef.current && node.srcObject !== streamRef.current) {
      node.srcObject = streamRef.current;
      node.play().catch(() => {});
    }
  }, []);

  useEffect(() => {
    // Auto-start is only a FAST PATH once a camera has succeeded this session
    // (permission granted → effect-start is fine). First-ever start must be
    // the user's tap on "Start camera". The ~350ms grace gives the ID step's
    // tracks time to fully release (WebKit single-stream rule).
    let graceTimer = null;
    if (!selfie && !verifyResult && cameraGrantedOnce()) {
      graceTimer = setTimeout(() => { startCamera(); }, 350);
    }
    return () => {
      if (graceTimer) clearTimeout(graceTimer);
      stopCamera();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const takePhoto = () => {
    const video = videoRef.current;
    if (!video || !video.videoWidth) return;
    const side = Math.min(video.videoWidth, video.videoHeight);
    const canvas = document.createElement('canvas');
    canvas.width = 640; canvas.height = 640;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(
      video,
      (video.videoWidth - side) / 2, (video.videoHeight - side) / 2, side, side,
      0, 0, 640, 640,
    );
    setSelfie(canvas.toDataURL('image/jpeg', 0.85));
    stopCamera();
  };

  const onFile = (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => { setSelfie(String(reader.result)); stopCamera(); };
    reader.readAsDataURL(file);
    e.target.value = '';
  };

  const retake = () => { setSelfie(null); startCamera(); };

  // Verified → success checklist + continue (K4 checks panel).
  if (verifyResult?.verified) {
    return (
      <div className="kio-main center">
        <div className="kio-h2">✓ {t('kiosk.verifyOkTitle')}</div>
        <div className="kio-panel" style={{ maxWidth: 560 }}>
          <VerifyChecks t={t} result={verifyResult} />
        </div>
        {err ? <div className="kio-error">{err}</div> : null}
        <button type="button" className="kio-btn" style={{ marginTop: 20 }} disabled={busy} onClick={onContinue}>
          {t('kiosk.continue')} ›
        </button>
      </div>
    );
  }

  // Failed + escalate suggested → K-E3.
  if (verifyResult && !verifyResult.verified && verifyResult.escalateSuggested) {
    return (
      <div className="kio-main center">
        <div className="kio-h2">{t('kiosk.verifyStuckTitle')}</div>
        <p className="kio-sub">{t('kiosk.verifyStuckBody')}</p>
        <div className="kio-panel" style={{ maxWidth: 560 }}>
          <VerifyChecks t={t} result={verifyResult} />
        </div>
        <div className="kio-row" style={{ marginTop: 18 }}>
          <button type="button" className="kio-btn sm" onClick={onEscalate}>🎧 {t('kiosk.connectAgent')}</button>
          <button type="button" className="kio-btn ghost sm" onClick={onRetryScan}>{t('kiosk.tryScanAgain')}</button>
        </div>
        {/* Employee-facing (B3c) — discreet on purpose. */}
        {onStaffAssist ? (
          <div style={{ marginTop: 18 }}>
            <button type="button" className="kio-btn back" onClick={onStaffAssist}>🔧 {t('kiosk.assistEntry')}</button>
          </div>
        ) : null}
      </div>
    );
  }

  // Failed (first miss) → reasons + retry.
  if (verifyResult && !verifyResult.verified) {
    return (
      <div className="kio-main center">
        <div className="kio-h2">{t('kiosk.verifyFailedTitle')}</div>
        <div className="kio-panel" style={{ maxWidth: 560 }}>
          <VerifyChecks t={t} result={verifyResult} />
        </div>
        <div className="kio-row" style={{ marginTop: 18 }}>
          <button type="button" className="kio-btn sm" onClick={onRetryScan}>{t('kiosk.tryScanAgain')}</button>
          <button type="button" className="kio-btn ghost sm" onClick={onEscalate}>🎧 {t('kiosk.getHelp')}</button>
        </div>
      </div>
    );
  }

  return (
    <div className="kio-main">
      <div className="kio-h2">{t('kiosk.selfieTitle')}</div>
      <p className="kio-sub">{t('kiosk.selfieSub')}</p>
      <div className="kio-selfie-frame">
        {selfie ? (
          <img src={selfie} alt="" />
        ) : cameraOn ? (
          // Preview mirrored (front camera, natural aiming) — the captured
          // canvas frame stays raw/unmirrored. Black bg: a stalled stream is
          // a visible black circle, never an empty frame (iPad debug).
          // eslint-disable-next-line jsx-a11y/media-has-caption
          <video
            ref={attachVideo}
            muted
            playsInline
            style={{ transform: 'scaleX(-1)', background: '#000' }}
            onLoadedMetadata={(e) => {
              if (!e.currentTarget.videoWidth) setCamDiag('loadedmetadata: videoWidth=0');
            }}
          />
        ) : (
          <span style={{ fontSize: 64 }}>🙂</span>
        )}
      </div>
      <input ref={fileRef} type="file" accept="image/*" capture="user" style={{ display: 'none' }} onChange={onFile} />
      <div className="kio-row">
        {!selfie ? (
          <>
            {cameraOn ? (
              <button type="button" className="kio-btn sm" onClick={takePhoto}>📸 {t('kiosk.selfieTake')}</button>
            ) : (
              // Gesture-initiated start — getUserMedia runs inside this tap.
              <button type="button" className="kio-btn sm" onClick={startCamera}>
                📷 {cameraFailed ? t('kiosk.tryAgain') : t('kiosk.selfieStartCamera')}
              </button>
            )}
            {/* Upload fallback ALWAYS visible — on kiosk tablets it's the
                resilient path, not an error-only afterthought. */}
            <button type="button" className="kio-btn ghost sm" onClick={() => fileRef.current?.click()}>
              ⬆ {t('kiosk.selfieUpload')}
            </button>
          </>
        ) : (
          <>
            <button type="button" className="kio-btn sm" disabled={busy} onClick={() => onSubmit(selfie)}>
              {t('kiosk.continue')} ›
            </button>
            <button type="button" className="kio-btn ghost sm" disabled={busy} onClick={retake}>{t('kiosk.selfieRetake')}</button>
          </>
        )}
      </div>
      {cameraFailed && !selfie ? (
        <div className="kio-error">
          {t('kiosk.selfieCameraFailed')}
          {camDiag ? (
            <div style={{ fontSize: 11.5, color: '#6f668f', fontWeight: 600, marginTop: 4 }}>{camDiag}</div>
          ) : null}
        </div>
      ) : null}
      {!cameraFailed && camDiag && !selfie ? (
        <div style={{ fontSize: 11.5, color: '#6f668f', fontWeight: 600, marginTop: 6 }}>{camDiag}</div>
      ) : null}
      {err ? <div className="kio-error">{err}</div> : null}
      <div className="kio-note" style={{ marginTop: 18 }}>🔒 {t('kiosk.selfiePrivacy')}</div>
    </div>
  );
}

function OffersScreen({ t, busy, err, offers, agreement, maskedName, onChoose }) {
  const [selectedAddons, setSelectedAddons] = useState([]);

  if (!offers) {
    return <div className="kio-main center"><p className="kio-sub">{t('kiosk.loading')}</p>{err ? <div className="kio-error">{err}</div> : null}</div>;
  }

  const packages = Array.isArray(offers.packages) ? offers.packages : [];
  const addons = Array.isArray(offers.addons) ? offers.addons : [];
  const deposit = Number(agreement?.agreement?.securityDepositAmount || 0);

  // Neither packages nor addons configured/offerable → nothing to sell:
  // continue straight to payment with an honest note.
  if (!packages.length && !addons.length) {
    return (
      <div className="kio-main center">
        <div className="kio-h2">{t('kiosk.offersTitle', { name: maskedName || '' })}</div>
        <p className="kio-sub">{t('kiosk.offersNoneBody')}</p>
        {err ? <div className="kio-error">{err}</div> : null}
        <button type="button" className="kio-btn" disabled={busy} onClick={() => onChoose([])}>
          {t('kiosk.continue')} ›
        </button>
      </div>
    );
  }

  const toggleAddon = (id) => {
    setSelectedAddons((current) => (current.includes(id) ? current.filter((x) => x !== id) : [...current, id]));
  };

  const orderKey = { BASIC: 0, RECOMMENDED: 1, PREMIUM: 2 };
  const sortedPackages = [...packages].sort(
    (a, b) => (orderKey[a.key] ?? 9) - (orderKey[b.key] ?? 9),
  );

  return (
    <div className="kio-main">
      <div className="kio-h2">{t('kiosk.offersTitle', { name: maskedName || '' })}</div>
      <p className="kio-sub" style={{ marginBottom: 26 }}>{t('kiosk.offersSub', { days: offers.days })}</p>

      {packages.length ? (
        <div className="kio-pkgs">
          {/* Honest decline — no dark patterns (mockup K5 "Basic"). */}
          <div className="kio-pkg">
            <h4>{t('kiosk.pkgBasicTitle')}</h4>
            <div className="kio-pp">$0<small>{t('kiosk.perDay')}</small></div>
            <ul>
              <li><span className="kio-no">✕</span> {t('kiosk.pkgBasicNoExtras')}</li>
              <li><span className="kio-ck">✓</span> {t('kiosk.pkgBasicNoCost')}</li>
            </ul>
            <button type="button" className="kio-cta ghostc" disabled={busy} onClick={() => onChoose([])}>
              {t('kiosk.pkgBasicCta')} ›
            </button>
          </div>
          {sortedPackages.map((pkg) => {
            const reco = pkg.key === 'RECOMMENDED';
            return (
              <div key={pkg.key} className={`kio-pkg ${reco ? 'reco' : ''}`}>
                {/* GD review 2026-07-05: copy is "Our recommendation" — restore
                    "Most popular" ONLY when B6 telemetry can back the claim
                    with real attach data (no fabricated social proof). */}
                {reco ? <div className="kio-ribbon">{t('kiosk.pkgMostPopular')}</div> : null}
                <h4>{pkg.name}</h4>
                <div className="kio-pp">
                  {money(pkg.perDay)}
                  <small>{t('kiosk.perDay')} · {money(pkg.total)} {t('kiosk.total')}</small>
                </div>
                <ul>
                  {(pkg.services || []).map((line) => (
                    <li key={line.serviceId}>
                      <span className="kio-ck">✓</span>
                      <span>
                        {line.name}
                        {line.pricingMode === 'PER_DAY'
                          ? ` — ${money(line.rate)}${t('kiosk.perDay')}`
                          : ` — ${money(line.total)}`}
                      </span>
                    </li>
                  ))}
                </ul>
                <button
                  type="button"
                  className={`kio-cta ${reco ? 'buy' : 'ghostc'}`}
                  disabled={busy}
                  onClick={() => onChoose(pkg.serviceIds)}
                >
                  {t('kiosk.pkgAdd', { name: pkg.name })} ›
                </button>
              </div>
            );
          })}
        </div>
      ) : (
        <>
          <div className="kio-panel" style={{ maxWidth: 640 }}>
            {addons.map((line) => {
              const on = selectedAddons.includes(line.serviceId);
              return (
                <button
                  key={line.serviceId}
                  type="button"
                  onClick={() => toggleAddon(line.serviceId)}
                  className="kio-kv"
                  style={{
                    width: '100%', border: 'none', cursor: 'pointer', minHeight: 52,
                    background: on ? 'rgba(135,82,254,.07)' : 'transparent',
                    borderRadius: 12, padding: '10px 12px', fontFamily: 'inherit', fontSize: 15,
                  }}
                >
                  <span className="kio-l" style={{ textAlign: 'left' }}>
                    <b style={{ color: on ? '#4c1d95' : undefined }}>{on ? '✓ ' : ''}{line.name}</b>
                    {line.description ? <span style={{ display: 'block', fontSize: 12.5 }}>{line.description}</span> : null}
                  </span>
                  <b>
                    {line.pricingMode === 'PER_DAY'
                      ? `${money(line.rate)}${t('kiosk.perDay')}`
                      : money(line.total)}
                  </b>
                </button>
              );
            })}
          </div>
          <div className="kio-row" style={{ marginTop: 18 }}>
            <button type="button" className="kio-btn" disabled={busy} onClick={() => onChoose(selectedAddons)}>
              {selectedAddons.length ? t('kiosk.offersAddSelected', { count: selectedAddons.length }) : t('kiosk.pkgBasicCta')} ›
            </button>
          </div>
        </>
      )}

      {deposit > 0 ? (
        <p className="kio-sub" style={{ margin: '18px 0 0', fontSize: 14 }}>
          {t('kiosk.offersDepositLine', { amount: money(deposit) })}
        </p>
      ) : null}
      {err ? <div className="kio-error">{err}</div> : null}
    </div>
  );
}

function PaymentScreen({ t, busy, err, agreement, payState, onSimulate, onHelp, onBack }) {
  const totals = agreement?.agreement || {};
  const deposit = Number(totals.securityDepositAmount || 0);

  if (payState === 'FAILED') {
    // K-E2 — payment failed / link expired.
    return (
      <div className="kio-main center">
        <div className="kio-h2">{t('kiosk.payFailedTitle')}</div>
        <div className="kio-paystate bad">✕ {t('kiosk.payFailedChip')}</div>
        <p className="kio-sub" style={{ marginTop: 14 }}>{t('kiosk.payFailedBody')}</p>
        {err ? <div className="kio-error">{err}</div> : null}
        <div className="kio-row">
          <button type="button" className="kio-btn sm" disabled={busy} onClick={onSimulate}>{t('kiosk.payRetry')}</button>
          <button type="button" className="kio-btn ghost sm" onClick={onHelp}>🎧 {t('kiosk.getHelp')}</button>
        </div>
      </div>
    );
  }

  return (
    <div className="kio-main">
      <div className="kio-h2">{t('kiosk.payTitle')}</div>
      <div style={{ display: 'flex', gap: 26, alignItems: 'flex-start', maxWidth: 900, width: '100%', justifyContent: 'center', flexWrap: 'wrap' }}>
        <div className="kio-panel" style={{ maxWidth: 400 }}>
          <div className="kio-kv"><span className="kio-l">{t('kiosk.paySubtotal')}</span><b>{money(totals.subtotal)}</b></div>
          <div className="kio-kv"><span className="kio-l">{t('kiosk.payTaxesFees')}</span><b>{money(Number(totals.taxes || 0) + Number(totals.fees || 0))}</b></div>
          <div className="kio-kv" style={{ borderTop: '2px solid #efeaff' }}>
            <span className="kio-l"><b>{t('kiosk.payToday')}</b></span>
            <b style={{ fontSize: 21 }}>{money(totals.total)}</b>
          </div>
          {deposit > 0 ? (
            <>
              <div className="kio-kv" style={{ background: 'rgba(31,199,170,.07)', borderRadius: 12, padding: '10px 12px', borderBottom: 'none', marginTop: 6 }}>
                <span className="kio-l">{t('kiosk.payHold')}</span>
                <b style={{ color: '#0f766e' }}>{money(deposit)}</b>
              </div>
              <div style={{ fontSize: 12, color: '#6f668f', padding: '6px 2px 0' }}>{t('kiosk.payHoldHint')}</div>
            </>
          ) : null}
        </div>
        <div style={{ textAlign: 'center' }}>
          {/* Visual placeholder — the real QR/SMS payment link ships in Fase B5. */}
          <div className="kio-qrph"><span style={{ fontSize: 12, color: '#6f668f', fontWeight: 700 }}>{t('kiosk.payQrSoon')}</span></div>
          <div className="kio-paystate">⏳ {t('kiosk.payWaiting')}</div>
          <div style={{ marginTop: 14 }}>
            <button type="button" className="kio-btn ghost sm" disabled>📱 {t('kiosk.payTextLink')}</button>
          </div>
          <div style={{ marginTop: 22 }}>
            <div className="kio-badge-sandbox" style={{ marginBottom: 8 }}>SANDBOX</div>
            <div>
              <button type="button" className="kio-btn mint sm" disabled={busy || payState === 'DISABLED'} onClick={onSimulate}>
                {t('kiosk.paySimulate')}
              </button>
            </div>
            {payState === 'DISABLED' ? (
              <div className="kio-error" style={{ marginTop: 10 }}>{t('kiosk.paySandboxDisabled')}</div>
            ) : null}
          </div>
        </div>
      </div>
      <div className="kio-panel" style={{ maxWidth: 640, marginTop: 18, fontSize: 14, textAlign: 'center' }}>
        {t('kiosk.payHowTo')}
      </div>
      {err && payState !== 'FAILED' ? <div className="kio-error">{err}</div> : null}
      {/* Going back is safe pre-payment: POST offers is an idempotent REPLACE
          (wipes prior KIOSK_UPSELL rows, recreates, recomputes tax/totals) —
          confirmed by the backend owner. Hidden once payment is stamped. */}
      {payState !== 'PAID' ? (
        <div style={{ marginTop: 16 }}>
          <button type="button" className="kio-btn ghost sm" disabled={busy} onClick={onBack}>
            ‹ {t('kiosk.payChangeExtras')}
          </button>
        </div>
      ) : null}
    </div>
  );
}

function SignScreen({ t, busy, err, sessionId, agreement, setAgreement, vehicle, stub, fmtDateTime, onSubmit, routeFatal }) {
  const [initials, setInitials] = useState(null);
  const [applied, setApplied] = useState({}); // sectionKey → initialDataUrl
  const [signature, setSignature] = useState(null);
  const [readOpen, setReadOpen] = useState(false);

  // Make sure we have the freshest sections/totals (payment may have re-synced).
  useEffect(() => {
    if (!sessionId) return;
    getAgreement(sessionId).then((out) => setAgreement(out)).catch((e) => { routeFatal(e); });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  const sections = Array.isArray(agreement?.sections) ? agreement.sections : [];
  const totals = agreement?.agreement || {};
  const summary = agreement?.summary || {};
  const car = summary.vehicle || vehicle || null;
  const allInitialed = sections.length > 0 && sections.every((s) => applied[s.key]);

  const applyAll = () => {
    if (!initials) return;
    setApplied(Object.fromEntries(sections.map((s) => [s.key, initials])));
  };

  const carLabel = car
    ? [car.year, car.make, car.model].filter(Boolean).join(' ') + (car.color ? ` · ${car.color}` : '')
    : summary.vehicleClassName || '—';

  return (
    <div className="kio-main">
      <div className="kio-h2">{t('kiosk.signTitle')} 🚙</div>
      <div className="kio-carcard">
        <div className="kio-carimg">🚙</div>
        <div style={{ flex: 1 }}>
          <b style={{ fontSize: 18, color: '#29223f' }}>{carLabel}</b>
          <div style={{ fontSize: 14, color: '#6f668f' }}>
            {car?.plate ? <>{t('kiosk.signPlate')} <b>{car.plate}</b></> : null}
            {car?.internalNumber ? <> · #{car.internalNumber}</> : null}
          </div>
          <div style={{ fontSize: 13, color: '#6f668f', marginTop: 4 }}>{t('kiosk.signReviewHint')}</div>
        </div>
      </div>

      <div className="kio-panel" style={{ maxWidth: 680, marginTop: 14 }}>
        <div className="kio-kv">
          <span className="kio-l">{t('kiosk.signReturn')}</span>
          <b>{fmtDateTime(summary.pickupWindow?.returnAt || stub?.pickupWindow?.returnAt)}</b>
        </div>
        <div className="kio-kv"><span className="kio-l">{t('kiosk.payToday')}</span><b>{money(totals.total)}</b></div>
        {Number(totals.securityDepositAmount || 0) > 0 ? (
          <div className="kio-kv">
            <span className="kio-l">{t('kiosk.signDeposit')}</span>
            <b>{t('kiosk.signDepositValue', { amount: money(totals.securityDepositAmount) })}</b>
          </div>
        ) : null}
        {agreement?.agreement?.agreementNumber ? (
          <div className="kio-kv"><span className="kio-l">{t('kiosk.signAgreementNo')}</span><b>{agreement.agreement.agreementNumber}</b></div>
        ) : null}
      </div>

      {/* Per-section initials: draw once, then apply to each section (or all). */}
      <div className="kio-panel" style={{ maxWidth: 680, marginTop: 14 }}>
        <b style={{ fontSize: 15 }}>{t('kiosk.signInitialsTitle')}</b>
        <p style={{ fontSize: 13, color: '#6f668f', margin: '4px 0 10px' }}>{t('kiosk.signInitialsHint')}</p>
        <SignaturePad height={90} placeholder={t('kiosk.signInitialsPlaceholder')} onChange={setInitials} />
        <div className="kio-row" style={{ marginTop: 10, justifyContent: 'flex-start' }}>
          <button type="button" className="kio-btn ghost sm" disabled={!initials} onClick={applyAll}>
            {t('kiosk.signInitialAll')}
          </button>
          <button type="button" className="kio-btn back" onClick={() => setReadOpen((v) => !v)}>
            {readOpen ? t('kiosk.signHideAgreement') : t('kiosk.signReadAgreement')}
          </button>
        </div>
        <div style={{ display: 'grid', gap: 10, marginTop: 12 }}>
          {sections.map((section) => (
            <div key={section.key} className="kio-section-initial">
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, alignItems: 'center' }}>
                <b style={{ fontSize: 14 }}>{section.label}</b>
                {applied[section.key] ? (
                  <span style={{ color: '#047857', fontWeight: 800, fontSize: 13, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                    ✓ {t('kiosk.signInitialed')}
                    <img src={applied[section.key]} alt="" style={{ height: 26, borderRadius: 4, border: '1px solid #e6dfff', background: '#fff' }} />
                  </span>
                ) : (
                  <button
                    type="button"
                    className="kio-btn ghost sm"
                    style={{ minHeight: 48, padding: '8px 16px', fontSize: 14 }}
                    disabled={!initials}
                    onClick={() => setApplied((cur) => ({ ...cur, [section.key]: initials }))}
                  >
                    {t('kiosk.signInitialHere')}
                  </button>
                )}
              </div>
              {readOpen ? <div className="kio-body">{section.body}</div> : null}
            </div>
          ))}
        </div>
      </div>

      <div className="kio-panel" style={{ maxWidth: 680, marginTop: 14 }}>
        <b style={{ fontSize: 15 }}>{t('kiosk.signSignatureTitle')}</b>
        <div style={{ marginTop: 10 }}>
          <SignaturePad height={150} placeholder={t('kiosk.signSignaturePlaceholder')} onChange={setSignature} />
        </div>
      </div>

      {err ? <div className="kio-error">{err}</div> : null}
      <div className="kio-row" style={{ marginTop: 18 }}>
        <button
          type="button"
          className="kio-btn mint"
          disabled={busy || !allInitialed || !signature}
          onClick={() => onSubmit({
            sectionInitials: sections.map((s) => ({ sectionKey: s.key, initialDataUrl: applied[s.key] })),
            signature,
          })}
        >
          {t('kiosk.signFinish')} ›
        </button>
      </div>
      {!allInitialed && sections.length ? (
        <p className="kio-sub" style={{ fontSize: 13, marginTop: 10 }}>{t('kiosk.signMissingInitials')}</p>
      ) : null}
    </div>
  );
}

/**
 * Scannable QR for the beta.160 customer-inspection link (K8). Uses the
 * repo's existing `qrcode` dependency, dynamically imported so the encoder
 * stays out of the kiosk's initial bundle.
 */
function InspectionQr({ link, alt }) {
  const [src, setSrc] = useState(null);
  useEffect(() => {
    let cancelled = false;
    import('qrcode')
      .then((QRCode) => (QRCode.toDataURL || QRCode.default?.toDataURL)?.(link, { width: 320, margin: 1 }))
      .then((dataUrl) => { if (!cancelled && dataUrl) setSrc(dataUrl); })
      .catch(() => {}); // QR is a bonus — the email line stays either way.
    return () => { cancelled = true; };
  }, [link]);
  if (!src) return null;
  return (
    <img
      src={src}
      alt={alt || ''}
      style={{ width: 160, height: 160, borderRadius: 18, border: '8px solid #fff', boxShadow: '0 14px 32px rgba(35,21,80,.08)', background: '#fff' }}
    />
  );
}

function DoneScreen({ t, doneData, vehicle, maskedName, startedAtMs, countdown }) {
  const keyHandoff = doneData?.keyHandoff || { mode: 'STAFF' };
  const totalTime = startedAtMs
    ? (() => {
      const secs = Math.max(0, Math.round((Date.now() - startedAtMs) / 1000));
      return `${Math.floor(secs / 60)}m ${String(secs % 60).padStart(2, '0')}s`;
    })()
    : null;
  const carLabel = vehicle
    ? [vehicle.color, vehicle.make, vehicle.model].filter(Boolean).join(' ') + (vehicle.plate ? ` · ${vehicle.plate}` : '')
    : '—';

  return (
    <div className="kio-main center">
      <div className="kio-h1">{t('kiosk.doneTitle', { name: maskedName || '' })} 🎉</div>
      <div className="kio-panel" style={{ maxWidth: 640 }}>
        <div className="kio-kv">
          <span className="kio-l">🔑 {t('kiosk.doneKeys')}</span>
          <b>
            {keyHandoff.mode === 'LOCKBOX'
              ? (keyHandoff.lockboxNote || t('kiosk.doneKeysLockbox'))
              : t('kiosk.doneKeysStaff')}
          </b>
        </div>
        <div className="kio-kv"><span className="kio-l">🚙 {t('kiosk.doneCar')}</span><b>{carLabel}</b></div>
        <div className="kio-kv">
          <span className="kio-l">📄 {t('kiosk.doneContract')}</span>
          <b>{doneData?.contractEmail?.sent ? t('kiosk.doneContractSent') : t('kiosk.doneContractAskStaff')}</b>
        </div>
        {doneData?.customerInspection?.sent ? (
          <div className="kio-kv">
            <span className="kio-l">📱 {t('kiosk.doneInspection')}</span>
            <b>{t('kiosk.doneInspectionSent')}</b>
          </div>
        ) : null}
      </div>
      {/* On-screen inspection QR (mockup K8) — the link only comes back on the
          FIRST completion; retries return sent:false and keep the email line. */}
      {doneData?.customerInspection?.link ? (
        <div style={{ marginTop: 14 }}>
          <InspectionQr link={doneData.customerInspection.link} alt={t('kiosk.doneInspectionScan')} />
          <div style={{ fontWeight: 750, color: '#4c1d95', fontSize: 14, marginTop: 4 }}>
            📱 {t('kiosk.doneInspectionScan')}
          </div>
        </div>
      ) : null}
      {totalTime ? (
        <p className="kio-sub" style={{ fontSize: 13, marginTop: 14 }}>
          {t('kiosk.doneTotalTime', { time: totalTime })} · {t('kiosk.doneEnjoy')}
        </p>
      ) : (
        <p className="kio-sub" style={{ fontSize: 13, marginTop: 14 }}>{t('kiosk.doneEnjoy')}</p>
      )}
      <p className="kio-sub" style={{ fontSize: 12.5, margin: 0 }}>{t('kiosk.doneReset', { count: countdown })}</p>
    </div>
  );
}
