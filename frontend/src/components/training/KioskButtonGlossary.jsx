'use client';

/**
 * Ride University — the kiosk button glossary, as a dialog.
 *
 * Reference material, not a module: no points, always available from the
 * course row. The labels are the kiosk's own strings via t('kiosk.*'), so a
 * chip here reads exactly like the button on the iPad.
 */

import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { KIOSK_GLOSSARY, glossaryKey, glossaryGroupKey, glossaryEntryKey } from '../../lib/training/kiosk-glossary.js';
import { trainingText } from '../../lib/training/i18n-keys.js';

// Chip tones. White on the brand purple #8752FE measures 4.50:1 — AA fails by a
// hair — so chips use the system's --p-600, which the design system documents
// as the white-on-purple that passes (6.57:1); danger/ok use the semantic tokens
// so they invert in dark mode instead of becoming light islands.
const TONE = {
  guest: { background: 'var(--p-600, #6a35e0)', color: '#fff', border: '1px solid transparent' },
  staff: { background: '#4c1d95', color: '#fff', border: '1px solid transparent' },
  secondary: { background: 'var(--surface-1, #fff)', color: 'var(--text-1, #1e1a2b)', border: '1px solid var(--border, #d9d2ea)' },
  danger: { background: 'var(--danger-bg, #fdecea)', color: 'var(--danger-tx, #b3261e)', border: '1px solid transparent' },
};

export function KioskButtonGlossary({ open, onClose }) {
  const { t } = useTranslation();
  const ref = useRef(null);
  const opener = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    // Remember what opened us and give focus back on close; lock the page
    // behind the dialog so the wheel scrolls the glossary, not the University.
    opener.current = document.activeElement;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); onClose?.(); } };
    window.addEventListener('keydown', onKey);
    ref.current?.focus();
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = prevOverflow;
      try { opener.current?.focus?.(); } catch { /* it may be gone */ }
    };
  }, [open, onClose]);

  if (!open || typeof document === 'undefined') return null;

  return createPortal(
    <div role="dialog" aria-modal="true" aria-label={trainingText(t, glossaryKey('title'), KIOSK_GLOSSARY.title)} style={{ position: 'fixed', inset: 0, zIndex: 100000, display: 'flex', alignItems: 'flex-start', justifyContent: 'center', padding: '4vh 12px' }}>
      <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(20,14,40,0.45)' }} />
      <div
        ref={ref}
        tabIndex={-1}
        data-testid="kiosk-glossary"
        style={{
          position: 'relative', width: 'min(920px, 100%)', maxHeight: '92vh', overflowY: 'auto',
          background: 'var(--surface-1, #fff)', color: 'var(--text-1, #1e1a2b)',
          border: '1px solid var(--border, #d9d2ea)', borderRadius: 14, padding: '18px 20px 22px',
          boxShadow: '0 12px 40px rgba(30,20,60,0.28)', outline: 'none',
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12, marginBottom: 6 }}>
          <div>
            <div className="eyebrow">Ride University</div>
            <h2 style={{ margin: '2px 0 4px', fontSize: 18 }}>{trainingText(t, glossaryKey('title'), KIOSK_GLOSSARY.title)}</h2>
            <p className="ui-muted" style={{ margin: 0, fontSize: 13 }}>{trainingText(t, glossaryKey('summary'), KIOSK_GLOSSARY.summary)}</p>
            <p className="ui-muted" style={{ margin: '6px 0 0', fontSize: 12 }}>{trainingText(t, glossaryKey('legend'), KIOSK_GLOSSARY.legend)}</p>
          </div>
          <button type="button" className="button-subtle" onClick={onClose} aria-label={t('common.close', 'Close')} style={{ minWidth: 40, minHeight: 40, fontSize: 20, lineHeight: 1 }}>×</button>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 12, marginTop: 12 }}>
          {KIOSK_GLOSSARY.groups.map((group) => (
            <section key={group.key} style={{ border: '1px solid var(--border, #e6e0f2)', borderRadius: 12, padding: '12px 14px' }}>
              <h3 style={{ margin: '0 0 8px', fontSize: 13.5 }}>{trainingText(t, glossaryGroupKey(group), group.title)}</h3>
              <dl style={{ margin: 0, display: 'grid', gap: 8 }}>
                {group.entries.map((entry) => (
                  <div key={entry.id} style={{ paddingBottom: 8, borderBottom: '1px solid var(--border, #eee9f6)' }}>
                    <dt style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 3 }}>
                      {entry.labels.map((labelKey) => (entry.tone === 'note'
                        // A quoted message or rule, not a button: plain text, so
                        // the legend "chip = real button" stays true.
                        ? (
                          <em key={labelKey} className="ui-muted" data-tone="note" style={{ fontSize: 12.5 }}>
                            “{t(labelKey, { name: '…', count: 2, time: '9:58', destinations: '…' })}”
                          </em>
                        ) : (
                          <span key={labelKey} data-tone={entry.tone} style={{ ...TONE[entry.tone] || TONE.secondary, display: 'inline-block', fontSize: 12, fontWeight: 600, padding: '2px 9px', borderRadius: 8 }}>
                            {t(labelKey, { name: '…', count: 2, time: '9:58', destinations: '…' })}
                          </span>
                        )))}
                    </dt>
                    <dd style={{ margin: 0, fontSize: 13, lineHeight: 1.45, color: 'var(--text-2, #4a4258)' }}>
                      {trainingText(t, glossaryEntryKey(entry), entry.what)}
                    </dd>
                  </div>
                ))}
              </dl>
            </section>
          ))}
        </div>
      </div>
    </div>,
    document.body,
  );
}
