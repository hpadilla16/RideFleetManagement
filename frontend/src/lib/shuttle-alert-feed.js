/**
 * Pure helpers for the Shuttle Monitor alert feed + toast (Phase 2,
 * approved mockup Screen 5). No fetch, no React — unit-testable alone.
 *
 * The feed polls GET /api/shuttle-monitor/alerts on the monitor's existing
 * 12s cycle; the toast fires only for alerts NEWER than the previous poll's
 * newest timestamp (never on the first poll — a page load must not replay
 * the morning's history as toasts).
 */

/** Alert type → icon + tone + i18n label key. Types come from the backend's
 *  ALERT_TYPES (shuttle-zone-alerts.js) — anything unknown renders neutral. */
export const ALERT_META = {
  ENTER: { icon: '✓', tone: 'ok', labelKey: 'shuttleMonitor.alertEnter', labelDefault: '{{who}} entered {{zone}}' },
  EXIT: { icon: '↩', tone: 'neutral', labelKey: 'shuttleMonitor.alertExit', labelDefault: '{{who}} exited {{zone}}' },
  OFF_ROUTE: { icon: '⚠', tone: 'warn', labelKey: 'shuttleMonitor.alertOffRoute', labelDefault: '{{who}} left the route corridor' },
  // Phase 3 no-show fan-out (Screen 17c). The feed payload carries zone +
  // vehicle labels only — customer name/party stay in the backend's rawJson,
  // which this endpoint deliberately does not expose — so the sentence leans
  // on the pickup spot, and the row's action deep-links to the queue.
  REQUEST_NO_SHOW: { icon: '⚠', tone: 'warn', labelKey: 'shuttleMonitor.alertNoShow', labelDefault: 'No-show — customer not picked up at {{zone}}' },
};

/** occurredAt → epoch ms, 0 when unparseable (never NaN out). */
export function alertTs(alert) {
  const t = new Date(alert?.occurredAt || 0).getTime();
  return Number.isFinite(t) ? t : 0;
}

/** Newest occurredAt (ms) in a feed payload, or null for an empty feed. */
export function newestAlertTs(alerts = []) {
  let max = null;
  for (const a of alerts) {
    const t = alertTs(a);
    if (t && (max == null || t > max)) max = t;
  }
  return max;
}

/**
 * Alerts strictly newer than `sinceTs` — the toast candidates for one poll.
 * `sinceTs == null` means "first poll": nothing toasts, by design.
 */
export function alertsNewerThan(alerts = [], sinceTs) {
  if (sinceTs == null) return [];
  return alerts.filter((a) => alertTs(a) > sinceTs);
}

/** Provider event time → local HH:MM (the mockup's tabular timestamp). */
export function formatAlertTime(occurredAt) {
  const d = new Date(occurredAt || 0);
  if (Number.isNaN(d.getTime())) return '';
  try {
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
  } catch {
    return d.toISOString().slice(11, 16);
  }
}
