'use client';

/**
 * StackedDayBarChart — Chart.js stacked bar chart, one bar per day, segments
 * representing categorical counts (e.g. reservation status buckets). Tooltip
 * shows per-segment count and the day total in the footer.
 *
 * Props:
 *   days:    [{ iso, label }]                    one entry per X tick
 *   series:  [{ key, label, color, data: [...] }]
 *           Each series produces one stack segment; data length must match
 *           days length. Order of `series` controls stacking order
 *           (first = bottom).
 *   highlightIdx?: number          — index of a day to call out in the X-tick label colour
 *   onBarClick?:   (dayIdx) => void — clicking a bar fires the day index
 *   height?: number (default 220)
 */

import { Bar } from 'react-chartjs-2';
import { ensureChartsRegistered, CHART_PALETTE } from './chartjs-setup';

ensureChartsRegistered();

export function StackedDayBarChart({
  days = [],
  series = [],
  highlightIdx = -1,
  onBarClick,
  height = 220,
}) {
  const labels = days.map((d) => (d?.label || '').split(' ').slice(1).join(' '));

  const datasets = series.map((s) => ({
    label: s.label,
    data: s.data,
    backgroundColor: s.color,
    borderWidth: 0,
    borderRadius: 1,
    stack: 'reservations',
  }));

  const data = { labels, datasets };

  const options = {
    responsive: true,
    maintainAspectRatio: false,
    animation: false,
    onClick: onBarClick
      ? (_e, els) => {
          if (els?.length) onBarClick(els[0].index);
        }
      : undefined,
    plugins: {
      legend: {
        position: 'top',
        align: 'start',
        labels: {
          font: { size: 11 },
          color: CHART_PALETTE.brandInk,
          boxWidth: 12,
          boxHeight: 12,
          padding: 12,
        },
      },
      tooltip: {
        callbacks: {
          title: (items) => (items?.[0] ? days[items[0].dataIndex]?.label || '' : ''),
          footer: (items) => {
            if (!items?.length) return '';
            // Sum all stacks at the hovered index
            const idx = items[0].dataIndex;
            const total = datasets.reduce((acc, ds) => acc + (ds.data[idx] || 0), 0);
            return `Total: ${total}`;
          },
        },
      },
    },
    scales: {
      x: {
        stacked: true,
        ticks: {
          color: (ctx) => (ctx.index === highlightIdx ? CHART_PALETTE.peak : CHART_PALETTE.muted),
          font: (ctx) => ({
            size: 10,
            weight: ctx.index === highlightIdx ? '500' : 'normal',
          }),
          maxRotation: 0,
          autoSkip: true,
        },
        grid: { display: false },
      },
      y: {
        stacked: true,
        beginAtZero: true,
        ticks: { color: CHART_PALETTE.muted, font: { size: 10 }, precision: 0 },
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
