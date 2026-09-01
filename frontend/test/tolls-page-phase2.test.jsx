/**
 * Tolls phase 2 — Direction B grafts on the shipped Direction A queue.
 *
 * Pins the binding constraints:
 *  - the toggle DEFAULTS OFF and, while off, the phase-1 flat queue renders
 *    unchanged: no group headers, no keyboard hint, keys completely inert;
 *  - with the toggle on (NEEDS_REVIEW lane): group headers show renter, toll
 *    count, dollar total, and the batch's MINIMUM confidence; "Confirm N"
 *    opens the SAME themed bulk dialog and batches through the EXISTING
 *    bulk-confirm ids[] endpoint;
 *  - the J/K/C/D/W loop: J/K move a visible focus, C confirms through the
 *    existing per-row path, D/W open the themed dialogs (never instant),
 *    Escape clears — and every key is inert while a dialog is open or an
 *    input owns the browser focus;
 *  - the choice persists per user in localStorage;
 *  - the evidence drawer explains the losing candidate from
 *    candidateAssignments, and stays honest when none is stored.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import i18n from '../src/lib/i18n';

const { apiMock, apiDownloadMock } = vi.hoisted(() => ({ apiMock: vi.fn(), apiDownloadMock: vi.fn() }));

vi.mock('../src/lib/client', () => ({ api: apiMock, apiDownload: apiDownloadMock }));
vi.mock('../src/components/AuthGate', () => ({
  AuthGate: ({ children }) => children({ token: 'tkn', me: { role: 'ADMIN', name: 'Test' }, logout: () => {} })
}));
vi.mock('../src/components/AppShell', () => ({
  AppShell: ({ children }) => <div>{children}</div>
}));

import TollsPage from '../src/app/tolls/page';

const GROUP_MODE_KEY = 'tolls.groupByReservation';

const RES_1 = { id: 'r1', reservationNumber: 'TL-ZE40848835BA', pickupAt: '2026-08-24T13:00:00Z', returnAt: '2026-08-29T13:00:00Z' };
const RES_2 = { id: 'r2', reservationNumber: 'TL-PW10394857AA', pickupAt: '2026-08-22T13:00:00Z', returnAt: '2026-08-26T13:00:00Z' };

const DASHBOARD = {
  tollsEnabled: true,
  metrics: { importedToday: 4, matched: 38, needsReview: 12, postedToBilling: 1148 },
  queueCounts: { ALL: 4, AUTO_MATCHED: 0, NEEDS_REVIEW: 4, UNMATCHED: 0, DISPATCH_REVIEW: 0, USAGE_ONLY: 0, READY_TO_POST: 0 },
  returnedCount: 4,
  totalCount: 4,
  providerAccount: { provider: 'AUTOEXPRESO', username: 'cx', isActive: true, hasPassword: true, settings: {} },
  autoSync: { enabled: true, intervalMinutes: 30, lastAutomaticRunAt: '2026-08-26T12:42:00Z', nextRunAt: null, lastSweep: null },
  importRuns: [],
  transactions: [
    {
      id: 'tx-1',
      transactionAt: '2026-08-26T07:14:00Z',
      amount: 1.4,
      location: 'Plaza Caguas Norte',
      status: 'NEEDS_REVIEW',
      billingStatus: 'PENDING',
      needsReview: true,
      matchConfidence: 92,
      vehicle: { id: 'v1', internalNumber: 'UNIT-102', plate: 'KST-894' },
      reservation: { ...RES_1, customer: { firstName: 'M.', lastName: 'Rivera' } },
      latestAssignment: {
        id: 'a1', status: 'SUGGESTED', confidence: 92,
        matchReason: 'vehicleResponsibilityWindow,plate,withinTripWindow,effectiveVehicleTripWindow,multipleCandidates',
        reservation: RES_1
      },
      candidateAssignments: [],
      issueIncident: null
    },
    {
      id: 'tx-3',
      transactionAt: '2026-08-25T09:03:00Z',
      amount: 2.25,
      location: 'PR-52 Caguas',
      status: 'NEEDS_REVIEW',
      billingStatus: 'PENDING',
      needsReview: true,
      matchConfidence: 88,
      vehicle: { id: 'v1', internalNumber: 'UNIT-102', plate: 'KST-894' },
      reservation: null,
      latestAssignment: { id: 'a3', status: 'SUGGESTED', confidence: 88, matchReason: 'plate,withinTripWindow', reservation: RES_1 },
      candidateAssignments: [],
      issueIncident: null
    },
    {
      id: 'tx-2',
      transactionAt: '2026-08-25T13:57:00Z',
      amount: 1.0,
      location: 'Plaza Buchanan',
      status: 'NEEDS_REVIEW',
      billingStatus: 'PENDING',
      needsReview: true,
      matchConfidence: 58,
      vehicle: { id: 'v2', internalNumber: 'UNIT-088', plate: 'HYT-441' },
      reservation: null,
      latestAssignment: {
        id: 'a2', status: 'SUGGESTED', confidence: 58,
        matchReason: 'plate,withinTripWindow,withinGraceWindow,multipleCandidates',
        reservation: RES_2
      },
      candidateAssignments: [{
        id: 'a-old', status: 'REJECTED', confidence: 41, matchReason: 'plate,withinGraceWindow',
        reservation: { id: 'r-old', reservationNumber: 'TL-QQ57', pickupAt: '2026-08-10T13:00:00Z', returnAt: '2026-08-24T09:12:00Z' }
      }],
      issueIncident: null
    },
    {
      id: 'tx-4',
      transactionAt: '2026-08-25T10:12:00Z',
      amount: 2.25,
      location: 'Plaza Caguas Sur',
      status: 'NEEDS_REVIEW',
      billingStatus: 'PENDING',
      needsReview: true,
      matchConfidence: 0,
      vehicle: { id: 'v4', internalNumber: 'UNIT-045', plate: 'FBM-617' },
      reservation: null,
      latestAssignment: null,
      candidateAssignments: [],
      issueIncident: null
    }
  ]
};

function mockApi() {
  apiMock.mockImplementation(async (path) => {
    if (String(path).startsWith('/api/tolls/dashboard')) return DASHBOARD;
    if (String(path).startsWith('/api/tolls/alerts')) return { tollsEnabled: true, alerts: [] };
    if (String(path).includes('/bulk-confirm')) return { confirmed: 2, dispatchConfirmed: 0, skipped: 0, failed: 0 };
    return {};
  });
}

// The flattened grouped order: r1's rows, then r2's, then the unmatched bucket.
const GROUPED_ORDER = ['tx-1', 'tx-3', 'tx-2', 'tx-4'];

const focusedRowId = () => document.querySelector('tr.is-kfocus')?.getAttribute('data-rowid') || '';
const pressKey = (key) => fireEvent.keyDown(document.body, { key });

beforeEach(() => {
  apiMock.mockReset();
  apiDownloadMock.mockReset();
  mockApi();
  window.localStorage.clear();
  window.history.replaceState({}, '', '/tolls?view=NEEDS_REVIEW');
  i18n.changeLanguage('en');
});
afterEach(() => {
  vi.restoreAllMocks();
  window.history.replaceState({}, '', '/tolls');
  i18n.changeLanguage('en');
});

describe('toggle off (default) — phase-1 queue unchanged', () => {
  it('defaults OFF, renders the flat phase-1 list, keys fully inert', async () => {
    render(<TollsPage />);
    await screen.findAllByText('Plate match');

    // the opt-in exists but is unchecked
    const toggle = screen.getByRole('checkbox', { name: /Group by reservation/ });
    expect(toggle.checked).toBe(false);

    // no phase-2 chrome
    expect(document.querySelector('.tq-grouphead')).toBeNull();
    expect(document.querySelector('.tq-keys')).toBeNull();
    expect(screen.queryByText('No reservation found')).toBeNull();
    expect(screen.queryByText(/min conf/)).toBeNull();

    // flat list keeps the delivered order
    const ids = Array.from(document.querySelectorAll('tr[data-rowid]')).map((tr) => tr.getAttribute('data-rowid'));
    expect(ids).toEqual(['tx-1', 'tx-3', 'tx-2', 'tx-4']);

    // phase-1 landmarks intact
    expect(screen.getByText('92')).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Confirm' }).length).toBeGreaterThan(0);
    expect(screen.getByText(/rows · sorted newest/)).toBeInTheDocument();

    // keyboard is completely inert while off
    const callsBefore = apiMock.mock.calls.length;
    pressKey('j');
    pressKey('c');
    pressKey('d');
    expect(focusedRowId()).toBe('');
    expect(document.querySelector('.tq-dialog')).toBeNull();
    expect(apiMock.mock.calls.length).toBe(callsBefore);
  });

  it('arming the toggle persists the choice in localStorage', async () => {
    render(<TollsPage />);
    await screen.findAllByText('Plate match');
    fireEvent.click(screen.getByRole('checkbox', { name: /Group by reservation/ }));
    expect(window.localStorage.getItem(GROUP_MODE_KEY)).toBe('1');
    await screen.findByText('No reservation found');
    fireEvent.click(screen.getByRole('checkbox', { name: /Group by reservation/ }));
    expect(window.localStorage.getItem(GROUP_MODE_KEY)).toBe('0');
    expect(document.querySelector('.tq-grouphead')).toBeNull();
  });
});

describe('toggle on — group-by-reservation batching', () => {
  beforeEach(() => window.localStorage.setItem(GROUP_MODE_KEY, '1'));

  it('group headers carry renter, count, dollar total, and MINIMUM confidence', async () => {
    render(<TollsPage />);
    await screen.findByText('No reservation found');

    const heads = Array.from(document.querySelectorAll('.tq-grouphead'));
    expect(heads).toHaveLength(3);
    // r1: renter + the honest minimum of 92/88, $3.65 over 2 tolls
    expect(heads[0].textContent).toContain('TL-ZE40848835BA · M. Rivera');
    expect(heads[0].textContent).toContain('$3.65');
    expect(heads[0].textContent).toContain('2 tolls');
    expect(heads[0].textContent).toContain('min conf 88');
    // r2: single toll
    expect(heads[1].textContent).toContain('TL-PW10394857AA');
    expect(heads[1].textContent).toContain('1 toll');
    expect(heads[1].textContent).toContain('min conf 58');
    // unmatched bucket last, no Confirm button inside it
    expect(heads[2].textContent).toContain('No reservation found');
    expect(heads[2].querySelector('button')).toBeNull();

    // footer says groups, and rows are in grouped order
    expect(screen.getByText(/3 groups · 4 rows/)).toBeInTheDocument();
    const ids = Array.from(document.querySelectorAll('tr[data-rowid]')).map((tr) => tr.getAttribute('data-rowid'));
    expect(ids).toEqual(GROUPED_ORDER);
  });

  it('"Confirm N" batches the group through the EXISTING bulk-confirm ids[] endpoint', async () => {
    render(<TollsPage />);
    await screen.findByText('No reservation found');

    fireEvent.click(screen.getByRole('button', { name: 'Confirm 2' }));
    // the same themed dialog as Confirm all
    await screen.findByText('Confirm 2 tolls now?');
    fireEvent.click(screen.getByRole('button', { name: 'Confirm all' }));

    await waitFor(() => {
      const call = apiMock.mock.calls.find(([path]) => String(path).includes('/api/tolls/transactions/bulk-confirm'));
      expect(call).toBeTruthy();
      expect(JSON.parse(call[1].body).ids).toEqual(['tx-1', 'tx-3']);
    });
  });
});

describe('toggle on — keyboard triage loop', () => {
  beforeEach(() => window.localStorage.setItem(GROUP_MODE_KEY, '1'));

  it('J/K move the visible focus across the grouped order; Escape clears', async () => {
    render(<TollsPage />);
    await screen.findByText('No reservation found');

    expect(document.querySelector('.tq-keys')).not.toBeNull();

    pressKey('j');
    expect(focusedRowId()).toBe('tx-1');
    pressKey('j');
    expect(focusedRowId()).toBe('tx-3');
    pressKey('j');
    expect(focusedRowId()).toBe('tx-2');
    pressKey('j');
    expect(focusedRowId()).toBe('tx-4');
    pressKey('j'); // clamps at the end
    expect(focusedRowId()).toBe('tx-4');
    pressKey('k');
    expect(focusedRowId()).toBe('tx-2');
    pressKey('Escape');
    expect(focusedRowId()).toBe('');
  });

  it('C confirms the focused suggestion through the existing per-row endpoint', async () => {
    render(<TollsPage />);
    await screen.findByText('No reservation found');

    pressKey('j'); // tx-1
    pressKey('c');
    await waitFor(() => {
      const call = apiMock.mock.calls.find(([path]) => String(path).includes('/api/tolls/transactions/tx-1/confirm-match'));
      expect(call).toBeTruthy();
      expect(JSON.parse(call[1].body).reservationId).toBe('r1');
    });
  });

  it('D opens the themed dispute dialog (never instant) and keys go inert while it is open', async () => {
    render(<TollsPage />);
    await screen.findByText('No reservation found');

    pressKey('j'); // tx-1
    pressKey('d');
    await screen.findByText('Dispute toll');
    // no review-action fired yet — the dialog owns the decision
    expect(apiMock.mock.calls.find(([path]) => String(path).includes('review-action'))).toBeUndefined();

    // inert while the dialog is open
    pressKey('j');
    expect(focusedRowId()).toBe('tx-1');
    pressKey('Escape');
    expect(focusedRowId()).toBe('tx-1');

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(document.querySelector('.tq-dialog')).toBeNull());
    pressKey('Escape');
    expect(focusedRowId()).toBe('');
  });

  it('W opens the themed waive dialog for the focused row', async () => {
    render(<TollsPage />);
    await screen.findByText('No reservation found');
    pressKey('j');
    pressKey('w');
    await screen.findByText('Waive toll — not billable');
    expect(document.querySelector('.tq-dialog textarea')).toBeTruthy();
  });

  it('keys are inert while an input owns the browser focus', async () => {
    render(<TollsPage />);
    await screen.findByText('No reservation found');

    const search = screen.getByPlaceholderText('Search plate, tag, location, reservation');
    fireEvent.keyDown(search, { key: 'j' });
    expect(focusedRowId()).toBe('');
    fireEvent.keyDown(search, { key: 'c' });
    expect(apiMock.mock.calls.find(([path]) => String(path).includes('confirm-match'))).toBeUndefined();
  });
});

describe('evidence drawer — the losing candidate explained', () => {
  it('names the superseded candidate and where its window sits vs the toll', async () => {
    render(<TollsPage />);
    await screen.findAllByText('Plate match');

    // tx-2 has 4 chips → "+1 more" opens its drawer
    fireEvent.click(screen.getByText('+1 more'));
    await screen.findByText('Other candidates — superseded suggestions');
    expect(screen.getByText(/TL-QQ57 \(score 41\) — window ended .* before this toll/)).toBeInTheDocument();
  });

  it('stays honest when multipleCandidates was penalized but no candidate is stored', async () => {
    render(<TollsPage />);
    await screen.findAllByText('Plate match');

    // tx-1: 5 chips → "+2 more" opens its drawer; candidateAssignments is empty
    fireEvent.click(screen.getByText('+2 more'));
    await screen.findByText(/only the winning suggestion is stored/);
    expect(screen.queryByText('Other candidates — superseded suggestions')).toBeNull();
  });
});

describe('toggle on (ES) — the phase-2 strings are translated', () => {
  it('renders Spanish group header math and keyboard hint', async () => {
    window.localStorage.setItem(GROUP_MODE_KEY, '1');
    i18n.changeLanguage('es');
    render(<TollsPage />);
    await screen.findByText('Sin reserva encontrada');
    expect(screen.getByRole('checkbox', { name: /Agrupar por reserva/ })).toBeInTheDocument();
    const heads = Array.from(document.querySelectorAll('.tq-grouphead'));
    expect(heads[0].textContent).toContain('2 peajes');
    expect(heads[0].textContent).toContain('conf mín 88');
    expect(screen.getByRole('button', { name: 'Confirmar 2' })).toBeInTheDocument();
    expect(document.querySelector('.tq-keys').textContent).toContain('exonerar');
  });
});
