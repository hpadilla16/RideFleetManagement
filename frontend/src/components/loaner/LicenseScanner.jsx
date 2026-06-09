'use client';

/**
 * Driver's-license barcode scanner for the loaner check-out wizard.
 *
 * Decodes the PDF417 barcode on the back of US/Canada licenses (AAMVA) and
 * pre-fills the customer + license fields — far more reliable than OCR of the
 * printed front. Live-camera scan with a still-photo upload fallback.
 *
 * @zxing/browser is loaded via dynamic import so it never runs during SSR and
 * stays out of the initial bundle.
 */

import { useEffect, useRef, useState } from 'react';
import { parseAamva } from '../../lib/aamva';

// PDF417 on the back of a license is dense — it needs a high-res REAR camera to
// decode. zxing's default decodeFromVideoDevice(undefined) picks the default
// camera (often the FRONT cam on phones/tablets) at ~640x480, which is why the
// webcam scan failed. Request environment-facing 1080p with continuous focus.
const CAMERA_CONSTRAINTS = {
  audio: false,
  video: {
    facingMode: { ideal: 'environment' },
    width: { ideal: 1920 },
    height: { ideal: 1080 },
    advanced: [{ focusMode: 'continuous' }] // honored on Android/Chrome; ignored elsewhere
  }
};

// Shared reader with TRY_HARDER so partially-skewed / lower-contrast barcodes
// still decode (matters for webcams and phone shots taken at an angle).
async function makePdf417Reader() {
  const [{ BrowserPDF417Reader }, lib] = await Promise.all([
    import('@zxing/browser'),
    import('@zxing/library')
  ]);
  let hints;
  try {
    hints = new Map();
    hints.set(lib.DecodeHintType.TRY_HARDER, true);
  } catch { hints = undefined; }
  return new BrowserPDF417Reader(hints);
}

export function LicenseScanner({ onDecode, onPhoto }) {
  const videoRef = useRef(null);
  const controlsRef = useRef(null);
  const [scanning, setScanning] = useState(false);
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');

  useEffect(() => () => stop(), []);

  function stop() {
    try { controlsRef.current?.stop(); } catch {}
    controlsRef.current = null;
    setScanning(false);
  }

  function handleText(text) {
    stop();
    const fields = parseAamva(text);
    if (!fields) {
      setError('That barcode isn’t a recognizable license. Enter the fields manually below.');
      setStatus('');
      return;
    }
    setError('');
    setStatus(`Scanned ${[fields.firstName, fields.lastName].filter(Boolean).join(' ')}`.trim() || 'License scanned');
    onDecode?.(fields);
  }

  async function startCamera() {
    setError('');
    setStatus('Hold the BACK of the license steady — fill the frame with the barcode…');
    setScanning(true);
    try {
      const reader = await makePdf417Reader();
      const onResult = (result, _err, controls) => {
        if (result) { controls.stop(); handleText(result.getText()); }
      };
      try {
        // Preferred: high-res rear camera.
        controlsRef.current = await reader.decodeFromConstraints(CAMERA_CONSTRAINTS, videoRef.current, onResult);
      } catch {
        // Fallback for single-camera desktops/webcams where the environment
        // constraint can't be satisfied — let zxing use the default device.
        controlsRef.current = await reader.decodeFromVideoDevice(undefined, videoRef.current, onResult);
      }
    } catch {
      setError('Camera unavailable — use “Upload barcode photo” instead.');
      setScanning(false);
    }
  }

  async function onFile(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    setError('');
    setStatus('Reading barcode…');
    try {
      const { compressToDataUrl } = await import('../../lib/image-compressor');
      // PDF417 lines are fine-grained — keep more pixels + higher quality than a
      // normal photo so the bars survive compression (1600/0.85 was too lossy).
      const dataUrl = await compressToDataUrl(file, { maxWidth: 2400, quality: 0.92 });
      onPhoto?.(dataUrl);
      const reader = await makePdf417Reader();
      const result = await reader.decodeFromImageUrl(dataUrl);
      handleText(result.getText());
    } catch {
      setError('Couldn’t read the barcode from that photo. Try a sharper shot of the back of the license, or enter fields manually.');
      setStatus('');
    }
  }

  return (
    <div>
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
        {!scanning ? (
          <button type="button" className="hero-pill" onClick={startCamera}>📷 Scan license barcode</button>
        ) : (
          <button type="button" className="hero-pill" onClick={stop}>■ Stop scan</button>
        )}
        <label className="hero-pill" style={{ cursor: 'pointer' }}>
          ⬆ Upload barcode photo
          <input type="file" accept="image/*" capture="environment" onChange={onFile} style={{ display: 'none' }} />
        </label>
      </div>

      <video
        ref={videoRef}
        style={{
          display: scanning ? 'block' : 'none',
          width: '100%', maxWidth: 420, marginTop: 12,
          borderRadius: 12, border: '1px solid #e6dfff', background: '#000'
        }}
        muted
        playsInline
      />

      {status && <div style={{ marginTop: 10, fontSize: 12.5, color: '#0f9b82', fontWeight: 700 }}>{status}</div>}
      {error && <div style={{ marginTop: 10, fontSize: 12.5, color: '#b9791e', fontWeight: 700 }}>{error}</div>}
      <div style={{ marginTop: 8, fontSize: 12, color: '#6f668f' }}>
        Scanning the PDF417 barcode auto-fills name, license #, state, and expiry. Confirm the fields below.
      </div>
    </div>
  );
}
