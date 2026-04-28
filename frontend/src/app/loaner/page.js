'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { AuthGate } from '../../components/AuthGate';
import { AppShell } from '../../components/AppShell';
import { api, API_BASE } from '../../lib/client';

const EMPTY_FORM = {
  customerId: '',
  firstName: '',
  lastName: '',
  email: '',
  phone: '',
  vehicleId: '',
  vehicleTypeId: '',
  pickupAt: '',
  returnAt: '',
  pickupLocationId: '',
  returnLocationId: '',
  loanerBillingMode: 'COURTESY',
  repairOrderNumber: '',
  claimNumber: '',
  serviceAdvisorName: '',
  serviceAdvisorEmail: '',
  serviceAdvisorPhone: '',
  serviceVehicleYear: '',
  serviceVehicleMake: '',
  serviceVehicleModel: '',
  serviceVehiclePlate: '',
  serviceVehicleVin: '',
  notes: '',
  loanerProgramNotes: '',
  loanerLiabilityAccepted: false,
  serviceAdvisorNotes: ''
};

const LOANER_SEARCH_KEY = 'loaner.search';
const LOANER_QUEUE_FOCUS_KEY = 'loaner.queueFocus';
const LOANER_EXPORT_FILTERS_KEY = 'loaner.exportFilters';
const LOANER_INTAKE_FORM_KEY = 'loaner.intakeForm';

// Small inline accent marking a required form field. Inline-style to avoid
// touching globals.css; matches the rest of the page's inline-style approach.
function RequiredMark() {
  return (
    <span
      aria-hidden="true"
      title="Required"
      style={{ color: '#dc2626', marginLeft: 4, fontWeight: 700 }}
    >
      *
    </span>
  );
}

// Skeleton placeholder for the initial dashboard fetch. Avoids the
// "blank cards for 1-3s" feel on slow networks.
function SkeletonCard({ height = 64, lines = 1 }) {
  return (
    <div
      style={{
        display: 'grid',
        gap: 8,
        padding: 14,
        borderRadius: 16,
        background: 'rgba(102,79,177,0.04)',
        border: '1px solid rgba(102,79,177,0.10)'
      }}
    >
      {Array.from({ length: lines }).map((_, i) => (
        <div
          key={i}
          style={{
            height: height / Math.max(1, lines) - 4,
            borderRadius: 8,
            background:
              'linear-gradient(90deg, rgba(102,79,177,0.10), rgba(102,79,177,0.18), rgba(102,79,177,0.10))',
            backgroundSize: '200% 100%',
            animation: 'loaner-skeleton-shimmer 1.4s ease-in-out infinite'
          }}
        />
      ))}
    </div>
  );
}

// Inject the keyframes once. Idempotent — only runs in the browser, only adds
// the rule if it doesn't already exist.
if (typeof document !== 'undefined' && !document.getElementById('loaner-skeleton-keyframes')) {
  const style = document.createElement('style');
  style.id = 'loaner-skeleton-keyframes';
  style.textContent = `@keyframes loaner-skeleton-shimmer { 0% { background-position: 200% 0; } 100% { background-position: -200% 0; } }`;
  document.head.appendChild(style);
}

function restoreLoanerExportFilters() {
  if (typeof window === 'undefined') {
    return {
      billingStatus: '',
      billingMode: '',
      startDate: '',
      endDate: ''
    };
  }
  try {
    const raw = localStorage.getItem(LOANER_EXPORT_FILTERS_KEY);
    if (!raw) {
      return {
        billingStatus: '',
        billingMode: '',
        startDate: '',
        endDate: ''
      };
    }
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') {
      return {
        billingStatus: '',
        billingMode: '',
        startDate: '',
        endDate: ''
      };
    }
    return {
      billingStatus: typeof parsed.billingStatus === 'string' ? parsed.billingStatus : '',
      billingMode: typeof parsed.billingMode === 'string' ? parsed.billingMode : '',
      startDate: typeof parsed.startDate === 'string' ? parsed.startDate : '',
      endDate: typeof parsed.endDate === 'string' ? parsed.endDate : ''
    };
  } catch {
    return {
      billingStatus: '',
      billingMode: '',
      startDate: '',
      endDate: ''
    };
  }
}

function restoreLoanerForm() {
  if (typeof window === 'undefined') return EMPTY_FORM;
  try {
    const raw = localStorage.getItem(LOANER_INTAKE_FORM_KEY);
    if (!raw) return EMPTY_FORM;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return EMPTY_FORM;
    return {
      ...EMPTY_FORM,
      ...parsed,
      loanerLiabilityAccepted: !!parsed.loanerLiabilityAccepted
    };
  } catch {
    return EMPTY_FORM;
  }
}

function formatDateTime(value) {
  if (!value) return '-';
  try {
    return new Date(value).toLocaleString();
  } catch {
    return String(value);
  }
}

function formatMoney(value) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(Number(value || 0));
}

function customerName(row) {
  return [row?.customer?.firstName, row?.customer?.lastName].filter(Boolean).join(' ') || row?.customer?.email || 'Customer';
}

function serviceVehicleLabel(row) {
  return [row?.serviceVehicle?.year, row?.serviceVehicle?.make, row?.serviceVehicle?.model, row?.serviceVehicle?.plate].filter(Boolean).join(' · ') || 'No service vehicle info';
}

function reservationHref(row, action = '') {
  if (!row?.id) return '#';
  return action ? `/reservations/${row.id}/${action}` : `/reservations/${row.id}`;
}

function loanerBoardNote(row) {
  if (!row) return '';
  if (row.alertReason) return row.alertReason;
  if (row.loanerReturnExceptionFlag) return 'Return exception flagged';
  if (!row.loanerBorrowerPacketCompletedAt) return 'Borrower packet still pending';
  if (String(row.loanerBillingStatus || 'DRAFT').toUpperCase() !== 'SETTLED') return `${row.loanerBillingStatus || 'Draft'} billing status`;
  return 'Service lane follow-up needed';
}

export default function LoanerProgramPage() {
  return <AuthGate>{({ token, me, logout }) => <LoanerProgramInner token={token} me={me} logout={logout} />}</AuthGate>;
}

function LoanerProgramInner({ token, me, logout }) {
  const [dashboard, setDashboard] = useState(null);
  const [config, setConfig] = useState({ enabled: true });
  const [customers, setCustomers] = useState([]);
  const [locations, setLocations] = useState([]);
  const [vehicleTypes, setVehicleTypes] = useState([]);
  const [vehicles, setVehicles] = useState([]);
  const [search, setSearch] = useState(() => {
    if (typeof window === 'undefined') return '';
    try { return localStorage.getItem(LOANER_SEARCH_KEY) || ''; } catch { return ''; }
  });
  const [exportFilters, setExportFilters] = useState(() => restoreLoanerExportFilters());
  const [queueFocus, setQueueFocus] = useState(() => {
    if (typeof window === 'undefined') return 'ALL';
    try { return localStorage.getItem(LOANER_QUEUE_FOCUS_KEY) || 'ALL'; } catch { return 'ALL'; }
  });
  const [msg, setMsg] = useState('');
  const [loading, setLoading] = useState(true);
  const [form, setForm] = useState(() => restoreLoanerForm());
  // Track in-flight async actions so we can disable their buttons + flip labels.
  // Prevents double-submits on intake / double-downloads on exports / double-popups on print.
  const [submitting, setSubmitting] = useState(false);
  const [exportingBilling, setExportingBilling] = useState(false);
  const [exportingStatement, setExportingStatement] = useState(false);
  const [printing, setPrinting] = useState(false);

  const metrics = dashboard?.metrics || {
    openLoaners: 0,
    activeLoaners: 0,
    pickupsToday: 0,
    dueBackToday: 0,
    readyForDelivery: 0,
    packetPending: 0,
    billingAttention: 0,
    returnExceptions: 0,
    overdueReturns: 0,
    serviceDelays: 0
  };

  async function load(query = '') {
    try {
      setLoading(true);
      const configOut = await api('/api/dealership-loaner/config', {}, token);
      setConfig(configOut || { enabled: false });

      const role = String(me?.role || '').toUpperCase();
      if (!configOut?.enabled && role !== 'SUPER_ADMIN') {
        setDashboard(null);
        setCustomers([]);
        setLocations([]);
        setVehicleTypes([]);
        setVehicles([]);
        setMsg('');
        return;
      }

      const [dashOut, intakeOptions] = await Promise.all([
        api(`/api/dealership-loaner/dashboard${query ? `?q=${encodeURIComponent(query)}` : ''}`, {}, token),
        api('/api/dealership-loaner/intake-options', {}, token)
      ]);
      setDashboard(dashOut);
      setCustomers(Array.isArray(intakeOptions?.customers) ? intakeOptions.customers : []);
      setLocations(Array.isArray(intakeOptions?.locations) ? intakeOptions.locations : []);
      setVehicleTypes(Array.isArray(intakeOptions?.vehicleTypes) ? intakeOptions.vehicleTypes : []);
      setVehicles(Array.isArray(intakeOptions?.vehicles) ? intakeOptions.vehicles : []);
      setMsg('');
    } catch (error) {
      setMsg(error.message);
      setDashboard(null);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load(search.trim());
  }, [token]);
  useEffect(() => {
    try {
      if (search) localStorage.setItem(LOANER_SEARCH_KEY, search);
      else localStorage.removeItem(LOANER_SEARCH_KEY);
    } catch {}
  }, [search]);
  useEffect(() => {
    try {
      if (queueFocus && queueFocus !== 'ALL') localStorage.setItem(LOANER_QUEUE_FOCUS_KEY, queueFocus);
      else localStorage.removeItem(LOANER_QUEUE_FOCUS_KEY);
    } catch {}
  }, [queueFocus]);
  useEffect(() => {
    try {
      const hasFilters = Object.values(exportFilters).some((value) => value);
      if (hasFilters) localStorage.setItem(LOANER_EXPORT_FILTERS_KEY, JSON.stringify(exportFilters));
      else localStorage.removeItem(LOANER_EXPORT_FILTERS_KEY);
    } catch {}
  }, [exportFilters]);
  useEffect(() => {
    try {
      const hasDraft = Object.entries(form).some(([key, value]) => {
        if (key === 'loanerBillingMode') return value && value !== EMPTY_FORM.loanerBillingMode;
        if (key === 'loanerLiabilityAccepted') return !!value;
        return !!value;
      });
      if (hasDraft) localStorage.setItem(LOANER_INTAKE_FORM_KEY, JSON.stringify(form));
      else localStorage.removeItem(LOANER_INTAKE_FORM_KEY);
    } catch {}
  }, [form]);

  const selectedCustomer = useMemo(() => {
    if (!form.customerId) return null;
    return customers.find((row) => row.id === form.customerId) || null;
  }, [customers, form.customerId]);

  const loanerReady = useMemo(() => {
    const hasCustomer = form.customerId || (form.firstName && form.lastName && form.phone);
    return !!(
      hasCustomer &&
      form.vehicleTypeId &&
      form.pickupAt &&
      form.returnAt &&
      form.pickupLocationId &&
      form.returnLocationId &&
      form.loanerLiabilityAccepted
    );
  }, [form]);

  const visibleVehicles = useMemo(() => {
    return vehicles.filter((row) => {
      if (!row?.id) return false;
      if (row.status && ['IN_MAINTENANCE', 'OUT_OF_SERVICE'].includes(String(row.status).toUpperCase())) return false;
      return true;
    });
  }, [vehicles]);

  const serviceLanePriorityItems = useMemo(() => {
    const items = [];
    const queues = dashboard?.queues || {};
    const addItem = (row, config) => {
      if (!row?.id) return;
      items.push({
        id: `${config.key}-${row.id}`,
        title: config.title,
        detail: `${row.reservationNumber} - ${customerName(row)}`,
        note: config.note?.(row) || loanerBoardNote(row),
        tone: config.tone,
        href: reservationHref(row, config.action || ''),
        actionLabel: config.actionLabel,
        secondaryHref: reservationHref(row),
        secondaryLabel: 'Open Workflow'
      });
    };

    addItem(queues.intake?.[0], {
      key: 'delivery',
      title: 'Next Delivery',
      tone: 'good',
      action: 'checkout',
      actionLabel: 'Checkout',
      note: (row) => `Pickup ${formatDateTime(row.pickupAt)} - ${row.pickupLocation?.name || 'Location pending'}`
    });
    addItem(queues.returns?.[0], {
      key: 'return',
      title: 'Next Return',
      tone: 'warn',
      action: 'checkin',
      actionLabel: 'Check-in',
      note: (row) => `Return ${formatDateTime(row.returnAt)} - ${row.pickupLocation?.name || 'Location pending'}`
    });
    addItem(queues.billing?.[0], {
      key: 'billing',
      title: 'Billing Blocker',
      tone: 'warn',
      action: 'payments',
      actionLabel: 'Review Billing',
      note: (row) => `${row.loanerBillingMode || 'Billing'} - ${row.loanerBillingStatus || 'Draft'}`
    });
    addItem(queues.alerts?.[0], {
      key: 'alert',
      title: 'SLA Alert',
      tone: 'warn',
      action: 'checkout',
      actionLabel: 'Handle Alert',
      note: (row) => row.alertReason || loanerBoardNote(row)
    });
    addItem(queues.advisor?.[0], {
      key: 'advisor',
      title: 'Advisor Follow-Up',
      tone: 'neutral',
      action: '',
      actionLabel: 'Open Case',
      note: (row) => row.serviceAdvisorName ? `Advisor ${row.serviceAdvisorName}` : loanerBoardNote(row)
    });

    return items.slice(0, 4);
  }, [dashboard]);

  const shiftSnapshot = useMemo(() => {
    const firstPriority = serviceLanePriorityItems[0] || null;
    return {
      firstPriority,
      openWork: metrics.openLoaners + metrics.packetPending + metrics.billingAttention,
      laneRisk: metrics.overdueReturns + metrics.serviceDelays + metrics.returnExceptions,
      readyToday: metrics.readyForDelivery + metrics.pickupsToday
    };
  }, [metrics, serviceLanePriorityItems]);

  const queueSections = useMemo(() => ([
    {
      key: 'INTAKE',
      title: 'New loaner check-ins',
      subtitle: 'Customers about to take a loaner — finish handoff and get keys in their hands.',
      rows: dashboard?.queues?.intake || [],
      emptyText: 'No loaner check-ins waiting right now.',
      actions: (row) => (
        <>
          <Link href={reservationHref(row)}><button type="button">Open</button></Link>
          <Link href={reservationHref(row, 'checkout')}><button type="button" className="button-subtle">Check out</button></Link>
        </>
      )
    },
    {
      key: 'ACTIVE',
      title: 'Active loaners',
      subtitle: 'Vehicles currently out with customers.',
      rows: dashboard?.queues?.active || [],
      emptyText: 'No active loaners right now.',
      actions: (row) => (
        <>
          <Link href={reservationHref(row)}><button type="button">Open</button></Link>
          <Link href={reservationHref(row, 'payments')}><button type="button" className="button-subtle">Payments</button></Link>
        </>
      )
    },
    {
      key: 'RETURNS',
      title: 'Returns',
      subtitle: 'Loaners coming back — inspect and close out.',
      rows: dashboard?.queues?.returns || [],
      emptyText: 'No returns waiting right now.',
      actions: (row) => (
        <>
          <Link href={reservationHref(row, 'checkin')}><button type="button">Check in</button></Link>
          <Link href={reservationHref(row, 'inspection')}><button type="button" className="button-subtle">Inspect</button></Link>
        </>
      )
    },
    {
      key: 'ADVISOR',
      title: 'Service advisor follow-up',
      subtitle: 'Need lane guidance, customer-agreement progress, or ready-for-pickup approval.',
      rows: dashboard?.queues?.advisor || [],
      emptyText: 'No advisor follow-ups right now.',
      actions: (row) => (
        <>
          <Link href={reservationHref(row)}><button type="button">Open</button></Link>
          <Link href={reservationHref(row, 'checkout')}><button type="button" className="button-subtle">Check out</button></Link>
        </>
      )
    },
    {
      key: 'BILLING',
      title: 'Billing review',
      subtitle: 'Warranty, insurance, and customer-pay loaners still needing billing follow-up.',
      rows: dashboard?.queues?.billing || [],
      emptyText: 'No billing items waiting right now.',
      actions: (row) => (
        <>
          <Link href={reservationHref(row)}><button type="button">Open</button></Link>
          <Link href={reservationHref(row, 'payments')}><button type="button" className="button-subtle">Payments</button></Link>
        </>
      )
    },
    {
      key: 'ALERTS',
      title: 'Overdue and at-risk',
      subtitle: 'Past-due returns, missed service ETAs, and denied billing — act now.',
      rows: dashboard?.queues?.alerts || [],
      emptyText: 'No overdue or at-risk loaners right now.',
      actions: (row) => (
        <>
          <Link href={reservationHref(row)}><button type="button">Open</button></Link>
          <Link href={reservationHref(row, row.overdueReturn ? 'checkin' : 'checkout')}><button type="button" className="button-subtle">{row.overdueReturn ? 'Check in' : 'Check out'}</button></Link>
        </>
      )
    }
  ]), [dashboard]);

  const visibleQueueSections = useMemo(() => {
    if (queueFocus === 'ALL') return queueSections;
    return queueSections.filter((section) => section.key === queueFocus);
  }, [queueFocus, queueSections]);

  async function createLoaner(event) {
    event.preventDefault();

    // Build a named-fields validation error so the user knows EXACTLY what's
    // missing instead of a generic "complete the required fields" hint.
    if (!loanerReady) {
      const missing = [];
      if (!selectedCustomer && !(form.firstName && form.lastName && form.phone)) {
        missing.push('Customer (pick existing or fill first name + last name + phone)');
      }
      if (!form.vehicleTypeId) missing.push('Vehicle Type');
      if (!form.pickupAt) missing.push('Pickup date/time');
      if (!form.returnAt) missing.push('Return date/time');
      if (!form.pickupLocationId || !form.returnLocationId) missing.push('Pickup + Return locations');
      if (!form.loanerLiabilityAccepted) missing.push('Liability acceptance checkbox');
      setMsg(
        missing.length
          ? `Please complete: ${missing.join(' · ')}`
          : 'Complete the required loaner intake fields first.'
      );
      return;
    }

    setSubmitting(true);
    try {
      const payload = await api('/api/dealership-loaner/intake', {
        method: 'POST',
        body: JSON.stringify({
          ...form,
          serviceVehicleYear: form.serviceVehicleYear ? Number(form.serviceVehicleYear) : null
        })
      }, token);
      setMsg(`Loaner reservation ${payload?.reservationNumber || ''} created`);
      setForm(EMPTY_FORM);
      try { localStorage.removeItem(LOANER_INTAKE_FORM_KEY); } catch {}
      setSearch(payload?.reservationNumber || '');
      await load(payload?.reservationNumber || '');
    } catch (error) {
      setMsg(error.message);
    } finally {
      setSubmitting(false);
    }
  }

  function applyQuickWindow(days = 3) {
    const pickup = new Date();
    pickup.setMinutes(0, 0, 0);
    pickup.setHours(pickup.getHours() + 1);
    const ret = new Date(pickup.getTime() + days * 24 * 60 * 60 * 1000);
    setForm((current) => ({
      ...current,
      pickupAt: pickup.toISOString().slice(0, 16),
      returnAt: ret.toISOString().slice(0, 16)
    }));
  }

  async function runSearch() {
    await load(search.trim());
  }

  async function exportBillingCsv() {
    if (exportingBilling) return;
    setExportingBilling(true);
    try {
      const query = new URLSearchParams();
      if (search.trim()) query.set('q', search.trim());
      if (exportFilters.billingStatus) query.set('billingStatus', exportFilters.billingStatus);
      if (exportFilters.billingMode) query.set('billingMode', exportFilters.billingMode);
      if (exportFilters.startDate) query.set('startDate', exportFilters.startDate);
      if (exportFilters.endDate) query.set('endDate', exportFilters.endDate);
      const res = await fetch(`${API_BASE}/api/dealership-loaner/billing-export${query.toString() ? `?${query.toString()}` : ''}`, {
        headers: { Authorization: `Bearer ${token}` },
        cache: 'no-store'
      });
      if (!res.ok) throw new Error(`Billing export failed (${res.status})`);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = 'loaner-billing-export.csv';
      anchor.click();
      URL.revokeObjectURL(url);
      setMsg('Loaner billing export downloaded');
    } catch (error) {
      setMsg(error.message);
    } finally {
      setExportingBilling(false);
    }
  }

  function buildStatementQuery() {
    const query = new URLSearchParams();
    if (search.trim()) query.set('q', search.trim());
    if (exportFilters.billingStatus) query.set('billingStatus', exportFilters.billingStatus);
    if (exportFilters.billingMode) query.set('billingMode', exportFilters.billingMode);
    if (exportFilters.startDate) query.set('startDate', exportFilters.startDate);
    if (exportFilters.endDate) query.set('endDate', exportFilters.endDate);
    return query;
  }

  async function exportStatementCsv() {
    if (exportingStatement) return;
    setExportingStatement(true);
    try {
      const query = buildStatementQuery();
      const res = await fetch(`${API_BASE}/api/dealership-loaner/statement-export${query.toString() ? `?${query.toString()}` : ''}`, {
        headers: { Authorization: `Bearer ${token}` },
        cache: 'no-store'
      });
      if (!res.ok) throw new Error(`Statement export failed (${res.status})`);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = 'loaner-dealer-statement.csv';
      anchor.click();
      URL.revokeObjectURL(url);
      setMsg('Dealer statement export downloaded');
    } catch (error) {
      setMsg(error.message);
    } finally {
      setExportingStatement(false);
    }
  }

  async function printStatementPacket() {
    if (printing) return;
    setPrinting(true);
    const printWindow = window.open('', '_blank');
    if (!printWindow) {
      setMsg('Pop-up blocked. Please allow pop-ups to print the dealer statement.');
      setPrinting(false);
      return;
    }
    printWindow.opener = null;
    printWindow.document.write('<html><body style="font-family:Inter, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif;padding:32px;text-align:center;background:#0b0a12;color:#fff;">Preparing monthly accounting packet...</body></html>');
    printWindow.document.close();
    try {
      const query = buildStatementQuery();
      const res = await fetch(`${API_BASE}/api/dealership-loaner/statement-print${query.toString() ? `?${query.toString()}` : ''}`, {
        headers: { Authorization: `Bearer ${token}` },
        cache: 'no-store'
      });
      if (!res.ok) throw new Error(`Statement print failed (${res.status})`);
      const html = await res.text();
      printWindow.document.open();
      printWindow.document.write(html);
      printWindow.document.close();
      printWindow.focus();
      printWindow.print();
    } catch (error) {
      printWindow.document.open();
      printWindow.document.write(`<p style="font-family: sans-serif; padding: 24px;">${error.message || 'Unable to print dealer statement'}</p>`);
      printWindow.document.close();
      setMsg(error.message);
    } finally {
      setPrinting(false);
    }
  }

  if (!config?.enabled && String(me?.role || '').toUpperCase() !== 'SUPER_ADMIN') {
    return (
      <AppShell me={me} logout={logout}>
        <section className="glass card-lg section-card">
          <span className="eyebrow">Dealership Loaner</span>
          <h1 className="page-title">Loaner program is not enabled for this tenant.</h1>
          <p className="ui-muted">Turn on the feature in Tenants first, then come back here to start service-lane intake.</p>
        </section>
      </AppShell>
    );
  }

  return (
    <AppShell me={me} logout={logout}>
      <section className="glass card-lg page-hero">
        <div className="hero-grid">
          <div className="hero-copy">
            <span className="eyebrow">Dealership Loaner Foundation</span>
            <h1 className="page-title" style={{ fontSize: 'clamp(30px, 5vw, 54px)', lineHeight: 1.02 }}>
              Service-lane loaners built on the same reservation, agreement, payment, and inspection spine.
            </h1>
            <p>
              This first slice covers intake, repair-order metadata, courtesy and insurance-backed loaners, quick search,
              and direct jump-off into the same operational workflow the rest of the platform already uses.
            </p>
            <div className="hero-meta">
              <span className="hero-pill">Courtesy + customer-pay</span>
              <span className="hero-pill">Repair order tracking</span>
              <span className="hero-pill">Ready for service lane ops</span>
              {(dashboard?.badges || []).map((badge) => (
                <span key={badge.label} className={`hero-pill ${badge.tone === 'warn' ? 'hero-pill-warn' : ''}`} title={badge.detail}>
                  {badge.label}
                </span>
              ))}
            </div>
          </div>
          <div className="glass card section-card">
            <div className="section-title">Loaner Snapshot</div>
            <div className="metric-grid">
              <div className="metric-card"><span className="label">Open Loaners</span><strong>{metrics.openLoaners}</strong></div>
              <div className="metric-card"><span className="label">Active Loaners</span><strong>{metrics.activeLoaners}</strong></div>
              <div className="metric-card"><span className="label">Pickups Today</span><strong>{metrics.pickupsToday}</strong></div>
              <div className="metric-card"><span className="label">Due Back Today</span><strong>{metrics.dueBackToday}</strong></div>
              <div className="metric-card"><span className="label">Packet Pending</span><strong>{metrics.packetPending}</strong></div>
              <div className="metric-card"><span className="label">Billing Attention</span><strong>{metrics.billingAttention}</strong></div>
              <div className="metric-card"><span className="label">Return Exceptions</span><strong>{metrics.returnExceptions}</strong></div>
              <div className="metric-card"><span className="label">Ready For Delivery</span><strong>{metrics.readyForDelivery}</strong></div>
              <div className="metric-card"><span className="label">Overdue Returns</span><strong>{metrics.overdueReturns}</strong></div>
              <div className="metric-card"><span className="label">Service Delays</span><strong>{metrics.serviceDelays}</strong></div>
            </div>
          </div>
        </div>
      </section>

      {msg ? (
        <div className="surface-note" style={{ color: /created|saved|updated/i.test(msg) ? '#166534' : '#991b1b', marginBottom: 18 }}>
          {msg}
        </div>
      ) : null}

      <section className="glass card-lg section-card" style={{ marginBottom: 18 }}>
        <div className="app-banner">
          <div className="row-between" style={{ alignItems: 'start', marginBottom: 0 }}>
            <div>
              <span className="eyebrow">Loaner Shift</span>
              <h2 className="page-title" style={{ marginTop: 6 }}>
                Welcome back{me?.firstName ? `, ${me.firstName}` : ''}. The lane is ready.
              </h2>
              <p className="ui-muted">
                Jump into intake, returns, billing, and statement work without hunting through the full queue.
              </p>
            </div>
            <span className="status-chip neutral">Service Lane Hub</span>
          </div>
          <div className="app-card-grid compact">
            <div className="info-tile">
              <span className="label">Open Work</span>
              <strong>{shiftSnapshot.openWork}</strong>
              <span className="ui-muted">Open loaners, packets, and billing follow-up still in motion.</span>
            </div>
            <div className="info-tile">
              <span className="label">Ready Today</span>
              <strong>{shiftSnapshot.readyToday}</strong>
              <span className="ui-muted">Loaners ready for delivery or scheduled for pickup today.</span>
            </div>
            <div className="info-tile">
              <span className="label">Lane Risk</span>
              <strong>{shiftSnapshot.laneRisk}</strong>
              <span className="ui-muted">Overdues, service delays, and return exceptions needing attention.</span>
            </div>
            <div className="info-tile">
              <span className="label">Top Priority</span>
              <strong>{shiftSnapshot.firstPriority?.title || 'All Clear'}</strong>
              <span className="ui-muted">{shiftSnapshot.firstPriority?.detail || 'No urgent loaner task is ahead of the lane right now.'}</span>
            </div>
          </div>
          <div className="app-banner-list">
            <a href="#loaner-intake" className="app-banner-pill">Open Intake</a>
            <a href="#loaner-lookup" className="app-banner-pill">Loaner Lookup</a>
            <a href="#loaner-queues" className="app-banner-pill">Jump To Queues</a>
            <button type="button" className="button-subtle" onClick={printStatementPacket} disabled={printing}>
              {printing ? 'Preparing packet…' : 'Print Monthly Packet'}
            </button>
          </div>
        </div>
      </section>

      <section className="glass card-lg section-card" style={{ marginBottom: 18 }}>
        <div className="row-between">
          <div>
            <div className="section-title">Service Lane Priority Board</div>
            <p className="ui-muted">The first delivery, return, billing blocker, and SLA risk the lane should touch next.</p>
          </div>
          <span className="status-chip neutral">Mobile Ops</span>
        </div>
        {loading && !dashboard ? (
          <div className="app-card-grid compact" aria-busy="true" aria-label="Loading priority board">
            <SkeletonCard height={88} lines={3} />
            <SkeletonCard height={88} lines={3} />
            <SkeletonCard height={88} lines={3} />
            <SkeletonCard height={88} lines={3} />
            <SkeletonCard height={88} lines={3} />
          </div>
        ) : serviceLanePriorityItems.length ? (
          <div className="app-card-grid compact">
            {serviceLanePriorityItems.map((item) => (
              <section key={item.id} className="glass card section-card">
                <div className="row-between" style={{ alignItems: 'start', marginBottom: 6 }}>
                  <div>
                    <div className="section-title" style={{ fontSize: 15 }}>{item.title}</div>
                    <div className="ui-muted" style={{ marginTop: 4 }}>{item.detail}</div>
                  </div>
                  <span className={`status-chip ${item.tone}`}>{item.title}</span>
                </div>
                <div className="surface-note">{item.note}</div>
                <div className="inline-actions">
                  <Link href={item.href}><button type="button">{item.actionLabel}</button></Link>
                  <Link href={item.secondaryHref}><button type="button" className="button-subtle">{item.secondaryLabel}</button></Link>
                </div>
              </section>
            ))}
          </div>
        ) : (
          <div className="surface-note">No immediate loaner priorities right now. The service lane looks clear.</div>
        )}
      </section>

      <section className="split-panel">
        <section id="loaner-lookup" className="glass card-lg section-card">
          <div className="row-between">
            <div>
              <div className="section-title">Loaner Lookup</div>
              <p className="ui-muted">Search by reservation, RO number, claim, customer, advisor, or service vehicle.</p>
            </div>
            <div className="inline-actions">
              <span className="status-chip neutral">Service Lane</span>
              <button type="button" className="button-subtle" onClick={exportBillingCsv} disabled={exportingBilling}>
                {exportingBilling ? 'Exporting billing…' : 'Export Billing CSV'}
              </button>
              <button type="button" className="button-subtle" onClick={exportStatementCsv} disabled={exportingStatement}>
                {exportingStatement ? 'Exporting statement…' : 'Export Statement CSV'}
              </button>
              <button type="button" className="button-subtle" onClick={printStatementPacket} disabled={printing}>
                {printing ? 'Preparing packet…' : 'Print Monthly Packet'}
              </button>
            </div>
          </div>

          <div className="inline-actions" style={{ alignItems: 'stretch' }}>
            <input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Reservation, RO, claim, customer, vehicle"
              style={{ minWidth: 260, flex: 1 }}
            />
            <button type="button" onClick={runSearch} disabled={loading}>{loading ? 'Loading...' : 'Search'}</button>
            <button type="button" className="button-subtle" onClick={() => { setSearch(''); load(''); }}>Clear</button>
          </div>
          <div className="form-grid-2" style={{ marginTop: 12 }}>
            <select value={exportFilters.billingMode} onChange={(event) => setExportFilters((current) => ({ ...current, billingMode: event.target.value }))}>
              <option value="">All billing modes</option>
              <option value="COURTESY">Courtesy</option>
              <option value="CUSTOMER_PAY">Customer Pay</option>
              <option value="WARRANTY">Warranty</option>
              <option value="INSURANCE">Insurance</option>
              <option value="INTERNAL">Internal</option>
            </select>
            <select value={exportFilters.billingStatus} onChange={(event) => setExportFilters((current) => ({ ...current, billingStatus: event.target.value }))}>
              <option value="">All billing statuses</option>
              <option value="DRAFT">Draft</option>
              <option value="PENDING_APPROVAL">Pending Approval</option>
              <option value="APPROVED">Approved</option>
              <option value="INVOICED">Invoiced</option>
              <option value="SETTLED">Settled</option>
              <option value="DENIED">Denied</option>
            </select>
            <input type="date" value={exportFilters.startDate} onChange={(event) => setExportFilters((current) => ({ ...current, startDate: event.target.value }))} />
            <input type="date" value={exportFilters.endDate} onChange={(event) => setExportFilters((current) => ({ ...current, endDate: event.target.value }))} />
          </div>

          {dashboard?.searchResults?.length ? (
            <div className="table-shell" style={{ marginTop: 14 }}>
              <table>
                <thead>
                  <tr>
                    <th>Reservation</th>
                    <th>Customer</th>
                    <th>RO</th>
                    <th>Status</th>
                    <th>Pickup</th>
                    <th>Return</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {dashboard.searchResults.map((row) => (
                    <tr key={row.id}>
                      <td>{row.reservationNumber}</td>
                      <td>{customerName(row)}</td>
                      <td>{row.repairOrderNumber || '-'}</td>
                      <td><span className="status-chip neutral">{row.status}</span></td>
                      <td>{formatDateTime(row.pickupAt)}</td>
                      <td>{formatDateTime(row.returnAt)}</td>
                      <td>
                        <div className="inline-actions">
                          <Link href={reservationHref(row)}><button type="button">Open</button></Link>
                          <button type="button" className="button-subtle" onClick={() => window.open(reservationHref(row), '_blank')}>Open New Tab</button>
                          <Link href={reservationHref(row, 'checkout')}><button type="button" className="button-subtle">Checkout</button></Link>
                          <Link href={reservationHref(row, 'checkin')}><button type="button" className="button-subtle">Check-in</button></Link>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="surface-note" style={{ marginTop: 14 }}>
              Search results will appear here once you start typing an RO number, customer, or service vehicle.
            </div>
          )}
        </section>

        <section id="loaner-intake" className="glass card-lg section-card">
          <div className="row-between">
            <div>
              <div className="section-title">Quick Intake</div>
              <p className="ui-muted">Create a loaner directly from the service lane and hand it off into the normal workflow.</p>
            </div>
            <div className="inline-actions">
              <button type="button" className="button-subtle" onClick={() => applyQuickWindow(2)}>2 Days</button>
              <button type="button" className="button-subtle" onClick={() => applyQuickWindow(5)}>5 Days</button>
            </div>
          </div>

          <form className="stack" onSubmit={createLoaner}>
            <div className="form-grid-2">
              <div>
                <div className="label">Existing Customer</div>
                <select value={form.customerId} onChange={(event) => setForm((current) => ({ ...current, customerId: event.target.value }))}>
                  <option value="">Create or choose customer</option>
                  {customers.map((row) => (
                    <option key={row.id} value={row.id}>
                      {[row.firstName, row.lastName].filter(Boolean).join(' ') || row.email}
                    </option>
                  ))}
                </select>
                {selectedCustomer ? (
                  <div className="surface-note" style={{ marginTop: 8 }}>
                    Using {selectedCustomer.firstName} {selectedCustomer.lastName} · {selectedCustomer.phone}
                  </div>
                ) : null}
              </div>
              <div>
                <div className="label">Billing Mode</div>
                <select value={form.loanerBillingMode} onChange={(event) => setForm((current) => ({ ...current, loanerBillingMode: event.target.value }))}>
                  <option value="COURTESY">Courtesy</option>
                  <option value="CUSTOMER_PAY">Customer Pay</option>
                  <option value="WARRANTY">Warranty</option>
                  <option value="INSURANCE">Insurance</option>
                  <option value="INTERNAL">Internal</option>
                </select>
              </div>
            </div>

            {!form.customerId ? (
              <div className="form-grid-2">
                <div>
                  <div className="label">First Name</div>
                  <input value={form.firstName} onChange={(event) => setForm((current) => ({ ...current, firstName: event.target.value }))} />
                </div>
                <div>
                  <div className="label">Last Name</div>
                  <input value={form.lastName} onChange={(event) => setForm((current) => ({ ...current, lastName: event.target.value }))} />
                </div>
                <div>
                  <div className="label">Email</div>
                  <input value={form.email} onChange={(event) => setForm((current) => ({ ...current, email: event.target.value }))} />
                </div>
                <div>
                  <div className="label">Phone</div>
                  <input value={form.phone} onChange={(event) => setForm((current) => ({ ...current, phone: event.target.value }))} />
                </div>
              </div>
            ) : null}

            <div className="form-grid-3">
              <div>
                <div className="label">Repair Order</div>
                <input value={form.repairOrderNumber} onChange={(event) => setForm((current) => ({ ...current, repairOrderNumber: event.target.value }))} placeholder="RO-12345" />
              </div>
              <div>
                <div className="label">Claim Number</div>
                <input value={form.claimNumber} onChange={(event) => setForm((current) => ({ ...current, claimNumber: event.target.value }))} placeholder="Optional" />
              </div>
              <div>
                <div className="label">Advisor Name</div>
                <input value={form.serviceAdvisorName} onChange={(event) => setForm((current) => ({ ...current, serviceAdvisorName: event.target.value }))} />
              </div>
              <div>
                <div className="label">Advisor Email</div>
                <input value={form.serviceAdvisorEmail} onChange={(event) => setForm((current) => ({ ...current, serviceAdvisorEmail: event.target.value }))} />
              </div>
              <div>
                <div className="label">Advisor Phone</div>
                <input value={form.serviceAdvisorPhone} onChange={(event) => setForm((current) => ({ ...current, serviceAdvisorPhone: event.target.value }))} />
              </div>
              <div>
                <div className="label">Vehicle Type<RequiredMark /></div>
                <select value={form.vehicleTypeId} onChange={(event) => setForm((current) => ({ ...current, vehicleTypeId: event.target.value }))} aria-required="true">
                  <option value="">Select type</option>
                  {vehicleTypes.map((row) => (
                    <option key={row.id} value={row.id}>{row.name}</option>
                  ))}
                </select>
              </div>
              <div>
                <div className="label">Loaner Vehicle</div>
                <select value={form.vehicleId} onChange={(event) => setForm((current) => ({ ...current, vehicleId: event.target.value }))}>
                  <option value="">Leave unassigned for now</option>
                  {visibleVehicles.map((row) => (
                    <option key={row.id} value={row.id}>
                      {[row.year, row.make, row.model, row.internalNumber].filter(Boolean).join(' ')}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <div className="label">Pickup Location<RequiredMark /></div>
                <select value={form.pickupLocationId} onChange={(event) => setForm((current) => ({ ...current, pickupLocationId: event.target.value }))} aria-required="true">
                  <option value="">Select location</option>
                  {locations.map((row) => (
                    <option key={row.id} value={row.id}>{row.name}</option>
                  ))}
                </select>
              </div>
              <div>
                <div className="label">Return Location<RequiredMark /></div>
                <select value={form.returnLocationId} onChange={(event) => setForm((current) => ({ ...current, returnLocationId: event.target.value }))} aria-required="true">
                  <option value="">Select location</option>
                  {locations.map((row) => (
                    <option key={row.id} value={row.id}>{row.name}</option>
                  ))}
                </select>
              </div>
              <div>
                <div className="label">Pickup At<RequiredMark /></div>
                <input type="datetime-local" value={form.pickupAt} onChange={(event) => setForm((current) => ({ ...current, pickupAt: event.target.value }))} aria-required="true" />
              </div>
              <div>
                <div className="label">Return At<RequiredMark /></div>
                <input type="datetime-local" value={form.returnAt} onChange={(event) => setForm((current) => ({ ...current, returnAt: event.target.value }))} aria-required="true" />
              </div>
            </div>

            <div className="form-grid-3">
              <div>
                <div className="label">Service Vehicle Year</div>
                <input value={form.serviceVehicleYear} onChange={(event) => setForm((current) => ({ ...current, serviceVehicleYear: event.target.value }))} />
              </div>
              <div>
                <div className="label">Service Vehicle Make</div>
                <input value={form.serviceVehicleMake} onChange={(event) => setForm((current) => ({ ...current, serviceVehicleMake: event.target.value }))} />
              </div>
              <div>
                <div className="label">Service Vehicle Model</div>
                <input value={form.serviceVehicleModel} onChange={(event) => setForm((current) => ({ ...current, serviceVehicleModel: event.target.value }))} />
              </div>
              <div>
                <div className="label">Service Vehicle Plate</div>
                <input value={form.serviceVehiclePlate} onChange={(event) => setForm((current) => ({ ...current, serviceVehiclePlate: event.target.value }))} />
              </div>
              <div>
                <div className="label">Service Vehicle VIN</div>
                <input value={form.serviceVehicleVin} onChange={(event) => setForm((current) => ({ ...current, serviceVehicleVin: event.target.value }))} />
              </div>
            </div>

            <div>
              <div className="label">Internal Notes</div>
              <textarea rows={3} value={form.notes} onChange={(event) => setForm((current) => ({ ...current, notes: event.target.value }))} placeholder="Lane notes, approval context, dealership notes" />
            </div>
            <div>
              <div className="label">Loaner Program Notes</div>
              <textarea rows={3} value={form.loanerProgramNotes} onChange={(event) => setForm((current) => ({ ...current, loanerProgramNotes: event.target.value }))} placeholder="Coverage details, insurer approval, courtesy policy, etc." />
            </div>
            <div>
              <div className="label">Service Advisor Notes</div>
              <textarea rows={3} value={form.serviceAdvisorNotes} onChange={(event) => setForm((current) => ({ ...current, serviceAdvisorNotes: event.target.value }))} placeholder="Advisor follow-up, promised completion, customer expectations, or service context" />
            </div>
            <label className="label" style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
              <input
                type="checkbox"
                checked={form.loanerLiabilityAccepted}
                onChange={(event) => setForm((current) => ({ ...current, loanerLiabilityAccepted: event.target.checked }))}
                aria-required="true"
              />
              <span>
                Customer accepted responsibility and liability for the loaner vehicle.
                <RequiredMark />
              </span>
            </label>
            <div className="inline-actions">
              <button type="submit" disabled={submitting}>
                {submitting ? 'Creating loaner intake…' : 'Create Loaner Intake'}
              </button>
              <button
                type="button"
                className="button-subtle"
                onClick={() => setForm(EMPTY_FORM)}
                disabled={submitting}
              >
                Reset
              </button>
            </div>
          </form>
        </section>
      </section>

      <section id="loaner-queues" className="glass card-lg section-card" style={{ marginTop: 18 }}>
        <div className="row-between">
          <div>
            <div className="section-title">Loaner Queues</div>
            <p className="ui-muted">Driveway and service-lane visibility for outgoing, active, and returning loaners.</p>
          </div>
          <span className="status-chip neutral">Foundation Surface</span>
        </div>

        <div className="app-banner-list">
          <button type="button" className={queueFocus === 'ALL' ? '' : 'button-subtle'} onClick={() => setQueueFocus('ALL')}>All Queues</button>
          <button type="button" className={queueFocus === 'INTAKE' ? '' : 'button-subtle'} onClick={() => setQueueFocus('INTAKE')}>Intake</button>
          <button type="button" className={queueFocus === 'RETURNS' ? '' : 'button-subtle'} onClick={() => setQueueFocus('RETURNS')}>Returns</button>
          <button type="button" className={queueFocus === 'ADVISOR' ? '' : 'button-subtle'} onClick={() => setQueueFocus('ADVISOR')}>Advisor</button>
          <button type="button" className={queueFocus === 'BILLING' ? '' : 'button-subtle'} onClick={() => setQueueFocus('BILLING')}>Billing</button>
          <button type="button" className={queueFocus === 'ALERTS' ? '' : 'button-subtle'} onClick={() => setQueueFocus('ALERTS')}>Alerts</button>
        </div>

        {queueFocus === 'ALL' ? (
          <>
            <div className="split-panel" style={{ marginTop: 10 }}>
              {visibleQueueSections.slice(0, 2).map((section) => (
                <LoanerQueueCard
                  key={section.key}
                  title={section.title}
                  subtitle={section.subtitle}
                  rows={section.rows}
                  emptyText={section.emptyText}
                  actions={section.actions}
                  loading={loading && !dashboard}
                />
              ))}
            </div>

            <div className="split-panel" style={{ marginTop: 16 }}>
              {visibleQueueSections.slice(2, 4).map((section) => (
                <LoanerQueueCard
                  key={section.key}
                  title={section.title}
                  subtitle={section.subtitle}
                  rows={section.rows}
                  emptyText={section.emptyText}
                  actions={section.actions}
                  loading={loading && !dashboard}
                />
              ))}
            </div>

            <div className="split-panel" style={{ marginTop: 16 }}>
              {visibleQueueSections.slice(4, 6).map((section) => (
                <LoanerQueueCard
                  key={section.key}
                  title={section.title}
                  subtitle={section.subtitle}
                  rows={section.rows}
                  emptyText={section.emptyText}
                  actions={section.actions}
                  loading={loading && !dashboard}
                />
              ))}
            </div>
          </>
        ) : (
          <div style={{ marginTop: 16 }}>
            {visibleQueueSections.map((section) => (
              <LoanerQueueCard
                key={section.key}
                title={section.title}
                subtitle={section.subtitle}
                rows={section.rows}
                emptyText={section.emptyText}
                actions={section.actions}
              />
            ))}
          </div>
        )}

        <section className="glass card section-card" style={{ marginTop: 16 }}>
          <div className="row-between">
            <div>
              <div className="section-title">Alert Escalation</div>
              <p className="ui-muted">Fast signal for what should get cashier, advisor, or lane-manager attention first.</p>
            </div>
            <span className="status-chip warn">Escalation Board</span>
          </div>
          <div className="metric-grid">
            <div className="metric-card">
              <span className="label">Overdue Returns</span>
              <strong>{metrics.overdueReturns}</strong>
              <span className="ui-muted">Units still out after promised return time.</span>
            </div>
            <div className="metric-card">
              <span className="label">Service Delays</span>
              <strong>{metrics.serviceDelays}</strong>
              <span className="ui-muted">ETA passed and not yet ready for pickup.</span>
            </div>
            <div className="metric-card">
              <span className="label">Billing Attention</span>
              <strong>{metrics.billingAttention}</strong>
              <span className="ui-muted">Warranty, insurer, or customer-pay billing still unresolved.</span>
            </div>
            <div className="metric-card">
              <span className="label">Return Exceptions</span>
              <strong>{metrics.returnExceptions}</strong>
              <span className="ui-muted">Damage, fuel, odor, or closeout issues flagged by staff.</span>
            </div>
          </div>
        </section>
      </section>
    </AppShell>
  );
}

function LoanerQueueCard({ title, subtitle, rows, emptyText, actions, loading }) {
  return (
    <section className="glass card section-card">
      <div className="section-title">{title}</div>
      <p className="ui-muted" style={{ marginTop: -6 }}>{subtitle}</p>
      {loading ? (
        <div className="stack" aria-busy="true" aria-label={`Loading ${title}`}>
          <SkeletonCard height={96} lines={3} />
          <SkeletonCard height={96} lines={3} />
        </div>
      ) : rows.length ? (
        <div className="stack">
          {rows.map((row) => (
            <div key={row.id} className="surface-note" style={{ display: 'grid', gap: 10 }}>
              <div className="row-between" style={{ gap: 12, alignItems: 'start' }}>
                <div>
                  <div style={{ fontWeight: 700 }}>{row.reservationNumber}</div>
                  <div className="label" style={{ textTransform: 'none', letterSpacing: 0, fontSize: 12 }}>
                    {customerName(row)} · {serviceVehicleLabel(row)}
                  </div>
                </div>
                <span className="status-chip neutral">{row.status}</span>
              </div>
              <div className="metric-grid">
                <div className="metric-card"><span className="label">RO</span><strong>{row.repairOrderNumber || '-'}</strong></div>
                <div className="metric-card"><span className="label">Billing</span><strong>{row.loanerBillingMode || '-'}</strong></div>
                <div className="metric-card"><span className="label">Billing Status</span><strong>{row.loanerBillingStatus || 'DRAFT'}</strong></div>
                <div className="metric-card"><span className="label">Pickup</span><strong>{formatDateTime(row.pickupAt)}</strong></div>
                <div className="metric-card"><span className="label">Return</span><strong>{formatDateTime(row.returnAt)}</strong></div>
                <div className="metric-card"><span className="label">Estimate</span><strong>{formatMoney(row.estimatedTotal)}</strong></div>
              </div>
              {row.serviceAdvisorNotes ? (
                <div className="label" style={{ textTransform: 'none', letterSpacing: 0, fontSize: 12 }}>
                  Notes: {row.serviceAdvisorNotes}
                </div>
              ) : null}
              <div className="inline-actions" style={{ gap: 8 }}>
                <span className={`status-chip ${row.loanerBorrowerPacketCompletedAt ? 'good' : 'warn'}`}>
                  {row.loanerBorrowerPacketCompletedAt ? 'Agreement complete' : 'Agreement pending'}
                </span>
                {row.loanerReturnExceptionFlag ? <span className="status-chip warn">Return issue flagged</span> : null}
                {row.alertReason ? <span className={`status-chip ${row.alertSeverity === 'warn' ? 'warn' : 'neutral'}`}>{row.alertReason}</span> : null}
              </div>
              <div className="label" style={{ textTransform: 'none', letterSpacing: 0, fontSize: 12 }}>
                Advisor: {row.serviceAdvisorName || '-'} · Location: {row.pickupLocation?.name || '-'}
              </div>
              <div className="inline-actions">{actions(row)}</div>
            </div>
          ))}
        </div>
      ) : (
        <div className="surface-note">{emptyText}</div>
      )}
    </section>
  );
}
