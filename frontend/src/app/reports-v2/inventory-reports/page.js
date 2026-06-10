'use client';

import { useEffect, useState } from 'react';
import { AuthGate } from '../../../components/AuthGate';
import { AppShell } from '../../../components/AppShell';
import { api, API_BASE } from '../../../lib/client';

function fmtDate(value) {
  if (!value) return '-';
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? '-' : d.toLocaleString();
}

export default function InventoryReportsPage() {
  return <AuthGate>{({ token, me, logout }) => <InventoryReportsInner token={token} me={me} logout={logout} />}</AuthGate>;
}

function InventoryReportsInner({ token, me, logout }) {
  const [rows, setRows] = useState(null);
  const [msg, setMsg] = useState('');
  const [downloading, setDownloading] = useState('');

  useEffect(() => {
    let alive = true;
    api('/api/inventory/reports', { bypassCache: true }, token)
      .then((out) => { if (alive) setRows(Array.isArray(out) ? out : []); })
      .catch((e) => { if (alive) { setMsg(e.message); setRows([]); } });
    return () => { alive = false; };
  }, [token]);

  async function download(report) {
    try {
      setDownloading(report.id); setMsg('');
      const res = await fetch(`${API_BASE}/api/inventory/reports/${report.id}/download`, { headers: { Authorization: `Bearer ${token}` } });
      if (!res.ok) throw new Error('Download failed');
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${(report.title || 'inventory').replace(/[^\w.-]+/g, '_')}.pdf`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (e) { setMsg(e.message); } finally { setDownloading(''); }
  }

  return (
    <AppShell me={me} logout={logout}>
      <section className="glass card-lg section-card" style={{ marginBottom: 16 }}>
        <div className="row-between">
          <div>
            <span className="eyebrow">Reports</span>
            <h2 className="page-title" style={{ marginTop: 6 }}>Inventory Reports</h2>
            <p className="ui-muted">Saved PDF reports from completed fleet inventories.</p>
          </div>
        </div>
      </section>

      {msg ? <div className="glass card" style={{ marginBottom: 12 }}>{msg}</div> : null}

      {rows === null ? (
        <div className="glass card">Loading…</div>
      ) : rows.length === 0 ? (
        <div className="glass card-lg section-card">
          <p className="ui-muted" style={{ margin: 0 }}>No inventory reports yet. Run an inventory from Vehicles → Inventory Helper and complete it — the report will appear here.</p>
        </div>
      ) : (
        <section className="glass card-lg section-card">
          <div className="table-shell">
            <table>
              <thead>
                <tr><th>Report</th><th>Completed</th><th>Vehicles</th><th>Confirmed</th><th>Mismatches</th><th></th></tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const s = r.summaryJson || {};
                  return (
                    <tr key={r.id}>
                      <td>{r.title || 'Fleet inventory'}</td>
                      <td>{fmtDate(r.generatedAt)}</td>
                      <td>{s.total ?? '-'}</td>
                      <td>{s.confirmed ?? '-'}</td>
                      <td>{s.mismatches ?? 0}</td>
                      <td>
                        <button type="button" className="btn-ghost btn-sm" disabled={downloading === r.id} onClick={() => download(r)}>
                          {downloading === r.id ? 'Downloading…' : 'Download PDF'}
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </AppShell>
  );
}
