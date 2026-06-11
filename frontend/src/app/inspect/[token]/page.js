'use client';

/**
 * Customer-led vehicle inspection (2026-06-11, Fase A).
 * Plan: doc/customer-inspection-plan-2026-06-11.md — mockups v4 approved.
 *
 * Opens from the email link on the CUSTOMER's phone. NO auth — the 24h
 * CUSTOMER_INSPECTION token in the URL is the auth; the backend re-validates
 * on every call.
 *
 * Two steps:
 *   1. Confirm identity + vehicle (name, car, plate) + disclosures.
 *   2. Per-view diagrams (Left/Right/Front/Rear/Interior, matched to the
 *      vehicle type): tap to place a damage dot → photo (required, camera
 *      capture) + short description → POST /damage per dot.
 *      "Finish inspection" → POST /complete (0+ reports is valid).
 *
 * Phone-first layout. No nav chrome.
 */

import { useEffect, useRef, useState } from 'react';
import { useParams } from 'next/navigation';
import { api } from '../../../lib/client';
import { diagramFor, DIAGRAM_VIEWBOX, DIAGRAM_W, DIAGRAM_H, VIEW_LABELS } from '../../../components/vehicleDiagrams';

const VIEWS = ['LEFT', 'RIGHT', 'FRONT', 'REAR', 'INTERIOR'];

export default function Page() {
  const params = useParams();
  const token = params?.token;
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  const [step, setStep] = useState(1);
  const [completed, setCompleted] = useState(false);
  const [finalCount, setFinalCount] = useState(0);

  useEffect(() => {
    if (!token) return;
    (async () => {
      try {
        const json = await api(`/api/customer-inspection/${token}`, { bypassCache: true });
        setData(json);
      } catch (err) {
        setError(err?.message || 'Failed to load');
      } finally {
        setLoading(false);
      }
    })();
  }, [token]);

  if (loading) return <Shell><Note>Loading your inspection…</Note></Shell>;
  if (error) return <Shell><Note tone="error">{error}</Note></Shell>;
  if (completed) {
    return (
      <Shell>
        <Note tone="ok">
          <strong>Inspection submitted — thank you!</strong><br />
          {finalCount > 0
            ? `${finalCount} damage report${finalCount === 1 ? '' : 's'} sent to the rental team for review.`
            : 'No damages reported. Enjoy your ride!'}
        </Note>
      </Shell>
    );
  }
  if (!data) return null;

  return (
    <Shell>
      {step === 1
        ? <StepConfirm data={data} onConfirm={() => setStep(2)} />
        : <StepAnnotate token={token} data={data} onDone={(n) => { setFinalCount(n); setCompleted(true); }} />}
    </Shell>
  );
}

function StepConfirm({ data, onConfirm }) {
  return (
    <div>
      <p style={eyebrowStyle}>STEP 1 OF 2</p>
      <h2 style={titleStyle}>Confirm it&apos;s you and your car</h2>
      <div style={infoBoxStyle}>
        <div style={{ fontSize: 12, color: '#6B7280' }}>Renter</div>
        <div style={{ fontSize: 15, fontWeight: 600 }}>{data.customerName || '—'}</div>
      </div>
      <div style={infoBoxStyle}>
        <div style={{ fontSize: 12, color: '#6B7280' }}>Vehicle</div>
        <div style={{ fontSize: 15, fontWeight: 600 }}>{data.vehicle?.label || '—'}</div>
        <div style={{ fontSize: 12, color: '#6B7280' }}>
          {[data.vehicle?.plate ? `Plate ${data.vehicle.plate}` : null, data.vehicle?.color].filter(Boolean).join(' · ')}
        </div>
      </div>
      <button style={primaryBtn} onClick={onConfirm}>Yes, this is my rental →</button>
      <p style={{ fontSize: 11, color: '#9CA3AF', marginTop: 10, lineHeight: 1.5 }}>
        By continuing you accept that this inspection is your responsibility. Any damage
        we detect upon return that was not reported here and pertains to your rental
        period will be your responsibility. If the name or vehicle above is wrong,
        contact the rental office before continuing.
      </p>
    </div>
  );
}

function StepAnnotate({ token, data, onDone }) {
  const [view, setView] = useState('LEFT');
  const [dots, setDots] = useState({ LEFT: [], RIGHT: [], FRONT: [], REAR: [], INTERIOR: [] });
  const [pending, setPending] = useState(null); // { xPct, yPct }
  const [desc, setDesc] = useState('');
  const [photo, setPhoto] = useState(null); // dataUrl
  const [saving, setSaving] = useState(false);
  const [finishing, setFinishing] = useState(false);
  const [err, setErr] = useState('');
  const svgRef = useRef(null);
  const fileRef = useRef(null);

  const total = VIEWS.reduce((s, v) => s + dots[v].length, 0);

  const tap = (e) => {
    if (pending) return;
    const r = svgRef.current.getBoundingClientRect();
    const xPct = Math.round(((e.clientX - r.left) / r.width) * 1000) / 10;
    const yPct = Math.round(((e.clientY - r.top) / r.height) * 1000) / 10;
    setPending({ xPct, yPct });
    setDesc('');
    setPhoto(null);
    setErr('');
  };

  const onFile = (file) => {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => setPhoto(reader.result);
    reader.readAsDataURL(file);
  };

  const saveDot = async () => {
    if (!photo) { setErr('A photo of the damage is required.'); return; }
    setSaving(true);
    setErr('');
    try {
      const out = await api(`/api/customer-inspection/${token}/damage`, {
        method: 'POST',
        body: JSON.stringify({ view, xPct: pending.xPct, yPct: pending.yPct, description: desc.trim() || undefined, photoDataUrl: photo }),
      });
      setDots((c) => ({ ...c, [view]: [...c[view], { xPct: pending.xPct, yPct: pending.yPct, id: out?.id }] }));
      setPending(null);
      setPhoto(null);
      setDesc('');
    } catch (e2) {
      setErr(e2?.message || 'Failed to save — try again');
    } finally {
      setSaving(false);
    }
  };

  const finish = async () => {
    setFinishing(true);
    setErr('');
    try {
      const out = await api(`/api/customer-inspection/${token}/complete`, { method: 'POST' });
      onDone(out?.reportCount ?? total);
    } catch (e2) {
      setErr(e2?.message || 'Failed to submit — try again');
      setFinishing(false);
    }
  };

  return (
    <div>
      <p style={eyebrowStyle}>STEP 2 OF 2 · {data.vehicle?.label || ''}</p>
      <h2 style={titleStyle}>Tap the car where you see damage</h2>

      <div style={{ display: 'flex', border: '1px solid #E5E7EB', borderRadius: 999, overflow: 'hidden', marginBottom: 10 }}>
        {VIEWS.map((v) => (
          <button
            key={v}
            type="button"
            onClick={() => { if (!pending) setView(v); }}
            style={{
              flex: 1, fontSize: 12, padding: '8px 2px', border: 'none', borderRadius: 0,
              background: v === view ? '#5b3df5' : 'transparent',
              color: v === view ? '#FFFFFF' : '#6B7280', cursor: 'pointer',
            }}
          >
            {VIEW_LABELS[v]}{dots[v].length ? ` · ${dots[v].length}` : ''}
          </button>
        ))}
      </div>

      <svg
        ref={svgRef}
        viewBox={DIAGRAM_VIEWBOX}
        onClick={tap}
        style={{ width: '100%', background: '#F6F4FE', borderRadius: 14, cursor: 'crosshair', touchAction: 'manipulation' }}
        xmlns="http://www.w3.org/2000/svg"
      >
        <g dangerouslySetInnerHTML={{ __html: diagramFor(data.diagramType, view) }} />
        <g>
          {dots[view].map((d, i) => (
            <g key={d.id || i}>
              <circle cx={(d.xPct / 100) * DIAGRAM_W} cy={(d.yPct / 100) * DIAGRAM_H} r="10" fill="#E24B4A" stroke="#FFFFFF" strokeWidth="2" />
              <text x={(d.xPct / 100) * DIAGRAM_W} y={(d.yPct / 100) * DIAGRAM_H + 3.5} textAnchor="middle" fill="#FFFFFF" fontSize="11" fontWeight="600">{i + 1}</text>
            </g>
          ))}
          {pending ? (
            <circle cx={(pending.xPct / 100) * DIAGRAM_W} cy={(pending.yPct / 100) * DIAGRAM_H} r="10" fill="#E24B4A" fillOpacity="0.6" stroke="#FFFFFF" strokeWidth="2" />
          ) : null}
        </g>
      </svg>

      {pending ? (
        <div style={{ border: '1px solid #D1D5DB', borderRadius: 10, padding: 12, marginTop: 10 }}>
          <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 8 }}>Report damage — {VIEW_LABELS[view].toLowerCase()} view</div>
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            capture="environment"
            style={{ display: 'none' }}
            onChange={(e) => { onFile(e.target.files?.[0]); e.target.value = ''; }}
          />
          <button type="button" style={{ ...secondaryBtn, width: '100%', marginBottom: 8 }} onClick={() => fileRef.current?.click()}>
            {photo ? '✓ Photo attached — retake' : '📷 Take photo (required)'}
          </button>
          {photo ? <img src={photo} alt="damage" style={{ width: '100%', maxHeight: 160, objectFit: 'cover', borderRadius: 8, marginBottom: 8 }} /> : null}
          <input
            type="text"
            placeholder="Brief description (e.g. scratch on rim)"
            value={desc}
            onChange={(e) => setDesc(e.target.value)}
            style={inputStyle}
          />
          <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
            <button type="button" style={{ ...primaryBtn, flex: 1, margin: 0 }} disabled={saving} onClick={saveDot}>
              {saving ? 'Saving…' : 'Save report'}
            </button>
            <button type="button" style={{ ...secondaryBtn, flex: 1 }} disabled={saving} onClick={() => { setPending(null); setErr(''); }}>
              Cancel
            </button>
          </div>
        </div>
      ) : null}

      {err ? <div style={{ color: '#B91C1C', fontSize: 13, marginTop: 8 }}>{err}</div> : null}

      <p style={{ fontSize: 13, color: '#6B7280', margin: '10px 0' }}>
        {total === 0 ? 'No damages reported yet — switch views to check every side.' : `${total} damage${total === 1 ? '' : 's'} reported.`}
      </p>
      <button style={primaryBtn} disabled={!!pending || finishing} onClick={finish}>
        {finishing ? 'Submitting…' : 'Finish inspection ✓'}
      </button>
    </div>
  );
}

function Shell({ children }) {
  return (
    <div style={{ minHeight: '100vh', background: '#F3F1FB', padding: '16px 12px', display: 'flex', justifyContent: 'center' }}>
      <div style={{ background: '#FFFFFF', borderRadius: 20, padding: 18, width: '100%', maxWidth: 440, alignSelf: 'flex-start', fontFamily: 'system-ui, -apple-system, sans-serif', color: '#111827' }}>
        {children}
      </div>
    </div>
  );
}

function Note({ children, tone }) {
  const colors = tone === 'error'
    ? { bg: '#FEF2F2', fg: '#991B1B' }
    : tone === 'ok'
      ? { bg: '#ECFDF5', fg: '#065F46' }
      : { bg: '#F9FAFB', fg: '#374151' };
  return <div style={{ background: colors.bg, color: colors.fg, borderRadius: 10, padding: 16, fontSize: 14, lineHeight: 1.6 }}>{children}</div>;
}

const eyebrowStyle = { fontSize: 11, letterSpacing: 0.4, color: '#9CA3AF', margin: '0 0 4px' };
const titleStyle = { fontSize: 17, fontWeight: 600, margin: '0 0 12px' };
const infoBoxStyle = { background: '#F6F4FE', borderRadius: 10, padding: 12, marginBottom: 10 };
const inputStyle = { width: '100%', padding: '10px 12px', borderRadius: 8, border: '1px solid #D1D5DB', fontSize: 14, boxSizing: 'border-box' };
const primaryBtn = { width: '100%', padding: '12px 16px', borderRadius: 10, border: 'none', background: '#5b3df5', color: '#FFFFFF', fontSize: 15, fontWeight: 600, cursor: 'pointer', marginTop: 4 };
const secondaryBtn = { padding: '10px 14px', borderRadius: 10, border: '1px solid #D1D5DB', background: '#FFFFFF', color: '#374151', fontSize: 14, cursor: 'pointer' };
