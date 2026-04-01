'use client';

function parseCsv(text) {
  const lines = String(text || '').split(/\r?\n/).filter(Boolean);
  if (!lines.length) return [];
  const headers = lines[0].split(',').map((h) => h.trim());
  return lines.slice(1).map((line) => {
    const cols = line.split(',').map((c) => c.trim());
    const row = {};
    headers.forEach((h, i) => { row[h] = cols[i] ?? ''; });
    return row;
  });
}

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

const RESERVATION_PAGE_SIZE = 100;
const CUSTOMER_PICKER_LIMIT = 100;

export default function ReservationsPage() {
  return <AuthGate>{({ token, me, logout }) => <ReservationsInner token={token} me={me} logout={logout} />}</AuthGate>;
}

function ReservationsInner({ token, me, logout }) {
  const router = useRouter();
  const role = String(me?.role || '').toUpperCase().trim();
  const isSuper = role === 'SUPER_ADMIN';
  const canManageReservationSetup = ['SUPER_ADMIN', 'ADMIN', 'OPS'].includes(role);
  const canCreateReservation = ['SUPER_ADMIN', 'ADMIN', 'OPS', 'AGENT'].includes(role);
  const [reservations, setReservations] = useState([]);
  const [reservationsTotal, setReservationsTotal] = useState(0);
  const [reservationsHasMore, setReservationsHasMore] = useState(false);
  const [loadingReservations, setLoadingReservations] = useState(false);
  const [reservationSummary, setReservationSummary] = useState({
    pickupsToday: 0,
    returnsToday: 0,
    checkedOut: 0,
    feeAdvisories: 0,
    noShows: 0,
    nextItems: []
  });
  const [customers, setCustomers] = useState([]);
  const [locations, setLocations] = useState([]);
  const [vehicleTypes, setVehicleTypes] = useState([]);
  const [tenantRows, setTenantRows] = useState([]);
  const [activeTenantId, setActiveTenantId] = useState('');
  const [services, setServices] = useState([]);
  const [fees, setFees] = useState([]);
  const [insurancePlans, setInsurancePlans] = useState([]);
  const [supportLoaded, setSupportLoaded] = useState(false);
  const [loadingSupport, setLoadingSupport] = useState(false);
  const [selectedServiceIds, setSelectedServiceIds] = useState([]);
  const [selectedFeeIds, setSelectedFeeIds] = useState([]);
  const [selectedInsuranceCode, setSelectedInsuranceCode] = useState('');
  const [searchDraft, setSearchDraft] = useState('');
  const [query, setQuery] = useState('');
  const [msg, setMsg] = useState('');
  const [createOpen, setCreateOpen] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const [importStep, setImportStep] = useState(1);
  const [importRows, setImportRows] = useState([]);
  const [importReport, setImportReport] = useState(null);
  const [validatingImport, setValidatingImport] = useState(false);
  const [importingRows, setImportingRows] = useState(false);
  const [rateError, setRateError] = useState('');
  const [addingCustomer, setAddingCustomer] = useState(false);
  const [newCustomer, setNewCustomer] = useState({ firstName: '', lastName: '', phone: '', email: '' });
  const [createForm, setCreateForm] = useState({ reservationNumber: '', customerId: '', vehicleTypeId: '', pickupAt: '', returnAt: '', pickupLocationId: '', returnLocationId: '', dailyRate: '', estimatedTotal: '', notes: '' });

  const hasFeeAdvisory = (notes) => /\[FEE_ADVISORY_OPEN\s+/i.test(String(notes || ''));

  const scopedPath = (path) => {
    if (!isSuper || !activeTenantId) return path;
    const joiner = path.includes('?') ? '&' : '?';
    return `${path}${joiner}tenantId=${encodeURIComponent(activeTenantId)}`;
  };

  const clearSupportData = () => {
    setCustomers([]);
    setLocations([]);
    setVehicleTypes([]);
    setServices([]);
    setFees([]);
    setInsurancePlans([]);
    setSupportLoaded(false);
  };

  const loadReservations = async ({ offset = 0, append = false, nextQuery = query } = {}) => {
    if (isSuper && !activeTenantId) {
      setReservations([]);
      setReservationsTotal(0);
      setReservationsHasMore(false);
      return;
    }
    setLoadingReservations(true);
    const params = new URLSearchParams({
      limit: String(RESERVATION_PAGE_SIZE),
      offset: String(offset)
    });
    if (nextQuery) params.set('q', nextQuery);
    try {
      const payload = await api(scopedPath(`/api/reservations/page?${params.toString()}`), {}, token);
      const nextRows = Array.isArray(payload?.rows) ? payload.rows : [];
      setReservations((prev) => append ? [...prev, ...nextRows] : nextRows);
      setReservationsTotal(Number(payload?.total || nextRows.length || 0));
      setReservationsHasMore(!!payload?.hasMore);
      setMsg('');
    } catch (error) {
      if (!append) {
        setReservations([]);
        setReservationsTotal(0);
        setReservationsHasMore(false);
      }
      setMsg(error?.message || 'Unable to load reservations');
    } finally {
      setLoadingReservations(false);
    }
  };

  const loadReservationSummary = async () => {
    if (isSuper && !activeTenantId) {
      setReservationSummary({
        pickupsToday: 0,
        returnsToday: 0,
        checkedOut: 0,
        feeAdvisories: 0,
        noShows: 0,
        nextItems: []
      });
      return;
    }
    try {
      const payload = await api(scopedPath('/api/reservations/summary'), {}, token);
      setReservationSummary({
        pickupsToday: Number(payload?.pickupsToday || 0),
        returnsToday: Number(payload?.returnsToday || 0),
        checkedOut: Number(payload?.checkedOut || 0),
        feeAdvisories: Number(payload?.feeAdvisories || 0),
        noShows: Number(payload?.noShows || 0),
        nextItems: Array.isArray(payload?.nextItems) ? payload.nextItems : []
      });
    } catch {
      setReservationSummary({
        pickupsToday: 0,
        returnsToday: 0,
        checkedOut: 0,
        feeAdvisories: 0,
        noShows: 0,
        nextItems: []
      });
    }
  };

  const loadSupportData = async () => {
    if (!canCreateReservation || supportLoaded || loadingSupport) return;
    if (isSuper && !activeTenantId) return;

    setLoadingSupport(true);
    try {
      const results = await Promise.allSettled([
        api(scopedPath(`/api/customers?limit=${CUSTOMER_PICKER_LIMIT}`), {}, token),
        api(scopedPath('/api/reservations/create-options'), {}, token)
      ]);

      const [c, createOptions] = results;
      if (c.status === 'fulfilled') setCustomers(c.value || []);
      else setCustomers([]);
      if (createOptions.status === 'fulfilled') {
        const payload = createOptions.value || {};
        setLocations(Array.isArray(payload.locations) ? payload.locations : []);
        setVehicleTypes(Array.isArray(payload.vehicleTypes) ? payload.vehicleTypes : []);
        setServices(Array.isArray(payload.services) ? payload.services : []);
        setFees(Array.isArray(payload.fees) ? payload.fees.filter((x) => x?.isActive !== false) : []);
        setInsurancePlans(Array.isArray(payload.insurancePlans) ? payload.insurancePlans : []);
      } else {
        setLocations([]);
        setVehicleTypes([]);
        setServices([]);
        setFees([]);
        setInsurancePlans([]);
      }

      const failures = results.filter((row) => row.status === 'rejected');
      if (failures.length) setMsg('Supporting reservation setup data loaded with some limits');
      setSupportLoaded(true);
    } finally {
      setLoadingSupport(false);
    }
  };
  useEffect(() => {
    if (!isSuper) return;
    api('/api/tenants', {}, token)
      .then((rows) => {
        const nextRows = Array.isArray(rows) ? rows : [];
        setTenantRows(nextRows);
        if (!activeTenantId && nextRows[0]?.id) setActiveTenantId(nextRows[0].id);
      })
      .catch((error) => setMsg(error.message));
  }, [token, isSuper]);
  useEffect(() => {
    const handle = setTimeout(() => setQuery(searchDraft.trim()), 250);
    return () => clearTimeout(handle);
  }, [searchDraft]);
  useEffect(() => { clearSupportData(); }, [token, isSuper, activeTenantId, canCreateReservation]);
  useEffect(() => { loadReservations({ offset: 0, append: false, nextQuery: query }); }, [token, isSuper, activeTenantId, query]);
  useEffect(() => { loadReservationSummary(); }, [token, isSuper, activeTenantId]);
  useEffect(() => {
    if (!createOpen && !showImport) return;
    loadSupportData();
  }, [createOpen, showImport, token, isSuper, activeTenantId, canCreateReservation]);

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
        const out = await api(scopedPath(`/api/rates/resolve?${q.toString()}`), {}, token);
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
      await api(scopedPath(`/api/reservations/${id}`), { method: 'PATCH', body: JSON.stringify({ status }) }, token);
      setMsg(status === 'CANCELLED' ? 'Reservation cancelled' : status === 'NO_SHOW' ? 'Reservation marked as no show' : 'Status updated');
      await loadReservations({ offset: 0, nextQuery: query });
      await loadReservationSummary();
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
      const created = await api(scopedPath('/api/customers'), {
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

      await api(scopedPath('/api/reservations'), {
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
      await loadReservations({ offset: 0, nextQuery: query });
      await loadReservationSummary();
    } catch (e) {
      setMsg(e.message);
    }
  };

  const downloadImportTemplate = () => {
    const sampleTenantSlug = me?.tenantId ? '' : 'tenantSlug,';
    const sampleTenantValue = me?.tenantId ? '' : 'demo,';
    const samplePickupCode = locations[0]?.code || 'SJU';
    const sampleReturnCode = locations[1]?.code || samplePickupCode;
    const sampleVehicleTypeCode = vehicleTypes[0]?.code || 'ECON';
    const csv = `${sampleTenantSlug}reservationNumber,sourceRef,workflowMode,status,paymentStatus,customerFirstName,customerLastName,customerEmail,customerPhone,vehicleTypeCode,AssignedVehicleLicensePlate,pickupAt,returnAt,pickupLocationCode,returnLocationCode,dailyRate,estimatedTotal,notes\n${sampleTenantValue}MIG-1001,LEGACY-1001,RENTAL,CONFIRMED,PENDING,Jose,Diaz,jose@example.com,,${sampleVehicleTypeCode},KJU499,2026-03-30T10:00,2026-04-02T10:00,${samplePickupCode},${sampleReturnCode},49.99,149.97,Imported from legacy platform`;
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'reservation_migration_template.csv';
    a.click();
    URL.revokeObjectURL(url);
  };

  const downloadLoanerImportTemplate = () => {
    const sampleTenantSlug = me?.tenantId ? '' : 'tenantSlug,';
    const sampleTenantValue = me?.tenantId ? '' : 'demo,';
    const samplePickupCode = locations[0]?.code || 'SERVICE';
    const sampleReturnCode = locations[1]?.code || samplePickupCode;
    const sampleVehicleTypeCode = vehicleTypes[0]?.code || 'LOANER';
    const csv = `${sampleTenantSlug}reservationNumber,sourceRef,workflowMode,status,paymentStatus,customerFirstName,customerLastName,customerEmail,customerPhone,vehicleTypeCode,vehicleInternalNumber,pickupAt,returnAt,pickupLocationCode,returnLocationCode,dailyRate,estimatedTotal,loanerBillingMode,repairOrderNumber,claimNumber,serviceAdvisorName,serviceAdvisorEmail,serviceAdvisorPhone,serviceStartAt,estimatedServiceCompletionAt,serviceVehicleYear,serviceVehicleMake,serviceVehicleModel,serviceVehiclePlate,serviceVehicleVin,loanerProgramNotes,notes\n${sampleTenantValue}LN-2001,BLUEBIRD-2001,DEALERSHIP_LOANER,CONFIRMED,PENDING,Maria,Rivera,maria@example.com,7875550111,${sampleVehicleTypeCode},,2026-03-30T09:00,2026-04-03T17:00,${samplePickupCode},${sampleReturnCode},0,0,WARRANTY,RO-22091,CLM-99123,Carlos Vega,cvega@dealer.com,7875550199,2026-03-30T08:30,2026-04-03T16:30,2023,Toyota,RAV4,JVX123,2T3R1RFV0PW123456,Imported dealership loaner reservation,Imported from prior loaner platform`;
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'loaner_reservation_migration_template.csv';
    a.click();
    URL.revokeObjectURL(url);
  };

  const onSelectImportFile = async (file) => {
    if (!file) return;
    const text = await file.text();
    setImportRows(parseCsv(text));
  };

  const validateImport = async () => {
    setValidatingImport(true);
    setImportReport(null);
    try {
      const report = await api(scopedPath('/api/reservations/bulk/validate'), {
        method: 'POST',
        body: JSON.stringify({ rows: importRows })
      }, token);
      setImportReport(report);
    } catch (e) {
      setMsg(e.message);
    } finally {
      setValidatingImport(false);
    }
  };

  const proceedImport = async () => {
    setImportingRows(true);
    try {
      const out = await api(scopedPath('/api/reservations/bulk/import'), {
        method: 'POST',
        body: JSON.stringify({ rows: importRows })
      }, token);
      setMsg(`Migration upload successful. Created ${out.created}, skipped ${out.skipped}.`);
      setShowImport(false);
      setImportStep(1);
      setImportRows([]);
      setImportReport(null);
      await loadReservations({ offset: 0, nextQuery: query });
      await loadReservationSummary();
    } catch (e) {
      setMsg(e.message);
    } finally {
      setImportingRows(false);
    }
  };

  const resetImportWizard = () => {
    setImportStep(1);
    setImportRows([]);
    setImportReport(null);
  };

  const rows = reservations;

  const reservationShiftSummary = reservationSummary;

  const activeTenant = tenantRows.find((tenant) => tenant.id === activeTenantId) || null;

  return (
    <AppShell me={me} logout={logout}>
      <section className="glass card-lg section-card" style={{ marginBottom: 16 }}>
        <div className="app-banner">
          <div className="row-between" style={{ alignItems: 'start', marginBottom: 0 }}>
            <div>
              <span className="eyebrow">Reservation Shift Board</span>
              <h2 className="page-title" style={{ marginTop: 6 }}>
                Keep pickups, returns, and booking follow-up in view.
              </h2>
              <p className="ui-muted">A compact operations board for counter staff before diving into the full reservation table.</p>
            </div>
            <span className="status-chip neutral">Mobile Ops</span>
          </div>
          {isSuper ? (
            <div className="form-grid-2" style={{ marginTop: 16, marginBottom: 8 }}>
              <div className="stack">
                <label className="label">Reservation Tenant Scope</label>
                <select value={activeTenantId} onChange={(e) => setActiveTenantId(e.target.value)}>
                  {tenantRows.map((tenant) => (
                    <option key={tenant.id} value={tenant.id}>{tenant.name} ({tenant.slug})</option>
                  ))}
                </select>
              </div>
              <div className="info-tile">
                <span className="label">Focused Tenant</span>
                <strong>{activeTenant?.name || 'Select tenant'}</strong>
                <span className="ui-muted">{activeTenant?.slug || 'Reservations, create flow, and imports now follow this scope.'}</span>
              </div>
            </div>
          ) : null}
          <div className="app-card-grid compact">
            <div className="info-tile">
              <span className="label">Pickups Today</span>
              <strong>{reservationShiftSummary.pickupsToday}</strong>
              <span className="ui-muted">Reservations scheduled to go out today.</span>
            </div>
            <div className="info-tile">
              <span className="label">Returns Today</span>
              <strong>{reservationShiftSummary.returnsToday}</strong>
              <span className="ui-muted">Bookings due back today across the board.</span>
            </div>
            <div className="info-tile">
              <span className="label">Checked Out</span>
              <strong>{reservationShiftSummary.checkedOut}</strong>
              <span className="ui-muted">Reservations currently out and active.</span>
            </div>
            <div className="info-tile">
              <span className="label">Fee Advisories</span>
              <strong>{reservationShiftSummary.feeAdvisories}</strong>
              <span className="ui-muted">Bookings that still have advisory follow-up attached.</span>
            </div>
          </div>
          {reservationShiftSummary.nextItems.length ? (
            <div className="app-card-grid compact">
              {reservationShiftSummary.nextItems.map((item) => (
                <section key={item.id} className="glass card section-card">
                  <div className="section-title" style={{ fontSize: 15 }}>{item.title}</div>
                  <div className="ui-muted">{item.detail}</div>
                  <div className="surface-note">{item.note}</div>
                  <div className="inline-actions">
                    <Link href={item.href}><button type="button">{item.actionLabel}</button></Link>
                  </div>
                </section>
              ))}
            </div>
          ) : null}
        </div>
      </section>
      <section className="glass card-lg">
        <div className="row-between">
          <h2>Reservations</h2>
          <div style={{ display: 'flex', gap: 8 }}>
            <input
              placeholder="Search reservation/customer"
              value={searchDraft}
              onChange={(e) => setSearchDraft(e.target.value)}
            />
            {canManageReservationSetup ? <button onClick={() => setShowImport(true)}>{loadingSupport && !supportLoaded ? 'Loading...' : 'Upload Migration'}</button> : null}
            {canCreateReservation ? (
              <button onClick={() => {
                setCreateOpen(true);
                setSelectedServiceIds([]);
                setSelectedFeeIds([]);
                setSelectedInsuranceCode('');
                setRateError('');
                setAddingCustomer(false);
                setNewCustomer({ firstName: '', lastName: '', phone: '', email: '' });
              }}
              >
                {loadingSupport && !supportLoaded ? 'Loading...' : 'New Reservation'}
              </button>
            ) : null}
          </div>
        </div>
        {msg ? <p className="label">{msg}</p> : null}
        <p className="label">
          Showing {rows.length} of {reservationsTotal} reservations{loadingReservations ? ' - loading...' : ''}.
        </p>
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
        {reservationsHasMore ? (
          <div style={{ display: 'flex', justifyContent: 'center', marginTop: 12 }}>
            <button type="button" onClick={() => loadReservations({ offset: rows.length, append: true, nextQuery: query })} disabled={loadingReservations}>
              {loadingReservations ? 'Loading...' : 'Load More'}
            </button>
          </div>
        ) : null}
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

      {showImport && (
        <div className="modal-backdrop" onClick={() => { setShowImport(false); resetImportWizard(); }}>
          <div className="rent-modal glass" style={{ width: 'min(820px, 95vw)' }} onClick={(e) => e.stopPropagation()}>
            <h3>Upload Reservation Migration</h3>

            {importStep === 1 && (
              <div className="stack">
                <p className="label">Step 1: Review instructions</p>
                <ul>
                  <li>Use CSV format exported from the legacy platform.</li>
                  <li>Required columns: <code>reservationNumber</code>, <code>pickupAt</code>, <code>returnAt</code>, <code>pickupLocationCode</code>, <code>returnLocationCode</code>.</li>
                  <li>Identify the customer with <code>customerId</code>, <code>customerEmail</code>, <code>customerPhone</code>, or provide <code>customerFirstName</code> and <code>customerLastName</code> so Ride Fleet can create the customer.</li>
                  <li><code>customerEmail</code> and <code>customerPhone</code> may be blank in migration uploads.</li>
                  <li>Use <code>AssignedVehicleLicensePlate</code> to assign the reservation to a vehicle by plate number.</li>
                  <li>Recommended columns: <code>sourceRef</code>, <code>vehicleTypeCode</code>, <code>AssignedVehicleLicensePlate</code>, <code>dailyRate</code>, <code>estimatedTotal</code>, <code>notes</code>.</li>
                  <li>For dealership migrations, use the loaner template and include <code>workflowMode=DEALERSHIP_LOANER</code>, plus advisor and RO/claim fields.</li>
                  {!me?.tenantId ? <li>For super admin imports, include <code>tenantSlug</code> in every row.</li> : null}
                  <li>Duplicate reservation numbers or source refs are skipped.</li>
                </ul>
                <div style={{ display: 'flex', gap: 8 }}>
                  <button type="button" onClick={downloadImportTemplate}>Download Template</button>
                  <button type="button" className="button-subtle" onClick={downloadLoanerImportTemplate}>Download Loaner Template</button>
                  <button type="button" onClick={() => setImportStep(2)}>Next</button>
                </div>
              </div>
            )}

            {importStep === 2 && (
              <div className="stack">
                <p className="label">Step 2: Upload file and validate</p>
                <input type="file" accept=".csv,text/csv" onChange={(e) => onSelectImportFile(e.target.files?.[0])} />
                <p className="label">Rows loaded: {importRows.length}</p>
                <div style={{ display: 'flex', gap: 8 }}>
                  <button type="button" onClick={resetImportWizard}>Try again</button>
                  <button type="button" onClick={validateImport} disabled={!importRows.length || validatingImport}>{validatingImport ? 'Validating…' : 'Validate'}</button>
                </div>
              </div>
            )}

            {importReport && (
              <div className="stack" style={{ marginTop: 12 }}>
                <p><strong>Validation report</strong></p>
                <p className="label">Found: {importReport.found} · Valid: {importReport.valid} · Invalid: {importReport.invalid}</p>
                <div style={{ maxHeight: 180, overflow: 'auto', border: '1px solid #eee8ff', borderRadius: 8, padding: 8 }}>
                  {importReport.rows.slice(0, 60).map((row) => (
                    <div key={row.row} className="label" style={{ marginBottom: 6 }}>
                      Row {row.row}: {row.valid ? `valid${row.customerAction === 'create' ? ' · creates customer' : ''}` : row.errors.join(', ')}
                    </div>
                  ))}
                </div>
                <div style={{ display: 'flex', gap: 8 }}>
                  <button type="button" onClick={resetImportWizard}>Try again</button>
                  <button type="button" onClick={proceedImport} disabled={importReport.valid === 0 || importingRows}>{importingRows ? 'Uploading…' : 'Proceed with Upload'}</button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </AppShell>
  );
}
