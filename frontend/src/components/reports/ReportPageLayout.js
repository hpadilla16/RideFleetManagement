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
    <div style={{ maxWidth: 1200, margin: '0 auto', padding: '20px 24px' }}>

      {/* Breadcrumb */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 6,
        fontSize: 13, color: '#6f668f', marginBottom: 4,
      }}>
        <Link href="/reports-v2" style={{ color: '#6f668f', textDecoration: 'underline', cursor: 'pointer' }}>
          ← Reports
        </Link>
        {category ? <><span>·</span><span>{category}</span></> : null}
      </div>

      {/* Title + description */}
      <h1 style={{ margin: '0 0 6px', fontSize: 24, fontWeight: 500 }}>{title}</h1>
      {description ? (
        <div style={{ fontSize: 13, color: '#6f668f', marginBottom: 16 }}>{description}</div>
      ) : null}

      {/* Filter bar */}
      <div style={{
        background: '#f1efe8', borderRadius: 12, padding: '12px 14px',
        marginBottom: 18, display: 'flex', alignItems: 'center',
        gap: 12, flexWrap: 'wrap',
      }}>
        {hideDateRange
          ? (leftSlot || null)
          : <DateRangePicker value={range} onChange={onRangeChange} presets={presets} />}
        {extraFilters ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>{extraFilters}</div>
        ) : null}
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
          <button
            onClick={() => handleDownload('pdf')}
            style={{
              fontSize: 13, padding: '6px 12px',
              background: 'white', border: '0.5px solid #d3d1c7',
              borderRadius: 8, cursor: 'pointer',
              display: 'flex', alignItems: 'center', gap: 6,
            }}
          >
            📄 PDF
          </button>
          <button
            onClick={() => handleDownload('excel')}
            style={{
              fontSize: 13, padding: '6px 12px',
              background: 'white', border: '0.5px solid #d3d1c7',
              borderRadius: 8, cursor: 'pointer',
              display: 'flex', alignItems: 'center', gap: 6,
            }}
          >
            📊 Excel
          </button>
        </div>
      </div>

      {/* Body */}
      {children}

    </div>
  );
}
