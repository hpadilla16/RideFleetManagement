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
    setStatus('Hold the barcode (back of the license) steady in the frame…');
    setScanning(true);
    try {
      const { BrowserPDF417Reader } = await import('@zxing/browser');
      const reader = new BrowserPDF417Reader();
      controlsRef.current = await reader.decodeFromVideoDevice(undefined, videoRef.current, (result, _err, controls) => {
        if (result) {
          controls.stop();
          handleText(result.getText());
        }
      });
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
      const dataUrl = await compressToDataUrl(file, { maxWidth: 1600, quality: 0.85 });
      onPhoto?.(dataUrl);
      const { BrowserPDF417Reader } = await import('@zxing/browser');
      const reader = new BrowserPDF417Reader();
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
