'use client';

import { useEffect, useMemo, useState } from 'react';
import { AuthGate } from '../../components/AuthGate';
import { AppShell } from '../../components/AppShell';
import { api } from '../../lib/client';

function formatMoney(value) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(Number(value || 0));
}

function formatDateTime(value) {
  if (!value) return '-';
  try { return new Date(value).toLocaleString(); } catch { return String(value); }
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

function hostAttention(trip) {
  const current = String(trip?.status || '').toUpperCase();
  const reservation = trip?.reservation || null;
  if (current === 'DISPUTED') return { label: 'Dispute Open', tone: 'warn' };
  if (!reservation) return { label: 'Missing Workflow', tone: 'warn' };
  if (!reservation.customerInfoCompletedAt) return { label: 'Guest Pre-check-in Pending', tone: 'neutral' };
  if (!reservation.signatureSignedAt) return { label: 'Signature Pending', tone: 'neutral' };
  if (Number(reservation?.rentalAgreement?.balance || 0) > 0) return { label: 'Payment Balance Pending', tone: 'warn' };
  if (!reservation.readyForPickupAt && ['CONFIRMED', 'READY_FOR_PICKUP'].includes(current)) return { label: 'Awaiting Pickup Readiness', tone: 'neutral' };
  return { label: 'Healthy', tone: 'good' };
}

const EMPTY_LISTING_EDIT = {
  id: '', shortDescription: '', description: '', status: 'DRAFT',
  baseDailyRate: '', cleaningFee: '', deliveryFee: '', securityDeposit: '',
  instantBook: false, minTripDays: '1', maxTripDays: '', tripRules: ''
};

const EMPTY_WINDOW_FORM = {
  startAt: '', endAt: '', isBlocked: false, priceOverride: '', minTripDaysOverride: '', note: ''
};

const EMPTY_ISSUE_FORM = {
  tripId: '', type: 'OTHER', title: '', description: '', amountClaimed: ''
};

function WatchCard({ trip, onMove }) {
  const attention = hostAttention(trip);
  const nextAction = tripActionsFor(trip.status)[0];
  return (
    <div className="surface-note" style={{ display: 'grid', gap: 10 }}>
      <div className="row-between" style={{ gap: 12, alignItems: 'start' }}>
        <div>
          <div style={{ fontWeight: 700 }}>{trip.tripCode}</div>
          <div className="label" style={{ textTransform: 'none', letterSpacing: 0, fontSize: 12 }}>
            {[trip.listing?.title || 'Listing', trip.guestCustomer ? [trip.guestCustomer.firstName, trip.guestCustomer.lastName].filter(Boolean).join(' ') : 'Guest'].join(' · ')}
          </div>
        </div>
        <span className={`status-chip ${attention.tone === 'good' ? 'good' : attention.tone === 'warn' ? 'warn' : 'neutral'}`}>{attention.label}</span>
      </div>
      <div className="metric-grid">
        <div className="metric-card"><span className="label">Pickup</span><strong>{formatDateTime(trip.scheduledPickupAt)}</strong></div>
        <div className="metric-card"><span className="label">Return</span><strong>{formatDateTime(trip.scheduledReturnAt)}</strong></div>
        <div className="metric-card"><span className="label">Status</span><strong>{trip.status}</strong></div>
        <div className="metric-card"><span className="label">Earnings</span><strong>{formatMoney(trip.hostEarnings)}</strong></div>
      </div>
      <div className="inline-actions">
        {trip.reservation?.id ? <a href={`/reservations/${trip.reservation.id}`}><button type="button">Open Workflow</button></a> : null}
        {nextAction ? <button type="button" className="button-subtle" onClick={onMove}>{nextAction}</button> : null}
      </div>
    </div>
  );
}

export default function HostAppPage() {
  return <AuthGate>{({ token, me, logout }) => <HostAppInner token={token} me={me} logout={logout} />}</AuthGate>;
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
  const [issueForm, setIssueForm] = useState(EMPTY_ISSUE_FORM);
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
      if (!selectedHostProfileId && payload?.hostProfile?.id) setSelectedHostProfileId(payload.hostProfile.id);
      setMsg('');
    } catch (error) {
      setDashboard(null);
      setMsg(error.message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(); }, [scopedQuery, token]);

  const metrics = dashboard?.metrics || { listings: 0, activeListings: 0, instantBookListings: 0, trips: 0, activeTrips: 0, projectedEarnings: 0 };
  const host = dashboard?.hostProfile || null;
  const listings = dashboard?.listings || [];
  const trips = dashboard?.trips || [];

  const hostSnapshot = useMemo(() => {
    const now = Date.now();
    const upcomingPickups = trips.filter((trip) => {
      const pickup = trip?.scheduledPickupAt ? new Date(trip.scheduledPickupAt).getTime() : null;
      return pickup && pickup >= now && pickup <= now + 48 * 60 * 60 * 1000 && ['RESERVED', 'CONFIRMED', 'READY_FOR_PICKUP'].includes(String(trip.status || '').toUpperCase());
    });
    const watchlist = trips.filter((trip) => hostAttention(trip).tone !== 'good');
    const disputed = trips.filter((trip) => String(trip.status || '').toUpperCase() === 'DISPUTED');
    const completedTrips = trips.filter((trip) => String(trip.status || '').toUpperCase() === 'COMPLETED');
    return {
      upcomingPickups,
      watchlist,
      disputed,
      completedTrips,
      earnedCompleted: Number(completedTrips.reduce((sum, trip) => sum + Number(trip.hostEarnings || 0), 0).toFixed(2)),
      atRisk: Number(disputed.reduce((sum, trip) => sum + Number(trip.hostEarnings || 0), 0).toFixed(2))
    };
  }, [trips]);

  async function saveListingEdit(event) {
    event.preventDefault();
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

  async function submitIssue(event) {
    event.preventDefault();
    if (!issueForm.tripId) {
      setMsg('Choose a trip first');
      return;
    }
    try {
      await api(`/api/host-app/trips/${issueForm.tripId}/incidents`, {
        method: 'POST',
        body: JSON.stringify({
          type: issueForm.type,
          title: issueForm.title,
          description: issueForm.description,
          amountClaimed: issueForm.amountClaimed === '' ? null : Number(issueForm.amountClaimed)
        })
      }, token);
      setIssueForm(EMPTY_ISSUE_FORM);
      setMsg('Issue submitted for customer service review');
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
              Manage your listings, watch upcoming trips, and stay ahead of guest issues from one host surface.
            </h1>
            <p>This next slice makes the host app more operational: better pickup visibility, earnings context, a cleaner attention queue, and faster trip follow-up.</p>
            <div className="hero-meta">
              <span className="hero-pill">Host dashboard</span>
              <span className="hero-pill">Earnings visibility</span>
              <span className="hero-pill">Trip watchlist</span>
            </div>
          </div>
          <div className="glass card section-card">
            <div className="section-title">Host Snapshot</div>
            <div className="metric-grid">
              <div className="metric-card"><span className="label">Listings</span><strong>{metrics.listings}</strong></div>
              <div className="metric-card"><span className="label">Published</span><strong>{metrics.activeListings}</strong></div>
              <div className="metric-card"><span className="label">Active Trips</span><strong>{metrics.activeTrips}</strong></div>
              <div className="metric-card"><span className="label">Projected Earnings</span><strong>{formatMoney(metrics.projectedEarnings)}</strong></div>
              <div className="metric-card"><span className="label">Upcoming Pickups</span><strong>{hostSnapshot.upcomingPickups.length}</strong></div>
              <div className="metric-card"><span className="label">Needs Attention</span><strong>{hostSnapshot.watchlist.length}</strong></div>
              <div className="metric-card"><span className="label">Completed Trips</span><strong>{hostSnapshot.completedTrips.length}</strong></div>
              <div className="metric-card"><span className="label">Earned Closed</span><strong>{formatMoney(hostSnapshot.earnedCompleted)}</strong></div>
            </div>
            {host ? (
              <div className="surface-note"><strong>{host.displayName}</strong><br />{[host.tenant?.name || 'No tenant', host.status].join(' · ')}<br />{host.payoutEnabled ? 'Payouts enabled' : 'Payouts not enabled yet'}</div>
            ) : (
              <div className="surface-note">{loading ? 'Loading host profile...' : 'No host profile is linked to this login yet. Admins can still use the selector below to support hosts.'}</div>
            )}
          </div>
        </div>
      </section>

      {msg ? <div className="surface-note" style={{ color: /updated|moved|added|removed/i.test(msg) ? '#166534' : '#991b1b', marginBottom: 18 }}>{msg}</div> : null}

      {isAdminViewer ? (
        <section className="glass card-lg section-card" style={{ marginBottom: 18 }}>
          <div className="row-between">
            <div><div className="section-title">Host Selector</div><p className="ui-muted">Admins and ops can support a specific host from this focused host surface.</p></div>
            <span className="status-chip neutral">Admin Support</span>
          </div>
          <div style={{ maxWidth: 380 }}>
            <div className="label">Host</div>
            <select value={selectedHostProfileId} onChange={(event) => setSelectedHostProfileId(event.target.value)}>
              <option value="">Choose host</option>
              {(dashboard?.availableHosts || []).map((row) => <option key={row.id} value={row.id}>{row.displayName}</option>)}
            </select>
          </div>
        </section>
      ) : null}

      <section className="split-panel">
        <section className="glass card-lg section-card">
          <div className="row-between">
            <div><div className="section-title">Host Action Center</div><p className="ui-muted">Stay ahead of pickups, guest readiness, and payout risk from one place.</p></div>
            <span className="status-chip neutral">{hostSnapshot.watchlist.length} watchlist items</span>
          </div>
          <div className="metric-grid">
            <div className="metric-card"><span className="label">Upcoming Pickups</span><strong>{hostSnapshot.upcomingPickups.length}</strong></div>
            <div className="metric-card"><span className="label">Issues / Disputes</span><strong>{hostSnapshot.disputed.length}</strong></div>
            <div className="metric-card"><span className="label">At Risk Earnings</span><strong>{formatMoney(hostSnapshot.atRisk)}</strong></div>
            <div className="metric-card"><span className="label">Completed Earnings</span><strong>{formatMoney(hostSnapshot.earnedCompleted)}</strong></div>
          </div>
          {hostSnapshot.watchlist.length ? (
            <div className="stack">{hostSnapshot.watchlist.slice(0, 4).map((trip) => <WatchCard key={trip.id} trip={trip} onMove={() => moveTrip(trip.id, tripActionsFor(trip.status)[0])} />)}</div>
          ) : <div className="surface-note">Your host watchlist is clear right now.</div>}
        </section>

        <section className="glass card-lg section-card">
          <div className="row-between">
            <div><div className="section-title">Upcoming Pickups</div><p className="ui-muted">Trips scheduled in the next 48 hours so hosts can stay prepared.</p></div>
            <span className="status-chip neutral">{hostSnapshot.upcomingPickups.length} coming up</span>
          </div>
          {hostSnapshot.upcomingPickups.length ? (
            <div className="stack">
              {hostSnapshot.upcomingPickups.slice(0, 4).map((trip) => (
                <div key={trip.id} className="surface-note" style={{ display: 'grid', gap: 8 }}>
                  <div className="row-between" style={{ gap: 12 }}>
                    <strong>{trip.tripCode}</strong>
                    <span className={statusChip(trip.status)}>{trip.status}</span>
                  </div>
                  <div style={{ color: '#55456f', lineHeight: 1.5 }}>{[trip.listing?.title || 'Listing', formatDateTime(trip.scheduledPickupAt)].join(' · ')}</div>
                  <div className="inline-actions">{trip.reservation?.id ? <a href={`/reservations/${trip.reservation.id}`}><button type="button">Open Workflow</button></a> : null}</div>
                </div>
              ))}
            </div>
          ) : <div className="surface-note">No upcoming pickups in the next 48 hours.</div>}
        </section>
      </section>

      <section className="split-panel" style={{ marginTop: 18 }}>
        <section className="glass card-lg section-card">
          <div className="row-between">
            <div><div className="section-title">My Listings</div><p className="ui-muted">Edit the host-facing listing details and pricing without opening the full car sharing console.</p></div>
            <span className="status-chip neutral">{metrics.instantBookListings} instant book</span>
          </div>
          {listings.length ? (
            <div className="metric-grid">
              {listings.map((listing) => (
                <div key={listing.id} className="glass card section-card" style={{ padding: 14 }}>
                  <div className="row-between" style={{ alignItems: 'start', gap: 12 }}>
                    <div><div style={{ fontWeight: 700 }}>{listing.title}</div><div className="label" style={{ textTransform: 'none', letterSpacing: 0, fontSize: 12 }}>{listing.vehicle ? `${listing.vehicle.year || ''} ${listing.vehicle.make || ''} ${listing.vehicle.model || ''}`.trim() : 'No vehicle'}</div></div>
                    <span className={statusChip(listing.status)}>{listing.status}</span>
                  </div>
                  <div className="metric-grid">
                    <div className="metric-card"><span className="label">Daily Rate</span><strong>{formatMoney(listing.baseDailyRate)}</strong></div>
                    <div className="metric-card"><span className="label">Instant Book</span><strong>{listing.instantBook ? 'On' : 'Off'}</strong></div>
                    <div className="metric-card"><span className="label">Min Stay</span><strong>{listing.minTripDays} day(s)</strong></div>
                  </div>
                  <div className="inline-actions">
                    <button type="button" onClick={() => setListingEdit({
                      id: listing.id, shortDescription: listing.shortDescription || '', description: listing.description || '', status: listing.status || 'DRAFT',
                      baseDailyRate: String(listing.baseDailyRate ?? ''), cleaningFee: String(listing.cleaningFee ?? ''), deliveryFee: String(listing.deliveryFee ?? ''),
                      securityDeposit: String(listing.securityDeposit ?? ''), instantBook: !!listing.instantBook, minTripDays: String(listing.minTripDays ?? 1),
                      maxTripDays: listing.maxTripDays ? String(listing.maxTripDays) : '', tripRules: listing.tripRules || ''
                    })}>Edit Listing</button>
                    <button type="button" className="button-subtle" onClick={() => loadAvailability(listing.id)}>Availability</button>
                  </div>
                </div>
              ))}
            </div>
          ) : <div className="surface-note">No listings yet for this host.</div>}
        </section>

        <section className="glass card-lg section-card">
          <div className="row-between">
            <div><div className="section-title">Listing Editor</div><p className="ui-muted">Host-safe edit surface for pricing, availability mode, and trip rules.</p></div>
            {listingEdit.id ? <button type="button" className="button-subtle" onClick={() => setListingEdit(EMPTY_LISTING_EDIT)}>Clear</button> : null}
          </div>
          {listingEdit.id ? (
            <form className="stack" onSubmit={saveListingEdit}>
              <div className="stack"><label className="label">Short Description</label><input value={listingEdit.shortDescription} onChange={(event) => setListingEdit((current) => ({ ...current, shortDescription: event.target.value }))} /></div>
              <div className="stack"><label className="label">Description</label><textarea rows={4} value={listingEdit.description} onChange={(event) => setListingEdit((current) => ({ ...current, description: event.target.value }))} /></div>
              <div className="form-grid-3">
                <div className="stack"><label className="label">Status</label><select value={listingEdit.status} onChange={(event) => setListingEdit((current) => ({ ...current, status: event.target.value }))}><option value="DRAFT">DRAFT</option><option value="PUBLISHED">PUBLISHED</option><option value="PAUSED">PAUSED</option><option value="ARCHIVED">ARCHIVED</option></select></div>
                <div className="stack"><label className="label">Daily Rate</label><input type="number" min="0" step="0.01" value={listingEdit.baseDailyRate} onChange={(event) => setListingEdit((current) => ({ ...current, baseDailyRate: event.target.value }))} /></div>
                <div className="stack"><label className="label">Security Deposit</label><input type="number" min="0" step="0.01" value={listingEdit.securityDeposit} onChange={(event) => setListingEdit((current) => ({ ...current, securityDeposit: event.target.value }))} /></div>
                <div className="stack"><label className="label">Cleaning Fee</label><input type="number" min="0" step="0.01" value={listingEdit.cleaningFee} onChange={(event) => setListingEdit((current) => ({ ...current, cleaningFee: event.target.value }))} /></div>
                <div className="stack"><label className="label">Delivery Fee</label><input type="number" min="0" step="0.01" value={listingEdit.deliveryFee} onChange={(event) => setListingEdit((current) => ({ ...current, deliveryFee: event.target.value }))} /></div>
                <div className="stack"><label className="label">Min Trip Days</label><input type="number" min="1" value={listingEdit.minTripDays} onChange={(event) => setListingEdit((current) => ({ ...current, minTripDays: event.target.value }))} /></div>
                <div className="stack"><label className="label">Max Trip Days</label><input type="number" min="1" value={listingEdit.maxTripDays} onChange={(event) => setListingEdit((current) => ({ ...current, maxTripDays: event.target.value }))} /></div>
              </div>
              <label className="label" style={{ textTransform: 'none', letterSpacing: 0 }}><input type="checkbox" checked={listingEdit.instantBook} onChange={(event) => setListingEdit((current) => ({ ...current, instantBook: event.target.checked }))} /> Instant Book</label>
              <div className="stack"><label className="label">Trip Rules</label><textarea rows={3} value={listingEdit.tripRules} onChange={(event) => setListingEdit((current) => ({ ...current, tripRules: event.target.value }))} /></div>
              <div className="inline-actions"><button type="submit">Save Listing</button></div>
            </form>
          ) : <div className="surface-note">Choose a listing to edit host-facing pricing and publishing controls.</div>}
        </section>
      </section>

      <section className="split-panel" style={{ marginTop: 18 }}>
        <section className="glass card-lg section-card">
          <div className="row-between">
            <div><div className="section-title">Availability Windows</div><p className="ui-muted">Block dates, set price overrides, or require a longer minimum stay from the host surface.</p></div>
            <select value={availabilityListingId} onChange={(event) => loadAvailability(event.target.value)} style={{ maxWidth: 280 }}>
              <option value="">Choose listing</option>
              {listings.map((row) => <option key={row.id} value={row.id}>{row.title}</option>)}
            </select>
          </div>
          {availabilityListingId ? (
            availabilityRows.length ? (
              <div className="stack">
                {availabilityRows.map((row) => (
                  <div key={row.id} className="surface-note" style={{ display: 'grid', gap: 8 }}>
                    <div className="row-between" style={{ gap: 12 }}>
                      <strong>{formatDateTime(row.startAt)} → {formatDateTime(row.endAt)}</strong>
                      <span className={row.isBlocked ? 'status-chip warn' : 'status-chip good'}>{row.isBlocked ? 'Blocked' : 'Open'}</span>
                    </div>
                    <div style={{ color: '#55456f', lineHeight: 1.5 }}>{`Price override: ${row.priceOverride != null ? formatMoney(row.priceOverride) : 'None'} · Min days override: ${row.minTripDaysOverride || '-'}`}</div>
                    <div style={{ color: '#55456f', lineHeight: 1.5 }}>{row.note || 'No notes'}</div>
                    <div className="inline-actions"><button type="button" className="button-subtle" onClick={() => removeAvailabilityWindow(row.id)}>Delete</button></div>
                  </div>
                ))}
              </div>
            ) : <div className="surface-note">No availability windows yet for this listing.</div>
          ) : <div className="surface-note">Choose a listing to manage availability windows.</div>}
        </section>

        <section className="glass card-lg section-card">
          <div className="row-between">
            <div><div className="section-title">Add Availability Window</div><p className="ui-muted">Useful for blackout dates, seasonal pricing, and minimum-stay control.</p></div>
            {availabilityListingId ? <span className="status-chip neutral">Listing Selected</span> : null}
          </div>
          <form className="stack" onSubmit={saveAvailabilityWindow}>
            <div className="form-grid-2">
              <div className="stack"><label className="label">Start</label><input type="datetime-local" value={windowForm.startAt} onChange={(event) => setWindowForm((current) => ({ ...current, startAt: event.target.value }))} /></div>
              <div className="stack"><label className="label">End</label><input type="datetime-local" value={windowForm.endAt} onChange={(event) => setWindowForm((current) => ({ ...current, endAt: event.target.value }))} /></div>
              <div className="stack"><label className="label">Price Override</label><input type="number" min="0" step="0.01" value={windowForm.priceOverride} onChange={(event) => setWindowForm((current) => ({ ...current, priceOverride: event.target.value }))} /></div>
              <div className="stack"><label className="label">Min Trip Days Override</label><input type="number" min="1" value={windowForm.minTripDaysOverride} onChange={(event) => setWindowForm((current) => ({ ...current, minTripDaysOverride: event.target.value }))} /></div>
            </div>
            <label className="label" style={{ textTransform: 'none', letterSpacing: 0 }}><input type="checkbox" checked={windowForm.isBlocked} onChange={(event) => setWindowForm((current) => ({ ...current, isBlocked: event.target.checked }))} /> Block these dates</label>
            <div className="stack"><label className="label">Note</label><textarea rows={3} value={windowForm.note} onChange={(event) => setWindowForm((current) => ({ ...current, note: event.target.value }))} /></div>
            <div className="inline-actions"><button type="submit">Add Window</button></div>
          </form>
        </section>
      </section>

      <section className="split-panel" style={{ marginTop: 18 }}>
        <section className="glass card-lg section-card">
          <div className="row-between">
            <div><div className="section-title">Report Issue Or Dispute</div><p className="ui-muted">Hosts can raise damage, toll, cleaning, late return, or other disputes from here.</p></div>
            <a href="/issues"><button type="button" className="button-subtle">Open Issue Center</button></a>
          </div>
          <form className="stack" onSubmit={submitIssue}>
            <div className="form-grid-2">
              <div className="stack">
                <label className="label">Trip</label>
                <select value={issueForm.tripId} onChange={(event) => setIssueForm((current) => ({ ...current, tripId: event.target.value }))}>
                  <option value="">Choose trip</option>
                  {trips.map((trip) => <option key={trip.id} value={trip.id}>{trip.tripCode} - {trip.listing?.title || 'Listing'}</option>)}
                </select>
              </div>
              <div className="stack">
                <label className="label">Type</label>
                <select value={issueForm.type} onChange={(event) => setIssueForm((current) => ({ ...current, type: event.target.value }))}>
                  <option value="DAMAGE">DAMAGE</option>
                  <option value="TOLL">TOLL</option>
                  <option value="CLEANING">CLEANING</option>
                  <option value="LATE_RETURN">LATE_RETURN</option>
                  <option value="OTHER">OTHER</option>
                </select>
              </div>
              <div className="stack">
                <label className="label">Title</label>
                <input value={issueForm.title} onChange={(event) => setIssueForm((current) => ({ ...current, title: event.target.value }))} placeholder="Short issue title" />
              </div>
              <div className="stack">
                <label className="label">Amount Claimed</label>
                <input type="number" min="0" step="0.01" value={issueForm.amountClaimed} onChange={(event) => setIssueForm((current) => ({ ...current, amountClaimed: event.target.value }))} placeholder="Optional" />
              </div>
            </div>
            <div className="stack">
              <label className="label">Description</label>
              <textarea rows={4} value={issueForm.description} onChange={(event) => setIssueForm((current) => ({ ...current, description: event.target.value }))} placeholder="Describe the issue and what happened" />
            </div>
            <div className="inline-actions"><button type="submit">Submit Issue</button></div>
          </form>
        </section>

        <section className="glass card-lg section-card">
          <div className="row-between">
            <div><div className="section-title">Recent Issues And Disputes</div><p className="ui-muted">A quick host-facing view of open or recently raised cases.</p></div>
            <span className="status-chip neutral">{trips.reduce((sum, trip) => sum + (trip.incidents?.length || 0), 0)} cases</span>
          </div>
          {trips.some((trip) => (trip.incidents?.length || 0) > 0) ? (
            <div className="stack">
              {trips.filter((trip) => (trip.incidents?.length || 0) > 0).slice(0, 4).map((trip) => (
                <div key={trip.id} className="surface-note" style={{ display: 'grid', gap: 10 }}>
                  <strong>{trip.tripCode} - {trip.listing?.title || 'Listing'}</strong>
                  <div className="stack">
                    {(trip.incidents || []).map((incident) => (
                      <div key={incident.id} className="doc-card">
                        <div className="row-between" style={{ gap: 10 }}>
                          <strong>{incident.title}</strong>
                          <span className={statusChip(incident.status)}>{incident.status}</span>
                        </div>
                        <div className="label" style={{ textTransform: 'none', letterSpacing: 0, fontSize: 12 }}>
                          {[incident.type, incident.amountClaimed ? formatMoney(incident.amountClaimed) : 'No amount claimed'].join(' - ')}
                        </div>
                        <div style={{ color: '#55456f', lineHeight: 1.5 }}>{incident.description || 'No details provided.'}</div>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          ) : <div className="surface-note">No issue or dispute cases have been raised yet.</div>}
        </section>
      </section>

      <section className="glass card-lg section-card" style={{ marginTop: 18 }}>
        <div className="row-between">
          <div><div className="section-title">My Trips</div><p className="ui-muted">Watch incoming trips, see guest readiness, and move them through the next host-facing operational status.</p></div>
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
                <th>Attention</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {trips.map((trip) => {
                const attention = hostAttention(trip);
                return (
                  <tr key={trip.id}>
                    <td>{trip.tripCode}</td>
                    <td>{trip.listing?.title || '-'}</td>
                    <td>{trip.guestCustomer ? [trip.guestCustomer.firstName, trip.guestCustomer.lastName].filter(Boolean).join(' ') : '-'}</td>
                    <td><span className={statusChip(trip.status)}>{trip.status}</span></td>
                    <td>{formatDateTime(trip.scheduledPickupAt)}</td>
                    <td>{formatDateTime(trip.scheduledReturnAt)}</td>
                    <td>{formatMoney(trip.quotedTotal)}</td>
                    <td>{formatMoney(trip.hostEarnings)}</td>
                    <td><span className={`status-chip ${attention.tone === 'good' ? 'good' : attention.tone === 'warn' ? 'warn' : 'neutral'}`}>{attention.label}</span></td>
                    <td>
                      <div className="inline-actions">
                        {tripActionsFor(trip.status).map((action) => <button key={action} type="button" className="button-subtle" onClick={() => moveTrip(trip.id, action)}>{action}</button>)}
                        {trip.reservation?.id ? <a href={`/reservations/${trip.reservation.id}`}><button type="button">Open Workflow</button></a> : null}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {!trips.length && !loading ? <div className="surface-note">No trips yet for this host.</div> : null}
      </section>
    </AppShell>
  );
}
