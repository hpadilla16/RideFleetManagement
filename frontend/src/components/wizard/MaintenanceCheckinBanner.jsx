'use client';

/**
 * Maintenance detection at check-in (Feature A, 2026-09-01) — the Step 3
 * banner. Mounts DIRECTLY under the odometer field it reacts to (cause above
 * effect) and re-evaluates as the agent types: the parent recomputes `items`
 * via lib/maintenance-eval.js on every keystroke; nothing is written until
 * check-in close.
 *
 * Three states (design/mockups/maintenance-checkin-mockup.html):
 *  1. PENDING — lists every overdue + due-soon schedule with the concrete gap
 *     ("Oil change — 1,230 mi overdue"), gauge per row, one primary action
 *     (Send to maintenance) + snooze + one consequence sentence. The parent
 *     gates Step 3's Continue while an OVERDUE row is pending.
 *  2. Snooze confirm — ONE confirm ("Continue — remind me at next check-out
 *     or check-in"), the re-prompt rule as the consequence, an optional
 *     collapsed note, and the automatic stamp preview. No mandatory reason.
 *  3. ARMED — "Will send to maintenance when the return completes" + Undo
 *     (works until the signature step). SNOOZED shows its own quiet strip.
 *
 * The component is presentation + local popover state only; the decision
 * lives in the wizard so it survives step navigation and rides the close
 * payload (armed, not fired).
 */

import { useState } from 'react';
import { useTranslation } from 'react-i18next';

const palette = {
  dangerBg: 'rgba(239,68,68,.07)', dangerBd: '#FCA5A5', dangerTx: '#991B1B',
  warnBg: '#FEF3C7', warnBd: '#F59E0B', warnTx: '#92400E',
  okBg: '#D1FAE5', okBd: 'rgba(16,185,129,.4)', okTx: '#065F46',
};

const fmt = (n) => (n == null ? '—' : Number(n).toLocaleString());
const fmtDate = (d) => {
  if (!d) return '—';
  try { return new Date(d).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' }); } catch { return '—'; }
};

function DueRow({ item, t }) {
  const isOverdue = item.state === 'OVERDUE';
  const chipStyle = {
    display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 11, fontWeight: 700,
    padding: '3px 9px', borderRadius: 5, whiteSpace: 'nowrap', flexShrink: 0,
    background: isOverdue ? '#FEE2E2' : palette.warnBg,
    color: isOverdue ? palette.dangerTx : palette.warnTx,
    border: `0.5px solid ${isOverdue ? palette.dangerBd : palette.warnBd}`,
  };
  const chipText = item.basis === 'MILES'
    ? (isOverdue
      ? t('maintCheckin.chip.overdueMi', { n: fmt(item.gapMiles) })
      : t('maintCheckin.chip.dueSoonMi', { n: fmt(item.gapMiles) }))
    : (isOverdue
      ? t('maintCheckin.chip.overdueDays', { n: fmt(item.gapDays) })
      : t('maintCheckin.chip.dueSoonDays', { n: fmt(item.gapDays) }));
  const meta = item.basis === 'MILES'
    ? t('maintCheckin.metaMiles', {
        last: fmt(item.lastServiceMiles), due: fmt(item.nextDueMiles), now: fmt(item.nowMileage),
      })
    : t('maintCheckin.metaDays', {
        last: fmtDate(item.lastServiceAt), due: fmtDate(item.nextDueAt),
      });
  const interval = item.intervalMiles
    ? t('maintCheckin.intervalMiles', { n: fmt(item.intervalMiles) })
    : (item.intervalDays ? t('maintCheckin.intervalDays', { n: fmt(item.intervalDays) }) : '');
  return (
    <div data-testid={`maint-row-${item.serviceType}`} style={{
      display: 'flex', alignItems: 'center', gap: 12, padding: '9px 14px', minHeight: 44,
      borderBottom: '0.5px solid #F3F4F6',
    }}>
      <div style={{ flex: '0 0 150px', minWidth: 0 }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: '#111827' }}>
          {t(`maintCheckin.svc.${item.serviceType}`, { defaultValue: item.serviceType })}
        </div>
        <div style={{ fontSize: 10.5, color: '#6B7280', fontFamily: 'ui-monospace, monospace' }}>
          {item.serviceType}{interval ? ` · ${interval}` : ''}
        </div>
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ position: 'relative', height: 6, borderRadius: 3, background: '#F3F4F6', overflow: 'hidden' }}>
          <div style={{
            position: 'absolute', left: 0, top: 0, bottom: 0, borderRadius: 3,
            width: `${item.gaugePct}%`,
            background: isOverdue ? '#DC2626' : '#F59E0B',
          }} />
        </div>
        <div style={{ fontSize: 10.5, color: '#6B7280', marginTop: 4, fontVariantNumeric: 'tabular-nums' }}>{meta}</div>
      </div>
      <span style={chipStyle}>{chipText}</span>
    </div>
  );
}

export function MaintenanceCheckinBanner({
  items,
  unit,
  typedOdometer,
  decision,
  onArm,
  onUndo,
  onSnooze,
  stampPreview,   // { who, res, when } — the automatic-stamp preview values
  prevSnooze,     // consumed marker stamp from a prior rental event, or null
}) {
  const { t } = useTranslation();
  const [confirming, setConfirming] = useState(false);
  const [note, setNote] = useState('');

  if (!items || items.length === 0) return null;

  const hasOverdue = items.some((i) => i.state === 'OVERDUE');
  const status = decision?.status || 'PENDING';
  const headBg = hasOverdue ? palette.dangerBg : palette.warnBg;
  const headBd = hasOverdue ? palette.dangerBd : palette.warnBd;
  const headTx = hasOverdue ? palette.dangerTx : palette.warnTx;

  return (
    <div role="alert" data-testid="maint-banner" style={{
      border: `0.5px solid ${status === 'ARMED' ? palette.okBd : headBd}`,
      borderRadius: 8, background: '#FFFFFF', overflow: 'hidden',
    }}>
      {/* header */}
      <div style={{
        display: 'flex', alignItems: 'flex-start', gap: 10, padding: '11px 14px',
        background: headBg, borderBottom: `0.5px solid ${headBd}`,
      }}>
        <span aria-hidden="true" style={{ fontSize: 15, lineHeight: '18px' }}>🔧</span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 13.5, fontWeight: 700, color: headTx }}>
            {t('maintCheckin.title')}
          </div>
          <div style={{ fontSize: 11.5, color: headTx, opacity: 0.85, marginTop: 1 }}>
            {t('maintCheckin.sub', { odo: fmt(typedOdometer) })}
          </div>
        </div>
        <span style={{
          fontSize: 9.5, letterSpacing: '.08em', textTransform: 'uppercase',
          color: headTx, opacity: 0.65, whiteSpace: 'nowrap', paddingTop: 2,
          fontFamily: 'ui-monospace, monospace',
        }}>
          {t('maintCheckin.src', { unit })}
        </span>
      </div>

      {/* prior-snooze trail (marker consumed on wizard open) */}
      {prevSnooze ? (
        <div style={{
          padding: '7px 14px', fontSize: 11.5, color: '#6B7280',
          borderBottom: '0.5px solid #F3F4F6', background: '#F9FAFB',
        }}>
          {t('maintCheckin.prevSnooze', {
            who: prevSnooze.byName || '—',
            when: fmtDate(prevSnooze.at),
          })}{prevSnooze.note ? ` — “${prevSnooze.note}”` : ''}
        </div>
      ) : null}

      {/* due rows */}
      {items.map((item) => <DueRow key={item.serviceType} item={item} t={t} />)}

      {/* action bar / armed / snoozed */}
      {status === 'ARMED' ? (
        <div data-testid="maint-armed" style={{
          display: 'flex', alignItems: 'center', gap: 10, padding: '10px 14px',
          background: palette.okBg, borderTop: `0.5px solid ${palette.okBd}`,
        }}>
          <span aria-hidden="true" style={{ color: palette.okTx, fontWeight: 700 }}>✓</span>
          <span style={{ flex: 1, fontSize: 12.5, color: palette.okTx }}>
            <strong>{t('maintCheckin.armed.msg')}</strong> {t('maintCheckin.armed.sub')}
          </span>
          <button type="button" onClick={onUndo} style={{
            border: 'none', background: 'transparent', fontSize: 12, fontWeight: 700,
            color: palette.okTx, textDecoration: 'underline', cursor: 'pointer', minHeight: 32,
          }}>
            {t('maintCheckin.undo')}
          </button>
        </div>
      ) : status === 'SNOOZED' ? (
        <div data-testid="maint-snoozed" style={{
          display: 'flex', alignItems: 'center', gap: 10, padding: '10px 14px',
          background: '#F9FAFB', borderTop: '0.5px solid #E5E7EB',
        }}>
          <span aria-hidden="true">😴</span>
          <span style={{ flex: 1, fontSize: 12.5, color: '#374151' }}>
            {t('maintCheckin.snoozed.msg', { unit })}
          </span>
          <button type="button" onClick={onUndo} style={{
            border: 'none', background: 'transparent', fontSize: 12, fontWeight: 700,
            color: '#374151', textDecoration: 'underline', cursor: 'pointer', minHeight: 32,
          }}>
            {t('maintCheckin.undo')}
          </button>
        </div>
      ) : (
        <div style={{
          display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap',
          padding: '10px 14px', background: '#F9FAFB', borderTop: '0.5px solid #E5E7EB',
        }}>
          <button type="button" data-testid="maint-send" onClick={onArm} style={{
            padding: '9px 15px', background: '#1F2937', color: '#FFFFFF', border: 'none',
            borderRadius: 6, fontSize: 13, fontWeight: 600, cursor: 'pointer', minHeight: 38,
          }}>
            🔧 {t('maintCheckin.action.send')}
          </button>
          <button type="button" data-testid="maint-snooze-open" onClick={() => setConfirming(true)} style={{
            padding: '8px 13px', background: '#FFFFFF', color: '#374151',
            border: '0.5px solid #D1D5DB', borderRadius: 6, fontSize: 13, cursor: 'pointer', minHeight: 38,
          }}>
            {t('maintCheckin.action.snooze')}
          </button>
          <div style={{
            flexBasis: '100%', fontSize: 11.5, color: '#6B7280', lineHeight: 1.5,
            display: 'flex', gap: 6, alignItems: 'flex-start',
          }}>
            <span aria-hidden="true">ⓘ</span>
            <span>{t('maintCheckin.consequence', { unit })}</span>
          </div>
        </div>
      )}

      {/* State 2 — the snooze confirm (one click, stamp automatic) */}
      {confirming && status === 'PENDING' ? (
        <div role="dialog" aria-label={t('maintCheckin.snooze.title', { unit })} data-testid="maint-snooze-confirm" style={{
          borderTop: '0.5px solid #E5E7EB', padding: '13px 14px', background: '#FFFFFF',
        }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: '#111827' }}>
            {t('maintCheckin.snooze.title', { unit })}
          </div>
          <div style={{ fontSize: 11.5, color: '#6B7280', marginTop: 3, lineHeight: 1.5 }}>
            {t('maintCheckin.snooze.body')}
          </div>
          <details style={{ marginTop: 9 }}>
            <summary style={{ fontSize: 12, fontWeight: 600, color: '#4B5563', cursor: 'pointer' }}>
              {t('maintCheckin.snooze.note')}
            </summary>
            <textarea
              data-testid="maint-snooze-note"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder={t('maintCheckin.snooze.notePlaceholder')}
              style={{
                width: '100%', marginTop: 6, border: '0.5px solid #D1D5DB', borderRadius: 6,
                padding: '8px 10px', fontSize: 12.5, minHeight: 52, resize: 'vertical', fontFamily: 'inherit',
              }}
            />
          </details>
          <div style={{
            marginTop: 9, paddingTop: 8, borderTop: '1px dashed #E5E7EB',
            fontSize: 10.5, color: '#6B7280', lineHeight: 1.5,
          }}>
            🛡 {t('maintCheckin.snooze.stamp', {
              who: stampPreview?.who || '—',
              res: stampPreview?.res || '—',
              odo: fmt(typedOdometer),
              when: stampPreview?.when || '—',
            })}
          </div>
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
            <button type="button" onClick={() => setConfirming(false)} style={{
              padding: '7px 12px', background: '#FFFFFF', color: '#374151',
              border: '0.5px solid #D1D5DB', borderRadius: 6, fontSize: 12.5, cursor: 'pointer', minHeight: 34,
            }}>
              {t('maintCheckin.snooze.back')}
            </button>
            <button
              type="button"
              data-testid="maint-snooze-confirm-btn"
              onClick={() => { setConfirming(false); onSnooze(String(note || '').trim() || null); }}
              style={{
                padding: '7px 13px', background: '#1F2937', color: '#FFFFFF', border: 'none',
                borderRadius: 6, fontSize: 12.5, fontWeight: 600, cursor: 'pointer', minHeight: 34,
              }}
            >
              {t('maintCheckin.snooze.confirm')}
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

export default MaintenanceCheckinBanner;
