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
 * Visual system (2026-06-04): restyled to match checkout-wizard-v2 —
 * same StepTracker pill header, cardStyle surfaces, KV rows, button and
 * status-pill palette. Style constants are copied locally (no cross-page
 * imports). Logic, API calls, fee preview, and submit flow are unchanged.
 */

import { useEffect, useMemo, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { AuthGate } from '../../../../components/AuthGate';
import { AppShell } from '../../../../components/AppShell';
import { api } from '../../../../lib/client';
import { formatTenantWallClock } from '../../../../lib/tenant-time';
import { displayNoteLines, hasDisplayNotes, isRecentNote, relativeNoteAge } from '../../../../lib/reservation-notes';
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
  // Pillar 2 16q: tenant-configured fee rates fetched from Settings →
  // Inspection Fees. Used by the live fee preview in Step 3 so the
  // numbers staff see match what the backend will actually charge.
  // Falls back to hardcoded defaults inside useFeePreview if fetch fails.
  const [feeRates, setFeeRates] = useState(null);

  // Form state
  const [odometerIn, setOdometerIn] = useState('');
  const [fuelIn, setFuelIn] = useState(1);
  const [cleanlinessIn, setCleanlinessIn] = useState(5);
  const [smokingDetected, setSmokingDetected] = useState(false);
  // Waive Late Return Fee — agent override. Mirrors the backend
  // waiveLateFee flag in checkin-close.service.js. Reasons typically:
  // courtesy / flight delay / authorized overrun. The live fee preview
  // skips the LATE_RETURN line when this is on; the backend re-validates
  // and audit-logs the flag on the STATUS_CHANGE row.
  const [waiveLateFee, setWaiveLateFee] = useState(false);
  // Actual return date/time — ADMIN backdate (Hector, 2026-08-10): the
  // customer returned on the scheduled day but staff ran the check-in later,
  // and the late fee was computing from "now". Empty = now (unchanged flow).
  // The backend enforces the same role rule; this only reveals the field.
  const [actualReturnAt, setActualReturnAt] = useState('');
  const canBackdate = ['SUPER_ADMIN', 'ADMIN', 'OPS'].includes(String(me?.role || '').toUpperCase());
  const [photos, setPhotos] = useState({});
  const [currentAngle, setCurrentAngle] = useState(0);
  // Fase D (2026-06-18): when the tenant uses the CUSTOMER inspection model AND the customer
  // already submitted a CHECK-IN inspection, the agent's photo step becomes optional (they can
  // skip and close, or still add their own). Pure gating — no change to the close/money logic.
  const [checkinModel, setCheckinModel] = useState('AGENT');
  const [customerCheckinInspection, setCustomerCheckinInspection] = useState(null);
  const [paymentMode, setPaymentMode] = useState('autocharge');  // 'autocharge' | 'manual'
  const [manualPayment, setManualPayment] = useState({ amount: '', method: 'card', last4: '', reference: '' });
  const [signerName, setSignerName] = useState('');
  const [signatureDataUrl, setSignatureDataUrl] = useState('');

  // Load reservation + agreement + tenant fee rates (for live preview)
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

        // Fetch tenant-configured fee rates so Step 3 preview matches what
        // the backend will charge. The GET endpoint always returns 7 rows
        // merged with platform defaults — never empty for an authed user.
        // Pass the reservation's tenantId explicitly so super-admins viewing
        // a tenant's reservation see THAT tenant's rates (not their own,
        // which super-admin doesn't have). For regular tenant users this is
        // a no-op (scopeFor uses req.user.tenantId anyway when not super).
        try {
          const tenantId = res?.tenantId || res?.rentalAgreement?.tenantId;
          const ratesUrl = tenantId
            ? `/api/settings/fee-rates?tenantId=${encodeURIComponent(tenantId)}`
            : '/api/settings/fee-rates';
          const ratesRes = await api(ratesUrl, { bypassCache: true }, token);
          const rows = Array.isArray(ratesRes?.rates) ? ratesRes.rates : [];
          // Transform to the { FEE_TYPE: { unit, amount } } shape useFeePreview expects.
          // Use currentAmount (the override) if set, otherwise defaultAmount.
          const dict = {};
          for (const r of rows) {
            const amount = r.currentAmount != null ? Number(r.currentAmount) : Number(r.defaultAmount || 0);
            // disabled=true when tenant explicitly turned this fee off; the
            // hook returns null for disabled rates and skips computing them.
            const disabled = r.isActive === false;
            dict[r.feeType] = { unit: r.unit, amount, disabled };
          }
          setFeeRates(dict);
        } catch (err) {
          // Non-fatal: useFeePreview falls back to its FALLBACK_RATES table.
          console.warn('[checkin-wizard] failed to load tenant fee rates, using fallbacks', err);
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

  // Late-return preview: dueBackAt is the scheduled return-by time, returnedAt
  // is "now" (when the user is closing checkin). The hook silently skips if the
  // tenant disabled LATE_RETURN or if the return is on-time / inside grace.
  const dueBackAt = agreement?.returnAt || reservation?.returnAt || null;
  const returnedAtNow = useMemo(() => new Date().toISOString(), [
    // Refresh once per minute while Step 3 is open so the preview keeps pace
    // with the clock without rerendering on every keystroke.
    Math.floor(Date.now() / 60000)
  ]);

  const feePreview = useFeePreview({
    rates: feeRates,
    odometerOut: agreement?.odometerOut,
    odometerIn: odometerIn ? Number(odometerIn) : null,
    fuelOut: agreement?.fuelOut,
    fuelIn,
    cleanlinessOut: agreement?.cleanlinessOut,
    cleanlinessIn,
    smokingDetected,
    // Waive flag: nulling dueBackAt makes the hook skip the LATE_RETURN
    // computation (same trick as the backend uses). Other fees compute
    // normally.
    dueBackAt: waiveLateFee ? null : dueBackAt,
    returnedAt: (canBackdate && actualReturnAt) ? actualReturnAt : returnedAtNow,
    rentalDays,
    includedMilesPerDay: 200,
    tankCapacityGallons: 15
  });

  const photosCaptured = Object.keys(photos).length;
  const photosRequired = STANDARD_ANGLES.length;

  // Load the tenant's check-in inspection model + whether the customer already self-inspected
  // at return. When both say "customer", the agent photo step is optional.
  useEffect(() => {
    if (!reservation?.id) return;
    let on = true;
    api('/api/settings/customer-inspection', {}, token)
      .then((cfg) => { if (on) setCheckinModel(cfg?.enabled && String(cfg?.checkinModel || 'AGENT').toUpperCase() === 'CUSTOMER' ? 'CUSTOMER' : 'AGENT'); })
      .catch(() => {});
    api(`/api/customer-inspections?reservationId=${encodeURIComponent(reservation.id)}`, {}, token)
      .then((list) => {
        if (!on) return;
        const arr = Array.isArray(list) ? list : (list?.rows || list?.inspections || []);
        setCustomerCheckinInspection(arr.find((i) => String(i?.phase || '').toUpperCase() === 'CHECKIN') || null);
      })
      .catch(() => {});
    return () => { on = false; };
  }, [reservation?.id, token]);

  const agentInspectionOptional = checkinModel === 'CUSTOMER' && !!customerCheckinInspection;

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
        // Agent waiver of the LATE_RETURN line item. Backend re-validates
        // and audit-logs the flag on the STATUS_CHANGE entry.
        waiveLateFee,
        // Naive wall-clock string; the backend parses it in the TENANT's
        // timezone (the 2026-08-07 extension lesson). Omitted entirely when
        // untouched so the default "now" path is byte-identical to before.
        ...(canBackdate && actualReturnAt ? { returnedAt: actualReturnAt } : {}),
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
    { title: 'Return summary', body: 'Step1Summary' },
    { title: 'Photo inspection', body: 'Step2Photos' },
    { title: 'Return metrics · live fee preview', body: 'Step3Metrics' },
    { title: 'Settle balance', body: 'Step4Payment' },
    { title: 'Acknowledge fees & sign', body: 'Step5Signature' },
    { title: 'Return complete', body: 'Step6Success' }
  ];

  const canAdvance = () => {
    switch (step) {
      case 0: return !!reservation && !!agreement;
      case 1: return photosCaptured >= 1 || agentInspectionOptional;  // staff override (≥1 photo) OR customer already self-inspected
      case 2: return Number(odometerIn) > 0 && Number(odometerIn) >= Number(agreement?.odometerOut || 0);
      case 3: return paymentMode === 'autocharge' || (paymentMode === 'manual' && Number(manualPayment.amount) > 0);
      // 2026-07-28 (LAX #9): the customer signature at check-IN is OPTIONAL —
      // it must never block completion (Hector). The pad stays available and
      // still persists when captured; the backend never required it.
      case 4: return true;
      default: return true;
    }
  };

  // Sibling of canAdvance(): when the Continue button is disabled, returns a
  // short, actionable string telling staff EXACTLY what's missing for the
  // current step. Returns null whenever canAdvance() is true (button enabled,
  // no hint to show). Keeps the same step→rule mapping as canAdvance() above
  // so the two never drift — fixes the QA "stuck with no explanation" P2.
  const blockedReason = () => {
    if (canAdvance()) return null;
    const odoOut = Number(agreement?.odometerOut || 0);
    switch (step) {
      case 0:
        if (!reservation) return 'Cargando la reservación…';
        if (!agreement) return 'No hay un acuerdo vinculado a esta reservación todavía — completa primero el check-out (Start Check-out) para generarlo.';
        return 'Faltan datos de la reservación';
      case 1:
        return 'Captura al menos 1 foto del return';
      case 2:
        if (!(Number(odometerIn) > 0)) return 'Ingresa el odómetro de regreso (mayor a 0)';
        return `El odómetro de regreso no puede ser menor al de salida (${odoOut.toLocaleString()} mi)`;
      case 3:
        return 'En pago manual, ingresa un monto mayor a $0.00 (o elige auto-cobro en 24h)';
      // case 4 removed (LAX #9): signature is optional, the button never
      // disables on this step, so there is no hint to show.
      default:
        return null;
    }
  };

  const onNext = () => {
    if (step === 4) return submitCheckinClose();
    if (step === 5) return router.push('/reservations');
    setStep((s) => Math.min(s + 1, steps.length - 1));
  };

  // Scroll to top on each step change so the user doesn't land mid-page.
  // (Previously provided by the shared WizardShell chrome.)
  useEffect(() => {
    if (typeof window !== 'undefined') window.scrollTo(0, 0);
  }, [step]);

  if (loading) {
    return (
      <AppShell me={me} logout={logout}>
        <div style={{ padding: 24 }}>Loading reservation…</div>
      </AppShell>
    );
  }
  if (!reservation) {
    return (
      <AppShell me={me} logout={logout}>
        <div style={{ padding: 24, color: '#B91C1C' }}>Reservation not found</div>
      </AppShell>
    );
  }

  const onBack = step > 0 && step < 5 ? () => setStep((s) => s - 1) : null;
  const nextLabel =
    submitting ? 'Submitting…' :
    step === 4 ? 'Confirm & submit →' :
    step === 5 ? 'Return to reservations' : 'Continue →';
  const nextDisabled = !canAdvance() || submitting;
  // When the button is disabled (and we're not mid-submit), surface WHY so
  // staff aren't left guessing. Null while submitting or when advanceable.
  const reason = submitting ? null : blockedReason();

  return (
    <AppShell me={me} logout={logout}>
      <div style={{ padding: 24, maxWidth: 1100, margin: '0 auto' }}>
        {/* Header — title + step tracker, same visual system as checkout-wizard-v2 */}
        <div style={{ marginBottom: 24 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
            <div>
              <div style={{ fontWeight: 600, fontSize: 16 }}>
                Check-in · #{reservation.reservationNumber}
              </div>
              <div style={{ fontSize: 13, color: '#6B7280' }}>
                {reservation.customer?.firstName} {reservation.customer?.lastName}
              </div>
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <button onClick={() => router.push(`/reservations/${reservationId}`)} style={pauseBtnStyle}>
                Back to reservation
              </button>
            </div>
          </div>
          <StepTracker currentNumber={step + 1} done={step === 5} />
        </div>

        <div style={cardStyle}>
          <h3 style={h3Style}>Step {step + 1} · {steps[step].title}</h3>
          {step === 0 && <Step1Summary reservation={reservation} agreement={agreement} />}
          {step === 1 && (
            <>
              {agentInspectionOptional && (
                <div style={{ background: '#eef0ff', border: '1px solid #c9cdf7', borderRadius: 10, padding: '12px 14px', marginBottom: 14, color: '#2c2a5a', fontSize: 14 }}>
                  <strong>The customer already inspected this vehicle at return.</strong> Their damage reports
                  {String(customerCheckinInspection?.status || '').toUpperCase() === 'SUBMITTED' ? ' are waiting in the approval queue.' : ' are in the review queue.'} You can
                  <strong> skip the photos and continue</strong>, or still add your own below.
                </div>
              )}
              <Step2Photos
                photos={photos}
                onCapture={(k, dataUrl) => setPhotos((p) => ({ ...p, [k]: dataUrl }))}
                currentAngle={currentAngle}
                onAngleChange={setCurrentAngle}
              />
            </>
          )}
          {step === 2 && (
            <Step3Metrics
              agreement={agreement}
              odometerIn={odometerIn} onOdometerIn={setOdometerIn}
              fuelIn={fuelIn} onFuelIn={setFuelIn}
              cleanlinessIn={cleanlinessIn} onCleanlinessIn={setCleanlinessIn}
              smokingDetected={smokingDetected} onSmokingDetected={setSmokingDetected}
              waiveLateFee={waiveLateFee} onWaiveLateFee={setWaiveLateFee}
              canBackdate={canBackdate}
              actualReturnAt={actualReturnAt} onActualReturnAt={setActualReturnAt}
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

          {/* Step navigation — same primary/ghost button styles as checkout-wizard-v2 */}
          <div style={{ display: 'flex', gap: 12, justifyContent: 'flex-end', alignItems: 'center', marginTop: 16 }}>
            {/* Disabled-reason hint — tells staff exactly what's missing so they
                aren't stuck staring at a greyed-out Continue (QA P2 fix). */}
            {reason && (
              <span style={{ fontSize: 12, color: '#92400E', textAlign: 'right', flex: 1 }}>
                {reason}
              </span>
            )}
            {onBack && (
              <button type="button" style={ghostBtn} onClick={onBack}>← Back</button>
            )}
            <button
              type="button"
              style={{ ...primaryBtn, opacity: nextDisabled ? 0.4 : 1, cursor: nextDisabled ? 'not-allowed' : 'pointer' }}
              onClick={onNext}
              disabled={nextDisabled}
              title={reason || undefined}
            >
              {nextLabel}
            </button>
          </div>
        </div>
      </div>
    </AppShell>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// StepTracker — numbered pills, same visual style as checkout-wizard-v2
// ─────────────────────────────────────────────────────────────────────────────
function StepTracker({ currentNumber, done }) {
  const steps = [
    { number: 1, label: 'Summary' },
    { number: 2, label: 'Photos' },
    { number: 3, label: 'Metrics' },
    { number: 4, label: 'Settle' },
    { number: 5, label: 'Sign' },
    { number: 6, label: 'Done' },
  ];
  return (
    <div style={{ display: 'flex', gap: 8 }}>
      {steps.map((s) => {
        const isCurrent = s.number === currentNumber;
        const isDone = s.number < currentNumber || done;
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

// ─────────────────────────────────────────────────────────────────────────────
// Step 1 — Welcome / Return summary
// ─────────────────────────────────────────────────────────────────────────────
function Step1Summary({ reservation, agreement }) {
  const v = reservation?.vehicle;
  const vehicleDesc = v ? [v.year, v.make, v.model].filter(Boolean).join(' ') : 'Vehicle';
  // Render the agreed pickup/return in the tenant TZ rather than the browser
  // TZ so this matches the agreement print, the reservation list/detail, and
  // any AST-facing staff view regardless of where the page is loaded from.
  const pickupAt = formatTenantWallClock(agreement?.pickupAt || reservation?.pickupAt);
  const returnAt = formatTenantWallClock(agreement?.returnAt || reservation?.returnAt);
  const isLate = new Date(agreement?.returnAt) < new Date();
  // Break out AUTH_HOLD payments from settled payments so the summary
  // shows the agent why the outstanding balance is what it is (e.g.
  // total=$289, hold=$250, settled=$0, outstanding=$39).
  const paymentsList = Array.isArray(agreement?.payments) ? agreement.payments : [];
  const authHoldsTotal = paymentsList
    .filter((p) => String(p?.method || '').toUpperCase() === 'AUTH_HOLD' && String(p?.status || 'PAID').toUpperCase() !== 'VOIDED')
    .reduce((sum, p) => sum + Number(p?.amount || 0), 0);
  const totalPaid = Number(agreement?.paidAmount || 0);
  const settledPaid = Math.max(0, Number((totalPaid - authHoldsTotal).toFixed(2)));
  return (
    <>
      {/* LAX #13 (2026-07-28): reservation notes reviewed as part of the flow. */}
      {hasDisplayNotes(reservation?.notes) && (
        <div style={{
          ...sectionBox, marginBottom: 16,
          background: 'rgba(110,73,255,.06)', border: '0.5px solid rgba(110,73,255,.35)',
        }}>
          <div style={{ ...sectionLabel, color: '#5b21b6' }}>
            📝 Notas de la reservación
            {isRecentNote(reservation?.notesUpdatedAt) && (
              <span style={{
                marginLeft: 8, padding: '1px 8px', borderRadius: 999, fontSize: 10,
                fontWeight: 700, textTransform: 'uppercase', background: '#6d28d9', color: '#fff',
              }}>
                Nueva · {relativeNoteAge(reservation?.notesUpdatedAt)}
              </span>
            )}
          </div>
          <div style={{ fontSize: 13, color: '#3b2d66', marginTop: 6 }}>
            {displayNoteLines(reservation?.notes).map((line, i) => (
              <div key={i} style={{ marginTop: i === 0 ? 0 : 2 }}>{line}</div>
            ))}
          </div>
        </div>
      )}
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div style={sectionBox}>
          <div style={sectionLabel}>Returning vehicle</div>
          <div style={{ fontSize: 18, fontWeight: 600, marginTop: 4, color: '#111827' }}>{vehicleDesc}</div>
          <div style={{ fontSize: 13, color: '#6B7280', marginTop: 4 }}>{v?.plate || 'No plate'} · Unit {v?.internalNumber || '—'}</div>
          <div style={{ display: 'flex', gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
            <StatusPill ok={!isLate} label={isLate ? 'Late return' : 'On time'} />
            <span style={{ ...pillBase, background: '#F3F4F6', color: '#6B7280' }}>
              {agreement?.inspections?.length || 0} inspection records
            </span>
          </div>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
          <Tile k="Customer" v={`${reservation?.customer?.firstName || ''} ${reservation?.customer?.lastName || ''}`.trim() || '—'} />
          <Tile k="Picked up" v={pickupAt.replace(',', ' ·')} />
          <Tile k="Due back" v={returnAt.replace(',', ' ·')} />
          <Tile k="Status" v={isLate ? 'Late' : 'On time'} valueColor={isLate ? '#F59E0B' : '#10B981'} />
        </div>
      </div>
      <div style={sectionBox}>
        <div style={sectionLabel}>Pickup baseline</div>
        <KV label="Odometer" value={`${Number(agreement?.odometerOut || 0).toLocaleString()} mi`} />
        <KV label="Fuel" value={`${Math.round(Number(agreement?.fuelOut || 0) * 100)}%`} />
        <KV label="Cleanliness" value={`${agreement?.cleanlinessOut || '—'}/5`} />
        <hr style={{ border: 'none', borderTop: '0.5px solid #E5E7EB', margin: '12px 0' }} />
        <KV label="Agreement total" value={`$${Number(agreement?.total || 0).toFixed(2)}`} />
        <KV label="Paid so far" value={`$${settledPaid.toFixed(2)}`} valueColor="#10B981" />
        {authHoldsTotal > 0 ? (
          <KV label="Auth holds" value={`$${authHoldsTotal.toFixed(2)}`} valueColor="#92400E" />
        ) : null}
        <KV
          label={<strong>Outstanding balance</strong>}
          value={<strong>${Number(agreement?.balance || 0).toFixed(2)}</strong>}
          valueColor={Number(agreement?.balance || 0) > 0 ? '#F59E0B' : '#10B981'}
        />
        <KV label="Card on file" value={
          agreement?.reservation?.customer?.cardLast4
            ? `${agreement.reservation.customer.cardBrand || 'Card'} ····${agreement.reservation.customer.cardLast4}`
            : '— No card'
        } />
      </div>
    </div>
    </>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Step 2 — Photo capture
// ─────────────────────────────────────────────────────────────────────────────
function Step2Photos({ photos, onCapture, currentAngle, onAngleChange }) {
  return (
    <div style={sectionBox}>
      <PhotoCapture
        capturedPhotos={photos}
        onCapture={onCapture}
        currentAngleIndex={currentAngle}
        onAngleChange={onAngleChange}
      />
    </div>
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
  waiveLateFee, onWaiveLateFee,
  canBackdate, actualReturnAt, onActualReturnAt,
  feePreview
}) {
  const odoOut = Number(agreement?.odometerOut || 0);
  const driven = Number(odometerIn) - odoOut;
  // Only show the waiver toggle when the rental is actually late — there's
  // no fee to waive otherwise. Late = now > returnAt + the 30-min grace
  // (mirrors LATE_RETURN_GRACE_MINUTES on the backend).
  const dueBack = agreement?.returnAt ? new Date(agreement.returnAt) : null;
  const isPastGrace = dueBack ? (Date.now() - dueBack.getTime()) > 30 * 60 * 1000 : false;
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
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
        {canBackdate && isPastGrace ? (
          <div style={{ padding: 12, background: actualReturnAt ? '#EFF6FF' : '#F9FAFB', border: `0.5px solid ${actualReturnAt ? '#3B82F6' : '#E5E7EB'}`, borderRadius: 6 }}>
            <div style={{ fontWeight: 500, fontSize: 13, color: '#374151' }}>Actual return date & time</div>
            <div style={{ fontSize: 11, color: '#6B7280', margin: '2px 0 8px' }}>
              {actualReturnAt
                ? 'Late fees will be computed from THIS moment, not from now. Backdate is audit-logged with your role.'
                : 'If the customer returned the car earlier and the check-in is only being recorded now, set when the car actually came back. Leave empty to use the current time.'}
            </div>
            <input
              type="datetime-local"
              value={actualReturnAt}
              max={new Date(Date.now() + 5 * 60000).toISOString().slice(0, 16)}
              onChange={(e) => onActualReturnAt(e.target.value)}
              style={{ padding: '8px 10px', border: '1px solid #D1D5DB', borderRadius: 6, fontSize: 13, fontFamily: 'inherit' }}
            />
            {actualReturnAt ? (
              <button type="button" onClick={() => onActualReturnAt('')} style={{ marginLeft: 8, fontSize: 12, background: 'none', border: 'none', color: '#3B82F6', cursor: 'pointer' }}>
                use current time
              </button>
            ) : null}
          </div>
        ) : null}
        {isPastGrace ? (
          <div style={{
            padding: 12,
            background: waiveLateFee ? '#FEF3C7' : '#F9FAFB',
            border: `0.5px solid ${waiveLateFee ? '#F59E0B' : '#E5E7EB'}`,
            borderRadius: 6,
          }}>
            <label style={{ display: 'flex', alignItems: 'flex-start', gap: 10, cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={waiveLateFee}
                onChange={(e) => onWaiveLateFee(e.target.checked)}
                style={{ width: 16, height: 16, marginTop: 2, accentColor: '#F59E0B' }}
              />
              <div>
                <div style={{ fontWeight: 500, fontSize: 13, color: waiveLateFee ? '#92400E' : '#374151' }}>
                  Waive late return fee
                </div>
                <div style={{ fontSize: 11, color: '#6B7280', marginTop: 2 }}>
                  {waiveLateFee
                    ? 'Late fee removed from this checkout. Action audit-logged.'
                    : 'Skip the LATE_RETURN fee for this rental (courtesy / flight delay / authorized overrun).'}
                </div>
              </div>
            </label>
          </div>
        ) : null}
      </div>
      <div style={{ position: 'sticky', top: 80 }}>
        <FeePreviewPanel items={feePreview.items} total={feePreview.total} />
      </div>
    </div>
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
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div style={{ ...sectionBox, background: '#1F2937', border: 'none', color: '#FFFFFF' }}>
          <div style={{ fontSize: 11, opacity: .7, fontWeight: 600, letterSpacing: '.06em', textTransform: 'uppercase' }}>Outstanding</div>
          <div style={{ fontSize: 28, fontWeight: 600, marginTop: 4 }}>${outstandingTotal.toFixed(2)}</div>
          <div style={{ fontSize: 11, opacity: .65, marginTop: 4 }}>
            ${existingBalance.toFixed(2)} prior balance · ${feesTotal.toFixed(2)} return fees
          </div>
        </div>

        <PaymentOption
          selected={paymentMode === 'autocharge'}
          onSelect={() => onPaymentMode('autocharge')}
          title="Auto-charge in 24h"
          subtitle="Recommended · gives customer time to review and dispute"
        >
          {paymentMode === 'autocharge' && (
            <>
              <KV label="Amount" value={`$${outstandingTotal.toFixed(2)}`} />
              <KV label="Charge time" value="Tomorrow, this hour" />
              <KV label="Card" value={`${cardBrand} ····${cardLast4}`} />
              <KV label="Status after" value="CHECKED_IN_UNPAID" valueColor="#F59E0B" />
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
        <div style={{
          ...sectionBox,
          background: paymentMode === 'autocharge' ? 'rgba(245,158,11,.08)' : '#D1FAE5',
          border: paymentMode === 'autocharge' ? '0.5px solid rgba(245,158,11,.3)' : '0.5px solid rgba(16,185,129,.3)',
        }}>
          <div style={{ fontSize: 11, fontWeight: 600, color: paymentMode === 'autocharge' ? '#92400E' : '#065F46', letterSpacing: '.06em', textTransform: 'uppercase' }}>
            {paymentMode === 'autocharge' ? 'What happens next' : 'Paid in full'}
          </div>
          <div style={{ fontSize: 13, color: '#374151', lineHeight: 1.6, marginTop: 8 }}>
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
        </div>
        <div style={{ ...sectionBox, marginTop: 12 }}>
          <div style={sectionLabel}>Agreement authorization</div>
          <div style={{ fontSize: 12, color: '#6B7280', lineHeight: 1.6 }}>
            Customer signed the post-rental charge authorization on the original agreement. The card-on-file
            is pre-authorized for these fee categories.
          </div>
          <div style={{ display: 'flex', gap: 6, marginTop: 10, flexWrap: 'wrap' }}>
            {['Mileage', 'Fuel', 'Cleaning', 'Smoking', 'Tolls', 'Damages'].map((tag) => (
              <span key={tag} style={{ ...pillBase, background: '#D1FAE5', color: '#065F46' }}>✓ {tag}</span>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function PaymentOption({ selected, onSelect, title, subtitle, children }) {
  return (
    <div
      onClick={onSelect}
      style={{
        border: selected ? '1px solid #1F2937' : '0.5px solid #E5E7EB',
        background: selected ? '#F9FAFB' : '#FFFFFF',
        borderRadius: 8,
        padding: 14,
        cursor: 'pointer',
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <div>
          <div style={{ fontSize: 10, fontWeight: 600, color: '#9CA3AF', letterSpacing: '.06em', textTransform: 'uppercase' }}>
            {selected ? 'Selected' : 'Or'}
          </div>
          <div style={{ fontSize: 14, fontWeight: 600, color: '#111827', marginTop: 4 }}>{title}</div>
          <div style={{ fontSize: 12, color: '#6B7280', marginTop: 4 }}>{subtitle}</div>
        </div>
        <div style={{
          width: 22, height: 22, borderRadius: '50%',
          background: selected ? '#10B981' : 'transparent',
          border: selected ? 'none' : '1px solid #D1D5DB',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          color: '#FFFFFF', fontWeight: 600, fontSize: 12, flexShrink: 0
        }}>
          {selected && '✓'}
        </div>
      </div>
      {children && <div style={{ marginTop: 12, borderTop: '0.5px solid #E5E7EB', paddingTop: 12 }}>{children}</div>}
    </div>
  );
}

function ManualPaymentForm({ payment, onChange, suggestedAmount }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ display: 'flex', gap: 6 }}>
        {[
          { id: 'card', label: 'Card' },
          { id: 'cash', label: 'Cash' },
          { id: 'check', label: 'Check' }
        ].map((m) => (
          <button
            key={m.id}
            type="button"
            onClick={() => onChange({ ...payment, method: m.id })}
            style={
              payment.method === m.id
                ? { ...primaryBtn, flex: 1, padding: '8px 12px', fontSize: 13 }
                : { ...ghostBtn, flex: 1 }
            }
          >
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
    <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <span style={{ fontSize: 12, color: '#6B7280' }}>{label}</span>
      <input
        type={type}
        value={value || ''}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        style={inputStyle}
      />
    </label>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Step 5 — Signature
// ─────────────────────────────────────────────────────────────────────────────
function Step5Signature({ feePreview, signerName, onSignerName, signatureDataUrl, onSignature, paymentMode, cardLast4, cardBrand, error }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div style={{ ...sectionBox, background: 'rgba(245,158,11,.08)', border: '0.5px solid rgba(245,158,11,.3)' }}>
          <div style={{ fontSize: 11, fontWeight: 600, color: '#92400E', letterSpacing: '.06em', textTransform: 'uppercase', marginBottom: 10 }}>Fees to acknowledge</div>
          {feePreview.items.length === 0 ? (
            <div style={{ fontSize: 13, color: '#374151' }}>No additional fees · balance unchanged</div>
          ) : (
            feePreview.items.map((it) => (
              <KV key={it.feeType} label={readableFee(it.feeType)} value={`$${it.total.toFixed(2)}`} />
            ))
          )}
          <hr style={{ border: 'none', borderTop: '0.5px solid rgba(245,158,11,.24)', margin: '10px 0' }} />
          <KV label={<strong>Total fees</strong>} value={<strong>${feePreview.total.toFixed(2)}</strong>} valueColor="#111827" />
        </div>
        {paymentMode === 'autocharge' && feePreview.total > 0 && (
          <div style={{ ...sectionBox, background: 'rgba(245,158,11,.08)', border: '0.5px solid rgba(245,158,11,.3)' }}>
            <div style={{ fontSize: 11, fontWeight: 600, color: '#92400E', letterSpacing: '.06em', textTransform: 'uppercase' }}>Charge notice</div>
            <div style={{ fontSize: 13, color: '#374151', marginTop: 8, lineHeight: 1.5 }}>
              <strong>{cardBrand} ····{cardLast4}</strong> will be charged <strong>${feePreview.total.toFixed(2)}</strong> in
              24 hours. You can reply to the invoice email or call us before then to dispute.
            </div>
          </div>
        )}
      </div>
      <div>
        <SignaturePad
          height={200}
          label="Customer Signature (optional)"
          signerName={signerName}
          onSignerNameChange={onSignerName}
          onSignatureChange={onSignature}
          helperText="Optional — capture it when the customer is present. By signing, the customer acknowledges the return condition and authorizes the listed charges. The return can be completed without a signature."
        />
        {error && (
          <div style={{ marginTop: 12, padding: '6px 8px', background: 'rgba(220,38,38,.06)', border: '0.5px solid rgba(220,38,38,.2)', borderRadius: 4, color: '#B91C1C', fontSize: 12 }}>
            {error}
          </div>
        )}
      </div>
    </div>
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
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
      <div>
        <div style={{
          minHeight: 240,
          borderRadius: 8,
          border: '0.5px solid rgba(16,185,129,.3)',
          background: '#D1FAE5',
          color: '#065F46',
          padding: 32,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
        }}>
          <div style={{
            width: 56, height: 56,
            borderRadius: '50%',
            background: '#10B981',
            color: '#FFFFFF',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: 28, fontWeight: 600,
          }}>✓</div>
          <div style={{ fontSize: 18, fontWeight: 600, marginTop: 14 }}>
            Thanks, {reservation?.customer?.firstName || 'Customer'}
          </div>
          <div style={{ fontSize: 12, opacity: .85, marginTop: 6 }}>
            Vehicle returned · {isUnpaid ? 'auto-charge in 24h' : 'paid in full'}
          </div>
          <div style={{ display: 'flex', gap: 8, marginTop: 16, flexWrap: 'wrap', justifyContent: 'center' }}>
            <span style={{ ...pillBase, background: 'rgba(16,185,129,.18)', color: '#065F46' }}>{isUnpaid ? 'Invoice' : 'Receipt'} emailed</span>
            {isUnpaid && <span style={{ ...pillBase, background: 'rgba(245,158,11,.18)', color: '#92400E' }}>Auto-charge in 24h</span>}
          </div>
        </div>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        {result?.feesTotal > 0 && (
          <div style={{
            ...sectionBox,
            background: isUnpaid ? 'rgba(245,158,11,.08)' : '#D1FAE5',
            border: isUnpaid ? '0.5px solid rgba(245,158,11,.3)' : '0.5px solid rgba(16,185,129,.3)',
          }}>
            <div style={{ fontSize: 11, fontWeight: 600, color: isUnpaid ? '#92400E' : '#065F46', letterSpacing: '.06em', textTransform: 'uppercase' }}>
              {isUnpaid ? 'Pending charge' : 'Charged'}
            </div>
            <div style={{ fontSize: 24, fontWeight: 600, color: '#111827', marginTop: 4 }}>
              ${Number(result.feesTotal).toFixed(2)}
            </div>
            <div style={{ fontSize: 12, color: '#6B7280', marginTop: 4 }}>
              {result?.feesAdded?.length} fee{result?.feesAdded?.length === 1 ? '' : 's'} added · {result?.autochargeAt ? `auto-charge ${new Date(result.autochargeAt).toLocaleString()}` : 'settled at counter'}
            </div>
          </div>
        )}
        <div style={sectionBox}>
          <div style={sectionLabel}>Staff actions</div>
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
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Small helpers
// ─────────────────────────────────────────────────────────────────────────────

function Tile({ k, v, valueColor }) {
  return (
    <div style={{ background: '#FFFFFF', border: '0.5px solid #E5E7EB', borderRadius: 6, padding: '8px 12px' }}>
      <div style={{ fontSize: 10, color: '#6B7280', textTransform: 'uppercase', letterSpacing: '.06em', fontWeight: 600 }}>{k}</div>
      <div style={{ fontSize: 13, fontWeight: 500, color: valueColor || '#111827', marginTop: 2 }}>{v}</div>
    </div>
  );
}

// KV — same key/value row used by checkout-wizard-v2 (label muted left,
// value medium-weight right), with an optional valueColor for status hues.
function KV({ label, value, valueColor }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', padding: '4px 0', fontSize: 13 }}>
      <span style={{ color: '#6B7280' }}>{label}</span>
      <span style={{ fontWeight: 500, color: valueColor || undefined }}>{value}</span>
    </div>
  );
}

// StatusPill — same status colors as checkout-wizard-v2 (#10B981 ok /
// #F59E0B warn) in a compact pill.
function StatusPill({ ok, label }) {
  return (
    <span style={{
      ...pillBase,
      background: ok ? '#D1FAE5' : '#FEF3C7',
      color: ok ? '#065F46' : '#92400E',
    }}>
      <span style={{
        display: 'inline-block', width: 6, height: 6, borderRadius: '50%',
        background: ok ? '#10B981' : '#F59E0B', marginRight: 6,
      }} />
      {label}
    </span>
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
        fontSize: 13,
        color: '#374151',
        cursor: 'pointer',
        textAlign: 'left'
      }}
    >
      <span>{label}</span>
      <span style={{ fontWeight: 600, color: variant === 'danger' ? '#B91C1C' : '#1F2937' }}>→</span>
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

// ---------------------------------------------------------------------------
// Styles — copied from checkout-wizard-v2 so both wizards read as the same
// product family. Do NOT import across page files; keep the constants local.
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

// Inner section panel — same surface treatment as checkout-v2's grey
// sub-panels (e.g. the QR + terminal-status boxes) for grouping content
// inside a step card.
const sectionBox = {
  background: '#F9FAFB', border: '0.5px solid #E5E7EB', borderRadius: 6, padding: 14,
};
const sectionLabel = {
  fontSize: 11, fontWeight: 600, color: '#6B7280',
  letterSpacing: '.06em', textTransform: 'uppercase', marginBottom: 10,
};
const pillBase = {
  display: 'inline-flex', alignItems: 'center',
  padding: '4px 10px', borderRadius: 999, fontSize: 11, fontWeight: 600,
};
