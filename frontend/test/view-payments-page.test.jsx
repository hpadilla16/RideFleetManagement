/**
 * View Payments redesign — the capability→control matrix, rendered.
 *
 * Pins the owner's brief ("B: functional with what the tenant has"):
 *  - an iPOS+SPIn tenant (IRC) sees ZERO Authorize.Net furniture — no
 *    reconcile control, no Charge Saved Card, no AuthNet watch line — and the
 *    silent auto-reconcile loop NEVER fires a network call;
 *  - an Authorize.Net tenant keeps every current function (charge saved card,
 *    reconcile disclosure, auto-reconcile polling for WEB- reservations);
 *  - universal controls (OTC recording, history, send payment link) render for
 *    everyone, including when the capabilities fetch fails (fail open);
 *  - window.prompt / window.confirm are NEVER called — refund/void/release run
 *    through themed dialogs;
 *  - both EN and ES actually render (namespace-merge gotcha guard).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react';
import i18n from '../src/lib/i18n';

const { apiMock } = vi.hoisted(() => ({ apiMock: vi.fn() }));

vi.mock('next/navigation', () => ({
  usePathname: () => '/reservations/r1/payments',
  useParams: () => ({ id: 'r1' }),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('../src/lib/client', () => ({ api: apiMock }));
vi.mock('../src/components/AuthGate', () => ({
  AuthGate: ({ children }) => children({ token: 'tkn', me: { role: 'ADMIN', name: 'Test', moduleAccess: { paymentActions: true } }, logout: () => {} })
}));
vi.mock('../src/components/AppShell', () => ({
  AppShell: ({ children }) => <div>{children}</div>
}));

import ViewPaymentsPage from '../src/app/reservations/[id]/payments/page';

const IPOS_CAPS = {
  gateway: 'ipos',
  authorizenet: { enabled: false },
  spin: { enabled: true },
  ipos: { enabled: true, linkReady: true },
  stripe: { enabled: false },
  square: { enabled: false },
  payarc: { enabled: false },
  autocharge: { mode: 'MANUAL' }
};

const AUTHNET_CAPS = {
  gateway: 'authorizenet',
  authorizenet: { enabled: true },
  spin: { enabled: false },
  ipos: { enabled: false, linkReady: false },
  stripe: { enabled: false },
  square: { enabled: false },
  payarc: { enabled: false },
  autocharge: { mode: 'AUTO' }
};

// WEB- reservation with a real balance: the exact shape that, pre-redesign,
// armed the Authorize.Net auto-reconcile loop for EVERY tenant.
const RESERVATION = {
  id: 'r1',
  reservationNumber: 'WEB-282260',
  customer: { email: 'maria.colon@example.com', authnetCustomerProfileId: null, authnetPaymentProfileId: null },
  rentalAgreement: {
    id: 'ag1',
    total: 712.40,
    paidAmount: 500.00,
    balance: 212.40,
    cardOnFileBrand: 'Visa',
    cardOnFileLast4: '4821',
    cardOnFileCapturedAt: '2026-08-26T14:32:00Z',
    depositHoldId: 'DVJ-88213',
    depositHoldAmount: 250,
    depositHoldVoidedAt: null,
    securityDepositAmount: 250
  }
};

const PAYMENTS = [
  { id: 'p1', paidAt: '2026-08-28T20:22:00Z', method: 'CARD', amount: 300, reference: 'IPOS:K1a2b3c4d5e6f7g8', status: 'PAID' },
  { id: 'p2', paidAt: '2026-08-26T14:41:00Z', method: 'CASH', amount: 200, reference: 'OTC-1756224061', status: 'PAID' },
  { id: 'p3', paidAt: '2026-08-20T14:41:00Z', method: 'CARD', amount: 44, reference: 'AUTHNET:120058491022', status: 'PAID' },
  // SPIn terminal sale: gateway column + "Spin Sale · <refId>" note are the
  // server-written evidence the refund rail routes on (refund-rails.js).
  { id: 'p4', paidAt: '2026-08-18T15:00:00Z', method: 'CARD', amount: 150, reference: 'A8K2X9', status: 'PAID', gateway: 'SPIN', notes: 'Spin Sale · RFM-RES1-777' },
  // AUTH_HOLD: an authorization, not settled money — must never grow a
  // refund action (Release deposit is the verb for holds).
  { id: 'p5', paidAt: '2026-08-18T15:05:00Z', method: 'AUTH_HOLD', amount: 250, reference: 'HOLD-AUTH-9912', status: 'PAID' }
];

function mockApi({ caps = IPOS_CAPS, capsError = false } = {}) {
  apiMock.mockImplementation(async (path) => {
    const p = String(path);
    if (p === '/api/settings/payment-capabilities') {
      if (capsError) throw new Error('boom');
      return caps;
    }
    if (p === '/api/reservations/r1') return RESERVATION;
    if (p === '/api/reservations/r1/payments') return PAYMENTS;
    if (p === '/api/reservations/r1/pricing') return { totals: { total: 712.40 } };
    return {};
  });
}

const reconcileCalls = () =>
  apiMock.mock.calls.filter(([p]) => String(p).includes('reconcile-authorizenet'));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

beforeEach(() => {
  apiMock.mockReset();
  i18n.changeLanguage('en');
});
afterEach(() => {
  vi.restoreAllMocks();
  i18n.changeLanguage('en');
});

describe('iPOS + SPIn tenant (IRC)', () => {
  it('renders SPIn collect tools and ZERO Authorize.Net furniture', async () => {
    mockApi({ caps: IPOS_CAPS });
    render(<ViewPaymentsPage />);

    // zones + snapshot
    await screen.findByText('Collect the balance');
    expect(screen.getByText('Record a payment')).toBeInTheDocument();
    expect(screen.getByText('Payment history')).toBeInTheDocument();
    expect(screen.getByText('Agreement total')).toBeInTheDocument();

    // processor identity chip
    await screen.findByText('iPOSpays · SPIn terminal');

    // SPIn charge tool (evidence + tenant gateway)
    expect(screen.getByText('Charge card on file')).toBeInTheDocument();
    // universal collect verb
    expect(screen.getByText('Send payment link')).toBeInTheDocument();
    // deposit hold band with release controls
    expect(screen.getByTestId('deposit-band-spin')).toBeInTheDocument();
    expect(screen.getByText('Release hold')).toBeInTheDocument();

    // ZERO Authorize.Net furniture — the entire point of the redesign
    expect(screen.queryByText(/Authorize\.Net/)).toBeNull();
    expect(screen.queryByText(/AuthNet/)).toBeNull();
    expect(screen.queryByText('Charge saved card')).toBeNull();
    expect(screen.queryByText(/Reconcile/)).toBeNull();
    expect(screen.queryByTestId('deposit-band-authnet')).toBeNull();
    // the legacy AUTHNET: row is still listed (history is universal) but its
    // save-card action must not render for a non-AuthNet tenant
    expect(screen.queryByText('Save card to file')).toBeNull();
  });

  it('NEVER fires the silent Authorize.Net auto-reconcile loop', async () => {
    mockApi({ caps: IPOS_CAPS });
    render(<ViewPaymentsPage />);
    await screen.findByText('iPOSpays · SPIn terminal');
    // the loop's first attempt fires 1.2s after arming — give it time to
    // prove it does NOT (WEB- reservation + balance, previously guaranteed)
    await sleep(1700);
    expect(reconcileCalls()).toHaveLength(0);
  }, 10000);

  it('refund and void run through themed dialogs — window.prompt/confirm are never called', async () => {
    mockApi({ caps: IPOS_CAPS });
    const promptSpy = vi.spyOn(window, 'prompt');
    const confirmSpy = vi.spyOn(window, 'confirm');
    render(<ViewPaymentsPage />);
    await screen.findByText('iPOSpays · SPIn terminal');

    // open the first row's overflow → Record refund (IPOS: row routes as bookkeeping)
    const menus = screen.getAllByTitle('More actions');
    fireEvent.click(menus[0]);
    const refundItem = (await screen.findAllByText('Record refund'))[0];
    fireEvent.click(refundItem);
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toBeInTheDocument();
    expect(screen.getByText('Refund payment')).toBeInTheDocument();
    fireEvent.click(screen.getByText('Cancel'));

    // void (admin) opens the themed danger dialog
    fireEvent.click(menus[0]);
    fireEvent.click((await screen.findAllByText('Void · no refund'))[0]);
    await screen.findByRole('dialog');
    expect(screen.getByText('Reason (required)')).toBeInTheDocument();

    expect(promptSpy).not.toHaveBeenCalled();
    expect(confirmSpy).not.toHaveBeenCalled();
  });

  it('labels refunds by the ROW’s own reference routing (AUTHNET: row → Refund to card)', async () => {
    mockApi({ caps: IPOS_CAPS });
    render(<ViewPaymentsPage />);
    await screen.findByText('iPOSpays · SPIn terminal');
    const menus = screen.getAllByTitle('More actions');
    // Menu items render inside each row's <details>, so scope to the row.
    const authnetRow = menus[2].closest('tr');
    fireEvent.click(menus[2]); // the AUTHNET: legacy row
    expect(within(authnetRow).getByText('Refund to card')).toBeInTheDocument();
  });

  it('SPIn terminal sale row refunds TO THE CARD, requires a reason, and posts amount + reason', async () => {
    mockApi({ caps: IPOS_CAPS });
    render(<ViewPaymentsPage />);
    await screen.findByText('iPOSpays · SPIn terminal');

    const menus = screen.getAllByTitle('More actions');
    const spinRow = menus[3].closest('tr'); // p4 — gateway:'SPIN' CARD row
    fireEvent.click(menus[3]);
    fireEvent.click(within(spinRow).getByText('Refund to card'));
    const dialog = await screen.findByRole('dialog');
    // confirmation names the processor + the row's reference
    expect(within(dialog).getByText('SPIN')).toBeInTheDocument();
    expect(within(dialog).getByText('RFM-RES1-777')).toBeInTheDocument();

    const submit = screen.getByRole('button', { name: 'Refund' });
    expect(submit).toBeDisabled(); // no reason yet

    fireEvent.change(screen.getByPlaceholderText('e.g. overcharge at counter, cancelled add-on'), {
      target: { value: 'customer overcharged' }
    });
    expect(submit).not.toBeDisabled();
    fireEvent.click(submit);

    await waitFor(() => {
      const call = apiMock.mock.calls.find(([p]) => String(p).includes('/payments/p4/refund'));
      expect(call).toBeTruthy();
      const body = JSON.parse(call[1].body);
      expect(body.amount).toBe(150);
      expect(body.reason).toBe('customer overcharged');
    });
  });

  it('AUTH_HOLD rows get NO refund action — holds are released, not refunded', async () => {
    mockApi({ caps: IPOS_CAPS });
    render(<ViewPaymentsPage />);
    await screen.findByText('iPOSpays · SPIn terminal');
    const menus = screen.getAllByTitle('More actions');
    const holdRow = menus[4].closest('tr'); // p5 — the AUTH_HOLD row
    fireEvent.click(menus[4]);
    // the overflow renders (copy reference) but no refund item of either kind
    expect(within(holdRow).getByText('Copy reference')).toBeInTheDocument();
    expect(within(holdRow).queryByText('Refund to card')).toBeNull();
    expect(within(holdRow).queryByText('Record refund')).toBeNull();
  });
});

describe('Authorize.Net tenant', () => {
  it('keeps every Auth.Net function: charge saved card, reconcile disclosure, watch line', async () => {
    mockApi({ caps: AUTHNET_CAPS });
    render(<ViewPaymentsPage />);

    await screen.findByText('Authorize.Net'); // gateway chip
    expect(screen.getByText('Charge saved card')).toBeInTheDocument();
    expect(screen.getByText('Find a missing Authorize.Net payment')).toBeInTheDocument();
    expect(screen.getByText('Reconcile payment')).toBeInTheDocument();
    expect(screen.getByTestId('deposit-band-authnet')).toBeInTheDocument();
    // universal + evidence-backed legacy SPIn tools still reachable
    expect(screen.getByText('Send payment link')).toBeInTheDocument();
    expect(screen.getByTestId('deposit-band-spin')).toBeInTheDocument();
    expect(screen.getByText('Charge card on file')).toBeInTheDocument();
    // save-card row action renders for the AUTHNET: row
    const menus = screen.getAllByTitle('More actions');
    fireEvent.click(menus[2]);
    expect(await screen.findByText('Save card to file')).toBeInTheDocument();
  });

  it('ARMS the silent auto-reconcile loop for a WEB- reservation with a balance', async () => {
    mockApi({ caps: AUTHNET_CAPS });
    render(<ViewPaymentsPage />);
    await screen.findByText('Authorize.Net');
    await waitFor(() => expect(reconcileCalls().length).toBeGreaterThan(0), { timeout: 5000 });
  }, 10000);
});

describe('capabilities fetch failure (fail open)', () => {
  it('renders universal controls only — OTC form, history, send-link — and hides gateway furniture', async () => {
    mockApi({ capsError: true });
    render(<ViewPaymentsPage />);

    await screen.findByText('Record a payment');
    expect(screen.getByText('Payment history')).toBeInTheDocument();
    expect(screen.getByText('Send payment link')).toBeInTheDocument();
    // no processor chip, no gateway-specific controls
    expect(screen.queryByTestId('gateway-chip')).toBeNull();
    expect(screen.queryByText('Charge saved card')).toBeNull();
    expect(screen.queryByText(/Reconcile/)).toBeNull();
    // evidence-backed SPIn tools stay reachable (reservation has a card + hold)
    expect(screen.getByTestId('deposit-band-spin')).toBeInTheDocument();
    expect(screen.getByText('Charge card on file')).toBeInTheDocument();
    // and the auto-reconcile loop must not arm on unknown capabilities
    await sleep(1500);
    expect(reconcileCalls()).toHaveLength(0);
  }, 10000);
});

describe('Spanish render (namespace-merge gotcha guard)', () => {
  it('renders the full page in Spanish', async () => {
    mockApi({ caps: IPOS_CAPS });
    i18n.changeLanguage('es');
    render(<ViewPaymentsPage />);

    await screen.findByText('Cobrar el balance');
    expect(screen.getByText('Registrar un pago')).toBeInTheDocument();
    expect(screen.getByText('Historial de pagos')).toBeInTheDocument();
    expect(screen.getByText('Enviar enlace de pago')).toBeInTheDocument();
    expect(screen.getByText('Cobrar tarjeta guardada')).toBeInTheDocument();
    expect(screen.getByText('Liberar retención')).toBeInTheDocument();
    expect(screen.getByText('Total del contrato')).toBeInTheDocument();
    // status chip + KPI label both say "Balance pendiente"
    expect(screen.getAllByText('Balance pendiente').length).toBeGreaterThan(0);
    // ES must not leak EN zone titles
    expect(screen.queryByText('Collect the balance')).toBeNull();
  });
});
