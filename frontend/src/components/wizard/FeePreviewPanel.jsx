'use client';

/**
 * Pillar 2 — Live fee preview panel.
 *
 * Animated card stack that shows fees computed from the current inputs.
 * Each row fades + slides in with a staggered delay matching the mockup.
 * Zero state shown as a mint "no fees" card. Total summarized in a dark
 * ink card at the bottom with a radial purple glow.
 */

export function FeePreviewPanel({ items, total, title = 'FEES · LIVE PREVIEW' }) {
  return (
    <div className="fee-panel">
      <div className="fee-panel-title">{title}</div>

      {items.length === 0 ? (
        <div className="fee-empty">
          <div className="fee-empty-icon">✓</div>
          <div>
            <div className="fee-empty-h">No fees</div>
            <div className="fee-empty-sub">Vehicle returned within rental terms · balance unchanged</div>
          </div>
        </div>
      ) : (
        <div className="fee-stack">
          {items.map((item, idx) => (
            <FeeRow key={item.feeType} item={item} delay={idx * 0.08} />
          ))}
        </div>
      )}

      <div className="fee-total">
        <div className="fee-total-label">FEES SUBTOTAL · LIVE</div>
        <div className="fee-total-value">${total.toFixed(2)}</div>
        {items.length > 0 && (
          <div className="fee-total-note">
            Will be added to the agreement and shown on the customer invoice email
          </div>
        )}
      </div>

      <style jsx>{`
        .fee-panel {
          display: flex;
          flex-direction: column;
          gap: 12px;
        }
        .fee-panel-title {
          font-size: 11px;
          font-weight: 800;
          color: #6f668f;
          letter-spacing: .12em;
        }
        .fee-stack {
          display: grid;
          gap: 8px;
        }
        .fee-empty {
          display: flex;
          align-items: center;
          gap: 12px;
          padding: 14px 16px;
          background: linear-gradient(135deg, rgba(31,199,170,.08), rgba(31,199,170,.02));
          border: 1px solid rgba(31,199,170,.22);
          border-radius: 12px;
        }
        .fee-empty-icon {
          width: 32px; height: 32px;
          background: #1fc7aa;
          color: white;
          border-radius: 50%;
          display: flex; align-items: center; justify-content: center;
          font-size: 16px;
          font-weight: 800;
          flex-shrink: 0;
        }
        .fee-empty-h {
          font-size: 13px;
          font-weight: 800;
          color: #211a38;
        }
        .fee-empty-sub {
          font-size: 11px;
          color: #6f668f;
          margin-top: 2px;
        }
        .fee-total {
          background: linear-gradient(135deg, #211a38 0%, #2c1e54 100%);
          color: white;
          border-radius: 14px;
          padding: 16px 20px;
          position: relative;
          overflow: hidden;
          margin-top: 6px;
        }
        .fee-total::before {
          content: '';
          position: absolute;
          top: -60%; right: -10%;
          width: 70%; height: 220%;
          background: radial-gradient(circle, rgba(135,82,254,.3) 0%, transparent 60%);
          pointer-events: none;
        }
        .fee-total-label {
          font-size: 11px;
          opacity: .7;
          font-weight: 700;
          letter-spacing: .1em;
          position: relative;
          z-index: 1;
        }
        .fee-total-value {
          font-size: 32px;
          font-weight: 800;
          letter-spacing: -.02em;
          margin-top: 4px;
          position: relative;
          z-index: 1;
        }
        .fee-total-note {
          font-size: 11px;
          opacity: .65;
          margin-top: 6px;
          position: relative;
          z-index: 1;
        }
      `}</style>
    </div>
  );
}

const ICON_PALETTE = {
  EXCESS_MILEAGE:    { glyph: 'M', bg: 'rgba(135,82,254,.15)', fg: '#6d3df2' },
  FUEL_REFILL:       { glyph: 'F', bg: 'rgba(245,158,11,.15)', fg: '#f59e0b' },
  CLEANING_LIGHT:    { glyph: 'C', bg: 'rgba(99,102,241,.15)', fg: '#4338ca' },
  CLEANING_MEDIUM:   { glyph: 'C', bg: 'rgba(99,102,241,.15)', fg: '#4338ca' },
  CLEANING_HEAVY:    { glyph: 'C', bg: 'rgba(99,102,241,.15)', fg: '#4338ca' },
  SMOKING:           { glyph: 'S', bg: 'rgba(239,68,68,.15)', fg: '#ef4444' }
};

function FeeRow({ item, delay = 0 }) {
  const palette = ICON_PALETTE[item.feeType] || ICON_PALETTE.EXCESS_MILEAGE;
  return (
    <div className="fee-row" style={{ animationDelay: `${delay}s` }}>
      <div className="fee-icon" style={{ background: palette.bg, color: palette.fg }}>
        {palette.glyph}
      </div>
      <div className="fee-meta">
        <div className="fee-name">{readableName(item.feeType)}</div>
        <div className="fee-sub">{item.formula || item.description}</div>
      </div>
      <div className="fee-amount">${item.total.toFixed(2)}</div>

      <style jsx>{`
        .fee-row {
          display: flex;
          align-items: center;
          gap: 12px;
          padding: 12px 16px;
          background: white;
          border: 1px solid #e6dfff;
          border-radius: 12px;
          animation: fadeSlideIn .4s ease-out both;
        }
        @keyframes fadeSlideIn {
          from { opacity: 0; transform: translateX(10px); }
          to { opacity: 1; transform: translateX(0); }
        }
        .fee-icon {
          width: 32px; height: 32px;
          border-radius: 9px;
          display: flex; align-items: center; justify-content: center;
          font-size: 14px;
          font-weight: 800;
          flex-shrink: 0;
        }
        .fee-meta { flex: 1; min-width: 0; }
        .fee-name {
          font-size: 13px;
          font-weight: 800;
          color: #211a38;
        }
        .fee-sub {
          font-size: 11px;
          color: #6f668f;
          margin-top: 2px;
        }
        .fee-amount {
          font-size: 16px;
          font-weight: 800;
          color: #211a38;
          font-variant-numeric: tabular-nums;
          flex-shrink: 0;
        }
      `}</style>
    </div>
  );
}

function readableName(feeType) {
  switch (feeType) {
    case 'EXCESS_MILEAGE': return 'Excess mileage';
    case 'FUEL_REFILL': return 'Fuel refill';
    case 'CLEANING_LIGHT': return 'Cleaning · light';
    case 'CLEANING_MEDIUM': return 'Cleaning · medium';
    case 'CLEANING_HEAVY': return 'Cleaning · heavy';
    case 'SMOKING': return 'Smoking penalty';
    default: return feeType;
  }
}
