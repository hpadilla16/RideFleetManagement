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

import { useEffect, useMemo, useState } from 'react';
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
  const [pricing, setPricing] = useState(null);
  const [paymentRows, setPaymentRows] = useState([]);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState('');

  const [odometerOut, setOdometerOut] = useState('');
  const [fuelOut, setFuelOut] = useState(1);
  const [cleanlinessOut, setCleanlinessOut] = useState(5);
  const [photos, setPhotos] = useState({});
  const [currentAngle, setCurrentAngle] = useState(0);
  const [signerName, setSignerName] = useState('');
  const [signatureDataUrl, setSignatureDataUrl] = useState('');

  // Load reservation + agreement + pricing in parallel — mirrors the
  // reservation-detail page's parallel fetch pattern. All three endpoints
  // are independent of each other and read-only at load time.
  // - reservation: source of truth for status, vehicle, customer
  // - agreement: read via GET /reservations/:id/agreement which calls
  //   startFromReservation and SYNCS charges from reservation pricing to
  //   agreement. Without this, finalize() rejects with "At least one
  //   selected charge required".
  // - pricing: source of truth for the charges array shown in Step 4 review
  useEffect(() => {
    if (!reservationId) return;
    (async () => {
      try {
        const [resR, agR, pricingR, paymentsR] = await Promise.allSettled([
          api(`/api/reservations/${reservationId}`, {}, token),
          api(`/api/reservations/${reservationId}/agreement`, {}, token),
          api(`/api/reservations/${reservationId}/pricing`, { bypassCache: true }, token),
          api(`/api/reservations/${reservationId}/payments`, { bypassCache: true }, token)
        ]);
        if (resR.status === 'fulfilled') {
          setReservation(resR.value);
          setSignerName([resR.value?.customer?.firstName, resR.value?.customer?.lastName].filter(Boolean).join(' '));
        }
        if (agR.status === 'fulfilled') setAgreement(agR.value);
        if (pricingR.status === 'fulfilled') setPricing(pricingR.value);
        if (paymentsR.status === 'fulfilled') setPaymentRows(Array.isArray(paymentsR.value) ? paymentsR.value : []);
      } catch (err) {
        console.error('Failed to load wizard data', err);
      } finally {
        setLoading(false);
      }
    })();
  }, [reservationId, token]);

  // Balance management is now handled by the reservation-detail page.
  // The wizard validates server-side at submit time: if the reservation has
  // an outstanding balance, finalize() will refuse and we surface the error
  // so the agent goes back to the reservation page to collect payment first.

  // Vehicle assignment state — if reservation has no vehicle, staff picks here
  const [vehicleId, setVehicleId] = useState('');
  const [availableVehicles, setAvailableVehicles] = useState([]);
  const [loadingVehicles, setLoadingVehicles] = useState(false);

  // Sync vehicleId from reservation/agreement when they load
  useEffect(() => {
    setVehicleId(reservation?.vehicleId || agreement?.vehicleId || '');
  }, [reservation?.vehicleId, agreement?.vehicleId]);

  // Auto-populate odometerOut from the assigned vehicle's last recorded
  // mileage (updated by the check-in flow on every return). This saves
  // staff from typing the number off the dashboard and avoids fat-finger
  // errors that would trigger phantom mileage fees at the next return.
  // Only fills when the field is empty so a staff override is preserved.
  useEffect(() => {
    if (!vehicleId) return;
    if (odometerOut !== '' && odometerOut !== 0 && odometerOut != null) return;
    const fromAvailable = availableVehicles.find((x) => x.id === vehicleId);
    const v = fromAvailable || reservation?.vehicle || agreement?.vehicle;
    const m = v?.mileage;
    if (m != null && Number(m) >= 0) {
      setOdometerOut(String(m));
    }
  }, [vehicleId, availableVehicles, reservation?.vehicle, agreement?.vehicle, odometerOut]);

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

  // Pillar 2 wizards (2026-05-19) — submit sequence mirrors legacy
  // /reservations/[id]/checkout/page.js EXACTLY. Same calls, same order.
  // The only addition is the inspection POST between start-rental and rental
  // (the legacy flow expects inspections to be captured on a separate page
  // first; the wizard inlines that step).
  //
  // Order is load-bearing — DO NOT REORDER without updating the audit doc:
  // 1. PATCH reservation         — vehicle + franchise + notes onto reservation row
  // 2. POST start-rental         — creates/syncs agreement WITH selected charges
  // 3. POST inspection           — wizard-specific: photos + metrics before finalize
  // 4. PUT rental                — agreement odometer/fuel/cleanliness/vehicleId
  // 5. POST signature            — writes signerName + signatureDataUrl on reservation
  // 6. POST finalize             — transitions reservation to CHECKED_OUT
  // 7. POST email-agreement      — fire-and-forget PDF email
  const submit = async () => {
    setSubmitting(true);
    setSubmitError('');
    try {
      // Build checkout audit note line for the reservation
      const checkoutLine = `[RES_CHECKOUT ${new Date().toISOString()}] odometerOut=${Number(odometerOut || 0)} fuelOut=${Number(fuelOut || 0)} cleanlinessOut=${Number(cleanlinessOut || 5)}`;
      const baseNotes = String(reservation?.notes || '').trim();
      const nextNotes = `${baseNotes}${baseNotes ? '\n' : ''}${checkoutLine}`;

      // 1. PATCH reservation with vehicleId + notes
      await api(`/api/reservations/${reservationId}`, {
        method: 'PATCH',
        body: JSON.stringify({
          vehicleId,
          franchiseId: reservation?.franchiseId || null,
          notes: nextNotes
        })
      }, token);

      // 2. POST start-rental → returns agreement (creates or syncs charges)
      const startRentalRes = await api(`/api/reservations/${reservationId}/start-rental`, {
        method: 'POST',
        body: JSON.stringify({})
      }, token);
      const agreementId = startRentalRes?.id;
      if (!agreementId) throw new Error('No rental agreement available for checkout');

      // 3. POST inspection (CHECKOUT phase) — wizard's photos + metrics
      await api(`/api/rental-agreements/${agreementId}/inspection`, {
        method: 'POST',
        body: JSON.stringify({
          phase: 'CHECKOUT',
          odometer: odometerOut ? Number(odometerOut) : null,
          fuelLevel: String(fuelOut),
          cleanliness: String(cleanlinessOut),
          photos
        })
      }, token);

      // 4. PUT rental — agreement-level checkout metrics
      await api(`/api/rental-agreements/${agreementId}/rental`, {
        method: 'PUT',
        body: JSON.stringify({
          vehicleId,
          odometerOut: Number(odometerOut || 0),
          fuelOut: Number(fuelOut || 0),
          cleanlinessOut: Number(cleanlinessOut || 5)
        })
      }, token);

      // 5. POST signature
      await api(`/api/rental-agreements/${agreementId}/signature`, {
        method: 'POST',
        body: JSON.stringify({ signerName, signatureDataUrl })
      }, token);

      // 6. POST finalize → transitions reservation to CHECKED_OUT
      await api(`/api/rental-agreements/${agreementId}/finalize`, {
        method: 'POST',
        body: JSON.stringify({
          odometerOut: Number(odometerOut || 0),
          fuelOut: Number(fuelOut || 0),
          cleanlinessOut: Number(cleanlinessOut || 5)
        })
      }, token);

      // 7. POST email-agreement (fire-and-forget; backend responds 202 + runs
      //    Puppeteer + SMTP async). We do NOT await — failures land in Sentry +
      //    audit log on the agreement.
      api(`/api/rental-agreements/${agreementId}/email-agreement`, {
        method: 'POST',
        body: JSON.stringify({})
      }, token).catch((err) => {
        console.warn('[checkout-wizard] email-agreement dispatch failed (non-blocking):', err?.message || err);
      });

      // Save agreementId in state so success screen can use it
      setAgreement((prev) => ({ ...prev, id: agreementId }));
      setStep(5);  // Success
    } catch (err) {
      setSubmitError(err.message || 'Checkout failed');
    } finally {
      setSubmitting(false);
    }
  };

  const steps = [
    'Confirm vehicle & customer',  // 0
    'Capture exterior + interior inspection',  // 1
    'Capture pickup metrics',  // 2
    'Review charges',  // 3 — NEW: read-only pricing display (Pillar 2 P4b)
    'Customer signature',  // 4
    'Keys delivered'  // 5 (success)
  ];

  const canAdvance = () => {
    switch (step) {
      case 0: return !!reservation && !!agreement && !!vehicleId;
      case 1: return Object.keys(photos).length >= 1;
      case 2: return Number(odometerOut) > 0;
      case 3: return true;  // review step — read-only, always advance
      case 4: return !!signerName && !!signatureDataUrl;
      default: return true;
    }
  };

  const onNext = () => {
    if (step === 4) return submit();
    if (step === 5) return router.push('/reservations');
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
      >
        {step === 0 && (
          <Step1Confirm
            reservation={reservation}
            agreement={agreement}
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
          <Step4ReviewCharges
            pricing={pricing}
            reservation={reservation}
            paymentRows={paymentRows}
            reservationId={reservationId}
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

function Step1Confirm({ reservation, agreement, vehicleId, onVehicleChange, availableVehicles, loadingVehicles }) {
  // Read vehicle from explicit selection > reservation > agreement
  const vSelected = availableVehicles.find((x) => x.id === vehicleId);
  const v = vSelected || reservation?.vehicle || agreement?.vehicle;
  const vehicleDesc = v ? [v.year, v.make, v.model].filter(Boolean).join(' ') : null;
  const hasVehicle = !!vehicleDesc;

  // Vehicle searcher state (only used when no vehicle assigned yet)
  const [search, setSearch] = useState('');
  const matches = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return availableVehicles.slice(0, 25);
    return availableVehicles.filter((veh) => {
      const haystack = [
        veh.year, veh.make, veh.model, veh.plate, veh.internalNumber, veh.color,
        veh.vehicleType?.name
      ].filter(Boolean).join(' ').toLowerCase();
      return haystack.includes(q);
    }).slice(0, 25);
  }, [availableVehicles, search]);
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
            <div style={{ fontSize: 11, fontWeight: 800, color: '#b45309', letterSpacing: '.12em', marginBottom: 8 }}>ASSIGN VEHICLE</div>
            <div style={{ fontSize: 13, color: '#211a38', marginBottom: 12 }}>
              Search by plate, unit number, year/make/model, or color. {availableVehicles.length} available.
            </div>
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={loadingVehicles ? 'Loading inventory…' : 'Search vehicles…'}
              autoFocus
              style={{
                width: '100%',
                padding: '12px 14px',
                border: '1px solid #e6dfff',
                borderRadius: 12,
                fontSize: 14,
                fontWeight: 700,
                color: '#211a38',
                background: 'white',
                outline: 'none',
                boxSizing: 'border-box'
              }}
            />
            <div style={{ marginTop: 12, maxHeight: 320, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 6 }}>
              {matches.length === 0 && !loadingVehicles && (
                <div style={{ fontSize: 12, color: '#6f668f', textAlign: 'center', padding: '12px 0' }}>
                  No vehicles match &quot;{search}&quot;
                </div>
              )}
              {matches.map((veh) => {
                const isSelected = veh.id === vehicleId;
                const desc = [veh.year, veh.make, veh.model].filter(Boolean).join(' ');
                return (
                  <button
                    key={veh.id}
                    type="button"
                    onClick={() => onVehicleChange(veh.id)}
                    style={{
                      textAlign: 'left',
                      padding: '10px 12px',
                      borderRadius: 10,
                      border: isSelected ? '2px solid #6d3df2' : '1px solid #e6dfff',
                      background: isSelected ? 'rgba(109,61,242,.06)' : 'white',
                      cursor: 'pointer',
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                      gap: 12
                    }}
                  >
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 13, fontWeight: 800, color: '#211a38' }}>{desc || 'Vehicle'}</div>
                      <div style={{ fontSize: 11, color: '#6f668f', marginTop: 2 }}>
                        {veh.plate ? `${veh.plate} · ` : ''}
                        {veh.internalNumber ? `Unit ${veh.internalNumber} · ` : ''}
                        {veh.color || ''}
                        {veh.mileage != null ? ` · ${Number(veh.mileage).toLocaleString()} mi` : ''}
                      </div>
                    </div>
                    {isSelected && <span style={{ fontWeight: 800, color: '#6d3df2', fontSize: 14 }}>✓</span>}
                  </button>
                );
              })}
            </div>
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

// Pillar 2 wizards P4b (2026-05-19, revised 2026-05-18) — read-only pricing display.
// Uses PERSISTED canonical numbers: reservation.estimatedTotal as total,
// sum of /api/reservations/:id/payments as paid. These match the reservation
// detail page's unpaidBalance byte-for-byte because both pages read from the
// same source.
//
// Why not pricing.charges?
//   ReservationCharge only holds extras (tolls, location fees, persisted taxes).
//   It does NOT include the base daily rate × days, which is computed UI-side
//   on the reservation page via `breakdown`. For a fresh CONFIRMED reservation,
//   pricing.charges may be empty/partial — so summing it ≠ the real total.
//   The persisted estimatedTotal is the only field guaranteed to match.
//
// Line items from pricing.charges are shown for visibility but the math
// at the bottom uses estimatedTotal, not the line-item sum.
function Step4ReviewCharges({ pricing, reservation, paymentRows, reservationId }) {
  const charges = Array.isArray(pricing?.charges) ? pricing.charges : [];

  // Total source-of-truth precedence:
  //   1. sum(pricing.charges) — pricing endpoint runs syncs that fold base
  //      rate × days + services + fees + tolls into ReservationCharge rows.
  //      This is what the reservation page would show after a fresh fetch.
  //   2. reservation.estimatedTotal — persisted on Save in pricing editor.
  //   3. dailyRate × days fallback — for cases where neither (1) nor (2) yet
  //      populated (e.g. brand-new reservation pre-sync).
  const chargesSum = Number(charges.reduce((s, c) => s + Number(c?.total || 0), 0).toFixed(2));
  const persistedTotal = Number(reservation?.estimatedTotal || 0);
  const fallbackTotal = (() => {
    const daily = Number(reservation?.dailyRate || 0);
    const pickupMs = new Date(reservation?.pickupAt || Date.now()).getTime();
    const returnMs = new Date(reservation?.returnAt || Date.now()).getTime();
    const msDiff = Number.isFinite(returnMs - pickupMs) ? returnMs - pickupMs : 0;
    const days = Math.max(1, Math.ceil(msDiff / (1000 * 60 * 60 * 24)));
    return Number((daily * days).toFixed(2));
  })();
  const total = chargesSum > 0 ? chargesSum : (persistedTotal > 0 ? persistedTotal : fallbackTotal);
  const usingFallback = chargesSum === 0 && persistedTotal === 0 && total > 0;

  const paid = (paymentRows || []).filter((p) => String(p?.method || '').toUpperCase() !== 'AUTH_HOLD').reduce((s, p) => s + Number(p?.amount || 0), 0);
  const balance = Math.max(0, Number((total - paid).toFixed(2)));

  return (
    <WizGrid cols={2}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <WizCard padding={18}>
          <div style={{ fontSize: 11, fontWeight: 800, color: '#6f668f', letterSpacing: '.12em', marginBottom: 10 }}>LINE ITEMS</div>
          {charges.length === 0 ? (
            usingFallback ? (
              <div style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 0', borderBottom: '1px solid #f1edff', fontSize: 13 }}>
                <div style={{ flex: 1 }}>
                  <div style={{ fontWeight: 700, color: '#211a38' }}>Daily rate (estimate)</div>
                  <div style={{ fontSize: 11, color: '#6f668f', marginTop: 2 }}>From reservation dailyRate × days</div>
                </div>
                <div style={{ fontWeight: 700, color: '#211a38', fontVariantNumeric: 'tabular-nums' }}>${total.toFixed(2)}</div>
              </div>
            ) : (
              <div style={{ fontSize: 13, color: '#6f668f' }}>
                No pricing on this reservation. Configure dailyRate or charges on the reservation page first.
              </div>
            )
          ) : (
            charges.map((c) => (
              <div key={c.id || c.code || c.name} style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 0', borderBottom: '1px solid #f1edff', fontSize: 13 }}>
                <div style={{ flex: 1 }}>
                  <div style={{ fontWeight: 700, color: '#211a38' }}>{c.name}</div>
                  {Number(c.quantity || 1) > 1 && (
                    <div style={{ fontSize: 11, color: '#6f668f', marginTop: 2 }}>{Number(c.quantity).toFixed(2)} × ${Number(c.rate || 0).toFixed(2)}</div>
                  )}
                </div>
                <div style={{ fontWeight: 700, color: '#211a38', fontVariantNumeric: 'tabular-nums' }}>${Number(c.total || 0).toFixed(2)}</div>
              </div>
            ))
          )}
        </WizCard>
        <div style={{ fontSize: 11, color: '#6f668f', lineHeight: 1.6, padding: '0 4px' }}>
          Totals on the right are read-only and pulled from the persisted reservation total.
          To edit charges, services, fees, or insurance — <a href={`/reservations/${reservationId}`} style={{ color: '#6d3df2', fontWeight: 700 }}>open the reservation page</a> and use the pricing editor there, then return.
        </div>
      </div>
      <WizCard accent="ink" padding={22}>
        <div style={{ fontSize: 11, opacity: .7, fontWeight: 700, letterSpacing: '.1em' }}>AGREEMENT TOTAL</div>
        <div style={{ marginTop: 14, display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 18 }}>
            <span style={{ fontWeight: 800 }}>Total</span>
            <span style={{ fontWeight: 800 }}>${total.toFixed(2)}</span>
          </div>
          {paid > 0 && (
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, color: '#1fc7aa' }}>
              <span>Paid</span>
              <span style={{ fontWeight: 700 }}>−${paid.toFixed(2)}</span>
            </div>
          )}
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 18, marginTop: 6 }}>
            <span style={{ fontWeight: 800, color: balance > 0 ? '#f59e0b' : '#1fc7aa' }}>Balance</span>
            <span style={{ fontWeight: 800, color: balance > 0 ? '#f59e0b' : '#1fc7aa' }}>${balance.toFixed(2)}</span>
          </div>
        </div>
        {balance > 0 && (
          <div style={{ marginTop: 16, padding: '10px 12px', background: 'rgba(245,158,11,.15)', borderLeft: '3px solid #f59e0b', borderRadius: 6, fontSize: 12 }}>
            ⚠ Outstanding balance. Collect payment on the reservation page before signing.
          </div>
        )}
        {usingFallback && (
          <div style={{ marginTop: 10, padding: '8px 12px', background: 'rgba(255,255,255,.08)', borderRadius: 6, fontSize: 11, opacity: .85 }}>
            ℹ Pricing not saved yet — total computed from daily rate × days. Save pricing on the reservation page to lock the canonical total.
          </div>
        )}
      </WizCard>
    </WizGrid>
  );
}

function Step5Signature({ agreement, signerName, onSignerName, signatureDataUrl, onSignature, error }) {
  return (
    <div style={{ maxWidth: 720, margin: '0 auto' }}>
      <div style={{
        padding: 16,
        background: 'linear-gradient(135deg, rgba(245,158,11,.08), rgba(245,158,11,.02))',
        border: '1px solid rgba(245,158,11,.24)',
        borderLeft: '4px solid #f59e0b',
        borderRadius: 12,
        marginBottom: 18
      }}>
        <div style={{ fontSize: 11, fontWeight: 800, color: '#b45309', letterSpacing: '.1em', marginBottom: 6 }}>POST-RENTAL CHARGES</div>
        <div style={{ fontSize: 13, color: '#211a38', lineHeight: 1.55 }}>
          I authorize charges to the card on file for: excess mileage · fuel · cleaning · smoking · damage.
        </div>
      </div>
      <SignaturePad
        height={240}
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
          onClick={() => reservation?.id && (window.location.href = `/reservations/${reservation.id}`)}
        />
        <ActionLink
          label="View inspection photos"
          onClick={() => reservation?.id && (window.location.href = `/reservations/${reservation.id}/inspection-report`)}
        />
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
