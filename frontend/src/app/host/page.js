'use client';

import { useEffect, useMemo, useState } from 'react';
import { AuthGate } from '../../components/AuthGate';
import { AppShell } from '../../components/AppShell';
import { MobileAppShell } from '../../components/MobileAppShell';
import { api } from '../../lib/client';

const MAX_INLINE_PDF_BYTES = 350 * 1024;
const MAX_SUBMISSION_PAYLOAD_CHARS = 850000;
const HOST_SELECTED_PROFILE_KEY = 'host.selectedProfile';
const HOST_TRIP_FILTER_KEY = 'host.tripStatusFilter';
const HOST_LISTING_EDIT_KEY = 'host.listingEditId';
const HOST_AVAILABILITY_KEY = 'host.availabilityListingId';

function formatMoney(value) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(Number(value || 0));
}

function formatRating(value, count = 0) {
  const rating = Number(value || 0);
  if (!count) return 'No ratings yet';
  return `${rating.toFixed(2)} ★ (${count})`;
}

function formatDateTime(value) {
  if (!value) return '-';
  try { return new Date(value).toLocaleString(); } catch { return String(value); }
}

function formatDate(value) {
  if (!value) return '-';
  try { return new Date(value).toLocaleDateString(); } catch { return String(value); }
}

function parsePhotoList(value) {
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) : value;
    return Array.isArray(parsed)
      ? parsed.map((item) => String(item || '').trim()).filter(Boolean).slice(0, 6)
      : [];
  } catch {
    return [];
  }
}

function parseAddOns(value) {
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) : value;
    return Array.isArray(parsed)
      ? parsed.map((row) => ({
          name: String(row?.name || '').trim(),
          price: String(row?.price ?? '').trim(),
          description: String(row?.description || '').trim()
        }))
      : [];
  } catch {
    return [];
  }
}

function parseDeliveryAreas(value) {
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) : value;
    return Array.isArray(parsed)
      ? parsed.map((row) => String(row || '').trim()).filter(Boolean).slice(0, 12)
      : [];
  } catch {
    return String(value || '')
      .split(/\r?\n|,/)
      .map((row) => row.trim())
      .filter(Boolean)
      .slice(0, 12);
  }
}

function primaryPhoto(value) {
  return parsePhotoList(value)[0] || '';
}

function submissionProgress(row) {
  const photoCount = Array.isArray(row?.photos) ? row.photos.length : parsePhotoList(row?.photosJson).length;
  const docCount = [
    !!row?.insuranceDocumentUrl,
    !!row?.registrationDocumentUrl,
    !!row?.initialInspectionDocumentUrl
  ].filter(Boolean).length;
  const pendingReply = (row?.communications || []).find((entry) => entry.publicTokenExpiresAt && !entry.respondedAt);
  const responded = (row?.communications || []).find((entry) => !!entry.respondedAt);
  return {
    photoCount,
    docCount,
    pendingReply,
    responded,
    addOnCount: Array.isArray(row?.addOns) ? row.addOns.length : parseAddOns(row?.addOnsJson).length
  };
}

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(new Error(`Could not read ${file?.name || 'file'}`));
    reader.readAsDataURL(file);
  });
}

function loadImage(dataUrl) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('Could not process image'));
    image.src = dataUrl;
  });
}

async function compressImageFile(file, { maxWidth = 1400, maxHeight = 1400, quality = 0.72 } = {}) {
  const raw = await fileToDataUrl(file);
  const image = await loadImage(raw);
  let width = image.width || maxWidth;
  let height = image.height || maxHeight;

  const scale = Math.min(1, maxWidth / width, maxHeight / height);
  width = Math.max(1, Math.round(width * scale));
  height = Math.max(1, Math.round(height * scale));

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(image, 0, 0, width, height);
  return canvas.toDataURL('image/jpeg', quality);
}

async function toCompactUploadPayload(file, options = {}) {
  if (!file) return '';
  if (String(file.type || '').startsWith('image/')) {
    return compressImageFile(file, options);
  }
  if (String(file.type || '').includes('pdf')) {
    if (Number(file.size || 0) > MAX_INLINE_PDF_BYTES) {
      throw new Error(`PDF "${file.name}" is too large for inline upload. Please use an image or a PDF under ${Math.round(MAX_INLINE_PDF_BYTES / 1024)} KB.`);
    }
    return fileToDataUrl(file);
  }
  return fileToDataUrl(file);
}

function estimateSubmissionPayload(form) {
  const pieces = [
    ...(form.photos || []),
    form.insuranceDocumentUrl || '',
    form.registrationDocumentUrl || '',
    form.initialInspectionDocumentUrl || '',
    JSON.stringify((form.addOns || []).filter((row) => row.name && row.price))
  ];
  return pieces.reduce((sum, item) => sum + String(item || '').length, 0);
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

function guestFlowLabel(trip) {
  const reservation = trip?.reservation || null;
  if (!reservation) return 'Workflow missing';
  if (!reservation.customerInfoCompletedAt) return 'Guest pre-check-in pending';
  if (!reservation.signatureSignedAt) return 'Guest signature pending';
  if (Number(reservation?.rentalAgreement?.balance || 0) > 0) return 'Guest payment pending';
  if (!reservation.readyForPickupAt) return 'Awaiting pickup readiness';
  return 'Guest ready for handoff';
}

function fulfillmentModeLabel(mode) {
  const value = String(mode || 'PICKUP_ONLY').toUpperCase();
  if (value === 'DELIVERY_ONLY') return 'Delivery only';
  if (value === 'PICKUP_OR_DELIVERY') return 'Pickup or delivery';
  return 'Pickup only';
}

function deliveryEnabled(mode) {
  return String(mode || 'PICKUP_ONLY').toUpperCase() !== 'PICKUP_ONLY';
}

function deliveryToggleValue(mode) {
  return deliveryEnabled(mode) ? 'YES' : 'NO';
}

function enableDeliveryMode(mode) {
  return String(mode || '').toUpperCase() === 'DELIVERY_ONLY' ? 'DELIVERY_ONLY' : 'PICKUP_OR_DELIVERY';
}

function listingToEdit(listing) {
  return {
    id: listing.id,
    shortDescription: listing.shortDescription || '',
    description: listing.description || '',
    status: listing.status || 'DRAFT',
    fulfillmentMode: listing.fulfillmentMode || 'PICKUP_ONLY',
    baseDailyRate: String(listing.baseDailyRate ?? ''),
    cleaningFee: String(listing.cleaningFee ?? ''),
    pickupFee: String(listing.pickupFee ?? ''),
    deliveryFee: String(listing.deliveryFee ?? ''),
    deliveryRadiusMiles: listing.deliveryRadiusMiles ? String(listing.deliveryRadiusMiles) : '',
    deliveryAreasText: parseDeliveryAreas(listing.deliveryAreasJson).join('\n'),
    deliveryNotes: listing.deliveryNotes || '',
    securityDeposit: String(listing.securityDeposit ?? ''),
    instantBook: !!listing.instantBook,
    minTripDays: String(listing.minTripDays ?? 1),
    maxTripDays: listing.maxTripDays ? String(listing.maxTripDays) : '',
    tripRules: listing.tripRules || '',
    photoUrls: parsePhotoList(listing.photosJson),
    addOns: parseAddOns(listing.addOnsJson)
  };
}

const EMPTY_LISTING_EDIT = {
  id: '', shortDescription: '', description: '', status: 'DRAFT',
  fulfillmentMode: 'PICKUP_ONLY', baseDailyRate: '', cleaningFee: '', pickupFee: '', deliveryFee: '', deliveryRadiusMiles: '', deliveryAreasText: '', deliveryNotes: '', securityDeposit: '',
  instantBook: false, minTripDays: '1', maxTripDays: '', tripRules: '', photoUrls: [], addOns: []
};

const EMPTY_SUBMISSION_FORM = {
  vehicleTypeId: '', preferredLocationId: '', preferredPickupSpotId: '', year: '', make: '', model: '', color: '', vin: '', plate: '', mileage: '',
  fulfillmentMode: 'PICKUP_ONLY', baseDailyRate: '', cleaningFee: '', pickupFee: '', deliveryFee: '', deliveryRadiusMiles: '', deliveryAreasText: '', deliveryNotes: '', securityDeposit: '', minTripDays: '1', maxTripDays: '',
  shortDescription: '', description: '', tripRules: '', photos: [], insuranceDocumentUrl: '', registrationDocumentUrl: '',
  initialInspectionDocumentUrl: '', initialInspectionNotes: '', addOns: []
};

const EMPTY_PICKUP_SPOT_FORM = {
  label: '',
  anchorLocationId: '',
  address1: '',
  address2: '',
  city: '',
  state: '',
  postalCode: '',
  country: 'Puerto Rico',
  instructions: '',
  isDefault: true
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
  const [selectedHostProfileId, setSelectedHostProfileId] = useState(() => {
    if (typeof window === 'undefined') return '';
    try { return localStorage.getItem(HOST_SELECTED_PROFILE_KEY) || ''; } catch { return ''; }
  });
  const [listingEdit, setListingEdit] = useState(EMPTY_LISTING_EDIT);
  const [tripStatusFilter, setTripStatusFilter] = useState(() => {
    if (typeof window === 'undefined') return '';
    try { return localStorage.getItem(HOST_TRIP_FILTER_KEY) || ''; } catch { return ''; }
  });
  const [availabilityRows, setAvailabilityRows] = useState([]);
  const [availabilityListingId, setAvailabilityListingId] = useState(() => {
    if (typeof window === 'undefined') return '';
    try { return localStorage.getItem(HOST_AVAILABILITY_KEY) || ''; } catch { return ''; }
  });
  const [windowForm, setWindowForm] = useState(EMPTY_WINDOW_FORM);
  const [issueForm, setIssueForm] = useState(EMPTY_ISSUE_FORM);
  const [submissionForm, setSubmissionForm] = useState(EMPTY_SUBMISSION_FORM);
  const [pickupSpotForm, setPickupSpotForm] = useState(EMPTY_PICKUP_SPOT_FORM);
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
  useEffect(() => {
    try {
      if (selectedHostProfileId) localStorage.setItem(HOST_SELECTED_PROFILE_KEY, selectedHostProfileId);
      else localStorage.removeItem(HOST_SELECTED_PROFILE_KEY);
    } catch {}
  }, [selectedHostProfileId]);
  useEffect(() => {
    try {
      if (tripStatusFilter) localStorage.setItem(HOST_TRIP_FILTER_KEY, tripStatusFilter);
      else localStorage.removeItem(HOST_TRIP_FILTER_KEY);
    } catch {}
  }, [tripStatusFilter]);
  useEffect(() => {
    try {
      if (listingEdit.id) localStorage.setItem(HOST_LISTING_EDIT_KEY, listingEdit.id);
      else localStorage.removeItem(HOST_LISTING_EDIT_KEY);
    } catch {}
  }, [listingEdit.id]);
  useEffect(() => {
    try {
      if (availabilityListingId) localStorage.setItem(HOST_AVAILABILITY_KEY, availabilityListingId);
      else localStorage.removeItem(HOST_AVAILABILITY_KEY);
    } catch {}
  }, [availabilityListingId]);

  const metrics = dashboard?.metrics || { listings: 0, activeListings: 0, instantBookListings: 0, trips: 0, activeTrips: 0, projectedEarnings: 0 };
  const host = dashboard?.hostProfile || null;
  const recentReviews = dashboard?.recentReviews || [];
  const listings = dashboard?.listings || [];
  const trips = dashboard?.trips || [];
  const submissions = dashboard?.vehicleSubmissions || [];
  const vehicleTypes = dashboard?.vehicleTypes || [];
  const locations = dashboard?.locations || [];
  const pickupSpots = dashboard?.pickupSpots || [];

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

  const hostMobileSnapshot = useMemo(() => ({
    publishedListings: listings.filter((row) => String(row.status || '').toUpperCase() === 'PUBLISHED').length,
    listingsWithPhotos: listings.filter((row) => parsePhotoList(row.photosJson).length > 0).length,
    listingsWithAddOns: listings.filter((row) => parseAddOns(row.addOnsJson).filter((item) => item.name && item.price).length > 0).length,
    instantBookListings: listings.filter((row) => !!row.instantBook).length,
    nextPickupAt: hostSnapshot.upcomingPickups[0]?.scheduledPickupAt || null
  }), [hostSnapshot.upcomingPickups, listings]);

  const hostTripOpsSnapshot = useMemo(() => {
    const nextHandoffTrip = hostSnapshot.upcomingPickups[0] || hostSnapshot.watchlist[0] || null;
    const guestActionTrips = trips.filter((trip) => {
      const reservation = trip?.reservation || null;
      return !!reservation && (
        !reservation.customerInfoCompletedAt ||
        !reservation.signatureSignedAt ||
        Number(reservation?.rentalAgreement?.balance || 0) > 0
      );
    });
    const readyForHandoff = trips.filter((trip) => {
      const reservation = trip?.reservation || null;
      return !!reservation?.readyForPickupAt && ['CONFIRMED', 'READY_FOR_PICKUP'].includes(String(trip?.status || '').toUpperCase());
    });
    return {
      nextHandoffTrip,
      guestActionTrips,
      readyForHandoff
    };
  }, [hostSnapshot.upcomingPickups, hostSnapshot.watchlist, trips]);

  const hostShellStats = useMemo(() => ([
    { label: 'Listings', value: `${metrics.activeListings}/${metrics.listings || 0} active` },
    { label: 'Next Handoff', value: hostTripOpsSnapshot.nextHandoffTrip?.tripCode || 'Clear' },
    { label: 'Guest Readiness', value: `${hostTripOpsSnapshot.guestActionTrips.length} waiting` },
    { label: 'Approvals', value: `${submissions.filter((row) => String(row.status || '').toUpperCase() === 'PENDING_REVIEW').length} pending` }
  ]), [hostTripOpsSnapshot.guestActionTrips.length, hostTripOpsSnapshot.nextHandoffTrip?.tripCode, metrics.activeListings, metrics.listings, submissions]);

  const selectedListingSnapshot = useMemo(() => {
    if (!listingEdit.id) return null;
    return {
      photoCount: (listingEdit.photoUrls || []).length,
      addOnCount: (listingEdit.addOns || []).filter((row) => row.name && row.price).length,
      pricingReady: !!Number(listingEdit.baseDailyRate || 0),
      publishState: listingEdit.status || 'DRAFT',
      fulfillmentMode: listingEdit.fulfillmentMode || 'PICKUP_ONLY',
      deliveryFee: Number(listingEdit.deliveryFee || 0),
      pickupFee: Number(listingEdit.pickupFee || 0),
      deliveryRadiusMiles: Number(listingEdit.deliveryRadiusMiles || 0),
      cleaningFee: Number(listingEdit.cleaningFee || 0),
      securityDeposit: Number(listingEdit.securityDeposit || 0),
      instantBook: !!listingEdit.instantBook
    };
  }, [listingEdit]);

  const nextListingAttention = useMemo(() => {
    return listings.find((listing) => parsePhotoList(listing.photosJson).length < 3)
      || listings.find((listing) => !Number(listing.baseDailyRate || 0))
      || listings.find((listing) => !listing.instantBook)
      || listings[0]
      || null;
  }, [listings]);

  const selectedAvailabilityListing = useMemo(
    () => listings.find((row) => row.id === availabilityListingId) || null,
    [availabilityListingId, listings]
  );

  const availabilitySnapshot = useMemo(() => {
    if (!availabilityListingId) return null;
    return {
      totalWindows: availabilityRows.length,
      blockedWindows: availabilityRows.filter((row) => !!row.isBlocked).length,
      priceOverrides: availabilityRows.filter((row) => row.priceOverride != null).length,
      minStayOverrides: availabilityRows.filter((row) => row.minTripDaysOverride != null).length
    };
  }, [availabilityListingId, availabilityRows]);

  useEffect(() => {
    if (!listings.length) return;
    try {
      const storedListingId = localStorage.getItem(HOST_LISTING_EDIT_KEY) || '';
      if (storedListingId && !listingEdit.id) {
        const listing = listings.find((row) => row.id === storedListingId);
        if (listing) setListingEdit(listingToEdit(listing));
      }
      const storedAvailabilityId = localStorage.getItem(HOST_AVAILABILITY_KEY) || '';
      if (storedAvailabilityId && !availabilityListingId) {
        const listing = listings.find((row) => row.id === storedAvailabilityId);
        if (listing) loadAvailability(storedAvailabilityId);
      }
    } catch {}
  }, [availabilityListingId, listingEdit.id, listings]);

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
          fulfillmentMode: listingEdit.fulfillmentMode,
          baseDailyRate: Number(listingEdit.baseDailyRate || 0),
          cleaningFee: Number(listingEdit.cleaningFee || 0),
          pickupFee: Number(listingEdit.pickupFee || 0),
          deliveryFee: Number(listingEdit.deliveryFee || 0),
          deliveryRadiusMiles: listingEdit.deliveryRadiusMiles ? Number(listingEdit.deliveryRadiusMiles) : null,
          deliveryAreas: parseDeliveryAreas(listingEdit.deliveryAreasText),
          deliveryNotes: listingEdit.deliveryNotes,
          securityDeposit: Number(listingEdit.securityDeposit || 0),
          instantBook: !!listingEdit.instantBook,
          minTripDays: Number(listingEdit.minTripDays || 1),
          maxTripDays: listingEdit.maxTripDays ? Number(listingEdit.maxTripDays) : null,
          tripRules: listingEdit.tripRules,
          photosJson: JSON.stringify((listingEdit.photoUrls || []).slice(0, 6)),
          addOnsJson: JSON.stringify((listingEdit.addOns || []).filter((row) => row.name && row.price))
        })
      }, token);
      setMsg('Listing updated');
      setListingEdit(EMPTY_LISTING_EDIT);
      try { localStorage.removeItem(HOST_LISTING_EDIT_KEY); } catch {}
      await load();
    } catch (error) {
      setMsg(error.message);
    }
  }

  async function loadAvailability(listingId) {
    if (!listingId) {
      setAvailabilityListingId('');
      setAvailabilityRows([]);
      try { localStorage.removeItem(HOST_AVAILABILITY_KEY); } catch {}
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

  async function submitVehicleSubmission(event) {
    event.preventDefault();
    try {
      const estimatedPayload = estimateSubmissionPayload(submissionForm);
      if (estimatedPayload > MAX_SUBMISSION_PAYLOAD_CHARS) {
        throw new Error('The vehicle submission is still too large. Use smaller images, avoid large PDFs, or upload fewer/lighter photos before submitting.');
      }
      await api('/api/host-app/vehicle-submissions', {
        method: 'POST',
        body: JSON.stringify({
          ...submissionForm,
          hostProfileId: isAdminViewer ? (selectedHostProfileId || host?.id || '') : undefined,
          year: submissionForm.year ? Number(submissionForm.year) : null,
          mileage: submissionForm.mileage ? Number(submissionForm.mileage) : 0,
          fulfillmentMode: submissionForm.fulfillmentMode,
          baseDailyRate: submissionForm.baseDailyRate ? Number(submissionForm.baseDailyRate) : 0,
          cleaningFee: submissionForm.cleaningFee ? Number(submissionForm.cleaningFee) : 0,
          pickupFee: submissionForm.pickupFee ? Number(submissionForm.pickupFee) : 0,
          deliveryFee: submissionForm.deliveryFee ? Number(submissionForm.deliveryFee) : 0,
          deliveryRadiusMiles: submissionForm.deliveryRadiusMiles ? Number(submissionForm.deliveryRadiusMiles) : null,
          deliveryAreas: parseDeliveryAreas(submissionForm.deliveryAreasText),
          deliveryNotes: submissionForm.deliveryNotes,
          securityDeposit: submissionForm.securityDeposit ? Number(submissionForm.securityDeposit) : 0,
          minTripDays: submissionForm.minTripDays ? Number(submissionForm.minTripDays) : 1,
          maxTripDays: submissionForm.maxTripDays ? Number(submissionForm.maxTripDays) : null,
          photosJson: JSON.stringify((submissionForm.photos || []).slice(0, 6)),
          addOnsJson: JSON.stringify((submissionForm.addOns || []).filter((row) => row.name && row.price))
        })
      }, token);
      setMsg('Vehicle submitted for approval');
      setSubmissionForm(EMPTY_SUBMISSION_FORM);
      await load();
    } catch (error) {
      setMsg(error.message);
    }
  }

  async function savePickupSpot(event) {
    event.preventDefault();
    try {
      await api('/api/host-app/pickup-spots', {
        method: 'POST',
        body: JSON.stringify({
          ...pickupSpotForm,
          hostProfileId: isAdminViewer ? (selectedHostProfileId || host?.id || '') : undefined
        })
      }, token);
      setPickupSpotForm(EMPTY_PICKUP_SPOT_FORM);
      setMsg('Pickup spot saved');
      await load();
    } catch (error) {
      setMsg(error.message);
    }
  }

  function uploadListingPhotos(files) {
    const incoming = Array.from(files || []).slice(0, 6);
    if (!incoming.length) return;
    Promise.all(incoming.map((file) => toCompactUploadPayload(file, { maxWidth: 1600, maxHeight: 1200, quality: 0.74 }))).then((images) => {
      setListingEdit((current) => ({
        ...current,
        photoUrls: [...(current.photoUrls || []), ...images.filter(Boolean)].slice(0, 6)
      }));
      setMsg('Photos optimized for faster upload');
    }).catch((error) => {
      setMsg(error.message);
    });
  }

  function uploadSubmissionPhotos(files) {
    const incoming = Array.from(files || []).slice(0, 6);
    if (!incoming.length) return;
    Promise.all(incoming.map((file) => toCompactUploadPayload(file, { maxWidth: 1400, maxHeight: 1100, quality: 0.7 }))).then((images) => {
      setSubmissionForm((current) => ({
        ...current,
        photos: [...(current.photos || []), ...images.filter(Boolean)].slice(0, 6)
      }));
      setMsg('Vehicle photos optimized for upload');
    }).catch((error) => {
      setMsg(error.message);
    });
  }

  function uploadSubmissionDocument(field, file) {
    if (!file) return;
    toCompactUploadPayload(file, { maxWidth: 1600, maxHeight: 1600, quality: 0.72 })
      .then((payload) => {
        setSubmissionForm((current) => ({ ...current, [field]: payload }));
        setMsg(`${file.name} is ready for submission`);
      })
      .catch((error) => {
        setMsg(error.message);
      });
  }

  function updateAddOn(target, index, key, value) {
    target((current) => {
      const addOns = Array.isArray(current.addOns) ? [...current.addOns] : [];
      addOns[index] = { ...(addOns[index] || { name: '', price: '', description: '' }), [key]: value };
      return { ...current, addOns };
    });
  }

  function removeAddOn(target, index) {
    target((current) => ({ ...current, addOns: (current.addOns || []).filter((_, idx) => idx !== index) }));
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
              <span className="hero-pill">Listing quality</span>
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
              <div className="metric-card"><span className="label">Fleet Pending</span><strong>{dashboard?.metrics?.pendingVehicleApprovals || 0}</strong></div>
              <div className="metric-card"><span className="label">Host Rating</span><strong>{formatRating(host?.averageRating, host?.reviewCount)}</strong></div>
              <div className="metric-card"><span className="label">Reviews</span><strong>{host?.reviewCount || 0}</strong></div>
            </div>
            {host ? (
              <div className="surface-note">
                <strong>{host.displayName}</strong><br />{[host.tenant?.name || 'No tenant', host.status].join(' · ')}<br />{host.payoutEnabled ? 'Payouts enabled' : 'Payouts not enabled yet'}<br />{host.resolvedTenantId ? 'Tenant scope ready' : 'Tenant setup still missing'}<br />Guest rating: {formatRating(host.averageRating, host.reviewCount)}
              </div>
            ) : (
              <div className="surface-note">{loading ? 'Loading host profile...' : 'No host profile is linked to this login yet. Admins can still use the selector below to support hosts.'}</div>
            )}
            {host?.id ? (
              <div className="inline-actions">
                <a href={`/host-profile/${host.id}`} target="_blank" rel="noreferrer"><button type="button" className="button-subtle">View Public Host Profile</button></a>
              </div>
            ) : null}
            {recentReviews.length ? (
              <div className="stack" style={{ marginTop: 12 }}>
                {recentReviews.slice(0, 3).map((review) => (
                  <div key={review.id} className="surface-note">
                    <strong>{Number(review.rating || 0).toFixed(1)} ★</strong> · {review.reviewerName || 'Guest'}<br />
                    {review.comments || 'Guest left a rating without a comment.'}
                  </div>
                ))}
              </div>
            ) : null}
          </div>
        </div>
      </section>

      {msg ? <div className="surface-note" style={{ color: /updated|moved|added|removed/i.test(msg) ? '#166534' : '#991b1b', marginBottom: 18 }}>{msg}</div> : null}

      <MobileAppShell
        eyebrow="Ride Fleet Host App"
        title="Host account shell"
        description="A shared mobile-first foundation for host account, handoff readiness, fleet setup, and approval follow-up."
        statusLabel={host ? 'Host Account' : 'Support Mode'}
        storageKey="host-account"
        stats={hostShellStats}
        tabs={[
          { href: '#host-account', label: 'Account', active: !!host },
          { href: '#host-handoff', label: 'Handoff', active: !!hostTripOpsSnapshot.nextHandoffTrip },
          { href: '#host-fleet', label: 'Fleet', active: listings.length > 0 },
          { href: '#host-approvals', label: 'Approvals', active: submissions.some((row) => String(row.status || '').toUpperCase() === 'PENDING_REVIEW') },
          { href: '#host-actions', label: 'Actions', active: hostSnapshot.watchlist.length > 0 }
        ]}
      />

      <section className="glass card-lg section-card" style={{ marginBottom: 18 }}>
        <div className="row-between">
          <div><div className="section-title">Host Mobile Hub</div><p className="ui-muted">A compact read on listing quality, pricing readiness, and the next handoff moment.</p></div>
          <span className="status-chip neutral">{hostMobileSnapshot.publishedListings} published</span>
        </div>
        <div className="app-card-grid compact">
          <div className="doc-card">
            <strong>Next Pickup</strong>
            <div className="doc-meta">{hostMobileSnapshot.nextPickupAt ? formatDateTime(hostMobileSnapshot.nextPickupAt) : 'No pickup in the next 48 hours'}</div>
          </div>
          <div className="doc-card">
            <strong>Photo Coverage</strong>
            <div className="doc-meta">{hostMobileSnapshot.listingsWithPhotos}/{listings.length || 0} listings have custom host photos.</div>
          </div>
          <div className="doc-card">
            <strong>Add-On Coverage</strong>
            <div className="doc-meta">{hostMobileSnapshot.listingsWithAddOns}/{listings.length || 0} listings have host add-ons ready.</div>
          </div>
          <div className="doc-card">
            <strong>Instant Book</strong>
            <div className="doc-meta">{hostMobileSnapshot.instantBookListings} listing{hostMobileSnapshot.instantBookListings === 1 ? '' : 's'} currently support instant book.</div>
          </div>
        </div>
      </section>

      <section id="host-account" className="glass card-lg section-card" style={{ marginBottom: 18 }}>
        <div className="row-between">
          <div>
            <div className="section-title">Welcome back{host?.displayName ? `, ${host.displayName}` : ''}.</div>
            <p className="ui-muted">This is your host account hub for listings, trips, approvals, and your public trust profile.</p>
          </div>
          <span className="status-chip neutral">{host ? formatRating(host.averageRating, host.reviewCount) : 'Host account'}</span>
        </div>
        <div className="app-card-grid compact">
          <div className="doc-card">
            <strong>Host Profile</strong>
            <div className="doc-meta">{host?.displayName || 'Host profile not linked yet'}</div>
          </div>
          <div className="doc-card">
            <strong>Public Rating</strong>
            <div className="doc-meta">{formatRating(host?.averageRating, host?.reviewCount)}</div>
          </div>
          <div className="doc-card">
            <strong>Pending Approvals</strong>
            <div className="doc-meta">{submissions.filter((row) => String(row.status || '').toUpperCase() === 'PENDING_REVIEW').length} fleet submission{''}</div>
          </div>
          <div className="doc-card">
            <strong>Attention Listing</strong>
            <div className="doc-meta">{nextListingAttention?.title || 'No listings yet'}</div>
          </div>
        </div>
        <div className="surface-note">
          {nextListingAttention
            ? `Next listing to improve: ${nextListingAttention.title}. ${
                parsePhotoList(nextListingAttention.photosJson).length < 3
                  ? 'Add more photos to build guest trust faster.'
                  : !Number(nextListingAttention.baseDailyRate || 0)
                    ? 'Set pricing so guests can actually book it.'
                    : !nextListingAttention.instantBook
                      ? 'Review approval settings and handoff readiness.'
                      : 'Keep this listing updated for stronger conversion.'
              }`
            : 'Once you publish listings and trips, your account summary and next recommendation will show here.'}
        </div>
        <div className="inline-actions">
          {host?.id ? <a href={`/host-profile/${host.id}`}><button type="button">Open Public Host Profile</button></a> : null}
          <a href="#host-fleet"><button type="button" className="button-subtle">Go To Fleet Vehicles</button></a>
        </div>
      </section>

      <section className="split-panel" style={{ marginBottom: 18 }}>
        <section id="host-handoff" className="glass card-lg section-card">
          <div className="row-between">
            <div><div className="section-title">Next Handoff</div><p className="ui-muted">The next trip that likely needs host attention right now.</p></div>
            <span className="status-chip neutral">{hostTripOpsSnapshot.nextHandoffTrip ? 'Live' : 'Clear'}</span>
          </div>
          {hostTripOpsSnapshot.nextHandoffTrip ? (
            <div className="stack">
              <div className="surface-note" style={{ display: 'grid', gap: 10 }}>
                <div className="row-between" style={{ gap: 12, alignItems: 'start' }}>
                  <div>
                    <div style={{ fontWeight: 700 }}>{hostTripOpsSnapshot.nextHandoffTrip.tripCode}</div>
                    <div className="label" style={{ textTransform: 'none', letterSpacing: 0, fontSize: 12 }}>
                      {[
                        hostTripOpsSnapshot.nextHandoffTrip.listing?.title || 'Listing',
                        hostTripOpsSnapshot.nextHandoffTrip.guestCustomer
                          ? [hostTripOpsSnapshot.nextHandoffTrip.guestCustomer.firstName, hostTripOpsSnapshot.nextHandoffTrip.guestCustomer.lastName].filter(Boolean).join(' ')
                          : 'Guest'
                      ].join(' · ')}
                    </div>
                  </div>
                  <span className={statusChip(hostTripOpsSnapshot.nextHandoffTrip.status)}>{hostTripOpsSnapshot.nextHandoffTrip.status}</span>
                </div>
                <div className="app-card-grid compact">
                  <div className="doc-card">
                    <strong>Pickup</strong>
                    <div className="doc-meta">{formatDateTime(hostTripOpsSnapshot.nextHandoffTrip.scheduledPickupAt)}</div>
                  </div>
                  <div className="doc-card">
                    <strong>Guest Flow</strong>
                    <div className="doc-meta">{guestFlowLabel(hostTripOpsSnapshot.nextHandoffTrip)}</div>
                  </div>
                  <div className="doc-card">
                    <strong>Host Earnings</strong>
                    <div className="doc-meta">{formatMoney(hostTripOpsSnapshot.nextHandoffTrip.hostEarnings)}</div>
                  </div>
                  <div className="doc-card">
                    <strong>Support Cases</strong>
                    <div className="doc-meta">{hostTripOpsSnapshot.nextHandoffTrip.incidents?.length || 0} case{(hostTripOpsSnapshot.nextHandoffTrip.incidents?.length || 0) === 1 ? '' : 's'} on this trip.</div>
                  </div>
                </div>
                <div className="inline-actions">
                  {hostTripOpsSnapshot.nextHandoffTrip.reservation?.id ? <a href={`/reservations/${hostTripOpsSnapshot.nextHandoffTrip.reservation.id}`}><button type="button">Open Workflow</button></a> : null}
                  {tripActionsFor(hostTripOpsSnapshot.nextHandoffTrip.status)[0] ? (
                    <button type="button" className="button-subtle" onClick={() => moveTrip(hostTripOpsSnapshot.nextHandoffTrip.id, tripActionsFor(hostTripOpsSnapshot.nextHandoffTrip.status)[0])}>
                      {tripActionsFor(hostTripOpsSnapshot.nextHandoffTrip.status)[0]}
                    </button>
                  ) : null}
                </div>
              </div>
            </div>
          ) : <div className="surface-note">No handoff needs immediate host action right now.</div>}
        </section>

        <section id="host-approvals" className="glass card-lg section-card">
          <div className="row-between">
            <div><div className="section-title">Guest Readiness Lane</div><p className="ui-muted">Trips where the guest still owes a step before handoff feels clean.</p></div>
            <span className="status-chip neutral">{hostTripOpsSnapshot.guestActionTrips.length} waiting</span>
          </div>
          {hostTripOpsSnapshot.guestActionTrips.length ? (
            <div className="stack">
              {hostTripOpsSnapshot.guestActionTrips.slice(0, 4).map((trip) => (
                <div key={trip.id} className="surface-note" style={{ display: 'grid', gap: 8 }}>
                  <div className="row-between" style={{ gap: 12 }}>
                    <strong>{trip.tripCode}</strong>
                    <span className={statusChip(trip.status)}>{trip.status}</span>
                  </div>
                  <div style={{ color: '#55456f', lineHeight: 1.5 }}>
                    {[trip.listing?.title || 'Listing', guestFlowLabel(trip)].join(' · ')}
                  </div>
                  <div className="inline-actions">
                    {trip.reservation?.id ? <a href={`/reservations/${trip.reservation.id}`}><button type="button" className="button-subtle">Open Workflow</button></a> : null}
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="surface-note">Guests are looking clean right now. No pre-check-in, signature, or payment blockers detected.</div>
          )}
        </section>
      </section>

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
      <section id="host-actions" className="glass card-lg section-card">
          <div className="row-between">
            <div><div className="section-title">Add Vehicle To My Fleet</div><p className="ui-muted">Submit a host-owned vehicle, documents, inspection proof, pricing, and host-only add-ons for review.</p></div>
            <span className="status-chip neutral">{dashboard?.metrics?.pendingVehicleApprovals || 0} pending</span>
          </div>
          {!vehicleTypes.length ? (
            <div className="surface-note" style={{ color: '#92400e' }}>
              Vehicle types are not showing for this host yet. This usually means the host profile still needs tenant scope or that no vehicle classes are configured for that tenant.
            </div>
          ) : null}
          <section className="surface-note" style={{ display: 'grid', gap: 14 }}>
            <div className="row-between">
              <div>
                <div className="section-title" style={{ fontSize: 18 }}>Host Pickup Spots</div>
                <p className="ui-muted">Create guest-facing pickup points without changing the tenant's branch locations. Each spot can still anchor back to an approved operational hub.</p>
              </div>
              <span className="status-chip neutral">{pickupSpots.length} spots</span>
            </div>
            <form className="stack" onSubmit={savePickupSpot}>
              <div className="form-grid-3">
                <div className="stack"><label className="label">Spot Label</label><input value={pickupSpotForm.label} onChange={(event) => setPickupSpotForm((current) => ({ ...current, label: event.target.value }))} placeholder="Condado Guest Pickup" /></div>
                <div className="stack">
                  <label className="label">Anchor Branch</label>
                  <select value={pickupSpotForm.anchorLocationId} onChange={(event) => setPickupSpotForm((current) => ({ ...current, anchorLocationId: event.target.value }))}>
                    <option value="">Choose branch</option>
                    {locations.map((row) => <option key={row.id} value={row.id}>{row.name}</option>)}
                  </select>
                </div>
                <div className="stack"><label className="label">Address Line 1</label><input value={pickupSpotForm.address1} onChange={(event) => setPickupSpotForm((current) => ({ ...current, address1: event.target.value }))} /></div>
                <div className="stack"><label className="label">Address Line 2</label><input value={pickupSpotForm.address2} onChange={(event) => setPickupSpotForm((current) => ({ ...current, address2: event.target.value }))} /></div>
                <div className="stack"><label className="label">City</label><input value={pickupSpotForm.city} onChange={(event) => setPickupSpotForm((current) => ({ ...current, city: event.target.value }))} /></div>
                <div className="stack"><label className="label">State</label><input value={pickupSpotForm.state} onChange={(event) => setPickupSpotForm((current) => ({ ...current, state: event.target.value }))} /></div>
                <div className="stack"><label className="label">Postal Code</label><input value={pickupSpotForm.postalCode} onChange={(event) => setPickupSpotForm((current) => ({ ...current, postalCode: event.target.value }))} /></div>
                <div className="stack"><label className="label">Country</label><input value={pickupSpotForm.country} onChange={(event) => setPickupSpotForm((current) => ({ ...current, country: event.target.value }))} /></div>
              </div>
              <div className="stack"><label className="label">Instructions</label><textarea rows={2} value={pickupSpotForm.instructions} onChange={(event) => setPickupSpotForm((current) => ({ ...current, instructions: event.target.value }))} /></div>
              <label style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                <input type="checkbox" checked={pickupSpotForm.isDefault} onChange={(event) => setPickupSpotForm((current) => ({ ...current, isDefault: event.target.checked }))} />
                <span className="label" style={{ margin: 0 }}>Make this the default host pickup spot</span>
              </label>
              <div className="inline-actions"><button type="submit">Save Pickup Spot</button></div>
            </form>
            {pickupSpots.length ? (
              <div className="stack">
                {pickupSpots.map((spot) => (
                  <div key={spot.id} className="surface-note" style={{ display: 'grid', gap: 8 }}>
                    <div className="row-between" style={{ gap: 12 }}>
                      <strong>{spot.label}</strong>
                      <span className={statusChip(spot.approvalStatus || (spot.isActive ? 'ACTIVE' : 'ARCHIVED'))}>
                        {spot.approvalStatus || (spot.isActive ? 'ACTIVE' : 'INACTIVE')}
                      </span>
                    </div>
                    <div className="label" style={{ textTransform: 'none', letterSpacing: 0, fontSize: 12 }}>
                      {[spot.address1, spot.city, spot.state, spot.postalCode].filter(Boolean).join(' · ') || 'No detailed address yet'}
                    </div>
                    <div style={{ color: '#55456f', lineHeight: 1.5 }}>
                      {[spot.anchorLocation?.name ? `Ops hub ${spot.anchorLocation.name}` : '', spot.instructions || '', spot.isDefault ? 'Default pickup spot' : ''].filter(Boolean).join(' · ')}
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="surface-note">No host pickup spots yet. Create one so guests can see a true handoff point without changing the tenant branch list.</div>
            )}
          </section>
          <form className="stack" onSubmit={submitVehicleSubmission}>
            <div className="form-grid-3">
              <div className="stack">
                <label className="label">Vehicle Type</label>
                <select value={submissionForm.vehicleTypeId} onChange={(event) => setSubmissionForm((current) => ({ ...current, vehicleTypeId: event.target.value }))}>
                  <option value="">Choose vehicle type</option>
                  {vehicleTypes.map((row) => <option key={row.id} value={row.id}>{row.name}</option>)}
                </select>
              </div>
              <div className="stack">
                <label className="label">Preferred Location</label>
                <select value={submissionForm.preferredLocationId} onChange={(event) => setSubmissionForm((current) => ({ ...current, preferredLocationId: event.target.value }))}>
                  <option value="">Choose location</option>
                  {locations.map((row) => <option key={row.id} value={row.id}>{row.name}</option>)}
                </select>
              </div>
              <div className="stack">
                <label className="label">Host Pickup Spot</label>
                <select value={submissionForm.preferredPickupSpotId} onChange={(event) => setSubmissionForm((current) => ({ ...current, preferredPickupSpotId: event.target.value }))}>
                  <option value="">Choose host pickup spot</option>
                  {pickupSpots.map((row) => <option key={row.id} value={row.id}>{row.label}</option>)}
                </select>
              </div>
              <div className="stack"><label className="label">Year</label><input type="number" value={submissionForm.year} onChange={(event) => setSubmissionForm((current) => ({ ...current, year: event.target.value }))} /></div>
              <div className="stack"><label className="label">Make</label><input value={submissionForm.make} onChange={(event) => setSubmissionForm((current) => ({ ...current, make: event.target.value }))} /></div>
              <div className="stack"><label className="label">Model</label><input value={submissionForm.model} onChange={(event) => setSubmissionForm((current) => ({ ...current, model: event.target.value }))} /></div>
              <div className="stack"><label className="label">Color</label><input value={submissionForm.color} onChange={(event) => setSubmissionForm((current) => ({ ...current, color: event.target.value }))} /></div>
              <div className="stack"><label className="label">VIN</label><input value={submissionForm.vin} onChange={(event) => setSubmissionForm((current) => ({ ...current, vin: event.target.value }))} /></div>
              <div className="stack"><label className="label">Plate</label><input value={submissionForm.plate} onChange={(event) => setSubmissionForm((current) => ({ ...current, plate: event.target.value }))} /></div>
              <div className="stack"><label className="label">Mileage</label><input type="number" value={submissionForm.mileage} onChange={(event) => setSubmissionForm((current) => ({ ...current, mileage: event.target.value }))} /></div>
            </div>
            <div className="surface-note">
              Keep this simple for the host: start with pickup only, or turn on delivery if the host wants handoff outside the pickup spot.
            </div>
            <div className="form-grid-3">
              <div className="stack">
                <label className="label">Offer Delivery</label>
                <select
                  value={deliveryToggleValue(submissionForm.fulfillmentMode)}
                  onChange={(event) => setSubmissionForm((current) => ({
                    ...current,
                    fulfillmentMode: event.target.value === 'YES' ? enableDeliveryMode(current.fulfillmentMode) : 'PICKUP_ONLY'
                  }))}
                >
                  <option value="NO">No, pickup only</option>
                  <option value="YES">Yes, offer delivery</option>
                </select>
              </div>
              <div className="stack"><label className="label">Daily Rate</label><input type="number" min="0" step="0.01" value={submissionForm.baseDailyRate} onChange={(event) => setSubmissionForm((current) => ({ ...current, baseDailyRate: event.target.value }))} /></div>
              <div className="stack"><label className="label">Cleaning Fee</label><input type="number" min="0" step="0.01" value={submissionForm.cleaningFee} onChange={(event) => setSubmissionForm((current) => ({ ...current, cleaningFee: event.target.value }))} /></div>
              <div className="stack"><label className="label">Security Deposit</label><input type="number" min="0" step="0.01" value={submissionForm.securityDeposit} onChange={(event) => setSubmissionForm((current) => ({ ...current, securityDeposit: event.target.value }))} /></div>
              <div className="stack"><label className="label">Min Trip Days</label><input type="number" min="1" value={submissionForm.minTripDays} onChange={(event) => setSubmissionForm((current) => ({ ...current, minTripDays: event.target.value }))} /></div>
              <div className="stack"><label className="label">Max Trip Days</label><input type="number" min="1" value={submissionForm.maxTripDays} onChange={(event) => setSubmissionForm((current) => ({ ...current, maxTripDays: event.target.value }))} /></div>
            </div>
            {deliveryEnabled(submissionForm.fulfillmentMode) ? (
              <>
                <div className="form-grid-2">
                  <div className="stack">
                    <label className="label">Delivery Style</label>
                    <select value={submissionForm.fulfillmentMode} onChange={(event) => setSubmissionForm((current) => ({ ...current, fulfillmentMode: event.target.value }))}>
                      <option value="PICKUP_OR_DELIVERY">Offer pickup and delivery</option>
                      <option value="DELIVERY_ONLY">Delivery only</option>
                    </select>
                  </div>
                </div>
                <div className="form-grid-3">
                  <div className="stack"><label className="label">Delivery Fee</label><input type="number" min="0" step="0.01" value={submissionForm.deliveryFee} onChange={(event) => setSubmissionForm((current) => ({ ...current, deliveryFee: event.target.value }))} /></div>
                  <div className="stack"><label className="label">Delivery Radius Miles</label><input type="number" min="0" value={submissionForm.deliveryRadiusMiles} onChange={(event) => setSubmissionForm((current) => ({ ...current, deliveryRadiusMiles: event.target.value }))} /></div>
                  <div className="stack"><label className="label">Allowed Delivery Areas</label><textarea rows={3} value={submissionForm.deliveryAreasText} onChange={(event) => setSubmissionForm((current) => ({ ...current, deliveryAreasText: event.target.value }))} placeholder={'One area per line, for example:\nSan Juan\nIsla Verde\nCondado'} /></div>
                </div>
                <details className="surface-note">
                  <summary>Advanced delivery options</summary>
                  <div className="form-grid-2" style={{ marginTop: 12 }}>
                    <div className="stack"><label className="label">Pickup Fee</label><input type="number" min="0" step="0.01" value={submissionForm.pickupFee} onChange={(event) => setSubmissionForm((current) => ({ ...current, pickupFee: event.target.value }))} /></div>
                    <div className="stack"><label className="label">Delivery Notes</label><input value={submissionForm.deliveryNotes} onChange={(event) => setSubmissionForm((current) => ({ ...current, deliveryNotes: event.target.value }))} placeholder="Airport, hotel, or service area guidance" /></div>
                  </div>
                </details>
              </>
            ) : (
              <div className="surface-note">Guests will pick up the vehicle at the host pickup spot. Delivery fields stay hidden until the host enables delivery.</div>
            )}
            <div className="stack"><label className="label">Short Description</label><input value={submissionForm.shortDescription} onChange={(event) => setSubmissionForm((current) => ({ ...current, shortDescription: event.target.value }))} /></div>
            <div className="stack"><label className="label">Description</label><textarea rows={4} value={submissionForm.description} onChange={(event) => setSubmissionForm((current) => ({ ...current, description: event.target.value }))} /></div>
            <div className="stack"><label className="label">Trip Rules</label><textarea rows={3} value={submissionForm.tripRules} onChange={(event) => setSubmissionForm((current) => ({ ...current, tripRules: event.target.value }))} /></div>
            <div className="stack">
              <label className="label">Vehicle Photos</label>
              <input type="file" accept="image/*" multiple onChange={(event) => uploadSubmissionPhotos(event.target.files)} />
              {submissionForm.photos?.length ? (
                <div className="metric-grid">
                  {submissionForm.photos.map((photo, index) => (
                    <div key={`${index}-${photo.slice(0, 18)}`} className="surface-note" style={{ display: 'grid', gap: 8 }}>
                      <img src={photo} alt={`Submitted vehicle ${index + 1}`} style={{ width: '100%', aspectRatio: '16 / 10', objectFit: 'cover', borderRadius: 14 }} />
                      <button type="button" className="button-subtle" onClick={() => setSubmissionForm((current) => ({ ...current, photos: current.photos.filter((_, idx) => idx !== index) }))}>Remove</button>
                    </div>
                  ))}
                </div>
              ) : <div className="surface-note">Upload up to 6 photos of the vehicle. Images are optimized automatically before submit.</div>}
            </div>
            <div className="surface-note">
              For the approval submit, image files work best. Large PDFs can exceed the gateway limit, so if a PDF fails
              use a photo or a smaller PDF.
            </div>
            <div className="form-grid-3">
              <div className="stack"><label className="label">Insurance Document</label><input type="file" accept="image/*,.pdf" onChange={(event) => uploadSubmissionDocument('insuranceDocumentUrl', event.target.files?.[0])} /></div>
              <div className="stack"><label className="label">Registration Document</label><input type="file" accept="image/*,.pdf" onChange={(event) => uploadSubmissionDocument('registrationDocumentUrl', event.target.files?.[0])} /></div>
              <div className="stack"><label className="label">Initial Inspection</label><input type="file" accept="image/*,.pdf" onChange={(event) => uploadSubmissionDocument('initialInspectionDocumentUrl', event.target.files?.[0])} /></div>
            </div>
            <div className="stack"><label className="label">Initial Inspection Notes</label><textarea rows={3} value={submissionForm.initialInspectionNotes} onChange={(event) => setSubmissionForm((current) => ({ ...current, initialInspectionNotes: event.target.value }))} /></div>
            <div className="stack">
              <div className="row-between">
                <label className="label">Host Vehicle Add-Ons</label>
                <button type="button" className="button-subtle" onClick={() => setSubmissionForm((current) => ({ ...current, addOns: [...(current.addOns || []), { name: '', price: '', description: '' }] }))}>Add Service</button>
              </div>
              {(submissionForm.addOns || []).length ? (
                <div className="stack">
                  {(submissionForm.addOns || []).map((row, index) => (
                    <div key={`submission-addon-${index}`} className="surface-note" style={{ display: 'grid', gap: 10 }}>
                      <div className="form-grid-3">
                        <input placeholder="Service name" value={row.name} onChange={(event) => updateAddOn(setSubmissionForm, index, 'name', event.target.value)} />
                        <input placeholder="Price" type="number" min="0" step="0.01" value={row.price} onChange={(event) => updateAddOn(setSubmissionForm, index, 'price', event.target.value)} />
                        <button type="button" className="button-subtle" onClick={() => removeAddOn(setSubmissionForm, index)}>Remove</button>
                      </div>
                      <textarea rows={2} placeholder="Description" value={row.description} onChange={(event) => updateAddOn(setSubmissionForm, index, 'description', event.target.value)} />
                    </div>
                  ))}
                </div>
              ) : <div className="surface-note">Optional host-only add-ons like cooler, car seat, or delivery extras.</div>}
            </div>
            <div className="inline-actions"><button type="submit">Submit Vehicle For Approval</button></div>
          </form>
        </section>

        <section className="glass card-lg section-card">
          <div className="row-between">
            <div><div className="section-title">Fleet Approval Status</div><p className="ui-muted">These submissions stay pending until customer service reviews and approves the vehicle.</p></div>
            <a href="/issues"><button type="button" className="button-subtle">Open Issue Center</button></a>
          </div>
          {submissions.length ? (
            <div className="stack">
              {submissions.map((row) => (
                <div key={row.id} className="surface-note" style={{ display: 'grid', gap: 10 }}>
                  {(() => {
                    const progress = submissionProgress(row);
                    return (
                      <>
                  <div className="row-between" style={{ gap: 12 }}>
                    <strong>{[row.year, row.make, row.model].filter(Boolean).join(' ') || 'Vehicle Submission'}</strong>
                    <span className={statusChip(row.status)}>{row.status}</span>
                  </div>
                  <div className="label" style={{ textTransform: 'none', letterSpacing: 0, fontSize: 12 }}>
                    {[row.vehicleType?.name || '-', row.preferredPickupSpot?.label || row.preferredLocation?.name || '-', formatDateTime(row.createdAt)].join(' - ')}
                  </div>
                  <div className="info-grid-tight">
                    <div className="info-tile"><span className="label">Photos</span><strong>{progress.photoCount}</strong></div>
                    <div className="info-tile"><span className="label">Docs</span><strong>{`${progress.docCount}/3`}</strong></div>
                    <div className="info-tile"><span className="label">Add-Ons</span><strong>{progress.addOnCount}</strong></div>
                    <div className="info-tile"><span className="label">Last Update</span><strong>{formatDateTime(row.updatedAt)}</strong></div>
                  </div>
                  <div style={{ color: '#55456f', lineHeight: 1.5 }}>
                    {[fulfillmentModeLabel(row.fulfillmentMode), row.deliveryRadiusMiles ? `Delivery radius ${row.deliveryRadiusMiles} mi` : '', parseDeliveryAreas(row.deliveryAreasJson).length ? `${parseDeliveryAreas(row.deliveryAreasJson).length} delivery areas` : '', row.plate ? `Plate ${row.plate}` : '', row.vin ? `VIN ${row.vin}` : '', row.reviewNotes || 'Waiting for review.'].filter(Boolean).join(' · ')}
                  </div>
                  <div className="inline-actions">
                    {row.listing?.id ? <span className="status-chip good">Active In Portal</span> : null}
                    {progress.pendingReply ? <span className="status-chip warn">Info Requested</span> : progress.responded ? <span className="status-chip good">You Replied</span> : null}
                  </div>
                      </>
                    );
                  })()}
                </div>
              ))}
            </div>
          ) : <div className="surface-note">No vehicle submissions yet.</div>}
        </section>
      </section>

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
            <div><div className="section-title">My Fleet Vehicles</div><p className="ui-muted">Edit rates, host add-ons, photos, and listing details for active host vehicles.</p></div>
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
                  {parsePhotoList(listing.photosJson).length ? (
                    <img
                      src={parsePhotoList(listing.photosJson)[0]}
                      alt={listing.title}
                      style={{ width: '100%', aspectRatio: '16 / 9', objectFit: 'cover', borderRadius: 16, border: '1px solid rgba(110,73,255,.15)' }}
                    />
                  ) : listing.vehicle?.vehicleType?.imageUrl ? (
                    <img
                      src={listing.vehicle.vehicleType.imageUrl}
                      alt={listing.vehicle.vehicleType.name || listing.title}
                      style={{ width: '100%', aspectRatio: '16 / 9', objectFit: 'cover', borderRadius: 16, border: '1px solid rgba(110,73,255,.15)' }}
                    />
                  ) : null}
                  <div className="metric-grid">
                    <div className="metric-card"><span className="label">Daily Rate</span><strong>{formatMoney(listing.baseDailyRate)}</strong></div>
                    <div className="metric-card"><span className="label">Cleaning Fee</span><strong>{formatMoney(listing.cleaningFee)}</strong></div>
                    <div className="metric-card"><span className="label">Instant Book</span><strong>{listing.instantBook ? 'On' : 'Off'}</strong></div>
                    <div className="metric-card"><span className="label">Min Stay</span><strong>{listing.minTripDays} day(s)</strong></div>
                    <div className="metric-card"><span className="label">Photos</span><strong>{parsePhotoList(listing.photosJson).length}</strong></div>
                    <div className="metric-card"><span className="label">Add-Ons</span><strong>{parseAddOns(listing.addOnsJson).filter((row) => row.name && row.price).length}</strong></div>
                  </div>
                  <div className="surface-note" style={{ color: '#55456f', lineHeight: 1.5 }}>
                    {[fulfillmentModeLabel(listing.fulfillmentMode), listing.deliveryRadiusMiles ? `Delivery radius ${listing.deliveryRadiusMiles} mi` : '', parseDeliveryAreas(listing.deliveryAreasJson).length ? `${parseDeliveryAreas(listing.deliveryAreasJson).length} delivery areas` : '', 'Change daily rate, cleaning fee, delivery fee, deposit, host add-ons, and photos from the editor below.'].filter(Boolean).join(' · ')}
                  </div>
                  <div className="inline-actions">
                    <button type="button" onClick={() => setListingEdit(listingToEdit(listing))}>Edit Rates And Listing</button>
                    <button type="button" className="button-subtle" onClick={() => loadAvailability(listing.id)}>Availability</button>
                  </div>
                </div>
              ))}
            </div>
          ) : <div className="surface-note">No listings yet for this host.</div>}
        </section>

        <section className="glass card-lg section-card">
          <div className="row-between">
            <div><div className="section-title">Rates And Listing Editor</div><p className="ui-muted">This is where hosts can change daily rate, cleaning fee, delivery fee, deposit, host add-ons, and listing photos.</p></div>
            {listingEdit.id ? <button type="button" className="button-subtle" onClick={() => setListingEdit(EMPTY_LISTING_EDIT)}>Clear</button> : null}
          </div>
          {listingEdit.id ? (
            <form className="stack" onSubmit={saveListingEdit}>
              {selectedListingSnapshot ? (
                <div className="app-card-grid compact">
                  <div className="doc-card">
                    <strong>Pricing Ready</strong>
                    <div className="doc-meta">{selectedListingSnapshot.pricingReady ? 'Daily rate is set for booking.' : 'Set a daily rate before publishing.'}</div>
                  </div>
                  <div className="doc-card">
                    <strong>Photos</strong>
                    <div className="doc-meta">{selectedListingSnapshot.photoCount} host photo{selectedListingSnapshot.photoCount === 1 ? '' : 's'} uploaded.</div>
                  </div>
                  <div className="doc-card">
                    <strong>Add-Ons</strong>
                    <div className="doc-meta">{selectedListingSnapshot.addOnCount} host add-on{selectedListingSnapshot.addOnCount === 1 ? '' : 's'} available.</div>
                  </div>
                  <div className="doc-card">
                    <strong>Status</strong>
                    <div className="doc-meta">{selectedListingSnapshot.publishState}</div>
                  </div>
                  <div className="doc-card">
                    <strong>Fulfillment</strong>
                    <div className="doc-meta">
                      {`${fulfillmentModeLabel(selectedListingSnapshot.fulfillmentMode)}${selectedListingSnapshot.deliveryRadiusMiles ? ` · ${selectedListingSnapshot.deliveryRadiusMiles} mi radius` : ''}${parseDeliveryAreas(listingEdit.deliveryAreasText).length ? ` · ${parseDeliveryAreas(listingEdit.deliveryAreasText).length} delivery areas` : ''}`}
                    </div>
                  </div>
                  <div className="doc-card">
                    <strong>Fee Stack</strong>
                    <div className="doc-meta">
                      Cleaning {formatMoney(selectedListingSnapshot.cleaningFee)} · Pickup {formatMoney(selectedListingSnapshot.pickupFee)} · Delivery {formatMoney(selectedListingSnapshot.deliveryFee)}
                    </div>
                  </div>
                  <div className="doc-card">
                    <strong>Booking Controls</strong>
                    <div className="doc-meta">
                      {selectedListingSnapshot.instantBook ? 'Instant book is on.' : 'Approval flow is active.'} Deposit set to {formatMoney(selectedListingSnapshot.securityDeposit)}.
                    </div>
                  </div>
                </div>
              ) : null}
              {selectedListingSnapshot ? (
                <div className="surface-note">
                  Hosts should confirm four things before publishing: daily rate, photo coverage, add-ons if applicable, and whether the listing should be instant book or approval based.
                </div>
              ) : null}
              <div className="stack"><label className="label">Short Description</label><input value={listingEdit.shortDescription} onChange={(event) => setListingEdit((current) => ({ ...current, shortDescription: event.target.value }))} /></div>
              <div className="stack"><label className="label">Description</label><textarea rows={4} value={listingEdit.description} onChange={(event) => setListingEdit((current) => ({ ...current, description: event.target.value }))} /></div>
              <div className="surface-note">
                Keep host pricing simple. Use pickup only by default, and only open delivery fields when the listing really offers delivery.
              </div>
              <div className="form-grid-3">
                <div className="stack"><label className="label">Status</label><select value={listingEdit.status} onChange={(event) => setListingEdit((current) => ({ ...current, status: event.target.value }))}><option value="DRAFT">DRAFT</option><option value="PUBLISHED">PUBLISHED</option><option value="PAUSED">PAUSED</option><option value="ARCHIVED">ARCHIVED</option></select></div>
                <div className="stack">
                  <label className="label">Offer Delivery</label>
                  <select
                    value={deliveryToggleValue(listingEdit.fulfillmentMode)}
                    onChange={(event) => setListingEdit((current) => ({
                      ...current,
                      fulfillmentMode: event.target.value === 'YES' ? enableDeliveryMode(current.fulfillmentMode) : 'PICKUP_ONLY'
                    }))}
                  >
                    <option value="NO">No, pickup only</option>
                    <option value="YES">Yes, offer delivery</option>
                  </select>
                </div>
                <div className="stack"><label className="label">Daily Rate</label><input type="number" min="0" step="0.01" value={listingEdit.baseDailyRate} onChange={(event) => setListingEdit((current) => ({ ...current, baseDailyRate: event.target.value }))} /></div>
                <div className="stack"><label className="label">Security Deposit</label><input type="number" min="0" step="0.01" value={listingEdit.securityDeposit} onChange={(event) => setListingEdit((current) => ({ ...current, securityDeposit: event.target.value }))} /></div>
                <div className="stack"><label className="label">Cleaning Fee</label><input type="number" min="0" step="0.01" value={listingEdit.cleaningFee} onChange={(event) => setListingEdit((current) => ({ ...current, cleaningFee: event.target.value }))} /></div>
                <div className="stack"><label className="label">Min Trip Days</label><input type="number" min="1" value={listingEdit.minTripDays} onChange={(event) => setListingEdit((current) => ({ ...current, minTripDays: event.target.value }))} /></div>
                <div className="stack"><label className="label">Max Trip Days</label><input type="number" min="1" value={listingEdit.maxTripDays} onChange={(event) => setListingEdit((current) => ({ ...current, maxTripDays: event.target.value }))} /></div>
              </div>
              <label className="label" style={{ textTransform: 'none', letterSpacing: 0 }}><input type="checkbox" checked={listingEdit.instantBook} onChange={(event) => setListingEdit((current) => ({ ...current, instantBook: event.target.checked }))} /> Instant Book</label>
              {deliveryEnabled(listingEdit.fulfillmentMode) ? (
                <>
                  <div className="form-grid-2">
                    <div className="stack">
                      <label className="label">Delivery Style</label>
                      <select value={listingEdit.fulfillmentMode} onChange={(event) => setListingEdit((current) => ({ ...current, fulfillmentMode: event.target.value }))}>
                        <option value="PICKUP_OR_DELIVERY">Offer pickup and delivery</option>
                        <option value="DELIVERY_ONLY">Delivery only</option>
                      </select>
                    </div>
                  </div>
                  <div className="form-grid-3">
                    <div className="stack"><label className="label">Delivery Fee</label><input type="number" min="0" step="0.01" value={listingEdit.deliveryFee} onChange={(event) => setListingEdit((current) => ({ ...current, deliveryFee: event.target.value }))} /></div>
                    <div className="stack"><label className="label">Delivery Radius Miles</label><input type="number" min="0" value={listingEdit.deliveryRadiusMiles} onChange={(event) => setListingEdit((current) => ({ ...current, deliveryRadiusMiles: event.target.value }))} /></div>
                    <div className="stack"><label className="label">Allowed Delivery Areas</label><textarea rows={3} value={listingEdit.deliveryAreasText} onChange={(event) => setListingEdit((current) => ({ ...current, deliveryAreasText: event.target.value }))} placeholder={'One area per line, for example:\nSan Juan\nIsla Verde\nCondado'} /></div>
                  </div>
                  <details className="surface-note">
                    <summary>Advanced delivery options</summary>
                    <div className="form-grid-2" style={{ marginTop: 12 }}>
                      <div className="stack"><label className="label">Pickup Fee</label><input type="number" min="0" step="0.01" value={listingEdit.pickupFee} onChange={(event) => setListingEdit((current) => ({ ...current, pickupFee: event.target.value }))} /></div>
                      <div className="stack"><label className="label">Delivery Notes</label><textarea rows={2} value={listingEdit.deliveryNotes} onChange={(event) => setListingEdit((current) => ({ ...current, deliveryNotes: event.target.value }))} placeholder="Explain the service area, airport delivery guidance, or any handoff rules." /></div>
                    </div>
                  </details>
                </>
              ) : (
                <div className="surface-note">Guests will pick up the vehicle at the configured pickup spot. Delivery fields stay hidden until delivery is enabled.</div>
              )}
              <div className="stack"><label className="label">Trip Rules</label><textarea rows={3} value={listingEdit.tripRules} onChange={(event) => setListingEdit((current) => ({ ...current, tripRules: event.target.value }))} /></div>
              <div className="stack">
                <div className="row-between">
                  <label className="label">Host Vehicle Add-Ons</label>
                  <button type="button" className="button-subtle" onClick={() => setListingEdit((current) => ({ ...current, addOns: [...(current.addOns || []), { name: '', price: '', description: '' }] }))}>Add Service</button>
                </div>
                {(listingEdit.addOns || []).length ? (
                  <div className="stack">
                    {(listingEdit.addOns || []).map((row, index) => (
                      <div key={`listing-addon-${index}`} className="surface-note" style={{ display: 'grid', gap: 10 }}>
                        <div className="form-grid-3">
                          <input placeholder="Service name" value={row.name} onChange={(event) => updateAddOn(setListingEdit, index, 'name', event.target.value)} />
                          <input placeholder="Price" type="number" min="0" step="0.01" value={row.price} onChange={(event) => updateAddOn(setListingEdit, index, 'price', event.target.value)} />
                          <button type="button" className="button-subtle" onClick={() => removeAddOn(setListingEdit, index)}>Remove</button>
                        </div>
                        <textarea rows={2} placeholder="Description" value={row.description} onChange={(event) => updateAddOn(setListingEdit, index, 'description', event.target.value)} />
                      </div>
                    ))}
                  </div>
                ) : <div className="surface-note">Optional host-specific add-ons for this vehicle only.</div>}
              </div>
              <div className="stack">
                <label className="label">Vehicle Photos</label>
                <input type="file" accept="image/*" multiple onChange={(event) => uploadListingPhotos(event.target.files)} />
                <span className="label">Upload up to 6 photos. If none are uploaded, booking will fall back to the default vehicle class image.</span>
                {listingEdit.photoUrls?.length ? (
                  <div className="metric-grid">
                    {listingEdit.photoUrls.map((photo, index) => (
                      <div key={`${index}-${photo.slice(0, 18)}`} className="surface-note" style={{ display: 'grid', gap: 8 }}>
                        <img src={photo} alt={`Vehicle photo ${index + 1}`} style={{ width: '100%', aspectRatio: '16 / 10', objectFit: 'cover', borderRadius: 14 }} />
                        <button type="button" className="button-subtle" onClick={() => setListingEdit((current) => ({ ...current, photoUrls: current.photoUrls.filter((_, idx) => idx !== index) }))}>Remove</button>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="surface-note">No host photos yet. The customer will see the vehicle class default image instead.</div>
                )}
              </div>
              <div className="inline-actions"><button type="submit">Save Listing</button></div>
            </form>
          ) : <div className="surface-note">Choose a listing to edit host-facing pricing and publishing controls.</div>}
        </section>
      </section>

      <section id="host-fleet" className="split-panel" style={{ marginTop: 18 }}>
        <section className="glass card-lg section-card">
          <div className="row-between">
            <div><div className="section-title">Availability Windows</div><p className="ui-muted">Block dates, set price overrides, or require a longer minimum stay from the host surface.</p></div>
            <select value={availabilityListingId} onChange={(event) => loadAvailability(event.target.value)} style={{ maxWidth: 280 }}>
              <option value="">Choose listing</option>
              {listings.map((row) => <option key={row.id} value={row.id}>{row.title}</option>)}
            </select>
          </div>
          {selectedAvailabilityListing && availabilitySnapshot ? (
            <div className="app-card-grid compact">
              <div className="doc-card">
                <strong>Listing</strong>
                <div className="doc-meta">{selectedAvailabilityListing.title}</div>
              </div>
              <div className="doc-card">
                <strong>Windows</strong>
                <div className="doc-meta">{availabilitySnapshot.totalWindows} total window{availabilitySnapshot.totalWindows === 1 ? '' : 's'} configured.</div>
              </div>
              <div className="doc-card">
                <strong>Blackouts</strong>
                <div className="doc-meta">{availabilitySnapshot.blockedWindows} blocked date range{availabilitySnapshot.blockedWindows === 1 ? '' : 's'}.</div>
              </div>
              <div className="doc-card">
                <strong>Overrides</strong>
                <div className="doc-meta">{availabilitySnapshot.priceOverrides} price and {availabilitySnapshot.minStayOverrides} minimum-stay override{availabilitySnapshot.minStayOverrides === 1 ? '' : 's'} live.</div>
              </div>
            </div>
          ) : null}
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
          {selectedAvailabilityListing ? (
            <div className="surface-note">
              You are editing availability for <strong>{selectedAvailabilityListing.title}</strong>. Use blocked windows for blackout dates, or leave dates open and add pricing/minimum-stay overrides for peak periods.
            </div>
          ) : null}
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
                <th>Guest Total</th>
                <th>Net Earnings</th>
                <th>Service Fee</th>
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
                    <td>{formatMoney(trip.hostServiceFee)}</td>
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
