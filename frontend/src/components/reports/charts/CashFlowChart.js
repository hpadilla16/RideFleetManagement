'use client';

/**
 * CashFlowChart — collected history and forward forecast on one timeline.
 *
 * The visual grammar carries the model (see cash-flow-math.js): history is a
 * solid filled line, COMMITTED forecast is a solid bar-like fill, PROJECTED
 * forecast is dashed and lighter. A reader must be able to tell at a glance
 * which future money is booked and which is a guess — blending them would be
 * the whole failure mode of a cash-flow chart.
 *
 * "Today" is drawn as the boundary: everything left of it happened.
 *
 * Props:
 *   history:  [{iso, label, collected}]
 *   forecast: [{iso, label, committed, projected, total, confidence}]
 *   onPointClick(iso, kind)  — drill into a day
 */

import { Line } from 'react-chartjs-2';
import { ensureChartsRegistered, CHART_PALETTE } from './chartjs-setup';

ensureChartsRegistered();

const money = (v) => `$${Number(v || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export function CashFlowChart({ history = [], forecast = [], onPointClick = null, height = 300 }) {
  const labels = [...history.map((d) => d.label), ...forecast.map((d) => d.label)];
  const isoByIndex = [...history.map((d) => d.iso), ...forecast.map((d) => d.iso)];
  const hN = history.length;

  // Each series spans the full axis with nulls where it does not apply, so the
  // three lines share one timeline without Chart.js re-interpolating.
  const pad = (before, arr, after) => [...Array(before).fill(null), ...arr, ...Array(after).fill(null)];

  const collected = pad(0, history.map((d) => Number(d.collected || 0)), forecast.length);
  // Repeat the last history point at the seam so the forecast lines start
  // attached to reality instead of floating.
  const seam = hN > 0 ? Number(history[hN - 1].collected || 0) : null;
  const committed = pad(Math.max(0, hN - 1), [
    ...(hN > 0 ? [seam] : []),
    ...forecast.map((d) => Number(d.committed || 0)),
  ], 0);
  const expected = pad(Math.max(0, hN - 1), [
    ...(hN > 0 ? [seam] : []),
    ...forecast.map((d) => Number(d.total || 0)),
  ], 0);

  const data = {
    labels,
    datasets: [
      {
        label: 'Collected',
        data: collected,
        borderColor: CHART_PALETTE.brandPurple,
        backgroundColor: 'rgba(83, 74, 183, 0.16)',
        borderWidth: 2,
        pointRadius: 0,
        pointHoverRadius: 5,
        fill: true,
        tension: 0.25,
      },
      {
        label: 'Expected (committed + projected)',
        data: expected,
        borderColor: CHART_PALETTE.muted,
        backgroundColor: 'rgba(111, 102, 143, 0.10)',
        borderWidth: 2,
        borderDash: [5, 4],
        pointRadius: 0,
        pointHoverRadius: 5,
        fill: true,
        tension: 0.25,
      },
      {
        label: 'Committed (already booked)',
        data: committed,
        borderColor: CHART_PALETTE.brandMint,
        backgroundColor: 'rgba(31, 199, 170, 0.22)',
        borderWidth: 2,
        pointRadius: 0,
        pointHoverRadius: 5,
        fill: true,
        tension: 0.25,
      },
    ],
  };

  const options = {
    responsive: true,
    maintainAspectRatio: false,
    interaction: { mode: 'index', intersect: false },
    onClick: (_evt, elements) => {
      if (!onPointClick || !elements?.length) return;
      const idx = elements[0].index;
      const iso = isoByIndex[idx];
      if (iso) onPointClick(iso, idx < hN ? 'HISTORY' : 'FORECAST');
    },
    plugins: {
      legend: { display: true, labels: { boxWidth: 12, font: { size: 11 } } },
      tooltip: {
        callbacks: {
          label: (ctx) => (ctx.parsed.y == null ? null : `${ctx.dataset.label}: ${money(ctx.parsed.y)}`),
          afterBody: (items) => {
            const idx = items?.[0]?.dataIndex;
            if (idx == null || idx < hN) return '';
            const f = forecast[idx - hN];
            if (!f) return '';
            const bits = [`Committed ${money(f.committed)} · projected ${money(f.projected)}`];
            if (!f.hasRate) bits.push('No history for this weekday yet');
            else if (f.confidence < 1) bits.push(`Projection confidence ${Math.round(f.confidence * 100)}%`);
            return bits.join('\n');
          },
        },
      },
    },
    scales: {
      x: {
        grid: { display: false },
        ticks: {
          color: CHART_PALETTE.axis,
          font: { size: 10 },
          maxRotation: 0,
          autoSkip: true,
          maxTicksLimit: 12,
          // Mark the boundary between what happened and what might.
          callback(value, index) {
            const raw = this.getLabelForValue(value);
            return index === hN - 1 ? `${raw} ▏today` : raw;
          },
        },
      },
      y: {
        beginAtZero: true,
        grid: { color: CHART_PALETTE.gridLine },
        ticks: {
          color: CHART_PALETTE.axis,
          font: { size: 10 },
          callback: (v) => (v >= 1000 ? `$${Math.round(v / 1000)}k` : `$${v}`),
        },
      },
    },
  };

  return (
    <div style={{ height, cursor: onPointClick ? 'pointer' : 'default' }}>
      <Line data={data} options={options} />
    </div>
  );
}

export default CashFlowChart;
