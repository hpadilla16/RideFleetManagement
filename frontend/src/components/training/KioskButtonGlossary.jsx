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

const TONE = {
  guest: { background: '#8752FE', color: '#fff', border: '1px solid transparent' },
  staff: { background: '#4c1d95', color: '#fff', border: '1px solid transparent' },
  secondary: { background: 'var(--surface-1, #fff)', color: 'var(--text-1, #1e1a2b)', border: '1px solid var(--border-2, #d9d2ea)' },
  danger: { background: '#fdecea', color: '#b3261e', border: '1px solid transparent' },
};

export function KioskButtonGlossary({ open, onClose }) {
  const { t } = useTranslation();
  const ref = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); onClose?.(); } };
    window.addEventListener('keydown', onKey);
    ref.current?.focus();
    return () => window.removeEventListener('keydown', onKey);
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
          border: '1px solid var(--border-2, #d9d2ea)', borderRadius: 14, padding: '18px 20px 22px',
          boxShadow: '0 12px 40px rgba(30,20,60,0.28)', outline: 'none',
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12, marginBottom: 6 }}>
          <div>
            <div style={{ fontSize: 11, letterSpacing: '0.08em', textTransform: 'uppercase', color: '#6d3de0', fontWeight: 700 }}>Ride University</div>
            <h2 style={{ margin: '2px 0 4px', fontSize: 18 }}>{trainingText(t, glossaryKey('title'), KIOSK_GLOSSARY.title)}</h2>
            <p className="ui-muted" style={{ margin: 0, fontSize: 13 }}>{trainingText(t, glossaryKey('summary'), KIOSK_GLOSSARY.summary)}</p>
          </div>
          <button type="button" className="button-subtle" onClick={onClose} aria-label={t('common.close', 'Close')}>×</button>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 12, marginTop: 12 }}>
          {KIOSK_GLOSSARY.groups.map((group) => (
            <section key={group.key} style={{ border: '1px solid var(--border-2, #e6e0f2)', borderRadius: 12, padding: '12px 14px' }}>
              <h3 style={{ margin: '0 0 8px', fontSize: 13.5 }}>{trainingText(t, glossaryGroupKey(group), group.title)}</h3>
              <dl style={{ margin: 0, display: 'grid', gap: 8 }}>
                {group.entries.map((entry) => (
                  <div key={entry.id} style={{ paddingBottom: 8, borderBottom: '1px solid var(--border-2, #eee9f6)' }}>
                    <dt style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 3 }}>
                      {entry.labels.map((labelKey) => (
                        <span key={labelKey} style={{ ...TONE[entry.tone] || TONE.secondary, display: 'inline-block', fontSize: 12, fontWeight: 600, padding: '2px 9px', borderRadius: 8 }}>
                          {t(labelKey, { name: '…', count: 2, time: '9:58', destinations: '…' })}
                        </span>
                      ))}
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
