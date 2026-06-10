'use client';

/**
 * Vehicle identity scanner for the Inventory Helper (2026-06-09).
 *
 * Confirms you're standing in front of the RIGHT vehicle via:
 *   - QR: the vehicle profile QR (encodes /vehicles/{id}) — format qr_code
 *   - VIN: the Code 39 barcode on the driver-door jamb sticker — format code_39
 *   - Plate: typed in and matched (BarcodeDetector can't OCR a plate)
 *
 * Uses the native BarcodeDetector (Chrome desktop + Android). On a browser
 * without it (e.g. iOS Safari), QR/VIN scanning is unavailable — the agent uses
 * Plate match or the manual fallback.
 */

import { useEffect, useRef, useState } from 'react';

const CAMERA_CONSTRAINTS = {
  audio: false,
  video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } },
};

const norm = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

function extractVehicleId(raw) {
  const s = String(raw || '').trim();
  try {
    const u = new URL(s);
    const parts = u.pathname.split('/').filter(Boolean);
    const i = parts.indexOf('vehicles');
    if (i >= 0 && parts[i + 1]) return parts[i + 1];
    return parts[parts.length - 1] || s;
  } catch {
    const parts = s.split('/').filter(Boolean);
    return parts[parts.length - 1] || s;
  }
}

async function getDetector() {
  if (typeof window === 'undefined' || !('BarcodeDetector' in window)) return null;
  try {
    const formats = await window.BarcodeDetector.getSupportedFormats();
    const want = ['qr_code', 'code_39'].filter((f) => formats.includes(f));
    if (!want.length) return null;
    return new window.BarcodeDetector({ formats: want });
  } catch {
    return null;
  }
}

export function VehicleScanner({ expected, onMatched, onManual }) {
  const videoRef = useRef(null);
  const streamRef = useRef(null);
  const rafRef = useRef(null);
  const scanningRef = useRef(false);
  const [scanning, setScanning] = useState(false);
  const [plate, setPlate] = useState('');
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');

  useEffect(() => () => stop(), []);

  function stop() {
    scanningRef.current = false;
    if (rafRef.current) { cancelAnimationFrame(rafRef.current); rafRef.current = null; }
    try { streamRef.current?.getTracks?.().forEach((t) => t.stop()); } catch {}
    streamRef.current = null;
    if (videoRef.current) { try { videoRef.current.srcObject = null; } catch {} }
    setScanning(false);
  }

  function handleCode(code) {
    const fmt = String(code.format || '');
    const val = code.rawValue;
    if (fmt === 'qr_code') {
      const id = extractVehicleId(val);
      if (expected?.id && id === expected.id) { stop(); setError(''); setStatus('Matched by QR'); onMatched?.('QR'); return true; }
      setError(`That QR is a different vehicle. Expected ${expected?.plate || expected?.internalNumber || 'this unit'}.`);
      return false;
    }
    if (fmt === 'code_39') {
      if (expected?.vin && norm(val) === norm(expected.vin)) { stop(); setError(''); setStatus('Matched by VIN barcode'); onMatched?.('VIN'); return true; }
      setError('That VIN barcode is a different vehicle.');
      return false;
    }
    return false;
  }

  async function startCamera() {
    setError(''); setStatus('Point the camera at the QR or the VIN barcode on the door jamb…');
    setScanning(true); scanningRef.current = true;

    const detector = await getDetector();
    if (!detector) {
      setError('Live scanning isn’t supported on this browser. Use Plate match or confirm manually.');
      stop(); return;
    }
    let stream;
    try { stream = await navigator.mediaDevices.getUserMedia(CAMERA_CONSTRAINTS); }
    catch {
      try { stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false }); }
      catch { setError('Camera unavailable. Use Plate match or confirm manually.'); stop(); return; }
    }
    streamRef.current = stream;
    const video = videoRef.current;
    if (!video) { stop(); return; }
    video.srcObject = stream;
    try { await video.play(); } catch {}

    const tick = async () => {
      if (!scanningRef.current) return;
      try {
        const codes = await detector.detect(video);
        if (codes && codes.length && handleCode(codes[0])) return;
      } catch { /* transient */ }
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
  }

  function matchPlate() {
    if (expected?.plate && norm(plate) === norm(expected.plate)) { setError(''); setStatus('Matched by plate'); onMatched?.('PLATE'); }
    else setError('That plate doesn’t match this vehicle.');
  }

  return (
    <div>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        {!scanning ? (
          <button type="button" className="btn-ghost" onClick={startCamera}>Scan QR / VIN</button>
        ) : (
          <button type="button" className="btn-ghost" onClick={stop}>Stop scan</button>
        )}
        <span className="ui-muted" style={{ fontSize: 12 }}>or</span>
        <input type="text" value={plate} onChange={(e) => setPlate(e.target.value)} placeholder="Type plate" style={{ width: 130 }} />
        <button type="button" className="btn-ghost" onClick={matchPlate}>Match plate</button>
        <button type="button" className="btn-ghost" onClick={() => onManual?.()}>Can’t scan</button>
      </div>

      <video
        ref={videoRef}
        style={{ display: scanning ? 'block' : 'none', width: '100%', maxWidth: 360, marginTop: 12, borderRadius: 12, background: '#000' }}
        muted
        playsInline
      />

      {status ? <div style={{ marginTop: 8, fontSize: 12.5, color: 'var(--ok, #16a34a)', fontWeight: 600 }}>{status}</div> : null}
      {error ? <div style={{ marginTop: 8, fontSize: 12.5, color: 'var(--warn, #b9791e)', fontWeight: 600 }}>{error}</div> : null}
    </div>
  );
}
