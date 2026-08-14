'use client';

/**
 * Pillar 2 — Photo capture component with AR-style overlay.
 *
 * Wraps the browser camera (getUserMedia) with:
 *   - A live video feed
 *   - Animated corner brackets + scan line (AR vibe)
 *   - Position label ("DRIVER SIDE · 3/8") for guided capture
 *   - Capture button that frames the video to canvas, compresses, and
 *     emits the data URL via onCapture
 *
 * Falls back to a file input on devices without camera access.
 * Compression handled by frontend/src/lib/image-compressor.js (quick fix
 * for the photosJson DB bloat — see master plan section 7.2).
 *
 * The progress grid renders captured thumbs alongside still-empty slots,
 * matching the mockup at design/mockups/pillar2-checkin-checkout/.
 */

import { useRef, useState, useEffect } from 'react';
import { compressToDataUrl } from '../../lib/image-compressor.js';

// 8 standard inspection angles — keys MUST match the keys consumed by
// frontend/src/app/reservations/[id]/inspection-report/page.js (line 12).
// If you add or rename a key here, also update the inspection-report
// renderer or the photos will save to DB but never display.
//
// 4 exterior angles + 4 interior shots = 8 photos total.
export const STANDARD_ANGLES = [
  { key: 'front',     label: 'Front (exterior)',  abbr: 'Front' },
  { key: 'rear',      label: 'Rear (exterior)',   abbr: 'Rear' },
  { key: 'left',      label: 'Driver side',       abbr: 'Left' },
  { key: 'right',     label: 'Passenger side',    abbr: 'Right' },
  { key: 'frontSeat', label: 'Front seat',        abbr: 'F. Seat' },
  { key: 'rearSeat',  label: 'Rear seat',         abbr: 'R. Seat' },
  { key: 'dashboard', label: 'Dashboard',         abbr: 'Dash' },
  { key: 'trunk',     label: 'Trunk',             abbr: 'Trunk' }
];

export function PhotoCapture({
  capturedPhotos,        // { [angleKey]: dataUrl }
  onCapture,             // (angleKey, dataUrl) => void
  currentAngleIndex,
  onAngleChange,         // (index) => void
  angles = STANDARD_ANGLES,
  comparePhoto = null,   // optional baseline image to show side-by-side
  // Checkout reference (Hector, 2026-08-14). The agent inspecting a returning
  // car sees the SAME angle as it left the lot, right beside the live camera —
  // so a scratch that wasn't there gets noticed while the customer is still
  // standing there, not days later from the archive.
  compareCaption = '',   // e.g. "Checkout · Aug 8, 3:15 PM"
  comparePhotos = null,  // { [angleKey]: dataUrl } — baselines for the thumb grid
  damageNotes = null,    // { [angleKey]: string } — per-angle new-damage notes
  onDamageNote = null    // (angleKey, text) => void; omit to hide the control
}) {
  const videoRef = useRef(null);
  const streamRef = useRef(null);
  const fileInputRef = useRef(null);
  const [streamActive, setStreamActive] = useState(false);
  const [streamError, setStreamError] = useState('');
  const [capturing, setCapturing] = useState(false);

  const currentAngle = angles[currentAngleIndex] || angles[0];

  // Get the camera stream
  useEffect(() => {
    let cancelled = false;
    const startStream = async () => {
      if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
        setStreamError('Camera not available on this device. Tap "Choose file" to upload.');
        return;
      }
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } },
          audio: false
        });
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        streamRef.current = stream;
        setStreamActive(true);
      } catch (err) {
        setStreamError(err.message || 'Camera permission denied. Use "Choose file" instead.');
      }
    };
    startStream();
    return () => {
      cancelled = true;
      if (streamRef.current) {
        streamRef.current.getTracks().forEach((t) => t.stop());
        streamRef.current = null;
      }
    };
  }, []);

  // Attach the stream to the video element. Runs after streamActive flips
  // true AND the video element has mounted (videoRef has a current value).
  // Without this two-step, the previous version set srcObject before the
  // <video> rendered, so the stream attached to nothing and the viewfinder
  // stayed blank.
  useEffect(() => {
    if (!streamActive || !videoRef.current || !streamRef.current) return;
    videoRef.current.srcObject = streamRef.current;
    const playPromise = videoRef.current.play();
    if (playPromise?.catch) playPromise.catch((err) => {
      console.warn('[photo-capture] video.play() rejected', err);
    });
  }, [streamActive]);

  const capture = async () => {
    if (capturing) return;
    setCapturing(true);
    try {
      const video = videoRef.current;
      if (!video || video.readyState < 2) throw new Error('Camera not ready');

      // Frame video to a canvas
      const canvas = document.createElement('canvas');
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

      // Convert canvas to Blob, then compress
      const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.85));
      if (!blob) throw new Error('Capture failed');
      const file = new File([blob], `${currentAngle.key}-${Date.now()}.jpg`, { type: 'image/jpeg' });
      const dataUrl = await compressToDataUrl(file, { maxWidth: 1280, quality: 0.7 });

      onCapture?.(currentAngle.key, dataUrl);

      // Advance to next un-captured angle
      const next = findNextEmpty(angles, capturedPhotos, currentAngleIndex);
      if (next !== -1) onAngleChange?.(next);
    } catch (err) {
      console.error('Capture error', err);
      alert('Capture failed: ' + err.message);
    } finally {
      setCapturing(false);
    }
  };

  const onFileChange = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const dataUrl = await compressToDataUrl(file, { maxWidth: 1280, quality: 0.7 });
      onCapture?.(currentAngle.key, dataUrl);
      const next = findNextEmpty(angles, capturedPhotos, currentAngleIndex);
      if (next !== -1) onAngleChange?.(next);
    } catch (err) {
      alert('File upload failed: ' + err.message);
    }
    e.target.value = '';
  };

  const completed = angles.filter((a) => capturedPhotos?.[a.key]).length;

  return (
    <div className="capture-wrap">
      <div className="capture-head">
        <div className="capture-progress">{completed} of {angles.length} captured</div>
        <div className="capture-position">{currentAngle.label.toUpperCase()} · {currentAngleIndex + 1}/{angles.length}</div>
      </div>

      <div className={comparePhoto ? 'capture-row compare' : 'capture-row'}>
        {comparePhoto && (
          <div className="compare-cell">
            <div className="compare-label">
              CHECKOUT REFERENCE{compareCaption ? <span className="compare-cap"> · {compareCaption}</span> : null}
            </div>
            <div className="compare-img" style={{ backgroundImage: `url(${comparePhoto})` }} />
          </div>
        )}
        <div className="compare-cell">
          {comparePhoto && <div className="compare-label live">LIVE · CAPTURING NOW</div>}
          <div className="viewfinder">
            {/* Video element is ALWAYS in the DOM so videoRef.current is set
                before the stream-attach effect runs. Hidden via CSS when the
                stream isn't ready yet. */}
            <video
              ref={videoRef}
              playsInline
              muted
              autoPlay
              style={{
                display: streamActive ? 'block' : 'none',
                width: '100%',
                height: '100%',
                objectFit: 'cover'
              }}
            />
            {streamError && (
              <div className="vf-error">
                <div className="vf-error-icon">📷</div>
                <div>{streamError}</div>
              </div>
            )}
            {!streamActive && !streamError && (
              <div className="vf-error">
                <div className="vf-error-icon">📷</div>
                <div>Requesting camera permission…</div>
              </div>
            )}
            <div className="vf-overlay">
              <div className="vf-corner tl" />
              <div className="vf-corner tr" />
              <div className="vf-corner bl" />
              <div className="vf-corner br" />
              <div className="vf-scan" />
            </div>
            <div className="vf-position">{currentAngle.label.toUpperCase()} · {currentAngleIndex + 1}/{angles.length}</div>
            <div className="vf-prompt">CENTER VEHICLE · TAP CAPTURE</div>
          </div>
        </div>
      </div>

      {/* Capture button */}
      <div className="capture-actions">
        <button
          type="button"
          className="capture-btn"
          onClick={() => fileInputRef.current?.click()}
        >
          Choose file
        </button>
        <button
          type="button"
          className="capture-shutter"
          onClick={capture}
          disabled={!streamActive || capturing}
        >
          {capturing ? '...' : '📷 Capture'}
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          capture="environment"
          onChange={onFileChange}
          style={{ display: 'none' }}
        />
      </div>

      {/* A missing baseline is normal — plenty of older checkouts never shot
          all 8 angles. Say so plainly instead of leaving a blank half. */}
      {comparePhotos && !comparePhoto && (
        <div className="compare-none">No checkout photo for this angle — capture as usual.</div>
      )}

      {onDamageNote && (
        <div className="damage-box">
          <label className="damage-label" htmlFor={`dmg-${currentAngle.key}`}>
            New damage on {currentAngle.label.toLowerCase()}?
            {comparePhoto ? ' Compare against the checkout photo above.' : ''}
          </label>
          <input
            id={`dmg-${currentAngle.key}`}
            type="text"
            className="damage-input"
            placeholder="e.g. 6-inch scratch below the door handle — not in the checkout photo"
            value={damageNotes?.[currentAngle.key] || ''}
            onChange={(e) => onDamageNote(currentAngle.key, e.target.value)}
          />
        </div>
      )}

      {/* Thumbnail grid */}
      <div className="thumb-grid">
        {angles.map((a, idx) => {
          const captured = capturedPhotos?.[a.key];
          const baseline = comparePhotos?.[a.key];
          const isCurrent = idx === currentAngleIndex;
          const flagged = !!damageNotes?.[a.key]?.trim();
          return (
            <div key={a.key} className="thumb-stack">
              {/* Checkout row sits ABOVE its check-in counterpart so the pair
                  reads as one column: how it left, how it came back. */}
              {comparePhotos && (
                <div
                  className={baseline ? 'thumb-base' : 'thumb-base empty'}
                  style={baseline ? { backgroundImage: `url(${baseline})` } : undefined}
                  title={baseline ? `${a.label} at checkout` : `No checkout photo for ${a.label}`}
                />
              )}
              <button
                type="button"
                className={
                  captured ? 'thumb captured' :
                  isCurrent ? 'thumb current' : 'thumb'
                }
                onClick={() => onAngleChange?.(idx)}
                title={a.label}
              >
                {captured ? (
                  <div className="thumb-img" style={{ backgroundImage: `url(${captured})` }} />
                ) : isCurrent ? '📷' : ''}
                <span className="thumb-label">{a.abbr}</span>
                {captured && <span className="thumb-check">✓</span>}
                {flagged && <span className="thumb-flag" title="New damage noted">!</span>}
              </button>
            </div>
          );
        })}
      </div>

      <style jsx>{`
        .capture-wrap { display: flex; flex-direction: column; gap: 14px; }
        .capture-head {
          display: flex;
          justify-content: space-between;
          align-items: baseline;
          padding: 0 2px;
        }
        .capture-progress { font-size: 13px; color: #6f668f; font-weight: 700; }
        .capture-position {
          font-size: 11px;
          font-weight: 800;
          color: #6d3df2;
          letter-spacing: .12em;
        }
        .capture-row {
          display: grid;
          grid-template-columns: 1fr;
          gap: 14px;
        }
        .capture-row.compare {
          grid-template-columns: 1fr 1fr;
        }
        @media (max-width: 720px) {
          .capture-row.compare { grid-template-columns: 1fr; }
        }
        .compare-cell { display: flex; flex-direction: column; gap: 8px; }
        .compare-label {
          font-size: 11px;
          font-weight: 800;
          color: #6f668f;
          letter-spacing: .12em;
        }
        .compare-label.live { color: #1fc7aa; }
        .compare-cap { font-weight: 700; letter-spacing: 0; text-transform: none; color: #8b83a6; }
        .compare-none {
          font-size: 12px;
          color: #6f668f;
          background: #f4f2fb;
          border: 1px solid #e2ddf3;
          border-radius: 10px;
          padding: 8px 12px;
          text-align: center;
        }
        .damage-box { display: flex; flex-direction: column; gap: 6px; }
        .damage-label { font-size: 12px; font-weight: 700; color: #6f668f; }
        .damage-input {
          width: 100%;
          padding: 10px 12px;
          border: 1px solid #d7cbff;
          border-radius: 12px;
          font-size: 13px;
          color: #2c2a5a;
        }
        .damage-input:focus { outline: none; border-color: #6d3df2; }
        .thumb-stack { display: flex; flex-direction: column; gap: 3px; }
        .thumb-base {
          aspect-ratio: 1;
          border-radius: 8px;
          background: #ece7fb center / cover no-repeat;
          border: 1px solid #e2ddf3;
        }
        .thumb-base.empty {
          background: repeating-linear-gradient(45deg, #f4f2fb, #f4f2fb 4px, #ece7fb 4px, #ece7fb 8px);
        }
        .thumb-flag {
          position: absolute;
          top: -4px; left: -4px;
          width: 20px; height: 20px;
          background: #e2574c;
          color: white;
          border-radius: 50%;
          display: flex; align-items: center; justify-content: center;
          font-size: 12px;
          font-weight: 800;
        }
        .compare-img {
          height: 240px;
          border-radius: 14px;
          background: #c5b1ff center / cover no-repeat;
          background-size: cover;
        }
        .viewfinder {
          height: 240px;
          border-radius: 14px;
          background: #1a1a2e;
          overflow: hidden;
          position: relative;
          display: flex; align-items: center; justify-content: center;
        }
        .viewfinder video {
          width: 100%; height: 100%; object-fit: cover;
        }
        .vf-error {
          color: white;
          text-align: center;
          padding: 24px;
          font-size: 13px;
        }
        .vf-error-icon { font-size: 32px; margin-bottom: 8px; opacity: .6; }
        .vf-overlay { position: absolute; inset: 0; pointer-events: none; }
        .vf-corner {
          position: absolute;
          width: 22px; height: 22px;
          border: 2.5px solid #1fc7aa;
        }
        .vf-corner.tl { top: 22%; left: 17%; border-right: none; border-bottom: none; }
        .vf-corner.tr { top: 22%; right: 17%; border-left: none; border-bottom: none; }
        .vf-corner.bl { bottom: 22%; left: 17%; border-right: none; border-top: none; }
        .vf-corner.br { bottom: 22%; right: 17%; border-left: none; border-top: none; }
        .vf-scan {
          position: absolute;
          top: 22%; left: 17%; right: 17%; bottom: 22%;
          background: linear-gradient(transparent 49%, rgba(31,199,170,.7) 50%, transparent 51%) center / 100% 100%;
          animation: scan 2.2s ease-in-out infinite;
        }
        @keyframes scan {
          0%, 100% { background-position: 0% 0%; }
          50% { background-position: 0% 100%; }
        }
        .vf-position {
          position: absolute;
          top: 8%; left: 50%; transform: translateX(-50%);
          background: rgba(0,0,0,.6);
          backdrop-filter: blur(8px);
          color: white;
          padding: 5px 14px;
          border-radius: 999px;
          font-size: 11px;
          font-weight: 700;
          letter-spacing: .05em;
        }
        .vf-prompt {
          position: absolute;
          bottom: 8%; left: 50%; transform: translateX(-50%);
          background: rgba(31,199,170,.95);
          color: white;
          padding: 5px 14px;
          border-radius: 999px;
          font-size: 11px;
          font-weight: 800;
          letter-spacing: .08em;
        }
        .capture-actions {
          display: flex;
          gap: 10px;
          justify-content: center;
        }
        .capture-btn {
          padding: 10px 18px;
          background: white;
          color: #6d3df2;
          border: 1px solid #d7cbff;
          border-radius: 12px;
          font-size: 13px;
          font-weight: 800;
          cursor: pointer;
        }
        .capture-shutter {
          padding: 12px 32px;
          background: linear-gradient(135deg, #8752FE, #6d3df2);
          color: white;
          border: none;
          border-radius: 14px;
          font-size: 15px;
          font-weight: 800;
          cursor: pointer;
          box-shadow: 0 8px 20px rgba(135,82,254,.32);
        }
        .capture-shutter:disabled { opacity: .5; cursor: not-allowed; }
        .thumb-grid {
          display: grid;
          grid-template-columns: repeat(4, 1fr);
          gap: 10px;
        }
        @media (min-width: 720px) {
          .thumb-grid { grid-template-columns: repeat(8, 1fr); }
        }
        .thumb {
          aspect-ratio: 1;
          border-radius: 12px;
          background: linear-gradient(135deg, rgba(135,82,254,.10), rgba(135,82,254,.04));
          border: 2px dashed rgba(135,82,254,.28);
          display: flex; align-items: center; justify-content: center;
          font-size: 22px;
          color: #6d3df2;
          position: relative;
          cursor: pointer;
          padding: 0;
          overflow: hidden;
        }
        .thumb.current {
          border-color: #1fc7aa;
          background: rgba(31,199,170,.08);
        }
        .thumb.captured {
          border: none;
          background: #ddd0ff;
        }
        .thumb-img {
          position: absolute;
          inset: 0;
          background-size: cover;
          background-position: center;
        }
        .thumb-label {
          position: absolute;
          bottom: 4px; left: 6px;
          font-size: 9px;
          color: #6f668f;
          font-weight: 700;
        }
        .thumb.captured .thumb-label { color: white; text-shadow: 0 1px 2px rgba(0,0,0,.5); }
        .thumb-check {
          position: absolute;
          top: -4px; right: -4px;
          width: 20px; height: 20px;
          background: #1fc7aa;
          color: white;
          border-radius: 50%;
          display: flex; align-items: center; justify-content: center;
          font-size: 11px;
          font-weight: 800;
          box-shadow: 0 2px 6px rgba(31,199,170,.4);
        }
      `}</style>
    </div>
  );
}

function findNextEmpty(angles, captured, fromIndex) {
  for (let i = fromIndex + 1; i < angles.length; i++) {
    if (!captured?.[angles[i].key]) return i;
  }
  for (let i = 0; i < fromIndex; i++) {
    if (!captured?.[angles[i].key]) return i;
  }
  return -1;
}
