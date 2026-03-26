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

function dateTimeLabel(value) {
  if (!value) return 'Not scheduled yet';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString();
}

function normalizeHeader(value) {
  return String(value || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function parseBulkImportRows(text) {
  const rawLines = String(text || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (!rawLines.length) return [];

  const delimiter = rawLines[0].includes('\t') ? '\t' : ',';
  const splitLine = (line) => line.split(delimiter).map((part) => part.trim());
  const header = splitLine(rawLines[0]).map(normalizeHeader);
  const hasHeader = header.some((cell) => ['transactionat', 'datetime', 'date', 'timestamp', 'amount', 'plate', 'tag', 'sello', 'sticker'].includes(cell));
  const rows = (hasHeader ? rawLines.slice(1) : rawLines).map((line) => splitLine(line)).filter((parts) => parts.some(Boolean));
  const columnIndex = (aliases, fallback) => {
    const idx = header.findIndex((cell) => aliases.includes(cell));
    return idx >= 0 ? idx : fallback;
  };

  const dateIdx = columnIndex(['transactionat', 'datetime', 'date', 'timestamp'], 0);
  const amountIdx = columnIndex(['amount', 'tollamount', 'charge'], 1);
  const locationIdx = columnIndex(['location', 'plaza'], 2);
  const laneIdx = columnIndex(['lane', 'directionlane'], 3);
  const directionIdx = columnIndex(['direction'], 4);
  const plateIdx = columnIndex(['plate', 'licenseplate', 'tablilla'], 5);
  const tagIdx = columnIndex(['tag', 'tolltag', 'tagnumber'], 6);
  const selloIdx = columnIndex(['sello', 'sticker', 'tollsticker', 'stickernumber'], 7);

  return rows.map((parts) => ({
    transactionAt: parts[dateIdx] || '',
    amount: Number(parts[amountIdx] || 0),
    location: parts[locationIdx] || '',
    lane: parts[laneIdx] || '',
    direction: parts[directionIdx] || '',
    plate: parts[plateIdx] || '',
    tag: parts[tagIdx] || '',
    sello: parts[selloIdx] || ''
  })).filter((row) => row.transactionAt && Number.isFinite(row.amount) && row.amount > 0);
}

function TollsInner({ token, me, logout }) {
  const role = String(me?.role || '').toUpperCase();
  const isSuper = role === 'SUPER_ADMIN';
  const [msg, setMsg] = useState('');
  const [dashboard, setDashboard] = useState(null);
  const [tenantRows, setTenantRows] = useState([]);
  const [activeTenantId, setActiveTenantId] = useState('');
  const [providerForm, setProviderForm] = useState({
    username: '',
    password: '',
    loginUrl: '',
    notes: '',
    isActive: true
  });
  const [statusFilter, setStatusFilter] = useState('');
  const [reviewOnly, setReviewOnly] = useState(true);
  const [query, setQuery] = useState('');
  const [bulkImportText, setBulkImportText] = useState('');
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
      const provider = out?.providerAccount || null;
      setProviderForm((current) => ({
        username: provider?.username || '',
        password: '',
        loginUrl: provider?.settings?.loginUrl || '',
        notes: provider?.settings?.notes || '',
        isActive: provider?.isActive !== false
      }));
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

  const saveBulkImport = async () => {
    const rows = parseBulkImportRows(bulkImportText);
    if (!rows.length) {
      setMsg('Paste CSV rows with transactionAt, amount, location, lane, direction, plate, tag, sello');
      return;
    }
    try {
      setBusyId('bulk-import');
      await api(scopedTollsPath('/api/tolls/transactions/manual-import'), {
        method: 'POST',
        body: JSON.stringify({ rows })
      }, token);
      setBulkImportText('');
      setMsg(`${rows.length} toll transactions imported`);
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

  const runReviewAction = async (row, action) => {
    const notePrompt = action === 'MARK_DISPUTED'
      ? 'Optional dispute note'
      : action === 'MARK_NOT_BILLABLE'
        ? 'Optional waiver note'
        : 'Optional reset note';
    const note = window.prompt(notePrompt, '') || '';
    try {
      setBusyId(`${action}-${row.id}`);
      const out = await api(scopedTollsPath(`/api/tolls/transactions/${row.id}/review-action`), {
        method: 'POST',
        body: JSON.stringify({ action, note })
      }, token);
      setMsg(`Toll ${out?.actionLabel || 'updated'}`);
      await load();
    } catch (error) {
      setMsg(error.message);
    } finally {
      setBusyId('');
    }
  };

  const saveProviderAccount = async () => {
    try {
      setBusyId('provider-save');
      await api(scopedTollsPath('/api/tolls/provider-account'), {
        method: 'PUT',
        body: JSON.stringify(providerForm)
      }, token);
      setMsg('AutoExpreso provider setup saved');
      await load();
    } catch (error) {
      setMsg(error.message);
    } finally {
      setBusyId('');
    }
  };

  const runProviderHealthCheck = async () => {
    try {
      setBusyId('provider-health');
      const out = await api(scopedTollsPath('/api/tolls/provider-account/health-check'), {
        method: 'POST',
        body: JSON.stringify({})
      }, token);
      setMsg(out?.ready ? 'Provider health check passed' : `Provider is missing: ${(out?.missing || []).join(', ')}`);
      await load();
    } catch (error) {
      setMsg(error.message);
    } finally {
      setBusyId('');
    }
  };

  const runMockSync = async () => {
    try {
      setBusyId('provider-sync');
      await api(scopedTollsPath('/api/tolls/provider-account/mock-sync'), {
        method: 'POST',
        body: JSON.stringify({})
      }, token);
      setMsg('Mock sync completed and import history updated');
      await load();
    } catch (error) {
      setMsg(error.message);
    } finally {
      setBusyId('');
    }
  };

  const runLiveSync = async () => {
    try {
      setBusyId('provider-live-sync');
      const out = await api(scopedTollsPath('/api/tolls/provider-account/live-sync'), {
        method: 'POST',
        body: JSON.stringify({})
      }, token);
      setMsg(`AutoExpreso sync completed with ${Number(out?.createdCount || 0)} imported rows`);
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
          <div className="row-between">
            <div className="section-title">Automatic AutoExpreso Sync</div>
            <span className={`status-chip ${dashboard?.autoSync?.enabled ? 'good' : 'neutral'}`}>
              {dashboard?.autoSync?.enabled ? 'Auto Sync Enabled' : 'Auto Sync Disabled'}
            </span>
          </div>
          <div className="app-card-grid compact">
            <div className="info-tile">
              <span className="label">Interval</span>
              <strong>{Number(dashboard?.autoSync?.intervalMinutes || 0) || 0} min</strong>
            </div>
            <div className="info-tile">
              <span className="label">Last Automatic Run</span>
              <strong style={{ fontSize: '0.95rem' }}>{dateTimeLabel(dashboard?.autoSync?.lastAutomaticRunAt)}</strong>
            </div>
            <div className="info-tile">
              <span className="label">Next Scheduled Run</span>
              <strong style={{ fontSize: '0.95rem' }}>{dateTimeLabel(dashboard?.autoSync?.nextRunAt)}</strong>
            </div>
          </div>
          {dashboard?.autoSync?.lastSweep ? (
            <div className="app-card-grid compact" style={{ marginTop: 10 }}>
              <div className="info-tile">
                <span className="label">Last Sweep Imported</span>
                <strong>{Number(dashboard.autoSync.lastSweep.importedCount || 0)}</strong>
              </div>
              <div className="info-tile">
                <span className="label">Last Sweep Auto-Matched</span>
                <strong>{Number(dashboard.autoSync.lastSweep.autoMatchedCount || 0)}</strong>
              </div>
              <div className="info-tile">
                <span className="label">Last Sweep Suggested</span>
                <strong>{Number(dashboard.autoSync.lastSweep.suggestedCount || 0)}</strong>
              </div>
              <div className="info-tile">
                <span className="label">Pending Review Now</span>
                <strong>{Number(dashboard.autoSync.lastSweep.pendingReviewCount || 0)}</strong>
              </div>
            </div>
          ) : null}
          <div className="surface-note" style={{ marginTop: 10 }}>
            The backend now runs AutoExpreso sync sweeps automatically for active tenants with tolls enabled, then re-checks pending tolls against the assigned vehicle and reservation window.
          </div>
        </div>

        <div className="glass card section-card">
          <div className="row-between">
            <div className="section-title">AutoExpreso Provider Setup</div>
            <span className={`status-chip ${dashboard?.providerAccount?.isActive ? 'good' : 'neutral'}`}>
              {dashboard?.providerAccount?.isActive ? 'Provider Ready' : 'Not configured'}
            </span>
          </div>
          <div className="surface-note" style={{ marginBottom: 10 }}>
            Puerto Rico uses AutoExpreso as the toll provider. Configure the login credentials for this tenant and then run health check or sync.
          </div>
          <div className="grid2">
            <input placeholder="AutoExpreso username" value={providerForm.username} onChange={(e) => setProviderForm((prev) => ({ ...prev, username: e.target.value }))} />
            <input placeholder={dashboard?.providerAccount?.hasPassword ? 'Leave blank to keep current password' : 'AutoExpreso password'} type="password" value={providerForm.password} onChange={(e) => setProviderForm((prev) => ({ ...prev, password: e.target.value }))} />
            <input placeholder="Login URL (optional)" value={providerForm.loginUrl} onChange={(e) => setProviderForm((prev) => ({ ...prev, loginUrl: e.target.value }))} />
          </div>
          <textarea rows={3} placeholder="Provider notes or login behavior notes" value={providerForm.notes} onChange={(e) => setProviderForm((prev) => ({ ...prev, notes: e.target.value }))} />
          <div className="inline-actions" style={{ marginTop: 10 }}>
            <label className="label"><input type="checkbox" checked={providerForm.isActive} onChange={(e) => setProviderForm((prev) => ({ ...prev, isActive: e.target.checked }))} /> Active provider account</label>
            <button type="button" disabled={busyId === 'provider-save' || (isSuper && !activeTenantId)} onClick={saveProviderAccount}>
              {busyId === 'provider-save' ? 'Saving...' : 'Save Provider Setup'}
            </button>
            <button type="button" className="button-subtle" disabled={busyId === 'provider-health' || (isSuper && !activeTenantId)} onClick={runProviderHealthCheck}>
              {busyId === 'provider-health' ? 'Checking...' : 'Run Health Check'}
            </button>
            <button type="button" className="button-subtle" disabled={busyId === 'provider-sync' || (isSuper && !activeTenantId)} onClick={runMockSync}>
              {busyId === 'provider-sync' ? 'Running...' : 'Run Mock Sync'}
            </button>
            <button type="button" className="button-subtle" disabled={busyId === 'provider-live-sync' || (isSuper && !activeTenantId)} onClick={runLiveSync}>
              {busyId === 'provider-live-sync' ? 'Syncing...' : 'Run AutoExpreso Sync'}
            </button>
          </div>
          {dashboard?.providerAccount?.lastSyncStatus || dashboard?.providerAccount?.lastSyncMessage ? (
            <div className="surface-note" style={{ marginTop: 10 }}>
              Last sync status: {dashboard?.providerAccount?.lastSyncStatus || 'N/A'}{dashboard?.providerAccount?.lastSyncMessage ? ` | ${dashboard.providerAccount.lastSyncMessage}` : ''}
            </div>
          ) : null}
        </div>

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
          <div className="section-title">Bulk CSV Import</div>
          <div className="surface-note" style={{ marginBottom: 10 }}>
            Paste CSV or tab-separated rows in this order:
            <br />
            <code>transactionAt, amount, location, lane, direction, plate, tag, sello</code>
          </div>
          <textarea
            rows={7}
            placeholder={'transactionAt,amount,location,lane,direction,plate,tag,sello\n2026-03-26T00:41,5.00,Plaza Norte,Lane 1,North,BBTB1,0202,0202'}
            value={bulkImportText}
            onChange={(e) => setBulkImportText(e.target.value)}
          />
          <div className="inline-actions" style={{ marginTop: 10 }}>
            <button type="button" disabled={busyId === 'bulk-import' || (isSuper && !activeTenantId)} onClick={saveBulkImport}>
              {busyId === 'bulk-import' ? 'Importing...' : 'Import CSV Rows'}
            </button>
          </div>
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
                <option value="DISPUTED">Disputed</option>
                <option value="VOID">Void / Not Billable</option>
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
                      {(row.latestAssignment?.reservation || row.reservation?.id) ? (
                        <button type="button" className="button-subtle" onClick={() => runReviewAction(row, 'RESET_MATCH')} disabled={busyId === `RESET_MATCH-${row.id}`}>
                          {busyId === `RESET_MATCH-${row.id}` ? 'Resetting...' : 'Reset Match'}
                        </button>
                      ) : null}
                      {row.billingStatus !== 'DISPUTED' ? (
                        <button type="button" className="button-subtle" onClick={() => runReviewAction(row, 'MARK_DISPUTED')} disabled={busyId === `MARK_DISPUTED-${row.id}`}>
                          {busyId === `MARK_DISPUTED-${row.id}` ? 'Saving...' : 'Mark Disputed'}
                        </button>
                      ) : null}
                      {row.billingStatus !== 'WAIVED' ? (
                        <button type="button" className="button-subtle" onClick={() => runReviewAction(row, 'MARK_NOT_BILLABLE')} disabled={busyId === `MARK_NOT_BILLABLE-${row.id}`}>
                          {busyId === `MARK_NOT_BILLABLE-${row.id}` ? 'Saving...' : 'Mark Not Billable'}
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

        <div className="glass card section-card">
          <div className="section-title">Recent Import Runs</div>
          {Array.isArray(dashboard?.importRuns) && dashboard.importRuns.length ? (
            <table>
              <thead>
                <tr>
                  <th>Started</th>
                  <th>Source</th>
                  <th>Status</th>
                  <th>Imported</th>
                  <th>Matched</th>
                  <th>Review</th>
                </tr>
              </thead>
              <tbody>
                {dashboard.importRuns.map((run) => (
                  <tr key={run.id}>
                    <td>{new Date(run.startedAt).toLocaleString()}</td>
                    <td>{run.sourceType || '-'}</td>
                    <td>{run.status || '-'}</td>
                    <td>{run.importedCount}</td>
                    <td>{run.matchedCount}</td>
                    <td>{run.reviewCount}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <div className="surface-note">Import run history will appear here once provider sync or bulk imports start logging runs.</div>
          )}
        </div>
      </section>
    </AppShell>
  );
}
