'use client';

import { useEffect, useMemo, useState } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { AuthGate } from '../../../components/AuthGate';
import { AppShell } from '../../../components/AppShell';
import { api } from '../../../lib/client';

export default function CustomerDetailPage() {
  return <AuthGate>{({ token, me, logout }) => <Inner token={token} me={me} logout={logout} />}</AuthGate>;
}

function Inner({ token, me, logout }) {
  const { id } = useParams();
  const [row, setRow] = useState(null);
  const [msg, setMsg] = useState('');
  const [reason, setReason] = useState('');
  const [creditDelta, setCreditDelta] = useState('');

  const load = async () => {
    const c = await api(`/api/customers/${id}`, {}, token);
    setRow(c);
    setReason(c.doNotRentReason || '');
  };

  useEffect(() => { if (id) load(); }, [id, token]);

  const adjustCredit = async () => {
    if (me?.role !== 'ADMIN') { setMsg('Admin approval required'); return; }
    const delta = Number(creditDelta || 0);
    if (!Number.isFinite(delta) || delta === 0) { setMsg('Enter non-zero credit adjustment'); return; }
    try {
      await api(`/api/customers/${row.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ creditBalance: Number((Number(row.creditBalance || 0) + delta).toFixed(2)) })
      }, token);
      setMsg('Credit balance updated');
      setCreditDelta('');
      await load();
    } catch (e) {
      setMsg(e.message);
    }
  };

  const issuePasswordReset = async () => {
    if (me?.role !== 'ADMIN') { setMsg('Admin approval required'); return; }
    try {
      const out = await api(`/api/customers/${row.id}/password-reset`, { method: 'POST' }, token);
      const link = out?.resetLink || '';
      if (link && navigator?.clipboard) {
        try { await navigator.clipboard.writeText(link); } catch {}
      }
      window.alert(`Password reset link created.\n\n${link}${link ? '\n\n(Link copied to clipboard if allowed.)' : ''}`);
      setMsg('Password reset link issued');
    } catch (e) {
      setMsg(e.message);
    }
  };

  const toggleDoNotRent = async () => {
    if (!row) return;
    try {
      const patch = row.doNotRent
        ? { doNotRent: false, doNotRentReason: null }
        : { doNotRent: true, doNotRentReason: reason || null };
      await api(`/api/customers/${row.id}`, { method: 'PATCH', body: JSON.stringify(patch) }, token);
      setMsg(row.doNotRent ? 'Removed from Do Not Rent list' : 'Customer added to Do Not Rent list');
      await load();
    } catch (e) {
      setMsg(e.message);
    }
  };

  const unpaid = useMemo(() => Number(row?.unpaidBalance || 0), [row]);
  const reservationCount = row?.reservations?.length || 0;
  const agreementCount = row?.agreements?.length || 0;
  const holdState = row?.doNotRent ? 'On Hold' : 'Active';

  return (
    <AppShell me={me} logout={logout}>
      {msg ? <p className="label">{msg}</p> : null}
      {!row ? <section className="glass card-lg">Loading customer...</section> : (
        <section className="glass card-lg stack">
          <div className="app-banner">
            <div className="row-between" style={{ marginBottom: 0 }}>
              <div className="stack" style={{ gap: 6 }}>
                <span className="eyebrow">Customer Snapshot</span>
                <h3 style={{ margin: 0 }}>{row.firstName} {row.lastName}</h3>
                <p className="ui-muted">
                  Keep account status, balances, and booking history visible while you manage hold, credit, and password actions.
                </p>
              </div>
              <span className={`status-chip ${row.doNotRent ? 'warn' : 'good'}`}>{holdState}</span>
            </div>
            <div className="app-card-grid compact">
              <div className="info-tile">
                <span className="label">Unpaid Balance</span>
                <strong>${unpaid.toFixed(2)}</strong>
              </div>
              <div className="info-tile">
                <span className="label">Credit Balance</span>
                <strong>${Number(row.creditBalance || 0).toFixed(2)}</strong>
              </div>
              <div className="info-tile">
                <span className="label">Reservations</span>
                <strong>{reservationCount}</strong>
              </div>
              <div className="info-tile">
                <span className="label">Agreements</span>
                <strong>{agreementCount}</strong>
              </div>
            </div>
          </div>

          <div className="row-between">
            <h2>{row.firstName} {row.lastName}</h2>
            <div className="label">Account: {row.doNotRent ? 'Hold' : 'Active'}</div>
          </div>

          <div className="grid2">
            <div className="stack">
              <div><span className="label">Email</span><div>{row.email || '-'}</div></div>
              <div><span className="label">Phone</span><div>{row.phone || '-'}</div></div>
              <div><span className="label">DOB</span><div>{row.dateOfBirth ? new Date(row.dateOfBirth).toLocaleDateString() : '-'}</div></div>
              <div><span className="label">License</span><div>{row.licenseNumber || '-'} {row.licenseState || ''}</div></div>
              <div><span className="label">Address</span><div>{[row.address1, row.address2, row.city, row.state, row.zip, row.country].filter(Boolean).join(', ') || '-'}</div></div>
              <div><span className="label">Insurance Policy</span><div>{row.insurancePolicyNumber || '-'}</div></div>
              <div><span className="label">Unpaid Balance</span><div><strong>${unpaid.toFixed(2)}</strong></div></div>
              <div><span className="label">Credit Balance</span><div><strong>${Number(row.creditBalance || 0).toFixed(2)}</strong></div></div>
              {row.idPhotoUrl ? <img src={row.idPhotoUrl} alt="ID" style={{ maxWidth: 280, border: '1px solid #ddd', borderRadius: 8 }} /> : null}
            </div>

            <div className="stack" style={{ maxWidth: 340, marginLeft: 'auto' }}>
              <div className="label">Internal account control</div>
              {me?.role === 'ADMIN' ? (
                <>
                  <div className="grid2">
                    <input placeholder="Credit +/-" value={creditDelta} onChange={(e) => setCreditDelta(e.target.value)} />
                    <button onClick={adjustCredit} style={{ fontSize: 12, padding: '6px 10px', opacity: 0.85 }}>Apply Credit</button>
                  </div>
                  <button onClick={issuePasswordReset} style={{ fontSize: 12, padding: '6px 10px', opacity: 0.85 }}>Issue Password Reset</button>
                  <textarea rows={3} placeholder="Private note" value={reason} onChange={(e) => setReason(e.target.value)} />
                  <button onClick={toggleDoNotRent} style={{ fontSize: 12, padding: '6px 10px', opacity: 0.85 }}>{row.doNotRent ? 'Remove Hold' : 'Place Hold'}</button>
                </>
              ) : <div className="label">Admin approval required for hold/credit changes.</div>}
              {row.doNotRentReason ? <div className="label">Note: {row.doNotRentReason}</div> : null}
            </div>
          </div>

          <div className="stack">
            <h3>Associated Reservations</h3>
            <table>
              <thead><tr><th>#</th><th>Status</th><th>Pickup</th><th>Return</th><th>Estimated</th><th>Alert</th></tr></thead>
              <tbody>
                {(row.reservations || []).map((r) => (
                  <tr key={r.id}>
                    <td><Link href={`/reservations/${r.id}`}>{r.reservationNumber}</Link></td>
                    <td>{r.status}</td>
                    <td>{new Date(r.pickupAt).toLocaleString()}</td>
                    <td>{new Date(r.returnAt).toLocaleString()}</td>
                    <td>${Number(r.estimatedTotal || 0).toFixed(2)}</td>
                    <td>{r.underageAlert ? <span className="badge" style={{ background: '#fee2e2', color: '#7f1d1d', borderColor: '#fecaca' }}>UNDERAGE</span> : '-'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="stack">
            <h3>Associated Agreements</h3>
            <table>
              <thead><tr><th>Agreement</th><th>Status</th><th>Total</th><th>Balance</th><th>Reservation</th></tr></thead>
              <tbody>
                {(row.agreements || []).map((a) => (
                  <tr key={a.id}>
                    <td>{a.agreementNumber}</td>
                    <td>{a.status}</td>
                    <td>${Number(a.total || 0).toFixed(2)}</td>
                    <td>${Number(a.balance || 0).toFixed(2)}</td>
                    <td>{a.reservation?.reservationNumber || '-'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </AppShell>
  );
}
