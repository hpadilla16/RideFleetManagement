'use client';

/**
 * Loaner Program reimagining — in-bay check-in / return wizard (tablet).
 *
 *   0. Return metrics   (fuel + odometer in, live out/in diff)
 *   1. Return photos    (walkaround-in, with out-count reference)
 *   2. Exceptions + close-out
 *
 * Wired to /api/loaner-agreements/:id/{photos,check-in,close}. The backend
 * computes the out/in diff (miles driven, fuel delta). Mockup: Surface B
 * "Check-in / return". Plan: doc/loaner-reimagining-plan-2026-05-31.md
 */

import { useEffect, useMemo, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { AuthGate } from '../../../../components/AuthGate';
import { AppShell } from '../../../../components/AppShell';
import { api } from '../../../../lib/client';
import { WizardShell, WizCard, WizGrid } from '../../../../components/wizard/WizardShell';
import { OdometerInput, FuelLevelInput } from '../../../../components/wizard/MetricInputs';
import { PhotoCapture } from '../../../../components/wizard/PhotoCapture';

const EXCEPTIONS = ['Fuel short', 'Damage', 'Odor / smoke', 'Cleaning needed', 'Personal items left'];

export default function Page() {
  return <AuthGate>{({ token, me, logout }) => <LoanerCheckinWizard token={token} me={me} logout={logout} />}</AuthGate>;
}

function LoanerCheckinWizard({ token, me, logout }) {
  const { reservationId } = useParams();
  const router = useRouter();

  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [submitError, setSubmitError] = useState('');
  const [busy, setBusy] = useState(false);

  const [agreement, setAgreement] = useState(null);
  const [step, setStep] = useState(0);
  const [done, setDone] = useState(false);
  const [closing, setClosing] = useState(false);

  const [odometerIn, setOdometerIn] = useState('');
  const [fuelIn, setFuelIn] = useState(1);
  const [photos, setPhotos] = useState({});
  const [currentAngle, setCurrentAngle] = useState(0);
  const [photosUploaded, setPhotosUploaded] = useState(false);
  const [exceptions, setExceptions] = useState([]);
  const [notes, setNotes] = useState('');

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        setLoading(true);
        const ag = await api(`/api/loaner-agreements/reservations/${reservationId}`, {}, token);
        if (!alive) return;
        if (!ag) {
          setLoadError('No loaner agreement found for this reservation. Complete check-out first.');
          return;
        }
        setAgreement(ag);
        if (ag.status === 'CLOSED' || ag.status === 'RETURNED') setDone(true);
        if (ag.fuelOut != null) setFuelIn(Number(ag.fuelOut));
      } catch (e) {
        if (alive) setLoadError(e.message || 'Failed to load check-in');
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => { alive = false; };
  }, [token, reservationId]);

  const agreementId = agreement?.id;
  const photoCount = useMemo(() => Object.values(photos).filter(Boolean).length, [photos]);

  const milesDriven = useMemo(() => {
    const out = agreement?.odometerOut;
    const inv = Number(odometerIn);
    if (out == null || !Number.isFinite(inv) || String(odometerIn).trim() === '') return null;
    return inv - out;
  }, [agreement, odometerIn]);

  const fuelDelta = useMemo(() => {
    const out = agreement?.fuelOut;
    if (out == null) return null;
    return Number((Number(out) - Number(fuelIn)).toFixed(2));
  }, [agreement, fuelIn]);

  function toggleException(label) {
    setExceptions((list) => (list.includes(label) ? list.filter((x) => x !== label) : [...list, label]));
  }

  function canAdvance() {
    if (step === 0) return String(odometerIn).trim() !== '';
    return true;
  }

  async function handleNext() {
    if (!canAdvance() || busy) return;
    setBusy(true);
    setSubmitError('');
    try {
      if (step === 0) {
        setStep(1);
      } else if (step === 1) {
        if (!photosUploaded) {
          const payload = Object.entries(photos).filter(([, v]) => !!v).map(([key, dataUrl]) => ({ dataUrl, angleLabel: key }));
          if (payload.length) {
            await api(`/api/loaner-agreements/${agreementId}/photos`, {
              method: 'POST',
              body: JSON.stringify({ kind: 'WALKAROUND_IN', photos: payload })
            }, token);
          }
          setPhotosUploaded(true);
        }
        setStep(2);
      } else if (step === 2) {
        const composedNotes = [
          exceptions.length ? `Exceptions: ${exceptions.join(', ')}` : null,
          notes.trim() || null
        ].filter(Boolean).join('. ');
        const updated = await api(`/api/loaner-agreements/${agreementId}/check-in`, {
          method: 'POST',
          body: JSON.stringify({ fuelIn: Number(fuelIn), odometerIn: Number(odometerIn), notes: composedNotes || null })
        }, token);
        setAgreement(updated);
        setDone(true);
      }
    } catch (e) {
      setSubmitError(e.message || 'Something went wrong');
    } finally {
      setBusy(false);
    }
  }

  async function closeOut() {
    setClosing(true);
    setSubmitError('');
    try {
      const updated = await api(`/api/loaner-agreements/${agreementId}/close`, { method: 'POST', body: JSON.stringify({}) }, token);
      setAgreement(updated);
    } catch (e) {
      setSubmitError(e.message || 'Could not close out');
    } finally {
      setClosing(false);
    }
  }

  const diffNode = (
    <WizCard accent="warn" style={{ marginTop: 14 }}>
      <div style={{ fontSize: 13 }}>
        <strong style={{ color: '#b9791e' }}>Auto-diff:</strong>{' '}
        {milesDriven != null ? `${milesDriven} miles driven` : 'miles —'}
        {' · '}
        {fuelDelta != null ? (fuelDelta > 0 ? `fuel down ${Math.round(fuelDelta * 100)}%` : 'fuel full') : 'fuel —'}
      </div>
    </WizCard>
  );

  return (
    <AppShell me={me} logout={logout}>
      {loading ? (
        <div style={{ padding: 40, textAlign: 'center', color: '#6f668f' }}>Loading check-in…</div>
      ) : loadError ? (
        <WizCard accent="warn" style={{ margin: 24 }}>
          <strong style={{ color: '#b9791e' }}>Couldn’t open this check-in.</strong>
          <div style={{ marginTop: 6, color: '#6f668f', fontSize: 14 }}>{loadError}</div>
          <button type="button" className="hero-pill" style={{ marginTop: 14 }} onClick={() => router.push('/loaner')}>← Back to Loaner Command Center</button>
        </WizCard>
      ) : done ? (
        <div style={{ maxWidth: 640, margin: '40px auto', padding: '0 16px' }}>
          <WizCard accent="mint" style={{ textAlign: 'center', padding: 28 }}>
            <div style={{ fontSize: 40 }}>↩</div>
            <h2 style={{ margin: '8px 0 4px', color: '#0f9b82' }}>{agreement?.status === 'CLOSED' ? 'Closed out' : 'Loaner returned'}</h2>
            <div style={{ color: '#6f668f', fontSize: 14 }}>
              {agreement?.agreementNumber} · {agreement?.diff?.milesDriven != null ? `${agreement.diff.milesDriven} mi driven` : ''}
              {agreement?.diff?.fuelDelta != null ? ` · fuel Δ ${Math.round(agreement.diff.fuelDelta * 100)}%` : ''}
            </div>
          </WizCard>
          {submitError && <WizCard accent="warn" style={{ marginTop: 14 }}><span style={{ color: '#b9791e', fontWeight: 700 }}>{submitError}</span></WizCard>}
          <div style={{ display: 'flex', gap: 10, marginTop: 16, justifyContent: 'center', flexWrap: 'wrap' }}>
            <button type="button" className="hero-pill" onClick={() => router.push('/loaner')}>← Command Center</button>
            {agreement?.status !== 'CLOSED' && (
              <button type="button" className="hero-pill" onClick={closeOut} disabled={closing}>{closing ? 'Closing…' : '✓ Close out (billing settled)'}</button>
            )}
          </div>
        </div>
      ) : (
        <WizardShell
          title="Loaner Check-In"
          stepIndex={step}
          totalSteps={3}
          stepTitle={['Return metrics', 'Return photos', 'Exceptions & close-out'][step]}
          subtitle={agreement?.agreementNumber}
          onBack={step > 0 ? () => { setSubmitError(''); setStep(step - 1); } : null}
          onNext={handleNext}
          nextDisabled={!canAdvance() || busy}
          nextLabel={step === 2 ? '✓ Complete return' : 'Continue →'}
          accent={step === 2 ? 'mint' : 'purple'}
        >
          {submitError && (
            <WizCard accent="warn" style={{ marginBottom: 14 }}><span style={{ color: '#b9791e', fontWeight: 700 }}>{submitError}</span></WizCard>
          )}

          {step === 0 && (
            <>
              <WizGrid cols={2}>
                <OdometerInput value={odometerIn} onChange={setOdometerIn} label="Odometer in" />
                <FuelLevelInput value={fuelIn} onChange={setFuelIn} label="Fuel level in" baseline={agreement?.fuelOut} />
              </WizGrid>
              {diffNode}
            </>
          )}

          {step === 1 && (
            <div>
              <div style={{ fontWeight: 800, fontSize: 13, marginBottom: 8 }}>
                Return walkaround <span style={{ color: '#6f668f', fontWeight: 600 }}>— {photoCount} captured · {(agreement?.photos || []).filter((p) => p.kind === 'WALKAROUND_OUT').length} on file from check-out</span>
              </div>
              <PhotoCapture
                capturedPhotos={photos}
                onCapture={(key, dataUrl) => setPhotos((p) => ({ ...p, [key]: dataUrl }))}
                currentAngleIndex={currentAngle}
                onAngleChange={setCurrentAngle}
              />
            </div>
          )}

          {step === 2 && (
            <>
              <WizCard>
                <div className="label" style={{ marginBottom: 10, fontSize: 11, fontWeight: 800, color: '#6f668f', textTransform: 'uppercase', letterSpacing: '.08em' }}>Return exceptions</div>
                <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                  {EXCEPTIONS.map((label) => {
                    const on = exceptions.includes(label);
                    return (
                      <button
                        key={label}
                        type="button"
                        onClick={() => toggleException(label)}
                        style={{
                          border: on ? '1px solid #e2574c' : '1px solid #e6dfff',
                          background: on ? '#fdeceb' : 'white',
                          color: on ? '#c0392b' : '#211a38',
                          borderRadius: 10, padding: '10px 14px', fontSize: 12.5, fontWeight: 700, cursor: 'pointer'
                        }}
                      >
                        {on ? '⚠ ' : ''}{label}
                      </button>
                    );
                  })}
                </div>
              </WizCard>
              <WizCard style={{ marginTop: 14 }}>
                <label style={{ display: 'block' }}>
                  <span style={{ display: 'block', fontSize: 11, fontWeight: 800, color: '#6f668f', textTransform: 'uppercase', letterSpacing: '.08em', marginBottom: 6 }}>Return notes</span>
                  <textarea
                    value={notes}
                    onChange={(e) => setNotes(e.target.value)}
                    rows={3}
                    style={{ width: '100%', border: '1px solid #e6dfff', borderRadius: 10, padding: '11px 13px', fontSize: 14, background: '#fff', color: '#211a38' }}
                    placeholder="Any notes for the closeout / billing review"
                  />
                </label>
              </WizCard>
              {diffNode}
            </>
          )}
        </WizardShell>
      )}
    </AppShell>
  );
}
