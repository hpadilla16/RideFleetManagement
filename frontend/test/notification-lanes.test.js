/**
 * Notification Center — pure logic + i18n parity (2026-09-01).
 * Pins, in order:
 *  (1) the badge contract — CRITICAL+NEEDS_ACTION badge, INFO never; 99+ cap
 *  (2) lanes are saved filters (severity/sourceType) with DB-provided counts
 *  (3) localized titles render from templateKey + params, falling back to the
 *      stored EN title for unknown keys (old rows must never break)
 *  (4) day grouping (today / yesterday / date) and read-tint inputs
 *  (5) the notifications i18n namespace exists in BOTH languages with equal
 *      key sets (namespace-merge guard, same precedent as tolls-grouping)
 */
import { describe, it, expect } from 'vitest';
import en from '../src/locales/en.json';
import es from '../src/locales/es.json';
import {
  NOTIFICATION_LANE_GROUPS,
  BADGE_SEVERITIES,
  laneCount,
  badgeLabel,
  matchesFilter,
  notificationTitle,
  severityTone,
  groupByDay,
  relativeTime,
} from '../src/lib/notification-lanes';

describe('badge contract', () => {
  it('badges CRITICAL + NEEDS_ACTION only — INFO never badges', () => {
    expect(BADGE_SEVERITIES).toEqual(['CRITICAL', 'NEEDS_ACTION']);
    expect(BADGE_SEVERITIES).not.toContain('INFO');
  });

  it('badge label: hidden at 0, exact through 99, capped at 99+', () => {
    expect(badgeLabel(0)).toBe('');
    expect(badgeLabel(-2)).toBe('');
    expect(badgeLabel(1)).toBe('1');
    expect(badgeLabel(99)).toBe('99');
    expect(badgeLabel(100)).toBe('99+');
    expect(badgeLabel(4000)).toBe('99+');
    expect(badgeLabel(undefined)).toBe('');
  });
});

describe('lanes are saved filters over one feed', () => {
  it('every lane filter uses only severity/sourceType (no separate inboxes)', () => {
    for (const group of NOTIFICATION_LANE_GROUPS) {
      for (const lane of group.lanes) {
        const keys = Object.keys(lane.filter);
        expect(keys.every((k) => k === 'severity' || k === 'sourceType')).toBe(true);
      }
    }
  });

  it('the four groups mirror the mock: critical / needsAction / info / everything', () => {
    expect(NOTIFICATION_LANE_GROUPS.map((g) => g.id)).toEqual(['critical', 'needsAction', 'info', 'everything']);
    const everything = NOTIFICATION_LANE_GROUPS[3];
    expect(everything.lanes).toEqual([{ id: 'all', filter: {} }]);
  });

  it('laneCount reads the DB-provided counts, never the loaded page', () => {
    const counts = {
      severity: { CRITICAL: 2, NEEDS_ACTION: 5, INFO: 3 },
      sourceType: { GEOFENCE: 1, KIOSK: 1, TOLL: 4, MAINTENANCE: 1, DOCUMENTS: 4 },
    };
    expect(laneCount(counts, { severity: 'CRITICAL' })).toBe(2);
    expect(laneCount(counts, { sourceType: 'TOLL' })).toBe(4);
    expect(laneCount(counts, {})).toBe(10);
    expect(laneCount({}, { severity: 'CRITICAL' })).toBe(0);
  });

  it('matchesFilter narrows by severity and sourceType', () => {
    const item = { severity: 'CRITICAL', sourceType: 'GEOFENCE' };
    expect(matchesFilter(item, {})).toBe(true);
    expect(matchesFilter(item, { severity: 'CRITICAL' })).toBe(true);
    expect(matchesFilter(item, { severity: 'INFO' })).toBe(false);
    expect(matchesFilter(item, { severity: 'CRITICAL', sourceType: 'KIOSK' })).toBe(false);
  });
});

describe('localized titles', () => {
  // Minimal t() mimicking i18next default-value semantics over the real EN file.
  const t = (key, opts = {}) => {
    const parts = key.split('.');
    let node = en;
    for (const p of parts) node = node?.[p];
    if (typeof node !== 'string') return opts.defaultValue ?? key;
    return node.replace(/\{\{(\w+)\}\}/g, (_, k) => String(opts[k] ?? ''));
  };

  it('renders from templateKey + params (client-side i18n, not stored text)', () => {
    const item = { templateKey: 'noShow', params: { stop: 'Terminal B' }, title: 'ignored EN' };
    expect(notificationTitle(t, item)).toBe('Shuttle request no-show — Terminal B');
  });

  it('falls back to the stored EN title for unknown templateKeys (old rows never break)', () => {
    const item = { templateKey: 'somethingNew', title: 'Stored title' };
    expect(notificationTitle(t, item)).toBe('Stored title');
    expect(notificationTitle(t, { title: 'No key at all' })).toBe('No key at all');
  });
});

describe('severity tone + day grouping (feed rendering inputs)', () => {
  it('tones: CRITICAL→bad, NEEDS_ACTION→warn, INFO→info, resolved→ok', () => {
    expect(severityTone('CRITICAL', null)).toBe('bad');
    expect(severityTone('NEEDS_ACTION', null)).toBe('warn');
    expect(severityTone('INFO', null)).toBe('info');
    expect(severityTone('CRITICAL', '2026-09-01T10:00:00Z')).toBe('ok');
  });

  it('groups newest-first into today / yesterday / dated buckets', () => {
    const now = new Date('2026-09-01T15:00:00');
    const items = [
      { id: 'a', createdAt: '2026-09-01T14:41:00' },
      { id: 'b', createdAt: '2026-09-01T11:05:00' },
      { id: 'c', createdAt: '2026-08-31T16:20:00' },
      { id: 'd', createdAt: '2026-08-25T09:00:00' },
    ];
    const groups = groupByDay(items, now);
    expect(groups.map((g) => g.kind)).toEqual(['today', 'yesterday', 'date']);
    expect(groups[0].items.map((i) => i.id)).toEqual(['a', 'b']);
    expect(groups[2].items.map((i) => i.id)).toEqual(['d']);
  });

  it('relative time for the panel', () => {
    const now = new Date('2026-09-01T12:00:00Z');
    expect(relativeTime('2026-09-01T11:58:00Z', now)).toBe('2m');
    expect(relativeTime('2026-09-01T09:00:00Z', now)).toBe('3h');
    expect(relativeTime('2026-08-29T12:00:00Z', now)).toBe('3d');
  });
});

describe('i18n parity (namespace-merge guard)', () => {
  const keysDeep = (obj, prefix = '') => Object.entries(obj).flatMap(([k, v]) => (
    typeof v === 'object' && v !== null ? keysDeep(v, `${prefix}${k}.`) : [`${prefix}${k}`]
  ));

  it('the notifications namespace exists in BOTH languages with identical key sets', () => {
    expect(en.notifications).toBeTruthy();
    expect(es.notifications).toBeTruthy();
    expect(keysDeep(es.notifications).sort()).toEqual(keysDeep(en.notifications).sort());
  });

  it('nav.notifications exists in both languages (sidebar label)', () => {
    expect(en.nav.notifications).toBe('Notifications');
    expect(es.nav.notifications).toBe('Notificaciones');
  });

  it('every lane id has a label in both languages', () => {
    for (const group of NOTIFICATION_LANE_GROUPS) {
      expect(en.notifications.lanes[group.id], `en lanes.${group.id}`).toBeTruthy();
      expect(es.notifications.lanes[group.id], `es lanes.${group.id}`).toBeTruthy();
      for (const lane of group.lanes) {
        expect(en.notifications.lanes[lane.id], `en lanes.${lane.id}`).toBeTruthy();
        expect(es.notifications.lanes[lane.id], `es lanes.${lane.id}`).toBeTruthy();
      }
    }
  });

  it('every emitter templateKey has an evt.* title in both languages', () => {
    for (const key of ['geofence', 'kiosk', 'tollClosed', 'tollNew', 'noShow', 'regExpiring', 'regExpired', 'maintOverdue', 'billingSuspended']) {
      expect(en.notifications.evt[key], `en evt.${key}`).toBeTruthy();
      expect(es.notifications.evt[key], `es evt.${key}`).toBeTruthy();
    }
  });
});
