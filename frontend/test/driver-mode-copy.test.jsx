import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';

/**
 * Driver Mode home — the one line that tells the driver HOW this sede runs.
 *
 * Live finding 2026-08-26: an ON_DEMAND location's driver was shown
 * "Continuous loop · passes every 30 min". The copy was keyed on
 * `headwayMinutes`, which the config column defaults to 10 and therefore
 * always has a value — so the loop line was unconditional and the on-demand
 * string was dead code. `mode` is the fact; headway only decorates NON_STOP.
 *
 * Separate file from shuttle-driver-mode.test.jsx on purpose (that suite is
 * being edited concurrently).
 */

import { DriverClient } from '../src/app/driver/[token]/DriverClient';

const TOKEN = 'TEST-DRIVER-SHIFT-TOKEN';

const BASE = {
  driverName: 'Carlos M.',
  expiresAt: null,
  mode: 'NON_STOP',
  headwayMinutes: 30,
  vehicle: { name: 'Ford Transit 350', color: 'white', plate: 'IKT-482' },
  location: { name: 'LAX Airport', latitude: 33.9425, longitude: -118.4081 },
  zones: [],
  roster: [],
  generatedAt: '2026-08-26T14:41:00.000Z',
};

function mockFetch(payload) {
  vi.stubGlobal('fetch', vi.fn(async (url) => {
    if (String(url).includes('/notifications')) {
      return { ok: true, status: 200, json: async () => ({ messages: [] }) };
    }
    return { ok: true, status: 200, json: async () => payload };
  }));
}

beforeEach(() => {
  window.localStorage.clear();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('Driver Mode — mode line', () => {
  it('NON_STOP keeps the loop + headway promise (ES)', async () => {
    window.localStorage.setItem('ride-driver-lang', 'es');
    mockFetch(BASE);
    render(<DriverClient token={TOKEN} />);
    const line = await screen.findByTestId('driver-mode-line');
    expect(line).toHaveTextContent('Circuito continuo · pasa cada 30 min');
  });

  it('THE REGRESSION: ON_DEMAND never says "loop", even though headway has a value (ES)', async () => {
    window.localStorage.setItem('ride-driver-lang', 'es');
    mockFetch({ ...BASE, mode: 'ON_DEMAND' });
    render(<DriverClient token={TOKEN} />);
    const line = await screen.findByTestId('driver-mode-line');
    expect(line.textContent).not.toMatch(/Circuito continuo|30 min/);
    expect(line).toHaveTextContent('A demanda · recoges cuando el counter asigna');
  });

  it('ON_DEMAND in English says who assigns the pickup', async () => {
    window.localStorage.setItem('ride-driver-lang', 'en');
    mockFetch({ ...BASE, mode: 'ON_DEMAND' });
    render(<DriverClient token={TOKEN} />);
    const line = await screen.findByTestId('driver-mode-line');
    expect(line).toHaveTextContent('On demand · you pick up when the counter assigns');
  });

  it('NON_STOP in English keeps the headway', async () => {
    window.localStorage.setItem('ride-driver-lang', 'en');
    mockFetch(BASE);
    render(<DriverClient token={TOKEN} />);
    expect(await screen.findByTestId('driver-mode-line')).toHaveTextContent('Continuous loop · passes every 30 min');
  });

  it('a missing mode is treated as on-demand, not as a loop', async () => {
    // Fail toward the weaker promise: telling a driver a loop exists when the
    // payload never said so is the failure that cost the live confusion.
    window.localStorage.setItem('ride-driver-lang', 'en');
    mockFetch({ ...BASE, mode: undefined });
    render(<DriverClient token={TOKEN} />);
    expect((await screen.findByTestId('driver-mode-line')).textContent).not.toMatch(/Continuous loop/);
  });

  it('NON_STOP with no usable headway does not promise a number', async () => {
    window.localStorage.setItem('ride-driver-lang', 'en');
    mockFetch({ ...BASE, headwayMinutes: 0 });
    render(<DriverClient token={TOKEN} />);
    const line = await screen.findByTestId('driver-mode-line');
    expect(line.textContent).not.toMatch(/\{n\}|passes every/);
  });
});
