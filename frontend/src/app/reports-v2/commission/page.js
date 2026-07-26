'use client';

/**
 * Commission Payouts (slug 'commission') — resurrected 2026-07-25 (LAX #5).
 *
 * The LEDGER view: what AgreementCommission actually owes/paid per employee
 * — including review-tier and virtual-agent rows the catalog-based Sales
 * Performance report can't see — plus each employee's VALIDATED review
 * count (the number that drives their tier percent). Admins drill into an
 * employee and walk rows through the soft-gated workflow:
 * Approve → Mark paid (or Void), every action audited server-side.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { AuthGate } from '../../../components/AuthGate';
import { AppShell } from '../../../components/AppShell';
import { ReportPageLayout } from '../../../components/reports/ReportPageLayout';
import { api } from '../../../lib/client';

function money(n) { return `$${Number(n || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`; }
function isoDay(d) { const p = (x) => String(x).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`; }

const STATUS_STYLE = {
  PAID: { background: '#dcfce7', color: '#166534' },
  APPROVED: { background: '#dbeafe', color: '#1e40af' },
  PENDING: { background: '#fef3c7', color: '#92400e' },
  VOID: { background: '#e5e7eb', color: '#374151' }
};

function StatusChip({ status }) {
  const s = STATUS_STYLE[String(status || '').toUpperCase()] || STATUS_STYLE.VOID;
  return <span style={{ ...s, padding: '2px 8px', borderRadius: 999, fontSize: 11, fontWeight: 700 }}>{status}</span>;
}

export default function CommissionPayoutsPage() {
  return <AuthGate>{({ token, me, logout }) => (
    <AppShell me={me} logout={logout}>
      <Inner token={token} me={me} />
    </AppShell>
  )}</AuthGate>;
}

function Inner({ token, me }) {
  const isAdmin = ['ADMIN', 'SUPER_ADMIN'].includes(String(me?.role || '').toUpperCase());
  const [range, setRange] = useState(() => {
    const now = new Date();
    return { from: isoDay(new Date(now.getFullYear(), now.getMonth(), 1)), to: isoDay(now) };
  });
  const [data, setData] = useState(null);
  const [err, setErr] = useState('');
  const [openEmployee, setOpenEmployee] = useState(null); // employeeUserId
  const [drill, setDrill] = useState(null);
  const [drillBusy, setDrillBusy] = useState(false);
  const [actionBusy, setActionBusy] = useState('');

  const load = useCallback(async () => {
    try {
      setErr('');
      const q = new URLSearchParams({ from: range.from, to: range.to });
      setData(await api(`/api/reports/commission?${q}`, {}, token));
    } catch (e) {
      setErr(e?.message || 'Failed to load');
      setData(null);
    }
  }, [range.from, range.to, token]);

  useEffect(() => { load(); }, [load]);

  const loadDrill = useCallback(async (employeeUserId) => {
    try {
      setDrillBusy(true);
      const q = new URLSearchParams({ from: range.from, to: range.to, employeeUserId });
      setDrill(await api(`/api/reports/commission/employee?${q}`, {}, token));
    } catch (e) {
      setDrill({ error: e?.message || 'Failed to load employee detail' });
    } finally {
      setDrillBusy(false);
    }
  }, [range.from, range.to, token]);

  useEffect(() => {
    if (openEmployee) loadDrill(openEmployee);
    else setDrill(null);
  }, [openEmployee, loadDrill]);

  const act = async (commissionId, action) => {
    const note = action === 'void' ? (window.prompt('Reason for voiding this commission?') || '') : '';
    if (action === 'void' && !note.trim()) return;
    try {
      setActionBusy(commissionId + action);
      await api(`/api/commissions/ledger/${commissionId}/${action}`, {
        method: 'POST',
        body: JSON.stringify(note ? { note } : {})
      }, token);
      await Promise.all([load(), openEmployee ? loadDrill(openEmployee) : Promise.resolve()]);
    } catch (e) {
      alert(e?.message || `${action} failed`);
    } finally {
      setActionBusy('');
    }
  };

  const totals = data?.totals || {};
  const byEmployee = useMemo(() => (data?.byEmployee || []), [data]);

  return (
    <ReportPageLayout
      slug="commission"
      title="Commission Payouts"
      description="The ledger view — what each employee is owed and has been paid, with their validated review count. Approve and mark paid from here."
      category="OPERATIONS"
      token={token}
      range={range}
      onRangeChange={setRange}
    >
      {err ? <p className="error">{err}</p> : null}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: 12, marginBottom: 18 }}>
        <div className="glass card" style={{ padding: 14 }}>
          <div className="label">Total Commission</div>
          <strong style={{ fontSize: 20 }}>{money(totals.amount)}</strong>
        </div>
        <div className="glass card" style={{ padding: 14 }}>
          <div className="label">Rentals</div>
          <strong style={{ fontSize: 20 }}>{totals.rentalCount ?? totals.count ?? 0}</strong>
        </div>
        <div className="glass card" style={{ padding: 14 }}>
          <div className="label">Employees</div>
          <strong style={{ fontSize: 20 }}>{byEmployee.length}</strong>
        </div>
      </div>

      <div className="glass card" style={{ padding: 14 }}>
        <table style={{ width: '100%' }}>
          <thead>
            <tr>
              <th style={{ textAlign: 'left' }}>Employee</th>
              <th>Rentals</th>
              <th>Reviews (validated)</th>
              <th style={{ textAlign: 'right' }}>Commission</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {byEmployee.length ? byEmployee.map((e) => (
              <tr key={e.employeeUserId}>
                <td>{e.employeeName || e.employeeEmail || e.employeeUserId}</td>
                <td style={{ textAlign: 'center' }}>{e.rentalCount ?? e.count ?? 0}</td>
                <td style={{ textAlign: 'center' }}>{e.reviewsValidated ?? 0}</td>
                <td style={{ textAlign: 'right' }}><strong>{money(e.amount)}</strong></td>
                <td style={{ textAlign: 'right' }}>
                  <button type="button" className="button-subtle"
                    onClick={() => setOpenEmployee(openEmployee === e.employeeUserId ? null : e.employeeUserId)}>
                    {openEmployee === e.employeeUserId ? 'Hide' : 'Detail'}
                  </button>
                </td>
              </tr>
            )) : (
              <tr><td colSpan={5} className="ui-muted">No commission rows in this range.</td></tr>
            )}
          </tbody>
        </table>
      </div>

      {openEmployee ? (
        <div className="glass card" style={{ padding: 14, marginTop: 14 }}>
          <div className="row-between" style={{ marginBottom: 8 }}>
            <h3 style={{ margin: 0 }}>Agreements — {byEmployee.find((e) => e.employeeUserId === openEmployee)?.employeeName || 'employee'}</h3>
            {drill && !drill.error ? <span className="label">{drill.commissionCount} row(s) · {money(drill.totalAmount)}</span> : null}
          </div>
          {drillBusy ? <div className="ui-muted">Loading…</div> : null}
          {drill?.error ? <p className="error">{drill.error}</p> : null}
          {drill && !drill.error ? (
            <table style={{ width: '100%' }}>
              <thead>
                <tr>
                  <th style={{ textAlign: 'left' }}>Agreement</th>
                  <th style={{ textAlign: 'left' }}>Customer</th>
                  <th>Month</th>
                  <th>Status</th>
                  <th style={{ textAlign: 'right' }}>Amount</th>
                  {isAdmin ? <th></th> : null}
                </tr>
              </thead>
              <tbody>
                {(drill.commissions || []).map((c) => (
                  <tr key={c.id}>
                    <td>{c.agreementNumber || '-'}</td>
                    <td>{c.customerName || '-'}</td>
                    <td style={{ textAlign: 'center' }}>{c.monthKey}</td>
                    <td style={{ textAlign: 'center' }}><StatusChip status={c.status} /></td>
                    <td style={{ textAlign: 'right' }}><strong>{money(c.commissionAmount)}</strong></td>
                    {isAdmin ? (
                      <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                        {c.status === 'PENDING' ? (
                          <button type="button" className="button-subtle" disabled={!!actionBusy}
                            onClick={() => act(c.id, 'approve')}>
                            {actionBusy === c.id + 'approve' ? '…' : 'Approve'}
                          </button>
                        ) : null}
                        {['PENDING', 'APPROVED'].includes(c.status) ? (
                          <>
                            {' '}
                            <button type="button" className="button-subtle" disabled={!!actionBusy}
                              onClick={() => act(c.id, 'mark-paid')}>
                              {actionBusy === c.id + 'mark-paid' ? '…' : 'Mark paid'}
                            </button>
                            {' '}
                            <button type="button" className="button-subtle" disabled={!!actionBusy}
                              onClick={() => act(c.id, 'void')}>
                              {actionBusy === c.id + 'void' ? '…' : 'Void'}
                            </button>
                          </>
                        ) : null}
                      </td>
                    ) : null}
                  </tr>
                ))}
              </tbody>
            </table>
          ) : null}
        </div>
      ) : null}
    </ReportPageLayout>
  );
}
