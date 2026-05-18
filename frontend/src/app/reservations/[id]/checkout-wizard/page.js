'use client';

/**
 * Pillar 2 — Checkout wizard (vehicle handoff to customer).
 *
 * 6 steps:
 *   1. Vehicle & customer confirm
 *   2. Exterior inspection (8 photos · AR-guided)
 *   3. Pickup metrics (odometer · fuel · cleanliness)
 *   4. Balance gate (collect deposit/remainder if applicable)
 *   5. Customer signature
 *   6. Handoff success · keys delivered
 *
 * No fee engine here — fees are checkin-only. This wizard's job is to
 * capture the baseline state cleanly so checkin can compute deltas.
 *
 * Mockups reference: design/mockups/pillar2-checkin-checkout/index.html
 */

import { useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { AuthGate } from '../../../../components/AuthGate';
import { AppShell } from '../../../../components/AppShell';
import { api } from '../../../../lib/client';
import { WizardShell, WizCard, WizGrid } from '../../../../components/wizard/WizardShell';
import { OdometerInput, FuelLevelInput, CleanlinessInput } from '../../../../components/wizard/MetricInputs';
import { PhotoCapture, STANDARD_ANGLES } from '../../../../components/wizard/PhotoCapture';
import { SignaturePad } from '../../../../components/wizard/SignaturePad';

export default function Page() {
  return <AuthGate>{({ token, me, logout }) => <CheckoutWizard token={token} me={me} logout={logout} />}</AuthGate>;
}

function CheckoutWizard({ token, me, logout }) {
  const { id: reservationId } = useParams();
  const router = useRouter();
  const [step, setStep] = useState(0);
  const [loading, setLoading] = useState(true);
  const [reservation, setReservation] = useState(null);
  const [agreement, setAgreement] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState('');

  const [odometerOut, setOdometerOut] = useState('');
  const [fuelOut, setFuelOut] = useState(1);
  const [cleanlinessOut, setCleanlinessOut] = useState(5);
  const [photos, setPhotos] = useState({});
  const [currentAngle, setCurrentAngle] = useState(0);
  const [paymentTaken, setPaymentTaken] = useState({ amount: '', method: 'card', last4: '', reference: '' });
  const [paymentSkipped, setPaymentSkipped] = useState(false);
  const [signerName, setSignerName] = useState('');
  const [signatureDataUrl, setSignatureDataUrl] = useState('');

  // Load reservation + agreement
  useEffect(() => {
    if (!reservationId) return;
    (async () => {
      try {
        const res = await api(`/api/reservations/${reservationId}`, {}, token);
        setReservation(res);
        // Ensure an agreement exists (creates DRAFT if needed)
        const ag = res?.rentalAgreement?.id
          ? await api(`/api/rental-agreements/${res.rentalAgreement.id}`, {}, token)
          : await api(`/api/reservations/${reservationId}/agreement`, {}, token);
        setAgreement(ag);
        setSignerName([res?.customer?.firstName, res?.customer?.lastName].filter(Boolean).join(' '));
      } catch (err) {
        console.error('Failed to load reservation', err);
      } finally {
        setLoading(false);
      }
    })();
  }, [reservationId, token]);

  // Balance — agreement.balance comes back as string "0" on fresh agreements
  // even when charges exist. Compute from agreement.charges array (sum of
  // line items) minus agreement.payments (sum of PAID amounts).
  // Fallback: same computation on reservation if its arrays exist instead.
  const agreementChargesSum = Array.isArray(agreement?.charges)
    ? agreement.charges
        .filter((c) => c?.selected !== false)
        .reduce((s, c) => s + Number(c?.total || c?.amount || 0), 0)
    : 0;
  const agreementPaymentsSum = Array.isArray(agreement?.payments)
    ? agreement.payments
        .filter((p) => String(p?.status || '').toUpperCase() === 'PAID')
        .reduce((s, p) => s + Number(p?.amount || 0), 0)
    : 0;
  const agreementComputedBalance = Math.max(0, agreementChargesSum - agreementPaymentsSum);

  const reservationChargesSum = Array.isArray(reservation?.charges)
    ? reservation.charges.reduce((s, c) => s + Number(c?.total || c?.amount || 0), 0)
    : 0;
  const reservationPaymentsSum = Array.isArray(reservation?.payments)
    ? reservation.payments
        .filter((p) => String(p?.status || '').toUpperCase() === 'PAID')
        .reduce((s, p) => s + Number(p?.amount || 0), 0)
    : 0;
  const reservationComputedBalance = Math.max(0, reservationChargesSum - reservationPaymentsSum);

  const balanceDue = Math.max(
    Number(agreement?.balance || 0),
    Number(reservation?.balance || 0),
    Number(reservation?.amountDue || 0),
    Number(reservation?.amountOwed || 0),
    Number(reservation?.unpaidBalance || 0),
    agreementComputedBalance,
    reservationComputedBalance
  );

  // Debug v2: dump full reservation + agreement keys to discover where
  // the balance/charges actually live.
  useEffect(() => {
    if (reservation && agreement) {
      const chargesSum = Array.isArray(reservation?.charges)
        ? reservation.charges.reduce((s, c) => s + Number(c?.total || c?.amount || 0), 0)
        : null;
      const paymentsSum = Array.isArray(reservation?.payments)
        ? reservation.payments
            .filter((p) => String(p?.status || '').toUpperCase() === 'PAID')
            .reduce((s, p) => s + Number(p?.amount || 0), 0)
        : null;
      // eslint-disable-next-line no-console
      console.log('[checkout-wizard] balance debug v3', {
        agreementBalance: agreement?.balance,
        agreementTotal: agreement?.total,
        agreementPaidAmount: agreement?.paidAmount,
        agreementChargesLength: Array.isArray(agreement?.charges) ? agreement.charges.length : 'not-array',
        agreementPaymentsLength: Array.isArray(agreement?.payments) ? agreement.payments.length : 'not-array',
        agreementChargesSum,
        agreementPaymentsSum,
        agreementComputedBalance,
        firstAgreementCharge: agreement?.charges?.[0],
        firstAgreementPayment: agreement?.payments?.[0],
        computedBalanceDue: balanceDue
      });
    }
  }, [reservation?.id, agreement?.id]);

  const needsPayment = balanceDue > 0 && !paymentSkipped && !(Number(paymentTaken.amount) >= balanceDue);

  // Vehicle assignment state — if reservation has no vehicle, staff picks here
  const [vehicleId, setVehicleId] = useState('');
  const [availableVehicles, setAvailableVehicles] = useState([]);
  const [loadingVehicles, setLoadingVehicles] = useState(false);

  // Sync vehicleId from reservation/agreement when they load
  useEffect(() => {
    setVehicleId(reservation?.vehicleId || agreement?.vehicleId || '');
  }, [reservation?.vehicleId, agreement?.vehicleId]);

  // Load available vehicles when no vehicle is yet assigned
  useEffect(() => {
    if (vehicleId || !reservation) return;
    let cancelled = false;
    (async () => {
      setLoadingVehicles(true);
      try {
        const res = await api('/api/vehicles?status=AVAILABLE', {}, token);
        const list = Array.isArray(res?.data) ? res.data : (Array.isArray(res) ? res : []);
        if (!cancelled) setAvailableVehicles(list);
      } catch (err) {
        console.warn('Failed to load vehicles', err);
      } finally {
        if (!cancelled) setLoadingVehicles(false);
      }
    })();
    return () => { cancelled = true; };
  }, [reservation, vehicleId, token]);

  const submit = async () => {
    if (!agreement?.id) {
      setSubmitError('No agreement linked');
      return;
    }
    setSubmitting(true);
    setSubmitError('');
    try {
      // Save inspection (CHECKOUT phase)
      await api(`/api/rental-agreements/${agreement.id}/inspection`, {
        method: 'POST',
        body: JSON.stringify({
          phase: 'CHECKOUT',
          odometer: odometerOut ? Number(odometerOut) : null,
          fuelLevel: String(fuelOut),
          cleanlinessOut: String(cleanlinessOut),
          photos
        })
      }, token);

      // Update agreement with checkout metrics + vehicleId (in case the
      // staff picked the vehicle in step 1 — reservation may have been
      // created without one)
      await api(`/api/rental-agreements/${agreement.id}/rental`, {
        method: 'PUT',
        body: JSON.stringify({
          vehicleId: vehicleId || undefined,
          odometerOut: odometerOut ? Number(odometerOut) : null,
          fuelOut,
          cleanlinessOut
        })
      }, token);

      // Manual payment if taken — surface failures so staff knows
      if (Number(paymentTaken.amount) > 0) {
        const ref = [paymentTaken.last4 && `****${paymentTaken.last4}`, paymentTaken.reference]
          .filter(Boolean).join(' · ') || '';
        try {
          await api(`/api/rental-agreements/${agreement.id}/payments/manual`, {
            method: 'POST',
            body: JSON.stringify({
              entryType: 'CHARGE',
              amount: Number(paymentTaken.amount),
              method: paymentTaken.method.toUpperCase(),
              reference: ref
            })
          }, token);
        } catch (payErr) {
          throw new Error('Payment failed: ' + (payErr.message || 'unknown error'));
        }
      }

      // Signature
      if (signatureDataUrl && signerName) {
        await api(`/api/rental-agreements/${agreement.id}/signature`, {
          method: 'POST',
          body: JSON.stringify({ signerName, signatureDataUrl })
        }, token);
      }

      // Finalize the agreement — transitions reservation to CHECKED_OUT,
      // locks the agreement, and runs validation on charges + payments.
      await api(`/api/rental-agreements/${agreement.id}/finalize`, {
        method: 'POST',
        body: JSON.stringify({})
      }, token);

      setStep(5);
    } catch (err) {
      setSubmitError(err.message || 'Checkout failed');
    } finally {
      setSubmitting(false);
    }
  };

  const steps = [
    'Confirm vehicle & customer',
    'Capture exterior inspection',
    'Capture pickup metrics',
    'Collect outstanding balance',
    'Customer signature',
    'Keys delivered'
  ];

  const canAdvance = () => {
    switch (step) {
      case 0: return !!reservation && !!agreement && !!vehicleId;
      case 1: return Object.keys(photos).length >= 1;
      case 2: return Number(odometerOut) > 0;
      case 3: return balanceDue === 0 || paymentSkipped || Number(paymentTaken.amount) >= balanceDue;
      case 4: return !!signerName && !!signatureDataUrl;
      default: return true;
    }
  };

  const onNext = () => {
    if (step === 4) return submit();
    if (step === 3 && balanceDue === 0) {
      setStep(4);
      return;
    }
    setStep((s) => Math.min(s + 1, steps.length - 1));
  };

  if (loading) {
    return <AppShell me={me} logout={logout}>
      <div style={{ padding: 60, textAlign: 'center', color: '#6f668f' }}>Loading reservation…</div>
    </AppShell>;
  }
  if (!reservation) {
    return <AppShell me={me} logout={logout}>
      <div style={{ padding: 60, textAlign: 'center', color: '#ef4444' }}>Reservation not found</div>
    </AppShell>;
  }

  return (
    <AppShell me={me} logout={logout}>
      <WizardShell
        title="Checkout"
        stepIndex={step}
        totalSteps={6}
        stepTitle={steps[step]}
        accent="purple"
        onBack={step > 0 && step < 5 ? () => setStep((s) => s - 1) : null}
        onNext={onNext}
        nextLabel={submitting ? 'Submitting…' : step === 4 ? 'Confirm & deliver →' : step === 5 ? 'Return to reservations' : 'Continue →'}
        nextDisabled={!canAdvance() || submitting}
        ghostAction={step === 3 && needsPayment ? { label: 'Manager skip', onClick: () => setPaymentSkipped(true) } : null}
      >
        {step === 0 && (
          <Step1Confirm
            reservation={reservation}
            agreement={agreement}
            balanceDue={balanceDue}
            vehicleId={vehicleId}
            onVehicleChange={setVehicleId}
            availableVehicles={availableVehicles}
            loadingVehicles={loadingVehicles}
          />
        )}
        {step === 1 && (
          <WizCard padding={20}>
            <PhotoCapture
              capturedPhotos={photos}
              onCapture={(k, d) => setPhotos((p) => ({ ...p, [k]: d }))}
              currentAngleIndex={currentAngle}
              onAngleChange={setCurrentAngle}
            />
          </WizCard>
        )}
        {step === 2 && (
          <WizGrid cols={3} gap={14}>
            <OdometerInput value={odometerOut} onChange={setOdometerOut} allowOcr label="Odometer Out" />
            <FuelLevelInput value={fuelOut} onChange={setFuelOut} label="Fuel Out" />
            <CleanlinessInput value={cleanlinessOut} onChange={setCleanlinessOut} label="Cleanliness Out" />
          </WizGrid>
        )}
        {step === 3 && (
          <Step4Balance
            agreement={agreement}
            balanceDue={balanceDue}
            paymentTaken={paymentTaken}
            onPaymentChange={setPaymentTaken}
            paymentSkipped={paymentSkipped}
          />
        )}
        {step === 4 && (
          <Step5Signature
            agreement={agreement}
            signerName={signerName}
            onSignerName={setSignerName}
            signatureDataUrl={signatureDataUrl}
            onSignature={setSignatureDataUrl}
            error={submitError}
          />
        )}
        {step === 5 && <Step6Handoff reservation={reservation} agreement={agreement} token={token} onDone={() => router.push('/reservations')} />}
      </WizardShell>
    </AppShell>
  );
}

function Step1Confirm({ reservation, agreement, balanceDue, vehicleId, onVehicleChange, availableVehicles, loadingVehicles }) {
  // Read vehicle from explicit selection > reservation > agreement
  const vSelected = availableVehicles.find((x) => x.id === vehicleId);
  const v = vSelected || reservation?.vehicle || agreement?.vehicle;
  const vehicleDesc = v ? [v.year, v.make, v.model].filter(Boolean).join(' ') : null;
  const hasVehicle = !!vehicleDesc;
  return (
    <WizGrid cols={2}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        {hasVehicle ? (
          <WizCard accent="ink" padding={22}>
            <div style={{ fontSize: 12, opacity: .85, fontWeight: 700, letterSpacing: '.12em' }}>VEHICLE ASSIGNED</div>
            <div style={{ fontSize: 24, fontWeight: 800, marginTop: 6, letterSpacing: '-.01em' }}>{vehicleDesc}</div>
            <div style={{ fontSize: 13, opacity: .9, marginTop: 4 }}>⬢ Plate {v?.plate || '—'} · Unit {v?.internalNumber || '—'} · {v?.color || ''}</div>
            <div style={{ display: 'flex', gap: 8, marginTop: 16, flexWrap: 'wrap' }}>
              <span style={{ background: 'rgba(255,255,255,.16)', padding: '6px 12px', borderRadius: 999, fontSize: 11, fontWeight: 700 }}>⛽ Inspection ready</span>
              <span style={{ background: 'rgba(255,255,255,.16)', padding: '6px 12px', borderRadius: 999, fontSize: 11, fontWeight: 700 }}>Agreement {agreement?.agreementNumber || 'DRAFT'}</span>
            </div>
          </WizCard>
        ) : (
          <WizCard accent="warn" padding={22}>
            <div style={{ fontSize: 11, fontWeight: 800, color: '#b45309', letterSpacing: '.12em', marginBottom: 8 }}>NO VEHICLE ASSIGNED</div>
            <div style={{ fontSize: 14, color: '#211a38', marginBottom: 12 }}>
              Pick a vehicle from your available inventory to continue with checkout.
            </div>
            <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <span style={{ fontSize: 10, fontWeight: 800, color: '#6f668f', letterSpacing: '.1em' }}>SELECT VEHICLE</span>
              <select
                value={vehicleId}
                onChange={(e) => onVehicleChange(e.target.value)}
                style={{
                  padding: '12px 14px',
                  border: '1px solid #e6dfff',
                  borderRadius: 12,
                  fontSize: 14,
                  fontWeight: 700,
                  color: '#211a38',
                  background: 'white',
                  outline: 'none'
                }}
              >
                <option value="">{loadingVehicles ? 'Loading…' : '— Choose a vehicle —'}</option>
                {availableVehicles.map((veh) => (
                  <option key={veh.id} value={veh.id}>
                    {[veh.year, veh.make, veh.model].filter(Boolean).join(' ')}
                    {veh.plate ? ` · ${veh.plate}` : ''}
                    {veh.internalNumber ? ` · Unit ${veh.internalNumber}` : ''}
                  </option>
                ))}
              </select>
            </label>
          </WizCard>
        )}
        <WizGrid cols={2} gap={10}>
          <Tile k="Customer" v={`${reservation?.customer?.firstName || ''} ${reservation?.customer?.lastName || ''}`.trim() || '—'} />
          <Tile k="Days" v={`${rentalDays(reservation)} days`} />
          <Tile k="Pickup" v={new Date(reservation?.pickupAt).toLocaleString()} />
          <Tile k="Return" v={new Date(reservation?.returnAt).toLocaleString()} />
        </WizGrid>
      </div>
      <WizCard>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12 }}>
          <div style={{
            width: 44, height: 44, borderRadius: '50%',
            background: 'linear-gradient(135deg, #8752FE, #1fc7aa)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            color: 'white', fontWeight: 800, fontSize: 16
          }}>{(reservation?.customer?.firstName?.[0] || '?') + (reservation?.customer?.lastName?.[0] || '')}</div>
          <div>
            <div style={{ fontSize: 14, fontWeight: 800, color: '#211a38' }}>{reservation?.customer?.firstName} {reservation?.customer?.lastName}</div>
            <div style={{ fontSize: 11, color: '#6f668f' }}>License {reservation?.customer?.licenseState || ''} · {reservation?.customer?.licenseNumber ? '••••' + reservation.customer.licenseNumber.slice(-4) : 'no license on file'}</div>
          </div>
        </div>
        <hr style={{ border: 'none', borderTop: '1px solid #e6dfff', margin: '12px 0' }} />
        <RowBetween k="Email" v={reservation?.customer?.email || '—'} />
        <RowBetween k="Phone" v={reservation?.customer?.phone || '—'} />
        <RowBetween k="Card on file" v={
          reservation?.customer?.cardLast4
            ? `${reservation.customer.cardBrand || 'Card'} ····${reservation.customer.cardLast4}`
            : 'None'
        } />
        <RowBetween k="Balance" v={`$${balanceDue.toFixed(2)}`} valueColor={balanceDue > 0 ? '#f59e0b' : '#1fc7aa'} />
      </WizCard>
    </WizGrid>
  );
}

function Step4Balance({ agreement, balanceDue, paymentTaken, onPaymentChange, paymentSkipped }) {
  if (balanceDue === 0) {
    return (
      <WizCard accent="mint" padding={28}>
        <div style={{ textAlign: 'center' }}>
          <div style={{
            width: 60, height: 60, borderRadius: '50%',
            background: '#1fc7aa', color: 'white',
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
            fontSize: 28, fontWeight: 800, marginBottom: 12
          }}>✓</div>
          <div style={{ fontSize: 22, fontWeight: 800, color: '#211a38' }}>Balance is $0.00</div>
          <div style={{ fontSize: 13, color: '#6f668f', marginTop: 6 }}>Reservation fully paid at booking · proceed to signature</div>
        </div>
      </WizCard>
    );
  }
  return (
    <WizGrid cols={2}>
      <WizCard accent="ink" padding={22}>
        <div style={{ fontSize: 11, opacity: .7, fontWeight: 700, letterSpacing: '.1em' }}>BALANCE DUE</div>
        <div style={{ fontSize: 36, fontWeight: 800, letterSpacing: '-.02em', marginTop: 4 }}>${balanceDue.toFixed(2)}</div>
        <div style={{ fontSize: 11, opacity: .65, marginTop: 4 }}>Outstanding from booking</div>
        {paymentSkipped && (
          <div style={{ marginTop: 16, padding: '8px 12px', background: 'rgba(245,158,11,.18)', borderRadius: 8, fontSize: 11, fontWeight: 700 }}>
            ⚠ Manager skip used · this balance will need to be collected later
          </div>
        )}
      </WizCard>
      <WizCard>
        <div style={{ fontSize: 11, fontWeight: 800, color: '#6f668f', letterSpacing: '.1em', marginBottom: 12 }}>PAYMENT METHOD</div>
        <div style={{ display: 'flex', gap: 6, marginBottom: 12 }}>
          {[
            { id: 'card', label: 'Card', icon: '💳' },
            { id: 'cash', label: 'Cash', icon: '💵' },
            { id: 'check', label: 'Check', icon: '📄' }
          ].map((m) => (
            <button
              key={m.id}
              type="button"
              onClick={() => onPaymentChange({ ...paymentTaken, method: m.id })}
              style={{
                flex: 1, padding: '12px 8px',
                background: paymentTaken.method === m.id ? 'linear-gradient(135deg, #8752FE, #6d3df2)' : 'white',
                color: paymentTaken.method === m.id ? 'white' : '#6f668f',
                border: paymentTaken.method === m.id ? 'none' : '1px solid #e6dfff',
                borderRadius: 12, fontSize: 12, fontWeight: 700, cursor: 'pointer'
              }}
            >
              <div style={{ fontSize: 18, marginBottom: 4 }}>{m.icon}</div>{m.label}
            </button>
          ))}
        </div>
        <Field label="Amount" type="number" value={paymentTaken.amount} onChange={(v) => onPaymentChange({ ...paymentTaken, amount: v })} placeholder={balanceDue.toFixed(2)} />
        {paymentTaken.method === 'card' && (
          <Field label="Last 4 digits" value={paymentTaken.last4} onChange={(v) => onPaymentChange({ ...paymentTaken, last4: v.replace(/\D/g, '').slice(0, 4) })} placeholder="4242" />
        )}
        <Field label="Reference / Auth #" value={paymentTaken.reference} onChange={(v) => onPaymentChange({ ...paymentTaken, reference: v })} placeholder="Optional" />
      </WizCard>
    </WizGrid>
  );
}

function Step5Signature({ agreement, signerName, onSignerName, signatureDataUrl, onSignature, error }) {
  return (
    <WizGrid cols={2}>
      <WizCard>
        <div style={{ fontSize: 11, fontWeight: 800, color: '#6f668f', letterSpacing: '.1em', marginBottom: 10 }}>AGREEMENT SUMMARY</div>
        <div style={{ fontSize: 16, fontWeight: 800, color: '#211a38' }}>{agreement?.agreementNumber || 'DRAFT'}</div>
        <hr style={{ border: 'none', borderTop: '1px solid #e6dfff', margin: '12px 0' }} />
        <RowBetween k="Total" v={`$${Number(agreement?.total || 0).toFixed(2)}`} />
        <RowBetween k="Paid" v={`$${Number(agreement?.paidAmount || 0).toFixed(2)}`} valueColor="#1fc7aa" />
        <RowBetween k="Balance" v={`$${Number(agreement?.balance || 0).toFixed(2)}`} valueColor={Number(agreement?.balance) > 0 ? '#f59e0b' : '#1fc7aa'} />
        <div style={{ marginTop: 14, padding: 12, background: 'linear-gradient(135deg, rgba(245,158,11,.08), rgba(245,158,11,.02))', border: '1px solid rgba(245,158,11,.24)', borderRadius: 10 }}>
          <div style={{ fontSize: 11, fontWeight: 800, color: '#b45309', letterSpacing: '.08em' }}>POST-RENTAL CHARGES</div>
          <div style={{ fontSize: 12, color: '#211a38', marginTop: 4, lineHeight: 1.5 }}>
            I authorize charges to the card on file for: excess mileage · fuel · cleaning · smoking · damage.
          </div>
        </div>
      </WizCard>
      <div>
        <SignaturePad
          height={200}
          label="Customer Signature"
          signerName={signerName}
          onSignerNameChange={onSignerName}
          onSignatureChange={onSignature}
          helperText="By signing, you accept the rental terms and authorize the post-rental charge categories listed."
        />
        {error && (
          <div style={{ marginTop: 12, padding: '10px 14px', background: 'rgba(239,68,68,.08)', border: '1px solid rgba(239,68,68,.24)', borderRadius: 10, color: '#b91c1c', fontSize: 13, fontWeight: 700 }}>⚠ {error}</div>
        )}
      </div>
    </WizGrid>
  );
}

function Step6Handoff({ reservation, agreement, token, onDone }) {
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
      <div style={{
        minHeight: 240, borderRadius: 18,
        background: 'linear-gradient(135deg, #1fc7aa 0%, #16a589 100%)',
        color: 'white', padding: 36,
        display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
        position: 'relative', overflow: 'hidden'
      }}>
        <div style={{
          width: 80, height: 80, borderRadius: '50%',
          background: 'rgba(255,255,255,.95)', color: '#1fc7aa',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontSize: 40, fontWeight: 800, boxShadow: '0 8px 24px rgba(0,0,0,.16)'
        }}>✓</div>
        <div style={{ fontSize: 22, fontWeight: 800, marginTop: 14, letterSpacing: '-.005em' }}>All set, {reservation?.customer?.firstName || 'Customer'}</div>
        <div style={{ fontSize: 12, opacity: .85, marginTop: 6 }}>Returns {new Date(agreement?.returnAt || reservation?.returnAt).toLocaleString()}</div>
        <div style={{ display: 'flex', gap: 8, marginTop: 18, flexWrap: 'wrap', justifyContent: 'center' }}>
          <span style={{ background: 'rgba(255,255,255,.22)', padding: '6px 14px', borderRadius: 999, fontSize: 11, fontWeight: 700 }}>📧 Agreement emailed</span>
          <span style={{ background: 'rgba(255,255,255,.22)', padding: '6px 14px', borderRadius: 999, fontSize: 11, fontWeight: 700 }}>🔑 Keys handed off</span>
        </div>
      </div>
      <WizCard>
        <div style={{ fontSize: 11, fontWeight: 800, color: '#6f668f', letterSpacing: '.1em', marginBottom: 10 }}>NEXT</div>
        <ActionLink
          label={`View agreement ${agreement?.agreementNumber || ''}`}
          onClick={() => agreement?.id && (window.location.href = `/agreements/${agreement.id}`)}
        />
        <ActionLink
          label="View inspection photos"
          onClick={() => reservation?.id && (window.location.href = `/reservations/${reservation.id}/inspection-report`)}
        />
        <ActionLink label="Print agreement" onClick={() => agreement?.id && window.open(`/agreements/${agreement.id}`, '_blank')} />
        <ActionLink
          label={emailing ? 'Sending…' : (emailMsg || 'Re-send agreement email')}
          onClick={handleResendEmail}
        />
      </WizCard>
    </WizGrid>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Small helpers (mirror checkin-wizard versions)
// ─────────────────────────────────────────────────────────────────────────────

function rentalDays(reservation) {
  if (!reservation?.pickupAt || !reservation?.returnAt) return 1;
  const ms = new Date(reservation.returnAt) - new Date(reservation.pickupAt);
  return Math.max(1, Math.ceil(ms / (24 * 60 * 60 * 1000)));
}

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
        display: 'flex', justifyContent: 'space-between', width: '100%',
        padding: '8px 0', background: 'transparent', border: 'none',
        fontSize: 12, color: '#6f668f', cursor: 'pointer', textAlign: 'left'
      }}
    >
      <span>{label}</span>
      <span style={{ fontWeight: 700, color: variant === 'danger' ? '#ef4444' : '#6d3df2' }}>→</span>
    </button>
  );
}

function Field({ label, value, onChange, type = 'text', placeholder = '' }) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 8 }}>
      <span style={{ fontSize: 10, fontWeight: 800, color: '#6f668f', letterSpacing: '.1em' }}>{label.toUpperCase()}</span>
      <input
        type={type}
        value={value || ''}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        style={{ padding: '10px 14px', border: '1px solid #e6dfff', borderRadius: 12, fontSize: 14, fontWeight: 700, color: '#211a38', outline: 'none', background: 'white' }}
      />
    </label>
  );
}
