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

// Map the booking-source key to a human label used across the tray + modal copy.
// Defaults to TL International so TL's appearance is byte-identical when no
// source (or 'tl-international') is passed.
function sourceLabelFor(source) {
  switch (String(source || 'tl-international')) {
    case 'economy': return 'Economy (RezLight)';
    case 'nu': return 'NU Car Rentals';
    case 'tl-international':
    default: return 'TL International';
  }
}

// NU is the only source with a prepaid MIX (PP/OP prepaid vs blank pay-at-
// destination). Its pending-imports rows carry `isPrepaid`; TL/Economy rows do
// not (all prepaid) so this badge renders ONLY when the field is present, keeping
// the TL/Economy tray byte-identical.
function PrepaidBadge({ row }) {
  if (row?.isPrepaid === undefined || row?.isPrepaid === null) return null;
  const prepaid = row.isPrepaid === true;
  const style = prepaid
    ? { background: 'rgba(135,82,254,.15)', color: '#5a2fca', border: '1px solid rgba(135,82,254,.22)' }
    : { background: '#fef3c7', color: '#92400e', border: '1px solid #fde68a' };
  return (
    <span
      title={prepaid ? 'Prepaid through NU — do not charge at the counter' : 'Pay at destination — the counter collects at pickup'}
      style={{ ...style, padding: '2px 8px', borderRadius: 999, fontSize: 11, fontWeight: 600, display: 'inline-block' }}
    >
      {prepaid ? 'Prepaid' : 'Pay at destination'}
    </span>
  );
}

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

function EditPromoteModal({ row, token, scopedPath, onClose, onSaved, basePath = '/api/admin/integrations/tl-international', sourceLabel = 'TL International', source = 'tl-international' }) {
  // Phone placeholder stamped when the source sent no phone. Kept source-specific
  // so TL rows stay 'TL-IMPORT-NO-PHONE' (byte-identical) while Economy gets its
  // own token. New sources fall through to a generic token.
  const noPhonePlaceholder = source === 'economy'
    ? 'ECON-IMPORT-NO-PHONE'
    : (source === 'nu'
      ? 'NU-IMPORT-NO-PHONE'
      : (source === 'tl-international' ? 'TL-IMPORT-NO-PHONE' : 'IMPORT-NO-PHONE'));
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
        scopedPath(`${basePath}/pending-imports/${row.id}/promote`),
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
      display: 'flex', alignItems: 'flex-start', justifyContent: 'center',
      zIndex: 1000, padding: '24px 16px', overflowY: 'auto',
    }}>
      <div className="glass card" style={{
        background: 'white', padding: 20, borderRadius: 8,
        width: '100%', maxWidth: 640, marginBottom: 24,
      }}>
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
            {sourceLabel} data for this booking
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
                      // the create succeeds even when the source did not send a phone.
                      // The agent can edit the customer later.
                      phone: tl.phone || noPhonePlaceholder,
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
            <h4 style={{ margin: '0 0 6px' }}>2. Vehicle category</h4>
            <div className="ui-muted" style={{ fontSize: 12, marginBottom: 4 }}>
              ACRISS TL: <strong>{row?.vehicleAcriss || row?.vehicleClass || '-'}</strong> - {row?.vehicleDescription || ''}
            </div>
            <select value={vehicleCategoryOverride} onChange={(e) => setVehicleCategoryOverride(e.target.value)} style={{ width: '100%' }}>
              <option value="">Select…</option>
              {vehicleTypes.map((vt) => (
                <option key={vt.id} value={vt.id}>{vt.name} ({vt.code})</option>
              ))}
            </select>
          </section>

          <section>
            <h4 style={{ margin: '0 0 6px' }}>3. Location</h4>
            <div className="ui-muted" style={{ fontSize: 12, marginBottom: 4 }}>
              TL code: <strong>{row?.locationCode || '-'}</strong>
            </div>
            <select value={locationIdOverride} onChange={(e) => setLocationIdOverride(e.target.value)} style={{ width: '100%' }}>
              <option value="">Select…</option>
              {locations.map((l) => (
                <option key={l.id} value={l.id}>{l.name || l.code} ({l.code})</option>
              ))}
            </select>
          </section>

          <label className="label" style={{ textTransform: 'none', letterSpacing: 0, fontSize: 13 }}>
            <input type="checkbox" checked={saveMapping} onChange={(e) => setSaveMapping(e.target.checked)} />
            {' '}Save mapping for future imports
          </label>

          <div style={{ fontSize: 11, color: '#6b7280', marginTop: 4 }}>
            Vehicle category and Location are optional here — the backend auto-resolves them
            from your TL ACRISS &amp; Location mappings when you have them set up. Override only
            if you want to force a specific value.
          </div>
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <button type="button" onClick={onClose} disabled={busy}>Cancel</button>
            <button type="submit" disabled={busy || !customerId}>
              {busy ? 'Promoting…' : 'Promote'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

const SORT_OPTIONS = [
  { value: 'pickup-asc',  label: 'Pickup — oldest first' },
  { value: 'pickup-desc', label: 'Pickup — newest first' },
  { value: 'return-asc',  label: 'Return — oldest first' },
  { value: 'return-desc', label: 'Return — newest first' },
];

function sortRows(rows, sort) {
  const arr = [...rows];
  const dir = sort.endsWith('-asc') ? 1 : -1;
  const field = sort.startsWith('pickup') ? 'pickupAt' : 'dropoffAt';
  arr.sort((a, b) => {
    const av = a[field] ? new Date(a[field]).getTime() : 0;
    const bv = b[field] ? new Date(b[field]).getTime() : 0;
    if (av === bv) return 0;
    return (av - bv) * dir;
  });
  return arr;
}

export function PendingFranchiseImportsTray({ token, me, isSuper, activeTenantId, scopedPath, source = 'tl-international' }) {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [editRow, setEditRow] = useState(null);
  const [msg, setMsg] = useState('');
  const [autoPromotedToday, setAutoPromotedToday] = useState(0);
  const [sort, setSort] = useState('pickup-asc');

  // Source-aware base path + label — the same tray serves any booking-source
  // integration (TL International or Economy). Defaults to TL for backward
  // compatibility, so TL's tray appearance/behavior is byte-identical.
  const basePath = `/api/admin/integrations/${source}`;
  const sourceLabel = sourceLabelFor(source);

  // 2026-07-13 (Hector): tenant ADMINs work their own pending imports too.
  // The backend routes were always SUPER_ADMIN + ADMIN (ADMIN hard-scoped to
  // its tenant via resolveTenantId) — only this tray hid itself from admins.
  // ADMIN requests don't append ?tenantId; the backend resolves their tenant.
  const canSeeTray = isSuper || String(me?.role || '').toUpperCase() === 'ADMIN';

  const scoped = scopedPath || ((p) => {
    if (!isSuper || !activeTenantId) return p;
    const sep = p.includes('?') ? '&' : '?';
    return `${p}${sep}tenantId=${encodeURIComponent(activeTenantId)}`;
  });

  const load = async () => {
    if (!canSeeTray) return;
    setLoading(true);
    try {
      const [pending, status] = await Promise.all([
        api(scoped(`${basePath}/pending-imports`), { bypassCache: true }, token).catch(() => ({ rows: [] })),
        api(scoped(`${basePath}/status`), { bypassCache: true }, token).catch(() => null)
      ]);
      setRows(Array.isArray(pending?.rows) ? pending.rows : []);
      setAutoPromotedToday(Number(status?.lastRun?.autoPromotedToday || status?.autoPromotedToday || 0));
    } catch {
      setRows([]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [token, activeTenantId, isSuper, canSeeTray]);

  if (!canSeeTray) return null;
  if (!loading && rows.length === 0) return null;

  const promote = async (r) => {
    setMsg('');
    try {
      const res = await api(
        scoped(`${basePath}/pending-imports/${r.id}/promote`),
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
        scoped(`${basePath}/pending-imports/${r.id}/reject`),
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
          <strong style={{ fontSize: 15 }}>Pending franchise imports — {sourceLabel}</strong>
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
        <div style={{ padding: '0 16px 16px', maxWidth: '100%', minWidth: 0 }}>
          {msg ? (
            <div style={{ padding: 8, background: '#ecfdf5', color: '#065f46', borderRadius: 4, marginBottom: 8 }}>{msg}</div>
          ) : null}
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, alignItems: 'center', marginBottom: 8 }}>
            <label style={{ fontSize: 12, color: '#6b7280' }}>Sort by</label>
            <select
              value={sort}
              onChange={(e) => setSort(e.target.value)}
              style={{ fontSize: 12, padding: '4px 8px', borderRadius: 4 }}
            >
              {SORT_OPTIONS.map(o => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
          </div>
          <div style={{ overflowX: 'auto', WebkitOverflowScrolling: 'touch', maxWidth: '100%' }}>
            <table style={{ width: '100%', minWidth: 900, borderCollapse: 'collapse', fontSize: 13 }}>
              <thead>
                <tr style={{ borderBottom: '1px solid #e5e7eb', textAlign: 'left', background: '#f9fafb' }}>
                  <th style={{ padding: '6px 8px' }}>{sourceLabel} Ref</th>
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
                ) : sortRows(rows, sort).map((r) => {
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
                      <td style={{ padding: '6px 8px' }}>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, alignItems: 'flex-start' }}>
                          <ReasonBadge reason={r.needsReviewReason} />
                          <PrepaidBadge row={r} />
                        </div>
                      </td>
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
          basePath={basePath}
          sourceLabel={sourceLabel}
          source={source}
          onClose={() => setEditRow(null)}
          onSaved={() => { setMsg(`Promoted: ${editRow.externalRef}`); load(); }}
        />
      ) : null}
    </section>
  );
}

export default PendingFranchiseImportsTray;
