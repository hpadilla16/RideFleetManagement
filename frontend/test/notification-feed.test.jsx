/**
 * Notification Center — the feed body (2026-09-01).
 * Pins, in order:
 *  (1) day grouping headers (Today / Yesterday / dated)
 *  (2) read tint: unread rows carry the brand inset bar class; read rows don't
 *  (3) read ≠ acknowledge in the UI: an unacked row offers Acknowledge; an
 *      acked row shows WHO + WHEN instead; a self-resolved row shows
 *      "Self-resolved" and no Acknowledge button
 *  (4) severity icons map to the fixed tones (bad/warn/info/ok)
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

vi.mock('react-i18next', () => ({
  // The page module's import chain (AuthGate → AppShell → lib/i18n) calls
  // i18n.use(initReactI18next).init(...) at import time — the mock must
  // export it or the whole suite fails to load.
  initReactI18next: { type: '3rdParty', init: () => {} },
  useTranslation: () => ({
    t: (key, opts) => {
      if (typeof opts === 'string') return opts;
      if (opts && typeof opts === 'object' && opts.defaultValue) return opts.defaultValue;
      return key;
    },
    i18n: { language: 'en' },
  }),
}));

import { NotificationsFeed } from '../src/app/notifications/page';

const now = new Date();
const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);

const ITEMS = [
  {
    id: 'n1', severity: 'CRITICAL', sourceType: 'GEOFENCE', title: 'Overdue & outside geofence — RES-848d',
    body: 'RES 848d', deepLink: '/reservations/r1', locationId: 'sju',
    read: false, ackAt: null, resolvedAt: null, createdAt: now.toISOString(),
  },
  {
    id: 'n2', severity: 'NEEDS_ACTION', sourceType: 'SHUTTLE', title: 'Shuttle request no-show — Terminal B',
    body: 'party of 3', deepLink: '/shuttles', locationId: 'sju',
    read: true, ackAt: yesterday.toISOString(), ackByName: 'M. Ortiz', resolvedAt: null,
    createdAt: now.toISOString(),
  },
  {
    id: 'n3', severity: 'CRITICAL', sourceType: 'GEOFENCE', title: 'Overdue & outside geofence — RES-700a',
    body: null, deepLink: '/reservations/r3', locationId: null,
    read: true, ackAt: null, resolvedAt: yesterday.toISOString(), createdAt: yesterday.toISOString(),
  },
];

describe('NotificationsFeed', () => {
  let onOpen; let onAck;
  beforeEach(() => {
    onOpen = vi.fn();
    onAck = vi.fn();
  });

  it('groups rows by day with Today / Yesterday headers', () => {
    render(<NotificationsFeed items={ITEMS} onOpen={onOpen} onAck={onAck} />);
    const days = [...document.querySelectorAll('.nc-day')].map((d) => d.textContent);
    expect(days.length).toBe(2);
    expect(days[0]).toContain('Today');
    expect(days[1]).toContain('Yesterday');
  });

  it('unread rows carry the read-tint class; read rows do not', () => {
    render(<NotificationsFeed items={ITEMS} onOpen={onOpen} onAck={onAck} />);
    const rows = screen.getAllByTestId('nc-row');
    expect(rows[0].className).toContain('unread');
    expect(rows[1].className).not.toContain('unread');
  });

  it('unacked rows offer Acknowledge; acked rows show WHO + WHEN instead', () => {
    render(<NotificationsFeed items={ITEMS} onOpen={onOpen} onAck={onAck} />);
    const rows = screen.getAllByTestId('nc-row');
    // n1: open work → Acknowledge button.
    expect(rows[0].textContent).toContain('Acknowledge');
    // n2: acked → the team-visible stamp, no button ("Acknowledged by…" is a
    // substring superset of "Acknowledge", so assert on the button element).
    expect(rows[1].textContent).toContain('M. Ortiz');
    expect(rows[1].querySelector('.nc-btn')).toBeNull();
    fireEvent.click(screen.getByText('Acknowledge'));
    expect(onAck).toHaveBeenCalledWith(expect.objectContaining({ id: 'n1' }));
  });

  it('self-resolved rows show Self-resolved and no Acknowledge button', () => {
    render(<NotificationsFeed items={ITEMS} onOpen={onOpen} onAck={onAck} />);
    const rows = screen.getAllByTestId('nc-row');
    expect(rows[2].textContent).toContain('Self-resolved');
    expect(rows[2].querySelector('.nc-btn')).toBeNull();
  });

  it('severity tones: CRITICAL→bad, NEEDS_ACTION→warn, resolved→ok', () => {
    render(<NotificationsFeed items={ITEMS} onOpen={onOpen} onAck={onAck} />);
    const rows = screen.getAllByTestId('nc-row');
    expect(rows[0].querySelector('.nc-sev--bad')).toBeTruthy();
    expect(rows[1].querySelector('.nc-sev--warn')).toBeTruthy();
    expect(rows[2].querySelector('.nc-sev--ok')).toBeTruthy();
  });

  it('empty feed renders the honest empty state', () => {
    render(<NotificationsFeed items={[]} onOpen={onOpen} onAck={onAck} />);
    expect(screen.getByText('Nothing needs your attention')).toBeInTheDocument();
  });
});
