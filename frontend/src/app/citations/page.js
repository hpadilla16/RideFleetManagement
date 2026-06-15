'use client';

import { useEffect, useMemo, useState } from 'react';
import { AuthGate } from '../../components/AuthGate';
import { AppShell } from '../../components/AppShell';
import { api } from '../../lib/client';

const EMPTY_IMPORT = {
  citationNo: '',
  plate: '',
  plateState: 'FL',
  issuedAt: '',
  amount: '',
  agency: '',
  violationType: ''
};

const SOURCE_LABELS = {
  CITATION_PROCESSING_CENTER: 'CPC',
  T2: 'T2',
  OCSO_COMPTROLLER: 'OCSO',
  VIOLATIONINFO: 'Verra',
  MANUAL: 'Manual'
};

const STATUS_TONE = {
  NEEDS_REVIEW: 'warn',
  MATCHED: 'good',
  BILLED: 'good',
  PAID: 'good',
  DISPUTED: 'danger',
  VOID: 'neutral',
  IMPORTED: 'neutral',
  TRANSFERRED: 'good',
  CLOSED: 'neutral'
};

export default function CitationsPage() {
  return <AuthGate>{({ token, me, logout }) => <CitationsInner token={token} me={me} logout={logout} />}</AuthGate>;
}

function money(value) {
  return `$${Number(Number(value || 0).toFixed(2)).toFixed(2)}`;
}

function dateLabel(value) {
  if (!value) return '—';
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? String(value) : d.toLocaleDateString();
}

function CitationsInner({ token, me, logout }) {
  const role = String(me?.role || '').toUpperCase();
  const isSuper = role === 'SUPER_ADMIN';
  const [msg, setMsg] = useState('');
  const [data, setData] = useState(null);
  const [tenantRows, setTenantRows] = useState([]);
  const [activeTenantId, setActiveTenantId] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [sourceFilter, setSourceFilter] = useState('');
  const [plateFilter, setPlateFilter] = useState('');
  const [reviewOnly, setReviewOnly] = useState(false);
  const [importForm, setImportForm] = useState(EMPTY_IMPORT);
  const [showImport, setShowImport] = useState(false);
  const [busyId, setBusyId] = useState('');

  const scoped = (path) => {
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
        setData(null);
        return;
      }
      const params = new URLSearchParams();
      params.set('pageSize', '200');
      if (statusFilter) params.set('status', statusFilter);
      else if (reviewOnly) params.set('status', 'NEEDS_REVIEW');
      if (sourceFilter) params.set('source', sourceFilter);
      if (plateFilter.trim()) params.set('plate', plateFilter.trim());
      const out = await api(scoped(`/api/citations?${params.toString()}`), {}, token);
      setData(out);
      setMsg('');
    } catch (error) {
      setMsg(error.message);
    }
  };

  useEffect(() => { loadTenants(); }, [token, isSuper]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { load(); }, [token, statusFilter, sourceFilter, reviewOnly, activeTenantId, isSuper]);

  const rows = useMemo(() => (Array.isArray(data?.rows) ? data.rows : []), [data]);
  const kpis = useMemo(() => {
    const open = rows.filter((r) => !['VOID', 'PAID', 'CLOSED'].includes(String(r.status).toUpperCase()));
    return {
      total: Number(data?.total || rows.length),
      review: rows.filter((r) => String(r.status).toUpperCase() === 'NEEDS_REVIEW').length,
      outstanding: open.reduce((sum, r) => sum + Number(r.amount || 0), 0),
      matched: rows.filter((r) => r.reservationId || r.reservation).length
    };
  }, [rows, data]);

  const review = async (row, decision) => {
    const note = decision === 'DISPUTE' || decision === 'VOID'
      ? (window.prompt(`Optional note for ${decision}`, '') || '')
      : '';
    try {
      setBusyId(`${decision}-${row.id}`);
      await api(scoped(`/api/citations/${row.id}/review`), {
        method: 'POST',
        body: JSON.stringify({ decision, note })
      }, token);
      setMsg(`Citation ${row.citationNo} → ${decision}`);
      await load();
    } catch (error) {
      setMsg(error.message);
    } finally {
      setBusyId('');
    }
  };

  const saveManual = async (event) => {
    event.preventDefault();
    if (!importForm.citationNo.trim()) { setMsg('Citation number required'); return; }
    try {
      setBusyId('manual');
      await api(scoped('/api/citations/manual-import'), {
        method: 'POST',
        body: JSON.stringify({
          source: 'MANUAL',
          rows: [{
            citationNo: importForm.citationNo.trim(),
            plate: importForm.plate.trim() || null,
            plateState: importForm.plateState.trim() || null,
            issuedAt: importForm.issuedAt || null,
            amount: Number(importForm.amount || 0),
            agency: importForm.agency.trim() || 'Manual entry',
            violationType: importForm.violationType.trim() || null
          }]
        })
      }, token);
      setImportForm(EMPTY_IMPORT);
      setShowImport(false);
      setMsg('Citation imported');
      await load();
    } catch (error) {
      setMsg(error.message);
    } finally {
      setBusyId('');
    }
  };

  // OCR mail intake (Fase A): upload a scanned/emailed notice (image/PDF). It's
  // stored as a CitationDocument(PENDING); the Fase B worker extracts the fields.
  const uploadNotice = async (file) => {
    if (!file) return;
    if (file.size > 15 * 1024 * 1024) { setMsg('Notice file exceeds 15MB'); return; }
    try {
      setBusyId('upload');
      const dataUrl = await new Promise((resolve, reject) => {
        const fr = new FileReader();
        fr.onload = () => resolve(fr.result);
        fr.onerror = () => reject(new Error('Could not read file'));
        fr.readAsDataURL(file);
      });
      await api(scoped('/api/citations/documents'), {
        method: 'POST',
        body: JSON.stringify({ dataUrl, sourceChannel: 'UPLOAD' })
      }, token);
      setMsg('Notice uploaded — queued for OCR.');
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
              <span className="eyebrow">Citations</span>
              <h2 className="page-title" style={{ marginTop: 6 }}>Parking & traffic citations matched to your fleet.</h2>
              <p className="ui-muted">
                Citations scraped from county/city portals (Citation Processing Center, T2, OCSO) are matched to the vehicle by plate, and to the renter when the violation time falls inside a rental window.
              </p>
            </div>
            <span className="status-chip neutral">Review Queue</span>
          </div>

          {isSuper ? (
            <div className="inline-actions" style={{ marginTop: 12 }}>
              <label className="label" style={{ minWidth: 140 }}>Tenant Scope</label>
              <select value={activeTenantId} onChange={(e) => setActiveTenantId(e.target.value)}>
                <option value="">Select tenant</option>
                {tenantRows.map((tn) => <option key={tn.id} value={tn.id}>{tn.name}</option>)}
              </select>
            </div>
          ) : null}

          <div className="app-card-grid compact">
            <div className="info-tile"><span className="label">Total Citations</span><strong>{kpis.total}</strong></div>
            <div className="info-tile"><span className="label">Needs Review</span><strong>{kpis.review}</strong></div>
            <div className="info-tile"><span className="label">Outstanding</span><strong>{money(kpis.outstanding)}</strong></div>
            <div className="info-tile"><span className="label">Matched to Renter</span><strong>{kpis.matched}</strong></div>
          </div>
        </div>

        {msg ? <div className="label">{msg}</div> : null}

        <div className="glass card section-card">
          <div className="row-between" style={{ flexWrap: 'wrap', gap: 8 }}>
            <div className="section-title">Citations</div>
            <div className="inline-actions" style={{ flexWrap: 'wrap', gap: 6 }}>
              <input placeholder="Plate (exact)" style={{ minWidth: 130 }} value={plateFilter} onChange={(e) => setPlateFilter(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') load(); }} />
              <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
                <option value="">All statuses</option>
                <option value="NEEDS_REVIEW">Needs Review</option>
                <option value="MATCHED">Matched</option>
                <option value="DISPUTED">Disputed</option>
                <option value="BILLED">Billed</option>
                <option value="PAID">Paid</option>
                <option value="VOID">Void</option>
              </select>
              <select value={sourceFilter} onChange={(e) => setSourceFilter(e.target.value)}>
                <option value="">All sources</option>
                <option value="CITATION_PROCESSING_CENTER">CPC (Orlando)</option>
                <option value="T2">T2</option>
                <option value="OCSO_COMPTROLLER">OCSO</option>
                <option value="VIOLATIONINFO">Verra</option>
                <option value="MANUAL">Manual</option>
              </select>
              <label className="label"><input type="checkbox" checked={reviewOnly} onChange={(e) => setReviewOnly(e.target.checked)} /> Review only</label>
              <button type="button" onClick={load}>Refresh</button>
              <button type="button" className="button-subtle" onClick={() => setShowImport((v) => !v)}>{showImport ? 'Close' : 'Add citation'}</button>
              <label className="button-subtle" style={{ cursor: 'pointer' }} title="Upload a scanned/emailed citation notice (image or PDF) for OCR">
                {busyId === 'upload' ? 'Uploading...' : 'Upload notice'}
                <input
                  type="file"
                  accept=".pdf,.png,.jpg,.jpeg,.webp,application/pdf,image/*"
                  hidden
                  disabled={busyId === 'upload'}
                  onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; uploadNotice(f); }}
                />
              </label>
            </div>
          </div>

          {showImport ? (
            <form className="stack" onSubmit={saveManual} style={{ marginTop: 10, paddingTop: 10, borderTop: '0.5px solid rgba(0,0,0,0.08)' }}>
              <div className="grid3">
                <input placeholder="Citation #" value={importForm.citationNo} onChange={(e) => setImportForm((p) => ({ ...p, citationNo: e.target.value }))} />
                <input placeholder="Plate" value={importForm.plate} onChange={(e) => setImportForm((p) => ({ ...p, plate: e.target.value }))} />
                <input placeholder="State" value={importForm.plateState} onChange={(e) => setImportForm((p) => ({ ...p, plateState: e.target.value }))} />
              </div>
              <div className="grid3">
                <input type="datetime-local" value={importForm.issuedAt} onChange={(e) => setImportForm((p) => ({ ...p, issuedAt: e.target.value }))} />
                <input type="number" step="0.01" min="0" placeholder="Amount" value={importForm.amount} onChange={(e) => setImportForm((p) => ({ ...p, amount: e.target.value }))} />
                <input placeholder="Agency" value={importForm.agency} onChange={(e) => setImportForm((p) => ({ ...p, agency: e.target.value }))} />
              </div>
              <input placeholder="Violation type (optional)" value={importForm.violationType} onChange={(e) => setImportForm((p) => ({ ...p, violationType: e.target.value }))} />
              <div className="inline-actions">
                <button type="submit" disabled={busyId === 'manual'}>{busyId === 'manual' ? 'Saving...' : 'Save citation'}</button>
              </div>
            </form>
          ) : null}

          <table style={{ fontSize: '0.88rem', marginTop: 10 }}>
            <thead>
              <tr>
                <th style={{ width: '16%' }}>Citation #</th>
                <th style={{ width: '13%' }}>Vehicle</th>
                <th style={{ width: '11%' }}>Issued</th>
                <th style={{ width: '20%' }}>Agency / Violation</th>
                <th style={{ width: '8%' }}>Source</th>
                <th style={{ width: '9%' }} className="right">Amount</th>
                <th style={{ width: '23%' }}>Status / Actions</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const status = String(r.status || '').toUpperCase();
                return (
                  <tr key={r.id}>
                    <td style={{ fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>{r.citationNo}</td>
                    <td style={{ fontSize: '0.82rem' }}>
                      {r.vehicle ? (
                        <div>
                          <div style={{ fontWeight: 600 }}>{r.vehicle.plate || r.plateNormalized}</div>
                          {r.reservation ? <div style={{ color: '#6b7a9a', fontSize: '0.72rem' }}>{r.reservation.reservationNumber}</div> : null}
                        </div>
                      ) : (
                        <span style={{ color: '#b91c1c', fontSize: '0.78rem' }}>{r.plateNormalized || 'Unmatched'}</span>
                      )}
                    </td>
                    <td style={{ fontSize: '0.82rem' }}>{dateLabel(r.issuedAt)}</td>
                    <td style={{ fontSize: '0.82rem' }}>
                      <div>{r.agency || '—'}</div>
                      {r.violationType ? <div style={{ color: '#6b7a9a', fontSize: '0.74rem' }}>{r.violationType}</div> : null}
                    </td>
                    <td><span style={{ fontSize: '0.72rem', padding: '2px 8px', borderRadius: 6, background: 'rgba(0,0,0,0.05)', color: '#5f5e5a', whiteSpace: 'nowrap' }}>{SOURCE_LABELS[r.source] || r.source}</span></td>
                    <td className="right" style={{ fontWeight: 700 }}>{money(r.amount)}</td>
                    <td>
                      <span className={`status-chip ${STATUS_TONE[status] || 'neutral'}`}>{status.replace('_', ' ')}</span>
                      <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginTop: 6 }}>
                        {status !== 'MATCHED' ? (
                          <button type="button" style={{ fontSize: '0.74rem', padding: '3px 8px' }} onClick={() => review(r, 'CONFIRM')} disabled={busyId === `CONFIRM-${r.id}`}>Confirm</button>
                        ) : null}
                        {status !== 'DISPUTED' ? (
                          <button type="button" className="button-subtle" style={{ fontSize: '0.74rem', padding: '3px 8px' }} onClick={() => review(r, 'DISPUTE')} disabled={busyId === `DISPUTE-${r.id}`}>Dispute</button>
                        ) : null}
                        {status !== 'VOID' ? (
                          <button type="button" className="button-subtle" style={{ fontSize: '0.74rem', padding: '3px 8px' }} onClick={() => review(r, 'VOID')} disabled={busyId === `VOID-${r.id}`}>Void</button>
                        ) : null}
                        {r.vehicleId ? (
                          <a href={`/vehicles?focus=${r.vehicleId}`} style={{ fontSize: '0.72rem', color: '#6e49ff', alignSelf: 'center' }}>Vehicle</a>
                        ) : null}
                      </div>
                    </td>
                  </tr>
                );
              })}
              {!rows.length ? (
                <tr><td colSpan={7} className="label">{isSuper && !activeTenantId ? 'Select a tenant to view citations.' : 'No citations yet. The CPC connector imports them automatically; new cars are included once Citations is enabled for the tenant.'}</td></tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </section>
    </AppShell>
  );
}
