'use client';

import { useEffect, useMemo, useState } from 'react';
import { AuthGate } from '../../components/AuthGate';
import { AppShell } from '../../components/AppShell';
import { API_BASE, api } from '../../lib/client';

function fmtMoney(value) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(Number(value || 0));
}

function isoInput(value) {
  const d = value ? new Date(value) : new Date();
  return d.toISOString().slice(0, 10);
}

function monthInput(value) {
  const d = value ? new Date(value) : new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function humanDate(value) {
  if (!value) return '-';
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return String(value);
  return parsed.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
}

function daysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return isoInput(d);
}

function metricCards(report) {
  const kpis = report?.kpis || {};
  return [
    { label: 'Reservations', value: kpis.reservationsCreated || 0 },
    { label: 'Checked Out', value: kpis.checkedOut || 0 },
    { label: 'Checked In', value: kpis.checkedIn || 0 },
    { label: 'Due Today', value: kpis.agreementsDueToday || 0 },
    { label: 'Available Fleet', value: kpis.availableFleet || 0 },
    { label: 'Migration Held', value: kpis.migrationHeld || 0 },
    { label: 'Wash Held', value: kpis.washHeld || 0 },
    { label: 'Collected', value: fmtMoney(kpis.collectedPayments) },
    { label: 'Open Balance', value: fmtMoney(kpis.openBalance) },
    { label: 'Maintenance / OOS', value: (Number(kpis.vehiclesInMaintenance || 0) + Number(kpis.vehiclesOutOfService || 0)) || 0 },
    { label: 'Utilization', value: `${Number(kpis.utilizationPct || 0).toFixed(1)}%` }
  ];
}

function EmptyTableState({ text }) {
  return <div className="surface-note">{text}</div>;
}

function DataTable({ title, subtitle, columns, rows, renderRow, emptyText }) {
  return (
    <section className="glass card-lg section-card">
      <div className="row-between" style={{ marginBottom: 0 }}>
        <div>
          <div className="section-title">{title}</div>
          {subtitle ? <div className="ui-muted">{subtitle}</div> : null}
        </div>
      </div>
      {rows.length ? (
        <div className="table-shell">
          <table>
            <thead>
              <tr>
                {columns.map((col) => <th key={col}>{col}</th>)}
              </tr>
            </thead>
            <tbody>{rows.map(renderRow)}</tbody>
          </table>
        </div>
      ) : (
        <EmptyTableState text={emptyText} />
      )}
    </section>
  );
}

function Inner({ token, me, logout }) {
  const canFilterEmployee = ['SUPER_ADMIN', 'ADMIN', 'OPS'].includes(String(me?.role || '').toUpperCase());
  const isSuper = String(me?.role || '').toUpperCase() === 'SUPER_ADMIN';
  const [filters, setFilters] = useState({ start: daysAgo(29), end: daysAgo(0), tenantId: '', locationId: '', employeeUserId: '' });
  const [report, setReport] = useState(null);
  const [servicesSold, setServicesSold] = useState(null);
  const [commissionMonth, setCommissionMonth] = useState(monthInput(new Date()));
  const [commissionLedger, setCommissionLedger] = useState([]);
  const [opsEmailRecipients, setOpsEmailRecipients] = useState('');
  const [sendingOpsEmail, setSendingOpsEmail] = useState(false);
  const [vehicleRevenue, setVehicleRevenue] = useState(null);
  const [vehicleRevenueProgramFilter, setVehicleRevenueProgramFilter] = useState('ALL');
  const [exportingVehicleRevenue, setExportingVehicleRevenue] = useState(false);
  const [inventoryReport, setInventoryReport] = useState(null);
  const [inventoryProgramFilter, setInventoryProgramFilter] = useState('ALL');
  const [exportingInventory, setExportingInventory] = useState(false);
  const [reservationsReport, setReservationsReport] = useState(null);
  const [reservationsProgramFilter, setReservationsProgramFilter] = useState('ALL');
  const [reservationsWorkflowFilter, setReservationsWorkflowFilter] = useState('ALL');
  const [reservationsStatusFilter, setReservationsStatusFilter] = useState('ALL');
  const [exportingReservations, setExportingReservations] = useState(false);
  const [msg, setMsg] = useState('');
  const [loading, setLoading] = useState(true);

  const load = async (next = filters) => {
    setLoading(true);
    try {
      const reportQs = new URLSearchParams({
        start: next.start,
        end: next.end,
        ...(next.tenantId ? { tenantId: next.tenantId } : {}),
        ...(next.locationId ? { locationId: next.locationId } : {})
      });
      const servicesQs = new URLSearchParams({
        start: next.start,
        end: next.end,
        ...(next.tenantId ? { tenantId: next.tenantId } : {}),
        ...(next.locationId ? { locationId: next.locationId } : {}),
        ...(next.employeeUserId ? { employeeUserId: next.employeeUserId } : {})
      });
      const ledgerQs = new URLSearchParams({
        month: commissionMonth,
        ...(next.tenantId ? { tenantId: next.tenantId } : {}),
        ...(canFilterEmployee && next.employeeUserId ? { employeeUserId: next.employeeUserId } : {})
      });
      const vehicleRevenueQs = new URLSearchParams({
        start: next.start,
        end: next.end,
        ...(next.tenantId ? { tenantId: next.tenantId } : {}),
        ...(vehicleRevenueProgramFilter !== 'ALL' ? { programCategory: vehicleRevenueProgramFilter } : {})
      });
      const inventoryQs = new URLSearchParams({
        start: next.start,
        end: next.end,
        ...(next.tenantId ? { tenantId: next.tenantId } : {}),
        ...(inventoryProgramFilter !== 'ALL' ? { programCategory: inventoryProgramFilter } : {})
      });
      const reservationsQs = new URLSearchParams({
        start: next.start,
        end: next.end,
        ...(next.tenantId ? { tenantId: next.tenantId } : {}),
        ...(reservationsProgramFilter !== 'ALL' ? { programCategory: reservationsProgramFilter } : {}),
        ...(reservationsWorkflowFilter !== 'ALL' ? { workflowMode: reservationsWorkflowFilter } : {}),
        ...(reservationsStatusFilter !== 'ALL' ? { status: reservationsStatusFilter } : {})
      });
      const [overviewOut, servicesOut, ledgerOut, vehicleRevenueOut, inventoryOut, reservationsOut] = await Promise.all([
        api(`/api/reports/overview?${reportQs.toString()}`, {}, token),
        api(`/api/reports/services-sold?${servicesQs.toString()}`, {}, token),
        api(`/api/commissions/ledger?${ledgerQs.toString()}`, {}, token),
        api(`/api/reports/vehicle-revenue?${vehicleRevenueQs.toString()}`, {}, token),
        api(`/api/reports/inventory?${inventoryQs.toString()}`, {}, token),
        api(`/api/reports/reservations?${reservationsQs.toString()}`, {}, token)
      ]);
      setReport(overviewOut);
      setServicesSold(servicesOut);
      setCommissionLedger(Array.isArray(ledgerOut) ? ledgerOut : []);
      setVehicleRevenue(vehicleRevenueOut);
      setInventoryReport(inventoryOut);
      setReservationsReport(reservationsOut);
      setMsg('');
    } catch (e) {
      setMsg(e.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load(filters);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, commissionMonth, vehicleRevenueProgramFilter, inventoryProgramFilter, reservationsProgramFilter, reservationsWorkflowFilter, reservationsStatusFilter]);

  const cards = useMemo(() => metricCards(report), [report]);
  const reservationSeriesMax = Math.max(1, ...(report?.reservationsByDay || []).map((row) => Number(row.count || 0)));
  const paymentSeriesMax = Math.max(1, ...(report?.paymentsByDay || []).map((row) => Number(row.amount || 0)));

  const commissionSummary = useMemo(() => {
    const rows = Array.isArray(commissionLedger) ? commissionLedger : [];
    return {
      agreements: rows.length,
      grossRevenue: rows.reduce((sum, row) => sum + Number(row.grossRevenue || 0), 0),
      serviceRevenue: rows.reduce((sum, row) => sum + Number(row.serviceRevenue || 0), 0),
      commissionAmount: rows.reduce((sum, row) => sum + Number(row.commissionAmount || 0), 0)
    };
  }, [commissionLedger]);

  const scopePills = useMemo(() => {
    const pills = [`${report?.range?.days || 0} day window`];
    if (report?.filters?.tenantName) pills.push(`Tenant: ${report.filters.tenantName}`);
    if (report?.filters?.locationName) pills.push(`Location: ${report.filters.locationName}`);
    if (canFilterEmployee && servicesSold?.filters?.employeeName) pills.push(`Employee: ${servicesSold.filters.employeeName}`);
    pills.push(`Commission month: ${commissionMonth}`);
    return pills;
  }, [report, servicesSold, commissionMonth, canFilterEmployee]);

  const reportsLeadershipHub = useMemo(() => {
    const kpis = report?.kpis || {};
    const topLocation = (report?.topPickupLocations || [])[0] || null;
    const topService = (servicesSold?.topServices || [])[0] || null;
    const nextItems = [
      Number(kpis.openBalance || 0) > 0
        ? {
            id: 'open-balance',
            title: 'Open Balance Watch',
            detail: fmtMoney(kpis.openBalance),
            note: 'Outstanding balance still open across the current report scope.'
          }
        : null,
      topLocation
        ? {
            id: 'top-location',
            title: 'Top Pickup Location',
            detail: topLocation.name || 'Location',
            note: `${topLocation.count || 0} reservations in the current range.`
          }
        : null,
      topService
        ? {
            id: 'top-service',
            title: 'Top Add-On',
            detail: topService.serviceName || topService.name || 'Service',
            note: `${fmtMoney(topService.serviceRevenue)} in service revenue.`
          }
        : null,
      {
        id: 'utilization',
        title: 'Utilization Snapshot',
        detail: `${Number(kpis.utilizationPct || 0).toFixed(1)}%`,
        note: Number(kpis.utilizationPct || 0) >= 70
          ? 'Fleet utilization is healthy in the current window.'
          : 'There may be room to improve fleet usage in this range.'
      },
      {
        id: 'fleet-balance',
        title: 'Fleet Balance',
        detail: `${Number(kpis.availableFleet || 0)} available / ${Number(kpis.onRent || 0)} committed`,
        note: `${Number(kpis.vehiclesInMaintenance || 0) + Number(kpis.vehiclesOutOfService || 0)} units are in maintenance or out of service, plus ${Number(kpis.washHeld || 0)} in wash hold.`
      }
    ].filter(Boolean);

    return {
      reservationsCreated: kpis.reservationsCreated || 0,
      collectedPayments: fmtMoney(kpis.collectedPayments),
      openBalance: fmtMoney(kpis.openBalance),
      utilization: `${Number(kpis.utilizationPct || 0).toFixed(1)}%`,
      nextItems
    };
  }, [report, servicesSold]);

  const exportCsv = async () => {
    try {
      setMsg('');
      const qs = new URLSearchParams({
        start: filters.start,
        end: filters.end,
        ...(filters.tenantId ? { tenantId: filters.tenantId } : {}),
        ...(filters.locationId ? { locationId: filters.locationId } : {}),
        ...(filters.employeeUserId ? { employeeUserId: filters.employeeUserId } : {})
      });
      const res = await fetch(`${API_BASE}/api/reports/overview.csv?${qs.toString()}`, {
        headers: { Authorization: `Bearer ${token}` },
        cache: 'no-store'
      });
      if (!res.ok) {
        const text = await res.text();
        throw new Error(text || `CSV export failed (${res.status})`);
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `reports-overview-${filters.start}-to-${filters.end}${filters.tenantId ? `-${filters.tenantId}` : ''}${filters.locationId ? `-${filters.locationId}` : ''}.csv`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (e) {
      setMsg(e.message);
    }
  };

  const exportContractsXlsx = async () => {
    try {
      setMsg('');
      const qs = new URLSearchParams({
        start: filters.start,
        end: filters.end,
        ...(filters.tenantId ? { tenantId: filters.tenantId } : {})
      });
      const res = await fetch(`${API_BASE}/api/reports/contracts.xlsx?${qs.toString()}`, {
        headers: { Authorization: `Bearer ${token}` },
        cache: 'no-store'
      });
      if (!res.ok) {
        const text = await res.text();
        throw new Error(text || `Excel export failed (${res.status})`);
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `rental-contracts-${filters.start}-to-${filters.end}${filters.tenantId ? `-${filters.tenantId}` : ''}.xlsx`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (e) {
      setMsg(e.message);
    }
  };

  const exportReservationsXlsx = async () => {
    if (exportingReservations) return;
    try {
      setExportingReservations(true);
      setMsg('');
      const qs = new URLSearchParams({
        start: filters.start,
        end: filters.end,
        ...(filters.tenantId ? { tenantId: filters.tenantId } : {}),
        ...(reservationsProgramFilter !== 'ALL' ? { programCategory: reservationsProgramFilter } : {}),
        ...(reservationsWorkflowFilter !== 'ALL' ? { workflowMode: reservationsWorkflowFilter } : {}),
        ...(reservationsStatusFilter !== 'ALL' ? { status: reservationsStatusFilter } : {})
      });
      const res = await fetch(`${API_BASE}/api/reports/reservations.xlsx?${qs.toString()}`, {
        headers: { Authorization: `Bearer ${token}` },
        cache: 'no-store'
      });
      if (!res.ok) {
        const text = await res.text();
        throw new Error(text || `Excel export failed (${res.status})`);
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `reservations-${filters.start}-to-${filters.end}.xlsx`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (e) {
      setMsg(e.message);
    } finally {
      setExportingReservations(false);
    }
  };

  const exportInventoryXlsx = async () => {
    if (exportingInventory) return;
    try {
      setExportingInventory(true);
      setMsg('');
      const qs = new URLSearchParams({
        start: filters.start,
        end: filters.end,
        ...(filters.tenantId ? { tenantId: filters.tenantId } : {}),
        ...(inventoryProgramFilter !== 'ALL' ? { programCategory: inventoryProgramFilter } : {})
      });
      const res = await fetch(`${API_BASE}/api/reports/inventory.xlsx?${qs.toString()}`, {
        headers: { Authorization: `Bearer ${token}` },
        cache: 'no-store'
      });
      if (!res.ok) {
        const text = await res.text();
        throw new Error(text || `Excel export failed (${res.status})`);
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `inventory-${filters.start}-to-${filters.end}${inventoryProgramFilter !== 'ALL' ? `-${inventoryProgramFilter}` : ''}.xlsx`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (e) {
      setMsg(e.message);
    } finally {
      setExportingInventory(false);
    }
  };

  const exportVehicleRevenueXlsx = async () => {
    if (exportingVehicleRevenue) return;
    try {
      setExportingVehicleRevenue(true);
      setMsg('');
      const qs = new URLSearchParams({
        start: filters.start,
        end: filters.end,
        ...(filters.tenantId ? { tenantId: filters.tenantId } : {}),
        ...(vehicleRevenueProgramFilter !== 'ALL' ? { programCategory: vehicleRevenueProgramFilter } : {})
      });
      const res = await fetch(`${API_BASE}/api/reports/vehicle-revenue.xlsx?${qs.toString()}`, {
        headers: { Authorization: `Bearer ${token}` },
        cache: 'no-store'
      });
      if (!res.ok) {
        const text = await res.text();
        throw new Error(text || `Excel export failed (${res.status})`);
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `vehicle-revenue-${filters.start}-to-${filters.end}${vehicleRevenueProgramFilter !== 'ALL' ? `-${vehicleRevenueProgramFilter}` : ''}.xlsx`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (e) {
      setMsg(e.message);
    } finally {
      setExportingVehicleRevenue(false);
    }
  };

  const printReport = () => {
    if (typeof window === 'undefined') return;
    window.setTimeout(() => window.print(), 80);
  };

  const sendOpsEmail = async () => {
    try {
      setSendingOpsEmail(true);
      setMsg('');
      const out = await api('/api/reports/overview/email', {
        method: 'POST',
        body: JSON.stringify({
          start: filters.start,
          end: filters.end,
          ...(filters.tenantId ? { tenantId: filters.tenantId } : {}),
          ...(filters.locationId ? { locationId: filters.locationId } : {}),
          recipients: opsEmailRecipients
        })
      }, token);
      setMsg(`Daily ops email sent to ${Array.isArray(out?.recipients) ? out.recipients.join(', ') : 'configured recipients'}`);
    } catch (e) {
      setMsg(e.message);
    } finally {
      setSendingOpsEmail(false);
    }
  };

  const commissionLines = (commissionLedger || [])
    .flatMap((row) => (row.lines || []).map((line) => ({
      ...line,
      agreementNumber: row.rentalAgreement?.agreementNumber || row.rentalAgreementId || row.id
    })));

  return (
    <AppShell me={me} logout={logout}>
      <section className="page-hero">
        <div className="hero-grid">
          <section className="glass card-lg hero-copy">
            <div className="eyebrow">Reports Workspace</div>
            <h2>Revenue, operations, services sold, and commission performance in one view.</h2>
            <p>
              This page is now the command center for daily rental performance. Teams can compare operational flow,
              revenue movement, add-on attachment, and employee commission outcomes without hopping between modules.
            </p>
            <div className="hero-meta">
              {scopePills.map((pill) => <span key={pill} className="hero-pill">{pill}</span>)}
            </div>
          </section>

          <section className="glass card-lg section-card">
            <div className="row-between" style={{ marginBottom: 0 }}>
              <div>
                <div className="section-title">Report controls</div>
                <div className="ui-muted">Adjust the scope, export CSV, print/save PDF, and refresh the operational snapshot.</div>
              </div>
              <div className="inline-actions reports-screen-only">
                <button onClick={exportContractsXlsx} disabled={loading}>Export Contracts Excel</button>
                <button className="button-subtle" onClick={exportCsv} disabled={loading}>Export CSV</button>
                <button className="button-subtle" onClick={printReport} disabled={loading}>Print / Save PDF</button>
                <button className="button-subtle" onClick={() => load(filters)} disabled={loading}>Refresh</button>
              </div>
            </div>

            <div className="form-grid-3">
              <div className="stack">
                <label className="label">Start</label>
                <input
                  type="date"
                  value={filters.start}
                  onChange={(e) => setFilters((prev) => ({ ...prev, start: e.target.value }))}
                />
              </div>

              <div className="stack">
                <label className="label">End</label>
                <input
                  type="date"
                  value={filters.end}
                  onChange={(e) => setFilters((prev) => ({ ...prev, end: e.target.value }))}
                />
              </div>

              <div className="stack">
                <label className="label">Commission Month</label>
                <input
                  type="month"
                  value={commissionMonth}
                  onChange={(e) => setCommissionMonth(e.target.value)}
                />
              </div>

              {isSuper ? (
                <div className="stack">
                  <label className="label">Tenant</label>
                  <select
                    value={filters.tenantId}
                    onChange={(e) => setFilters((prev) => ({ ...prev, tenantId: e.target.value, locationId: '' }))}
                  >
                    <option value="">All tenants</option>
                    {(report?.tenants || []).map((tenant) => (
                      <option key={tenant.id} value={tenant.id}>{tenant.name}</option>
                    ))}
                  </select>
                </div>
              ) : null}

              <div className="stack">
                <label className="label">Location</label>
                <select
                  value={filters.locationId}
                  onChange={(e) => setFilters((prev) => ({ ...prev, locationId: e.target.value }))}
                >
                  <option value="">All locations</option>
                  {(report?.locations || []).map((location) => (
                    <option key={location.id} value={location.id}>{location.name}</option>
                  ))}
                </select>
              </div>

              {canFilterEmployee ? (
                <div className="stack">
                  <label className="label">Employee</label>
                  <select
                    value={filters.employeeUserId}
                    onChange={(e) => setFilters((prev) => ({ ...prev, employeeUserId: e.target.value }))}
                  >
                    <option value="">All employees</option>
                    {(servicesSold?.employees || []).map((employee) => (
                      <option key={employee.id} value={employee.id}>{employee.fullName}</option>
                    ))}
                  </select>
                </div>
              ) : null}
            </div>

            <div className="inline-actions">
              <button onClick={() => load(filters)} disabled={loading}>Apply Range</button>
              {loading ? <span className="status-chip neutral">Loading report</span> : null}
            </div>

            <div className="stack reports-screen-only">
              <label className="label">Daily Ops Email Recipients</label>
              <input
                placeholder="ops@company.com, manager@company.com"
                value={opsEmailRecipients}
                onChange={(e) => setOpsEmailRecipients(e.target.value)}
              />
              <div className="ui-muted">Leave blank to use the configured `locationEmail` values for the selected report scope.</div>
              <div className="inline-actions">
                <button onClick={sendOpsEmail} disabled={loading || sendingOpsEmail}>
                  {sendingOpsEmail ? 'Sending Daily Ops Email...' : 'Send Daily Ops Email'}
                </button>
              </div>
            </div>
          </section>
        </div>
      </section>

      {msg ? <div className="surface-note" style={{ marginBottom: 16 }}>{msg}</div> : null}

      <section className="reports-print-header reports-print-only">
        <div className="reports-print-title">Ride Fleet Reports Overview</div>
        <div className="reports-print-meta">
          <span>Range: {humanDate(filters.start)} to {humanDate(filters.end)}</span>
          <span>Tenant: {report?.filters?.tenantName || 'All Tenants'}</span>
          <span>Location: {report?.filters?.locationName || 'All Locations'}</span>
          <span>Commission Month: {commissionMonth}</span>
        </div>
        <div className="reports-print-meta">
          {(report?.fleetHoldBreakdown || []).map((row) => (
            <span key={row.id}>{row.label}: {row.count}</span>
          ))}
        </div>
      </section>

      <section className="glass card-lg section-card" style={{ marginBottom: 18 }}>
        <div className="app-banner">
          <div className="row-between" style={{ alignItems: 'start', marginBottom: 0 }}>
            <div>
              <span className="eyebrow">Reports Leadership Hub</span>
              <h2 className="page-title" style={{ marginTop: 6 }}>
                Read the business fast before diving into the full report.
              </h2>
              <p className="ui-muted">A compact mobile-first summary for revenue, open balance, utilization, and what deserves attention next.</p>
            </div>
            <span className="status-chip neutral">Leadership View</span>
          </div>
          <div className="app-card-grid compact">
            <div className="info-tile">
              <span className="label">Reservations</span>
              <strong>{reportsLeadershipHub.reservationsCreated}</strong>
              <span className="ui-muted">Reservations created inside the current reporting window.</span>
            </div>
            <div className="info-tile">
              <span className="label">Collected</span>
              <strong>{reportsLeadershipHub.collectedPayments}</strong>
              <span className="ui-muted">Payments collected in the selected range.</span>
            </div>
            <div className="info-tile">
              <span className="label">Open Balance</span>
              <strong>{reportsLeadershipHub.openBalance}</strong>
              <span className="ui-muted">Outstanding balance still open across this scope.</span>
            </div>
            <div className="info-tile">
              <span className="label">Utilization</span>
              <strong>{reportsLeadershipHub.utilization}</strong>
              <span className="ui-muted">Fleet utilization snapshot for the active range.</span>
            </div>
          </div>
          <div className="app-card-grid compact">
            {reportsLeadershipHub.nextItems.map((item) => (
              <section key={item.id} className="glass card section-card">
                <div className="section-title" style={{ fontSize: 15 }}>{item.title}</div>
                <div className="ui-muted">{item.detail}</div>
                <div className="surface-note">{item.note}</div>
              </section>
            ))}
          </div>
        </div>
      </section>

      <section className="metric-grid" style={{ marginBottom: 18 }}>
        {cards.map((card) => (
          <div key={card.label} className="metric-card">
            <span className="label">{card.label}</span>
            <strong>{card.value}</strong>
          </div>
        ))}
      </section>

      <section className="split-panel" style={{ marginBottom: 18 }}>
        <section className="glass card-lg section-card">
          <div className="row-between" style={{ marginBottom: 0 }}>
            <div>
              <div className="section-title">Reservations By Day</div>
              <div className="ui-muted">Volume trend across the selected range.</div>
            </div>
            <span className="hero-pill">{report?.range?.days || 0} days</span>
          </div>

          <div className="stack">
            {(report?.reservationsByDay || []).length ? (report.reservationsByDay || []).map((row) => (
              <div key={row.date}>
                <div className="row-between" style={{ marginBottom: 4 }}>
                  <span>{row.date}</span>
                  <strong>{row.count}</strong>
                </div>
                <div style={{ height: 10, borderRadius: 999, background: 'rgba(135,82,254,.08)', overflow: 'hidden' }}>
                  <div
                    style={{
                      width: `${(Number(row.count || 0) / reservationSeriesMax) * 100}%`,
                      height: '100%',
                      background: 'linear-gradient(90deg, #6d3df2, #1fc7aa)'
                    }}
                  />
                </div>
              </div>
            )) : <EmptyTableState text="No reservation activity for the selected range." />}
          </div>
        </section>

        <section className="glass card-lg section-card">
          <div className="row-between" style={{ marginBottom: 0 }}>
            <div>
              <div className="section-title">Payments By Day</div>
              <div className="ui-muted">Reservation payment movement across the same range.</div>
            </div>
            <span className="hero-pill">Cashflow snapshot</span>
          </div>

          <div className="stack">
            {(report?.paymentsByDay || []).length ? (report.paymentsByDay || []).map((row) => (
              <div key={row.date}>
                <div className="row-between" style={{ marginBottom: 4 }}>
                  <span>{row.date}</span>
                  <strong>{fmtMoney(row.amount)}</strong>
                </div>
                <div style={{ height: 10, borderRadius: 999, background: 'rgba(31,199,170,.08)', overflow: 'hidden' }}>
                  <div
                    style={{
                      width: `${(Number(row.amount || 0) / paymentSeriesMax) * 100}%`,
                      height: '100%',
                      background: 'linear-gradient(90deg, #1fc7aa, #6d3df2)'
                    }}
                  />
                </div>
              </div>
            )) : <EmptyTableState text="No payment activity for the selected range." />}
          </div>
        </section>
      </section>

      <section className="split-panel" style={{ marginBottom: 18 }}>
        <DataTable
          title="Status Breakdown"
          subtitle="Reservation outcome mix across the current range."
          columns={['Status', 'Count']}
          rows={report?.reservationStatusBreakdown || []}
          emptyText="No reservation status data is available for this range."
          renderRow={(row) => (
            <tr key={row.status}>
              <td>{row.status}</td>
              <td>{row.count}</td>
            </tr>
          )}
        />

        <DataTable
          title="Top Pickup Locations"
          subtitle="Highest-volume pickup points for the current filter."
          columns={['Location', 'Reservations']}
          rows={report?.topPickupLocations || []}
          emptyText="No pickup locations are available for this range."
          renderRow={(row) => (
            <tr key={row.locationId}>
              <td>{row.name}</td>
              <td>{row.count}</td>
            </tr>
          )}
        />
      </section>

      <section className="split-panel" style={{ marginBottom: 18 }}>
        <DataTable
          title="Fleet Hold Breakdown"
          subtitle="Separate migration, wash, maintenance, and out-of-service pressure on the fleet."
          columns={['Hold Type', 'Count', 'Operational Note']}
          rows={report?.fleetHoldBreakdown || []}
          emptyText="No active fleet holds are present for this range."
          renderRow={(row) => (
            <tr key={row.id}>
              <td>{row.label}</td>
              <td>{row.count}</td>
              <td>{row.note}</td>
            </tr>
          )}
        />

        <section className="glass card-lg section-card">
          <div className="row-between" style={{ marginBottom: 0 }}>
            <div>
              <div className="section-title">Hold Pressure Snapshot</div>
              <div className="ui-muted">Quick operational read on where temporary capacity is being absorbed.</div>
            </div>
          </div>
          <div className="metric-grid">
            {(report?.fleetHoldBreakdown || []).map((row) => (
              <div key={row.id} className="metric-card">
                <span className="label">{row.label}</span>
                <strong>{row.count}</strong>
              </div>
            ))}
          </div>
        </section>
      </section>

      <section className="glass card-lg section-card" style={{ marginBottom: 18 }}>
        <div className="row-between" style={{ marginBottom: 0 }}>
          <div>
            <div className="section-title">Services Sold</div>
            <div className="ui-muted">Closed agreements and commission-bearing service lines.</div>
          </div>
          <div className="hero-meta">
            <span className="hero-pill">Revenue {fmtMoney(servicesSold?.summary?.serviceRevenue)}</span>
            <span className="hero-pill">Commission {fmtMoney(servicesSold?.summary?.commissionAmount)}</span>
          </div>
        </div>

        <div className="metric-grid">
          <div className="metric-card">
            <span className="label">Service Lines</span>
            <strong>{servicesSold?.summary?.servicesSoldCount || 0}</strong>
          </div>
          <div className="metric-card">
            <span className="label">Units Sold</span>
            <strong>{Number(servicesSold?.summary?.unitsSold || 0).toFixed(2)}</strong>
          </div>
          <div className="metric-card">
            <span className="label">Agreements Closed</span>
            <strong>{servicesSold?.summary?.agreementsClosed || 0}</strong>
          </div>
          <div className="metric-card">
            <span className="label">Commission</span>
            <strong>{fmtMoney(servicesSold?.summary?.commissionAmount)}</strong>
          </div>
        </div>

        <div className="split-panel">
          <DataTable
            title="By Service"
            subtitle="Which add-ons are moving and contributing revenue."
            columns={['Service', 'Units', 'Revenue', 'Commission', 'Agreements']}
            rows={servicesSold?.byService || []}
            emptyText="No service lines have closed in this range."
            renderRow={(row) => (
              <tr key={row.serviceId}>
                <td>{row.serviceName}</td>
                <td>{Number(row.unitsSold || 0).toFixed(2)}</td>
                <td>{fmtMoney(row.serviceRevenue)}</td>
                <td>{fmtMoney(row.commissionAmount)}</td>
                <td>{row.agreementsClosed}</td>
              </tr>
            )}
          />

          {canFilterEmployee ? (
            <DataTable
              title="By Employee"
              subtitle="Who is driving service revenue and commission."
              columns={['Employee', 'Units', 'Revenue', 'Commission', 'Agreements']}
              rows={servicesSold?.byEmployee || []}
              emptyText="No employee-attributed service activity yet."
              renderRow={(row) => (
                <tr key={row.employeeUserId}>
                  <td>{row.employeeName}</td>
                  <td>{Number(row.unitsSold || 0).toFixed(2)}</td>
                  <td>{fmtMoney(row.serviceRevenue)}</td>
                  <td>{fmtMoney(row.commissionAmount)}</td>
                  <td>{row.agreementsClosed}</td>
                </tr>
              )}
            />
          ) : null}
        </div>
      </section>

      <section className="glass card-lg section-card">
        <div className="row-between" style={{ marginBottom: 0 }}>
          <div>
            <div className="section-title">
              {canFilterEmployee && servicesSold?.filters?.employeeName ? `${servicesSold.filters.employeeName} Commission` : 'My Commission'}
            </div>
            <div className="ui-muted">Month-to-month commission snapshot sourced from closed agreements.</div>
          </div>
          <span className="hero-pill">{commissionMonth}</span>
        </div>

        <div className="metric-grid">
          <div className="metric-card">
            <span className="label">Closed Agreements</span>
            <strong>{commissionSummary.agreements}</strong>
          </div>
          <div className="metric-card">
            <span className="label">Gross Revenue</span>
            <strong>{fmtMoney(commissionSummary.grossRevenue)}</strong>
          </div>
          <div className="metric-card">
            <span className="label">Service Revenue</span>
            <strong>{fmtMoney(commissionSummary.serviceRevenue)}</strong>
          </div>
          <div className="metric-card">
            <span className="label">Commission Earned</span>
            <strong>{fmtMoney(commissionSummary.commissionAmount)}</strong>
          </div>
        </div>

        <div className="split-panel">
          <DataTable
            title="Agreement Ledger"
            subtitle="Closed agreements contributing to the current month."
            columns={['Agreement', 'Closed', 'Gross', 'Service Revenue', 'Commission', 'Status']}
            rows={commissionLedger || []}
            emptyText="No commission ledger rows exist for the selected month."
            renderRow={(row) => (
              <tr key={row.id}>
                <td>{row.rentalAgreement?.agreementNumber || row.rentalAgreementId}</td>
                <td>{row.rentalAgreement?.closedAt ? new Date(row.rentalAgreement.closedAt).toLocaleDateString() : '-'}</td>
                <td>{fmtMoney(row.grossRevenue)}</td>
                <td>{fmtMoney(row.serviceRevenue)}</td>
                <td>{fmtMoney(row.commissionAmount)}</td>
                <td><span className="status-chip neutral">{row.status}</span></td>
              </tr>
            )}
          />

          <DataTable
            title="Commission Lines"
            subtitle="Every line item contributing to commission calculation."
            columns={['Agreement', 'Line', 'Qty', 'Revenue', 'Rule', 'Commission']}
            rows={commissionLines}
            emptyText="No commission line items are available for the selected month."
            renderRow={(line) => (
              <tr key={line.id}>
                <td>{line.agreementNumber}</td>
                <td>{line.service?.name || line.description}</td>
                <td>{Number(line.quantity || 0).toFixed(2)}</td>
                <td>{fmtMoney(line.lineRevenue)}</td>
                <td>{line.valueType}</td>
                <td>{fmtMoney(line.commissionAmount)}</td>
              </tr>
            )}
          />

          <section className="glass card-lg section-card">
            <div className="row-between" style={{ marginBottom: 12, alignItems: 'flex-start' }}>
              <div>
                <h2 style={{ marginBottom: 4 }}>Vehicle Revenue</h2>
                <p className="label" style={{ marginTop: 0 }}>
                  Charges and payments aggregated per vehicle for the selected date range.
                  Triangle plan item #3 — see which cars are pulling weight, optionally scoped to rental or loaner pool.
                </p>
              </div>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <span className="label">Program:</span>
                <select
                  value={vehicleRevenueProgramFilter}
                  onChange={(e) => setVehicleRevenueProgramFilter(e.target.value)}
                  style={{ minWidth: 140 }}
                >
                  <option value="ALL">All programs</option>
                  <option value="RENTAL_ONLY">Rental only</option>
                  <option value="LOANER_ONLY">Loaner only</option>
                  <option value="BOTH">Flexible only</option>
                </select>
                <button onClick={exportVehicleRevenueXlsx} disabled={exportingVehicleRevenue || !vehicleRevenue?.vehicles?.length}>
                  {exportingVehicleRevenue ? 'Exporting…' : 'Export Excel'}
                </button>
              </div>
            </div>
            {vehicleRevenue?.totals ? (
              <div className="metric-grid" style={{ marginBottom: 12 }}>
                <div className="metric-card"><span className="label">Vehicles</span><strong>{vehicleRevenue.totals.vehicleCount}</strong></div>
                <div className="metric-card"><span className="label">Reservations</span><strong>{vehicleRevenue.totals.reservationCount}</strong></div>
                <div className="metric-card"><span className="label">Total charges</span><strong>{fmtMoney(vehicleRevenue.totals.totalCharges)}</strong></div>
                <div className="metric-card"><span className="label">Total paid</span><strong>{fmtMoney(vehicleRevenue.totals.totalPaid)}</strong></div>
              </div>
            ) : null}
            {vehicleRevenue?.vehicles?.length ? (
              <table>
                <thead>
                  <tr>
                    <th>Unit ID</th>
                    <th>Plate</th>
                    <th>Vehicle</th>
                    <th>Type</th>
                    <th>Program</th>
                    <th>Reservations</th>
                    <th>Charges</th>
                    <th>Paid</th>
                  </tr>
                </thead>
                <tbody>
                  {vehicleRevenue.vehicles.map((v) => (
                    <tr key={v.vehicleId}>
                      <td>{v.internalNumber}</td>
                      <td>{v.plate || '-'}</td>
                      <td>{[v.year, v.make, v.model].filter(Boolean).join(' ') || '-'}</td>
                      <td>{v.vehicleTypeName || '-'}</td>
                      <td>
                        <span
                          className="badge"
                          style={{
                            background:
                              (v.programCategory || 'BOTH') === 'LOANER_ONLY' ? 'rgba(255,140,0,0.18)'
                              : (v.programCategory || 'BOTH') === 'RENTAL_ONLY' ? 'rgba(73,140,255,0.18)'
                              : 'rgba(160,160,160,0.18)',
                            color:
                              (v.programCategory || 'BOTH') === 'LOANER_ONLY' ? '#b56300'
                              : (v.programCategory || 'BOTH') === 'RENTAL_ONLY' ? '#1d4ed8'
                              : '#444'
                          }}
                        >
                          {(v.programCategory || 'BOTH') === 'LOANER_ONLY' ? 'Loaner'
                            : (v.programCategory || 'BOTH') === 'RENTAL_ONLY' ? 'Rental'
                            : 'Flex'}
                        </span>
                      </td>
                      <td>{v.reservationCount}</td>
                      <td>{fmtMoney(v.totalCharges)}</td>
                      <td>{fmtMoney(v.totalPaid)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <EmptyTableState text="No reservations against vehicles for the selected date range and program filter." />
            )}
          </section>

          <section className="glass card-lg section-card">
            <div className="row-between" style={{ marginBottom: 12, alignItems: 'flex-start' }}>
              <div>
                <h2 style={{ marginBottom: 4 }}>Inventory</h2>
                <p className="label" style={{ marginTop: 0 }}>
                  Full fleet snapshot with utilization metrics for the selected window.
                  Triangle plan item #7 — see which vehicles are working, idle, or unavailable, scoped by program.
                </p>
              </div>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <span className="label">Program:</span>
                <select
                  value={inventoryProgramFilter}
                  onChange={(e) => setInventoryProgramFilter(e.target.value)}
                  style={{ minWidth: 140 }}
                >
                  <option value="ALL">All programs</option>
                  <option value="RENTAL_ONLY">Rental only</option>
                  <option value="LOANER_ONLY">Loaner only</option>
                  <option value="BOTH">Flexible only</option>
                </select>
                <button onClick={exportInventoryXlsx} disabled={exportingInventory || !inventoryReport?.vehicles?.length}>
                  {exportingInventory ? 'Exporting…' : 'Export Excel'}
                </button>
              </div>
            </div>
            {inventoryReport?.totals ? (
              <div className="metric-grid" style={{ marginBottom: 12 }}>
                <div className="metric-card"><span className="label">Vehicles</span><strong>{inventoryReport.totals.vehicleCount}</strong></div>
                <div className="metric-card"><span className="label">Reservations (window)</span><strong>{inventoryReport.totals.reservationCount}</strong></div>
                <div className="metric-card"><span className="label">Avg utilization</span><strong>{Number(inventoryReport.totals.avgUtilization || 0).toFixed(1)}%</strong></div>
                <div className="metric-card"><span className="label">Revenue (window)</span><strong>{fmtMoney(inventoryReport.totals.totalRevenue)}</strong></div>
              </div>
            ) : null}
            {inventoryReport?.vehicles?.length ? (
              <table>
                <thead>
                  <tr>
                    <th>Unit</th>
                    <th>Plate</th>
                    <th>Vehicle</th>
                    <th>Type</th>
                    <th>Status</th>
                    <th>Program</th>
                    <th>Home</th>
                    <th>Reservations</th>
                    <th>Util %</th>
                    <th>Revenue</th>
                    <th>Last Res.</th>
                    <th>Days idle</th>
                  </tr>
                </thead>
                <tbody>
                  {inventoryReport.vehicles.map((v) => (
                    <tr key={v.vehicleId}>
                      <td>{v.internalNumber}</td>
                      <td>{v.plate || '-'}</td>
                      <td>{[v.year, v.make, v.model].filter(Boolean).join(' ') || '-'}</td>
                      <td>{v.vehicleTypeName || '-'}</td>
                      <td><span className="badge">{v.status}</span></td>
                      <td>
                        <span
                          className="badge"
                          style={{
                            background:
                              (v.programCategory || 'BOTH') === 'LOANER_ONLY' ? 'rgba(255,140,0,0.18)'
                              : (v.programCategory || 'BOTH') === 'RENTAL_ONLY' ? 'rgba(73,140,255,0.18)'
                              : 'rgba(160,160,160,0.18)',
                            color:
                              (v.programCategory || 'BOTH') === 'LOANER_ONLY' ? '#b56300'
                              : (v.programCategory || 'BOTH') === 'RENTAL_ONLY' ? '#1d4ed8'
                              : '#444'
                          }}
                        >
                          {(v.programCategory || 'BOTH') === 'LOANER_ONLY' ? 'Loaner'
                            : (v.programCategory || 'BOTH') === 'RENTAL_ONLY' ? 'Rental'
                            : 'Flex'}
                        </span>
                      </td>
                      <td>{v.homeLocationName || '-'}</td>
                      <td>{v.reservationCount}</td>
                      <td>{Number(v.utilizationPct || 0).toFixed(1)}%</td>
                      <td>{fmtMoney(v.totalRevenue)}</td>
                      <td>{v.lastReservationAt ? humanDate(v.lastReservationAt) : '-'}</td>
                      <td>{v.daysSinceLastReservation == null ? '-' : v.daysSinceLastReservation}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <EmptyTableState text="No vehicles in scope for the selected program filter." />
            )}
          </section>

          <section className="glass card-lg section-card">
            <div className="row-between" style={{ marginBottom: 12, alignItems: 'flex-start' }}>
              <div>
                <h2 style={{ marginBottom: 4 }}>Reservations</h2>
                <p className="label" style={{ marginTop: 0 }}>
                  Flat list of every reservation with billing fields for accounting reconciliation.
                  Triangle plan item #7 — filter by program, workflow (rental vs loaner), or status; export to Excel.
                </p>
              </div>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                <select
                  value={reservationsWorkflowFilter}
                  onChange={(e) => setReservationsWorkflowFilter(e.target.value)}
                  title="Workflow mode"
                >
                  <option value="ALL">All workflows</option>
                  <option value="STANDARD_RENTAL">Standard rental</option>
                  <option value="DEALERSHIP_LOANER">Dealership loaner</option>
                </select>
                <select
                  value={reservationsProgramFilter}
                  onChange={(e) => setReservationsProgramFilter(e.target.value)}
                  title="Vehicle program"
                >
                  <option value="ALL">All programs</option>
                  <option value="RENTAL_ONLY">Rental only</option>
                  <option value="LOANER_ONLY">Loaner only</option>
                  <option value="BOTH">Flexible only</option>
                </select>
                <select
                  value={reservationsStatusFilter}
                  onChange={(e) => setReservationsStatusFilter(e.target.value)}
                  title="Status"
                >
                  <option value="ALL">All statuses</option>
                  <option value="NEW">New</option>
                  <option value="CONFIRMED">Confirmed</option>
                  <option value="CHECKED_OUT">Checked out</option>
                  <option value="CANCELLED">Cancelled</option>
                </select>
                <button onClick={exportReservationsXlsx} disabled={exportingReservations || !reservationsReport?.reservations?.length}>
                  {exportingReservations ? 'Exporting…' : 'Export Excel'}
                </button>
              </div>
            </div>
            {reservationsReport?.totals ? (
              <div className="metric-grid" style={{ marginBottom: 12 }}>
                <div className="metric-card"><span className="label">Reservations</span><strong>{reservationsReport.totals.reservationCount}</strong></div>
                <div className="metric-card"><span className="label">Charges</span><strong>{fmtMoney(reservationsReport.totals.totalCharges)}</strong></div>
                <div className="metric-card"><span className="label">Agreement Total</span><strong>{fmtMoney(reservationsReport.totals.totalAgreement)}</strong></div>
                <div className="metric-card"><span className="label">Paid</span><strong>{fmtMoney(reservationsReport.totals.totalPaid)}</strong></div>
                <div className="metric-card"><span className="label">Open Balance</span><strong>{fmtMoney(reservationsReport.totals.totalBalance)}</strong></div>
              </div>
            ) : null}
            {reservationsReport?.reservations?.length ? (
              <table>
                <thead>
                  <tr>
                    <th>Reservation</th>
                    <th>Customer</th>
                    <th>Pickup</th>
                    <th>Days</th>
                    <th>Vehicle</th>
                    <th>Program</th>
                    <th>Workflow</th>
                    <th>Status</th>
                    <th>Total</th>
                    <th>Paid</th>
                    <th>Balance</th>
                  </tr>
                </thead>
                <tbody>
                  {reservationsReport.reservations.slice(0, 200).map((r) => (
                    <tr key={r.reservationId}>
                      <td>{r.reservationNumber}</td>
                      <td>{r.customerName || '-'}</td>
                      <td>{humanDate(r.pickupAt)}</td>
                      <td>{r.days}</td>
                      <td>{r.vehicleUnit ? `${r.vehicleUnit} | ${r.vehicleLabel || ''}` : '-'}</td>
                      <td>
                        <span
                          className="badge"
                          style={{
                            background:
                              (r.vehicleProgramCategory || 'BOTH') === 'LOANER_ONLY' ? 'rgba(255,140,0,0.18)'
                              : (r.vehicleProgramCategory || 'BOTH') === 'RENTAL_ONLY' ? 'rgba(73,140,255,0.18)'
                              : 'rgba(160,160,160,0.18)',
                            color:
                              (r.vehicleProgramCategory || 'BOTH') === 'LOANER_ONLY' ? '#b56300'
                              : (r.vehicleProgramCategory || 'BOTH') === 'RENTAL_ONLY' ? '#1d4ed8'
                              : '#444'
                          }}
                        >
                          {(r.vehicleProgramCategory || 'BOTH') === 'LOANER_ONLY' ? 'Loaner'
                            : (r.vehicleProgramCategory || 'BOTH') === 'RENTAL_ONLY' ? 'Rental'
                            : 'Flex'}
                        </span>
                      </td>
                      <td>{r.workflowMode === 'DEALERSHIP_LOANER' ? 'Loaner' : 'Rental'}</td>
                      <td><span className="badge">{r.status}</span></td>
                      <td>{fmtMoney(r.agreementTotal)}</td>
                      <td>{fmtMoney(r.agreementPaid)}</td>
                      <td>{fmtMoney(r.agreementBalance)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <EmptyTableState text="No reservations match the current filters." />
            )}
            {reservationsReport?.reservations?.length > 200 ? (
              <p className="label" style={{ marginTop: 8 }}>
                Showing 200 of {reservationsReport.reservations.length} — export to Excel for the full list.
              </p>
            ) : null}
          </section>
        </div>
      </section>

      <style jsx global>{`
        .reports-print-only {
          display: none;
        }

        @media print {
          @page {
            size: auto;
            margin: 10mm;
          }

          .reports-screen-only,
          .page-hero,
          .surface-note {
            display: none !important;
          }

          .reports-print-only {
            display: block !important;
          }

          .reports-print-header {
            margin-bottom: 16px;
            padding-bottom: 12px;
            border-bottom: 1px solid #d1d5db;
          }

          .reports-print-title {
            font-size: 22px;
            font-weight: 700;
            margin-bottom: 8px;
          }

          .reports-print-meta {
            display: flex;
            flex-wrap: wrap;
            gap: 8px 16px;
            font-size: 12px;
            color: #4b5563;
            margin-bottom: 6px;
          }

          .glass,
          .metric-card,
          .hero-pill,
          .info-tile,
          .surface-note,
          .status-chip {
            background: #fff !important;
            border-color: #d1d5db !important;
            box-shadow: none !important;
            color: #111 !important;
          }

          .section-card,
          .metric-card,
          .table-shell,
          table,
          tr,
          .split-panel > section {
            break-inside: avoid;
            page-break-inside: avoid;
          }

          .app-banner,
          .metric-grid,
          .split-panel,
          .app-card-grid {
            gap: 12px !important;
          }

          table {
            font-size: 12px;
          }

          .ui-muted,
          .label {
            color: #4b5563 !important;
          }
        }
      `}</style>
    </AppShell>
  );
}

export default function ReportsPage() {
  return <AuthGate>{({ token, me, logout }) => <Inner token={token} me={me} logout={logout} />}</AuthGate>;
}
