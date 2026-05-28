'use client';

import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { api, readStoredToken } from '../../../../lib/client';

// Two polling rates: slow when the wizard isn't active (just showing
// reservation summary), fast when a CheckoutSession is in flight and
// we need to react to step transitions in near-realtime. 2026-05-28.
const POLL_INTERVAL_IDLE   = 8000;
const POLL_INTERVAL_ACTIVE = 1500;

function money(n) {
  return `$${Number(n || 0).toFixed(2)}`;
}

function fmtDate(v) {
  if (!v) return '—';
  try { return new Date(v).toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' }); }
  catch { return '—'; }
}

function StatusBadge({ status }) {
  const map = {
    NEW: { bg: 'rgba(59,130,246,.1)', color: '#2563eb', border: 'rgba(59,130,246,.25)' },
    CONFIRMED: { bg: 'rgba(22,163,74,.08)', color: '#166534', border: 'rgba(22,163,74,.2)' },
    CHECKED_OUT: { bg: 'rgba(245,158,11,.1)', color: '#92400e', border: 'rgba(245,158,11,.25)' },
    CHECKED_IN: { bg: 'rgba(22,163,74,.1)', color: '#166534', border: 'rgba(22,163,74,.25)' },
    CANCELLED: { bg: 'rgba(220,38,38,.08)', color: '#991b1b', border: 'rgba(220,38,38,.2)' },
    NO_SHOW: { bg: 'rgba(107,114,128,.1)', color: '#4b5563', border: 'rgba(107,114,128,.2)' },
  };
  const s = String(status || 'NEW').toUpperCase();
  const m = map[s] || map.NEW;
  return (
    <span style={{ display: 'inline-block', padding: '6px 14px', borderRadius: 999, background: m.bg, border: `1px solid ${m.border}`, color: m.color, fontWeight: 800, fontSize: '0.84rem', letterSpacing: '.03em' }}>
      {s.replace(/_/g, ' ')}
    </span>
  );
}

function ProgressStep({ label, done, active }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
      <div style={{
        width: 28, height: 28, borderRadius: '50%', flexShrink: 0,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: done ? '#16a34a' : active ? '#7c3aed' : 'rgba(110,73,255,.1)',
        color: done || active ? '#fff' : '#a090c8',
        fontWeight: 800, fontSize: done ? 13 : 12,
        border: active ? '2px solid #7c3aed' : 'none',
        boxShadow: active ? '0 2px 8px rgba(110,73,255,.25)' : 'none',
      }}>
        {done ? '✓' : ''}
      </div>
      <span style={{ fontWeight: 700, fontSize: '0.9rem', color: done ? '#166534' : active ? '#4c1d95' : '#94a3b8' }}>{label}</span>
    </div>
  );
}

export default function CustomerViewPage() {
  const { id } = useParams();
  const [row, setRow] = useState(null);
  // CheckoutSession — populated only when a checkout-wizard-v2 session
  // is in flight. When non-null, drives the wizard-step hero above the
  // reservation summary. Polled every 1.5s while non-terminal so the
  // customer's screen reacts to step transitions immediately.
  const [session, setSession] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const loadData = async () => {
    try {
      const token = readStoredToken();
      if (!token) { setError('Session expired'); setLoading(false); return; }
      // Fetch reservation + checkout session in parallel. The session
      // endpoint 404s when no wizard is open — that's normal and
      // doesn't surface as an error.
      const [data, sessionResult] = await Promise.allSettled([
        api(`/api/reservations/${id}`, { bypassCache: true }, token),
        api(`/api/checkout-sessions/by-reservation/${id}`, { bypassCache: true }, token),
      ]);
      if (data.status === 'fulfilled') setRow(data.value);
      else throw data.reason;
      setSession(sessionResult.status === 'fulfilled' ? sessionResult.value : null);
      setError('');
    } catch (e) {
      setError(e?.message || 'Unable to load reservation');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { loadData(); }, [id]);

  useEffect(() => {
    // Adaptive interval: 1.5s during an active checkout, 8s otherwise.
    const isActiveSession = session && !['CLOSED', 'CANCELLED'].includes(session.currentStep);
    const interval = setInterval(loadData, isActiveSession ? POLL_INTERVAL_ACTIVE : POLL_INTERVAL_IDLE);
    return () => clearInterval(interval);
  }, [id, session?.currentStep]);

  if (loading && !row) {
    return (
      <div style={shell}>
        <div style={{ ...card, textAlign: 'center', padding: 48 }}>
          <p style={{ color: '#6b7a9a', fontWeight: 600 }}>Loading your reservation...</p>
        </div>
      </div>
    );
  }

  if (error && !row) {
    return (
      <div style={shell}>
        <div style={{ ...card, textAlign: 'center', padding: 48 }}>
          <p style={{ color: '#991b1b', fontWeight: 600 }}>{error}</p>
        </div>
      </div>
    );
  }

  const customer = row?.customer || {};
  const vehicle = row?.vehicle;
  const charges = Array.isArray(row?.charges) ? row.charges.filter((c) => c.selected) : [];
  const vehicleLabel = vehicle ? `${vehicle.year || ''} ${vehicle.make || ''} ${vehicle.model || ''}`.trim() : null;
  const vehicleColor = vehicle?.color || null;
  const vehiclePlate = vehicle?.plate || null;
  const pickupLocation = row?.pickupLocation;
  const returnLocation = row?.returnLocation;
  const status = String(row?.status || 'NEW').toUpperCase();
  const hasAgreement = !!row?.rentalAgreement?.id;
  const agreementTotal = Number(row?.rentalAgreement?.total || row?.estimatedTotal || 0);
  const paidTotal = (row?.payments || []).reduce((sum, p) => sum + Number(p?.amount || 0), 0);
  const balance = Number((agreementTotal - paidTotal).toFixed(2));

  const precheckinDone = !!row?.customerInfoCompletedAt;
  const signatureDone = !!row?.signatureCompletedAt || !!row?.rentalAgreement?.signedAt;
  const paymentDone = balance <= 0 && paidTotal > 0;

  const isCheckedOut = status === 'CHECKED_OUT';
  const isCheckedIn = status === 'CHECKED_IN';
  const isComplete = isCheckedIn;

  const insuranceCharge = charges.find((c) => c.source === 'INSURANCE');
  const serviceCharges = charges.filter((c) => c.source === 'ADDITIONAL_SERVICE' || c.source === 'ADDITIONAL_SERVICE_PRECHECKIN');
  const isOtaPrepaid = charges.some((c) => c.source === 'OTA_PREPAID_VOUCHER');

  return (
    <div style={shell}>
      {/* Brand header */}
      <div style={{ textAlign: 'center', padding: '20px 0 8px' }}>
        <div style={{ fontWeight: 900, fontSize: '1.3rem', color: '#1a1230', letterSpacing: '-.02em' }}>Ride Fleet</div>
        <div style={{ fontSize: '0.78rem', color: '#94a3b8', fontWeight: 600, marginTop: 2 }}>Customer View</div>
      </div>

      {/* Wizard-step hero — renders only when a checkout-wizard-v2
          session is in flight. Per-step screens match the customer
          panes from the mockup (steps 1-6). 2026-05-28. */}
      {session && !['CLOSED', 'CANCELLED'].includes(session.currentStep) && (
        <CheckoutStepHero session={session} customer={row?.customer} />
      )}

      {/* Welcome + Status */}
      <div style={card}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12, flexWrap: 'wrap' }}>
          <div>
            <div style={{ fontWeight: 900, fontSize: '1.15rem', color: '#1a1230' }}>
              {customer.firstName ? `Welcome, ${customer.firstName}` : 'Your Reservation'}
            </div>
            <div style={{ fontSize: '0.88rem', color: '#6b7a9a', marginTop: 3 }}>
              Reservation #{row?.reservationNumber}
            </div>
          </div>
          <StatusBadge status={status} />
        </div>
      </div>

      {/* Trip Details */}
      <div style={card}>
        <div style={sectionTitle}>Trip Details</div>
        <div style={grid2}>
          <div style={tile}>
            <div style={tileLabel}>Pickup</div>
            <div style={tileValue}>{fmtDate(row?.pickupAt)}</div>
            {pickupLocation && <div style={tileSub}>{[pickupLocation.name, pickupLocation.city].filter(Boolean).join(', ')}</div>}
          </div>
          <div style={tile}>
            <div style={tileLabel}>Return</div>
            <div style={tileValue}>{fmtDate(row?.returnAt)}</div>
            {returnLocation && <div style={tileSub}>{[returnLocation.name, returnLocation.city].filter(Boolean).join(', ')}</div>}
          </div>
        </div>
      </div>

      {/* Vehicle */}
      {vehicleLabel && (
        <div style={card}>
          <div style={sectionTitle}>Your Vehicle</div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
            <div style={{ width: 56, height: 56, borderRadius: 16, background: 'linear-gradient(135deg, rgba(110,73,255,.1), rgba(31,199,170,.08))', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '1.6rem', flexShrink: 0 }}>
              🚗
            </div>
            <div>
              <div style={{ fontWeight: 800, color: '#1a1230', fontSize: '1.05rem' }}>{vehicleLabel}</div>
              <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginTop: 4 }}>
                {vehicleColor && <span style={chip}>{vehicleColor}</span>}
                {vehiclePlate && <span style={chip}>Plate: {vehiclePlate}</span>}
                {vehicle?.internalNumber && <span style={chip}>#{vehicle.internalNumber}</span>}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Progress */}
      <div style={card}>
        <div style={sectionTitle}>Reservation Progress</div>
        <div style={{ display: 'grid', gap: 12, padding: '4px 0' }}>
          <ProgressStep label="Reservation Created" done />
          <ProgressStep label="Pre-Check-in" done={precheckinDone} active={!precheckinDone && !isCheckedOut} />
          <ProgressStep label="Agreement Signed" done={signatureDone} active={precheckinDone && !signatureDone && !isCheckedOut} />
          <ProgressStep label="Payment" done={paymentDone} active={signatureDone && !paymentDone && !isCheckedOut} />
          <ProgressStep label="Checked Out" done={isCheckedOut || isCheckedIn} active={false} />
          <ProgressStep label="Returned" done={isCheckedIn} active={isCheckedOut} />
        </div>
      </div>

      {/* Charges / Pricing */}
      {charges.length > 0 && !isOtaPrepaid && (
        <div style={card}>
          <div style={sectionTitle}>Trip Summary</div>
          <div style={{ display: 'grid', gap: 8 }}>
            {charges.filter((c) => c.source !== 'OTA_PREPAID_VOUCHER').map((c, i) => (
              <div key={c.id || i} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: '0.9rem', color: '#53607b', padding: '4px 0', borderBottom: '1px solid rgba(110,73,255,.06)' }}>
                <span>{c.name || 'Charge'}</span>
                <strong style={{ color: '#1a1230' }}>{money(c.total)}</strong>
              </div>
            ))}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', paddingTop: 10, borderTop: '2px solid rgba(110,73,255,.12)' }}>
              <span style={{ fontWeight: 800, color: '#1a1230' }}>Total</span>
              <span style={{ fontWeight: 900, fontSize: '1.15rem', color: '#1a1230' }}>{money(agreementTotal)}</span>
            </div>
            {paidTotal > 0 && (
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.88rem', color: '#166534' }}>
                <span>Paid</span><strong>{money(paidTotal)}</strong>
              </div>
            )}
            {balance > 0 && (
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.88rem', color: '#b45309' }}>
                <span>Remaining Balance</span><strong>{money(balance)}</strong>
              </div>
            )}
          </div>
        </div>
      )}

      {isOtaPrepaid && (
        <div style={{ ...card, background: 'rgba(245,158,11,.06)', borderColor: 'rgba(245,158,11,.2)' }}>
          <div style={{ fontWeight: 800, color: '#92400e', marginBottom: 6 }}>Prepaid Booking</div>
          <div style={{ fontSize: '0.88rem', color: '#78716c', lineHeight: 1.6 }}>
            This reservation was prepaid through a third-party provider. Your daily rate, taxes, and standard fees are covered by your voucher.
          </div>
        </div>
      )}

      {/* Protection & Services */}
      {(insuranceCharge || serviceCharges.length > 0) && (
        <div style={card}>
          <div style={sectionTitle}>Your Selections</div>
          <div style={{ display: 'grid', gap: 8 }}>
            {insuranceCharge && (
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '10px 14px', borderRadius: 12, background: 'rgba(22,163,74,.05)', border: '1px solid rgba(22,163,74,.15)' }}>
                <div>
                  <div style={{ fontWeight: 700, color: '#166534', fontSize: '0.9rem' }}>🛡 {insuranceCharge.name}</div>
                </div>
                <strong style={{ color: '#166534' }}>{money(insuranceCharge.total)}</strong>
              </div>
            )}
            {serviceCharges.map((svc, i) => (
              <div key={svc.id || i} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 14px', borderRadius: 12, background: 'rgba(110,73,255,.04)', border: '1px solid rgba(110,73,255,.1)' }}>
                <span style={{ fontWeight: 600, color: '#32405d', fontSize: '0.88rem' }}>{svc.name}</span>
                <strong style={{ color: '#1a1230', fontSize: '0.88rem' }}>{money(svc.total)}</strong>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Completion */}
      {isComplete && (
        <div style={{ ...card, background: 'linear-gradient(135deg, rgba(22,163,74,.06), rgba(110,73,255,.04))', borderColor: 'rgba(22,163,74,.18)', textAlign: 'center' }}>
          <div style={{ fontSize: '2rem', marginBottom: 8 }}>✅</div>
          <div style={{ fontWeight: 900, color: '#166534', fontSize: '1.1rem' }}>Trip Complete</div>
          <div style={{ fontSize: '0.88rem', color: '#55456f', marginTop: 4 }}>
            Thank you for renting with us! We hope you had a great experience.
          </div>
        </div>
      )}

      {/* Footer */}
      <div style={{ textAlign: 'center', padding: '16px 0 24px', fontSize: '0.78rem', color: '#94a3b8' }}>
        Ride Fleet · This view updates automatically
      </div>
    </div>
  );
}

// ─── Styles ──────────────────────────────────────────────────────────────────
const shell = {
  maxWidth: 480,
  margin: '0 auto',
  padding: '8px 16px 24px',
  minHeight: '100vh',
  fontFamily: "Aptos, 'Segoe UI Variable', 'Segoe UI', system-ui, sans-serif",
};

const card = {
  padding: '18px 20px',
  borderRadius: 20,
  background: 'rgba(255,255,255,.92)',
  border: '1px solid rgba(110,73,255,.1)',
  boxShadow: '0 8px 24px rgba(47,58,114,.06)',
  marginBottom: 14,
};

const sectionTitle = {
  fontWeight: 800,
  fontSize: '0.88rem',
  color: '#6b7a9a',
  textTransform: 'uppercase',
  letterSpacing: '.06em',
  marginBottom: 12,
};

const grid2 = {
  display: 'grid',
  gridTemplateColumns: '1fr 1fr',
  gap: 12,
};

const tile = {
  padding: '12px 14px',
  borderRadius: 14,
  background: 'rgba(110,73,255,.04)',
  border: '1px solid rgba(110,73,255,.08)',
};

const tileLabel = {
  fontSize: '0.72rem',
  fontWeight: 700,
  color: '#6b7a9a',
  textTransform: 'uppercase',
  letterSpacing: '.06em',
  marginBottom: 4,
};

const tileValue = {
  fontWeight: 800,
  color: '#1a1230',
  fontSize: '0.92rem',
};

const tileSub = {
  fontSize: '0.8rem',
  color: '#6b7a9a',
  marginTop: 3,
};

const chip = {
  display: 'inline-block',
  padding: '3px 10px',
  borderRadius: 999,
  background: 'rgba(110,73,255,.06)',
  border: '1px solid rgba(110,73,255,.12)',
  color: '#4c1d95',
  fontSize: '0.78rem',
  fontWeight: 700,
};

// ===========================================================================
// CheckoutStepHero — wizard-step screen shown to the customer during
// an active checkout-wizard-v2 session. Mirrors the customer panes from
// the mockup (steps 1-6).
//
// Important: this stays READ-ONLY. The customer never interacts with
// the counter display. T&C signing happens on their phone, signature
// happens on the agent's mobile during step 6. This component just
// tells them what's happening and what to do next.
// ===========================================================================
function CheckoutStepHero({ session, customer }) {
  const step = session?.currentStep;
  const stepNumber = STEP_TO_NUMBER[step] || 1;
  return (
    <div style={{ ...card, background: '#FFFFFF', borderRadius: 16, padding: 24, marginBottom: 16 }}>
      <CheckoutStepTracker currentNumber={stepNumber} />
      <div style={{ marginTop: 20 }}>
        {step === 'CONFIRMING'             && <HeroConfirm customer={customer} />}
        {step === 'TC_PENDING'             && <HeroTermsPending />}
        {step === 'TC_SIGNED'              && <HeroBridge label="Terms signed ✓" />}
        {step === 'PAYMENT_PENDING'        && <HeroPayment />}
        {step === 'PAID'                   && <HeroBridge label="Payment captured ✓" />}
        {step === 'INSPECTION_HANDOFF'     && <HeroInspectionHandoff />}
        {step === 'INSPECTION_IN_PROGRESS' && <HeroInspectionInProgress />}
        {step === 'CUSTOMER_SIGN_PENDING'  && <HeroCustomerSign />}
        {step === 'FINALIZING'             && <HeroBridge label="Building your agreement…" />}
      </div>
    </div>
  );
}

const STEP_TO_NUMBER = {
  CONFIRMING: 1,
  TC_PENDING: 2,
  TC_SIGNED: 2,
  PAYMENT_PENDING: 3,
  PAID: 3,
  INSPECTION_HANDOFF: 4,
  INSPECTION_IN_PROGRESS: 5,
  CUSTOMER_SIGN_PENDING: 6,
  FINALIZING: 6,
  CLOSED: 6,
};

function CheckoutStepTracker({ currentNumber }) {
  const steps = [1, 2, 3, 4, 5, 6];
  return (
    <div style={{ display: 'flex', justifyContent: 'center', gap: 8 }}>
      {steps.map((n) => {
        const isCurrent = n === currentNumber;
        const isDone = n < currentNumber;
        return (
          <div key={n} style={{
            width: 28, height: 28, borderRadius: '50%',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            background: isCurrent ? '#7c3aed' : isDone ? '#16a34a' : 'rgba(110,73,255,.1)',
            color: isCurrent || isDone ? '#FFFFFF' : '#a090c8',
            fontWeight: 700, fontSize: 12,
            boxShadow: isCurrent ? '0 2px 8px rgba(124,58,237,.3)' : 'none',
          }}>
            {isDone ? '✓' : n}
          </div>
        );
      })}
    </div>
  );
}

function HeroConfirm({ customer }) {
  return (
    <div style={{ textAlign: 'center' }}>
      <div style={{ fontSize: '1.4rem', fontWeight: 800, color: '#1a1230', marginBottom: 6 }}>
        Welcome{customer?.firstName ? `, ${customer.firstName}` : ''}!
      </div>
      <div style={{ color: '#6b7a9a' }}>Let's confirm your reservation</div>
    </div>
  );
}

function HeroTermsPending() {
  return (
    <div style={{ textAlign: 'center' }}>
      <div style={{ fontSize: '1.3rem', fontWeight: 800, color: '#1a1230', marginBottom: 6 }}>
        Sign your rental terms
      </div>
      <div style={{ color: '#6b7a9a', marginBottom: 16 }}>Scan the QR with your phone</div>
      <div style={{ display: 'inline-block', padding: 24, background: '#F3F4F6', borderRadius: 12, fontSize: 80 }}>📱</div>
      <div style={{ color: '#94a3b8', fontSize: '0.85rem', marginTop: 12 }}>Or check your email for a signing link</div>
    </div>
  );
}

function HeroPayment() {
  return (
    <div style={{ textAlign: 'center' }}>
      <div style={{ fontSize: '1.3rem', fontWeight: 800, color: '#1a1230', marginBottom: 6 }}>
        Review your invoice
      </div>
      <div style={{ color: '#6b7a9a', marginBottom: 16 }}>Use the terminal to your right</div>
      <div style={{
        background: 'rgba(59,130,246,.08)', border: '1px solid rgba(59,130,246,.2)',
        padding: 12, borderRadius: 8, color: '#1e3a8a', fontSize: '0.85rem', textAlign: 'left',
      }}>
        <strong>Card on file:</strong> Your card will be securely saved. Any extra charges
        (tolls, fuel, damage) may be billed to this card after return.
      </div>
    </div>
  );
}

function HeroInspectionHandoff() {
  return (
    <div style={{ textAlign: 'center' }}>
      <div style={{ fontSize: '1.3rem', fontWeight: 800, color: '#1a1230', marginBottom: 6 }}>
        Follow your agent outside
      </div>
      <div style={{ color: '#6b7a9a' }}>Vehicle inspection</div>
      <div style={{ fontSize: 64, marginTop: 16 }}>🚶</div>
    </div>
  );
}

function HeroInspectionInProgress() {
  return (
    <div style={{ textAlign: 'center' }}>
      <div style={{ fontSize: '1.3rem', fontWeight: 800, color: '#1a1230', marginBottom: 6 }}>
        Vehicle inspection in progress
      </div>
      <div style={{ color: '#6b7a9a' }}>Your agent is reviewing the car with you</div>
    </div>
  );
}

function HeroCustomerSign() {
  return (
    <div style={{ textAlign: 'center' }}>
      <div style={{ fontSize: '1.3rem', fontWeight: 800, color: '#1a1230', marginBottom: 6 }}>
        Sign on agent's device
      </div>
      <div style={{ color: '#6b7a9a' }}>Almost done — your agent will hand you a tablet to sign the inspection</div>
    </div>
  );
}

function HeroBridge({ label }) {
  return (
    <div style={{ textAlign: 'center', color: '#16a34a', fontWeight: 700, fontSize: '1.1rem' }}>
      {label}
    </div>
  );
}
