'use client';

/**
 * ReportPageLayout — Round 24 (2026-05-22).
 *
 * Shared chrome for every individual report page:
 *   - Breadcrumb back to /reports + category label
 *   - Title + short description
 *   - Sticky filter bar with DateRangePicker + PDF / Excel export buttons
 *   - children slot = the report's actual body
 *
 * Designed so every report (commission, agent track record, availability
 * forecast, etc.) renders identical chrome — different bodies. Adding a
 * new report = build the body component + wire it through this layout.
 *
 * Export buttons hit `/api/reports/{slug}/pdf` and `/api/reports/{slug}/excel`
 * with the current date-range query params. Server renders, browser
 * downloads.
 *
 * Props:
 *   slug          — report slug ('commission-sales-performance', etc.)
 *   title         — page title
 *   description   — one-line subtitle
 *   category      — 'OPERATIONS' | 'FLEET' | etc. (rendered in breadcrumb)
 *   token         — auth token for export download links
 *   range         — { from: 'YYYY-MM-DD', to: 'YYYY-MM-DD' }
 *   onRangeChange — ({ from, to }) => void
 *   presets       — optional override (defaults to DateRangePicker defaults)
 *   extraFilters  — optional ReactNode rendered between the date picker and
 *                   the export buttons. Used by reports that need additional
 *                   filters in the filter bar (e.g. location dropdown).
 *   hideDateRange — when true, the DateRangePicker is not rendered (used by
 *                   snapshot-style reports like rental-status that have no
 *                   meaningful date window). The export buttons still work and
 *                   simply pass no from/to params.
 *   leftSlot      — optional ReactNode rendered in place of the DateRangePicker
 *                   when hideDateRange is true. Use for "As of …" labels.
 *   children      — the report body
 */

import Link from 'next/link';
import { DateRangePicker } from './DateRangePicker';

export function ReportPageLayout({
  slug, title, description, category,
  token, range, onRangeChange, presets,
  extraFilters,
  hideDateRange,
  leftSlot,
  children,
}) {
  const exportUrl = (kind) => {
    const params = new URLSearchParams();
    if (range?.from) params.set('from', range.from);
    if (range?.to)   params.set('to',   range.to);
    return `/api/reports/${slug}/${kind}?${params.toString()}`;
  };

  const handleDownload = async (kind) => {
    if (!token) return;
    try {
      const res = await fetch(exportUrl(kind), {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) throw new Error(`Export failed: ${res.status}`);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      // Filename comes from Content-Disposition; fall back to slug + ext.
      const cd = res.headers.get('Content-Disposition') || '';
      const m = cd.match(/filename="?([^"]+)"?/);
      a.download = m ? m[1] : `${slug}.${kind === 'pdf' ? 'pdf' : 'xlsx'}`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
    } catch (err) {
      console.error('[ReportPageLayout] download failed', err);
      alert(`Export failed: ${err.message || err}`);
    }
  };

  return (
    <div className="report-shell">

      {/* Breadcrumb */}
      <div className="report-breadcrumb">
        <Link href="/reports-v2" className="report-breadcrumb-link">
          <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M15 18l-6-6 6-6" /></svg>
          Reports
        </Link>
        {category ? <><span>·</span><span>{category}</span></> : null}
      </div>

      {/* Title + description */}
      <h1 className="report-title">{title}</h1>
      {description ? (
        <div className="report-desc">{description}</div>
      ) : null}

      {/* Filter bar */}
      <div className="report-filterbar">
        {hideDateRange
          ? (leftSlot || null)
          : <DateRangePicker value={range} onChange={onRangeChange} presets={presets} />}
        {extraFilters ? (
          <div className="report-filterbar-extra">{extraFilters}</div>
        ) : null}
        <div className="report-export-group">
          <button className="report-export-btn" onClick={() => handleDownload('pdf')}>
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><path d="M14 2v6h6" /></svg>
            PDF
          </button>
          <button className="report-export-btn" onClick={() => handleDownload('excel')}>
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="2" /><path d="M3 9h18M3 15h18M9 3v18M15 3v18" /></svg>
            Excel
          </button>
        </div>
      </div>

      {/* Body */}
      {children}

    </div>
  );
}
