'use client';

/**
 * UtilizationBarChart — daily fleet utilization (0..100%) as a Chart.js bar
 * chart. Replaces the inline SVG that lived in Round 24d's Forecast view.
 *
 * Props:
 *   days: [{ iso, label }]
 *   utilizationByDay: number[] (0..1 decimals)
 *   peakIdx?: number — index of the peak day (gets the peak colour)
 *
 * Bars colour:
 *   peak day → A32D2D (red),  utilization ≥ 75% → 534AB7 (brand purple),
 *   everything else → 7F77DD (brand purple light)
 */

import { Bar } from 'react-chartjs-2';
import { ensureChartsRegistered, CHART_PALETTE } from './chartjs-setup';

ensureChartsRegistered();

function barColor(u, isPeak) {
  if (isPeak) return CHART_PALETTE.peak;
  if (u >= 0.75) return CHART_PALETTE.brandPurple;
  return CHART_PALETTE.brandPurpleLight;
}

export function UtilizationBarChart({ days = [], utilizationByDay = [], peakIdx = -1, height = 180 }) {
  // Strip the weekday off the label ("Sat May 30" → "May 30") to keep ticks tight.
  const labels = days.map((d) => (d?.label || '').split(' ').slice(1).join(' '));
  const values = utilizationByDay.map((u) => Math.round(u * 100));

  const data = {
    labels,
    datasets: [
      {
        label: 'Utilization',
        data: values,
        backgroundColor: values.map((_, i) => barColor(utilizationByDay[i] || 0, i === peakIdx)),
        borderWidth: 0,
        borderRadius: 2,
      },
    ],
  };

  const options = {
    responsive: true,
    maintainAspectRatio: false,
    animation: false,
    plugins: {
      legend: { display: false },
      tooltip: {
        callbacks: {
          title: (items) => (items?.[0] ? days[items[0].dataIndex]?.label || '' : ''),
          label: (ctx) => `${ctx.parsed.y}% booked`,
        },
      },
    },
    scales: {
      x: {
        ticks: { color: CHART_PALETTE.muted, font: { size: 10 }, maxRotation: 0, autoSkip: true },
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
      <Bar data={data} options={options} />
    </div>
  );
}
