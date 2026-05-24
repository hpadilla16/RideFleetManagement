'use client';

/**
 * ListDrawer — generic slide-in side panel for report drill-downs.
 *
 * Owns the drawer chrome (header, ESC/backdrop close, body scroll lock,
 * focus management) and the fetch lifecycle (loading / error / empty).
 * Item rendering is delegated to the caller via `renderItem` so each
 * report can supply its own card shape (reservations, payments, vehicles,
 * etc.).
 *
 * Props:
 *   open:         boolean
 *   endpoint:     string | null      — full URL incl. query params (null = inert)
 *   title:        string             — header line
 *   subtitle?:    string             — optional second line under the title
 *   token:        auth token
 *   onClose:      () => void
 *   dataKey?:     string             — JSON response key holding the list (default 'items')
 *   renderItem:   (item, idx) => ReactNode
 *   emptyMessage?: string            — copy when the list is empty
 *   countLabel?:  (n) => string      — header chip e.g. "12 payments" (default "{n} items")
 *
 * Expected JSON response shape: { [dataKey]: [...], ...extras }
 * The full response is also passed to `renderHeaderExtras` if provided so
 * the drawer can render top-level summary (e.g. "Total: $1,234").
 *
 *   renderHeaderExtras?: (data) => ReactNode
 */

import { useEffect, useRef, useState } from 'react';
import { api } from '../../lib/client';

export function ListDrawer({
  open,
  endpoint,
  title,
  subtitle,
  token,
  onClose,
  dataKey = 'items',
  renderItem,
  emptyMessage = 'Nothing to show here.',
  countLabel = (n) => `${n} item${n === 1 ? '' : 's'}`,
  renderHeaderExtras,
}) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const closeBtnRef = useRef(null);
  const returnFocusRef = useRef(null);

  // Fetch whenever the endpoint changes (and the drawer is open)
  useEffect(() => {
    if (!open || !endpoint || !token) return;
    let cancelled = false;
    setLoading(true);
    setError('');
    setData(null);
    (async () => {
      try {
        const out = await api(endpoint, { bypassCache: true }, token);
        if (!cancelled) setData(out);
      } catch (err) {
        if (!cancelled) setError(err?.message || 'Failed to load');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [open, endpoint, token]);

  // ESC to close
  useEffect(() => {
    if (!open) return;
    const onKey = (e) => { if (e.key === 'Escape') onClose?.(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  // Lock body scroll + capture/restore focus
  useEffect(() => {
    if (!open) return;
    if (typeof document === 'undefined') return;
    returnFocusRef.current = document.activeElement;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const t = setTimeout(() => closeBtnRef.current?.focus(), 0);
    return () => {
      clearTimeout(t);
      document.body.style.overflow = prevOverflow;
      const back = returnFocusRef.current;
      if (back && typeof back.focus === 'function') {
        try { back.focus(); } catch { /* ignore */ }
      }
    };
  }, [open]);

  if (!open) return null;

  const items = Array.isArray(data?.[dataKey]) ? data[dataKey] : [];

  return (
    <>
      <div
        onClick={onClose}
        style={{
          position: 'fixed', inset: 0, background: 'rgba(15, 12, 30, 0.32)',
          zIndex: 80, transition: 'opacity 0.15s',
        }}
        aria-hidden="true"
      />
      <aside
        role="dialog"
        aria-modal="true"
        aria-label={title || 'Details'}
        style={{
          position: 'fixed', top: 0, right: 0, bottom: 0,
          width: 'min(440px, 92vw)',
          background: 'white',
          borderLeft: '0.5px solid #d3d1c7',
          boxShadow: '-8px 0 24px rgba(15, 12, 30, 0.12)',
          zIndex: 81,
          display: 'flex', flexDirection: 'column',
        }}
      >
        <div style={{ padding: '14px 18px', borderBottom: '0.5px solid #d3d1c7', display: 'flex', alignItems: 'flex-start', gap: 8 }}>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 11, color: '#6f668f', textTransform: 'uppercase', letterSpacing: 0.4, marginBottom: 2 }}>
              Drill-down
            </div>
            <div style={{ fontSize: 16, fontWeight: 500, color: '#211a38' }}>{title || '—'}</div>
            {subtitle ? (
              <div style={{ fontSize: 12, color: '#6f668f', marginTop: 4 }}>{subtitle}</div>
            ) : null}
            {data ? (
              <div style={{ fontSize: 11, color: '#6f668f', marginTop: 4 }}>
                {countLabel(items.length)}
              </div>
            ) : null}
            {data && renderHeaderExtras ? renderHeaderExtras(data) : null}
          </div>
          <button
            ref={closeBtnRef}
            onClick={onClose}
            aria-label="Close drill-down panel"
            style={{
              background: 'transparent', border: 'none', cursor: 'pointer',
              fontSize: 18, color: '#6f668f', padding: 4, marginTop: -4,
            }}
          >×</button>
        </div>

        <div style={{ overflowY: 'auto', flex: 1, padding: '12px 18px' }}>
          {loading ? (
            <div style={{ padding: 30, textAlign: 'center', color: '#6f668f', fontSize: 13 }}>Loading…</div>
          ) : error ? (
            <div role="alert" style={{ background: '#FCEBEB', color: '#791F1F', padding: 10, borderRadius: 8, fontSize: 13 }}>{error}</div>
          ) : items.length === 0 ? (
            <div style={{ padding: 30, textAlign: 'center', color: '#6f668f', fontSize: 13 }}>{emptyMessage}</div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {items.map((item, idx) => (
                <div key={item.id ?? idx}>{renderItem(item, idx)}</div>
              ))}
            </div>
          )}
        </div>
      </aside>
    </>
  );
}
