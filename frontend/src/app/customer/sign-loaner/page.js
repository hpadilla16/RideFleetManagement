'use client';

import { useEffect, useRef, useState } from 'react';
import { API_BASE } from '../../../lib/client';
import { PortalFrame, portalStyles } from '../_components/PortalFrame';

// Public, token-based remote signing of a dealership loaner agreement.
// Mirrors /customer/sign-addendum but targets the
// /api/public/loaner-signature/:token endpoints. No JWT — the URL token IS
// the auth. The token is single-use (consumed on submit), so a reload after
// signing returns 404 ("link no longer valid").

const fmt = (d) => (d ? new Date(d).toLocaleString() : '-');

export default function SignLoanerPage() {
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
  const [agreement, setAgreement] = useState(null);
  const [signerName, setSignerName] = useState('');
  const [accepted, setAccepted] = useState(false);
  const [signed, setSigned] = useState(false);

  const signatureReady = !!signerName.trim() && accepted;

  useEffect(() => {
    const run = async () => {
      if (!token) return;
      try {
        const res = await fetch(`${API_BASE}/api/public/loaner-signature/${encodeURIComponent(token)}`);
        const j = await res.json();
        if (!res.ok) throw new Error(j?.error || 'Unable to load loaner agreement');
        setAgreement(j);
        if (j?.signature?.signed) setSigned(true);
        if (j?.customer) setSignerName([j.customer.firstName, j.customer.lastName].filter(Boolean).join(' '));
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
    c.getContext('2d').clearRect(0, 0, c.width, c.height);
  };

  const submit = async () => {
    try {
      if (!token) return setError('Missing token');
      if (!signerName.trim()) return setError('Please enter your name');
      if (!accepted) return setError('Please accept the terms');
      const c = canvasRef.current;
      if (!c) return setError('Signature pad unavailable');
      const signatureDataUrl = c.toDataURL('image/png');
      if (!signatureDataUrl || signatureDataUrl.length < 2000) return setError('Please draw your signature');

      const res = await fetch(`${API_BASE}/api/public/loaner-signature/${encodeURIComponent(token)}/signature`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ signerName: signerName.trim(), signatureDataUrl })
      });
      const j = await res.json();
      if (!res.ok) throw new Error(j?.error || 'Unable to submit signature');
      setOk(j?.message || 'Signature captured. Thank you.');
      setError('');
      setSigned(true);
    } catch (e) {
      setError(String(e.message || e));
    }
  };

  const notices = (
    <div style={portalStyles.stack}>
      {!loaded && !error ? (
        <div style={{ ...portalStyles.notice, background: 'rgba(79, 70, 229, 0.08)', color: '#4338ca' }}>Loading your loaner agreement...</div>
      ) : null}
      {error ? (
        <div style={{ ...portalStyles.notice, background: 'rgba(220, 38, 38, 0.12)', color: '#991b1b' }}>{error}</div>
      ) : null}
      {ok ? (
        <div style={{ ...portalStyles.notice, background: 'rgba(22, 163, 74, 0.12)', color: '#166534' }}>{ok}</div>
      ) : null}
    </div>
  );

  const customerName = agreement?.customer ? [agreement.customer.firstName, agreement.customer.lastName].filter(Boolean).join(' ') : '-';

  return (
    <PortalFrame
      eyebrow={agreement?.reservation?.reservationNumber ? 'Dealership Loaner' : 'Self-Service'}
      title="Review and Sign Your Loaner Agreement"
      subtitle="Please review the loaner details, accept the terms, and sign below to complete your check-out."
    >
      {notices}

      {loaded && agreement ? (
        <>
          <div style={portalStyles.card}>
            <h2 style={portalStyles.cardTitle}>Loaner Summary</h2>
            <div style={portalStyles.statGrid}>
              <div style={portalStyles.statTile}>
                <div style={portalStyles.statLabel}>Agreement</div>
                <div style={portalStyles.statValue}>{agreement.agreementNumber || '-'}</div>
              </div>
              <div style={portalStyles.statTile}>
                <div style={portalStyles.statLabel}>Customer</div>
                <div style={portalStyles.statValue}>{customerName}</div>
              </div>
              <div style={portalStyles.statTile}>
                <div style={portalStyles.statLabel}>Repair order</div>
                <div style={portalStyles.statValue}>{agreement.reservation?.repairOrderNumber || '-'}</div>
              </div>
              <div style={portalStyles.statTile}>
                <div style={portalStyles.statLabel}>Due back</div>
                <div style={portalStyles.statValue}>{fmt(agreement.returnAt)}</div>
              </div>
            </div>
          </div>

          <div style={portalStyles.card}>
            <h2 style={portalStyles.cardTitle}>Terms</h2>
            <div style={{ color: '#55456f', lineHeight: 1.6 }}>
              I agree to return the loaner vehicle in the condition received, with fuel at the level recorded at
              check-out, and accept responsibility for tolls, citations, and damage not documented at check-out.
            </div>
          </div>

          {signed ? (
            <div style={portalStyles.card}>
              <div style={{ color: '#166534', lineHeight: 1.6, fontWeight: 600 }}>
                This loaner agreement has been signed. Thank you — you’re all set.
              </div>
            </div>
          ) : (
            <div style={portalStyles.card}>
              <h2 style={portalStyles.cardTitle}>Digital Signature</h2>
              <div style={{ display: 'grid', gap: 12 }}>
                <div>
                  <label style={portalStyles.sectionTitle}>Your name</label>
                  <input style={portalStyles.input} value={signerName} onChange={(e) => setSignerName(e.target.value)} />
                </div>
                <div>
                  <label style={portalStyles.sectionTitle}>Signature</label>
                  <canvas
                    ref={canvasRef}
                    width={860}
                    height={220}
                    style={{ width: '100%', border: '1px solid rgba(102, 79, 177, 0.18)', borderRadius: 20, background: '#fff' }}
                    onMouseDown={start} onMouseMove={move} onMouseUp={end} onMouseLeave={end}
                    onTouchStart={start} onTouchMove={move} onTouchEnd={end}
                  />
                </div>
                <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                  <button onClick={clearSig} style={portalStyles.secondaryButton}>Clear Signature</button>
                </div>
                <label style={{ color: '#55456f', lineHeight: 1.6 }}>
                  <input type="checkbox" checked={accepted} onChange={(e) => setAccepted(e.target.checked)} />{' '}
                  I have reviewed the loaner details and accept the terms above.
                </label>
                <div>
                  <button onClick={submit} style={portalStyles.button} disabled={!signatureReady}>Submit Signature</button>
                </div>
              </div>
            </div>
          )}
        </>
      ) : null}
    </PortalFrame>
  );
}
