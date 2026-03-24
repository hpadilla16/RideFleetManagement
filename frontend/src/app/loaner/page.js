'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { AuthGate } from '../../components/AuthGate';
import { AppShell } from '../../components/AppShell';
import { api, API_BASE } from '../../lib/client';

const EMPTY_FORM = {
  customerId: '',
  firstName: '',
  lastName: '',
  email: '',
  phone: '',
  vehicleId: '',
  vehicleTypeId: '',
  pickupAt: '',
  returnAt: '',
  pickupLocationId: '',
  returnLocationId: '',
  loanerBillingMode: 'COURTESY',
  repairOrderNumber: '',
  claimNumber: '',
  serviceAdvisorName: '',
  serviceAdvisorEmail: '',
  serviceAdvisorPhone: '',
  serviceVehicleYear: '',
  serviceVehicleMake: '',
  serviceVehicleModel: '',
  serviceVehiclePlate: '',
  serviceVehicleVin: '',
  notes: '',
  loanerProgramNotes: '',
  loanerLiabilityAccepted: false,
  serviceAdvisorNotes: ''
};

function formatDateTime(value) {
  if (!value) return '-';
  try {
    return new Date(value).toLocaleString();
  } catch {
    return String(value);
  }
}

function formatMoney(value) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(Number(value || 0));
}

function customerName(row) {
  return [row?.customer?.firstName, row?.customer?.lastName].filter(Boolean).join(' ') || row?.customer?.email || 'Customer';
}

function serviceVehicleLabel(row) {
  return [row?.serviceVehicle?.year, row?.serviceVehicle?.make, row?.serviceVehicle?.model, row?.serviceVehicle?.plate].filter(Boolean).join(' · ') || 'No service vehicle info';
}

function reservationHref(row, action = '') {
  if (!row?.id) return '#';
  return action ? `/reservations/${row.id}/${action}` : `/reservations/${row.id}`;
}

function loanerBoardNote(row) {
  if (!row) return '';
  if (row.alertReason) return row.alertReason;
  if (row.loanerReturnExceptionFlag) return 'Return exception flagged';
  if (!row.loanerBorrowerPacketCompletedAt) return 'Borrower packet still pending';
  if (String(row.loanerBillingStatus || 'DRAFT').toUpperCase() !== 'SETTLED') return `${row.loanerBillingStatus || 'Draft'} billing status`;
  return 'Service lane follow-up needed';
}

export default function LoanerProgramPage() {
  return <AuthGate>{({ token, me, logout }) => <LoanerProgramInner token={token} me={me} logout={logout} />}</AuthGate>;
}

function LoanerProgramInner({ token, me, logout }) {
  const [dashboard, setDashboard] = useState(null);
  const [config, setConfig] = useState({ enabled: true });
  const [customers, setCustomers] = useState([]);
  const [locations, setLocations] = useState([]);
  const [vehicleTypes, setVehicleTypes] = useState([]);
  const [vehicles, setVehicles] = useState([]);
  const [search, setSearch] = useState('');
  const [exportFilters, setExportFilters] = useState({
    billingStatus: '',
    billingMode: '',
    startDate: '',
    endDate: ''
  });
  const [msg, setMsg] = useState('');
  const [loading, setLoading] = useState(true);
  const [form, setForm] = useState(EMPTY_FORM);

  const metrics = dashboard?.metrics || {
    openLoaners: 0,
    activeLoaners: 0,
    pickupsToday: 0,
    dueBackToday: 0,
    readyForDelivery: 0,
    packetPending: 0,
    billingAttention: 0,
    returnExceptions: 0,
    overdueReturns: 0,
    serviceDelays: 0
  };

  async function load(query = '') {
    try {
      setLoading(true);
      const configOut = await api('/api/dealership-loaner/config', {}, token);
      setConfig(configOut || { enabled: false });

      const role = String(me?.role || '').toUpperCase();
      if (!configOut?.enabled && role !== 'SUPER_ADMIN') {
        setDashboard(null);
        setCustomers([]);
        setLocations([]);
        setVehicleTypes([]);
        setVehicles([]);
        setMsg('');
        return;
      }

      const [dashOut, intakeOptions] = await Promise.all([
        api(`/api/dealership-loaner/dashboard${query ? `?q=${encodeURIComponent(query)}` : ''}`, {}, token),
        api('/api/dealership-loaner/intake-options', {}, token)
      ]);
      setDashboard(dashOut);
      setCustomers(Array.isArray(intakeOptions?.customers) ? intakeOptions.customers : []);
      setLocations(Array.isArray(intakeOptions?.locations) ? intakeOptions.locations : []);
      setVehicleTypes(Array.isArray(intakeOptions?.vehicleTypes) ? intakeOptions.vehicleTypes : []);
      setVehicles(Array.isArray(intakeOptions?.vehicles) ? intakeOptions.vehicles : []);
      setMsg('');
    } catch (error) {
      setMsg(error.message);
      setDashboard(null);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, [token]);

  const selectedCustomer = useMemo(() => {
    if (!form.customerId) return null;
    return customers.find((row) => row.id === form.customerId) || null;
  }, [customers, form.customerId]);

  const loanerReady = useMemo(() => {
    const hasCustomer = form.customerId || (form.firstName && form.lastName && form.phone);
    return !!(
      hasCustomer &&
      form.vehicleTypeId &&
      form.pickupAt &&
      form.returnAt &&
      form.pickupLocationId &&
      form.returnLocationId &&
      form.loanerLiabilityAccepted
    );
  }, [form]);

  const visibleVehicles = useMemo(() => {
    return vehicles.filter((row) => {
      if (!row?.id) return false;
      if (row.status && ['IN_MAINTENANCE', 'OUT_OF_SERVICE'].includes(String(row.status).toUpperCase())) return false;
      return true;
    });
  }, [vehicles]);

  const serviceLanePriorityItems = useMemo(() => {
    const items = [];
    const queues = dashboard?.queues || {};
    const addItem = (row, config) => {
      if (!row?.id) return;
      items.push({
        id: `${config.key}-${row.id}`,
        title: config.title,
        detail: `${row.reservationNumber} - ${customerName(row)}`,
        note: config.note?.(row) || loanerBoardNote(row),
        tone: config.tone,
        href: reservationHref(row, config.action || ''),
        actionLabel: config.actionLabel,
        secondaryHref: reservationHref(row),
        secondaryLabel: 'Open Workflow'
      });
    };

    addItem(queues.intake?.[0], {
      key: 'delivery',
      title: 'Next Delivery',
      tone: 'good',
      action: 'checkout',
      actionLabel: 'Checkout',
      note: (row) => `Pickup ${formatDateTime(row.pickupAt)} - ${row.pickupLocation?.name || 'Location pending'}`
    });
    addItem(queues.returns?.[0], {
      key: 'return',
      title: 'Next Return',
      tone: 'warn',
      action: 'checkin',
      actionLabel: 'Check-in',
      note: (row) => `Return ${formatDateTime(row.returnAt)} - ${row.pickupLocation?.name || 'Location pending'}`
    });
    addItem(queues.billing?.[0], {
      key: 'billing',
      title: 'Billing Blocker',
      tone: 'warn',
      action: 'payments',
      actionLabel: 'Review Billing',
      note: (row) => `${row.loanerBillingMode || 'Billing'} - ${row.loanerBillingStatus || 'Draft'}`
    });
    addItem(queues.alerts?.[0], {
      key: 'alert',
      title: 'SLA Alert',
      tone: 'warn',
      action: 'checkout',
      actionLabel: 'Handle Alert',
      note: (row) => row.alertReason || loanerBoardNote(row)
    });
    addItem(queues.advisor?.[0], {
      key: 'advisor',
      title: 'Advisor Follow-Up',
      tone: 'neutral',
      action: '',
      actionLabel: 'Open Case',
      note: (row) => row.serviceAdvisorName ? `Advisor ${row.serviceAdvisorName}` : loanerBoardNote(row)
    });

    return items.slice(0, 4);
  }, [dashboard]);

  async function createLoaner(event) {
    event.preventDefault();
    if (!loanerReady) {
      setMsg('Complete the required loaner intake fields first.');
      return;
    }
    try {
      const payload = await api('/api/dealership-loaner/intake', {
        method: 'POST',
        body: JSON.stringify({
          ...form,
          serviceVehicleYear: form.serviceVehicleYear ? Number(form.serviceVehicleYear) : null
        })
      }, token);
      setMsg(`Loaner reservation ${payload?.reservationNumber || ''} created`);
      setForm(EMPTY_FORM);
      setSearch(payload?.reservationNumber || '');
      await load(payload?.reservationNumber || '');
    } catch (error) {
      setMsg(error.message);
    }
  }

  function applyQuickWindow(days = 3) {
    const pickup = new Date();
    pickup.setMinutes(0, 0, 0);
    pickup.setHours(pickup.getHours() + 1);
    const ret = new Date(pickup.getTime() + days * 24 * 60 * 60 * 1000);
    setForm((current) => ({
      ...current,
      pickupAt: pickup.toISOString().slice(0, 16),
      returnAt: ret.toISOString().slice(0, 16)
    }));
  }

  async function runSearch() {
    await load(search.trim());
  }

  async function exportBillingCsv() {
    try {
      const query = new URLSearchParams();
      if (search.trim()) query.set('q', search.trim());
      if (exportFilters.billingStatus) query.set('billingStatus', exportFilters.billingStatus);
      if (exportFilters.billingMode) query.set('billingMode', exportFilters.billingMode);
      if (exportFilters.startDate) query.set('startDate', exportFilters.startDate);
      if (exportFilters.endDate) query.set('endDate', exportFilters.endDate);
      const res = await fetch(`${API_BASE}/api/dealership-loaner/billing-export${query.toString() ? `?${query.toString()}` : ''}`, {
        headers: { Authorization: `Bearer ${token}` },
        cache: 'no-store'
      });
      if (!res.ok) throw new Error(`Billing export failed (${res.status})`);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = 'loaner-billing-export.csv';
      anchor.click();
      URL.revokeObjectURL(url);
      setMsg('Loaner billing export downloaded');
    } catch (error) {
      setMsg(error.message);
    }
  }

  function buildStatementQuery() {
    const query = new URLSearchParams();
    if (search.trim()) query.set('q', search.trim());
    if (exportFilters.billingStatus) query.set('billingStatus', exportFilters.billingStatus);
    if (exportFilters.billingMode) query.set('billingMode', exportFilters.billingMode);
    if (exportFilters.startDate) query.set('startDate', exportFilters.startDate);
    if (exportFilters.endDate) query.set('endDate', exportFilters.endDate);
    return query;
  }

  async function exportStatementCsv() {
    try {
      const query = buildStatementQuery();
      const res = await fetch(`${API_BASE}/api/dealership-loaner/statement-export${query.toString() ? `?${query.toString()}` : ''}`, {
        headers: { Authorization: `Bearer ${token}` },
        cache: 'no-store'
      });
      if (!res.ok) throw new Error(`Statement export failed (${res.status})`);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = 'loaner-dealer-statement.csv';
      anchor.click();
      URL.revokeObjectURL(url);
      setMsg('Dealer statement export downloaded');
    } catch (error) {
      setMsg(error.message);
    }
  }

  async function printStatementPacket() {
    const printWindow = window.open('', '_blank');
    if (!printWindow) {
      setMsg('Pop-up blocked. Please allow pop-ups to print the dealer statement.');
      return;
    }
    printWindow.opener = null;
    printWindow.document.write('<html><body style="font-family:Inter, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif;padding:32px;text-align:center;background:#0b0a12;color:#fff;">Preparing monthly accounting packet...</body></html>');
    printWindow.document.close();
    try {
      const query = buildStatementQuery();
      const res = await fetch(`${API_BASE}/api/dealership-loaner/statement-print${query.toString() ? `?${query.toString()}` : ''}`, {
        headers: { Authorization: `Bearer ${token}` },
        cache: 'no-store'
      });
      if (!res.ok) throw new Error(`Statement print failed (${res.status})`);
      const html = await res.text();
      printWindow.document.open();
      printWindow.document.write(html);
      printWindow.document.close();
      printWindow.focus();
      printWindow.print();
    } catch (error) {
      printWindow.document.open();
      printWindow.document.write(`<p style="font-family: sans-serif; padding: 24px;">${error.message || 'Unable to print dealer statement'}</p>`);
      printWindow.document.close();
      setMsg(error.message);
    }
  }

  if (!config?.enabled && String(me?.role || '').toUpperCase() !== 'SUPER_ADMIN') {
    return (
      <AppShell me={me} logout={logout}>
        <section className="glass card-lg section-card">
          <span className="eyebrow">Dealership Loaner</span>
          <h1 className="page-title">Loaner program is not enabled for this tenant.</h1>
          <p className="ui-muted">Turn on the feature in Tenants first, then come back here to start service-lane intake.</p>
        </section>
      </AppShell>
    );
  }

  return (
    <AppShell me={me} logout={logout}>
      <section className="glass card-lg page-hero">
        <div className="hero-grid">
          <div className="hero-copy">
            <span className="eyebrow">Dealership Loaner Foundation</span>
            <h1 className="page-title" style={{ fontSize: 'clamp(30px, 5vw, 54px)', lineHeight: 1.02 }}>
              Service-lane loaners built on the same reservation, agreement, payment, and inspection spine.
            </h1>
            <p>
              This first slice covers intake, repair-order metadata, courtesy and insurance-backed loaners, quick search,
              and direct jump-off into the same operational workflow the rest of the platform already uses.
            </p>
            <div className="hero-meta">
              <span className="hero-pill">Courtesy + customer-pay</span>
              <span className="hero-pill">Repair order tracking</span>
              <span className="hero-pill">Ready for service lane ops</span>
              {(dashboard?.badges || []).map((badge) => (
                <span key={badge.label} className={`hero-pill ${badge.tone === 'warn' ? 'hero-pill-warn' : ''}`} title={badge.detail}>
                  {badge.label}
                </span>
              ))}
            </div>
          </div>
          <div className="glass card section-card">
            <div className="section-title">Loaner Snapshot</div>
            <div className="metric-grid">
              <div className="metric-card"><span className="label">Open Loaners</span><strong>{metrics.openLoaners}</strong></div>
              <div className="metric-card"><span className="label">Active Loaners</span><strong>{metrics.activeLoaners}</strong></div>
              <div className="metric-card"><span className="label">Pickups Today</span><strong>{metrics.pickupsToday}</strong></div>
              <div className="metric-card"><span className="label">Due Back Today</span><strong>{metrics.dueBackToday}</strong></div>
              <div className="metric-card"><span className="label">Packet Pending</span><strong>{metrics.packetPending}</strong></div>
              <div className="metric-card"><span className="label">Billing Attention</span><strong>{metrics.billingAttention}</strong></div>
              <div className="metric-card"><span className="label">Return Exceptions</span><strong>{metrics.returnExceptions}</strong></div>
              <div className="metric-card"><span className="label">Ready For Delivery</span><strong>{metrics.readyForDelivery}</strong></div>
              <div className="metric-card"><span className="label">Overdue Returns</span><strong>{metrics.overdueReturns}</strong></div>
              <div className="metric-card"><span className="label">Service Delays</span><strong>{metrics.serviceDelays}</strong></div>
            </div>
          </div>
        </div>
      </section>

      {msg ? (
        <div className="surface-note" style={{ color: /created|saved|updated/i.test(msg) ? '#166534' : '#991b1b', marginBottom: 18 }}>
          {msg}
        </div>
      ) : null}

      <section className="glass card-lg section-card" style={{ marginBottom: 18 }}>
        <div className="row-between">
          <div>
            <div className="section-title">Service Lane Priority Board</div>
            <p className="ui-muted">The first delivery, return, billing blocker, and SLA risk the lane should touch next.</p>
          </div>
          <span className="status-chip neutral">Mobile Ops</span>
        </div>
        {serviceLanePriorityItems.length ? (
          <div className="app-card-grid compact">
            {serviceLanePriorityItems.map((item) => (
              <section key={item.id} className="glass card section-card">
                <div className="row-between" style={{ alignItems: 'start', marginBottom: 6 }}>
                  <div>
                    <div className="section-title" style={{ fontSize: 15 }}>{item.title}</div>
                    <div className="ui-muted" style={{ marginTop: 4 }}>{item.detail}</div>
                  </div>
                  <span className={`status-chip ${item.tone}`}>{item.title}</span>
                </div>
                <div className="surface-note">{item.note}</div>
                <div className="inline-actions">
                  <Link href={item.href}><button type="button">{item.actionLabel}</button></Link>
                  <Link href={item.secondaryHref}><button type="button" className="button-subtle">{item.secondaryLabel}</button></Link>
                </div>
              </section>
            ))}
          </div>
        ) : (
          <div className="surface-note">No immediate loaner priorities right now. The service lane looks clear.</div>
        )}
      </section>

      <section className="split-panel">
        <section className="glass card-lg section-card">
          <div className="row-between">
            <div>
              <div className="section-title">Loaner Lookup</div>
              <p className="ui-muted">Search by reservation, RO number, claim, customer, advisor, or service vehicle.</p>
            </div>
            <div className="inline-actions">
              <span className="status-chip neutral">Service Lane</span>
              <button type="button" className="button-subtle" onClick={exportBillingCsv}>Export Billing CSV</button>
              <button type="button" className="button-subtle" onClick={exportStatementCsv}>Export Statement CSV</button>
              <button type="button" className="button-subtle" onClick={printStatementPacket}>Print Monthly Packet</button>
            </div>
          </div>

          <div className="inline-actions" style={{ alignItems: 'stretch' }}>
            <input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Reservation, RO, claim, customer, vehicle"
              style={{ minWidth: 260, flex: 1 }}
            />
            <button type="button" onClick={runSearch} disabled={loading}>{loading ? 'Loading...' : 'Search'}</button>
            <button type="button" className="button-subtle" onClick={() => { setSearch(''); load(''); }}>Clear</button>
          </div>
          <div className="form-grid-2" style={{ marginTop: 12 }}>
            <select value={exportFilters.billingMode} onChange={(event) => setExportFilters((current) => ({ ...current, billingMode: event.target.value }))}>
              <option value="">All billing modes</option>
              <option value="COURTESY">Courtesy</option>
              <option value="CUSTOMER_PAY">Customer Pay</option>
              <option value="WARRANTY">Warranty</option>
              <option value="INSURANCE">Insurance</option>
              <option value="INTERNAL">Internal</option>
            </select>
            <select value={exportFilters.billingStatus} onChange={(event) => setExportFilters((current) => ({ ...current, billingStatus: event.target.value }))}>
              <option value="">All billing statuses</option>
              <option value="DRAFT">Draft</option>
              <option value="PENDING_APPROVAL">Pending Approval</option>
              <option value="APPROVED">Approved</option>
              <option value="INVOICED">Invoiced</option>
              <option value="SETTLED">Settled</option>
              <option value="DENIED">Denied</option>
            </select>
            <input type="date" value={exportFilters.startDate} onChange={(event) => setExportFilters((current) => ({ ...current, startDate: event.target.value }))} />
            <input type="date" value={exportFilters.endDate} onChange={(event) => setExportFilters((current) => ({ ...current, endDate: event.target.value }))} />
          </div>

          {dashboard?.searchResults?.length ? (
            <div className="table-shell" style={{ marginTop: 14 }}>
              <table>
                <thead>
                  <tr>
                    <th>Reservation</th>
                    <th>Customer</th>
                    <th>RO</th>
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
                      <td>{row.repairOrderNumber || '-'}</td>
                      <td><span className="status-chip neutral">{row.status}</span></td>
                      <td>{formatDateTime(row.pickupAt)}</td>
                      <td>{formatDateTime(row.returnAt)}</td>
                      <td>
                        <div className="inline-actions">
                          <Link href={reservationHref(row)}><button type="button">Open</button></Link>
                          <button type="button" className="button-subtle" onClick={() => window.open(reservationHref(row), '_blank')}>Open New Tab</button>
                          <Link href={reservationHref(row, 'checkout')}><button type="button" className="button-subtle">Checkout</button></Link>
                          <Link href={reservationHref(row, 'checkin')}><button type="button" className="button-subtle">Check-in</button></Link>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="surface-note" style={{ marginTop: 14 }}>
              Search results will appear here once you start typing an RO number, customer, or service vehicle.
            </div>
          )}
        </section>

        <section className="glass card-lg section-card">
          <div className="row-between">
            <div>
              <div className="section-title">Quick Intake</div>
              <p className="ui-muted">Create a loaner directly from the service lane and hand it off into the normal workflow.</p>
            </div>
            <div className="inline-actions">
              <button type="button" className="button-subtle" onClick={() => applyQuickWindow(2)}>2 Days</button>
              <button type="button" className="button-subtle" onClick={() => applyQuickWindow(5)}>5 Days</button>
            </div>
          </div>

          <form className="stack" onSubmit={createLoaner}>
            <div className="form-grid-2">
              <div>
                <div className="label">Existing Customer</div>
                <select value={form.customerId} onChange={(event) => setForm((current) => ({ ...current, customerId: event.target.value }))}>
                  <option value="">Create or choose customer</option>
                  {customers.map((row) => (
                    <option key={row.id} value={row.id}>
                      {[row.firstName, row.lastName].filter(Boolean).join(' ') || row.email}
                    </option>
                  ))}
                </select>
                {selectedCustomer ? (
                  <div className="surface-note" style={{ marginTop: 8 }}>
                    Using {selectedCustomer.firstName} {selectedCustomer.lastName} · {selectedCustomer.phone}
                  </div>
                ) : null}
              </div>
              <div>
                <div className="label">Billing Mode</div>
                <select value={form.loanerBillingMode} onChange={(event) => setForm((current) => ({ ...current, loanerBillingMode: event.target.value }))}>
                  <option value="COURTESY">Courtesy</option>
                  <option value="CUSTOMER_PAY">Customer Pay</option>
                  <option value="WARRANTY">Warranty</option>
                  <option value="INSURANCE">Insurance</option>
                  <option value="INTERNAL">Internal</option>
                </select>
              </div>
            </div>

            {!form.customerId ? (
              <div className="form-grid-2">
                <div>
                  <div className="label">First Name</div>
                  <input value={form.firstName} onChange={(event) => setForm((current) => ({ ...current, firstName: event.target.value }))} />
                </div>
                <div>
                  <div className="label">Last Name</div>
                  <input value={form.lastName} onChange={(event) => setForm((current) => ({ ...current, lastName: event.target.value }))} />
                </div>
                <div>
                  <div className="label">Email</div>
                  <input value={form.email} onChange={(event) => setForm((current) => ({ ...current, email: event.target.value }))} />
                </div>
                <div>
                  <div className="label">Phone</div>
                  <input value={form.phone} onChange={(event) => setForm((current) => ({ ...current, phone: event.target.value }))} />
                </div>
              </div>
            ) : null}

            <div className="form-grid-3">
              <div>
                <div className="label">Repair Order</div>
                <input value={form.repairOrderNumber} onChange={(event) => setForm((current) => ({ ...current, repairOrderNumber: event.target.value }))} placeholder="RO-12345" />
              </div>
              <div>
                <div className="label">Claim Number</div>
                <input value={form.claimNumber} onChange={(event) => setForm((current) => ({ ...current, claimNumber: event.target.value }))} placeholder="Optional" />
              </div>
              <div>
                <div className="label">Advisor Name</div>
                <input value={form.serviceAdvisorName} onChange={(event) => setForm((current) => ({ ...current, serviceAdvisorName: event.target.value }))} />
              </div>
              <div>
                <div className="label">Advisor Email</div>
                <input value={form.serviceAdvisorEmail} onChange={(event) => setForm((current) => ({ ...current, serviceAdvisorEmail: event.target.value }))} />
              </div>
              <div>
                <div className="label">Advisor Phone</div>
                <input value={form.serviceAdvisorPhone} onChange={(event) => setForm((current) => ({ ...current, serviceAdvisorPhone: event.target.value }))} />
              </div>
              <div>
                <div className="label">Vehicle Type</div>
                <select value={form.vehicleTypeId} onChange={(event) => setForm((current) => ({ ...current, vehicleTypeId: event.target.value }))}>
                  <option value="">Select type</option>
                  {vehicleTypes.map((row) => (
                    <option key={row.id} value={row.id}>{row.name}</option>
                  ))}
                </select>
              </div>
              <div>
                <div className="label">Loaner Vehicle</div>
                <select value={form.vehicleId} onChange={(event) => setForm((current) => ({ ...current, vehicleId: event.target.value }))}>
                  <option value="">Leave unassigned for now</option>
                  {visibleVehicles.map((row) => (
                    <option key={row.id} value={row.id}>
                      {[row.year, row.make, row.model, row.internalNumber].filter(Boolean).join(' ')}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <div className="label">Pickup Location</div>
                <select value={form.pickupLocationId} onChange={(event) => setForm((current) => ({ ...current, pickupLocationId: event.target.value }))}>
                  <option value="">Select location</option>
                  {locations.map((row) => (
                    <option key={row.id} value={row.id}>{row.name}</option>
                  ))}
                </select>
              </div>
              <div>
                <div className="label">Return Location</div>
                <select value={form.returnLocationId} onChange={(event) => setForm((current) => ({ ...current, returnLocationId: event.target.value }))}>
                  <option value="">Select location</option>
                  {locations.map((row) => (
                    <option key={row.id} value={row.id}>{row.name}</option>
                  ))}
                </select>
              </div>
              <div>
                <div className="label">Pickup At</div>
                <input type="datetime-local" value={form.pickupAt} onChange={(event) => setForm((current) => ({ ...current, pickupAt: event.target.value }))} />
              </div>
              <div>
                <div className="label">Return At</div>
                <input type="datetime-local" value={form.returnAt} onChange={(event) => setForm((current) => ({ ...current, returnAt: event.target.value }))} />
              </div>
            </div>

            <div className="form-grid-3">
              <div>
                <div className="label">Service Vehicle Year</div>
                <input value={form.serviceVehicleYear} onChange={(event) => setForm((current) => ({ ...current, serviceVehicleYear: event.target.value }))} />
              </div>
              <div>
                <div className="label">Service Vehicle Make</div>
                <input value={form.serviceVehicleMake} onChange={(event) => setForm((current) => ({ ...current, serviceVehicleMake: event.target.value }))} />
              </div>
              <div>
                <div className="label">Service Vehicle Model</div>
                <input value={form.serviceVehicleModel} onChange={(event) => setForm((current) => ({ ...current, serviceVehicleModel: event.target.value }))} />
              </div>
              <div>
                <div className="label">Service Vehicle Plate</div>
                <input value={form.serviceVehiclePlate} onChange={(event) => setForm((current) => ({ ...current, serviceVehiclePlate: event.target.value }))} />
              </div>
              <div>
                <div className="label">Service Vehicle VIN</div>
                <input value={form.serviceVehicleVin} onChange={(event) => setForm((current) => ({ ...current, serviceVehicleVin: event.target.value }))} />
              </div>
            </div>

            <div>
              <div className="label">Internal Notes</div>
              <textarea rows={3} value={form.notes} onChange={(event) => setForm((current) => ({ ...current, notes: event.target.value }))} placeholder="Lane notes, approval context, dealership notes" />
            </div>
            <div>
              <div className="label">Loaner Program Notes</div>
              <textarea rows={3} value={form.loanerProgramNotes} onChange={(event) => setForm((current) => ({ ...current, loanerProgramNotes: event.target.value }))} placeholder="Coverage details, insurer approval, courtesy policy, etc." />
            </div>
            <div>
              <div className="label">Service Advisor Notes</div>
              <textarea rows={3} value={form.serviceAdvisorNotes} onChange={(event) => setForm((current) => ({ ...current, serviceAdvisorNotes: event.target.value }))} placeholder="Advisor follow-up, promised completion, customer expectations, or service context" />
            </div>
            <label className="label">
              <input
                type="checkbox"
                checked={form.loanerLiabilityAccepted}
                onChange={(event) => setForm((current) => ({ ...current, loanerLiabilityAccepted: event.target.checked }))}
              />
              Customer accepted responsibility and liability for the loaner vehicle.
            </label>
            <div className="inline-actions">
              <button type="submit">Create Loaner Intake</button>
              <button type="button" className="button-subtle" onClick={() => setForm(EMPTY_FORM)}>Reset</button>
            </div>
          </form>
        </section>
      </section>

      <section className="glass card-lg section-card" style={{ marginTop: 18 }}>
        <div className="row-between">
          <div>
            <div className="section-title">Loaner Queues</div>
            <p className="ui-muted">Driveway and service-lane visibility for outgoing, active, and returning loaners.</p>
          </div>
          <span className="status-chip neutral">Foundation Surface</span>
        </div>

        <div className="split-panel" style={{ marginTop: 10 }}>
          <LoanerQueueCard
            title="Intake And Delivery"
            subtitle="Customers about to take a loaner or still waiting on delivery steps."
            rows={dashboard?.queues?.intake || []}
            emptyText="No loaner pickups in the active intake queue."
            actions={(row) => (
              <>
                <Link href={reservationHref(row)}><button type="button">Open Workflow</button></Link>
                <Link href={reservationHref(row, 'checkout')}><button type="button" className="button-subtle">Checkout</button></Link>
              </>
            )}
          />
          <LoanerQueueCard
            title="Active Loaners"
            subtitle="Vehicles currently out in service-loaner status."
            rows={dashboard?.queues?.active || []}
            emptyText="No active loaners right now."
            actions={(row) => (
              <>
                <Link href={reservationHref(row)}><button type="button">Open</button></Link>
                <Link href={reservationHref(row, 'payments')}><button type="button" className="button-subtle">Payments</button></Link>
              </>
            )}
          />
        </div>

        <div className="split-panel" style={{ marginTop: 16 }}>
          <LoanerQueueCard
            title="Returns"
            subtitle="Loaners coming back from service customers."
            rows={dashboard?.queues?.returns || []}
            emptyText="No loaner returns in queue right now."
            actions={(row) => (
              <>
                <Link href={reservationHref(row, 'checkin')}><button type="button">Check-in</button></Link>
                <Link href={reservationHref(row, 'inspection')}><button type="button" className="button-subtle">Inspect</button></Link>
              </>
            )}
          />
          <LoanerQueueCard
            title="Advisor Follow-Up"
            subtitle="Reservations that still need lane guidance, borrower packet progress, or ready-for-pickup decisions."
            rows={dashboard?.queues?.advisor || []}
            emptyText="No advisor follow-up items right now."
            actions={(row) => (
              <>
                <Link href={reservationHref(row)}><button type="button">Open Workflow</button></Link>
                <Link href={reservationHref(row, 'checkout')}><button type="button" className="button-subtle">Checkout</button></Link>
              </>
            )}
          />
        </div>

        <div className="split-panel" style={{ marginTop: 16 }}>
          <LoanerQueueCard
            title="Billing Review"
            subtitle="Warranty, insurer, and customer-pay loaners that still need billing follow-up."
            rows={dashboard?.queues?.billing || []}
            emptyText="No loaner billing items waiting right now."
            actions={(row) => (
              <>
                <Link href={reservationHref(row)}><button type="button">Open Workflow</button></Link>
                <Link href={reservationHref(row, 'payments')}><button type="button" className="button-subtle">Payments</button></Link>
              </>
            )}
          />
          <LoanerQueueCard
            title="Overdue And SLA Alerts"
            subtitle="Past-due returns, missed service ETAs, and denied billing items that need action now."
            rows={dashboard?.queues?.alerts || []}
            emptyText="No overdue or SLA-risk loaner alerts right now."
            actions={(row) => (
              <>
                <Link href={reservationHref(row)}><button type="button">Open Workflow</button></Link>
                <Link href={reservationHref(row, row.overdueReturn ? 'checkin' : 'checkout')}><button type="button" className="button-subtle">{row.overdueReturn ? 'Check-in' : 'Checkout'}</button></Link>
              </>
            )}
          />
        </div>

        <section className="glass card section-card" style={{ marginTop: 16 }}>
          <div className="row-between">
            <div>
              <div className="section-title">Alert Escalation</div>
              <p className="ui-muted">Fast signal for what should get cashier, advisor, or lane-manager attention first.</p>
            </div>
            <span className="status-chip warn">Escalation Board</span>
          </div>
          <div className="metric-grid">
            <div className="metric-card">
              <span className="label">Overdue Returns</span>
              <strong>{metrics.overdueReturns}</strong>
              <span className="ui-muted">Units still out after promised return time.</span>
            </div>
            <div className="metric-card">
              <span className="label">Service Delays</span>
              <strong>{metrics.serviceDelays}</strong>
              <span className="ui-muted">ETA passed and not yet ready for pickup.</span>
            </div>
            <div className="metric-card">
              <span className="label">Billing Attention</span>
              <strong>{metrics.billingAttention}</strong>
              <span className="ui-muted">Warranty, insurer, or customer-pay billing still unresolved.</span>
            </div>
            <div className="metric-card">
              <span className="label">Return Exceptions</span>
              <strong>{metrics.returnExceptions}</strong>
              <span className="ui-muted">Damage, fuel, odor, or closeout issues flagged by staff.</span>
            </div>
          </div>
        </section>
      </section>
    </AppShell>
  );
}

function LoanerQueueCard({ title, subtitle, rows, emptyText, actions }) {
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
                    {customerName(row)} · {serviceVehicleLabel(row)}
                  </div>
                </div>
                <span className="status-chip neutral">{row.status}</span>
              </div>
              <div className="metric-grid">
                <div className="metric-card"><span className="label">RO</span><strong>{row.repairOrderNumber || '-'}</strong></div>
                <div className="metric-card"><span className="label">Billing</span><strong>{row.loanerBillingMode || '-'}</strong></div>
                <div className="metric-card"><span className="label">Billing Status</span><strong>{row.loanerBillingStatus || 'DRAFT'}</strong></div>
                <div className="metric-card"><span className="label">Pickup</span><strong>{formatDateTime(row.pickupAt)}</strong></div>
                <div className="metric-card"><span className="label">Return</span><strong>{formatDateTime(row.returnAt)}</strong></div>
                <div className="metric-card"><span className="label">Estimate</span><strong>{formatMoney(row.estimatedTotal)}</strong></div>
              </div>
              {row.serviceAdvisorNotes ? (
                <div className="label" style={{ textTransform: 'none', letterSpacing: 0, fontSize: 12 }}>
                  Notes: {row.serviceAdvisorNotes}
                </div>
              ) : null}
              <div className="inline-actions" style={{ gap: 8 }}>
                <span className={`status-chip ${row.loanerBorrowerPacketCompletedAt ? 'good' : 'warn'}`}>
                  {row.loanerBorrowerPacketCompletedAt ? 'Packet Complete' : 'Packet Pending'}
                </span>
                {row.loanerReturnExceptionFlag ? <span className="status-chip warn">Return Exception</span> : null}
                {row.alertReason ? <span className={`status-chip ${row.alertSeverity === 'warn' ? 'warn' : 'neutral'}`}>{row.alertReason}</span> : null}
              </div>
              <div className="label" style={{ textTransform: 'none', letterSpacing: 0, fontSize: 12 }}>
                Advisor: {row.serviceAdvisorName || '-'} · Location: {row.pickupLocation?.name || '-'}
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
