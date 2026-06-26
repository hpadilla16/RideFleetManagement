'use client';

import { useEffect, useState } from 'react';
import { api } from '../../lib/client';

/**
 * Customer Requests queue (2026-06-26): portal-initiated extension / scheduled-return requests.
 * Backend: GET /api/dealership-loaner/customer-requests, POST .../customer-requests/:id/resolve.
 * Apply pushes the requested date onto the reservation; Dismiss just clears the request.
 */
export function CustomerRequestsPanel({ token }) {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState(null);
  const [msg, setMsg] = useState('');

  const load = async () => {
    setLoading(true);
    try {
      const out = await api('/api/dealership-loaner/customer-requests', { bypassCache: true }, token);
      setRows(Array.isArray(out?.requests) ? out.requests : []);
    } catch (e) {
      setMsg(`Failed to load customer requests: ${e.message || e}`);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); /* eslint-disable-next-line */ }, []);

  const resolve = async (agreementId, apply) => {
    setBusyId(agreementId);
    try {
      await api(`/api/dealership-loaner/customer-requests/${agreementId}/resolve`, { method: 'POST', body: JSON.stringify({ apply }) }, token);
      setMsg(apply ? 'Request approved — date applied.' : 'Request dismissed.');
      await load();
    } catch (e) {
      setMsg(`Action failed: ${e.message || e}`);
    } finally {
      setBusyId(null);
    }
  };

  const fmt = (v) => { if (!v) return '—'; const d = new Date(v); return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString('en-US', { timeZone: 'America/Puerto_Rico' }); };

  if (!loading && rows.length === 0) return null; // hide when empty — keeps the dashboard clean

  return (
    <section className="app-card" style={{ marginTop: 10, borderLeft: '3px solid #f59e0b' }}>
      <div className="row-between">
        <h3 style={{ margin: 0 }}>⏰ Customer Requests {loading ? '' : `(${rows.length})`}</h3>
      </div>
      {msg ? <p style={{ fontSize: 13, color: '#666' }}>{msg}</p> : null}
      {loading ? <p>Loading…</p> : (
        <table>
          <thead>
            <tr><th>Received</th><th>Customer</th><th>RO</th><th>Type</th><th>Requested</th><th>Note</th><th></th></tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.agreementId}>
                <td>{fmt(r.requestedAt)}</td>
                <td>{r.customerName || '—'}</td>
                <td>{r.repairOrderNumber || r.reservationNumber || '—'}</td>
                <td>{r.kind === 'EXTENSION' ? 'Extension' : 'Return'}</td>
                <td>{fmt(r.kind === 'EXTENSION' ? r.requestedReturnAt : r.returnScheduledAt)}</td>
                <td style={{ maxWidth: 200, whiteSpace: 'normal' }}>{r.note || '—'}</td>
                <td style={{ whiteSpace: 'nowrap' }}>
                  <button type="button" disabled={busyId === r.agreementId} onClick={() => resolve(r.agreementId, true)}>Approve</button>
                  {' '}
                  <button type="button" className="button-subtle" disabled={busyId === r.agreementId} onClick={() => resolve(r.agreementId, false)}>Dismiss</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
