'use client';

import { useEffect, useMemo, useState } from 'react';
import { AuthGate } from '../../components/AuthGate';
import { AppShell } from '../../components/AppShell';
import { api } from '../../lib/client';

const EMPTY_IMPORT_FORM = {
  transactionAt: '',
  amount: '',
  location: '',
  lane: '',
  direction: '',
  plate: '',
  tag: '',
  sello: ''
};

export default function TollsPage() {
  return <AuthGate>{({ token, me, logout }) => <TollsInner token={token} me={me} logout={logout} />}</AuthGate>;
}

function money(value) {
  return `$${Number(Number(value || 0).toFixed(2)).toFixed(2)}`;
}

function TollsInner({ token, me, logout }) {
  const role = String(me?.role || '').toUpperCase();
  const isSuper = role === 'SUPER_ADMIN';
  const [msg, setMsg] = useState('');
  const [dashboard, setDashboard] = useState(null);
  const [tenantRows, setTenantRows] = useState([]);
  const [activeTenantId, setActiveTenantId] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [reviewOnly, setReviewOnly] = useState(true);
  const [query, setQuery] = useState('');
  const [importForm, setImportForm] = useState(() => ({
    ...EMPTY_IMPORT_FORM,
    transactionAt: new Date().toISOString().slice(0, 16)
  }));
  const [reservationDrafts, setReservationDrafts] = useState({});
  const [busyId, setBusyId] = useState('');

  const scopedTollsPath = (path) => {
    if (!isSuper || !activeTenantId) return path;
    const sep = path.includes('?') ? '&' : '?';
    return `${path}${sep}tenantId=${encodeURIComponent(activeTenantId)}`;
  };

  const loadTenants = async () => {
    if (!isSuper) return;
    try {
      const rows = await api('/api/tenants', {}, token);
      const list = Array.isArray(rows) ? rows : [];
      setTenantRows(list);
      if (!activeTenantId && list[0]?.id) setActiveTenantId(list[0].id);
    } catch (error) {
      setMsg(error.message);
    }
  };

  const load = async () => {
    try {
      if (isSuper && !activeTenantId) {
        setDashboard(null);
        return;
      }
      const params = new URLSearchParams();
      if (query.trim()) params.set('q', query.trim());
      if (statusFilter) params.set('status', statusFilter);
      if (reviewOnly) params.set('needsReview', 'true');
      const out = await api(scopedTollsPath(`/api/tolls/dashboard${params.toString() ? `?${params.toString()}` : ''}`), {}, token);
      setDashboard(out);
      setMsg('');
    } catch (error) {
      setMsg(error.message);
    }
  };

  useEffect(() => {
    loadTenants();
  }, [token, isSuper]);

  useEffect(() => {
    load();
  }, [token, statusFilter, reviewOnly, activeTenantId, isSuper]);

  const transactions = useMemo(() => Array.isArray(dashboard?.transactions) ? dashboard.transactions : [], [dashboard]);

  const saveManualImport = async (event) => {
    event.preventDefault();
    try {
      setBusyId('manual-import');
      await api(scopedTollsPath('/api/tolls/transactions/manual-import'), {
        method: 'POST',
        body: JSON.stringify({
          rows: [{
            transactionAt: importForm.transactionAt,
            amount: Number(importForm.amount || 0),
            location: importForm.location,
            lane: importForm.lane,
            direction: importForm.direction,
            plate: importForm.plate,
            tag: importForm.tag,
            sello: importForm.sello
          }]
        })
      }, token);
      setImportForm({
        ...EMPTY_IMPORT_FORM,
        transactionAt: new Date().toISOString().slice(0, 16)
      });
      setMsg('Toll transaction imported');
      await load();
    } catch (error) {
      setMsg(error.message);
    } finally {
      setBusyId('');
    }
  };

  const confirmMatch = async (row) => {
    const reservationId = row?.latestAssignment?.reservation?.id || '';
    const reservationNumber = reservationDrafts[row.id] || '';
    if (!reservationId && !reservationNumber.trim()) {
      setMsg('Add a reservation number or use a suggested reservation first');
      return;
    }
    try {
      setBusyId(`confirm-${row.id}`);
      await api(scopedTollsPath(`/api/tolls/transactions/${row.id}/confirm-match`), {
        method: 'POST',
        body: JSON.stringify({
          reservationId: reservationId || undefined,
          reservationNumber: reservationId ? undefined : reservationNumber.trim()
        })
      }, token);
      setMsg(`Toll matched to reservation ${row?.latestAssignment?.reservation?.reservationNumber || reservationNumber.trim()}`);
      await load();
    } catch (error) {
      setMsg(error.message);
    } finally {
      setBusyId('');
    }
  };

  const postToReservation = async (row) => {
    try {
      setBusyId(`post-${row.id}`);
      await api(scopedTollsPath(`/api/tolls/transactions/${row.id}/post-to-reservation`), {
        method: 'POST',
        body: JSON.stringify({})
      }, token);
      setMsg('Toll posted to reservation charges');
      await load();
    } catch (error) {
      setMsg(error.message);
    } finally {
      setBusyId('');
    }
  };

  return (
    <AppShell me={me} logout={logout}>
      <section className="glass card-lg stack">
        <div className="app-banner">
          <div className="row-between" style={{ alignItems: 'start', marginBottom: 0 }}>
            <div>
              <span className="eyebrow">Toll Operations</span>
              <h2 className="page-title" style={{ marginTop: 6 }}>Match Puerto Rico tolls against tenant fleet and reservation windows.</h2>
              <p className="ui-muted">
                This queue uses the tenant's real vehicles, plate, toll tag, toll sticker, and reservation pickup and return timestamps to suggest or confirm toll ownership.
              </p>
            </div>
            <span className="status-chip neutral">Review Queue</span>
          </div>

          {isSuper ? (
            <div className="inline-actions" style={{ marginTop: 12 }}>
              <label className="label" style={{ minWidth: 160 }}>Toll Tenant Scope</label>
              <select value={activeTenantId} onChange={(e) => setActiveTenantId(e.target.value)}>
                <option value="">Select tenant</option>
                {tenantRows.map((tenant) => (
                  <option key={tenant.id} value={tenant.id}>{tenant.name}</option>
                ))}
              </select>
              <span className="ui-muted">
                {activeTenantId
                  ? `${tenantRows.find((tenant) => tenant.id === activeTenantId)?.name || 'Tenant selected'} active`
                  : 'Choose a tenant before importing or reviewing tolls'}
              </span>
            </div>
          ) : null}

          <div className="app-card-grid compact">
            <div className="info-tile">
              <span className="label">Imported Today</span>
              <strong>{dashboard?.metrics?.importedToday || 0}</strong>
            </div>
            <div className="info-tile">
              <span className="label">Matched</span>
              <strong>{dashboard?.metrics?.matched || 0}</strong>
            </div>
            <div className="info-tile">
              <span className="label">Needs Review</span>
              <strong>{dashboard?.metrics?.needsReview || 0}</strong>
            </div>
            <div className="info-tile">
              <span className="label">Posted To Billing</span>
              <strong>{dashboard?.metrics?.postedToBilling || 0}</strong>
            </div>
          </div>
        </div>

        {msg ? <div className="label">{msg}</div> : null}

        <div className="glass card section-card">
          <div className="section-title">Manual Toll Import</div>
          {isSuper && !activeTenantId ? (
            <div className="surface-note" style={{ marginBottom: 10 }}>
              Choose the tenant above first so the toll import uses that tenant's fleet, toll tags, toll stickers, and reservation windows.
            </div>
          ) : null}
          <form className="stack" onSubmit={saveManualImport}>
            <div className="grid2">
              <input type="datetime-local" required value={importForm.transactionAt} onChange={(e) => setImportForm((prev) => ({ ...prev, transactionAt: e.target.value }))} />
              <input type="number" step="0.01" min="0.01" required placeholder="Toll amount" value={importForm.amount} onChange={(e) => setImportForm((prev) => ({ ...prev, amount: e.target.value }))} />
            </div>
            <div className="grid2">
              <input placeholder="Location / Plaza" value={importForm.location} onChange={(e) => setImportForm((prev) => ({ ...prev, location: e.target.value }))} />
              <input placeholder="Lane / Direction" value={importForm.lane} onChange={(e) => setImportForm((prev) => ({ ...prev, lane: e.target.value }))} />
            </div>
            <div className="grid3">
              <input placeholder="Plate" value={importForm.plate} onChange={(e) => setImportForm((prev) => ({ ...prev, plate: e.target.value }))} />
              <input placeholder="Toll Tag Number" value={importForm.tag} onChange={(e) => setImportForm((prev) => ({ ...prev, tag: e.target.value }))} />
              <input placeholder="Toll Sticker Number" value={importForm.sello} onChange={(e) => setImportForm((prev) => ({ ...prev, sello: e.target.value }))} />
            </div>
            <div className="inline-actions">
              <button type="submit" disabled={busyId === 'manual-import' || (isSuper && !activeTenantId)}>{busyId === 'manual-import' ? 'Importing...' : 'Import Toll'}</button>
            </div>
          </form>
        </div>

        <div className="glass card section-card">
          <div className="row-between">
            <div className="section-title">Review Queue</div>
            <div className="inline-actions">
              <input placeholder="Search plate, tag, sticker, location, reservation" value={query} onChange={(e) => setQuery(e.target.value)} />
              <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
                <option value="">All statuses</option>
                <option value="IMPORTED">Imported</option>
                <option value="MATCHED">Matched</option>
                <option value="NEEDS_REVIEW">Needs Review</option>
                <option value="BILLED">Billed</option>
              </select>
              <label className="label"><input type="checkbox" checked={reviewOnly} onChange={(e) => setReviewOnly(e.target.checked)} /> Review only</label>
              <button type="button" onClick={load}>Refresh</button>
            </div>
          </div>

          <table>
            <thead>
              <tr>
                <th>When</th>
                <th>Toll</th>
                <th>Vehicle Match</th>
                <th>Reservation Match</th>
                <th>Status</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {transactions.map((row) => (
                <tr key={row.id}>
                  <td>
                    <div>{new Date(row.transactionAt).toLocaleString()}</div>
                    <div className="label" style={{ textTransform: 'none', letterSpacing: 0 }}>{row.location || row.lane || '-'}</div>
                  </td>
                  <td>
                    <div>{money(row.amount)}</div>
                    <div className="label" style={{ textTransform: 'none', letterSpacing: 0 }}>
                      Plate: {row.plateRaw || '-'} · Tag: {row.tagRaw || '-'} · Sello: {row.selloRaw || '-'}
                    </div>
                  </td>
                  <td>
                    {row.vehicle ? (
                      <>
                        <div>{row.vehicle.internalNumber}</div>
                        <div className="label" style={{ textTransform: 'none', letterSpacing: 0 }}>{row.vehicle.plate || '-'} · {row.vehicle.tollTagNumber || '-'} · {row.vehicle.tollStickerNumber || '-'}</div>
                      </>
                    ) : (
                      <div className="label">No tenant vehicle resolved yet</div>
                    )}
                  </td>
                  <td>
                    {row.latestAssignment?.reservation ? (
                      <>
                        <div>{row.latestAssignment.reservation.reservationNumber}</div>
                        <div className="label" style={{ textTransform: 'none', letterSpacing: 0 }}>
                          Score {row.latestAssignment.confidence ?? row.matchConfidence ?? 0} · {row.latestAssignment.matchReason || 'suggested'}
                        </div>
                      </>
                    ) : row.reservation ? (
                      <div>{row.reservation.reservationNumber}</div>
                    ) : (
                      <div className="stack" style={{ gap: 6 }}>
                        <div className="label">Manual reservation lookup</div>
                        <input
                          placeholder="Reservation number"
                          value={reservationDrafts[row.id] || ''}
                          onChange={(e) => setReservationDrafts((prev) => ({ ...prev, [row.id]: e.target.value }))}
                        />
                      </div>
                    )}
                  </td>
                  <td>
                    <span className={`status-chip ${row.needsReview ? 'warn' : row.billingStatus === 'POSTED_TO_RESERVATION' ? 'good' : 'neutral'}`}>
                      {row.needsReview ? 'Needs review' : row.statusLabel}
                    </span>
                    <div className="label" style={{ textTransform: 'none', letterSpacing: 0 }}>{row.billingStatus}</div>
                  </td>
                  <td>
                    <div className="stack" style={{ gap: 6 }}>
                      {(row.latestAssignment?.reservation || reservationDrafts[row.id]) ? (
                        <button type="button" onClick={() => confirmMatch(row)} disabled={busyId === `confirm-${row.id}`}>
                          {busyId === `confirm-${row.id}` ? 'Matching...' : 'Confirm Match'}
                        </button>
                      ) : null}
                      {row.reservation?.id && row.billingStatus === 'PENDING' ? (
                        <button type="button" onClick={() => postToReservation(row)} disabled={busyId === `post-${row.id}`}>
                          {busyId === `post-${row.id}` ? 'Posting...' : 'Post To Reservation'}
                        </button>
                      ) : null}
                    </div>
                  </td>
                </tr>
              ))}
              {!transactions.length ? (
                <tr>
                  <td colSpan={6} className="label">No toll transactions matched this filter yet.</td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </section>
    </AppShell>
  );
}
