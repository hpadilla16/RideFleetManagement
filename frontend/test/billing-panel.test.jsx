/**
 * The SUPER_ADMIN billing panel — Phase 4.
 *
 * Pinned here, in order of cost-of-being-wrong:
 *
 *  1. THE PANEL NEVER CLAIMS A RETRY IT DID NOT PERFORM. Verified behaviour:
 *     a declined ARB payment suspends the subscription and Authorize.Net retries
 *     nightly ONLY once the payment method is updated — no fixed attempt count,
 *     no predictable next-retry date. The approved mockup drew "Reintentar cobro
 *     ahora" and "Intento 2 de 3"; both are fiction and neither may reach the
 *     screen. This is asserted on the rendered output, not on intent.
 *  2. SUSPEND DOES NOT OVERSELL ITSELF. The staff-app lockout does not exist yet
 *     (it is a later phase), so the dialog must say so rather than promise it.
 *  3. Billing dates render in UTC. A YYYY-MM-DD rendered locally shows the day
 *     BEFORE the one Authorize.Net charges.
 *  4. Cancel is gated on a typed phrase AND a reason before it can be submitted.
 *  5. A tenant with no subscription is a visible row, not an omission.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const { apiMock } = vi.hoisted(() => ({ apiMock: vi.fn() }));
vi.mock('../src/lib/client', () => ({
  API_BASE: 'http://test',
  api: (...args) => apiMock(...args),
}));

const { BillingOverviewClient, billingDate, money, applyFilter, applySearch, sortBySeverity } =
  await import('../src/app/tenants/billing/BillingOverviewClient');
const { TenantBillingDetailClient, CANCEL_CONFIRMATION } =
  await import('../src/app/tenants/billing/[tenantId]/TenantBillingDetailClient');

function row(over = {}) {
  return {
    tenantId: 't1',
    tenantName: 'Corpusa Fleet',
    tenantSlug: 'corpusa-fleet',
    tenantStatus: 'ACTIVE',
    entitlementPlan: 'PRO',
    status: 'ACTIVE',
    subscriptionId: 's1',
    planCode: 'PRO',
    planName: 'RFM Pro',
    amount: '199',
    currency: 'USD',
    intervalUnit: 'months',
    intervalLength: 1,
    startDate: '2026-04-19',
    nextChargeDate: '2026-09-19',
    cardBrand: 'Visa',
    cardLast4: '1881',
    cardExpiry: null,
    planDiverges: false,
    lastCharge: null,
    monthlyValue: 199,
    ...over,
  };
}

const TOTALS = {
  mrr: 199, active: 1, trialing: 0, pastDue: 0, suspended: 0,
  pendingAuthorization: 0, neverEnrolled: 0, planDiverges: 0, cardExpiring: 0,
};

const HEALTH = {
  lastEventAt: '2026-08-26T09:27:00Z', hoursSinceLastEvent: 0.2, eventsLast24h: 38,
  unprocessed: 0, unprocessedStuck: 0, liveSubscriptions: 1, silenceAlarm: false, recentEvents: [],
};

function detail(over = {}) {
  return {
    tenant: { id: 't1', name: 'Corpusa Fleet', slug: 'corpusa-fleet', status: 'ACTIVE', plan: 'PRO' },
    subscription: {
      id: 's1', status: 'PAST_DUE', planCode: 'PRO', planName: 'RFM Pro', amount: '199', currency: 'USD',
      intervalUnit: 'months', intervalLength: 1, startDate: '2026-04-19', nextChargeDate: '2026-09-19',
      currentPeriodStart: '2026-08-19', currentPeriodEnd: '2026-09-18', trialEndsAt: null,
      cardBrand: 'Visa', cardLast4: '1881', cardExpMonth: 11, cardExpYear: 2027, cardExpiry: null,
      arbSubscriptionId: '9471226', customerProfileId: '1928374650',
      failedAttempts: 2, pastDueSince: '2026-08-19T00:00:00Z',
      authorizedAt: '2026-04-19T18:22:00Z', authorizedIp: '24.55.18.203',
      authorizedEmail: 'rmarrero@corpusafleet.test',
      authorizedDisclosureText: 'Corpusa Fleet autoriza a Ride Car Sharing LLC…',
      authorizedDisclosureHash: '4f2b9ac1deadbeef',
    },
    history: [],
    charges: [{
      id: 'c1', kind: 'RECURRING', status: 'DECLINED', amount: '199', currency: 'USD',
      chargeDate: '2026-08-19', periodStart: '2026-08-19', periodEnd: '2026-09-18',
      description: 'Suscripción RFM Pro — mensualidad del 19 de agosto al 18 de septiembre de 2026.',
      transId: null, responseCode: '2', responseReasonText: 'This transaction has been declined.',
    }],
    events: [],
    invites: [],
    planDiverges: false,
    ...over,
  };
}

beforeEach(() => {
  apiMock.mockReset();
});

describe('billing overview', () => {
  const wire = (rows, totals = TOTALS) => apiMock.mockImplementation((path) => {
    if (path.includes('/health')) return Promise.resolve(HEALTH);
    return Promise.resolve({ rows, totals, asOf: '2026-08-26' });
  });

  it('shows a never-enrolled tenant as a row rather than omitting it', async () => {
    wire([row({ status: 'NONE', planCode: null, amount: null, subscriptionId: null, nextChargeDate: null, cardLast4: null })],
      { ...TOTALS, active: 0, neverEnrolled: 1, mrr: 0 });
    render(<BillingOverviewClient token="t" />);
    expect(await screen.findByText('Corpusa Fleet')).toBeInTheDocument();
    // Appears as the KPI label, the filter tab and the row's own chip.
    expect(screen.getAllByText('Never enrolled').length).toBeGreaterThan(0);
    // The gap must be legible as a gap: they use the product and pay nothing.
    expect(screen.getAllByText(/billed nothing/i).length).toBeGreaterThan(0);
  });

  it('states the past-due truth and offers the card path — never an attempt count', async () => {
    wire([row({ status: 'PAST_DUE' })], { ...TOTALS, active: 0, pastDue: 1 });
    render(<BillingOverviewClient token="t" />);
    await screen.findByText('Past due');
    expect(screen.getByText(/Suspended at Authorize\.Net — needs a new card/i)).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/attempt \d+ of \d+/i);
    expect(document.body.textContent).not.toMatch(/intento \d+ de \d+/i);
  });

  it('badges a plan divergence, because a silent one is a revenue leak', async () => {
    wire([row({ planDiverges: true, entitlementPlan: 'STARTER' })], { ...TOTALS, planDiverges: 1 });
    render(<BillingOverviewClient token="t" />);
    expect(await screen.findByText('≠ STARTER')).toBeInTheDocument();
  });

  it('warns on an expiring card without calling a still-valid one expired', async () => {
    wire([row({ cardExpiry: { cardExpMonth: 9, cardExpYear: 2026, expired: false } })], { ...TOTALS, cardExpiring: 1 });
    render(<BillingOverviewClient token="t" />);
    expect(await screen.findByText(/expires 09\/26/)).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/EXPIRED/);
  });

  it('raises the silence alarm when the endpoint has gone quiet', async () => {
    apiMock.mockImplementation((path) => {
      if (path.includes('/health')) return Promise.resolve({ ...HEALTH, silenceAlarm: true, liveSubscriptions: 3 });
      return Promise.resolve({ rows: [row()], totals: TOTALS, asOf: '2026-08-26' });
    });
    render(<BillingOverviewClient token="t" />);
    expect(await screen.findByText(/No verified Authorize\.Net webhook has arrived in 72 hours/i)).toBeInTheDocument();
  });

  it('asks the server not to serve a cached list', async () => {
    wire([row()]);
    render(<BillingOverviewClient token="t" />);
    await screen.findByText('Corpusa Fleet');
    expect(apiMock).toHaveBeenCalledWith('/api/tenants/billing/overview', { cacheTtlMs: 0 }, 't');
  });
});

describe('overview pure helpers', () => {
  it('renders billing dates in UTC, so the day matches what ARB will charge', () => {
    expect(billingDate('2026-09-01')).toBe('Sep 1, 2026');
    expect(billingDate('2026-01-01')).toBe('Jan 1, 2026');
    expect(billingDate('')).toBe('—');
  });

  it('formats money and an absent amount distinctly', () => {
    expect(money('1650')).toBe('$1,650.00 USD');
    expect(money(null)).toBe('—');
  });

  it('sorts trouble to the top rather than the alphabet', () => {
    const out = sortBySeverity([
      row({ tenantName: 'Aaa', status: 'ACTIVE' }),
      row({ tenantName: 'Zzz', status: 'PAST_DUE' }),
      row({ tenantName: 'Mmm', status: 'NONE' }),
    ]);
    expect(out.map((r) => r.status)).toEqual(['PAST_DUE', 'NONE', 'ACTIVE']);
  });

  it('filters and searches on what an operator would actually type', () => {
    const rows = [row({ status: 'PAST_DUE' }), row({ tenantId: 't2', tenantName: 'Isla Verde', status: 'ACTIVE' })];
    expect(applyFilter(rows, 'pastDue')).toHaveLength(1);
    expect(applySearch(rows, 'isla')).toHaveLength(1);
    expect(applySearch(rows, '1881')).toHaveLength(2);
    expect(applySearch(rows, '')).toHaveLength(2);
  });
});

describe('billing detail', () => {
  const wire = (d = detail()) => apiMock.mockImplementation(() => Promise.resolve(d));

  it('never shows a retry countdown or a predicted next-retry date', async () => {
    wire();
    render(<TenantBillingDetailClient token="t" tenantId="t1" />);
    await screen.findByText(/Past due since 2026-08-19/i);
    const text = document.body.textContent;
    expect(text).not.toMatch(/attempt \d+ of \d+/i);
    expect(text).not.toMatch(/intento \d+ de \d+/i);
    // No PREDICTED retry date. Scoped to a date-shaped claim so it does not
    // trip on the honest sentence "retries only once the method is updated".
    expect(text).not.toMatch(/retr(y|ies) on \w+ \d/i);
    expect(text).not.toMatch(/next retry|next attempt/i);
    // …and it does say the thing that is actually true.
    expect(text).toMatch(/only once the payment method is updated/i);
    expect(text).toMatch(/no fixed number of attempts/i);
  });

  it('offers the new-card link and a read-only re-check, not a force-a-charge button', async () => {
    wire();
    render(<TenantBillingDetailClient token="t" tenantId="t1" />);
    await screen.findAllByText('Send new-card link');
    expect(screen.getAllByText('Re-check at Authorize.Net').length).toBeGreaterThan(0);
    expect(screen.queryByText(/retry charge|retry now|charge now/i)).toBeNull();
  });

  it('renders the stored charge description verbatim', async () => {
    wire();
    render(<TenantBillingDetailClient token="t" tenantId="t1" />);
    expect(
      await screen.findByText('Suscripción RFM Pro — mensualidad del 19 de agosto al 18 de septiembre de 2026.'),
    ).toBeInTheDocument();
  });

  it('holds cancel behind a typed phrase AND a reason', async () => {
    wire();
    render(<TenantBillingDetailClient token="t" tenantId="t1" />);
    fireEvent.click(await screen.findByText('Cancel subscription'));

    const submit = await screen.findByText('Cancel at Authorize.Net');
    expect(submit).toBeDisabled();

    fireEvent.change(screen.getByLabelText(/Reason \(required\)/), { target: { value: '30 days notice.' } });
    expect(screen.getByText('Cancel at Authorize.Net')).toBeDisabled();

    fireEvent.change(screen.getByLabelText(new RegExp(`Type ${CANCEL_CONFIRMATION}`)), {
      target: { value: CANCEL_CONFIRMATION },
    });
    expect(screen.getByText('Cancel at Authorize.Net')).not.toBeDisabled();
  });

  it('tells the truth in the cancel dialog about the ARB-first ordering', async () => {
    wire();
    render(<TenantBillingDetailClient token="t" tenantId="t1" />);
    fireEvent.click(await screen.findByText('Cancel subscription'));
    const text = document.body.textContent;
    expect(text).toMatch(/calls Authorize\.Net first/i);
    expect(text).toMatch(/nothing changes on this screen/i);
    expect(text).toMatch(/30 days/i);
  });

  // Phase 5 (2026-08-28): the staff lockout now EXISTS, but is gated on
  // TENANT_SUSPENSION_ENFORCEMENT — a deploy variable the browser cannot see.
  // So the dialog is no longer allowed to hard-code either answer, and the
  // original "does not exist yet" assertion becomes these two.
  it('with enforcement OFF, it still refuses to promise a lockout', async () => {
    wire(detail({ suspensionEnforcement: 'off' }));
    render(<TenantBillingDetailClient token="t" tenantId="t1" />);
    fireEvent.click(await screen.findByText('Suspend access'));
    const text = document.body.textContent;
    expect(text).toMatch(/What does NOT stop/i);
    expect(text).toMatch(/staff can still sign in/i);
    expect(text).toMatch(/switched OFF on this deploy/i);
    // The real, present-tense consequences.
    expect(text).toMatch(/public booking website goes dark/i);
    expect(text).toMatch(/integration syncs/i);
  });

  it('a payload with no enforcement field is read as OFF, not as a lockout', async () => {
    // An unknown enforcement state must never be described as a lockout.
    wire(detail());
    render(<TenantBillingDetailClient token="t" tenantId="t1" />);
    fireEvent.click(await screen.findByText('Suspend access'));
    expect(document.body.textContent).toMatch(/staff can still sign in/i);
  });

  it('with enforcement ON, it says the staff ARE locked out — and what they keep', async () => {
    wire(detail({ suspensionEnforcement: 'enforce' }));
    render(<TenantBillingDetailClient token="t" tenantId="t1" />);
    fireEvent.click(await screen.findByText('Suspend access'));
    const text = document.body.textContent;
    expect(text).toMatch(/staff are locked out/i);
    expect(text).not.toMatch(/staff can still sign in/i);
    // The three carve-outs, stated to the operator BEFORE they pull the lever.
    expect(text).toMatch(/billing page/i);
    expect(text).toMatch(/close out rentals/i);
    expect(text).toMatch(/shuttle tracker/i);
  });

  it('requires a suspension reason before it can be submitted', async () => {
    wire();
    render(<TenantBillingDetailClient token="t" tenantId="t1" />);
    fireEvent.click(await screen.findByText('Suspend access'));
    expect(screen.getByText('Suspend this tenant')).toBeDisabled();
    fireEvent.change(screen.getByLabelText(/Reason/), { target: { value: 'Impago 7 días.' } });
    expect(screen.getByText('Suspend this tenant')).not.toBeDisabled();
  });

  it('posts the cancel with the phrase and reason the operator typed', async () => {
    wire();
    render(<TenantBillingDetailClient token="t" tenantId="t1" />);
    fireEvent.click(await screen.findByText('Cancel subscription'));
    fireEvent.change(screen.getByLabelText(/Reason \(required\)/), { target: { value: '30 days notice.' } });
    fireEvent.change(screen.getByLabelText(new RegExp(`Type ${CANCEL_CONFIRMATION}`)), {
      target: { value: CANCEL_CONFIRMATION },
    });
    fireEvent.click(screen.getByText('Cancel at Authorize.Net'));

    await waitFor(() => {
      expect(apiMock).toHaveBeenCalledWith(
        '/api/tenants/billing/subscriptions/s1/cancel',
        { method: 'POST', body: JSON.stringify({ reason: '30 days notice.', confirm: CANCEL_CONFIRMATION }) },
        't',
      );
    });
  });

  it('surfaces the archived consent, expandable, verbatim', async () => {
    wire();
    render(<TenantBillingDetailClient token="t" tenantId="t1" />);
    fireEvent.click(await screen.findByText(/Show the exact text they agreed to/i));
    expect(screen.getByText('Corpusa Fleet autoriza a Ride Car Sharing LLC…')).toBeInTheDocument();
  });

  it('offers apply-plan only when billing and entitlement actually disagree', async () => {
    wire();
    render(<TenantBillingDetailClient token="t" tenantId="t1" />);
    await screen.findByText('Actions');
    expect(screen.queryByText('Apply billing plan to entitlements')).toBeNull();

    apiMock.mockReset();
    apiMock.mockImplementation(() => Promise.resolve(detail({
      planDiverges: true,
      tenant: { id: 't1', name: 'Corpusa Fleet', slug: 'c', status: 'ACTIVE', plan: 'STARTER' },
    })));
    render(<TenantBillingDetailClient token="t" tenantId="t1" />);
    expect(await screen.findByText('Apply billing plan to entitlements')).toBeInTheDocument();
  });

  it('says a never-enrolled tenant is billed nothing and points at Tenants', async () => {
    wire(detail({ subscription: null, charges: [] }));
    render(<TenantBillingDetailClient token="t" tenantId="t1" />);
    expect(await screen.findByText(/has no subscription/i)).toBeInTheDocument();
    expect(screen.getAllByText(/billed nothing/i).length).toBeGreaterThan(0);
  });

  // RESTORE NAMES THE STATUS IT WILL ACTUALLY SET (2026-08-28).
  //
  // Tenant.status is free text and 'ACTIVE' is load-bearing: the public booking
  // token resolver, the booking-engine tenant resolution and the car-sharing
  // marketplace list all match `status: 'ACTIVE'` exactly. Restore used to
  // hardcode ACTIVE, which would have PUBLISHED a demo tenant onto the public
  // booking site rather than merely relabelling it. The dialog must therefore
  // never say "turns the public booking site back on" unconditionally.

  it('the restore dialog names a non-ACTIVE status and refuses to promise publication', async () => {
    wire(detail({
      tenant: {
        id: 't1', name: 'Corpusa Fleet', slug: 'c', status: 'SUSPENDED', plan: 'PRO',
        billingSuspendedAt: '2026-08-28T00:00:00Z', billingPreviousStatus: 'DEMO', restoresToStatus: 'DEMO',
      },
    }));
    render(<TenantBillingDetailClient token="t" tenantId="t1" />);
    fireEvent.click(await screen.findByText('Restore access'));
    const text = document.body.textContent;
    expect(text).toMatch(/Returns this tenant to\s*Demo/i);
    expect(text).toMatch(/public booking site stays dark/i);
    // The old copy's promise must not survive for a tenant it is false for.
    expect(text).not.toMatch(/booking site and integration syncs come back on/i);
  });

  it('the restore dialog says Active when that is what it will set', async () => {
    wire(detail({
      tenant: {
        id: 't1', name: 'Corpusa Fleet', slug: 'c', status: 'SUSPENDED', plan: 'PRO',
        billingSuspendedAt: '2026-08-28T00:00:00Z', billingPreviousStatus: 'ACTIVE', restoresToStatus: 'ACTIVE',
      },
    }));
    render(<TenantBillingDetailClient token="t" tenantId="t1" />);
    fireEvent.click(await screen.findByText('Restore access'));
    const text = document.body.textContent;
    expect(text).toMatch(/Returns this tenant to\s*Active/i);
    expect(text).toMatch(/come back on/i);
  });

  it('the dialog never re-derives the rule: a recorded SUSPENDED shows ACTIVE, as the server resolved it', async () => {
    // The one branch where the raw recorded value and the resolved outcome
    // DISAGREE. A dialog deriving its own answer from billingPreviousStatus
    // would say "Suspended ... stays dark" while the server publishes them.
    wire(detail({
      tenant: {
        id: 't1', name: 'Corpusa Fleet', slug: 'c', status: 'SUSPENDED', plan: 'PRO',
        billingSuspendedAt: '2026-08-28T00:00:00Z',
        billingPreviousStatus: 'SUSPENDED', restoresToStatus: 'ACTIVE',
      },
    }));
    render(<TenantBillingDetailClient token="t" tenantId="t1" />);
    fireEvent.click(await screen.findByText('Restore access'));
    const text = document.body.textContent;
    expect(text).toMatch(/Returns this tenant to\s*Active/i);
    expect(text).toMatch(/come back on/i);
    expect(text).not.toMatch(/stays dark/i);
  });

  it('a payload with no recorded previous status reads as Active, matching the service fallback', async () => {
    // billingPreviousStatus is null for a tenant suspended before the column
    // existed. The service falls back to ACTIVE there, and the dialog must say
    // the same thing rather than hedge about what it does not know.
    wire(detail({
      tenant: {
        id: 't1', name: 'Corpusa Fleet', slug: 'c', status: 'SUSPENDED', plan: 'PRO',
        billingSuspendedAt: '2026-08-28T00:00:00Z', restoresToStatus: 'ACTIVE',
      },
    }));
    render(<TenantBillingDetailClient token="t" tenantId="t1" />);
    fireEvent.click(await screen.findByText('Restore access'));
    const text = document.body.textContent;
    expect(text).toMatch(/Returns this tenant to\s*Active/i);
    // And it SAYS the value was missing rather than implying it was read.
    expect(text).toMatch(/no earlier status was recorded/i);
  });

  // ── Phase 6: plan changes ────────────────────────────────────────────────

  const ACTIVE_SUB = {
    ...detail().subscription,
    status: 'ACTIVE',
    pastDueSince: null,
    failedAttempts: 0,
  };

  it('renders a scheduled change on the card, leading with the date the customer feels', async () => {
    wire(detail({
      subscription: {
        ...ACTIVE_SUB,
        pendingPlanCode: 'PRO',
        pendingAmount: '249',
        pendingEffectiveDate: '2026-09-18',
      },
    }));
    render(<TenantBillingDetailClient token="t" tenantId="t1" />);
    const notes = await screen.findAllByText(/Scheduled change/i);
    expect(notes.length).toBeGreaterThan(0);
    const text = document.body.textContent;
    // The charge date, not only the boundary date — "applies on the 18th" alone
    // invites a support call on the 19th.
    expect(text).toMatch(/first charged at the new price on\s*Sep 19, 2026/i);
    expect(text).toMatch(/\$249\.00 USD/);
    expect(text).toMatch(/no money\s*moves when it applies/i);
    // A pending change swaps the action: undo, not a second schedule.
    expect(screen.getByText('Cancel scheduled change')).toBeInTheDocument();
    expect(screen.queryByText('Change plan / amount')).toBeNull();
  });

  it('cancelling the scheduled change posts the undo — no dialog, nothing has happened yet', async () => {
    wire(detail({
      subscription: { ...ACTIVE_SUB, pendingPlanCode: 'PRO', pendingAmount: '249', pendingEffectiveDate: '2026-09-18' },
    }));
    render(<TenantBillingDetailClient token="t" tenantId="t1" />);
    fireEvent.click(await screen.findByText('Cancel scheduled change'));
    await waitFor(() => {
      expect(apiMock).toHaveBeenCalledWith(
        '/api/tenants/billing/subscriptions/s1/plan-change/cancel',
        { method: 'POST', body: JSON.stringify({}) },
        't',
      );
    });
  });

  it('the plan-change dialog refuses to commit before a preview — the number must be read first', async () => {
    wire(detail({ subscription: ACTIVE_SUB }));
    render(<TenantBillingDetailClient token="t" tenantId="t1" />);
    fireEvent.click(await screen.findByText('Change plan / amount'));

    // The honest default, stated before any field is touched.
    expect(document.body.textContent).toMatch(/no money moves today/i);
    expect(screen.getByText('Schedule the change')).toBeDisabled();
  });

  it('preview then schedule: posts the previewed values, no prorate flag by default', async () => {
    const previewPayload = {
      from: { planCode: 'PRO', planName: 'RFM Pro', amount: '199' },
      to: { planCode: 'PRO', planName: 'RFM Pro', amount: '249' },
      noChange: false,
      upgrade: true,
      effectiveDate: '2026-09-18',
      firstChargedOn: '2026-09-19',
      prorationAvailable: true,
      proration: {
        periodDays: 31, remainingDays: 3, dailyDelta: 1.6129, proration: 4.84, belowFloor: false, floor: 1,
        description: 'Ajuste por cambio de plan: 3 día(s) restante(s)…',
      },
      hasPendingChange: false,
    };
    apiMock.mockImplementation((path) => {
      if (path.endsWith('/plan-change/preview')) return Promise.resolve(previewPayload);
      if (path.endsWith('/plan-change')) return Promise.resolve({ ok: true });
      return Promise.resolve(detail({ subscription: ACTIVE_SUB }));
    });

    render(<TenantBillingDetailClient token="t" tenantId="t1" />);
    fireEvent.click(await screen.findByText('Change plan / amount'));
    fireEvent.change(screen.getByLabelText(/Amount/), { target: { value: '249' } });
    fireEvent.click(screen.getByText('Preview'));

    // The preview names the charge date and offers — never presumes — proration.
    await screen.findByText(/first charged on/i);
    expect(document.body.textContent).toMatch(/Sep 19, 2026/);
    const check = screen.getByLabelText(/charge the prorated difference/i);
    expect(check).not.toBeChecked();

    const submit = screen.getByText('Schedule the change');
    expect(submit).not.toBeDisabled();
    fireEvent.click(submit);
    await waitFor(() => {
      expect(apiMock).toHaveBeenCalledWith(
        '/api/tenants/billing/subscriptions/s1/plan-change',
        { method: 'POST', body: JSON.stringify({ planCode: 'PRO', amount: '249' }) },
        't',
      );
    });
  });

  it('opting into proration shows the exact stored sentence and echoes the previewed number', async () => {
    const previewPayload = {
      from: { planCode: 'PRO', planName: 'RFM Pro', amount: '199' },
      to: { planCode: 'PRO', planName: 'RFM Pro', amount: '249' },
      noChange: false,
      upgrade: true,
      effectiveDate: '2026-09-18',
      firstChargedOn: '2026-09-19',
      prorationAvailable: true,
      proration: {
        periodDays: 31, remainingDays: 3, dailyDelta: 1.6129, proration: 4.84, belowFloor: false, floor: 1,
        description: 'Ajuste por cambio de plan: 3 día(s) restante(s) del ciclo…',
      },
      hasPendingChange: false,
    };
    apiMock.mockImplementation((path) => {
      if (path.endsWith('/plan-change/preview')) return Promise.resolve(previewPayload);
      if (path.endsWith('/plan-change')) return Promise.resolve({ ok: true });
      return Promise.resolve(detail({ subscription: ACTIVE_SUB }));
    });

    render(<TenantBillingDetailClient token="t" tenantId="t1" />);
    fireEvent.click(await screen.findByText('Change plan / amount'));
    fireEvent.change(screen.getByLabelText(/Amount/), { target: { value: '249' } });
    fireEvent.click(screen.getByText('Preview'));
    fireEvent.click(await screen.findByLabelText(/charge the prorated difference/i));

    // §7.2: the exact sentence the ledger will store, before the money moves.
    expect(screen.getByText(/Ajuste por cambio de plan: 3 día/)).toBeInTheDocument();

    fireEvent.click(screen.getByText('Charge now and change the plan'));
    await waitFor(() => {
      expect(apiMock).toHaveBeenCalledWith(
        '/api/tenants/billing/subscriptions/s1/plan-change',
        { method: 'POST', body: JSON.stringify({ planCode: 'PRO', amount: '249', prorateNow: true, expectedProration: 4.84 }) },
        't',
      );
    });
  });

  it('editing a field voids the preview — a stale number cannot be committed', async () => {
    const previewPayload = {
      from: { planCode: 'PRO', planName: 'RFM Pro', amount: '199' },
      to: { planCode: 'PRO', planName: 'RFM Pro', amount: '249' },
      noChange: false, upgrade: true, effectiveDate: '2026-09-18', firstChargedOn: '2026-09-19',
      prorationAvailable: false, proration: null, hasPendingChange: false,
    };
    apiMock.mockImplementation((path) => {
      if (path.endsWith('/plan-change/preview')) return Promise.resolve(previewPayload);
      return Promise.resolve(detail({ subscription: ACTIVE_SUB }));
    });
    render(<TenantBillingDetailClient token="t" tenantId="t1" />);
    fireEvent.click(await screen.findByText('Change plan / amount'));
    fireEvent.change(screen.getByLabelText(/Amount/), { target: { value: '249' } });
    fireEvent.click(screen.getByText('Preview'));
    await waitFor(() => expect(screen.getByText('Schedule the change')).not.toBeDisabled());

    fireEvent.change(screen.getByLabelText(/Amount/), { target: { value: '299' } });
    expect(screen.getByText('Schedule the change')).toBeDisabled();
  });

  it('warns that a hand-set suspension is not billing\'s to lift', async () => {
    wire(detail({
      tenant: { id: 't1', name: 'Corpusa Fleet', slug: 'c', status: 'SUSPENDED', plan: 'PRO', billingSuspendedAt: null },
    }));
    render(<TenantBillingDetailClient token="t" tenantId="t1" />);
    expect(await screen.findByText(/NOT set by billing/i)).toBeInTheDocument();
  });
});
