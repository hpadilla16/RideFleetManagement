'use client';

/**
 * Checkout Wizard v2 — state-machine-driven, dual-screen aware.
 *
 * This route runs in parallel with the legacy /checkout-wizard during
 * the Dejavoo Spin redesign rollout (Phase 1-5). The legacy wizard
 * stays untouched until Phase 5 cuts traffic over.
 *
 * v2 design:
 *   • State lives on the backend (CheckoutSession). Refreshes via 1.5s
 *     poll during waiting steps, 6s during user-driving steps. The
 *     customer display (parallel browser tab on the second monitor)
 *     polls the same session and renders its own step screens.
 *   • Step content is render-only — every progression is a POST to
 *     /api/checkout-sessions/:id/transition. Backend rejects illegal
 *     ones with a 409 we surface as a toast.
 *   • Phase 1 stubs out the per-step UX (mock T&C, mock Spin, mock
 *     mobile inspection) so the wireframe works end-to-end. Phases 2-4
 *     swap each stub for the real integration.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { useTranslation } from 'react-i18next';
import { AuthGate } from '../../../../components/AuthGate';
import { AppShell } from '../../../../components/AppShell';
import { api } from '../../../../lib/client';
import { displayNoteLines, hasDisplayNotes, isRecentNote, relativeNoteAge } from '../../../../lib/reservation-notes';
import { filterAssignableVehicles } from '../../../../lib/vehicle-assignment';
import { MaintenanceSnoozeReprompt } from '../../../../components/wizard/MaintenanceSnoozeReprompt';
import { KnownDamageDisclosure } from '../../../../components/reservations/KnownDamageDisclosure';
import {
  createSession, getSessionByReservation, transition,
  mintTermsToken, mintHandoffToken, abandon,
  stepNumber, isTerminal, STEP_INFO,
  shouldSwallowTransitionConflict, resolveFinalizeFailureCopy,
  isFinalizeComplete, closedCardState,
  paymentStepMode, PAYMENT_STEP_MODES,
  getTerminalContract, runTerminalClause, captureTerminalSignature,
  fallbackTerminalContract, terminalActionsFor,
  getTerminalOptions, selectTerminalRegister,
} from '../../../../lib/checkout-session';
import QRCode from 'qrcode';

/**
 * QrCode — renders a scannable QR for the given URL using the qrcode
 * library (already in package.json). Dataurl-into-img keeps the
 * canvas/SVG complexity out of React render and works on every
 * device. Falls back to plain text when QRCode.toDataURL fails (e.g.
 * URL too long, library missing).
 */
function QrCode({ url, size = 200 }) {
  const [dataUrl, setDataUrl] = useState(null);
  const [err, setErr] = useState(null);
  useEffect(() => {
    if (!url) return;
    QRCode.toDataURL(url, { width: size, margin: 1, errorCorrectionLevel: 'M' })
      .then(setDataUrl)
      .catch((e) => setErr(e?.message || 'QR render failed'));
  }, [url, size]);

  if (err) {
    return <div style={{ fontSize: 11, color: '#B91C1C' }}>{err}</div>;
  }
  if (!dataUrl) {
    return (
      <div style={{
        width: size, height: size, margin: '0 auto',
        background: '#F3F4F6', borderRadius: 4,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        fontSize: 11, color: '#9CA3AF',
      }}>Generating QR…</div>
    );
  }
  return (
    <img
      src={dataUrl}
      alt="QR code"
      width={size}
      height={size}
      style={{ display: 'block', margin: '0 auto', borderRadius: 4 }}
    />
  );
}

export default function Page() {
  return <AuthGate>{({ token, me, logout }) => <CheckoutWizardV2 token={token} me={me} logout={logout} />}</AuthGate>;
}

function CheckoutWizardV2({ token, me, logout }) {
  const params = useParams();
  const router = useRouter();
  const reservationId = params?.id;

  const [session, setSession] = useState(null);
  const [reservation, setReservation] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [toast, setToast] = useState(null);
  const [swapOpen, setSwapOpen] = useState(false);
  // Bumped by the age-gate blocker after the agent captures/corrects the DOB —
  // re-runs the mount effect (fresh reservation + ageRules, then find-or-create).
  const [reloadKey, setReloadKey] = useState(0);
  // The last finalize failure, kept so the CLOSED card can NAME the blocker
  // instead of just reporting that one exists. Ephemeral by nature — it dies
  // on F5, which is exactly why it is never what decides the card's variant
  // (see closedCheck below). Refilled on demand by "Reintentar cierre".
  const [finalizeError, setFinalizeError] = useState(null);
  // Server truth about the finalize: 'pending' | 'ok' | 'failed'.
  const [closedCheck, setClosedCheck] = useState('pending');
  // Bumped to re-run that check after a retry (currentStep stays CLOSED, so
  // the effect's own deps never change on their own).
  const [closedCheckKey, setClosedCheckKey] = useState(0);
  // advance() drops a concurrent call silently; on a button the agent presses
  // themselves that reads as a dead click, so the button gets its own visible
  // in-flight state.
  const [retrying, setRetrying] = useState(false);
  const retryingRef = useRef(false);
  const pollTimer = useRef(null);

  // Innovation #5 (2026-07-27): drive the live customer display. The second
  // screen (/customer-display) already listens on the 'customer-display'
  // BroadcastChannel and fast-polls charges once it knows the reservation —
  // it just was never TOLD which reservation. Broadcast load-reservation when
  // the wizard mounts (and re-broadcast if the display announces itself
  // ready), so opening the wizard makes the customer's screen follow along.
  useEffect(() => {
    if (!reservationId || typeof BroadcastChannel === 'undefined') return;
    let ch;
    try {
      ch = new BroadcastChannel('customer-display');
      const announce = () => ch.postMessage({ type: 'load-reservation', id: String(reservationId) });
      announce();
      ch.onmessage = (e) => { if (e?.data?.type === 'display-ready') announce(); };
    } catch { /* channel unsupported — polling on the display still works via ?id= */ }
    return () => { try { ch && ch.close(); } catch { /* no-op */ } };
  }, [reservationId]);
  // In-flight guard for the transition POST. Multiple triggers can race
  // (double-clicked Continue button, the auto-advance effect re-running on
  // a stale poll snapshot, StepBridge's 500ms timer remounting) — without
  // the guard the second POST hits the backend after the first already
  // moved the state and 409s (ILLEGAL_TRANSITION). A ref (not state) so
  // the check-and-set is synchronous within a single render/tick.
  const transitionInFlightRef = useRef(false);

  // Vehicle swap is locked once inspection photos are being captured.
  // Mirrors the backend STEPS_BLOCKING_SWAP check so the button greys
  // out instead of erroring on click.
  const swapLocked = session && [
    'INSPECTION_IN_PROGRESS', 'CUSTOMER_SIGN_PENDING', 'FINALIZING', 'CLOSED', 'CANCELLED',
  ].includes(session.currentStep);

  // Find-or-create the session on mount. Both endpoints are idempotent.
  useEffect(() => {
    if (!reservationId) return;
    let cancelled = false;
    (async () => {
      try {
        setLoading(true);
        // 1. Reservation context (customer, vehicle, charges)
        const r = await api(`/api/reservations/${reservationId}`, { bypassCache: reloadKey > 0 }, token);
        if (cancelled) return;
        setReservation(r);

        // Checkout gates (2026-07-28, LAX): a blocking pre-checkin gate (#3)
        // or age-rules evaluation (#4: no DOB / under min / over max) renders
        // a blocker screen INSTEAD of the wizard — for new AND resumed
        // sessions alike (the backend re-checks at session create and again
        // at finalize, so these screens are UX, not the enforcement).
        //
        // 2026-08-17 — the gate lookup now happens AFTER the session lookup,
        // because "you cannot start this checkout" is the wrong thing to say
        // about one that has already ended. These same two flags are derived
        // from the very evaluator the CLOSED cascade enforces with
        // (reservations.service.js says so: "UI and gate can never disagree"),
        // so a finalize that died on PRECHECKIN_REQUIRED or any AGE_RULES_*
        // guarantees the matching flag is set — and the blocker preempted the
        // CLOSED failure card for five of its seven reasons. The agent got
        // "Checkout bloqueado · pre-check-in pendiente" over a session that
        // was closed with the reservation stranded: a screen claiming the
        // checkout never started, on one that ended badly.
        const gatesBlocking = !!(r?.precheckinGate?.blocking || r?.ageRules?.blocking);

        // 2. Find existing session OR create a new one
        let s;
        try {
          s = await getSessionByReservation({ reservationId, token });
        } catch (err) {
          if (err?.status === 404) {
            // Creation is what the gate must still refuse — there is no
            // checkout here yet, so the blocker is exactly right.
            if (gatesBlocking) { setSession(null); return; }
            s = await createSession({ reservationId, token });
          } else {
            throw err;
          }
        }
        if (cancelled) return;
        // A session mid-wizard still gets the blocker — unchanged behaviour.
        // A TERMINAL one does not: it is past the point the gate guards, and
        // its own screen is the one with the truth on it.
        if (gatesBlocking && !isTerminal(s?.currentStep)) { setSession(null); return; }
        setSession(s);
      } catch (err) {
        if (!cancelled) setError(err?.message || 'Failed to load checkout session');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [reservationId, token, reloadKey]);

  // Poll the session for state changes (the customer display, the
  // customer's T&C-signing phone, the Spin webhook, and the agent's
  // mobile inspection all push state into this row out-of-band).
  useEffect(() => {
    if (!session?.id || isTerminal(session.currentStep)) return;
    const waitingSteps = new Set(['TC_PENDING', 'PAYMENT_PENDING', 'INSPECTION_HANDOFF', 'INSPECTION_IN_PROGRESS', 'CUSTOMER_SIGN_PENDING']);
    const interval = waitingSteps.has(session.currentStep) ? 1500 : 6000;
    pollTimer.current = setInterval(async () => {
      try {
        const fresh = await api(`/api/checkout-sessions/${session.id}`, { bypassCache: true }, token);
        setSession((curr) => (curr && fresh.updatedAt !== curr.updatedAt ? fresh : curr));
      } catch { /* swallow — next tick retries */ }
    }, interval);
    return () => clearInterval(pollTimer.current);
  }, [session?.id, session?.currentStep, session?.updatedAt, token]);

  // Refetch the reservation when the wizard enters the PAYMENT step.
  // 2026-06-03 — the reservation (and its rentalAgreement.charges) is fetched
  // once on mount, but the agreement charges are created/updated server-side
  // during steps 1–2. By step 3 the in-memory copy is stale: the wizard saw no
  // charges, fell back to balance math, and showed sale+deposit merged
  // ($2.12 / $0 pre-auth) until the agent manually refreshed. A fresh fetch on
  // entering PAYMENT_PENDING keeps the sale/deposit split correct.
  useEffect(() => {
    if (!reservationId || session?.currentStep !== 'PAYMENT_PENDING') return;
    let cancelled = false;
    (async () => {
      try {
        const r = await api(`/api/reservations/${reservationId}`, { bypassCache: true }, token);
        if (!cancelled) setReservation(r);
      } catch { /* keep the mount-time copy — agent can refresh manually */ }
    })();
    return () => { cancelled = true; };
  }, [reservationId, session?.currentStep, token]);

  // Same refetch, same reason, at the other end of the wizard: by CLOSED the
  // mount-time reservation is several steps stale, and here the stale copy is
  // not a wrong number on a screen — it is the difference between telling the
  // agent the checkout finished and telling them it did not.
  //
  // Reaching CLOSED does NOT mean the finalize completed. Every guard in the
  // cascade (no vehicle / pre-check-in / age rules / vehicle conflict) raises
  // AFTER transition() has committed the step, so a failed finalize leaves the
  // session visibly CLOSED with the reservation still CONFIRMED. That gap is
  // the whole defect.
  //
  // BOTH statuses are asserted, and the second one is not decoration. The
  // write that turns the DRAFT into the legal document is deliberately
  // best-effort (checkout-session.service.js — it catches, clears
  // `agreementFinalized`, and lets the cascade finish so the vehicle sync is
  // not stranded). So there is a live path where the reservation reaches
  // CHECKED_OUT, the contract stays DRAFT, the email is withheld and
  // transition() still answers 200 with no error at all. Reading only
  // reservation.status would call that a success and print "Contrato
  // finalizado" over a draft — this ticket's own defect, through the door the
  // parent ticket opened. Nothing has to be inferred: getById selects
  // rentalAgreement.status.
  //
  // The verdict is deliberately four-valued. A boolean would read the stale
  // in-memory copy as CONFIRMED for the one render before the refetch lands
  // and flash "el cierre no se completó" across every SUCCESSFUL checkout —
  // crying wolf on the happy path is how a truthful screen gets ignored.
  useEffect(() => {
    if (session?.currentStep !== 'CLOSED') return;
    if (!reservationId) return;
    let cancelled = false;
    setClosedCheck('pending');
    (async () => {
      try {
        const r = await api(`/api/reservations/${reservationId}`, { bypassCache: true }, token);
        if (cancelled) return;
        setReservation(r);
        // Deliberately TWO clauses, not three: vehicle status is reported on
        // the card but never gates the verdict. syncVehicleStatusForReservation
        // skips (rather than fails) a car in a locked status like
        // IN_MAINTENANCE, so a perfectly good finalize can legitimately end
        // not-ON_RENT. A third clause here would manufacture false failures.
        setClosedCheck(isFinalizeComplete(r) ? 'ok' : 'failed');
      } catch {
        // Can't reach the server, so we don't know — and 'unknown' is a state
        // with a way out, unlike 'pending', which would park the agent on a
        // spinner that no poll will ever resolve (the poll effect stops at
        // terminal steps). Same shape as PrecheckinGateBlocker's "Verificar de
        // nuevo".
        if (!cancelled) setClosedCheck('unknown');
      }
    })();
    return () => { cancelled = true; };
  }, [reservationId, session?.currentStep, closedCheckKey, token]);

  // Auto-advance when a side-effect stamp arrives out-of-band. The
  // customer signing on their phone stamps tcCompletedAt; the Spin
  // webhook stamps paymentCompletedAt; the mobile inspection page
  // stamps inspectionCompletedAt / customerSignedAt. The wizard
  // observes the next poll and advances without the agent having to
  // press anything.
  useEffect(() => {
    if (!session?.id) return;
    if (session.currentStep === 'TC_PENDING' && session.tcCompletedAt) {
      advance('TC_SIGNED');
    } else if (session.currentStep === 'PAYMENT_PENDING' && session.paymentCompletedAt) {
      advance('PAID');
    } else if (session.currentStep === 'INSPECTION_HANDOFF' && session.inspectionCompletedAt) {
      // Mobile inspection finished while the desktop was still on the
      // handoff screen — bump through INSPECTION_IN_PROGRESS so the
      // next tick of the auto-advance cascade can land on
      // CUSTOMER_SIGN_PENDING (and beyond, if customerSignedAt is also
      // stamped, which the phone does when it captures the signature).
      advance('INSPECTION_IN_PROGRESS');
    } else if (session.currentStep === 'INSPECTION_IN_PROGRESS' && session.inspectionCompletedAt) {
      advance('CUSTOMER_SIGN_PENDING');
    } else if (session.currentStep === 'CUSTOMER_SIGN_PENDING' && session.customerSignedAt) {
      advance('FINALIZING');
    } else if (session.currentStep === 'FINALIZING' && session.customerSignedAt) {
      // Hector wants the desktop to fully close the loop without an
      // agent click once the phone has signed everything. CLOSED is
      // the terminal — entry guard already verified customerSignedAt.
      advance('CLOSED');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.currentStep, session?.tcCompletedAt, session?.paymentCompletedAt, session?.inspectionCompletedAt, session?.customerSignedAt]);

  const advance = async (toStep, metadata) => {
    if (transitionInFlightRef.current) return; // drop concurrent/double fires
    transitionInFlightRef.current = true;
    try {
      const next = await transition({ id: session.id, toStep, metadata, token });
      setSession(next);
      // A finalize that succeeds clears whatever the last one left behind, so
      // a successful retry does not keep showing the blocker it just cleared.
      if (toStep === 'CLOSED') setFinalizeError(null);
    } catch (err) {
      // 409 = state conflict. If the session is already in (or past) the
      // requested step AND the code is one of the benign ones — the classic
      // double-fire — refetch and treat as a success-noop instead of toasting
      // an error at the agent. The decision lives in
      // shouldSwallowTransitionConflict (lib/checkout-session.js) so it can be
      // tested; it swallows an ALLOW-list, so a finalize that failed after the
      // step committed (FINALIZE_INCOMPLETE, and anything new) is toasted.
      let freshSession = null;
      if (err?.status === 409) {
        try {
          const fresh = await api(`/api/checkout-sessions/${session.id}`, { bypassCache: true }, token);
          freshSession = fresh;
          if (shouldSwallowTransitionConflict({ err, fresh, toStep })) {
            setSession(fresh);
            return;
          }
        } catch { /* fall through to the toast */ }
      }
      // Reconcile the screen to server truth BEFORE complaining: on
      // FINALIZE_INCOMPLETE the session really is closed, and the agent needs
      // to see that AND the reason the finalize did not finish.
      if (freshSession) setSession(freshSession);
      // Keep the blocker for the CLOSED card. Deliberately not narrowed to
      // code === 'FINALIZE_INCOMPLETE': the card's variant is decided by
      // server truth, so anything that fails a run at CLOSED belongs in the
      // card, and resolveFinalizeFailureCopy falls back to the raw message for
      // a `reason` it does not recognise. Narrowing here would send the next
      // unforeseen failure to the dismissible toast alone — the same silence
      // BENIGN_CONFLICT_CODES was widened to stop.
      if (toStep === 'CLOSED') {
        setFinalizeError({ reason: err?.reason || null, message: err?.message || null });
      }
      setToast({ kind: 'error', message: err?.message || 'Cannot advance' });
    } finally {
      transitionInFlightRef.current = false;
    }
  };

  // "Reintentar cierre" — re-POSTs CLOSED → CLOSED. Not a refresh button: the
  // backend answers that pair through the idempotent branch and RE-RUNS the
  // finalize cascade, whose self-heal allow-list (['NEW','CONFIRMED']) covers
  // exactly the state a failed finalize strands the reservation in. So if the
  // agent has since cleared the blocker, this genuinely completes the
  // checkout; if not, it brings back a fresh `reason` — which is also how the
  // post-F5 card, with no error object left, learns why it failed.
  // The 'unknown' card's button. Bumping the key re-runs the check effect,
  // which only GETs — a control labelled "check again" must not POST, least of
  // all on a card telling the agent not to hand over the vehicle yet.
  const recheckClose = () => setClosedCheckKey((k) => k + 1);

  const retryFinalize = async () => {
    if (retryingRef.current) return;
    retryingRef.current = true;
    setRetrying(true);
    setToast(null);
    setClosedCheck('pending');
    try {
      await advance('CLOSED');
    } finally {
      retryingRef.current = false;
      setRetrying(false);
      setClosedCheckKey((k) => k + 1);
    }
  };

  const pauseAndExit = async () => {
    try {
      await abandon({ id: session.id, reason: 'agent_paused', token });
      router.push(`/reservations/${reservationId}`);
    } catch (err) {
      setToast({ kind: 'error', message: err?.message || 'Failed to pause' });
    }
  };

  if (loading) {
    return <AppShell me={me} logout={logout}><div style={{ padding: 24 }}>Loading checkout session…</div></AppShell>;
  }
  if (error) {
    return (
      <AppShell me={me} logout={logout}>
        <div style={{ padding: 24, color: '#B91C1C' }}>{error}</div>
      </AppShell>
    );
  }
  // Same precedence rule as the mount effect: the entry blockers are about
  // ENTERING the wizard, and a terminal session is past that. Without this the
  // gate would swap the wizard out on the render right after the CLOSED check
  // refetches the reservation — hiding the failure card behind a screen that
  // says the checkout has not started.
  const gatesApply = !session || !isTerminal(session.currentStep);
  if (gatesApply && reservation?.precheckinGate?.blocking) {
    return (
      <AppShell me={me} logout={logout}>
        <div style={{ padding: 24, maxWidth: 720, margin: '0 auto' }}>
          <PrecheckinGateBlocker
            reservation={reservation}
            onRetry={() => setReloadKey((k) => k + 1)}
          />
        </div>
      </AppShell>
    );
  }
  if (gatesApply && reservation?.ageRules?.blocking) {
    return (
      <AppShell me={me} logout={logout}>
        <div style={{ padding: 24, maxWidth: 720, margin: '0 auto' }}>
          <AgeGateBlocker
            reservation={reservation}
            token={token}
            onResolved={() => setReloadKey((k) => k + 1)}
          />
        </div>
      </AppShell>
    );
  }
  if (!session || !reservation) return null;

  return (
    <AppShell me={me} logout={logout}>
      <div style={{ padding: 24, maxWidth: 1100, margin: '0 auto' }}>
        <WizardHeader
          reservation={reservation}
          session={session}
          onPause={pauseAndExit}
          onSwapClick={() => setSwapOpen(true)}
          swapLocked={swapLocked}
          closedCheck={closedCheck}
        />
        {/* Maintenance snooze re-prompt (Feature A, 2026-09-01): a snooze
            taken at check-in re-surfaces at the vehicle's NEXT rental event —
            this wizard open consumes the marker and, when something is still
            due at the current odometer, shows the reminder. Informational
            only; the gate lives in the check-in wizard's Step 3. */}
        {!isTerminal(session.currentStep) && (reservation.vehicleId || reservation.vehicle?.id) ? (
          <MaintenanceSnoozeReprompt
            vehicleId={reservation.vehicleId || reservation.vehicle?.id}
            token={token}
          />
        ) : null}
        <StepRenderer
          session={session}
          reservation={reservation}
          token={token}
          onAdvance={advance}
          closedCheck={closedCheck}
          finalizeError={finalizeError}
          onRetryFinalize={retryFinalize}
          onRecheck={recheckClose}
          retrying={retrying}
        />
        {/* The CLOSED failure card already carries the backend's raw message,
            durably and with the recovery next to it. Repeating it in a
            dismissible red bar underneath just paints the same event twice. */}
        {toast && !(session.currentStep === 'CLOSED' && closedCheck === 'failed') && (
          <Toast kind={toast.kind} message={toast.message} onClose={() => setToast(null)} />
        )}
        {swapOpen && (
          <SwapVehicleModal
            session={session}
            reservation={reservation}
            token={token}
            onClose={() => setSwapOpen(false)}
            onSwapped={(result) => {
              setSwapOpen(false);
              setReservation((r) => ({ ...r, vehicleId: result.toVehicleId }));
              setToast({ kind: 'ok', message: 'Vehicle swapped' });
            }}
            onError={(msg) => setToast({ kind: 'error', message: msg })}
          />
        )}
      </div>
    </AppShell>
  );
}

// ---------------------------------------------------------------------------
// SwapVehicleModal — list of eligible alternative vehicles. Backend
// /api/checkout-sessions/:id/vehicle does the atomic swap of both
// Reservation.vehicleId and RentalAgreement.vehicleId so they can't
// drift apart (the bug we fixed earlier today on the extensions flow).
// ---------------------------------------------------------------------------
function SwapVehicleModal({ session, reservation, token, onClose, onSwapped, onError }) {
  const { t } = useTranslation();
  const [vehicles, setVehicles] = useState([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState(null);
  // Counter-UX Item 1 (2026-08-31): default to AVAILABLE units of the
  // reservation's type; "Show all vehicles" is the deliberate-upgrade escape.
  const [showAll, setShowAll] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        // Pull the fleet; client-side filters out SOLD/OOS and the current
        // assignment. Overlap check happens server-side on swap submit.
        const list = await api('/api/vehicles?limit=500', {}, token);
        if (!cancelled) setVehicles(Array.isArray(list) ? list : []);
      } catch (err) {
        if (!cancelled) onError(err?.message || 'Failed to load vehicles');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [token]);

  const reservationTypeId = reservation.vehicleTypeId
    || reservation.vehicleType?.id
    || reservation.vehicle?.vehicleTypeId
    || null;
  const eligible = useMemo(() => {
    const base = vehicles.filter((v) => {
      const status = String(v?.status || '').toUpperCase();
      if (['SOLD', 'OUT_OF_SERVICE'].includes(status)) return false;
      if (v.id === reservation.vehicleId) return false;
      return true;
    });
    return filterAssignableVehicles(base, { vehicleTypeId: reservationTypeId, showAll });
  }, [vehicles, reservation.vehicleId, reservationTypeId, showAll]);

  const submit = async (vehicleId) => {
    setBusyId(vehicleId);
    try {
      const result = await api(`/api/checkout-sessions/${session.id}/vehicle`, {
        method: 'POST',
        body: JSON.stringify({ newVehicleId: vehicleId }),
      }, token);
      onSwapped(result);
    } catch (err) {
      onError(err?.message || 'Swap failed');
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div onClick={onClose} style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 100,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
    }}>
      <div onClick={(e) => e.stopPropagation()} style={{
        width: 'min(600px, 95vw)', maxHeight: '85vh', overflow: 'auto',
        background: '#FFFFFF', borderRadius: 12, padding: 24,
      }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
          <h3 style={{ margin: 0 }}>Change vehicle</h3>
          <button onClick={onClose} style={{ background: 'none', border: 'none', fontSize: 20, cursor: 'pointer' }}>×</button>
        </div>
        {/* Counter-UX Item 1: filter note + "Show all vehicles" escape hatch —
            the counter sometimes deliberately upgrades to another type. */}
        {reservationTypeId ? (
          <div style={{ fontSize: 12, color: '#6B7280', marginBottom: 10 }}>
            {showAll
              ? t('vehicleAssign.showingAll')
              : (reservation.vehicleType?.name
                  ? t('vehicleAssign.filterNoteType', { type: reservation.vehicleType.name })
                  : t('vehicleAssign.filterNote'))}
            {' · '}
            <button
              type="button"
              onClick={() => setShowAll((v) => !v)}
              style={{ background: 'none', border: 'none', padding: 0, color: '#4338CA', fontWeight: 600, cursor: 'pointer', fontSize: 12, textDecoration: 'underline' }}
            >
              {showAll ? t('vehicleAssign.showMatching') : t('vehicleAssign.showAll')}
            </button>
          </div>
        ) : null}
        {loading ? (
          <div style={{ padding: 24, textAlign: 'center', color: '#6B7280' }}>Loading…</div>
        ) : eligible.length === 0 ? (
          <div style={{ padding: 24, textAlign: 'center', color: '#6B7280' }}>
            No alternative vehicles available.
            {reservationTypeId && !showAll ? (
              <div style={{ marginTop: 8 }}>
                <button type="button" style={{ ...ghostBtn, fontSize: 12 }} onClick={() => setShowAll(true)}>
                  {t('vehicleAssign.showAll')}
                </button>
              </div>
            ) : null}
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {eligible.slice(0, 80).map((v) => (
              <div key={v.id} style={{
                display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                padding: '8px 12px', border: '0.5px solid #E5E7EB', borderRadius: 6,
              }}>
                <div>
                  <div style={{ fontWeight: 500, fontSize: 14 }}>
                    {v.plate} · {v.year} {v.make} {v.model}
                  </div>
                  <div style={{ fontSize: 11, color: '#6B7280' }}>
                    {v.vehicleType?.name || '—'} · {v.status}
                  </div>
                </div>
                <button
                  style={{ ...ghostBtn, fontSize: 12 }}
                  disabled={!!busyId}
                  onClick={() => submit(v.id)}
                >
                  {busyId === v.id ? 'Swapping…' : 'Select'}
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Header — step tracker + pause button
// ---------------------------------------------------------------------------

function WizardHeader({ reservation, session, onPause, onSwapClick, swapLocked, closedCheck }) {
  const currentNumber = stepNumber(session.currentStep);
  return (
    <div style={{ marginBottom: 24 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <div>
          <div style={{ fontWeight: 600, fontSize: 16 }}>
            Checkout · #{reservation.reservationNumber}
          </div>
          <div style={{ fontSize: 13, color: '#6B7280' }}>
            {reservation.customer?.firstName} {reservation.customer?.lastName}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button
            onClick={onSwapClick}
            disabled={swapLocked}
            title={swapLocked ? 'Swap locked — inspection in progress' : 'Swap to a different vehicle'}
            style={{ ...pauseBtnStyle, opacity: swapLocked ? 0.4 : 1 }}
          >
            Change vehicle
          </button>
          <button onClick={onPause} style={pauseBtnStyle}>Save &amp; pause</button>
        </div>
      </div>
      <StepTracker
        currentStep={session.currentStep}
        currentNumber={currentNumber}
        closedCheck={closedCheck}
      />
    </div>
  );
}

function StepTracker({ currentStep, currentNumber, closedCheck }) {
  const steps = [
    { number: 1, label: 'Confirm' },
    { number: 2, label: 'Terms', tour: 'checkout-terms' },
    { number: 3, label: 'Payment' },
    { number: 4, label: 'Inspection', tour: 'checkout-inspection-handoff' },
    { number: 5, label: 'Metrics' },
    { number: 6, label: 'Sign' },
  ];
  if (currentStep === 'CANCELLED') {
    return <div style={{ color: '#B91C1C', fontSize: 14 }}>Checkout cancelled.</div>;
  }
  return (
    <div style={{ display: 'flex', gap: 8 }}>
      {steps.map((s) => {
        const isCurrent = s.number === currentNumber;
        const isLast = s.number === steps.length;
        // Only the LAST step reacts to the finalize. Steps 1-5 really did
        // happen — the customer signed, the card was charged, the car was
        // photographed — and repainting them as problems would be its own lie,
        // just in the other direction. What failed is the close, and step 6 is
        // the close.
        const isWarn = isLast && closedCheck === 'failed';
        // ...and it must not go GREEN before the answer is in either. The
        // verdict takes a round-trip, and a ✓ that appears for that render —
        // over a card reading "Cerrando checkout…", and again on every retry —
        // is a small version of the claim this whole change removes.
        const verdictPending = isLast && currentStep === 'CLOSED'
          && closedCheck !== 'ok' && closedCheck !== 'failed';
        // 'unknown' is not "in progress" — nothing is running. Drop the dark
        // current-step fill too, so the chip reads as unresolved rather than
        // as work still happening.
        const verdictUnknown = isLast && currentStep === 'CLOSED' && closedCheck === 'unknown';
        const isDone = (s.number < currentNumber || currentStep === 'CLOSED')
          && !isWarn && !verdictPending;
        return (
          // isWarn is tested FIRST everywhere below, and that ordering is the
          // whole point rather than a style choice. stepNumber('CLOSED') is 6,
          // so at the terminal step the closing chip is ALSO `isCurrent` — put
          // isCurrent first and the amber loses to the dark "you are here"
          // fill on the one chip that has something to report. There is no
          // "here" to mark on a terminal step anyway; there is only whether
          // the close landed.
          <div key={s.number} data-tour={s.tour} style={{
            flex: 1, padding: '8px 12px', borderRadius: 6,
            border: `0.5px solid ${isWarn ? WARN.bd : '#E5E7EB'}`,
            background: isWarn ? WARN.bg : ((isCurrent && !verdictUnknown) ? '#1F2937' : (isDone ? '#D1FAE5' : '#FFFFFF')),
            color: isWarn ? WARN.tx : ((isCurrent && !verdictUnknown) ? '#FFFFFF' : (isDone ? '#065F46' : '#6B7280')),
            fontSize: 12, fontWeight: (isCurrent || isWarn) ? 600 : 500,
            display: 'flex', alignItems: 'center', gap: 6,
          }}>
            <span aria-hidden="true" style={{
              width: 18, height: 18, borderRadius: '50%',
              background: isWarn ? WARN.dot : ((isCurrent && !verdictUnknown) ? 'rgba(255,255,255,0.2)' : (isDone ? '#10B981' : '#F3F4F6')),
              color: (isWarn || (isCurrent && !verdictUnknown) || isDone) ? '#FFFFFF' : '#9CA3AF',
              display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
              fontSize: 10, fontWeight: 600,
            }}>
              {isWarn ? '!' : (isDone ? '✓' : s.number)}
            </span>
            {s.label}
          </div>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Step dispatch
// ---------------------------------------------------------------------------

function StepRenderer({ session, reservation, token, onAdvance, closedCheck, finalizeError, onRetryFinalize, onRecheck, retrying }) {
  switch (session.currentStep) {
    case 'CONFIRMING':
      return <Step1Confirm reservation={reservation} session={session} token={token} onNext={() => onAdvance('TC_PENDING')} />;
    case 'TC_PENDING':
      return <Step2TermsPending session={session} reservation={reservation} token={token} onSigned={() => onAdvance('TC_SIGNED')} />;
    case 'TC_SIGNED':
      return <StepBridge key="TC_SIGNED" label="Terms signed" onNext={() => onAdvance('PAYMENT_PENDING')} />;
    case 'PAYMENT_PENDING': {
      // Which of the three payment screens this session gets — see
      // paymentStepMode() in lib/checkout-session.js for the ordering rule.
      // LOANER keeps its own bridge (billing is on the reservation); SKIP is a
      // session the backend already stamped paymentCompletedAt on, either
      // because the tenant does not collect payment during check-out
      // (`checkoutPaymentRequired=false`) or because a charge already landed.
      const mode = paymentStepMode(session, reservation);
      if (mode === PAYMENT_STEP_MODES.LOANER) {
        return <LoanerPaymentBridge reservation={reservation} onNext={() => onAdvance('PAID')} />;
      }
      if (mode === PAYMENT_STEP_MODES.SKIP) {
        return <StepBridge key="PAYMENT_SKIPPED" label="No payment required at check-out" onNext={() => onAdvance('PAID')} />;
      }
      return <Step3PaymentPending session={session} reservation={reservation} token={token} onPaid={() => onAdvance('PAID')} />;
    }
    case 'PAID':
      return <StepBridge key="PAID" label="Payment captured" onNext={() => onAdvance('INSPECTION_HANDOFF')} />;
    case 'INSPECTION_HANDOFF':
      // Known-damage disclosure (damage-baseline NOTES §D4): the compact
      // read-only card above the inspection handoff — the agent points the
      // documented marks out during the walkthrough. Renders ONLY when the
      // vehicle has active baseline entries; zero behavior change otherwise.
      return (
        <>
          <KnownDamageDisclosure vehicleId={reservation?.vehicleId || reservation?.vehicle?.id} token={token} />
          <Step4Handoff session={session} token={token} reservationId={reservation?.id} onContinue={() => onAdvance('INSPECTION_IN_PROGRESS')} />
        </>
      );
    case 'INSPECTION_IN_PROGRESS':
      return <Step5Metrics
        session={session}
        reservation={reservation}
        token={token}
        onNext={() => onAdvance('CUSTOMER_SIGN_PENDING')}
      />;
    case 'CUSTOMER_SIGN_PENDING':
      return <Step6CustomerSign
        session={session}
        token={token}
        onSigned={() => onAdvance('FINALIZING')}
      />;
    case 'FINALIZING':
      return <StepBridge key="FINALIZING" label="Building agreement…" onNext={() => onAdvance('CLOSED')} />;
    case 'CLOSED':
      return <StepClosed
        reservation={reservation}
        closedCheck={closedCheck}
        finalizeError={finalizeError}
        onRetryFinalize={onRetryFinalize}
        onRecheck={onRecheck}
        retrying={retrying}
      />;
    case 'CANCELLED':
      return <div style={cardStyle}>This checkout was cancelled. <a href={`/reservations/${reservation.id}`}>Back to reservation</a>.</div>;
    default:
      return <div style={cardStyle}>Unknown step: {session.currentStep}</div>;
  }
}

// ---------------------------------------------------------------------------
// PrecheckinGateBlocker (LAX #3) — full-screen replacement while the pickup
// location requires a completed pre-check-in and this reservation lacks one.
// The agent completes it from the reservation page ("fill in for customer" —
// that flow stamps customerInfoCompletedAt) or the customer finishes the
// portal link; "Verificar de nuevo" refetches. Enforcement is the backend's
// PRECHECKIN_REQUIRED gate — this screen is the friendly path.
// ---------------------------------------------------------------------------
function PrecheckinGateBlocker({ reservation, onRetry }) {
  return (
    <div style={cardStyle}>
      <h3 style={h3Style}>Checkout bloqueado · pre-check-in pendiente</h3>
      <div style={{ marginBottom: 12 }}>
        <KV label="Reservación" value={`#${reservation.reservationNumber || reservation.id}`} />
        <KV label="Cliente" value={`${reservation.customer?.firstName || ''} ${reservation.customer?.lastName || ''}`.trim() || '—'} />
        <KV label="Pickup" value={reservation.pickupAt ? new Date(reservation.pickupAt).toLocaleString() : '—'} />
      </div>
      <div style={{
        padding: 12, marginBottom: 12,
        background: '#FEF2F2', border: '0.5px solid #EF4444', borderRadius: 6,
        color: '#991B1B', fontSize: 13,
      }}>
        <div style={{ fontWeight: 600, marginBottom: 4 }}>Esta sede exige el pre-check-in completo antes del checkout</div>
        El cliente aún no completó su pre-check-in. Opciones: reenvíale el enlace desde la
        reservación, o complétalo tú con sus datos ("llenar por el cliente") en la sección de
        pre-registro de la reservación.
      </div>
      <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
        <a href={`/reservations/${reservation.id}`} style={{ ...primaryBtn, textDecoration: 'none', display: 'inline-block' }}>
          Ir a la reservación
        </a>
        <button style={ghostBtn} onClick={onRetry}>Verificar de nuevo</button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// AgeGateBlocker — full-screen replacement for the wizard while the pickup
// location's age rules block check-out (reservation.ageRules.blocking). The
// agent captures/corrects the DOB right here; onResolved re-runs the wizard
// mount (fresh ageRules → session find-or-create). Enforcement lives in the
// backend (session create + finalize) — this screen is the friendly path.
// ---------------------------------------------------------------------------

const AGE_BLOCK_COPY = {
  DOB_REQUIRED: {
    title: 'Falta la fecha de nacimiento',
    body: 'Esta sede exige verificar la edad del conductor antes del checkout. Captura la fecha de nacimiento del cliente (del ID/licencia) para continuar.',
  },
  DOB_IMPLAUSIBLE: {
    title: 'Fecha de nacimiento inválida',
    body: 'La fecha de nacimiento registrada es imposible. Corrígela con el ID/licencia del cliente para continuar.',
  },
  UNDER_MIN: {
    title: 'Conductor menor de la edad mínima',
    body: null, // built dynamically with the ages
  },
  ABOVE_MAX: {
    title: 'Conductor excede la edad máxima',
    body: null,
  },
};

function AgeGateBlocker({ reservation, token, onResolved }) {
  const [dob, setDob] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState(null);
  const rules = reservation.ageRules || {};
  const copy = AGE_BLOCK_COPY[rules.status] || AGE_BLOCK_COPY.DOB_REQUIRED;
  const customerId = reservation.customer?.id;
  const isHardAgeBlock = rules.status === 'UNDER_MIN' || rules.status === 'ABOVE_MAX';

  const body = copy.body
    || (rules.status === 'UNDER_MIN'
      ? `El conductor tiene ${rules.age} años y la edad mínima de esta sede es ${rules.minAge}. No se puede hacer el checkout.`
      : `El conductor tiene ${rules.age} años y la edad máxima de esta sede es ${rules.maxAge}. No se puede hacer el checkout.`);

  const saveDob = async () => {
    if (!dob || !customerId) return;
    setSaving(true);
    setSaveError(null);
    try {
      await api(`/api/customers/${customerId}`, {
        method: 'PATCH',
        body: JSON.stringify({ dateOfBirth: dob }),
      }, token);
      onResolved();
    } catch (err) {
      setSaveError(err?.message || 'No se pudo guardar la fecha de nacimiento');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div style={cardStyle}>
      <h3 style={h3Style}>Checkout bloqueado · reglas de edad</h3>
      <div style={{ marginBottom: 12 }}>
        <KV label="Reservación" value={`#${reservation.reservationNumber || reservation.id}`} />
        <KV label="Cliente" value={`${reservation.customer?.firstName || ''} ${reservation.customer?.lastName || ''}`.trim() || '—'} />
        <KV label="Fecha de nacimiento" value={reservation.customer?.dateOfBirth ? new Date(reservation.customer.dateOfBirth).toLocaleDateString() : '—'} />
        {rules.age != null && <KV label="Edad al pickup" value={String(rules.age)} />}
      </div>
      <div style={{
        padding: 12, marginBottom: 12,
        background: '#FEF2F2', border: '0.5px solid #EF4444', borderRadius: 6,
        color: '#991B1B', fontSize: 13,
      }}>
        <div style={{ fontWeight: 600, marginBottom: 4 }}>{copy.title}</div>
        {body}
      </div>
      {!isHardAgeBlock && (
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 12 }}>
          <input
            type="date"
            value={dob}
            onChange={(e) => setDob(e.target.value)}
            style={{ padding: '8px 10px', border: '0.5px solid #E5E7EB', borderRadius: 6, fontSize: 13 }}
          />
          <button
            style={{ ...primaryBtn, opacity: dob && !saving ? 1 : 0.4 }}
            disabled={!dob || saving}
            onClick={saveDob}
          >
            {saving ? 'Guardando…' : 'Guardar y continuar'}
          </button>
        </div>
      )}
      {isHardAgeBlock && (
        <div style={{ fontSize: 12, color: '#6B7280', marginBottom: 12 }}>
          ¿Fecha de nacimiento incorrecta? Corrígela:
          {' '}
          <input
            type="date"
            value={dob}
            onChange={(e) => setDob(e.target.value)}
            style={{ padding: '6px 8px', border: '0.5px solid #E5E7EB', borderRadius: 6, fontSize: 12, marginRight: 8 }}
          />
          <button
            style={{ ...ghostBtn, fontSize: 12, opacity: dob && !saving ? 1 : 0.4 }}
            disabled={!dob || saving}
            onClick={saveDob}
          >
            {saving ? 'Guardando…' : 'Corregir'}
          </button>
        </div>
      )}
      {saveError && (
        <div style={{ fontSize: 12, color: '#B91C1C', marginBottom: 12 }}>{saveError}</div>
      )}
      <a href={`/reservations/${reservation.id}`} style={{ fontSize: 13 }}>← Volver a la reservación</a>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Per-step renderers (Phase 1 stubs — real content in Phases 2-4)
// ---------------------------------------------------------------------------

function Step1Confirm({ reservation, session, token, onNext }) {
  // Declined-insurance toggle. Persists to RentalAgreement.declinedInsurance
  // via /api/checkout-sessions/:id/declined-insurance. The T&C signing
  // flow (Phase 3) reads the flag to inject the addendum section into
  // the customer's signing UI; the PDF generator emits the
  // acknowledgement page.
  const [declinedInsurance, setDeclinedInsurance] = useState(
    !!reservation.rentalAgreement?.declinedInsurance,
  );
  const [savingDecline, setSavingDecline] = useState(false);
  const [declineError, setDeclineError] = useState(null);

  const persistDecline = async (next) => {
    const previous = declinedInsurance;
    setDeclinedInsurance(next);
    setDeclineError(null);
    if (!session?.id) return;
    setSavingDecline(true);
    try {
      await api(`/api/checkout-sessions/${session.id}/declined-insurance`, {
        method: 'POST',
        body: JSON.stringify({ declined: next }),
      }, token);
    } catch (err) {
      // The backend refuses this write once the customer has signed, or while
      // they are signing (409 TC_ALREADY_COMPLETED / TC_SIGNING_IN_PROGRESS).
      // Swallowing that left the switch showing the OPPOSITE of what is stored
      // with no message — the agent believes they changed a legal flag they did
      // not. Roll the optimistic set back and say why.
      //
      // The sentence comes from the server (messageFor() in
      // insurance-selection-gate.js), so the wording lives next to the rule
      // instead of being restated here and drifting from it.
      setDeclinedInsurance(previous);
      setDeclineError(err?.message || 'Could not save the insurance selection. Please try again.');
    } finally {
      setSavingDecline(false);
    }
  };

  // beta.116 — NO-CAR-NO-CHECKOUT: a reservation with no vehicle can't pass
  // step 1. The backend rejects session-start with 422 NO_VEHICLE_ASSIGNED,
  // but disable the button here too so the agent gets an immediate, clear
  // reason instead of a failed call.
  const hasVehicle = !!(reservation.vehicleId || reservation.vehicle?.id);

  return (
    <div style={cardStyle}>
      <h3 style={h3Style}>Step 1 · Confirm customer + vehicle</h3>
      <div style={{ marginBottom: 12 }}>
        <KV label="Customer" value={`${reservation.customer?.firstName} ${reservation.customer?.lastName}`} />
        <KV label="Phone" value={reservation.customer?.phone || '—'} />
        {reservation.ageRules?.enforced && (
          <KV
            label="Age"
            value={reservation.ageRules?.age != null
              ? `${reservation.ageRules.age} (DOB ${reservation.customer?.dateOfBirth ? new Date(reservation.customer.dateOfBirth).toLocaleDateString() : '—'})`
              : '—'}
          />
        )}
        <KV label="Vehicle" value={reservation.vehicle ? `${reservation.vehicle.year} ${reservation.vehicle.make} ${reservation.vehicle.model} · ${reservation.vehicle.plate}` : 'Not assigned'} />
        <KV label="Pickup" value={reservation.pickupAt ? new Date(reservation.pickupAt).toLocaleString() : '—'} />
        <KV label="Return" value={reservation.returnAt ? new Date(reservation.returnAt).toLocaleString() : '—'} />
      </div>
      {hasDisplayNotes(reservation.notes) && (
        <div style={{
          padding: 12, marginBottom: 12,
          background: 'rgba(110,73,255,.06)', border: '0.5px solid rgba(110,73,255,.35)', borderRadius: 6,
          color: '#3b2d66', fontSize: 13,
        }}>
          <div style={{ fontWeight: 600, marginBottom: 4 }}>
            📝 Notas de la reservación
            {isRecentNote(reservation.notesUpdatedAt) && (
              <span style={{
                marginLeft: 8, padding: '1px 8px', borderRadius: 999, fontSize: 10,
                fontWeight: 700, textTransform: 'uppercase', background: '#6d28d9', color: '#fff',
              }}>
                Nueva · {relativeNoteAge(reservation.notesUpdatedAt)}
              </span>
            )}
          </div>
          {displayNoteLines(reservation.notes).map((line, i) => (
            <div key={i} style={{ marginTop: i === 0 ? 0 : 2 }}>{line}</div>
          ))}
        </div>
      )}
      {reservation.ageRules?.status === 'UNDERAGE_BAND' && (
        <div style={{
          padding: 12, marginBottom: 12,
          background: '#FEF3C7', border: '0.5px solid #F59E0B', borderRadius: 6,
          color: '#92400E', fontSize: 13,
        }}>
          <div style={{ fontWeight: 600, marginBottom: 2 }}>
            Conductor joven ({reservation.ageRules.age} años)
          </div>
          Entre {reservation.ageRules.minAge} y {reservation.ageRules.bandMaxAge} años aplica el
          cargo obligatorio de conductor joven — se agrega automáticamente al total en el paso de pago.
        </div>
      )}
      {!hasVehicle && (
        <div style={{
          padding: 12, marginBottom: 12,
          background: '#FEF2F2', border: '0.5px solid #EF4444', borderRadius: 6,
          color: '#991B1B', fontSize: 13,
        }}>
          No hay vehículo asignado a esta reservación. Asigna un carro desde la
          reservación antes de iniciar el checkout — el contrato no puede
          generarse sin vehículo.
        </div>
      )}
      {reservation.workflowMode !== 'DEALERSHIP_LOANER' && (
      <div style={{
        padding: 12, marginBottom: 12,
        background: declinedInsurance ? '#FEF3C7' : '#F9FAFB',
        border: `0.5px solid ${declinedInsurance ? '#F59E0B' : '#E5E7EB'}`,
        borderRadius: 6,
      }}>
        <label style={{ display: 'flex', alignItems: 'flex-start', gap: 10, cursor: 'pointer' }}>
          <input
            type="checkbox"
            checked={declinedInsurance}
            onChange={(e) => persistDecline(e.target.checked)}
            style={{ width: 16, height: 16, marginTop: 2, accentColor: '#F59E0B' }}
            disabled={savingDecline}
          />
          <div>
            <div style={{ fontWeight: 500, color: declinedInsurance ? '#92400E' : '#374151', fontSize: 13 }}>
              Customer declines counter insurance
            </div>
            <div style={{ fontSize: 11, color: '#6B7280', marginTop: 2 }}>
              Adds a Declined Insurance acknowledgement section to T&amp;C — customer initials it on their phone in step 2.
            </div>
            {declineError && (
              <div
                role="alert"
                style={{
                  fontSize: 11, color: '#991B1B', background: '#FEF2F2',
                  border: '0.5px solid #FCA5A5', borderRadius: 6,
                  padding: '6px 8px', marginTop: 6,
                }}
              >
                {declineError}
              </div>
            )}
          </div>
        </label>
      </div>
      )}
      <button
        style={{ ...primaryBtn, opacity: hasVehicle ? 1 : 0.4, cursor: hasVehicle ? 'pointer' : 'not-allowed' }}
        onClick={hasVehicle ? onNext : undefined}
        disabled={!hasVehicle}
        title={hasVehicle ? undefined : 'Asigna un vehículo a la reservación primero'}
      >
        Start checkout →
      </button>
    </div>
  );
}

/**
 * Step 2 — the renderer switch (design decision D2).
 *
 * The SERVER decides which surface signs: GET /terminal-contract answers with
 * `mode`. Deciding here would mean the client could draw a terminal ladder for
 * a counter whose QD2 is not configured, and the agent would sit watching a
 * device that was never sent anything.
 *
 * Both branches end the same way — `tcCompletedAt` on the session — so the
 * fallback below is a change of surface, not a change of state. That is the
 * whole reason it is safe to offer mid-contract.
 */
function Step2TermsPending({ session, reservation, token, onSigned }) {
  const [mode, setMode] = useState(null); // null = still asking the server
  const [forcedPhone, setForcedPhone] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const state = await getTerminalContract({ id: session.id, token });
        if (!cancelled) setMode(state?.mode === 'TERMINAL' ? 'TERMINAL' : 'PHONE');
      } catch {
        // A read that fails must not strand the agent: PHONE is the flow every
        // tenant has always had, and it needs no device to work.
        if (!cancelled) setMode('PHONE');
      }
    })();
    return () => { cancelled = true; };
  }, [session.id, token]);

  if (mode === null) {
    return (
      <div style={cardStyle}>
        <div style={{ color: '#6B7280' }}>…</div>
      </div>
    );
  }
  if (mode === 'TERMINAL' && !forcedPhone) {
    return (
      <Step2TerminalContract
        session={session} reservation={reservation} token={token}
        onSigned={onSigned}
        onFellBack={() => setForcedPhone(true)}
      />
    );
  }
  return <Step2PhoneTerms session={session} reservation={reservation} token={token} onSigned={onSigned} />;
}

function Step2PhoneTerms({ session, reservation, token, onSigned }) {
  const [tokenInfo, setTokenInfo] = useState(null);
  const [minting, setMinting] = useState(false);

  const mint = async () => {
    setMinting(true);
    try {
      const t = await mintTermsToken({ id: session.id, token });
      setTokenInfo(t);
    } catch (err) {
      // ignore — user can retry
    } finally {
      setMinting(false);
    }
  };

  // Auto-mint on first render
  useEffect(() => { if (!tokenInfo && !minting) mint(); }, []);

  return (
    <div style={cardStyle}>
      <h3 style={h3Style}>Step 2 · Customer signs Terms &amp; Conditions</h3>
      <div style={{ background: '#F9FAFB', padding: 24, borderRadius: 8, textAlign: 'center', marginBottom: 16 }}>
        {tokenInfo ? (
          <>
            <div style={{ fontSize: 12, color: '#6B7280', marginBottom: 12 }}>QR · expires in 15 min</div>
            <QrCode
              size={220}
              url={`${typeof window !== 'undefined' ? window.location.origin : ''}/sign/${tokenInfo.token}`}
            />
            <div style={{ fontFamily: 'monospace', fontSize: 10, wordBreak: 'break-all', padding: '8px 12px', background: '#FFFFFF', borderRadius: 4, marginTop: 12, color: '#6B7280' }}>
              {`${typeof window !== 'undefined' ? window.location.origin : ''}/sign/${tokenInfo.token}`}
            </div>
            <div style={{ fontSize: 12, color: '#6B7280', marginTop: 12 }}>Customer scans with their phone</div>
          </>
        ) : (
          <div style={{ color: '#6B7280' }}>Minting QR token…</div>
        )}
      </div>
      <div style={{ display: 'flex', gap: 8, justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <div style={{ fontSize: 13, color: '#6B7280' }}>
          <span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: '50%', background: '#F59E0B', marginRight: 6 }} />
          Waiting for customer signature…
        </div>
        <button style={ghostBtn} onClick={mint} disabled={minting}>Re-issue QR</button>
      </div>
      {/* Phase 1 dev shortcut — simulates customer completing T&C */}
      <DevSimulateButton
        label="Simulate customer completed T&C"
        sessionId={session.id}
        token={token}
        field="tcCompletedAt"
        onDone={onSigned}
      />
    </div>
  );
}

/**
 * Which terminal at THIS counter (2026-09-04). Renders only when the pickup
 * location has more than one enabled register (LAX Counter 1 / Counter 2) —
 * legacy single-terminal tenants and single-register branches see nothing.
 * The pick is stored on the SESSION, so the contract, the sale and the deposit
 * all run on the same device. When nothing is picked the backend uses the
 * location's first register; the picker shows which one that is and nudges the
 * agent to confirm it is the device in front of the renter.
 */
function TerminalPicker({ session, token }) {
  const { t } = useTranslation();
  const [info, setInfo] = useState(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  const load = async () => {
    try {
      setInfo(await getTerminalOptions({ id: session.id, token }));
    } catch {
      // The selector is a convenience read — it must never block the step.
    }
  };
  useEffect(() => { load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [session.id]);

  if (!info || !info.selectable) return null;

  const current = info.selectedRegisterId || info.options[0]?.id || '';
  const pick = async (registerId) => {
    setSaving(true); setError(null);
    try {
      setInfo(await selectTerminalRegister({ id: session.id, registerId, token }));
    } catch (err) {
      setError(err?.message || t('terminalPicker.error', 'Could not select that terminal'));
      await load();
    } finally { setSaving(false); }
  };

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', margin: '0 0 14px', padding: '8px 12px', background: '#F9FAFB', border: '0.5px solid #E5E7EB', borderRadius: 6 }}>
      <span style={{ fontSize: 12, color: '#374151', fontWeight: 600 }}>
        {t('terminalPicker.label', 'Terminal')}
      </span>
      <select
        value={current}
        disabled={saving}
        onChange={(e) => pick(e.target.value)}
        style={{ fontSize: 12.5, padding: '4px 8px', borderRadius: 6, border: '0.5px solid #D1D5DB', background: '#FFFFFF' }}
      >
        {info.options.map((o) => (
          <option key={o.id} value={o.id} disabled={!o.complete}>
            {o.name} · {o.maskedTpn}{o.complete ? '' : t('terminalPicker.incomplete', ' — not configured')}
          </option>
        ))}
      </select>
      {!info.selectedRegisterId ? (
        <>
          <button style={{ ...ghostBtn, fontSize: 11.5 }} disabled={saving} onClick={() => pick(current)}>
            {t('terminalPicker.confirm', 'Use this terminal')}
          </button>
          <span style={{ fontSize: 11.5, color: '#92400e' }}>
            {t('terminalPicker.autoNote', 'This counter has several terminals — confirm which device is in front of the renter.')}
          </span>
        </>
      ) : null}
      {error ? <span style={{ fontSize: 11.5, color: '#B91C1C' }}>{error}</span> : null}
    </div>
  );
}

/**
 * Step 2 on the Dejavoo QD2 — the agent's ladder.
 *
 * The mockup's rule, kept: THIS LADDER IS DRIVEN BY THE TERMINAL'S OWN
 * RESPONSES, NOT BY A TIMER. Every row moves because a call came back, so what
 * the agent sees is what the device did. The only countdown on screen is the
 * one the gateway itself asked for (2008's DelayBeforeNextRequest), and it is
 * labelled as such.
 *
 * The clause is sent ONE AT A TIME rather than as a server-side loop. Six calls
 * inside one request would hold the connection for up to twelve minutes and
 * give the agent nothing to look at while the renter is on clause 4.
 *
 * EN/ES on every string, laid out at Spanish length (~30% longer) per the
 * mockup, because LAX is US but PR tenants share this codebase.
 */
function Step2TerminalContract({ session, reservation, token, onSigned, onFellBack }) {
  const { t } = useTranslation();
  const [state, setState] = useState(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState(null); // { message, terminal }
  const [countdown, setCountdown] = useState(0);
  const [qr, setQr] = useState(null);

  const load = async () => {
    try {
      setState(await getTerminalContract({ id: session.id, token }));
    } catch (err) {
      setFailure({ message: err?.message || String(err), terminal: err?.terminal || null });
    }
  };
  useEffect(() => { load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [session.id]);

  // The gateway's own countdown. A real number it told us to wait, ticked down
  // so the agent can see it move — an agent told "wait 30" with a frozen number
  // reloads the page, which is how a second 2008 happens.
  useEffect(() => {
    if (countdown <= 0) return undefined;
    const id = setTimeout(() => setCountdown((n) => n - 1), 1000);
    return () => clearTimeout(id);
  }, [countdown]);

  const runFailure = (err) => {
    const terminal = err?.terminal || null;
    setFailure({ message: err?.message || String(err), terminal });
    if (terminal?.retryAfterSeconds) setCountdown(terminal.retryAfterSeconds);
  };

  const sendClause = async (sectionKey) => {
    setBusy(true); setFailure(null);
    try {
      setState(await runTerminalClause({ id: session.id, sectionKey, token }));
    } catch (err) {
      runFailure(err);
      await load();
    } finally { setBusy(false); }
  };

  const sign = async () => {
    setBusy(true); setFailure(null);
    try {
      await captureTerminalSignature({ id: session.id, token });
      onSigned();
    } catch (err) {
      runFailure(err);
      await load();
    } finally { setBusy(false); }
  };

  // ONE control moves the contract to the phone. D5: three independent
  // fallbacks produce a checkout signed on the terminal, paid by link, holding
  // no deposit, with nobody noticing until the car comes back damaged.
  const fallBack = async () => {
    setBusy(true);
    try {
      const out = await fallbackTerminalContract({
        id: session.id, reason: failure?.terminal?.state || null, token,
      });
      setQr(out?.token || null);
      onFellBack();
    } catch (err) {
      runFailure(err);
    } finally { setBusy(false); }
  };

  if (!state) {
    return (
      <div style={cardStyle}>
        <h3 style={h3Style}>{t('terminalContract.title', 'Step 2 · Contract on the terminal')}</h3>
        <div style={{ color: '#6B7280' }}>{t('terminalContract.loading', 'Reading the counter\'s terminal…')}</div>
        {failure ? <div style={{ ...modalError, marginTop: 12 }}>{failure.message}</div> : null}
      </div>
    );
  }

  const actions = terminalActionsFor(failure?.terminal?.verdict);
  const declined = state.clauses.find((c) => c.key === state.declinedSectionKey) || null;
  const next = state.clauses.find((c) => c.key === state.nextSectionKey) || null;

  return (
    <div style={cardStyle}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap', marginBottom: 4 }}>
        <h3 style={{ ...h3Style, margin: 0 }}>
          {t('terminalContract.title', 'Step 2 · Contract on the terminal')}
        </h3>
        <span style={{ fontSize: 12, color: '#6B7280', fontVariantNumeric: 'tabular-nums' }}>
          {t('terminalContract.progress', '{{done}} of {{total}} clauses accepted', {
            done: state.acceptedCount, total: state.total,
          })}
        </span>
      </div>
      <p style={{ fontSize: 12.5, color: '#6B7280', margin: '0 0 14px', lineHeight: 1.5 }}>
        {t('terminalContract.hint',
          'Hand the QD2 to the renter. This list is driven by the terminal\'s own answers — it is not a timer.')}
      </p>

      <TerminalPicker session={session} token={token} />

      {state.clauseLengthError ? (
        <div style={{ ...modalError, marginBottom: 14 }}>{state.clauseLengthError}</div>
      ) : null}

      {/* The ladder */}
      <div style={{ border: '0.5px solid #E5E7EB', borderRadius: 8, overflow: 'hidden', marginBottom: 14 }}>
        {state.clauses.map((c) => {
          const isNext = c.key === state.nextSectionKey;
          return (
            <div
              key={c.key}
              style={{
                display: 'grid', gridTemplateColumns: '26px 1fr auto', gap: 11,
                alignItems: 'center', padding: '9px 13px', minHeight: 44,
                borderBottom: '0.5px solid #F3F4F6', fontSize: 12.5,
                background: c.declined ? ALERT.bg : (isNext ? '#F5F3FF' : '#FFFFFF'),
              }}
            >
              <span
                aria-hidden="true"
                style={{
                  width: 18, height: 18, borderRadius: '50%', display: 'grid',
                  placeItems: 'center', fontSize: 10, fontWeight: 700,
                  background: c.accepted ? '#E6F7F1' : (c.declined ? ALERT.bg : '#F3F4F6'),
                  color: c.accepted ? '#08674E' : (c.declined ? ALERT.tx : '#6B7280'),
                  border: '0.5px solid #E5E7EB',
                }}
              >
                {c.accepted ? '✓' : c.index}
              </span>
              <span>
                <b style={{ display: 'block', fontWeight: 600, color: '#111827' }}>{c.label}</b>
                <small style={{ fontSize: 11, color: '#6B7280' }}>
                  {c.accepted || c.declined
                    // The VERBATIM option the renter pressed. Not "accepted" —
                    // the exact button text, which is what the audit trail keeps
                    // and what the printed agreement shows beside this clause.
                    ? `${c.choiceOption} · ${new Date(c.acceptedAt).toLocaleTimeString()}`
                    : (isNext
                      ? t('terminalContract.onScreen', 'Next on the terminal')
                      : t('terminalContract.waiting', 'Waiting'))}
                </small>
              </span>
              {c.accepted && !isNext ? (
                <button
                  style={{ ...ghostBtn, fontSize: 11 }}
                  disabled={busy}
                  onClick={() => sendClause(c.key)}
                >
                  {t('terminalContract.resendClause', 'Re-send')}
                </button>
              ) : <span />}
            </div>
          );
        })}
      </div>

      {failure ? (
        <div style={{ ...modalError, marginBottom: 14 }}>
          <div style={{ fontWeight: 600 }}>
            {failure.terminal?.state
              ? t(`terminalContract.state.${failure.terminal.state}`, failure.terminal.state)
              : t('terminalContract.state.UNKNOWN', 'The terminal did not answer')}
          </div>
          <div>{failure.message}</div>
          {actions.wait && countdown > 0 ? (
            <div style={{ marginTop: 6, fontVariantNumeric: 'tabular-nums' }}>
              {t('terminalContract.busyCountdown',
                'The gateway asked us to wait {{seconds}}s before sending again.',
                { seconds: countdown })}
            </div>
          ) : null}
        </div>
      ) : null}

      {declined ? (
        <div style={{ background: WARN.bg, border: `0.5px solid ${WARN.bd}`, color: WARN.tx, borderRadius: 6, padding: '10px 12px', fontSize: 12.5, marginBottom: 14, lineHeight: 1.5 }}>
          {t('terminalContract.declined',
            'The renter declined “{{label}}”. This is a conversation, not a retry — resolve it with them, then re-send that clause or go back to step 1 to change their coverage.',
            { label: declined.label })}
        </div>
      ) : null}

      {qr ? (
        <div style={{ background: '#F9FAFB', padding: 20, borderRadius: 8, textAlign: 'center', marginBottom: 14 }}>
          <div style={{ fontSize: 12, color: '#6B7280', marginBottom: 10 }}>
            {t('terminalContract.qrHint',
              'The renter scans this and continues on their phone. The clauses they already accepted on the terminal are carried over.')}
          </div>
          <QrCode
            size={200}
            url={`${typeof window !== 'undefined' ? window.location.origin : ''}/sign/${qr}`}
          />
        </div>
      ) : null}

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        {state.allAccepted ? (
          <button style={primaryBtn} disabled={busy || !!state.clauseLengthError} onClick={sign}>
            {t('terminalContract.capture', 'Capture signature on the terminal')}
          </button>
        ) : (
          <button
            style={primaryBtn}
            disabled={busy || !next || !!state.declinedSectionKey || !!state.clauseLengthError
              || (actions.wait && countdown > 0)}
            onClick={() => sendClause(null)}
          >
            {next
              ? t('terminalContract.send', 'Send “{{label}}” to the terminal', { label: next.label })
              : t('terminalContract.send_none', 'Send to the terminal')}
          </button>
        )}
        {actions.resend && next ? (
          <button style={ghostBtn} disabled={busy} onClick={() => sendClause(next.key)}>
            {t('terminalContract.resend', 'Re-send this clause')}
          </button>
        ) : null}
        <span style={{ flex: 1 }} />
        {/* Always available, not only after a failure: the agent may simply see
            the renter is struggling with the device. */}
        <button style={ghostBtn} disabled={busy} onClick={fallBack}>
          {t('terminalContract.fallback', 'Switch this checkout to the renter\'s phone')}
        </button>
      </div>
      <p style={{ fontSize: 11.5, color: '#6B7280', margin: '10px 0 0', lineHeight: 1.5 }}>
        {t('terminalContract.fallbackCost',
          'Falling back moves the contract to the phone. Payment and the deposit move with it — they do not stay on the terminal.')}
      </p>
    </div>
  );
}

function Step3PaymentPending({ session, reservation, token, onPaid }) {
  // ── Source-of-truth math ─────────────────────────────────────────
  // Split the agreement charges: rental SALE = non-deposit charges − paid, and
  // the deposit = SECURITY_DEPOSIT charges. This mirrors the server (which is
  // authoritative). We do NOT use `balance` — it's inconsistent (sometimes it
  // includes the deposit, sometimes not), which made the sale display wrong.
  const agreementCharges = Array.isArray(reservation.rentalAgreement?.charges)
    ? reservation.rentalAgreement.charges : [];
  const isDepositCharge = (c) => String(c.source || '').toUpperCase() === 'SECURITY_DEPOSIT';
  const rentalChargesSum = agreementCharges
    .filter((c) => !isDepositCharge(c)).reduce((s, c) => s + Number(c.total || 0), 0);
  const securityDepositChargesSum = agreementCharges
    .filter(isDepositCharge).reduce((s, c) => s + Number(c.total || 0), 0);
  const paidSoFar = Number(reservation.rentalAgreement?.paidAmount || 0);
  // Fall back to balance / estimatedTotal only if no charges were loaded.
  const rentalFallback = Number.isFinite(Number(reservation.rentalAgreement?.balance))
    ? Number(reservation.rentalAgreement.balance)
    : Number(reservation.estimatedTotal || 0);
  const subtotal = agreementCharges.length > 0
    ? Number(Math.max(0, rentalChargesSum - paidSoFar).toFixed(2))
    : Number(Math.max(0, rentalFallback).toFixed(2));
  const isPrepaid = subtotal === 0;

  // 2026-05-29 — Deposit hold amount comes from the reservation's
  // configured securityDepositAmount (or the SECURITY_DEPOSIT charges
  // sum as a fallback). NO $500 hardcoded default — if the reservation
  // doesn't require a deposit (vehicle class with no deposit, comped
  // rental, etc.) the wizard treats it as $0 and the hold step
  // becomes a no-op rather than charging the customer for something
  // their reservation didn't price in.
  const agreementDepositCol = Number(reservation.rentalAgreement?.securityDepositAmount);
  let depositAmount;
  if (Number.isFinite(agreementDepositCol) && agreementDepositCol > 0) {
    depositAmount = agreementDepositCol;
  } else if (securityDepositChargesSum > 0) {
    depositAmount = securityDepositChargesSum;
  } else {
    depositAmount = 0;
  }

  // ── Two-tap state machine (2026-05-29) ───────────────────────────
  // Tap 1 (sale): saleStatus = 'idle' → 'running' → 'done' / 'error'
  // Tap 2 (deposit hold): depositStatus = 'idle' → 'running' → 'done' / 'error'
  //
  // Pre-paid customers skip tap 1 — saleStatus stays 'skipped' and the
  // deposit-hold button shows immediately. A failed deposit hold does
  // NOT roll back a successful sale; the agent re-clicks the deposit
  // button to try again.
  const [saleStatus, setSaleStatus] = useState(isPrepaid ? 'skipped' : 'idle');
  const [depositStatus, setDepositStatus] = useState('idle');
  const [saleResult, setSaleResult] = useState(null);
  const [depositResult, setDepositResult] = useState(null);
  const [saleError, setSaleError] = useState(null);
  const [depositError, setDepositError] = useState(null);

  // Manual-override modals (2026-05-29 failsafe). The terminal can fail
  // mid-checkout; the agent uses these to unblock the wizard by recording
  // what actually happened (cash collected, external auth, waived).
  const [showManualSale, setShowManualSale] = useState(false);
  const [showManualDeposit, setShowManualDeposit] = useState(false);

  const saleDone = saleStatus === 'done' || saleStatus === 'skipped';

  // ── Tap 1 — charge the rental ────────────────────────────────────
  const runSale = async () => {
    setSaleStatus('running');
    setSaleError(null);
    try {
      const r = await api(`/api/checkout-sessions/${session.id}/charge-sale`, {
        method: 'POST',
        body: JSON.stringify({ amount: subtotal }),
      }, token);
      setSaleResult(r);
      setSaleStatus('done');
    } catch (err) {
      setSaleError(err?.message || 'Sale failed');
      setSaleStatus('error');
    }
  };

  // ── Tap 2 — hold the deposit ─────────────────────────────────────
  const runDepositHold = async () => {
    setDepositStatus('running');
    setDepositError(null);
    try {
      const r = await api(`/api/checkout-sessions/${session.id}/hold-deposit`, {
        method: 'POST',
        body: JSON.stringify({ depositAmount }),
      }, token);
      setDepositResult(r);
      setDepositStatus('done');
      // Backend stamped paymentCompletedAt — advance the wizard.
      onPaid();
    } catch (err) {
      setDepositError(err?.message || 'Deposit hold failed');
      setDepositStatus('error');
    }
  };

  // ── Failsafe — record a manual payment (terminal bypass) ─────────
  const submitManualSale = async ({ amount, method, reference, notes }) => {
    try {
      const r = await api(`/api/checkout-sessions/${session.id}/record-manual-payment`, {
        method: 'POST',
        body: JSON.stringify({ amount, method, reference, notes }),
      }, token);
      setSaleResult({
        sale: { authCode: r.reference, manual: true },
        cardOnFile: null,
      });
      setSaleStatus('done');
      setShowManualSale(false);
    } catch (err) {
      throw err; // surfaced by the modal itself
    }
  };

  // ── Failsafe — record a manual deposit (terminal bypass) ─────────
  const submitManualDeposit = async ({ amount, method, reason, reference }) => {
    try {
      const r = await api(`/api/checkout-sessions/${session.id}/record-manual-deposit`, {
        method: 'POST',
        body: JSON.stringify({ amount, method, reason, reference }),
      }, token);
      setDepositResult({
        preauth: { authCode: r.depositRefId, manual: true },
        cardOnFile: null,
      });
      setDepositStatus('done');
      setShowManualDeposit(false);
      onPaid();
    } catch (err) {
      throw err; // surfaced by the modal itself
    }
  };

  return (
    <div style={cardStyle}>
      <h3 style={h3Style}>Step 3 · Payment</h3>
      <p style={{ fontSize: 13, color: '#6B7280', margin: '0 0 12px' }}>
        {isPrepaid
          ? `Customer already pre-paid. One card tap on the terminal will capture the card on file and place the $${depositAmount.toFixed(2)} security deposit hold.`
          : `Customer taps card once for the $${subtotal.toFixed(2)} rental sale, then enters their phone or email at the terminal. The $${depositAmount.toFixed(2)} deposit hold runs automatically against the saved card — no second tap.`}
      </p>
      <TerminalPicker session={session} token={token} />
      <div style={{
        margin: '0 0 16px',
        padding: '10px 12px',
        borderRadius: 6,
        background: 'rgba(245,158,11,.08)',
        border: '0.5px solid rgba(245,158,11,.3)',
        color: '#92400e',
        fontSize: 12,
        lineHeight: 1.45,
      }}>
        <strong>Required:</strong> the customer must enter their phone number or email on the
        terminal after tapping their card. Without contact info captured, the saved-card
        deposit hold will fail.
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 16 }}>
        {/* Invoice column */}
        <div>
          <div style={{ fontSize: 14, fontWeight: 500, marginBottom: 8 }}>Invoice</div>
          {isPrepaid ? (
            <KV label="Balance due" value="$0.00 · pre-paid" />
          ) : (
            <KV label="Subtotal" value={`$${subtotal.toFixed(2)}`} />
          )}
          <KV label="Pre-auth deposit" value={`$${depositAmount.toFixed(2)}`} />
        </div>

        {/* Terminal status column */}
        <div style={{ background: '#F9FAFB', padding: 12, borderRadius: 6 }}>
          <div style={{ fontSize: 12, fontWeight: 500, marginBottom: 4 }}>Dejavoo terminal</div>
          {saleStatus === 'idle' && depositStatus === 'idle' && (
            <div style={{ fontSize: 12, color: '#10B981', marginTop: 8 }}>● Ready</div>
          )}
          {saleStatus === 'running' && (
            <div style={{ fontSize: 12, color: '#F59E0B', marginTop: 8 }}>● Waiting for sale tap…</div>
          )}
          {depositStatus === 'running' && (
            <div style={{ fontSize: 12, color: '#F59E0B', marginTop: 8 }}>
              ● {isPrepaid ? 'Waiting for card tap…' : 'Authorizing saved card…'}
            </div>
          )}
        </div>
      </div>

      {/* ── Debit-card advisory (2026-06-04) ─────────────────────── */}
      {/* Shown once the sale tap reveals a DEBIT card. The deposit hold
          amount itself is resolved SERVER-SIDE at hold time (per-location
          securityDepositAmountDebit uplift) — we never duplicate that
          logic here. After the hold completes, depositResult.amount is
          the authoritative held amount and we surface it when it differs
          from the standard amount previewed above. */}
      {saleStatus === 'done' && saleResult?.cardOnFile?.type === 'DEBIT' && (
        <div style={{
          marginTop: 16,
          padding: '10px 12px',
          borderRadius: 6,
          background: 'rgba(245,158,11,.08)',
          border: '0.5px solid rgba(245,158,11,.3)',
          color: '#92400e',
          fontSize: 12,
          lineHeight: 1.45,
        }}>
          <strong>Debit card detected</strong> — the deposit hold uses the debit amount
          {depositStatus === 'done' && Number(depositResult?.amount) > 0 && Number(depositResult.amount) !== depositAmount
            ? ` ($${Number(depositResult.amount).toFixed(2)})`
            : ''}.
          {' '}Refunds to debit cards can take up to 30 days.
        </div>
      )}

      {/* ── Two-step transaction tracker ─────────────────────────── */}
      <div style={{ marginTop: 16, border: '0.5px solid #E5E7EB', borderRadius: 6 }}>
        {/* Step A — Rental sale */}
        {!isPrepaid && (
          <PaymentRow
            label="Rental sale"
            amount={subtotal}
            status={saleStatus}
            errorMsg={saleError}
            authCode={saleResult?.sale?.authCode}
            cardOnFile={saleResult?.cardOnFile}
            primaryAction={
              saleStatus === 'idle'
                ? { label: `Charge $${subtotal.toFixed(2)}`, onClick: runSale }
                : saleStatus === 'error'
                  ? { label: 'Retry sale', onClick: runSale }
                  : null
            }
            secondaryAction={
              saleStatus === 'done' || saleStatus === 'skipped'
                ? null
                : {
                    label: 'Record manually',
                    title: 'Terminal bypass — record cash/check/external card payment',
                    onClick: () => setShowManualSale(true),
                  }
            }
          />
        )}

        {/* Step B — Deposit hold (only enabled after sale, or immediately if pre-paid) */}
        <PaymentRow
          label="Security deposit hold"
          amount={depositStatus === 'done' && Number(depositResult?.amount) > 0 ? Number(depositResult.amount) : depositAmount}
          status={depositStatus}
          errorMsg={depositError}
          authCode={depositResult?.preauth?.authCode}
          cardOnFile={depositResult?.cardOnFile}
          disabled={!saleDone}
          divider={!isPrepaid}
          primaryAction={
            !saleDone
              ? { label: 'Charge sale first', disabled: true }
              : depositStatus === 'idle'
                ? {
                    label: isPrepaid
                      ? `Capture card + hold $${depositAmount.toFixed(2)}`
                      : `Authorize $${depositAmount.toFixed(2)} on saved card`,
                    onClick: runDepositHold,
                  }
                : depositStatus === 'error'
                  ? { label: 'Retry deposit hold', onClick: runDepositHold }
                  : null
          }
          secondaryAction={
            depositStatus === 'done' || !saleDone
              ? null
              : {
                  label: 'Record manually',
                  title: 'Terminal bypass — record cash/check deposit, external auth, or waiver',
                  onClick: () => setShowManualDeposit(true),
                }
          }
        />
      </div>

      {showManualSale && (
        <ManualSaleModal
          suggestedAmount={subtotal}
          onClose={() => setShowManualSale(false)}
          onSubmit={submitManualSale}
        />
      )}
      {showManualDeposit && (
        <ManualDepositModal
          suggestedAmount={depositAmount}
          onClose={() => setShowManualDeposit(false)}
          onSubmit={submitManualDeposit}
        />
      )}
    </div>
  );
}

/**
 * One row in the two-step transaction tracker — shared by the Sale and
 * Deposit Hold steps.
 */
function PaymentRow({ label, amount, status, errorMsg, authCode, cardOnFile, disabled, divider, primaryAction, secondaryAction }) {
  const statusColor = {
    idle: '#9CA3AF',
    running: '#F59E0B',
    done: '#10B981',
    skipped: '#10B981',
    error: '#B91C1C',
  }[status];
  const statusLabel = {
    idle: 'Awaiting tap',
    running: 'Processing…',
    done: 'Approved',
    skipped: 'Skipped',
    error: 'Declined',
  }[status];

  return (
    <div style={{
      padding: 14,
      borderTop: divider ? '0.5px solid #E5E7EB' : 'none',
      opacity: disabled ? 0.45 : 1,
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 8 }}>
        <div>
          <div style={{ fontWeight: 600, color: '#111827', fontSize: 14 }}>{label}</div>
          <div style={{ fontSize: 11, color: '#6B7280', marginTop: 2 }}>${Number(amount || 0).toFixed(2)}</div>
        </div>
        <div style={{ textAlign: 'right' }}>
          <div style={{ fontSize: 11, fontWeight: 600, color: statusColor }}>● {statusLabel}</div>
          {status === 'done' && authCode && (
            <div style={{ fontSize: 10, color: '#6B7280', marginTop: 2, fontFamily: 'monospace' }}>auth {authCode}</div>
          )}
          {status === 'done' && cardOnFile && (
            <div style={{ fontSize: 10, color: '#6B7280', marginTop: 2 }}>{cardOnFile.brand} ····{cardOnFile.last4}</div>
          )}
        </div>
      </div>
      {status === 'error' && errorMsg && (
        <div style={{
          fontSize: 11, color: '#B91C1C',
          background: 'rgba(220,38,38,.06)', border: '0.5px solid rgba(220,38,38,.2)',
          padding: '6px 8px', borderRadius: 4, marginBottom: 8,
        }}>{errorMsg}</div>
      )}
      {(primaryAction || secondaryAction) && (
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginTop: 4 }}>
          {primaryAction && (
            <button
              style={{ ...primaryBtn, opacity: primaryAction.disabled ? 0.4 : 1 }}
              disabled={primaryAction.disabled || status === 'running'}
              onClick={primaryAction.onClick}
            >
              {primaryAction.label}
            </button>
          )}
          {secondaryAction && (
            <button
              style={{ ...ghostBtn, opacity: secondaryAction.disabled ? 0.4 : 1 }}
              disabled={secondaryAction.disabled || status === 'running'}
              onClick={secondaryAction.onClick}
              title={secondaryAction.title || ''}
            >
              {secondaryAction.label}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Failsafe modal — record a payment manually when the Dejavoo terminal
 * isn't available (cash collected at counter, external auth from a
 * separate payment device, etc.). Backend writes a RentalAgreementPayment
 * row tagged "Manual sale" and advances the wizard without touching
 * Spin. Reason isn't required for sales — the method + reference is
 * enough audit trail because the customer signs the agreement PDF.
 */
function ManualSaleModal({ suggestedAmount, onClose, onSubmit }) {
  const [amount, setAmount] = useState(String(Number(suggestedAmount || 0).toFixed(2)));
  const [method, setMethod] = useState('CASH');
  const [reference, setReference] = useState('');
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const submit = async () => {
    const v = Number(amount);
    if (!Number.isFinite(v) || v <= 0) {
      setError('Enter a valid amount greater than zero');
      return;
    }
    if (method === 'CARD' && !reference.trim()) {
      setError('Reference (auth code or last 4) is required for CARD method');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await onSubmit({
        amount: v,
        method,
        reference: reference.trim() || undefined,
        notes: notes.trim() || undefined,
      });
    } catch (err) {
      setError(err?.message || 'Manual payment failed');
      setBusy(false);
    }
  };

  return (
    <div style={modalBackdrop}>
      <div style={modalCard}>
        <div style={modalHeader}>
          <h3 style={{ ...h3Style, margin: 0 }}>Record Manual Payment</h3>
          <button style={ghostBtn} onClick={onClose} disabled={busy}>Close</button>
        </div>
        <p style={modalHelp}>
          Use this when the Dejavoo terminal is unavailable. The wizard will advance
          as if the sale completed; nothing is sent to Spin. Card-on-file features
          (auto-charges, deposit re-auth) will not be available later.
        </p>
        <div style={modalField}>
          <label style={modalLabel}>Amount</label>
          <input
            type="number" min="0" step="0.01"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            style={inputStyle}
            disabled={busy}
          />
        </div>
        <div style={modalField}>
          <label style={modalLabel}>Method</label>
          <select
            value={method}
            onChange={(e) => setMethod(e.target.value)}
            style={inputStyle}
            disabled={busy}
          >
            <option value="CASH">Cash</option>
            <option value="CHECK">Check</option>
            <option value="CARD">Card (external terminal)</option>
            <option value="OTHER">Other</option>
          </select>
        </div>
        <div style={modalField}>
          <label style={modalLabel}>
            Reference {method === 'CARD' ? <span style={{ color: '#B91C1C' }}>*</span> : <span style={{ color: '#9CA3AF' }}>(optional)</span>}
          </label>
          <input
            value={reference}
            onChange={(e) => setReference(e.target.value)}
            placeholder={method === 'CARD' ? 'Auth code or last 4' : method === 'CHECK' ? 'Check #' : 'Receipt ID, etc.'}
            style={inputStyle}
            disabled={busy}
          />
        </div>
        <div style={modalField}>
          <label style={modalLabel}>Notes (optional)</label>
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="Anything the agent should remember about this manual entry"
            style={{ ...inputStyle, minHeight: 60, fontFamily: 'inherit' }}
            disabled={busy}
          />
        </div>
        {error && <div style={modalError}>{error}</div>}
        <div style={modalActions}>
          <button style={ghostBtn} onClick={onClose} disabled={busy}>Cancel</button>
          <button style={primaryBtn} onClick={submit} disabled={busy}>
            {busy ? 'Recording…' : 'Record Payment'}
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * Failsafe modal — record a deposit hold manually. Reason is REQUIRED
 * because the rental agent is overriding the standard authorization
 * flow; the audit log captures it. WAIVED is supported with a $0 amount
 * for legitimate waiver scenarios (loyalty customer, comped rental).
 */
function ManualDepositModal({ suggestedAmount, onClose, onSubmit }) {
  const [amount, setAmount] = useState(String(Number(suggestedAmount || 0).toFixed(2)));
  const [method, setMethod] = useState('CASH');
  const [reason, setReason] = useState('');
  const [reference, setReference] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const submit = async () => {
    const v = Number(amount);
    if (!Number.isFinite(v) || v < 0) {
      setError('Enter a valid amount (zero or greater)');
      return;
    }
    if (method !== 'WAIVED' && v <= 0) {
      setError('Amount must be greater than zero unless method is Waived');
      return;
    }
    if (String(reason).trim().length < 3) {
      setError('Reason is required (audit trail)');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await onSubmit({
        amount: v,
        method,
        reason: reason.trim(),
        reference: reference.trim() || undefined,
      });
    } catch (err) {
      setError(err?.message || 'Manual deposit failed');
      setBusy(false);
    }
  };

  return (
    <div style={modalBackdrop}>
      <div style={modalCard}>
        <div style={modalHeader}>
          <h3 style={{ ...h3Style, margin: 0 }}>Record Manual Deposit Hold</h3>
          <button style={ghostBtn} onClick={onClose} disabled={busy}>Close</button>
        </div>
        <p style={modalHelp}>
          Use this when the terminal can't place the hold (terminal down, customer
          paid cash deposit at counter, deposit waived for a comped rental).
          A reason is required for the audit log.
        </p>
        <div style={modalField}>
          <label style={modalLabel}>Amount</label>
          <input
            type="number" min="0" step="0.01"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            style={inputStyle}
            disabled={busy}
          />
          {method === 'WAIVED' && (
            <span style={{ fontSize: 11, color: '#6B7280', marginTop: 4 }}>
              Waived deposits can be $0.
            </span>
          )}
        </div>
        <div style={modalField}>
          <label style={modalLabel}>Method</label>
          <select
            value={method}
            onChange={(e) => setMethod(e.target.value)}
            style={inputStyle}
            disabled={busy}
          >
            <option value="CASH">Cash held at counter</option>
            <option value="CHECK">Check held at counter</option>
            <option value="CARD">Card (external terminal)</option>
            <option value="WAIVED">Waived (no hold)</option>
            <option value="OTHER">Other</option>
          </select>
        </div>
        <div style={modalField}>
          <label style={modalLabel}>Reason <span style={{ color: '#B91C1C' }}>*</span></label>
          <input
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="e.g. terminal offline, comped rental, returning loyalty customer"
            style={inputStyle}
            disabled={busy}
          />
        </div>
        <div style={modalField}>
          <label style={modalLabel}>Reference <span style={{ color: '#9CA3AF' }}>(optional)</span></label>
          <input
            value={reference}
            onChange={(e) => setReference(e.target.value)}
            placeholder="Receipt ID, external auth code, check #, etc."
            style={inputStyle}
            disabled={busy}
          />
        </div>
        {error && <div style={modalError}>{error}</div>}
        <div style={modalActions}>
          <button style={ghostBtn} onClick={onClose} disabled={busy}>Cancel</button>
          <button style={primaryBtn} onClick={submit} disabled={busy}>
            {busy ? 'Recording…' : 'Record Deposit Hold'}
          </button>
        </div>
      </div>
    </div>
  );
}

function Step4Handoff({ session, token, onContinue, reservationId }) {
  const [tokenInfo, setTokenInfo] = useState(null);
  // 2026-06-11 — customer-led inspection (plan: doc/customer-inspection-plan).
  // When the tenant setting is ON, step 4 offers TWO exits: delegate the
  // walkthrough to the customer (email link, checkout finishes now) or the
  // QR fail-safe (today's flow, untouched). Setting OFF → exactly the old UI.
  const [customerLed, setCustomerLed] = useState(false);
  const [mode, setMode] = useState('choose'); // choose | qr
  const [sending, setSending] = useState(false);
  const [sendResult, setSendResult] = useState(null);
  const [sendError, setSendError] = useState('');

  useEffect(() => {
    (async () => {
      try {
        const cfg = await api('/api/settings/customer-inspection', {}, token);
        if (cfg?.enabled) setCustomerLed(true);
      } catch { /* setting unreadable → default to old flow */ }
    })();
  }, [token]);

  const wantQr = !customerLed || mode === 'qr';
  useEffect(() => {
    if (!wantQr || tokenInfo) return;
    (async () => {
      try { setTokenInfo(await mintHandoffToken({ id: session.id, token })); } catch {}
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wantQr]);

  const sendToCustomer = async () => {
    setSending(true);
    setSendError('');
    try {
      const out = await api(`/api/checkout-sessions/${session.id}/send-customer-inspection`, { method: 'POST' }, token);
      setSendResult(out);
      // The backend walks the session to CLOSED; the poll picks it up within
      // ~1.5s and this screen swaps to the Closed step on its own.
    } catch (err) {
      setSendError(err?.message || 'Failed to send the inspection link');
    } finally {
      setSending(false);
    }
  };

  if (customerLed && mode === 'choose') {
    return (
      <div style={cardStyle}>
        <h3 style={h3Style}>Step 4 · Vehicle inspection</h3>
        <p style={{ fontSize: 13, color: '#6B7280', margin: '0 0 16px' }}>
          Who will do the walkthrough?
        </p>
        {sendResult ? (
          <div style={{ background: '#ECFDF5', color: '#065F46', padding: 16, borderRadius: 8, fontSize: 13 }}>
            ✓ Inspection link sent to <strong>{sendResult.emailTo}</strong>. The checkout is
            finishing now and the agreement will be emailed as usual. Damage reports the
            customer submits will appear in your review queue.
          </div>
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: 12 }}>
            <div style={{ border: '2px solid #5b3df5', borderRadius: 10, padding: 16 }}>
              <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 4 }}>Send inspection link to customer</div>
              <p style={{ fontSize: 12, color: '#6B7280', margin: '0 0 12px' }}>
                Emails the link + disclosures. The checkout finishes now and the
                agreement is emailed. Their damage reports land in your review queue.
              </p>
              <button style={{ width: '100%' }} disabled={sending} onClick={sendToCustomer}>
                {sending ? 'Sending…' : 'Send link & finish checkout'}
              </button>
            </div>
            <div style={{ border: '1px solid #E5E7EB', borderRadius: 10, padding: 16 }}>
              <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 4 }}>Do inspection for customer</div>
              <p style={{ fontSize: 12, color: '#6B7280', margin: '0 0 12px' }}>
                Fail-safe: shows the QR code, you scan with the tablet and do the
                walkthrough with the customer — today&apos;s flow.
              </p>
              <button style={{ width: '100%' }} onClick={() => setMode('qr')}>Show QR code</button>
            </div>
          </div>
        )}
        {sendError ? <div style={{ marginTop: 12, color: '#B91C1C', fontSize: 13 }}>{sendError}</div> : null}
      </div>
    );
  }

  return (
    <div style={cardStyle}>
      <h3 style={h3Style}>Step 4 · Walk-around inspection on mobile</h3>
      <p style={{ fontSize: 13, color: '#6B7280', margin: '0 0 16px' }}>
        The agent's phone captures photos, odometer/fuel, and the
        customer's signature — then this screen advances to <strong>Closed</strong>
        on its own and the customer drives off with the keys.
      </p>
      <div style={{ background: '#F9FAFB', padding: 24, borderRadius: 8, textAlign: 'center' }}>
        {tokenInfo ? (
          <>
            <div style={{ fontSize: 12, color: '#6B7280', marginBottom: 12 }}>Scan with agent's phone</div>
            <QrCode
              size={220}
              url={`${typeof window !== 'undefined' ? window.location.origin : ''}/checkout/mobile/${tokenInfo.token}`}
            />
            <div style={{ fontFamily: 'monospace', fontSize: 10, wordBreak: 'break-all', padding: '8px 12px', background: '#FFFFFF', borderRadius: 4, marginTop: 12, color: '#6B7280' }}>
              {`${typeof window !== 'undefined' ? window.location.origin : ''}/checkout/mobile/${tokenInfo.token}`}
            </div>
          </>
        ) : (
          <div style={{ color: '#6B7280' }}>Minting handoff token…</div>
        )}
      </div>
      {/* Doing the whole checkout on the tablet means there is no second
          device left to scan with (Hector, 2026-08-19) — the QR is unusable
          precisely when the agent is working alone. Same destination, opened
          directly, with a return path so the wizard is one tap away after. */}
      <button
        style={{ ...primaryBtn, width: '100%', marginTop: 16 }}
        onClick={() => {
          const back = reservationId ? `/reservations/${reservationId}/checkout-wizard-v2` : '';
          const qs = back ? `?return=${encodeURIComponent(back)}` : '';
          window.location.href = `/checkout/mobile/${tokenInfo.token}${qs}`;
        }}
        disabled={!tokenInfo}
      >
        Do the inspection on this device →
      </button>
      <div style={{ fontSize: 12, color: '#6B7280', textAlign: 'center', marginTop: 8 }}>
        Use this when the tablet in your hand is the only device.
      </div>

      <div style={{ marginTop: 16, display: 'flex', gap: 12 }}>
        {customerLed ? (
          <button style={ghostBtn} onClick={() => setMode('choose')}>← Back to options</button>
        ) : null}
        <button style={ghostBtn} onClick={onContinue}>Continue here on desktop (fallback) →</button>
      </div>
    </div>
  );
}

function Step5Metrics({ session, reservation, token, onNext }) {
  const [odometer, setOdometer] = useState(reservation.vehicle?.mileage || '');
  const [fuel, setFuel] = useState(8);
  const [cleanliness, setCleanliness] = useState(5);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setBusy(true);
    try {
      // Stamp the inspection-complete side-effect so the entry guard
      // on CUSTOMER_SIGN_PENDING passes, then advance.
      await api(`/api/checkout-sessions/${session.id}/stamp`, {
        method: 'POST',
        body: JSON.stringify({ field: 'inspectionCompletedAt', value: new Date().toISOString() }),
      }, token);
      onNext();
    } catch (err) {
      // surface via the parent toast
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={cardStyle}>
      <h3 style={h3Style}>Step 5 · Vehicle metrics</h3>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 16 }}>
        <Field label="Odometer (autopopulated from last check-in)">
          <input type="number" value={odometer} onChange={(e) => setOdometer(e.target.value)} style={inputStyle} />
        </Field>
        <Field label="Fuel (1-8 eighths)">
          <input type="range" min="1" max="8" value={fuel} onChange={(e) => setFuel(Number(e.target.value))} />
          <span>{fuel}/8</span>
        </Field>
        <Field label="Cleanliness">
          <input type="range" min="1" max="5" value={cleanliness} onChange={(e) => setCleanliness(Number(e.target.value))} />
          <span>{cleanliness}/5</span>
        </Field>
      </div>
      <button style={primaryBtn} onClick={submit} disabled={busy}>
        {busy ? 'Saving…' : 'Customer signs →'}
      </button>
    </div>
  );
}

function Step6CustomerSign({ session, token, onSigned }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [signerName, setSignerName] = useState('');
  const [drawing, setDrawing] = useState(false);
  const [hasInk, setHasInk] = useState(false);
  const canvasRef = useRef(null);

  const pos = (e) => {
    const c = canvasRef.current;
    if (!c) return null;
    const r = c.getBoundingClientRect();
    const p = e.touches?.[0] || e;
    return { x: p.clientX - r.left, y: p.clientY - r.top };
  };
  const start = (e) => {
    e.preventDefault?.();
    const c = canvasRef.current;
    if (!c) return;
    const ctx = c.getContext('2d');
    const p = pos(e);
    if (!p) return;
    ctx.beginPath();
    ctx.moveTo(p.x, p.y);
    setDrawing(true);
  };
  const move = (e) => {
    if (!drawing) return;
    e.preventDefault?.();
    const c = canvasRef.current;
    if (!c) return;
    const ctx = c.getContext('2d');
    const p = pos(e);
    if (!p) return;
    ctx.lineWidth = 2;
    ctx.lineCap = 'round';
    ctx.strokeStyle = '#111827';
    ctx.lineTo(p.x, p.y);
    ctx.stroke();
    setHasInk(true);
  };
  const end = () => setDrawing(false);
  const clearSig = () => {
    const c = canvasRef.current;
    if (!c) return;
    c.getContext('2d').clearRect(0, 0, c.width, c.height);
    setHasInk(false);
  };

  const submit = async () => {
    setErr('');
    const c = canvasRef.current;
    if (!c) return setErr('Signature pad unavailable');
    const signatureDataUrl = c.toDataURL('image/png');
    if (!hasInk || !signatureDataUrl || signatureDataUrl.length < 2000) {
      return setErr('Please have the customer sign before finalizing.');
    }
    setBusy(true);
    try {
      // Persist the in-person signature to the agreement AND stamp
      // customerSignedAt so the wizard advances CUSTOMER_SIGN_PENDING →
      // FINALIZING → CLOSED. (Replaces the old simulate stub.)
      await api(`/api/checkout-sessions/${session.id}/customer-signature`, {
        method: 'POST',
        body: JSON.stringify({ signatureDataUrl, signerName: signerName.trim() || undefined }),
      }, token);
      onSigned();
    } catch (e) {
      setErr(e?.message || 'Could not save signature. Please try again.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={cardStyle}>
      <h3 style={h3Style}>Step 6 · Customer signs inspection</h3>
      <p style={{ color: '#6B7280', marginTop: 0 }}>
        Have the customer sign below to acknowledge the vehicle condition and finalize the agreement.
        (If the inspection was pushed to the customer's phone, they sign there instead and this step completes automatically.)
      </p>
      <label style={{ display: 'block', fontSize: 13, color: '#374151', marginBottom: 6 }}>Signer name (optional)</label>
      <input
        value={signerName}
        onChange={(e) => setSignerName(e.target.value)}
        placeholder="Customer name"
        style={{ width: '100%', maxWidth: 360, padding: '8px 10px', border: '1px solid #D1D5DB', borderRadius: 8, marginBottom: 12, fontSize: 14 }}
      />
      <div style={{ border: '1px solid #D1D5DB', borderRadius: 8, background: '#fff', display: 'inline-block', touchAction: 'none' }}>
        <canvas
          ref={canvasRef}
          width={520}
          height={180}
          style={{ display: 'block', borderRadius: 8, cursor: 'crosshair', maxWidth: '100%' }}
          onMouseDown={start}
          onMouseMove={move}
          onMouseUp={end}
          onMouseLeave={end}
          onTouchStart={start}
          onTouchMove={move}
          onTouchEnd={end}
        />
      </div>
      {err ? <p style={{ color: '#B91C1C', fontSize: 13 }}>{err}</p> : null}
      <div style={{ display: 'flex', gap: 10, marginTop: 12 }}>
        <button style={{ ...primaryBtn, background: '#fff', color: '#374151', border: '1px solid #D1D5DB' }} onClick={clearSig} disabled={busy} type="button">
          Clear
        </button>
        <button style={primaryBtn} onClick={submit} disabled={busy} type="button">
          {busy ? 'Saving…' : 'Sign → finalize'}
        </button>
      </div>
    </div>
  );
}

function StepBridge({ label, onNext }) {
  // Single-action intermediate states. Auto-advance after a short delay
  // so the agent sees the confirmation before it disappears.
  useEffect(() => {
    const t = setTimeout(onNext, 500);
    return () => clearTimeout(t);
  }, []);
  return <div style={cardStyle}><h3 style={h3Style}>{label} ✓</h3></div>;
}

// Loaner "payment" step. No gateway charge ever runs for a loaner. When the
// billing mode is CUSTOMER_PAY and there's a class-upgrade differential, we
// surface the amount to the advisor (instead of silently auto-advancing) so
// it gets collected and settled in the Billing tab. Courtesy / warranty /
// internal / $0 loaners just confirm and move on.
function LoanerPaymentBridge({ reservation, onNext }) {
  const amount = Number(reservation?.estimatedTotal || 0);
  const mode = String(reservation?.loanerBillingMode || '').toUpperCase();
  const status = String(reservation?.loanerBillingStatus || '').toUpperCase();
  const needsCollection = mode === 'CUSTOMER_PAY' && amount > 0 && status !== 'SETTLED';

  useEffect(() => {
    if (!needsCollection) {
      const t = setTimeout(onNext, 500);
      return () => clearTimeout(t);
    }
  }, [needsCollection]);

  if (!needsCollection) {
    return <div style={cardStyle}><h3 style={h3Style}>No payment required (loaner) ✓</h3></div>;
  }

  return (
    <div style={cardStyle}>
      <h3 style={h3Style}>Loaner — collect upgrade differential</h3>
      <div style={{ background: '#FEF3C7', border: '1px solid #FCD34D', borderRadius: 8, padding: '12px 14px', margin: '8px 0 12px' }}>
        <div style={{ fontSize: 22, fontWeight: 700, color: '#92400E' }}>${amount.toFixed(2)}</div>
        <div style={{ fontSize: 13, color: '#92400E' }}>Class-upgrade differential · Bill mode: Customer pays</div>
      </div>
      <p style={{ color: '#6B7280', marginTop: 0, fontSize: 14 }}>
        No online charge is taken here. Collect this from the customer and mark it settled in the
        reservation's <strong>Billing</strong> tab. Continue to finish checkout.
      </p>
      <button style={primaryBtn} onClick={onNext} type="button">Acknowledged — continue</button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// StepClosed — CLOSED is where the session ENDS, not proof the finalize
// SUCCEEDED. Every guard in the cascade raises after transition() commits the
// step, so a checkout blocked by a missing car, an unmet gate or a
// double-booked vehicle lands here with the reservation still CONFIRMED, the
// contract still DRAFT, the vehicle still AVAILABLE and the customer email
// deliberately withheld by finalizeCascadeOk.
//
// The old copy asserted the opposite of all three, and louder than the 409
// toast that told the truth — the toast is dismissible and dies on refresh,
// the claim did not. So the variant is chosen by `closedCheck`, which the
// wizard computes from a fresh reservation fetch, never from whether an error
// object happens to still be in memory.
// ---------------------------------------------------------------------------
function StepClosed({ reservation, closedCheck, finalizeError, onRetryFinalize, onRecheck, retrying }) {
  const { t } = useTranslation();

  // Verdict still in flight. Claim nothing either way.
  if (closedCheck === 'pending') {
    return (
      <div style={cardStyle}>
        <h3 style={h3Style}>{t('checkoutClosed.pendingTitle')}</h3>
        <p style={{ color: '#6B7280' }}>{t('checkoutClosed.pendingBody')}</p>
      </div>
    );
  }

  // The refetch failed, so we genuinely do not know. This needs its own exit:
  // polling stops at terminal steps, so without a button the agent sits on a
  // spinner nothing will ever resolve. Mirrors PrecheckinGateBlocker's
  // "Verificar de nuevo" — and like it, this one only READS. It re-runs the
  // check, never the finalize: a button labelled "check again" on a card that
  // says "do not hand over the vehicle" must not quietly POST.
  if (closedCheck === 'unknown') {
    return (
      <div style={cardStyle}>
        <h3 style={h3Style}>{t('checkoutClosed.unknownTitle')}</h3>
        <p style={{ color: '#6B7280', maxWidth: '70ch' }}>{t('checkoutClosed.unknownBody')}</p>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          <button style={primaryBtn} onClick={onRecheck} type="button">
            {t('checkoutClosed.verify')}
          </button>
          <a href={`/reservations/${reservation.id}`} style={secondaryLinkBtn}>
            {t('checkoutClosed.goToReservation')}
          </a>
        </div>
      </div>
    );
  }

  if (closedCheck === 'ok') {
    return (
      <div style={cardStyle}>
        <h3 style={h3Style}>{t('checkoutClosed.okTitle')}</h3>
        {/* Both halves of the first sentence are asserted upstream —
            reservation CHECKED_OUT AND contract FINALIZED. The email is NOT:
            it is dispatched fire-and-forget and can still fail for a customer
            with no address on file, so it is phrased as what was queued, not
            as what arrived. The only field that could prove delivery is
            CheckoutSession.autoEmailedAt, and it is stamped after this
            response — reading it here would race. */}
        <p>{t('checkoutClosed.okBody')}</p>
        <a href={`/reservations/${reservation.id}`}>{t('checkoutClosed.back')}</a>
      </div>
    );
  }

  const copy = resolveFinalizeFailureCopy(finalizeError || {});
  const resvStatus = String(reservation.status || '');
  const agreementStatus = reservation.rentalAgreement?.status || null;
  const vehicleStatus = reservation.vehicle?.status || null;

  // The backend only re-runs the finalize for a reservation it still owns: its
  // self-heal allow-list is ['NEW','CONFIRMED'], and CANCELLED / NO_SHOW /
  // PENDING_FRANCHISE_IMPORT are declined with a server-side log and a plain
  // 200. Offering a retry there would be a button that silently changes
  // nothing, under copy promising it would explain the blocker — exactly the
  // kind of confident-but-false affordance this ticket removes.
  const { voided, halfFinalized, showRetry } =
    closedCardState({ reservation, terminalReason: copy.terminal });

  let title;
  let body;
  if (voided) {
    title = t('checkoutClosed.voidedTitle');
    body = t('checkoutClosed.voidedBody', { status: resvStatus });
  } else if (halfFinalized) {
    title = t('checkoutClosed.halfTitle');
    body = t('checkoutClosed.halfBody');
  } else {
    title = t(copy.titleKey);
    body = copy.bodyText || t(copy.bodyKey);
  }

  // Each row is judged on ITS OWN field, not on "the finalize failed, so
  // assume all four did". The cascade is not all-or-nothing: the write that
  // finalizes the contract is best-effort and does not abort the rest, so a
  // half-finished close really can leave the reservation CHECKED_OUT and the
  // vehicle ON_RENT with the contract still DRAFT. A static list of failures
  // would then print "the reservation was not marked as handed over" beside
  // the value CHECKED_OUT — a fresh contradiction on the screen whose whole
  // job is to stop contradicting the database.
  //
  // The email is the one line with no field to read. It is reported as not
  // sent because that is what this state means: the send sits behind
  // finalizeCascadeOk, which is exactly what a failed cascade clears.
  const facts = [
    {
      id: 'reservation',
      done: resvStatus === 'CHECKED_OUT',
      label: resvStatus === 'CHECKED_OUT' ? 'factReservationYes' : 'factReservationNo',
      state: resvStatus || '—',
    },
    {
      id: 'agreement',
      done: agreementStatus === 'FINALIZED',
      label: agreementStatus === 'FINALIZED' ? 'factAgreementYes' : 'factAgreementNo',
      state: agreementStatus || '—',
    },
    {
      id: 'vehicle',
      done: vehicleStatus === 'ON_RENT',
      label: vehicleStatus === 'ON_RENT' ? 'factVehicleYes' : 'factVehicleNo',
      state: vehicleStatus || '—',
    },
    { id: 'email', done: false, label: 'factEmailNo', state: '—' },
  ];
  // Only in the half-finalize view: the car is already gone, so the one row
  // that still needs action belongs directly under the alert rather than
  // third in a mostly-✓ list. Stable sort keeps the original order within
  // each group.
  const orderedFacts = halfFinalized
    ? [...facts.filter((f) => !f.done), ...facts.filter((f) => f.done)]
    : facts;

  return (
    <div style={{ ...cardStyle, borderColor: WARN.bd, borderLeft: `3px solid ${WARN.tx}` }}>
      <h3 style={h3Style}>{t('checkoutClosed.failedTitle')}</h3>

      {/* Same anatomy as .swap-alert, pinned to its light palette — see WARN /
          ALERT for why this card cannot reference the live tokens. */}
      <div
        role="alert"
        style={{
          padding: '10px 14px', borderRadius: 12, fontSize: 13, lineHeight: 1.45,
          background: ALERT.bg, border: `1px solid ${ALERT.bd}`, color: ALERT.tx,
          marginBottom: 14, maxWidth: '70ch',
        }}
      >
        <span style={{ display: 'block', fontWeight: 800, marginBottom: 3 }}>{title}</span>
        <span style={{ display: 'block', fontWeight: 500 }}>{body}</span>
        {/* Its own line, not appended to `body`: on an unrecognised reason the
            body IS the backend's raw message, which ends without punctuation,
            so an inline hint ran straight on out of the end of its sentence.
            Only shown when the button below can actually act on it. */}
        {showRetry && !halfFinalized && (
          <span style={{ display: 'block', fontWeight: 500, marginTop: 4 }}>
            {t('checkoutClosed.retryHint')}
          </span>
        )}
        {/* The raw backend message is the ONLY place the blocking reservation
            number appears, and "which reservation has my car" is the one thing
            the agent can act on — so it is full-strength body text, not a
            faint footnote. We do not parse the number out of it: the backend
            hands clients a `reason` precisely so nobody has to read its prose. */}
        {!voided && !halfFinalized && copy.detail && (
          <span style={{ display: 'block', fontWeight: 500, fontSize: 13, marginTop: 6 }}>
            {copy.detail}
          </span>
        )}
      </div>

      <div style={{
        border: '0.5px solid #E5E7EB', borderRadius: 8, overflow: 'hidden',
        marginBottom: 16, maxWidth: '70ch',
      }}>
        {orderedFacts.map((f, i) => (
          <div key={f.id} style={{
            display: 'flex', alignItems: 'flex-start', gap: 9, padding: '8px 12px', fontSize: 13,
            color: '#4B5563',
            borderBottom: i === orderedFacts.length - 1 ? 'none' : '0.5px solid #E5E7EB',
          }}>
            {/* The ✓ rows stay NEUTRAL grey, not success green: inside a
                failure card the app's success colour competes with the alert
                and makes a partly-done close read as mostly fine. The glyph
                alone carries "this part landed". */}
            <span aria-hidden="true" style={{
              width: 15, textAlign: 'center', fontWeight: 700,
              color: f.done ? '#6B7280' : WARN.tx,
            }}>{f.done ? '✓' : '✗'}</span>
            <span>{t(`checkoutClosed.${f.label}`)}</span>
            <span style={{
              marginLeft: 'auto', fontSize: 11.5, color: '#6B7280',
              fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
            }}>
              {f.state}
            </span>
          </div>
        ))}
      </div>

      <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
        {showRetry && !halfFinalized && (
          <button
            style={{ ...primaryBtn, opacity: retrying ? 0.6 : 1 }}
            onClick={onRetryFinalize}
            type="button"
            disabled={retrying}
            aria-busy={retrying}
          >
            {retrying ? t('checkoutClosed.retrying') : t('checkoutClosed.retry')}
          </button>
        )}
        <a
          href={`/reservations/${reservation.id}`}
          style={(showRetry && !halfFinalized)
            ? secondaryLinkBtn
            : { ...primaryBtn, textDecoration: 'none', display: 'inline-block' }}
        >
          {t('checkoutClosed.goToReservation')}
        </a>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Small components
// ---------------------------------------------------------------------------

function KV({ label, value }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', padding: '4px 0', fontSize: 13 }}>
      <span style={{ color: '#6B7280' }}>{label}</span>
      <span style={{ fontWeight: 500 }}>{value}</span>
    </div>
  );
}

function Field({ label, children }) {
  return (
    <div>
      <div style={{ fontSize: 12, color: '#6B7280', marginBottom: 4 }}>{label}</div>
      {children}
    </div>
  );
}

// The toast carries the backend's raw message — long, English, and on the
// finalize path the only place a reservation number or an age bound appears.
// It used to be an unwrapped <span> in a space-between flex, so a full
// sentence squeezed the × off the edge and screen readers were never told it
// arrived. It stays dismissible; what it must NOT be is the only record of a
// failure — the CLOSED card holds that, from server truth.
function Toast({ kind, message, onClose }) {
  const isError = kind === 'error';
  return (
    <div
      role={isError ? 'alert' : 'status'}
      style={{
        position: 'sticky', bottom: 16, marginTop: 16,
        background: isError ? '#FEE2E2' : '#D1FAE5',
        color: isError ? '#991B1B' : '#065F46',
        padding: '10px 14px', borderRadius: 6,
        display: 'flex', justifyContent: 'space-between',
        gap: 12, alignItems: 'flex-start',
      }}
    >
      <span style={{ lineHeight: 1.45, maxWidth: '64ch' }}>{message}</span>
      <button
        onClick={onClose}
        type="button"
        aria-label="Cerrar aviso"
        style={{
          flex: 'none', width: 44, height: 44, margin: '-10px -10px -10px 0',
          background: 'none', border: 'none', color: 'inherit', cursor: 'pointer',
          fontSize: 18, lineHeight: 1,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}
      >
        ×
      </button>
    </div>
  );
}

function DevSimulateButton({ label, sessionId, token, field, onDone }) {
  const [busy, setBusy] = useState(false);
  const click = async () => {
    setBusy(true);
    try {
      await api(`/api/checkout-sessions/${sessionId}/stamp`, {
        method: 'POST',
        body: JSON.stringify({ field, value: new Date().toISOString() }),
      }, token);
      onDone();
    } catch (err) {
      // surface error — caller will toast it
    } finally {
      setBusy(false);
    }
  };
  return (
    <button style={{ ...ghostBtn, opacity: 0.7, marginTop: 8 }} onClick={click} disabled={busy}>
      [DEV] {busy ? 'Working…' : label}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const cardStyle = {
  background: '#FFFFFF', border: '0.5px solid #E5E7EB', borderRadius: 8,
  padding: 20, marginBottom: 16,
};

// ── Failure palette for the CLOSED card and its tracker chip ────────────────
//
// These are globals.css's --warn-*/--danger-* and .swap-alert values, PINNED
// to their light-mode readings on purpose. That looks backwards — the ticket
// asked for the tokens, and the tokens are how the rest of the app themes —
// but this wizard is a hardcoded-light island: cardStyle above is a literal
// #FFFFFF, so are the tracker chips, and this file carries no themed surface
// anywhere. Reference the live tokens here and dark mode flips the TEXT while
// the surface underneath stays white: --warn-tx becomes #e8a13c on white
// (~1.97:1) and .swap-alert's text becomes #fca5a5 on white (~1.54:1). Both
// unreadable, and the .swap-alert audit its comment protects assumes a themed
// host it does not have here.
//
// So the values are inlined at their audited light readings, which keeps this
// card internally consistent with the island around it. Point the whole wizard
// at surface tokens and these should go back to var(--warn-*) / .swap-alert in
// the same commit — see the dark-mode debt ticket.
const WARN = {
  bg: '#fdf3e2',   // --warn-bg
  bd: '#f3dcb5',   // --warn-bd
  tx: '#8a5606',   // --warn-tx — measured 5.59:1 on its own bg
  dot: '#8a5606',  // white on this measured 6.15:1; --warn (#b8760a) is 3.74:1
};
// .swap-alert's light values (globals.css:284). #b91c1c on the composite is
// the 5.98:1 the audit at globals.css:299-303 measured.
const ALERT = {
  bg: 'rgba(229,72,77,.08)',
  bd: 'rgba(229,72,77,.28)',
  tx: '#b91c1c',
};
const h3Style = { margin: '0 0 12px', fontSize: 16, fontWeight: 600 };
const primaryBtn = {
  padding: '10px 16px', background: '#1F2937', color: '#FFFFFF',
  border: 'none', borderRadius: 6, fontSize: 14, fontWeight: 500, cursor: 'pointer',
};
const ghostBtn = {
  padding: '8px 12px', background: '#FFFFFF', color: '#374151',
  border: '0.5px solid #D1D5DB', borderRadius: 6, fontSize: 13, cursor: 'pointer',
};
const pauseBtnStyle = { ...ghostBtn, fontSize: 12 };
// ghostBtn sized to sit beside primaryBtn (both 40px tall) and usable as an
// <a>. Mismatched heights on a paired action read as unfinished.
const secondaryLinkBtn = {
  ...ghostBtn, padding: '10px 16px', fontSize: 14,
  textDecoration: 'none', display: 'inline-block',
};
const inputStyle = { width: '100%', padding: '6px 8px', border: '0.5px solid #D1D5DB', borderRadius: 4, fontSize: 14 };

// Manual failsafe modal styling — kept tight to match the wizard's
// minimalist look. z-index 60 sits above all wizard content.
const modalBackdrop = {
  position: 'fixed', inset: 0, background: 'rgba(17,24,39,.55)',
  display: 'flex', alignItems: 'center', justifyContent: 'center',
  zIndex: 60, padding: 16,
};
const modalCard = {
  background: '#FFFFFF', borderRadius: 10, padding: 22,
  width: '100%', maxWidth: 460,
  boxShadow: '0 20px 60px rgba(0,0,0,.25)',
};
const modalHeader = {
  display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8,
};
const modalHelp = { fontSize: 12, color: '#6B7280', lineHeight: 1.45, margin: '0 0 16px' };
const modalField = { display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 12 };
const modalLabel = { fontSize: 12, fontWeight: 500, color: '#374151' };
const modalError = {
  fontSize: 12, color: '#B91C1C',
  background: 'rgba(220,38,38,.06)', border: '0.5px solid rgba(220,38,38,.2)',
  padding: '6px 8px', borderRadius: 4, marginBottom: 12,
};
const modalActions = { display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 4 };
