// Notification Center — pure lane/badge logic (2026-09-01).
// Source of truth: design/mockups/notification-center-mockup.html +
// notifications-NOTES.md. Mirrors lib/toll-triage.js: a data module with no
// React so the rail, the bell badge and the tests share one implementation.
//
// Lanes are SAVED FILTERS over one feed, not separate inboxes (mock callout).
// Each lane is {severity?, sourceType?} applied to the same GET /api/notifications.

export const NOTIFICATION_SEVERITIES = ['CRITICAL', 'NEEDS_ACTION', 'INFO'];

// The severity contract (fixed): CRITICAL badges the bell, NEEDS_ACTION shows
// in the panel and counts, INFO never badges.
export const BADGE_SEVERITIES = ['CRITICAL', 'NEEDS_ACTION'];

/**
 * Lane rail, regrouped by severity exactly like the mock. `id` doubles as the
 * i18n leaf (notifications.lanes.<id>); `filter` is what the lane queries.
 */
export const NOTIFICATION_LANE_GROUPS = [
  {
    id: 'critical', tone: 'bad',
    lanes: [
      { id: 'allCritical', filter: { severity: 'CRITICAL' } },
      { id: 'geofence', filter: { severity: 'CRITICAL', sourceType: 'GEOFENCE' } },
      { id: 'kiosk', filter: { severity: 'CRITICAL', sourceType: 'KIOSK' } },
    ],
  },
  {
    id: 'needsAction', tone: 'warn',
    lanes: [
      { id: 'maintenance', filter: { sourceType: 'MAINTENANCE' } },
      { id: 'shuttle', filter: { sourceType: 'SHUTTLE' } },
      { id: 'documents', filter: { sourceType: 'DOCUMENTS' } },
      // Check-in audit (2026-09-03): entry-error findings from the T1 rules
      // pass — NEEDS_ACTION, deduped per reservation+check by the emitter.
      { id: 'checkinAudit', filter: { sourceType: 'CHECKIN_AUDIT' } },
      // Idle vehicles (2026-09-01, backlog #5): one envelope per vehicle per
      // idle episode from the daily sweep; severity is tenant-configurable so
      // the lane filters by source only.
      { id: 'fleet', filter: { sourceType: 'FLEET' } },
    ],
  },
  {
    id: 'info', tone: 'info',
    lanes: [
      { id: 'allInfo', filter: { severity: 'INFO' } },
      // Billing is ADMIN-gated at the API; for everyone else this lane simply
      // counts 0 and stays quiet.
      { id: 'billing', filter: { sourceType: 'BILLING' } },
    ],
  },
  {
    id: 'everything', tone: 'all',
    lanes: [
      { id: 'all', filter: {} },
    ],
  },
];

/** DB-provided counts ({severity:{}, sourceType:{}}) → this lane's number. */
export function laneCount(counts, filter = {}) {
  const sev = counts?.severity || {};
  const src = counts?.sourceType || {};
  if (filter.severity && filter.sourceType) {
    // No cross-tab from the API; the narrower dimension is the honest upper
    // bound and in practice these sources are single-severity (geofence and
    // kiosk emit CRITICAL only).
    return Number(src[filter.sourceType] || 0);
  }
  if (filter.severity) return Number(sev[filter.severity] || 0);
  if (filter.sourceType) return Number(src[filter.sourceType] || 0);
  return Object.values(sev).reduce((a, b) => a + Number(b || 0), 0);
}

/** Badge text for the bell: '' hides it, caps at 99+. */
export function badgeLabel(count) {
  const n = Number(count) || 0;
  if (n <= 0) return '';
  return n > 99 ? '99+' : String(n);
}

/** Client-side filter matching the lane (used by panel scope pills). */
export function matchesFilter(item, filter = {}) {
  if (filter.severity && item?.severity !== filter.severity) return false;
  if (filter.sourceType && item?.sourceType !== filter.sourceType) return false;
  return true;
}

/**
 * Localized title: known templateKey → notifications.evt.<key> with params;
 * anything else falls back to the stored (EN) title so old rows never break.
 */
export function notificationTitle(t, item) {
  if (item?.templateKey) {
    const key = `notifications.evt.${item.templateKey}`;
    const out = t(key, { ...(item.params || {}), defaultValue: item.title || '' });
    if (out && out !== key) return out;
  }
  return item?.title || '';
}

/** Severity → visual tone class suffix (sev--bad / sev--warn / sev--info). */
export function severityTone(severity, resolvedAt) {
  if (resolvedAt) return 'ok';
  if (severity === 'CRITICAL') return 'bad';
  if (severity === 'NEEDS_ACTION') return 'warn';
  return 'info';
}

/**
 * Day grouping for the feed: [{label:{kind,date}, items}] newest-first.
 * kind: 'today' | 'yesterday' | 'date' — the component renders the i18n label.
 */
export function groupByDay(items, now = new Date()) {
  const dayKey = (d) => {
    const x = new Date(d);
    return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;
  };
  const todayKey = dayKey(now);
  const yesterdayKey = dayKey(new Date(now.getTime() - 24 * 60 * 60 * 1000));
  const groups = [];
  const byKey = new Map();
  for (const item of items || []) {
    const key = dayKey(item.createdAt);
    if (!byKey.has(key)) {
      const kind = key === todayKey ? 'today' : (key === yesterdayKey ? 'yesterday' : 'date');
      const group = { key, kind, date: new Date(item.createdAt), items: [] };
      byKey.set(key, group);
      groups.push(group);
    }
    byKey.get(key).items.push(item);
  }
  return groups;
}

/** Short relative time for the panel ("2m", "3h", "5d"). */
export function relativeTime(createdAt, now = new Date()) {
  const ms = Math.max(0, now - new Date(createdAt));
  const min = Math.floor(ms / 60000);
  if (min < 1) return 'now';
  if (min < 60) return `${min}m`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}
