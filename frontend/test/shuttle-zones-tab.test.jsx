import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react';

/**
 * Zones & Routes tab (Phase 2, approved mockup Screen 4) — what these tests
 * pin down:
 *  - Zone list renders per-kind: Zone/Route chip, pickup badge, and the FOUR
 *    honest providerSyncStatus chips (SYNCED/PENDING/ERROR/UNSUPPORTED, the
 *    ERROR one carrying the redacted provider message as its title).
 *  - Notify toggles PATCH inline (PUT /api/shuttle-zones/:id with just the
 *    flipped flag) and the row re-renders from the server's answer.
 *  - Routes expose ONLY the off-route toggle + the "coming soon" honesty
 *    badge — no enter/exit toggles, no promised detection.
 *  - Delete asks for confirmation, then DELETEs.
 *  - Without a Maps key the editor says drawing is unavailable and a NEW zone
 *    cannot be saved (create requires geometry).
 *  - Recipients panel lists the location's recipients and PUTs the whole
 *    cleaned list on add.
 */

const { apiMock } = vi.hoisted(() => ({ apiMock: vi.fn() }));

vi.mock('../src/lib/client', () => ({ api: apiMock }));
vi.mock('../src/lib/google-maps-loader', () => ({
  MAPS_KEY: '', // no key in tests — the tab must fully work list-side anyway
  loadGoogleMaps: vi.fn(async () => null),
}));

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

import { ZonesRoutesTab } from '../src/app/shuttles/ZonesRoutesTab';

const ZONES = [
  {
    id: 'z1', locationId: 'loc1', name: 'LAX Pickup Lot B', kind: 'ZONE',
    isPickupSpot: true, walkingDirections: 'Cross to island B.',
    geometry: { type: 'rectangle', points: [{ lat: 1, lng: 1 }, { lat: 1, lng: 2 }, { lat: 0, lng: 2 }, { lat: 0, lng: 1 }] },
    toleranceM: null, notifyOnEnter: true, notifyOnExit: false, notifyOnOffRoute: false,
    active: true, providerSyncStatus: 'SYNCED', providerSyncError: null,
  },
  {
    id: 'z2', locationId: 'loc1', name: 'Local — Base', kind: 'ZONE',
    isPickupSpot: false, walkingDirections: null,
    geometry: { type: 'polygon', points: [{ lat: 1, lng: 1 }, { lat: 2, lng: 2 }, { lat: 3, lng: 1 }] },
    toleranceM: null, notifyOnEnter: true, notifyOnExit: true, notifyOnOffRoute: false,
    active: true, providerSyncStatus: 'PENDING', providerSyncError: null,
  },
  {
    id: 'z3', locationId: 'loc1', name: 'Terminal loop', kind: 'ZONE',
    isPickupSpot: false, walkingDirections: null,
    geometry: { type: 'polygon', points: [{ lat: 1, lng: 1 }, { lat: 2, lng: 2 }, { lat: 3, lng: 1 }] },
    toleranceM: null, notifyOnEnter: false, notifyOnExit: false, notifyOnOffRoute: false,
    active: true, providerSyncStatus: 'ERROR', providerSyncError: 'OneStepGPS rejected the zone (422)',
  },
  {
    id: 'r1', locationId: 'loc1', name: 'Base ⇄ LAX corridor', kind: 'ROUTE',
    isPickupSpot: false, walkingDirections: null,
    geometry: { type: 'polyline', points: [{ lat: 1, lng: 1 }, { lat: 2, lng: 2 }] },
    toleranceM: 300, notifyOnEnter: false, notifyOnExit: false, notifyOnOffRoute: true,
    active: true, providerSyncStatus: 'UNSUPPORTED', providerSyncError: null,
  },
];

const RECIPIENTS = [
  { name: 'Hector P.', email: 'hector@example.com', phone: '+17871234567', channels: ['EMAIL', 'SMS'] },
];

/** Route the api mock; `routes` is [ [method, substring], response|fn ]. */
function routeApi(routes) {
  apiMock.mockImplementation(async (path, opts = {}) => {
    const method = String(opts.method || 'GET').toUpperCase();
    for (const [match, response] of routes) {
      const [m, sub] = Array.isArray(match) ? match : ['GET', match];
      if (method === m && path.includes(sub)) {
        return typeof response === 'function' ? response(path, opts) : response;
      }
    }
    throw new Error(`unmocked api call: ${method} ${path}`);
  });
}

function routeDefaults(extraRoutes = []) {
  routeApi([
    ...extraRoutes,
    ['/api/locations', [{ id: 'loc1', name: 'LAX Airport', latitude: 33.94, longitude: -118.4 }]],
    ['/api/shuttle-zones/recipients', { locationId: 'loc1', recipients: RECIPIENTS }],
    ['/api/shuttle-zones?locationId=loc1', { zones: ZONES }],
  ]);
}

beforeEach(() => { apiMock.mockReset(); });
afterEach(() => { vi.restoreAllMocks(); });

async function findZoneRow(name) {
  const label = await screen.findByText(name);
  return label.closest('[data-testid="zone-row"]');
}

describe('ZonesRoutesTab — list rendering', () => {
  it('renders every zone with kind chip, pickup badge and honest sync chips', async () => {
    routeDefaults();
    render(<ZonesRoutesTab token="tok" />);

    const row1 = await findZoneRow('LAX Pickup Lot B');
    expect(within(row1).getByText('shuttleZones.kindZone')).toBeInTheDocument();
    expect(within(row1).getByText('shuttleZones.pickupSpot')).toBeInTheDocument();
    const chip1 = within(row1).getByTestId('sync-chip');
    expect(chip1).toHaveTextContent('shuttleZones.syncSynced');
    expect(chip1.className).toContain('chip--ok');

    const row2 = await findZoneRow('Local — Base');
    const chip2 = within(row2).getByTestId('sync-chip');
    expect(chip2).toHaveTextContent('shuttleZones.syncPending');
    expect(chip2.className).toContain('chip--warn');

    const row3 = await findZoneRow('Terminal loop');
    const chip3 = within(row3).getByTestId('sync-chip');
    expect(chip3).toHaveTextContent('shuttleZones.syncError');
    expect(chip3.className).toContain('chip--danger');
    // The redacted provider message surfaces as the tooltip — staff SEE why.
    expect(chip3).toHaveAttribute('title', 'OneStepGPS rejected the zone (422)');
    // ERROR rows offer the refresh affordance (the worker does the retrying).
    expect(within(row3).getByRole('button', { name: 'shuttleZones.syncRetry' })).toBeInTheDocument();

    const rowR = await findZoneRow('Base ⇄ LAX corridor');
    expect(within(rowR).getByText('shuttleZones.kindRoute')).toBeInTheDocument();
    const chipR = within(rowR).getByTestId('sync-chip');
    expect(chipR).toHaveTextContent('shuttleZones.syncUnsupported');
    expect(chipR.className).toContain('chip--neutral');
  });

  it('routes show only the off-route toggle plus the coming-soon badge — never enter/exit', async () => {
    routeDefaults();
    render(<ZonesRoutesTab token="tok" />);

    const rowR = await findZoneRow('Base ⇄ LAX corridor');
    expect(within(rowR).getByRole('checkbox', { name: 'shuttleZones.notifyOffRoute' })).toBeChecked();
    expect(within(rowR).queryByRole('checkbox', { name: 'shuttleZones.notifyEnter' })).not.toBeInTheDocument();
    expect(within(rowR).queryByRole('checkbox', { name: 'shuttleZones.notifyExit' })).not.toBeInTheDocument();
    // Honesty rule: the route row itself says detection is not live yet.
    expect(within(rowR).getByText('shuttleZones.routeComingSoon')).toBeInTheDocument();
    expect(within(rowR).getByText(/shuttleZones\.toleranceChip\[.*m=300\]/)).toBeInTheDocument();
  });
});

describe('ZonesRoutesTab — inline notify toggles', () => {
  it('PATCHes just the flipped flag and re-renders from the server answer', async () => {
    const puts = [];
    routeDefaults([
      [['PUT', '/api/shuttle-zones/z1'], (path, opts) => {
        puts.push(opts.body);
        return { ok: true, zone: { ...ZONES[0], notifyOnEnter: false } };
      }],
    ]);
    render(<ZonesRoutesTab token="tok" />);

    const row1 = await findZoneRow('LAX Pickup Lot B');
    const toggle = within(row1).getByRole('checkbox', { name: 'shuttleZones.notifyEnter' });
    expect(toggle).toBeChecked();
    fireEvent.click(toggle);

    await waitFor(() => expect(puts).toHaveLength(1));
    expect(puts[0]).toEqual({ notifyOnEnter: false });
    await waitFor(() => {
      expect(within(row1).getByRole('checkbox', { name: 'shuttleZones.notifyEnter' })).not.toBeChecked();
    });
  });

  it('off-route toggle on a route PATCHes notifyOnOffRoute', async () => {
    const puts = [];
    routeDefaults([
      [['PUT', '/api/shuttle-zones/r1'], (path, opts) => {
        puts.push(opts.body);
        return { ok: true, zone: { ...ZONES[3], notifyOnOffRoute: false } };
      }],
    ]);
    render(<ZonesRoutesTab token="tok" />);

    const rowR = await findZoneRow('Base ⇄ LAX corridor');
    fireEvent.click(within(rowR).getByRole('checkbox', { name: 'shuttleZones.notifyOffRoute' }));
    await waitFor(() => expect(puts).toHaveLength(1));
    expect(puts[0]).toEqual({ notifyOnOffRoute: false });
  });
});

describe('ZonesRoutesTab — delete', () => {
  it('asks for confirmation, DELETEs, and drops the row', async () => {
    const deleted = [];
    routeDefaults([
      [['DELETE', '/api/shuttle-zones/z2'], (path) => { deleted.push(path); return { ok: true }; }],
    ]);
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(<ZonesRoutesTab token="tok" />);

    const row2 = await findZoneRow('Local — Base');
    fireEvent.click(within(row2).getByRole('button', { name: 'shuttleZones.delete' }));

    await waitFor(() => expect(deleted).toHaveLength(1));
    expect(deleted[0]).toContain('/api/shuttle-zones/z2');
    expect(window.confirm).toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByText('Local — Base')).not.toBeInTheDocument());
  });

  it('does nothing when the confirm is declined', async () => {
    routeDefaults();
    vi.spyOn(window, 'confirm').mockReturnValue(false);
    render(<ZonesRoutesTab token="tok" />);

    const row2 = await findZoneRow('Local — Base');
    fireEvent.click(within(row2).getByRole('button', { name: 'shuttleZones.delete' }));
    expect(apiMock.mock.calls.some(([, o]) => String(o?.method).toUpperCase() === 'DELETE')).toBe(false);
    expect(screen.getByText('Local — Base')).toBeInTheDocument();
  });
});

describe('ZonesRoutesTab — editor without a Maps key', () => {
  it('new zone: honest no-drawing note and Save disabled (create needs geometry)', async () => {
    routeDefaults();
    render(<ZonesRoutesTab token="tok" />);
    await findZoneRow('LAX Pickup Lot B');

    fireEvent.click(screen.getByRole('button', { name: 'shuttleZones.newZone' }));
    const editor = await screen.findByTestId('zone-editor');
    expect(within(editor).getByText('shuttleZones.noMapsKeyDraw')).toBeInTheDocument();
    expect(within(editor).getByRole('button', { name: 'shuttleZones.save' })).toBeDisabled();
  });

  it('editing an existing zone still saves non-geometry fields (no geometry re-sent)', async () => {
    const puts = [];
    routeDefaults([
      [['PUT', '/api/shuttle-zones/z1'], (path, opts) => {
        puts.push(opts.body);
        return { ok: true, zone: { ...ZONES[0], name: 'LAX Lot B (renamed)' } };
      }],
    ]);
    render(<ZonesRoutesTab token="tok" />);

    const row1 = await findZoneRow('LAX Pickup Lot B');
    fireEvent.click(within(row1).getByRole('button', { name: 'shuttleZones.edit' }));
    const editor = await screen.findByTestId('zone-editor');

    const nameInput = within(editor).getByRole('textbox', { name: 'shuttleZones.nameLabel' });
    fireEvent.change(nameInput, { target: { value: 'LAX Lot B (renamed)' } });
    fireEvent.click(within(editor).getByRole('button', { name: 'shuttleZones.save' }));

    await waitFor(() => expect(puts).toHaveLength(1));
    expect(puts[0]).toEqual({
      name: 'LAX Lot B (renamed)',
      kind: 'ZONE',
      isPickupSpot: true,
      walkingDirections: 'Cross to island B.',
      notifyOnEnter: true,
      notifyOnExit: false,
    });
    // No geometry key — an untouched shape must not trigger a provider re-push.
    expect('geometry' in puts[0]).toBe(false);
  });

  it('route editor shows tolerance slider and the coming-soon honesty badge', async () => {
    routeDefaults();
    render(<ZonesRoutesTab token="tok" />);
    const rowR = await findZoneRow('Base ⇄ LAX corridor');
    fireEvent.click(within(rowR).getByRole('button', { name: 'shuttleZones.edit' }));

    const editor = await screen.findByTestId('zone-editor');
    expect(within(editor).getByText(/shuttleZones\.toleranceLabel\[.*m=300\]/)).toBeInTheDocument();
    expect(within(editor).getByText('shuttleZones.routeComingSoon')).toBeInTheDocument();
    expect(within(editor).getByText('shuttleZones.routeUnsupportedNote')).toBeInTheDocument();
    // Route editor never grows zone-only controls.
    expect(within(editor).queryByText('shuttleZones.pickupSpot')).not.toBeInTheDocument();
  });
});

describe('ZonesRoutesTab — recipients panel', () => {
  it('lists recipients with their channels', async () => {
    routeDefaults();
    render(<ZonesRoutesTab token="tok" />);
    const panel = await screen.findByTestId('recipients-panel');
    const row = await within(panel).findByTestId('recipient-row');
    expect(within(row).getByText('Hector P.')).toBeInTheDocument();
    expect(within(row).getByText('shuttleZones.channelEmail')).toBeInTheDocument();
    expect(within(row).getByText('shuttleZones.channelSms')).toBeInTheDocument();
  });

  it('add PUTs the whole list (old + new) to /recipients', async () => {
    const puts = [];
    routeDefaults([
      [['PUT', '/api/shuttle-zones/recipients'], (path, opts) => {
        puts.push(opts.body);
        return { locationId: 'loc1', recipients: opts.body.recipients };
      }],
    ]);
    render(<ZonesRoutesTab token="tok" />);
    const panel = await screen.findByTestId('recipients-panel');
    await within(panel).findByTestId('recipient-row');

    fireEvent.change(within(panel).getByPlaceholderText('shuttleZones.recipientName'), { target: { value: 'M. Colón' } });
    fireEvent.change(within(panel).getByPlaceholderText('shuttleZones.recipientEmail'), { target: { value: 'mcolon@example.com' } });
    fireEvent.click(within(panel).getByRole('button', { name: 'shuttleZones.addRecipient' }));

    await waitFor(() => expect(puts).toHaveLength(1));
    expect(puts[0]).toEqual({
      locationId: 'loc1',
      recipients: [
        RECIPIENTS[0],
        { name: 'M. Colón', email: 'mcolon@example.com', phone: null, channels: ['EMAIL'] },
      ],
    });
    await waitFor(() => expect(within(panel).getAllByTestId('recipient-row')).toHaveLength(2));
  });

  it('refuses an add with no usable channel (no contact for the channel)', async () => {
    routeDefaults();
    render(<ZonesRoutesTab token="tok" />);
    const panel = await screen.findByTestId('recipients-panel');
    await within(panel).findByTestId('recipient-row');

    // EMAIL checked by default but no email typed → no channel is reachable.
    fireEvent.change(within(panel).getByPlaceholderText('shuttleZones.recipientName'), { target: { value: 'Nobody' } });
    fireEvent.click(within(panel).getByRole('button', { name: 'shuttleZones.addRecipient' }));

    expect(await within(panel).findByText('shuttleZones.recipientNeedsChannel')).toBeInTheDocument();
    expect(apiMock.mock.calls.some(([p, o]) => p.includes('/recipients') && String(o?.method).toUpperCase() === 'PUT')).toBe(false);
  });
});
