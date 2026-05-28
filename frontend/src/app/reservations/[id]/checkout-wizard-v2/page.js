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
    } else if (session.currentStep === 'INSPECTION_IN_PROGRESS' && session.inspectionCompletedAt) {
      advance('CUSTOMER_SIGN_PENDING');
    } else if (session.currentStep === 'CUSTOMER_SIGN_PENDING' && session.customerSignedAt) {
      advance('FINALIZING');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.currentStep, session?.tcCompletedAt, session?.paymentCompletedAt, session?.inspectionCompletedAt, session?.customerSignedAt]);

  const advance = async (toStep, metadata) => {
    try {
      const next = await transition({ id: session.id, toStep, metadata, token });
      setSession(next);
    } catch (err) {
      setToast({ kind: 'error', message: err?.message || 'Cannot advance' });
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
      <button style={primaryBtn} onClick={onNext}>Start checkout →</button>
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
            <div style={{ fontSize: 12, color: '#6B7280', marginBottom: 8 }}>QR · expires in 15 min</div>
            <div style={{ fontFamily: 'monospace', fontSize: 11, wordBreak: 'break-all', padding: '8px 12px', background: '#FFFFFF', borderRadius: 4 }}>
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
  // Wizard-side states: 'ready' → 'charging' → 'done' / 'error'
  const [phase, setPhase] = useState('ready');
  const [error, setError] = useState(null);
  const [result, setResult] = useState(null);

  const subtotal = Number(reservation.estimatedTotal || reservation.rentalAgreement?.total || 0);
  const depositAmount = 500;

  const charge = async () => {
    setPhase('charging');
    setError(null);
    try {
      const r = await api(`/api/checkout-sessions/${session.id}/charge`, {
        method: 'POST',
        body: JSON.stringify({ amount: subtotal, depositAmount }),
      }, token);
      setResult(r);
      setPhase('done');
      // Backend stamped paymentCompletedAt already; advance the wizard.
      onPaid();
    } catch (err) {
      setError(err?.message || 'Charge failed');
      setPhase('error');
    }
  };

  return (
    <div style={cardStyle}>
      <h3 style={h3Style}>Step 3 · Payment</h3>
      <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 16 }}>
        <div>
          <div style={{ fontSize: 14, fontWeight: 500, marginBottom: 8 }}>Invoice</div>
          <KV label="Subtotal" value={`$${subtotal.toFixed(2)}`} />
          <KV label="Pre-auth deposit" value={`$${depositAmount.toFixed(2)}`} />
        </div>
        <div style={{ background: '#F9FAFB', padding: 12, borderRadius: 6 }}>
          <div style={{ fontSize: 12, fontWeight: 500, marginBottom: 4 }}>Dejavoo terminal</div>
          {phase === 'ready' && (
            <>
              <div style={{ fontSize: 11, color: '#6B7280' }}>Customer: tap, insert, or swipe</div>
              <div style={{ fontSize: 12, color: '#10B981', marginTop: 8 }}>● Terminal ready</div>
            </>
          )}
          {phase === 'charging' && (
            <>
              <div style={{ fontSize: 11, color: '#6B7280' }}>Waiting for card…</div>
              <div style={{ fontSize: 12, color: '#F59E0B', marginTop: 8 }}>● Processing</div>
            </>
          )}
          {phase === 'done' && result && (
            <>
              <div style={{ fontSize: 12, color: '#10B981', marginTop: 8 }}>✓ Approved · {result.sale?.authCode}</div>
              {result.cardOnFile && (
                <div style={{ fontSize: 11, color: '#6B7280', marginTop: 4 }}>
                  {result.cardOnFile.brand} ····{result.cardOnFile.last4} saved
                </div>
              )}
              {result.preauth && (
                <div style={{ fontSize: 11, color: '#6B7280', marginTop: 2 }}>
                  Deposit hold ✓
                </div>
              )}
            </>
          )}
          {phase === 'error' && (
            <div style={{ fontSize: 11, color: '#B91C1C' }}>{error}</div>
          )}
        </div>
      </div>
      <div style={{ marginTop: 16, display: 'flex', gap: 8 }}>
        {phase === 'ready' && (
          <button style={primaryBtn} onClick={charge}>Start charge</button>
        )}
        {phase === 'charging' && (
          <button style={{ ...primaryBtn, opacity: 0.6 }} disabled>Processing…</button>
        )}
        {phase === 'error' && (
          <>
            <button style={primaryBtn} onClick={charge}>Retry charge</button>
            <button style={ghostBtn} onClick={() => setPhase('ready')}>Reset</button>
          </>
        )}
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
      <h3 style={h3Style}>Step 4 · Continue inspection on mobile</h3>
      <div style={{ background: '#F9FAFB', padding: 24, borderRadius: 8, textAlign: 'center' }}>
        {tokenInfo ? (
          <>
            <div style={{ fontSize: 12, color: '#6B7280', marginBottom: 8 }}>Scan with agent's phone</div>
            <div style={{ fontFamily: 'monospace', fontSize: 11, wordBreak: 'break-all', padding: '8px 12px', background: '#FFFFFF', borderRadius: 4 }}>
              {`${typeof window !== 'undefined' ? window.location.origin : ''}/checkout/mobile/${tokenInfo.token}`}
            </div>
          </>
        ) : (
          <div style={{ color: '#6B7280' }}>Minting handoff token…</div>
        )}
      </div>
      <div style={{ marginTop: 16 }}>
        <button style={primaryBtn} onClick={onContinue}>Continue here (skip mobile) →</button>
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
