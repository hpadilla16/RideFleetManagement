'use client';

/**
 * Touch signature / initials pad for the Ride Kiosk (K7).
 * Draws with pointer events onto a canvas; emits a PNG dataUrl after each
 * stroke via onChange (null when cleared). The backend requires dataUrls of
 * length ≥ 200, which any real stroke easily satisfies.
 */

import { useEffect, useRef, useState } from 'react';

export function SignaturePad({ height = 150, placeholder = '', onChange, strokeColor = '#4c1d95' }) {
  const canvasRef = useRef(null);
  const drawingRef = useRef(false);
  const hasInkRef = useRef(false);
  const [hasInk, setHasInk] = useState(false);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return undefined;

    const setup = () => {
      const ratio = window.devicePixelRatio || 1;
      const rect = canvas.getBoundingClientRect();
      // Preserve strokes on resize is overkill for a kiosk pad — a resize
      // mid-signature is not a real tablet scenario; just reset cleanly.
      canvas.width = Math.max(1, Math.round(rect.width * ratio));
      canvas.height = Math.max(1, Math.round(rect.height * ratio));
      const ctx = canvas.getContext('2d');
      ctx.scale(ratio, ratio);
      ctx.lineWidth = 3;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.strokeStyle = strokeColor;
    };
    setup();

    const point = (e) => {
      const rect = canvas.getBoundingClientRect();
      return { x: e.clientX - rect.left, y: e.clientY - rect.top };
    };
    const ctx = () => canvas.getContext('2d');

    const down = (e) => {
      e.preventDefault();
      drawingRef.current = true;
      const p = point(e);
      ctx().beginPath();
      ctx().moveTo(p.x, p.y);
      try { canvas.setPointerCapture(e.pointerId); } catch {}
    };
    const move = (e) => {
      if (!drawingRef.current) return;
      e.preventDefault();
      const p = point(e);
      ctx().lineTo(p.x, p.y);
      ctx().stroke();
      if (!hasInkRef.current) { hasInkRef.current = true; setHasInk(true); }
    };
    const up = () => {
      if (!drawingRef.current) return;
      drawingRef.current = false;
      if (hasInkRef.current) {
        try { onChange?.(canvas.toDataURL('image/png')); } catch {}
      }
    };

    canvas.addEventListener('pointerdown', down);
    canvas.addEventListener('pointermove', move);
    canvas.addEventListener('pointerup', up);
    canvas.addEventListener('pointercancel', up);
    return () => {
      canvas.removeEventListener('pointerdown', down);
      canvas.removeEventListener('pointermove', move);
      canvas.removeEventListener('pointerup', up);
      canvas.removeEventListener('pointercancel', up);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const clear = () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.restore();
    hasInkRef.current = false;
    setHasInk(false);
    onChange?.(null);
  };

  return (
    <div style={{ width: '100%' }}>
      <div className="kio-sig" style={{ height }}>
        {!hasInk && placeholder ? <span className="kio-sig-hint">{placeholder}</span> : null}
        <canvas ref={canvasRef} />
      </div>
      {hasInk ? (
        <div style={{ textAlign: 'right', marginTop: 6 }}>
          <button
            type="button"
            className="kio-btn back"
            style={{ minHeight: 48, padding: '6px 16px' }}
            onClick={clear}
          >
            ⌫
          </button>
        </div>
      ) : null}
    </div>
  );
}
