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
    { label: 'Collected', value: fmtMoney(kpis.collectedPayments) },
    { label: 'Open Balance', value: fmtMoney(kpis.openBalance) },
    { label: 'In Maintenance', value: kpis.vehiclesInMaintenance || 0 },
    { label: 'Utilization', value: `${Number(kpis.utilizationPct || 0).toFixed(1)}%` }
  ];
}

function Inner({ token, me, logout }) {
  const canFilterEmployee = ['SUPER_ADMIN', 'ADMIN', 'OPS'].includes(String(me?.role || '').toUpperCase());
  const [filters, setFilters] = useState({ start: daysAgo(29), end: daysAgo(0), tenantId: '', locationId: '', employeeUserId: '' });
  const [report, setReport] = useState(null);
  const [servicesSold, setServicesSold] = useState(null);
  const [commissionMonth, setCommissionMonth] = useState(monthInput(new Date()));
  const [commissionLedger, setCommissionLedger] = useState([]);
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
      const [overviewOut, servicesOut, ledgerOut] = await Promise.all([
        api(`/api/reports/overview?${reportQs.toString()}`, {}, token),
        api(`/api/reports/services-sold?${servicesQs.toString()}`, {}, token),
        api(`/api/commissions/ledger?${ledgerQs.toString()}`, {}, token)
      ]);
      setReport(overviewOut);
      setServicesSold(servicesOut);
      setCommissionLedger(Array.isArray(ledgerOut) ? ledgerOut : []);
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
  }, [token, commissionMonth]);

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

  return (
    <AppShell me={me} logout={logout}>
      <section className="glass card-lg stack">
        <div className="row-between">
          <div>
            <h2>Reports</h2>
            <p className="label">Sprint 3 - Reports v1</p>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button onClick={exportCsv} disabled={loading}>Export CSV</button>
            <button onClick={() => load(filters)} disabled={loading}>Refresh</button>
          </div>
        </div>

        <div className="grid2">
          <div>
            <span className="label">Start</span>
            <input
              type="date"
              value={filters.start}
              onChange={(e) => setFilters((prev) => ({ ...prev, start: e.target.value }))}
            />
          </div>
          <div>
            <span className="label">End</span>
            <input
              type="date"
              value={filters.end}
              onChange={(e) => setFilters((prev) => ({ ...prev, end: e.target.value }))}
            />
          </div>
        </div>

        {String(me?.role || '').toUpperCase() === 'SUPER_ADMIN' ? (
          <div>
            <span className="label">Tenant</span>
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

        <div>
          <span className="label">Location</span>
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
          <div>
            <span className="label">Employee</span>
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

        <div>
          <span className="label">Commission Month</span>
          <input
            type="month"
            value={commissionMonth}
            onChange={(e) => setCommissionMonth(e.target.value)}
          />
        </div>

        <button onClick={() => load(filters)} disabled={loading}>Apply Range</button>
        {msg ? <p className="error">{msg}</p> : null}
        {loading ? <p className="label">Loading report...</p> : null}
        {!loading && report?.filters?.tenantName ? <p className="label">Tenant: {report.filters.tenantName}</p> : null}
        {!loading && report?.filters?.locationName ? <p className="label">Filtered by: {report.filters.locationName}</p> : null}
        {!loading && canFilterEmployee && servicesSold?.filters?.employeeName ? <p className="label">Employee: {servicesSold.filters.employeeName}</p> : null}
      </section>

      <section className="grid2" style={{ marginTop: 12 }}>
        {cards.map((card) => (
          <div key={card.label} className="glass card">
            <div className="label">{card.label}</div>
            <div style={{ fontSize: 28, fontWeight: 800, marginTop: 6 }}>{card.value}</div>
          </div>
        ))}
      </section>

      <section className="grid2" style={{ marginTop: 12 }}>
        <div className="glass card-lg">
          <div className="row-between" style={{ marginBottom: 10 }}>
            <h3>Reservations By Day</h3>
            <span className="label">{report?.range?.days || 0} days</span>
          </div>
          <div className="stack">
            {(report?.reservationsByDay || []).map((row) => (
              <div key={row.date}>
                <div className="row-between">
                  <span>{row.date}</span>
                  <strong>{row.count}</strong>
                </div>
                <div style={{ height: 10, borderRadius: 999, background: 'rgba(255,255,255,.08)', overflow: 'hidden', marginTop: 4 }}>
                  <div style={{ width: `${(Number(row.count || 0) / reservationSeriesMax) * 100}%`, height: '100%', background: 'linear-gradient(90deg, #2a9d8f, #e9c46a)' }} />
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className="glass card-lg">
          <div className="row-between" style={{ marginBottom: 10 }}>
            <h3>Payments By Day</h3>
            <span className="label">Reservation payments</span>
          </div>
          <div className="stack">
            {(report?.paymentsByDay || []).map((row) => (
              <div key={row.date}>
                <div className="row-between">
                  <span>{row.date}</span>
                  <strong>{fmtMoney(row.amount)}</strong>
                </div>
                <div style={{ height: 10, borderRadius: 999, background: 'rgba(255,255,255,.08)', overflow: 'hidden', marginTop: 4 }}>
                  <div style={{ width: `${(Number(row.amount || 0) / paymentSeriesMax) * 100}%`, height: '100%', background: 'linear-gradient(90deg, #264653, #2a9d8f)' }} />
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="grid2" style={{ marginTop: 12 }}>
        <div className="glass card-lg">
          <h3>Status Breakdown</h3>
          <table>
            <thead>
              <tr>
                <th>Status</th>
                <th>Count</th>
              </tr>
            </thead>
            <tbody>
              {(report?.reservationStatusBreakdown || []).map((row) => (
                <tr key={row.status}>
                  <td>{row.status}</td>
                  <td>{row.count}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="glass card-lg">
          <h3>Top Pickup Locations</h3>
          <table>
            <thead>
              <tr>
                <th>Location</th>
                <th>Reservations</th>
              </tr>
            </thead>
            <tbody>
              {(report?.topPickupLocations || []).map((row) => (
                <tr key={row.locationId}>
                  <td>{row.name}</td>
                  <td>{row.count}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="glass card-lg stack" style={{ marginTop: 12 }}>
        <div className="row-between">
          <div>
            <h3>Services Sold</h3>
            <p className="label">Closed agreements and commission-bearing service lines</p>
          </div>
          <div className="label">
            Revenue {fmtMoney(servicesSold?.summary?.serviceRevenue)} | Commission {fmtMoney(servicesSold?.summary?.commissionAmount)}
          </div>
        </div>

        <div className="grid2">
          <div className="glass card">
            <div className="label">Service Lines</div>
            <div style={{ fontSize: 28, fontWeight: 800, marginTop: 6 }}>{servicesSold?.summary?.servicesSoldCount || 0}</div>
          </div>
          <div className="glass card">
            <div className="label">Units Sold</div>
            <div style={{ fontSize: 28, fontWeight: 800, marginTop: 6 }}>{Number(servicesSold?.summary?.unitsSold || 0).toFixed(2)}</div>
          </div>
          <div className="glass card">
            <div className="label">Agreements Closed</div>
            <div style={{ fontSize: 28, fontWeight: 800, marginTop: 6 }}>{servicesSold?.summary?.agreementsClosed || 0}</div>
          </div>
          <div className="glass card">
            <div className="label">Commission</div>
            <div style={{ fontSize: 28, fontWeight: 800, marginTop: 6 }}>{fmtMoney(servicesSold?.summary?.commissionAmount)}</div>
          </div>
        </div>

        <div className="grid2">
          <div>
            <h4>By Service</h4>
            <table>
              <thead>
                <tr>
                  <th>Service</th>
                  <th>Units</th>
                  <th>Revenue</th>
                  <th>Commission</th>
                  <th>Agreements</th>
                </tr>
              </thead>
              <tbody>
                {(servicesSold?.byService || []).map((row) => (
                  <tr key={row.serviceId}>
                    <td>{row.serviceName}</td>
                    <td>{Number(row.unitsSold || 0).toFixed(2)}</td>
                    <td>{fmtMoney(row.serviceRevenue)}</td>
                    <td>{fmtMoney(row.commissionAmount)}</td>
                    <td>{row.agreementsClosed}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {canFilterEmployee ? (
          <div>
            <h4>By Employee</h4>
            <table>
              <thead>
                <tr>
                  <th>Employee</th>
                  <th>Units</th>
                  <th>Revenue</th>
                  <th>Commission</th>
                  <th>Agreements</th>
                </tr>
              </thead>
              <tbody>
                {(servicesSold?.byEmployee || []).map((row) => (
                  <tr key={row.employeeUserId}>
                    <td>{row.employeeName}</td>
                    <td>{Number(row.unitsSold || 0).toFixed(2)}</td>
                    <td>{fmtMoney(row.serviceRevenue)}</td>
                    <td>{fmtMoney(row.commissionAmount)}</td>
                    <td>{row.agreementsClosed}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          ) : null}
        </div>
      </section>

      <section className="glass card-lg stack" style={{ marginTop: 12 }}>
        <div className="row-between">
          <div>
            <h3>{canFilterEmployee && servicesSold?.filters?.employeeName ? `${servicesSold.filters.employeeName} Commission` : 'My Commission'}</h3>
            <p className="label">Month-to-month commission snapshot from closed agreements</p>
          </div>
          <div className="label">{commissionMonth}</div>
        </div>

        <div className="grid2">
          <div className="glass card">
            <div className="label">Closed Agreements</div>
            <div style={{ fontSize: 28, fontWeight: 800, marginTop: 6 }}>{commissionSummary.agreements}</div>
          </div>
          <div className="glass card">
            <div className="label">Gross Revenue</div>
            <div style={{ fontSize: 28, fontWeight: 800, marginTop: 6 }}>{fmtMoney(commissionSummary.grossRevenue)}</div>
          </div>
          <div className="glass card">
            <div className="label">Service Revenue</div>
            <div style={{ fontSize: 28, fontWeight: 800, marginTop: 6 }}>{fmtMoney(commissionSummary.serviceRevenue)}</div>
          </div>
          <div className="glass card">
            <div className="label">Commission Earned</div>
            <div style={{ fontSize: 28, fontWeight: 800, marginTop: 6 }}>{fmtMoney(commissionSummary.commissionAmount)}</div>
          </div>
        </div>

        <div>
          <h4>Agreement Ledger</h4>
          <table>
            <thead>
              <tr>
                <th>Agreement</th>
                <th>Closed</th>
                <th>Gross</th>
                <th>Service Revenue</th>
                <th>Commission</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {(commissionLedger || []).map((row) => (
                <tr key={row.id}>
                  <td>{row.rentalAgreement?.agreementNumber || row.rentalAgreementId}</td>
                  <td>{row.rentalAgreement?.closedAt ? new Date(row.rentalAgreement.closedAt).toLocaleDateString() : '-'}</td>
                  <td>{fmtMoney(row.grossRevenue)}</td>
                  <td>{fmtMoney(row.serviceRevenue)}</td>
                  <td>{fmtMoney(row.commissionAmount)}</td>
                  <td>{row.status}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div>
          <h4>Commission Lines</h4>
          <table>
            <thead>
              <tr>
                <th>Agreement</th>
                <th>Line</th>
                <th>Qty</th>
                <th>Revenue</th>
                <th>Rule</th>
                <th>Commission</th>
              </tr>
            </thead>
            <tbody>
              {(commissionLedger || [])
                .flatMap((row) => (row.lines || []).map((line) => ({ ...line, agreementNumber: row.rentalAgreement?.agreementNumber || row.rentalAgreementId || row.id })))
                .map((line) => (
                  <tr key={line.id}>
                    <td>{line.agreementNumber}</td>
                    <td>{line.service?.name || line.description}</td>
                    <td>{Number(line.quantity || 0).toFixed(2)}</td>
                    <td>{fmtMoney(line.lineRevenue)}</td>
                    <td>{line.valueType}</td>
                    <td>{fmtMoney(line.commissionAmount)}</td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      </section>
    </AppShell>
  );
}

export default function ReportsPage() {
  return <AuthGate>{({ token, me, logout }) => <Inner token={token} me={me} logout={logout} />}</AuthGate>;
}
