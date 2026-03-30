'use client';

import { useEffect, useRef, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { AuthGate } from '../../../../components/AuthGate';
import { AppShell } from '../../../../components/AppShell';
import { api, API_BASE } from '../../../../lib/client';

export default function Page() {
  return <AuthGate>{({ token, me, logout }) => <Inner token={token} me={me} logout={logout} />}</AuthGate>;
}

function Inner({ token, me, logout }) {
  const { id } = useParams();
  const router = useRouter();
  const [row, setRow] = useState(null);
  const [vehicles, setVehicles] = useState([]);
  const [msg, setMsg] = useState('');
  const [form, setForm] = useState({ vehicleId: '', odometerOut: '', fuelOut: '1.000', cleanlinessOut: '5', signerName: '' });
  const sigRef = useRef(null);
  const drawing = useRef(false);
  const selectedVehicle = vehicles.find((vehicle) => String(vehicle.id) === String(form.vehicleId)) || null;

  const load = async () => {
    setMsg('');
    const r = await api(`/api/reservations/${id}`, {}, token);
    setRow(r);
    setForm((f) => ({ ...f, vehicleId: r?.vehicleId || '', signerName: `${r?.customer?.firstName || ''} ${r?.customer?.lastName || ''}`.trim() }));
    try {
      const av = await api(`/api/reservations/${id}/available-vehicles`, {}, token);
      setVehicles(Array.isArray(av) ? av : []);
    } catch (e) {
      setVehicles([]);
      setMsg(String(e?.message || 'Unable to load available vehicles for this tenant.'));
    }
  };
  useEffect(() => {
    if (!id || !token) return;
    load().catch((e) => setMsg(String(e?.message || 'Unable to load checkout wizard.')));
  }, [id, token]);

  const ensureAgreementId = async () => {
    const out = await api(`/api/reservations/${id}/start-rental`, { method: 'POST', body: JSON.stringify({}) }, token);
    return out?.id;
  };

  const ensureCheckoutInspectionComplete = async (agreementId) => {
    const report = await api(`/api/rental-agreements/${agreementId}/inspection-report`, {}, token);
    if (!report?.checkoutInspection?.at) {
      throw new Error('Checkout inspection is required before completing check-out');
    }
    return report;
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
      if (!form.vehicleId) return setMsg('Select a vehicle');
      if (!form.odometerOut) return setMsg('Odometer out is required');
      const signer = String(form.signerName || '').trim();
      const signatureDataUrl = sig();
      if (!signer || !signatureDataUrl) return setMsg('Customer signature is required');

      const checkoutLine = `[RES_CHECKOUT ${new Date().toISOString()}] odometerOut=${Number(form.odometerOut || 0)} fuelOut=${Number(form.fuelOut || 0)} cleanlinessOut=${Number(form.cleanlinessOut || 5)}`;
      const baseNotes = String(row?.notes || '').trim();
      const nextNotes = `${baseNotes}${baseNotes ? '\n' : ''}${checkoutLine}`;

      await api(`/api/reservations/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          vehicleId: form.vehicleId,
          notes: nextNotes
        })
      }, token);

      const agreementId = await ensureAgreementId();
      if (!agreementId) throw new Error('No rental agreement available for checkout');

      await api(`/api/rental-agreements/${agreementId}/rental`, {
        method: 'PUT',
        body: JSON.stringify({
          vehicleId: form.vehicleId,
          odometerOut: Number(form.odometerOut || 0),
          fuelOut: Number(form.fuelOut || 0),
          cleanlinessOut: Number(form.cleanlinessOut || 5)
        })
      }, token);

      await ensureCheckoutInspectionComplete(agreementId);

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
      try {
        await api(`/api/rental-agreements/${agreementId}/email-agreement`, { method: 'POST', body: JSON.stringify({}) }, token);
      } catch {
        // Non-blocking: checkout already completed.
      }

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
      </section>
    </AppShell>
  );
}
