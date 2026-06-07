'use client';

/**
 * Loaner Program reimagining — in-bay check-out wizard (tablet).
 *
 * Six guided steps replace the legacy 30-field intake form, producing a
 * signed, photo-backed LoanerAgreement against a DEALERSHIP_LOANER
 * reservation:
 *
 *   0. Customer & license   (DL fields + optional license photo)
 *   1. Pick loaner vehicle  (availability-aware grid)
 *   2. Walkaround + damage   (8-angle photos + damage pins)
 *   3. Fuel & odometer out   (baseline the return diffs against)
 *   4. Billing mode          (confirm — billing lives on the reservation)
 *   5. Terms & signature     (in-person canvas, or text a remote link)
 *
 * Wired to /api/loaner-agreements/*. Mockup: doc/loaner-mockups.html
 * (Surface B). Plan: doc/loaner-reimagining-plan-2026-05-31.md
 */

import { useEffect, useMemo, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { AuthGate } from '../../../../components/AuthGate';
import { AppShell } from '../../../../components/AppShell';
import { api } from '../../../../lib/client';
import { WizardShell, WizCard, WizGrid } from '../../../../components/wizard/WizardShell';
import { OdometerInput, FuelLevelInput } from '../../../../components/wizard/MetricInputs';
import { PhotoCapture, STANDARD_ANGLES } from '../../../../components/wizard/PhotoCapture';
import { SignaturePad } from '../../../../components/wizard/SignaturePad';
import { LicenseScanner } from '../../../../components/loaner/LicenseScanner';

const REQUIRED_WALKAROUND = 4; // minimum angles before advancing
const TERMS_VERSION = 'loaner-v1';

export default function Page() {
  return <AuthGate>{({ token, me, logout }) => <LoanerCheckoutWizard token={token} me={me} logout={logout} />}</AuthGate>;
}

function fullName(c) {
  if (!c) return '';
  return [c.firstName, c.lastName].filter(Boolean).join(' ') || c.email || '';
}

function vehicleLabel(v) {
  if (!v) return '';
  const core = [v.year, v.make, v.model].filter(Boolean).join(' ');
  return core || v.name || v.id;
}

function LoanerCheckoutWizard({ token, me, logout }) {
  const { reservationId } = useParams();
  const router = useRouter();

  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [submitError, setSubmitError] = useState('');
  const [busy, setBusy] = useState(false);

  const [reservation, setReservation] = useState(null);
  const [agreement, setAgreement] = useState(null);
  const [vehicles, setVehicles] = useState([]);
  const [step, setStep] = useState(() => {
    if (typeof window === 'undefined') return 0;
    try {
      const s = parseInt(window.localStorage.getItem(`loaner.checkout.step.${reservationId}`), 10);
      return Number.isInteger(s) && s >= 0 && s <= 5 ? s : 0;
    } catch { return 0; }
  });
  const [done, setDone] = useState(false);
  const [remoteLink, setRemoteLink] = useState('');
  const [smsTo, setSmsTo] = useState('');
  // 2026-06-06 (loaner Ola 2.1): persist the wizard step so a tablet reload
  // resumes where the advisor left off (the field data already persisted; only
  // the step pointer reset to 0). Cleared once the agreement is signed/done.
  useEffect(() => {
    if (!reservationId) return;
    try {
      if (done) window.localStorage.removeItem(`loaner.checkout.step.${reservationId}`);
      else window.localStorage.setItem(`loaner.checkout.step.${reservationId}`, String(step));
    } catch {}
  }, [step, done, reservationId]);

  // Step 0 — customer & license
  const [form, setForm] = useState({
    customerFirstName: '', customerLastName: '', customerPhone: '', customerEmail: '',
    licenseNumber: '', licenseState: '', licenseExpiry: ''
  });
  const [licensePhoto, setLicensePhoto] = useState('');

  // Step 1 — vehicle
  const [vehicleId, setVehicleId] = useState('');

  // Step 2 — walkaround + damage
  const [photos, setPhotos] = useState({});
  const [currentAngle, setCurrentAngle] = useState(0);
  const [walkaroundUploaded, setWalkaroundUploaded] = useState(false);
  const [damagePoints, setDamagePoints] = useState([]);
  const [pendingPin, setPendingPin] = useState(null); // { x, y }
  const [pinNote, setPinNote] = useState('');
  const [pinSeverity, setPinSeverity] = useState('MINOR');

  // Step 3 — fuel & odometer
  const [odometerOut, setOdometerOut] = useState('');
  const [fuelOut, setFuelOut] = useState(1);

  // Step 5 — signature
  const [signerName, setSignerName] = useState('');
  const [signatureDataUrl, setSignatureDataUrl] = useState('');

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        setLoading(true);
        setLoadError('');
        const [resv, options] = await Promise.all([
          api(`/api/reservations/${reservationId}`, {}, token),
          api('/api/dealership-loaner/intake-options', {}, token).catch(() => ({ vehicles: [] }))
        ]);
        if (!alive) return;
        setReservation(resv);
        setVehicles(Array.isArray(options?.vehicles) ? options.vehicles : []);

        let ag = await api(`/api/loaner-agreements/reservations/${reservationId}`, {}, token);
        if (!ag) {
          ag = await api(`/api/loaner-agreements/reservations/${reservationId}`, { method: 'POST', body: JSON.stringify({}) }, token);
        }
        if (!alive) return;
        setAgreement(ag);
        // Hydrate form from the agreement (which pre-filled from the reservation customer).
        setForm({
          customerFirstName: ag?.customer?.firstName || '',
          customerLastName: ag?.customer?.lastName || '',
          customerPhone: ag?.customer?.phone || '',
          customerEmail: ag?.customer?.email || '',
          licenseNumber: ag?.license?.number || '',
          licenseState: ag?.license?.state || '',
          licenseExpiry: ag?.license?.expiry ? String(ag.license.expiry).slice(0, 10) : ''
        });
        setVehicleId(ag?.vehicleId || resv?.vehicleId || '');
        setOdometerOut(ag?.odometerOut != null ? String(ag.odometerOut) : '');
        if (ag?.fuelOut != null) setFuelOut(Number(ag.fuelOut));
        setDamagePoints(ag?.damagePoints || []);
        if (ag?.signature?.signed) setDone(true);
      } catch (e) {
        if (alive) setLoadError(e.message || 'Failed to load check-out');
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => { alive = false; };
  }, [token, reservationId]);

  const agreementId = agreement?.id;
  const walkaroundCount = useMemo(() => Object.values(photos).filter(Boolean).length, [photos]);

  const billingMode = reservation?.loanerBillingMode || agreement?.reservation?.loanerBillingMode || 'COURTESY';

  function setField(k, v) {
    setForm((f) => ({ ...f, [k]: v }));
  }

  async function patchAgreement(data) {
    const updated = await api(`/api/loaner-agreements/${agreementId}`, { method: 'PATCH', body: JSON.stringify(data) }, token);
    setAgreement(updated);
    return updated;
  }

  function canAdvance() {
    if (step === 0) return !!(form.customerFirstName.trim() && form.customerLastName.trim());
    if (step === 1) return !!vehicleId;
    if (step === 2) return walkaroundCount >= REQUIRED_WALKAROUND;
    if (step === 3) return String(odometerOut).trim() !== '' && Number(fuelOut) >= 0;
    if (step === 4) return true;
    if (step === 5) return !!(signatureDataUrl && signerName.trim());
    return true;
  }

  // Sibling of canAdvance(): when the Continue button is disabled, return a
  // short, actionable string telling staff EXACTLY what the current step needs.
  // Mirrors canAdvance()'s rules one-for-one (no new gating) so the two never
  // drift. Returns null when advanceable (button enabled — no hint to show).
  function blockedReason() {
    if (canAdvance()) return null;
    if (step === 0) {
      if (!form.customerFirstName.trim()) return 'Ingresa el nombre del cliente';
      if (!form.customerLastName.trim()) return 'Ingresa el apellido del cliente';
      return 'Faltan el nombre y apellido del cliente';
    }
    if (step === 1) return 'Selecciona un vehículo loaner';
    if (step === 2) return `Captura al menos ${REQUIRED_WALKAROUND} fotos del walkaround (vas ${walkaroundCount})`;
    if (step === 3) {
      if (String(odometerOut).trim() === '') return 'Ingresa el odómetro de salida';
      return 'Ingresa un nivel de combustible válido';
    }
    if (step === 5) {
      if (!signerName.trim()) return 'Ingresa el nombre de quien firma';
      if (!signatureDataUrl) return 'Captura la firma del cliente';
      return 'Falta la firma y el nombre del firmante';
    }
    return null;
  }

  async function handleNext() {
    if (!canAdvance() || busy) return;
    setBusy(true);
    setSubmitError('');
    try {
      if (step === 0) {
        await patchAgreement({
          customerFirstName: form.customerFirstName,
          customerLastName: form.customerLastName,
          customerPhone: form.customerPhone || null,
          customerEmail: form.customerEmail || null,
          licenseNumber: form.licenseNumber || null,
          licenseState: form.licenseState || null,
          licenseExpiry: form.licenseExpiry || null
        });
        if (licensePhoto) {
          await api(`/api/loaner-agreements/${agreementId}/photos`, {
            method: 'POST',
            body: JSON.stringify({ kind: 'LICENSE', photos: [{ dataUrl: licensePhoto, angleLabel: 'license' }] })
          }, token);
        }
        setStep(1);
      } else if (step === 1) {
        await patchAgreement({ vehicleId });
        setStep(2);
      } else if (step === 2) {
        if (!walkaroundUploaded) {
          const payload = Object.entries(photos)
            .filter(([, dataUrl]) => !!dataUrl)
            .map(([key, dataUrl]) => ({ dataUrl, angleLabel: key }));
          if (payload.length) {
            await api(`/api/loaner-agreements/${agreementId}/photos`, {
              method: 'POST',
              body: JSON.stringify({ kind: 'WALKAROUND_OUT', photos: payload })
            }, token);
          }
          setWalkaroundUploaded(true);
        }
        setStep(3);
      } else if (step === 3) {
        await patchAgreement({ odometerOut: Number(odometerOut), fuelOut: Number(fuelOut) });
        setStep(4);
      } else if (step === 4) {
        setStep(5);
      } else if (step === 5) {
        const result = await api(`/api/loaner-agreements/${agreementId}/sign`, {
          method: 'POST',
          body: JSON.stringify({ signatureDataUrl, signerName, termsVersion: TERMS_VERSION })
        }, token);
        setAgreement(result);
        setDone(true);
      }
    } catch (e) {
      setSubmitError(e.message || 'Something went wrong');
    } finally {
      setBusy(false);
    }
  }

  function handleBack() {
    setSubmitError('');
    if (step > 0) setStep(step - 1);
  }

  async function addDamagePin() {
    if (!pendingPin) return;
    try {
      const res = await api(`/api/loaner-agreements/${agreementId}/damage-points`, {
        method: 'POST',
        body: JSON.stringify({ x: pendingPin.x, y: pendingPin.y, severity: pinSeverity, note: pinNote || null, preExisting: true })
      }, token);
      setDamagePoints((d) => [...d, { id: res.id, x: pendingPin.x, y: pendingPin.y, severity: pinSeverity, note: pinNote, preExisting: true }]);
      setPendingPin(null);
      setPinNote('');
      setPinSeverity('MINOR');
    } catch (e) {
      setSubmitError(e.message || 'Could not save damage point');
    }
  }

  async function textRemoteLink() {
    try {
      const res = await api(`/api/loaner-agreements/${agreementId}/signature-token`, { method: 'POST', body: JSON.stringify({}) }, token);
      const link = res.link || `${window.location.origin}/customer/sign-loaner?token=${encodeURIComponent(res.token)}`;
      setRemoteLink(link);
      setSmsTo(res.smsSent ? res.smsTo : '');
    } catch (e) {
      setSubmitError(e.message || 'Could not create signing link');
    }
  }

  return (
    <AppShell me={me} logout={logout}>
      {loading ? (
        <div style={{ padding: 40, textAlign: 'center', color: '#6f668f' }}>Loading check-out…</div>
      ) : loadError ? (
        <WizCard accent="warn" style={{ margin: 24 }}>
          <strong style={{ color: '#b9791e' }}>Couldn’t open this check-out.</strong>
          <div style={{ marginTop: 6, color: '#6f668f', fontSize: 14 }}>{loadError}</div>
          <button type="button" className="hero-pill" style={{ marginTop: 14 }} onClick={() => router.push('/loaner')}>← Back to Loaner Command Center</button>
        </WizCard>
      ) : done ? (
        <SuccessScreen agreement={agreement} reservation={reservation} onRemote={textRemoteLink} remoteLink={remoteLink} smsTo={smsTo} router={router} />
      ) : (
        <WizardShell
          title="Loaner Check-Out"
          stepIndex={step}
          totalSteps={6}
          stepTitle={STEP_TITLES[step]}
          subtitle={subtitleFor(step, reservation, agreement)}
          onBack={step > 0 ? handleBack : null}
          onNext={handleNext}
          nextDisabled={!canAdvance() || busy}
          nextHint={busy ? null : blockedReason()}
          nextLabel={step === 5 ? '✓ Complete · keys out' : 'Continue →'}
          accent={step === 5 ? 'mint' : 'purple'}
          ghostAction={step === 5 ? { label: '✉ Text signing link', onClick: textRemoteLink } : null}
        >
          {submitError && (
            <WizCard accent="warn" style={{ marginBottom: 14 }}>
              <span style={{ color: '#b9791e', fontWeight: 700 }}>{submitError}</span>
            </WizCard>
          )}

          {/* Disabled-reason hint — tells staff exactly what this step still
              needs so they aren't stuck staring at a greyed-out Continue.
              Hidden while busy (the button reads its own busy state then). */}
          {!busy && blockedReason() && (
            <div style={{ fontSize: 12, color: '#6f668f', marginBottom: 14 }}>
              {blockedReason()}
            </div>
          )}

          {step === 0 && (
            <Step0 form={form} setField={setField} licensePhoto={licensePhoto} setLicensePhoto={setLicensePhoto} reservation={reservation} />
          )}
          {step === 1 && (
            <Step1Vehicles vehicles={vehicles} vehicleId={vehicleId} setVehicleId={setVehicleId} />
          )}
          {step === 2 && (
            <Step2Walkaround
              photos={photos} setPhotos={setPhotos} currentAngle={currentAngle} setCurrentAngle={setCurrentAngle}
              count={walkaroundCount} damagePoints={damagePoints}
              pendingPin={pendingPin} setPendingPin={setPendingPin}
              pinNote={pinNote} setPinNote={setPinNote} pinSeverity={pinSeverity} setPinSeverity={setPinSeverity}
              onAddPin={addDamagePin}
            />
          )}
          {step === 3 && (
            <WizGrid cols={2}>
              <OdometerInput value={odometerOut} onChange={setOdometerOut} />
              <FuelLevelInput value={fuelOut} onChange={setFuelOut} label="Fuel level out" />
            </WizGrid>
          )}
          {step === 4 && (
            <Step4Billing billingMode={billingMode} reservation={reservation} />
          )}
          {step === 5 && (
            <WizGrid cols={2}>
              <WizCard>
                <div className="label">Loaner agreement</div>
                <p style={{ fontSize: 13, color: '#6f668f', lineHeight: 1.5, marginTop: 8 }}>
                  Borrower returns the loaner in the condition received with fuel at the recorded level, and is
                  responsible for tolls, citations, and damage not documented at check-out. Billing: <strong>{billingMode}</strong>.
                  By signing, the borrower confirms the recorded mileage ({odometerOut || '—'}) and fuel level.
                </p>
              </WizCard>
              <WizCard>
                <SignaturePad
                  signerName={signerName}
                  onSignerNameChange={setSignerName}
                  onSignatureChange={setSignatureDataUrl}
                  label="Customer signature"
                />
              </WizCard>
            </WizGrid>
          )}
        </WizardShell>
      )}
    </AppShell>
  );
}

const STEP_TITLES = [
  'Customer & license',
  'Pick the loaner vehicle',
  'Walkaround & damage',
  'Fuel & odometer out',
  'Billing mode',
  'Terms & signature'
];

function subtitleFor(step, reservation, agreement) {
  const ro = reservation?.repairOrderNumber || agreement?.reservation?.repairOrderNumber;
  const cust = fullName(agreement?.customer) || fullName(reservation?.customer);
  return [ro ? `RO #${ro}` : null, cust].filter(Boolean).join(' · ');
}

function Step0({ form, setField, licensePhoto, setLicensePhoto, reservation }) {
  function handleScan(fields) {
    if (fields.firstName) setField('customerFirstName', fields.firstName);
    if (fields.lastName) setField('customerLastName', fields.lastName);
    if (fields.licenseNumber) setField('licenseNumber', fields.licenseNumber);
    if (fields.licenseState) setField('licenseState', fields.licenseState);
    if (fields.licenseExpiry) setField('licenseExpiry', fields.licenseExpiry);
  }
  return (
    <>
      <WizCard accent="mint" style={{ marginBottom: 14 }}>
        <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 8 }}>Scan the license to auto-fill these fields</div>
        <LicenseScanner onDecode={handleScan} onPhoto={setLicensePhoto} />
        {licensePhoto ? <div style={{ marginTop: 8, fontSize: 12, color: '#0f9b82', fontWeight: 700 }}>✓ License image captured</div> : null}
      </WizCard>
      <WizGrid cols={2}>
        <Field label="First name"><input className="input" value={form.customerFirstName} onChange={(e) => setField('customerFirstName', e.target.value)} /></Field>
        <Field label="Last name"><input className="input" value={form.customerLastName} onChange={(e) => setField('customerLastName', e.target.value)} /></Field>
        <Field label="Phone"><input className="input" value={form.customerPhone} onChange={(e) => setField('customerPhone', e.target.value)} /></Field>
        <Field label="Email"><input className="input" value={form.customerEmail} onChange={(e) => setField('customerEmail', e.target.value)} /></Field>
        <Field label="License #"><input className="input" value={form.licenseNumber} onChange={(e) => setField('licenseNumber', e.target.value)} /></Field>
        <Field label="License state"><input className="input" value={form.licenseState} onChange={(e) => setField('licenseState', e.target.value)} /></Field>
        <Field label="License expiry"><input className="input" type="date" value={form.licenseExpiry} onChange={(e) => setField('licenseExpiry', e.target.value)} /></Field>
        <Field label="Service vehicle">
          <div className="input" style={{ background: '#faf9fe' }}>
            {[reservation?.serviceVehicleYear, reservation?.serviceVehicleMake, reservation?.serviceVehicleModel].filter(Boolean).join(' ') || '—'}
          </div>
        </Field>
      </WizGrid>
      <FieldStyles />
    </>
  );
}

function Step1Vehicles({ vehicles, vehicleId, setVehicleId }) {
  if (!vehicles.length) {
    return <WizCard accent="warn"><span style={{ color: '#b9791e' }}>No loaner-program vehicles available. Tag vehicles as LOANER_ONLY or BOTH in inventory.</span></WizCard>;
  }
  return (
    <WizGrid cols={3}>
      {vehicles.map((v) => {
        const selected = v.id === vehicleId;
        return (
          <button
            key={v.id}
            type="button"
            onClick={() => setVehicleId(v.id)}
            style={{
              textAlign: 'left', cursor: 'pointer', borderRadius: 16, padding: 14,
              border: selected ? '2px solid #8752FE' : '1px solid #e6dfff',
              background: selected ? 'rgba(135,82,254,.06)' : 'white',
              boxShadow: '0 8px 22px rgba(35,21,80,.06)'
            }}
          >
            <div style={{ height: 48, borderRadius: 9, background: 'linear-gradient(135deg,#e6dffb,#cdbff5)', marginBottom: 9 }} />
            <div style={{ fontWeight: 800, fontSize: 14 }}>{vehicleLabel(v)}</div>
            <div style={{ fontSize: 12, color: '#6f668f', marginTop: 2 }}>
              {(v.licensePlate || v.plate || '—')}{v.vehicleType?.name ? ` · ${v.vehicleType.name}` : ''}
            </div>
            {selected && <div style={{ marginTop: 8, color: '#6d3df2', fontWeight: 800, fontSize: 12 }}>✓ Selected</div>}
          </button>
        );
      })}
    </WizGrid>
  );
}

function Step2Walkaround(props) {
  const {
    photos, setPhotos, currentAngle, setCurrentAngle, count, damagePoints,
    pendingPin, setPendingPin, pinNote, setPinNote, pinSeverity, setPinSeverity, onAddPin
  } = props;

  function onDiagramClick(e) {
    const rect = e.currentTarget.getBoundingClientRect();
    const x = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    const y = Math.max(0, Math.min(1, (e.clientY - rect.top) / rect.height));
    setPendingPin({ x: Number(x.toFixed(3)), y: Number(y.toFixed(3)) });
  }

  return (
    <WizGrid cols={2}>
      <div>
        <div style={{ fontWeight: 800, fontSize: 13, marginBottom: 8 }}>
          Walkaround photos <span style={{ color: '#6f668f', fontWeight: 600 }}>— {count} of {STANDARD_ANGLES.length} ({REQUIRED_WALKAROUND} required)</span>
        </div>
        <PhotoCapture
          capturedPhotos={photos}
          onCapture={(key, dataUrl) => setPhotos((p) => ({ ...p, [key]: dataUrl }))}
          currentAngleIndex={currentAngle}
          onAngleChange={setCurrentAngle}
        />
      </div>
      <WizCard>
        <div className="label" style={{ marginBottom: 8 }}>Damage map · {damagePoints.length} pin{damagePoints.length === 1 ? '' : 's'}</div>
        <div
          onClick={onDiagramClick}
          style={{ position: 'relative', height: 150, borderRadius: 12, background: '#faf9fe', border: '1px solid #e6dfff', cursor: 'crosshair' }}
          title="Tap to drop a damage pin"
        >
          <svg viewBox="0 0 240 120" style={{ width: '100%', height: '100%' }}>
            <rect x="20" y="35" width="200" height="50" rx="22" fill="#d9cefa" />
            <rect x="58" y="22" width="120" height="40" rx="16" fill="#c4b4f3" />
            <circle cx="64" cy="92" r="13" fill="#8f74e0" />
            <circle cx="176" cy="92" r="13" fill="#8f74e0" />
          </svg>
          {damagePoints.map((d, i) => (
            <span key={d.id || i} style={{
              position: 'absolute', left: `${d.x * 100}%`, top: `${d.y * 100}%`, transform: 'translate(-50%,-50%)',
              width: 20, height: 20, borderRadius: '50%', background: '#e2574c', color: '#fff', border: '2px solid #fff',
              fontSize: 11, fontWeight: 800, display: 'flex', alignItems: 'center', justifyContent: 'center'
            }}>{i + 1}</span>
          ))}
          {pendingPin && (
            <span style={{
              position: 'absolute', left: `${pendingPin.x * 100}%`, top: `${pendingPin.y * 100}%`, transform: 'translate(-50%,-50%)',
              width: 20, height: 20, borderRadius: '50%', background: '#8752FE', color: '#fff', border: '2px solid #fff',
              fontSize: 11, fontWeight: 800, display: 'flex', alignItems: 'center', justifyContent: 'center'
            }}>+</span>
          )}
        </div>
        {pendingPin ? (
          <div style={{ marginTop: 12 }}>
            <Field label="Severity">
              <select className="input" value={pinSeverity} onChange={(e) => setPinSeverity(e.target.value)}>
                <option value="MINOR">Minor</option>
                <option value="MODERATE">Moderate</option>
                <option value="SEVERE">Severe</option>
              </select>
            </Field>
            <Field label="Note"><input className="input" value={pinNote} onChange={(e) => setPinNote(e.target.value)} placeholder="e.g. scuff on driver door, pre-existing" /></Field>
            <button type="button" className="hero-pill" onClick={onAddPin} style={{ marginTop: 6 }}>Save pin</button>
          </div>
        ) : (
          <div style={{ fontSize: 12, color: '#6f668f', marginTop: 10 }}>Tap the diagram to drop a damage pin (note + severity).</div>
        )}
        <FieldStyles />
      </WizCard>
    </WizGrid>
  );
}

function Step4Billing({ billingMode, reservation }) {
  const modes = [
    { key: 'COURTESY', icon: '🎁', label: 'Courtesy' },
    { key: 'WARRANTY', icon: '🛡️', label: 'Warranty' },
    { key: 'INSURANCE', icon: '🏥', label: 'Insurance' },
    { key: 'CUSTOMER_PAY', icon: '💳', label: 'Customer-pay' },
    { key: 'INTERNAL', icon: '🏢', label: 'Internal' }
  ];
  return (
    <>
      <WizGrid cols={5}>
        {modes.map((m) => {
          const sel = m.key === billingMode;
          return (
            <div key={m.key} style={{
              borderRadius: 12, padding: '14px 10px', textAlign: 'center', fontWeight: 800, fontSize: 12,
              border: sel ? '2px solid #8752FE' : '1px solid #e6dfff',
              background: sel ? 'rgba(135,82,254,.06)' : 'white', color: sel ? '#6d3df2' : '#211a38'
            }}>
              <div style={{ fontSize: 18, marginBottom: 5 }}>{m.icon}</div>{m.label}
            </div>
          );
        })}
      </WizGrid>
      <WizCard style={{ marginTop: 14 }}>
        <div style={{ fontSize: 13, color: '#6f668f' }}>
          Billing mode is set on the reservation ({billingMode}). RO #{reservation?.repairOrderNumber || '—'}.
          Change it from the reservation if needed; warranty/OEM reconciliation happens in the billing screen after return.
        </div>
      </WizCard>
    </>
  );
}

function SuccessScreen({ agreement, reservation, onRemote, remoteLink, smsTo, router }) {
  return (
    <div style={{ maxWidth: 640, margin: '40px auto', padding: '0 16px' }}>
      <WizCard accent="mint" style={{ textAlign: 'center', padding: 28 }}>
        <div style={{ fontSize: 40 }}>🔑</div>
        <h2 style={{ margin: '8px 0 4px', color: '#0f9b82' }}>Check-out complete</h2>
        <div style={{ color: '#6f668f', fontSize: 14 }}>
          {agreement?.agreementNumber} · {fullName(agreement?.customer)} · keys out
        </div>
        <div style={{ marginTop: 8, fontSize: 13, color: '#6f668f' }}>
          A signed packet is on file. {agreement?.signature?.signed ? 'Signed in person.' : 'Awaiting remote signature.'}
        </div>
      </WizCard>
      <div style={{ display: 'flex', gap: 10, marginTop: 16, justifyContent: 'center', flexWrap: 'wrap' }}>
        <button type="button" className="hero-pill" onClick={() => router.push('/loaner')}>← Command Center</button>
        {!agreement?.signature?.signed && <button type="button" className="hero-pill" onClick={onRemote}>✉ Text signing link</button>}
      </div>
      {remoteLink && (
        <WizCard style={{ marginTop: 14 }}>
          <div className="label">Remote signing link{smsTo ? ` · texted to ${smsTo}` : ''}</div>
          {smsTo ? <div style={{ fontSize: 12, color: '#0f9b82', fontWeight: 700, marginTop: 4 }}>✓ Sent by SMS</div> : null}
          <div style={{ fontSize: 13, wordBreak: 'break-all', marginTop: 6 }}>{remoteLink}</div>
        </WizCard>
      )}
    </div>
  );
}

function Field({ label, children }) {
  return (
    <label style={{ display: 'block' }}>
      <span className="field-label">{label}</span>
      {children}
    </label>
  );
}

function FieldStyles() {
  return (
    <style jsx global>{`
      .field-label { display:block; font-size:11px; font-weight:800; color:#6f668f; text-transform:uppercase; letter-spacing:.08em; margin-bottom:5px; }
      .input { width:100%; border:1px solid #e6dfff; border-radius:10px; padding:11px 13px; font-size:14px; background:#fff; color:#211a38; }
      .input:focus { outline:none; border-color:#8752FE; }
      label > .field-label { margin-top: 2px; }
      label { margin-bottom: 12px; display:block; }
    `}</style>
  );
}
