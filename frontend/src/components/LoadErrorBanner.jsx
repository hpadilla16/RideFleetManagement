'use client';

/**
 * "This page could not load its data" — said loudly, in one place.
 *
 * WHY THIS EXISTS (2026-08-08 outage): every list page turns a failed fetch
 * into an empty array and a small grey line of text. For two hours a
 * site-wide stall rendered as "you have no reservations and no cars", which is
 * visually identical to a quiet Tuesday. Nobody reported an error because
 * nobody saw one — Hector found out when users complained.
 *
 * The message existed. It lost, because it sat under a header next to tiles
 * confidently showing 0. An error has to outrank the data it invalidates.
 *
 * Two rules for callers:
 *   1. Render this when a load REJECTED — not when it legitimately returned
 *      nothing. "None" and "I don't know" are different answers and the whole
 *      incident is what happens when a screen confuses them.
 *   2. Show counts as an em dash while it is up. A number you could not fetch
 *      must never be drawn as a number.
 */
import { useTranslation } from 'react-i18next';

export function LoadErrorBanner({ detail = '', onRetry = null }) {
  const { t } = useTranslation();
  return (
    <div
      role="alert"
      className="glass card"
      style={{
        margin: '4px 0 12px',
        padding: '12px 14px',
        borderColor: 'var(--danger-bd)',
        background: 'var(--danger-bg)',
        color: 'var(--danger-tx)',
      }}
    >
      <strong>{t('dashboard.loadFailedTitle', 'This page could not load its data.')}</strong>{' '}
      {t('dashboard.loadFailedBody', 'The numbers below are incomplete or missing — they are NOT real counts. Reload in a moment, and tell an admin if it keeps happening.')}
      {detail ? <div className="label" style={{ marginTop: 6 }}>{detail}</div> : null}
      {onRetry ? (
        <div style={{ marginTop: 10 }}>
          <button type="button" onClick={onRetry}>{t('common.retry', 'Retry')}</button>
        </div>
      ) : null}
    </div>
  );
}

export default LoadErrorBanner;
