'use client';

/**
 * Pillar 2 — Checkin wizard (multi-step, fee engine, live preview).
 *
 * 6 steps:
 *   1. Return summary
 *   2. Before/after photo compare (8 angles)
 *   3. Metrics input WITH live fee preview (killer feature)
 *   4. Balance settlement (autocharge 24h OR manual payment now)
 *   5. Signature acknowledging fees
 *   6. Success
 *
 * Submits to POST /api/rental-agreements/:id/checkin-close which runs the
 * server-side fee engine, persists fees as RentalAgreementCharge rows,
 * routes status to CHECKED_IN or CHECKED_IN_UNPAID, enqueues autocharge,
 * and sends the appropriate email.
 *
 * Mockups reference: design/mockups/pillar2-checkin-checkout/index.html
 */

import { useEffect, useMemo, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { AuthGate } from '../../../../components/AuthGate';
import { AppShell } from '../../../../components/AppShell';
import { api } from '../../../../lib/client';
import { WizardShell, WizCard, WizGrid } from '../../../../components/wizard/WizardShell';
import { useFeePreview } from '../../../../components/wizard/useFeePreview';
import { FeePreviewPanel } from '../../../../components/wizard/FeePreviewPanel';
import {
  OdometerInput, FuelLevelInput, CleanlinessInput, SmokingToggle
} from '../../../../components/wizard/MetricInputs';
import { PhotoCapture, STANDARD_ANGLES } from '../../../../components/wizard/PhotoCapture';
import { SignaturePad } from '../../../../components/wizard/SignaturePad';

export default function Page() {
  return <AuthGate>{({ token, me, logout }) => <CheckinWizard token={token} me={me} logout={logout} />}</AuthGate>;
}

function CheckinWizard({ token, me, logout }) {
  const { id: reservationId } = useParams();
  const router = useRouter();
  const [step, setStep] = useState(0);
  const [loading, setLoading] = useState(true);
  const [reservation, setReservation] = useState(null);
  const [agreement, setAgreement] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState('');
  const [result, setResult] = useState(null);

  // Form state
  const [odometerIn, setOdometerIn] = useState('');
  const [fuelIn, setFuelIn] = useState(1);
  const [cleanlinessIn, setCleanlinessIn] = useState(5);
  const [smokingDetected, setSmokingDetected] = useState(false);
  const [photos, setPhotos] = useState({});
  const [currentAngle, setCurrentAngle] = useState(0);
  const [paymentMode, setPaymentMode] = useState('autocharge');  // 'autocharge' | 'manual'
  const [manualPayment, setManualPayment] = useState({ amount: '', method: 'card', last4: '', reference: '' });
  const [signerName, setSignerName] = useState('');
  const [signatureDataUrl, setSignatureDataUrl] = useState('');

  // Load reservation + agreement
  useEffect(() => {
    if (!reservationId) return;
    (async () => {
      try {
        const res = await api(`/api/reservations/${reservationId}`, {}, token);
        setReservation(res);

        const agreementId = res?.rentalAgreement?.id;
        if (agreementId) {
          const ag = await api(`/api/rental-agreements/${agreementId}`, {}, token);
          setAgreement(ag);
          // Default signer name to customer
          setSignerName([
            res?.customer?.firstName,
            res?.customer?.lastName
          ].filter(Boolean).join(' '));
        }
      } catch (err) {
        console.error('Failed to load reservation', err);
      } finally {
        setLoading(false);
      }
    })();
  }, [reservationId, token]);

  // Live fee preview
  const rentalDays = useMemo(() => {
    const start = new Date(agreement?.pickupAt || reservation?.pickupAt || Date.now());
    const end = new Date(agreement?.returnAt || reservation?.returnAt || Date.now());
    const ms = end - start;
    return Math.max(1, Math.ceil(ms / (24 * 60 * 60 * 1000)));
  }, [agreement?.pickupAt, agreement?.returnAt, reservation?.pickupAt, reservation?.returnAt]);

  const feePreview = useFeePreview({
    odometerOut: agreement?.odometerOut,
    odometerIn: odometerIn ? Number(odometerIn) : null,
    fuelOut: agreement?.fuelOut,
    fuelIn,
    cleanlinessOut: agreement?.cleanlinessOut,
    cleanlinessIn,
    smokingDetected,
    rentalDays,
    includedMilesPerDay: 200,
    tankCapacityGallons: 15
  });

  const photosCaptured = Object.keys(photos).length;
  const photosRequired = STANDARD_ANGLES.length;

  // Pillar 2 wizards (2026-05-19) — checkin submit sequence:
  // 1. POST /inspection (CHECKIN phase, photos + metrics)
  // 2. POST /signature  (writes signature to the reservation row)
  // 3. POST /checkin-close (runs fee engine, routes status to CHECKED_IN
  //    or CHECKED_IN_UNPAID, enqueues autocharge if pending, sends email)
  const submitCheckinClose = async () => {
    if (!agreement?.id) {
      setSubmitError('No agreement linked to this reservation');
      return;
    }
    setSubmitting(true);
    setSubmitError('');
    try {
      // 0. PATCH reservation notes with RES_CHECKIN audit line so the
      // /ops-view?section=checkin page (which parses notes for the
      // `[RES_CHECKIN ...]` marker) can show the check-in metrics side by
      // side with check-out. The legacy /checkin page does this same step.
      try {
        const checkinLine = `[RES_CHECKIN ${new Date().toISOString()}] odometerIn=${Number(odometerIn || 0)} fuelIn=${Number(fuelIn || 0)} cleanlinessIn=${Number(cleanlinessIn || 5)} smokingDetected=${smokingDetected ? 'true' : 'false'}`;
        const existingNotes = String(reservation?.notes || '');
        const nextNotes = existingNotes.trim() ? `${existingNotes}\n${checkinLine}` : checkinLine;
        await api(`/api/reservations/${reservationId}`, {
          method: 'PATCH',
          body: JSON.stringify({ notes: nextNotes })
        }, token);
      } catch (err) {
        // Non-fatal: ops-view will just not surface this row.
        console.warn('[checkin-wizard] failed to append RES_CHECKIN notes line', err);
      }

      // 1. Inspection (CHECKIN phase) with photos + metrics
      await api(`/api/rental-agreements/${agreement.id}/inspection`, {
        method: 'POST',
        body: JSON.stringify({
          phase: 'CHECKIN',
          odometer: odometerIn ? Number(odometerIn) : null,
          fuelLevel: String(fuelIn),
          cleanliness: String(cleanlinessIn),
          photos
        })
      }, token);

      // 2. Signature
      if (signatureDataUrl && signerName) {
        await api(`/api/rental-agreements/${agreement.id}/signature`, {
          method: 'POST',
          body: JSON.stringify({ signerName, signatureDataUrl })
        }, token);
      }

      // 3. Checkin-close — fee engine + status routing + emails
      const body = {
        odometerIn: odometerIn ? Number(odometerIn) : null,
        fuelIn,
        cleanlinessIn,
        smokingDetected,
        signerName,
        signatureDataUrl,
        manualPayment: paymentMode === 'manual' && Number(manualPayment.amount) > 0
          ? {
              amount: Number(manualPayment.amount),
              method: manualPayment.method,
              last4: manualPayment.last4 || null,
              reference: manualPayment.reference || null
            }
          : null
      };
      const res = await api(`/api/rental-agreements/${agreement.id}/checkin-close`, {
        method: 'POST',
        body: JSON.stringify(body)
      }, token);
      setResult(res);
      setStep(5);  // success step
    } catch (err) {
      setSubmitError(err.message || 'Checkin close failed');
    } finally {
      setSubmitting(false);
    }
  };

  // Step navigation
  const steps = [
    { title: 'Welcome back · return summary', body: 'Step1Summary' },
    { title: 'Before & after photo inspection', body: 'Step2Photos' },
    { title: 'Capture return metrics · live fee preview', body: 'Step3Metrics' },
    { title: 'Settle balance or schedule auto-charge', body: 'Step4Payment' },
    { title: 'Acknowledge fees & sign', body: 'Step5Signature' },
    { title: 'Return complete', body: 'Step6Success' }
  ];

  const canAdvance = () => {
    switch (step) {
      case 0: return !!reservation && !!agreement;
      case 1: return photosCaptured >= 1;  // staff can override and continue with at least 1
      case 2: return Number(odometerIn) > 0 && Number(odometerIn) >= Number(agreement?.odometerOut || 0);
      case 3: return paymentMode === 'autocharge' || (paymentMode === 'manual' && Number(manualPayment.amount) > 0);
      case 4: return !!signerName && !!signatureDataUrl;
      default: return true;
    }
  };

  const onNext = () => {
    if (step === 4) return submitCheckinClose();
    if (step === 5) return router.push('/reservations');
    setStep((s) => Math.min(s + 1, steps.length - 1));
  };

  if (loading) {
    return (
      <AppShell me={me} logout={logout}>
        <div style={{ padding: 60, textAlign: 'center', color: '#6f668f' }}>Loading reservation…</div>
      </AppShell>
    );
  }
  if (!reservation) {
    return (
      <AppShell me={me} logout={logout}>
        <div style={{ padding: 60, textAlign: 'center', color: '#ef4444' }}>Reservation not found</div>
      </AppShell>
    );
  }

  return (
    <AppShell me={me} logout={logout}>
      <WizardShell
        title="Checkin"
        stepIndex={step}
        totalSteps={6}
        stepTitle={steps[step].title}
        accent="mint"
        onBack={step > 0 && step < 5 ? () => setStep((s) => s - 1) : null}
        onNext={onNext}
        nextLabel={
          submitting ? 'Submitting…' :
          step === 4 ? 'Confirm & submit →' :
          step === 5 ? 'Return to reservations' : 'Continue →'
        }
        nextDisabled={!canAdvance() || submitting}
      >
        {step === 0 && <Step1Summary reservation={reservation} agreement={agreement} />}
        {step === 1 && (
          <Step2Photos
            photos={photos}
            onCapture={(k, dataUrl) => setPhotos((p) => ({ ...p, [k]: dataUrl }))}
            currentAngle={currentAngle}
            onAngleChange={setCurrentAngle}
          />
        )}
        {step === 2 && (
          <Step3Metrics
            agreement={agreement}
            odometerIn={odometerIn} onOdometerIn={setOdometerIn}
            fuelIn={fuelIn} onFuelIn={setFuelIn}
            cleanlinessIn={cleanlinessIn} onCleanlinessIn={setCleanlinessIn}
            smokingDetected={smokingDetected} onSmokingDetected={setSmokingDetected}
            feePreview={feePreview}
          />
        )}
        {step === 3 && (
          <Step4Payment
            reservation={reservation}
            agreement={agreement}
            feesTotal={feePreview.total}
            paymentMode={paymentMode}
            onPaymentMode={setPaymentMode}
            manualPayment={manualPayment}
            onManualPayment={setManualPayment}
          />
        )}
        {step === 4 && (
          <Step5Signature
            feePreview={feePreview}
            signerName={signerName}
            onSignerName={setSignerName}
            signatureDataUrl={signatureDataUrl}
            onSignature={setSignatureDataUrl}
            paymentMode={paymentMode}
            cardLast4={reservation?.customer?.cardLast4 || agreement?.reservation?.customer?.cardLast4}
            cardBrand={reservation?.customer?.cardBrand || agreement?.reservation?.customer?.cardBrand}
            error={submitError}
          />
        )}
        {step === 5 && <Step6Success result={result} reservation={reservation} agreement={agreement} token={token} onDone={() => router.push('/reservations')} />}
      </WizardShell>
    </AppShell>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Step 1 — Welcome / Return summary
// ─────────────────────────────────────────────────────────────────────────────
function Step1Summary({ reservation, agreement }) {
  const v = reservation?.vehicle;
  const vehicleDesc = v ? [v.year, v.make, v.model].filter(Boolean).join(' ') : 'Vehicle';
  const pickupAt = new Date(agreement?.pickupAt || reservation?.pickupAt).toLocaleString();
  const returnAt = new Date(agreement?.returnAt || reservation?.returnAt).toLocaleString();
  const isLate = new Date(agreement?.returnAt) < new Date();
  return (
    <WizGrid cols={2}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <WizCard accent="ink" padding={22}>
          <div style={{ fontSize: 12, opacity: .85, fontWeight: 700, letterSpacing: '.12em' }}>RETURNING VEHICLE</div>
          <div style={{ fontSize: 24, fontWeight: 800, marginTop: 6, letterSpacing: '-.01em' }}>{vehicleDesc}</div>
          <div style={{ fontSize: 13, opacity: .9, marginTop: 4 }}>⬢ {v?.plate || 'No plate'} · Unit {v?.internalNumber || '—'}</div>
          <div style={{ display: 'flex', gap: 8, marginTop: 16, flexWrap: 'wrap' }}>
            <span style={{ background: 'rgba(255,255,255,.22)', padding: '6px 12px', borderRadius: 999, fontSize: 11, fontWeight: 700 }}>
              {isLate ? '⚠ Late return' : '✓ On time'}
            </span>
            <span style={{ background: 'rgba(255,255,255,.22)', padding: '6px 12px', borderRadius: 999, fontSize: 11, fontWeight: 700 }}>
              {agreement?.inspections?.length || 0} inspection records
            </span>
          </div>
        </WizCard>
        <WizGrid cols={2} gap={10}>
          <Tile k="Customer" v={`${reservation?.customer?.firstName || ''} ${reservation?.customer?.lastName || ''}`.trim() || '—'} />
          <Tile k="Picked up" v={pickupAt.replace(',', ' ·')} />
          <Tile k="Due back" v={returnAt.replace(',', ' ·')} />
          <Tile k="Status" v={isLate ? 'Late' : 'On time'} valueColor={isLate ? '#f59e0b' : '#1fc7aa'} />
        </WizGrid>
      </div>
      <WizCard>
        <div style={{ fontSize: 11, fontWeight: 800, color: '#6f668f', letterSpacing: '.12em', marginBottom: 10 }}>PICKUP BASELINE</div>
        <RowBetween k="Odometer" v={`${Number(agreement?.odometerOut || 0).toLocaleString()} mi`} />
        <RowBetween k="Fuel" v={`${Math.round(Number(agreement?.fuelOut || 0) * 100)}%`} />
        <RowBetween k="Cleanliness" v={`${agreement?.cleanlinessOut || '—'}/5`} />
        <hr style={{ border: 'none', borderTop: '1px solid #e6dfff', margin: '12px 0' }} />
        <RowBetween k="Agreement total" v={`$${Number(agreement?.total || 0).toFixed(2)}`} />
        <RowBetween k="Paid so far" v={`$${Number(agreement?.paidAmount || 0).toFixed(2)}`} valueColor="#1fc7aa" />
        <RowBetween
          k={<strong>Outstanding balance</strong>}
          v={<strong>${Number(agreement?.balance || 0).toFixed(2)}</strong>}
          valueColor={Number(agreement?.balance || 0) > 0 ? '#f59e0b' : '#1fc7aa'}
        />
        <RowBetween k="Card on file" v={
          agreement?.reservation?.customer?.cardLast4
            ? `${agreement.reservation.customer.cardBrand || 'Card'} ····${agreement.reservation.customer.cardLast4}`
            : '— No card'
        } />
      </WizCard>
    </WizGrid>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Step 2 — Photo capture
// ─────────────────────────────────────────────────────────────────────────────
function Step2Photos({ photos, onCapture, currentAngle, onAngleChange }) {
  return (
    <WizCard padding={20}>
      <PhotoCapture
        capturedPhotos={photos}
        onCapture={onCapture}
        currentAngleIndex={currentAngle}
        onAngleChange={onAngleChange}
      />
    </WizCard>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Step 3 — Metrics + LIVE FEE PREVIEW (killer feature)
// ─────────────────────────────────────────────────────────────────────────────
function Step3Metrics({
  agreement,
  odometerIn, onOdometerIn,
  fuelIn, onFuelIn,
  cleanlinessIn, onCleanlinessIn,
  smokingDetected, onSmokingDetected,
  feePreview
}) {
  const odoOut = Number(agreement?.odometerOut || 0);
  const driven = Number(odometerIn) - odoOut;
  return (
    <WizGrid cols={2}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <OdometerInput
          value={odometerIn}
          onChange={onOdometerIn}
          baseline={odoOut}
          allowOcr
          hint={driven > 0 ? `+${driven.toLocaleString()} mi driven · ${Math.max(0, driven - feePreview.includedMiles)} over allowance` : null}
        />
        <FuelLevelInput
          value={fuelIn}
          onChange={onFuelIn}
          baseline={agreement?.fuelOut}
          hint={Number(agreement?.fuelOut) > fuelIn ? `Returned at ${Math.round(fuelIn*100)}% · pickup was ${Math.round(Number(agreement?.fuelOut)*100)}%` : null}
        />
        <CleanlinessInput
          value={cleanlinessIn}
          onChange={onCleanlinessIn}
          baseline={agreement?.cleanlinessOut}
          hint={Number(agreement?.cleanlinessOut) > cleanlinessIn ? `${Number(agreement?.cleanlinessOut) - cleanlinessIn}-tier drop from pickup` : null}
        />
        <SmokingToggle
          value={smokingDetected}
          onChange={onSmokingDetected}
        />
      </div>
      <div style={{ position: 'sticky', top: 80 }}>
        <FeePreviewPanel items={feePreview.items} total={feePreview.total} />
      </div>
    </WizGrid>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Step 4 — Payment routing
// ─────────────────────────────────────────────────────────────────────────────
function Step4Payment({ reservation, agreement, feesTotal, paymentMode, onPaymentMode, manualPayment, onManualPayment }) {
  const existingBalance = Number(agreement?.balance || 0);
  const outstandingTotal = existingBalance + feesTotal;
  const customer = agreement?.reservation?.customer || reservation?.customer;
  const cardLast4 = customer?.cardLast4 || '????';
  const cardBrand = customer?.cardBrand || 'Card';

  return (
    <WizGrid cols={2}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <WizCard accent="ink" padding={22}>
          <div style={{ fontSize: 11, opacity: .7, fontWeight: 700, letterSpacing: '.1em' }}>OUTSTANDING</div>
          <div style={{ fontSize: 36, fontWeight: 800, letterSpacing: '-.02em', marginTop: 4 }}>${outstandingTotal.toFixed(2)}</div>
          <div style={{ fontSize: 11, opacity: .65, marginTop: 4 }}>
            ${existingBalance.toFixed(2)} prior balance · ${feesTotal.toFixed(2)} return fees
          </div>
        </WizCard>

        <PaymentOption
          selected={paymentMode === 'autocharge'}
          onSelect={() => onPaymentMode('autocharge')}
          title="Auto-charge in 24h"
          subtitle="Recommended · gives customer time to review and dispute"
          accent="purple"
        >
          {paymentMode === 'autocharge' && (
            <>
              <RowBetween k="Amount" v={`$${outstandingTotal.toFixed(2)}`} />
              <RowBetween k="Charge time" v="Tomorrow, this hour" />
              <RowBetween k="Card" v={`${cardBrand} ····${cardLast4}`} />
              <RowBetween k="Status after" v="CHECKED_IN_UNPAID" valueColor="#f59e0b" />
            </>
          )}
        </PaymentOption>

        <PaymentOption
          selected={paymentMode === 'manual'}
          onSelect={() => onPaymentMode('manual')}
          title="Collect now at counter"
          subtitle="Manual payment · balance goes to $0.00 immediately"
        >
          {paymentMode === 'manual' && (
            <ManualPaymentForm
              payment={manualPayment}
              onChange={onManualPayment}
              suggestedAmount={outstandingTotal}
            />
          )}
        </PaymentOption>
      </div>
      <div>
        <WizCard accent={paymentMode === 'autocharge' ? 'warn' : 'mint'}>
          <div style={{ fontSize: 11, fontWeight: 800, color: paymentMode === 'autocharge' ? '#b45309' : '#047857', letterSpacing: '.1em' }}>
            {paymentMode === 'autocharge' ? 'WHAT HAPPENS NEXT' : 'PAID IN FULL'}
          </div>
          <div style={{ fontSize: 13, color: '#211a38', lineHeight: 1.6, marginTop: 8 }}>
            {paymentMode === 'autocharge' ? (
              <>
                Customer will receive an itemized invoice email <strong>immediately</strong> with the
                charge notice. They can reply or call <strong>within 24 hours</strong> to dispute. After that,
                the card on file is auto-charged via Authorize.Net CIM.
              </>
            ) : (
              <>
                After this payment posts, balance reaches <strong>$0.00</strong>. Customer gets the
                paid-in-full receipt email and leaves with a clean rental record.
              </>
            )}
          </div>
        </WizCard>
        <WizCard style={{ marginTop: 12 }}>
          <div style={{ fontSize: 11, fontWeight: 800, color: '#6f668f', letterSpacing: '.1em', marginBottom: 10 }}>AGREEMENT AUTHORIZATION</div>
          <div style={{ fontSize: 12, color: '#6f668f', lineHeight: 1.6 }}>
            Customer signed the post-rental charge authorization on the original agreement. The card-on-file
            is pre-authorized for these fee categories.
          </div>
          <div style={{ display: 'flex', gap: 6, marginTop: 10, flexWrap: 'wrap' }}>
            {['Mileage', 'Fuel', 'Cleaning', 'Smoking', 'Tolls', 'Damages'].map((tag) => (
              <span key={tag} style={{ fontSize: 10, padding: '3px 9px', background: 'rgba(31,199,170,.10)', color: '#047857', borderRadius: 999, fontWeight: 700 }}>✓ {tag}</span>
            ))}
          </div>
        </WizCard>
      </div>
    </WizGrid>
  );
}

function PaymentOption({ selected, onSelect, title, subtitle, accent, children }) {
  return (
    <div
      onClick={onSelect}
      style={{
        border: selected ? '2px solid #6d3df2' : '1px solid #e6dfff',
        background: selected ? 'linear-gradient(135deg, rgba(135,82,254,.05), rgba(135,82,254,.01))' : 'white',
        borderRadius: 16,
        padding: 16,
        cursor: 'pointer',
        boxShadow: selected ? '0 8px 20px rgba(135,82,254,.18)' : '0 6px 14px rgba(35,21,80,.06)',
        transition: 'all .2s ease'
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <div>
          <div style={{ fontSize: 11, fontWeight: 800, color: '#6f668f', letterSpacing: '.1em' }}>
            {selected ? 'SELECTED' : 'OR'}
          </div>
          <div style={{ fontSize: 16, fontWeight: 800, color: '#211a38', marginTop: 4 }}>{title}</div>
          <div style={{ fontSize: 12, color: '#6f668f', marginTop: 4 }}>{subtitle}</div>
        </div>
        <div style={{
          width: 26, height: 26, borderRadius: '50%',
          background: selected ? '#6d3df2' : 'transparent',
          border: selected ? 'none' : '2px solid #c5b1ff',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          color: 'white', fontWeight: 800, fontSize: 14, flexShrink: 0
        }}>
          {selected && '✓'}
        </div>
      </div>
      {children && <div style={{ marginTop: 14, borderTop: '1px solid rgba(135,82,254,.10)', paddingTop: 12 }}>{children}</div>}
    </div>
  );
}

function ManualPaymentForm({ payment, onChange, suggestedAmount }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ display: 'flex', gap: 6 }}>
        {[
          { id: 'card', label: 'Card', icon: '💳' },
          { id: 'cash', label: 'Cash', icon: '💵' },
          { id: 'check', label: 'Check', icon: '📄' }
        ].map((m) => (
          <button
            key={m.id}
            type="button"
            onClick={() => onChange({ ...payment, method: m.id })}
            style={{
              flex: 1, padding: '12px 8px',
              background: payment.method === m.id ? 'linear-gradient(135deg, #8752FE, #6d3df2)' : 'white',
              color: payment.method === m.id ? 'white' : '#6f668f',
              border: payment.method === m.id ? 'none' : '1px solid #e6dfff',
              borderRadius: 12,
              fontSize: 12,
              fontWeight: 700,
              cursor: 'pointer',
              boxShadow: payment.method === m.id ? '0 6px 14px rgba(135,82,254,.32)' : 'none'
            }}
          >
            <div style={{ fontSize: 18, marginBottom: 4 }}>{m.icon}</div>
            {m.label}
          </button>
        ))}
      </div>
      <Field
        label="Amount"
        value={payment.amount}
        onChange={(v) => onChange({ ...payment, amount: v })}
        type="number"
        placeholder={suggestedAmount.toFixed(2)}
      />
      {payment.method === 'card' && (
        <Field
          label="Last 4 digits"
          value={payment.last4}
          onChange={(v) => onChange({ ...payment, last4: v.replace(/\D/g, '').slice(0, 4) })}
          placeholder="4242"
        />
      )}
      <Field
        label="Reference / Auth #"
        value={payment.reference}
        onChange={(v) => onChange({ ...payment, reference: v })}
        placeholder="Optional"
      />
    </div>
  );
}

function Field({ label, value, onChange, type = 'text', placeholder = '' }) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <span style={{ fontSize: 10, fontWeight: 800, color: '#6f668f', letterSpacing: '.1em' }}>{label.toUpperCase()}</span>
      <input
        type={type}
        value={value || ''}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        style={{
          padding: '10px 14px',
          border: '1px solid #e6dfff',
          borderRadius: 12,
          fontSize: 14,
          fontWeight: 700,
          color: '#211a38',
          outline: 'none',
          background: 'white'
        }}
      />
    </label>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Step 5 — Signature
// ─────────────────────────────────────────────────────────────────────────────
function Step5Signature({ feePreview, signerName, onSignerName, signatureDataUrl, onSignature, paymentMode, cardLast4, cardBrand, error }) {
  return (
    <WizGrid cols={2}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <WizCard accent="warn">
          <div style={{ fontSize: 11, fontWeight: 800, color: '#b45309', letterSpacing: '.1em', marginBottom: 10 }}>FEES TO ACKNOWLEDGE</div>
          {feePreview.items.length === 0 ? (
            <div style={{ fontSize: 13, color: '#211a38' }}>No additional fees · balance unchanged</div>
          ) : (
            feePreview.items.map((it) => (
              <RowBetween key={it.feeType} k={readableFee(it.feeType)} v={`$${it.total.toFixed(2)}`} />
            ))
          )}
          <hr style={{ border: 'none', borderTop: '1px solid rgba(245,158,11,.24)', margin: '10px 0' }} />
          <RowBetween k={<strong>Total fees</strong>} v={<strong>${feePreview.total.toFixed(2)}</strong>} valueColor="#211a38" />
        </WizCard>
        {paymentMode === 'autocharge' && feePreview.total > 0 && (
          <WizCard accent="warn">
            <div style={{ fontSize: 11, fontWeight: 800, color: '#b45309', letterSpacing: '.1em' }}>CHARGE NOTICE</div>
            <div style={{ fontSize: 13, color: '#211a38', marginTop: 8, lineHeight: 1.5 }}>
              <strong>{cardBrand} ····{cardLast4}</strong> will be charged <strong>${feePreview.total.toFixed(2)}</strong> in
              24 hours. You can reply to the invoice email or call us before then to dispute.
            </div>
          </WizCard>
        )}
      </div>
      <div>
        <SignaturePad
          height={200}
          label="Customer Signature"
          signerName={signerName}
          onSignerNameChange={onSignerName}
          onSignatureChange={onSignature}
          helperText="By signing, the customer acknowledges the return condition and authorizes the listed charges."
        />
        {error && (
          <div style={{ marginTop: 12, padding: '10px 14px', background: 'rgba(239,68,68,.08)', border: '1px solid rgba(239,68,68,.24)', borderRadius: 10, color: '#b91c1c', fontSize: 13, fontWeight: 700 }}>
            ⚠ {error}
          </div>
        )}
      </div>
    </WizGrid>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Step 6 — Success
// ─────────────────────────────────────────────────────────────────────────────
function Step6Success({ result, reservation, agreement, token, onDone }) {
  const isUnpaid = result?.reservationStatus === 'CHECKED_IN_UNPAID';
  const [emailing, setEmailing] = useState(false);
  const [emailMsg, setEmailMsg] = useState('');
  const handleResendEmail = async () => {
    if (!agreement?.id) return;
    setEmailing(true);
    setEmailMsg('');
    try {
      await api(`/api/rental-agreements/${agreement.id}/email-agreement`, {
        method: 'POST',
        body: JSON.stringify({})
      }, token);
      setEmailMsg('Sent ✓');
    } catch (err) {
      setEmailMsg('Failed: ' + (err.message || 'unknown'));
    } finally {
      setEmailing(false);
    }
  };
  return (
    <WizGrid cols={2}>
      <div>
        <div style={{
          minHeight: 240,
          borderRadius: 18,
          background: 'linear-gradient(135deg, #1fc7aa 0%, #16a589 100%)',
          color: 'white',
          padding: 36,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          position: 'relative',
          overflow: 'hidden'
        }}>
          <div style={{
            width: 80, height: 80,
            borderRadius: '50%',
            background: 'rgba(255,255,255,.95)',
            color: '#1fc7aa',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: 40, fontWeight: 800,
            boxShadow: '0 8px 24px rgba(0,0,0,.16)'
          }}>✓</div>
          <div style={{ fontSize: 22, fontWeight: 800, marginTop: 14, letterSpacing: '-.005em' }}>
            Thanks, {reservation?.customer?.firstName || 'Customer'}
          </div>
          <div style={{ fontSize: 12, opacity: .85, marginTop: 6 }}>
            Vehicle returned · {isUnpaid ? 'auto-charge in 24h' : 'paid in full'}
          </div>
          <div style={{ display: 'flex', gap: 8, marginTop: 18, flexWrap: 'wrap', justifyContent: 'center' }}>
            <span style={{ background: 'rgba(255,255,255,.22)', padding: '6px 14px', borderRadius: 999, fontSize: 11, fontWeight: 700 }}>📧 {isUnpaid ? 'Invoice' : 'Receipt'} emailed</span>
            {isUnpaid && <span style={{ background: 'rgba(255,255,255,.22)', padding: '6px 14px', borderRadius: 999, fontSize: 11, fontWeight: 700 }}>⏰ Auto-charge in 24h</span>}
          </div>
        </div>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        {result?.feesTotal > 0 && (
          <WizCard accent={isUnpaid ? 'warn' : 'mint'}>
            <div style={{ fontSize: 11, fontWeight: 800, color: isUnpaid ? '#b45309' : '#047857', letterSpacing: '.1em' }}>
              {isUnpaid ? 'PENDING CHARGE' : 'CHARGED'}
            </div>
            <div style={{ fontSize: 28, fontWeight: 800, color: '#211a38', letterSpacing: '-.01em', marginTop: 4 }}>
              ${Number(result.feesTotal).toFixed(2)}
            </div>
            <div style={{ fontSize: 12, color: '#6f668f', marginTop: 4 }}>
              {result?.feesAdded?.length} fee{result?.feesAdded?.length === 1 ? '' : 's'} added · {result?.autochargeAt ? `auto-charge ${new Date(result.autochargeAt).toLocaleString()}` : 'settled at counter'}
            </div>
          </WizCard>
        )}
        <WizCard>
          <div style={{ fontSize: 11, fontWeight: 800, color: '#6f668f', letterSpacing: '.1em', marginBottom: 10 }}>STAFF ACTIONS</div>
          <ActionLink
            label={`View agreement ${agreement?.agreementNumber || ''}`}
            onClick={() => reservation?.id && (window.location.href = `/reservations/${reservation.id}`)}
          />
          <ActionLink
            label="View inspection photos"
            onClick={() => reservation?.id && (window.location.href = `/reservations/${reservation.id}/inspection-report`)}
          />
          <ActionLink
            label={emailing ? 'Sending…' : (emailMsg || (isUnpaid ? 'Re-send invoice email' : 'Re-send receipt email'))}
            onClick={handleResendEmail}
          />
          <ActionLink label="Return to reservations" onClick={onDone} />
        </WizCard>
      </div>
    </WizGrid>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Small helpers
// ─────────────────────────────────────────────────────────────────────────────

function Tile({ k, v, valueColor }) {
  return (
    <div style={{ background: 'white', border: '1px solid #e6dfff', borderRadius: 12, padding: '9px 12px' }}>
      <div style={{ fontSize: 10, color: '#6f668f', textTransform: 'uppercase', letterSpacing: '.08em', fontWeight: 700 }}>{k}</div>
      <div style={{ fontSize: 14, fontWeight: 750, color: valueColor || '#211a38', marginTop: 2 }}>{v}</div>
    </div>
  );
}

function RowBetween({ k, v, valueColor }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', padding: '4px 0', fontSize: 12 }}>
      <span style={{ color: '#6f668f' }}>{k}</span>
      <span style={{ color: valueColor || '#211a38', fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>{v}</span>
    </div>
  );
}

function ActionLink({ label, onClick, variant }) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        display: 'flex',
        justifyContent: 'space-between',
        width: '100%',
        padding: '8px 0',
        background: 'transparent',
        border: 'none',
        fontSize: 12,
        color: '#6f668f',
        cursor: 'pointer',
        textAlign: 'left'
      }}
    >
      <span>{label}</span>
      <span style={{ fontWeight: 700, color: variant === 'danger' ? '#ef4444' : '#6d3df2' }}>→</span>
    </button>
  );
}

function readableFee(feeType) {
  switch (feeType) {
    case 'EXCESS_MILEAGE': return 'Excess mileage';
    case 'FUEL_REFILL': return 'Fuel refill';
    case 'CLEANING_LIGHT': return 'Cleaning · light';
    case 'CLEANING_MEDIUM': return 'Cleaning · medium';
    case 'CLEANING_HEAVY': return 'Cleaning · heavy';
    case 'SMOKING': return 'Smoking penalty';
    default: return feeType;
  }
}
