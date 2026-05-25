'use client';

/**
 * BookingPaceChart — "% of capacity booked at T days before pickup"
 * averaged across the days in the selected window. Compares current
 * period vs LY (typical pace).
 *
 * X axis is days remaining until pickup, plotted decreasing left → right
 * so that "day of pickup" sits on the far right (matching the mental model
 * of bookings filling up over time).
 *
 * Props:
 *   binsDaysOut: number[] (e.g. [0,1,...,60])
 *   thisPct:     number[] (0..1 decimals, same length as binsDaysOut)
 *   lastYearPct: number[] | null
 *   showLastYear: boolean
 */

import { Line } from 'react-chartjs-2';
import { ensureChartsRegistered, CHART_PALETTE } from './chartjs-setup';

ensureChartsRegistered();

export function BookingPaceChart({
  binsDaysOut = [],
  thisPct = [],
  lastYearPct = null,
  showLastYear = false,
  height = 200,
}) {
  // Plot from largest lead time on the left → 0 (day of pickup) on the right.
  // Mirror the arrays once here so chart code stays simple.
  const xLabels = [...binsDaysOut].sort((a, b) => b - a).map((t) =>
    t === 0 ? 'Day of' : t === 1 ? '1d out' : `${t}d out`
  );
  const reorder = (arr) => [...arr].reverse(); // bins are 0..N; we want N..0

  const datasets = [
    {
      label: 'This period',
      data: reorder(thisPct).map((p) => Math.round(p * 1000) / 10),
      borderColor: CHART_PALETTE.brandPurple,
      backgroundColor: 'rgba(83, 74, 183, 0.10)',
      borderWidth: 2,
      pointRadius: 0,
      pointHoverRadius: 4,
      tension: 0.3,
      fill: true,
    },
  ];

  if (showLastYear && Array.isArray(lastYearPct) && lastYearPct.length > 0) {
    datasets.push({
      label: 'Typical pace (last year)',
      data: reorder(lastYearPct).map((p) => Math.round(p * 1000) / 10),
      borderColor: CHART_PALETTE.brandMint,
      backgroundColor: 'transparent',
      borderWidth: 1.5,
      borderDash: [5, 4],
      pointRadius: 0,
      pointHoverRadius: 3,
      tension: 0.3,
      fill: false,
    });
  }

  const data = { labels: xLabels, datasets };

  const options = {
    responsive: true,
    maintainAspectRatio: false,
    animation: false,
    interaction: { mode: 'index', intersect: false },
    plugins: {
      legend: {
        position: 'top', align: 'end',
        labels: { font: { size: 11 }, color: CHART_PALETTE.brandInk, boxWidth: 18, boxHeight: 2 },
      },
      tooltip: {
        callbacks: {
          label: (ctx) => `${ctx.dataset.label}: ${ctx.parsed.y.toFixed(1)}% of capacity`,
        },
      },
    },
    scales: {
      x: {
        ticks: { color: CHART_PALETTE.muted, font: { size: 10 }, maxRotation: 0, autoSkip: true, autoSkipPadding: 12 },
        grid: { display: false },
      },
      y: {
        beginAtZero: true,
        max: 100,
        ticks: { callback: (v) => `${v}%`, color: CHART_PALETTE.muted, font: { size: 10 } },
        grid: { color: CHART_PALETTE.gridLine, drawBorder: false },
      },
    },
  };

  return (
    <div style={{ height, position: 'relative' }}>
      <Line data={data} options={options} />
    </div>
  );
}
