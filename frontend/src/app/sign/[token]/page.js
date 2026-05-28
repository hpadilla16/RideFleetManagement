'use client';

/**
 * Customer T&C signing page — opens on the customer's phone after they
 * scan the QR shown on the agent's screen (and customer display) in
 * step 2 of checkout-wizard-v2.
 *
 * NO auth — the token in the URL is the auth. Backend re-validates on
 * every endpoint call (kind = TERMS_SIGNING, not expired, not consumed).
 *
 * Flow:
 *   1. Load /api/sign/:token → { sections[], agreementNumber, ... }
 *   2. For each section: show body text + initial pad, post initial on
 *      tap-away.
 *   3. After all sections initialed, customer types name + draws full
 *      signature, taps Complete. Posts to /api/sign/:token/complete
 *      which stamps tcCompletedAt on the CheckoutSession.
 *   4. Agent screen polls the session 1.5s/cycle and advances to step 3
 *      automatically when tcCompletedAt becomes non-null.
 *
 * Phone-first layout — fluid full-width on narrow viewports, padded
 * card on wider. No nav chrome.
 */

import { useEffect, useRef, useState } from 'react';
import { useParams } from 'next/navigation';
import { api } from '../../../lib/client';

export default function Page() {
  const params = useParams();
  const token = params?.token;
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  const [completed, setCompleted] = useState(false);

  // Load token + sections on mount.
  useEffect(() => {
    if (!token) return;
    (async () => {
      try {
        const json = await api(`/api/sign/${token}`, { bypassCache: true });
        setData(json);
      } catch (err) {
        setError(err?.message || 'Failed to load');
      } finally {
        setLoading(false);
      }
    })();
  }, [token]);

  if (loading) return <ShellMessage>Loading…</ShellMessage>;
  if (error) return <ShellMessage tone="error">{error}</ShellMessage>;
  if (completed) return <ShellMessage tone="ok">Thanks! Return to your rental agent.</ShellMessage>;
  if (!data) return null;

  return (
    <Shell title="Terms & Conditions" subtitle={`Agreement ${data.agreementNumber || ''}`}>
      <SignFlow token={token} data={data} onComplete={() => setCompleted(true)} onError={setError} />
    </Shell>
  );
}

// ---------------------------------------------------------------------------
// Sign flow — walks through sections, then final signature
// ---------------------------------------------------------------------------

function SignFlow({ token, data, onComplete, onError }) {
  const [sections, setSections] = useState(data.sections);
  const [signerName, setSignerName] = useState('');
  const [finalSig, setFinalSig] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const allInitialed = sections.every((s) => s.signed);
  const canComplete = allInitialed && signerName.trim().length >= 2 && finalSig.length > 200;

  const onInitialChange = async (sectionKey, dataUrl) => {
    // The initial pad fires this when the customer lifts their finger
    // with a non-trivial drawing.
    if (!dataUrl || dataUrl.length < 200) return;
    try {
      await api(`/api/sign/${token}/initials`, {
        method: 'POST',
        body: JSON.stringify({ sectionKey, initialDataUrl: dataUrl }),
      });
      setSections((curr) => curr.map((s) => (s.key === sectionKey ? { ...s, signed: true } : s)));
    } catch (err) {
      onError(err?.message || 'Save failed');
    }
  };

  const submitComplete = async () => {
    setSubmitting(true);
    try {
      await api(`/api/sign/${token}/complete`, {
        method: 'POST',
        body: JSON.stringify({ signatureDataUrl: finalSig, signerName: signerName.trim() }),
      });
      onComplete();
    } catch (err) {
      onError(err?.message || 'Complete failed');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div>
      <p style={hintTextStyle}>
        Read each section, initial inside the box at the bottom, then sign at the bottom of this page.
      </p>
      {sections.map((s, idx) => (
        <TermsSection
          key={s.key}
          index={idx + 1}
          total={sections.length}
          section={s}
          onInitial={(dataUrl) => onInitialChange(s.key, dataUrl)}
        />
      ))}
      <hr style={{ margin: '24px 0', border: 'none', borderTop: '0.5px solid #E5E7EB' }} />
      <div style={{ marginBottom: 12 }}>
        <label style={labelStyle}>Type your full name</label>
        <input
          type="text"
          value={signerName}
          onChange={(e) => setSignerName(e.target.value)}
          placeholder="First Last"
          style={inputStyle}
        />
      </div>
      <div style={{ marginBottom: 16 }}>
        <label style={labelStyle}>Sign in the box below</label>
        <SigPad height={140} onChange={setFinalSig} />
      </div>
      <button
        style={{ ...primaryBtn, opacity: canComplete && !submitting ? 1 : 0.4 }}
        disabled={!canComplete || submitting}
        onClick={submitComplete}
      >
        {submitting ? 'Submitting…' : `Complete (${sections.filter((s) => s.signed).length}/${sections.length} initials)`}
      </button>
    </div>
  );
}

function TermsSection({ index, total, section, onInitial }) {
  return (
    <div style={{
      padding: 16, marginBottom: 12,
      background: section.signed ? '#ECFDF5' : '#FFFFFF',
      border: `0.5px solid ${section.signed ? '#10B981' : '#E5E7EB'}`,
      borderRadius: 10,
    }}>
      <div style={{ fontSize: 11, color: '#6B7280', marginBottom: 4 }}>
        Section {index} of {total}
      </div>
      <h3 style={{ margin: '0 0 8px', fontSize: 15, fontWeight: 600 }}>
        {section.label}
      </h3>
      <p style={{ fontSize: 13, color: '#374151', lineHeight: 1.5, margin: '0 0 12px' }}>
        {section.body}
      </p>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
        <span style={{ fontSize: 12, color: '#6B7280' }}>
          {section.signed ? '✓ Initialed' : 'Initial here →'}
        </span>
        <InitialPad
          width={120} height={60}
          signed={section.signed}
          onChange={onInitial}
        />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tiny inline initial pad — narrower than SignaturePad, suits a phone
// in portrait. Reuses the same touch+mouse logic, no name field, no
// helper text.
// ---------------------------------------------------------------------------

function InitialPad({ width = 120, height = 60, signed, onChange }) {
  return <CanvasPad width={width} height={height} disabled={signed} onChange={onChange} />;
}

function SigPad({ height = 140, onChange }) {
  return <CanvasPad height={height} onChange={onChange} fullWidth />;
}

function CanvasPad({ width, height, fullWidth = false, disabled = false, onChange }) {
  const canvasRef = useRef(null);
  const [drawing, setDrawing] = useState(false);
  const [hasContent, setHasContent] = useState(false);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const resize = () => {
      const parent = canvas.parentElement;
      const w = fullWidth ? parent.clientWidth - 2 : width;
      const dpr = window.devicePixelRatio || 1;
      canvas.style.width = w + 'px';
      canvas.style.height = height + 'px';
      canvas.width = w * dpr;
      canvas.height = height * dpr;
      const ctx = canvas.getContext('2d');
      ctx.scale(dpr, dpr);
      ctx.fillStyle = '#FFFFFF';
      ctx.fillRect(0, 0, w, height);
      ctx.strokeStyle = '#1F2937';
      ctx.lineWidth = 2;
      ctx.lineCap = 'round';
    };
    resize();
    window.addEventListener('resize', resize);
    return () => window.removeEventListener('resize', resize);
  }, [width, height, fullWidth]);

  const pointFromEvent = (e) => {
    const canvas = canvasRef.current;
    const rect = canvas.getBoundingClientRect();
    const t = e.touches?.[0];
    const clientX = t ? t.clientX : e.clientX;
    const clientY = t ? t.clientY : e.clientY;
    return { x: clientX - rect.left, y: clientY - rect.top };
  };

  const start = (e) => {
    if (disabled) return;
    e.preventDefault();
    setDrawing(true);
    const ctx = canvasRef.current.getContext('2d');
    const p = pointFromEvent(e);
    ctx.beginPath();
    ctx.moveTo(p.x, p.y);
  };
  const move = (e) => {
    if (!drawing || disabled) return;
    e.preventDefault();
    const ctx = canvasRef.current.getContext('2d');
    const p = pointFromEvent(e);
    ctx.lineTo(p.x, p.y);
    ctx.stroke();
    setHasContent(true);
  };
  const end = () => {
    if (!drawing) return;
    setDrawing(false);
    if (hasContent && onChange) {
      const dataUrl = canvasRef.current.toDataURL('image/png');
      onChange(dataUrl);
    }
  };

  const clear = () => {
    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#FFFFFF';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    setHasContent(false);
    if (onChange) onChange('');
  };

  return (
    <div style={{ position: 'relative', display: 'inline-block' }}>
      <canvas
        ref={canvasRef}
        style={{
          border: `0.5px ${disabled ? 'solid #10B981' : 'dashed #9CA3AF'}`,
          borderRadius: 6,
          background: '#FFFFFF',
          touchAction: 'none',
          opacity: disabled ? 0.5 : 1,
        }}
        onMouseDown={start} onMouseMove={move} onMouseUp={end} onMouseLeave={end}
        onTouchStart={start} onTouchMove={move} onTouchEnd={end}
      />
      {!disabled && hasContent && (
        <button onClick={clear} style={clearBtnStyle}>Clear</button>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Shell
// ---------------------------------------------------------------------------

function Shell({ title, subtitle, children }) {
  return (
    <div style={{ minHeight: '100vh', background: '#F9FAFB', padding: '16px', boxSizing: 'border-box' }}>
      <div style={{ maxWidth: 480, margin: '0 auto' }}>
        <div style={{ marginBottom: 16, padding: '12px 4px' }}>
          <div style={{ fontWeight: 700, fontSize: 18, color: '#111827' }}>{title}</div>
          {subtitle && <div style={{ color: '#6B7280', fontSize: 13, marginTop: 2 }}>{subtitle}</div>}
        </div>
        {children}
      </div>
    </div>
  );
}

function ShellMessage({ children, tone = 'neutral' }) {
  const color = tone === 'error' ? '#B91C1C' : tone === 'ok' ? '#065F46' : '#374151';
  return (
    <div style={{ minHeight: '100vh', background: '#F9FAFB', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
      <div style={{
        background: '#FFFFFF', padding: 24, borderRadius: 12,
        maxWidth: 360, width: '100%', textAlign: 'center',
        border: '0.5px solid #E5E7EB',
      }}>
        <div style={{ color, fontSize: 15 }}>{children}</div>
      </div>
    </div>
  );
}

const labelStyle = { display: 'block', fontSize: 12, color: '#6B7280', marginBottom: 4 };
const inputStyle = {
  width: '100%', padding: '10px 12px', fontSize: 15,
  border: '0.5px solid #D1D5DB', borderRadius: 6, boxSizing: 'border-box',
};
const primaryBtn = {
  width: '100%', padding: '14px', background: '#1F2937', color: '#FFFFFF',
  border: 'none', borderRadius: 8, fontSize: 15, fontWeight: 500, cursor: 'pointer',
};
const hintTextStyle = { fontSize: 13, color: '#6B7280', margin: '0 0 16px' };
const clearBtnStyle = {
  position: 'absolute', top: 2, right: 2, fontSize: 10,
  background: 'rgba(255,255,255,0.95)', border: '0.5px solid #D1D5DB',
  padding: '2px 6px', borderRadius: 4, cursor: 'pointer',
};
