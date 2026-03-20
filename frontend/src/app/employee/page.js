'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { AuthGate } from '../../components/AuthGate';
import { AppShell } from '../../components/AppShell';
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
  if (['CANCELLED', 'NO_SHOW'].includes(current)) return 'status-chip warn';
  return 'status-chip neutral';
}

function customerName(row) {
  return [row?.customer?.firstName, row?.customer?.lastName].filter(Boolean).join(' ') || row?.customer?.email || 'Guest';
}

function vehicleLabel(row) {
  if (row?.vehicle) {
    return [row.vehicle.year, row.vehicle.make, row.vehicle.model].filter(Boolean).join(' ');
  }
  return row?.vehicleType?.name || 'Unassigned vehicle';
}

function reservationHref(row, action = '') {
  if (!row?.id) return '#';
  if (!action) return `/reservations/${row.id}`;
  return `/reservations/${row.id}/${action}`;
}

export default function EmployeeAppPage() {
  return <AuthGate>{({ token, me, logout }) => <EmployeeAppInner token={token} me={me} logout={logout} />}</AuthGate>;
}

function EmployeeAppInner({ token, me, logout }) {
  const [dashboard, setDashboard] = useState(null);
  const [customers, setCustomers] = useState([]);
  const [locations, setLocations] = useState([]);
  const [vehicleTypes, setVehicleTypes] = useState([]);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [msg, setMsg] = useState('');
  const [createForm, setCreateForm] = useState(EMPTY_FORM);

  const metrics = dashboard?.metrics || {
    openReservations: 0,
    activeRentals: 0,
    precheckinQueue: 0,
    readyForPickup: 0,
    dueBackToday: 0
  };

  async function load(query = '') {
    try {
      setLoading(true);
      const [dash, customersOut, locationsOut, typesOut] = await Promise.all([
        api(`/api/employee-app/dashboard${query ? `?q=${encodeURIComponent(query)}` : ''}`, {}, token),
        api('/api/customers', {}, token),
        api('/api/locations', {}, token),
        api('/api/vehicle-types', {}, token)
      ]);
      setDashboard(dash);
      setCustomers(Array.isArray(customersOut) ? customersOut : []);
      setLocations(Array.isArray(locationsOut) ? locationsOut : []);
      setVehicleTypes(Array.isArray(typesOut) ? typesOut : []);
      setMsg('');
    } catch (error) {
      setDashboard(null);
      setMsg(error.message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, [token]);

  const quickCreateReady = useMemo(() => {
    return !!(
      createForm.reservationNumber &&
      createForm.customerId &&
      createForm.vehicleTypeId &&
      createForm.pickupAt &&
      createForm.returnAt &&
      createForm.pickupLocationId &&
      createForm.returnLocationId
    );
  }, [createForm]);

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
              This first slice is built for agents, ops, and admins who need fast lookup, pre-check-in review,
              quick reservation creation, and direct access to checkout, check-in, inspections, and payments.
            </p>
            <div className="hero-meta">
              <span className="hero-pill">Lookup + queues</span>
              <span className="hero-pill">Quick create</span>
              <span className="hero-pill">Phone and tablet friendly</span>
            </div>
          </div>
          <div className="glass card section-card">
            <div className="section-title">Today&apos;s Focus</div>
            <div className="metric-grid">
              <div className="metric-card"><span className="label">Open Reservations</span><strong>{metrics.openReservations}</strong></div>
              <div className="metric-card"><span className="label">Active Rentals</span><strong>{metrics.activeRentals}</strong></div>
              <div className="metric-card"><span className="label">Ready For Pickup</span><strong>{metrics.readyForPickup}</strong></div>
              <div className="metric-card"><span className="label">Due Back Today</span><strong>{metrics.dueBackToday}</strong></div>
            </div>
          </div>
        </div>
      </section>

      {msg ? (
        <div className="surface-note" style={{ color: /created|saved|updated/i.test(msg) ? '#166534' : '#991b1b', marginBottom: 18 }}>
          {msg}
        </div>
      ) : null}

      <section className="split-panel">
        <section className="glass card-lg section-card">
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
            <div className="table-shell" style={{ marginTop: 14 }}>
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
          ) : (
            <div className="surface-note" style={{ marginTop: 14 }}>
              Search results will appear here. You can also work directly from the queues below.
            </div>
          )}
        </section>

        <section className="glass card-lg section-card">
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
          </form>
        </section>
      </section>

      <section className="glass card-lg section-card" style={{ marginTop: 18 }}>
        <div className="row-between">
          <div>
            <div className="section-title">Employee Queues</div>
            <p className="ui-muted">Designed for quick triage: who needs review, who is ready to leave, and who is due back.</p>
          </div>
          <span className="status-chip neutral">Foundation Surface</span>
        </div>

        <div className="split-panel" style={{ marginTop: 10 }}>
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

        <div className="split-panel" style={{ marginTop: 16 }}>
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
    </AppShell>
  );
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
                    {customerName(row)} · {vehicleLabel(row)}
                  </div>
                </div>
                <span className={statusClass(row.status)}>{row.status}</span>
              </div>
              <div className="metric-grid">
                <div className="metric-card"><span className="label">Pickup</span><strong>{formatDateTime(row.pickupAt)}</strong></div>
                <div className="metric-card"><span className="label">Return</span><strong>{formatDateTime(row.returnAt)}</strong></div>
                <div className="metric-card"><span className="label">Location</span><strong>{row.pickupLocation?.name || '-'}</strong></div>
                <div className="metric-card"><span className="label">Estimate</span><strong>{formatMoney(row.estimatedTotal)}</strong></div>
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
