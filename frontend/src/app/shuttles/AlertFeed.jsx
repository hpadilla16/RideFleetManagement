'use client';

/**
 * Monitor alert feed + toast (Phase 2, approved mockup Screen 5).
 *
 * Rows render the staff feed from GET /api/shuttle-monitor/alerts — icon,
 * "Shuttle 1 entered LAX Pickup Lot B", vehicle sublabel, provider event
 * time (NOT our poll time — the backend passes occurredAt through). The
 * toast is a lightweight fixed card the page shows for alerts newer than
 * the previous poll; it never replays history on page load.
 */
import { useTranslation } from 'react-i18next';
import { ALERT_META, formatAlertTime } from '../../lib/shuttle-alert-feed';

const TONE_STYLE = {
  ok: { background: 'var(--ok-bg, #e6f7f1)', borderColor: 'var(--ok-bd, #bfe8d9)' },
  warn: { background: 'var(--warn-bg, #fdf3e2)', borderColor: 'var(--warn-bd, #f3dcb5)' },
  neutral: {},
};

const FALLBACK_META = { icon: '•', tone: 'neutral', labelKey: null };

/** One alert → its display sentence, translated. Exported for the toast. */
export function alertText(t, alert) {
  const meta = ALERT_META[alert?.type] || null;
  const who = alert?.vehicle?.name || t('shuttleMonitor.alertShuttleFallback', 'Shuttle');
  const zone = alert?.zone?.name || t('shuttleMonitor.alertZoneFallback', 'a zone');
  if (!meta) return `${who} · ${String(alert?.type || '').toLowerCase()}`;
  return t(meta.labelKey, { defaultValue: meta.labelDefault, who, zone });
}

export function AlertFeed({ alerts = [], onSelect }) {
  const { t } = useTranslation();
  return (
    <div data-testid="alert-feed">
      <span className="label">{t('shuttleMonitor.alertsTitle', 'Alerts · today')}</span>
      {alerts.length === 0 ? (
        <p className="ui-muted" style={{ fontSize: 12, marginTop: 6 }}>
          {t('shuttleMonitor.alertsEmpty', 'No geofence alerts yet. Enter/exit events appear here as they fire.')}
        </p>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 8 }}>
          {alerts.map((a) => {
            const meta = ALERT_META[a?.type] || FALLBACK_META;
            const sub = [a?.vehicle?.name, a?.vehicle?.plate].filter(Boolean).join(' · ');
            const clickable = !!(onSelect && a?.vehicle?.id);
            return (
              <div
                key={a.id}
                data-testid="alert-row"
                onClick={clickable ? () => onSelect(a) : undefined}
                style={{
                  display: 'flex', gap: 8, alignItems: 'flex-start', padding: '8px 10px',
                  borderRadius: 8, border: '1px solid var(--border, #e9e4f4)', fontSize: 12,
                  lineHeight: 1.45, cursor: clickable ? 'pointer' : 'default',
                  ...(TONE_STYLE[meta.tone] || {}),
                }}
              >
                <span aria-hidden="true" style={{ flexShrink: 0, marginTop: 1 }}>{meta.icon}</span>
                <span style={{ minWidth: 0 }}>
                  <strong>{alertText(t, a)}</strong>
                  {sub ? (<><br /><span className="ui-muted">{sub}</span></>) : null}
                </span>
                <span
                  className="ui-muted"
                  style={{ marginLeft: 'auto', fontSize: 10.5, whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums', paddingLeft: 8 }}
                >
                  {formatAlertTime(a?.occurredAt)}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

export function AlertToast({ alert, onClose, onShow }) {
  const { t } = useTranslation();
  const meta = ALERT_META[alert?.type] || FALLBACK_META;
  const sub = [alert?.vehicle?.name, alert?.vehicle?.plate, formatAlertTime(alert?.occurredAt)]
    .filter(Boolean).join(' · ');
  return (
    <div
      data-testid="alert-toast"
      role="status"
      style={{
        position: 'fixed', right: 18, bottom: 18, zIndex: 60, display: 'flex', gap: 10,
        alignItems: 'flex-start', maxWidth: 360, padding: '13px 15px', borderRadius: 11,
        // Deliberately theme-fixed dark (mockup toast): readable over any map.
        background: '#17122b', color: '#fff', boxShadow: '0 6px 24px rgba(0,0,0,.35)',
        fontSize: 12.5, lineHeight: 1.5,
      }}
    >
      <span aria-hidden="true" style={{ fontSize: 15 }}>{meta.icon}</span>
      <span style={{ minWidth: 0 }}>
        <strong>{alertText(t, alert)}</strong>
        {sub ? (<><br />{sub}</>) : null}
        {onShow ? (
          <><br />
            <span
              onClick={onShow}
              style={{ textDecoration: 'underline', cursor: 'pointer' }}
            >
              {t('shuttleMonitor.alertShowOnMap', 'Show on map')}
            </span>
          </>
        ) : null}
      </span>
      <button
        type="button"
        onClick={onClose}
        aria-label={t('common.close', 'Close')}
        style={{ background: 'none', border: 'none', color: 'rgba(255,255,255,.6)', cursor: 'pointer', fontSize: 14, padding: 0, lineHeight: 1 }}
      >
        ✕
      </button>
    </div>
  );
}
