'use client';

import { useEffect, useMemo, useState } from 'react';
import { AuthGate } from '../../components/AuthGate';
import { AppShell } from '../../components/AppShell';
import { api } from '../../lib/client';

const EMPTY_HOST = {
  id: '',
  displayName: '',
  legalName: '',
  email: '',
  phone: '',
  status: 'ACTIVE',
  payoutProvider: '',
  payoutAccountRef: '',
  payoutEnabled: false,
  notes: ''
};

const EMPTY_LISTING = {
  id: '',
  hostProfileId: '',
  vehicleId: '',
  locationId: '',
  title: '',
  shortDescription: '',
  description: '',
  status: 'DRAFT',
  ownershipType: 'HOST_OWNED',
  currency: 'USD',
  baseDailyRate: '',
  cleaningFee: '',
  deliveryFee: '',
  securityDeposit: '',
  instantBook: false,
  minTripDays: '1',
  maxTripDays: '',
  tripRules: ''
};

const EMPTY_WINDOW = {
  id: '',
  startAt: '',
  endAt: '',
  isBlocked: false,
  priceOverride: '',
  minTripDaysOverride: '',
  note: ''
};

const EMPTY_TRIP = {
  guestCustomerId: '',
  scheduledPickupAt: '',
  scheduledReturnAt: '',
  pickupLocationId: '',
  returnLocationId: '',
  notes: ''
};

const discoveryBullets = [
  'Use Fleet Manager as the internal ops spine while hosts and guests get marketplace-specific flows.',
  'Reuse reservations, pricing, agreements, inspections, portal steps, and earnings ledgers instead of rebuilding the stack.',
  'Build supply management first, then public listing discovery and guest booking.'
];

function normalizeMoney(value) {
  if (value === '' || value === null || value === undefined) return 0;
  const num = Number(value);
  return Number.isFinite(num) ? num : 0;
}

function toLocalDateTimeInput(value) {
  if (!value) return '';
  const dt = new Date(value);
  if (Number.isNaN(dt.getTime())) return '';
  const pad = (n) => String(n).padStart(2, '0');
  return `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}T${pad(dt.getHours())}:${pad(dt.getMinutes())}`;
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

function tripWorkflowSummary(trip) {
  const reservation = trip?.reservation;
  const agreement = reservation?.rentalAgreement;
  const reservationStatus = String(reservation?.status || '').toUpperCase();
  const agreementStatus = String(agreement?.status || '').toUpperCase();
  const paymentStatus = String(reservation?.paymentStatus || '').toUpperCase();

  const checks = [
    { label: 'Customer Info', done: !!reservation?.customerInfoCompletedAt },
    { label: 'Signature', done: !!reservation?.signatureSignedAt },
    { label: 'Ready', done: !!reservation?.readyForPickupAt },
    { label: 'Checkout', done: reservationStatus === 'CHECKED_OUT' || reservationStatus === 'CHECKED_IN' },
    { label: 'Check-in', done: reservationStatus === 'CHECKED_IN' || agreementStatus === 'CLOSED' }
  ];

  if (!reservation) {
    return {
      stageLabel: 'Reservation Pending',
      nextAction: 'Create the operational reservation workflow',
      paymentLabel: 'No payment workflow yet',
      checks
    };
  }

  if (reservationStatus === 'CANCELLED' || reservationStatus === 'NO_SHOW' || String(trip?.status || '').toUpperCase() === 'CANCELLED') {
    return {
      stageLabel: 'Trip Cancelled',
      nextAction: 'Review cancellation and payout outcome',
      paymentLabel: paymentStatus || 'PENDING',
      checks
    };
  }

  if (reservationStatus === 'CHECKED_IN' || agreementStatus === 'CLOSED') {
    return {
      stageLabel: 'Trip Closed',
      nextAction: 'Review receipts, damages, and host payout',
      paymentLabel: paymentStatus === 'PAID' ? 'Paid in Full' : paymentStatus,
      checks
    };
  }

  if (reservationStatus === 'CHECKED_OUT') {
    return {
      stageLabel: 'Trip In Progress',
      nextAction: 'Run check-in, final inspection, and close-out',
      paymentLabel: paymentStatus === 'PAID' ? 'Paid in Full' : paymentStatus,
      checks
    };
  }

  if (reservation?.readyForPickupAt) {
    return {
      stageLabel: 'Ready For Pickup',
      nextAction: 'Run checkout and hand off the vehicle',
      paymentLabel: paymentStatus === 'PAID' ? 'Paid in Full' : paymentStatus,
      checks
    };
  }

  if (reservation?.customerInfoReviewedAt) {
    return {
      stageLabel: 'Reviewed - Awaiting Pickup',
      nextAction: 'Mark ready for pickup or clear outstanding ops items',
      paymentLabel: paymentStatus,
      checks
    };
  }

  if (reservation?.signatureSignedAt && reservation?.customerInfoCompletedAt) {
    return {
      stageLabel: 'Signed - Awaiting Ops Review',
      nextAction: 'Review docs and mark ready for pickup',
      paymentLabel: paymentStatus,
      checks
    };
  }

  if (reservation?.customerInfoCompletedAt) {
    return {
      stageLabel: 'Customer Info Complete',
      nextAction: 'Request signature and payment',
      paymentLabel: paymentStatus,
      checks
    };
  }

  return {
    stageLabel: 'Guest Intake Pending',
    nextAction: 'Request customer information, signature, and payment',
    paymentLabel: paymentStatus,
    checks
  };
}

function HostCard({ host, onEdit }) {
  return (
    <div className="glass card stack" style={{ padding: 14, gap: 8 }}>
      <div className="row-between" style={{ alignItems: 'flex-start', gap: 12 }}>
        <div>
          <div style={{ fontWeight: 700 }}>{host.displayName}</div>
          <div className="label" style={{ textTransform: 'none', letterSpacing: 0, fontSize: 12 }}>
            {host.email || 'No email'} {host.phone ? `· ${host.phone}` : ''}
          </div>
        </div>
        <button type="button" onClick={() => onEdit(host)}>Edit</button>
      </div>
      <div className="row-between">
        <span className="label">Status</span>
        <strong>{host.status}</strong>
      </div>
      <div className="row-between">
        <span className="label">Listings</span>
        <strong>{host._count?.listings || 0}</strong>
      </div>
      <div className="row-between">
        <span className="label">Trips</span>
        <strong>{host._count?.trips || 0}</strong>
      </div>
      <div className="row-between">
        <span className="label">Payouts Enabled</span>
        <strong>{host.payoutEnabled ? 'Yes' : 'No'}</strong>
      </div>
    </div>
  );
}

function ListingCard({ listing, onEdit }) {
  return (
    <div className="glass card stack" style={{ padding: 14, gap: 8 }}>
      <div className="row-between" style={{ alignItems: 'flex-start', gap: 12 }}>
        <div>
          <div style={{ fontWeight: 700 }}>{listing.title}</div>
          <div className="label" style={{ textTransform: 'none', letterSpacing: 0, fontSize: 12 }}>
            {listing.vehicle ? `${listing.vehicle.year || ''} ${listing.vehicle.make || ''} ${listing.vehicle.model || ''}`.trim() : 'No vehicle'} · {listing.slug}
          </div>
        </div>
        <button type="button" onClick={() => onEdit(listing)}>Edit</button>
      </div>
      <div className="row-between">
        <span className="label">Host</span>
        <strong>{listing.hostProfile?.displayName || '-'}</strong>
      </div>
      <div className="row-between">
        <span className="label">Status</span>
        <strong>{listing.status}</strong>
      </div>
      <div className="row-between">
        <span className="label">Daily Rate</span>
        <strong>${Number(listing.baseDailyRate || 0).toFixed(2)}</strong>
      </div>
      <div className="row-between">
        <span className="label">Instant Book</span>
        <strong>{listing.instantBook ? 'Enabled' : 'Off'}</strong>
      </div>
      <div className="row-between">
        <span className="label">Trips</span>
        <strong>{listing.trips?.length || 0}</strong>
      </div>
    </div>
  );
}

export default function CarSharingPage() {
  return (
    <AuthGate>
      {({ token, me, logout }) => <CarSharingInner token={token} me={me} logout={logout} />}
    </AuthGate>
  );
}

function CarSharingInner({ token, me, logout }) {
  const [msg, setMsg] = useState('');
  const [hosts, setHosts] = useState([]);
  const [listings, setListings] = useState([]);
  const [trips, setTrips] = useState([]);
  const [eligibleVehicles, setEligibleVehicles] = useState([]);
  const [vehicles, setVehicles] = useState([]);
  const [customers, setCustomers] = useState([]);
  const [locations, setLocations] = useState([]);
  const [tenants, setTenants] = useState([]);
  const [tenantConfig, setTenantConfig] = useState(null);
  const [hostForm, setHostForm] = useState(EMPTY_HOST);
  const [listingForm, setListingForm] = useState(EMPTY_LISTING);
  const [windowForm, setWindowForm] = useState(EMPTY_WINDOW);
  const [tripForm, setTripForm] = useState(EMPTY_TRIP);
  const [activeTenantId, setActiveTenantId] = useState('');
  const [loading, setLoading] = useState(true);

  const isSuper = String(me?.role || '').toUpperCase() === 'SUPER_ADMIN';

  const scopedQuery = useMemo(() => {
    const qs = new URLSearchParams();
    if (isSuper && activeTenantId) qs.set('tenantId', activeTenantId);
    const out = qs.toString();
    return out ? `?${out}` : '';
  }, [isSuper, activeTenantId]);

  const filteredVehicles = useMemo(() => {
    if (!activeTenantId || !isSuper) return vehicles;
    return vehicles.filter((row) => String(row.tenantId || '') === String(activeTenantId));
  }, [vehicles, activeTenantId, isSuper]);

  const assignableVehicles = useMemo(() => {
    if (!activeTenantId || !isSuper) return filteredVehicles;
    return vehicles.filter((row) => {
      const tenantId = String(row.tenantId || '');
      return tenantId === String(activeTenantId) || !tenantId;
    });
  }, [vehicles, filteredVehicles, activeTenantId, isSuper]);

  const filteredLocations = useMemo(() => {
    if (!activeTenantId || !isSuper) return locations;
    return locations.filter((row) => String(row.tenantId || '') === String(activeTenantId));
  }, [locations, activeTenantId, isSuper]);

  const filteredCustomers = useMemo(() => {
    if (!activeTenantId || !isSuper) return customers;
    return customers.filter((row) => String(row.tenantId || '') === String(activeTenantId));
  }, [customers, activeTenantId, isSuper]);

  const filteredEligibleVehicles = useMemo(() => {
    if (!activeTenantId || !isSuper) return eligibleVehicles;
    return eligibleVehicles.filter((row) => {
      const tenantId = String(row.tenantId || '');
      return tenantId === String(activeTenantId) || !tenantId;
    });
  }, [eligibleVehicles, activeTenantId, isSuper]);

  const load = async () => {
    try {
      setLoading(true);
      const reqs = [
        api(`/api/car-sharing/hosts${scopedQuery}`, {}, token),
        api(`/api/car-sharing/listings${scopedQuery}`, {}, token),
        api(`/api/car-sharing/trips${scopedQuery}`, {}, token),
        api(`/api/car-sharing/eligible-vehicles${scopedQuery}`, {}, token),
        api('/api/vehicles', {}, token),
        api('/api/customers', {}, token),
        api('/api/locations', {}, token),
        api(`/api/car-sharing/config${scopedQuery}`, {}, token)
      ];
      if (isSuper) reqs.push(api('/api/tenants', {}, token));
      const results = await Promise.all(reqs);
      setHosts(Array.isArray(results[0]) ? results[0] : []);
      setListings(Array.isArray(results[1]) ? results[1] : []);
      setTrips(Array.isArray(results[2]) ? results[2] : []);
      setEligibleVehicles(Array.isArray(results[3]) ? results[3] : []);
      setVehicles(Array.isArray(results[4]) ? results[4] : []);
      setCustomers(Array.isArray(results[5]) ? results[5] : []);
      setLocations(Array.isArray(results[6]) ? results[6] : []);
      setTenantConfig(results[7] || null);
      if (isSuper) {
        const rows = Array.isArray(results[8]) ? results[8] : [];
        setTenants(rows);
        if (!activeTenantId && rows[0]?.id) setActiveTenantId(rows[0].id);
      }
      setMsg('');
    } catch (e) {
      setMsg(e.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, [token, scopedQuery]);

  const resetHostForm = () => setHostForm(EMPTY_HOST);
  const resetListingForm = () => {
    setListingForm(EMPTY_LISTING);
    setWindowForm(EMPTY_WINDOW);
    setTripForm(EMPTY_TRIP);
  };

  const saveHost = async (e) => {
    e.preventDefault();
    try {
      const payload = {
        ...hostForm,
        tenantId: isSuper ? activeTenantId : undefined
      };
      if (hostForm.id) {
        await api(`/api/car-sharing/hosts/${hostForm.id}`, { method: 'PATCH', body: JSON.stringify(payload) }, token);
        setMsg('Host updated');
      } else {
        await api('/api/car-sharing/hosts', { method: 'POST', body: JSON.stringify(payload) }, token);
        setMsg('Host created');
      }
      resetHostForm();
      await load();
    } catch (e2) {
      setMsg(e2.message);
    }
  };

  const saveListing = async (e) => {
    e.preventDefault();
    try {
      const payload = {
        ...listingForm,
        tenantId: isSuper ? activeTenantId : undefined,
        baseDailyRate: normalizeMoney(listingForm.baseDailyRate),
        cleaningFee: normalizeMoney(listingForm.cleaningFee),
        deliveryFee: normalizeMoney(listingForm.deliveryFee),
        securityDeposit: normalizeMoney(listingForm.securityDeposit),
        minTripDays: Number(listingForm.minTripDays || 1),
        maxTripDays: listingForm.maxTripDays ? Number(listingForm.maxTripDays) : null
      };
      if (listingForm.id) {
        await api(`/api/car-sharing/listings/${listingForm.id}`, { method: 'PATCH', body: JSON.stringify(payload) }, token);
        setMsg('Listing updated');
      } else {
        await api('/api/car-sharing/listings', { method: 'POST', body: JSON.stringify(payload) }, token);
        setMsg('Listing created');
      }
      resetListingForm();
      await load();
    } catch (e2) {
      setMsg(e2.message);
    }
  };

  const activeHosts = hosts.filter((row) => !activeTenantId || !isSuper || String(row.tenantId || '') === String(activeTenantId));
  const canManageCarSharing = isSuper ? !!tenantConfig?.tenantId && !!tenantConfig?.enabled : !!tenantConfig?.enabled;
  const selectedListing = useMemo(() => listings.find((row) => row.id === listingForm.id) || null, [listings, listingForm.id]);
  const selectedListingTrips = useMemo(() => trips.filter((row) => row.listingId === selectedListing?.id), [trips, selectedListing?.id]);

  const updateVehicleFleetMode = async (vehicleId, fleetMode) => {
    try {
      const payload = { fleetMode };
      if (isSuper && activeTenantId) payload.tenantId = activeTenantId;
      await api(`/api/vehicles/${vehicleId}`, { method: 'PATCH', body: JSON.stringify(payload) }, token);
      setMsg(isSuper && activeTenantId ? 'Vehicle fleet mode updated and assigned to active tenant' : 'Vehicle fleet mode updated');
      await load();
    } catch (e) {
      setMsg(e.message);
    }
  };

  const saveAvailabilityWindow = async (e) => {
    e.preventDefault();
    if (!selectedListing?.id) {
      setMsg('Select an existing listing first to manage availability.');
      return;
    }
    try {
      const payload = {
        startAt: windowForm.startAt,
        endAt: windowForm.endAt,
        isBlocked: !!windowForm.isBlocked,
        priceOverride: windowForm.priceOverride === '' ? null : normalizeMoney(windowForm.priceOverride),
        minTripDaysOverride: windowForm.minTripDaysOverride ? Number(windowForm.minTripDaysOverride) : null,
        note: windowForm.note || null
      };
      if (windowForm.id) {
        await api(`/api/car-sharing/availability/${windowForm.id}`, { method: 'PATCH', body: JSON.stringify(payload) }, token);
        setMsg('Availability window updated');
      } else {
        await api(`/api/car-sharing/listings/${selectedListing.id}/availability`, { method: 'POST', body: JSON.stringify(payload) }, token);
        setMsg('Availability window created');
      }
      setWindowForm(EMPTY_WINDOW);
      await load();
    } catch (e) {
      setMsg(e.message);
    }
  };

  const deleteAvailabilityWindow = async (id) => {
    try {
      await api(`/api/car-sharing/availability/${id}`, { method: 'DELETE' }, token);
      setMsg('Availability window deleted');
      if (windowForm.id === id) setWindowForm(EMPTY_WINDOW);
      await load();
    } catch (e) {
      setMsg(e.message);
    }
  };

  useEffect(() => {
    if (!selectedListing) return;
    setTripForm((current) => ({
      ...current,
      pickupLocationId: current.pickupLocationId || selectedListing.locationId || '',
      returnLocationId: current.returnLocationId || selectedListing.locationId || ''
    }));
  }, [selectedListing]);

  const saveTrip = async (e) => {
    e.preventDefault();
    if (!selectedListing?.id) {
      setMsg('Select an existing listing first to create a trip.');
      return;
    }
    try {
      const created = await api('/api/car-sharing/trips', {
        method: 'POST',
        body: JSON.stringify({
          tenantId: isSuper ? activeTenantId : undefined,
          listingId: selectedListing.id,
          guestCustomerId: tripForm.guestCustomerId || null,
          scheduledPickupAt: tripForm.scheduledPickupAt,
          scheduledReturnAt: tripForm.scheduledReturnAt,
          pickupLocationId: tripForm.pickupLocationId || null,
          returnLocationId: tripForm.returnLocationId || null,
          notes: tripForm.notes || null
        })
      }, token);
      setMsg(created?.reservation?.reservationNumber
        ? `Trip created and linked to reservation ${created.reservation.reservationNumber}`
        : 'Trip created');
      setTripForm({
        ...EMPTY_TRIP,
        pickupLocationId: selectedListing.locationId || '',
        returnLocationId: selectedListing.locationId || ''
      });
      await load();
    } catch (e) {
      setMsg(e.message);
    }
  };

  const updateTripStatus = async (tripId, status) => {
    try {
      await api(`/api/car-sharing/trips/${tripId}/status`, {
        method: 'PATCH',
        body: JSON.stringify({ status, note: `Trip moved to ${status}` })
      }, token);
      setMsg(`Trip moved to ${status}`);
      await load();
    } catch (e) {
      setMsg(e.message);
    }
  };

  const provisionTripWorkflow = async (tripId) => {
    try {
      const trip = await api(`/api/car-sharing/trips/${tripId}/provision-workflow`, {
        method: 'POST',
        body: JSON.stringify({})
      }, token);
      setMsg(trip?.reservation?.reservationNumber
        ? `Workflow created and linked to reservation ${trip.reservation.reservationNumber}`
        : 'Workflow created for trip');
      await load();
    } catch (e) {
      setMsg(e.message);
    }
  };

  return (
    <AppShell me={me} logout={logout}>
      <section className="glass card-lg" style={{ marginBottom: 18 }}>
        <div className="label">Sprint 5 · Car Sharing Build</div>
        <h2 style={{ marginTop: 8, marginBottom: 10 }}>Host And Listing Management</h2>
        <p style={{ margin: 0, maxWidth: 920, lineHeight: 1.7 }}>
          This is the first internal management layer for the car sharing module. It keeps Fleet Manager as the operational console while introducing hosts and public-facing listings as separate supply entities.
        </p>
      </section>

      {msg ? <p className="label" style={{ margin: '0 0 12px 2px' }}>{msg}</p> : null}

      {isSuper ? (
        <section className="glass card" style={{ marginBottom: 18 }}>
          <div className="stack">
            <label className="label">Tenant Scope</label>
            <select value={activeTenantId} onChange={(e) => setActiveTenantId(e.target.value)}>
              {tenants.map((tenant) => (
                <option key={tenant.id} value={tenant.id}>{tenant.name}</option>
              ))}
            </select>
          </div>
        </section>
      ) : null}

      <section className="glass card" style={{ marginBottom: 18 }}>
        <div className="row-between" style={{ alignItems: 'center', gap: 12 }}>
          <div>
            <div className="label">Tenant Feature Status</div>
            <div style={{ fontWeight: 700 }}>
              {tenantConfig?.enabled ? 'Car Sharing Enabled' : 'Car Sharing Disabled'}
            </div>
          </div>
          <div className="label" style={{ textTransform: 'none', letterSpacing: 0 }}>
            {tenantConfig?.tenantName || 'Select a tenant to manage this module.'}
          </div>
        </div>
        {!tenantConfig?.enabled ? (
          <div className="label" style={{ marginTop: 10, textTransform: 'none', letterSpacing: 0, fontSize: 13 }}>
            Enable Car Sharing for this tenant in `Tenants` before creating hosts or listings.
          </div>
        ) : null}
      </section>

      <section className="grid2">
        <section className="glass card-lg stack">
          <div className="row-between">
            <h3 style={{ margin: 0 }}>Host Profiles</h3>
            <button type="button" onClick={resetHostForm}>New Host</button>
          </div>
          <form className="stack" onSubmit={saveHost}>
            <div className="grid2">
              <div className="stack"><label className="label">Display Name</label><input value={hostForm.displayName} onChange={(e) => setHostForm({ ...hostForm, displayName: e.target.value })} /></div>
              <div className="stack"><label className="label">Legal Name</label><input value={hostForm.legalName} onChange={(e) => setHostForm({ ...hostForm, legalName: e.target.value })} /></div>
              <div className="stack"><label className="label">Email</label><input value={hostForm.email} onChange={(e) => setHostForm({ ...hostForm, email: e.target.value })} /></div>
              <div className="stack"><label className="label">Phone</label><input value={hostForm.phone} onChange={(e) => setHostForm({ ...hostForm, phone: e.target.value })} /></div>
              <div className="stack"><label className="label">Status</label><select value={hostForm.status} onChange={(e) => setHostForm({ ...hostForm, status: e.target.value })}><option value="ACTIVE">ACTIVE</option><option value="PAUSED">PAUSED</option><option value="ARCHIVED">ARCHIVED</option></select></div>
              <div className="stack"><label className="label">Payout Provider</label><input value={hostForm.payoutProvider} onChange={(e) => setHostForm({ ...hostForm, payoutProvider: e.target.value })} placeholder="stripe-connect / manual" /></div>
            </div>
            <div className="grid2">
              <div className="stack"><label className="label">Payout Account Ref</label><input value={hostForm.payoutAccountRef} onChange={(e) => setHostForm({ ...hostForm, payoutAccountRef: e.target.value })} /></div>
              <label className="label"><input type="checkbox" checked={hostForm.payoutEnabled} onChange={(e) => setHostForm({ ...hostForm, payoutEnabled: e.target.checked })} /> Payouts Enabled</label>
            </div>
            <div className="stack"><label className="label">Notes</label><textarea rows={3} value={hostForm.notes} onChange={(e) => setHostForm({ ...hostForm, notes: e.target.value })} /></div>
            <div><button type="submit" disabled={!canManageCarSharing}>{hostForm.id ? 'Update Host' : 'Create Host'}</button></div>
          </form>

          <div className="grid2">
            {activeHosts.map((host) => <HostCard key={host.id} host={host} onEdit={setHostForm} />)}
          </div>
          {!activeHosts.length && !loading ? <div className="label">No host profiles yet for this tenant.</div> : null}
        </section>

        <section className="glass card-lg stack">
          <div className="row-between">
            <h3 style={{ margin: 0 }}>Vehicle Listings</h3>
            <button type="button" onClick={resetListingForm}>New Listing</button>
          </div>
          <form className="stack" onSubmit={saveListing}>
            <div className="grid2">
              <div className="stack">
                <label className="label">Host</label>
                <select value={listingForm.hostProfileId} onChange={(e) => setListingForm({ ...listingForm, hostProfileId: e.target.value })}>
                  <option value="">Select host</option>
                  {activeHosts.map((host) => <option key={host.id} value={host.id}>{host.displayName}</option>)}
                </select>
              </div>
              <div className="stack">
                <label className="label">Vehicle</label>
                <select value={listingForm.vehicleId} onChange={(e) => setListingForm({ ...listingForm, vehicleId: e.target.value })}>
                  <option value="">Select vehicle</option>
                  {filteredEligibleVehicles.map((vehicle) => (
                    <option key={vehicle.id} value={vehicle.id}>
                      {[vehicle.year, vehicle.make, vehicle.model, vehicle.plate].filter(Boolean).join(' ')} · {vehicle.fleetMode}
                    </option>
                  ))}
                </select>
              </div>
              <div className="stack"><label className="label">Title</label><input value={listingForm.title} onChange={(e) => setListingForm({ ...listingForm, title: e.target.value })} /></div>
              <div className="stack">
                <label className="label">Location</label>
                <select value={listingForm.locationId} onChange={(e) => setListingForm({ ...listingForm, locationId: e.target.value })}>
                  <option value="">No fixed location</option>
                  {filteredLocations.map((location) => <option key={location.id} value={location.id}>{location.name}</option>)}
                </select>
              </div>
              <div className="stack"><label className="label">Status</label><select value={listingForm.status} onChange={(e) => setListingForm({ ...listingForm, status: e.target.value })}><option value="DRAFT">DRAFT</option><option value="PUBLISHED">PUBLISHED</option><option value="PAUSED">PAUSED</option><option value="ARCHIVED">ARCHIVED</option></select></div>
              <div className="stack"><label className="label">Ownership</label><select value={listingForm.ownershipType} onChange={(e) => setListingForm({ ...listingForm, ownershipType: e.target.value })}><option value="HOST_OWNED">HOST_OWNED</option><option value="FLEET_OWNED">FLEET_OWNED</option></select></div>
            </div>
            <div className="stack"><label className="label">Short Description</label><input value={listingForm.shortDescription} onChange={(e) => setListingForm({ ...listingForm, shortDescription: e.target.value })} /></div>
            <div className="stack"><label className="label">Description</label><textarea rows={4} value={listingForm.description} onChange={(e) => setListingForm({ ...listingForm, description: e.target.value })} /></div>
            <div className="grid2">
              <div className="stack"><label className="label">Base Daily Rate</label><input type="number" min="0" step="0.01" value={listingForm.baseDailyRate} onChange={(e) => setListingForm({ ...listingForm, baseDailyRate: e.target.value })} /></div>
              <div className="stack"><label className="label">Cleaning Fee</label><input type="number" min="0" step="0.01" value={listingForm.cleaningFee} onChange={(e) => setListingForm({ ...listingForm, cleaningFee: e.target.value })} /></div>
              <div className="stack"><label className="label">Delivery Fee</label><input type="number" min="0" step="0.01" value={listingForm.deliveryFee} onChange={(e) => setListingForm({ ...listingForm, deliveryFee: e.target.value })} /></div>
              <div className="stack"><label className="label">Security Deposit</label><input type="number" min="0" step="0.01" value={listingForm.securityDeposit} onChange={(e) => setListingForm({ ...listingForm, securityDeposit: e.target.value })} /></div>
              <div className="stack"><label className="label">Min Trip Days</label><input type="number" min="1" value={listingForm.minTripDays} onChange={(e) => setListingForm({ ...listingForm, minTripDays: e.target.value })} /></div>
              <div className="stack"><label className="label">Max Trip Days</label><input type="number" min="1" value={listingForm.maxTripDays} onChange={(e) => setListingForm({ ...listingForm, maxTripDays: e.target.value })} /></div>
            </div>
            <label className="label"><input type="checkbox" checked={listingForm.instantBook} onChange={(e) => setListingForm({ ...listingForm, instantBook: e.target.checked })} /> Instant Book</label>
            <div className="stack"><label className="label">Trip Rules</label><textarea rows={3} value={listingForm.tripRules} onChange={(e) => setListingForm({ ...listingForm, tripRules: e.target.value })} /></div>
            <div><button type="submit" disabled={!canManageCarSharing}>{listingForm.id ? 'Update Listing' : 'Create Listing'}</button></div>
          </form>

          {!filteredEligibleVehicles.length ? (
            <div className="label" style={{ textTransform: 'none', letterSpacing: 0, fontSize: 13 }}>
              No car-sharing eligible vehicles are available for this tenant yet. Enable the feature on the tenant and set some vehicles to `CAR_SHARING_ONLY` or `BOTH` below.
            </div>
          ) : null}

          <div className="grid2">
            {listings.map((listing) => <ListingCard key={listing.id} listing={listing} onEdit={(row) => {
              setListingForm({
                id: row.id,
                hostProfileId: row.hostProfileId || '',
                vehicleId: row.vehicleId || '',
                locationId: row.locationId || '',
                title: row.title || '',
                shortDescription: row.shortDescription || '',
                description: row.description || '',
                status: row.status || 'DRAFT',
                ownershipType: row.ownershipType || 'HOST_OWNED',
                currency: row.currency || 'USD',
                baseDailyRate: String(row.baseDailyRate ?? ''),
                cleaningFee: String(row.cleaningFee ?? ''),
                deliveryFee: String(row.deliveryFee ?? ''),
                securityDeposit: String(row.securityDeposit ?? ''),
                instantBook: !!row.instantBook,
                minTripDays: String(row.minTripDays ?? 1),
                maxTripDays: row.maxTripDays ? String(row.maxTripDays) : '',
                tripRules: row.tripRules || ''
              });
              setWindowForm(EMPTY_WINDOW);
            }} />)}
          </div>
          {!listings.length && !loading ? <div className="label">No listings yet for this tenant.</div> : null}
        </section>
      </section>

      <section className="glass card-lg stack" style={{ marginTop: 18 }}>
        <div className="row-between">
          <h3 style={{ margin: 0 }}>Availability Windows</h3>
          {selectedListing ? <button type="button" onClick={() => setWindowForm(EMPTY_WINDOW)}>New Window</button> : null}
        </div>
        {!selectedListing ? (
          <div className="label" style={{ textTransform: 'none', letterSpacing: 0, fontSize: 13 }}>
            Edit a listing first to manage blackout dates, price overrides, and minimum stay rules.
          </div>
        ) : (
          <>
            <div className="label" style={{ textTransform: 'none', letterSpacing: 0, fontSize: 13 }}>
              Managing windows for <strong>{selectedListing.title}</strong>
            </div>
            <form className="stack" onSubmit={saveAvailabilityWindow}>
              <div className="grid2">
                <div className="stack"><label className="label">Start</label><input type="datetime-local" value={windowForm.startAt} onChange={(e) => setWindowForm({ ...windowForm, startAt: e.target.value })} /></div>
                <div className="stack"><label className="label">End</label><input type="datetime-local" value={windowForm.endAt} onChange={(e) => setWindowForm({ ...windowForm, endAt: e.target.value })} /></div>
                <div className="stack"><label className="label">Price Override</label><input type="number" min="0" step="0.01" value={windowForm.priceOverride} onChange={(e) => setWindowForm({ ...windowForm, priceOverride: e.target.value })} /></div>
                <div className="stack"><label className="label">Min Trip Days Override</label><input type="number" min="1" value={windowForm.minTripDaysOverride} onChange={(e) => setWindowForm({ ...windowForm, minTripDaysOverride: e.target.value })} /></div>
              </div>
              <label className="label"><input type="checkbox" checked={windowForm.isBlocked} onChange={(e) => setWindowForm({ ...windowForm, isBlocked: e.target.checked })} /> Block this window</label>
              <div className="stack"><label className="label">Note</label><textarea rows={2} value={windowForm.note} onChange={(e) => setWindowForm({ ...windowForm, note: e.target.value })} /></div>
              <div><button type="submit">{windowForm.id ? 'Update Window' : 'Create Window'}</button></div>
            </form>

            <table>
              <thead>
                <tr>
                  <th>Start</th>
                  <th>End</th>
                  <th>Blocked</th>
                  <th>Price Override</th>
                  <th>Min Trip Days</th>
                  <th>Note</th>
                  <th>Action</th>
                </tr>
              </thead>
              <tbody>
                {(selectedListing.availabilityWindows || []).map((window) => (
                  <tr key={window.id}>
                    <td>{new Date(window.startAt).toLocaleString()}</td>
                    <td>{new Date(window.endAt).toLocaleString()}</td>
                    <td>{window.isBlocked ? 'Yes' : 'No'}</td>
                    <td>{window.priceOverride !== null && window.priceOverride !== undefined ? `$${Number(window.priceOverride).toFixed(2)}` : '-'}</td>
                    <td>{window.minTripDaysOverride || '-'}</td>
                    <td>{window.note || '-'}</td>
                    <td>
                      <div className="row" style={{ gap: 8 }}>
                        <button type="button" onClick={() => setWindowForm({
                          id: window.id,
                          startAt: toLocalDateTimeInput(window.startAt),
                          endAt: toLocalDateTimeInput(window.endAt),
                          isBlocked: !!window.isBlocked,
                          priceOverride: window.priceOverride ?? '',
                          minTripDaysOverride: window.minTripDaysOverride ?? '',
                          note: window.note || ''
                        })}>Edit</button>
                        <button type="button" onClick={() => deleteAvailabilityWindow(window.id)}>Delete</button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!(selectedListing.availabilityWindows || []).length ? (
              <div className="label" style={{ textTransform: 'none', letterSpacing: 0, fontSize: 13 }}>
                No availability windows yet for this listing.
              </div>
            ) : null}
          </>
        )}
      </section>

      <section className="glass card-lg stack" style={{ marginTop: 18 }}>
        <div className="row-between">
          <h3 style={{ margin: 0 }}>Trip Creation</h3>
          <div className="label">Internal booking flow on top of listing supply.</div>
        </div>
        {!selectedListing ? (
          <div className="label" style={{ textTransform: 'none', letterSpacing: 0, fontSize: 13 }}>
            Edit a listing first to create trips from it.
          </div>
        ) : (
          <>
            <div className="label" style={{ textTransform: 'none', letterSpacing: 0, fontSize: 13 }}>
              Creating trips for <strong>{selectedListing.title}</strong>
            </div>
            <form className="stack" onSubmit={saveTrip}>
              <div className="grid2">
                <div className="stack">
                  <label className="label">Guest</label>
                  <select value={tripForm.guestCustomerId} onChange={(e) => setTripForm({ ...tripForm, guestCustomerId: e.target.value })}>
                    <option value="">Select guest</option>
                    {filteredCustomers.map((customer) => (
                      <option key={customer.id} value={customer.id}>
                        {[customer.firstName, customer.lastName].filter(Boolean).join(' ') || customer.email || customer.id}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="stack"><label className="label">Pickup</label><input type="datetime-local" value={tripForm.scheduledPickupAt} onChange={(e) => setTripForm({ ...tripForm, scheduledPickupAt: e.target.value })} /></div>
                <div className="stack"><label className="label">Return</label><input type="datetime-local" value={tripForm.scheduledReturnAt} onChange={(e) => setTripForm({ ...tripForm, scheduledReturnAt: e.target.value })} /></div>
                <div className="stack">
                  <label className="label">Pickup Location</label>
                  <select value={tripForm.pickupLocationId} onChange={(e) => setTripForm({ ...tripForm, pickupLocationId: e.target.value })}>
                    <option value="">No fixed pickup location</option>
                    {filteredLocations.map((location) => <option key={location.id} value={location.id}>{location.name}</option>)}
                  </select>
                </div>
                <div className="stack">
                  <label className="label">Return Location</label>
                  <select value={tripForm.returnLocationId} onChange={(e) => setTripForm({ ...tripForm, returnLocationId: e.target.value })}>
                    <option value="">No fixed return location</option>
                    {filteredLocations.map((location) => <option key={location.id} value={location.id}>{location.name}</option>)}
                  </select>
                </div>
              </div>
              <div className="stack"><label className="label">Notes</label><textarea rows={2} value={tripForm.notes} onChange={(e) => setTripForm({ ...tripForm, notes: e.target.value })} /></div>
              <div><button type="submit">Create Trip</button></div>
            </form>

            <table>
              <thead>
                <tr>
                  <th>Trip</th>
                  <th>Reservation</th>
                  <th>Workflow</th>
                  <th>Guest</th>
                  <th>Status</th>
                  <th>Pickup</th>
                  <th>Return</th>
                  <th>Total</th>
                  <th>Host Earnings</th>
                  <th>Platform Fee</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {selectedListingTrips.map((trip) => {
                  const workflow = tripWorkflowSummary(trip);
                  return (
                  <tr key={trip.id}>
                    <td>{trip.tripCode}</td>
                    <td>
                      {trip.reservation?.reservationNumber ? (
                        <div className="stack" style={{ gap: 4 }}>
                          <a href={`/reservations/${trip.reservation.id}`} style={{ fontWeight: 700 }}>
                            {trip.reservation.reservationNumber}
                          </a>
                          <span className="label" style={{ textTransform: 'none', letterSpacing: 0, fontSize: 11 }}>
                            Payment: {workflow.paymentLabel || '-'}
                          </span>
                        </div>
                      ) : '-'}
                    </td>
                    <td>
                      <div className="stack" style={{ gap: 4 }}>
                        <strong>{workflow.stageLabel}</strong>
                        <span className="label" style={{ textTransform: 'none', letterSpacing: 0, fontSize: 11 }}>
                          {workflow.nextAction}
                        </span>
                        <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
                          {workflow.checks.map((check) => (
                            <span
                              key={check.label}
                              style={{
                                border: '1px solid rgba(124, 58, 237, 0.24)',
                                borderRadius: 999,
                                padding: '3px 8px',
                                fontSize: 11,
                                background: check.done ? 'rgba(16,185,129,0.12)' : 'rgba(148,163,184,0.12)',
                                color: check.done ? '#047857' : '#475569'
                              }}
                            >
                              {check.done ? 'Done' : 'Pending'} {check.label}
                            </span>
                          ))}
                        </div>
                      </div>
                    </td>
                    <td>{trip.guestCustomer ? [trip.guestCustomer.firstName, trip.guestCustomer.lastName].filter(Boolean).join(' ') : '-'}</td>
                    <td>{trip.status}</td>
                    <td>{new Date(trip.scheduledPickupAt).toLocaleString()}</td>
                    <td>{new Date(trip.scheduledReturnAt).toLocaleString()}</td>
                    <td>${Number(trip.quotedTotal || 0).toFixed(2)}</td>
                    <td>${Number(trip.hostEarnings || 0).toFixed(2)}</td>
                    <td>${Number(trip.platformFee || 0).toFixed(2)}</td>
                    <td>
                      <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
                        {tripActionsFor(trip.status).map((action) => (
                          <button key={action} type="button" onClick={() => updateTripStatus(trip.id, action)}>{action}</button>
                        ))}
                        {trip.reservation?.id ? (
                          <>
                            <a href={`/reservations/${trip.reservation.id}`}>
                              <button type="button">Open Workflow</button>
                            </a>
                            <a href={`/reservations/${trip.reservation.id}/checkout`}>
                              <button type="button">Checkout</button>
                            </a>
                            <a href={`/reservations/${trip.reservation.id}/checkin`}>
                              <button type="button">Check-in</button>
                            </a>
                            <a href={`/reservations/${trip.reservation.id}/inspection-report`}>
                              <button type="button">Inspections</button>
                            </a>
                          </>
                        ) : (
                          <button type="button" onClick={() => provisionTripWorkflow(trip.id)}>Create Workflow</button>
                        )}
                      </div>
                    </td>
                  </tr>
                )})}
              </tbody>
            </table>
            {!selectedListingTrips.length ? (
              <div className="label" style={{ textTransform: 'none', letterSpacing: 0, fontSize: 13 }}>
                No trips yet for this listing.
              </div>
            ) : null}
          </>
        )}
      </section>

      <section className="glass card-lg stack" style={{ marginTop: 18 }}>
        <div className="row-between">
          <h3 style={{ margin: 0 }}>Vehicle Fleet Access</h3>
          <div className="label">Separate traditional rental inventory from car sharing supply.</div>
        </div>
        {isSuper ? (
          <div className="label" style={{ textTransform: 'none', letterSpacing: 0, fontSize: 13 }}>
            Unassigned vehicles are shown here too. Changing fleet mode from this screen will attach them to the active tenant.
          </div>
        ) : null}
        <table>
          <thead>
            <tr>
              <th>Vehicle</th>
              {isSuper ? <th>Tenant</th> : null}
              <th>Type</th>
              <th>Status</th>
              <th>Fleet Mode</th>
            </tr>
          </thead>
          <tbody>
            {assignableVehicles.map((vehicle) => (
              <tr key={vehicle.id}>
                <td>{[vehicle.year, vehicle.make, vehicle.model, vehicle.plate].filter(Boolean).join(' ') || vehicle.internalNumber}</td>
                {isSuper ? <td>{vehicle.tenantId ? (vehicle.tenant?.name || 'Assigned') : 'Unassigned'}</td> : null}
                <td>{vehicle.vehicleType?.name || '-'}</td>
                <td>{vehicle.status}</td>
                <td>
                  <select value={vehicle.fleetMode || 'RENTAL_ONLY'} onChange={(e) => updateVehicleFleetMode(vehicle.id, e.target.value)}>
                    <option value="RENTAL_ONLY">RENTAL_ONLY</option>
                    <option value="CAR_SHARING_ONLY">CAR_SHARING_ONLY</option>
                    <option value="BOTH">BOTH</option>
                  </select>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {!assignableVehicles.length && !loading ? <div className="label">No vehicles found for this tenant.</div> : null}
      </section>

      <section className="glass card-lg stack" style={{ marginTop: 18 }}>
        <h3 style={{ margin: 0 }}>Launch Direction</h3>
        <div className="stack">
          {discoveryBullets.map((point) => (
            <div key={point} className="row" style={{ alignItems: 'flex-start', gap: 10 }}>
              <strong>•</strong>
              <span>{point}</span>
            </div>
          ))}
        </div>
      </section>
    </AppShell>
  );
}
