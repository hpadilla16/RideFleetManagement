'use client';

import { useEffect, useRef, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { AuthGate } from '../../../../components/AuthGate';
import { AppShell } from '../../../../components/AppShell';
import { api, API_BASE } from '../../../../lib/client';
import { syncRentalAndInspection } from './checkout-sync';

export default function Page() {
  return <AuthGate>{({ token, me, logout }) => <Inner token={token} me={me} logout={logout} />}</AuthGate>;
}

function Inner({ token, me, logout }) {
  const { id } = useParams();
  const router = useRouter();
  const [row, setRow] = useState(null);
  const [vehicles, setVehicles] = useState([]);
  const [msg, setMsg] = useState('');
  const [form, setForm] = useState({ vehicleId: '', odometerOut: '', fuelOut: '1.000', cleanlinessOut: '5', signerName: '', franchiseId: '' });
  const [franchises, setFranchises] = useState([]);
  const [requireFranchise, setRequireFranchise] = useState(false);
  const [checkoutErrors, setCheckoutErrors] = useState(null);
  const sigRef = useRef(null);
  const drawing = useRef(false);
  const selectedVehicle = vehicles.find((vehicle) => String(vehicle.id) === String(form.vehicleId)) || null;

  const load = async () => {
    setMsg('');
    const r = await api(`/api/reservations/${id}`, {}, token);
    setRow(r);
    setForm((f) => ({ ...f, vehicleId: r?.vehicleId || '', franchiseId: r?.franchiseId || '', signerName: `${r?.customer?.firstName || ''} ${r?.customer?.lastName || ''}`.trim() }));
    const [vehiclesRes, optionsRes, pricingRes] = await Promise.allSettled([
      api(`/api/reservations/${id}/available-vehicles`, {}, token),
      api('/api/settings/reservation-options', {}, token),
      api(`/api/reservations/${id}/pricing-options`, {}, token)
    ]);
    if (vehiclesRes.status === 'fulfilled') setVehicles(Array.isArray(vehiclesRes.value) ? vehiclesRes.value : []);
    else setMsg('Unable to load available vehicles.');
    if (optionsRes.status === 'fulfilled') setRequireFranchise(!!optionsRes.value?.requireFranchiseSelection);
    if (pricingRes.status === 'fulfilled') setFranchises(Array.isArray(pricingRes.value?.franchises) ? pricingRes.value.franchises : []);
  };
  useEffect(() => {
    if (!id || !token) return;
    load().catch((e) => setMsg(String(e?.message || 'Unable to load checkout wizard.')));
  }, [id, token]);

  const ensureAgreementId = async () => {
    const out = await api(`/api/reservations/${id}/start-rental`, { method: 'POST', body: JSON.stringify({}) }, token);
    return out?.id;
  };

  const p = (e, c) => {
    const r = c.getBoundingClientRect();
    const t = e?.touches?.[0] || e;
    const sx = c.width / Math.max(1, r.width);
    const sy = c.height / Math.max(1, r.height);
    return {
      x: (t.clientX - r.left) * sx,
      y: (t.clientY - r.top) * sy
    };
  };
  const begin = (e) => {
    e.preventDefault?.();
    const c = sigRef.current; if (!c) return;
    const ctx = c.getContext('2d');
    const pt = p(e, c);
    ctx.beginPath();
    ctx.moveTo(pt.x, pt.y);
    ctx.lineWidth = 2;
    ctx.lineCap = 'round';
    ctx.strokeStyle = '#111827';
    drawing.current = true;
  };
  const move = (e) => {
    if (!drawing.current) return;
    e.preventDefault?.();
    const c = sigRef.current; if (!c) return;
    const ctx = c.getContext('2d');
    const pt = p(e, c);
    ctx.lineTo(pt.x, pt.y);
    ctx.stroke();
  };
  const end = (e) => { e?.preventDefault?.(); drawing.current = false; };
  const clearSig = () => { const c = sigRef.current; if (!c) return; c.getContext('2d').clearRect(0, 0, c.width, c.height); };
  const sig = () => { const c = sigRef.current; if (!c) return ''; const d = c.toDataURL('image/png'); const b = document.createElement('canvas'); b.width = c.width; b.height = c.height; return b.toDataURL() === d ? '' : d; };

  const complete = async () => {
    try {
      // Validate all required fields and show popup if anything is missing
      const errors = [];
      if (!form.vehicleId) errors.push({ field: 'Vehicle', detail: 'Select an available vehicle from the dropdown before checkout.' });
      if (!form.odometerOut) errors.push({ field: 'Odometer Out', detail: 'Record the current odometer reading at the time of handoff.' });
      const signer = String(form.signerName || '').trim();
      const signatureDataUrl = sig();
      if (!signer) errors.push({ field: 'Signer Name', detail: 'Enter the full name of the person signing the rental agreement.' });
      if (!signatureDataUrl) errors.push({ field: 'Customer Signature', detail: 'The customer must sign on the signature pad before checkout can be completed.' });
      if (requireFranchise && !form.franchiseId) errors.push({ field: 'Franchise', detail: 'This tenant requires a franchise to be assigned. Select the franchise operating this rental before checkout.' });
      if (errors.length > 0) {
        setCheckoutErrors(errors);
        return;
      }
      setCheckoutErrors(null);

      const checkoutLine = `[RES_CHECKOUT ${new Date().toISOString()}] odometerOut=${Number(form.odometerOut || 0)} fuelOut=${Number(form.fuelOut || 0)} cleanlinessOut=${Number(form.cleanlinessOut || 5)}`;
      const baseNotes = String(row?.notes || '').trim();
      const nextNotes = `${baseNotes}${baseNotes ? '\n' : ''}${checkoutLine}`;

      await api(`/api/reservations/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          vehicleId: form.vehicleId,
          franchiseId: form.franchiseId || null,
          notes: nextNotes
        })
      }, token);

      const agreementId = await ensureAgreementId();
      if (!agreementId) throw new Error('No rental agreement available for checkout');

      // PR 4: parallelize PUT /rental and GET /inspection-report. They are
      // independent (neither reads what the other produces), so overlapping
      // their RTT trims ~300-600 ms off the checkout. `syncRentalAndInspection`
      // also enforces the "checkout inspection must be complete" guard that
      // used to run sequentially after the PUT.
      await syncRentalAndInspection(
        agreementId,
        {
          vehicleId: form.vehicleId,
          odometerOut: Number(form.odometerOut || 0),
          fuelOut: Number(form.fuelOut || 0),
          cleanlinessOut: Number(form.cleanlinessOut || 5)
        },
        { api, token }
      );

      await api(`/api/rental-agreements/${agreementId}/signature`, {
        method: 'POST',
        body: JSON.stringify({
          signerName: signer,
          signatureDataUrl
        })
      }, token);

      await api(`/api/rental-agreements/${agreementId}/finalize`, {
        method: 'POST',
        body: JSON.stringify({
          odometerOut: Number(form.odometerOut || 0),
          fuelOut: Number(form.fuelOut || 0),
          cleanlinessOut: Number(form.cleanlinessOut || 5)
        })
      }, token);

      // Auto-email PDF copy after successful checkout.
      // Backend responds 202 immediately and runs Puppeteer + SMTP in the
      // background, so we intentionally do NOT await here. UI redirects right
      // away; failures land in Sentry + an audit-log entry on the agreement.
      api(`/api/rental-agreements/${agreementId}/email-agreement`, { method: 'POST', body: JSON.stringify({}) }, token)
        .catch((err) => {
          // Best-effort console visibility during dev — real error surface is
          // Sentry backend + the auditLog entry on the agreement.
          console.warn('[checkout] email-agreement dispatch failed (non-blocking):', err?.message || err);
        });

      router.push(`/reservations/${id}`);
    } catch (e) { setMsg(e.message); }
  };

  return (
    <AppShell me={me} logout={logout}>
      <section className="glass card-lg stack">
        <div className="app-banner">
          <div className="row-between" style={{ marginBottom: 0 }}>
            <div className="stack" style={{ gap: 6 }}>
              <span className="eyebrow">Checkout Snapshot</span>
              <h3 style={{ margin: 0 }}>{row?.reservationNumber || `Reservation ${id}`}</h3>
              <p className="ui-muted">
                Confirm the assigned vehicle, signer, and checkout readiness before capturing the signature and closing the handoff.
              </p>
            </div>
            <span className={`status-chip ${form.vehicleId && form.signerName ? 'good' : 'warn'}`}>
              {form.vehicleId && form.signerName ? 'Ready to sign' : 'Needs setup'}
            </span>
          </div>
          <div className="app-card-grid compact">
            <div className="info-tile">
              <span className="label">Customer</span>
              <strong>{[row?.customer?.firstName, row?.customer?.lastName].filter(Boolean).join(' ') || row?.customer?.email || '-'}</strong>
            </div>
            <div className="info-tile">
              <span className="label">Vehicle</span>
              <strong>{selectedVehicle ? [selectedVehicle.year, selectedVehicle.make, selectedVehicle.model].filter(Boolean).join(' ') : 'Select vehicle'}</strong>
            </div>
            <div className="info-tile">
              <span className="label">Pickup</span>
              <strong>{row?.pickupAt ? new Date(row.pickupAt).toLocaleString() : '-'}</strong>
            </div>
            <div className="info-tile">
              <span className="label">Readiness</span>
              <strong>{form.signerName && form.vehicleId ? 'Ready to sign' : 'Needs setup'}</strong>
            </div>
          </div>
        </div>

        <div className="row-between"><h2>Check-out Wizard</h2><button onClick={() => router.push(`/reservations/${id}`)}>Back</button></div>
        <div className="label" style={{ textTransform: 'none', letterSpacing: 0, marginBottom: 8 }}>Reservation: {row?.reservationNumber || '-'}</div>
        {msg ? <div className="label" style={{ color: '#b91c1c' }}>{msg}</div> : null}

        <div className="grid2">
          <div className="stack"><label className="label">Vehicle</label><select value={form.vehicleId} onChange={(e) => setForm({ ...form, vehicleId: e.target.value })}><option value="">Select available vehicle</option>{vehicles.map((v) => <option key={v.id} value={v.id}>{v.year || ''} {v.make || ''} {v.model || ''} • {v.plate || v.licensePlate || ''}</option>)}</select></div>
          <div className="stack"><label className="label">Signer Name</label><input value={form.signerName} onChange={(e) => setForm({ ...form, signerName: e.target.value })} /></div>
          <div className="stack"><label className="label">Odometer Out</label><input type="number" min="0" value={form.odometerOut} onChange={(e) => setForm({ ...form, odometerOut: e.target.value })} /></div>
          <div className="stack"><label className="label">Fuel Out</label><select value={form.fuelOut} onChange={(e) => setForm({ ...form, fuelOut: e.target.value })}>{['0.000','0.125','0.250','0.375','0.500','0.625','0.750','0.875','1.000'].map((v, i) => <option key={v} value={v}>{i}/8</option>)}</select></div>
          <div className="stack"><label className="label">Cleanliness Out (1-5)</label><input type="number" min="1" max="5" value={form.cleanlinessOut} onChange={(e) => setForm({ ...form, cleanlinessOut: e.target.value })} /></div>
          {(requireFranchise || franchises.length > 0) && (
            <div className="stack">
              <label className="label">Franchise{requireFranchise ? ' *' : ''}</label>
              <select value={form.franchiseId} onChange={(e) => setForm({ ...form, franchiseId: e.target.value })}>
                <option value="">{requireFranchise ? 'Select franchise (required)' : '— No franchise —'}</option>
                {franchises.map((f) => <option key={f.id} value={f.id}>{f.name}{f.code ? ` (${f.code})` : ''}</option>)}
              </select>
            </div>
          )}
        </div>

        <div className="row-between" style={{ marginTop: 8 }}>
          <label className="label">Customer Signature</label>
          <button onClick={() => router.push(`/reservations/${id}/inspection?phase=CHECKOUT&returnTo=checkout`)}>Open Inspection Wizard</button>
        </div>
        <canvas ref={sigRef} width={900} height={220} style={{ width: '100%', border: '1px solid #d1d5db', borderRadius: 8, background: '#fff', touchAction: 'none', cursor: 'crosshair' }} onPointerDown={begin} onPointerMove={move} onPointerUp={end} onPointerCancel={end} onPointerLeave={end} />
        <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 8 }}>
          <button onClick={clearSig}>Clear Signature</button>
          <button className="ios-action-btn" onClick={complete}>Complete Check-out</button>
        </div>

        {/* Checkout validation error popup */}
        {checkoutErrors && (
          <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 9999 }} onClick={() => setCheckoutErrors(null)}>
            <div style={{ background: '#fff', borderRadius: 16, padding: 28, maxWidth: 480, width: '90%', boxShadow: '0 24px 48px rgba(0,0,0,0.15)' }} onClick={(e) => e.stopPropagation()}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16 }}>
                <span style={{ fontSize: 28 }}>&#9888;</span>
                <div>
                  <h3 style={{ margin: 0, fontSize: 18, fontWeight: 800, color: '#1e2847' }}>Unable to Complete Check-out</h3>
                  <p style={{ margin: '4px 0 0', fontSize: 13, color: '#6b7a9a' }}>The following items must be resolved before the contract can be checked out:</p>
                </div>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                {checkoutErrors.map((err, idx) => (
                  <div key={idx} style={{ padding: '10px 14px', borderRadius: 10, background: '#fef2f2', border: '1px solid #fecaca' }}>
                    <div style={{ fontWeight: 700, fontSize: 14, color: '#991b1b', marginBottom: 2 }}>{err.field}</div>
                    <div style={{ fontSize: 13, color: '#7f1d1d' }}>{err.detail}</div>
                  </div>
                ))}
              </div>
              <div style={{ marginTop: 16, display: 'flex', justifyContent: 'flex-