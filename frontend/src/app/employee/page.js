'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { AuthGate } from '../../components/AuthGate';
import { AppShell } from '../../components/AppShell';
import { MobileAppShell } from '../../components/MobileAppShell';
import { api } from '../../lib/client';

const EMPTY_FORM = {
  reservationNumber: '',
  customerId: '',
  vehicleTypeId: '',
  pickupAt: '',
  returnAt: '',
  pickupLocationId: '',
  returnLocationId: '',
  notes: ''
};

const EMPLOYEE_SEARCH_KEY = 'employee.search';
const EMPLOYEE_CREATE_FORM_KEY = 'employee.createForm';

function formatMoney(value) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(Number(value || 0));
}

function formatDateTime(value) {
  if (!value) return '-';
  try {
    return new Date(value).toLocaleString();
  } catch {
    return String(value);
  }
}

function statusClass(status) {
  const current = String(status || '').toUpperCase();
  if (['CHECKED_OUT', 'CHECKED_IN', 'READY_FOR_PICKUP'].includes(current)) return 'status-chip good';
  if (['CANCELLED', 'NO_SHOW', 'DENIED'].includes(current)) return 'status-chip warn';
  return 'status-chip neutral';
}

function customerName(row) {
  return [row?.customer?.firstName, row?.customer?.lastName].filter(Boolean).join(' ') || row?.customer?.email || 'Guest';
}

function restoreCreateForm() {
  if (typeof window === 'undefined') return EMPTY_FORM;
  try {
    const raw = localStorage.getItem(EMPLOYEE_CREATE_FORM_KEY);
    if (!raw) return EMPTY_FORM;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return EMPTY_FORM;
    return {
      ...EMPTY_FORM,
      reservationNumber: typeof parsed.reservationNumber === 'string' ? parsed.reservationNumber : '',
      customerId: typeof parsed.customerId === 'string' ? parsed.customerId : '',
      vehicleTypeId: typeof parsed.vehicleTypeId === 'string' ? parsed.vehicleTypeId : '',
      pickupAt: typeof parsed.pickupAt === 'string' ? parsed.pickupAt : '',
      returnAt: typeof parsed.returnAt === 'string' ? parsed.returnAt : '',
      pickupLocationId: typeof parsed.pickupLocationId === 'string' ? parsed.pickupLocationId : '',
      returnLocationId: typeof parsed.returnLocationId === 'string' ? parsed.returnLocationId : '',
      notes: typeof parsed.notes === 'string' ? parsed.notes : ''
    };
  } catch {
    return EMPTY_FORM;
  }
}

function vehicleLabel(row) {
  if (row?.vehicle) return [row.vehicle.year, row.vehicle.make, row.vehicle.model].filter(Boolean).join(' ');
  return row?.vehicleType?.name || 'Unassigned vehicle';
}

function incidentStatusClass(status) {
  const current = String(status || '').toUpperCase();
  if (['RESOLVED', 'CLOSED'].includes(current)) return 'status-chip good';
  if (['OPEN', 'UNDER_REVIEW'].includes(current)) return 'status-chip warn';
  return 'status-chip neutral';
}

function workflowLabel(row) {
  const mode = String(row?.workflowMode || 'RENTAL').toUpperCase();
  if (mode === 'DEALERSHIP_LOANER') return 'Dealership Loaner';
  if (mode === 'CAR_SHARING') return 'Car Sharing';
  return 'Rental';
}

function queueContext(row) {
  if (String(row?.workflowMode || '').toUpperCase() !== 'DEALERSHIP_LOANER') return '';
  return [
    row?.repairOrderNumber ? `RO ${row.repairOrderNumber}` : '',
    row?.serviceAdvisorName || '',
    row?.loanerBillingStatus ? `Billing ${String(row.loanerBillingStatus).replaceAll('_', ' ')}` : ''
  ].filter(Boolean).join(' - ');
}

function reservationHref(row, action = '') {
  if (!row?.id) return '#';
  if (!action) return `/reservations/${row.id}`;
  return `/reservations/${row.id}/${action}`;
}

function tripGuestName(trip) {
  return [trip?.guestCustomer?.firstName, trip?.guestCustomer?.lastName].filter(Boolean).join(' ') || trip?.guestCustomer?.email || 'Guest';
}

function issueHeadline(row) {
  return [row?.title, row?.trip?.tripCode || '', row?.trip?.reservation?.reservationNumber || ''].filter(Boolean).join(' - ');
}

function QueueCard({ title, subtitle, rows, emptyText, actions }) {
  return (
    <section className="glass card section-card">
      <div className="section-title">{title}</div>
      <p className="ui-muted" style={{ marginTop: -6 }}>{subtitle}</p>
      {rows.length ? (
        <div className="stack">
          {rows.map((row) => (
            <div key={row.id} className="surface-note" style={{ display: 'grid', gap: 10 }}>
              <div className="row-between" style={{ gap: 12, alignItems: 'start' }}>
                <div>
                  <div style={{ fontWeight: 700 }}>{row.reservationNumber}</div>
                  <div className="label" style={{ textTransform: 'none', letterSpacing: 0, fontSize: 12 }}>
                    {[customerName(row), vehicleLabel(row)].filter(Boolean).join(' - ')}
                  </div>
                  <div className="label" style={{ textTransform: 'none', letterSpacing: 0, fontSize: 12, marginTop: 4 }}>
                    {[workflowLabel(row), queueContext(row)].filter(Boolean).join(' - ')}
                  </div>
                </div>
                <span className={statusClass(row.status)}>{row.status}</span>
              </div>
              <div className="info-grid-tight">
                <div className="info-tile"><span className="label">Pickup</span><strong>{formatDateTime(row.pickupAt)}</strong></div>
                <div className="info-tile"><span className="label">Return</span><strong>{formatDateTime(row.returnAt)}</strong></div>
                <div className="info-tile"><span className="label">Location</span><strong>{row.pickupLocation?.name || '-'}</strong></div>
                <div className="info-tile"><span className="label">Estimate</span><strong>{formatMoney(row.estimatedTotal)}</strong></div>
                {String(row?.workflowMode || '').toUpperCase() === 'DEALERSHIP_LOANER' ? (
                  <>
                    <div className="info-tile"><span className="label">Service ETA</span><strong>{formatDateTime(row.estimatedServiceCompletionAt)}</strong></div>
                    <div className="info-tile"><span className="label">Billing</span><strong>{row.loanerBillingStatus || '-'}</strong></div>
                  </>
                ) : null}
              </div>
              <div className="inline-actions">{actions(row)}</div>
            </div>
          ))}
        </div>
      ) : (
        <div className="surface-note">{emptyText}</div>
      )}
    </section>
  );
}

function IssueQueueCard({ rows }) {
  return (
    <section className="glass card section-card">
      <div className="row-between">
        <div>
          <div className="section-title">Issue Escalations</div>
          <p className="ui-muted" style={{ marginTop: -6 }}>
            Customer service and ops can triage disputes here before moving into the full issue center.
          </p>
        </div>
        <Link href="/issues"><button type="button">Open Issue Center</button></Link>
      </div>
      {rows.length ? (
        <div className="stack">
          {rows.map((row) => (
            <div key={row.id} className="surface-note" style={{ display: 'grid', gap: 10 }}>
              <div className="row-between" style={{ gap: 12, alignItems: 'start' }}>
                <div>
                  <div style={{ fontWeight: 700 }}>{row.title}</div>
                  <div className="label" style={{ textTransform: 'none', letterSpacing: 0, fontSize: 12 }}>
                    {[row.trip?.tripCode || '-', row.type, tripGuestName(row.trip), row.trip?.hostProfile?.displayName || ''].filter(Boolean).join(' - ')}
                  </div>
                </div>
                <span className={incidentStatusClass(row.status)}>{row.status}</span>
              </div>
              <div className="info-grid-tight">
                <div className="info-tile"><span className="label">Trip</span><strong>{row.trip?.status || '-'}</strong></div>
                <div className="info-tile"><span className="label">Claimed</span><strong>{formatMoney(row.amountClaimed)}</strong></div>
                <div className="info-tile"><span className="label">Created</span><strong>{formatDateTime(row.createdAt)}</strong></div>
                <div className="info-tile"><span className="label">Reservation</span><strong>{row.trip?.reservation?.reservationNumber || '-'}</strong></div>
              </div>
              <div style={{ color: '#55456f', lineHeight: 1.5 }}>{row.description || 'No description provided.'}</div>
              <div className="inline-actions">
                <Link href="/issues"><button type="button">Handle Case</button></Link>
                {row.trip?.reservation?.id ? (
                  <Link href={`/reservations/${row.trip.reservation.id}`}>
                    <button type="button" className="button-subtle">Open Workflow</button>
                  </Link>
                ) : null}
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="surface-note">No issue escalations are open right now.</div>
      )}
    </section>
  );
}

function OpsLaneCard({ title, count, note, href, cta, tone = 'neutral' }) {
  const chipClass = tone === 'warn' ? 'status-chip warn' : tone === 'good' ? 'status-chip good' : 'status-chip neutral';
  return (
    <div className="doc-card">
      <div className="row-between" style={{ marginBottom: 0, alignItems: 'start' }}>
        <div style={{ display: 'grid', gap: 6 }}>
          <span className="label">{title}</span>
          <strong style={{ fontSize: 28, color: '#241b41' }}>{count}</strong>
        </div>
        <span className={chipClass}>{tone === 'warn' ? 'Attention' : tone === 'good' ? 'Ready' : 'Live'}</span>
      </div>
      <div className="doc-meta">{note}</div>
      {href ? (
        <div className="inline-actions">
          <Link href={href}>
            <button type="button" className="button-subtle">{cta || 'Open'}</button>
          </Link>
        </div>
      ) : null}
    </div>
  );
}

export default function EmployeeAppPage() {
  return <AuthGate>{({ token, me, logout }) => <EmployeeAppInner token={token} me={me} logout={logout} />}</AuthGate>;
}

function EmployeeAppInner({ token, me, logout }) {
  const [dashboard, setDashboard] = useState(null);
  const [customers, setCustomers] = useState([]);
  const [locations, setLocations] = useState([]);
  const [vehicleTypes, setVehicleTypes] = useState([]);
  const [search, setSearch] = useState(() => {
    if (typeof window === 'undefined') return '';
    try { return localStorage.getItem(EMPLOYEE_SEARCH_KEY) || ''; } catch { return ''; }
  });
  const [loading, setLoading] = useState(true);
  const [msg, setMsg] = useState('');
  const [createForm, setCreateForm] = useState(() => restoreCreateForm());

  const metrics = dashboard?.metrics || {
    openReservations: 0,
    activeRentals: 0,
    precheckinQueue: 0,
    readyForPickup: 0,
    dueBackToday: 0,
    loanerOpen: 0,
    loanerReady: 0,
    loanerBillingAttention: 0,
    loanerOverdue: 0,
    issueOpen: 0,
    issueUnderReview: 0
  };

  async function load(query = '') {
    try {
      setLoading(true);
      const [dash, customersOut, locationsOut, typesOut] = await Promise.allSettled([
        api(`/api/employee-app/dashboard${query ? `?q=${encodeURIComponent(query)}` : ''}`, {}, token),
        api('/api/customers', {}, token),
        api('/api/locations', {}, token),
        api('/api/vehicle-types', {}, token)
      ]);
      if (dash.status === 'fulfilled') setDashboard(dash.value || null);
      else setDashboard(null);
      if (customersOut.status === 'fulfilled') setCustomers(Array.isArray(customersOut.value) ? customersOut.value : []);
      else setCustomers([]);
      if (locationsOut.status === 'fulfilled') setLocations(Array.isArray(locationsOut.value) ? locationsOut.value : []);
      else setLocations([]);
      if (typesOut.status === 'fulfilled') setVehicleTypes(Array.isArray(typesOut.value) ? typesOut.value : []);
      else setVehicleTypes([]);

      if (dash.status === 'rejected') setMsg(dash.reason?.message || 'Unable to load employee app');
      else if ([customersOut, locationsOut, typesOut].some((row) => row.status === 'rejected')) setMsg('Employee app loaded with limited supporting data');
      else setMsg('');
    } catch (error) {
      setDashboard(null);
      setMsg(error.message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load(search.trim());
  }, [token]);
  useEffect(() => {
    try {
      if (search) localStorage.setItem(EMPLOYEE_SEARCH_KEY, search);
      else localStorage.removeItem(EMPLOYEE_SEARCH_KEY);
    } catch {}
  }, [search]);
  useEffect(() => {
    try {
      const hasDraft = Object.values(createForm).some((value) => value);
      if (hasDraft) localStorage.setItem(EMPLOYEE_CREATE_FORM_KEY, JSON.stringify(createForm));
      else localStorage.removeItem(EMPLOYEE_CREATE_FORM_KEY);
    } catch {}
  }, [createForm]);

  const quickCreateReady = useMemo(() => (
    !!(
      createForm.reservationNumber &&
      createForm.customerId &&
      createForm.vehicleTypeId &&
      createForm.pickupAt &&
      createForm.returnAt &&
      createForm.pickupLocationId &&
      createForm.returnLocationId
    )
  ), [createForm]);

  const nextUpItems = useMemo(() => {
    const checkout = dashboard?.queues?.checkout?.[0];
    const returns = dashboard?.queues?.returns?.[0];
    const loanerBilling = dashboard?.queues?.loanerBillingReview?.[0];
    const issue = dashboard?.queues?.issueEscalations?.[0];

    return [
      checkout ? {
        key: 'checkout',
        label: 'Next Pickup',
        title: checkout.reservationNumber,
        detail: `${customerName(checkout)} - ${formatDateTime(checkout.pickupAt)}`,
        note: [workflowLabel(checkout), checkout.pickupLocation?.name || ''].filter(Boolean).join(' - '),
        href: reservationHref(checkout, 'checkout'),
        cta: 'Start Checkout',
        tone: 'good'
      } : null,
      returns ? {
        key: 'return',
        label: 'Next Return',
        title: returns.reservationNumber,
        detail: `${customerName(returns)} - ${formatDateTime(returns.returnAt)}`,
        note: [workflowLabel(returns), vehicleLabel(returns)].filter(Boolean).join(' - '),
        href: reservationHref(returns, 'checkin'),
        cta: 'Run Check-in',
        tone: 'warn'
      } : null,
      loanerBilling ? {
        key: 'loaner-billing',
        label: 'Loaner Billing Blocker',
        title: loanerBilling.reservationNumber,
        detail: `${loanerBilling.loanerBillingStatus || 'Pending'} - ${customerName(loanerBilling)}`,
        note: queueContext(loanerBilling) || 'Needs billing follow-up',
        href: reservationHref(loanerBilling),
        cta: 'Open Loaner Workflow',
        tone: 'warn'
      } : null,
      issue ? {
        key: 'issue',
        label: 'Issue Escalation',
        title: issueHeadline(issue),
        detail: `${tripGuestName(issue.trip)} - ${formatDateTime(issue.createdAt)}`,
        note: issue.trip?.hostProfile?.displayName || 'Customer service follow-up',
        href: '/issues',
        cta: 'Handle Case',
        tone: 'warn'
      } : null
    ].filter(Boolean);
  }, [dashboard]);

  const employeeShellStats = useMemo(() => ([
    { label: 'Shift Ready', value: `${metrics.readyForPickup} pickups` },
    { label: 'Returns Due', value: `${metrics.dueBackToday} returns` },
    { label: 'Loaner Billing', value: `${metrics.loanerBillingAttention} blockers` },
    { label: 'Issue Escalations', value: `${metrics.issueOpen + metrics.issueUnderReview} live` }
  ]), [metrics.dueBackToday, metrics.issueOpen, metrics.issueUnderReview, metrics.loanerBillingAttention, metrics.readyForPickup]);

  async function runSearch() {
    await load(search.trim());
  }

  function applyQuickWindow(hours = 24) {
    const pickup = new Date();
    pickup.setMinutes(0, 0, 0);
    pickup.setHours(pickup.getHours() + 1);
    const ret = new Date(pickup.getTime() + hours * 60 * 60 * 1000);
    setCreateForm((current) => ({
      ...current,
      pickupAt: pickup.toISOString().slice(0, 16),
      returnAt: ret.toISOString().slice(0, 16),
      reservationNumber: current.reservationNumber || `EMP-${Date.now().toString().slice(-6)}`
    }));
  }

  async function createReservation(event) {
    event.preventDefault();
    if (!quickCreateReady) {
      setMsg('Complete the required fields to create the reservation.');
      return;
    }
    try {
      const payload = await api('/api/reservations', {
        method: 'POST',
        body: JSON.stringify({
          reservationNumber: createForm.reservationNumber,
          customerId: createForm.customerId,
          vehicleTypeId: createForm.vehicleTypeId,
          pickupAt: createForm.pickupAt,
          returnAt: createForm.returnAt,
          pickupLocationId: createForm.pickupLocationId,
          returnLocationId: createForm.returnLocationId,
          notes: createForm.notes,
          sendConfirmationEmail: false,
          status: 'CONFIRMED'
        })
      }, token);
      setMsg(`Reservation ${payload?.reservationNumber || ''} created`);
      setCreateForm(EMPTY_FORM);
      try { localStorage.removeItem(EMPLOYEE_CREATE_FORM_KEY); } catch {}
      setSearch(payload?.reservationNumber || '');
      await load(payload?.reservationNumber || '');
    } catch (error) {
      setMsg(error.message);
    }
  }

  return (
    <AppShell me={me} logout={logout}>
      <section className="glass card-lg page-hero">
        <div className="hero-grid">
          <div className="hero-copy">
            <span className="eyebrow">Employee App Foundation</span>
            <h1 className="page-title" style={{ fontSize: 'clamp(30px, 5vw, 54px)', lineHeight: 1.02 }}>
              Run reservation operations from a faster, mobile-first employee surface.
            </h1>
            <p>
              The employee app now works as a real operations hub: search, quick reservation intake, rental queues,
              and dealership loaner service-lane work from one place.
            </p>
            <div className="hero-meta">
              <span className="hero-pill">Lookup + queues</span>
              <span className="hero-pill">Quick create</span>
              <span className="hero-pill">Phone and tablet friendly</span>
              <span className="hero-pill">Loaner service lane</span>
              <span className="hero-pill">Issue escalation queue</span>
              <Link href="/loaner" className="hero-pill">Open Loaner Program</Link>
            </div>
          </div>
          <div className="glass card section-card">
            <div className="section-title">Today&apos;s Focus</div>
            <div className="metric-grid">
              <div className="metric-card"><span className="label">Open Reservations</span><strong>{metrics.openReservations}</strong></div>
              <div className="metric-card"><span className="label">Active Rentals</span><strong>{metrics.activeRentals}</strong></div>
              <div className="metric-card"><span className="label">Ready For Pickup</span><strong>{metrics.readyForPickup}</strong></div>
              <div className="metric-card"><span className="label">Due Back Today</span><strong>{metrics.dueBackToday}</strong></div>
              <div className="metric-card"><span className="label">Loaners Open</span><strong>{metrics.loanerOpen}</strong></div>
              <div className="metric-card"><span className="label">Loaners Ready</span><strong>{metrics.loanerReady}</strong></div>
              <div className="metric-card"><span className="label">Billing Attention</span><strong>{metrics.loanerBillingAttention}</strong></div>
              <div className="metric-card"><span className="label">Loaners Overdue</span><strong>{metrics.loanerOverdue}</strong></div>
              <div className="metric-card"><span className="label">Issues Open</span><strong>{metrics.issueOpen}</strong></div>
              <div className="metric-card"><span className="label">Under Review</span><strong>{metrics.issueUnderReview}</strong></div>
            </div>
          </div>
        </div>
      </section>

      {msg ? (
        <div className="surface-note" style={{ color: /created|saved|updated|moved/i.test(msg) ? '#166534' : '#991b1b', marginBottom: 18 }}>
          {msg}
        </div>
      ) : null}

      <MobileAppShell
        eyebrow="Ride Fleet Employee App"
        title="Employee app shell"
        description="A shared mobile-first foundation for shift priorities, lookup, quick creation, and operational queues."
        statusLabel="Shift Ready"
        storageKey="employee-app"
        stats={employeeShellStats}
        tabs={[
          { href: '#employee-hub', label: 'Hub', active: true },
          { href: '#employee-shift', label: 'Shift', active: nextUpItems.length > 0 },
          { href: '#employee-search', label: 'Lookup', active: !!search || !!dashboard?.searchResults?.length },
          { href: '#employee-create', label: 'Quick Create', active: quickCreateReady },
          { href: '#employee-queues', label: 'Queues', active: true }
        ]}
      />

      <section className="app-section-grid">
        <div className="app-banner">
          <div className="section-title">Operations Lanes</div>
          <div className="app-banner-list">
            <span className="app-banner-pill">Rental review {metrics.precheckinQueue}</span>
            <span className="app-banner-pill">Ready pickup {metrics.readyForPickup}</span>
            <span className="app-banner-pill">Loaner ready {metrics.loanerReady}</span>
            <span className="app-banner-pill">Billing attention {metrics.loanerBillingAttention}</span>
            <span className="app-banner-pill">Returns due {metrics.dueBackToday}</span>
            <span className="app-banner-pill">Issues open {metrics.issueOpen}</span>
            <span className="app-banner-pill">Under review {metrics.issueUnderReview}</span>
          </div>
        </div>

        <section id="employee-hub" className="glass card-lg section-card">
          <div className="row-between">
            <div>
              <div className="section-title">Employee Mobile Hub</div>
              <p className="ui-muted">Use this top layer like a phone-ready operations dashboard: what is due now, what needs review, and where to jump next.</p>
            </div>
            <span className="status-chip neutral">Shift Ready</span>
          </div>
          <div className="app-card-grid compact">
            <OpsLaneCard
              title="Ready Pickups"
              count={metrics.readyForPickup}
              note="Guests who are close to pickup and should move into checkout quickly."
              href="/reservations"
              cta="Open Pickup Queue"
              tone={metrics.readyForPickup > 0 ? 'good' : 'neutral'}
            />
            <OpsLaneCard
              title="Returns Due"
              count={metrics.dueBackToday}
              note="Vehicles coming back today that may need check-in, fuel, mileage, and damage review."
              href="/reservations"
              cta="Open Return Queue"
              tone={metrics.dueBackToday > 0 ? 'warn' : 'neutral'}
            />
            <OpsLaneCard
              title="Loaner Billing"
              count={metrics.loanerBillingAttention}
              note="Loaners waiting on advisor, dealer, insurer, or customer-pay billing decisions."
              href="/loaner"
              cta="Open Loaner Billing"
              tone={metrics.loanerBillingAttention > 0 ? 'warn' : 'neutral'}
            />
            <OpsLaneCard
              title="Issue Escalations"
              count={metrics.issueOpen + metrics.issueUnderReview}
              note="Disputes and support cases that customer service or ops should review right away."
              href="/issues"
              cta="Open Issue Center"
              tone={(metrics.issueOpen + metrics.issueUnderReview) > 0 ? 'warn' : 'neutral'}
            />
          </div>
          <div className="surface-note">
            Best mobile order for most shifts: search the reservation, launch checkout or check-in, handle loaner follow-up, then clear issue escalations before close.
          </div>
          <div className="inline-actions">
            <Link href="/reservations"><button type="button">Reservations Board</button></Link>
            <Link href="/loaner"><button type="button" className="button-subtle">Loaner Dashboard</button></Link>
            <Link href="/issues"><button type="button" className="button-subtle">Issue Center</button></Link>
            <Link href="/planner"><button type="button" className="button-subtle">Planner</button></Link>
            <Link href="/knowledge-base"><button type="button" className="button-subtle">Knowledge Base</button></Link>
          </div>
        </section>

        <section id="employee-shift" className="glass card-lg section-card">
          <div className="row-between">
            <div>
              <div className="section-title">Next Up For This Shift</div>
              <p className="ui-muted">A compact priority board for phone and tablet so the next operational move is obvious.</p>
            </div>
            <span className="status-chip neutral">{nextUpItems.length} live priorities</span>
          </div>
          {nextUpItems.length ? (
            <div className="app-card-grid compact">
              {nextUpItems.map((item) => (
                <div key={item.key} className="doc-card">
                  <div className="row-between" style={{ marginBottom: 0, alignItems: 'start' }}>
                    <div style={{ display: 'grid', gap: 6 }}>
                      <span className="label">{item.label}</span>
                      <strong>{item.title}</strong>
                    </div>
                    <span className={item.tone === 'good' ? 'status-chip good' : 'status-chip warn'}>
                      {item.tone === 'good' ? 'Ready' : 'Attention'}
                    </span>
                  </div>
                  <div className="doc-meta">{item.detail}</div>
                  <div className="doc-meta">{item.note}</div>
                  <div className="inline-actions">
                    <Link href={item.href}>
                      <button type="button">{item.cta}</button>
                    </Link>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="surface-note">No urgent shift priorities are open right now. You can work from the full queues below.</div>
          )}
        </section>

        <section className="split-panel">
          <section id="employee-search" className="glass card-lg section-card">
            <div className="row-between">
              <div>
                <div className="section-title">Lookup And Resume</div>
                <p className="ui-muted">Search by reservation number, customer, email, or vehicle to jump straight into the right workflow.</p>
              </div>
              <span className="status-chip neutral">Ops Search</span>
            </div>
            <div className="inline-actions" style={{ alignItems: 'stretch' }}>
              <input
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Reservation, customer, email, vehicle"
                style={{ minWidth: 260, flex: 1 }}
              />
              <button type="button" onClick={runSearch} disabled={loading}>{loading ? 'Loading...' : 'Search'}</button>
              <button type="button" className="button-subtle" onClick={() => { setSearch(''); load(''); }}>Clear</button>
            </div>

            {dashboard?.searchResults?.length ? (
              <div className="stack" style={{ marginTop: 14 }}>
                <div className="surface-note">
                  Found <strong>{dashboard.searchResults.length}</strong> matching reservation{dashboard.searchResults.length === 1 ? '' : 's'}.
                </div>
                <div className="table-shell">
                  <table>
                    <thead>
                      <tr>
                        <th>Reservation</th>
                        <th>Customer</th>
                        <th>Status</th>
                        <th>Pickup</th>
                        <th>Return</th>
                        <th>Actions</th>
                      </tr>
                    </thead>
                    <tbody>
                      {dashboard.searchResults.map((row) => (
                        <tr key={row.id}>
                          <td>{row.reservationNumber}</td>
                          <td>{customerName(row)}</td>
                          <td><span className={statusClass(row.status)}>{row.status}</span></td>
                          <td>{formatDateTime(row.pickupAt)}</td>
                          <td>{formatDateTime(row.returnAt)}</td>
                          <td>
                            <div className="label" style={{ textTransform: 'none', letterSpacing: 0, fontSize: 12, marginBottom: 6 }}>
                              {[workflowLabel(row), queueContext(row)].filter(Boolean).join(' - ')}
                            </div>
                            <div className="inline-actions">
                              <Link href={reservationHref(row)}><button type="button">Open</button></Link>
                              <Link href={reservationHref(row, 'checkout')}><button type="button" className="button-subtle">Checkout</button></Link>
                              <Link href={reservationHref(row, 'checkin')}><button type="button" className="button-subtle">Check-in</button></Link>
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            ) : (
              <div className="surface-note" style={{ marginTop: 14 }}>
                Search results will appear here. You can also work directly from the queues below.
              </div>
            )}
          </section>

          <section id="employee-create" className="glass card-lg section-card">
            <div className="row-between">
              <div>
                <div className="section-title">Quick Create Reservation</div>
                <p className="ui-muted">Fast intake flow for phone or tablet when staff need to book from the counter or driveway.</p>
              </div>
              <div className="inline-actions">
                <button type="button" className="button-subtle" onClick={() => applyQuickWindow(24)}>24h</button>
                <button type="button" className="button-subtle" onClick={() => applyQuickWindow(72)}>72h</button>
              </div>
            </div>
            <form className="stack" onSubmit={createReservation}>
              <div className="form-grid-2">
                <div>
                  <div className="label">Reservation Number</div>
                  <input value={createForm.reservationNumber} onChange={(event) => setCreateForm((current) => ({ ...current, reservationNumber: event.target.value }))} placeholder="EMP-123456" />
                </div>
                <div>
                  <div className="label">Customer</div>
                  <select value={createForm.customerId} onChange={(event) => setCreateForm((current) => ({ ...current, customerId: event.target.value }))}>
                    <option value="">Select customer</option>
                    {customers.map((row) => (
                      <option key={row.id} value={row.id}>
                        {[row.firstName, row.lastName].filter(Boolean).join(' ') || row.email}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <div className="label">Vehicle Type</div>
                  <select value={createForm.vehicleTypeId} onChange={(event) => setCreateForm((current) => ({ ...current, vehicleTypeId: event.target.value }))}>
                    <option value="">Select type</option>
                    {vehicleTypes.map((row) => (
                      <option key={row.id} value={row.id}>{row.name}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <div className="label">Pickup Location</div>
                  <select value={createForm.pickupLocationId} onChange={(event) => setCreateForm((current) => ({ ...current, pickupLocationId: event.target.value }))}>
                    <option value="">Select location</option>
                    {locations.map((row) => (
                      <option key={row.id} value={row.id}>{row.name}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <div className="label">Pickup At</div>
                  <input type="datetime-local" value={createForm.pickupAt} onChange={(event) => setCreateForm((current) => ({ ...current, pickupAt: event.target.value }))} />
                </div>
                <div>
                  <div className="label">Return At</div>
                  <input type="datetime-local" value={createForm.returnAt} onChange={(event) => setCreateForm((current) => ({ ...current, returnAt: event.target.value }))} />
                </div>
                <div>
                  <div className="label">Return Location</div>
                  <select value={createForm.returnLocationId} onChange={(event) => setCreateForm((current) => ({ ...current, returnLocationId: event.target.value }))}>
                    <option value="">Select location</option>
                    {locations.map((row) => (
                      <option key={row.id} value={row.id}>{row.name}</option>
                    ))}
                  </select>
                </div>
              </div>
              <div>
                <div className="label">Notes</div>
                <textarea rows={3} value={createForm.notes} onChange={(event) => setCreateForm((current) => ({ ...current, notes: event.target.value }))} placeholder="Counter notes, service lane note, or booking context" />
              </div>
              <div className="inline-actions">
                <button type="submit">Create Reservation</button>
                <button type="button" className="button-subtle" onClick={() => setCreateForm(EMPTY_FORM)}>Reset</button>
              </div>
              <div className="surface-note">
                Counter tip: for the fastest intake on phone, start with `24h` or `72h`, pick the customer, then adjust pickup and return after the reservation is created.
              </div>
            </form>
          </section>
        </section>
      </section>

      <section id="employee-queues" className="glass card-lg section-card" style={{ marginTop: 18 }}>
        <IssueQueueCard rows={dashboard?.queues?.issueEscalations || []} />
      </section>

      <section className="glass card-lg section-card" style={{ marginTop: 18 }}>
        <div className="row-between">
          <div>
            <div className="section-title">Employee Queues</div>
            <p className="ui-muted">Designed for quick triage: who needs review, who is ready to leave, and who is due back.</p>
          </div>
          <span className="status-chip neutral">Rental Operations</span>
        </div>

        <div className="queue-grid" style={{ marginTop: 10 }}>
          <QueueCard
            title="Pre-check-in Review"
            subtitle="Review documents and mark ready."
            rows={dashboard?.queues?.precheckin || []}
            emptyText="No reservations currently waiting on pre-check-in review."
            actions={(row) => (
              <>
                <Link href={reservationHref(row)}><button type="button">Open Workflow</button></Link>
                <Link href={reservationHref(row)}><button type="button" className="button-subtle">Review</button></Link>
              </>
            )}
          />
          <QueueCard
            title="Ready For Checkout"
            subtitle="Upcoming pickups and quick launch into checkout."
            rows={dashboard?.queues?.checkout || []}
            emptyText="No upcoming pickups in the active checkout queue."
            actions={(row) => (
              <>
                <Link href={reservationHref(row, 'checkout')}><button type="button">Checkout</button></Link>
                <Link href={reservationHref(row, 'inspection')}><button type="button" className="button-subtle">Inspect</button></Link>
              </>
            )}
          />
        </div>

        <div className="queue-grid" style={{ marginTop: 16 }}>
          <QueueCard
            title="Returns Queue"
            subtitle="Vehicles that should be returning soon."
            rows={dashboard?.queues?.returns || []}
            emptyText="No return queue items right now."
            actions={(row) => (
              <>
                <Link href={reservationHref(row, 'checkin')}><button type="button">Check-in</button></Link>
                <Link href={reservationHref(row, 'inspection')}><button type="button" className="button-subtle">Inspect</button></Link>
              </>
            )}
          />
          <QueueCard
            title="Active Rentals"
            subtitle="Open contracts and balance follow-up."
            rows={dashboard?.queues?.active || []}
            emptyText="No active rentals right now."
            actions={(row) => (
              <>
                <Link href={reservationHref(row)}><button type="button">Open</button></Link>
                <Link href={reservationHref(row, 'payments')}><button type="button" className="button-subtle">Payments</button></Link>
              </>
            )}
          />
        </div>
      </section>

      <section className="glass card-lg section-card" style={{ marginTop: 18 }}>
        <div className="row-between">
          <div>
            <div className="section-title">Loaner Service Lane</div>
            <p className="ui-muted">Keep dealership loaners moving without leaving the employee surface.</p>
          </div>
          <Link href="/loaner"><button type="button">Open Loaner Dashboard</button></Link>
        </div>

        <div className="queue-grid" style={{ marginTop: 10 }}>
          <QueueCard
            title="Loaners Ready For Pickup"
            subtitle="Units that the service lane has cleared for customer handoff."
            rows={dashboard?.queues?.loanerReady || []}
            emptyText="No loaners are marked ready for pickup right now."
            actions={(row) => (
              <>
                <Link href={reservationHref(row)}><button type="button">Open Workflow</button></Link>
                <Link href={reservationHref(row, 'checkout')}><button type="button" className="button-subtle">Checkout</button></Link>
              </>
            )}
          />
          <QueueCard
            title="Advisor Follow-Up"
            subtitle="Loaners still missing packet work, waiting on advisor response, or missing ready status."
            rows={dashboard?.queues?.loanerAdvisorFollowup || []}
            emptyText="No service-lane follow-up items right now."
            actions={(row) => (
              <>
                <Link href={reservationHref(row)}><button type="button">Open Workflow</button></Link>
                <Link href="/loaner"><button type="button" className="button-subtle">Loaner Board</button></Link>
              </>
            )}
          />
        </div>

        <div className="queue-grid" style={{ marginTop: 16 }}>
          <QueueCard
            title="Billing Review"
            subtitle="Customer-pay, warranty, or insurance loaners that still need billing resolution."
            rows={dashboard?.queues?.loanerBillingReview || []}
            emptyText="No loaner billing items currently need review."
            actions={(row) => (
              <>
                <Link href={reservationHref(row)}><button type="button">Open Workflow</button></Link>
                <Link href="/loaner"><button type="button" className="button-subtle">Billing Board</button></Link>
              </>
            )}
          />
          <QueueCard
            title="Loaner Returns"
            subtitle="Loaner agreements due back soon or already checked out."
            rows={dashboard?.queues?.loanerReturns || []}
            emptyText="No loaner returns are in the near-term queue."
            actions={(row) => (
              <>
                <Link href={reservationHref(row, 'checkin')}><button type="button">Check-in</button></Link>
                <Link href={reservationHref(row)}><button type="button" className="button-subtle">Open Workflow</button></Link>
              </>
            )}
          />
        </div>
      </section>
    </AppShell>
  );
}
