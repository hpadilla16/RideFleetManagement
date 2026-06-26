'use client';

import { useEffect, useState } from 'react';
import { api } from '../../lib/client';

/**
 * Courtesy-car requests queue (2026-06-26). Lists public "request a loaner" leads (LoanerRequest)
 * and lets an advisor advance/dismiss them. Backend: GET /api/dealership-loaner/requests,
 * PATCH /api/dealership-loaner/requests/:id. Tenant-scoped + auth handled server-side.
 */
const STATUSES = ['RECEIVED', 'CONTACTED', 'CONVERTED', 'CLOSED'];

export function LoanerRequestsPanel({ token }) {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showClosed, setShowClosed] = useState(false);
  const [busyId, setBusyId] = useState(null);
  const [open, setOpen] = useState(true);
  const [msg, setMsg] = useState('');

  const load = async () => {
    setLoading(true);
    try {
      const qs = showClosed ? '' : '?status=RECEIVED';
      const out = await api(`/api/dealership-loaner/requests${qs}`, { bypassCache: true }, token);
      setRows(Array.isArray(out?.requests) ? out.requests : []);
    } catch (e) {
      setMsg(`Failed to load requests: ${e.message || e}`);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); /* eslint-disable-next-line */ }, [showClosed]);

  const setStatus = async (id, status) => {
    setBusyId(id);
    try {
      await api(`/api/dealership-loaner/requests/${id}`, { method: 'PATCH', body: JSON.stringify({ status }) }, token);
      setMsg('Request updated.');
      await load();
    } catch (e) {
      setMsg(`Update failed: ${e.message || e}`);
    } finally {
      setBusyId(null);
    }
  };

  const fmtDate = (v) => {
    if (!v) return '—';
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? '—' : d.toLocaleDateString();
  };

  return (
    <section className="app-card" style={{ marginTop: 10 }}>
      <div className="row-between">
        <h3 style={{ margin: 0 }}>
          Courtesy Requests {loading ? '' : `(${rows.length}${showClosed ? '' : ' open'})`}
        </h3>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <label style={{ fontSize: 13 }}>
            <input type="checkbox" checked={showClosed} onChange={(e) => setShowClosed(e.target.checked)} /> Show all
          </label>
          <button type="button" className="button-subtle" onClick={() => setOpen((o) => !o)}>{open ? 'Hide' : 'Show'}</button>
        </div>
      </div>
      {msg ? <p style={{ fontSize: 13, color: '#666' }}>{msg}</p> : null}
      {!open ? null : loading ? (
        <p>Loading…</p>
      ) : rows.length === 0 ? (
        <p style={{ color: '#666' }}>No {showClosed ? '' : 'open '}courtesy-car requests.</p>
      ) : (
        <table>
          <thead>
            <tr><th>Received</th><th>Name</th><th>Phone</th><th>RO</th><th>Preferred</th><th>Notes</th><th>Status</th><th></th></tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                <td>{fmtDate(r.createdAt)}</td>
                <td>{r.name}</td>
                <td>{r.phone}</td>
                <td>{r.repairOrderNumber || '—'}</td>
                <td>{fmtDate(r.preferredDate)}</td>
                <td style={{ maxWidth: 220, whiteSpace: 'normal' }}>{r.notes || '—'}</td>
                <td>
                  <select value={r.status} disabled={busyId === r.id} onChange={(e) => setStatus(r.id, e.target.value)}>
                    {STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
                  </select>
                </td>
                <td>
                  {r.status !== 'CLOSED'
                    ? <button type="button" className="button-subtle" disabled={busyId === r.id} onClick={() => setStatus(r.id, 'CLOSED')}>Dismiss</button>
                    : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
