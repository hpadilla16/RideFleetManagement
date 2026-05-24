'use client';

/**
 * One-time Chart.js registration. Each chart component imports this and calls
 * ensureChartsRegistered() at module scope. Idempotent.
 *
 * We register tree-shakable Chart.js pieces explicitly (rather than the default
 * `auto` bundle) so the gzipped bundle stays small. Add new pieces here when a
 * future chart needs them.
 */

import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  BarElement,
  LineElement,
  PointElement,
  ArcElement,
  Title,
  Tooltip,
  Legend,
  Filler,
} from 'chart.js';

let _registered = false;

export function ensureChartsRegistered() {
  if (_registered) return;
  ChartJS.register(
    CategoryScale,
    LinearScale,
    BarElement,
    LineElement,
    PointElement,
    ArcElement,
    Title,
    Tooltip,
    Legend,
    Filler,
  );
  _registered = true;
}

// Shared palette aligned with the existing UI.
export const CHART_PALETTE = {
  brandPurple: '#534AB7',
  brandPurpleLight: '#7F77DD',
  brandInk: '#211a38',
  brandMint: '#1fc7aa',
  muted: '#6f668f',
  peak: '#A32D2D',
  axis: '#888780',
  gridLine: '#d3d1c7',
  amber: '#FAC775',
  amberText: '#412402',
  red: '#A32D2D',
};
