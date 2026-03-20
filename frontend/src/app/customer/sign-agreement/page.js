'use client';

import { useEffect, useRef, useState } from 'react';
import { API_BASE } from '../../../lib/client';
import { PortalFrame, portalStyles } from '../_components/PortalFrame';
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
  const nextPortalStep = portal?.nextStep;

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
      setOk(j?.message || 'Thank you. Your signature has been captured successfully.');
      setError('');
      if (j?.portal) setPortal(j.portal);
      if (j?.emailedSignedAgreement) {
        window.alert('Signed agreement has been sent to your email.');
      }
    } catch (e) {
      setError(String(e.message || e));
    }
  };

  const notices = (
    <div style={portalStyles.stack}>
      {!loaded ? <div style={{ ...portalStyles.notice, background: 'rgba(79, 70, 229, 0.08)', color: '#4338ca' }}>Loading your agreement package...</div> : null}
      {error ? <div style={{ ...portalStyles.notice, background: 'rgba(220, 38, 38, 0.12)', color: '#991b1b' }}>{error}</div> : null}
      {ok ? <div style={{ ...portalStyles.notice, background: 'rgba(22, 163, 74, 0.12)', color: '#166534' }}>{ok}</div> : null}
    </div>
  );

  return (
    <PortalFrame
      eyebrow="Ride Fleet Self-Service"
      title="Review and Sign Your Agreement"
      subtitle="Review your reservation details, verify the full cost breakdown, and sign the agreement digitally in one secure step."
      aside={<PortalTimelineCard portal={portal} />}
    >
      {notices}

      {loaded ? (
        <>
          <div style={portalStyles.card}>
            <h2 style={portalStyles.cardTitle}>Reservation Summary</h2>
            <div style={portalStyles.statGrid}>
              <div style={portalStyles.statTile}>
                <div style={portalStyles.statLabel}>Reservation</div>
                <div style={portalStyles.statValue}>{reservation?.reservationNumber || '-'}</div>
              </div>
              <div style={portalStyles.statTile}>
                <div style={portalStyles.statLabel}>Customer</div>
                <div style={portalStyles.statValue}>{reservation?.customerName || '-'}</div>
              </div>
              <div style={portalStyles.statTile}>
                <div style={portalStyles.statLabel}>Vehicle</div>
                <div style={portalStyles.statValue}>{reservation?.vehicle || '-'}</div>
              </div>
              <div style={portalStyles.statTile}>
                <div style={portalStyles.statLabel}>Balance</div>
                <div style={portalStyles.statValue}>${Number(breakdown?.balance || 0).toFixed(2)}</div>
              </div>
            </div>
            <div style={{ marginTop: 14, color: '#55456f', lineHeight: 1.6 }}>
              <div><strong>Pickup:</strong> {reservation?.pickupAt ? new Date(reservation.pickupAt).toLocaleString() : '-'} ({reservation?.pickupLocation || '-'})</div>
              <div><strong>Return:</strong> {reservation?.returnAt ? new Date(reservation.returnAt).toLocaleString() : '-'} ({reservation?.returnLocation || '-'})</div>
            </div>
          </div>

          <div style={portalStyles.card}>
            <h2 style={portalStyles.cardTitle}>Cost Breakdown</h2>
            <table style={portalStyles.table}>
              <tbody>
                {(breakdown?.charges || []).map((c, idx) => (
                  <tr key={idx}>
                    <td style={{ ...portalStyles.tableCell, textAlign: 'left' }}>{c.name}</td>
                    <td style={{ ...portalStyles.tableCell, textAlign: 'right' }}>{Number(c.quantity || 0).toFixed(2)}</td>
                    <td style={{ ...portalStyles.tableCell, textAlign: 'right' }}>${Number(c.rate || 0).toFixed(2)}</td>
                    <td style={{ ...portalStyles.tableCell, textAlign: 'right' }}>${Number(c.total || 0).toFixed(2)}</td>
                  </tr>
                ))}
                <tr><td style={portalStyles.tableCell} colSpan={3}><strong>Subtotal</strong></td><td style={{ ...portalStyles.tableCell, textAlign: 'right' }}><strong>${Number(breakdown?.subtotal || 0).toFixed(2)}</strong></td></tr>
                <tr><td style={portalStyles.tableCell} colSpan={3}>Taxes</td><td style={{ ...portalStyles.tableCell, textAlign: 'right' }}>${Number(breakdown?.taxes || 0).toFixed(2)}</td></tr>
                <tr><td style={portalStyles.tableCell} colSpan={3}>Paid</td><td style={{ ...portalStyles.tableCell, textAlign: 'right' }}>${Number(breakdown?.paidAmount || 0).toFixed(2)}</td></tr>
                <tr><td style={portalStyles.tableCell} colSpan={3}><strong>Balance</strong></td><td style={{ ...portalStyles.tableCell, textAlign: 'right' }}><strong>${Number(breakdown?.balance || 0).toFixed(2)}</strong></td></tr>
              </tbody>
            </table>
          </div>

          <div style={portalStyles.card}>
            <h2 style={portalStyles.cardTitle}>Terms & Conditions</h2>
            <div style={{ whiteSpace: 'pre-wrap', lineHeight: 1.7, color: '#55456f' }}>{termsText || 'N/A'}</div>
          </div>

          <div style={portalStyles.card}>
            <h2 style={portalStyles.cardTitle}>Digital Signature</h2>
            <div style={{ display: 'grid', gap: 12 }}>
              <div>
                <label style={portalStyles.sectionTitle}>Signer Name</label>
                <input style={portalStyles.input} value={signerName} onChange={(e) => setSignerName(e.target.value)} />
              </div>

              <div>
                <label style={portalStyles.sectionTitle}>Signature</label>
                <canvas
                  ref={canvasRef}
                  width={860}
                  height={220}
                  style={{ width: '100%', border: '1px solid rgba(102, 79, 177, 0.18)', borderRadius: 20, background: '#fff' }}
                  onMouseDown={start}
                  onMouseMove={move}
                  onMouseUp={end}
                  onMouseLeave={end}
                  onTouchStart={start}
                  onTouchMove={move}
                  onTouchEnd={end}
                />
              </div>

              <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                <button onClick={clearSig} style={portalStyles.secondaryButton}>Clear Signature</button>
              </div>

              <label style={{ color: '#55456f', lineHeight: 1.6 }}>
                <input type="checkbox" checked={accepted} onChange={(e) => setAccepted(e.target.checked)} /> I accept the terms and conditions.
              </label>

              <div>
                <button onClick={submit} style={portalStyles.button}>Submit Signature</button>
              </div>
              {nextPortalStep?.key && nextPortalStep.key !== 'signature' && nextPortalStep.link ? (
                <div style={{ display: 'grid', gap: 8 }}>
                  <div style={{ color: '#55456f', lineHeight: 1.6 }}>
                    Once this step is complete, continue directly to the next guest action.
                  </div>
                  <div className="inline-actions">
                    <a href={nextPortalStep.link} target="_blank" rel="noreferrer" style={{ textDecoration: 'none' }}>
                      <button type="button" className="button-subtle">Continue to {nextPortalStep.label}</button>
                    </a>
                  </div>
                </div>
              ) : null}
            </div>
          </div>
        </>
      ) : null}
    </PortalFrame>
  );
}
