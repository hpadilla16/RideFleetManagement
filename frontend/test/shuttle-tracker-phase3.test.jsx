import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act, within } from '@testing-library/react';

/**
 * Shuttle v2 Phase 3 — customer tracker UI (approved mockup Screens 7, 8a/8b,
 * 9, 16). What these tests pin down:
 *  - Intake (Screen 7) renders ONLY when the payload says the sede opted in
 *    ({ intake: { enabled: true } }); otherwise the pre-Phase-3 one-tap
 *    request posts { partySize } and NOTHING else.
 *  - The flow posts partySize/bags/smsOptIn, steppers respect the payload's
 *    caps, and pickupSpotZoneId goes out only when the payload identifies a
 *    spot (contract-gap-tolerant read of state.pickupSpot).
 *  - Location sharing (Screen 9): consent → watchPosition → POST /location;
 *    Detener stops the watch; the distance line prefers the SERVER's
 *    locationSharing.distanceMeters, never an echo of coordinates.
 *  - Mode-aware rendering (8a/8b): assigned chip vs per-shuttle freshness
 *    rows. No ETA anywhere.
 *  - Arrival banner (Screen 16) on the payload's arrivedAtSpot flag.
 *
 * All payloads are OFFLINE/no-key so the Google map never enters jsdom — the
 * card layout carries every Phase-3 surface by design.
 */

import { ShuttleTrackerClient } from '../src/app/shuttle/[token]/TrackerClient';

// Deliberately NOT key-shaped: a `prefix_hex` fixture trips gitleaks' generic-api-key rule (CI hard gate).
const TOKEN = 'TEST-TRACKER-TOKEN';

const BASE = {
  mode: 'ON_DEMAND',
  headwayMinutes: 10,
  locationName: 'RIDE LAX Airport',
  pickupInstructions: 'Wait at island B',
  walkingDirections: 'Cross both crosswalks to sign B-4',
  brandName: 'International Rental Corp',
  counterPhone: '(310) 555-0100',
  requestStatus: null,
  arrivedAtSpot: false,
  arrivedSpotName: null,
  assigned: false,
  locationSharing: { active: false, distanceMeters: null },
  status: 'OFFLINE',
};

function mockFetch(payload, { requestResponse } = {}) {
  const calls = [];
  const fn = vi.fn(async (url, opts = {}) => {
    calls.push({ url: String(url), opts });
    if (opts.method === 'POST' && String(url).includes('/request')) {
      return {
        ok: true,
        status: 200,
        json: async () => (requestResponse || { ok: true, deduplicated: false, status: 'READY' }),
      };
    }
    if (opts.method === 'POST' && String(url).includes('/location')) {
      return { ok: true, status: 200, json: async () => ({ ok: true, active: true }) };
    }
    return { ok: true, status: 200, json: async () => payload };
  });
  vi.stubGlobal('fetch', fn);
  return { fn, calls };
}

const postCalls = (calls, path) => calls.filter((c) => c.opts?.method === 'POST' && c.url.includes(path));
const lastBody = (calls, path) => JSON.parse(postCalls(calls, path).at(-1).opts.body);

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
  window.localStorage.setItem('ride-shuttle-lang', 'en'); // deterministic strings
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('Screen 7 — intake flow', () => {
  it('intake ABSENT from the payload keeps the one-tap request byte-identical', async () => {
    const { calls } = mockFetch({ ...BASE });
    render(<ShuttleTrackerClient token={TOKEN} />);

    const btn = await screen.findByRole('button', { name: 'Request the shuttle' });
    // The legacy party select is still there; no intake flow anywhere.
    expect(screen.getByLabelText('People')).toBeInTheDocument();
    expect(screen.queryByTestId('intake-start')).not.toBeInTheDocument();
    expect(screen.queryByTestId('intake-flow')).not.toBeInTheDocument();

    fireEvent.click(btn);
    await waitFor(() => expect(postCalls(calls, '/request')).toHaveLength(1));
    // The pre-Phase-3 body: partySize and NOTHING else.
    expect(lastBody(calls, '/request')).toEqual({ partySize: 1 });
  });

  it('intake enabled: steppers + SMS opt-in post partySize/bags/smsOptIn', async () => {
    const { calls } = mockFetch({ ...BASE, intake: { enabled: true, partySizeCap: 8, bagsCap: 4 } });
    render(<ShuttleTrackerClient token={TOKEN} />);

    fireEvent.click(await screen.findByTestId('intake-start'));
    expect(screen.getByTestId('intake-flow')).toBeInTheDocument();
    // No customerName in the payload (contract gap) → the confirm step is
    // skipped and the flow starts at the steppers.
    expect(screen.getByText('How many people?')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('party-plus'));
    fireEvent.click(screen.getByTestId('party-plus'));
    expect(screen.getByTestId('party-value')).toHaveTextContent('3');
    fireEvent.click(screen.getByTestId('bags-plus'));
    fireEvent.click(screen.getByTestId('bags-plus'));
    expect(screen.getByTestId('bags-value')).toHaveTextContent('2');
    fireEvent.click(screen.getByTestId('sms-optin'));
    expect(screen.getByTestId('sms-optin')).toBeChecked();

    fireEvent.click(screen.getByTestId('intake-continue'));
    // Spot step: generic title (no pickupSpot in the payload — gap-tolerant)
    // and the location-level walking directions.
    expect(screen.getByTestId('intake-spot-title')).toHaveTextContent('Your pickup spot');
    // (the same sede-written text also sits in the card below the flow —
    // scope to the flow)
    expect(within(screen.getByTestId('intake-flow')).getByText('Cross both crosswalks to sign B-4')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('intake-submit'));
    await waitFor(() => expect(postCalls(calls, '/request')).toHaveLength(1));
    expect(lastBody(calls, '/request')).toEqual({ partySize: 3, bags: 2, smsOptIn: true });

    // Success → the flow closes and the status line takes over.
    await screen.findByText('We got your request — the counter has been alerted');
    expect(screen.queryByTestId('intake-flow')).not.toBeInTheDocument();
  });

  it('steppers respect the payload caps and never exceed them', async () => {
    mockFetch({ ...BASE, intake: { enabled: true, partySizeCap: 2, bagsCap: 1 } });
    render(<ShuttleTrackerClient token={TOKEN} />);

    fireEvent.click(await screen.findByTestId('intake-start'));
    for (let i = 0; i < 5; i += 1) fireEvent.click(screen.getByTestId('party-plus'));
    expect(screen.getByTestId('party-value')).toHaveTextContent('2');
    expect(screen.getByTestId('party-plus')).toBeDisabled();

    for (let i = 0; i < 5; i += 1) fireEvent.click(screen.getByTestId('bags-plus'));
    expect(screen.getByTestId('bags-value')).toHaveTextContent('1');
    expect(screen.getByTestId('bags-plus')).toBeDisabled();
    // And the party stepper never goes below 1.
    fireEvent.click(screen.getByTestId('party-minus'));
    fireEvent.click(screen.getByTestId('party-minus'));
    expect(screen.getByTestId('party-value')).toHaveTextContent('1');
    expect(screen.getByTestId('party-minus')).toBeDisabled();
  });

  it('sends pickupSpotZoneId only when the payload identifies the spot', async () => {
    const { calls } = mockFetch({
      ...BASE,
      intake: { enabled: true, partySizeCap: 8, bagsCap: 4 },
      pickupSpot: { id: 'zone123', name: 'Pickup Spot B', walkingDirections: 'Under sign B-4' },
    });
    render(<ShuttleTrackerClient token={TOKEN} />);

    fireEvent.click(await screen.findByTestId('intake-start'));
    fireEvent.click(screen.getByTestId('intake-continue'));
    expect(screen.getByTestId('intake-spot-title')).toHaveTextContent('Go to Pickup Spot B');
    expect(screen.getByText('Under sign B-4')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('intake-submit'));
    await waitFor(() => expect(postCalls(calls, '/request')).toHaveLength(1));
    expect(lastBody(calls, '/request')).toEqual({
      partySize: 1, bags: 0, smsOptIn: false, pickupSpotZoneId: 'zone123',
    });
  });
});

describe('Screen 9 — location sharing', () => {
  it('consent → watchPosition → POST /location; Detener stops the watch', async () => {
    const { calls } = mockFetch({
      ...BASE,
      requestStatus: 'READY',
      locationSharing: { active: true, distanceMeters: 400 },
    });
    const g = mockGeolocation();
    render(<ShuttleTrackerClient token={TOKEN} />);

    // The consent card exists only while a request is OPEN.
    await screen.findByTestId('consent-card');
    fireEvent.click(screen.getByRole('button', { name: 'Share location' }));
    expect(g.geo.watchPosition).toHaveBeenCalledTimes(1);

    await act(async () => { g.fire(33.9425, -118.4081); });
    // The first fix posts immediately — lat/lng only, nothing else.
    await waitFor(() => expect(postCalls(calls, '/location')).toHaveLength(1));
    expect(lastBody(calls, '/location')).toEqual({ lat: 33.9425, lng: -118.4081 });

    // Active pill + the SERVER's distance (never a local echo).
    expect(screen.getByTestId('sharing-pill')).toBeInTheDocument();
    expect(screen.getByTestId('sharing-distance')).toHaveTextContent('Your shuttle is ~400 m away');

    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
    expect(g.geo.clearWatch).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('sharing-pill')).not.toBeInTheDocument();
    // Stopping never re-nags: the card is replaced by a plain share-again button.
    expect(screen.queryByTestId('consent-card')).not.toBeInTheDocument();
    expect(postCalls(calls, '/location')).toHaveLength(1);
  });

  it('permission denied falls back to directions with no consent nagging', async () => {
    mockFetch({ ...BASE, requestStatus: 'READY' });
    const g = mockGeolocation();
    render(<ShuttleTrackerClient token={TOKEN} />);

    fireEvent.click((await screen.findByTestId('consent-card')).querySelector('button'));
    await act(async () => { g.fail(); });
    expect(screen.getByText(/We could not access your location/)).toBeInTheDocument();
    expect(screen.getByText(/Everything still works without sharing/)).toBeInTheDocument();
    expect(screen.queryByTestId('consent-card')).not.toBeInTheDocument();
  });

  it('no open request → no consent card (the endpoint would 404)', async () => {
    mockFetch({ ...BASE });
    render(<ShuttleTrackerClient token={TOKEN} />);
    await screen.findByText('RIDE LAX Airport');
    expect(screen.queryByTestId('consent-card')).not.toBeInTheDocument();
  });
});

describe('Screens 8a/8b — mode-aware rendering', () => {
  it('assigned: true names the customer\'s shuttle', async () => {
    mockFetch({
      ...BASE,
      requestStatus: 'VIEWED',
      assigned: true,
      vehicle: { name: 'Ford Transit 350', color: 'white', plate: 'IKT-482' },
    });
    render(<ShuttleTrackerClient token={TOKEN} />);
    const chip = await screen.findByTestId('assigned-chip');
    expect(chip).toHaveTextContent('Your shuttle: Ford Transit 350 · assigned to you');
  });

  it('NON_STOP renders every shuttle with per-shuttle freshness and no request button', async () => {
    mockFetch({
      ...BASE,
      mode: 'NON_STOP',
      pickupSpot: { name: 'Pickup Spot B' },
      shuttles: [
        { name: 'Ford Transit 350', color: 'white', plate: 'IKT-482', status: 'LIVE', position: { latitude: 33.94, longitude: -118.4, ageSeconds: 25 } },
        { name: 'Mercedes Sprinter 2500', color: null, plate: null, status: 'AGING', position: { latitude: 33.95, longitude: -118.41, ageSeconds: 130 } },
        { name: 'Van 3', color: null, plate: null, status: 'OFFLINE' },
      ],
    });
    render(<ShuttleTrackerClient token={TOKEN} />);

    const rows = await screen.findAllByTestId('loop-shuttle');
    expect(rows).toHaveLength(3);
    expect(screen.getByText('live · 25s ago')).toBeInTheDocument();
    expect(screen.getByText('last known 2 min ago')).toBeInTheDocument();
    expect(screen.getByText('no signal right now')).toBeInTheDocument();
    // Guidance card from the (gap-tolerant) pickupSpot read.
    expect(screen.getByTestId('go-to-spot')).toHaveTextContent('Head to: Pickup Spot B');
    // A loop has no request button, and freshness is never an ETA.
    expect(screen.queryByRole('button', { name: 'Request the shuttle' })).not.toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/\bETA\b/i);
  });
});

describe('Screen 16 — arrival banner', () => {
  it('renders the banner with the spot name while arrivedAtSpot is true', async () => {
    mockFetch({ ...BASE, requestStatus: 'VIEWED', arrivedAtSpot: true, arrivedSpotName: 'Pickup Lot B' });
    render(<ShuttleTrackerClient token={TOKEN} />);
    const banner = await screen.findByTestId('arrival-banner');
    expect(banner).toHaveTextContent('Your shuttle has arrived!');
    expect(banner).toHaveTextContent('Go to Pickup Lot B');
  });

  it('no banner when the payload does not say arrived', async () => {
    mockFetch({ ...BASE });
    render(<ShuttleTrackerClient token={TOKEN} />);
    await screen.findByText('RIDE LAX Airport');
    expect(screen.queryByTestId('arrival-banner')).not.toBeInTheDocument();
  });
});

describe('Per-language walking directions (2026-08-25)', () => {
  const BILINGUAL = {
    ...BASE,
    walkingDirections: 'Cross both crosswalks to sign B-4',
    walkingDirectionsEs: 'Cruza ambos cruces hasta el letrero B-4',
  };

  it('EN toggle shows the English text; flipping to ES swaps to the Spanish one live', async () => {
    mockFetch(BILINGUAL);
    render(<ShuttleTrackerClient token={TOKEN} />);
    await screen.findByText('Cross both crosswalks to sign B-4');
    expect(screen.queryByText('Cruza ambos cruces hasta el letrero B-4')).not.toBeInTheDocument();

    // The ES/EN toggle already re-renders every string — the directions must
    // ride the same state, no refetch needed.
    fireEvent.click(screen.getByRole('button', { name: 'ES' }));
    expect(screen.getByText('Cruza ambos cruces hasta el letrero B-4')).toBeInTheDocument();
    expect(screen.queryByText('Cross both crosswalks to sign B-4')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'EN' }));
    expect(screen.getByText('Cross both crosswalks to sign B-4')).toBeInTheDocument();
  });

  it('falls back across languages: only-ES shows in EN mode, only-EN shows in ES mode', async () => {
    mockFetch({ ...BASE, walkingDirections: '', walkingDirectionsEs: 'Solo en español' });
    render(<ShuttleTrackerClient token={TOKEN} />);
    // lang is 'en' (beforeEach) — the ES text is better than nothing.
    expect(await screen.findByText('Solo en español')).toBeInTheDocument();
  });

  it('only-EN text still shows after toggling to ES (fallback the other way)', async () => {
    mockFetch({ ...BASE, walkingDirectionsEs: '' });
    render(<ShuttleTrackerClient token={TOKEN} />);
    await screen.findByText('Cross both crosswalks to sign B-4');
    fireEvent.click(screen.getByRole('button', { name: 'ES' }));
    expect(screen.getByText('Cross both crosswalks to sign B-4')).toBeInTheDocument();
  });

  it('old payloads without walkingDirectionsEs render exactly as before', async () => {
    mockFetch({ ...BASE }); // no walkingDirectionsEs key at all
    render(<ShuttleTrackerClient token={TOKEN} />);
    expect(await screen.findByText('Cross both crosswalks to sign B-4')).toBeInTheDocument();
  });

  it('intake spot step prefers the SPOT text per language', async () => {
    mockFetch({
      ...BILINGUAL,
      intake: { enabled: true, partySizeCap: 8, bagsCap: 4 },
      pickupSpot: {
        id: 'zone123', name: 'Pickup Spot B',
        walkingDirections: 'Under sign B-4',
        walkingDirectionsEs: 'Bajo el letrero B-4',
      },
    });
    render(<ShuttleTrackerClient token={TOKEN} />);
    fireEvent.click(await screen.findByTestId('intake-start'));
    fireEvent.click(screen.getByRole('button', { name: 'ES' }));
    fireEvent.click(screen.getByTestId('intake-continue'));
    const flow = screen.getByTestId('intake-flow');
    expect(within(flow).getByText('Bajo el letrero B-4')).toBeInTheDocument();
    expect(within(flow).queryByText('Under sign B-4')).not.toBeInTheDocument();
  });
});
