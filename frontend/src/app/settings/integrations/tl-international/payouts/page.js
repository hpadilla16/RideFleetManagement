'use client';

/**
 * TL International - Monthly payout report (Surface 4, task 24 phase 1).
 *
 * Tracks expected vs. received payments from TL International per month.
 * ADMIN + SUPER_ADMIN gated (ADMIN scoped to own tenant via backend).
 *
 * Critical business rule (also enforced in backend):
 *   An ExternalReservation counts as BILLABLE only if the promoted
 *   Reservation has a RentalAgreement with status IN ('FINALIZED', 'CLOSED').
 *
 * Backend:
 *   GET /payout-periods?year=&tenantId=
 *       -> { periods: [{ year, month, expectedAmount, receivedAmount, receivedAt, notes, closedAt }] }
 *   GET /payout-periods/:year/:month/reservations
 *       -> { rows: [{ externalRef, customer, totalAmount, pickupAt, agreementStatus,
 *                     bucket: 'billable' | 'pending' | 'notbillable' }] }
 *   PUT /payout-periods/:year/:month
 *       body: { receivedAmount?, receivedAt?, notes?, closedAt? }
 */

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { AuthGate } from '../../../../../components/AuthGate';
import { AppShell } from '../../../../../components/AppShell';
import { api } from '../../../../../lib/client';

const MONTH_NAMES = [
  ['Enero', 'January'], ['Febrero', 'February'], ['Marzo', 'March'],
  ['Abril', 'April'], ['Mayo', 'May'], ['Junio', 'June'],
  ['Julio', 'July'], ['Agosto', 'August'], ['Septiembre', 'September'],
  ['Octubre', 'October'], ['Noviembre', 'November'], ['Diciembre', 'December']
];

function fmtMoney(n) {
  const num = Number(n);
  if (!Number.isFinite(num)) return '$0.00';
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(num);
}

function fmtDate(iso) {
  if (!iso) return '-';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString();
}

function VarianceCell({ expected, received }) {
  const exp = Number(expected || 0);
  const rec = Number(received || 0);
  const variance = exp - rec;
  let color = '#6b7280';
  if (Math.abs(variance) < 0.01) color = '#16a34a';
  else if (variance > 0) color = '#dc2626';
  else color = '#6b7280';
  return <span style={{ color, fontWeight: 600 }}>{fmtMoney(variance)}</span>;
}

function BucketBadge({ bucket }) {
  const map = {
    billable: { bg: '#dcfce7', fg: '#166534', label: 'Cobrable / Billable' },
    pending: { bg: '#fef3c7', fg: '#92400e', label: 'Pendiente / Pending' },
    notbillable: { bg: '#fee2e2', fg: '#991b1b', label: 'No cobrable / Not billable' }
  };
  const cfg = map[bucket] || { bg: '#e5e7eb', fg: '#374151', label: bucket || '-' };
  return (
    <span style={{ background: cfg.bg, color: cfg.fg, padding: '2px 8px', borderRadius: 999, fontSize: 11, fontWeight: 600 }}>
      {cfg.label}
    </span>
  );
}

function AgreementStatusPill({ status }) {
  const s = String(status || '').toUpperCase();
  const styles = {
    FINALIZED: { bg: '#dcfce7', fg: '#166534' },
    CLOSED: { bg: '#dbeafe', fg: '#1e40af' },
    DRAFT: { bg: '#fef3c7', fg: '#92400e' },
    PENDING: { bg: '#fef3c7', fg: '#92400e' },
    CANCELLED: { bg: '#fee2e2', fg: '#991b1b' },
    NONE: { bg: '#e5e7eb', fg: '#374151' }
  };
  const cfg = styles[s] || { bg: '#e5e7eb', fg: '#374151' };
  return (
    <span style={{ background: cfg.bg, color: cfg.fg, padding: '2px 8px', borderRadius: 999, fontSize: 11, fontWeight: 600 }}>
      {status || 'NONE'}
    </span>
  );
}

function toCsv(rows, headers) {
  const escape = (v) => {
    if (v == null) return '';
    const s = String(v);
    if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
    return s;
  };
  const lines = [headers.map((h) => h.label).join(',')];
  for (const r of rows) {
    lines.push(headers.map((h) => escape(typeof h.value === 'function' ? h.value(r) : r[h.value])).join(','));
  }
  return lines.join('\n');
}

function downloadCsv(filename, csv) {
  if (typeof window === 'undefined') return;
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export default function TLPayoutsPage() {
  return <AuthGate>{({ token, me, logout }) => <Inner token={token} me={me} logout={logout} />}</AuthGate>;
}

function Inner({ token, me, logout }) {
  const role = String(me?.role || '').toUpperCase().trim();
  const isSuper = role === 'SUPER_ADMIN';
  // 2026-05-26: ADMIN can also see TL payouts (scoped to their own tenant).
  const canAccess = isSuper || role === 'ADMIN';
  const currentYear = new Date().getFullYear();
  const [year, setYear] = useState(currentYear);
  const [periods, setPeriods] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [drawerMonth, setDrawerMonth] = useState(null); // { year, month }

  if (!canAccess) {
    return (
      <AppShell me={me} logout={logout}>
        <div style={{ padding: 20 }}>
          <strong>Admin access required.</strong> Restricted to ADMIN and SUPER_ADMIN.
        </div>
      </AppShell>
    );
  }

  const load = async () => {
    setLoading(true);
    setError('');
    try {
      const res = await api(`/api/admin/integrations/tl-international/payout-periods?year=${year}`, { bypassCache: true }, token);
      setPeriods(Array.isArray(res?.periods) ? res.periods : []);
    } catch (e) {
      setError(e?.message || 'No se pudo cargar / Could not load');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [token, year]);

  const ytd = useMemo(() => {
    let expected = 0, received = 0;
    for (const p of periods) {
      expected += Number(p.expectedAmount || 0);
      received += Number(p.receivedAmount || 0);
    }
    return { expected, received, variance: expected - received };
  }, [periods]);

  const handleUpdate = async (year, month, patch) => {
    try {
      const res = await api(
        `/api/admin/integrations/tl-international/payout-periods/${year}/${month}`,
        { method: 'PUT', body: JSON.stringify(patch) },
        token
      );
      if (res?.ok) await load();
    } catch (err) {
      setError(err?.message || 'Error al guardar / Error saving');
    }
  };

  const exportYear = () => {
    const rows = periods.map((p) => ({
      year: p.year, month: p.month, monthName: MONTH_NAMES[(p.month || 1) - 1][1],
      expected: p.expectedAmount, received: p.receivedAmount,
      variance: Number(p.expectedAmount || 0) - Number(p.receivedAmount || 0),
      receivedAt: p.receivedAt, closedAt: p.closedAt, notes: p.notes
    }));
    const headers = [
      { label: 'Year', value: 'year' },
      { label: 'Month', value: 'month' },
      { label: 'MonthName', value: 'monthName' },
      { label: 'Expected', value: 'expected' },
      { label: 'Received', value: 'received' },
      { label: 'Variance', value: 'variance' },
      { label: 'ReceivedAt', value: 'receivedAt' },
      { label: 'ClosedAt', value: 'closedAt' },
      { label: 'Notes', value: 'notes' }
    ];
    downloadCsv(`tl-payouts-${year}.csv`, toCsv(rows, headers));
  };

  // Ensure 12 months exist (fill blanks for months without records yet).
  const monthsTable = useMemo(() => {
    const byMonth = new Map(periods.map((p) => [p.month, p]));
    return Array.from({ length: 12 }, (_, i) => {
      const m = i + 1;
      return byMonth.get(m) || { year, month: m, expectedAmount: 0, receivedAmount: 0, receivedAt: null, notes: '', closedAt: null };
    });
  }, [periods, year]);

  return (
    <AppShell me={me} logout={logout}>
      <section className="glass card-lg section-card" style={{ marginBottom: 16 }}>
        <div className="ui-muted" style={{ fontSize: 13, marginBottom: 4 }}>
          <Link href="/settings" style={{ color: '#2563eb' }}>Settings</Link>
          {' > '} Integrations {' > '} TL International {' > '} Cobranza mensual / Monthly payouts
        </div>
        <div className="row-between" style={{ alignItems: 'center' }}>
          <h2 className="page-title" style={{ marginTop: 0 }}>Cobranza mensual / Monthly payouts</h2>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <label className="label" style={{ textTransform: 'none', letterSpacing: 0 }}>
              Ano / Year
              <select value={year} onChange={(e) => setYear(Number(e.target.value))}>
                {Array.from({ length: 5 }, (_, i) => currentYear - i).map((y) => (
                  <option key={y} value={y}>{y}</option>
                ))}
              </select>
            </label>
            <button type="button" onClick={exportYear}>Exportar CSV / Export CSV</button>
          </div>
        </div>
        <p className="ui-muted">
          Cobrable = reserva promovida con RentalAgreement FINALIZED o CLOSED. / Billable = promoted reservation with RentalAgreement FINALIZED or CLOSED.
        </p>

        <div className="app-card-grid compact" style={{ marginTop: 8 }}>
          <div className="info-tile">
            <span className="label">YTD esperado / YTD expected</span>
            <strong>{fmtMoney(ytd.expected)}</strong>
          </div>
          <div className="info-tile">
            <span className="label">YTD recibido / YTD received</span>
            <strong>{fmtMoney(ytd.received)}</strong>
          </div>
          <div className="info-tile">
            <span className="label">YTD variacion / YTD variance</span>
            <strong><VarianceCell expected={ytd.expected} received={ytd.received} /></strong>
          </div>
        </div>
      </section>

      <section className="glass card section-card" style={{ marginBottom: 16 }}>
        {error ? (
          <div style={{ padding: 10, background: '#fee2e2', color: '#991b1b', borderRadius: 4, marginBottom: 8 }}>{error}</div>
        ) : null}
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr style={{ borderBottom: '1px solid #e5e7eb', textAlign: 'left', background: '#f9fafb' }}>
                <th style={{ padding: '6px 8px' }}>Mes / Month</th>
                <th style={{ padding: '6px 8px', textAlign: 'right' }}>Esperado / Expected</th>
                <th style={{ padding: '6px 8px', textAlign: 'right' }}>Recibido / Received</th>
                <th style={{ padding: '6px 8px', textAlign: 'right' }}>Variacion / Variance</th>
                <th style={{ padding: '6px 8px' }}>Fecha recibido / Received at</th>
                <th style={{ padding: '6px 8px' }}>Notas / Notes</th>
                <th style={{ padding: '6px 8px' }}>Estado / Status</th>
                <th style={{ padding: '6px 8px' }}></th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr><td colSpan={8} style={{ padding: 12, color: '#6b7280' }}>Cargando... / Loading...</td></tr>
              ) : monthsTable.map((p) => (
                <tr key={`${p.year}-${p.month}`} style={{ borderBottom: '1px solid #f3f4f6' }}>
                  <td style={{ padding: '6px 8px' }}>
                    <button
                      type="button"
                      onClick={() => setDrawerMonth({ year: p.year, month: p.month })}
                      style={{ background: 'transparent', border: 0, color: '#2563eb', cursor: 'pointer', padding: 0, fontSize: 13, fontWeight: 600 }}
                    >
                      {MONTH_NAMES[p.month - 1][0]} / {MONTH_NAMES[p.month - 1][1]}
                    </button>
                  </td>
                  <td style={{ padding: '6px 8px', textAlign: 'right' }}>{fmtMoney(p.expectedAmount)}</td>
                  <td style={{ padding: '6px 8px', textAlign: 'right' }}>{fmtMoney(p.receivedAmount)}</td>
                  <td style={{ padding: '6px 8px', textAlign: 'right' }}>
                    <VarianceCell expected={p.expectedAmount} received={p.receivedAmount} />
                  </td>
                  <td style={{ padding: '6px 8px' }}>{fmtDate(p.receivedAt)}</td>
                  <td style={{ padding: '6px 8px', maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={p.notes || ''}>
                    {p.notes ? (p.notes.length > 32 ? `${p.notes.slice(0, 32)}...` : p.notes) : '-'}
                  </td>
                  <td style={{ padding: '6px 8px' }}>
                    {p.closedAt ? (
                      <span style={{ background: '#dbeafe', color: '#1e40af', padding: '2px 8px', borderRadius: 999, fontSize: 11, fontWeight: 600 }}>
                        Cerrado / Closed
                      </span>
                    ) : (
                      <span style={{ background: '#fef3c7', color: '#92400e', padding: '2px 8px', borderRadius: 999, fontSize: 11, fontWeight: 600 }}>
                        Abierto / Open
                      </span>
                    )}
                  </td>
                  <td style={{ padding: '6px 8px' }}>
                    <button type="button" onClick={() => setDrawerMonth({ year: p.year, month: p.month })}>
                      Ver / View
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {drawerMonth ? (
        <PayoutDrawer
          token={token}
          year={drawerMonth.year}
          month={drawerMonth.month}
          period={periods.find((p) => p.year === drawerMonth.year && p.month === drawerMonth.month) || { year: drawerMonth.year, month: drawerMonth.month }}
          onClose={() => setDrawerMonth(null)}
          onSaved={(patch) => handleUpdate(drawerMonth.year, drawerMonth.month, patch)}
        />
      ) : null}
    </AppShell>
  );
}

function PayoutDrawer({ token, year, month, period, onClose, onSaved }) {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [tab, setTab] = useState('billable');

  const [receivedAmount, setReceivedAmount] = useState(String(period?.receivedAmount ?? ''));
  const [receivedAt, setReceivedAt] = useState(period?.receivedAt ? String(period.receivedAt).slice(0, 10) : '');
  const [notes, setNotes] = useState(period?.notes || '');
  const [closedAt, setClosedAt] = useState(period?.closedAt ? String(period.closedAt).slice(0, 10) : '');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError('');
      try {
        const res = await api(
          `/api/admin/integrations/tl-international/payout-periods/${year}/${month}/reservations`,
          { bypassCache: true },
          token
        );
        if (cancelled) return;
        setRows(Array.isArray(res?.rows) ? res.rows : []);
      } catch (e) {
        if (!cancelled) setError(e?.message || 'No se pudo cargar / Could not load');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [year, month, token]);

  const buckets = useMemo(() => {
    const billable = rows.filter((r) => r.bucket === 'billable');
    const pending = rows.filter((r) => r.bucket === 'pending');
    const notbillable = rows.filter((r) => r.bucket === 'notbillable');
    const sum = (arr) => arr.reduce((s, r) => s + (Number(r.totalAmount) || 0), 0);
    return {
      billable, pending, notbillable,
      billableTotal: sum(billable),
      pendingTotal: sum(pending),
      notbillableTotal: sum(notbillable)
    };
  }, [rows]);

  const current = buckets[tab] || [];
  const currentTotal = tab === 'billable' ? buckets.billableTotal : tab === 'pending' ? buckets.pendingTotal : buckets.notbillableTotal;

  const save = async () => {
    setSaving(true);
    try {
      await onSaved({
        receivedAmount: receivedAmount === '' ? null : Number(receivedAmount),
        receivedAt: receivedAt || null,
        notes: notes || null,
        closedAt: closedAt || null
      });
    } finally {
      setSaving(false);
    }
  };

  const exportMonth = () => {
    const headers = [
      { label: 'ExternalRef', value: 'externalRef' },
      { label: 'Customer', value: (r) => r.customer?.fullName || `${r.customer?.firstName || ''} ${r.customer?.lastName || ''}`.trim() },
      { label: 'Total', value: 'totalAmount' },
      { label: 'PickupAt', value: 'pickupAt' },
      { label: 'AgreementStatus', value: 'agreementStatus' },
      { label: 'Bucket', value: 'bucket' }
    ];
    downloadCsv(`tl-payouts-${year}-${String(month).padStart(2, '0')}.csv`, toCsv(rows, headers));
  };

  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)',
      display: 'flex', justifyContent: 'flex-end', zIndex: 1000
    }}>
      <div style={{
        background: 'white', width: '90%', maxWidth: 920, height: '100%',
        overflow: 'auto', boxShadow: '-4px 0 16px rgba(0,0,0,0.2)'
      }}>
        <div style={{ padding: 16, borderBottom: '1px solid #e5e7eb', position: 'sticky', top: 0, background: 'white', zIndex: 1 }}>
          <div className="row-between" style={{ alignItems: 'start' }}>
            <div>
              <h3 style={{ margin: 0 }}>{MONTH_NAMES[month - 1][0]} / {MONTH_NAMES[month - 1][1]} {year}</h3>
              <div className="ui-muted" style={{ fontSize: 13 }}>
                Esperado / Expected: <strong>{fmtMoney(period?.expectedAmount)}</strong>
              </div>
            </div>
            <button type="button" onClick={onClose}>x Cerrar / Close</button>
          </div>

          <div className="app-card-grid compact" style={{ marginTop: 12 }}>
            <label className="label" style={{ textTransform: 'none', letterSpacing: 0 }}>
              Recibido / Received ($)
              <input type="number" step="0.01" value={receivedAmount} onChange={(e) => setReceivedAmount(e.target.value)} />
            </label>
            <label className="label" style={{ textTransform: 'none', letterSpacing: 0 }}>
              Fecha / Received at
              <input type="date" value={receivedAt} onChange={(e) => setReceivedAt(e.target.value)} />
            </label>
            <label className="label" style={{ textTransform: 'none', letterSpacing: 0 }}>
              Cerrar / Close on
              <input type="date" value={closedAt} onChange={(e) => setClosedAt(e.target.value)} />
            </label>
            <div className="info-tile">
              <span className="label">Variacion / Variance</span>
              <strong><VarianceCell expected={period?.expectedAmount} received={receivedAmount} /></strong>
            </div>
          </div>
          <label className="label" style={{ textTransform: 'none', letterSpacing: 0, display: 'block', marginTop: 8 }}>
            Notas / Notes
            <textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} style={{ width: '100%' }} />
          </label>
          <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
            <button type="button" onClick={save} disabled={saving}>
              {saving ? 'Guardando... / Saving...' : 'Guardar recibido / Save received'}
            </button>
            <button type="button" onClick={exportMonth}>Exportar CSV / Export CSV</button>
          </div>
        </div>

        <div style={{ padding: 16 }}>
          {error ? (
            <div style={{ padding: 10, background: '#fee2e2', color: '#991b1b', borderRadius: 4, marginBottom: 8 }}>{error}</div>
          ) : null}

          <div style={{ display: 'flex', gap: 4, borderBottom: '1px solid #e5e7eb', marginBottom: 8 }}>
            {[
              { id: 'billable', label: `Cobrable / Billable (${buckets.billable.length})` },
              { id: 'pending', label: `Pendiente / Pending (${buckets.pending.length})` },
              { id: 'notbillable', label: `No cobrable / Not billable (${buckets.notbillable.length})` }
            ].map((t) => (
              <button
                key={t.id}
                type="button"
                onClick={() => setTab(t.id)}
                style={{
                  padding: '8px 12px',
                  background: tab === t.id ? '#eff6ff' : 'transparent',
                  border: 0,
                  borderBottom: tab === t.id ? '2px solid #2563eb' : '2px solid transparent',
                  color: tab === t.id ? '#1e40af' : '#374151',
                  cursor: 'pointer',
                  fontWeight: 600
                }}
              >
                {t.label}
              </button>
            ))}
          </div>

          {loading ? (
            <div style={{ padding: 12, color: '#6b7280' }}>Cargando... / Loading...</div>
          ) : (
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                <thead>
                  <tr style={{ borderBottom: '1px solid #e5e7eb', textAlign: 'left', background: '#f9fafb' }}>
                    <th style={{ padding: '6px 8px' }}>Ref TL / ZE#</th>
                    <th style={{ padding: '6px 8px' }}>Cliente / Customer</th>
                    <th style={{ padding: '6px 8px', textAlign: 'right' }}>Total</th>
                    <th style={{ padding: '6px 8px' }}>Pickup</th>
                    <th style={{ padding: '6px 8px' }}>Contrato / Agreement</th>
                    <th style={{ padding: '6px 8px' }}>Bucket</th>
                  </tr>
                </thead>
                <tbody>
                  {current.length === 0 ? (
                    <tr><td colSpan={6} style={{ padding: 12, color: '#6b7280' }}>Sin reservas en este bucket / No reservations in this bucket</td></tr>
                  ) : current.map((r) => (
                    <tr key={r.id || r.externalRef} style={{ borderBottom: '1px solid #f3f4f6' }}>
                      <td style={{ padding: '6px 8px' }}>
                        <code>{r.externalRef}</code>
                        <button
                          type="button"
                          onClick={async () => {
                            try { if (navigator.clipboard) await navigator.clipboard.writeText(String(r.externalRef || '')); } catch {}
                          }}
                          style={{ marginLeft: 4, fontSize: 11, padding: '0 6px' }}
                        >
                          Copy
                        </button>
                      </td>
                      <td style={{ padding: '6px 8px' }}>
                        {r.customer?.fullName || `${r.customer?.firstName || ''} ${r.customer?.lastName || ''}`.trim() || '-'}
                      </td>
                      <td style={{ padding: '6px 8px', textAlign: 'right' }}>{fmtMoney(r.totalAmount)}</td>
                      <td style={{ padding: '6px 8px' }}>{fmtDate(r.pickupAt)}</td>
                      <td style={{ padding: '6px 8px' }}><AgreementStatusPill status={r.agreementStatus} /></td>
                      <td style={{ padding: '6px 8px' }}><BucketBadge bucket={r.bucket} /></td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr style={{ borderTop: '2px solid #e5e7eb', background: '#f9fafb', fontWeight: 700 }}>
                    <td colSpan={2} style={{ padding: '8px' }}>Subtotal {tab}</td>
                    <td style={{ padding: '8px', textAlign: 'right' }}>{fmtMoney(currentTotal)}</td>
                    <td colSpan={3} />
                  </tr>
                </tfoot>
              </table>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
