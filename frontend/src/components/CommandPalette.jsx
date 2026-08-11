'use client';

/**
 * Command palette (Innovation #2 — ⌘K global search). Self-contained: mounts
 * its own global Cmd/Ctrl+K listener and renders a modal. Search hits
 * GET /api/search (tenant- and location-scoped server-side); Enter opens the
 * top result, arrows move, Esc closes. Results only link to pages that keep
 * their own guards, so this exposes nothing the user couldn't already reach.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslation } from 'react-i18next';
import { API_BASE, readStoredToken } from '../lib/client';

const TYPE_LABEL = {
  reservation: 'Reservation',
  agreement: 'Agreement',
  vehicle: 'Vehicle',
  customer: 'Customer',
  // Payments by reference (2026-08-11): receipt/auth codes and card last-4 —
  // the "****1234 · auth A8K2X9" format the payment history already writes.
  payment: 'Payment'
};

export function CommandPalette() {
  const router = useRouter();
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [results, setResults] = useState([]);
  const [active, setActive] = useState(0);
  const [loading, setLoading] = useState(false);
  const inputRef = useRef(null);
  const debounceRef = useRef(null);
  const reqRef = useRef(0);

  const close = useCallback(() => { setOpen(false); setQ(''); setResults([]); setActive(0); }, []);

  // Global hotkey: Cmd+K (mac) / Ctrl+K. "/" opens too when not already typing.
  useEffect(() => {
    const onKey = (e) => {
      const k = String(e.key || '').toLowerCase();
      if ((e.metaKey || e.ctrlKey) && k === 'k') {
        e.preventDefault();
        setOpen((v) => !v);
      } else if (k === 'escape') {
        setOpen(false);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  useEffect(() => { if (open && inputRef.current) inputRef.current.focus(); }, [open]);

  useEffect(() => {
    if (!open) return;
    const query = q.trim();
    if (query.length < 2) { setResults([]); setLoading(false); return; }
    if (debounceRef.current) clearTimeout(debounceRef.current);
    setLoading(true);
    debounceRef.current = setTimeout(async () => {
      const myReq = ++reqRef.current;
      try {
        const token = readStoredToken();
        const res = await fetch(`${API_BASE}/api/search?q=${encodeURIComponent(query)}`, {
          headers: { Authorization: `Bearer ${token}` }
        });
        const data = res.ok ? await res.json() : { results: [] };
        if (myReq !== reqRef.current) return; // a newer keystroke won
        setResults(Array.isArray(data.results) ? data.results : []);
        setActive(0);
      } catch {
        if (myReq === reqRef.current) setResults([]);
      } finally {
        if (myReq === reqRef.current) setLoading(false);
      }
    }, 220);
    return () => debounceRef.current && clearTimeout(debounceRef.current);
  }, [q, open]);

  const go = useCallback((item) => {
    if (!item) return;
    close();
    router.push(item.href);
  }, [close, router]);

  const onInputKey = (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive((i) => Math.min(i + 1, results.length - 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((i) => Math.max(i - 1, 0)); }
    else if (e.key === 'Enter') { e.preventDefault(); go(results[active]); }
  };

  if (!open) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={t('search.title', 'Search')}
      onMouseDown={close}
      style={{
        position: 'fixed', inset: 0, zIndex: 4000, display: 'flex', justifyContent: 'center', alignItems: 'flex-start',
        paddingTop: '12vh', background: 'rgba(23,18,43,0.42)'
      }}
    >
      <div
        onMouseDown={(e) => e.stopPropagation()}
        style={{
          width: 'min(560px, 92vw)', background: 'var(--surface-1, #fff)', border: '1px solid var(--border-2, #e9e4f4)',
          borderRadius: 12, boxShadow: '0 24px 60px -20px rgba(23,18,43,0.45)', overflow: 'hidden'
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '12px 14px', borderBottom: '1px solid var(--border-2, #e9e4f4)' }}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--text-3, #736a8b)" strokeWidth="2" aria-hidden="true">
            <circle cx="11" cy="11" r="7" /><path d="m21 21-4.3-4.3" />
          </svg>
          <input
            ref={inputRef}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={onInputKey}
            placeholder={t('search.placeholder', 'Search plate, booking, customer…')}
            style={{ flex: 1, border: 'none', outline: 'none', fontSize: 15, background: 'transparent', color: 'var(--text-1, #17122b)' }}
          />
          <kbd style={{ fontFamily: 'var(--font-mono, ui-monospace, monospace)', fontSize: 10.5, border: '1px solid var(--border-2, #d9d2ea)', borderRadius: 5, padding: '1px 6px', color: 'var(--text-3, #736a8b)' }}>Esc</kbd>
        </div>

        <div style={{ maxHeight: '52vh', overflowY: 'auto' }}>
          {q.trim().length < 2 ? (
            <div style={{ padding: '18px 16px', color: 'var(--text-3, #736a8b)', fontSize: 13 }}>{t('search.hint', 'Type at least 2 characters — plate, booking #, agreement #, name, phone or email.')}</div>
          ) : loading ? (
            <div style={{ padding: '18px 16px', color: 'var(--text-3, #736a8b)', fontSize: 13 }}>{t('search.loading', 'Searching…')}</div>
          ) : results.length === 0 ? (
            <div style={{ padding: '18px 16px', color: 'var(--text-3, #736a8b)', fontSize: 13 }}>{t('search.empty', 'No matches.')}</div>
          ) : (
            results.map((item, i) => (
              <button
                key={`${item.type}-${item.id}`}
                type="button"
                onMouseEnter={() => setActive(i)}
                onClick={() => go(item)}
                style={{
                  display: 'flex', width: '100%', alignItems: 'center', gap: 10, textAlign: 'left', border: 'none',
                  padding: '10px 14px', cursor: 'pointer', background: i === active ? 'var(--surface-2, #f4efff)' : 'transparent'
                }}
              >
                <span style={{
                  flex: '0 0 auto', fontSize: 10.5, fontWeight: 700, letterSpacing: '.04em', textTransform: 'uppercase',
                  color: 'var(--brand-tx, #6a35e0)', background: 'var(--brand-soft, #ebe2ff)', borderRadius: 6, padding: '2px 7px', minWidth: 78, textAlign: 'center'
                }}>
                  {t(`search.type.${item.type}`, TYPE_LABEL[item.type] || item.type)}
                </span>
                <span style={{ minWidth: 0 }}>
                  <span style={{ display: 'block', fontWeight: 650, fontSize: 13.5, fontVariantNumeric: 'tabular-nums', color: 'var(--text-1, #17122b)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{item.title}</span>
                  {item.subtitle ? <span style={{ display: 'block', fontSize: 12, color: 'var(--text-3, #736a8b)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{item.subtitle}</span> : null}
                </span>
              </button>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
