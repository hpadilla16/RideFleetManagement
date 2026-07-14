'use client';

/**
 * Driver's-license barcode scanner for the loaner check-out wizard.
 *
 * Decodes the PDF417 barcode on the back of US/Canada licenses (AAMVA) and
 * pre-fills the customer + license fields.
 *
 * 2026-06-08 (3.4 rev 2): zxing-js decodes real-license PDF417 poorly (failed on
 * both webcam AND phone). We now prefer the NATIVE `BarcodeDetector` API
 * (Chrome desktop + Android Chrome support `pdf417`, hardware-accelerated and far
 * more reliable). zxing-js is kept only as a fallback for browsers without
 * BarcodeDetector (e.g. iOS Safari). We own the camera stream so we can request a
 * high-res rear camera and run a tight detect loop on the live <video>.
 */

import { useEffect, useRef, useState } from 'react';
import { parseAamva } from '../../lib/aamva';

// Camera constraints per facing mode. PDF417 is dense — low-res was a big part
// of the earlier failures, so the REAR camera (loaner: staff phone pointed at
// a license) stays 1920×1080. The FRONT camera (kiosk: guest holds the license
// up to a mounted tablet) uses 1280×720 — 1080p front streams on iPads are
// slow to start and slow to decode (Hector's iPad smoke test, 2026-07-05).
function cameraConstraints(facingMode) {
  const front = facingMode === 'user';
  return {
    audio: false,
    video: {
      facingMode: { ideal: front ? 'user' : 'environment' },
      width: { ideal: front ? 1280 : 1920 },
      height: { ideal: front ? 720 : 1080 },
      advanced: [{ focusMode: 'continuous' }]
    }
  };
}

// Show the "try uploading a photo instead" hint after this long without a
// successful decode (WebKit has no native BarcodeDetector → zxing is slow).
const SLOW_SCAN_HINT_MS = 12 * 1000;

async function getNativeDetector() {
  if (typeof window === 'undefined' || !('BarcodeDetector' in window)) return null;
  try {
    const formats = await window.BarcodeDetector.getSupportedFormats();
    if (!formats.includes('pdf417')) return null;
    return new window.BarcodeDetector({ formats: ['pdf417'] });
  } catch {
    return null;
  }
}

async function makeZxingReader() {
  const [{ BrowserPDF417Reader }, lib] = await Promise.all([
    import('@zxing/browser'),
    import('@zxing/library')
  ]);
  let hints;
  try { hints = new Map(); hints.set(lib.DecodeHintType.TRY_HARDER, true); } catch { hints = undefined; }
  // ONE reader instance drives decodeFromStream's internal setTimeout loop —
  // nothing is re-instantiated per frame. Explicit attempt interval (default
  // is 500ms) keeps iPad/WebKit throughput sane without melting the CPU.
  return new BrowserPDF417Reader(hints, { delayBetweenScanAttempts: 350 });
}

// Default UI strings — the loaner wizard keeps these untouched. Callers that
// need localization (e.g. the ES kiosk flow) pass a partial `labels` override.
const DEFAULT_LABELS = {
  scanButton: '📷 Scan license barcode',
  stopButton: '■ Stop scan',
  uploadButton: '⬆ Upload barcode photo',
  holdSteady: 'Hold the BACK of the license steady — fill the frame with the barcode…',
  scannedPrefix: 'Scanned',
  scannedFallback: 'License scanned',
  cameraUnavailable: 'Camera unavailable — use “Upload barcode photo” instead.',
  liveScanUnavailable: 'Live scan unavailable on this browser — use “Upload barcode photo” instead.',
  readingBarcode: 'Reading barcode…',
  photoNoBarcode: 'That photo didn’t contain a readable license barcode. Try a sharper, well-lit shot of the BACK of the license.',
  photoReadFailed: 'Couldn’t read the barcode from that photo. Try a sharper shot of the back of the license, or enter fields manually.',
  helperNote: 'Scanning the PDF417 barcode auto-fills name, license #, state, and expiry. Confirm the fields below.',
  slowScanHint: 'Trouble scanning? Try uploading a photo of the barcode instead.',
};

/**
 * facingMode: 'environment' (default — loaner: staff phone pointed at a
 * license, byte-identical behavior) or 'user' (kiosk: guest faces a mounted
 * tablet). When user-facing, ONLY the preview is mirrored via CSS
 * (transform: scaleX(-1)) so aiming feels natural — BarcodeDetector reads the
 * <video> element's raw frames and canvas drawImage grabs raw frames too, so
 * decoding and the evidence capture are unaffected by the CSS mirror.
 */
export function LicenseScanner({ onDecode, onPhoto, labels: labelOverrides, facingMode = 'environment' }) {
  const labels = { ...DEFAULT_LABELS, ...(labelOverrides || {}) };
  const videoRef = useRef(null);
  const streamRef = useRef(null);
  const rafRef = useRef(null);
  const vfcRef = useRef(null);
  const hintTimerRef = useRef(null);
  const zxingControlsRef = useRef(null);
  const scanningRef = useRef(false);
  const [scanning, setScanning] = useState(false);
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');
  const [slowHint, setSlowHint] = useState(false);

  useEffect(() => () => stop(), []);

  // FULL teardown — iOS/WebKit allows only ONE live camera stream, so a
  // half-released stream here blocks the next getUserMedia (the kiosk selfie
  // step). Stop every track, pause the element AND null srcObject.
  function stop() {
    scanningRef.current = false;
    if (rafRef.current) { cancelAnimationFrame(rafRef.current); rafRef.current = null; }
    if (vfcRef.current && videoRef.current?.cancelVideoFrameCallback) {
      try { videoRef.current.cancelVideoFrameCallback(vfcRef.current); } catch {}
      vfcRef.current = null;
    }
    if (hintTimerRef.current) { clearTimeout(hintTimerRef.current); hintTimerRef.current = null; }
    setSlowHint(false);
    try { zxingControlsRef.current?.stop(); } catch {}
    zxingControlsRef.current = null;
    try {
      streamRef.current?.getTracks?.().forEach((t) => t.stop());
    } catch {}
    streamRef.current = null;
    if (videoRef.current) {
      try { videoRef.current.pause(); } catch {}
      try { videoRef.current.srcObject = null; } catch {}
    }
    setScanning(false);
  }

  function handleText(text) {
    const fields = parseAamva(text);
    if (!fields) {
      // Not a license barcode — keep scanning rather than aborting.
      return false;
    }
    // Live-decode evidence capture: the upload branch already emits onPhoto,
    // but a live pdf417 decode used to send no photo at all. Grab the current
    // video frame BEFORE stop() tears the stream down. Best-effort — a failed
    // capture must never block the decode.
    if (scanningRef.current && onPhoto && videoRef.current?.videoWidth) {
      try {
        const video = videoRef.current;
        const canvas = document.createElement('canvas');
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        canvas.getContext('2d').drawImage(video, 0, 0);
        onPhoto(canvas.toDataURL('image/jpeg', 0.85));
      } catch {}
    }
    stop();
    setError('');
    const scannedName = [fields.firstName, fields.lastName].filter(Boolean).join(' ');
    setStatus(scannedName ? `${labels.scannedPrefix} ${scannedName}`.trim() : labels.scannedFallback);
    onDecode?.(fields);
    return true;
  }

  async function startCamera() {
    setError('');
    setStatus(labels.holdSteady);
    setScanning(true);
    scanningRef.current = true;
    setSlowHint(false);
    // No decode after SLOW_SCAN_HINT_MS → surface the upload fallback
    // (WebKit has no native BarcodeDetector, zxing on an iPad can be slow).
    // Scanning keeps running in the background.
    if (hintTimerRef.current) clearTimeout(hintTimerRef.current);
    hintTimerRef.current = setTimeout(() => {
      if (scanningRef.current) setSlowHint(true);
    }, SLOW_SCAN_HINT_MS);

    // 1) Acquire the camera for the requested facing (fall back to any camera).
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia(cameraConstraints(facingMode));
    } catch {
      try { stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false }); }
      catch { setError(labels.cameraUnavailable); stop(); return; }
    }
    streamRef.current = stream;
    const video = videoRef.current;
    if (!video) { stop(); return; }
    video.srcObject = stream;
    try { await video.play(); } catch {}

    // 2) Prefer the native BarcodeDetector (Chrome/Android) — much more
    // reliable. Pace the loop with requestVideoFrameCallback when available
    // (fires once per NEW camera frame instead of per display refresh).
    const detector = await getNativeDetector();
    if (detector) {
      const schedule = (fn) => {
        if (typeof video.requestVideoFrameCallback === 'function') {
          vfcRef.current = video.requestVideoFrameCallback(() => fn());
        } else {
          rafRef.current = requestAnimationFrame(fn);
        }
      };
      const tick = async () => {
        if (!scanningRef.current) return;
        try {
          const codes = await detector.detect(video);
          if (codes && codes.length && handleText(codes[0].rawValue)) return;
        } catch { /* transient — keep going */ }
        if (scanningRef.current) schedule(tick);
      };
      schedule(tick);
      return;
    }

    // 3) Fallback: zxing on the same stream (iOS Safari etc.).
    try {
      const reader = await makeZxingReader();
      zxingControlsRef.current = await reader.decodeFromStream(stream, video, (result, _err, controls) => {
        if (result) { controls.stop(); handleText(result.getText()); }
      });
    } catch {
      setError(labels.liveScanUnavailable);
      stop();
    }
  }

  async function onFile(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    setError('');
    setStatus(labels.readingBarcode);
    try {
      const { compressToDataUrl } = await import('../../lib/image-compressor');
      // Keep PDF417 lines crisp through compression.
      const dataUrl = await compressToDataUrl(file, { maxWidth: 2400, quality: 0.92 });
      onPhoto?.(dataUrl);

      // Try native BarcodeDetector on the still first (best), then zxing.
      const detector = await getNativeDetector();
      if (detector) {
        try {
          const img = await loadImage(dataUrl);
          const codes = await detector.detect(img);
          if (codes && codes.length && handleText(codes[0].rawValue)) return;
        } catch { /* fall through to zxing */ }
      }
      const reader = await makeZxingReader();
      const result = await reader.decodeFromImageUrl(dataUrl);
      if (!handleText(result.getText())) {
        setError(labels.photoNoBarcode);
        setStatus('');
      }
    } catch {
      setError(labels.photoReadFailed);
      setStatus('');
    }
  }

  return (
    <div>
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
        {!scanning ? (
          <button type="button" className="hero-pill" onClick={startCamera}>{labels.scanButton}</button>
        ) : (
          <button type="button" className="hero-pill" onClick={stop}>{labels.stopButton}</button>
        )}
        <label
          className="hero-pill"
          style={{
            cursor: 'pointer',
            // Slow-scan hint also spotlights this fallback (kiosk/iPad path).
            ...(slowHint ? { outline: '2px solid #8752FE', outlineOffset: 2 } : {}),
          }}
        >
          {labels.uploadButton}
          <input type="file" accept="image/*" capture={facingMode === 'user' ? 'user' : 'environment'} onChange={onFile} style={{ display: 'none' }} />
        </label>
      </div>

      <video
        ref={videoRef}
        style={{
          display: scanning ? 'block' : 'none',
          width: '100%', maxWidth: 420, marginTop: 12,
          borderRadius: 12, border: '1px solid #e6dfff', background: '#000',
          // Mirror ONLY the preview for a user-facing camera — decode +
          // evidence capture read raw (unmirrored) frames.
          ...(facingMode === 'user' ? { transform: 'scaleX(-1)' } : {}),
        }}
        muted
        playsInline
      />

      {scanning && slowHint ? (
        <div style={{
          marginTop: 10, padding: '10px 12px', borderRadius: 12, fontSize: 13, fontWeight: 700,
          background: 'rgba(245,158,11,.12)', border: '1px solid rgba(245,158,11,.25)', color: '#b45309',
        }}>
          {labels.slowScanHint}
        </div>
      ) : null}

      {status && <div style={{ marginTop: 10, fontSize: 12.5, color: '#0f9b82', fontWeight: 700 }}>{status}</div>}
      {error && <div style={{ marginTop: 10, fontSize: 12.5, color: '#b9791e', fontWeight: 700 }}>{error}</div>}
      <div style={{ marginTop: 8, fontSize: 12, color: '#6f668f' }}>
        {labels.helperNote}
      </div>
    </div>
  );
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}
