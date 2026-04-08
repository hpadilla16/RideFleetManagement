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
  fulfillmentChoice: 'PICKUP',
  searchPlaceId: '',
  deliveryAreaChoice: '',
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

function formatMoney(value) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(Number(value || 0));
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

function tripStatusClass(status) {
  const current = String(status || '').toUpperCase();
  if (['COMPLETED', 'READY_FOR_PICKUP'].includes(current)) return 'status-chip good';
  if (['CANCELLED', 'DISPUTED'].includes(current)) return 'status-chip warn';
  return 'status-chip neutral';
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
  const [reloadKey, setReloadKey] = useState(0);
  const [opsFocus, setOpsFocus] = useState('ALL');
  const [handoffAlerts, setHandoffAlerts] = useState([]);
  const [pendingSearchPlaces, setPendingSearchPlaces] = useState([]);

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

  useEffect(() => {
    let cancelled = false;
    const safeLoad = async () => {
      setLoading(true);
      try {
        if (isSuper && !activeTenantId) {
          const rows = await api('/api/tenants', {}, token);
          if (cancelled) return;
          const tenantRows = Array.isArray(rows) ? rows : [];
          setTenants(tenantRows);
          if (tenantRows[0]?.id) setActiveTenantId(tenantRows[0].id);
          return;
        }
        const reqs = [
          api(`/api/car-sharing/hosts${scopedQuery}`, {}, token),
          api(`/api/car-sharing/listings${scopedQuery}`, {}, token),
          api(`/api/car-sharing/trips${scopedQuery}`, {}, token),
          api(`/api/car-sharing/eligible-vehicles${scopedQuery}`, {}, token),
          api(`/api/vehicles${scopedQuery}`, {}, token),
          api(`/api/customers${scopedQuery}`, {}, token),
          api(`/api/locations${scopedQuery}`, {}, token),
          api(`/api/car-sharing/config${scopedQuery}`, {}, token)
        ];
        if (isSuper) reqs.push(api('/api/tenants', {}, token));
        const results = await Promise.all(reqs);
        if (cancelled) return;
        setHosts(Array.isArray(results[0]) ? results[0] : []);
        setListings(Array.isArray(results[1]?.items) ? results[1].items : (Array.isArray(results[1]) ? results[1] : []));
        setTrips(Array.isArray(results[2]?.items) ? results[2].items : (Array.isArray(results[2]) ? results[2] : []));
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
        Promise.all([
          api(`/api/car-sharing/search-places/pending${scopedQuery}`, {}, token).catch(() => []),
          api(`/api/car-sharing/ops/handoff-alerts${scopedQuery}`, {}, token).catch(() => [])
        ]).then(([places, alerts]) => {
          if (cancelled) return;
          setPendingSearchPlaces(Array.isArray(places) ? places : []);
          setHandoffAlerts(Array.isArray(alerts) ? alerts : []);
        });
        setMsg('');
      } catch (e) {
        if (!cancelled) setMsg(e.message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    safeLoad();
    return () => { cancelled = true; };
  }, [token, scopedQuery, reloadKey]);

  const load = () => setReloadKey((k) => k + 1);

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
  const heroMetrics = useMemo(() => ([
    { label: 'Hosts', value: activeHosts.length },
    { label: 'Listings', value: listings.length },
    { label: 'Trips', value: trips.length },
    { label: 'Eligible Vehicles', value: filteredEligibleVehicles.length },
    { label: 'Fleet Shared', value: assignableVehicles.filter((row) => ['CAR_SHARING_ONLY', 'BOTH'].includes(String(row.fleetMode || ''))).length }
  ]), [activeHosts.length, listings.length, trips.length, filteredEligibleVehicles.length, assignableVehicles]);
  const publishedListings = listings.filter((row) => String(row.status || '').toUpperCase() === 'PUBLISHED').length;
  const instantBookListings = listings.filter((row) => row.instantBook).length;
  const tripAttentionCount = trips.filter((row) => {
    const current = String(row.status || '').toUpperCase();
    return current === 'DISPUTED' || current === 'READY_FOR_PICKUP' || current === 'RESERVED';
  }).length;
  const controlCenterItems = useMemo(() => {
    const attentionTrip = trips.find((row) => {
      const current = String(row.status || '').toUpperCase();
      return current === 'DISPUTED' || current === 'READY_FOR_PICKUP' || current === 'RESERVED';
    }) || null;
    const instantBookListing = listings.find((row) => row.instantBook) || null;
    const draftListing = listings.find((row) => String(row.status || '').toUpperCase() !== 'PUBLISHED') || null;
    const publishedListing = listings.find((row) => String(row.status || '').toUpperCase() === 'PUBLISHED') || null;

    return [
      publishedListing
        ? {
            id: `listing-${publishedListing.id}`,
            focus: 'LISTINGS',
            title: 'Published Listing',
            detail: publishedListing.title,
            note: `${publishedListing.vehicle ? `${publishedListing.vehicle.year || ''} ${publishedListing.vehicle.make || ''} ${publishedListing.vehicle.model || ''}`.trim() : 'Vehicle pending'} · ${formatMoney(publishedListing.baseDailyRate)}/day`,
            actionLabel: 'Go To Listings',
            targetId: 'car-sharing-listings'
          }
        : null,
      instantBookListing
        ? {
            id: `instant-${instantBookListing.id}`,
            focus: 'INSTANT',
            title: 'Instant Book Live',
            detail: instantBookListing.title,
            note: `Host ${instantBookListing.hostProfile?.displayName || '-'} · Trips ${instantBookListing.trips?.length || 0}`,
            actionLabel: 'Review Listing',
            targetId: 'car-sharing-listings'
          }
        : null,
      attentionTrip
        ? {
            id: `trip-${attentionTrip.id}`,
            focus: 'TRIPS',
            title: 'Trip Attention',
            detail: `${attentionTrip.tripCode} · ${attentionTrip.guestCustomer ? [attentionTrip.guestCustomer.firstName, attentionTrip.guestCustomer.lastName].filter(Boolean).join(' ') : 'Guest pending'}`,
            note: `${String(attentionTrip.status || '').replaceAll('_', ' ')} · ${new Date(attentionTrip.scheduledPickupAt).toLocaleString()}`,
            actionLabel: 'Open Trips',
            targetId: 'car-sharing-trips'
          }
        : null,
      draftListing
        ? {
            id: `draft-${draftListing.id}`,
            focus: 'ATTENTION',
            title: 'Listing Needs Attention',
            detail: draftListing.title,
            note: `Status ${draftListing.status} · Complete pricing, availability, and publish readiness.`,
            actionLabel: 'Open Listings',
            targetId: 'car-sharing-listings'
          }
        : null
    ].filter(Boolean);
  }, [listings, trips]);
  const opsFocusOptions = useMemo(() => ([
    { id: 'ALL', label: 'All Queues', count: controlCenterItems.length },
    { id: 'LISTINGS', label: 'Listings', count: controlCenterItems.filter((item) => item.focus === 'LISTINGS').length },
    { id: 'INSTANT', label: 'Instant Book', count: controlCenterItems.filter((item) => item.focus === 'INSTANT').length },
    { id: 'TRIPS', label: 'Trips', count: controlCenterItems.filter((item) => item.focus === 'TRIPS').length },
    { id: 'ATTENTION', label: 'Attention', count: controlCenterItems.filter((item) => item.focus === 'ATTENTION').length }
  ]), [controlCenterItems]);
  const opsFocusSummary = useMemo(() => {
    switch (opsFocus) {
      case 'LISTINGS':
        return 'Focus the team on published supply and the listings that should stay guest-ready first.';
      case 'INSTANT':
        return 'Keep instant-book inventory visible so hosts and ops can watch quality and conversion from phone.';
      case 'TRIPS':
        return 'Show only trip-readiness work so support can jump into pickup and dispute actions faster.';
      case 'ATTENTION':
        return 'Highlight the listings that still need setup or publishing cleanup before they can sell well.';
      default:
        return 'Keep host supply, listing quality, and trip readiness in view before jumping into the full workspace below.';
    }
  }, [opsFocus]);
  const visibleControlCenterItems = useMemo(() => {
    if (opsFocus === 'ALL') return controlCenterItems;
    return controlCenterItems.filter((item) => item.focus === opsFocus);
  }, [controlCenterItems, opsFocus]);

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
          fulfillmentChoice: tripForm.fulfillmentChoice || 'PICKUP',
          searchPlaceId: tripForm.searchPlaceId || null,
          deliveryAreaChoice: tripForm.deliveryAreaChoice || null,
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

  const approveSearchPlace = async (id) => {
    try {
      await api(`/api/car-sharing/search-places/${id}/approve`, { method: 'PATCH', body: JSON.stringify({}) }, token);
      setMsg('Search place approved');
      await load();
    } catch (e) {
      setMsg(e.message);
    }
  };

  const rejectSearchPlace = async (id) => {
    try {
      await api(`/api/car-sharing/search-places/${id}/reject`, { method: 'PATCH', body: JSON.stringify({ reason: 'Rejected by admin' }) }, token);
      setMsg('Search place rejected');
      await load();
    } catch (e) {
      setMsg(e.message);
    }
  };

  const sendHandoffReminders = async () => {
    try {
      const result = await api(`/api/car-sharing/ops/send-handoff-reminders${scopedQuery}`, { method: 'POST', body: JSON.stringify({}) }, token);
      setMsg(`Reminders: ${result?.sent ?? 0} sent, ${result?.skipped ?? 0} skipped`);
    } catch (e) {
      setMsg(e.message);
    }
  };

  return (
    <AppShell me={me} logout={logout}>
      <section className="page-hero">
        <div className="hero-grid">
          <section className="glass card-lg hero-copy">
            <div className="eyebrow">Ride Fleet Car Sharing</div>
            <h2>Host supply, listing control, and trip operations in one internal console.</h2>
            <p>
              Build out supply the same way a strong marketplace would: enable the feature by tenant, separate fleet
              modes, manage hosts cleanly, attach vehicles to listings, control availability, and then run each trip
              through the same operational workflow backbone used for standard reservations.
            </p>
            <div className="hero-meta">
              <span className={tenantConfig?.enabled ? 'status-chip good' : 'status-chip warn'}>
                {tenantConfig?.enabled ? 'Car Sharing Enabled' : 'Car Sharing Disabled'}
              </span>
              <span className="hero-pill">{tenantConfig?.tenantName || 'Select a tenant to manage this module.'}</span>
              <span className="hero-pill">{selectedListing ? `Focused on ${selectedListing.title}` : 'Choose a listing to manage windows and trips'}</span>
            </div>
          </section>

          <section className="glass card-lg section-card">
            <div className="section-title">Current supply snapshot</div>
            <div className="metric-grid">
              {heroMetrics.map((metric) => (
                <div key={metric.label} className="metric-card">
                  <span className="label">{metric.label}</span>
                  <strong>{metric.value}</strong>
                </div>
              ))}
            </div>
          </section>
        </div>
      </section>

      {loading ? (
        <div className="surface-note" style={{ marginBottom: 16, textAlign: 'center', color: '#6b7280' }}>Loading car sharing data…</div>
      ) : null}

      {!loading && msg ? (
        <div className="surface-note" style={{ color: /updated|saved|created|sent|approved|rejected/i.test(msg) ? '#166534' : '#991b1b', marginBottom: 16 }}>
          {msg}
          <button onClick={() => setMsg('')} style={{ marginLeft: 12, background: 'none', border: 'none', cursor: 'pointer', color: 'inherit', fontWeight: 700 }}>✕</button>
        </div>
      ) : null}

      {isSuper ? (
        <section className="glass card-lg section-card" style={{ marginBottom: 18 }}>
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

      <section className="glass card-lg section-card" style={{ marginBottom: 18 }}>
        <div className="app-banner">
          <div className="row-between" style={{ marginBottom: 0 }}>
            <div className="stack" style={{ gap: 6 }}>
              <span className="eyebrow">Marketplace Ops</span>
              <h3 style={{ margin: 0 }}>Car Sharing Control Center</h3>
              <p className="ui-muted">
                {opsFocusSummary}
              </p>
            </div>
            <span className={`status-chip ${canManageCarSharing ? 'good' : 'warn'}`}>
              {canManageCarSharing ? 'Ready to manage' : 'Feature gated'}
            </span>
          </div>
          <div className="app-card-grid compact">
            <div className="info-tile">
              <span className="label">Published</span>
              <strong>{publishedListings}</strong>
            </div>
            <div className="info-tile">
              <span className="label">Instant Book</span>
              <strong>{instantBookListings}</strong>
            </div>
            <div className="info-tile">
              <span className="label">Trip Attention</span>
              <strong>{tripAttentionCount}</strong>
            </div>
            <div className="info-tile">
              <span className="label">Focused Listing</span>
              <strong>{selectedListing?.title || 'Choose one'}</strong>
            </div>
          </div>
          <div className="app-banner-list">
            {opsFocusOptions.map((option) => (
              <button
                key={option.id}
                type="button"
                className={opsFocus === option.id ? '' : 'button-subtle'}
                onClick={() => setOpsFocus(option.id)}
                style={{ minHeight: 36, paddingInline: 14 }}
              >
                {option.label} · {option.count}
              </button>
            ))}
          </div>
          {visibleControlCenterItems.length ? (
            <div className="app-card-grid compact">
              {visibleControlCenterItems.map((item) => (
                <section key={item.id} className="glass card section-card">
                  <div className="section-title" style={{ fontSize: 15 }}>{item.title}</div>
                  <div className="ui-muted">{item.detail}</div>
                  <div className="surface-note">{item.note}</div>
                  <div className="inline-actions">
                    <button
                      type="button"
                      onClick={() => document.getElementById(item.targetId)?.scrollIntoView({ behavior: 'smooth', block: 'start' })}
                    >
                      {item.actionLabel}
                    </button>
                  </div>
                </section>
              ))}
            </div>
          ) : controlCenterItems.length ? (
            <div className="surface-note">No car sharing items match this focus right now. Switch filters to review another lane.</div>
          ) : null}
          <div className="inline-actions">
            <button type="button" onClick={() => document.getElementById('car-sharing-hosts')?.scrollIntoView({ behavior: 'smooth', block: 'start' })}>Hosts</button>
            <button type="button" onClick={() => document.getElementById('car-sharing-listings')?.scrollIntoView({ behavior: 'smooth', block: 'start' })}>Listings</button>
            <button type="button" onClick={() => document.getElementById('car-sharing-windows')?.scrollIntoView({ behavior: 'smooth', block: 'start' })}>Availability</button>
            <button type="button" onClick={() => document.getElementById('car-sharing-trips')?.scrollIntoView({ behavior: 'smooth', block: 'start' })}>Trips</button>
          </div>
        </div>
      </section>

      <section className="glass card-lg section-card" style={{ marginBottom: 18 }}>
        <div className="row-between" style={{ alignItems: 'center', gap: 12 }}>
          <div>
            <div className="section-title">Tenant Feature Status</div>
            <div className="ui-muted">{tenantConfig?.tenantName || 'Select a tenant to manage this module.'}</div>
          </div>
          <span className={tenantConfig?.enabled ? 'status-chip good' : 'status-chip warn'}>
            {tenantConfig?.enabled ? 'Car Sharing Enabled' : 'Car Sharing Disabled'}
          </span>
        </div>
        {!tenantConfig?.enabled ? (
          <div className="surface-note">
            Enable Car Sharing for this tenant in `Tenants` before creating hosts or listings.
          </div>
        ) : null}
      </section>

      <section className="split-panel">
        <section id="car-sharing-hosts" className="glass card-lg section-card">
          <div className="row-between">
            <h3 style={{ margin: 0 }}>Host Profiles</h3>
            <button type="button" className="button-subtle" onClick={resetHostForm}>New Host</button>
          </div>
          <form className="stack" onSubmit={saveHost}>
            <div className="form-grid-2">
              <div className="stack"><label className="label">Display Name</label><input value={hostForm.displayName} onChange={(e) => setHostForm({ ...hostForm, displayName: e.target.value })} /></div>
              <div className="stack"><label className="label">Legal Name</label><input value={hostForm.legalName} onChange={(e) => setHostForm({ ...hostForm, legalName: e.target.value })} /></div>
              <div className="stack"><label className="label">Email</label><input value={hostForm.email} onChange={(e) => setHostForm({ ...hostForm, email: e.target.value })} /></div>
              <div className="stack"><label className="label">Phone</label><input value={hostForm.phone} onChange={(e) => setHostForm({ ...hostForm, phone: e.target.value })} /></div>
              <div className="stack"><label className="label">Status</label><select value={hostForm.status} onChange={(e) => setHostForm({ ...hostForm, status: e.target.value })}><option value="ACTIVE">ACTIVE</option><option value="PAUSED">PAUSED</option><option value="ARCHIVED">ARCHIVED</option></select></div>
              <div className="stack"><label className="label">Payout Provider</label><input value={hostForm.payoutProvider} onChange={(e) => setHostForm({ ...hostForm, payoutProvider: e.target.value })} placeholder="stripe-connect / manual" /></div>
            </div>
            <div className="form-grid-2">
              <div className="stack"><label className="label">Payout Account Ref</label><input value={hostForm.payoutAccountRef} onChange={(e) => setHostForm({ ...hostForm, payoutAccountRef: e.target.value })} /></div>
              <label className="label" style={{ textTransform: 'none', letterSpacing: 0 }}><input type="checkbox" checked={hostForm.payoutEnabled} onChange={(e) => setHostForm({ ...hostForm, payoutEnabled: e.target.checked })} /> Payouts Enabled</label>
            </div>
            <div className="stack"><label className="label">Notes</label><textarea rows={3} value={hostForm.notes} onChange={(e) => setHostForm({ ...hostForm, notes: e.target.value })} /></div>
            <div className="inline-actions"><button type="submit" disabled={!canManageCarSharing}>{hostForm.id ? 'Update Host' : 'Create Host'}</button></div>
          </form>

          <div className="metric-grid">
            {activeHosts.map((host) => <HostCard key={host.id} host={host} onEdit={setHostForm} />)}
          </div>
          {!activeHosts.length && !loading ? <div className="surface-note">No host profiles yet for this tenant.</div> : null}
        </section>

        <section id="car-sharing-listings" className="glass card-lg section-card">
          <div className="row-between">
            <h3 style={{ margin: 0 }}>Vehicle Listings</h3>
            <button type="button" className="button-subtle" onClick={resetListingForm}>New Listing</button>
          </div>
          <form className="stack" onSubmit={saveListing}>
            <div className="form-grid-2">
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
            <div className="form-grid-3">
              <div className="stack"><label className="label">Base Daily Rate</label><input type="number" min="0" step="0.01" value={listingForm.baseDailyRate} onChange={(e) => setListingForm({ ...listingForm, baseDailyRate: e.target.value })} /></div>
              <div className="stack"><label className="label">Cleaning Fee</label><input type="number" min="0" step="0.01" value={listingForm.cleaningFee} onChange={(e) => setListingForm({ ...listingForm, cleaningFee: e.target.value })} /></div>
              <div className="stack"><label className="label">Delivery Fee</label><input type="number" min="0" step="0.01" value={listingForm.deliveryFee} onChange={(e) => setListingForm({ ...listingForm, deliveryFee: e.target.value })} /></div>
              <div className="stack"><label className="label">Security Deposit</label><input type="number" min="0" step="0.01" value={listingForm.securityDeposit} onChange={(e) => setListingForm({ ...listingForm, securityDeposit: e.target.value })} /></div>
              <div className="stack"><label className="label">Min Trip Days</label><input type="number" min="1" value={listingForm.minTripDays} onChange={(e) => setListingForm({ ...listingForm, minTripDays: e.target.value })} /></div>
              <div className="stack"><label className="label">Max Trip Days</label><input type="number" min="1" value={listingForm.maxTripDays} onChange={(e) => setListingForm({ ...listingForm, maxTripDays: e.target.value })} /></div>
            </div>
            <label className="label" style={{ textTransform: 'none', letterSpacing: 0 }}><input type="checkbox" checked={listingForm.instantBook} onChange={(e) => setListingForm({ ...listingForm, instantBook: e.target.checked })} /> Instant Book</label>
            <div className="stack"><label className="label">Trip Rules</label><textarea rows={3} value={listingForm.tripRules} onChange={(e) => setListingForm({ ...listingForm, tripRules: e.target.value })} /></div>
            <div className="inline-actions"><button type="submit" disabled={!canManageCarSharing}>{listingForm.id ? 'Update Listing' : 'Create Listing'}</button></div>
          </form>

          {!filteredEligibleVehicles.length ? (
            <div className="surface-note">
              No car-sharing eligible vehicles are available for this tenant yet. Enable the feature on the tenant and set some vehicles to `CAR_SHARING_ONLY` or `BOTH` below.
            </div>
          ) : null}

          <div className="metric-grid">
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
          {!listings.length && !loading ? <div className="surface-note">No listings yet for this tenant.</div> : null}
        </section>
      </section>

      <section id="car-sharing-windows" className="glass card-lg section-card" style={{ marginTop: 18 }}>
        <div className="row-between">
          <h3 style={{ margin: 0 }}>Availability Windows</h3>
          {selectedListing ? <button type="button" className="button-subtle" onClick={() => setWindowForm(EMPTY_WINDOW)}>New Window</button> : null}
        </div>
        {!selectedListing ? (
          <div className="surface-note">
            Edit a listing first to manage blackout dates, price overrides, and minimum stay rules.
          </div>
        ) : (
          <>
            <div className="surface-note">
              Managing windows for <strong>{selectedListing.title}</strong>
            </div>
            <form className="stack" onSubmit={saveAvailabilityWindow}>
              <div className="form-grid-2">
                <div className="stack"><label className="label">Start</label><input type="datetime-local" value={windowForm.startAt} onChange={(e) => setWindowForm({ ...windowForm, startAt: e.target.value })} /></div>
                <div className="stack"><label className="label">End</label><input type="datetime-local" value={windowForm.endAt} onChange={(e) => setWindowForm({ ...windowForm, endAt: e.target.value })} /></div>
                <div className="stack"><label className="label">Price Override</label><input type="number" min="0" step="0.01" value={windowForm.priceOverride} onChange={(e) => setWindowForm({ ...windowForm, priceOverride: e.target.value })} /></div>
                <div className="stack"><label className="label">Min Trip Days Override</label><input type="number" min="1" value={windowForm.minTripDaysOverride} onChange={(e) => setWindowForm({ ...windowForm, minTripDaysOverride: e.target.value })} /></div>
              </div>
              <label className="label" style={{ textTransform: 'none', letterSpacing: 0 }}><input type="checkbox" checked={windowForm.isBlocked} onChange={(e) => setWindowForm({ ...windowForm, isBlocked: e.target.checked })} /> Block this window</label>
              <div className="stack"><label className="label">Note</label><textarea rows={2} value={windowForm.note} onChange={(e) => setWindowForm({ ...windowForm, note: e.target.value })} /></div>
              <div className="inline-actions"><button type="submit">{windowForm.id ? 'Update Window' : 'Create Window'}</button></div>
            </form>

            <div className="table-shell">
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
                    <td><span className={window.isBlocked ? 'status-chip warn' : 'status-chip good'}>{window.isBlocked ? 'Blocked' : 'Open'}</span></td>
                    <td>{window.priceOverride !== null && window.priceOverride !== undefined ? formatMoney(window.priceOverride) : '-'}</td>
                    <td>{window.minTripDaysOverride || '-'}</td>
                    <td>{window.note || '-'}</td>
                    <td>
                      <div className="inline-actions">
                        <button type="button" className="button-subtle" onClick={() => setWindowForm({
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
            </div>
            {!(selectedListing.availabilityWindows || []).length ? (
              <div className="surface-note">
                No availability windows yet for this listing.
              </div>
            ) : null}
          </>
        )}
      </section>

      <section id="car-sharing-trips" className="glass card-lg section-card" style={{ marginTop: 18 }}>
        <div className="row-between">
          <h3 style={{ margin: 0 }}>Trip Creation</h3>
          <div className="ui-muted">Internal booking flow on top of listing supply.</div>
        </div>
        {!selectedListing ? (
          <div className="surface-note">
            Edit a listing first to create trips from it.
          </div>
        ) : (
          <>
            <div className="surface-note">
              Creating trips for <strong>{selectedListing.title}</strong>
            </div>
            <form className="stack" onSubmit={saveTrip}>
              <div className="form-grid-2">
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
              <div className="stack">
                <label className="label">Fulfillment</label>
                <select value={tripForm.fulfillmentChoice} onChange={(e) => setTripForm({ ...tripForm, fulfillmentChoice: e.target.value })}>
                  <option value="PICKUP">Pickup</option>
                  <option value="DELIVERY">Delivery</option>
                </select>
              </div>
              {tripForm.fulfillmentChoice === 'DELIVERY' && (selectedListing?.serviceAreas || []).filter((a) => ['DELIVERY', 'BOTH'].includes(String(a.serviceType || '').toUpperCase())).length ? (
                <div className="stack">
                  <label className="label">Delivery Area</label>
                  <select value={tripForm.deliveryAreaChoice} onChange={(e) => setTripForm({ ...tripForm, deliveryAreaChoice: e.target.value, searchPlaceId: e.target.value })}>
                    <option value="">Any delivery area</option>
                    {(selectedListing.serviceAreas || []).filter((a) => ['DELIVERY', 'BOTH'].includes(String(a.serviceType || '').toUpperCase())).map((area) => (
                      <option key={area.id} value={area.searchPlace?.id || area.id}>
                        {area.searchPlace?.displayName || area.searchPlace?.name || area.id}{area.radiusMiles ? ` (${area.radiusMiles} mi)` : ''}
                      </option>
                    ))}
                  </select>
                </div>
              ) : null}
              <div className="stack"><label className="label">Notes</label><textarea rows={2} value={tripForm.notes} onChange={(e) => setTripForm({ ...tripForm, notes: e.target.value })} /></div>
              <div className="inline-actions"><button type="submit">Create Trip</button></div>
            </form>

            <div className="table-shell">
            <table>
              <thead>
                <tr>
                  <th>Trip</th>
                  <th>Reservation</th>
                  <th>Workflow</th>
                  <th>Handoff</th>
                  <th>Guest</th>
                  <th>Status</th>
                  <th>Pickup</th>
                  <th>Return</th>
                  <th>Guest Total</th>
                  <th>Host Net</th>
                  <th>Host Fee</th>
                  <th>Trip Fee</th>
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
                        <div className="inline-actions">
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
                    <td>
                      {trip.fulfillmentPlan ? (
                        <div className="stack" style={{ gap: 3, fontSize: 11 }}>
                          <span>{trip.fulfillmentPlan.fulfillmentChoice || 'PICKUP'}</span>
                          <span className="label" style={{ textTransform: 'none', letterSpacing: 0 }}>{trip.fulfillmentPlan.handoffMode || 'IN_PERSON'}</span>
                          {trip.fulfillmentPlan.confirmedAt
                            ? <span style={{ color: '#047857' }}>Confirmed</span>
                            : <span style={{ color: '#b45309' }}>Unconfirmed</span>}
                        </div>
                      ) : <span className="ui-muted" style={{ fontSize: 11 }}>No plan</span>}
                    </td>
                    <td>{trip.guestCustomer ? [trip.guestCustomer.firstName, trip.guestCustomer.lastName].filter(Boolean).join(' ') : '-'}</td>
                    <td><span className={tripStatusClass(trip.status)}>{trip.status}</span></td>
                    <td>{new Date(trip.scheduledPickupAt).toLocaleString()}</td>
                    <td>{new Date(trip.scheduledReturnAt).toLocaleString()}</td>
                    <td>{formatMoney(trip.quotedTotal)}</td>
                    <td>{formatMoney(trip.hostEarnings)}</td>
                    <td>{formatMoney(trip.hostServiceFee)}</td>
                    <td>{formatMoney(trip.guestTripFee)}</td>
                    <td>
                      <div className="inline-actions">
                        {tripActionsFor(trip.status).map((action) => (
                          <button key={action} type="button" className="button-subtle" onClick={() => updateTripStatus(trip.id, action)}>{action}</button>
                        ))}
                        {trip.reservation?.id ? (
                          <>
                            <a href={`/reservations/${trip.reservation.id}`}>
                              <button type="button">Open Workflow</button>
                            </a>
                            <a href={`/reservations/${trip.reservation.id}/checkout`}>
                              <button type="button" className="button-subtle">Checkout</button>
                            </a>
                            <a href={`/reservations/${trip.reservation.id}/checkin`}>
                              <button type="button" className="button-subtle">Check-in</button>
                            </a>
                            <a href={`/reservations/${trip.reservation.id}/inspection-report`}>
                              <button type="button" className="button-subtle">Inspections</button>
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
            </div>
            {!selectedListingTrips.length ? (
              <div className="surface-note">
                No trips yet for this listing.
              </div>
            ) : null}
          </>
        )}
      </section>

      <section className="glass card-lg section-card" style={{ marginTop: 18 }}>
        <div className="row-between">
          <h3 style={{ margin: 0 }}>Vehicle Fleet Access</h3>
          <div className="ui-muted">Separate traditional rental inventory from car sharing supply.</div>
        </div>
        {isSuper ? (
          <div className="surface-note">
            Unassigned vehicles are shown here too. Changing fleet mode from this screen will attach them to the active tenant.
          </div>
        ) : null}
        <div className="table-shell">
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
                <td><span className="status-chip neutral">{vehicle.status}</span></td>
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
        </div>
        {!assignableVehicles.length && !loading ? <div className="surface-note">No vehicles found for this tenant.</div> : null}
      </section>

      {handoffAlerts.length ? (
        <section className="glass card-lg section-card" style={{ marginTop: 18 }}>
          <div className="row-between">
            <h3 style={{ margin: 0 }}>Handoff Confirmation Alerts ({handoffAlerts.length})</h3>
            <button type="button" onClick={sendHandoffReminders}>Send Reminders</button>
          </div>
          <div className="table-shell">
            <table>
              <thead>
                <tr>
                  <th>Trip</th>
                  <th>Listing</th>
                  <th>Pickup</th>
                  <th>Hours Until</th>
                  <th>Handoff Mode</th>
                  <th>Status</th>
                  <th>Note</th>
                </tr>
              </thead>
              <tbody>
                {handoffAlerts.map((alert) => (
                  <tr key={alert.tripId}>
                    <td>{alert.tripCode || alert.tripId}</td>
                    <td>{alert.listingId}</td>
                    <td>{alert.scheduledPickupAt ? new Date(alert.scheduledPickupAt).toLocaleString() : '-'}</td>
                    <td>{alert.isOverdue ? <span style={{ color: '#b91c1c' }}>OVERDUE</span> : `${alert.hoursUntilPickup}h`}</td>
                    <td>{alert.handoffMode}</td>
                    <td>{alert.pickupRevealMode}</td>
                    <td style={{ fontSize: 11 }}>{alert.reason}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}

      {pendingSearchPlaces.length ? (
        <section className="glass card-lg section-card" style={{ marginTop: 18 }}>
          <div className="row-between">
            <h3 style={{ margin: 0 }}>Pending Search Places ({pendingSearchPlaces.length})</h3>
          </div>
          <div className="table-shell">
            <table>
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Type</th>
                  <th>City</th>
                  <th>State</th>
                  <th>Tenant</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {pendingSearchPlaces.map((place) => (
                  <tr key={place.id}>
                    <td>{place.displayName || place.name || place.id}</td>
                    <td>{place.placeType || '-'}</td>
                    <td>{place.city || '-'}</td>
                    <td>{place.state || '-'}</td>
                    <td>{place.tenantId || 'Global'}</td>
                    <td>
                      <div className="inline-actions">
                        <button type="button" onClick={() => approveSearchPlace(place.id)}>Approve</button>
                        <button type="button" className="button-subtle" onClick={() => rejectSearchPlace(place.id)}>Reject</button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}

      <section className="glass card-lg section-card" style={{ marginTop: 18 }}>
        <h3 style={{ margin: 0 }}>Launch Direction</h3>
        <div className="stack">
          {discoveryBullets.map((point) => (
            <div key={point} className="surface-note">
              {point}
            </div>
          ))}
        </div>
      </section>
    </AppShell>
  );
}
