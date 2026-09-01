/**
 * Notification Center — the topbar bell (2026-09-01).
 * Pins, in order:
 *  (1) badge renders the unread count from /api/notifications/unread-count,
 *      caps at 99+, and hides entirely at 0 (INFO-only feeds badge nothing —
 *      the API already excludes INFO, so 0 here IS that contract)
 *  (2) opening the panel loads the newest items; unread rows get the unread
 *      tint class and the brand dot
 *  (3) "Mark all read" clears the personal badge client-side
 *  (4) clicking a row marks it read and deep-links via the router
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const clientMocks = vi.hoisted(() => ({ api: vi.fn() }));
vi.mock('../src/lib/client', () => ({
  api: clientMocks.api,
}));

const routerMocks = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock('next/navigation', () => ({
  usePathname: () => '/dashboard',
  useRouter: () => ({ push: routerMocks.push, replace: vi.fn(), back: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

// t() honoring the i18next default-value signature (same recipe as appshell.test).
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key, opts) => {
      if (typeof opts === 'string') return opts;
      if (opts && typeof opts === 'object' && opts.defaultValue) return opts.defaultValue;
      return key;
    },
    i18n: { language: 'en' },
  }),
}));

import { NotificationBell } from '../src/components/NotificationBell';

const ITEMS = [
  {
    id: 'n1', severity: 'CRITICAL', sourceType: 'GEOFENCE', templateKey: 'geofence',
    params: { unit: 'RES-848d' }, title: 'Overdue & outside geofence — RES-848d',
    body: 'RES 848d · last seen near Bayamón', deepLink: '/reservations/r1',
    read: false, ackAt: null, resolvedAt: null, createdAt: new Date().toISOString(),
  },
  {
    id: 'n2', severity: 'NEEDS_ACTION', sourceType: 'TOLL', templateKey: 'tollClosed',
    params: { amt: '$3.20' }, title: 'New billable toll on a closed contract — $3.20',
    body: 'JVX-482', deepLink: '/reservations/r2',
    read: true, ackAt: null, resolvedAt: null, createdAt: new Date().toISOString(),
  },
];

describe('NotificationBell', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clientMocks.api.mockImplementation(async (path) => {
      if (path.startsWith('/api/notifications/unread-count')) return { count: 6 };
      if (path.startsWith('/api/notifications?')) return { items: ITEMS, total: 2, unread: 6 };
      return {};
    });
  });

  it('renders the badge from the unread count', async () => {
    render(<NotificationBell />);
    await waitFor(() => expect(screen.getByText('6')).toBeInTheDocument());
    expect(document.querySelector('.nb-badge')).toBeTruthy();
  });

  it('caps the badge at 99+', async () => {
    clientMocks.api.mockResolvedValue({ count: 240 });
    render(<NotificationBell />);
    await waitFor(() => expect(screen.getByText('99+')).toBeInTheDocument());
  });

  it('hides the badge entirely at 0 (an INFO-only feed badges nothing)', async () => {
    clientMocks.api.mockResolvedValue({ count: 0 });
    render(<NotificationBell />);
    // Poll resolves; no badge node may appear.
    await waitFor(() => expect(clientMocks.api).toHaveBeenCalled());
    expect(document.querySelector('.nb-badge')).toBeNull();
  });

  it('opens the panel, lists items, and tints unread rows', async () => {
    render(<NotificationBell />);
    fireEvent.click(document.querySelector('.nb-btn'));
    await waitFor(() => expect(screen.getByText('Overdue & outside geofence — RES-848d')).toBeInTheDocument());
    const rows = document.querySelectorAll('.nb-row');
    expect(rows.length).toBe(2);
    expect(rows[0].className).toContain('unread');
    expect(rows[0].querySelector('.nb-dot')).toBeTruthy();
    expect(rows[1].className).not.toContain('unread');
    expect(rows[1].querySelector('.nb-dot')).toBeNull();
  });

  it('"Mark all read" posts read-all and clears the personal badge', async () => {
    render(<NotificationBell />);
    await waitFor(() => expect(screen.getByText('6')).toBeInTheDocument());
    fireEvent.click(document.querySelector('.nb-btn'));
    await waitFor(() => expect(document.querySelectorAll('.nb-row').length).toBe(2));
    fireEvent.click(screen.getByText('Mark all read'));
    await waitFor(() => {
      expect(clientMocks.api).toHaveBeenCalledWith('/api/notifications/read-all', expect.objectContaining({ method: 'POST' }));
    });
    expect(document.querySelector('.nb-badge')).toBeNull();
  });

  it('clicking a row marks it read and deep-links to the owning surface', async () => {
    render(<NotificationBell />);
    fireEvent.click(document.querySelector('.nb-btn'));
    await waitFor(() => expect(screen.getByText('Overdue & outside geofence — RES-848d')).toBeInTheDocument());
    fireEvent.click(screen.getByText('Overdue & outside geofence — RES-848d'));
    await waitFor(() => {
      expect(clientMocks.api).toHaveBeenCalledWith('/api/notifications/n1/read', expect.objectContaining({ method: 'POST' }));
    });
    expect(routerMocks.push).toHaveBeenCalledWith('/reservations/r1');
  });

  it('scope pills filter the panel client-side (Critical shows only CRITICAL)', async () => {
    render(<NotificationBell />);
    fireEvent.click(document.querySelector('.nb-btn'));
    await waitFor(() => expect(document.querySelectorAll('.nb-row').length).toBe(2));
    // The t() mock returns the inline default, i.e. the scope id itself.
    fireEvent.click(screen.getByText('critical'));
    expect(document.querySelectorAll('.nb-row').length).toBe(1);
    expect(screen.getByText('Overdue & outside geofence — RES-848d')).toBeInTheDocument();
  });
});
