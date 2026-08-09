/**
 * New Reservation UI v2 (beta.136).
 *
 * 4-step wizard with a sticky live-summary pane, replacing the cramped single
 * modal on /reservations. Reuses the existing backend exactly:
 *   GET  /api/locations, /api/vehicle-types
 *   GET  /api/customers?q=         POST /api/customers
 *   GET  /api/reservations/resolve-rate   (live quote)
 *   GET  /api/market/summary?airport=<code>  (vehicle-class market context)
 *   POST /api/reservations         (same payload as the legacy form)
 *
 * No new backend. Nothing here changes money logic — it just gathers the same
 * inputs and posts the same body. Mockup: doc/mockup-new-reservation-v2.
 */
'use client';

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { AuthGate } from '../../../components/AuthGate';
import { AppShell } from '../../../components/AppShell';
import { api } from '../../../lib/client';
import { toCompactUploadPayload } from '../../../lib/upload-compress';
import { missingRequiredCustomerFields, CUSTOMER_FIELD_LABELS } from '../../../lib/precheckin-fields';

// LAX #6 (2026-07-28): the inline-create form carries the SAME field set as
// the pre-check-in form (all mandatory except insurance, DL photo included).
const EMPTY_NEW_CUSTOMER = {
  firstName: '', lastName: '', email: '', phone: '',
  dateOfBirth: '', licenseNumber: '', licenseState: '',
  address1: '', address2: '', city: '', state: '', zip: '', country: 'US',
  idPhotoUrl: '', licenseBackUrl: '',
  insurancePolicyNumber: '', insuranceExpiry: ''
};

const SIPP_LABELS = {
  ECAR: 'Economy', CCAR: 'Compact', ICAR: 'Mid-size', SCAR: 'Standard',
  FCAR: 'Fullsize', PCAR: 'Premium', LCAR: 'Luxury', CFAR: 'Compact SUV',
  IFAR: 'Mid-size SUV', SFAR: 'Standard SUV', FFAR: 'Fullsize SUV',
  PFAR: 'Premium SUV', LFAR: 'Luxury SUV', RFAR: 'Recreational',
  XFAR: 'Open-Air All-Terrain', FJAR: 'SUV', FVAR: 'Passenger Van',
  MVAR: 'Minivan', SPAR: 'Special', STAR: 'Sports/Convertible', PUAR: 'Pickup'
};

const money = (n) => `$${Number(n || 0).toFixed(2)}`;

export default function NewReservationV2Page() {
  return <AuthGate>{({ token, me, logout }) => <Wizard token={token} me={me} logout={logout} />}</AuthGate>;
}

function Wizard({ token, me, logout }) {
  const router = useRouter();
  const [step, setStep] = useState(1);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');

  const [locations, setLocations] = useState([]);
  const [vehicleTypes, setVehicleTypes] = useState([]);
  const [marketBySipp, setMarketBySipp] = useState({});

  // Form state
  const [form, setForm] = useState({
    pickupAt: '', returnAt: '', pickupLocationId: '', returnLocationId: '',
    vehicleTypeId: '', customerId: '', reservationNumber: '', notes: '', bookingChannel: 'STAFF'
  });
  const [quote, setQuote] = useState(null);
  const [rateError, setRateError] = useState('');

  // Customer step
  const [custQuery, setCustQuery] = useState('');
  const [custResults, setCustResults] = useState([]);
  const [selectedCustomer, setSelectedCustomer] = useState(null);
  const [newCust, setNewCust] = useState(null); // inline-create form when non-null

  useEffect(() => {
    if (!token) return;
    Promise.all([
      api('/api/locations', {}, token).catch(() => []),
      api('/api/vehicle-types', {}, token).catch(() => [])
    ]).then(([locs, vts]) => {
      setLocations(Array.isArray(locs) ? locs : []);
      setVehicleTypes(Array.isArray(vts) ? vts : []);
    });
  }, [token]);

  const set = (patch) => setForm((f) => ({ ...f, ...patch }));

  const [rentalMin, setRentalMin] = useState({ minimumHours: 24, hourly: false });

  const rentalDays = useMemo(() => {
    if (!form.pickupAt || !form.returnAt) return 0;
    const ms = new Date(form.returnAt) - new Date(form.pickupAt);
    if (!Number.isFinite(ms) || ms <= 0) return 0;
    return Math.max(1, Math.ceil(ms / (1000 * 60 * 60 * 24)));
  }, [form.pickupAt, form.returnAt]);

  const pickupLocation = useMemo(() => locations.find((l) => l.id === form.pickupLocationId) || null, [locations, form.pickupLocationId]);

  // Live quote whenever vehicle type + locations + dates are set.
  useEffect(() => {
    const ready = form.vehicleTypeId && form.pickupLocationId && form.pickupAt && form.returnAt && rentalDays > 0;
    if (!ready) { setQuote(null); setRateError(''); return undefined; }
    let cancelled = false;
    (async () => {
      try {
        const q = new URLSearchParams({ vehicleTypeId: form.vehicleTypeId, pickupLocationId: form.pickupLocationId, pickupAt: form.pickupAt, returnAt: form.returnAt });
        const out = await api(`/api/reservations/resolve-rate?${q.toString()}`, {}, token);
        if (cancelled) return;
        setRateError(''); setQuote(out);
      } catch {
        if (cancelled) return;
        setQuote(null); setRateError('No rate tables found for this vehicle type, location and dates.');
      }
    })();
    return () => { cancelled = true; };
  }, [form.vehicleTypeId, form.pickupLocationId, form.pickupAt, form.returnAt, rentalDays, token]);

  // How short a rental may be here. 24 hours unless an hourly rate is
  // configured (Hector, 2026-08-09). Asked of the backend rather than assumed,
  // because the old rule was a hardcoded pickup+1day `min` that the API never
  // shared: a desktop agent could type past it while an iPhone's picker
  // clamped hard, which is how an International agent could not save at all.
  useEffect(() => {
    if (!form.pickupLocationId) { setRentalMin({ minimumHours: 24, hourly: false }); return undefined; }
    let cancelled = false;
    const q = new URLSearchParams({ pickupLocationId: form.pickupLocationId });
    if (form.vehicleTypeId) q.set('vehicleTypeId', form.vehicleTypeId);
    if (form.pickupAt) q.set('pickupAt', form.pickupAt);
    api(`/api/rates/rental-minimum?${q.toString()}`, {}, token)
      .then((r) => { if (!cancelled && r) setRentalMin({ minimumHours: Number(r.minimumHours || 24), hourly: !!r.hourly }); })
      .catch(() => { if (!cancelled) setRentalMin({ minimumHours: 24, hourly: false }); });
    return () => { cancelled = true; };
  }, [form.pickupLocationId, form.vehicleTypeId, form.pickupAt, token]);

  // Market context for the vehicle-class cards, keyed by the pickup airport code.
  useEffect(() => {
    const code = pickupLocation?.code;
    if (!code) { setMarketBySipp({}); return; }
    api(`/api/market/summary?airport=${encodeURIComponent(code)}`, {}, token)
      .then((s) => {
        const map = {};
        for (const row of (s?.sipps || [])) map[String(row.sipp || '').toUpperCase()] = row;
        setMarketBySipp(map);
      })
      .catch(() => setMarketBySipp({}));
  }, [pickupLocation?.code, token]);

  const searchCustomers = async (q) => {
    setCustQuery(q);
    if (!q || q.trim().length < 2) { setCustResults([]); return; }
    try {
      const out = await api(`/api/customers?q=${encodeURIComponent(q.trim())}&limit=20`, {}, token);
      setCustResults(Array.isArray(out) ? out : (out?.rows || []));
    } catch { setCustResults([]); }
  };

  const chooseCustomer = (c) => { setSelectedCustomer(c); set({ customerId: c.id }); setNewCust(null); };

  const createCustomer = async () => {
    setBusy(true); setErr('');
    try {
      const created = await api('/api/customers', { method: 'POST', body: JSON.stringify(newCust) }, token);
      chooseCustomer(created);
      setMsg(`Customer ${created.firstName || ''} ${created.lastName || ''} created.`);
    } catch (e) { setErr(e?.message || 'Failed to create customer'); } finally { setBusy(false); }
  };

  const handleNewCustUpload = async (key, file) => {
    if (!file) return;
    try {
      const payload = await toCompactUploadPayload(file);
      setNewCust((prev) => ({ ...prev, [key]: payload }));
    } catch (e) { setErr(e?.message || 'Upload failed'); }
  };

  const newCustMissing = useMemo(
    () => (newCust ? missingRequiredCustomerFields(newCust) : []),
    [newCust]
  );

  const stepValid = (n) => {
    if (n === 1) return form.pickupAt && form.returnAt && form.pickupLocationId && form.returnLocationId && rentalDays > 0;
    if (n === 2) return !!form.vehicleTypeId && !!quote && !rateError;
    if (n === 3) return !!form.customerId;
    return true;
  };

  /**
   * Why a save is refused, in the agent's words.
   *
   * "Complete all steps first." sent an International agent to Hector on
   * 2026-08-07 reporting "no me graba la reserva" — and because submit()
   * returns BEFORE calling the API, the server had no record of the attempt
   * at all. Nothing to read in the logs, nothing for the agent to act on.
   * A refusal has to name what is missing.
   */
  const blockedReason = () => {
    if (!form.pickupAt || !form.returnAt) return 'Step 1: pick a pickup and a return date.';
    if (rentalDays <= 0) return 'Step 1: the return date must be after the pickup date.';
    if (!form.pickupLocationId || !form.returnLocationId) return 'Step 1: choose a pickup and a return location.';
    if (!form.vehicleTypeId) return 'Step 2: choose a vehicle class.';
    if (rateError) return `Step 2: ${rateError}`;
    if (!quote) return 'Step 2: still pricing this class — wait a moment, or reselect the dates if the price never appears.';
    if (!form.customerId) return 'Step 3: choose or create the customer.';
    return '';
  };

  const submit = async () => {
    const blocked = blockedReason();
    if (blocked) { setErr(blocked); return; }
    setBusy(true); setErr('');
    try {
      const reservationNumber = form.reservationNumber || `RES-${Date.now().toString().slice(-6)}`;
      const created = await api('/api/reservations', {
        method: 'POST',
        body: JSON.stringify({
          reservationNumber,
          customerId: form.customerId,
          vehicleTypeId: form.vehicleTypeId,
          pickupAt: form.pickupAt,
          returnAt: form.returnAt,
          pickupLocationId: form.pickupLocationId,
          returnLocationId: form.returnLocationId,
          dailyRate: quote?.dailyRate != null ? Number(quote.dailyRate) : null,
          estimatedTotal: quote?.baseTotal != null ? Number(quote.baseTotal) : null,
          addOnsTotal: 0,
          status: 'CONFIRMED',
          sendConfirmationEmail: false,
          // Booking source (LAX #5): OTA-sourced contracts qualify for the
          // review-tier commission; walk-ins stay STAFF.
          bookingChannel: form.bookingChannel || 'STAFF',
          notes: form.notes || null
        })
      }, token);
      router.push(`/reservations/${created.id}`);
    } catch (e) { setErr(e?.message || 'Failed to create reservation'); setBusy(false); }
  };

  const returnMin = useMemo(() => {
    if (!form.pickupAt) return '';
    const d = new Date(form.pickupAt);
    if (!Number.isFinite(d.getTime())) return '';
    d.setHours(d.getHours() + Number(rentalMin.minimumHours || 24));
    const pad = (x) => String(x).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }, [form.pickupAt, rentalMin.minimumHours]);

  const Stepper = () => (
    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 16 }}>
      {['Dates & locations', 'Vehicle class', 'Customer', 'Review'].map((label, i) => {
        const n = i + 1; const active = step === n; const done = step > n;
        return (
          <button key={label} type="button" onClick={() => (done || stepValid(n - 1) || n === 1) && setStep(n)}
            style={{ padding: '6px 12px', borderRadius: 999, fontSize: 13, fontWeight: 600, border: 'none', cursor: 'pointer',
              background: active ? '#6d28d9' : done ? '#ecfdf5' : '#f3f0ff', color: active ? '#fff' : done ? '#166534' : '#6f668f' }}>
            {done ? '✓ ' : `${n}. `}{label}
          </button>
        );
      })}
    </div>
  );

  const SummaryPane = () => (
    <aside className="glass card section-card" style={{ position: 'sticky', top: 16, alignSelf: 'start' }}>
      <h3 style={{ marginTop: 0 }}>Live summary</h3>
      <div className="stack" style={{ gap: 8, fontSize: 14 }}>
        <Row label="Pickup" value={form.pickupAt ? new Date(form.pickupAt).toLocaleString() : '—'} />
        <Row label="Return" value={form.returnAt ? new Date(form.returnAt).toLocaleString() : '—'} />
        <Row label="Days" value={rentalDays || '—'} />
        <Row label="Pickup loc" value={pickupLocation?.name || '—'} />
        <Row label="Vehicle class" value={selectedVtLabel(vehicleTypes, form.vehicleTypeId)} />
        <Row label="Customer" value={selectedCustomer ? `${selectedCustomer.firstName || ''} ${selectedCustomer.lastName || ''}`.trim() || selectedCustomer.email : '—'} />
        <div style={{ borderTop: '1px solid #e6dfff', margin: '6px 0' }} />
        <Row label="Daily rate" value={quote?.dailyRate != null ? money(quote.dailyRate) : '—'} />
        <Row label="Base total" value={quote?.baseTotal != null ? money(quote.baseTotal) : '—'} strong />
        {rateError ? <div className="error" style={{ fontSize: 12 }}>{rateError}</div> : null}
      </div>
      <div className="surface-note" style={{ marginTop: 12, fontSize: 12 }}>
        A refundable pre-authorization (security deposit hold) is placed on the customer&rsquo;s card at check-out — it is not charged now.
      </div>
    </aside>
  );

  const dnr = selectedCustomer?.doNotRent;

  return (
    <AppShell me={me} logout={logout}>
      <section className="glass card-lg section-card" style={{ marginBottom: 16 }}>
        <div className="row-between" style={{ alignItems: 'start' }}>
          <div>
            <span className="eyebrow">Reservations</span>
            <h2 className="page-title" style={{ marginTop: 6 }}>New reservation</h2>
            <p className="ui-muted">Guided booking — dates, class, customer, review.</p>
          </div>
          <button type="button" className="button-subtle" onClick={() => router.push('/reservations')}>Cancel</button>
        </div>
      </section>

      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) 320px', gap: 16, alignItems: 'start' }}>
        <section className="glass card-lg section-card">
          <Stepper />
          {msg ? <p className="label" style={{ color: '#166534' }}>{msg}</p> : null}
          {err ? <p className="error">{err}</p> : null}

          {step === 1 && (
            <div className="stack">
              <h3 style={{ margin: 0 }}>1. Dates & locations</h3>
              <div className="app-card-grid compact">
                <div className="stack" style={{ gap: 4 }}><label className="label">Pickup</label><input type="datetime-local" value={form.pickupAt} onChange={(e) => set({ pickupAt: e.target.value })} /></div>
                <div className="stack" style={{ gap: 4 }}><label className="label">Return</label><input type="datetime-local" min={returnMin} value={form.returnAt} onChange={(e) => set({ returnAt: e.target.value })} /></div>
                <div className="stack" style={{ gap: 4 }}><label className="label">Pickup location</label>
                  <select value={form.pickupLocationId} onChange={(e) => set({ pickupLocationId: e.target.value, returnLocationId: form.returnLocationId || e.target.value })}>
                    <option value="">— select —</option>
                    {locations.map((l) => <option key={l.id} value={l.id}>{l.code} · {l.name}</option>)}
                  </select>
                </div>
                <div className="stack" style={{ gap: 4 }}><label className="label">Return location</label>
                  <select value={form.returnLocationId} onChange={(e) => set({ returnLocationId: e.target.value })}>
                    <option value="">— select —</option>
                    {locations.map((l) => <option key={l.id} value={l.id}>{l.code} · {l.name}</option>)}
                  </select>
                </div>
              </div>
              {form.pickupAt && form.returnAt && rentalDays <= 0 ? <p className="error">Return must be after pickup.</p> : null}
              <p className="ui-muted" style={{ fontSize: 12, marginTop: 4 }}>
                {rentalMin.hourly
                  ? `This location rents by the hour — minimum ${rentalMin.minimumHours} hour${rentalMin.minimumHours === 1 ? '' : 's'}.`
                  : 'Minimum rental is 24 hours. To rent for less, configure an hourly rate for the vehicle class.'}
              </p>
              <div className="inline-actions" style={{ marginTop: 14 }}>
                <button type="button" onClick={() => setStep(2)} disabled={!stepValid(1)}>Continue</button>
              </div>
            </div>
          )}

          {step === 2 && (
            <div className="stack">
              <h3 style={{ margin: 0 }}>2. Vehicle class</h3>
              <div className="ui-muted">Market median (where available) is shown per class for the pickup airport.</div>
              <div className="app-card-grid" style={{ marginTop: 8 }}>
                {vehicleTypes.map((vt) => {
                  const code = String(vt.code || '').toUpperCase();
                  const mkt = marketBySipp[code];
                  const sel = form.vehicleTypeId === vt.id;
                  return (
                    <button key={vt.id} type="button" onClick={() => set({ vehicleTypeId: vt.id })}
                      className={sel ? '' : 'button-subtle'} style={{ textAlign: 'left', padding: 12, borderRadius: 12, border: sel ? '2px solid #6d28d9' : '1px solid #e6dfff' }}>
                      <div style={{ fontWeight: 700 }}>{vt.code} · {vt.name}</div>
                      <div className="ui-muted" style={{ fontSize: 12 }}>{SIPP_LABELS[code] || ''}</div>
                      <div style={{ marginTop: 6, fontSize: 13 }}>
                        {mkt ? <>Market median <strong>{money(mkt.median)}</strong>{mkt.yourRate != null ? ` · yours ${money(mkt.yourRate)}` : ''}</> : <span className="ui-muted">No market data</span>}
                      </div>
                    </button>
                  );
                })}
              </div>
              {rateError ? <p className="error">{rateError}</p> : null}
              <div className="inline-actions" style={{ marginTop: 14 }}>
                <button type="button" className="button-subtle" onClick={() => setStep(1)}>Back</button>
                <button type="button" onClick={() => setStep(3)} disabled={!stepValid(2)}>Continue</button>
              </div>
            </div>
          )}

          {step === 3 && (
            <div className="stack">
              <h3 style={{ margin: 0 }}>3. Customer</h3>
              {!newCust ? (
                <>
                  <input placeholder="Search by name, email or phone…" value={custQuery} onChange={(e) => searchCustomers(e.target.value)} />
                  <div className="stack" style={{ gap: 6, marginTop: 6 }}>
                    {custResults.map((c) => (
                      <button key={c.id} type="button" className={form.customerId === c.id ? '' : 'button-subtle'} style={{ textAlign: 'left' }} onClick={() => chooseCustomer(c)}>
                        {(c.firstName || '') + ' ' + (c.lastName || '')} · {c.email || c.phone || c.id}{c.doNotRent ? ' · ⚠ DO NOT RENT' : ''}
                      </button>
                    ))}
                  </div>
                  <button type="button" className="link" style={{ marginTop: 8 }} onClick={() => setNewCust({ ...EMPTY_NEW_CUSTOMER })}>+ Create new customer</button>
                </>
              ) : (
                <div className="app-card-grid compact">
                  {/* LAX #6 (2026-07-28): same field set + completeness bar as the
                      pre-check-in form — all mandatory except insurance. */}
                  <div className="stack" style={{ gap: 4 }}><label className="label">First name*</label><input value={newCust.firstName} onChange={(e) => setNewCust({ ...newCust, firstName: e.target.value })} /></div>
                  <div className="stack" style={{ gap: 4 }}><label className="label">Last name*</label><input value={newCust.lastName} onChange={(e) => setNewCust({ ...newCust, lastName: e.target.value })} /></div>
                  <div className="stack" style={{ gap: 4 }}><label className="label">Email*</label><input type="email" value={newCust.email} onChange={(e) => setNewCust({ ...newCust, email: e.target.value })} /></div>
                  <div className="stack" style={{ gap: 4 }}><label className="label">Phone*</label><input value={newCust.phone} onChange={(e) => setNewCust({ ...newCust, phone: e.target.value })} /></div>
                  <div className="stack" style={{ gap: 4 }}><label className="label">Date of birth*</label><input type="date" value={newCust.dateOfBirth} onChange={(e) => setNewCust({ ...newCust, dateOfBirth: e.target.value })} /></div>
                  <div className="stack" style={{ gap: 4 }}><label className="label">License number*</label><input value={newCust.licenseNumber} onChange={(e) => setNewCust({ ...newCust, licenseNumber: e.target.value })} /></div>
                  <div className="stack" style={{ gap: 4 }}><label className="label">License state*</label><input value={newCust.licenseState} onChange={(e) => setNewCust({ ...newCust, licenseState: e.target.value })} /></div>
                  <div className="stack" style={{ gap: 4 }}><label className="label">Address*</label><input value={newCust.address1} onChange={(e) => setNewCust({ ...newCust, address1: e.target.value })} /></div>
                  <div className="stack" style={{ gap: 4 }}><label className="label">Address line 2</label><input value={newCust.address2} onChange={(e) => setNewCust({ ...newCust, address2: e.target.value })} /></div>
                  <div className="stack" style={{ gap: 4 }}><label className="label">City*</label><input value={newCust.city} onChange={(e) => setNewCust({ ...newCust, city: e.target.value })} /></div>
                  <div className="stack" style={{ gap: 4 }}><label className="label">State*</label><input value={newCust.state} onChange={(e) => setNewCust({ ...newCust, state: e.target.value })} /></div>
                  <div className="stack" style={{ gap: 4 }}><label className="label">ZIP*</label><input value={newCust.zip} onChange={(e) => setNewCust({ ...newCust, zip: e.target.value })} /></div>
                  <div className="stack" style={{ gap: 4 }}><label className="label">Country*</label><input value={newCust.country} onChange={(e) => setNewCust({ ...newCust, country: e.target.value })} /></div>
                  <div className="stack" style={{ gap: 4 }}><label className="label">Insurance policy #</label><input value={newCust.insurancePolicyNumber} onChange={(e) => setNewCust({ ...newCust, insurancePolicyNumber: e.target.value })} /></div>
                  <div className="stack" style={{ gap: 4 }}><label className="label">Insurance exp date</label><input type="date" value={newCust.insuranceExpiry} onChange={(e) => setNewCust({ ...newCust, insuranceExpiry: e.target.value })} /></div>
                  <div className="stack" style={{ gap: 4 }}>
                    <label className="label">ID / License photo*</label>
                    <input type="file" accept="image/*,.pdf" onChange={(e) => handleNewCustUpload('idPhotoUrl', e.target.files?.[0])} />
                    {newCust.idPhotoUrl ? <span style={{ fontSize: '0.8rem', color: '#166534' }}>Uploaded</span> : null}
                  </div>
                  <div className="stack" style={{ gap: 4 }}>
                    <label className="label">License (back)</label>
                    <input type="file" accept="image/*,.pdf" onChange={(e) => handleNewCustUpload('licenseBackUrl', e.target.files?.[0])} />
                    {newCust.licenseBackUrl ? <span style={{ fontSize: '0.8rem', color: '#166534' }}>Uploaded</span> : null}
                  </div>
                  {newCustMissing.length > 0 && (
                    <p className="label" style={{ gridColumn: '1 / -1', textTransform: 'none', letterSpacing: 0, color: '#b45309' }}>
                      Missing: {newCustMissing.map((k) => CUSTOMER_FIELD_LABELS[k] || k).join(', ')}
                    </p>
                  )}
                  <div className="inline-actions" style={{ gridColumn: '1 / -1' }}>
                    <button type="button" onClick={createCustomer} disabled={busy || newCustMissing.length > 0}>Create & select</button>
                    <button type="button" className="button-subtle" onClick={() => setNewCust(null)}>Cancel</button>
                  </div>
                </div>
              )}
              {dnr ? <p className="error" style={{ marginTop: 10 }}>⚠ This customer is flagged DO NOT RENT{selectedCustomer?.doNotRentReason ? `: ${selectedCustomer.doNotRentReason}` : ''}.</p> : null}
              <div className="inline-actions" style={{ marginTop: 14 }}>
                <button type="button" className="button-subtle" onClick={() => setStep(2)}>Back</button>
                <button type="button" onClick={() => setStep(4)} disabled={!stepValid(3)}>Continue</button>
              </div>
            </div>
          )}

          {step === 4 && (
            <div className="stack">
              <h3 style={{ margin: 0 }}>4. Review & confirm</h3>
              {dnr ? <p className="error">⚠ Customer is flagged DO NOT RENT. Confirm with a manager before booking.</p> : null}
              <div className="stack" style={{ gap: 4 }}>
                <label className="label">Reservation # (optional — auto if blank)</label>
                <input placeholder="Leave blank for auto-number" value={form.reservationNumber} onChange={(e) => set({ reservationNumber: e.target.value })} />
              </div>
              <div className="stack" style={{ gap: 4 }}>
                <label className="label">Booking source</label>
                <select value={form.bookingChannel} onChange={(e) => set({ bookingChannel: e.target.value })}>
                  <option value="STAFF">Walk-in / counter</option>
                  <option value="EXPEDIA">Expedia</option>
                  <option value="PRICELINE">Priceline</option>
                </select>
                <span className="label" style={{ textTransform: 'none', letterSpacing: 0 }}>
                  OTA reservations (Expedia/Priceline) qualify for the review-tier commission.
                </span>
              </div>
              <div className="stack" style={{ gap: 4 }}>
                <label className="label">Notes</label>
                <textarea rows={3} value={form.notes} onChange={(e) => set({ notes: e.target.value })} />
              </div>
              <div className="inline-actions" style={{ marginTop: 14 }}>
                <button type="button" className="button-subtle" onClick={() => setStep(3)}>Back</button>
                <button type="button" onClick={submit} disabled={busy || !!rateError}>{busy ? 'Creating…' : 'Create reservation'}</button>
              </div>
            </div>
          )}
        </section>

        <SummaryPane />
      </div>
    </AppShell>
  );
}

function Row({ label, value, strong }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>
      <span className="ui-muted">{label}</span>
      <span style={{ fontWeight: strong ? 700 : 500, textAlign: 'right' }}>{value}</span>
    </div>
  );
}

function selectedVtLabel(vehicleTypes, id) {
  const vt = vehicleTypes.find((v) => v.id === id);
  return vt ? `${vt.code} · ${vt.name}` : '—';
}
