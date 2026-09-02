import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent, within, act } from '@testing-library/react';

/**
 * OneStepGpsConnectorTab (Settings → Telematics) — the OneStepGPS connector
 * panel from the approved 2026-08 mockups. What these tests pin down:
 *
 *  - No-key state: write-only password input, Test disabled, empty state shown,
 *    and NO device fetch is attempted without a key.
 *  - The key is write-only: saving POSTs it, then the input is cleared and the
 *    key string never appears in the DOM again (server only returns booleans).
 *  - Plate auto-match is a SUGGESTION: pre-selected + auto badge + dirty/unsaved
 *    indication, and nothing is persisted until "Save mappings" is clicked
 *    (approved decision: suggestion + explicit Save).
 *  - Save only posts the dirty rows; already-saved mappings are not re-posted.
 *  - Disconnect calls DELETE /credentials (mappings are kept server-side).
 */

const { apiMock } = vi.hoisted(() => ({ apiMock: vi.fn() }));

vi.mock('../src/lib/client', () => ({ api: apiMock }));

// i18n: return the key, with interpolation values appended so assertions can
// check counts without wiring real locale JSON into the test.
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

import { OneStepGpsConnectorTab } from '../src/app/settings/OneStepGpsConnectorTab';

const identityPath = (p) => p;

function renderTab() {
  return render(
    <OneStepGpsConnectorTab token="tok" scopedSettingsPath={identityPath} onPageMsg={() => {}} />
  );
}

/** Route the api mock by path prefix; `routes` maps substring → response (or fn). */
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

beforeEach(() => {
  apiMock.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('OneStepGpsConnectorTab — no key configured', () => {
  beforeEach(() => {
    routeApi([
      ['/api/admin/integrations/onestepgps/status', { hasApiKey: false }],
      ['/api/vehicles', { vehicles: [] }],
    ]);
  });

  it('shows the write-only password input, disabled Test, and the empty state', async () => {
    renderTab();
    const input = await screen.findByPlaceholderText('onestepgps.apiKeyPlaceholder');
    expect(input).toHaveAttribute('type', 'password');

    const testBtn = screen.getByRole('button', { name: 'onestepgps.testConnection' });
    expect(testBtn).toBeDisabled();

    // Save is disabled until something is typed.
    expect(screen.getByRole('button', { name: 'onestepgps.saveKey' })).toBeDisabled();

    // Screen 4: empty state instead of the mapping table.
    expect(screen.getByText('onestepgps.emptyTitle')).toBeInTheDocument();
    expect(screen.queryByText('onestepgps.mappingTitle')).not.toBeInTheDocument();

    // No device fetch without a key.
    expect(apiMock.mock.calls.some(([p]) => p.includes('/devices'))).toBe(false);
  });

  it('saves the key write-only: POSTs it, clears the input, never echoes it', async () => {
    let hasApiKey = false;
    routeApi([
      ['/api/admin/integrations/onestepgps/status', () => ({ hasApiKey, rotatedAt: null, lastTestedAt: null, lastTestStatus: null, mappedDevices: 0 })],
      ['/api/vehicles', { vehicles: [] }],
      [['POST', '/api/admin/integrations/onestepgps/credentials'], () => { hasApiKey = true; return { ok: true }; }],
      [['GET', '/api/admin/integrations/onestepgps/devices'], { devices: [] }],
      [['GET', '/api/admin/integrations/onestepgps/device-mappings'], { mappings: [] }],
    ]);
    const { container } = renderTab();

    const input = await screen.findByPlaceholderText('onestepgps.apiKeyPlaceholder');
    fireEvent.change(input, { target: { value: 'sekret-api-key-123' } });
    fireEvent.click(screen.getByRole('button', { name: 'onestepgps.saveKey' }));

    await waitFor(() => {
      const call = apiMock.mock.calls.find(([p, o]) => p.includes('/credentials') && o?.method === 'POST');
      expect(call).toBeTruthy();
      expect(JSON.parse(call[1].body)).toEqual({ apiKey: 'sekret-api-key-123' });
    });

    // Input cleared after save; masked state shown; the key never in the DOM.
    await waitFor(() => expect(screen.getByText(/onestepgps\.keyConfigured/)).toBeInTheDocument());
    expect(screen.getByPlaceholderText('onestepgps.apiKeyRotatePlaceholder')).toHaveValue('');
    expect(container.innerHTML).not.toContain('sekret-api-key-123');
  });
});

describe('OneStepGpsConnectorTab — key configured, mapping table', () => {
  const vehicles = [
    { id: 'v1', plate: 'IVU482', make: 'Toyota', model: 'Sienna', year: 2023 },
    { id: 'v2', plate: 'JQD-115', make: 'Toyota', model: 'Corolla', year: 2022 },
    { id: 'v3', plate: 'ABC-123', make: 'Hyundai', model: 'Elantra', year: 2023 },
  ];
  const devices = [
    // Plate matches v1 after normalization (IVU-482 vs IVU482) → auto suggestion.
    { externalDeviceId: 'dev_1', displayName: 'Van 12', licensePlate: 'IVU-482', mappedVehicleId: null },
    // Already saved mapping → not dirty, must NOT be re-posted on Save.
    { externalDeviceId: 'dev_2', displayName: 'Corolla Gray', licensePlate: 'JQD-115', mappedVehicleId: 'v2' },
    // No plate, no mapping → unmapped.
    { externalDeviceId: 'dev_3', displayName: 'Spare unit A', licensePlate: null, mappedVehicleId: null },
  ];

  function routeConfigured(extraRoutes = []) {
    routeApi([
      ...extraRoutes,
      ['/api/admin/integrations/onestepgps/status', { hasApiKey: true, rotatedAt: '2026-08-24T10:00:00Z', lastTestedAt: null, lastTestStatus: null, mappedDevices: 1 }],
      ['/api/vehicles', { vehicles }],
      [['GET', '/api/admin/integrations/onestepgps/devices'], { devices }],
      [['GET', '/api/admin/integrations/onestepgps/device-mappings'], { mappings: [
        { id: 'm2', externalDeviceId: 'dev_2', vehicleId: 'v2', isActive: true },
      ] }],
    ]);
  }

  it('pre-selects the plate auto-match as an unsaved suggestion with the auto badge', async () => {
    routeConfigured();
    renderTab();

    // Mapping card replaces the empty state.
    expect(await screen.findByText('onestepgps.mappingTitle')).toBeInTheDocument();
    expect(screen.queryByText('onestepgps.emptyTitle')).not.toBeInTheDocument();

    // Auto-matched badge on the dev_1 row, pre-selected to v1.
    // The suggestion is seeded by an effect, so it lands one commit AFTER the
    // rows first paint — await it rather than reading the pre-seed DOM.
    const row1 = (await screen.findByText('Van 12')).closest('tr');
    expect(await within(row1).findByText('onestepgps.autoMatched')).toBeInTheDocument();
    expect(within(row1).getByRole('combobox')).toHaveValue('v1');
    expect(row1.className).toContain('osg-dirty');

    // Saved row: mapped, not dirty, no auto badge.
    const row2 = screen.getByText('Corolla Gray').closest('tr');
    expect(within(row2).getByRole('combobox')).toHaveValue('v2');
    expect(row2.className).not.toContain('osg-dirty');
    expect(within(row2).queryByText('onestepgps.autoMatched')).not.toBeInTheDocument();

    // Unmapped row keeps the placeholder.
    const row3 = screen.getByText('Spare unit A').closest('tr');
    expect(within(row3).getByRole('combobox')).toHaveValue('');
    expect(within(row3).getByText('onestepgps.chipUnmapped')).toBeInTheDocument();

    // Exactly one unsaved change (the suggestion), announced in the chip.
    expect(screen.getByText('onestepgps.unsavedChanges[count=1]')).toBeInTheDocument();

    // Suggestion only: nothing was POSTed to /device-mappings on load.
    expect(apiMock.mock.calls.some(([p, o]) => p.includes('/device-mappings') && o?.method === 'POST')).toBe(false);

    // Footer: vehicles without a device (v3 only — v1 is suggested, v2 mapped).
    expect(screen.getByText('onestepgps.vehiclesWithoutDevice[count=1]')).toBeInTheDocument();
  });

  it('persists only dirty rows on explicit Save mappings', async () => {
    const posted = [];
    routeConfigured([
      [['POST', '/api/admin/integrations/onestepgps/device-mappings'], (p, o) => {
        posted.push(JSON.parse(o.body));
        return { ok: true, mapping: { id: 'm-new' } };
      }],
    ]);
    renderTab();

    const saveBtn = await screen.findByRole('button', { name: 'onestepgps.saveMappings' });
    // Wait for the auto-match suggestion to be seeded before saving — it lands
    // one commit after the rows paint, and without it there is no dirty row to
    // persist and the click would assert against an empty payload.
    await screen.findByText('onestepgps.unsavedChanges[count=1]');
    // React 19: findByText resolves off the DOM mutation, which can land while
    // the seeding commit's follow-up work is still queued. A discrete click
    // dispatched in that window is dropped, so drain React's queue first.
    await act(async () => {});
    fireEvent.click(saveBtn);

    await waitFor(() => expect(posted.length).toBe(1));
    expect(posted[0]).toEqual({ vehicleId: 'v1', externalDeviceId: 'dev_1', label: 'Van 12' });
    // Saved row dev_2 was NOT re-posted; success banner appears.
    await waitFor(() => expect(screen.getByText(/onestepgps\.mappingsSaved\[/)).toBeInTheDocument());
  });

  it('deactivates a cleared mapping via DELETE on Save', async () => {
    const deleted = [];
    routeConfigured([
      [['DELETE', '/api/admin/integrations/onestepgps/device-mappings/'], (p) => {
        deleted.push(p);
        return { ok: true };
      }],
      [['POST', '/api/admin/integrations/onestepgps/device-mappings'], { ok: true, mapping: { id: 'x' } }],
    ]);
    renderTab();

    // Clear the saved dev_2 row back to the placeholder.
    const row2 = (await screen.findByText('Corolla Gray')).closest('tr');
    fireEvent.change(within(row2).getByRole('combobox'), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: 'onestepgps.saveMappings' }));

    await waitFor(() => expect(deleted.length).toBe(1));
    expect(deleted[0]).toContain('/device-mappings/m2');
  });

  it('disconnect asks for confirmation then DELETEs the credentials', async () => {
    let cleared = false;
    routeConfigured([
      [['DELETE', '/api/admin/integrations/onestepgps/credentials'], () => { cleared = true; return { ok: true, deleted: 1 }; }],
    ]);
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    renderTab();

    const btn = await screen.findByRole('button', { name: 'onestepgps.disconnect' });
    fireEvent.click(btn);
    await waitFor(() => expect(cleared).toBe(true));
    expect(window.confirm).toHaveBeenCalled();
  });

  it('test connection renders the success banner with the device count', async () => {
    routeConfigured([
      [['POST', '/api/admin/integrations/onestepgps/test-connection'], { ok: true, deviceCount: 14 }],
    ]);
    renderTab();

    const btn = await screen.findByRole('button', { name: 'onestepgps.testConnection' });
    await waitFor(() => expect(btn).toBeEnabled());
    fireEvent.click(btn);
    await waitFor(() => expect(screen.getByText('onestepgps.testOk[count=14]')).toBeInTheDocument());
  });

  it('test connection failure renders the error banner and a retry label', async () => {
    routeConfigured([
      [['POST', '/api/admin/integrations/onestepgps/test-connection'], { ok: false, error: 'OneStepGPS rejected the API key (401)' }],
    ]);
    renderTab();

    const btn = await screen.findByRole('button', { name: 'onestepgps.testConnection' });
    await waitFor(() => expect(btn).toBeEnabled());
    fireEvent.click(btn);
    await waitFor(() => expect(screen.getByText(/onestepgps\.testFail\[error=OneStepGPS rejected/)).toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'onestepgps.testAgain' })).toBeInTheDocument();
  });
});
