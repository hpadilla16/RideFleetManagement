'use client';

import { useEffect, useMemo, useState } from 'react';
import { AuthGate } from '../../components/AuthGate';
import { AppShell } from '../../components/AppShell';
import { api } from '../../lib/client';

function formatMoney(value) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(Number(value || 0));
}

function tripActionsFor(status) {
  const current = String(status || '').toUpperCase();
  if (current === 'RESERVED') return ['CONFIRMED', 'CANCELLED'];
  if (current === 'CONFIRMED') return ['READY_FOR_PICKUP', 'CANCELLED'];
  if (current === 'READY_FOR_PICKUP') return ['IN_PROGRESS', 'CANCELLED'];
  if (current === 'IN_PROGRESS') return ['COMPLETED', 'DISPUTED'];
  if (current === 'DISPUTED') return ['COMPLETED'];
  return [];
}

function statusChip(status) {
  const current = String(status || '').toUpperCase();
  if (['PUBLISHED', 'ACTIVE', 'COMPLETED', 'READY_FOR_PICKUP'].includes(current)) return 'status-chip good';
  if (['PAUSED', 'CANCELLED', 'DISPUTED', 'ARCHIVED'].includes(current)) return 'status-chip warn';
  return 'status-chip neutral';
}

const EMPTY_LISTING_EDIT = {
  id: '',
  shortDescription: '',
  description: '',
  status: 'DRAFT',
  baseDailyRate: '',
  cleaningFee: '',
  deliveryFee: '',
  securityDeposit: '',
  instantBook: false,
  minTripDays: '1',
  maxTripDays: '',
  tripRules: ''
};

const EMPTY_WINDOW_FORM = {
  startAt: '',
  endAt: '',
  isBlocked: false,
  priceOverride: '',
  minTripDaysOverride: '',
  note: ''
};

export default function HostAppPage() {
  return (
    <AuthGate>
      {({ token, me, logout }) => <HostAppInner token={token} me={me} logout={logout} />}
    </AuthGate>
  );
}

function HostAppInner({ token, me, logout }) {
  const [dashboard, setDashboard] = useState(null);
  const [msg, setMsg] = useState('');
  const [selectedHostProfileId, setSelectedHostProfileId] = useState('');
  const [listingEdit, setListingEdit] = useState(EMPTY_LISTING_EDIT);
  const [tripStatusFilter, setTripStatusFilter] = useState('');
  const [availabilityRows, setAvailabilityRows] = useState([]);
  const [availabilityListingId, setAvailabilityListingId] = useState('');
  const [windowForm, setWindowForm] = useState(EMPTY_WINDOW_FORM);
  const [loading, setLoading] = useState(true);

  const isAdminViewer = !!dashboard?.isAdminViewer;

  const scopedQuery = useMemo(() => {
    const params = new URLSearchParams();
    if (selectedHostProfileId) params.set('hostProfileId', selectedHostProfileId);
    if (tripStatusFilter) params.set('tripStatus', tripStatusFilter);
    const str = params.toString();
    return str ? `?${str}` : '';
  }, [selectedHostProfileId, tripStatusFilter]);

  async function load() {
    try {
      setLoading(true);
      const payload = await api(`/api/host-app/dashboard${scopedQuery}`, {}, token);
      setDashboard(payload);
      if (!selectedHostProfileId && payload?.hostProfile?.id) {
        setSelectedHostProfileId(payload.hostProfile.id);
      }
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
  }, [scopedQuery, token]);

  const metrics = dashboard?.metrics || {
    listings: 0,
    activeListings: 0,
    instantBookListings: 0,
    trips: 0,
    activeTrips: 0,
    projectedEarnings: 0
  };

  const host = dashboard?.hostProfile || null;
  const listings = dashboard?.listings || [];
  const trips = dashboard?.trips || [];

  async function saveListingEdit(e) {
    e.preventDefault();
    if (!listingEdit.id) return;
    try {
      await api(`/api/host-app/listings/${listingEdit.id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          shortDescription: listingEdit.shortDescription,
          description: listingEdit.description,
          status: listingEdit.status,
          baseDailyRate: Number(listingEdit.baseDailyRate || 0),
          cleaningFee: Number(listingEdit.cleaningFee || 0),
          deliveryFee: Number(listingEdit.deliveryFee || 0),
          securityDeposit: Number(listingEdit.securityDeposit || 0),
          instantBook: !!listingEdit.instantBook,
          minTripDays: Number(listingEdit.minTripDays || 1),
          maxTripDays: listingEdit.maxTripDays ? Number(listingEdit.maxTripDays) : null,
          tripRules: listingEdit.tripRules
        })
      }, token);
      setMsg('Listing updated');
      setListingEdit(EMPTY_LISTING_EDIT);
      await load();
    } catch (error) {
      setMsg(error.message);
    }
  }

  async function loadAvailability(listingId) {
    if (!listingId) {
      setAvailabilityListingId('');
      setAvailabilityRows([]);
      return;
    }
    try {
      const rows = await api(`/api/host-app/listings/${listingId}/availability`, {}, token);
      setAvailabilityListingId(listingId);
      setAvailabilityRows(Array.isArray(rows) ? rows : []);
    } catch (error) {
      setMsg(error.message);
      setAvailabilityListingId(listingId);
      setAvailabilityRows([]);
    }
  }

  async function saveAvailabilityWindow(event) {
    event.preventDefault();
    if (!availabilityListingId) {
      setMsg('Choose a listing first');
      return;
    }
    try {
      await api(`/api/host-app/listings/${availabilityListingId}/availability`, {
        method: 'POST',
        body: JSON.stringify({
          startAt: windowForm.startAt,
          endAt: windowForm.endAt,
          isBlocked: !!windowForm.isBlocked,
          priceOverride: windowForm.priceOverride === '' ? null : Number(windowForm.priceOverride),
          minTripDaysOverride: windowForm.minTripDaysOverride === '' ? null : Number(windowForm.minTripDaysOverride),
          note: windowForm.note
        })
      }, token);
      setWindowForm(EMPTY_WINDOW_FORM);
      setMsg('Availability window added');
      await loadAvailability(availabilityListingId);
      await load();
    } catch (error) {
      setMsg(error.message);
    }
  }

  async function removeAvailabilityWindow(id) {
    try {
      await api(`/api/host-app/availability/${id}`, { method: 'DELETE' }, token);
      setMsg('Availability window removed');
      await loadAvailability(availabilityListingId);
      await load();
    } catch (error) {
      setMsg(error.message);
    }
  }

  async function moveTrip(tripId, status) {
    try {
      await api(`/api/host-app/trips/${tripId}/status`, {
        method: 'PATCH',
        body: JSON.stringify({ status, note: `Host moved trip to ${status}` })
      }, token);
      setMsg(`Trip moved to ${status}`);
      await load();
    } catch (error) {
      setMsg(error.message);
    }
  }

  return (
    <AppShell me={me} logout={logout}>
      <section className="glass card-lg page-hero">
        <div className="hero-grid">
          <div className="hero-copy">
            <span className="eyebrow">Host App Foundation</span>
            <h1 className="page-title" style={{ fontSize: 'clamp(30px, 5vw, 54px)', lineHeight: 1.02 }}>
              Manage your listings, see incoming trips, and keep supply moving from one host surface.
            </h1>
            <p>
              This is the first host-focused view on top of the car sharing engine. Hosts can monitor listings, see trip activity,
              and move bookings through the next operational state without living in the full admin console.
            </p>
            <div className="hero-meta">
              <span className="hero-pill">Host dashboard</span>
              <span className="hero-pill">Listings + trips</span>
              <span className="hero-pill">Operational actions</span>
            </div>
          </div>
          <div className="glass card section-card">
            <div className="section-title">Host Snapshot</div>
            <div className="metric-grid">
              <div className="metric-card"><span className="label">Listings</span><strong>{metrics.listings}</strong></div>
              <div className="metric-card"><span className="label">Published</span><strong>{metrics.activeListings}</strong></div>
              <div className="metric-card"><span className="label">Active Trips</span><strong>{metrics.activeTrips}</strong></div>
              <div className="metric-card"><span className="label">Projected Earnings</span><strong>{formatMoney(metrics.projectedEarnings)}</strong></div>
            </div>
            {host ? (
              <div className="surface-note">
                <strong>{host.displayName}</strong>
                <br />
                {host.tenant?.name || 'No tenant'} · {host.status}
                <br />
                {host.payoutEnabled ? 'Payouts enabled' : 'Payouts not enabled yet'}
              </div>
            ) : (
              <div className="surface-note">
                {loading
                  ? 'Loading host profile...'
                  : 'No host profile is linked to this login yet. Admins can still use the selector below to support hosts.'}
              </div>
            )}
          </div>
        </div>
      </section>

      {msg ? <div className="surface-note" style={{ color: /updated|moved/i.test(msg) ? '#166534' : '#991b1b', marginBottom: 18 }}>{msg}</div> : null}

      {isAdminViewer ? (
        <section className="glass card-lg section-card" style={{ marginBottom: 18 }}>
          <div className="row-between">
            <div>
              <div className="section-title">Host Selector</div>
              <p className="ui-muted">Admins and ops can support a specific host from this focused host surface.</p>
            </div>
            <span className="status-chip neutral">Admin Support</span>
          </div>
          <div style={{ maxWidth: 380 }}>
            <div className="label">Host</div>
            <select value={selectedHostProfileId} onChange={(event) => setSelectedHostProfileId(event.target.value)}>
              <option value="">Choose host</option>
              {(dashboard?.availableHosts || []).map((row) => (
                <option key={row.id} value={row.id}>{row.displayName}</option>
              ))}
            </select>
          </div>
        </section>
      ) : null}

      <section className="split-panel">
        <section className="glass card-lg section-card">
          <div className="row-between">
            <div>
              <div className="section-title">My Listings</div>
              <p className="ui-muted">Edit the host-facing listing details and pricing without opening the full car sharing console.</p>
            </div>
            <span className="status-chip neutral">{metrics.instantBookListings} instant book</span>
          </div>
          {listings.length ? (
            <div className="metric-grid">
              {listings.map((listing) => (
                <div key={listing.id} className="glass card section-card" style={{ padding: 14 }}>
                  <div className="row-between" style={{ alignItems: 'start', gap: 12 }}>
                    <div>
                      <div style={{ fontWeight: 700 }}>{listing.title}</div>
                      <div className="label" style={{ textTransform: 'none', letterSpacing: 0, fontSize: 12 }}>
                        {listing.vehicle ? `${listing.vehicle.year || ''} ${listing.vehicle.make || ''} ${listing.vehicle.model || ''}`.trim() : 'No vehicle'}
                      </div>
                    </div>
                    <span className={statusChip(listing.status)}>{listing.status}</span>
                  </div>
                  <div className="metric-grid">
                    <div className="metric-card"><span className="label">Daily Rate</span><strong>{formatMoney(listing.baseDailyRate)}</strong></div>
                    <div className="metric-card"><span className="label">Instant Book</span><strong>{listing.instantBook ? 'On' : 'Off'}</strong></div>
                    <div className="metric-card"><span className="label">Min Stay</span><strong>{listing.minTripDays} day(s)</strong></div>
                  </div>
                  <div className="inline-actions">
                    <button
                      type="button"
                      onClick={() => setListingEdit({
                        id: listing.id,
                        shortDescription: listing.shortDescription || '',
                        description: listing.description || '',
                        status: listing.status || 'DRAFT',
                        baseDailyRate: String(listing.baseDailyRate ?? ''),
                        cleaningFee: String(listing.cleaningFee ?? ''),
                        deliveryFee: String(listing.deliveryFee ?? ''),
                        securityDeposit: String(listing.securityDeposit ?? ''),
                        instantBook: !!listing.instantBook,
                        minTripDays: String(listing.minTripDays ?? 1),
                        maxTripDays: listing.maxTripDays ? String(listing.maxTripDays) : '',
                        tripRules: listing.tripRules || ''
                      })}
                    >
                      Edit Listing
                    </button>
                    <button
                      type="button"
                      className="button-subtle"
                      onClick={() => loadAvailability(listing.id)}
                    >
                      Availability
                    </button>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="surface-note">No listings yet for this host.</div>
          )}
        </section>

        <section className="glass card-lg section-card">
          <div className="row-between">
            <div>
              <div className="section-title">Listing Editor</div>
              <p className="ui-muted">Host-safe edit surface for pricing, availability mode, and trip rules.</p>
            </div>
            {listingEdit.id ? <button type="button" className="button-subtle" onClick={() => setListingEdit(EMPTY_LISTING_EDIT)}>Clear</button> : null}
          </div>
          {listingEdit.id ? (
            <form className="stack" onSubmit={saveListingEdit}>
              <div className="stack">
                <label className="label">Short Description</label>
                <input value={listingEdit.shortDescription} onChange={(event) => setListingEdit((current) => ({ ...current, shortDescription: event.target.value }))} />
              </div>
              <div className="stack">
                <label className="label">Description</label>
                <textarea rows={4} value={listingEdit.description} onChange={(event) => setListingEdit((current) => ({ ...current, description: event.target.value }))} />
              </div>
              <div className="form-grid-3">
                <div className="stack">
                  <label className="label">Status</label>
                  <select value={listingEdit.status} onChange={(event) => setListingEdit((current) => ({ ...current, status: event.target.value }))}>
                    <option value="DRAFT">DRAFT</option>
                    <option value="PUBLISHED">PUBLISHED</option>
                    <option value="PAUSED">PAUSED</option>
                    <option value="ARCHIVED">ARCHIVED</option>
                  </select>
                </div>
                <div className="stack">
                  <label className="label">Daily Rate</label>
                  <input type="number" min="0" step="0.01" value={listingEdit.baseDailyRate} onChange={(event) => setListingEdit((current) => ({ ...current, baseDailyRate: event.target.value }))} />
                </div>
                <div className="stack">
                  <label className="label">Security Deposit</label>
                  <input type="number" min="0" step="0.01" value={listingEdit.securityDeposit} onChange={(event) => setListingEdit((current) => ({ ...current, securityDeposit: event.target.value }))} />
                </div>
                <div className="stack">
                  <label className="label">Cleaning Fee</label>
                  <input type="number" min="0" step="0.01" value={listingEdit.cleaningFee} onChange={(event) => setListingEdit((current) => ({ ...current, cleaningFee: event.target.value }))} />
                </div>
                <div className="stack">
                  <label className="label">Delivery Fee</label>
                  <input type="number" min="0" step="0.01" value={listingEdit.deliveryFee} onChange={(event) => setListingEdit((current) => ({ ...current, deliveryFee: event.target.value }))} />
                </div>
                <div className="stack">
                  <label className="label">Min Trip Days</label>
                  <input type="number" min="1" value={listingEdit.minTripDays} onChange={(event) => setListingEdit((current) => ({ ...current, minTripDays: event.target.value }))} />
                </div>
                <div className="stack">
                  <label className="label">Max Trip Days</label>
                  <input type="number" min="1" value={listingEdit.maxTripDays} onChange={(event) => setListingEdit((current) => ({ ...current, maxTripDays: event.target.value }))} />
                </div>
              </div>
              <label className="label" style={{ textTransform: 'none', letterSpacing: 0 }}>
                <input type="checkbox" checked={listingEdit.instantBook} onChange={(event) => setListingEdit((current) => ({ ...current, instantBook: event.target.checked }))} /> Instant Book
              </label>
              <div className="stack">
                <label className="label">Trip Rules</label>
                <textarea rows={3} value={listingEdit.tripRules} onChange={(event) => setListingEdit((current) => ({ ...current, tripRules: event.target.value }))} />
              </div>
              <div className="inline-actions">
                <button type="submit">Save Listing</button>
              </div>
            </form>
          ) : (
            <div className="surface-note">Choose a listing to edit host-facing pricing and publishing controls.</div>
          )}
        </section>
      </section>

      <section className="split-panel" style={{ marginTop: 18 }}>
        <section className="glass card-lg section-card">
          <div className="row-between">
            <div>
              <div className="section-title">Availability Windows</div>
              <p className="ui-muted">Block dates, set price overrides, or require a longer minimum stay from the host surface.</p>
            </div>
            <select
              value={availabilityListingId}
              onChange={(event) => loadAvailability(event.target.value)}
              style={{ maxWidth: 280 }}
            >
              <option value="">Choose listing</option>
              {listings.map((row) => (
                <option key={row.id} value={row.id}>{row.title}</option>
              ))}
            </select>
          </div>
          {availabilityListingId ? (
            availabilityRows.length ? (
              <div className="stack">
                {availabilityRows.map((row) => (
                  <div key={row.id} className="surface-note" style={{ display: 'grid', gap: 8 }}>
                    <div className="row-between" style={{ gap: 12 }}>
                      <strong>{formatDateTime(row.startAt)} {'->'} {formatDateTime(row.endAt)}</strong>
                      <span className={row.isBlocked ? 'status-chip warn' : 'status-chip good'}>
                        {row.isBlocked ? 'Blocked' : 'Open'}
                      </span>
                    </div>
                    <div style={{ color: '#55456f', lineHeight: 1.5 }}>
                      Price override: {row.priceOverride != null ? formatMoney(row.priceOverride) : 'None'} · Min days override: {row.minTripDaysOverride || '-'}
                    </div>
                    <div style={{ color: '#55456f', lineHeight: 1.5 }}>
                      {row.note || 'No notes'}
                    </div>
                    <div className="inline-actions">
                      <button type="button" className="button-subtle" onClick={() => removeAvailabilityWindow(row.id)}>Delete</button>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="surface-note">No availability windows yet for this listing.</div>
            )
          ) : (
            <div className="surface-note">Choose a listing to manage availability windows.</div>
          )}
        </section>

        <section className="glass card-lg section-card">
          <div className="row-between">
            <div>
              <div className="section-title">Add Availability Window</div>
              <p className="ui-muted">Useful for blackout dates, seasonal pricing, and minimum-stay control.</p>
            </div>
            {availabilityListingId ? <span className="status-chip neutral">Listing Selected</span> : null}
          </div>
          <form className="stack" onSubmit={saveAvailabilityWindow}>
            <div className="form-grid-2">
              <div className="stack">
                <label className="label">Start</label>
                <input type="datetime-local" value={windowForm.startAt} onChange={(event) => setWindowForm((current) => ({ ...current, startAt: event.target.value }))} />
              </div>
              <div className="stack">
                <label className="label">End</label>
                <input type="datetime-local" value={windowForm.endAt} onChange={(event) => setWindowForm((current) => ({ ...current, endAt: event.target.value }))} />
              </div>
              <div className="stack">
                <label className="label">Price Override</label>
                <input type="number" min="0" step="0.01" value={windowForm.priceOverride} onChange={(event) => setWindowForm((current) => ({ ...current, priceOverride: event.target.value }))} />
              </div>
              <div className="stack">
                <label className="label">Min Trip Days Override</label>
                <input type="number" min="1" value={windowForm.minTripDaysOverride} onChange={(event) => setWindowForm((current) => ({ ...current, minTripDaysOverride: event.target.value }))} />
              </div>
            </div>
            <label className="label" style={{ textTransform: 'none', letterSpacing: 0 }}>
              <input type="checkbox" checked={windowForm.isBlocked} onChange={(event) => setWindowForm((current) => ({ ...current, isBlocked: event.target.checked }))} /> Block these dates
            </label>
            <div className="stack">
              <label className="label">Note</label>
              <textarea rows={3} value={windowForm.note} onChange={(event) => setWindowForm((current) => ({ ...current, note: event.target.value }))} />
            </div>
            <div className="inline-actions">
              <button type="submit">Add Window</button>
            </div>
          </form>
        </section>
      </section>

      <section className="glass card-lg section-card" style={{ marginTop: 18 }}>
        <div className="row-between">
          <div>
            <div className="section-title">My Trips</div>
            <p className="ui-muted">Watch incoming trips and move them through the next host-facing operational status.</p>
          </div>
          <div className="inline-actions">
            <select value={tripStatusFilter} onChange={(event) => setTripStatusFilter(event.target.value)} style={{ maxWidth: 220 }}>
              <option value="">All statuses</option>
              <option value="RESERVED">RESERVED</option>
              <option value="CONFIRMED">CONFIRMED</option>
              <option value="READY_FOR_PICKUP">READY_FOR_PICKUP</option>
              <option value="IN_PROGRESS">IN_PROGRESS</option>
              <option value="COMPLETED">COMPLETED</option>
              <option value="CANCELLED">CANCELLED</option>
              <option value="DISPUTED">DISPUTED</option>
            </select>
            <span className="status-chip neutral">{metrics.trips} trips</span>
          </div>
        </div>
        <div className="table-shell">
          <table>
            <thead>
              <tr>
                <th>Trip</th>
                <th>Listing</th>
                <th>Guest</th>
                <th>Status</th>
                <th>Pickup</th>
                <th>Return</th>
                <th>Total</th>
                <th>Earnings</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {trips.map((trip) => (
                <tr key={trip.id}>
                  <td>{trip.tripCode}</td>
                  <td>{trip.listing?.title || '-'}</td>
                  <td>{trip.guestCustomer ? [trip.guestCustomer.firstName, trip.guestCustomer.lastName].filter(Boolean).join(' ') : '-'}</td>
                  <td><span className={statusChip(trip.status)}>{trip.status}</span></td>
                  <td>{trip.scheduledPickupAt ? new Date(trip.scheduledPickupAt).toLocaleString() : '-'}</td>
                  <td>{trip.scheduledReturnAt ? new Date(trip.scheduledReturnAt).toLocaleString() : '-'}</td>
                  <td>{formatMoney(trip.quotedTotal)}</td>
                  <td>{formatMoney(trip.hostEarnings)}</td>
                  <td>
                    <div className="inline-actions">
                      {tripActionsFor(trip.status).map((action) => (
                        <button key={action} type="button" className="button-subtle" onClick={() => moveTrip(trip.id, action)}>
                          {action}
                        </button>
                      ))}
                      {trip.reservation?.id ? (
                        <a href={`/reservations/${trip.reservation.id}`}>
                          <button type="button">Open Workflow</button>
                        </a>
                      ) : null}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {!trips.length && !loading ? <div className="surface-note">No trips yet for this host.</div> : null}
      </section>
    </AppShell>
  );
}
