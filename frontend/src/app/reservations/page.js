'use client';

function extractMandatoryFeeIdsFromLocationConfig(rawCfg) {
  let cfg = rawCfg;
  try { if (typeof cfg === 'string') cfg = JSON.parse(cfg || '{}'); } catch { cfg = {}; }
  const out = new Set();
  const keys = ['mandatoryFeeIds','requiredFeeIds','feeIds','locationFeeIds'];
  for (const k of keys) {
    const arr = Array.isArray(cfg?.[k]) ? cfg[k] : [];
    for (const id of arr) if (id) out.add(String(id));
  }
  const feeRules = Array.isArray(cfg?.fees) ? cfg.fees : (Array.isArray(cfg?.feeRules) ? cfg.feeRules : []);
  for (const f of feeRules) {
    const active = f?.enabled ?? f?.active ?? f?.isActive ?? true;
    const mandatory = f?.mandatory ?? f?.required ?? f?.isMandatory ?? false;
    const id = f?.feeId ?? f?.id;
    if (active && mandatory && id) out.add(String(id));
  }
  return Array.from(out);
}


import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { AuthGate } from '../../components/AuthGate';
import { AppShell } from '../../components/AppShell';
import { api } from '../../lib/client';

export default function ReservationsPage() {
  return <AuthGate>{({ token, me, logout }) => <ReservationsInner token={token} me={me} logout={logout} />}</AuthGate>;
}

function ReservationsInner({ token, me, logout }) {
  const router = useRouter();
  const [reservations, setReservations] = useState([]);
  const [customers, setCustomers] = useState([]);
  const [locations, setLocations] = useState([]);
  const [vehicleTypes, setVehicleTypes] = useState([]);
  const [services, setServices] = useState([]);
  const [fees, setFees] = useState([]);
  const [insurancePlans, setInsurancePlans] = useState([]);
  const [selectedServiceIds, setSelectedServiceIds] = useState([]);
  const [selectedFeeIds, setSelectedFeeIds] = useState([]);
  const [selectedInsuranceCode, setSelectedInsuranceCode] = useState('');
  const [query, setQuery] = useState('');
  const [msg, setMsg] = useState('');
  const [createOpen, setCreateOpen] = useState(false);
  const [rateError, setRateError] = useState('');
  const [addingCustomer, setAddingCustomer] = useState(false);
  const [newCustomer, setNewCustomer] = useState({ firstName: '', lastName: '', phone: '', email: '' });
  const [createForm, setCreateForm] = useState({ reservationNumber: '', customerId: '', vehicleTypeId: '', pickupAt: '', returnAt: '', pickupLocationId: '', returnLocationId: '', dailyRate: '', estimatedTotal: '', notes: '' });

  const hasFeeAdvisory = (notes) => /\[FEE_ADVISORY_OPEN\s+/i.test(String(notes || ''));

  const load = async () => {
    const [r, c, l, vt, s, f, ip] = await Promise.all([
      api('/api/reservations', {}, token),
      api('/api/customers', {}, token),
      api('/api/locations', {}, token),
      api('/api/vehicle-types', {}, token),
      api('/api/additional-services?activeOnly=1', {}, token),
      api('/api/fees', {}, token),
      api('/api/settings/insurance-plans', {}, token)
    ]);
    setReservations(r);
    setCustomers(c);
    setLocations(l);
    setVehicleTypes(vt || []);
    setServices(s || []);
    setFees((f || []).filter((x) => x?.isActive !== false));
    setInsurancePlans(ip || []);
  };
  useEffect(() => { load(); }, [token]);

  useEffect(() => {
    const canResolve = createOpen && createForm.vehicleTypeId && createForm.pickupLocationId && createForm.pickupAt && createForm.returnAt;
    if (!canResolve) {
      setRateError('');
      return;
    }

    let cancelled = false;
    (async () => {
      try {
        const q = new URLSearchParams({
          vehicleTypeId: createForm.vehicleTypeId,
          pickupLocationId: createForm.pickupLocationId,
          pickupAt: createForm.pickupAt,
          returnAt: createForm.returnAt
        });
        const out = await api(`/api/rates/resolve?${q.toString()}`, {}, token);
        if (cancelled) return;
        setRateError('');
        setCreateForm((f) => ({ ...f, dailyRate: String(out?.dailyRate ?? ''), estimatedTotal: String(out?.baseTotal ?? '') }));
      } catch (e) {
        if (cancelled) return;
        setCreateForm((f) => ({ ...f, dailyRate: '', estimatedTotal: '' }));
        setRateError('No rate tables found for selected vehicle type, location and dates');
      }
    })();

    return () => { cancelled = true; };
  }, [createOpen, createForm.vehicleTypeId, createForm.pickupLocationId, createForm.pickupAt, createForm.returnAt, token]);

  const rentalDays = useMemo(() => {
    if (!createForm.pickupAt || !createForm.returnAt) return 0;
    const ms = new Date(createForm.returnAt) - new Date(createForm.pickupAt);
    if (!Number.isFinite(ms) || ms <= 0) return 0;
    return Math.max(1, Math.ceil(ms / (1000 * 60 * 60 * 24)));
  }, [createForm.pickupAt, createForm.returnAt]);

  const filteredServices = useMemo(() => {
    const vtId = createForm.vehicleTypeId;
    const locId = createForm.pickupLocationId;
    const parseIds = (raw) => {
      if (!raw) return [];
      if (Array.isArray(raw)) return raw;
      try { const arr = JSON.parse(raw); return Array.isArray(arr) ? arr : []; } catch { return []; }
    };
    return (services || []).filter((s) => {
      if (s?.isActive === false) return false;
      if (s?.locationId && locId && s.locationId !== locId) return false;
      const ids = parseIds(s?.vehicleTypeIds);
      if (!s?.allVehicleTypes && vtId && ids.length && !ids.includes(vtId)) return false;
      return true;
    });
  }, [services, createForm.vehicleTypeId, createForm.pickupLocationId]);

  const filteredInsurance = useMemo(() => {
    const vtId = createForm.vehicleTypeId;
    const locId = createForm.pickupLocationId;
    return (insurancePlans || []).filter((p) => {
      if (p?.isActive === false) return false;
      const locIds = Array.isArray(p?.locationIds) ? p.locationIds : [];
      const vtIds = Array.isArray(p?.vehicleTypeIds) ? p.vehicleTypeIds : [];
      if (locIds.length && locId && !locIds.includes(locId)) return false;
      if (vtIds.length && vtId && !vtIds.includes(vtId)) return false;
      return true;
    });
  }, [insurancePlans, createForm.vehicleTypeId, createForm.pickupLocationId]);

  const selectedServices = filteredServices.filter((s) => selectedServiceIds.includes(s.id));
  const selectedFees = (fees || []).filter((f) => selectedFeeIds.includes(f.id));
  const baseEstimate = Number(createForm.estimatedTotal || 0);
  const servicesTotal = selectedServices.reduce((sum, s) => {
    const qty = Number(s?.defaultQty || 1) || 1;
    const perDay = Number(s?.dailyRate || 0);
    const flat = Number(s?.rate || 0);
    const line = perDay > 0 ? perDay * Math.max(1, rentalDays) * qty : flat * qty;
    return sum + line;
  }, 0);
  const feesTotal = selectedFees.reduce((sum, f) => {
    const amt = Number(f?.amount || 0);
    const mode = String(f?.mode || 'FIXED').toUpperCase();
    if (mode === 'PERCENTAGE') return sum + (baseEstimate * (amt / 100));
    return sum + amt;
  }, 0);
  const selectedInsurance = filteredInsurance.find((p) => p.code === selectedInsuranceCode) || null;
  const insuranceTotal = (() => {
    if (!selectedInsurance) return 0;
    const amount = Number(selectedInsurance.amount || 0);
    const mode = String(selectedInsurance.chargeBy || selectedInsurance.mode || 'FIXED').toUpperCase();
    if (mode === 'PER_DAY') return amount * Math.max(1, rentalDays);
    if (mode === 'PERCENTAGE') return baseEstimate * (amount / 100);
    return amount;
  })();
  const estimatedWithExtras = Number((baseEstimate + servicesTotal + feesTotal + insuranceTotal).toFixed(2));

  const startRental = async (id) => {
    router.push(`/reservations/${id}/checkout`);
  };
  const setStatus = async (id, status) => {
    try {
      await api(`/api/reservations/${id}`, { method: 'PATCH', body: JSON.stringify({ status }) }, token);
      setMsg(status === 'CANCELLED' ? 'Reservation cancelled' : status === 'NO_SHOW' ? 'Reservation marked as no show' : 'Status updated');
      await load();
    } catch (e) {
      setMsg(e.message);
    }
  };

  const createInlineCustomer = async () => {
    try {
      if (!newCustomer.firstName || !newCustomer.lastName || !newCustomer.phone) {
        setMsg('New customer requires first name, last name and phone');
        return;
      }
      const created = await api('/api/customers', {
        method: 'POST',
        body: JSON.stringify({
          firstName: newCustomer.firstName,
          lastName: newCustomer.lastName,
          phone: newCustomer.phone,
          email: newCustomer.email || null
        })
      }, token);
      setCustomers((prev) => [created, ...prev]);
      setCreateForm((f) => ({ ...f, customerId: created.id }));
      setAddingCustomer(false);
      setNewCustomer({ firstName: '', lastName: '', phone: '', email: '' });
      setMsg(`Customer ${created.firstName} ${created.lastName} added and selected`);
    } catch (e) {
      setMsg(e.message);
    }
  };

  const createReservation = async () => {
    try {
      if (!createForm.customerId || !createForm.vehicleTypeId || !createForm.pickupAt || !createForm.returnAt || !createForm.pickupLocationId || !createForm.returnLocationId) {
        setMsg('Customer, vehicle type, pickup/return dates and locations are required');
        return;
      }
      if (rateError || !createForm.dailyRate) {
        setMsg('No rate tables found for selected vehicle type, location and dates');
        return;
      }
      const reservationNumber = createForm.reservationNumber || `RES-${Date.now().toString().slice(-6)}`;
      const addOnsTotal = 0;
      const addonSummary = ''; // moved to Charges edit flow

      await api('/api/reservations', {
        method: 'POST',
        body: JSON.stringify({
          reservationNumber,
          customerId: createForm.customerId,
          vehicleTypeId: createForm.vehicleTypeId,
          pickupAt: createForm.pickupAt,
          returnAt: createForm.returnAt,
          pickupLocationId: createForm.pickupLocationId,
          returnLocationId: createForm.returnLocationId,
          dailyRate: createForm.dailyRate ? Number(createForm.dailyRate) : null,
          estimatedTotal: estimatedWithExtras,
          addOnsTotal,
          status: 'CONFIRMED',
          sendConfirmationEmail: false,
          notes: createForm.notes || null
        })
      }, token);
      setMsg('Reservation created');
      setCreateOpen(false);
      setRateError('');
      setSelectedServiceIds([]);
      setSelectedFeeIds([]);
      setSelectedInsuranceCode('');
      setCreateForm({ reservationNumber: '', customerId: '', vehicleTypeId: '', pickupAt: '', returnAt: '', pickupLocationId: '', returnLocationId: '', dailyRate: '', estimatedTotal: '', notes: '' });
      await load();
    } catch (e) {
      setMsg(e.message);
    }
  };

  const rows = reservations.filter((r) => {
    const q = query.toLowerCase();
    return !q || r.reservationNumber.toLowerCase().includes(q) || `${r.customer?.firstName || ''} ${r.customer?.lastName || ''}`.toLowerCase().includes(q);
  });

  return (
    <AppShell me={me} logout={logout}>
      <section className="glass card-lg">
        <div className="row-between"><h2>Reservations</h2><div style={{ display: 'flex', gap: 8 }}><input placeholder="Search reservation/customer" value={query} onChange={(e) => setQuery(e.target.value)} /><button onClick={() => { setCreateOpen(true); setSelectedServiceIds([]); setSelectedFeeIds([]); setSelectedInsuranceCode(''); setRateError(''); setAddingCustomer(false); setNewCustomer({ firstName: '', lastName: '', phone: '', email: '' }); }}>New Reservation</button></div></div>
        {msg ? <p className="label">{msg}</p> : null}
        <table>
          <thead><tr><th>#</th><th>Status</th><th>Customer</th><th>Pickup</th><th>Return</th><th>Actions</th></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                <td><Link href={`/reservations/${r.id}`}>{r.reservationNumber}</Link></td>
                <td><span className="badge">{r.status}</span>{hasFeeAdvisory(r.notes) ? <span title="Additional fee advisory" style={{ marginLeft: 6 }}>⚠️</span> : null}</td>
                <td>{r.customer?.firstName} {r.customer?.lastName}</td>
                <td>{new Date(r.pickupAt).toLocaleString()}</td>
                <td>{new Date(r.returnAt).toLocaleString()}</td>
                <td>
                  {r.status === 'CHECKED_OUT' ? null : (
                    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                      <button onClick={() => startRental(r.id)}>Start Check-out</button>
                      <button onClick={() => setStatus(r.id, 'CANCELLED')}>Cancel</button>
                      <button onClick={() => setStatus(r.id, 'NO_SHOW')}>No Show</button>
                    </div>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      {createOpen && (
        <div className="modal-backdrop" onClick={() => setCreateOpen(false)}>
          <div className="rent-modal glass" style={{ width: 'min(760px, 95vw)' }} onClick={(e) => e.stopPropagation()}>
            <h3>New Reservation</h3>
            <div className="stack">
              <div className="grid2">
                <div className="stack">
                  <label className="label">Reservation # (optional)</label>
                  <input placeholder="Leave blank for auto-number" value={createForm.reservationNumber} onChange={(e) => setCreateForm({ ...createForm, reservationNumber: e.target.value })} />
                </div>
                <div className="stack">
                  <label className="label">Customer*</label>
                  <select value={createForm.customerId} onChange={(e) => setCreateForm({ ...createForm, customerId: e.target.value })}>
                    <option value="">Select</option>
                    {customers.map((c) => <option key={c.id} value={c.id}>{c.firstName} {c.lastName} · {c.phone}</option>)}
                  </select>
                </div>
              </div>

              <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: -2 }}>
                <button type="button" className="ios-action-btn" onClick={() => setAddingCustomer((v) => !v)}>{addingCustomer ? 'Cancel New Customer' : '+ Add New Customer'}</button>
              </div>

              {addingCustomer ? (
                <div className="glass card" style={{ padding: 10 }}>
                  <div className="label" style={{ marginBottom: 8 }}>Quick New Customer</div>
                  <div className="grid2">
                    <div className="stack"><label className="label">First Name*</label><input value={newCustomer.firstName} onChange={(e) => setNewCustomer({ ...newCustomer, firstName: e.target.value })} /></div>
                    <div className="stack"><label className="label">Last Name*</label><input value={newCustomer.lastName} onChange={(e) => setNewCustomer({ ...newCustomer, lastName: e.target.value })} /></div>
                    <div className="stack"><label className="label">Phone*</label><input value={newCustomer.phone} onChange={(e) => setNewCustomer({ ...newCustomer, phone: e.target.value })} /></div>
                    <div className="stack"><label className="label">Email</label><input value={newCustomer.email} onChange={(e) => setNewCustomer({ ...newCustomer, email: e.target.value })} /></div>
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 8 }}>
                    <button type="button" className="ios-action-btn" onClick={createInlineCustomer}>Create & Select Customer</button>
                  </div>
                </div>
              ) : null}
              <div className="grid2">
                <div className="stack"><label className="label">Vehicle Type*</label><select value={createForm.vehicleTypeId} onChange={(e) => setCreateForm({ ...createForm, vehicleTypeId: e.target.value })}><option value="">Select vehicle type</option>{vehicleTypes.map((v) => <option key={v.id} value={v.id}>{v.name} {v.code ? `(${v.code})` : ''}</option>)}</select></div>
              </div>
              <div className="grid2">
                <div className="stack"><label className="label">Pickup*</label><input type="datetime-local" value={createForm.pickupAt} onChange={(e) => setCreateForm({ ...createForm, pickupAt: e.target.value })} /></div>
                <div className="stack"><label className="label">Return*</label><input type="datetime-local" value={createForm.returnAt} onChange={(e) => setCreateForm({ ...createForm, returnAt: e.target.value })} /></div>
              </div>
              <div className="grid2">
                <div className="stack"><label className="label">Pickup Location*</label><select value={createForm.pickupLocationId} onChange={(e) => setCreateForm({ ...createForm, pickupLocationId: e.target.value })}><option value="">Select</option>{locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</select></div>
                <div className="stack"><label className="label">Return Location*</label><select value={createForm.returnLocationId} onChange={(e) => setCreateForm({ ...createForm, returnLocationId: e.target.value })}><option value="">Select</option>{locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</select></div>
              </div>
              <div className="grid2">
                <div className="stack"><label className="label">Daily Rate (auto from rate table)</label><input value={createForm.dailyRate} readOnly /></div>
                <div className="stack"><label className="label">Base Estimate (auto)</label><input value={createForm.estimatedTotal} readOnly /></div>
              </div>
              {rateError ? <div className="label" style={{ color: '#991b1b', fontWeight: 700 }}>{rateError}</div> : null}

              <div className="glass card" style={{ padding: 10, display:'none' }}>
                <h4 style={{ marginBottom: 8 }}>Additional Services</h4>
                <div className="service-checks-grid">
                  {filteredServices.map((s) => (
                    <label key={s.id} className="label">
                      <input
                        type="checkbox"
                        checked={selectedServiceIds.includes(s.id)}
                        onChange={(e) => setSelectedServiceIds((prev) => e.target.checked ? [...new Set([...prev, s.id])] : prev.filter((id) => id !== s.id))}
                      /> {s.name} ({Number(s.dailyRate || 0) > 0 ? `$${Number(s.dailyRate || 0).toFixed(2)}/day` : `$${Number(s.rate || 0).toFixed(2)}`})
                    </label>
                  ))}
                  {!filteredServices.length ? <div className="label">No additional services configured for this selection.</div> : null}
                </div>
              </div>

              <div className="glass card" style={{ padding: 10, display:'none' }}>
                <h4 style={{ marginBottom: 8 }}>Additional Fees</h4>
                <div className="service-checks-grid">
                  {(fees || []).map((f) => (
                    <label key={f.id} className="label">
                      <input
                        type="checkbox"
                        checked={selectedFeeIds.includes(f.id)}
                        onChange={(e) => setSelectedFeeIds((prev) => e.target.checked ? [...new Set([...prev, f.id])] : prev.filter((id) => id !== f.id))}
                      /> {f.name} ({String(f.mode || 'FIXED') === 'PERCENTAGE' ? `${Number(f.amount || 0).toFixed(2)}%` : `$${Number(f.amount || 0).toFixed(2)}`})
                    </label>
                  ))}
                  {!fees.length ? <div className="label">No fees configured.</div> : null}
                </div>
              </div>

              <div className="glass card" style={{ padding: 10 }}>
                <h4 style={{ marginBottom: 8 }}>Insurance</h4>
                <select value={selectedInsuranceCode} onChange={(e) => setSelectedInsuranceCode(e.target.value)}>
                  <option value="">No insurance selected</option>
                  {filteredInsurance.map((p, idx) => <option key={`${p.code || idx}`} value={p.code}>{p.name || p.label || p.code} ({String(p.chargeBy || p.mode || 'FIXED')})</option>)}
                </select>
              </div>

              <div className="grid2">
                <div className="stack"><label className="label">Services Total (estimated)</label><input value={servicesTotal.toFixed(2)} readOnly /></div>
                <div className="stack"><label className="label">Fees Total (estimated)</label><input value={feesTotal.toFixed(2)} readOnly /></div>
                <div className="stack"><label className="label">Insurance Total (estimated)</label><input value={insuranceTotal.toFixed(2)} readOnly /></div>
                <div className="stack"><label className="label">Estimated Total with Selections</label><input value={estimatedWithExtras.toFixed(2)} readOnly /></div>
                <div className="stack"><label className="label">Rental Days (estimated)</label><input value={String(rentalDays || 0)} readOnly /></div>
              </div>

              <div className="stack"><label className="label">Notes</label><textarea rows={3} value={createForm.notes} onChange={(e) => setCreateForm({ ...createForm, notes: e.target.value })} /></div>
              <div className="row-between">
                <button onClick={() => { setCreateOpen(false); setRateError(''); setSelectedServiceIds([]); setSelectedFeeIds([]); setSelectedInsuranceCode(''); setAddingCustomer(false); setNewCustomer({ firstName: '', lastName: '', phone: '', email: '' }); }}>Cancel</button>
                <button onClick={createReservation}>Create Reservation</button>
              </div>
            </div>
          </div>
        </div>
      )}
    </AppShell>
  );
}
