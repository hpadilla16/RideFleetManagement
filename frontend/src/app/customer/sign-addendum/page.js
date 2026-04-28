'use client';

import { useEffect, useRef, useState } from 'react';
import { API_BASE } from '../../../lib/client';
import { PortalFrame, portalStyles } from '../_components/PortalFrame';

// Public, token-based customer self-service signing of a rental agreement
// addendum. Mirrors /customer/sign-agreement but targets the new
// /api/public/addendum-signature/:token endpoints. No JWT — the URL token
// IS the auth.

const SIGNATURE_DRAFT_PREFIX = 'customer.addendum.signature.';

function signatureDraftKey(token) {
  return `${SIGNATURE_DRAFT_PREFIX}${token}`;
}

function restoreSignatureDraft(token) {
  if (!token || typeof window === 'undefined') return null;
  try {
    const raw = localStorage.getItem(signatureDraftKey(token));
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    return {
      signerName: typeof parsed.signerName === 'string' ? parsed.signerName : '',
      accepted: !!parsed.accepted
    };
  } catch {
    return null;
  }
}

const fmt = (d) => (d ? new Date(d).toLocaleString() : '-');

export default function SignAddendumPage() {
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
  const [addendum, setAddendum] = useState(null);
  const [agreement, setAgreement] = useState(null);
  const [signerName, setSignerName] = useState('');
  const [accepted, setAccepted] = useState(false);

  const signatureReady = !!signerName.trim() && accepted;
  const canSign = addendum && String(addendum.status || '').toUpperCase() === 'PENDING_SIGNATURE';

  useEffect(() => {
    const run = async () => {
      if (!token) return;
      try {
        const res = await fetch(
          `${API_BASE}/api/public/addendum-signature/${encodeURIComponent(token)}`
        );
        const j = await res.json();
        if (!res.ok) throw new Error(j?.error || 'Unable to load addendum');
        setAddendum(j.addendum);
        setAgreement(j.agreement);
        const draft = restoreSignatureDraft(token);
        if (draft) {
          setSignerName(draft.signerName || '');
          setAccepted(!!draft.accepted);
        }
        setLoaded(true);
      } catch (e) {
        setError(String(e.message || e));
      }
    };
    run();
  }, [token]);

  useEffect(() => {
    if (!token) return;
    try {
      if (signerName.trim() || accepted) {
        localStorage.setItem(
          signatureDraftKey(token),
          JSON.stringify({ signerName, accepted })
        );
      } else {
        localStorage.removeItem(signatureDraftKey(token));
      }
    } catch {}
  }, [accepted, signerName, token]);

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
      if (!accepted) return setError('Please accept the terms');

      const c = canvasRef.current;
      if (!c) return setError('Signature pad unavailable');
      const signatureDataUrl = c.toDataURL('image/png');
      if (!signatureDataUrl || signatureDataUrl.length < 2000) {
        return setError('Please draw your signature');
      }

      const res = await fetch(
        `${API_BASE}/api/public/addendum-signature/${encodeURIComponent(token)}/signature`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ signerName: signerName.trim(), signatureDataUrl })
        }
      );
      const j = await res.json();
      if (!res.ok) throw new Error(j?.error || 'Unable to submit signature');
      setOk(j?.message || 'Thank you. Your signature has been captured successfully.');
      setError('');
      try {
        localStorage.removeItem(signatureDraftKey(token));
      } catch {}
      // Reflect signed status locally so the canvas swaps to the "already
      // signed" message without needing a page reload.
      setAddendum((prev) =>
        prev
          ? { ...prev, status: 'SIGNED', signatureSignedAt: new Date().toISOString(), signatureSignedBy: signerName.trim() }
          : prev
      );
    } catch (e) {
      setError(String(e.message || e));
    }
  };

  const notices = (
    <div style={portalStyles.stack}>
      {!loaded && !error ? (
        <div style={{ ...portalStyles.notice, background: 'rgba(79, 70, 229, 0.08)', color: '#4338ca' }}>
          Loading your addendum...
        </div>
      ) : null}
      {error ? (
        <div style={{ ...portalStyles.notice, background: 'rgba(220, 38, 38, 0.12)', color: '#991b1b' }}>
          {error}
        </div>
      ) : null}
      {ok ? (
        <div style={{ ...portalStyles.notice, background: 'rgba(22, 163, 74, 0.12)', color: '#166534' }}>
          {ok}
        </div>
      ) : null}
    </div>
  );

  return (
    <PortalFrame
      eyebrow={agreement?.tenantName || 'Ride Fleet Self-Service'}
      title="Review and Sign Your Addendum"
      subtitle="An update has been made to your rental agreement. Please review the new dates, accept the terms, and sign below."
    >
      {notices}

      {loaded && addendum && agreement ? (
        <>
          <div style={portalStyles.card}>
            <h2 style={portalStyles.cardTitle}>Addendum Summary</h2>
            <div style={portalStyles.statGrid}>
              <div style={portalStyles.statTile}>
                <div style={portalStyles.statLabel}>Agreement</div>
                <div style={portalStyles.statValue}>{agreement.agreementNumber || '-'}</div>
              </div>
              <div style={portalStyles.statTile}>
                <div style={portalStyles.statLabel}>Customer</div>
                <div style={portalStyles.statValue}>{agreement.customerName || '-'}</div>
              </div>
              <div style={portalStyles.statTile}>
                <div style={portalStyles.statLabel}>Reservation</div>
                <div style={portalStyles.statValue}>{agreement.reservationNumber || '-'}</div>
              </div>
              <div style={portalStyles.statTile}>
                <div style={portalStyles.statLabel}>Status</div>
                <div style={portalStyles.statValue}>{addendum.status || '-'}</div>
              </div>
            </div>
          </div>

          <div style={portalStyles.card}>
            <h2 style={portalStyles.cardTitle}>Updated Rental Dates</h2>
            <div style={portalStyles.statGrid}>
              <div style={portalStyles.statTile}>
                <div style={portalStyles.statLabel}>New Pickup</div>
                <div style={portalStyles.statValue}>{fmt(addendum.pickupAt)}</div>
              </div>
              <div style={portalStyles.statTile}>
                <div style={portalStyles.statLabel}>New Return</div>
                <div style={portalStyles.statValue}>{fmt(addendum.returnAt)}</div>
              </div>
            </div>
            {agreement.reservationPickupAt || agreement.reservationReturnAt ? (
              <div style={{ marginTop: 14, color: '#55456f', lineHeight: 1.6 }}>
                <div>
                  <strong>Original pickup on file:</strong> {fmt(agreement.reservationPickupAt)}
                </div>
                <div>
                  <strong>Original return on file:</strong> {fmt(agreement.reservationReturnAt)}
                </div>
              </div>
            ) : null}
          </div>

          <div style={portalStyles.card}>
            <h2 style={portalStyles.cardTitle}>Reason for Change</h2>
            <div style={{ color: '#55456f', lineHeight: 1.6 }}>
              {addendum.reason || '-'}
              {addendum.reasonCategory ? (
                <span style={{ marginLeft: 8, fontSize: 13, color: '#746294' }}>
                  ({addendum.reasonCategory})
                </span>
              ) : null}
            </div>
          </div>

          {canSign ? (
            <div style={portalStyles.card}>
              <h2 style={portalStyles.cardTitle}>Digital Signature</h2>
              <div style={{ display: 'grid', gap: 12 }}>
                <div>
                  <label style={portalStyles.sectionTitle}>Signer Name</label>
                  <input
                    style={portalStyles.input}
                    value={signerName}
                    onChange={(e) => setSignerName(e.target.value)}
                  />
                </div>

                <div>
                  <label style={portalStyles.sectionTitle}>Signature</label>
                  <canvas
                    ref={canvasRef}
                    width={860}
                    height={220}
                    style={{
                      width: '100%',
                      border: '1px solid rgba(102, 79, 177, 0.18)',
                      borderRadius: 20,
                      background: '#fff'
                    }}
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
                  <button onClick={clearSig} style={portalStyles.secondaryButton}>
                    Clear Signature
                  </button>
                </div>

                <label style={{ color: '#55456f', lineHeight: 1.6 }}>
                  <input
                    type="checkbox"
                    checked={accepted}
                    onChange={(e) => setAccepted(e.target.checked)}
                  />{' '}
                  I have reviewed the new dates and accept this addendum to my rental agreement.
                </label>

                <div>
                  <button onClick={submit} style={portalStyles.button} disabled={!signatureReady}>
                    Submit Signature
                  </button>
                </div>
              </div>
            </div>
          ) : (
            <div style={portalStyles.card}>
              <div style={{ color: '#55456f', lineHeight: 1.6 }}>
                {String(addendum.status || '').toUpperCase() === 'SIGNED' ? (
                  <>
                    This addendum has been signed
                    {addendum.signatureSignedAt ? <> on {fmt(addendum.signatureSignedAt)}</> : null}
                    {addendum.signatureSignedBy ? <> by {addendum.signatureSignedBy}</> : null}.
                    Thank you.
                  </>
                ) : String(addendum.status || '').toUpperCase() === 'VOID' ? (
                  <>This addendum has been voided and cannot be signed.</>
                ) : (
                  <>This addendum is not currently available for signature.</>
                )}
              </div>
            </div>
          )}
        </>
      ) : null}
    </PortalFrame>
  );
}
