'use client';

/**
 * CategoryDonutChart — Chart.js doughnut showing category mix. Slices use a
 * fixed brand-aligned palette so the colors stay stable across reports.
 *
 * Props:
 *   slices: [{ key, label, value, color? }]
 *   centerLabel?: string    — large text in the donut center (e.g. "Sales")
 *   centerValue?: string    — small text below the center label (e.g. "$24,318")
 *   onSliceClick?: (idx) => void
 *   height?: number (default 200)
 *   formatValue?: (n) => string  — custom value formatter for tooltips/legend
 */

import { Doughnut } from 'react-chartjs-2';
import { ensureChartsRegistered } from './chartjs-setup';

ensureChartsRegistered();

// Stable category-color sequence. Reserve gray (last) for the "Other" bucket.
const DEFAULT_PALETTE = [
  '#534AB7', // brand purple
  '#7F77DD', // brand purple light
  '#1fc7aa', // brand mint
  '#EF9F27', // amber
  '#D85A30', // coral
  '#378ADD', // blue
  '#ED93B1', // pink
  '#639922', // green
  '#5DCAA5', // teal
  '#888780', // gray (Other bucket usually)
];

function defaultFormatValue(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return '';
  return v.toLocaleString();
}

// Plugin: render center label/value inside the donut hole.
const centerTextPlugin = {
  id: 'rfm-donut-center-text',
  afterDraw(chart, _args, opts) {
    if (!opts || (!opts.label && !opts.value)) return;
    const { ctx, chartArea: { width, height, top, left } } = chart;
    ctx.save();
    const cx = left + width / 2;
    const cy = top + height / 2;
    if (opts.label) {
      ctx.font = '11px var(--font-sans), system-ui, sans-serif';
      ctx.fillStyle = '#6f668f';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(opts.label, cx, cy - 10);
    }
    if (opts.value) {
      ctx.font = '500 14px var(--font-sans), system-ui, sans-serif';
      ctx.fillStyle = '#211a38';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(opts.value, cx, cy + 8);
    }
    ctx.restore();
  },
};

export function CategoryDonutChart({
  slices = [],
  centerLabel,
  centerValue,
  onSliceClick,
  height = 200,
  formatValue = defaultFormatValue,
}) {
  const labels = slices.map((s) => s.label);
  const values = slices.map((s) => Number(s.value) || 0);
  const colors = slices.map((s, i) => s.color || DEFAULT_PALETTE[i % DEFAULT_PALETTE.length]);

  const data = {
    labels,
    datasets: [{
      data: values,
      backgroundColor: colors,
      borderColor: 'white',
      borderWidth: 1,
      hoverOffset: 4,
    }],
  };

  const options = {
    responsive: true,
    maintainAspectRatio: false,
    animation: false,
    cutout: '62%',
    onClick: onSliceClick
      ? (_e, els) => { if (els?.length) onSliceClick(els[0].index); }
      : undefined,
    plugins: {
      legend: { display: false },
      tooltip: {
        callbacks: {
          label: (ctx) => `${ctx.label}: ${formatValue(ctx.parsed)}`,
        },
      },
      'rfm-donut-center-text': { label: centerLabel, value: centerValue },
    },
  };

  return (
    <div style={{ height, position: 'relative' }}>
      <Doughnut data={data} options={options} plugins={[centerTextPlugin]} />
    </div>
  );
}

export const CATEGORY_DONUT_PALETTE = DEFAULT_PALETTE;
