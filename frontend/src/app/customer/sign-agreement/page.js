'use client';

import { useEffect, useRef, useState } from 'react';
import { API_BASE } from '../../../lib/client';
import { PortalTimelineCard } from '../_components/PortalTimelineCard';

export default function SignAgreementPage() {
  const [token, setToken] = useState('');

  const canvasRef = useRef(null);

  useEffect(() => {
    const p = new URLSearchParams(window.location.search);
    setToken(p.get('token') || '');
  }, []);
  const [drawing, setDrawing] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState('');
  const [ok, setOk] = useState('');
  const [reservation, setReservation] = useState(null);
  const [breakdown, setBreakdown] = useState(null);
  const [termsText, setTermsText] = useState('');
  const [portal, setPortal] = useState(null);
  const [signerName, setSignerName] = useState('');
  const [accepted, setAccepted] = useState(false);

  useEffect(() => {
    const run = async () => {
      if (!token) return;
      try {
        const res = await fetch(`${API_BASE}/api/public/signature/${encodeURIComponent(token)}`);
        const j = await res.json();
        if (!res.ok) throw new Error(j?.error || 'Unable to load signature page');
        setReservation(j.reservation);
        setBreakdown(j.breakdown || null);
        setTermsText(j.termsText || '');
        setPortal(j.portal || null);
        setLoaded(true);
      } catch (e) {
        setError(String(e.message || e));
      }
    };
    run();
  }, [token]);

  const pos = (e) => {
    const c = canvasRef.current;
    if (!c) return null;
    const r = c.getBoundingClientRect();
    const p = e.touches?.[0] || e;
    return { x: p.clientX - r.left, y: p.clientY - r.top };
  };

  const start = (e) => {
    const c = canvasRef.current;
    if (!c) return;
    const ctx = c.getContext('2d');
    const p = pos(e);
    if (!p) return;
    ctx.beginPath();
    ctx.moveTo(p.x, p.y);
    setDrawing(true);
  };

  const move = (e) => {
    if (!drawing) return;
    const c = canvasRef.current;
    if (!c) return;
    const ctx = c.getContext('2d');
    const p = pos(e);
    if (!p) return;
    ctx.lineWidth = 2;
    ctx.lineCap = 'round';
    ctx.strokeStyle = '#111827';
    ctx.lineTo(p.x, p.y);
    ctx.stroke();
  };

  const end = () => setDrawing(false);

  const clearSig = () => {
    const c = canvasRef.current;
    if (!c) return;
    const ctx = c.getContext('2d');
    ctx.clearRect(0, 0, c.width, c.height);
  };

  const submit = async () => {
    try {
      if (!token) return setError('Missing token');
      if (!signerName.trim()) return setError('Please enter signer name');
      if (!accepted) return setError('Please accept terms');

      const c = canvasRef.current;
      if (!c) return setError('Signature pad unavailable');
      const signatureDataUrl = c.toDataURL('image/png');
      if (!signatureDataUrl || signatureDataUrl.length < 2000) return setError('Please draw your signature');

      const res = await fetch(`${API_BASE}/api/public/signature/${encodeURIComponent(token)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ signerName: signerName.trim(), signatureDataUrl })
      });
      const j = await res.json();
      if (!res.ok) throw new Error(j?.error || 'Unable to submit signature');
      const successMsg = j?.message || 'Thank you. Your signature has been captured successfully.';
      setOk(successMsg);
      setError('');
      if (j?.portal) setPortal(j.portal);
      if (j?.emailedSignedAgreement) {
        window.alert('Signed agreement has been sent to your email.');
      }
    } catch (e) {
      setError(String(e.message || e));
    }
  };

  return (
    <main style={{ maxWidth: 920, margin: '24px auto', padding: 16 }}>
      <h1>Sign Agreement</h1>
      {error ? <p style={{ color: '#b91c1c' }}>{error}</p> : null}
      {ok ? <p style={{ color: '#065f46' }}>{ok}</p> : null}

      {!loaded ? <p>Loading...</p> : (
        <div style={{ display: 'grid', gap: 14 }}>
          <div style={{ border: '1px solid #ddd', borderRadius: 8, padding: 12 }}>
            <strong>Reservation:</strong> {reservation?.reservationNumber}<br />
            <strong>Customer:</strong> {reservation?.customerName || '-'}<br />
            <strong>Vehicle:</strong> {reservation?.vehicle || '-'}<br />
            <strong>Pickup:</strong> {reservation?.pickupAt ? new Date(reservation.pickupAt).toLocaleString() : '-'} ({reservation?.pickupLocation || '-'})<br />
            <strong>Return:</strong> {reservation?.returnAt ? new Date(reservation.returnAt).toLocaleString() : '-'} ({reservation?.returnLocation || '-'})
          </div>

          <div style={{ border: '1px solid #ddd', borderRadius: 8, padding: 12 }}>
            <h3>Cost Breakdown</h3>
            <table style={{ width: '100%', minWidth: 0 }}>
              <tbody>
                {(breakdown?.charges || []).map((c, idx) => (
                  <tr key={idx}>
                    <td>{c.name}</td>
                    <td style={{ textAlign: 'right' }}>{Number(c.quantity || 0).toFixed(2)}</td>
                    <td style={{ textAlign: 'right' }}>${Number(c.rate || 0).toFixed(2)}</td>
                    <td style={{ textAlign: 'right' }}>${Number(c.total || 0).toFixed(2)}</td>
                  </tr>
                ))}
                <tr><td colSpan={3}><strong>Subtotal</strong></td><td style={{ textAlign: 'right' }}><strong>${Number(breakdown?.subtotal || 0).toFixed(2)}</strong></td></tr>
                <tr><td colSpan={3}>Taxes</td><td style={{ textAlign: 'right' }}>${Number(breakdown?.taxes || 0).toFixed(2)}</td></tr>
                <tr><td colSpan={3}>Paid</td><td style={{ textAlign: 'right' }}>${Number(breakdown?.paidAmount || 0).toFixed(2)}</td></tr>
                <tr><td colSpan={3}><strong>Balance</strong></td><td style={{ textAlign: 'right' }}><strong>${Number(breakdown?.balance || 0).toFixed(2)}</strong></td></tr>
              </tbody>
            </table>
          </div>

          <div style={{ border: '1px solid #ddd', borderRadius: 8, padding: 12, whiteSpace: 'pre-wrap' }}>
            <h3>Terms & Conditions</h3>
            {termsText || 'N/A'}
          </div>

          <div style={{ display: 'grid', gap: 8 }}>
            <label>Signer Name</label>
            <input value={signerName} onChange={(e) => setSignerName(e.target.value)} />

            <label>Signature</label>
            <canvas
              ref={canvasRef}
              width={860}
              height={220}
              style={{ width: '100%', border: '1px solid #9ca3af', borderRadius: 8, background: '#fff' }}
              onMouseDown={start}
              onMouseMove={move}
              onMouseUp={end}
              onMouseLeave={end}
              onTouchStart={start}
              onTouchMove={move}
              onTouchEnd={end}
            />
            <div style={{ display: 'flex', gap: 8 }}>
              <button onClick={clearSig}>Clear Signature</button>
            </div>

            <label><input type="checkbox" checked={accepted} onChange={(e) => setAccepted(e.target.checked)} /> I accept the terms and conditions.</label>
            <button onClick={submit}>Submit Signature</button>
          </div>

          <PortalTimelineCard portal={portal} />
        </div>
      )}
    </main>
  );
}
