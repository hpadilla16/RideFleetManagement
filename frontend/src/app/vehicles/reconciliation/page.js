'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { AuthGate } from '../../../components/AuthGate';
import { AppShell } from '../../../components/AppShell';
import { api } from '../../../lib/client';

function mismatchLabel(type) {
  switch (String(type || '').toUpperCase()) {
    case 'ON_RENT_OVERDUE': return 'Checked out but overdue';
    case 'SHOULD_BE_ON_RENT': return 'Should be checked out';
    default: return type || 'Mismatch';
  }
}

function fmtDate(value) {
  if (!value) return '-';
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? '-' : d.toLocaleString();
}

export default function ReconciliationPage() {
  return <AuthGate>{({ token, me, logout }) => <ReconciliationInner token={token} me={me} logout={logout} />}</AuthGate>;
}

function ReconciliationInner({ token, me, logout }) {
  const [flags, setFlags] = useState(null);
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState('');

  async function load() {
    try {
      const out = await api('/api/inventory/reconciliation/open', { bypassCache: true }, token);
      setFlags(Array.isArray(out?.flags) ? out.flags : []);
    } catch (e) { setMsg(e.message); setFlags([]); }
  }

  useEffect(() => { load(); /* eslint-disable-next-line */ }, [token]);

  async function resolve(flag) {
    try {
      setBusy(flag.id); setMsg('');
      await api(`/api/inventory/reconciliation/${flag.id}/resolve`, { method: 'POST', body: JSON.stringify({}) }, token);
      await load();
    } catch (e) { setMsg(e.message); } finally { setBusy(''); }
  }

  return (
    <AppShell me={me} logout={logout}>
      <section className="glass card-lg section-card" style={{ marginBottom: 16 }}>
        <div className="row-between">
          <div>
            <span className="eyebrow">Vehicles</span>
            <h2 className="page-title" style={{ marginTop: 6 }}>Status Mismatches</h2>
            <p className="ui-muted">Vehicles flagged during inventory whose status still needs fixing. Each one auto-clears when it's checked in or the hourly status sweep reconciles it.</p>
          </div>
          {flags ? <span className="status-chip neutral">{flags.length} open</span> : null}
        </div>
      </section>

      {msg ? <div className="glass card" style={{ marginBottom: 12 }}>{msg}</div> : null}

      {flags === null ? (
        <div className="glass card">Loading…</div>
      ) : flags.length === 0 ? (
        <div className="glass card-lg section-card">
          <p className="ui-muted" style={{ margin: 0 }}>No open mismatches. Everything reconciles. 🎉</p>
        </div>
      ) : (
        <section className="glass card-lg section-card">
          <div className="table-shell">
            <table>
              <thead>
                <tr><th>Unit</th><th>Plate</th><th>Lot</th><th>Mismatch</th><th>Note</th><th>Flagged</th><th></th></tr>
              </thead>
              <tbody>
                {flags.map((f) => (
                  <tr key={f.id}>
                    <td>{f.vehicle?.internalNumber || '-'}</td>
                    <td>{f.vehicle?.plate || '-'}</td>
                    <td>{f.vehicle?.homeLocation?.name || '-'}</td>
                    <td><span className="status-chip warn">{mismatchLabel(f.type)}</span></td>
                    <td className="ui-muted" style={{ fontSize: 12 }}>{f.note || '-'}</td>
                    <td className="ui-muted" style={{ fontSize: 12 }}>{fmtDate(f.raisedAt)}</td>
                    <td>
                      <div className="inline-actions">
                        {f.reservationId ? (
                          <Link href={`/reservations/${f.reservationId}/checkin-wizard`} className="legal-link-pill">Go to check-in</Link>
                        ) : null}
                        <button type="button" className="btn-ghost btn-sm" disabled={busy === f.id} onClick={() => resolve(f)}>
                          {busy === f.id ? 'Resolving…' : 'Mark resolved'}
                        </button>
                      </div>
                    </td>
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
