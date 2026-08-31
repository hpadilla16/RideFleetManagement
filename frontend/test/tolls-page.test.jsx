/**
 * Tolls redesign A — page render smoke, REAL i18n in both languages.
 *
 * Pins the binding constraints the triage-lib tests cannot see:
 *  - the page renders with the lane rail (DB counts), chips, and one primary
 *    action per row;
 *  - the raw comma-joined matchReason string is NOT in the document as text;
 *  - Reset / Dispute / Waive live in the overflow menu and open the THEMED
 *    dialog — window.prompt / window.confirm are never called;
 *  - both EN and ES actually render (the namespace-merge gotcha guard).
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

const RAW_REASON = 'vehicleResponsibilityWindow,currentVehicleId,plate,withinTripWindow,effectiveVehicleTripWindow';

const DASHBOARD = {
  tollsEnabled: true,
  metrics: { importedToday: 4, matched: 38, needsReview: 12, needsReviewActionable: 9, needsReviewNoSuggestion: 3, postedToBilling: 1148 },
  queueCounts: { ALL: 203, AUTO_MATCHED: 38, NEEDS_REVIEW: 201, NO_SUGGESTION: 3, UNMATCHED: 9, DISPATCH_REVIEW: 4, USAGE_ONLY: 11, READY_TO_POST: 27 },
  returnedCount: 2,
  totalCount: 203,
  providerAccount: { provider: 'AUTOEXPRESO', username: 'cx', isActive: true, hasPassword: true, settings: {} },
  autoSync: { enabled: true, intervalMinutes: 30, lastAutomaticRunAt: '2026-08-26T12:42:00Z', nextRunAt: '2026-08-26T13:12:00Z', lastSweep: null },
  importRuns: [],
  transactions: [
    {
      id: 'tx-1',
      transactionAt: '2026-08-26T07:14:00Z',
      amount: 1.4,
      location: 'Plaza Caguas Norte',
      lane: 'L2',
      direction: 'N',
      plateRaw: 'KST-894',
      status: 'NEEDS_REVIEW',
      billingStatus: 'PENDING',
      needsReview: true,
      matchConfidence: 92,
      vehicle: { id: 'v1', internalNumber: 'UNIT-102', plate: 'KST-894', tollTagNumber: '', tollStickerNumber: '' },
      reservation: null,
      latestAssignment: {
        id: 'a1', status: 'SUGGESTED', confidence: 92,
        matchReason: RAW_REASON,
        reservation: { id: 'r1', reservationNumber: 'TL-ZE40848835BA', pickupAt: '2026-08-24T13:00:00Z', returnAt: '2026-08-29T13:00:00Z' }
      },
      issueIncident: null
    },
    {
      id: 'tx-2',
      transactionAt: '2026-08-25T21:36:00Z',
      amount: 3.1,
      location: 'Plaza Guaynabo',
      plateRaw: 'BBT-812',
      status: 'IMPORTED',
      billingStatus: 'PENDING',
      needsReview: false,
      matchConfidence: null,
      vehicle: null,
      reservation: null,
      latestAssignment: null,
      issueIncident: null
    }
  ]
};

function mockApi() {
  apiMock.mockImplementation(async (path) => {
    if (String(path).startsWith('/api/tolls/dashboard')) return DASHBOARD;
    if (String(path).startsWith('/api/tolls/alerts')) return { tollsEnabled: true, alerts: [] };
    return {};
  });
}

beforeEach(() => {
  apiMock.mockReset();
  apiDownloadMock.mockReset();
  mockApi();
  i18n.changeLanguage('en');
});
afterEach(() => {
  vi.restoreAllMocks();
  i18n.changeLanguage('en');
});

describe('tolls page (EN)', () => {
  it('renders lanes with DB counts, chips, one primary action, and NEVER the raw reason string', async () => {
    const promptSpy = vi.spyOn(window, 'prompt');
    const confirmSpy = vi.spyOn(window, 'confirm');
    render(<TollsPage />);

    // lane rail: groups + views with database counts
    await screen.findByText('Confident — no eyes needed');
    expect(screen.getByText('No match found')).toBeInTheDocument();
    const needsReviewLane = await screen.findByRole('button', { name: /Needs review\s*201/ });
    expect(needsReviewLane).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Unmatched\s*9/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Ready to post\s*27/ })).toBeInTheDocument();

    // human chips, not tokens
    await screen.findByText('Plate match');
    expect(screen.getByText('Inside rental window')).toBeInTheDocument();
    expect(screen.getByText(/\+2 more/)).toBeInTheDocument();

    // the raw comma string is not rendered as text anywhere
    expect(screen.queryByText(new RegExp(RAW_REASON))).toBeNull();
    expect(screen.queryByText(/currentVehicleId/)).toBeNull();

    // confidence score is visible as a number
    expect(screen.getByText('92')).toBeInTheDocument();

    // one primary action for the suggested row
    expect(screen.getByRole('button', { name: 'Confirm' })).toBeInTheDocument();

    // unmatched row keeps its assign input
    expect(screen.getByPlaceholderText('Assign reservation #…')).toBeInTheDocument();

    // toolbar functions all reachable
    expect(screen.getByText('Export CSV')).toBeInTheDocument();
    expect(screen.getByText('Auto-match all')).toBeInTheDocument();
    expect(screen.getByText(/Confirm all/)).toBeInTheDocument();
    expect(screen.getByText('Refresh')).toBeInTheDocument();

    // browser dialogs never used
    expect(promptSpy).not.toHaveBeenCalled();
    expect(confirmSpy).not.toHaveBeenCalled();
  });

  it('Waive lives in the overflow menu and opens the THEMED dialog, not window.prompt', async () => {
    const promptSpy = vi.spyOn(window, 'prompt');
    render(<TollsPage />);
    await screen.findByText('Plate match');

    // open the suggested row's overflow menu and pick Waive
    const waive = await screen.findAllByText('Waive — not billable…');
    fireEvent.click(waive[0]);

    // themed dialog with a note textarea appears; window.prompt untouched
    await screen.findByText('Waive toll — not billable');
    expect(document.querySelector('.tq-dialog textarea')).toBeTruthy();
    expect(promptSpy).not.toHaveBeenCalled();

    // Reset and Dispute are reachable in the same menu
    expect(screen.getAllByText('Reset match').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Dispute…').length).toBeGreaterThan(0);
  });

  it('the "+N more" chip opens the evidence drawer with the score ledger', async () => {
    render(<TollsPage />);
    const more = await screen.findByText(/\+2 more/);
    fireEvent.click(more);
    await screen.findByText(/Score ledger — why 92/);
    expect(screen.getByText('+70')).toBeInTheDocument();
    // +25 appears twice: plate and withinTripWindow both score +25
    expect(screen.getAllByText('+25')).toHaveLength(2);
  });

  it('Imports & sync tab keeps provider setup, manual + CSV import, and runs', async () => {
    render(<TollsPage />);
    await screen.findByText('Plate match');
    fireEvent.click(screen.getByRole('button', { name: 'Imports & sync' }));
    await screen.findByText('Toll Provider Setup');
    expect(screen.getByText('Manual Toll Import')).toBeInTheDocument();
    expect(screen.getByText('Bulk CSV Import')).toBeInTheDocument();
    expect(screen.getByText('Recent Import Runs')).toBeInTheDocument();
    expect(screen.getByText('Run Health Check')).toBeInTheDocument();
    expect(screen.getByText(/Run AutoExpreso Sync/)).toBeInTheDocument();
  });
});

describe('tolls page (ES)', () => {
  it('renders the Spanish chip labels and lane names', async () => {
    i18n.changeLanguage('es');
    render(<TollsPage />);
    await screen.findByText('Tablilla coincide');
    expect(screen.getByText('Dentro del período de renta')).toBeInTheDocument();
    expect(screen.getByText('Confiable — no requiere ojos')).toBeInTheDocument();
    expect(screen.getByText('Sin match')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Confirmar' })).toBeInTheDocument();
    expect(screen.getByText('Exportar CSV')).toBeInTheDocument();
    // still no raw tokens in ES either
    expect(screen.queryByText(/vehicleResponsibilityWindow/)).toBeNull();
  });
});
