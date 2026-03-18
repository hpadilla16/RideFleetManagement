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
  const [filters, setFilters] = useState({ start: daysAgo(29), end: daysAgo(0), tenantId: '', locationId: '' });
  const [report, setReport] = useState(null);
  const [msg, setMsg] = useState('');
  const [loading, setLoading] = useState(true);

  const load = async (next = filters) => {
    setLoading(true);
    try {
      const qs = new URLSearchParams({
        start: next.start,
        end: next.end,
        ...(next.tenantId ? { tenantId: next.tenantId } : {}),
        ...(next.locationId ? { locationId: next.locationId } : {})
      });
      const out = await api(`/api/reports/overview?${qs.toString()}`, {}, token);
      setReport(out);
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
  }, [token]);

  const cards = useMemo(() => metricCards(report), [report]);
  const reservationSeriesMax = Math.max(1, ...(report?.reservationsByDay || []).map((row) => Number(row.count || 0)));
  const paymentSeriesMax = Math.max(1, ...(report?.paymentsByDay || []).map((row) => Number(row.amount || 0)));

  const exportCsv = async () => {
    try {
      setMsg('');
      const qs = new URLSearchParams({
        start: filters.start,
        end: filters.end,
        ...(filters.tenantId ? { tenantId: filters.tenantId } : {}),
        ...(filters.locationId ? { locationId: filters.locationId } : {})
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

        <button onClick={() => load(filters)} disabled={loading}>Apply Range</button>
        {msg ? <p className="error">{msg}</p> : null}
        {loading ? <p className="label">Loading report...</p> : null}
        {!loading && report?.filters?.tenantName ? <p className="label">Tenant: {report.filters.tenantName}</p> : null}
        {!loading && report?.filters?.locationName ? <p className="label">Filtered by: {report.filters.locationName}</p> : null}
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
    </AppShell>
  );
}

export default function ReportsPage() {
  return <AuthGate>{({ token, me, logout }) => <Inner token={token} me={me} logout={logout} />}</AuthGate>;
}
