'use client';

/**
 * Pillar 2 — Metric input components for the wizards.
 *
 * Three controls, each a glass card:
 *   - OdometerInput: numeric input with optional OCR-scan button (Phase 2)
 *   - FuelLevelInput: tap-on-track gauge with live percent
 *   - CleanlinessInput: 5-star rating
 *   - SmokingToggle: animated toggle switch
 *
 * Styling matches design/mockups/pillar2-checkin-checkout/index.html.
 */

export function OdometerInput({ value, onChange, label = 'Odometer', baseline, hint, allowOcr = false }) {
  const v = String(value || '');
  return (
    <div className="metric-card">
      <div className="metric-head">
        <div className="metric-label">{label}</div>
        {allowOcr && (
          <button type="button" className="ocr-pill" onClick={() => alert('OCR scan available in Phase 2')}>
            📸 OCR
          </button>
        )}
      </div>
      <input
        type="number"
        inputMode="numeric"
        value={v}
        onChange={(e) => onChange(e.target.value)}
        placeholder="0"
        className="metric-num"
      />
      {hint && <div className="metric-hint">{hint}</div>}
      {baseline != null && (
        <div className="metric-baseline">Pickup baseline: <strong>{Number(baseline).toLocaleString()} mi</strong></div>
      )}
      <style jsx>{`
        .metric-card {
          background: white;
          border: 1px solid #e6dfff;
          border-radius: 16px;
          padding: 18px;
          box-shadow: 0 8px 22px rgba(35,21,80,.08);
        }
        .metric-head {
          display: flex;
          justify-content: space-between;
          align-items: center;
          margin-bottom: 10px;
        }
        .metric-label {
          font-size: 11px;
          font-weight: 800;
          color: #6f668f;
          text-transform: uppercase;
          letter-spacing: .12em;
        }
        .ocr-pill {
          padding: 5px 10px;
          background: linear-gradient(135deg, rgba(135,82,254,.15), rgba(135,82,254,.06));
          color: #6d3df2;
          border: none;
          border-radius: 999px;
          font-size: 11px;
          font-weight: 800;
          cursor: pointer;
        }
        .metric-num {
          font-size: 32px;
          font-weight: 800;
          color: #211a38;
          letter-spacing: -.02em;
          width: 100%;
          border: none;
          padding: 0;
          background: transparent;
          outline: none;
          font-variant-numeric: tabular-nums;
        }
        .metric-num::-webkit-outer-spin-button,
        .metric-num::-webkit-inner-spin-button {
          -webkit-appearance: none; margin: 0;
        }
        .metric-num[type=number] { -moz-appearance: textfield; }
        .metric-hint {
          font-size: 12px;
          font-weight: 700;
          color: #f59e0b;
          margin-top: 4px;
        }
        .metric-baseline {
          font-size: 11px;
          color: #6f668f;
          margin-top: 4px;
        }
        .metric-baseline strong { color: #211a38; }
      `}</style>
    </div>
  );
}

export function FuelLevelInput({ value, onChange, label = 'Fuel Level', baseline, hint }) {
  const pct = Math.max(0, Math.min(1, Number(value || 0)));
  const percentage = Math.round(pct * 100);
  const handleClick = (e) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const ratio = Math.max(0, Math.min(1, x / rect.width));
    // Snap to nearest 1/8
    const snapped = Math.round(ratio * 8) / 8;
    onChange(snapped);
  };
  return (
    <div className="metric-card">
      <div className="metric-head">
        <div className="metric-label">{label}</div>
        <div className="metric-value">{percentage}% · {fuelWord(pct)}</div>
      </div>
      <div className="gauge" onClick={handleClick}>
        <div className="gauge-fill" style={{ width: `${percentage}%` }} />
      </div>
      <div className="gauge-ticks">
        <span>E</span><span>¼</span><span>½</span><span>¾</span><span>F</span>
      </div>
      {hint && <div className="metric-hint">{hint}</div>}
      {baseline != null && (
        <div className="metric-baseline">Pickup baseline: <strong>{Math.round(Number(baseline) * 100)}%</strong></div>
      )}
      <style jsx>{`
        .metric-card { background: white; border: 1px solid #e6dfff; border-radius: 16px; padding: 18px; box-shadow: 0 8px 22px rgba(35,21,80,.08); }
        .metric-head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 14px; }
        .metric-label { font-size: 11px; font-weight: 800; color: #6f668f; text-transform: uppercase; letter-spacing: .12em; }
        .metric-value { font-size: 16px; font-weight: 800; color: ${pct >= 0.95 ? '#1fc7aa' : (pct < 0.5 ? '#f59e0b' : '#211a38')}; }
        .gauge {
          position: relative;
          height: 8px;
          background: rgba(135,82,254,.12);
          border-radius: 6px;
          cursor: pointer;
        }
        .gauge-fill {
          height: 100%;
          background: linear-gradient(90deg, #f59e0b, #1fc7aa);
          border-radius: 6px;
          position: relative;
          transition: width .2s ease;
        }
        .gauge-fill::after {
          content: '';
          position: absolute;
          right: -7px; top: -4px;
          width: 16px; height: 16px;
          background: white;
          border: 2.5px solid #6d3df2;
          border-radius: 50%;
          box-shadow: 0 2px 6px rgba(35,21,80,.18);
        }
        .gauge-ticks {
          display: flex;
          justify-content: space-between;
          margin-top: 10px;
          font-size: 10px;
          color: #6f668f;
          font-weight: 700;
        }
        .metric-hint { font-size: 12px; font-weight: 700; color: #f59e0b; margin-top: 8px; }
        .metric-baseline { font-size: 11px; color: #6f668f; margin-top: 4px; }
        .metric-baseline strong { color: #211a38; }
      `}</style>
    </div>
  );
}

function fuelWord(p) {
  if (p >= 0.95) return 'Full';
  if (p >= 0.75) return '¾';
  if (p >= 0.50) return 'Half';
  if (p >= 0.25) return '¼';
  if (p > 0) return 'Low';
  return 'Empty';
}

export function CleanlinessInput({ value, onChange, label = 'Cleanliness', baseline, hint }) {
  const v = Math.max(0, Math.min(5, Number(value || 0)));
  return (
    <div className="metric-card">
      <div className="metric-head">
        <div className="metric-label">{label}</div>
        <div className="metric-value">{v}/5 · {cleanWord(v)}</div>
      </div>
      <div className="stars">
        {[1,2,3,4,5].map((n) => (
          <button
            key={n}
            type="button"
            className={n <= v ? 'star filled' : 'star empty'}
            onClick={() => onChange(n)}
          >
            ★
          </button>
        ))}
      </div>
      {hint && <div className="metric-hint">{hint}</div>}
      {baseline != null && (
        <div className="metric-baseline">Pickup baseline: <strong>{baseline}/5</strong></div>
      )}
      <style jsx>{`
        .metric-card { background: white; border: 1px solid #e6dfff; border-radius: 16px; padding: 18px; box-shadow: 0 8px 22px rgba(35,21,80,.08); }
        .metric-head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px; }
        .metric-label { font-size: 11px; font-weight: 800; color: #6f668f; text-transform: uppercase; letter-spacing: .12em; }
        .metric-value { font-size: 16px; font-weight: 800; color: ${v === 5 ? '#1fc7aa' : (v <= 2 ? '#f59e0b' : '#211a38')}; }
        .stars { display: flex; gap: 6px; }
        .star {
          background: none;
          border: none;
          font-size: 28px;
          cursor: pointer;
          padding: 0;
          transition: transform .15s;
        }
        .star:hover { transform: scale(1.15); }
        .star.filled { color: #1fc7aa; }
        .star.empty { color: rgba(135,82,254,.2); }
        .metric-hint { font-size: 12px; font-weight: 700; color: #f59e0b; margin-top: 8px; }
        .metric-baseline { font-size: 11px; color: #6f668f; margin-top: 4px; }
        .metric-baseline strong { color: #211a38; }
      `}</style>
    </div>
  );
}

function cleanWord(v) {
  if (v === 5) return 'Pristine';
  if (v >= 4) return 'Clean';
  if (v === 3) return 'Acceptable';
  if (v === 2) return 'Dirty';
  if (v === 1) return 'Filthy';
  return '—';
}

export function SmokingToggle({ value, onChange, label = 'Smoking detected' }) {
  return (
    <div className="metric-card">
      <div className="row">
        <div>
          <div className="metric-label">{label}</div>
          <div className="metric-sub">
            {value
              ? 'Smoke residue or tobacco odor present · $250 cleaning fee will be added'
              : 'No smoke residue or odor · no fee'}
          </div>
        </div>
        <button
          type="button"
          className={value ? 'toggle on' : 'toggle'}
          onClick={() => onChange(!value)}
          aria-pressed={value}
        >
          <span className="thumb" />
        </button>
      </div>
      <style jsx>{`
        .metric-card { background: white; border: 1px solid #e6dfff; border-radius: 16px; padding: 16px 18px; box-shadow: 0 8px 22px rgba(35,21,80,.08); }
        .row { display: flex; justify-content: space-between; align-items: center; gap: 14px; }
        .metric-label { font-size: 11px; font-weight: 800; color: #6f668f; text-transform: uppercase; letter-spacing: .12em; }
        .metric-sub { font-size: 11px; color: ${value ? '#f59e0b' : '#6f668f'}; margin-top: 4px; font-weight: ${value ? 700 : 500}; }
        .toggle {
          width: 52px;
          height: 30px;
          border-radius: 999px;
          background: rgba(135,82,254,.18);
          border: none;
          position: relative;
          cursor: pointer;
          padding: 0;
          flex-shrink: 0;
          transition: background .2s;
        }
        .toggle.on { background: linear-gradient(135deg, #8752FE, #6d3df2); }
        .thumb {
          position: absolute;
          top: 3px;
          left: 3px;
          width: 24px;
          height: 24px;
          background: white;
          border-radius: 50%;
          box-shadow: 0 2px 6px rgba(0,0,0,.2);
          transition: all .25s cubic-bezier(0.34, 1.56, 0.64, 1);
        }
        .toggle.on .thumb { left: 25px; }
      `}</style>
    </div>
  );
}
