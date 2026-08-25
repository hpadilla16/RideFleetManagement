import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act, within } from '@testing-library/react';

/**
 * Shuttle v2 Phase 3 — Driver Mode UI (approved mockup Screens 12–15 + 17a).
 * What these tests pin down against /api/public/driver/:token:
 *  - Roster rendering: name/pax/maletas/spot, status chips (esperando with
 *    minutes, 📍 compartiendo with age, assigned-to-you highlight, foreign
 *    van label).
 *  - "Recogido ✓" POSTs /requests/:id/picked-up and marks the row locally.
 *  - No-show is gated by the 17a confirm dialog: NO POST leaves the page
 *    until Confirmar, and the body carries { confirmed: true } (the server
 *    400s CONFIRM_REQUIRED without it).
 *  - Issue report (Screen 15): category grid POSTs the contract enum value
 *    plus the optional note, then shows the confirmation state.
 *  - Dead token: the bare 404 renders the friendly expired page.
 *  - Own-GPS fallback: "Transmitir mi ubicación" arms watchPosition and
 *    POSTs { lat, lng } to /position; an accepted:false DEVICE_MAPPED
 *    response flips honestly to "GPS del vehículo activo" and stops the
 *    watch.
 *  - Notifications (Screen 14): unread badge from local read-marks; opening
 *    the inbox renders the messages and clears the badge.
 *
 * No NEXT_PUBLIC_GOOGLE_MAPS_KEY in the test env, so the Google map never
 * enters jsdom — the stylized pickup-spot fallback carries Screen 12.
 */

import { DriverClient } from '../src/app/driver/[token]/DriverClient';

// Deliberately NOT key-shaped: a `prefix_hex` fixture trips gitleaks' generic-api-key rule (CI hard gate).
const TOKEN = 'TEST-DRIVER-SHIFT-TOKEN';

const BASE = {
  driverName: 'Carlos M.',
  expiresAt: '2026-08-25T23:59:59.999Z',
  mode: 'NON_STOP',
  headwayMinutes: 10,
  vehicle: { name: 'Ford Transit 350', color: 'white', plate: 'IKT-482' },
  location: { name: 'LAX Airport', latitude: 33.9425, longitude: -118.4081 },
  zones: [
    {
      id: 'z-route', name: 'Airport loop', kind: 'ROUTE', isPickupSpot: false,
      geometry: { type: 'polyline', points: [{ lat: 33.94, lng: -118.4 }, { lat: 33.95, lng: -118.41 }] },
      toleranceM: null, walkingDirections: null,
    },
    {
      id: 'z-spotb', name: 'Pickup Spot B', kind: 'ZONE', isPickupSpot: true,
      geometry: { type: 'polygon', points: [{ lat: 33.941, lng: -118.401 }, { lat: 33.942, lng: -118.401 }, { lat: 33.942, lng: -118.402 }] },
      toleranceM: 30, walkingDirections: 'Isla B, letrero B-4',
    },
  ],
  roster: [
    {
      id: 'req-1', name: 'Juan Pérez', partySize: 2, bags: 3, status: 'VIEWED',
      pickupNote: null, pickupSpot: 'Pickup Spot B', waitingMinutes: 12,
      assignedToYou: true, assignedVehicle: { name: 'Ford Transit 350', plate: 'IKT-482' },
      sharing: true, lat: 33.9418, lng: -118.4015, ageSeconds: 45,
    },
    {
      id: 'req-2', name: 'K. Osei', partySize: 2, bags: 2, status: 'READY',
      pickupNote: null, pickupSpot: 'Pickup Spot B', waitingMinutes: 14,
      assignedToYou: false, assignedVehicle: null, sharing: false,
    },
    {
      id: 'req-3', name: 'M. Rivera', partySize: 1, bags: 1, status: 'READY',
      pickupNote: 'Silla de bebé', pickupSpot: 'Pickup Spot A', waitingMinutes: 3,
      assignedToYou: false, assignedVehicle: { name: 'Mercedes Sprinter 2500', plate: 'XYZ-900' },
      sharing: false,
    },
  ],
  generatedAt: '2026-08-25T14:41:00.000Z',
};

function mockFetch(payload, { notifications, positionResponse, status = 200 } = {}) {
  const calls = [];
  const fn = vi.fn(async (url, opts = {}) => {
    calls.push({ url: String(url), opts });
    const u = String(url);
    if (status === 404) return { ok: false, status: 404, json: async () => ({ error: 'Not found' }) };
    if (opts.method === 'POST' && u.includes('/position')) {
      return { ok: true, status: 200, json: async () => (positionResponse || { ok: true, accepted: true }) };
    }
    if (opts.method === 'POST' && u.includes('/picked-up')) {
      return { ok: true, status: 200, json: async () => ({ ok: true, id: 'req', status: 'COMPLETED' }) };
    }
    if (opts.method === 'POST' && u.includes('/no-show')) {
      return { ok: true, status: 200, json: async () => ({ ok: true, id: 'req', status: 'NO_SHOW' }) };
    }
    if (opts.method === 'POST' && u.includes('/issues')) {
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    }
    if (u.includes('/notifications')) {
      return { ok: true, status: 200, json: async () => (notifications || { messages: [] }) };
    }
    return { ok: true, status: 200, json: async () => payload };
  });
  vi.stubGlobal('fetch', fn);
  return { fn, calls };
}

const postCalls = (calls, path) => calls.filter((c) => c.opts?.method === 'POST' && c.url.includes(path));

function mockGeolocation() {
  const watchers = [];
  const geo = {
    watchPosition: vi.fn((ok, err) => { watchers.push({ ok, err }); return watchers.length; }),
    clearWatch: vi.fn(),
  };
  Object.defineProperty(global.navigator, 'geolocation', { value: geo, configurable: true });
  return {
    geo,
    fire: (latitude, longitude) => watchers.forEach((w) => w.ok({ coords: { latitude, longitude } })),
    fail: () => watchers.forEach((w) => w.err(new Error('denied'))),
  };
}

beforeEach(() => {
  window.localStorage.clear();
  window.localStorage.setItem('ride-driver-lang', 'es'); // deterministic ES-primary strings
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('Screen 12 — home', () => {
  it('renders the driver header, next stop and pickup-spot fallback (no Maps key)', async () => {
    mockFetch(BASE);
    render(<DriverClient token={TOKEN} />);

    expect(await screen.findByText('Modo Conductor · Ford Transit 350')).toBeInTheDocument();
    expect(screen.getByText(/LAX Airport · Carlos M\./)).toBeInTheDocument();
    // Next stop = the spot with the most open pickups (2 at Spot B beat 1 at A).
    expect(screen.getByTestId('next-stop')).toHaveTextContent('Pickup Spot B');
    expect(screen.getByText('🧍 3 pickups esperando')).toBeInTheDocument();
    expect(screen.getByText('📍 1 compartiendo ubicación')).toBeInTheDocument();
    // No key → the stylized pickup-spot list (ONLY the isPickupSpot zones).
    const fallback = screen.getByTestId('spots-fallback');
    expect(within(fallback).getByText('Pickup Spot B')).toBeInTheDocument();
    expect(within(fallback).getByText('Isla B, letrero B-4')).toBeInTheDocument();
    expect(within(fallback).queryByText('Airport loop')).not.toBeInTheDocument();
  });
});

describe('Screen 13 — roster', () => {
  it('renders every rider with meta and honest status chips', async () => {
    mockFetch(BASE);
    render(<DriverClient token={TOKEN} />);

    fireEvent.click(await screen.findByTestId('tab-roster'));
    const rows = screen.getAllByTestId('rider-row');
    expect(rows).toHaveLength(3);

    const juan = rows[0];
    expect(within(juan).getByText('Juan Pérez')).toBeInTheDocument();
    expect(within(juan).getByText('2 pax · 3 maletas · Pickup Spot B')).toBeInTheDocument();
    expect(within(juan).getByText('📍 compartiendo · 45s')).toBeInTheDocument();
    expect(within(juan).getByText('⭐ asignado a ti')).toBeInTheDocument();

    const osei = rows[1];
    expect(within(osei).getByText('esperando · 14 min')).toBeInTheDocument();
    expect(within(osei).queryByText('⭐ asignado a ti')).not.toBeInTheDocument();

    // Foreign-van assignment reads differently from "yours" and "unassigned".
    const rivera = rows[2];
    expect(within(rivera).getByText('esperando · 3 min')).toBeInTheDocument();
    expect(within(rivera).getByText('asignado: Mercedes Sprinter 2500')).toBeInTheDocument();
  });

  it('Recogido ✓ POSTs picked-up and marks the row', async () => {
    const { calls } = mockFetch(BASE);
    render(<DriverClient token={TOKEN} />);

    fireEvent.click(await screen.findByTestId('tab-roster'));
    const juan = screen.getAllByTestId('rider-row')[0];
    fireEvent.click(within(juan).getByTestId('row-picked'));

    await waitFor(() => expect(postCalls(calls, '/picked-up')).toHaveLength(1));
    expect(postCalls(calls, '/picked-up')[0].url).toContain('/requests/req-1/picked-up');
    // The row flips to the picked chip and loses its action buttons.
    await within(juan).findByText('✓ recogido');
    expect(within(juan).queryByTestId('row-picked')).not.toBeInTheDocument();
  });

  it('rider detail shows note + big actions; picked-up POSTs from there too', async () => {
    const { calls } = mockFetch(BASE);
    render(<DriverClient token={TOKEN} />);

    fireEvent.click(await screen.findByTestId('tab-roster'));
    fireEvent.click(screen.getAllByTestId('rider-open')[2]); // M. Rivera
    expect(screen.getByText('Silla de bebé')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('detail-picked'));
    await waitFor(() => expect(postCalls(calls, '/picked-up')).toHaveLength(1));
    expect(postCalls(calls, '/picked-up')[0].url).toContain('/requests/req-3/picked-up');
  });
});

describe('Screen 17a — no-show confirm', () => {
  it('never POSTs without the dialog; Confirmar sends { confirmed: true }', async () => {
    const { calls } = mockFetch(BASE);
    render(<DriverClient token={TOKEN} />);

    fireEvent.click(await screen.findByTestId('tab-roster'));
    fireEvent.click(within(screen.getAllByTestId('rider-row')[1]).getByTestId('row-noshow'));

    // The tap opens the dialog and NOTHING leaves the phone.
    const dlg = screen.getByTestId('noshow-dialog');
    expect(within(dlg).getByText('¿Seguro?')).toBeInTheDocument();
    expect(within(dlg).getByText(/Se notificará al cliente y al counter/)).toBeInTheDocument();
    expect(postCalls(calls, '/no-show')).toHaveLength(0);

    // Cancelar closes it — still no POST.
    fireEvent.click(within(dlg).getByTestId('noshow-cancel'));
    expect(screen.queryByTestId('noshow-dialog')).not.toBeInTheDocument();
    expect(postCalls(calls, '/no-show')).toHaveLength(0);

    // Confirmar is the ONLY path to the POST, and it carries confirmed:true.
    fireEvent.click(within(screen.getAllByTestId('rider-row')[1]).getByTestId('row-noshow'));
    fireEvent.click(screen.getByTestId('noshow-confirm'));
    await waitFor(() => expect(postCalls(calls, '/no-show')).toHaveLength(1));
    const call = postCalls(calls, '/no-show')[0];
    expect(call.url).toContain('/requests/req-2/no-show');
    expect(JSON.parse(call.opts.body)).toEqual({ confirmed: true });

    // The row flips to the no-show chip.
    await within(screen.getAllByTestId('rider-row')[1]).findByText('✗ no-show');
  });
});

describe('Screen 15 — issue report', () => {
  it('category grid POSTs the contract enum + optional note, then confirms', async () => {
    const { calls } = mockFetch(BASE);
    render(<DriverClient token={TOKEN} />);

    fireEvent.click(await screen.findByTestId('tab-issue'));
    // The approved ES labels for the contract enum.
    expect(screen.getByText('Mecánico')).toBeInTheDocument();
    expect(screen.getByText('Accidente')).toBeInTheDocument();
    expect(screen.getByText('Tráfico / retraso')).toBeInTheDocument();
    expect(screen.getByText('Cliente no aparece')).toBeInTheDocument();
    expect(screen.getByText('Otro')).toBeInTheDocument();

    // No category picked → the send button is disabled (no empty POSTs).
    expect(screen.getByTestId('issue-send')).toBeDisabled();

    fireEvent.click(screen.getByTestId('cat-TRAFICO'));
    fireEvent.change(screen.getByTestId('issue-note'), { target: { value: 'Policía desvió el tráfico, ~15 min extra' } });
    fireEvent.click(screen.getByTestId('issue-send'));

    await waitFor(() => expect(postCalls(calls, '/issues')).toHaveLength(1));
    expect(JSON.parse(postCalls(calls, '/issues')[0].opts.body)).toEqual({
      category: 'TRAFICO',
      note: 'Policía desvió el tráfico, ~15 min extra',
    });
    // Confirmation state (15b).
    expect(await screen.findByTestId('issue-sent')).toHaveTextContent('Enviado al mostrador');
  });

  it('omits the note key when the driver leaves it empty', async () => {
    const { calls } = mockFetch(BASE);
    render(<DriverClient token={TOKEN} />);

    fireEvent.click(await screen.findByTestId('tab-issue'));
    fireEvent.click(screen.getByTestId('cat-MECANICO'));
    fireEvent.click(screen.getByTestId('issue-send'));

    await waitFor(() => expect(postCalls(calls, '/issues')).toHaveLength(1));
    expect(JSON.parse(postCalls(calls, '/issues')[0].opts.body)).toEqual({ category: 'MECANICO' });
  });
});

describe('dead token', () => {
  it('a bare 404 renders the friendly expired page', async () => {
    mockFetch(null, { status: 404 });
    render(<DriverClient token={TOKEN} />);

    expect(await screen.findByText('Este enlace expiró')).toBeInTheDocument();
    expect(screen.getByText(/Pide uno nuevo al counter/)).toBeInTheDocument();
    // The shift UI never renders.
    expect(screen.queryByTestId('tab-roster')).not.toBeInTheDocument();
  });
});

describe('Screen 12 — own-GPS transmit', () => {
  it('the toggle arms watchPosition and POSTs { lat, lng } to /position', async () => {
    const { calls } = mockFetch(BASE);
    const g = mockGeolocation();
    render(<DriverClient token={TOKEN} />);

    fireEvent.click(await screen.findByTestId('gps-start'));
    expect(g.geo.watchPosition).toHaveBeenCalledTimes(1);

    await act(async () => { g.fire(33.9425, -118.4081); });
    // The first fix posts immediately — lat/lng only, nothing else.
    await waitFor(() => expect(postCalls(calls, '/position')).toHaveLength(1));
    expect(JSON.parse(postCalls(calls, '/position')[0].opts.body)).toEqual({ lat: 33.9425, lng: -118.4081 });
    expect(screen.getByTestId('gps-on')).toBeInTheDocument();
  });

  it('accepted:false DEVICE_MAPPED flips honestly to "GPS del vehículo activo" and stops the watch', async () => {
    mockFetch(BASE, { positionResponse: { ok: true, accepted: false, reason: 'DEVICE_MAPPED' } });
    const g = mockGeolocation();
    render(<DriverClient token={TOKEN} />);

    fireEvent.click(await screen.findByTestId('gps-start'));
    await act(async () => { g.fire(33.9425, -118.4081); });

    expect(await screen.findByTestId('gps-device')).toHaveTextContent('GPS del vehículo activo');
    expect(g.geo.clearWatch).toHaveBeenCalled();
    expect(screen.queryByTestId('gps-on')).not.toBeInTheDocument();
    expect(screen.queryByTestId('gps-start')).not.toBeInTheDocument();
  });
});

describe('Screen 14 — notifications', () => {
  const NOTIFS = {
    messages: [
      { id: 'm1', message: 'Recoge también en Lot C a las 3:15pm.', at: '2026-08-25T14:41:00.000Z' },
      { id: 'm2', message: 'El Sr. Osei lleva equipaje extra.', at: '2026-08-25T14:35:00.000Z' },
    ],
  };

  it('badges the bell with the unread count and clears it when the inbox opens', async () => {
    mockFetch(BASE, { notifications: NOTIFS });
    render(<DriverClient token={TOKEN} />);

    // Both messages are unread (no local read-marks yet).
    expect(await screen.findByTestId('bell-badge')).toHaveTextContent('2');

    fireEvent.click(screen.getByTestId('bell'));
    const rows = screen.getAllByTestId('inbox-row');
    expect(rows).toHaveLength(2);
    expect(within(rows[0]).getByText(/Recoge también en Lot C/)).toBeInTheDocument();
    expect(within(rows[1]).getByText(/equipaje extra/)).toBeInTheDocument();

    // Opening the inbox marks everything read — the badge goes away.
    await waitFor(() => expect(screen.queryByTestId('bell-badge')).not.toBeInTheDocument());
  });

  it('read-marks persist locally so a reload does not re-badge old messages', async () => {
    window.localStorage.setItem(`ride-driver-read:${TOKEN}`, JSON.stringify(['m1', 'm2']));
    mockFetch(BASE, { notifications: NOTIFS });
    render(<DriverClient token={TOKEN} />);

    await screen.findByText('Modo Conductor · Ford Transit 350');
    await waitFor(() => expect(fetch).toHaveBeenCalled());
    expect(screen.queryByTestId('bell-badge')).not.toBeInTheDocument();
  });
});
