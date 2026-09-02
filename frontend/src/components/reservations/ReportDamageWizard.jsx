'use client';

/**
 * ReportDamageWizard — Feature 3 (2026-07-10). A guided modal launched from a
 * reservation that ORCHESTRATES three existing modules via one endpoint:
 *   POST /api/report-damage/:reservationId/report-damage
 * It records a HARD_APPROVED vehicle damage, puts the correct charge on the
 * contract (who-pays), sets the vehicle status, and auto-creates an incident
 * DRAFT the agent must complete. No money moves client-side.
 *
 * Props:
 *   reservation — the reservation row (id, reservationNumber, vehicle, customer)
 *   token       — auth token
 *   onClose()   — dismiss the modal
 *   onDone(result) — called after a successful submit with the API result
 *                    ({ damageReportId, chargeId, chargeAmount, incidentId, vehicleStatus })
 *   onComplete(result) — called ONLY when the agent clicks "Complete now" on the
 *                    confirmation (opens the incident DRAFT). "Later" just closes.
 *   prefill     — OPTIONAL (2026-09-06, check-in audit handoff): initial values
 *                 from an audit finding's evidence — { view, xPct, yPct,
 *                 description, damagePhotos: [dataUrl…], sourceAuditFindingId,
 *                 angle?, confidence? }. Everything stays editable; the money
 *                 fields (estimate, who-pays) are NEVER prefilled — the agent
 *                 enters them. sourceAuditFindingId rides on the submit so the
 *                 backend resolves the finding as CONVERTED_TO_REPORT.
 */

import { useEffect, useRef, useState } from 'react';
import { api } from '../../lib/client';
import { SignaturePad } from '../wizard/SignaturePad';
import { diagramFor, DIAGRAM_VIEWBOX, DIAGRAM_W, DIAGRAM_H, VIEW_LABELS } from '../vehicleDiagrams';

const VIEWS = ['LEFT', 'RIGHT', 'FRONT', 'REAR', 'INTERIOR'];
const PARTIES = [
  { key: 'CUSTOMER', title: 'Customer', desc: 'Customer pays out of pocket.' },
  { key: 'CUSTOMER_INSURANCE', title: "Customer's insurance", desc: "Billed to the renter's carrier." },
  { key: 'OUR_INSURANCE', title: 'Our insurance', desc: 'We claim it; renter owes the deductible.' },
];
// Hector's decision: the dropdown offers ALL VehicleStatus values, default IN_MAINTENANCE.
const STATUSES = [
  { v: 'AVAILABLE', label: 'Available (AVAILABLE)' },
  { v: 'IN_MAINTENANCE', label: 'In maintenance (IN_MAINTENANCE)' },
  { v: 'OUT_OF_SERVICE', label: 'Out of service (OUT_OF_SERVICE)' },
  { v: 'RESERVED', label: 'Reserved (RESERVED)' },
  { v: 'ON_RENT', label: 'On rent (ON_RENT)' },
  { v: 'SOLD', label: 'Sold (SOLD)' },
];

function diagramTypeFor(vehicle) {
  const s = `${vehicle?.vehicleType?.name || ''} ${vehicle?.vehicleType?.code || ''}`.toLowerCase();
  if (/suv|crossover/.test(s)) return 'suv';
  if (/van|minivan/.test(s)) return 'van';
  if (/pickup|truck/.test(s)) return 'pickup';
  return 'sedan';
}
function money(n) { return `$${Number(n || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`; }
function parseAmount(s) { const n = Number(String(s).replace(/[^0-9.]/g, '')); return Number.isFinite(n) ? n : 0; }
function newIdempotencyKey() {
  try { if (typeof crypto !== 'undefined' && crypto.randomUUID) return `rd-${crypto.randomUUID()}`; } catch { /* noop */ }
  return `rd-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export function ReportDamageWizard({ reservation, token, onClose, onDone, onComplete, prefill = null }) {
  const vehicle = reservation?.vehicle || {};
  const customer = reservation?.customer || {};
  // vehicleType may live on the vehicle or at the reservation level.
  const diagramType = diagramTypeFor(vehicle?.vehicleType ? vehicle : { vehicleType: reservation?.vehicleType });

  // Audit-handoff prefill (checkin-audit Mock 2): view + region-center dot +
  // description + the checkout/check-in photo pair arrive already loaded; the
  // agent verifies and can change any of it before submitting.
  const prefillView = prefill?.view && ['LEFT', 'RIGHT', 'FRONT', 'REAR', 'INTERIOR'].includes(prefill.view) ? prefill.view : null;
  const prefillMark = prefillView && Number.isFinite(Number(prefill?.xPct)) && Number.isFinite(Number(prefill?.yPct))
    ? { xPct: Number(prefill.xPct), yPct: Number(prefill.yPct), view: prefillView }
    : null;

  const [view, setView] = useState(prefillView || 'FRONT');
  const [mark, setMark] = useState(prefillMark);     // { xPct, yPct, view }
  const [description, setDescription] = useState(prefill?.description || '');
  const [photos, setPhotos] = useState(() => (Array.isArray(prefill?.damagePhotos) ? prefill.damagePhotos.filter(Boolean) : []));          // data URLs
  const [estimate, setEstimate] = useState(null);    // data URL
  const [estimateName, setEstimateName] = useState('');
  const [party, setParty] = useState('CUSTOMER');
  const [costInput, setCostInput] = useState('');    // dollars (Customer / Customer insurance)
  const [deductibleInput, setDeductibleInput] = useState(''); // dollars (Our insurance — the ONLY thing billed)
  const [fullEstimateInput, setFullEstimateInput] = useState(''); // dollars (Our insurance — full repair, filed on our policy, NOT billed)
  const [vehicleStatus, setVehicleStatus] = useState('IN_MAINTENANCE');
  // Customer acknowledgement (2026-07-25) — OPTIONAL. When the customer is
  // present and accepts responsibility, the agent flips the toggle, the
  // customer reads the branch's statement and signs on this device. The
  // statement TEXT comes from the backend (branch override or canonical) so
  // what is displayed is exactly what gets snapshotted with the signature.
  const [ackEnabled, setAckEnabled] = useState(false);
  const [ackStatement, setAckStatement] = useState(null); // { label, body }
  const [ackSignature, setAckSignature] = useState('');
  const [ackSignerName, setAckSignerName] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState(null);
  // FIX E (idempotency): a stable key so a double-click / retry of the SAME submit
  // replays the first response instead of billing twice. Rotated after a failure so
  // a corrected resubmit is treated as a fresh request (never a 422 payload clash).
  const idempotencyKeyRef = useRef(newIdempotencyKey());

  const photoRef = useRef(null);
  const estimateRef = useRef(null);

  const isOurInsurance = party === 'OUR_INSURANCE';
  const chargeDollars = isOurInsurance ? parseAmount(deductibleInput) : parseAmount(costInput);
  const fullEstimateDollars = parseAmount(fullEstimateInput); // OUR_INSURANCE full repair
  // With the acknowledgement toggled ON: signature + name + THE STATEMENT
  // ITSELF are required to submit (QA M2 — the customer must never sign
  // wording that failed to load; the backend snapshots what was displayed).
  const [ackStatementFailed, setAckStatementFailed] = useState(false);
  const ackReady = !ackEnabled || (ackSignature && ackSignerName.trim() && ackStatement?.body);
  const canSubmit = photos.length >= 1 && mark && chargeDollars > 0 && ackReady && !submitting;

  // Fetch the branch-resolved statement the first time the toggle turns on.
  useEffect(() => {
    if (!ackEnabled || ackStatement || ackStatementFailed || !reservation?.id) return;
    api(`/api/report-damage/${reservation.id}/acknowledgement-statement`, {}, token)
      .then((out) => {
        if (out?.body) setAckStatement(out);
        else setAckStatementFailed(true);
      })
      .catch(() => setAckStatementFailed(true));
  }, [ackEnabled, ackStatement, ackStatementFailed, reservation?.id, token]);

  function onDiagramClick(e) {
    const r = e.currentTarget.getBoundingClientRect();
    const xPct = Math.max(0, Math.min(100, ((e.clientX - r.left) / r.width) * 100));
    const yPct = Math.max(0, Math.min(100, ((e.clientY - r.top) / r.height) * 100));
    setMark({ xPct: Number(xPct.toFixed(2)), yPct: Number(yPct.toFixed(2)), view });
  }
  function addPhotos(fileList) {
    const files = Array.from(fileList || []);
    files.forEach((file) => {
      const reader = new FileReader();
      reader.onload = () => setPhotos((p) => [...p, reader.result]);
      reader.readAsDataURL(file);
    });
  }
  function onEstimate(file) {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => { setEstimate(reader.result); setEstimateName(file.name); };
    reader.readAsDataURL(file);
  }

  async function submit() {
    if (!canSubmit) return;
    setSubmitting(true); setError('');
    try {
      const body = {
        view: mark.view,
        xPct: mark.xPct,
        yPct: mark.yPct,
        description: description || null,
        damagePhotos: photos,
        estimatePhoto: estimate || null,
        responsibleParty: party,
        vehicleStatus,
      };
      if (isOurInsurance) {
        // OUR_INSURANCE bills ONLY the deductible, but we still record the FULL
        // repair (filed on our policy) on the damage report so the numbers reconcile.
        body.ourDeductibleCents = Math.round(chargeDollars * 100);
        if (fullEstimateDollars > 0) body.damageCostCents = Math.round(fullEstimateDollars * 100);
      } else {
        body.damageCostCents = Math.round(chargeDollars * 100);
      }
      if (ackEnabled && ackSignature && ackSignerName.trim()) {
        body.customerAck = { signatureDataUrl: ackSignature, signerName: ackSignerName.trim() };
      }
      // Audit handoff: the backend validates the finding (same tenant, same
      // reservation, DAMAGE) and resolves it CONVERTED_TO_REPORT after the
      // money commits.
      if (prefill?.sourceAuditFindingId) body.sourceAuditFindingId = prefill.sourceAuditFindingId;

      const out = await api(`/api/report-damage/${reservation.id}/report-damage`, {
        method: 'POST', body: JSON.stringify(body),
        headers: { 'Idempotency-Key': idempotencyKeyRef.current },
      }, token);
      setResult(out);
      if (onDone) onDone(out);
    } catch (e) {
      // Rotate the idempotency key so a corrected resubmit is a fresh request.
      idempotencyKeyRef.current = newIdempotencyKey();
      setError(e?.message || 'Failed to record damage');
    } finally {
      setSubmitting(false);
    }
  }

  const custName = [customer.firstName, customer.lastName].filter(Boolean).join(' ') || customer.email || 'Guest';
  const vehLabel = [vehicle.year, vehicle.make, vehicle.model].filter(Boolean).join(' ') || 'Vehicle';

  return (
    <div className="modal-backdrop" onClick={() => { if (!submitting) onClose?.(); }} style={{ position: 'fixed', inset: 0, zIndex: 60, background: 'rgba(15,23,42,0.32)', display: 'grid', placeItems: 'start center', overflowY: 'auto', padding: 18 }}>
      <section className="glass" onClick={(e) => e.stopPropagation()} style={{ width: 'min(680px, 100%)', borderRadius: 18, overflow: 'hidden', marginTop: 24, marginBottom: 40 }}>
        {/* head */}
        <div style={{ padding: '16px 20px', borderBottom: '1px solid var(--border-soft, #e6dfff)', background: 'linear-gradient(180deg,#fff,#faf7ff)', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}>
          <div>
            <div style={{ color: '#6d3df2', fontSize: 11, fontWeight: 800, letterSpacing: '.08em', textTransform: 'uppercase' }}>Report Damage</div>
            <div style={{ fontWeight: 800, fontSize: 16, color: '#211a38' }}>
              {result ? 'Damage recorded ✓' : `Reservation ${reservation?.reservationNumber || ''}`}
            </div>
          </div>
          <button type="button" onClick={() => onClose?.()} disabled={submitting} style={{ background: 'transparent', border: 'none', color: '#9a90b8', fontSize: 20, fontWeight: 700, cursor: 'pointer' }}>✕</button>
        </div>

        <div style={{ padding: '18px 20px', display: 'grid', gap: 14 }}>
          {result ? (
            <ResultView result={result} vehicle={vehicle} ackSent={ackEnabled} onClose={onClose} onComplete={() => { onComplete?.(result); onClose?.(); }} />
          ) : (
            <>
              {/* summary */}
              <div>
                <div className="row-between" style={{ marginBottom: 8 }}>
                  <strong style={{ fontSize: 14 }}>Reservation summary</strong>
                  <span className="pill gray" style={{ background: '#e5e7eb', color: '#374151', padding: '2px 8px', borderRadius: 999, fontSize: 12, fontWeight: 700 }}>Auto-filled · read-only</span>
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px,1fr))', gap: 12 }}>
                  <InfoTile label="Customer" strong={custName} sub={customer.licenseNumber ? `DL ${customer.licenseState || ''} · ${customer.licenseNumber}` : (customer.email || '')} />
                  <InfoTile label="Vehicle" strong={vehLabel} sub={vehicle.plate ? `Plate ${vehicle.plate}` : (vehicle.internalNumber || '')} />
                  <InfoTile label="Reservation #" strong={reservation?.reservationNumber || '—'} sub="" />
                </div>
              </div>

              {/* audit-handoff evidence banner */}
              {prefill?.sourceAuditFindingId ? (
                <div data-testid="audit-prefill-note" style={{ borderRadius: 12, padding: '11px 13px', fontSize: 12.5, fontWeight: 600, background: 'rgba(135,82,254,.08)', border: '1px solid rgba(135,82,254,.28)', color: '#2d244d' }}>
                  🔎 Evidence loaded from the check-in audit{prefill?.angle ? ` (${prefill.angle}${prefill?.confidence != null ? ` · ${prefill.confidence}%` : ''})` : ''} —
                  photos, view and description are pre-filled and editable. <b>Verify on the vehicle before charging</b>; the estimate and who-pays are yours to enter.
                </div>
              ) : null}

              {/* damage capture */}
              <Divider />
              <div>
                <div className="row-between" style={{ marginBottom: 8 }}>
                  <strong style={{ fontSize: 14 }}>1 · Where is the damage?</strong>
                  <span className="ui-muted" style={{ fontSize: 12 }}>Tap the diagram to drop a marker</span>
                </div>
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 10 }}>
                  {VIEWS.map((v) => (
                    <button key={v} type="button" onClick={() => setView(v)} style={{
                      padding: '6px 12px', borderRadius: 999, border: '1px solid var(--border-soft,#e6dfff)', fontWeight: 700, fontSize: 12, cursor: 'pointer',
                      background: v === view ? 'rgba(135,82,254,.13)' : 'rgba(255,255,255,.7)', color: v === view ? '#2d244d' : '#56526b',
                    }}>{VIEW_LABELS[v]}</button>
                  ))}
                </div>
                <svg viewBox={DIAGRAM_VIEWBOX} onClick={onDiagramClick} style={{ width: '100%', background: '#F6F4FE', borderRadius: 14, cursor: 'crosshair', border: '1px solid var(--border-soft,#e6dfff)' }} xmlns="http://www.w3.org/2000/svg">
                  <g dangerouslySetInnerHTML={{ __html: diagramFor(diagramType, view) }} />
                  {mark && mark.view === view ? (
                    <g>
                      <circle cx={(mark.xPct / 100) * DIAGRAM_W} cy={(mark.yPct / 100) * DIAGRAM_H} r="10" fill="#ef4444" stroke="#fff" strokeWidth="2.5" />
                      <text x={(mark.xPct / 100) * DIAGRAM_W} y={(mark.yPct / 100) * DIAGRAM_H + 3.5} textAnchor="middle" fill="#fff" fontSize="11" fontWeight="700">1</text>
                    </g>
                  ) : null}
                </svg>

                <label style={{ display: 'grid', gap: 5, marginTop: 12 }}>
                  <span className="label">Description</span>
                  <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={3}
                    placeholder="e.g. Deep scrape across the front bumper, driver side. Not present at check-out."
                    style={{ width: '100%', borderRadius: 12, border: '1px solid var(--border-soft,#e6dfff)', padding: '9px 12px', font: 'inherit' }} />
                </label>

                <div style={{ marginTop: 12 }}>
                  <div className="row-between" style={{ marginBottom: 6 }}>
                    <span className="label">Photos <span style={{ color: '#b45309', fontWeight: 800, fontSize: 11 }}>· at least 1 required</span></span>
                    <span style={{ background: photos.length ? '#dcfce7' : '#fee2e2', color: photos.length ? '#166534' : '#991b1b', padding: '2px 8px', borderRadius: 999, fontSize: 12, fontWeight: 700 }}>
                      {photos.length} attached
                    </span>
                  </div>
                  <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                    {photos.map((p, i) => (
                      <div key={i} style={{ width: 88, height: 88, borderRadius: 12, border: '1px solid var(--border-soft,#e6dfff)', position: 'relative', overflow: 'hidden' }}>
                        <img src={p} alt={`damage ${i + 1}`} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                        <button type="button" onClick={() => setPhotos((arr) => arr.filter((_, j) => j !== i))} style={{ position: 'absolute', top: 3, right: 3, width: 18, height: 18, borderRadius: 999, background: 'rgba(0,0,0,.55)', color: '#fff', border: 'none', fontSize: 11, cursor: 'pointer', lineHeight: 1 }}>✕</button>
                      </div>
                    ))}
                    <button type="button" onClick={() => photoRef.current?.click()} style={{ width: 88, height: 88, borderRadius: 12, border: '2px dashed var(--border-strong,#d7cbff)', background: 'rgba(135,82,254,.04)', color: '#6d3df2', fontSize: 12, fontWeight: 700, cursor: 'pointer' }}>＋<br />Add photo</button>
                  </div>
                  <input ref={photoRef} type="file" accept="image/*" capture="environment" multiple style={{ display: 'none' }}
                    onChange={(e) => { addPhotos(e.target.files); e.target.value = ''; }} />
                </div>
              </div>

              {/* estimate */}
              <Divider />
              <div>
                <strong style={{ fontSize: 14 }}>2 · Damage estimate <span className="ui-muted" style={{ fontWeight: 500 }}>(optional)</span></strong>
                <div onClick={() => estimateRef.current?.click()} style={{ marginTop: 10, border: '2px dashed var(--border-strong,#d7cbff)', borderRadius: 14, padding: 16, textAlign: 'center', background: 'rgba(135,82,254,.03)', color: '#6d3df2', cursor: 'pointer' }}>
                  ⬆ Upload a photo or PDF of the repair estimate
                  {estimateName ? (
                    <div style={{ marginTop: 8 }}>
                      <span style={{ display: 'inline-flex', gap: 8, alignItems: 'center', background: '#fff', border: '1px solid var(--border-soft,#e6dfff)', borderRadius: 10, padding: '6px 10px', color: '#433b63', fontWeight: 600, fontSize: 12.5 }}>
                        📄 {estimateName}
                        <span onClick={(e) => { e.stopPropagation(); setEstimate(null); setEstimateName(''); }} style={{ color: '#b91c1c', fontWeight: 700, cursor: 'pointer' }}>✕</span>
                      </span>
                    </div>
                  ) : null}
                </div>
                <input ref={estimateRef} type="file" accept="image/*,application/pdf" style={{ display: 'none' }}
                  onChange={(e) => { onEstimate(e.target.files?.[0]); e.target.value = ''; }} />
              </div>

              {/* who pays */}
              <Divider />
              <div>
                <div className="row-between" style={{ marginBottom: 10 }}>
                  <strong style={{ fontSize: 14 }}>3 · Who pays?</strong>
                  <span className="ui-muted" style={{ fontSize: 12 }}>Drives what gets added to the contract</span>
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 10 }}>
                  {PARTIES.map((p) => (
                    <button key={p.key} type="button" onClick={() => setParty(p.key)} style={{
                      textAlign: 'left', border: `1.5px solid ${party === p.key ? '#8752FE' : 'var(--border-soft,#e6dfff)'}`,
                      boxShadow: party === p.key ? '0 0 0 3px rgba(135,82,254,.2)' : 'none', background: party === p.key ? 'rgba(135,82,254,.04)' : '#fff',
                      borderRadius: 14, padding: 12, cursor: 'pointer', display: 'grid', gap: 6,
                    }}>
                      <span style={{ fontWeight: 800, color: '#2d244d', fontSize: 13.5 }}>{p.title}</span>
                      <span style={{ fontSize: 11.5, color: 'var(--ios-muted,#6f668f)', lineHeight: 1.4 }}>{p.desc}</span>
                    </button>
                  ))}
                </div>

                <div style={{ marginTop: 12, display: 'grid', gap: 8 }}>
                  {isOurInsurance ? (
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                      <label style={{ display: 'grid', gap: 5 }}>
                        <span className="label">Full repair estimate $</span>
                        <input inputMode="decimal" value={fullEstimateInput}
                          onChange={(e) => setFullEstimateInput(e.target.value)}
                          placeholder="e.g. 3,000.00"
                          style={{ width: '100%', borderRadius: 12, border: '1px solid var(--border-soft,#e6dfff)', padding: '9px 12px', font: 'inherit' }} />
                        <span className="ui-muted" style={{ fontSize: 11 }}>Filed on our policy — not billed to the renter</span>
                      </label>
                      <label style={{ display: 'grid', gap: 5 }}>
                        <span className="label">Our deductible $</span>
                        <input inputMode="decimal" value={deductibleInput}
                          onChange={(e) => setDeductibleInput(e.target.value)}
                          placeholder="e.g. 500.00"
                          style={{ width: '100%', borderRadius: 12, border: '1px solid var(--border-soft,#e6dfff)', padding: '9px 12px', font: 'inherit' }} />
                        <span className="ui-muted" style={{ fontSize: 11 }}>The only amount added to the contract</span>
                      </label>
                    </div>
                  ) : (
                    <label style={{ display: 'grid', gap: 5 }}>
                      <span className="label">Damage cost $</span>
                      <input inputMode="decimal" value={costInput}
                        onChange={(e) => setCostInput(e.target.value)}
                        placeholder="e.g. 1,250.00"
                        style={{ width: '100%', borderRadius: 12, border: '1px solid var(--border-soft,#e6dfff)', padding: '9px 12px', font: 'inherit' }} />
                    </label>
                  )}
                  {/* Suppress the "$0.00 added" line until a real amount is entered. */}
                  {chargeDollars > 0 ? (
                    <div style={{ borderRadius: 12, padding: '11px 13px', fontSize: 12.5, fontWeight: 600, background: 'rgba(245,158,11,.10)', border: '1px solid rgba(245,158,11,.28)', color: '#92400e' }}>
                      ➕ {isOurInsurance
                        ? <span><b>{money(chargeDollars)}</b> added to the contract{fullEstimateDollars > 0 ? <> · full <b>{money(fullEstimateDollars)}</b> repair filed on our policy (not billed to the renter)</> : <> — deductible only; the full repair is filed on our policy, not billed to the renter</>}.</span>
                        : <span><b>{money(chargeDollars)}</b> added to the contract (charged to the customer).</span>}
                    </div>
                  ) : (
                    <div style={{ borderRadius: 12, padding: '11px 13px', fontSize: 12.5, fontWeight: 500, background: 'rgba(0,0,0,.03)', border: '1px solid var(--border-soft,#e6dfff)', color: 'var(--ios-muted,#6f668f)' }}>
                      Enter {isOurInsurance ? 'the deductible' : 'a cost'} to see what will be added to the contract.
                    </div>
                  )}
                </div>
              </div>

              {/* vehicle status */}
              <Divider />
              <div>
                <strong style={{ fontSize: 14 }}>4 · Vehicle will be set to…</strong>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14, marginTop: 10, alignItems: 'end' }}>
                  <label style={{ display: 'grid', gap: 5 }}>
                    <span className="label">Vehicle status after</span>
                    <select value={vehicleStatus} onChange={(e) => setVehicleStatus(e.target.value)}
                      style={{ width: '100%', borderRadius: 12, border: '1px solid var(--border-soft,#e6dfff)', padding: '9px 12px', font: 'inherit', background: '#fff' }}>
                      {STATUSES.map((s) => <option key={s.v} value={s.v}>{s.label}</option>)}
                    </select>
                  </label>
                  <div className="surface-note" style={{ fontSize: 12.5 }}>Default <b>In maintenance</b> pulls the car out of availability until the repair is booked.</div>
                </div>
              </div>

              {/* customer acknowledgement (optional) */}
              <Divider />
              <div>
                <div className="row-between" style={{ marginBottom: 8 }}>
                  <strong style={{ fontSize: 14 }}>5 · Customer acknowledgement <span className="ui-muted" style={{ fontWeight: 500 }}>(optional)</span></strong>
                  <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
                    <input
                      type="checkbox"
                      checked={ackEnabled}
                      onChange={(e) => {
                        setAckEnabled(e.target.checked);
                        if (!e.target.checked) setAckSignature('');
                        // Prefill only a real NAME — never the email fallback.
                        else if (!ackSignerName && (customer.firstName || customer.lastName)) setAckSignerName(custName);
                      }} />
                    <span style={{ fontSize: 12.5, fontWeight: 700, color: '#2d244d' }}>Customer is present and acknowledges</span>
                  </label>
                </div>
                {ackEnabled ? (
                  <div style={{ display: 'grid', gap: 10 }}>
                    {ackStatementFailed ? (
                      <div style={{ borderRadius: 12, padding: '12px 14px', fontSize: 12.5, background: '#fee2e2', border: '1px solid #fca5a5', color: '#991b1b', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10 }}>
                        <span>The acknowledgement statement could not be loaded — the customer cannot sign without reading it.</span>
                        <button type="button" onClick={() => setAckStatementFailed(false)} style={{ background: '#fff', border: '1px solid #fca5a5', color: '#991b1b', borderRadius: 8, padding: '5px 10px', fontWeight: 700, cursor: 'pointer' }}>Retry</button>
                      </div>
                    ) : (
                      <div style={{ borderRadius: 12, padding: '12px 14px', fontSize: 12.5, lineHeight: 1.55, background: 'rgba(0,0,0,.03)', border: '1px solid var(--border-soft,#e6dfff)', color: '#33415c' }}>
                        {ackStatement?.body || 'Loading the acknowledgement statement…'}
                      </div>
                    )}
                    <SignaturePad
                      label="Customer signature"
                      signerName={ackSignerName}
                      onSignerNameChange={setAckSignerName}
                      onSignatureChange={setAckSignature}
                      helperText="The customer signs above after reading the statement. This signature appears on the incident report."
                    />
                    {!ackReady ? (
                      <div style={{ fontSize: 12, color: '#b45309', fontWeight: 600 }}>
                        Signature and printed name are required to submit with the acknowledgement — or untick it to submit without one.
                      </div>
                    ) : null}
                  </div>
                ) : (
                  <div className="ui-muted" style={{ fontSize: 12.5 }}>
                    If the customer is present and accepts responsibility, capture their signed acknowledgement here — it carries to the incident report.
                  </div>
                )}
              </div>

              {error && <div style={{ color: '#b91c1c', fontSize: 13 }}>{error}</div>}
            </>
          )}
        </div>

        {/* foot */}
        {!result && (
          <div style={{ padding: '14px 20px', borderTop: '1px solid var(--border-soft,#e6dfff)', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, background: 'rgba(252,251,255,.7)' }}>
            <button type="button" onClick={() => onClose?.()} disabled={submitting} style={{ background: 'transparent', border: 'none', color: '#6d3df2', fontWeight: 700, cursor: 'pointer' }}>Cancel</button>
            <button type="button" onClick={submit} disabled={!canSubmit}
              style={{ background: canSubmit ? 'linear-gradient(180deg,#ff8a8a,#ef4444)' : '#f0a5a5', border: '1px solid #dc2626', color: '#fff', borderRadius: 12, padding: '10px 16px', fontWeight: 700, cursor: canSubmit ? 'pointer' : 'not-allowed', boxShadow: '0 8px 18px rgba(239,68,68,.28)' }}>
              {submitting ? 'Recording…' : 'Submit damage report'}
            </button>
          </div>
        )}
      </section>
    </div>
  );
}

function ResultView({ result, vehicle, ackSent, onClose, onComplete }) {
  return (
    <div style={{ display: 'grid', gap: 12 }}>
      <div style={{ display: 'grid', gap: 10 }}>
        <Consequence bg="rgba(16,185,129,.10)" border="rgba(16,185,129,.28)" color="#047857">
          ✓ <span><b>Damage recorded on the vehicle</b> — a permanent record at <b>HARD_APPROVED</b> on the vehicle profile.</span>
        </Consequence>
        {result.chargeId ? (
          <Consequence bg="rgba(245,158,11,.10)" border="rgba(245,158,11,.28)" color="#92400e">
            ➕ <span>
              <b>{money(result.chargeAmount)} added to the contract</b> — charge <code>DAMAGE_CHARGE</code>.
              {result.responsibleParty === 'OUR_INSURANCE' && result.damageCostCents ? (
                <><br /><span style={{ fontWeight: 500 }}>Full <b>{money(result.damageCostCents / 100)}</b> repair filed on our policy — only the <b>{money(result.chargeAmount)}</b> deductible is billed to the renter.</span></>
              ) : null}
            </span>
          </Consequence>
        ) : null}
        <Consequence bg="rgba(245,158,11,.10)" border="rgba(245,158,11,.28)" color="#92400e">
          🔧 <span><b>Vehicle set to {result.vehicleStatus}</b>{vehicle?.plate ? ` — ${vehicle.plate}` : ''}.</span>
        </Consequence>
        {result.customerAckSaved ? (
          <Consequence bg="rgba(16,185,129,.10)" border="rgba(16,185,129,.28)" color="#047857">
            ✍ <span><b>Customer acknowledgement signed</b> — it will appear on the incident report beside the staff certification.</span>
          </Consequence>
        ) : ackSent ? (
          <Consequence bg="#fee2e2" border="#fca5a5" color="#991b1b">
            ⚠ <span><b>The customer's signature was NOT saved.</b> The damage and charge are recorded, but the acknowledgement failed — capture it again from the vehicle profile or contact an admin.</span>
          </Consequence>
        ) : null}
        <div style={{ fontSize: 12, color: 'var(--ios-muted,#6f668f)', lineHeight: 1.5 }}>
          Entered by mistake? An admin can undo this and void the charge from the vehicle profile.
        </div>
      </div>

      {result.incidentId ? (
        <div style={{ border: '1.5px solid rgba(12,68,124,.35)', background: '#EAF2FB', borderRadius: 16, padding: '14px 16px' }}>
          <div className="row-between" style={{ marginBottom: 6 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ fontSize: 18 }}>🔔</span>
              <strong style={{ color: '#0C447C', fontSize: 14 }}>Incident report started as a DRAFT</strong>
            </div>
            <span style={{ background: '#E6F1FB', color: '#0C447C', padding: '2px 9px', borderRadius: 8, fontSize: 11, fontWeight: 700 }}>DRAFT</span>
          </div>
          <p style={{ color: '#274a6e', fontSize: 13, lineHeight: 1.55, margin: 0 }}>
            We pre-filled a <b>DAMAGE</b> incident report with the customer, vehicle, your photos{result.chargeId ? ' and the charge' : ''}.
            <b> You still need to complete and certify it</b> before it can be issued — no email has been sent yet.
          </p>
          <div style={{ display: 'flex', gap: 8, marginTop: 10, alignItems: 'center' }}>
            <button type="button" onClick={onComplete} style={{ background: 'linear-gradient(180deg,#3d86d6,#0C447C)', border: '1px solid #0a3a6b', color: '#fff', borderRadius: 12, padding: '9px 14px', fontWeight: 700, cursor: 'pointer' }}>Complete now →</button>
            <button type="button" onClick={() => onClose?.()} style={{ background: 'transparent', border: 'none', color: '#0C447C', fontWeight: 700, cursor: 'pointer' }}>Later</button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function InfoTile({ label, strong, sub }) {
  return (
    <div style={{ display: 'grid', gap: 4, padding: '12px 14px', borderRadius: 14, background: 'rgba(255,255,255,.72)', border: '1px solid #ece5ff' }}>
      <span className="label" style={{ textTransform: 'uppercase' }}>{label}</span>
      <strong style={{ fontSize: 15, color: '#211a38' }}>{strong}</strong>
      {sub ? <span className="ui-muted" style={{ fontSize: 12 }}>{sub}</span> : null}
    </div>
  );
}
function Divider() { return <div style={{ borderTop: '1px solid var(--border-soft,#e6dfff)' }} />; }
function Consequence({ bg, border, color, children }) {
  return <div style={{ borderRadius: 12, padding: '11px 13px', fontSize: 12.5, fontWeight: 600, display: 'flex', alignItems: 'center', gap: 8, background: bg, border: `1px solid ${border}`, color }}>{children}</div>;
}
