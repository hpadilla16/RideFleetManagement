import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

/**
 * Phase 2 alert feed (approved mockup Screen 5) — what these tests pin down:
 *  - The pure toast decision: nothing toasts on the FIRST poll (sinceTs null),
 *    only alerts strictly newer than the previous poll's newest toast later.
 *  - Feed rows render type icon + sentence + vehicle sublabel + event time
 *    (the provider's occurredAt, not our poll time).
 *  - OFF_ROUTE with no zone still renders (zone-less alerts are feed-only by
 *    backend design) and the empty feed says so honestly.
 */

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key, opts) => {
      if (opts && typeof opts === 'object') {
        const vals = Object.entries(opts).map(([k, v]) => `${k}=${v}`).join(',');
        return `${key}[${vals}]`;
      }
      return key;
    },
  }),
}));

import { newestAlertTs, alertsNewerThan, formatAlertTime } from '../src/lib/shuttle-alert-feed';
import { AlertFeed, AlertToast } from '../src/app/shuttles/AlertFeed';

const ALERTS = [
  {
    id: 'a1',
    type: 'OFF_ROUTE',
    occurredAt: '2026-08-24T14:32:00Z',
    zone: null, // zone-less off-route is legal — renders with the fallback
    vehicle: { id: 'v2', name: 'Mercedes Sprinter 2500', plate: 'JQD-119' },
  },
  {
    id: 'a2',
    type: 'ENTER',
    occurredAt: '2026-08-24T14:28:00Z',
    zone: { id: 'z1', name: 'LAX Pickup Lot B', kind: 'ZONE', isPickupSpot: true },
    vehicle: { id: 'v1', name: 'Ford Transit 350', plate: 'IKT-482' },
  },
  {
    id: 'a3',
    type: 'EXIT',
    occurredAt: '2026-08-24T14:11:00Z',
    zone: { id: 'z2', name: 'Local — Base', kind: 'ZONE', isPickupSpot: false },
    vehicle: null, // vehicle can be unresolved — falls back to "Shuttle"
  },
];

describe('alert feed pure helpers', () => {
  it('newestAlertTs picks the max occurredAt and null for empty feeds', () => {
    expect(newestAlertTs(ALERTS)).toBe(new Date('2026-08-24T14:32:00Z').getTime());
    expect(newestAlertTs([])).toBeNull();
    expect(newestAlertTs([{ occurredAt: 'garbage' }])).toBeNull();
  });

  it('alertsNewerThan never toasts on the first poll (sinceTs null)', () => {
    expect(alertsNewerThan(ALERTS, null)).toEqual([]);
    expect(alertsNewerThan(ALERTS, undefined)).toEqual([]);
  });

  it('alertsNewerThan returns only strictly newer alerts', () => {
    const since = new Date('2026-08-24T14:28:00Z').getTime();
    const fresh = alertsNewerThan(ALERTS, since);
    expect(fresh.map((a) => a.id)).toEqual(['a1']);
    // Same newest again → nothing new, no re-toast.
    expect(alertsNewerThan(ALERTS, newestAlertTs(ALERTS))).toEqual([]);
  });

  it('formatAlertTime is empty for garbage, HH:MM otherwise', () => {
    expect(formatAlertTime('not-a-date')).toBe('');
    expect(formatAlertTime('2026-08-24T14:28:00Z')).toMatch(/^\d{2}:\d{2}$/);
  });
});

describe('AlertFeed rendering', () => {
  it('renders one row per alert with type sentence, sublabel and time', () => {
    render(<AlertFeed alerts={ALERTS} />);
    const rows = screen.getAllByTestId('alert-row');
    expect(rows).toHaveLength(3);

    // OFF_ROUTE: vehicle name interpolated, zone falls back.
    expect(screen.getByText(/shuttleMonitor\.alertOffRoute\[.*who=Mercedes Sprinter 2500/)).toBeInTheDocument();
    // ENTER: zone name interpolated.
    expect(screen.getByText(/shuttleMonitor\.alertEnter\[.*who=Ford Transit 350.*zone=LAX Pickup Lot B/)).toBeInTheDocument();
    // EXIT without a vehicle: "Shuttle" fallback (the mocked t returns the key).
    expect(screen.getByText(/shuttleMonitor\.alertExit\[.*who=shuttleMonitor\.alertShuttleFallback/)).toBeInTheDocument();

    // Vehicle sublabel: name · plate.
    expect(screen.getByText('Mercedes Sprinter 2500 · JQD-119')).toBeInTheDocument();
  });

  it('empty feed shows the honest empty note, not zero rows silently', () => {
    render(<AlertFeed alerts={[]} />);
    expect(screen.queryAllByTestId('alert-row')).toHaveLength(0);
    expect(screen.getByText('shuttleMonitor.alertsEmpty')).toBeInTheDocument();
  });
});

describe('AlertToast rendering', () => {
  it('renders the alert sentence, a close button and Show on map', () => {
    const onClose = vi.fn();
    const onShow = vi.fn();
    render(<AlertToast alert={ALERTS[1]} onClose={onClose} onShow={onShow} />);
    expect(screen.getByTestId('alert-toast')).toBeInTheDocument();
    expect(screen.getByText(/shuttleMonitor\.alertEnter\[.*zone=LAX Pickup Lot B/)).toBeInTheDocument();
    expect(screen.getByText('shuttleMonitor.alertShowOnMap')).toBeInTheDocument();
    screen.getByRole('button', { name: 'common.close' }).click();
    expect(onClose).toHaveBeenCalled();
  });
});
