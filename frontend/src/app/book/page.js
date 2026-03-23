'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { api } from '../../lib/client';

function toLocalInputValue(date) {
  const value = new Date(date);
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, '0');
  const day = String(value.getDate()).padStart(2, '0');
  const hours = String(value.getHours()).padStart(2, '0');
  const minutes = String(value.getMinutes()).padStart(2, '0');
  return `${year}-${month}-${day}T${hours}:${minutes}`;
}

function addDays(base, days) {
  const next = new Date(base);
  next.setDate(next.getDate() + days);
  return next;
}

function fmtMoney(value) {
  return `$${Number(value || 0).toFixed(2)}`;
}

function fmtRating(value, count = 0) {
  const rating = Number(value || 0);
  if (!count) return 'New host';
  return `${rating.toFixed(2)} star rating (${count})`;
}

function normalizeImageList(value) {
  const items = Array.isArray(value) ? value : value ? [value] : [];
  return items.map((item) => String(item || '').trim()).filter(Boolean).slice(0, 6);
}

function buildServiceSelectionState(result, mode) {
  return Object.fromEntries(
    (result?.additionalServices || []).map((service) => [
      service.serviceId,
      {
        selected: !!service.mandatory,
        quantity: Math.max(1, Number(service.quantity || 1) || 1)
      }
    ])
  );
}

function buildInsuranceSelectionState(result, mode) {
  if (mode !== 'RENTAL') {
    return {
      selectedPlanCode: '',
      declinedCoverage: false,
      usingOwnInsurance: false,
      liabilityAccepted: false,
      ownPolicyNumber: ''
    };
  }
  return {
    selectedPlanCode: '',
    declinedCoverage: false,
    usingOwnInsurance: false,
    liabilityAccepted: false,
    ownPolicyNumber: ''
  };
}

function BookingStageBar({ stage }) {
  const stages = [
    { key: 'search', label: 'Search' },
    { key: 'select', label: 'Select' },
    { key: 'checkout', label: 'Guest Details' },
    { key: 'confirm', label: 'Confirmation' }
  ];
  const activeIndex = stages.findIndex((item) => item.key === stage);

  return (
    <div className="metric-grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))' }}>
      {stages.map((item, index) => {
        const done = activeIndex > index;
        const active = activeIndex === index;
        const className = done ? 'status-chip good' : active ? 'status-chip' : 'status-chip neutral';
        return (
          <div key={item.key} className="surface-note" style={{ display: 'grid', gap: 8 }}>
            <span className={className} style={{ width: 'fit-content' }}>
              {done ? 'Done' : active ? 'Current' : 'Next'}
            </span>
            <strong>{item.label}</strong>
          </div>
        );
      })}
    </div>
  );
}

function BookingCard({ title, subtitle, meta, quote, cta, onClick, selected = false, hints = [], imageUrl = '', imageUrls = [], hostSummary = '', hostHref = '' }) {
  const gallery = normalizeImageList(imageUrls?.length ? imageUrls : imageUrl ? [imageUrl] : []);
  return (
    <article
      className="glass card section-card"
      style={selected ? { borderColor: 'rgba(110,73,255,.38)', boxShadow: '0 18px 42px rgba(110,73,255,.18)' } : undefined}
    >
      {gallery[0] ? (
        <div className="stack" style={{ gap: 10 }}>
          <img
            src={gallery[0]}
            alt={title}
            style={{ width: '100%', aspectRatio: '16 / 9', objectFit: 'cover', borderRadius: 18, border: '1px solid rgba(110,73,255,.15)' }}
          />
          {gallery.length > 1 ? (
            <div className="inline-actions">
              {gallery.slice(0, 4).map((photo, index) => (
                <img
                  key={`${title}-${index}`}
                  src={photo}
                  alt={`${title} ${index + 1}`}
                  style={{ width: 56, height: 40, objectFit: 'cover', borderRadius: 10, border: '1px solid rgba(110,73,255,.15)' }}
                />
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
      <div className="stack" style={{ gap: 8 }}>
        <div className="row-between" style={{ gap: 12, alignItems: 'start' }}>
          <div className="eyebrow">{meta}</div>
          {selected ? <span className="status-chip good">Selected</span> : null}
        </div>
        <div className="page-title">{title}</div>
        {subtitle ? <p className="ui-muted">{subtitle}</p> : null}
        {hostSummary ? (
          <div className="label" style={{ textTransform: 'none', letterSpacing: 0, fontSize: 13 }}>
            {hostSummary}
            {hostHref ? (
              <>
                {' · '}
                <Link href={hostHref}>View host</Link>
              </>
            ) : null}
          </div>
        ) : null}
      </div>
      {hints.length ? (
        <div className="inline-actions">
          {hints.map((hint) => (
            <span key={hint} className="status-chip neutral">{hint}</span>
          ))}
        </div>
      ) : null}
      <div className="metric-grid">
        {quote.map((item) => (
          <div key={item.label} className="metric-card">
            <span className="label">{item.label}</span>
            <strong>{item.value}</strong>
          </div>
        ))}
      </div>
      <div className="inline-actions">
        <button type="button" onClick={onClick}>{cta}</button>
      </div>
    </article>
  );
}

export default function PublicBookingPage() {
  const router = useRouter();
  const [bootstrap, setBootstrap] = useState(null);
  const [tenantSlug, setTenantSlug] = useState('');
  const [searchMode, setSearchMode] = useState('RENTAL');
  const [pickupLocationId, setPickupLocationId] = useState('');
  const [returnLocationId, setReturnLocationId] = useState('');
  const [vehicleTypeId, setVehicleTypeId] = useState('');
  const [pickupAt, setPickupAt] = useState(toLocalInputValue(addDays(new Date(), 1)));
  const [returnAt, setReturnAt] = useState(toLocalInputValue(addDays(new Date(), 4)));
  const [results, setResults] = useState(null);
  const [loadingBootstrap, setLoadingBootstrap] = useState(true);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState('');
  const [selectedResult, setSelectedResult] = useState(null);
  const [checkoutState, setCheckoutState] = useState({
    firstName: '',
    lastName: '',
    email: '',
    phone: '',
    dateOfBirth: '',
    licenseNumber: '',
    licenseState: ''
  });
  const [submitting, setSubmitting] = useState(false);
  const [lookingUp, setLookingUp] = useState(false);
  const [selectedServices, setSelectedServices] = useState({});
  const [insuranceSelection, setInsuranceSelection] = useState(buildInsuranceSelectionState(null, 'RENTAL'));
  const [lookupState, setLookupState] = useState({
    reference: '',
    email: ''
  });

  const loadBootstrap = async (slug) => {
    setLoadingBootstrap(true);
    setError('');
    try {
      const query = slug ? `?tenantSlug=${encodeURIComponent(slug)}` : '';
      const payload = await api(`/api/public/booking/bootstrap${query}`);
      setBootstrap(payload);
      const selectedSlug = payload?.selectedTenant?.slug || '';
      setTenantSlug(selectedSlug);
      const firstLocationId = payload?.locations?.[0]?.id || '';
      setPickupLocationId((current) =>
        payload?.locations?.some((item) => item.id === current) ? current : firstLocationId
      );
      setReturnLocationId((current) =>
        payload?.locations?.some((item) => item.id === current) ? current : firstLocationId
      );
      setVehicleTypeId((current) => {
        if (current && payload?.vehicleTypes?.some((item) => item.id === current)) return current;
        return '';
      });
    } catch (err) {
      setError(err.message);
    } finally {
      setLoadingBootstrap(false);
    }
  };

  useEffect(() => {
    loadBootstrap('');
  }, []);

  useEffect(() => {
    if (!selectedResult) {
      setSelectedServices({});
      setInsuranceSelection(buildInsuranceSelectionState(null, searchMode));
      return;
    }
    setSelectedServices(buildServiceSelectionState(selectedResult, searchMode));
    setInsuranceSelection(buildInsuranceSelectionState(selectedResult, searchMode));
  }, [selectedResult, searchMode]);

  const selectedTenant = bootstrap?.selectedTenant || null;
  const locations = bootstrap?.locations || [];
  const vehicleTypes = bootstrap?.vehicleTypes || [];
  const featuredListings = bootstrap?.featuredCarSharingListings || [];
  const bookingStage = selectedResult ? 'checkout' : results?.results?.length ? 'select' : 'search';

  const summaryCards = useMemo(() => ([
    { label: 'Tenants', value: bootstrap?.tenants?.length || 0 },
    { label: 'Locations', value: locations.length },
    { label: 'Vehicle Types', value: vehicleTypes.length },
    { label: 'Car Sharing', value: selectedTenant?.carSharingEnabled ? 'Enabled' : 'Not Yet' }
  ]), [bootstrap?.tenants?.length, locations.length, vehicleTypes.length, selectedTenant?.carSharingEnabled]);

  const chosenAdditionalServices = useMemo(() => {
    if (!selectedResult?.additionalServices?.length) return [];
    const bookingDays = searchMode === 'RENTAL'
      ? Number(selectedResult?.quote?.days || 1)
      : Number(selectedResult?.quote?.tripDays || 1);
    return selectedResult.additionalServices
      .filter((service) => selectedServices[service.serviceId]?.selected || service.mandatory)
      .map((service) => {
        const quantity = Math.max(1, Number(selectedServices[service.serviceId]?.quantity ?? service.quantity ?? 1) || 1);
        const total = service.pricingMode === 'PER_DAY'
          ? Number(service.rate || 0) * bookingDays * quantity
          : Number(service.rate || 0) * quantity;
        return {
          ...service,
          quantity,
          total
        };
      });
  }, [searchMode, selectedResult, selectedServices]);

  const chosenAdditionalServicesTotal = useMemo(
    () => chosenAdditionalServices.reduce((sum, service) => sum + Number(service.total || 0), 0),
    [chosenAdditionalServices]
  );

  const selectedInsurancePlan = useMemo(() => {
    if (searchMode !== 'RENTAL') return null;
    const code = String(insuranceSelection.selectedPlanCode || '').trim().toUpperCase();
    if (!code) return null;
    return (selectedResult?.insurancePlans || []).find((plan) => String(plan.code || '').trim().toUpperCase() === code) || null;
  }, [insuranceSelection.selectedPlanCode, searchMode, selectedResult]);

  const selectedInsuranceTotal = useMemo(
    () => Number(selectedInsurancePlan?.total || 0),
    [selectedInsurancePlan]
  );

  const checkoutEstimatedTotal = useMemo(() => {
    if (!selectedResult) return 0;
    const baseTotal = searchMode === 'RENTAL'
      ? Number(selectedResult?.quote?.estimatedTripTotal || 0)
      : Number(selectedResult?.quote?.total || 0);
    return baseTotal + chosenAdditionalServicesTotal + selectedInsuranceTotal;
  }, [chosenAdditionalServicesTotal, searchMode, selectedInsuranceTotal, selectedResult]);

  const runSearch = async () => {
    if (!tenantSlug) {
      setError('Select a tenant before searching.');
      return;
    }
    setSearching(true);
    setError('');
    setSelectedResult(null);
    try {
      const endpoint = searchMode === 'RENTAL'
        ? '/api/public/booking/rental-search'
        : '/api/public/booking/car-sharing-search';
      const payload = await api(endpoint, {
        method: 'POST',
        body: JSON.stringify({
          tenantSlug,
          pickupLocationId,
          returnLocationId,
          locationId: pickupLocationId,
          vehicleTypeId: vehicleTypeId || null,
          pickupAt,
          returnAt
        })
      });
      setResults(payload);
    } catch (err) {
      setResults(null);
      setError(err.message);
    } finally {
      setSearching(false);
    }
  };

  return (
    <main style={{ minHeight: '100vh', padding: '22px clamp(16px, 3vw, 34px) 42px' }}>
      <div style={{ maxWidth: 1380, margin: '0 auto', display: 'grid', gap: 18 }}>
        <section className="glass card-lg page-hero">
          <div className="hero-grid">
            <div className="hero-copy">
              <span className="eyebrow">Sprint 6 · Booking Engine Foundation</span>
              <h1 className="page-title" style={{ fontSize: 'clamp(30px, 5vw, 54px)', lineHeight: 1.02 }}>
                Reserve fleet rentals and car sharing from one public booking surface.
              </h1>
              <p>
                This is the shared quote layer we can grow into the booking website, guest app, and host app.
                Rental inventory and car sharing supply already speak the same public language here.
              </p>
              <div className="hero-meta">
                <span className="hero-pill">Public search</span>
                <span className="hero-pill">Shared pricing contract</span>
                <span className="hero-pill">Rental + Car Sharing</span>
              </div>
            </div>
            <div className="glass card section-card">
              <div className="section-title">Current Tenant Snapshot</div>
              <div className="metric-grid">
                {summaryCards.map((item) => (
                  <div key={item.label} className="metric-card">
                    <span className="label">{item.label}</span>
                    <strong>{item.value}</strong>
                  </div>
                ))}
              </div>
              {selectedTenant ? (
                <div className="surface-note">
                  <strong>{selectedTenant.name}</strong>
                  {` · ${selectedTenant.slug}`}
                  <br />
                  Public booking can now branch cleanly into booking web, guest app, host app, and employee app.
                </div>
              ) : (
                <div className="surface-note">Loading active tenant configuration...</div>
              )}
            </div>
          </div>
        </section>

        <section className="glass card-lg section-card">
          <div className="row-between">
            <div>
              <div className="section-title">Booking Journey</div>
              <p className="ui-muted">One public path for search, selection, guest details, and confirmation.</p>
            </div>
            <span className="status-chip neutral">{searchMode === 'RENTAL' ? 'Rental Flow' : 'Car Sharing Flow'}</span>
          </div>
          <BookingStageBar stage={bookingStage} />
        </section>

        <section className="split-panel">
          <div className="glass card-lg section-card">
            <div className="row-between">
              <div>
                <div className="section-title">Booking Search</div>
                <p className="ui-muted">Choose a tenant, set dates, and search either traditional rental inventory or car sharing supply.</p>
              </div>
              <div className="inline-actions">
                <button
                  type="button"
                  className={searchMode === 'RENTAL' ? '' : 'button-subtle'}
                  onClick={() => setSearchMode('RENTAL')}
                >
                  Rental
                </button>
                <button
                  type="button"
                  className={searchMode === 'CAR_SHARING' ? '' : 'button-subtle'}
                  onClick={() => setSearchMode('CAR_SHARING')}
                >
                  Car Sharing
                </button>
              </div>
            </div>

            <div className="form-grid-3">
              <div>
                <div className="label">Tenant</div>
                <select
                  value={tenantSlug}
                  onChange={async (event) => {
                    const nextSlug = event.target.value;
                    setResults(null);
                    setSelectedResult(null);
                    await loadBootstrap(nextSlug);
                  }}
                >
                  {(bootstrap?.tenants || []).map((tenant) => (
                    <option key={tenant.id} value={tenant.slug}>{tenant.name}</option>
                  ))}
                </select>
              </div>
              <div>
                <div className="label">Pickup</div>
                <input type="datetime-local" value={pickupAt} onChange={(event) => setPickupAt(event.target.value)} />
              </div>
              <div>
                <div className="label">Return</div>
                <input type="datetime-local" value={returnAt} onChange={(event) => setReturnAt(event.target.value)} />
              </div>
            </div>

            <div className={searchMode === 'RENTAL' ? 'form-grid-3' : 'form-grid-2'}>
              <div>
                <div className="label">{searchMode === 'RENTAL' ? 'Pickup Location' : 'Preferred Location'}</div>
                <select value={pickupLocationId} onChange={(event) => setPickupLocationId(event.target.value)}>
                  {locations.map((location) => (
                    <option key={location.id} value={location.id}>{location.name}</option>
                  ))}
                </select>
              </div>
              {searchMode === 'RENTAL' ? (
                <>
                  <div>
                    <div className="label">Return Location</div>
                    <select value={returnLocationId} onChange={(event) => setReturnLocationId(event.target.value)}>
                      {locations.map((location) => (
                        <option key={location.id} value={location.id}>{location.name}</option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <div className="label">Vehicle Type</div>
                    <select value={vehicleTypeId} onChange={(event) => setVehicleTypeId(event.target.value)}>
                      <option value="">All eligible classes</option>
                      {vehicleTypes.map((vehicleType) => (
                        <option key={vehicleType.id} value={vehicleType.id}>{vehicleType.name}</option>
                      ))}
                    </select>
                  </div>
                </>
              ) : null}
            </div>

            <div className="inline-actions">
              <button type="button" onClick={runSearch} disabled={loadingBootstrap || searching}>
                {searching ? 'Searching...' : `Search ${searchMode === 'RENTAL' ? 'Rental Quotes' : 'Car Sharing Listings'}`}
              </button>
            </div>

            {error ? <div className="surface-note" style={{ color: '#991b1b' }}>{error}</div> : null}
          </div>

          <div className="glass card-lg section-card">
            <div className="row-between">
              <div>
                <div className="section-title">Discovery Feed</div>
                <p className="ui-muted">Featured public supply and readiness hints for the selected tenant.</p>
              </div>
              {selectedTenant?.carSharingEnabled ? <span className="status-chip good">Car Sharing Live</span> : <span className="status-chip warn">Rental Only</span>}
            </div>
            {featuredListings.length ? (
              <div className="stack">
                {featuredListings.map((listing) => (
                  <div key={listing.id} className="surface-note" style={{ display: 'grid', gap: 10 }}>
                    {listing.primaryImageUrl ? (
                      <img src={listing.primaryImageUrl} alt={listing.title} style={{ width: '100%', aspectRatio: '16 / 9', objectFit: 'cover', borderRadius: 16, border: '1px solid rgba(110,73,255,.15)' }} />
                    ) : null}
                    <strong>{listing.title}</strong>
                    <br />
                    {listing.vehicle?.label || 'Vehicle pending'}
                    {listing.location?.name ? ` · ${listing.location.name}` : ''}
                    <br />
                    Host: {listing.host?.displayName || 'Unassigned'} · {fmtRating(listing.host?.averageRating, listing.host?.reviewCount)} · From {fmtMoney(listing.baseDailyRate)}/day
                  </div>
                ))}
              </div>
            ) : (
              <div className="surface-note">
                No featured public car sharing listings yet. This tenant can still search rental inventory if online rates are configured.
              </div>
            )}
          </div>
        </section>

        <section className="glass card-lg section-card">
          <div className="row-between">
            <div>
              <div className="section-title">Find Existing Booking</div>
              <p className="ui-muted">Guests can resume a rental reservation or car sharing trip with their reference and email, even if they changed devices.</p>
            </div>
            <span className="status-chip neutral">Resume Flow</span>
          </div>
          <div className="form-grid-2">
            <div>
              <div className="label">Reference</div>
              <input
                value={lookupState.reference}
                onChange={(event) => setLookupState((current) => ({ ...current, reference: event.target.value }))}
                placeholder="Reservation number or trip code"
              />
            </div>
            <div>
              <div className="label">Email</div>
              <input
                type="email"
                value={lookupState.email}
                onChange={(event) => setLookupState((current) => ({ ...current, email: event.target.value }))}
                placeholder="guest@email.com"
              />
            </div>
          </div>
          <div className="inline-actions">
            <button
              type="button"
              disabled={lookingUp}
              onClick={async () => {
                setLookingUp(true);
                setError('');
                try {
                  const payload = await api('/api/public/booking/lookup', {
                    method: 'POST',
                    body: JSON.stringify({
                      tenantSlug,
                      reference: lookupState.reference,
                      email: lookupState.email
                    })
                  });
                  if (typeof window !== 'undefined') {
                    sessionStorage.setItem('fleet_public_booking_confirmation', JSON.stringify(payload));
                  }
                  router.push('/book/confirmation');
                } catch (err) {
                  setError(err.message);
                } finally {
                  setLookingUp(false);
                }
              }}
            >
              {lookingUp ? 'Finding Booking...' : 'Find My Booking'}
            </button>
          </div>
        </section>

        <section className="glass card-lg section-card">
          <div className="row-between">
            <div>
              <div className="section-title">Search Results</div>
              <p className="ui-muted">
                {results
                  ? `${results.results?.length || 0} ${searchMode === 'RENTAL' ? 'rental quote option(s)' : 'listing option(s)'} returned`
                  : 'Run a search to load public inventory and pricing.'}
              </p>
            </div>
            {results?.tenant ? <span className="status-chip neutral">{results.tenant.name}</span> : null}
          </div>

          {results?.results?.length ? (
            <div className="grid2" style={{ marginBottom: 0 }}>
              {searchMode === 'RENTAL'
                ? results.results.map((result) => (
                    <BookingCard
                      key={result.vehicleType.id}
                      title={result.vehicleType.name}
                      subtitle={result.sampleVehicleLabel || result.vehicleType.description || 'Public rental quote available'}
                      meta={result.soldOut ? 'Waitlist / sold out' : `${result.availabilityCount} unit(s) available`}
                      selected={selectedResult?.vehicleType?.id === result.vehicleType.id}
                      imageUrl={result.primaryImageUrl}
                      imageUrls={result.imageUrls}
                      hints={[
                        ...(result.additionalServices?.length ? [`${result.additionalServices.length} add-on${result.additionalServices.length === 1 ? '' : 's'} online`] : []),
                        ...(result.insurancePlans?.length ? [`${result.insurancePlans.length} insurance option${result.insurancePlans.length === 1 ? '' : 's'}`] : [])
                      ]}
                      quote={[
                        { label: 'Daily Rate', value: fmtMoney(result.quote.dailyRate) },
                        { label: 'Trip Total', value: fmtMoney(result.quote.estimatedTripTotal) },
                        { label: 'Deposit Due', value: fmtMoney(result.quote.depositAmountDue) },
                        { label: 'Security Deposit', value: fmtMoney(result.quote.securityDepositAmount) }
                      ]}
                      cta={result.soldOut ? 'Notify Me Later' : 'Start Rental Booking'}
                      onClick={() => setSelectedResult(result)}
                    />
                  ))
                : results.results.map((result) => (
                    <BookingCard
                      key={result.id}
                      title={result.title}
                      subtitle={`${result.vehicle?.label || 'Vehicle'}${result.location?.name ? ` · ${result.location.name}` : ''}`}
                      meta={result.instantBook ? 'Instant book ready' : `Hosted by ${result.host?.displayName || 'Host'}`}
                      selected={selectedResult?.id === result.id}
                      imageUrl={result.primaryImageUrl}
                      imageUrls={result.imageUrls}
                      hostSummary={result.host ? `${result.host.displayName} · ${fmtRating(result.host.averageRating, result.host.reviewCount)}` : ''}
                      hostHref={result.host?.id ? `/host-profile/${result.host.id}` : ''}
                      hints={[
                        result.instantBook ? 'Instant book' : 'Approval flow',
                        `${Math.max(1, Number(result.minTripDays || 1))}+ day minimum`,
                        ...(result.additionalServices?.length ? [`${result.additionalServices.length} host add-on${result.additionalServices.length === 1 ? '' : 's'}`] : [])
                      ]}
                      quote={[
                        { label: 'Daily Rate', value: fmtMoney(result.quote.subtotal / Math.max(1, result.quote.tripDays)) },
                        { label: 'Trip Total', value: fmtMoney(result.quote.total) },
                        { label: 'Host Earnings', value: fmtMoney(result.quote.hostEarnings) },
                        { label: 'Platform Fee', value: fmtMoney(result.quote.platformFee) }
                      ]}
                      cta={result.instantBook ? 'Continue to Guest Flow' : 'Request Booking'}
                      onClick={() => setSelectedResult(result)}
                    />
                  ))}
            </div>
          ) : (
            <div className="surface-note">
              {results
                ? 'No options matched those dates yet. Try another date range, location, or tenant.'
                : 'Search results will appear here with a shared quote contract for both rental and car sharing.'}
            </div>
          )}
        </section>

        {selectedResult ? (
          <section className="glass card-lg section-card">
            <div className="row-between">
              <div>
                <div className="section-title">Checkout Foundation</div>
                <p className="ui-muted">Turn the selected quote into a live reservation or trip and immediately kick off customer info collection.</p>
              </div>
              <button type="button" className="button-subtle" onClick={() => setSelectedResult(null)}>Clear</button>
            </div>
            <div className="split-panel">
              <div className="surface-note">
                {normalizeImageList(selectedResult.imageUrls?.length ? selectedResult.imageUrls : selectedResult.primaryImageUrl ? [selectedResult.primaryImageUrl] : [])[0] ? (
                  <div className="stack" style={{ gap: 10, marginBottom: 12 }}>
                    <img
                      src={normalizeImageList(selectedResult.imageUrls?.length ? selectedResult.imageUrls : [selectedResult.primaryImageUrl])[0]}
                      alt={searchMode === 'RENTAL' ? selectedResult.vehicleType?.name : selectedResult.title}
                      style={{ width: '100%', maxWidth: 520, aspectRatio: '16 / 9', objectFit: 'cover', borderRadius: 18, border: '1px solid rgba(110,73,255,.15)' }}
                    />
                    {normalizeImageList(selectedResult.imageUrls?.length ? selectedResult.imageUrls : [selectedResult.primaryImageUrl]).length > 1 ? (
                      <div className="inline-actions">
                        {normalizeImageList(selectedResult.imageUrls).map((photo, index) => (
                          <img
                            key={`selected-${index}`}
                            src={photo}
                            alt={`Selected option ${index + 1}`}
                            style={{ width: 72, height: 52, objectFit: 'cover', borderRadius: 12, border: '1px solid rgba(110,73,255,.15)' }}
                          />
                        ))}
                      </div>
                    ) : null}
                  </div>
                ) : null}
                <strong>{searchMode === 'RENTAL' ? selectedResult.vehicleType?.name : selectedResult.title}</strong>
                <br />
                {searchMode === 'RENTAL'
                  ? `Pickup ${results?.pickupLocation?.name || ''} · ${fmtMoney(checkoutEstimatedTotal)} estimated total`
                  : `${selectedResult.vehicle?.label || ''} · ${fmtMoney(selectedResult.quote?.total)} projected total`}
                <br />
                {searchMode === 'CAR_SHARING' && selectedResult.host ? (
                  <>
                    {`Host ${selectedResult.host.displayName} · ${fmtRating(selectedResult.host.averageRating, selectedResult.host.reviewCount)}`}
                    {selectedResult.host.id ? (
                      <>
                        {' · '}
                        <Link href={`/host-profile/${selectedResult.host.id}`}>View profile</Link>
                      </>
                    ) : null}
                    <br />
                  </>
                ) : null}
                {searchMode === 'RENTAL'
                  ? `Deposit due now: ${fmtMoney(selectedResult.quote?.depositAmountDue)}${chosenAdditionalServicesTotal ? ` · Add-ons ${fmtMoney(chosenAdditionalServicesTotal)}` : ''}${selectedInsuranceTotal ? ` · Insurance ${fmtMoney(selectedInsuranceTotal)}` : ''}`
                  : `Host earns ${fmtMoney(selectedResult.quote?.hostEarnings)} · Platform fee ${fmtMoney(selectedResult.quote?.platformFee)}`}
              </div>

              <div className="section-card">
                <div className="surface-note" style={{ marginBottom: 6 }}>
                  <strong>Checkout Snapshot</strong>
                  <br />
                  {searchMode === 'RENTAL'
                    ? `Base total ${fmtMoney(selectedResult?.quote?.estimatedTripTotal)} · Estimated total ${fmtMoney(checkoutEstimatedTotal)}`
                    : `Trip total ${fmtMoney(selectedResult?.quote?.total)} · Guest flow will continue through pre-check-in, signature, and payment.`}
                </div>
                <div className="section-title">Guest Details</div>
                {searchMode === 'RENTAL' ? (
                  <div className="stack" style={{ marginBottom: 18 }}>
                    <div>
                      <div className="section-title" style={{ fontSize: 16 }}>Insurance</div>
                      <p className="ui-muted">Choose one of our protection plans or certify that you will use your own insurance and accept responsibility and liability.</p>
                    </div>
                    {selectedResult?.insurancePlans?.length ? (
                      <div className="stack">
                        <div className="form-grid-2">
                          <div>
                            <div className="label">Our Insurance Plan</div>
                            <select
                              value={insuranceSelection.selectedPlanCode}
                              onChange={(event) => {
                                const code = event.target.value;
                                setInsuranceSelection((current) => ({
                                  ...current,
                                  selectedPlanCode: code,
                                  declinedCoverage: false,
                                  usingOwnInsurance: false,
                                  liabilityAccepted: false
                                }));
                              }}
                            >
                              <option value="">Select a protection plan</option>
                              {selectedResult.insurancePlans.map((plan) => (
                                <option key={plan.code} value={plan.code}>
                                  {plan.name} ({plan.chargeBy === 'PER_DAY' ? `${fmtMoney(plan.amount)}/day` : plan.chargeBy === 'PERCENTAGE' ? `${plan.amount}%` : fmtMoney(plan.amount)})
                                </option>
                              ))}
                            </select>
                          </div>
                          <div>
                            <div className="label">Insurance Total</div>
                            <input value={selectedInsurancePlan ? fmtMoney(selectedInsurancePlan.total) : '$0.00'} disabled />
                          </div>
                        </div>
                        {selectedInsurancePlan?.description ? (
                          <div className="surface-note">{selectedInsurancePlan.description}</div>
                        ) : null}
                      </div>
                    ) : (
                      <div className="surface-note">
                        No house insurance plans are currently configured for this rental. The customer must proceed using their own insurance.
                      </div>
                    )}

                    <div className="surface-note" style={{ display: 'grid', gap: 10 }}>
                      <strong>Decline Our Insurance</strong>
                      <label style={{ display: 'inline-flex', gap: 8, alignItems: 'center' }}>
                        <input
                          type="checkbox"
                          checked={insuranceSelection.declinedCoverage}
                          onChange={(event) => {
                            const checked = event.target.checked;
                            setInsuranceSelection((current) => ({
                              ...current,
                              selectedPlanCode: checked ? '' : current.selectedPlanCode,
                              declinedCoverage: checked
                            }));
                          }}
                        />
                        <span>I decline the company insurance offered for this rental.</span>
                      </label>
                      <label style={{ display: 'inline-flex', gap: 8, alignItems: 'center' }}>
                        <input
                          type="checkbox"
                          checked={insuranceSelection.usingOwnInsurance}
                          onChange={(event) => setInsuranceSelection((current) => ({ ...current, usingOwnInsurance: event.target.checked }))}
                          disabled={!insuranceSelection.declinedCoverage}
                        />
                        <span>I confirm I will use my own insurance coverage for this rental.</span>
                      </label>
                      <label style={{ display: 'inline-flex', gap: 8, alignItems: 'center' }}>
                        <input
                          type="checkbox"
                          checked={insuranceSelection.liabilityAccepted}
                          onChange={(event) => setInsuranceSelection((current) => ({ ...current, liabilityAccepted: event.target.checked }))}
                          disabled={!insuranceSelection.declinedCoverage}
                        />
                        <span>I accept responsibility and liability if I decline your insurance coverage.</span>
                      </label>
                      <div>
                        <div className="label">Own Insurance Policy Number</div>
                        <input
                          value={insuranceSelection.ownPolicyNumber}
                          onChange={(event) => setInsuranceSelection((current) => ({ ...current, ownPolicyNumber: event.target.value }))}
                          placeholder="Optional but recommended if using your own policy"
                          disabled={!insuranceSelection.declinedCoverage}
                        />
                      </div>
                    </div>
                  </div>
                ) : null}
                {selectedResult?.additionalServices?.length ? (
                  <div className="stack" style={{ marginBottom: 18 }}>
                    <div>
                      <div className="section-title" style={{ fontSize: 16 }}>{searchMode === 'RENTAL' ? 'Additional Services' : 'Vehicle Add-Ons'}</div>
                      <p className="ui-muted">{searchMode === 'RENTAL' ? 'Add optional extras before the customer creates the reservation.' : 'Choose host-provided extras for this specific vehicle before creating the trip request.'}</p>
                    </div>
                    <div className="stack">
                      {selectedResult.additionalServices.map((service) => {
                        const serviceState = selectedServices[service.serviceId] || {
                          selected: !!service.mandatory,
                          quantity: Math.max(1, Number(service.quantity || 1) || 1)
                        };
                        const serviceTotal = service.pricingMode === 'PER_DAY'
                          ? Number(service.rate || 0) * Number(searchMode === 'RENTAL' ? selectedResult?.quote?.days || 1 : selectedResult?.quote?.tripDays || 1) * Number(serviceState.quantity || 1)
                          : Number(service.rate || 0) * Number(serviceState.quantity || 1);
                        return (
                          <div key={service.serviceId} className="surface-note" style={{ display: 'grid', gap: 12 }}>
                            <div className="row-between" style={{ alignItems: 'start', gap: 12 }}>
                              <div className="stack" style={{ gap: 4 }}>
                                <strong>{service.name}</strong>
                                {service.description ? <span className="ui-muted">{service.description}</span> : null}
                                <span className="eyebrow">
                                  {service.pricingMode === 'PER_DAY'
                                    ? `${fmtMoney(service.rate)} / ${service.unitLabel.toLowerCase()} / day`
                                    : `${fmtMoney(service.rate)} / ${service.unitLabel.toLowerCase()}`}
                                  {service.taxable ? ' · Taxable' : ''}
                                  {service.mandatory ? ' · Required' : ''}
                                </span>
                              </div>
                              <label style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                                <input
                                  type="checkbox"
                                  checked={!!serviceState.selected || !!service.mandatory}
                                  disabled={!!service.mandatory}
                                  onChange={(event) => {
                                    const checked = event.target.checked;
                                    setSelectedServices((current) => ({
                                      ...current,
                                      [service.serviceId]: {
                                        selected: checked,
                                        quantity: Math.max(1, Number(current[service.serviceId]?.quantity ?? service.quantity ?? 1) || 1)
                                      }
                                    }));
                                  }}
                                />
                                <span>{service.mandatory ? 'Included' : 'Add service'}</span>
                              </label>
                            </div>
                            <div className="form-grid-3">
                              <div>
                                <div className="label">Quantity</div>
                                <input
                                  type="number"
                                  min="1"
                                  value={serviceState.quantity}
                                  disabled={!serviceState.selected && !service.mandatory}
                                  onChange={(event) => {
                                    const quantity = Math.max(1, Number(event.target.value || 1) || 1);
                                    setSelectedServices((current) => ({
                                      ...current,
                                      [service.serviceId]: {
                                        selected: current[service.serviceId]?.selected ?? !!service.mandatory,
                                        quantity
                                      }
                                    }));
                                  }}
                                />
                              </div>
                              <div>
                                <div className="label">Billing</div>
                                <input
                                  value={service.pricingMode === 'PER_DAY' ? `Per day x ${searchMode === 'RENTAL' ? selectedResult?.quote?.days || 1 : selectedResult?.quote?.tripDays || 1} day(s)` : 'Flat'}
                                  disabled
                                />
                              </div>
                              <div>
                                <div className="label">Service Total</div>
                                <input value={fmtMoney(serviceTotal)} disabled />
                              </div>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                ) : null}
                {!selectedResult?.additionalServices?.length ? (
                  <div className="surface-note" style={{ marginBottom: 18 }}>
                    {searchMode === 'RENTAL'
                      ? 'No online additional services are configured for this rental yet. In Settings > Additional Services, make sure the service is active, matches this location/vehicle type, and has Display Online enabled.'
                      : 'No host add-ons are configured for this vehicle yet.'}
                  </div>
                ) : null}

                <div className="form-grid-2">
                  <div>
                    <div className="label">First Name</div>
                    <input value={checkoutState.firstName} onChange={(event) => setCheckoutState((current) => ({ ...current, firstName: event.target.value }))} />
                  </div>
                  <div>
                    <div className="label">Last Name</div>
                    <input value={checkoutState.lastName} onChange={(event) => setCheckoutState((current) => ({ ...current, lastName: event.target.value }))} />
                  </div>
                </div>
                <div className="form-grid-2">
                  <div>
                    <div className="label">Email</div>
                    <input type="email" value={checkoutState.email} onChange={(event) => setCheckoutState((current) => ({ ...current, email: event.target.value }))} />
                  </div>
                  <div>
                    <div className="label">Phone</div>
                    <input value={checkoutState.phone} onChange={(event) => setCheckoutState((current) => ({ ...current, phone: event.target.value }))} />
                  </div>
                </div>
                <div className="form-grid-3">
                  <div>
                    <div className="label">Date of Birth</div>
                    <input type="date" value={checkoutState.dateOfBirth} onChange={(event) => setCheckoutState((current) => ({ ...current, dateOfBirth: event.target.value }))} />
                  </div>
                  <div>
                    <div className="label">License Number</div>
                    <input value={checkoutState.licenseNumber} onChange={(event) => setCheckoutState((current) => ({ ...current, licenseNumber: event.target.value }))} />
                  </div>
                  <div>
                    <div className="label">License State</div>
                    <input value={checkoutState.licenseState} onChange={(event) => setCheckoutState((current) => ({ ...current, licenseState: event.target.value }))} />
                  </div>
                </div>
                <div className="inline-actions">
                  <button
                    type="button"
                    disabled={submitting}
                    onClick={async () => {
                      if (searchMode === 'RENTAL' && !selectedInsurancePlan) {
                        if (!(insuranceSelection.declinedCoverage && insuranceSelection.usingOwnInsurance && insuranceSelection.liabilityAccepted)) {
                          setError('Choose one of our insurance plans or certify that you are declining it, using your own insurance, and accepting responsibility and liability.');
                          return;
                        }
                      }
                      setSubmitting(true);
                      setError('');
                      try {
                        const payload = await api('/api/public/booking/checkout', {
                          method: 'POST',
                          body: JSON.stringify({
                            tenantSlug,
                            searchType: searchMode,
                            pickupAt,
                            returnAt,
                            pickupLocationId,
                            returnLocationId,
                            vehicleTypeId: searchMode === 'RENTAL' ? selectedResult?.vehicleType?.id : null,
                            listingId: searchMode === 'CAR_SHARING' ? selectedResult?.id : null,
                            additionalServices: chosenAdditionalServices.map((service) => ({
                              serviceId: service.serviceId,
                              quantity: service.quantity
                            })),
                            insuranceSelection: searchMode === 'RENTAL'
                              ? {
                                  selectedPlanCode: selectedInsurancePlan?.code || '',
                                  declinedCoverage: !!insuranceSelection.declinedCoverage,
                                  usingOwnInsurance: !!insuranceSelection.usingOwnInsurance,
                                  liabilityAccepted: !!insuranceSelection.liabilityAccepted,
                                  ownPolicyNumber: insuranceSelection.ownPolicyNumber || ''
                                }
                              : null,
                            customer: checkoutState
                          })
                        });
                        if (typeof window !== 'undefined') {
                          sessionStorage.setItem('fleet_public_booking_confirmation', JSON.stringify(payload));
                        }
                        router.push('/book/confirmation');
                      } catch (err) {
                        setError(err.message);
                      } finally {
                        setSubmitting(false);
                      }
                    }}
                  >
                    {submitting ? 'Creating Booking...' : `Create ${searchMode === 'RENTAL' ? 'Reservation' : 'Trip'} Request`}
                  </button>
                </div>
                {searchMode === 'RENTAL' ? (
                  <div className="surface-note">
                    Base trip total {fmtMoney(selectedResult?.quote?.estimatedTripTotal)}.
                    {chosenAdditionalServicesTotal || selectedInsuranceTotal
                      ? ` With extras and insurance: ${fmtMoney(checkoutEstimatedTotal)}.`
                      : ' Additional services and insurance will be reflected here before checkout.'}
                  </div>
                ) : null}
              </div>
            </div>
          </section>
        ) : null}
      </div>
    </main>
  );
}
