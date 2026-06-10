'use client';

/**
 * Mobile inspection capture — opens on the agent's phone after they
 * scan the QR from step 4 of checkout-wizard-v2.
 *
 * NO auth — the token in the URL is the auth. Backend re-validates on
 * every endpoint call (kind = MOBILE_INSPECTION, not expired, not consumed).
 *
 * Flow:
 *   1. Load /api/mobile-inspection/:token → { angles[], vehicle, ... }
 *   2. For each angle: tap to open the device camera (file input with
 *      capture="environment"), preview, then upload to
 *      /api/mobile-inspection/:token/photo. Inspection rows are
 *      upserted by angleKey so re-takes overwrite cleanly.
 *   3. Capture optional odometer + fuel + notes.
 *   4. Tap Complete → /api/mobile-inspection/:token/complete stamps
 *      inspectionCompletedAt on the CheckoutSession.
 *   5. Desktop wizard polls 1.5s/cycle and auto-advances to step 5
 *      when inspectionCompletedAt becomes non-null.
 *
 * Phone-first layout — fluid full-width on narrow viewports, padded
 * card on wider. No nav chrome.
 */

import { useEffect, useRef, useState } from 'react';
import { useParams } from 'next/navigation';
import { api } from '../../../../lib/client';

export default function Page() {
  const params = useParams();
  const token = params?.token;
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  const [completed, setCompleted] = useState(false);

  useEffect(() => {
    if (!token) return;
    (async () => {
      try {
        const json = await api(`/api/mobile-inspection/${token}`, { bypassCache: true });
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
    <Shell title="Vehicle inspection" subtitle={data.vehicle || `Agreement ${data.agreementNumber || ''}`}>
      <CaptureFlow token={token} data={data} onComplete={() => setCompleted(true)} onError={setError} />
    </Shell>
  );
}

function CaptureFlow({ token, data, onComplete, onError }) {
  const [angles, setAngles] = useState(data.angles);
  const [odometer, setOdometer] = useState('');
  const [fuelLevel, setFuelLevel] = useState('FULL');
  // 2026-06-10 — mobile checkouts left cleanlinessOut blank on the contract
  // ("-") because this page never captured it. Mirrors the desktop wizard's
  // 1..5 scale (5 = clean); written through to the agreement on complete.
  const [cleanliness, setCleanliness] = useState(5);
  const [notes, setNotes] = useState('');
  const [signerName, setSignerName] = useState('');
  const [signatureDataUrl, setSignatureDataUrl] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const capturedCount = angles.filter((a) => a.captured).length;
  const hasFrontRear = angles.find((a) => a.key === 'front')?.captured
    && angles.find((a) => a.key === 'rear')?.captured;
  const hasSignature = signatureDataUrl && signatureDataUrl.length > 200;
  const hasSignerName = signerName.trim().length >= 2;
  // Hector's 2026-05-28 workflow — customer signs once at the end of the
  // inspection so the agent can hand keys and the desktop wizard rolls
  // all the way to CLOSED on its own. Submit requires both photos AND
  // signature.
  const canComplete = hasFrontRear && hasSignature && hasSignerName;

  const onAngleCaptured = (key) => {
    setAngles((curr) => curr.map((a) => (a.key === key ? { ...a, captured: true } : a)));
  };

  const submitComplete = async () => {
    setSubmitting(true);
    try {
      await api(`/api/mobile-inspection/${token}/complete`, {
        method: 'POST',
        body: JSON.stringify({
          odometer: odometer ? Number(odometer) : undefined,
          fuelLevel,
          cleanliness,
          notes: notes.trim() || undefined,
          signatureDataUrl,
          signerName: signerName.trim(),
        }),
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
        Tap a tile to open the camera, or use the small <strong>Upload</strong> button to
        pick a photo from your gallery. Front and Rear are required; the rest are
        recommended. Progress is saved as you go.
      </p>
      <div style={gridStyle}>
        {angles.map((a) => (
          <AngleTile key={a.key} angle={a} token={token} onCaptured={() => onAngleCaptured(a.key)} onError={onError} />
        ))}
      </div>

      <hr style={{ margin: '20px 0', border: 'none', borderTop: '0.5px solid #E5E7EB' }} />

      <div style={{ marginBottom: 12 }}>
        <label style={labelStyle}>Odometer (mi)</label>
        <input
          type="number"
          inputMode="numeric"
          value={odometer}
          onChange={(e) => setOdometer(e.target.value)}
          placeholder="e.g. 23456"
          style={inputStyle}
        />
      </div>

      <div style={{ marginBottom: 12 }}>
        <label style={labelStyle}>Fuel level</label>
        <select value={fuelLevel} onChange={(e) => setFuelLevel(e.target.value)} style={inputStyle}>
          <option value="FULL">Full</option>
          <option value="SEVEN_EIGHTHS">7/8</option>
          <option value="THREE_QUARTERS">3/4</option>
          <option value="FIVE_EIGHTHS">5/8</option>
          <option value="HALF">1/2</option>
          <option value="THREE_EIGHTHS">3/8</option>
          <option value="QUARTER">1/4</option>
          <option value="ONE_EIGHTH">1/8</option>
          <option value="EMPTY">Empty</option>
        </select>
      </div>

      <div style={{ marginBottom: 12 }}>
        <label style={labelStyle}>Cleanliness</label>
        <select value={cleanliness} onChange={(e) => setCleanliness(Number(e.target.value))} style={inputStyle}>
          <option value={5}>5 — Very clean</option>
          <option value={4}>4 — Clean</option>
          <option value={3}>3 — Average</option>
          <option value={2}>2 — Dirty</option>
          <option value={1}>1 — Very dirty</option>
        </select>
      </div>

      <div style={{ marginBottom: 16 }}>
        <label style={labelStyle}>Notes (optional)</label>
        <textarea
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder="Damage callouts, customer comments…"
          rows={3}
          style={{ ...inputStyle, resize: 'vertical' }}
        />
      </div>

      <hr style={{ margin: '20px 0', border: 'none', borderTop: '0.5px solid #E5E7EB' }} />

      <div style={{ marginBottom: 8 }}>
        <div style={{ fontSize: 14, fontWeight: 700, color: '#111827' }}>Customer signature</div>
        <div style={{ fontSize: 12, color: '#6B7280', marginTop: 2 }}>
          By signing, the customer confirms the vehicle condition above and accepts
          the agreement. Keys are handed over after signing.
        </div>
      </div>
      <div style={{ marginBottom: 12 }}>
        <label style={labelStyle}>Customer's full name</label>
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
        <SignaturePad onChange={setSignatureDataUrl} />
      </div>

      <button
        style={{ ...primaryBtn, opacity: canComplete && !submitting ? 1 : 0.4 }}
        disabled={!canComplete || submitting}
        onClick={submitComplete}
      >
        {submitting
          ? 'Submitting…'
          : `Complete & hand over keys (${capturedCount}/${angles.length} photos)`}
      </button>
      {!canComplete && (
        <div style={{ fontSize: 11, color: '#B91C1C', marginTop: 8, textAlign: 'center' }}>
          {!hasFrontRear && 'Front and Rear photos required. '}
          {!hasSignerName && 'Type the customer\'s name. '}
          {!hasSignature && 'Customer must sign in the box.'}
        </div>
      )}
    </div>
  );
}

function AngleTile({ angle, token, onCaptured, onError }) {
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState(null);
  // Two refs: one input forces the camera (capture="environment"), the
  // other opens the device's normal file picker so the agent can pick a
  // previously-taken photo from the gallery / Files app. Per Hector's
  // 2026-05-28 request: tile tap = camera, Upload button = picker.
  const cameraRef = useRef(null);
  const uploadRef = useRef(null);

  const handleFile = async (file) => {
    if (!file) return;
    setBusy(true);
    try {
      // Resize/compress before upload — phone cameras produce 4-8MB
      // JPEGs at full res and Postgres TEXT columns get expensive.
      const dataUrl = await fileToCompressedDataUrl(file, 1600, 0.8);
      setPreview(dataUrl);
      await api(`/api/mobile-inspection/${token}/photo`, {
        method: 'POST',
        body: JSON.stringify({ angleKey: angle.key, photoDataUrl: dataUrl }),
      });
      onCaptured();
    } catch (err) {
      onError(err?.message || 'Upload failed');
    } finally {
      setBusy(false);
    }
  };

  // Tapping anywhere on the tile body fires the camera input. The
  // "Upload" button below stopPropagations and fires the picker
  // separately, so the two affordances don't fight each other.
  const openCamera = () => { if (!busy) cameraRef.current?.click(); };
  const openUpload = (e) => {
    e.stopPropagation();
    if (!busy) uploadRef.current?.click();
  };

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={openCamera}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') openCamera(); }}
      style={{
        ...tileStyle,
        borderColor: angle.captured ? '#10B981' : '#D1D5DB',
        background: angle.captured ? '#ECFDF5' : '#FFFFFF',
        cursor: busy ? 'wait' : 'pointer',
      }}
    >
      <input
        ref={cameraRef}
        type="file"
        accept="image/*"
        capture="environment"
        style={{ display: 'none' }}
        onChange={(e) => handleFile(e.target.files?.[0])}
        disabled={busy}
      />
      <input
        ref={uploadRef}
        type="file"
        accept="image/*"
        style={{ display: 'none' }}
        onChange={(e) => handleFile(e.target.files?.[0])}
        disabled={busy}
      />
      {preview ? (
        <img src={preview} alt={angle.label} style={{ width: '100%', height: 60, objectFit: 'cover', borderRadius: 4 }} />
      ) : (
        <div style={{
          width: '100%', height: 60, background: '#F3F4F6', borderRadius: 4,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontSize: 22, color: '#9CA3AF',
        }}>
          {busy ? '…' : (angle.captured ? '✓' : '📷')}
        </div>
      )}
      <div style={{ fontSize: 11, fontWeight: 600, marginTop: 6, color: '#374151', textAlign: 'center' }}>
        {angle.label}
      </div>
      <button
        type="button"
        onClick={openUpload}
        disabled={busy}
        style={uploadBtnStyle}
        title="Upload an existing photo instead of taking a new one"
      >
        Upload
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Signature pad — full-width canvas with touch + mouse + DPR support.
// Emits a PNG dataUrl through onChange whenever the user lifts their
// finger / mouse after drawing something non-trivial. Same touch logic
// as /sign/[token]'s CanvasPad — kept inline so this route stays
// self-contained.
// ---------------------------------------------------------------------------

function SignaturePad({ height = 140, onChange }) {
  const canvasRef = useRef(null);
  const [drawing, setDrawing] = useState(false);
  const [hasContent, setHasContent] = useState(false);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const resize = () => {
      const parent = canvas.parentElement;
      const w = parent.clientWidth - 2;
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
  }, [height]);

  const pointFromEvent = (e) => {
    const canvas = canvasRef.current;
    const rect = canvas.getBoundingClientRect();
    const t = e.touches?.[0];
    const clientX = t ? t.clientX : e.clientX;
    const clientY = t ? t.clientY : e.clientY;
    return { x: clientX - rect.left, y: clientY - rect.top };
  };

  const start = (e) => {
    e.preventDefault();
    setDrawing(true);
    const ctx = canvasRef.current.getContext('2d');
    const p = pointFromEvent(e);
    ctx.beginPath();
    ctx.moveTo(p.x, p.y);
  };
  const move = (e) => {
    if (!drawing) return;
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
      onChange(canvasRef.current.toDataURL('image/png'));
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
    <div style={{ position: 'relative', display: 'block', width: '100%' }}>
      <canvas
        ref={canvasRef}
        style={{
          border: '0.5px dashed #9CA3AF',
          borderRadius: 6,
          background: '#FFFFFF',
          touchAction: 'none',
          width: '100%',
          display: 'block',
        }}
        onMouseDown={start} onMouseMove={move} onMouseUp={end} onMouseLeave={end}
        onTouchStart={start} onTouchMove={move} onTouchEnd={end}
      />
      {hasContent && (
        <button
          type="button"
          onClick={clear}
          style={{
            position: 'absolute', top: 4, right: 4, fontSize: 10,
            background: 'rgba(255,255,255,0.95)', border: '0.5px solid #D1D5DB',
            padding: '2px 6px', borderRadius: 4, cursor: 'pointer',
          }}
        >Clear</button>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Compress: decode → draw to canvas at max-side, encode JPEG
// ---------------------------------------------------------------------------

function fileToCompressedDataUrl(file, maxSide = 1600, quality = 0.8) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Could not read file'));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error('Could not decode image'));
      img.onload = () => {
        const scale = Math.min(1, maxSide / Math.max(img.width, img.height));
        const w = Math.round(img.width * scale);
        const h = Math.round(img.height * scale);
        const canvas = document.createElement('canvas');
        canvas.width = w; canvas.height = h;
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#FFFFFF';
        ctx.fillRect(0, 0, w, h);
        ctx.drawImage(img, 0, 0, w, h);
        try {
          resolve(canvas.toDataURL('image/jpeg', quality));
        } catch (err) {
          reject(err);
        }
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
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
    <div style={{
      minHeight: '100vh', background: '#F9FAFB',
      display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16,
    }}>
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

const gridStyle = {
  display: 'grid',
  gridTemplateColumns: 'repeat(4, 1fr)',
  gap: 8,
};

const tileStyle = {
  border: '0.5px solid #D1D5DB',
  borderRadius: 8,
  padding: 8,
  background: '#FFFFFF',
  cursor: 'pointer',
  display: 'block',
};

const labelStyle = { display: 'block', fontSize: 12, color: '#6B7280', marginBottom: 4 };
const inputStyle = {
  width: '100%', padding: '10px 12px', fontSize: 15,
  border: '0.5px solid #D1D5DB', borderRadius: 6, boxSizing: 'border-box',
  background: '#FFFFFF',
};
const primaryBtn = {
  width: '100%', padding: '14px', background: '#1F2937', color: '#FFFFFF',
  border: 'none', borderRadius: 8, fontSize: 15, fontWeight: 500, cursor: 'pointer',
};
const hintTextStyle = { fontSize: 13, color: '#6B7280', margin: '0 0 16px' };
const uploadBtnStyle = {
  width: '100%',
  marginTop: 6,
  padding: '4px 6px',
  fontSize: 10,
  fontWeight: 500,
  background: '#FFFFFF',
  border: '0.5px solid #D1D5DB',
  borderRadius: 4,
  color: '#6B7280',
  cursor: 'pointer',
};
