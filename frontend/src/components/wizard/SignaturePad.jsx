'use client';

/**
 * Pillar 2 — Signature pad component.
 *
 * Canvas-based signature capture that works on touch (iPad, tablets) and
 * mouse. Renders a dashed-border pad with a baseline. Parent receives the
 * dataURL via the onChange callback. Includes Clear button.
 *
 * Adapted from frontend/src/app/customer/sign-agreement/page.js — same
 * mouse/touch handling, same trim threshold (2KB minimum data URL).
 */

import { useRef, useState, useEffect } from 'react';

export function SignaturePad({
  height = 160,
  label = 'Customer Signature',
  signerName,
  onSignerNameChange,
  onSignatureChange,
  onClear,
  showName = true,
  helperText
}) {
  const canvasRef = useRef(null);
  const [drawing, setDrawing] = useState(false);
  const [hasContent, setHasContent] = useState(false);

  // Resize canvas to fit container with correct DPR for crisp rendering
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const resize = () => {
      const parent = canvas.parentElement;
      if (!parent) return;
      const w = parent.clientWidth - 32;  // padding subtract
      const h = height - 32;
      const dpr = window.devicePixelRatio || 1;
      canvas.width = w * dpr;
      canvas.height = h * dpr;
      canvas.style.width = w + 'px';
      canvas.style.height = h + 'px';
      const ctx = canvas.getContext('2d');
      ctx.scale(dpr, dpr);
      ctx.lineWidth = 2.5;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.strokeStyle = '#211a38';
    };
    resize();
    window.addEventListener('resize', resize);
    return () => window.removeEventListener('resize', resize);
  }, [height]);

  const pos = (e) => {
    const c = canvasRef.current;
    if (!c) return null;
    const r = c.getBoundingClientRect();
    const p = e.touches?.[0] || e;
    return { x: p.clientX - r.left, y: p.clientY - r.top };
  };

  const start = (e) => {
    e.preventDefault();
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
    e.preventDefault();
    const c = canvasRef.current;
    if (!c) return;
    const ctx = c.getContext('2d');
    const p = pos(e);
    if (!p) return;
    ctx.lineTo(p.x, p.y);
    ctx.stroke();
    if (!hasContent) setHasContent(true);
  };

  const end = () => {
    if (!drawing) return;
    setDrawing(false);
    const c = canvasRef.current;
    if (!c) return;
    const dataUrl = c.toDataURL('image/png');
    if (dataUrl && dataUrl.length >= 2000) {
      onSignatureChange?.(dataUrl);
    }
  };

  const clearSig = () => {
    const c = canvasRef.current;
    if (!c) return;
    const ctx = c.getContext('2d');
    ctx.clearRect(0, 0, c.width, c.height);
    setHasContent(false);
    onSignatureChange?.('');
    onClear?.();
  };

  return (
    <div className="sig-wrap">
      <div className="sig-head">
        <div className="sig-label">{label}</div>
        {hasContent && (
          <button type="button" className="sig-clear" onClick={clearSig}>Clear</button>
        )}
      </div>
      <div className="sig-pad" style={{ height }}>
        <canvas
          ref={canvasRef}
          onMouseDown={start}
          onMouseMove={move}
          onMouseUp={end}
          onMouseLeave={end}
          onTouchStart={start}
          onTouchMove={move}
          onTouchEnd={end}
        />
        {!hasContent && (
          <div className="sig-placeholder">Sign with your finger or stylus</div>
        )}
        <div className="sig-baseline">{signerName || 'Customer signature above'}</div>
      </div>
      {showName && (
        <div className="sig-name-row">
          <input
            type="text"
            placeholder="Full legal name"
            value={signerName || ''}
            onChange={(e) => onSignerNameChange?.(e.target.value)}
            className="sig-name-input"
          />
        </div>
      )}
      {helperText && <div className="sig-helper">{helperText}</div>}
      <style jsx>{`
        .sig-wrap { width: 100%; }
        .sig-head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px; }
        .sig-label { font-size: 11px; font-weight: 800; color: #6f668f; letter-spacing: .12em; text-transform: uppercase; }
        .sig-clear { background: none; border: none; color: #6d3df2; font-weight: 700; font-size: 12px; cursor: pointer; padding: 4px 10px; border-radius: 6px; }
        .sig-clear:hover { background: rgba(135,82,254,.08); }
        .sig-pad {
          background: white;
          border: 1.5px dashed #d7cbff;
          border-radius: 14px;
          position: relative;
          overflow: hidden;
          padding: 16px;
        }
        canvas {
          width: 100%;
          height: 100%;
          touch-action: none;
          cursor: crosshair;
        }
        .sig-placeholder {
          position: absolute;
          top: 50%; left: 50%; transform: translate(-50%, -50%);
          color: #a89bd8;
          font-size: 13px;
          pointer-events: none;
          font-weight: 600;
        }
        .sig-baseline {
          position: absolute;
          bottom: 8px;
          left: 16px;
          font-size: 11px;
          color: #a89bd8;
          font-weight: 700;
          pointer-events: none;
        }
        .sig-name-row { margin-top: 12px; }
        .sig-name-input {
          width: 100%;
          padding: 12px 14px;
          border: 1px solid #e6dfff;
          border-radius: 12px;
          background: white;
          font-size: 15px;
          font-weight: 700;
          color: #211a38;
          outline: none;
          transition: border-color .15s;
        }
        .sig-name-input:focus { border-color: #6d3df2; box-shadow: 0 0 0 3px rgba(135,82,254,.12); }
        .sig-name-input::placeholder { color: #a89bd8; font-weight: 500; }
        .sig-helper { font-size: 11px; color: #6f668f; margin-top: 8px; line-height: 1.5; }
      `}</style>
    </div>
  );
}
