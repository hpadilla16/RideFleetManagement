/**
 * The hold screen and the day-0 banner — Phase 5.
 *
 * Pinned here, in order of cost-of-being-wrong:
 *
 *  1. THE SCREEN DOES NOT APPEAR UNTIL THE BACKEND SAYS IT SHOULD. Phase 4
 *     already sets Tenant.status='SUSPENDED' on tenants in production. If this
 *     component keyed off that, shipping the bundle would lock out their staff
 *     with the backend switch still off — enforcing in the browser what the
 *     environment variable was supposed to govern.
 *  2. IT DISTINGUISHES "you owe us" FROM "you are switched off". A compliance
 *     hold must not produce a "go pay your bill" screen.
 *  3. IT NEVER RENDERS A CARD FORM. The remedy is an emailed link.
 *  4. THE WAY OUT IS ALWAYS THERE. Sign out.
 *  5. The banner is silent when nothing is wrong, and carries the deadline
 *     when something is.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const { apiMock } = vi.hoisted(() => ({ apiMock: vi.fn() }));
vi.mock('../src/lib/client', () => ({
  API_BASE: 'http://test',
  api: (...args) => apiMock(...args),
  AUTH_EXPIRED_EVENT: 'ridefleet:auth-expired',
  PASSWORD_CHANGE_REQUIRED_EVENT: 'ridefleet:password-change-required',
  TENANT_SUSPENDED_EVENT: 'ridefleet:tenant-suspended',
  TOKEN_KEY: 'fleet_jwt',
  USER_KEY: 'fleet_user',
  clearStoredAuth: () => {},
}));

// English is the default; i18n must be initialised or every string renders as
// its own key and the assertions below would pass on nonsense.
await import('../src/lib/i18n');
const { TenantSuspendedHold } = await import('../src/components/TenantSuspendedHold');
const { BillingNoticeBanner } = await import('../src/components/BillingNoticeBanner');
const { AuthGate } = await import('../src/components/AuthGate');

const SELF = {
  tenant: { id: 't1', name: 'Autos del Valle', status: 'SUSPENDED', suspendedForNonPayment: true, billingSuspendedAt: '2026-09-08T00:00:00.000Z' },
  subscription: {
    status: 'SUSPENDED', planName: 'RFM Pro', amount: '199.00', amountFormatted: '199.00',
    currency: 'USD', cardBrand: 'Visa', cardLast4: '1111', billingEmail: 'owner@autos.test',
  },
  notice: { level: 'error', code: 'BILLING_SUSPENDED' },
};

beforeEach(() => {
  apiMock.mockReset();
  localStorage.clear();
});

describe('the hold screen', () => {
  it('tells a non-paying tenant what happened and how to fix it', async () => {
    apiMock.mockResolvedValue(SELF);
    render(<TenantSuspendedHold
      me={{ role: 'ADMIN', tenantStatus: 'SUSPENDED', tenantBillingSuspendedAt: '2026-09-08T00:00:00.000Z' }}
      logout={() => {}}
    />);

    expect(screen.getByText(/account is on hold/i)).toBeTruthy();
    await waitFor(() => expect(document.body.textContent).toMatch(/RFM Pro/));
    expect(document.body.textContent).toMatch(/199\.00/);
    expect(document.body.textContent).toMatch(/1111/);
    // The date it lapsed, rendered in UTC.
    expect(document.body.textContent).toMatch(/2026-09-08/);
  });

  it('NEVER renders a card form — the remedy is an emailed link', async () => {
    apiMock.mockResolvedValue(SELF);
    render(<TenantSuspendedHold
      me={{ role: 'ADMIN', tenantBillingSuspendedAt: '2026-09-08T00:00:00.000Z' }}
      logout={() => {}}
    />);
    await waitFor(() => expect(document.body.textContent).toMatch(/RFM Pro/));
    // A suspended session must never become a card-entry context.
    expect(document.querySelectorAll('input').length).toBe(0);
    expect(screen.getByText(/Email me a link/i)).toBeTruthy();
  });

  it('emails the link and says which inbox to check', async () => {
    apiMock.mockImplementation((path) => {
      if (path === '/api/billing/self') return Promise.resolve(SELF);
      return Promise.resolve({ sent: true, email: 'owner@autos.test' });
    });
    render(<TenantSuspendedHold me={{ role: 'ADMIN', tenantBillingSuspendedAt: '2026-09-08T00:00:00.000Z' }} logout={() => {}} />);
    fireEvent.click(await screen.findByText(/Email me a link/i));
    await waitFor(() => expect(document.body.textContent).toMatch(/owner@autos\.test/));
  });

  it('a HAND-suspended tenant is not told to go pay a bill', () => {
    apiMock.mockResolvedValue(SELF);
    render(<TenantSuspendedHold me={{ role: 'ADMIN', tenantBillingSuspendedAt: null }} logout={() => {}} />);
    expect(document.body.textContent).toMatch(/Contact Ride/i);
    expect(document.body.textContent).not.toMatch(/payment method/i);
    // And it does not go asking for billing details that do not apply.
    expect(apiMock).not.toHaveBeenCalled();
  });

  it('degrades for a non-admin: the screen still explains, with no dead button', async () => {
    // /api/billing/self is ADMIN-only, so an AGENT's fetch 403s.
    apiMock.mockRejectedValue(Object.assign(new Error('Forbidden'), { status: 403 }));
    render(<TenantSuspendedHold me={{ role: 'AGENT', tenantBillingSuspendedAt: '2026-09-08T00:00:00.000Z' }} logout={() => {}} />);
    await waitFor(() => expect(document.body.textContent).toMatch(/account is on hold/i));
    expect(screen.queryByText(/Email me a link/i)).toBeNull();
  });

  it('always offers a way out', () => {
    apiMock.mockResolvedValue(SELF);
    let out = false;
    render(<TenantSuspendedHold me={{ role: 'ADMIN', tenantBillingSuspendedAt: '2026-09-08T00:00:00.000Z' }} logout={() => { out = true; }} />);
    fireEvent.click(screen.getByText(/Sign out/i));
    expect(out).toBe(true);
  });
});

describe('AuthGate only shows the hold screen when the BACKEND is holding', () => {
  function mount(user) {
    localStorage.setItem('fleet_jwt', 'tok');
    localStorage.setItem('fleet_user', JSON.stringify(user));
    apiMock.mockImplementation((path) => {
      if (path === '/api/auth/me') return Promise.resolve({ user });
      if (path === '/api/billing/self') return Promise.resolve(SELF);
      return Promise.resolve({});
    });
    return render(<AuthGate>{() => <div>THE APP</div>}</AuthGate>);
  }

  it('SHIPS INERT: a SUSPENDED tenant whose backend is not enforcing keeps the app', async () => {
    // tenantAccessHeld is false because TENANT_SUSPENSION_ENFORCEMENT is off.
    // This is the assertion that stops the bundle from enforcing on its own.
    mount({ role: 'ADMIN', tenantStatus: 'SUSPENDED', tenantAccessHeld: false, tenantBillingSuspendedAt: '2026-09-08T00:00:00.000Z' });
    await waitFor(() => expect(screen.getByText('THE APP')).toBeTruthy());
  });

  it('holds when the backend says it is holding', async () => {
    mount({ role: 'ADMIN', tenantStatus: 'SUSPENDED', tenantAccessHeld: true, tenantBillingSuspendedAt: '2026-09-08T00:00:00.000Z' });
    await waitFor(() => expect(document.body.textContent).toMatch(/account is on hold/i));
    expect(screen.queryByText('THE APP')).toBeNull();
  });

  it('SUPER_ADMIN never inherits a tenant hold screen', async () => {
    mount({ role: 'SUPER_ADMIN', tenantStatus: 'SUSPENDED', tenantAccessHeld: true });
    await waitFor(() => expect(screen.getByText('THE APP')).toBeTruthy());
  });

  it('an active tenant is completely unaffected', async () => {
    mount({ role: 'ADMIN', tenantStatus: 'ACTIVE', tenantAccessHeld: false });
    await waitFor(() => expect(screen.getByText('THE APP')).toBeTruthy());
  });
});

describe('the day-0 dashboard banner', () => {
  it('renders NOTHING when there is nothing wrong', async () => {
    apiMock.mockResolvedValue({ tenant: {}, subscription: null, notice: null });
    const { container } = render(<BillingNoticeBanner />);
    await waitFor(() => expect(apiMock).toHaveBeenCalled());
    expect(container.querySelector('[data-testid="billing-notice"]')).toBeNull();
  });

  it('renders nothing for a user who cannot see billing (403)', async () => {
    apiMock.mockRejectedValue(Object.assign(new Error('Forbidden'), { status: 403 }));
    const { container } = render(<BillingNoticeBanner />);
    await waitFor(() => expect(apiMock).toHaveBeenCalled());
    expect(container.querySelector('[data-testid="billing-notice"]')).toBeNull();
  });

  it('DAY 0: warns on the first decline and says how long they have', async () => {
    apiMock.mockResolvedValue({
      tenant: {}, subscription: {},
      notice: { level: 'warning', code: 'BILLING_PAST_DUE', daysRemaining: 4, graceDays: 6 },
    });
    render(<BillingNoticeBanner />);
    await waitFor(() => expect(document.body.textContent).toMatch(/did not go through/i));
    expect(document.body.textContent).toMatch(/paused in 4 days/i);
    // The remedy, not just the problem.
    expect(screen.getByText(/Email me a payment link/i)).toBeTruthy();
  });

  it('says "today" rather than "in 0 days" on the last day', async () => {
    apiMock.mockResolvedValue({
      tenant: {}, subscription: {},
      notice: { level: 'warning', code: 'BILLING_PAST_DUE', daysRemaining: 0, graceDays: 6 },
    });
    render(<BillingNoticeBanner />);
    await waitFor(() => expect(document.body.textContent).toMatch(/paused today/i));
    expect(document.body.textContent).not.toMatch(/in 0 days/i);
  });

  it('never claims Authorize.Net will retry on its own', async () => {
    apiMock.mockResolvedValue({
      tenant: {}, subscription: {},
      notice: { level: 'warning', code: 'BILLING_PAST_DUE', daysRemaining: 3, graceDays: 6 },
    });
    render(<BillingNoticeBanner />);
    await waitFor(() => expect(document.body.textContent).toMatch(/did not go through/i));
    // The verified behaviour: retries resume only AFTER the card is updated.
    expect(document.body.textContent).toMatch(/once the card is updated/i);
    expect(document.body.textContent).toMatch(/waiting on its own does not fix it/i);
    // And no invented attempt counter.
    expect(document.body.textContent).not.toMatch(/attempt \d of \d/i);
  });

  it('a suspended account gets the error banner with no dismiss', async () => {
    apiMock.mockResolvedValue({ tenant: {}, subscription: {}, notice: { level: 'error', code: 'BILLING_SUSPENDED' } });
    render(<BillingNoticeBanner />);
    await waitFor(() => expect(document.body.textContent).toMatch(/on hold for non-payment/i));
    expect(screen.queryByText(/^Hide$/)).toBeNull();
  });
});
