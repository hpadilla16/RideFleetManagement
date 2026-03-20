'use client';

import { useEffect, useMemo, useState } from 'react';
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

function BookingCard({ title, subtitle, meta, quote, cta, onClick }) {
  return (
    <article className="glass card section-card">
      <div className="stack" style={{ gap: 8 }}>
        <div className="eyebrow">{meta}</div>
        <div className="page-title">{title}</div>
        {subtitle ? <p className="ui-muted">{subtitle}</p> : null}
      </div>
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

  const selectedTenant = bootstrap?.selectedTenant || null;
  const locations = bootstrap?.locations || [];
  const vehicleTypes = bootstrap?.vehicleTypes || [];
  const featuredListings = bootstrap?.featuredCarSharingListings || [];

  const summaryCards = useMemo(() => ([
    { label: 'Tenants', value: bootstrap?.tenants?.length || 0 },
    { label: 'Locations', value: locations.length },
    { label: 'Vehicle Types', value: vehicleTypes.length },
    { label: 'Car Sharing', value: selectedTenant?.carSharingEnabled ? 'Enabled' : 'Not Yet' }
  ]), [bootstrap?.tenants?.length, locations.length, vehicleTypes.length, selectedTenant?.carSharingEnabled]);

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
                  <div key={listing.id} className="surface-note">
                    <strong>{listing.title}</strong>
                    <br />
                    {listing.vehicle?.label || 'Vehicle pending'}
                    {listing.location?.name ? ` · ${listing.location.name}` : ''}
                    <br />
                    Host: {listing.host?.displayName || 'Unassigned'} · From {fmtMoney(listing.baseDailyRate)}/day
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
                <div className="section-title">Selected Result</div>
                <p className="ui-muted">This panel is the bridge into the future booking flow for web and app.</p>
              </div>
              <button type="button" className="button-subtle" onClick={() => setSelectedResult(null)}>Clear</button>
            </div>
            <div className="surface-note">
              <strong>{searchMode === 'RENTAL' ? selectedResult.vehicleType?.name : selectedResult.title}</strong>
              <br />
              {searchMode === 'RENTAL'
                ? `Pickup ${results?.pickupLocation?.name || ''} · ${fmtMoney(selectedResult.quote?.estimatedTripTotal)} estimated total`
                : `${selectedResult.vehicle?.label || ''} · ${fmtMoney(selectedResult.quote?.total)} projected total`}
              <br />
              Next slice will convert this selected quote into a real public booking path with guest checkout and reservation/trip creation.
            </div>
          </section>
        ) : null}
      </div>
    </main>
  );
}
