'use client';

/**
 * SoldOutIncidenceChart — # of sold-out days per month over the last 12 months.
 * Helps the Trends tab answer "how often do we sell out historically?".
 *
 * Bars in brand purple, with months ≥ 5 sold-out days highlighted in peak
 * red so high-pressure months pop without overdoing the colour load.
 *
 * Props:
 *   soldOutByMonth: [{ yearMonth, label, soldOutDays, daysInMonth }]
 */

import { Bar } from 'react-chartjs-2';
import { ensureChartsRegistered, CHART_PALETTE } from './chartjs-setup';

ensureChartsRegistered();

const HOT_THRESHOLD = 5; // 5+ sold-out days → highlight in red

export function SoldOutIncidenceChart({ soldOutByMonth = [], height = 160 }) {
  const labels = soldOutByMonth.map((m) => m.label || '');
  const values = soldOutByMonth.map((m) => m.soldOutDays || 0);

  const data = {
    labels,
    datasets: [
      {
        label: 'Sold-out days',
        data: values,
        backgroundColor: values.map((v) =>
          v >= HOT_THRESHOLD ? CHART_PALETTE.peak : CHART_PALETTE.brandPurple
        ),
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
          title: (items) => {
            const m = soldOutByMonth[items?.[0]?.dataIndex];
            return m ? m.label : '';
          },
          label: (ctx) => {
            const m = soldOutByMonth[ctx.dataIndex];
            if (!m) return '';
            return `${ctx.parsed.y} sold-out / ${m.daysInMonth} days`;
          },
        },
      },
    },
    scales: {
      x: {
        ticks: { color: CHART_PALETTE.muted, font: { size: 10 } },
        grid: { display: false },
      },
      y: {
        beginAtZero: true,
        ticks: { color: CHART_PALETTE.muted, font: { size: 10 }, stepSize: 1, precision: 0 },
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
