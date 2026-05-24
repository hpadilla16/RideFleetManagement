'use client';

/**
 * DateRangePicker — Round 24 (2026-05-22).
 *
 * Generic date range input for all report pages. Custom from/to + a row of
 * preset chips that snap to common windows. Designed to feel native to RFM
 * without pulling in a heavy calendar library.
 *
 * Props:
 *   value: { from: 'YYYY-MM-DD', to: 'YYYY-MM-DD' }
 *   onChange: ({ from, to }) => void
 *   presets: optional array of preset definitions; defaults provided.
 *
 * Each preset has the shape:
 *   { label: 'This month', compute: () => ({ from, to }) }
 */

import { useMemo } from 'react';

function isoDay(d) {
  return d.toISOString().slice(0, 10);
}

function today() {
  return new Date();
}

const DEFAULT_PRESETS = [
  {
    label: 'Today',
    compute: () => {
      const t = today();
      const s = isoDay(t);
      return { from: s, to: s };
    },
  },
  {
    label: 'This month',
    compute: () => {
      const t = today();
      const from = new Date(t.getFullYear(), t.getMonth(), 1);
      return { from: isoDay(from), to: isoDay(t) };
    },
  },
  {
    label: 'Last month',
    compute: () => {
      const t = today();
      const from = new Date(t.getFullYear(), t.getMonth() - 1, 1);
      const to = new Date(t.getFullYear(), t.getMonth(), 0); // last day of prev month
      return { from: isoDay(from), to: isoDay(to) };
    },
  },
  {
    label: 'Last 3 months',
    compute: () => {
      const t = today();
      const from = new Date(t.getFullYear(), t.getMonth() - 3, 1);
      return { from: isoDay(from), to: isoDay(t) };
    },
  },
  {
    label: 'YTD',
    compute: () => {
      const t = today();
      const from = new Date(t.getFullYear(), 0, 1);
      return { from: isoDay(from), to: isoDay(t) };
    },
  },
  {
    label: 'Next 7 days',
    compute: () => {
      const t = today();
      const to = new Date(t.getTime() + 7 * 24 * 60 * 60 * 1000);
      return { from: isoDay(t), to: isoDay(to) };
    },
  },
  {
    label: 'Next 30 days',
    compute: () => {
      const t = today();
      const to = new Date(t.getTime() + 30 * 24 * 60 * 60 * 1000);
      return { from: isoDay(t), to: isoDay(to) };
    },
  },
];

/**
 * BACKWARD_PRESETS — preset pack for reports that only look at past data
 * (utilization, toll-per-vehicle, toll-per-location, etc.). Last N days
 * ending today, plus YTD.
 */
export const BACKWARD_PRESETS = [
  {
    label: 'Last 7 days',
    compute: () => {
      const t = today();
      const from = new Date(t.getTime() - 6 * 24 * 60 * 60 * 1000);
      return { from: isoDay(from), to: isoDay(t) };
    },
  },
  {
    label: 'Last 30 days',
    compute: () => {
      const t = today();
      const from = new Date(t.getTime() - 29 * 24 * 60 * 60 * 1000);
      return { from: isoDay(from), to: isoDay(t) };
    },
  },
  {
    label: 'Last 90 days',
    compute: () => {
      const t = today();
      const from = new Date(t.getTime() - 89 * 24 * 60 * 60 * 1000);
      return { from: isoDay(from), to: isoDay(t) };
    },
  },
  {
    label: 'Last 6 months',
    compute: () => {
      const t = today();
      const from = new Date(t.getTime() - 179 * 24 * 60 * 60 * 1000);
      return { from: isoDay(from), to: isoDay(t) };
    },
  },
  {
    label: 'Last year',
    compute: () => {
      const t = today();
      const from = new Date(t.getTime() - 364 * 24 * 60 * 60 * 1000);
      return { from: isoDay(from), to: isoDay(t) };
    },
  },
  {
    label: 'YTD',
    compute: () => {
      const t = today();
      const from = new Date(t.getFullYear(), 0, 1);
      return { from: isoDay(from), to: isoDay(t) };
    },
  },
];

export function DateRangePicker({ value, onChange, presets = DEFAULT_PRESETS }) {
  const from = value?.from || '';
  const to = value?.to || '';

  const matchingPreset = useMemo(() => {
    for (const p of presets) {
      const r = p.compute();
      if (r.from === from && r.to === to) return p.label;
    }
    return null;
  }, [from, to, presets]);

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
      <span style={{ fontSize: 13, color: '#6f668f' }}>Period</span>
      <input
        type="date"
        value={from}
        onChange={(e) => onChange?.({ from: e.target.value, to })}
        style={{ fontSize: 13, padding: '6px 10px', minWidth: 130 }}
      />
      <span style={{ fontSize: 13, color: '#6f668f' }}>to</span>
      <input
        type="date"
        value={to}
        onChange={(e) => onChange?.({ from, to: e.target.value })}
        style={{ fontSize: 13, padding: '6px 10px', minWidth: 130 }}
      />
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        {presets.map((p) => {
          const active = matchingPreset === p.label;
          return (
            <button
              key={p.label}
              onClick={() => {
                const r = p.compute();
                onChange?.(r);
              }}
              style={{
                fontSize: 12,
                padding: '5px 10px',
                background: active ? '#534AB7' : 'transparent',
                color: active ? 'white' : '#211a38',
                border: active ? 'none' : '0.5px solid #d3d1c7',
                borderRadius: 999,
                cursor: 'pointer',
                fontWeight: active ? 500 : 400,
              }}
            >
              {p.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}
