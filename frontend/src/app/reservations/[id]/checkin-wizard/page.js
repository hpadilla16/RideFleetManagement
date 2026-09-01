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
import { useTranslation } from 'react-i18next';
import { AuthGate } from '../../../../components/AuthGate';
import { AppShell } from '../../../../components/AppShell';
import { api } from '../../../../lib/client';
import { mileageGuard } from '../../../../lib/mileage-guard';
import { ReportDamageWizard } from '../../../../components/reservations/ReportDamageWizard';
import { formatTenantWallClock } from '../../../../lib/tenant-time';
import { displayNoteLines, hasDisplayNotes, isRecentNote, relativeNoteAge } from '../../../../lib/reservation-notes';
import { useFeePreview } from '../../../../components/wizard/useFeePreview';
import { FeePreviewPanel } from '../../../../components/wizard/FeePreviewPanel';
import { MaintenanceCheckinBanner } from '../../../../components/wizard/MaintenanceCheckinBanner';
import { buildDueItems, maintenanceGateBlocked } from '../../../../lib/maintenance-eval';
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
  const { t } = useTranslation();
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
  // Counter-UX Item 2 (2026-08-31): the check-in odometer is PRE-FILLED with
  // the vehicle's last known mileage (agreement.odometerOut, falling back to
  // Vehicle.mileage — the "last odometer wins" mirror of VehicleMileageEntry).
  // Kept editable; entering less only WARNS (see mileageGuard), never blocks.
  const [odometerPrefill, setOdometerPrefill] = useState(null);
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
  // Checkout photos as the inspection reference (Hector, 2026-08-14): the
  // agent shooting each angle sees how the car left the lot, so a new scratch
  // is caught while the customer is still at the counter. Never blocks — a
  // checkout without photos just means no reference to show.
  const [checkoutPhotos, setCheckoutPhotos] = useState(null);
  const [checkoutAt, setCheckoutAt] = useState('');
  const [damageNotes, setDamageNotes] = useState({});
  // Fase D (2026-06-18): when the tenant uses the CUSTOMER inspection model AND the customer
  // already submitted a CHECK-IN inspection, the agent's photo step becomes optional (they can
  // skip and close, or still add their own). Pure gating — no change to the close/money logic.
  const [checkinModel, setCheckinModel] = useState('AGENT');
  const [customerCheckinInspection, setCustomerCheckinInspection] = useState(null);
  // Counter-UX Item 3 (2026-08-31): "Vehicle damage?" affordance inside the
  // check-in. REUSES the ReportDamageWizard modal (Feature 3) with THIS
  // reservation pre-selected — no second damage form. Same role roster as the
  // reservation-detail launch point (report-damage.routes.js).
  const canReportDamage = ['SUPER_ADMIN', 'ADMIN', 'OPS', 'AGENT'].includes(String(me?.role || '').toUpperCase());
  const [damageWizardOpen, setDamageWizardOpen] = useState(false);
  const [damageReported, setDamageReported] = useState(null);
  const [paymentMode, setPaymentMode] = useState('autocharge');  // 'autocharge' | 'manual'
  const [manualPayment, setManualPayment] = useState({ amount: '', method: 'card', last4: '', reference: '' });
  const [signerName, setSignerName] = useState('');
  const [signatureDataUrl, setSignatureDataUrl] = useState('');
  // Maintenance detection at check-in (Feature A, 2026-09-01). The vehicle's
  // service schedules are fetched ONCE per wizard; the Step-3 banner
  // re-evaluates them client-side against the TYPED odometer on every
  // keystroke (lib/maintenance-eval.js mirrors the backend evalSchedule).
  // The decision is ARMED here and FIRED at check-in close — nothing is
  // written until the close payload carries it. Undo = flipping back to
  // PENDING any time before the signature step submits.
  const [maintSchedules, setMaintSchedules] = useState(null);
  // A snooze marker consumed on wizard open (this IS the "re-surfaces at the
  // next rental event" contract — cleared server-side, re-evaluated fresh).
  const [maintPrevSnooze, setMaintPrevSnooze] = useState(null);
  // { status: 'PENDING' | 'ARMED' | 'SNOOZED', note }
  const [maintDecision, setMaintDecision] = useState({ status: 'PENDING', note: null });

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

          // Counter-UX Item 2: pre-fill the return odometer with the last
          // known mileage. odometerOut (stamped at check-out) is authoritative
          // for THIS rental; Vehicle.mileage covers agreements that never got
          // a check-out reading. Only fills while the field is still untouched.
          const lastKnown = Number(ag?.odometerOut ?? res?.vehicle?.mileage ?? 0);
          if (lastKnown > 0) {
            setOdometerPrefill(lastKnown);
            setOdometerIn((curr) => (String(curr || '').trim() === '' ? String(lastKnown) : curr));
          }
          // Default signer name to customer
          setSignerName([
            res?.customer?.firstName,
            res?.customer?.lastName
          ].filter(Boolean).join(' '));

          // Checkout photos for the side-by-side reference.
          //
          // DELIBERATELY NOT AWAITED. The payload is the checkout inspection's
          // base64 photos — 5 MB is typical — so awaiting it here would hold up
          // the fee-rate load below and delay step 3's preview by seconds on
          // every check-in. It lands while the agent is still on step 1; the
          // photo step is step 2. Soft-fail: an agreement with no CHECKOUT
          // inspection (or a slow endpoint) must never stand between an agent
          // and a check-in.
          api(`/api/rental-agreements/${agreementId}/inspection-report`, {}, token)
            .then((rep) => {
              // The ROUTE flattens the service's { checkout, checkin } into
              // checkoutInspection / checkinInspection — reading report.checkout
              // here silently found nothing and the comparison never rendered
              // (2026-08-14). Fallbacks cover the service shape in case a caller
              // ever passes the inner object straight through.
              const checkout = rep?.checkoutInspection || rep?.report?.checkout || rep?.checkout || null;
              const shots = checkout?.photos && typeof checkout.photos === 'object' ? checkout.photos : null;
              if (!shots || !Object.keys(shots).length) return;
              setCheckoutPhotos(shots);
              setCheckoutAt(checkout?.at ? new Date(checkout.at).toLocaleString([], {
                month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit'
              }) : '');
            })
            .catch((err) => {
              console.warn('[checkin-wizard] no checkout photos to compare against', err);
            });
        }

        // Maintenance detection (Feature A): consume the per-vehicle snooze
        // marker (wizard open = the vehicle's next rental event) and fetch
        // the service schedules the Step-3 banner evaluates against the typed
        // odometer. Both fail-soft — a maintenance read must never stand
        // between an agent and a check-in.
        const maintVehicleId = res?.vehicle?.id || res?.rentalAgreement?.vehicleId || null;
        if (maintVehicleId) {
          api(`/api/maintenance/vehicles/${maintVehicleId}/snooze/consume`, {
            method: 'POST',
            body: JSON.stringify({ event: 'CHECKIN' })
          }, token)
            .then((r) => { if (r?.snoozed) setMaintPrevSnooze(r.stamp || {}); })
            .catch(() => {});
          api(`/api/maintenance/vehicles/${maintVehicleId}/schedules`, { bypassCache: true }, token)
            .then((r) => setMaintSchedules(Array.isArray(r?.schedules) ? r.schedules : []))
            .catch(() => setMaintSchedules([]));
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

  // Maintenance banner rows at the TYPED reading — re-evaluated per keystroke.
  const maintItems = useMemo(
    () => buildDueItems(maintSchedules || [], odometerIn ? Number(odometerIn) : null, Date.now()),
    [maintSchedules, odometerIn]
  );
  // A corrected odometer can lift every row out of due — a decision armed
  // against rows that no longer exist must not ride the close payload.
  useEffect(() => {
    if (maintItems.length === 0 && maintDecision.status !== 'PENDING') {
      setMaintDecision({ status: 'PENDING', note: null });
    }
  }, [maintItems.length]); // eslint-disable-line react-hooks/exhaustive-deps

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

      // 1. Inspection (CHECKIN phase) with photos + metrics.
      //    Damage noted against the checkout reference is labelled by angle so
      //    the inspection report reads "Driver side: 6-inch scratch…" rather
      //    than an unattributed sentence — that attribution is what makes the
      //    note usable when a damage charge is questioned later.
      const damages = STANDARD_ANGLES
        .map((a) => {
          const note = String(damageNotes[a.key] || '').trim();
          return note ? `${a.label}: ${note}` : null;
        })
        .filter(Boolean)
        .join('\n');

      await api(`/api/rental-agreements/${agreement.id}/inspection`, {
        method: 'POST',
        body: JSON.stringify({
          phase: 'CHECKIN',
          odometer: odometerIn ? Number(odometerIn) : null,
          fuelLevel: String(fuelIn),
          cleanliness: String(cleanlinessIn),
          photos,
          ...(damages ? { damages } : {})
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
        // Feature A: the ARMED maintenance decision fires at close — the
        // backend opens the RO (or records the snooze marker + stamp) AFTER
        // its own status sync. Omitted when nothing was due or no decision
        // was made (due-soon-only path), so the legacy payload is unchanged.
        ...(maintItems.length && maintDecision.status !== 'PENDING' ? {
          maintenanceDecision: {
            action: maintDecision.status === 'ARMED' ? 'SEND' : 'SNOOZE',
            serviceTypes: maintItems.map((i) => i.serviceType),
            note: maintDecision.note || null,
          }
        } : {}),
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
      // Counter-UX Item 2 (2026-08-31): a reading BELOW the check-out odometer
      // no longer blocks — it warns inline instead (odometer swaps and
      // corrections are real; the Admin Corrections module is the precedent).
      // Feature A (2026-09-01): Continue is ALSO gated while an OVERDUE
      // maintenance row is pending a decision — the agent must arm
      // send-to-maintenance or snooze. Due-soon rows never gate.
      case 2: return Number(odometerIn) > 0 && !maintenanceGateBlocked(maintItems, maintDecision.status);
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
    switch (step) {
      case 0:
        if (!reservation) return 'Cargando la reservación…';
        if (!agreement) return 'No hay un acuerdo vinculado a esta reservación todavía — completa primero el check-out (Start Check-out) para generarlo.';
        return 'Faltan datos de la reservación';
      case 1:
        return 'Captura al menos 1 foto del return';
      case 2:
        // Below-checkout readings WARN inline in Step3Metrics but never block
        // (Counter-UX Item 2), so the hard requirements are > 0 plus the
        // Feature A maintenance decision when something is overdue.
        if (Number(odometerIn) > 0 && maintenanceGateBlocked(maintItems, maintDecision.status)) {
          return t('maintCheckin.gateHint');
        }
        return 'Ingresa el odómetro de regreso (mayor a 0)';
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
                checkoutPhotos={checkoutPhotos}
                checkoutAt={checkoutAt}
                damageNotes={damageNotes}
                onDamageNote={(k, text) => setDamageNotes((d) => ({ ...d, [k]: text }))}
              />
            </>
          )}
          {step === 2 && (
            <Step3Metrics
              agreement={agreement}
              odometerPrefill={odometerPrefill}
              odometerIn={odometerIn} onOdometerIn={setOdometerIn}
              fuelIn={fuelIn} onFuelIn={setFuelIn}
              cleanlinessIn={cleanlinessIn} onCleanlinessIn={setCleanlinessIn}
              smokingDetected={smokingDetected} onSmokingDetected={setSmokingDetected}
              waiveLateFee={waiveLateFee} onWaiveLateFee={setWaiveLateFee}
              canBackdate={canBackdate}
              actualReturnAt={actualReturnAt} onActualReturnAt={setActualReturnAt}
              feePreview={feePreview}
              maintItems={maintItems}
              maintDecision={maintDecision}
              maintPrevSnooze={maintPrevSnooze}
              maintUnit={reservation?.vehicle?.internalNumber || reservation?.vehicle?.plate || 'vehicle'}
              maintStampPreview={{
                who: me?.fullName || me?.name || me?.email || '—',
                res: reservation?.reservationNumber || '—',
                when: new Date().toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }),
              }}
              onMaintArm={() => setMaintDecision({ status: 'ARMED', note: null })}
              onMaintUndo={() => setMaintDecision({ status: 'PENDING', note: null })}
              onMaintSnooze={(note) => setMaintDecision({ status: 'SNOOZED', note })}
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

          {/* Counter-UX Item 3 (2026-08-31): visible damage affordance AFTER the
              photo-inspection step and before the return closes. Opens the
              existing ReportDamageWizard for THIS reservation in a modal —
              the wizard's own steps are untouched (no blocking, no reorder). */}
          {canReportDamage && step >= 2 && step <= 4 && (
            <div style={{
              marginTop: 16, padding: '12px 14px', borderRadius: 8,
              border: '0.5px solid #FCA5A5', background: 'rgba(239,68,68,.05)',
              display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap'
            }}>
              <div style={{ minWidth: 220, flex: 1 }}>
                <div style={{ fontWeight: 600, fontSize: 14, color: '#991B1B' }}>
                  ⚠ {t('checkinWizard.damageTitle')}
                </div>
                <div style={{ fontSize: 12, color: '#6B7280', marginTop: 2 }}>
                  {damageReported ? t('checkinWizard.damageRecorded') : t('checkinWizard.damageHint')}
                </div>
              </div>
              <button
                type="button"
                onClick={() => setDamageWizardOpen(true)}
                style={{
                  background: 'linear-gradient(180deg,#ff8a8a,#ef4444)', border: '1px solid #dc2626',
                  color: '#fff', borderRadius: 8, padding: '8px 14px', fontWeight: 700, cursor: 'pointer', fontSize: 13
                }}
              >
                {t('checkinWizard.damageCta')}
              </button>
            </div>
          )}

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

        {/* Counter-UX Item 3: the damage-report modal itself — the SAME wizard
            the reservation-detail page launches, reservation pre-selected. */}
        {damageWizardOpen && reservation?.id ? (
          <ReportDamageWizard
            reservation={reservation}
            token={token}
            onClose={() => setDamageWizardOpen(false)}
            onDone={async (res) => {
              setDamageReported(res || true);
              // The damage charge just landed on the contract — re-pull the
              // agreement so Step 4's "prior balance" includes it instead of
              // going stale mid-check-in.
              try {
                if (agreement?.id) {
                  const ag = await api(`/api/rental-agreements/${agreement.id}`, { bypassCache: true }, token);
                  setAgreement(ag);
                }
              } catch { /* non-fatal: backend still has the charge */ }
            }}
            onComplete={(res) => {
              // "Complete now" → the incident DRAFT lives in the reservation-
              // detail page's incident panel. Open it in a NEW tab so the
              // in-progress check-in (photos, metrics) is never thrown away.
              if (res?.incidentId) {
                setDamageReported(res);
                try { window.open(`/reservations/${reservationId}`, '_blank'); } catch { /* popup blocked — draft still listed on the detail page */ }
              }
            }}
          />
        ) : null}
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
    { number: 2, label: 'Photos', tour: 'checkin-photos' },
    { number: 3, label: 'Metrics', tour: 'checkin-metrics' },
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
          <div key={s.number} data-tour={s.tour} style={{
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
function Step2Photos({
  photos, onCapture, currentAngle, onAngleChange,
  checkoutPhotos, checkoutAt, damageNotes, onDamageNote
}) {
  const angleKey = STANDARD_ANGLES[currentAngle]?.key;
  return (
    <div style={sectionBox}>
      <PhotoCapture
        capturedPhotos={photos}
        onCapture={onCapture}
        currentAngleIndex={currentAngle}
        onAngleChange={onAngleChange}
        comparePhoto={checkoutPhotos?.[angleKey] || null}
        compareCaption={checkoutAt}
        comparePhotos={checkoutPhotos}
        damageNotes={damageNotes}
        onDamageNote={onDamageNote}
      />
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Step 3 — Metrics + LIVE FEE PREVIEW (killer feature)
// ─────────────────────────────────────────────────────────────────────────────
function Step3Metrics({
  agreement,
  odometerPrefill,
  odometerIn, onOdometerIn,
  fuelIn, onFuelIn,
  cleanlinessIn, onCleanlinessIn,
  smokingDetected, onSmokingDetected,
  waiveLateFee, onWaiveLateFee,
  canBackdate, actualReturnAt, onActualReturnAt,
  feePreview,
  maintItems, maintDecision, maintPrevSnooze, maintUnit, maintStampPreview,
  onMaintArm, onMaintUndo, onMaintSnooze
}) {
  const { t } = useTranslation();
  const odoOut = Number(agreement?.odometerOut || 0);
  const driven = Number(odometerIn) - odoOut;
  // Counter-UX Item 2: warn (never block) when the entered reading is below
  // the check-out odometer. Pure rule in lib/mileage-guard.js (unit-tested).
  const guard = mileageGuard({ entered: odometerIn, baseline: odoOut });
  const showPrefillNote = odometerPrefill != null
    && String(odometerIn || '').trim() === String(odometerPrefill);
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
        {showPrefillNote ? (
          <div style={{ fontSize: 11, color: '#6B7280', marginTop: -6 }}>
            {t('checkinWizard.mileagePrefilled')}
          </div>
        ) : null}
        {guard.warn ? (
          <div
            role="alert"
            style={{
              padding: '10px 12px', background: '#FEF3C7', border: '0.5px solid #F59E0B',
              borderRadius: 6, fontSize: 12, color: '#92400E', marginTop: -4
            }}
          >
            {t('checkinWizard.mileageWarning', {
              entered: Number(odometerIn).toLocaleString(),
              baseline: odoOut.toLocaleString()
            })}
          </div>
        ) : null}
        {/* Feature A (2026-09-01): the maintenance banner lives DIRECTLY
            under the odometer field it reacts to — cause above effect. It
            re-evaluates on every keystroke; the decision is armed here and
            fires at check-in close. */}
        <MaintenanceCheckinBanner
          items={maintItems}
          unit={maintUnit}
          typedOdometer={odometerIn ? Number(odometerIn) : null}
          decision={maintDecision}
          onArm={onMaintArm}
          onUndo={onMaintUndo}
          onSnooze={onMaintSnooze}
          stampPreview={maintStampPreview}
          prevSnooze={maintPrevSnooze}
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
  // Feature A: the close's maintenance outcome. FAILED keeps a retry that
  // re-attempts the RO-open (the check-in itself already completed — money
  // first; the car just needs its manual push into the maintenance pool).
  const [maint, setMaint] = useState(result?.maintenance || null);
  const [maintRetrying, setMaintRetrying] = useState(false);
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
  const { t } = useTranslation();
  const unit = reservation?.vehicle?.internalNumber || reservation?.vehicle?.plate || 'vehicle';
  const handleMaintRetry = async () => {
    if (!maint?.decisionId || maintRetrying) return;
    setMaintRetrying(true);
    try {
      const out = await api(`/api/maintenance/checkin-decisions/${maint.decisionId}/retry`, {
        method: 'POST',
        body: JSON.stringify({})
      }, token);
      setMaint({ ...maint, ...out });
    } catch (err) {
      setMaint({ ...maint, status: 'FAILED', error: err?.message || 'Retry failed' });
    } finally {
      setMaintRetrying(false);
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
        {/* Feature A — pool hand-off / snooze / failure strip (mockup state 3) */}
        {maint?.status === 'SENT' && (
          <div data-testid="maint-success-sent" style={{
            ...sectionBox, background: 'rgba(239,68,68,.05)', border: '0.5px solid #FCA5A5',
          }}>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 6 }}>
              <span style={{ ...pillBase, background: '#F3F4F6', color: '#9CA3AF', textDecoration: 'line-through' }}>Rentable</span>
              <span aria-hidden="true" style={{ color: '#9CA3AF' }}>→</span>
              <span style={{ ...pillBase, background: '#FEE2E2', color: '#991B1B' }}>{t('maintCheckin.poolMaintenance')}</span>
            </div>
            <div style={{ fontSize: 13, color: '#374151' }}>
              {t('maintCheckin.success.handoff', { unit, ro: maint.roLabel || maint.repairOrderId || 'RO' })}
            </div>
            <a href="/maintenance" style={{ display: 'inline-block', marginTop: 6, fontSize: 12, fontWeight: 600, color: '#991B1B', textDecoration: 'underline' }}>
              {t('maintCheckin.success.openRo', { ro: maint.roLabel || 'RO' })}
            </a>
          </div>
        )}
        {maint?.status === 'SNOOZED' && (
          <div data-testid="maint-success-snoozed" style={{ ...sectionBox }}>
            <div style={{ fontSize: 13, color: '#374151' }}>
              😴 {t('maintCheckin.success.snoozed', { unit })}
            </div>
          </div>
        )}
        {maint?.status === 'FAILED' && (
          <div data-testid="maint-success-failed" style={{
            ...sectionBox, background: 'rgba(245,158,11,.08)', border: '0.5px solid rgba(245,158,11,.4)',
          }}>
            <div style={{ fontSize: 13, fontWeight: 600, color: '#92400E' }}>
              ⚠ {t('maintCheckin.success.failed', { unit })}
            </div>
            {maint?.error ? (
              <div style={{ fontSize: 11, color: '#92400E', opacity: 0.85, marginTop: 4 }}>{maint.error}</div>
            ) : null}
            <div style={{ display: 'flex', gap: 10, marginTop: 8, alignItems: 'center' }}>
              {maint?.decisionId ? (
                <button type="button" onClick={handleMaintRetry} disabled={maintRetrying} style={{
                  padding: '6px 12px', background: '#92400E', color: '#fff', border: 'none',
                  borderRadius: 6, fontSize: 12, fontWeight: 600, cursor: maintRetrying ? 'wait' : 'pointer',
                }}>
                  {maintRetrying ? '…' : t('maintCheckin.success.retry')}
                </button>
              ) : null}
              <a href="/maintenance" style={{ fontSize: 12, fontWeight: 600, color: '#92400E', textDecoration: 'underline' }}>
                {t('maintCheckin.success.openManually')}
              </a>
            </div>
          </div>
        )}
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
