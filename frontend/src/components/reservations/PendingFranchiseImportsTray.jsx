'use client';

/**
 * PendingFranchiseImportsTray - shown at the top of the Reservations list when
 * there are franchise (TL International) reservations awaiting review.
 *
 * Visibility rules:
 *  - SUPER_ADMIN only (gated by caller).
 *  - If 0 pending rows -> the tray renders nothing at all (no empty state).
 *
 * Backend contract:
 *   GET  /api/admin/integrations/tl-international/pending-imports
 *        -> { rows: [{ id, externalRef, customer..., needsReviewReason, ... }] }
 *   POST /api/admin/integrations/tl-international/pending-imports/:id/promote
 *        body: { customerId?, vehicleCategoryOverride?, locationIdOverride? }
 *        -> { ok, reservationId }
 *   POST /api/admin/integrations/tl-international/pending-imports/:id/reject
 *        -> { ok }
 */

import { useEffect, useState } from 'react';
import { api } from '../../lib/client';

function ReasonBadge({ reason }) {
  const r = String(reason || '').toUpperCase();
  const map = {
    CUSTOMER_NOT_FOUND:       { bg: '#fef3c7', fg: '#92400e', label: 'Customer unmapped' },
    VEHICLE_CATEGORY_UNKNOWN: { bg: '#fee2e2', fg: '#991b1b', label: 'Unknown category' },
    LOCATION_UNKNOWN:         { bg: '#fef3c7', fg: '#92400e', label: 'Location unmapped' },
    DUPLICATE:                { bg: '#e0f2fe', fg: '#075985', label: 'Duplicate' },
    AUTO_PROMOTED:            { bg: '#dcfce7', fg: '#166534', label: 'Auto-promoted' },
  };
  const cfg = map[r] || { bg: '#e5e7eb', fg: '#374151', label: r || 'Review' };
  return (
    <span style={{ background: cfg.bg, color: cfg.fg, padding: '2px 8px', borderRadius: 999, fontSize: 11, fontWeight: 600 }}>
      {cfg.label}
    </span>
  );
}

function fmtMoney(n) {
  const num = Number(n);
  if (!Number.isFinite(num)) return '-';
  return `$${num.toFixed(2)}`;
}

function fmtDateTime(iso) {
  if (!iso) return '-';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString();
}

function CopyButton({ value, label }) {
  const [copied, setCopied] = useState(false);
  const onClick = async (e) => {
    e.stopPropagation();
    try {
      if (typeof navigator !== 'undefined' && navigator.clipboard) {
        await navigator.clipboard.writeText(String(value || ''));
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }
    } catch {}
  };
  return (
    <button type="button" onClick={onClick} title={label || 'Copiar / Copy'} style={{ marginLeft: 4, fontSize: 11, padding: '0 6px' }}>
      {copied ? 'OK' : 'Copy'}
    </button>
  );
}

function EditPromoteModal({ row, token, scopedPath, onClose, onSaved }) {
  // TL ships customer fields either flat on the row (customerFirstName, ...)
  // or nested under row.customer depending on which sync version produced the
  // record. Normalize once so the rest of the modal can read from `tl`.
  const tl = {
    firstName: row?.customerFirstName || row?.customer?.firstName || '',
    lastName: row?.customerLastName || row?.customer?.lastName || '',
    email: row?.customerEmail || row?.customer?.email || '',
    phone: row?.customerPhone || row?.customer?.phone || '',
    country: row?.customerCountry || row?.customer?.country || ''
  };
  const tlFullName = `${tl.firstName} ${tl.lastName}`.trim();

  const [customerId, setCustomerId] = useState(row?.matchedCustomerId || '');
  const [customerQuery, setCustomerQuery] = useState(row?.customer?.fullName || tlFullName || '');
  const [customerResults, setCustomerResults] = useState([]);
  const [vehicleCategoryOverride, setVehicleCategoryOverride] = useState(row?.suggestedVehicleTypeId || '');
  const [locationIdOverride, setLocationIdOverride] = useState(row?.suggestedLocationId || '');
  const [saveMapping, setSaveMapping] = useState(true);
  const [vehicleTypes, setVehicleTypes] = useState([]);
  const [locations, setLocations] = useState([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [creatingCustomer, setCreatingCustomer] = useState(false);
  const [customerCreatedMsg, setCustomerCreatedMsg] = useState('');

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [vts, locs] = await Promise.all([
          api(scopedPath('/api/vehicle-types'), {}, token).catch(() => []),
          api(scopedPath('/api/locations'), {}, token).catch(() => [])
        ]);
        if (cancelled) return;
        setVehicleTypes(Array.isArray(vts) ? vts : (vts?.rows || []));
        setLocations(Array.isArray(locs) ? locs : (locs?.rows || []));
      } catch {}
    })();
    return () => { cancelled = true; };
  }, [token, scopedPath]);

  useEffect(() => {
    const q = String(customerQuery || '').trim();
    if (q.length < 2) { setCustomerResults([]); return; }
    let cancelled = false;
    const handle = setTimeout(async () => {
      try {
        const res = await api(scopedPath(`/api/customers?search=${encodeURIComponent(q)}&limit=10`), {}, token).catch(() => null);
        if (cancelled) return;
        const rows = Array.isArray(res) ? res : (res?.rows || res?.customers || []);
        setCustomerResults(rows);
      } catch {}
    }, 250);
    return () => { cancelled = true; clearTimeout(handle); };
  }, [customerQuery, token, scopedPath]);

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const body = {
        customerId: customerId || undefined,
        vehicleCategoryOverride: vehicleCategoryOverride || undefined,
        locationIdOverride: locationIdOverride || undefined,
        saveMapping: !!saveMapping
      };
      const res = await api(
        scopedPath(`/api/admin/integrations/tl-international/pending-imports/${row.id}/promote`),
        { method: 'POST', body: JSON.stringify(body) },
        token
      );
      if (res?.ok) {
        if (onSaved) onSaved(res);
        onClose();
      } else {
        setError('Promotion failed');
      }
    } catch (err) {
      setError(err?.message || 'Error promoting');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000
    }}>
      <div className="glass card" style={{ background: 'white', padding: 20, borderRadius: 8, width: '90%', maxWidth: 640, maxHeight: '90vh', overflow: 'auto' }}>
        <div className="row-between" style={{ alignItems: 'start', marginBottom: 12 }}>
          <div>
            <h3 style={{ margin: 0 }}>Edit & promote</h3>
            <div className="ui-muted" style={{ fontSize: 13 }}>
              {row?.externalRef} - {row?.customer?.fullName || `${row?.customerFirstName || ''} ${row?.customerLastName || ''}`.trim() || '-'}
            </div>
          </div>
          <button type="button" onClick={onClose} aria-label="Close">x</button>
        </div>

        {error ? (
          <div style={{ padding: 8, background: '#fee2e2', color: '#991b1b', borderRadius: 4, marginBottom: 8 }}>{error}</div>
        ) : null}

        <section style={{ background: '#f0f9ff', border: '1px solid #bae6fd', padding: 10, borderRadius: 6, marginBottom: 12 }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: '#0369a1', marginBottom: 6 }}>
            TL data for this booking
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: '4px 12px', fontSize: 13 }}>
            <div><strong>Name:</strong> {tlFullName || '-'}</div>
            <div><strong>Email:</strong> {tl.email || '-'}</div>
            <div><strong>Phone:</strong> {tl.phone || '-'}</div>
            <div><strong>Country:</strong> {tl.country || '-'}</div>
            <div><strong>Pickup:</strong> {fmtDateTime(row?.pickupAt)}</div>
            <div><strong>Return:</strong> {fmtDateTime(row?.dropoffAt || row?.returnAt)}</div>
            <div><strong>Vehicle ACRISS:</strong> {row?.vehicleAcriss || row?.vehicleClass || '-'}</div>
            <div><strong>Total:</strong> {fmtMoney(row?.totalAmount)}</div>
          </div>
        </section>

        <form onSubmit={submit} className="stack" style={{ gap: 14 }}>
          <section>
            <h4 style={{ margin: '0 0 6px' }}>1. Customer</h4>
            <input
              type="text"
              placeholder="Search customer by name or email"
              value={customerQuery}
              onChange={(e) => setCustomerQuery(e.target.value)}
              style={{ width: '100%' }}
            />
            {customerResults.length > 0 ? (
              <div style={{ maxHeight: 140, overflowY: 'auto', border: '1px solid #e5e7eb', borderRadius: 4, marginTop: 4 }}>
                {customerResults.map((c) => (
                  <button
                    key={c.id}
                    type="button"
                    onClick={() => { setCustomerId(c.id); setCustomerQuery(c.fullName || `${c.firstName || ''} ${c.lastName || ''}`.trim() || c.email || c.id); setCustomerResults([]); }}
                    style={{
                      display: 'block', width: '100%', textAlign: 'left',
                      padding: '6px 10px', background: customerId === c.id ? '#dbeafe' : 'transparent',
                      border: 0, borderBottom: '1px solid #f3f4f6', cursor: 'pointer'
                    }}
                  >
                    <strong>{c.fullName || `${c.firstName || ''} ${c.lastName || ''}`.trim()}</strong>
                    <div className="ui-muted" style={{ fontSize: 12 }}>{c.email || c.phone || c.id}</div>
                  </button>
                ))}
              </div>
            ) : null}
            <div className="ui-muted" style={{ fontSize: 12, marginTop: 4 }}>
              Selected: <strong>{customerId || 'None'}</strong>
              {customerCreatedMsg ? (
                <span style={{ marginLeft: 8, color: '#065f46' }}>{customerCreatedMsg}</span>
              ) : null}
            </div>
            <div style={{ display: 'flex', gap: 8, marginTop: 6, flexWrap: 'wrap', alignItems: 'center' }}>
              <button
                type="button"
                disabled={busy || creatingCustomer || !!customerId || !tl.firstName || !tl.lastName}
                onClick={async () => {
                  setCreatingCustomer(true);
                  setError('');
                  setCustomerCreatedMsg('');
                  try {
                    const payload = {
                      firstName: tl.firstName,
                      lastName: tl.lastName,
                      email: tl.email || undefined,
                      // Backend requires `phone`; fall back to a clear placeholder so
                      // the create succeeds even when TL did not send a phone. The
                      // agent can edit the customer later.
                      phone: tl.phone || 'TL-IMPORT-NO-PHONE',
                      country: tl.country || undefined
                    };
                    const res = await api(
                      scopedPath('/api/customers'),
                      { method: 'POST', body: JSON.stringify(payload) },
                      token
                    );
                    const newId = res?.id || res?.customer?.id;
                    if (newId) {
                      setCustomerId(newId);
                      setCustomerQuery(`${tl.firstName} ${tl.lastName} (NEW)`);
                      setCustomerResults([]);
                      setCustomerCreatedMsg('Customer created');
                    } else {
                      setError('Customer create returned no id');
                    }
                  } catch (err) {
                    setError(`Could not create customer: ${err?.message || 'unknown error'}`);
                  } finally {
                    setCreatingCustomer(false);
                  }
                }}
                title={!tl.firstName || !tl.lastName ? 'Missing TL data' : ''}
                style={{
                  background: (busy || creatingCustomer || !!customerId || !tl.firstName || !tl.lastName) ? '#9ca3af' : '#1fc7aa',
                  color: 'white', border: 'none', padding: '6px 10px', borderRadius: 4, fontSize: 12,
                  cursor: (busy || creatingCustomer || !!customerId || !tl.firstName || !tl.lastName) ? 'not-allowed' : 'pointer'
                }}
              >
                {creatingCustomer ? 'Creating…' : 'Use TL customer data (create new)'}
              </button>
              <span style={{ fontSize: 11, color: '#6b7280' }}>
                Creates a Customer record using the TL data above
              </span>
            </div>
          </section>

          <section>
            <h4 style={{ margin: '0 0 6px' }}>2. Categoria de vehiculo / Vehicle category</h4>
            <div className="ui-muted" style={{ fontSize: 12, marginBottom: 4 }}>
              ACRISS TL: <strong>{row?.vehicleAcriss || row?.vehicleClass || '-'}</strong> - {row?.vehicleDescription || ''}
            </div>
            <select value={vehicleCategoryOverride} onChange={(e) => setVehicleCategoryOverride(e.target.value)} style={{ width: '100%' }}>
              <option value="">Seleccionar... / Select...</option>
              {vehicleTypes.map((vt) => (
                <option key={vt.id} value={vt.id}>{vt.name} ({vt.code})</option>
              ))}
            </select>
          </section>

          <section>
            <h4 style={{ margin: '0 0 6px' }}>3. Sucursal / Location</h4>
            <div className="ui-muted" style={{ fontSize: 12, marginBottom: 4 }}>
              Codigo TL / TL code: <strong>{row?.locationCode || '-'}</strong>
            </div>
            <select value={locationIdOverride} onChange={(e) => setLocationIdOverride(e.target.value)} style={{ width: '100%' }}>
              <option value="">Seleccionar... / Select...</option>
              {locations.map((l) => (
                <option key={l.id} value={l.id}>{l.name || l.code} ({l.code})</option>
              ))}
            </select>
          </section>

          <label className="label" style={{ textTransform: 'none', letterSpacing: 0, fontSize: 13 }}>
            <input type="checkbox" checked={saveMapping} onChange={(e) => setSaveMapping(e.target.checked)} />
            {' '}Guardar mapeo para futuras importaciones / Save mapping for future imports
          </label>

          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <button type="button" onClick={onClose} disabled={busy}>Cancelar / Cancel</button>
            <button type="submit" disabled={busy || !customerId || !vehicleCategoryOverride || !locationIdOverride}>
              {busy ? 'Promoviendo... / Promoting...' : 'Promover / Promote'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

export function PendingFranchiseImportsTray({ token, me, isSuper, activeTenantId, scopedPath }) {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [editRow, setEditRow] = useState(null);
  const [msg, setMsg] = useState('');
  const [autoPromotedToday, setAutoPromotedToday] = useState(0);

  const scoped = scopedPath || ((p) => {
    if (!isSuper || !activeTenantId) return p;
    const sep = p.includes('?') ? '&' : '?';
    return `${p}${sep}tenantId=${encodeURIComponent(activeTenantId)}`;
  });

  const load = async () => {
    if (!isSuper) return;
    setLoading(true);
    try {
      const [pending, status] = await Promise.all([
        api(scoped('/api/admin/integrations/tl-international/pending-imports'), { bypassCache: true }, token).catch(() => ({ rows: [] })),
        api(scoped('/api/admin/integrations/tl-international/status'), { bypassCache: true }, token).catch(() => null)
      ]);
      setRows(Array.isArray(pending?.rows) ? pending.rows : []);
      setAutoPromotedToday(Number(status?.lastRun?.autoPromotedToday || status?.autoPromotedToday || 0));
    } catch {
      setRows([]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [token, activeTenantId, isSuper]);

  if (!isSuper) return null;
  if (!loading && rows.length === 0) return null;

  const promote = async (r) => {
    setMsg('');
    try {
      const res = await api(
        scoped(`/api/admin/integrations/tl-international/pending-imports/${r.id}/promote`),
        { method: 'POST', body: JSON.stringify({}) },
        token
      );
      if (res?.ok) {
        setMsg(`Promoted: ${r.externalRef}`);
        await load();
      }
    } catch (err) {
      setMsg(err?.message || 'Error promoting');
    }
  };

  const reject = async (r) => {
    if (typeof window !== 'undefined' && !window.confirm(`Reject ${r.externalRef}?`)) return;
    setMsg('');
    try {
      const res = await api(
        scoped(`/api/admin/integrations/tl-international/pending-imports/${r.id}/reject`),
        { method: 'POST' },
        token
      );
      if (res?.ok) {
        setMsg(`Rejected: ${r.externalRef}`);
        await load();
      }
    } catch (err) {
      setMsg(err?.message || 'Error rejecting');
    }
  };

  return (
    <section className="glass card section-card" style={{ marginBottom: 16, borderLeft: '4px solid #f59e0b', overflow: 'hidden', maxWidth: '100%' }}>
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        style={{
          width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '12px 16px', background: 'transparent', border: 0, cursor: 'pointer', textAlign: 'left'
        }}
      >
        <div>
          <strong style={{ fontSize: 15 }}>Pending franchise imports</strong>
          <span style={{
            marginLeft: 8, background: '#f59e0b', color: 'white',
            padding: '2px 8px', borderRadius: 999, fontSize: 12, fontWeight: 700
          }}>
            {rows.length}
          </span>
          <div className="ui-muted" style={{ fontSize: 13, marginTop: 2 }}>
            {rows.length} franchise import{rows.length === 1 ? '' : 's'} awaiting review
          </div>
        </div>
        <span style={{ fontSize: 18, color: '#6b7280' }}>{expanded ? 'v' : '>'}</span>
      </button>

      {expanded ? (
        <div style={{ padding: '0 16px 16px', maxWidth: '100%' }}>
          {msg ? (
            <div style={{ padding: 8, background: '#ecfdf5', color: '#065f46', borderRadius: 4, marginBottom: 8 }}>{msg}</div>
          ) : null}
          <div style={{ overflowX: 'auto', WebkitOverflowScrolling: 'touch', maxWidth: '100%' }}>
            <table style={{ width: '100%', minWidth: 900, borderCollapse: 'collapse', fontSize: 13 }}>
              <thead>
                <tr style={{ borderBottom: '1px solid #e5e7eb', textAlign: 'left', background: '#f9fafb' }}>
                  <th style={{ padding: '6px 8px' }}>TL Ref</th>
                  <th style={{ padding: '6px 8px' }}>Customer</th>
                  <th style={{ padding: '6px 8px' }}>Pickup</th>
                  <th style={{ padding: '6px 8px' }}>Return</th>
                  <th style={{ padding: '6px 8px' }}>Location</th>
                  <th style={{ padding: '6px 8px' }}>Vehicle</th>
                  <th style={{ padding: '6px 8px', textAlign: 'right' }}>Total</th>
                  <th style={{ padding: '6px 8px' }}>Reason</th>
                  <th style={{ padding: '6px 8px' }}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {loading ? (
                  <tr><td colSpan={9} style={{ padding: 12, color: '#6b7280' }}>Loading…</td></tr>
                ) : rows.map((r) => {
                  const canAutoPromote = r.matchedCustomerId && r.suggestedVehicleTypeId && r.suggestedLocationId;
                  return (
                    <tr key={r.id} style={{ borderBottom: '1px solid #f3f4f6' }}>
                      <td style={{ padding: '6px 8px', whiteSpace: 'nowrap' }}>
                        <code>{r.externalRef}</code>
                        <CopyButton value={r.externalRef} />
                      </td>
                      <td style={{ padding: '6px 8px' }}>
                        <div>{r.customer?.fullName || `${r.customer?.firstName || r.customerFirstName || ''} ${r.customer?.lastName || r.customerLastName || ''}`.trim() || '-'}</div>
                        <div className="ui-muted" style={{ fontSize: 11 }}>{r.customer?.email || r.customerEmail || r.customer?.phone || r.customerPhone || ''}</div>
                      </td>
                      <td style={{ padding: '6px 8px' }}>{fmtDateTime(r.pickupAt)}</td>
                      <td style={{ padding: '6px 8px' }}>{fmtDateTime(r.dropoffAt)}</td>
                      <td style={{ padding: '6px 8px' }}>{r.locationCode || r.pickupLocation || '-'}</td>
                      <td style={{ padding: '6px 8px' }}>
                        <div><strong>{r.vehicleAcriss || r.vehicleClass || '-'}</strong></div>
                        <div className="ui-muted" style={{ fontSize: 11 }}>{r.vehicleDescription || ''}</div>
                      </td>
                      <td style={{ padding: '6px 8px', textAlign: 'right' }}>{fmtMoney(r.totalAmount)}</td>
                      <td style={{ padding: '6px 8px' }}><ReasonBadge reason={r.needsReviewReason} /></td>
                      <td style={{ padding: '6px 8px', whiteSpace: 'nowrap' }}>
                        <button type="button" disabled={!canAutoPromote} onClick={() => promote(r)} title={canAutoPromote ? '' : 'Mapping incomplete'}>
                          Promote
                        </button>
                        {' '}
                        <button type="button" onClick={() => setEditRow(r)}>Edit</button>
                        {' '}
                        <button type="button" onClick={() => reject(r)} style={{ color: '#991b1b' }}>Reject</button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div className="ui-muted" style={{ fontSize: 12, marginTop: 10 }}>
            Auto-promoted today: <strong>{autoPromotedToday}</strong>
          </div>
        </div>
      ) : null}

      {editRow ? (
        <EditPromoteModal
          row={editRow}
          token={token}
          scopedPath={scoped}
          onClose={() => setEditRow(null)}
          onSaved={() => { setMsg(`Promoted: ${editRow.externalRef}`); load(); }}
        />
      ) : null}
    </section>
  );
}

export default PendingFranchiseImportsTray;
