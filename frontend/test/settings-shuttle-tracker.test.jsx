import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';

/**
 * ShuttleTrackerSettings (Settings → Locations → location editor).
 *
 * Two live findings from 2026-08-25/26 are pinned here:
 *
 *  1. TENANT SCOPE. A SUPER_ADMIN operating inside a tenant got a 404 from
 *     GET /api/shuttle-tracker/config, because the card called the endpoint
 *     unscoped while the rest of the settings page routes everything through
 *     `scopedSettingsPath`. The card then rendered as ONE LINE of 12px grey
 *     text — visually identical to the helper copy around it, so the whole
 *     feature looked absent rather than broken. Both halves are tested: the
 *     scope actually reaches the wire, and a failure is loud and recoverable.
 *
 *  2. INTAKE HAS A UI. Until now `intakeJson` was flippable only by SQL.
 */

const { apiMock, tokenMock } = vi.hoisted(() => ({ apiMock: vi.fn(), tokenMock: vi.fn(() => 'tok') }));

vi.mock('../src/lib/client', () => ({ api: apiMock, readStoredToken: tokenMock }));

import { ShuttleTrackerSettings } from '../src/components/settings/ShuttleTrackerSettings';

const CONFIG = {
  locationId: 'loc-1',
  mode: 'ON_DEMAND',
  vehicleIds: ['veh-1'],
  headwayMinutes: 10,
  intake: { enabled: false, partySizeCap: 50, bagsCap: 20 },
};

const FLEET = { rows: [{ id: 'veh-1', make: 'Ford', model: 'Transit', plate: 'ABC123', programCategory: 'SHUTTLE_ONLY' }] };

/** The super-admin scoper the settings page hands down. */
const scopedForTenant = (tenantId) => (path) =>
  `${path}${path.includes('?') ? '&' : '?'}tenantId=${encodeURIComponent(tenantId)}`;

function mockOk(overrides = {}) {
  apiMock.mockImplementation(async (path, opts = {}) => {
    const method = String(opts.method || 'GET').toUpperCase();
    if (method === 'PUT') return { ...CONFIG, ...JSON.parse(opts.body), ...overrides };
    if (path.includes('/api/vehicles')) return FLEET;
    return { ...CONFIG, ...overrides };
  });
}

beforeEach(() => { apiMock.mockReset(); });
afterEach(() => { vi.restoreAllMocks(); });

describe('ShuttleTrackerSettings — tenant scope', () => {
  it('routes BOTH the config and the fleet read through scopedSettingsPath', async () => {
    mockOk();
    render(<ShuttleTrackerSettings locationId="loc-1" scopedSettingsPath={scopedForTenant('tnt-9')} />);
    await waitFor(() => expect(apiMock).toHaveBeenCalledTimes(2));

    const paths = apiMock.mock.calls.map(([p]) => p);
    expect(paths.some((p) => p.startsWith('/api/shuttle-tracker/config?') && p.includes('tenantId=tnt-9'))).toBe(true);
    expect(paths.some((p) => p.includes('/api/vehicles') && p.includes('tenantId=tnt-9'))).toBe(true);
  });

  it('carries the tenant on the SAVE too — a read-only scope would 404 the write', async () => {
    mockOk();
    render(<ShuttleTrackerSettings locationId="loc-1" scopedSettingsPath={scopedForTenant('tnt-9')} />);
    await screen.findByText(/Shuttle Tracker \(customer live map\)/);

    fireEvent.click(screen.getByRole('button', { name: /Save shuttle tracker/ }));
    await waitFor(() => {
      const put = apiMock.mock.calls.find(([, o]) => String(o?.method).toUpperCase() === 'PUT');
      expect(put).toBeTruthy();
      expect(put[0]).toContain('tenantId=tnt-9');
    });
  });

  it('works unscoped when mounted without the prop', async () => {
    mockOk();
    render(<ShuttleTrackerSettings locationId="loc-1" />);
    await waitFor(() => expect(apiMock).toHaveBeenCalled());
    expect(apiMock.mock.calls[0][0]).not.toContain('tenantId=');
  });
});

describe('ShuttleTrackerSettings — failure is visible', () => {
  it('renders a bordered alert with the message and a retry, not a grey line', async () => {
    apiMock.mockRejectedValue(new Error('Location not found'));
    render(<ShuttleTrackerSettings locationId="loc-1" scopedSettingsPath={(p) => p} />);

    const box = await screen.findByTestId('shuttle-tracker-error');
    // role=alert: the old version was a plain muted <div> with no semantics.
    expect(box.getAttribute('role')).toBe('alert');
    expect(box.style.border).toContain('1px solid');
    expect(box.textContent).toContain('Location not found');
    expect(screen.getByRole('button', { name: /Retry/ })).toBeTruthy();
  });

  it('retry re-issues the load and recovers', async () => {
    let fail = true;
    apiMock.mockImplementation(async (path) => {
      if (fail) throw new Error('Location not found');
      return path.includes('/api/vehicles') ? FLEET : CONFIG;
    });
    render(<ShuttleTrackerSettings locationId="loc-1" scopedSettingsPath={(p) => p} />);
    await screen.findByTestId('shuttle-tracker-error');

    fail = false;
    fireEvent.click(screen.getByRole('button', { name: /Retry/ }));
    await screen.findByText(/Shuttle Tracker \(customer live map\)/);
    expect(screen.queryByTestId('shuttle-tracker-error')).toBeNull();
  });
});

describe('ShuttleTrackerSettings — intake questions', () => {
  it('shows the toggle OFF and hides the caps until it is on', async () => {
    mockOk();
    render(<ShuttleTrackerSettings locationId="loc-1" scopedSettingsPath={(p) => p} />);
    const toggle = await screen.findByTestId('intake-enabled');
    expect(toggle.checked).toBe(false);
    expect(screen.queryByTestId('intake-party-cap')).toBeNull();
  });

  it('reveals the caps when enabled and PUTs the whole intake object', async () => {
    mockOk();
    render(<ShuttleTrackerSettings locationId="loc-1" scopedSettingsPath={(p) => p} />);
    fireEvent.click(await screen.findByTestId('intake-enabled'));

    fireEvent.change(screen.getByTestId('intake-party-cap'), { target: { value: '7' } });
    fireEvent.change(screen.getByTestId('intake-bags-cap'), { target: { value: '9' } });
    fireEvent.click(screen.getByRole('button', { name: /Save shuttle tracker/ }));

    await waitFor(() => {
      const put = apiMock.mock.calls.find(([, o]) => String(o?.method).toUpperCase() === 'PUT');
      expect(put).toBeTruthy();
      expect(JSON.parse(put[1].body).intake).toEqual({ enabled: true, partySizeCap: 7, bagsCap: 9 });
    });
  });

  it('an emptied cap falls back to the default rather than sending 0', async () => {
    // The server 400s on a cap below CAP_MIN, so a half-typed field must not
    // become a failed save.
    mockOk();
    render(<ShuttleTrackerSettings locationId="loc-1" scopedSettingsPath={(p) => p} />);
    fireEvent.click(await screen.findByTestId('intake-enabled'));
    fireEvent.change(screen.getByTestId('intake-bags-cap'), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: /Save shuttle tracker/ }));

    await waitFor(() => {
      const put = apiMock.mock.calls.find(([, o]) => String(o?.method).toUpperCase() === 'PUT');
      expect(JSON.parse(put[1].body).intake.bagsCap).toBe(20);
    });
  });

  it('a config the server returns without an intake block still renders', async () => {
    // Older rows have intakeJson NULL; the GET normalizes, but be defensive.
    apiMock.mockImplementation(async (path) => {
      if (path.includes('/api/vehicles')) return FLEET;
      const { intake, ...rest } = CONFIG;
      return rest;
    });
    render(<ShuttleTrackerSettings locationId="loc-1" scopedSettingsPath={(p) => p} />);
    expect((await screen.findByTestId('intake-enabled')).checked).toBe(false);
  });
});
