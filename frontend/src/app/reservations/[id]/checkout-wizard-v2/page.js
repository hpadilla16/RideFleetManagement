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
import { AuthGate } from '../../../../components/AuthGate';
import { AppShell } from '../../../../components/AppShell';
import { api } from '../../../../lib/client';
import {
  createSession, getSessionByReservation, transition,
  mintTermsToken, mintHandoffToken, abandon,
  stepNumber, isTerminal, STEP_INFO,
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
  const pollTimer = useRef(null);
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
        const r = await api(`/api/reservations/${reservationId}`, {}, token);
        if (cancelled) return;
        setReservation(r);

        // 2. Find existing session OR create a new one
        let s;
        try {
          s = await getSessionByReservation({ reservationId, token });
        } catch (err) {
          if (err?.status === 404) {
            s = await createSession({ reservationId, token });
          } else {
            throw err;
          }
        }
        if (cancelled) return;
        setSession(s);
      } catch (err) {
        if (!cancelled) setError(err?.message || 'Failed to load checkout session');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [reservationId, token]);

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

  // Forward order of CheckoutStep — used only to decide whether a 409 means
  // "already there / already past it" (benign, swallow) vs a real error.
  const STEP_ORDER = [
    'CONFIRMING', 'TC_PENDING', 'TC_SIGNED', 'PAYMENT_PENDING', 'PAID',
    'INSPECTION_HANDOFF', 'INSPECTION_IN_PROGRESS', 'CUSTOMER_SIGN_PENDING',
    'FINALIZING', 'CLOSED',
  ];

  const advance = async (toStep, metadata) => {
    if (transitionInFlightRef.current) return; // drop concurrent/double fires
    transitionInFlightRef.current = true;
    try {
      const next = await transition({ id: session.id, toStep, metadata, token });
      setSession(next);
    } catch (err) {
      // 409 = state conflict. If the session is already in (or past) the
      // requested step — the classic double-fire — refetch and treat as a
      // success-noop instead of toasting an error at the agent.
      if (err?.status === 409) {
        try {
          const fresh = await api(`/api/checkout-sessions/${session.id}`, { bypassCache: true }, token);
          const at = STEP_ORDER.indexOf(fresh?.currentStep);
          const want = STEP_ORDER.indexOf(toStep);
          if (at !== -1 && want !== -1 && at >= want) {
            setSession(fresh);
            return;
          }
        } catch { /* fall through to the toast */ }
      }
      setToast({ kind: 'error', message: err?.message || 'Cannot advance' });
    } finally {
      transitionInFlightRef.current = false;
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
        />
        <StepRenderer
          session={session}
          reservation={reservation}
          token={token}
          onAdvance={advance}
        />
        {toast && (
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
  const [vehicles, setVehicles] = useState([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState(null);

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

  const eligible = useMemo(() => {
    return vehicles.filter((v) => {
      const status = String(v?.status || '').toUpperCase();
      if (['SOLD', 'OUT_OF_SERVICE'].includes(status)) return false;
      if (v.id === reservation.vehicleId) return false;
      return true;
    });
  }, [vehicles, reservation.vehicleId]);

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
        {loading ? (
          <div style={{ padding: 24, textAlign: 'center', color: '#6B7280' }}>Loading…</div>
        ) : eligible.length === 0 ? (
          <div style={{ padding: 24, textAlign: 'center', color: '#6B7280' }}>
            No alternative vehicles available.
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

function WizardHeader({ reservation, session, onPause, onSwapClick, swapLocked }) {
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
      <StepTracker currentStep={session.currentStep} currentNumber={currentNumber} />
    </div>
  );
}

function StepTracker({ currentStep, currentNumber }) {
  const steps = [
    { number: 1, label: 'Confirm' },
    { number: 2, label: 'Terms' },
    { number: 3, label: 'Payment' },
    { number: 4, label: 'Inspection' },
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
        const isDone = s.number < currentNumber || currentStep === 'CLOSED';
        return (
          <div key={s.number} style={{
            flex: 1, padding: '8px 12px', borderRadius: 6,
            border: '0.5px solid #E5E7EB',
            background: isCurrent ? '#1F2937' : (isDone ? '#D1FAE5' : '#FFFFFF'),
            color: isCurrent ? '#FFFFFF' : (isDone ? '#065F46' : '#6B7280'),
            fontSize: 12, fontWeight: isCurrent ? 600 : 500,
            display: 'flex', alignItems: 'center', gap: 6,
          }}>
            <span style={{
              width: 18, height: 18, borderRadius: '50%',
              background: isCurrent ? 'rgba(255,255,255,0.2)' : (isDone ? '#10B981' : '#F3F4F6'),
              color: isCurrent ? '#FFFFFF' : (isDone ? '#FFFFFF' : '#9CA3AF'),
              display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
              fontSize: 10, fontWeight: 600,
            }}>
              {isDone ? '✓' : s.number}
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

function StepRenderer({ session, reservation, token, onAdvance }) {
  switch (session.currentStep) {
    case 'CONFIRMING':
      return <Step1Confirm reservation={reservation} session={session} token={token} onNext={() => onAdvance('TC_PENDING')} />;
    case 'TC_PENDING':
      return <Step2TermsPending session={session} reservation={reservation} token={token} onSigned={() => onAdvance('TC_SIGNED')} />;
    case 'TC_SIGNED':
      return <StepBridge label="Terms signed" onNext={() => onAdvance('PAYMENT_PENDING')} />;
    case 'PAYMENT_PENDING':
      return <Step3PaymentPending session={session} reservation={reservation} token={token} onPaid={() => onAdvance('PAID')} />;
    case 'PAID':
      return <StepBridge label="Payment captured" onNext={() => onAdvance('INSPECTION_HANDOFF')} />;
    case 'INSPECTION_HANDOFF':
      return <Step4Handoff session={session} token={token} onContinue={() => onAdvance('INSPECTION_IN_PROGRESS')} />;
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
      return <StepBridge label="Building agreement…" onNext={() => onAdvance('CLOSED')} />;
    case 'CLOSED':
      return <StepClosed reservation={reservation} />;
    case 'CANCELLED':
      return <div style={cardStyle}>This checkout was cancelled. <a href={`/reservations/${reservation.id}`}>Back to reservation</a>.</div>;
    default:
      return <div style={cardStyle}>Unknown step: {session.currentStep}</div>;
  }
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

  const persistDecline = async (next) => {
    setDeclinedInsurance(next);
    if (!session?.id) return;
    setSavingDecline(true);
    try {
      await api(`/api/checkout-sessions/${session.id}/declined-insurance`, {
        method: 'POST',
        body: JSON.stringify({ declined: next }),
      }, token);
    } catch { /* non-fatal; re-toggle to retry */ } finally {
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
        <KV label="Vehicle" value={reservation.vehicle ? `${reservation.vehicle.year} ${reservation.vehicle.make} ${reservation.vehicle.model} · ${reservation.vehicle.plate}` : 'Not assigned'} />
        <KV label="Pickup" value={reservation.pickupAt ? new Date(reservation.pickupAt).toLocaleString() : '—'} />
        <KV label="Return" value={reservation.returnAt ? new Date(reservation.returnAt).toLocaleString() : '—'} />
      </div>
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
          </div>
        </label>
      </div>
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

function Step2TermsPending({ session, reservation, token, onSigned }) {
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

function Step4Handoff({ session, token, onContinue }) {
  const [tokenInfo, setTokenInfo] = useState(null);
  useEffect(() => {
    (async () => {
      try { setTokenInfo(await mintHandoffToken({ id: session.id, token })); } catch {}
    })();
  }, []);

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
      <div style={{ marginTop: 16 }}>
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
  const submit = async () => {
    setBusy(true);
    try {
      // Stamp the customer-sign side-effect so the entry guard on
      // CLOSED passes when FINALIZING auto-advances.
      await api(`/api/checkout-sessions/${session.id}/stamp`, {
        method: 'POST',
        body: JSON.stringify({ field: 'customerSignedAt', value: new Date().toISOString() }),
      }, token);
      onSigned();
    } catch (err) {
      // parent toast
    } finally {
      setBusy(false);
    }
  };
  return (
    <div style={cardStyle}>
      <h3 style={h3Style}>Step 6 · Customer signs inspection</h3>
      <p style={{ color: '#6B7280' }}>
        Phase 1 stub. Real flow: customer signs on the agent's mobile, which posts back to the public route and stamps customerSignedAt.
      </p>
      <button style={primaryBtn} onClick={submit} disabled={busy}>
        {busy ? 'Saving…' : 'Simulate signature → finalize'}
      </button>
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

function StepClosed({ reservation }) {
  return (
    <div style={cardStyle}>
      <h3 style={h3Style}>Checkout complete ✓</h3>
      <p>Agreement built. Email queued.</p>
      <a href={`/reservations/${reservation.id}`}>Back to reservation</a>
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

function Toast({ kind, message, onClose }) {
  return (
    <div style={{
      position: 'sticky', bottom: 16, marginTop: 16,
      background: kind === 'error' ? '#FEE2E2' : '#D1FAE5',
      color: kind === 'error' ? '#991B1B' : '#065F46',
      padding: '10px 14px', borderRadius: 6, display: 'flex', justifyContent: 'space-between',
    }}>
      <span>{message}</span>
      <button onClick={onClose} style={{ background: 'none', border: 'none', color: 'inherit', cursor: 'pointer' }}>×</button>
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
