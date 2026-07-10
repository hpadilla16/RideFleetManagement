'use client';

/**
 * IncidentReportsPanel — incident / damage report module UI (beta.62).
 *
 * Renders on /reservations/[id] for ADMIN / OPS / AGENT. Drives the full
 * lifecycle against /api/incident-reports:
 *   - list incidents for the reservation
 *   - create a DRAFT, edit fields, manage evidence (upload / pull from
 *     inspection / remove), pick clauses, then certify & issue (locks)
 *   - view an ISSUED report, print/PDF, or revise (clones a new DRAFT)
 *
 * Props:
 *   reservation — the reservation row (id, reservationNumber, vehicle, customer)
 *   token       — auth token from AuthGate
 *   role        — current user role (renders nothing unless ADMIN/OPS/AGENT)
 *   me          — current user (used to default the certifier name)
 */

import { useEffect, useRef, useState } from 'react';
import { api, API_BASE } from '../../lib/client';

const TYPES = ['DAMAGE', 'SMOKING', 'CLEANING', 'POLICY_VIOLATION', 'TOLL', 'LATE_RETURN', 'OTHER'];
const SEVERITIES = ['MINOR', 'MODERATE', 'SEVERE'];
const ALLOWED_ROLES = ['ADMIN', 'OPS', 'AGENT', 'SUPER_ADMIN'];

const STATUS_STYLE = {
  DRAFT: { bg: '#FAEEDA', fg: '#854F0B', label: 'DRAFT' },
  ISSUED: { bg: '#E6F1FB', fg: '#0C447C', label: 'ISSUED' },
  DISPUTED: { bg: '#FCEBEB', fg: '#A32D2D', label: 'DISPUTED' },
  RESOLVED: { bg: '#E1F5EE', fg: '#0F6E56', label: 'RESOLVED' },
  CLOSED: { bg: '#F1EFE8', fg: '#444441', label: 'CLOSED' },
  VOID: { bg: '#F1EFE8', fg: '#5F5E5A', label: 'VOID' },
};

// Post-issuance transitions (mirrors the backend STATUS_FLOW).
const STATUS_NEXT = {
  ISSUED: ['DISPUTED', 'RESOLVED', 'CLOSED', 'VOID'],
  DISPUTED: ['RESOLVED', 'CLOSED', 'VOID'],
  RESOLVED: ['CLOSED', 'VOID'],
};

function fmtMoney(n) {
  if (n == null || n === '') return '—';
  return `$${Number(n).toFixed(2)}`;
}
function fmtDate(iso) {
  if (!iso) return '—';
  try { return new Date(iso).toLocaleString(); } catch { return String(iso); }
}
function StatusBadge({ status }) {
  const s = STATUS_STYLE[status] || STATUS_STYLE.DRAFT;
  return (
    <span style={{ background: s.bg, color: s.fg, fontSize: 11, padding: '2px 9px', borderRadius: 8, whiteSpace: 'nowrap' }}>
      {status !== 'DRAFT' && <span style={{ marginRight: 4 }}>🔒</span>}{s.label}
    </span>
  );
}

// Minimal signature pad → data:image/png. Pointer-based; works mouse + touch.
function SignaturePad({ onChange }) {
  const ref = useRef(null);
  const drawing = useRef(false);
  const dirty = useRef(false);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    ctx.lineWidth = 2;
    ctx.lineCap = 'round';
    ctx.strokeStyle = '#0C447C';
    const pos = (e) => {
      const r = canvas.getBoundingClientRect();
      const t = e.touches ? e.touches[0] : e;
      return { x: t.clientX - r.left, y: t.clientY - r.top };
    };
    const start = (e) => { drawing.current = true; const p = pos(e); ctx.beginPath(); ctx.moveTo(p.x, p.y); e.preventDefault(); };
    const move = (e) => { if (!drawing.current) return; const p = pos(e); ctx.lineTo(p.x, p.y); ctx.stroke(); dirty.current = true; e.preventDefault(); };
    const end = () => { if (!drawing.current) return; drawing.current = false; if (dirty.current && onChange) onChange(canvas.toDataURL('image/png')); };
    canvas.addEventListener('mousedown', start); canvas.addEventListener('mousemove', move); window.addEventListener('mouseup', end);
    canvas.addEventListener('touchstart', start, { passive: false }); canvas.addEventListener('touchmove', move, { passive: false }); canvas.addEventListener('touchend', end);
    return () => {
      canvas.removeEventListener('mousedown', start); canvas.removeEventListener('mousemove', move); window.removeEventListener('mouseup', end);
      canvas.removeEventListener('touchstart', start); canvas.removeEventListener('touchmove', move); canvas.removeEventListener('touchend', end);
    };
  }, [onChange]);

  function clear() {
    const canvas = ref.current; if (!canvas) return;
    canvas.getContext('2d').clearRect(0, 0, canvas.width, canvas.height);
    dirty.current = false; if (onChange) onChange('');
  }

  return (
    <div>
      <canvas ref={ref} width={320} height={90}
        style={{ width: '100%', maxWidth: 320, height: 90, border: '1px dashed #9aa', borderRadius: 8, background: '#fff', touchAction: 'none', cursor: 'crosshair' }} />
      <div><button type="button" className="btn ghost" style={{ fontSize: 12, marginTop: 4 }} onClick={clear}>Clear signature</button></div>
    </div>
  );
}

export function IncidentReportsPanel({ reservation, token, role, me, focusIncidentId }) {
  const allowed = ALLOWED_ROLES.includes(String(role || '').toUpperCase());
  const [incidents, setIncidents] = useState([]);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(null);      // currently-open incident (full serialized)
  const [clauses, setClauses] = useState([]);  // clause library
  const [agCharges, setAgCharges] = useState([]); // rental-agreement charges for the §6 picker
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  // certify form
  const [certName, setCertName] = useState('');
  const [certTitle, setCertTitle] = useState('');
  const [sig, setSig] = useState('');

  useEffect(() => {
    if (allowed && reservation?.id) refreshList();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reservation?.id]);

  // Report Damage "Complete now" nudge (Feature 3): when a caller points us at the
  // freshly-created DRAFT, refresh the list, open that incident, and scroll to it.
  useEffect(() => {
    if (!allowed || !focusIncidentId) return;
    (async () => {
      await refreshList();
      await openIncident(focusIncidentId);
      try { document.getElementById('incident-reports')?.scrollIntoView({ behavior: 'smooth', block: 'start' }); } catch { /* noop */ }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusIncidentId]);

  if (!allowed || !reservation?.id) return null;

  async function refreshList() {
    setLoading(true);
    try {
      const rows = await api(`/api/incident-reports/reservations/${reservation.id}`, {}, token);
      setIncidents(Array.isArray(rows) ? rows : []);
    } catch (e) { setError(e?.message || 'Failed to load incidents'); }
    finally { setLoading(false); }
  }
  async function loadClauses() {
    try { const rows = await api('/api/incident-reports/clauses', {}, token); setClauses(Array.isArray(rows) ? rows : []); }
    catch { /* clause library optional */ }
  }
  async function loadCharges() {
    const agId = reservation?.rentalAgreement?.id;
    if (!agId) { setAgCharges([]); return; }
    try { const ag = await api(`/api/rental-agreements/${agId}`, {}, token); setAgCharges(Array.isArray(ag?.charges) ? ag.charges : []); }
    catch { setAgCharges([]); }
  }
  async function openIncident(id) {
    setError('');
    try {
      const inc = await api(`/api/incident-reports/${id}`, {}, token);
      setOpen(inc);
      setCertName(inc.certifiedByName || `${me?.firstName || ''} ${me?.lastName || ''}`.trim());
      setCertTitle(inc.certifiedByTitle || '');
      setSig('');
      loadClauses();
      loadCharges();
    } catch (e) { setError(e?.message || 'Failed to open incident'); }
  }
  async function changeStatus(status) {
    if (!open) return;
    if (!window.confirm(`Move report ${open.reportNumber} to ${status}?`)) return;
    setBusy(true); setError('');
    try {
      const inc = await api(`/api/incident-reports/${open.id}/status`, { method: 'POST', body: JSON.stringify({ status }) }, token);
      setOpen(inc); await refreshList();
    } catch (e) { setError(e?.message || 'Status change failed'); }
    finally { setBusy(false); }
  }
  async function saveEvidence(evId, patch) {
    setBusy(true); setError('');
    try { await api(`/api/incident-reports/${open.id}/evidence/${evId}`, { method: 'PATCH', body: JSON.stringify(patch) }, token); await openIncident(open.id); }
    catch (e) { setError(e?.message || 'Evidence update failed'); }
    finally { setBusy(false); }
  }
  async function toggleCharge(chargeId, checked) {
    const base = (open.chargeIds && open.chargeIds.length)
      ? new Set(open.chargeIds.map(String))
      : new Set(agCharges.filter((c) => c.selected !== false).map((c) => String(c.id)));
    if (checked) base.add(String(chargeId)); else base.delete(String(chargeId));
    patchOpen({ chargeIds: Array.from(base) });
  }
  async function createIncident() {
    setBusy(true); setError('');
    try {
      const inc = await api(`/api/incident-reports/reservations/${reservation.id}`, {
        method: 'POST', body: JSON.stringify({ type: 'DAMAGE', title: 'Vehicle incident' }),
      }, token);
      await refreshList();
      await openIncident(inc.id);
    } catch (e) { setError(e?.message || 'Create failed'); }
    finally { setBusy(false); }
  }
  async function patchOpen(patch) {
    if (!open) return;
    setBusy(true); setError('');
    try {
      const inc = await api(`/api/incident-reports/${open.id}`, { method: 'PATCH', body: JSON.stringify(patch) }, token);
      setOpen(inc);
    } catch (e) { setError(e?.message || 'Update failed'); }
    finally { setBusy(false); }
  }
  async function toggleClause(clauseId, checked) {
    // The cited-clause snapshot has no clause id, so derive the current
    // selection by matching the library against the snapshot on section+label.
    const citedKeys = new Set((open.citedClauses || []).map((c) => `${c.section}|${c.label}`));
    const derived = clauses.filter((c) => citedKeys.has(`${c.section}|${c.label}`)).map((c) => c.id);
    const selected = new Set(open._selectedClauseIds || derived);
    if (checked) selected.add(clauseId); else selected.delete(clauseId);
    setBusy(true); setError('');
    try {
      const inc = await api(`/api/incident-reports/${open.id}/clauses`, { method: 'POST', body: JSON.stringify({ clauseIds: Array.from(selected) }) }, token);
      inc._selectedClauseIds = Array.from(selected);
      setOpen(inc);
    } catch (e) { setError(e?.message || 'Clause update failed'); }
    finally { setBusy(false); }
  }
  async function addPhotoEvidence(file) {
    if (!file) return;
    setBusy(true); setError('');
    try {
      const dataUrl = await new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(file); });
      await api(`/api/incident-reports/${open.id}/evidence`, {
        method: 'POST', body: JSON.stringify({ photoDataUrl: dataUrl, location: 'New evidence', description: '', evidenceStatus: 'VIOLATION', sourcePhase: 'NEW' }),
      }, token);
      await openIncident(open.id);
    } catch (e) { setError(e?.message || 'Add photo failed'); }
    finally { setBusy(false); }
  }
  async function pullInspection(phase) {
    setBusy(true); setError('');
    try {
      await api(`/api/incident-reports/${open.id}/evidence/pull`, { method: 'POST', body: JSON.stringify({ phase }) }, token);
      await openIncident(open.id);
    } catch (e) { setError(e?.message || 'Pull failed'); }
    finally { setBusy(false); }
  }
  async function removeEvidence(evId) {
    setBusy(true); setError('');
    try { await api(`/api/incident-reports/${open.id}/evidence/${evId}`, { method: 'DELETE' }, token); await openIncident(open.id); }
    catch (e) { setError(e?.message || 'Remove failed'); }
    finally { setBusy(false); }
  }
  async function certify() {
    if (!certName.trim()) { setError('Certifier name is required.'); return; }
    if (!sig.startsWith('data:image')) { setError('A signature is required to issue.'); return; }
    if (!window.confirm('Issue this report? It locks and can no longer be edited (use Revise to change an issued report).')) return;
    setBusy(true); setError('');
    try {
      await api(`/api/incident-reports/${open.id}/certify`, { method: 'POST', body: JSON.stringify({ certifiedByName: certName.trim(), certifiedByTitle: certTitle.trim() || null, signatureDataUrl: sig }) }, token);
      await refreshList();
      await openIncident(open.id);
    } catch (e) { setError(e?.message || 'Certify failed'); }
    finally { setBusy(false); }
  }
  async function revise() {
    setBusy(true); setError('');
    try { const inc = await api(`/api/incident-reports/${open.id}/revise`, { method: 'POST', body: JSON.stringify({}) }, token); await refreshList(); await openIncident(inc.id); }
    catch (e) { setError(e?.message || 'Revise failed'); }
    finally { setBusy(false); }
  }
  async function printReport() {
    try {
      const res = await fetch(`${API_BASE}/api/incident-reports/${open.id}/print`, { headers: { Authorization: `Bearer ${token}` } });
      const html = await res.text();
      const w = window.open('', '_blank');
      if (w) { w.document.open(); w.document.write(html); w.document.close(); }
    } catch (e) { setError(e?.message || 'Print failed'); }
  }

  const locked = open && open.status !== 'DRAFT';
  const citedKeys = new Set((open?.citedClauses || []).map((c) => `${c.section}|${c.label}`));
  const selectedClauseIds = new Set(
    open?._selectedClauseIds || clauses.filter((c) => citedKeys.has(`${c.section}|${c.label}`)).map((c) => c.id)
  );

  return (
    <section id="incident-reports" className="glass card-lg section-card" style={{ marginTop: 24, marginBottom: 24, borderLeft: '4px solid #185FA5' }}>
      <div className="row-between" style={{ alignItems: 'center' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <strong style={{ fontSize: 15 }}>Incident reports</strong>
          <span style={{ background: 'rgba(0,0,0,0.06)', fontSize: 12, padding: '2px 8px', borderRadius: 8 }}>{incidents.length}</span>
        </div>
        {!open && (
          <button className="btn" type="button" onClick={createIncident} disabled={busy}
            style={{ border: '2px solid #185FA5', color: '#0C447C' }}>+ New incident report</button>
        )}
        {open && <button className="btn ghost" type="button" onClick={() => setOpen(null)}>← Back to list</button>}
      </div>

      {error && <div style={{ marginTop: 12, color: '#b91c1c', fontSize: 13 }}>{error}</div>}

      {/* LIST VIEW */}
      {!open && (
        <div style={{ marginTop: 14 }}>
          {loading && <p className="ui-muted" style={{ fontSize: 13 }}>Loading…</p>}
          {!loading && incidents.length === 0 && <p className="ui-muted" style={{ fontSize: 13 }}>No incident reports for this reservation yet.</p>}
          {incidents.map((inc) => (
            <div key={inc.id} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 2px', borderTop: '1px solid rgba(0,0,0,0.07)' }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13.5 }}>{inc.title || 'Untitled incident'}</div>
                <div className="ui-muted" style={{ fontSize: 12 }}>
                  <code>{inc.reportNumber}</code> · {inc.type} · {(inc.evidence || []).length} evidence
                </div>
              </div>
              <StatusBadge status={inc.status} />
              <button className="btn ghost" style={{ fontSize: 12, padding: '4px 10px' }} onClick={() => openIncident(inc.id)}>
                {inc.status === 'DRAFT' ? 'Edit' : 'Open'}
              </button>
            </div>
          ))}
        </div>
      )}

      {/* DETAIL / BUILDER VIEW */}
      {open && (
        <div style={{ marginTop: 14 }}>
          <div className="row-between" style={{ alignItems: 'center', marginBottom: 12 }}>
            <div>
              <code style={{ fontSize: 13 }}>{open.reportNumber}</code>{' '}
              <StatusBadge status={open.status} />
            </div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <button className="btn ghost" type="button" onClick={printReport} style={{ fontSize: 13 }}>Preview / PDF</button>
              {locked && <button className="btn ghost" type="button" onClick={revise} disabled={busy} style={{ fontSize: 13 }}>Revise</button>}
              {locked && (STATUS_NEXT[open.status] || []).map((s) => (
                <button key={s} className="btn ghost" type="button" onClick={() => changeStatus(s)} disabled={busy}
                  style={{ fontSize: 13, color: STATUS_STYLE[s]?.fg }}>{s.charAt(0) + s.slice(1).toLowerCase()}</button>
              ))}
            </div>
          </div>

          {/* Core fields */}
          <div className="app-card-grid compact" style={{ marginBottom: 12 }}>
            <div>
              <label className="label">Type</label>
              <select value={open.type} disabled={locked} onChange={(e) => patchOpen({ type: e.target.value })}>
                {TYPES.map((t) => <option key={t} value={t}>{t.replace('_', ' ')}</option>)}
              </select>
            </div>
            <div>
              <label className="label">Severity</label>
              <select value={open.severity || ''} disabled={locked} onChange={(e) => patchOpen({ severity: e.target.value || null })}>
                <option value="">—</option>
                {SEVERITIES.map((s) => <option key={s} value={s}>{s}</option>)}
              </select>
            </div>
            <div>
              <label className="label">Deposit applied</label>
              <input type="number" step="0.01" defaultValue={open.depositApplied ?? ''} disabled={locked}
                onBlur={(e) => patchOpen({ depositApplied: e.target.value === '' ? null : Number(e.target.value) })} />
            </div>
          </div>
          <div style={{ marginBottom: 12 }}>
            <label className="label">Title / banner</label>
            <input type="text" defaultValue={open.title || ''} disabled={locked} onBlur={(e) => patchOpen({ title: e.target.value })} />
          </div>
          <div style={{ marginBottom: 12 }}>
            <label className="label">Evidence narrative (§3)</label>
            <textarea rows={2} defaultValue={open.narrative || ''} disabled={locked} style={{ width: '100%', resize: 'vertical' }}
              onBlur={(e) => patchOpen({ narrative: e.target.value })} />
          </div>
          <div style={{ marginBottom: 12 }}>
            <label className="label">Pre-rental condition (§2)</label>
            <textarea rows={2} defaultValue={open.preRentalCondition || ''} disabled={locked} style={{ width: '100%', resize: 'vertical' }}
              placeholder="Documented condition at check-out (inspection notes or staff entry). Leave blank if not on record — do not assert facts that aren't documented."
              onBlur={(e) => patchOpen({ preRentalCondition: e.target.value })} />
          </div>
          <div style={{ marginBottom: 12 }}>
            <label className="label">Chargeback rebuttal (§7) <span className="ui-muted" style={{ fontWeight: 400 }}>— one point per line; overrides the auto-generated points</span></label>
            <textarea rows={3} defaultValue={open.rebuttalText || ''} disabled={locked} style={{ width: '100%', resize: 'vertical' }}
              placeholder="Leave blank to auto-generate neutral, evidence-backed points."
              onBlur={(e) => patchOpen({ rebuttalText: e.target.value })} />
          </div>

          {/* Evidence */}
          <div style={{ border: '1px solid rgba(0,0,0,0.08)', borderRadius: 12, padding: '12px 14px', marginBottom: 12 }}>
            <div className="row-between" style={{ alignItems: 'center', marginBottom: 8 }}>
              <strong style={{ fontSize: 14 }}>Evidence &amp; violation documentation (§4)</strong>
              {!locked && (
                <div style={{ display: 'flex', gap: 8 }}>
                  <label className="btn ghost" style={{ fontSize: 13, cursor: 'pointer' }}>
                    Add photo
                    <input type="file" accept="image/*" style={{ display: 'none' }} onChange={(e) => addPhotoEvidence(e.target.files?.[0])} />
                  </label>
                  <button className="btn ghost" style={{ fontSize: 13 }} onClick={() => pullInspection('CHECKIN')} disabled={busy}>Pull check-in</button>
                  <button className="btn ghost" style={{ fontSize: 13 }} onClick={() => pullInspection('CHECKOUT')} disabled={busy}>Pull check-out</button>
                </div>
              )}
            </div>
            {(open.evidence || []).length === 0 && <p className="ui-muted" style={{ fontSize: 12, margin: 0 }}>No evidence yet.</p>}
            {(open.evidence || []).map((ev) => (
              <div key={ev.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 0', borderTop: '1px solid rgba(0,0,0,0.05)', fontSize: 13 }}>
                <span style={{ width: 22, color: '#888' }}>{ev.ordinal}</span>
                {locked ? (
                  <>
                    <span style={{ flex: 1, minWidth: 0 }}><strong>{ev.location}</strong>{ev.description ? ` — ${ev.description}` : ''}</span>
                    <span style={{ fontSize: 11, color: ev.evidenceStatus === 'VIOLATION' ? '#A32D2D' : '#0F6E56' }}>{ev.evidenceStatus}</span>
                    <span style={{ fontSize: 11, color: '#999' }}>{ev.sourcePhase}</span>
                  </>
                ) : (
                  <>
                    <input type="text" defaultValue={ev.location} placeholder="Location" style={{ flex: '1 1 110px', minWidth: 0, fontSize: 12 }}
                      onBlur={(e) => { if (e.target.value !== ev.location) saveEvidence(ev.id, { location: e.target.value }); }} />
                    <input type="text" defaultValue={ev.description || ''} placeholder="Description" style={{ flex: '2 1 150px', minWidth: 0, fontSize: 12 }}
                      onBlur={(e) => { if (e.target.value !== (ev.description || '')) saveEvidence(ev.id, { description: e.target.value }); }} />
                    <select value={ev.evidenceStatus} style={{ fontSize: 11 }} onChange={(e) => saveEvidence(ev.id, { evidenceStatus: e.target.value })}>
                      <option value="VIOLATION">VIOLATION</option>
                      <option value="CONFIRMED">CONFIRMED</option>
                    </select>
                    <button className="btn ghost" style={{ fontSize: 12, padding: '2px 8px' }} onClick={() => removeEvidence(ev.id)}>✕</button>
                  </>
                )}
              </div>
            ))}
          </div>

          {/* Clauses */}
          <div style={{ border: '1px solid rgba(0,0,0,0.08)', borderRadius: 12, padding: '12px 14px', marginBottom: 12 }}>
            <strong style={{ fontSize: 14 }}>Cited clauses (§5)</strong>
            {clauses.length === 0 && <p className="ui-muted" style={{ fontSize: 12, marginTop: 6 }}>No clauses in the library yet — seed defaults in Settings → Agreement clauses.</p>}
            <div style={{ marginTop: 8 }}>
              {clauses.map((c) => (
                <label key={c.id} style={{ display: 'flex', gap: 8, alignItems: 'flex-start', fontSize: 13, marginBottom: 6, opacity: locked ? 0.7 : 1 }}>
                  <input type="checkbox" disabled={locked} checked={selectedClauseIds.has(c.id)} onChange={(e) => toggleClause(c.id, e.target.checked)} style={{ marginTop: 3 }} />
                  <span><strong>§{c.section} {c.label}</strong>{c.amountRange ? ` — ${c.amountRange}` : ''}<br /><span className="ui-muted" style={{ fontSize: 12 }}>{c.text}</span></span>
                </label>
              ))}
            </div>
          </div>

          {/* Charges to include (§6) */}
          {agCharges.length > 0 && (
            <div style={{ border: '1px solid rgba(0,0,0,0.08)', borderRadius: 12, padding: '12px 14px', marginBottom: 12 }}>
              <strong style={{ fontSize: 14 }}>Charges to include (§6)</strong>
              <p className="ui-muted" style={{ fontSize: 12, marginTop: 4, marginBottom: 8 }}>
                {open.chargeIds && open.chargeIds.length
                  ? 'Showing this report’s selected charges.'
                  : 'No explicit selection — using all selected agreement charges. Tick boxes to pick specific ones.'}
              </p>
              <div style={{ fontSize: 12, lineHeight: 1.5, color: '#0C447C', background: '#EAF2FB', border: '1px solid rgba(12,68,124,.22)', borderRadius: 8, padding: '8px 10px', marginBottom: 8 }}>
                These charges are <strong>already on the contract</strong>. Ticking them here only <strong>documents</strong> them on this report — it does <strong>not</strong> bill the customer again.
              </div>
              {agCharges.map((c) => {
                const checked = (open.chargeIds && open.chargeIds.length)
                  ? open.chargeIds.map(String).includes(String(c.id))
                  : c.selected !== false;
                return (
                  <label key={c.id} style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13, marginBottom: 5, opacity: locked ? 0.7 : 1 }}>
                    <input type="checkbox" disabled={locked} checked={checked} onChange={(e) => toggleCharge(c.id, e.target.checked)} />
                    <span style={{ flex: 1 }}>{c.name}</span>
                    <span style={{ fontVariantNumeric: 'tabular-nums' }}>{fmtMoney(c.total)}</span>
                  </label>
                );
              })}
            </div>
          )}

          {/* Certification */}
          {!locked ? (
            <div style={{ background: 'rgba(0,0,0,0.03)', border: '1px solid rgba(0,0,0,0.1)', borderRadius: 12, padding: '12px 14px' }}>
              <strong style={{ fontSize: 14 }}>Declaration &amp; certification (§9)</strong>
              <span className="ui-muted" style={{ fontSize: 12, marginLeft: 8 }}>🔒 locks on issue</span>
              <div className="app-card-grid compact" style={{ marginTop: 10, marginBottom: 10 }}>
                <div><label className="label">Certified by</label><input type="text" value={certName} onChange={(e) => setCertName(e.target.value)} /></div>
                <div><label className="label">Title</label><input type="text" value={certTitle} onChange={(e) => setCertTitle(e.target.value)} /></div>
                <div><label className="label">Signature</label><SignaturePad onChange={setSig} /></div>
              </div>
              <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                <button className="btn" type="button" onClick={certify} disabled={busy} style={{ border: '2px solid #185FA5', color: '#0C447C' }}>Certify &amp; issue</button>
              </div>
            </div>
          ) : (
            <div style={{ background: 'rgba(0,0,0,0.03)', border: '1px solid rgba(0,0,0,0.1)', borderRadius: 12, padding: '12px 14px', fontSize: 13 }}>
              Certified by <strong>{open.certifiedByName}</strong>{open.certifiedByTitle ? ` — ${open.certifiedByTitle}` : ''} · {fmtDate(open.issuedAt)}
            </div>
          )}
        </div>
      )}
    </section>
  );
}
