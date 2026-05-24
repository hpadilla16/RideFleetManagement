'use client';

/**
 * UtilizationLineChart — daily fleet utilization as a Chart.js line chart,
 * with an optional "same period last year" overlay (dashed line).
 *
 * Props:
 *   days:                [{ iso, label }]
 *   utilizationByDay:    number[] (0..1 decimals, this period)
 *   lastYearByDay:       number[] | null  (0..1 decimals, LY same window)
 *   showLastYear:        boolean
 */

import { Line } from 'react-chartjs-2';
import { ensureChartsRegistered, CHART_PALETTE } from './chartjs-setup';

ensureChartsRegistered();

export function UtilizationLineChart({
  days = [],
  utilizationByDay = [],
  lastYearByDay = null,
  showLastYear = false,
  height = 240,
}) {
  const labels = days.map((d) => (d?.label || '').split(' ').slice(1).join(' '));
  const thisPeriod = utilizationByDay.map((u) => Math.round(u * 1000) / 10); // one decimal %

  const datasets = [
    {
      label: 'This period',
      data: thisPeriod,
      borderColor: CHART_PALETTE.brandPurple,
      backgroundColor: 'rgba(83, 74, 183, 0.08)',
      borderWidth: 2,
      pointRadius: 2,
      pointHoverRadius: 4,
      pointBackgroundColor: CHART_PALETTE.brandPurple,
      tension: 0.25,
      fill: false,
    },
  ];

  if (showLastYear && Array.isArray(lastYearByDay) && lastYearByDay.length > 0) {
    datasets.push({
      label: 'Last year',
      data: lastYearByDay.map((u) => Math.round(u * 1000) / 10),
      borderColor: '#B4B2A9',
      backgroundColor: 'transparent',
      borderWidth: 1.5,
      borderDash: [5, 4],
      pointRadius: 0,
      pointHoverRadius: 3,
      tension: 0.25,
      fill: false,
    });
  }

  const data = { labels, datasets };

  const options = {
    responsive: true,
    maintainAspectRatio: false,
    animation: false,
    interaction: { mode: 'index', intersect: false },
    plugins: {
      legend: {
        position: 'top',
        align: 'end',
        labels: { font: { size: 11 }, color: CHART_PALETTE.brandInk, boxWidth: 18, boxHeight: 2 },
      },
      tooltip: {
        callbacks: {
          title: (items) => (items?.[0] ? days[items[0].dataIndex]?.label || '' : ''),
          label: (ctx) => `${ctx.dataset.label}: ${ctx.parsed.y.toFixed(1)}%`,
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
      <Line data={data} options={options} />
    </div>
  );
}
