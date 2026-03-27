'use client';

import Link from 'next/link';
import { Suspense, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { api, TOKEN_KEY, USER_KEY } from '../../lib/client';

const MAX_INLINE_PDF_BYTES = 350 * 1024;

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

async function toCompactUploadPayload(file) {
  if (!file) return '';
  if (String(file.type || '').startsWith('image/')) return compressImageFile(file);
  if (String(file.type || '').includes('pdf')) {
    if (Number(file.size || 0) > MAX_INLINE_PDF_BYTES) {
      throw new Error(`PDF "${file.name}" is too large. Please keep PDFs under ${Math.round(MAX_INLINE_PDF_BYTES / 1024)} KB.`);
    }
    return fileToDataUrl(file);
  }
  return fileToDataUrl(file);
}

const EMPTY_FORM = {
  tenantSlug: '',
  fullName: '',
  displayName: '',
  legalName: '',
  email: '',
  phone: '',
  password: '',
  vehicleTypeId: '',
  preferredLocationId: '',
  pickupSpotLabel: '',
  pickupSpotAddress1: '',
  pickupSpotAddress2: '',
  pickupSpotCity: '',
  pickupSpotState: '',
  pickupSpotPostalCode: '',
  pickupSpotCountry: 'Puerto Rico',
  pickupSpotInstructions: '',
  year: '',
  make: '',
  model: '',
  color: '',
  vin: '',
  plate: '',
  mileage: '',
  fulfillmentMode: 'PICKUP_ONLY',
  baseDailyRate: '',
  cleaningFee: '',
  pickupFee: '',
  deliveryFee: '',
  deliveryRadiusMiles: '',
  deliveryAreasText: '',
  deliveryNotes: '',
  securityDeposit: '',
  minTripDays: '1',
  maxTripDays: '',
  shortDescription: '',
  description: '',
  tripRules: '',
  photos: [],
  insuranceDocumentUrl: '',
  registrationDocumentUrl: '',
  initialInspectionDocumentUrl: '',
  initialInspectionNotes: ''
};

function deliveryEnabled(mode) {
  return String(mode || 'PICKUP_ONLY').toUpperCase() !== 'PICKUP_ONLY';
}

function deliveryToggleValue(mode) {
  return deliveryEnabled(mode) ? 'YES' : 'NO';
}

function enableDeliveryMode(mode) {
  return String(mode || '').toUpperCase() === 'DELIVERY_ONLY' ? 'DELIVERY_ONLY' : 'PICKUP_OR_DELIVERY';
}

function BecomeAHostPageInner() {
  const searchParams = useSearchParams();
  const initialTenantSlug = String(searchParams.get('tenantSlug') || '').trim().toLowerCase();
  const [bootstrap, setBootstrap] = useState({ tenants: [], tenant: null, vehicleTypes: [], locations: [] });
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [uploadingKey, setUploadingKey] = useState('');
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [createdHost, setCreatedHost] = useState(null);
  const [form, setForm] = useState({ ...EMPTY_FORM, tenantSlug: initialTenantSlug });

  const selectedTenantSlug = form.tenantSlug || initialTenantSlug;

  useEffect(() => {
    let cancelled = false;
    async function loadBootstrap() {
      try {
        setLoading(true);
        const query = selectedTenantSlug ? `?tenantSlug=${encodeURIComponent(selectedTenantSlug)}` : '';
        const payload = await api(`/api/public/booking/bootstrap${query}`);
        if (cancelled) return;
        setBootstrap(payload || { tenants: [], tenant: null, vehicleTypes: [], locations: [] });
        setForm((current) => ({
          ...current,
          tenantSlug: payload?.tenant?.slug || current.tenantSlug || '',
          vehicleTypeId: payload?.vehicleTypes?.some((row) => row.id === current.vehicleTypeId) ? current.vehicleTypeId : '',
          preferredLocationId: payload?.locations?.some((row) => row.id === current.preferredLocationId) ? current.preferredLocationId : ''
        }));
      } catch (e) {
        if (!cancelled) setError(e.message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    loadBootstrap();
    return () => {
      cancelled = true;
    };
  }, [selectedTenantSlug]);

  const availableTenants = useMemo(
    () => (bootstrap?.tenants || []).filter((row) => !!row.carSharingEnabled),
    [bootstrap]
  );

  const selectedTenant = bootstrap?.tenant || availableTenants.find((row) => row.slug === selectedTenantSlug) || null;

  const handleUpload = async (field, files, multiple = false) => {
    try {
      setUploadingKey(field);
      setError('');
      if (multiple) {
        const payloads = [];
        for (const file of Array.from(files || []).slice(0, 6)) {
          payloads.push(await toCompactUploadPayload(file));
        }
        setForm((current) => ({ ...current, [field]: payloads.filter(Boolean) }));
        return;
      }
      const file = files?.[0];
      const payload = await toCompactUploadPayload(file);
      setForm((current) => ({ ...current, [field]: payload }));
    } catch (e) {
      setError(e.message);
    } finally {
      setUploadingKey('');
    }
  };

  const submit = async (e) => {
    e.preventDefault();
    try {
      setSubmitting(true);
      setError('');
      setSuccess('');
      const payload = {
        ...form,
        tenantSlug: selectedTenantSlug,
        photosJson: JSON.stringify(form.photos || [])
      };
      const out = await api('/api/public/booking/host-signup', {
        method: 'POST',
        body: JSON.stringify(payload)
      });
      if (out?.token) localStorage.setItem(TOKEN_KEY, out.token);
      if (out?.user) localStorage.setItem(USER_KEY, JSON.stringify(out.user));
      setCreatedHost(out);
      setSuccess(out?.message || 'Host account created. Your vehicle submission is pending review.');
    } catch (e) {
      setError(e.message);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <main className="legal-shell">
      <section className="glass card-lg legal-hero">
        <span className="eyebrow">Ride Fleet Car Sharing</span>
        <h1 className="legal-title">Become a Host</h1>
        <p className="legal-lead">
          Create your host account, add your vehicle, upload the required documents,
          and submit everything for review from one public onboarding flow.
        </p>
        <div className="hero-meta">
          <span className="hero-pill">Public Host Signup</span>
          <span className="hero-pill">Vehicle Review Workflow</span>
          <span className="hero-pill">Tenant-Approved Pickup Hubs</span>
        </div>
        <div className="inline-actions">
          <Link href="/book" className="legal-link-pill">Browse Marketplace</Link>
          <Link href="/host" className="legal-link-pill">Open Host App</Link>
          <Link href="/privacy" className="legal-link-pill">Privacy Policy</Link>
        </div>
      </section>

      <section className="legal-layout">
        <aside className="glass card legal-nav">
          <div className="label">How It Works</div>
          <div className="stack" style={{ gap: 10 }}>
            <div className="surface-note">1. Choose the tenant you want to host under.</div>
            <div className="surface-note">2. Create your host account and vehicle submission.</div>
            <div className="surface-note">3. Upload photos, insurance, registration, and inspection proof.</div>
            <div className="surface-note">4. After approval, your login opens the Host App with your listing workflow.</div>
            <div className="surface-note">You can also enter your own pickup spot. Ride Fleet keeps that separate from tenant branch locations while still anchoring ops to an approved hub.</div>
          </div>
        </aside>

        <div className="legal-content">
          <section className="glass card-lg legal-section">
            <h2>Public Host Onboarding</h2>
            <p>
              This flow is modeled for marketplace-style onboarding. It creates the host login, links the host profile,
              and submits the vehicle for review before publishing it live.
            </p>
            {error ? <div className="surface-note" style={{ color: '#991b1b' }}>{error}</div> : null}
            {success ? <div className="surface-note" style={{ color: '#166534' }}>{success}</div> : null}
            {createdHost ? (
              <div className="surface-note">
                Host account ready for <strong>{createdHost?.hostProfile?.displayName}</strong>. Submission status:
                {' '}<strong>{createdHost?.submission?.status}</strong>.
                <div className="inline-actions" style={{ marginTop: 12 }}>
                  <button type="button" onClick={() => { window.location.href = '/host'; }}>Open Host App</button>
                </div>
              </div>
            ) : null}

            <form onSubmit={submit} className="stack">
              <div className="form-grid-2">
                <label>
                  <span className="label">Tenant</span>
                  <select value={form.tenantSlug} onChange={(e) => setForm((current) => ({ ...current, tenantSlug: e.target.value }))} required>
                    <option value="">Select tenant</option>
                    {availableTenants.map((tenant) => (
                      <option key={tenant.id} value={tenant.slug}>{tenant.name}</option>
                    ))}
                  </select>
                </label>
                <div className="surface-note" style={{ alignSelf: 'end' }}>
                  {loading
                    ? 'Loading host onboarding setup...'
                    : selectedTenant
                      ? `${selectedTenant.name} is ready for public host onboarding.`
                      : 'Choose the tenant where this host should publish.'}
                </div>
              </div>

              <div className="form-grid-2">
                <label>
                  <span className="label">Full Name</span>
                  <input value={form.fullName} onChange={(e) => setForm((current) => ({ ...current, fullName: e.target.value }))} required />
                </label>
                <label>
                  <span className="label">Display Name</span>
                  <input value={form.displayName} onChange={(e) => setForm((current) => ({ ...current, displayName: e.target.value }))} placeholder="How guests should see the host" required />
                </label>
                <label>
                  <span className="label">Legal Name</span>
                  <input value={form.legalName} onChange={(e) => setForm((current) => ({ ...current, legalName: e.target.value }))} />
                </label>
                <label>
                  <span className="label">Phone</span>
                  <input value={form.phone} onChange={(e) => setForm((current) => ({ ...current, phone: e.target.value }))} required />
                </label>
                <label>
                  <span className="label">Email</span>
                  <input type="email" value={form.email} onChange={(e) => setForm((current) => ({ ...current, email: e.target.value }))} required />
                </label>
                <label>
                  <span className="label">Password</span>
                  <input type="password" value={form.password} onChange={(e) => setForm((current) => ({ ...current, password: e.target.value }))} minLength={8} required />
                </label>
              </div>

              <div className="form-grid-2">
                <label>
                  <span className="label">Vehicle Type</span>
                  <select value={form.vehicleTypeId} onChange={(e) => setForm((current) => ({ ...current, vehicleTypeId: e.target.value }))} required>
                    <option value="">Select vehicle type</option>
                    {(bootstrap?.vehicleTypes || []).map((row) => (
                      <option key={row.id} value={row.id}>{row.name}</option>
                    ))}
                  </select>
                </label>
                <label>
                  <span className="label">Pickup Hub</span>
                  <select value={form.preferredLocationId} onChange={(e) => setForm((current) => ({ ...current, preferredLocationId: e.target.value }))}>
                    <option value="">Choose later</option>
                    {(bootstrap?.locations || []).map((row) => (
                      <option key={row.id} value={row.id}>
                        {[row.name, row.city, row.state].filter(Boolean).join(', ')}
                      </option>
                    ))}
                  </select>
                </label>
                <div className="surface-note" style={{ alignSelf: 'end' }}>
                  Choose a tenant hub if you want ops tied to an existing branch. If not, enter your own pickup spot below and we will anchor it for review.
                </div>
                <label>
                  <span className="label">Year</span>
                  <input type="number" value={form.year} onChange={(e) => setForm((current) => ({ ...current, year: e.target.value }))} required />
                </label>
                <label>
                  <span className="label">Make</span>
                  <input value={form.make} onChange={(e) => setForm((current) => ({ ...current, make: e.target.value }))} required />
                </label>
                <label>
                  <span className="label">Model</span>
                  <input value={form.model} onChange={(e) => setForm((current) => ({ ...current, model: e.target.value }))} required />
                </label>
                <label>
                  <span className="label">Color</span>
                  <input value={form.color} onChange={(e) => setForm((current) => ({ ...current, color: e.target.value }))} />
                </label>
                <label>
                  <span className="label">VIN</span>
                  <input value={form.vin} onChange={(e) => setForm((current) => ({ ...current, vin: e.target.value }))} />
                </label>
                <label>
                  <span className="label">Plate</span>
                  <input value={form.plate} onChange={(e) => setForm((current) => ({ ...current, plate: e.target.value }))} />
                </label>
                <label>
                  <span className="label">Mileage</span>
                  <input type="number" value={form.mileage} onChange={(e) => setForm((current) => ({ ...current, mileage: e.target.value }))} />
                </label>
                <label>
                  <span className="label">Base Daily Rate</span>
                  <input type="number" step="0.01" value={form.baseDailyRate} onChange={(e) => setForm((current) => ({ ...current, baseDailyRate: e.target.value }))} />
                </label>
                <label>
                  <span className="label">Offer Delivery</span>
                  <select
                    value={deliveryToggleValue(form.fulfillmentMode)}
                    onChange={(e) => setForm((current) => ({
                      ...current,
                      fulfillmentMode: e.target.value === 'YES' ? enableDeliveryMode(current.fulfillmentMode) : 'PICKUP_ONLY'
                    }))}
                  >
                    <option value="NO">No, pickup only</option>
                    <option value="YES">Yes, offer delivery</option>
                  </select>
                </label>
                <label>
                  <span className="label">Min Trip Days</span>
                  <input type="number" value={form.minTripDays} onChange={(e) => setForm((current) => ({ ...current, minTripDays: e.target.value }))} />
                </label>
                <label>
                  <span className="label">Max Trip Days</span>
                  <input type="number" value={form.maxTripDays} onChange={(e) => setForm((current) => ({ ...current, maxTripDays: e.target.value }))} />
                </label>
              </div>
              {deliveryEnabled(form.fulfillmentMode) ? (
                <>
                  <div className="form-grid-2">
                    <label>
                      <span className="label">Delivery Style</span>
                      <select value={form.fulfillmentMode} onChange={(e) => setForm((current) => ({ ...current, fulfillmentMode: e.target.value }))}>
                        <option value="PICKUP_OR_DELIVERY">Offer pickup and delivery</option>
                        <option value="DELIVERY_ONLY">Delivery only</option>
                      </select>
                    </label>
                  </div>
                  <div className="form-grid-2">
                    <label>
                      <span className="label">Delivery Fee</span>
                      <input type="number" step="0.01" value={form.deliveryFee} onChange={(e) => setForm((current) => ({ ...current, deliveryFee: e.target.value }))} />
                    </label>
                    <label>
                      <span className="label">Delivery Radius Miles</span>
                      <input type="number" value={form.deliveryRadiusMiles} onChange={(e) => setForm((current) => ({ ...current, deliveryRadiusMiles: e.target.value }))} />
                    </label>
                  </div>
                  <label>
                    <span className="label">Allowed Delivery Areas</span>
                    <textarea rows={3} value={form.deliveryAreasText} onChange={(e) => setForm((current) => ({ ...current, deliveryAreasText: e.target.value }))} placeholder={'One area per line, for example:\nSan Juan\nIsla Verde\nCondado'} />
                  </label>
                  <details className="surface-note">
                    <summary>Advanced delivery options</summary>
                    <div className="form-grid-2" style={{ marginTop: 12 }}>
                      <label>
                        <span className="label">Pickup Fee</span>
                        <input type="number" step="0.01" value={form.pickupFee} onChange={(e) => setForm((current) => ({ ...current, pickupFee: e.target.value }))} />
                      </label>
                      <label>
                        <span className="label">Delivery Notes</span>
                        <input value={form.deliveryNotes} onChange={(e) => setForm((current) => ({ ...current, deliveryNotes: e.target.value }))} placeholder="Airport, hotel, or neighborhood guidance" />
                      </label>
                    </div>
                  </details>
                </>
              ) : (
                <div className="surface-note">Guests will pick up the vehicle at the configured pickup spot. Delivery details stay hidden until delivery is enabled.</div>
              )}

              <div className="surface-note">
                Optional: create a host pickup spot now. This is the guest-facing handoff point for your listing and stays separate from the tenant's operational branch locations.
              </div>

              <div className="form-grid-2">
                <label>
                  <span className="label">Pickup Spot Label</span>
                  <input value={form.pickupSpotLabel} onChange={(e) => setForm((current) => ({ ...current, pickupSpotLabel: e.target.value }))} placeholder="Example: Condado Guest Pickup" />
                </label>
                <label>
                  <span className="label">Address Line 1</span>
                  <input value={form.pickupSpotAddress1} onChange={(e) => setForm((current) => ({ ...current, pickupSpotAddress1: e.target.value }))} placeholder="Street address or meeting point" />
                </label>
                <label>
                  <span className="label">Address Line 2</span>
                  <input value={form.pickupSpotAddress2} onChange={(e) => setForm((current) => ({ ...current, pickupSpotAddress2: e.target.value }))} />
                </label>
                <label>
                  <span className="label">City</span>
                  <input value={form.pickupSpotCity} onChange={(e) => setForm((current) => ({ ...current, pickupSpotCity: e.target.value }))} />
                </label>
                <label>
                  <span className="label">State</span>
                  <input value={form.pickupSpotState} onChange={(e) => setForm((current) => ({ ...current, pickupSpotState: e.target.value }))} />
                </label>
                <label>
                  <span className="label">Postal Code</span>
                  <input value={form.pickupSpotPostalCode} onChange={(e) => setForm((current) => ({ ...current, pickupSpotPostalCode: e.target.value }))} />
                </label>
                <label>
                  <span className="label">Country</span>
                  <input value={form.pickupSpotCountry} onChange={(e) => setForm((current) => ({ ...current, pickupSpotCountry: e.target.value }))} />
                </label>
                <label>
                  <span className="label">Pickup Instructions</span>
                  <input value={form.pickupSpotInstructions} onChange={(e) => setForm((current) => ({ ...current, pickupSpotInstructions: e.target.value }))} placeholder="Gate code, landmark, where to meet" />
                </label>
              </div>

              <div className="form-grid-2">
                <label>
                  <span className="label">Short Description</span>
                  <input value={form.shortDescription} onChange={(e) => setForm((current) => ({ ...current, shortDescription: e.target.value }))} placeholder="Example: Clean SUV with airport-friendly pickup" />
                </label>
                <label>
                  <span className="label">Trip Rules</span>
                  <input value={form.tripRules} onChange={(e) => setForm((current) => ({ ...current, tripRules: e.target.value }))} placeholder="No smoking, no pets, return fueled" />
                </label>
              </div>

              <label>
                <span className="label">Vehicle Description</span>
                <textarea rows={5} value={form.description} onChange={(e) => setForm((current) => ({ ...current, description: e.target.value }))} placeholder="Tell guests what makes this vehicle a good fit." />
              </label>

              <div className="form-grid-2">
                <label>
                  <span className="label">Vehicle Photos</span>
                  <input type="file" accept="image/*" multiple onChange={(e) => handleUpload('photos', e.target.files, true)} />
                  <div className="ui-muted">{uploadingKey === 'photos' ? 'Uploading photos...' : `${form.photos.length} photo(s) ready`}</div>
                </label>
                <label>
                  <span className="label">Insurance Document</span>
                  <input type="file" accept="image/*,.pdf,application/pdf" onChange={(e) => handleUpload('insuranceDocumentUrl', e.target.files)} />
                  <div className="ui-muted">{uploadingKey === 'insuranceDocumentUrl' ? 'Uploading insurance...' : form.insuranceDocumentUrl ? 'Insurance ready' : 'Required'}</div>
                </label>
                <label>
                  <span className="label">Registration Document</span>
                  <input type="file" accept="image/*,.pdf,application/pdf" onChange={(e) => handleUpload('registrationDocumentUrl', e.target.files)} />
                  <div className="ui-muted">{uploadingKey === 'registrationDocumentUrl' ? 'Uploading registration...' : form.registrationDocumentUrl ? 'Registration ready' : 'Required'}</div>
                </label>
                <label>
                  <span className="label">Initial Inspection</span>
                  <input type="file" accept="image/*,.pdf,application/pdf" onChange={(e) => handleUpload('initialInspectionDocumentUrl', e.target.files)} />
                  <div className="ui-muted">{uploadingKey === 'initialInspectionDocumentUrl' ? 'Uploading inspection...' : form.initialInspectionDocumentUrl ? 'Inspection ready' : 'Required'}</div>
                </label>
              </div>

              <label>
                <span className="label">Initial Inspection Notes</span>
                <textarea rows={4} value={form.initialInspectionNotes} onChange={(e) => setForm((current) => ({ ...current, initialInspectionNotes: e.target.value }))} placeholder="Anything the review team should know before approval." />
              </label>

              <div className="inline-actions">
                <button type="submit" disabled={submitting || loading}>
                  {submitting ? 'Creating Host Account...' : 'Create Host Account And Submit Vehicle'}
                </button>
                <Link href="/host" className="button-subtle">Already Approved? Open Host App</Link>
              </div>
            </form>
          </section>
        </div>
      </section>
    </main>
  );
}

export default function BecomeAHostPage() {
  return (
    <Suspense fallback={<main className="legal-shell"><section className="glass card-lg legal-hero"><h1 className="legal-title">Become a Host</h1><p className="legal-lead">Loading public host onboarding...</p></section></main>}>
      <BecomeAHostPageInner />
    </Suspense>
  );
}
