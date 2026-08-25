import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react';

/**
 * Phase 3 STAFF UI (approved mockup Screens 10 + 17c) — what these tests pin:
 *  - Waiting list renders every open customer; the map-pin set (sharingPins)
 *    and the 📍 chip exist ONLY for customers actively sharing — non-sharers
 *    stay list-only and are not clickable.
 *  - AssignControl: ON_DEMAND only (renders nothing in loop mode); picking a
 *    vehicle POSTs /assign {vehicleId}; the assigned chip's × DELETEs.
 *  - Driver shifts: mint POSTs and the result modal shows the tokenized link
 *    ONCE — after close it is gone and the list never contains it; revoke
 *    confirms then DELETEs; the notify composer POSTs {message}.
 *  - REQUEST_NO_SHOW renders in the alert feed as a warn row with the
 *    "View requests" action (17c) instead of falling through to raw text.
 */

const { apiMock } = vi.hoisted(() => ({ apiMock: vi.fn() }));

vi.mock('../src/lib/client', () => ({ api: apiMock }));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key, opts) => {
      if (opts && typeof opts === 'object') {
        if (typeof opts.defaultValue === 'string') {
          return opts.defaultValue.replace(/\{\{(\w+)\}\}/g, (_, k) => String(opts[k] ?? ''));
        }
        const vals = Object.entries(opts).map(([k, v]) => `${k}=${v}`).join(',');
        return `${key}[${vals}]`;
      }
      return key;
    },
  }),
}));

import {
  initialsOf, shareAgeText, sharingPins, vehicleOptionsAt, modeAt,
  normalizeAssignedVehicle, shiftVehicleOptions, driverShiftLink,
} from '../src/lib/shuttle-staff';
import { WaitingPanel, AssignControl } from '../src/app/shuttles/WaitingPanel';
import { DriverShiftsTab, MintResultModal } from '../src/app/shuttles/DriverShiftsTab';
import { AlertFeed } from '../src/app/shuttles/AlertFeed';
import { ALERT_META } from '../src/lib/shuttle-alert-feed';

const SHUTTLES = [
  { vehicleId: 'v1', label: 'Ford Transit 350', plate: 'IKT-482', locationId: 'loc1', locationName: 'LAX', mode: 'ON_DEMAND' },
  { vehicleId: 'v2', label: 'Mercedes Sprinter', plate: 'JQD-119', locationId: 'loc1', locationName: 'LAX', mode: 'ON_DEMAND' },
  { vehicleId: 'v3', label: 'Van 3', plate: 'AAA-001', locationId: 'loc2', locationName: 'SJU', mode: 'NON_STOP', headwayMinutes: 10 },
];

const CUSTOMERS = [
  {
    requestId: 'r1', locationId: 'loc1', name: 'Juan P.', partySize: 2, bags: 3,
    pickupSpotZoneId: 'z1', waitingMinutes: 12, assignedVehicle: null,
    sharing: true, lat: 18.43, lng: -66.0, ageSeconds: 45,
  },
  {
    requestId: 'r2', locationId: 'loc1', name: 'M. Rivera', partySize: 1, bags: 1,
    pickupSpotZoneId: null, waitingMinutes: 2,
    assignedVehicle: { vehicleId: 'v2', label: 'Mercedes Sprinter', plate: 'JQD-119' },
    sharing: false,
  },
];

beforeEach(() => { apiMock.mockReset(); });
afterEach(() => { vi.restoreAllMocks(); });

describe('shuttle-staff pure helpers', () => {
  it('initialsOf mirrors the mockup identities', () => {
    expect(initialsOf('Juan P.')).toBe('JP');
    expect(initialsOf('K. Osei')).toBe('KO');
    expect(initialsOf('Madonna')).toBe('MA');
    expect(initialsOf('')).toBe('·');
  });

  it('shareAgeText uses the shuttle freshness language', () => {
    expect(shareAgeText(45)).toBe('45s');
    expect(shareAgeText(120)).toBe('2m');
    expect(shareAgeText('nope')).toBeNull();
  });

  it('sharingPins keeps ONLY sharing customers with usable coordinates', () => {
    const pins = sharingPins([
      ...CUSTOMERS,
      { requestId: 'r3', sharing: true, lat: null, lng: -66 }, // no fix → no pin
    ]);
    expect(pins.map((c) => c.requestId)).toEqual(['r1']);
  });

  it('vehicleOptionsAt scopes to the location and dedupes', () => {
    expect(vehicleOptionsAt(SHUTTLES, 'loc1').map((v) => v.vehicleId)).toEqual(['v1', 'v2']);
    expect(vehicleOptionsAt(SHUTTLES, 'loc2').map((v) => v.vehicleId)).toEqual(['v3']);
    expect(vehicleOptionsAt([...SHUTTLES, SHUTTLES[0]], 'loc1')).toHaveLength(2);
  });

  it('modeAt reads the location config mode; null with no shuttles', () => {
    expect(modeAt(SHUTTLES, 'loc1')).toBe('ON_DEMAND');
    expect(modeAt(SHUTTLES, 'loc2')).toBe('NON_STOP');
    expect(modeAt(SHUTTLES, 'nowhere')).toBeNull();
  });

  it('normalizeAssignedVehicle accepts both payload shapes', () => {
    expect(normalizeAssignedVehicle({ vehicleId: 'v1', label: 'Van', plate: 'P' }))
      .toEqual({ vehicleId: 'v1', label: 'Van', plate: 'P' });
    expect(normalizeAssignedVehicle({ id: 'v2', name: 'Sprinter', plate: null }))
      .toEqual({ vehicleId: 'v2', label: 'Sprinter', plate: null });
    expect(normalizeAssignedVehicle(null)).toBeNull();
  });

  it('shiftVehicleOptions keeps one entry per (vehicle, location) pair', () => {
    const opts = shiftVehicleOptions([...SHUTTLES, { ...SHUTTLES[0], locationId: 'loc2', locationName: 'SJU' }]);
    expect(opts.map((o) => o.key)).toEqual(['v1|loc1', 'v2|loc1', 'v3|loc2', 'v1|loc2']);
  });

  it('driverShiftLink joins origin + linkPath', () => {
    expect(driverShiftLink('/driver/tok123', 'https://app.example.com')).toBe('https://app.example.com/driver/tok123');
    expect(driverShiftLink('', 'https://app.example.com')).toBe('');
  });
});

describe('WaitingPanel (Screen 10)', () => {
  it('renders all customers; the sharing chip only for sharers', () => {
    render(<WaitingPanel customers={CUSTOMERS} shuttles={SHUTTLES} token="t" />);
    const rows = screen.getAllByTestId('waiting-row');
    expect(rows).toHaveLength(2);
    expect(screen.getAllByTestId('sharing-chip')).toHaveLength(1);
    expect(within(rows[0]).getByText('📍 sharing · 45s')).toBeInTheDocument();
    expect(within(rows[1]).getByText('shuttleMonitor.notSharing')).toBeInTheDocument();
    expect(within(rows[0]).getByText('2 pax · 3 bags')).toBeInTheDocument();
    expect(within(rows[0]).getByText('waiting 12 min')).toBeInTheDocument();
  });

  it('row click focuses ONLY sharing customers', () => {
    const onFocus = vi.fn();
    render(<WaitingPanel customers={CUSTOMERS} shuttles={SHUTTLES} token="t" onFocus={onFocus} />);
    const rows = screen.getAllByTestId('waiting-row');
    fireEvent.click(rows[1]); // not sharing → no map focus
    expect(onFocus).not.toHaveBeenCalled();
    fireEvent.click(rows[0]);
    expect(onFocus).toHaveBeenCalledWith(expect.objectContaining({ requestId: 'r1' }));
  });

  it('empty list says so honestly', () => {
    render(<WaitingPanel customers={[]} shuttles={SHUTTLES} token="t" />);
    expect(screen.getByText('shuttleMonitor.waitingEmpty')).toBeInTheDocument();
  });
});

describe('AssignControl (Screens 10 / 8a)', () => {
  it('renders nothing in loop mode — no dispatch to pick', () => {
    const { container } = render(
      <AssignControl requestId="r9" assignedVehicle={null} vehicles={vehicleOptionsAt(SHUTTLES, 'loc2')} mode="NON_STOP" token="t" />,
    );
    expect(container.querySelector('[data-testid="assign-control"]')).toBeNull();
  });

  it('POSTs /assign with the picked vehicleId and reports the change', async () => {
    apiMock.mockResolvedValue({});
    const onChanged = vi.fn();
    render(
      <AssignControl requestId="r1" assignedVehicle={null} vehicles={vehicleOptionsAt(SHUTTLES, 'loc1')} mode="ON_DEMAND" token="t" onChanged={onChanged} />,
    );
    fireEvent.change(screen.getByLabelText('shuttleMonitor.assignLabel'), { target: { value: 'v2' } });
    await waitFor(() => expect(apiMock).toHaveBeenCalledWith(
      '/api/shuttle-requests/r1/assign',
      expect.objectContaining({ method: 'POST', body: { vehicleId: 'v2' } }),
      't',
    ));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
  });

  it('assigned chip shows the vehicle and its × DELETEs the assignment', async () => {
    apiMock.mockResolvedValue({});
    const onChanged = vi.fn();
    render(
      <AssignControl
        requestId="r2"
        assignedVehicle={{ vehicleId: 'v2', label: 'Mercedes Sprinter', plate: 'JQD-119' }}
        vehicles={vehicleOptionsAt(SHUTTLES, 'loc1')}
        mode="ON_DEMAND"
        token="t"
        onChanged={onChanged}
      />,
    );
    expect(screen.getByTestId('assigned-chip')).toHaveTextContent('Mercedes Sprinter · JQD-119');
    fireEvent.click(screen.getByRole('button', { name: 'shuttleMonitor.unassign' }));
    await waitFor(() => expect(apiMock).toHaveBeenCalledWith(
      '/api/shuttle-requests/r2/assign',
      expect.objectContaining({ method: 'DELETE' }),
      't',
    ));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
  });

  it('the queue-row payload shape ({id,name}) renders the same chip', () => {
    render(
      <AssignControl requestId="r2" assignedVehicle={{ id: 'v2', name: 'Mercedes Sprinter', plate: 'JQD-119' }} vehicles={[]} mode="ON_DEMAND" token="t" />,
    );
    expect(screen.getByTestId('assigned-chip')).toHaveTextContent('Mercedes Sprinter · JQD-119');
  });
});

describe('DriverShiftsTab (mint / revoke / notify)', () => {
  const SHIFT = {
    id: 's1', driverName: 'Luis M.', vehicleId: 'v1', vehicleLabel: 'Ford Transit 350',
    plate: 'IKT-482', locationId: 'loc1', locationName: 'LAX',
    expiresAt: '2026-08-25T23:00:00Z', createdAt: '2026-08-25T11:00:00Z',
  };

  it('lists active shifts (never a token) and revoke confirms then DELETEs', async () => {
    apiMock.mockImplementation(async (path, opts = {}) => {
      if (path === '/api/shuttle-monitor/driver-shifts' && (!opts.method || opts.method === 'GET')) return { shifts: [SHIFT] };
      if (path === '/api/shuttle-monitor/driver-shifts/s1' && opts.method === 'DELETE') return { ok: true };
      throw new Error(`unexpected ${opts.method || 'GET'} ${path}`);
    });
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(<DriverShiftsTab token="t" shuttles={SHUTTLES} />);
    await waitFor(() => expect(screen.getByTestId('shift-row')).toBeInTheDocument());
    expect(screen.getByText('Luis M.')).toBeInTheDocument();
    expect(screen.getByText(/Ford Transit 350 · IKT-482 · LAX/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'shuttleMonitor.shiftRevoke' }));
    expect(window.confirm).toHaveBeenCalled();
    await waitFor(() => expect(apiMock).toHaveBeenCalledWith(
      '/api/shuttle-monitor/driver-shifts/s1',
      expect.objectContaining({ method: 'DELETE' }),
      't',
    ));
  });

  it('revoke is aborted when the confirm is declined', async () => {
    apiMock.mockResolvedValue({ shifts: [SHIFT] });
    vi.spyOn(window, 'confirm').mockReturnValue(false);
    render(<DriverShiftsTab token="t" shuttles={SHUTTLES} />);
    await waitFor(() => expect(screen.getByTestId('shift-row')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'shuttleMonitor.shiftRevoke' }));
    expect(apiMock.mock.calls.filter(([, o]) => o?.method === 'DELETE')).toHaveLength(0);
  });

  it('mint POSTs the form and shows the link ONCE — gone after close', async () => {
    apiMock.mockImplementation(async (path, opts = {}) => {
      if (path === '/api/shuttle-monitor/driver-shifts' && opts.method === 'POST') {
        return {
          id: 's9', driverName: 'Ana R.', vehicleId: 'v1', locationId: 'loc1',
          expiresAt: '2026-08-25T23:00:00Z', token: 'SECRET-TOKEN-abc', linkPath: '/driver/SECRET-TOKEN-abc',
        };
      }
      return { shifts: [] }; // list never re-shows tokens
    });
    render(<DriverShiftsTab token="t" shuttles={SHUTTLES} />);
    await waitFor(() => expect(screen.getByText('shuttleMonitor.shiftListEmpty')).toBeInTheDocument());

    fireEvent.change(screen.getByLabelText('shuttleMonitor.shiftVehicle'), { target: { value: 'v1|loc1' } });
    fireEvent.change(screen.getByLabelText('shuttleMonitor.shiftDriverName'), { target: { value: 'Ana R.' } });
    fireEvent.change(screen.getByLabelText('shuttleMonitor.shiftHours'), { target: { value: '8' } });
    fireEvent.click(screen.getByRole('button', { name: 'shuttleMonitor.shiftMint' }));

    await waitFor(() => expect(apiMock).toHaveBeenCalledWith(
      '/api/shuttle-monitor/driver-shifts',
      expect.objectContaining({
        method: 'POST',
        body: { vehicleId: 'v1', locationId: 'loc1', driverName: 'Ana R.', hours: 8 },
      }),
      't',
    ));

    // The modal is the ONE place the link appears.
    await waitFor(() => expect(screen.getByTestId('mint-modal')).toBeInTheDocument());
    expect(screen.getByTestId('mint-link')).toHaveTextContent('/driver/SECRET-TOKEN-abc');

    fireEvent.click(screen.getByRole('button', { name: 'common.close' }));
    await waitFor(() => expect(screen.queryByTestId('mint-modal')).toBeNull());
    // Token shown once — nothing on the page carries it any more.
    expect(document.body.textContent).not.toContain('SECRET-TOKEN-abc');
  });

  it('notify composer POSTs {message} to the shift and confirms', async () => {
    apiMock.mockImplementation(async (path, opts = {}) => {
      if (path === '/api/shuttle-monitor/driver-shifts/s1/notify' && opts.method === 'POST') return { ok: true, id: 'm1' };
      return { shifts: [SHIFT] };
    });
    render(<DriverShiftsTab token="t" shuttles={SHUTTLES} />);
    await waitFor(() => expect(screen.getByTestId('shift-row')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: 'shuttleMonitor.shiftMessage' }));
    fireEvent.change(screen.getByLabelText('shuttleMonitor.shiftMessage'), { target: { value: 'Lot B first' } });
    fireEvent.click(screen.getByRole('button', { name: 'shuttleMonitor.shiftSend' }));

    await waitFor(() => expect(apiMock).toHaveBeenCalledWith(
      '/api/shuttle-monitor/driver-shifts/s1/notify',
      expect.objectContaining({ method: 'POST', body: { message: 'Lot B first' } }),
      't',
    ));
    await waitFor(() => expect(screen.getByTestId('notify-ok')).toBeInTheDocument());
  });
});

describe('MintResultModal', () => {
  it('renders the full link with the shown-once warning', () => {
    render(
      <MintResultModal
        shift={{ driverName: 'Ana R.', vehicleLabel: 'Ford Transit 350', expiresAt: '2026-08-25T23:00:00Z', linkPath: '/driver/tok9' }}
        onClose={() => {}}
      />,
    );
    expect(screen.getByTestId('mint-link').textContent).toMatch(/\/driver\/tok9$/);
    expect(screen.getByText('shuttleMonitor.shiftLinkOnce')).toBeInTheDocument();
    expect(screen.getByText('shuttleMonitor.shiftWhatsApp').getAttribute('href')).toContain('https://wa.me/?text=');
  });
});

describe('REQUEST_NO_SHOW in the alert feed (Screen 17c)', () => {
  const NO_SHOW = {
    id: 'a9',
    type: 'REQUEST_NO_SHOW',
    occurredAt: '2026-08-25T19:42:00Z',
    zone: { id: 'z1', name: 'LAX Pickup Lot B', kind: 'ZONE', locationId: 'loc1', isPickupSpot: true },
    vehicle: { id: 'v2', name: 'Mercedes Sprinter', plate: 'JQD-119' },
  };

  it('has a warn meta mapping — never renders as raw type text', () => {
    expect(ALERT_META.REQUEST_NO_SHOW).toMatchObject({ tone: 'warn', icon: '⚠' });
  });

  it('renders the no-show sentence + the View requests action', () => {
    const onOpenRequests = vi.fn();
    render(<AlertFeed alerts={[NO_SHOW]} onOpenRequests={onOpenRequests} />);
    // The t-mock interpolates defaultValue — the meta's sentence must carry
    // the pickup-spot zone name (the payload has no customer fields, by
    // backend design).
    expect(screen.getByText('No-show — customer not picked up at LAX Pickup Lot B')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('alert-open-requests'));
    expect(onOpenRequests).toHaveBeenCalledWith(expect.objectContaining({ id: 'a9' }));
  });

  it('other alert types keep NO View requests action', () => {
    render(
      <AlertFeed
        alerts={[{ id: 'a1', type: 'ENTER', occurredAt: '2026-08-25T19:00:00Z', zone: null, vehicle: null }]}
        onOpenRequests={() => {}}
      />,
    );
    expect(screen.queryByTestId('alert-open-requests')).toBeNull();
  });
});
