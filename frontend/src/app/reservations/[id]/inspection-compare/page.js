'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter, useSearchParams, useParams } from 'next/navigation';

function Pane({ title, src }) {
  const svgRef = useRef(null);
  const [zoom, setZoom] = useState(1);
  const [tool, setTool] = useState('box');
  const [color, setColor] = useState('#ff2d55');
  const [stroke, setStroke] = useState(3);
  const [dims, setDims] = useState({ w: 900, h: 600 });
  const [items, setItems] = useState([]);
  const [draft, setDraft] = useState(null);

  useEffect(() => {
    if (!src) return;
    const img = new Image();
    img.onload = () => setDims({ w: img.naturalWidth || 900, h: img.naturalHeight || 600 });
    img.src = src;
  }, [src]);

  const scaled = useMemo(
    () => ({ w: Math.max(1, Math.round(dims.w * zoom)), h: Math.max(1, Math.round(dims.h * zoom)) }),
    [dims, zoom]
  );

  const toPoint = (clientX, clientY) => {
    const r = svgRef.current.getBoundingClientRect();
    return { x: clientX - r.left, y: clientY - r.top };
  };

  const onPointerDown = (e) => {
    e.preventDefault();
    const isMouse = e.pointerType === 'mouse';
    if (isMouse && e.button !== 0) return;
    const p = toPoint(e.clientX, e.clientY);
    try { e.currentTarget.setPointerCapture?.(e.pointerId); } catch {}
    setDraft({ tool, color, stroke, x1: p.x, y1: p.y, x2: p.x, y2: p.y });
  };

  const onPointerMove = (e) => {
    if (!draft) return;
    e.preventDefault();
    const p = toPoint(e.clientX, e.clientY);
    setDraft((d) => (d ? { ...d, x2: p.x, y2: p.y } : d));
  };

  const onPointerUp = (e) => {
    if (!draft) return;
    e.preventDefault();
    const p = toPoint(e.clientX, e.clientY);
    const done = { ...draft, x2: p.x, y2: p.y };
    try { e.currentTarget.releasePointerCapture?.(e.pointerId); } catch {}
    if (Math.abs(done.x2 - done.x1) < 4 && Math.abs(done.y2 - done.y1) < 4) {
      setDraft(null);
      return;
    }
    setItems((prev) => [...prev, done]);
    setDraft(null);
  };

  const undo = () => setItems((prev) => prev.slice(0, -1));
  const clear = () => { setItems([]); setDraft(null); };

  const draw = (s, key) => {
    if (!s) return null;
    if (s.tool === 'box') {
      const x = Math.min(s.x1, s.x2);
      const y = Math.min(s.y1, s.y2);
      return (
        <rect
          key={key}
          x={x}
          y={y}
          width={Math.abs(s.x2 - s.x1)}
          height={Math.abs(s.y2 - s.y1)}
          fill="none"
          stroke={s.color}
          strokeWidth={s.stroke}
          vectorEffect="non-scaling-stroke"
          rx="2"
        />
      );
    }
    return (
      <line
        key={key}
        x1={s.x1}
        y1={s.y1}
        x2={s.x2}
        y2={s.y2}
        stroke={s.color}
        strokeWidth={s.stroke}
        vectorEffect="non-scaling-stroke"
        markerEnd="url(#arrowhead)"
      />
    );
  };

  return (
    <section className="pane">
      <div className="pane-head">
        <h3>{title}</h3>
        <div className="controls">
          <strong style={{ fontSize: 12, opacity: 0.9 }}>MARKUP:</strong>
          <button onClick={() => setZoom((z) => Math.max(0.4, Number((z - 0.1).toFixed(2))))}>-</button>
          <span>{Math.round(zoom * 100)}%</span>
          <button onClick={() => setZoom((z) => Math.min(4, Number((z + 0.1).toFixed(2))))}>+</button>
          <label style={{ fontSize: 12 }}>Tool</label>
          <select value={tool} onChange={(e) => setTool(e.target.value)}>
            <option value="box">Box</option>
            <option value="arrow">Arrow</option>
          </select>
          <label style={{ fontSize: 12 }}>Color</label>
          <input type="color" value={color} onChange={(e) => setColor(e.target.value)} />
          <label style={{ fontSize: 12 }}>Width</label>
          <input type="range" min="1" max="12" value={stroke} onChange={(e) => setStroke(Number(e.target.value))} />
          <button onClick={undo} disabled={!items.length}>Undo</button>
          <button onClick={clear}>Clear</button>
        </div>
      </div>

      <div className="viewport">
        <svg
          ref={svgRef}
          className="compare-svg"
          width={scaled.w}
          height={scaled.h}
          viewBox={`0 0 ${scaled.w} ${scaled.h}`}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          onPointerLeave={onPointerUp}
        >
          <defs>
            <marker id="arrowhead" markerWidth="8" markerHeight="6" refX="7" refY="3" orient="auto">
              <polygon points="0 0, 8 3, 0 6" fill={color} />
            </marker>
          </defs>
          <image href={src} x="0" y="0" width={scaled.w} height={scaled.h} preserveAspectRatio="none" />
          {items.map((s, i) => draw(s, `s-${i}`))}
          {draft ? draw(draft, 'draft') : null}
        </svg>
      </div>
    </section>
  );
}

export default function ComparePage() {
  const router = useRouter();
  const sp = useSearchParams();
  const { id } = useParams();
  const [payload, setPayload] = useState(null);

  useEffect(() => {
    const key = sp.get('key');
    try {
      if (key) {
        const raw = localStorage.getItem(key);
        if (raw) return setPayload(JSON.parse(raw));
      }
      if (window.name) {
        const fromName = JSON.parse(window.name);
        if (fromName?.a?.src && fromName?.b?.src) return setPayload(fromName);
      }
    } catch {}
  }, [sp]);

  return (
    <main className="compare-page">
      <style jsx>{`
        .compare-page{min-height:100vh;background:#0f0d18;color:#f3efff;padding:12px;font-family:Inter,Arial,sans-serif}
        .top{display:flex;gap:8px;align-items:center;justify-content:space-between;margin-bottom:10px}
        .grid{display:grid;grid-template-columns:1fr 1fr;gap:10px}
        .pane{background:#171327;border:1px solid #322652;border-radius:12px;padding:10px}
        .pane-head{display:flex;justify-content:space-between;align-items:center;gap:8px;margin-bottom:6px}
        .controls{display:flex;gap:6px;align-items:center;flex-wrap:wrap}
        .viewport{border:1px solid #3a2d5f;border-radius:10px;overflow:auto;background:#09070f;min-height:420px;max-height:70vh}
        .compare-svg{display:block;touch-action:none;cursor:crosshair}
        @media print{ @page{size:landscape;margin:8mm} .top{display:none} .compare-page{background:#fff;color:#111;padding:0} .grid{display:grid;grid-template-columns:calc(50% - 4px) calc(50% - 4px) !important;gap:8px;align-items:start} .pane{background:#fff;border-color:#ddd;padding:4px;break-inside:avoid;page-break-inside:avoid} .pane h3{font-size:12px;margin:0 0 4px 0} .controls{display:none !important} .viewport{min-height:0;max-height:none;overflow:visible;border-color:#ddd} .compare-svg{display:block;width:100% !important;height:auto !important;max-height:90mm !important} }
      `}</style>

      <div className="top no-print">
        <div>
          <h2 style={{ margin: 0 }}>Compare Inspection Photos</h2>
          <div style={{ fontSize: 12, opacity: 0.8 }}>Markups are local to this screen only (not saved to inspection photos).</div>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button onClick={() => router.push(`/reservations/${id}/inspection-report`)}>Back</button>
          <button onClick={() => window.print()}>Print with Markups</button>
        </div>
      </div>

      {!payload ? (
        <div>Missing compare payload.</div>
      ) : (
        <div className="grid">
          <Pane title={payload?.a?.label || 'Photo A'} src={payload?.a?.src} />
          <Pane title={payload?.b?.label || 'Photo B'} src={payload?.b?.src} />
        </div>
      )}
    </main>
  );
}

