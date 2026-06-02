'use client';

/**
 * ReservationOverridePanel — SUPER_ADMIN-only manual status override (round 26).
 *
 * Renders at the bottom of /reservations/[id] for users with role=SUPER_ADMIN.
 * Lets the admin force a Reservation.status to any value (e.g. when an agent
 * accidentally checked-in a reservation the customer never picked up).
 *
 * Flow:
 *   1. Admin picks a target status from the dropdown.
 *   2. Hits "Preview" — UI fetches GET /api/admin/reservations/:id/override-preview
 *      and shows everything that will happen (RA delete, signing delete, vehicle
 *      flip, payments needing manual refund).
 *   3. Admin types a reason (min 5 chars), confirms double-prompt, hits "Apply".
 *   4. UI calls PATCH /api/admin/reservations/:id/status with { toStatus, reason }.
 *   5. AuditLog row written server-side (action=ADMIN_OVERRIDE).
 *
 * Props:
 *   reservation — the reservation row
 *   token       — auth token from AuthGate
 *   role        — current user role (renders nothing unless SUPER_ADMIN)
 *   onApplied   — callback (result) => void  fired after successful override
 *                 (parent should refetch reservation row)
 */

import { useState } from 'react';
import { api } from '../../lib/client';

const STATUS_OPTIONS = [
  'NEW',
  'CONFIRMED',
  'CHECKED_OUT',
  'CHECKED_IN_UNPAID',
  'CHECKED_IN',
  'CANCELLED',
  'NO_SHOW',
  'PENDING_FRANCHISE_IMPORT',
];

function fmtCents(c) {
  if (c == null) return '—';
  return `$${(c / 100).toFixed(2)}`;
}

function fmtDate(iso) {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return String(iso);
  }
}

export function ReservationOverridePanel({ reservation, token, role, onApplied }) {
  const isSuper = String(role || '').toUpperCase() === 'SUPER_ADMIN';
  const [expanded, setExpanded] = useState(false);
  const [toStatus, setToStatus] = useState('');
  const [reason, setReason] = useState('');
  const [preview, setPreview] = useState(null);
  const [previewing, setPreviewing] = useState(false);
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState(null);

  if (!isSuper || !reservation?.id) return null;

  const currentStatus = reservation.status;

  async function loadPreview() {
    if (!toStatus) {
      setError('Pick a target status first.');
      return;
    }
    setError('');
    setPreview(null);
    setResult(null);
    setPreviewing(true);
    try {
      const out = await api(
        `/api/admin/reservations/${reservation.id}/override-preview?toStatus=${encodeURIComponent(toStatus)}`,
        {},
        token
      );
      setPreview(out);
    } catch (err) {
      setError(err?.message || 'Preview failed');
    } finally {
      setPreviewing(false);
    }
  }

  async function applyOverride() {
    if (!preview) {
      setError('Load the preview first.');
      return;
    }
    if (reason.trim().length < 5) {
      setError('Reason must be at least 5 characters (audit trail).');
      return;
    }
    const confirmMsg =
      `Override Reservation ${reservation.reservationNumber}\n` +
      `  ${preview.fromStatus} → ${preview.toStatus}\n\n` +
      (preview.willDelete?.rentalAgreement ? `• Will DELETE RentalAgreement ${preview.willDelete.rentalAgreement.agreementNumber}\n` : '') +
      (preview.willDelete?.signing ? `• Will DELETE ReservationSigning\n` : '') +
      (preview.vehicleSync && !preview.vehicleSync.noop && !preview.vehicleSync.skipped
        ? `• Will flip Vehicle ${preview.vehicleSync.internalNumber || ''} ${preview.vehicleSync.from} → ${preview.vehicleSync.to}\n`
        : '') +
      (preview.paymentsForManualRefund?.length
        ? `• ${preview.paymentsForManualRefund.length} payment(s) will need MANUAL REFUND on the terminal\n`
        : '') +
      `\nProceed?`;
    if (!window.confirm(confirmMsg)) return;

    setError('');
    setApplying(true);
    try {
      const out = await api(
        `/api/admin/reservations/${reservation.id}/status`,
        {
          method: 'PATCH',
          body: JSON.stringify({ toStatus, reason: reason.trim() }),
        },
        token
      );
      setResult(out);
      setPreview(null);
      setReason('');
      setToStatus('');
      if (onApplied) onApplied(out);
    } catch (err) {
      setError(err?.message || 'Override failed');
    } finally {
      setApplying(false);
    }
  }

  return (
    <section
      className="glass card-lg section-card"
      style={{
        marginTop: 24,
        marginBottom: 24,
        borderLeft: '4px solid #b91c1c',
        background: 'linear-gradient(180deg, rgba(254,242,242,0.6), rgba(255,255,255,0.4))',
      }}
    >
      <div
        className="row-between"
        style={{ cursor: 'pointer', alignItems: 'center' }}
        onClick={() => setExpanded((v) => !v)}
      >
        <div>
          <span className="eyebrow" style={{ color: '#b91c1c' }}>SUPER_ADMIN tools</span>
          <h3 style={{ margin: '4px 0 0 0' }}>Reservation status override</h3>
          <p className="ui-muted" style={{ margin: '4px 0 0 0', fontSize: 13 }}>
            Force-change reservation status with smart rewind (vehicle sync, RA cleanup, payment refund list).
            All changes audit-logged.
          </p>
        </div>
        <button className="btn ghost" type="button">
          {expanded ? '▾ Collapse' : '▸ Expand'}
        </button>
      </div>

      {expanded && (
        <div style={{ marginTop: 20, paddingTop: 16, borderTop: '1px solid rgba(0,0,0,0.08)' }}>
          <div className="app-card-grid compact" style={{ marginBottom: 16 }}>
            <div className="info-tile">
              <span className="label">Current status</span>
              <strong>{currentStatus}</strong>
            </div>
            <div className="info-tile">
              <span className="label">Reservation</span>
              <strong>{reservation.reservationNumber}</strong>
            </div>
          </div>

          <div style={{ display: 'flex', gap: 12, alignItems: 'flex-end', flexWrap: 'wrap', marginBottom: 16 }}>
            <div style={{ flex: '1 1 220px' }}>
              <label className="label">Target status</label>
              <select
                value={toStatus}
                onChange={(e) => {
                  setToStatus(e.target.value);
                  setPreview(null);
                  setResult(null);
                  setError('');
                }}
                style={{ width: '100%', padding: '8px 12px', borderRadius: 8 }}
              >
                <option value="">— Pick a status —</option>
                {STATUS_OPTIONS.filter((s) => s !== currentStatus).map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
            </div>
            <button
              type="button"
              className="btn ghost"
              onClick={loadPreview}
              disabled={!toStatus || previewing}
            >
              {previewing ? 'Loading…' : 'Preview impact →'}
            </button>
          </div>

          {error && (
            <div className="alert error" style={{ marginBottom: 12, padding: 12, borderRadius: 8, background: '#fee2e2', color: '#991b1b' }}>
              {error}
            </div>
          )}

          {preview && (
            <div
              style={{
                background: '#fff',
                border: '1px solid rgba(0,0,0,0.08)',
                borderRadius: 12,
                padding: 16,
                marginBottom: 16,
              }}
            >
              <h4 style={{ marginTop: 0 }}>
                Impact: <code>{preview.fromStatus}</code> → <code>{preview.toStatus}</code>
                {preview.isRewind && (
                  <span style={{ marginLeft: 8, fontSize: 12, color: '#b91c1c' }}>(REWIND)</span>
                )}
              </h4>

              {preview.vehicleSync && (
                <p style={{ margin: '8px 0' }}>
                  <strong>Vehicle:</strong>{' '}
                  {preview.vehicleSync.noop && <span className="ui-muted">no change needed (already {preview.vehicleSync.status})</span>}
                  {preview.vehicleSync.skipped && (
                    <span style={{ color: '#92400e' }}>SKIPPED — {preview.vehicleSync.reason}</span>
                  )}
                  {!preview.vehicleSync.noop && !preview.vehicleSync.skipped && (
                    <>
                      {preview.vehicleSync.internalNumber} ({preview.vehicleSync.plate}) →{' '}
                      <code>{preview.vehicleSync.from}</code> →{' '}
                      <code>{preview.vehicleSync.to}</code>
                    </>
                  )}
                </p>
              )}

              {preview.willDelete?.rentalAgreement && (
                <p style={{ margin: '8px 0', color: '#b91c1c' }}>
                  <strong>RentalAgreement {preview.willDelete.rentalAgreement.agreementNumber}</strong> will be DELETED
                  (status: {preview.willDelete.rentalAgreement.status})
                </p>
              )}

              {preview.willDelete?.signing && (
                <p style={{ margin: '8px 0', color: '#b91c1c' }}>
                  <strong>ReservationSigning</strong> will be DELETED{' '}
                  ({preview.willDelete.signing.completedAt ? 'completed' : preview.willDelete.signing.refusedAt ? 'refused' : 'in-progress'})
                </p>
              )}

              {preview.willClearFields?.length > 0 && (
                <p style={{ margin: '8px 0' }}>
                  <strong>Fields cleared:</strong>{' '}
                  <code style={{ fontSize: 12 }}>{preview.willClearFields.join(', ')}</code>
                </p>
              )}

              {preview.paymentsForManualRefund?.length > 0 && (
                <div style={{ marginTop: 12 }}>
                  <p style={{ margin: '4px 0', color: '#b91c1c', fontWeight: 600 }}>
                    ⚠️ {preview.paymentsForManualRefund.length} approved payment(s) — refund manually on Dejavoo terminal:
                  </p>
                  <table style={{ width: '100%', fontSize: 13, marginTop: 8 }}>
                    <thead>
                      <tr style={{ background: '#f3f4f6' }}>
                        <th style={{ textAlign: 'left', padding: 6 }}>Type</th>
                        <th style={{ textAlign: 'right', padding: 6 }}>Amount</th>
                        <th style={{ textAlign: 'left', padding: 6 }}>Card</th>
                        <th style={{ textAlign: 'left', padding: 6 }}>Auth</th>
                        <th style={{ textAlign: 'left', padding: 6 }}>RefId</th>
                        <th style={{ textAlign: 'left', padding: 6 }}>When</th>
                      </tr>
                    </thead>
                    <tbody>
                      {preview.paymentsForManualRefund.map((p) => (
                        <tr key={p.id} style={{ borderBottom: '1px solid #eee' }}>
                          <td style={{ padding: 6 }}>{p.type}</td>
                          <td style={{ padding: 6, textAlign: 'right' }}>{fmtCents(p.amountCents)}</td>
                          <td style={{ padding: 6 }}>{p.cardBrand} ····{p.cardLast4}</td>
                          <td style={{ padding: 6 }}><code>{p.authCode}</code></td>
                          <td style={{ padding: 6, fontSize: 11 }}><code>{p.referenceId}</code></td>
                          <td style={{ padding: 6, fontSize: 11 }}>{fmtDate(p.createdAt)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              <div style={{ marginTop: 20 }}>
                <label className="label">Reason (required, min 5 chars — goes to audit log)</label>
                <textarea
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  rows={2}
                  placeholder="e.g. Agent accidentally checked-in before customer arrived"
                  style={{ width: '100%', padding: 8, borderRadius: 8, border: '1px solid #ccc' }}
                />
              </div>

              <div style={{ marginTop: 16, display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                <button
                  type="button"
                  className="btn ghost"
                  onClick={() => {
                    setPreview(null);
                    setReason('');
                  }}
                  disabled={applying}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  className="btn primary"
                  style={{ background: '#b91c1c', color: 'white' }}
                  onClick={applyOverride}
                  disabled={applying || reason.trim().length < 5}
                >
                  {applying ? 'Applying…' : `Apply override → ${preview.toStatus}`}
                </button>
              </div>
            </div>
          )}

          {result && (
            <div
              style={{
                background: '#ecfdf5',
                border: '1px solid #10b981',
                borderRadius: 12,
                padding: 16,
                marginBottom: 16,
              }}
            >
              <h4 style={{ marginTop: 0, color: '#065f46' }}>
                ✓ Override applied: {result.fromStatus} → {result.toStatus}
              </h4>
              <ul style={{ margin: '8px 0', paddingLeft: 20, fontSize: 13 }}>
                {result.raDeleted && <li>RentalAgreement deleted</li>}
                {result.signingDeleted && <li>ReservationSigning deleted</li>}
                {result.vehicleSync && (
                  <li>
                    Vehicle {result.vehicleSync.internalNumber || ''} synced:{' '}
                    {result.vehicleSync.from} → {result.vehicleSync.to}
                  </li>
                )}
                {result.paymentsForManualRefund?.length > 0 && (
                  <li style={{ color: '#b91c1c', fontWeight: 600 }}>
                    ⚠️ {result.paymentsForManualRefund.length} payment(s) listed above — refund on Dejavoo terminal
                  </li>
                )}
                <li style={{ fontSize: 11, color: '#6b7280' }}>Audit log id: <code>{result.auditLogId}</code></li>
              </ul>
              <button type="button" className="btn ghost" onClick={() => setResult(null)} style={{ marginTop: 8 }}>
                Dismiss
              </button>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
