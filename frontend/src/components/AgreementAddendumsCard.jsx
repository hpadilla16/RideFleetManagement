'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../lib/client';

/**
 * Admin-facing card for managing rental agreement addendums (BUG-001 / Option C).
 *
 * Renders the list of addendums for a given rental agreement, an admin-only
 * "Create Addendum" form, and per-row actions:
 *   - View / Print (always)
 *   - Resend signature email (admin, PENDING_SIGNATURE only) — POSTs to the
 *     `/notify` route which re-fires `scheduleAddendumNotification`. Used when
 *     the customer never received / lost the original email at addendum creation.
 *   - Sign on behalf (admin, PENDING_SIGNATURE only) — opens an in-page
 *     signature pad and submits via the authenticated
 *     `/addendums/:id/signature` endpoint. Used when the customer is in front
 *     of the agent or has authorized acceptance verbally / over email.
 *   - Void (admin, non-VOID).
 *
 * The customer self-service path lives separately at /customer/sign-addendum
 * (token-based public flow) — both surfaces converge on the same backend
 * `signAddendum` service so the resulting row is structurally identical.
 *
 * @param {object} props
 * @param {string} props.rentalAgreementId - parent agreement id (required to render)
 * @param {string} props.role - the current user's role (used for admin gating)
 * @param {object} [props.reservation] - parent reservation, optional; used to
 *   prefill the new-pickup / new-return inputs on the create form, and the
 *   signer name on the sign-on-behalf modal.
 */
export function AgreementAddendumsCard({ rentalAgreementId, role, reservation = null }) {
  const isAdmin = ['SUPER_ADMIN', 'ADMIN'].includes(String(role || '').toUpperCase());

  const [addendums, setAddendums] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [info, setInfo] = useState('');
  const [busyId, setBusyId] = useState(null);
  const [resendingId, setResendingId] = useState(null);

  // Sign-on-behalf modal state
  const [signModalAddendum, setSignModalAddendum] = useState(null);

  // Create-form state
  const [showForm, setShowForm] = useState(false);
  const [formPickupAt, setFormPickupAt] = useState('');
  const [formReturnAt, setFormReturnAt] = useState('');
  const [formReason, setFormReason] = useState('');
  const [formCategory, setFormCategory] = useState('admin_correction');
  const [formBusy, setFormBusy] = useState(false);

  const sortedAddendums = useMemo(
    () => [...addendums].sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0)),
    [addendums]
  );
  const hasPending = useMemo(
    () => sortedAddendums.some((x) => String(x.status || '').toUpperCase() === 'PENDING_SIGNATURE'),
    [sortedAddendums]
  );

  const fetchAddendums = async () => {
    if (!rentalAgreementId) return;
    setLoading(true);
    setError('');
    try {
      const rows = await api(`/api/rental-agreements/${rentalAgreementId}/addendums`);
      setAddendums(Array.isArray(rows) ? rows : []);
    } catch (e) {
      setError(String(e?.message || e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchAddendums();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rentalAgreementId]);

  // Pre-fill new-dates from reservation when the form opens
  useEffect(() => {
    if (!showForm) return;
    if (!formPickupAt && reservation?.pickupAt) {
      setFormPickupAt(toLocalInput(reservation.pickupAt));
    }
    if (!formReturnAt && reservation?.returnAt) {
      setFormReturnAt(toLocalInput(reservation.returnAt));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showForm]);

  const submitCreate = async () => {
    if (!isAdmin) return;
    if (!formPickupAt || !formReturnAt) {
      setError('newPickupAt and newReturnAt are required');
      return;
    }
    if (!formReason.trim()) {
      setError('Please describe the reason for this addendum');
      return;
    }
    setFormBusy(true);
    setError('');
    try {
      await api(`/api/rental-agreements/${rentalAgreementId}/addendums`, {
        method: 'POST',
        body: JSON.stringify({
          newPickupAt: new Date(formPickupAt).toISOString(),
          newReturnAt: new Date(formReturnAt).toISOString(),
          reason: formReason.trim(),
          reasonCategory: formCategory
        })
      });
      // Reset form + reload
      setShowForm(false);
      setFormPickupAt('');
      setFormReturnAt('');
      setFormReason('');
      setFormCategory('admin_correction');
      await fetchAddendums();
    } catch (e) {
      setError(String(e?.message || e));
    } finally {
      setFormBusy(false);
    }
  };

  const handleVoid = async (addendumId) => {
    if (!isAdmin) return;
    const reason = window.prompt('Reason for voiding this addendum?', 'Voided by admin');
    if (reason === null) return;
    setBusyId(addendumId);
    setError('');
    setInfo('');
    try {
      await api(`/api/rental-agreements/${rentalAgreementId}/addendums/${addendumId}/void`, {
        method: 'POST',
        body: JSON.stringify({ reason })
      });
      await fetchAddendums();
    } catch (e) {
      setError(String(e?.message || e));
    } finally {
      setBusyId(null);
    }
  };

  const handleResend = async (addendumId) => {
    if (!isAdmin) return;
    if (
      !window.confirm(
        'Resend the signature email to the customer? The customer will receive a fresh email with the existing signing link.'
      )
    ) {
      return;
    }
    setResendingId(addendumId);
    setError('');
    setInfo('');
    try {
      const result = await api(
        `/api/rental-agreements/${rentalAgreementId}/addendums/${addendumId}/notify`,
        { method: 'POST', body: JSON.stringify({}) }
      );
      // The notify route returns { customer, admin } envelopes — surface the
      // customer-side outcome since that's what the admin clicked the button for.
      const c = result?.customer || {};
      if (c.sent) {
        setInfo('Signature email resent to the customer.');
      } else if (c.skipped === 'no-customer-email') {
        setError('No customer email on file. Update the agreement before resending.');
      } else if (c.skipped === 'no-signature-token') {
        setError(
          'This addendum has no active signing token. Void it and create a new one to issue a fresh link.'
        );
      } else if (c.error) {
        setError(`Email send failed: ${c.error}`);
      } else {
        setInfo('Resend request accepted.');
      }
    } catch (e) {
      setError(String(e?.message || e));
    } finally {
      setResendingId(null);
    }
  };

  const handleSignedOnBehalf = (signedRow) => {
    // Reflect the new SIGNED status locally without a refetch round-trip.
    setAddendums((prev) =>
      prev.map((a) => (a.id === signedRow.id ? { ...a, ...signedRow } : a))
    );
    setSignModalAddendum(null);
    setInfo(`Signature recorded for ${signedRow.signatureSignedBy || 'customer'}.`);
    setError('');
  };

  const printUrl = (addendumId) =>
    `/api/rental-agreements/${rentalAgreementId}/addendums/${addendumId}/print`;

  if (!rentalAgreementId) return null;

  return (
    <div className="card" style={{ marginTop: 14 }}>
      <div className="row-between" style={{ marginBottom: 8 }}>
        <h3 style={{ margin: 0 }}>Addendums</h3>
        <span className="label">
          {hasPending ? 'Awaiting signature' : `${sortedAddendums.length} on file`}
        </span>
      </div>

      {error ? (
        <div
          style={{
            background: 'rgba(220, 38, 38, 0.08)',
            color: '#991b1b',
            padding: '8px 12px',
            borderRadius: 12,
            marginBottom: 10
          }}
        >
          {error}
        </div>
      ) : null}

      {info ? (
        <div
          style={{
            background: 'rgba(22, 163, 74, 0.10)',
            color: '#166534',
            padding: '8px 12px',
            borderRadius: 12,
            marginBottom: 10
          }}
        >
          {info}
        </div>
      ) : null}

      {loading ? (
        <div className="label">Loading addendums...</div>
      ) : sortedAddendums.length === 0 ? (
        <div className="label" style={{ marginBottom: 10 }}>
          No addendums yet. An addendum captures a date change after the agreement is signed,
          while keeping the original immutable as the legal record.
        </div>
      ) : (
        <div style={{ display: 'grid', gap: 10 }}>
          {sortedAddendums.map((a) => (
            <div
              key={a.id}
              style={{
                border: '1px solid rgba(102, 79, 177, 0.18)',
                borderRadius: 16,
                padding: 14
              }}
            >
              <div className="row-between" style={{ marginBottom: 6 }}>
                <strong style={{ fontSize: '0.95rem' }}>
                  {fmtDateTime(a.pickupAt)} &nbsp;→&nbsp; {fmtDateTime(a.returnAt)}
                </strong>
                <StatusBadge status={a.status} />
              </div>
              <div style={{ color: '#55456f', lineHeight: 1.5, marginBottom: 6 }}>
                <strong>Reason:</strong> {a.reason || '-'}
                {a.reasonCategory ? (
                  <span className="label" style={{ marginLeft: 8 }}>{a.reasonCategory}</span>
                ) : null}
              </div>
              {a.signatureSignedAt ? (
                <div className="label" style={{ marginBottom: 6 }}>
                  Signed by {a.signatureSignedBy || 'Unknown'} on {fmtDateTime(a.signatureSignedAt)}
                </div>
              ) : null}
              <div className="label" style={{ marginBottom: 8 }}>
                Created {fmtDateTime(a.createdAt)}
              </div>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <a
                  href={printUrl(a.id)}
                  target="_blank"
                  rel="noreferrer"
                  style={{ textDecoration: 'none' }}
                >
                  <button type="button" className="button-subtle">View / Print</button>
                </a>
                {isAdmin && String(a.status || '').toUpperCase() === 'PENDING_SIGNATURE' ? (
                  <>
                    <button
                      type="button"
                      className="button-subtle"
                      disabled={resendingId === a.id}
                      onClick={() => handleResend(a.id)}
                      title="Re-send the signature email to the customer's address on file"
                    >
                      {resendingId === a.id ? 'Resending...' : 'Resend signature email'}
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setError('');
                        setInfo('');
                        setSignModalAddendum(a);
                      }}
                      title="Capture the customer's signature on this device (in person)"
                    >
                      Sign on behalf
                    </button>
                  </>
                ) : null}
                {isAdmin && String(a.status || '').toUpperCase() !== 'VOID' ? (
                  <button
                    type="button"
                    className="button-subtle"
                    disabled={busyId === a.id}
                    onClick={() => handleVoid(a.id)}
                  >
                    {busyId === a.id ? 'Voiding...' : 'Void'}
                  </button>
                ) : null}
              </div>
            </div>
          ))}
        </div>
      )}

      {signModalAddendum ? (
        <SignOnBehalfModal
          rentalAgreementId={rentalAgreementId}
          addendum={signModalAddendum}
          reservation={reservation}
          onClose={() => setSignModalAddendum(null)}
          onSigned={handleSignedOnBehalf}
        />
      ) : null}

      {isAdmin ? (
        <div style={{ marginTop: 12 }}>
          {!showForm ? (
            <button
              type="button"
              onClick={() => setShowForm(true)}
              disabled={hasPending}
              title={hasPending ? 'Resolve the pending addendum first (sign or void)' : ''}
            >
              {hasPending ? 'Pending addendum awaiting signature' : 'Create Addendum'}
            </button>
          ) : (
            <div
              style={{
                border: '1px dashed rgba(102, 79, 177, 0.3)',
                borderRadius: 16,
                padding: 14,
                marginTop: 4
              }}
            >
              <div className="row-between" style={{ marginBottom: 8 }}>
                <strong>New addendum</strong>
                <span className="label">Admin only</span>
              </div>
              <div className="grid2" style={{ gap: 10, marginBottom: 8 }}>
                <div className="stack">
                  <label className="label">New Pickup</label>
                  <input
                    type="datetime-local"
                    value={formPickupAt}
                    onChange={(e) => setFormPickupAt(e.target.value)}
                  />
                </div>
                <div className="stack">
                  <label className="label">New Return</label>
                  <input
                    type="datetime-local"
                    value={formReturnAt}
                    onChange={(e) => setFormReturnAt(e.target.value)}
                  />
                </div>
              </div>
              <div className="stack" style={{ marginBottom: 8 }}>
                <label className="label">Category</label>
                <select value={formCategory} onChange={(e) => setFormCategory(e.target.value)}>
                  <option value="admin_correction">Admin correction</option>
                  <option value="customer_request">Customer request / extension</option>
                  <option value="system">System override</option>
                </select>
              </div>
              <div className="stack" style={{ marginBottom: 10 }}>
                <label className="label">Reason</label>
                <textarea
                  rows={2}
                  value={formReason}
                  onChange={(e) => setFormReason(e.target.value)}
                  placeholder="What changed and why?"
                />
              </div>
              <div style={{ display: 'flex', gap: 8 }}>
                <button type="button" onClick={submitCreate} disabled={formBusy}>
                  {formBusy ? 'Creating...' : 'Create Addendum'}
                </button>
                <button
                  type="button"
                  className="button-subtle"
                  onClick={() => {
                    setShowForm(false);
                    setError('');
                  }}
                  disabled={formBusy}
                >
                  Cancel
                </button>
              </div>
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
}

// --- helpers ---

function StatusBadge({ status }) {
  const s = String(status || '').toUpperCase();
  const palette = {
    PENDING_SIGNATURE: { bg: 'rgba(245, 158, 11, 0.12)', fg: '#92400e', label: 'Pending signature' },
    SIGNED: { bg: 'rgba(22, 163, 74, 0.12)', fg: '#166534', label: 'Signed' },
    VOID: { bg: 'rgba(102, 102, 102, 0.12)', fg: '#374151', label: 'Void' }
  };
  const tone = palette[s] || { bg: 'rgba(102, 79, 177, 0.10)', fg: '#3b2a6b', label: s || 'Unknown' };
  return (
    <span
      style={{
        background: tone.bg,
        color: tone.fg,
        padding: '4px 10px',
        borderRadius: 999,
        fontSize: '0.8rem',
        fontWeight: 700,
        letterSpacing: 0.2
      }}
    >
      {tone.label}
    </span>
  );
}

function fmtDateTime(d) {
  if (!d) return '-';
  try {
    return new Date(d).toLocaleString();
  } catch {
    return String(d);
  }
}

function toLocalInput(d) {
  if (!d) return '';
  try {
    const date = new Date(d);
    const pad = (n) => String(n).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(
      date.getHours()
    )}:${pad(date.getMinutes())}`;
  } catch {
    return '';
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Admin sign-on-behalf modal
//
// Captures a customer signature on the agent's device when the customer is
// physically present (or when an agent is recording verbal acceptance with
// permission). Mirrors the canvas + mouse/touch handler pattern in the public
// /customer/sign-addendum/page.js so the data shape on the backend is
// identical regardless of which path captured the signature.
//
// Calls authenticated POST /api/rental-agreements/:id/addendums/:addendumId/signature
// — the same endpoint the customer-facing public-token flow ultimately
// converges on. The backend records signatureSignedBy + signatureDataUrl +
// signatureIp; the agent's identity is derivable from the JWT in audit logs.
//
// Renders inline (no portal) — sufficient for current usage. Move to a portal
// if we add a second concurrent modal anywhere on the agreement detail page.
// ─────────────────────────────────────────────────────────────────────────────
function SignOnBehalfModal({ rentalAgreementId, addendum, reservation, onClose, onSigned }) {
  const canvasRef = useRef(null);
  const [drawing, setDrawing] = useState(false);
  const [signerName, setSignerName] = useState('');
  const [acknowledged, setAcknowledged] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  // Pre-fill the signer name from the reservation customer if available so the
  // agent doesn't have to retype it in person.
  useEffect(() => {
    const first = reservation?.customerFirstName || reservation?.customer?.firstName || '';
    const last = reservation?.customerLastName || reservation?.customer?.lastName || '';
    const composed = `${first} ${last}`.trim();
    if (composed) setSignerName(composed);
  }, [reservation]);

  const pos = (e) => {
    const c = canvasRef.current;
    if (!c) return null;
    const r = c.getBoundingClientRect();
    const p = e.touches?.[0] || e;
    return { x: p.clientX - r.left, y: p.clientY - r.top };
  };

  const start = (e) => {
    const c = canvasRef.current;
    if (!c) return;
    const ctx = c.getContext('2d');
    const p = pos(e);
    if (!p) return;
    ctx.beginPath();
    ctx.moveTo(p.x, p.y);
    setDrawing(true);
  };

  const move = (e) => {
    if (!drawing) return;
    const c = canvasRef.current;
    if (!c) return;
    const ctx = c.getContext('2d');
    const p = pos(e);
    if (!p) return;
    ctx.lineWidth = 2;
    ctx.lineCap = 'round';
    ctx.strokeStyle = '#111827';
    ctx.lineTo(p.x, p.y);
    ctx.stroke();
  };

  const end = () => setDrawing(false);

  const clearSig = () => {
    const c = canvasRef.current;
    if (!c) return;
    const ctx = c.getContext('2d');
    ctx.clearRect(0, 0, c.width, c.height);
  };

  const submit = async () => {
    setError('');
    if (!signerName.trim()) {
      setError('Signer name is required');
      return;
    }
    if (!acknowledged) {
      setError('Please confirm the customer authorized this signature.');
      return;
    }
    const c = canvasRef.current;
    if (!c) {
      setError('Signature pad unavailable');
      return;
    }
    const signatureDataUrl = c.toDataURL('image/png');
    // Empty 860×220 canvas serializes well below 2 KB; matches the threshold
    // used on the customer page so behaviour is consistent across surfaces.
    if (!signatureDataUrl || signatureDataUrl.length < 2000) {
      setError('Please draw the customer signature before submitting.');
      return;
    }

    setBusy(true);
    try {
      const row = await api(
        `/api/rental-agreements/${rentalAgreementId}/addendums/${addendum.id}/signature`,
        {
          method: 'POST',
          body: JSON.stringify({
            signatureDataUrl,
            signatureSignedBy: signerName.trim()
          })
        }
      );
      onSigned?.(row);
    } catch (e) {
      setError(String(e?.message || e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Sign addendum on customer's behalf"
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(15, 12, 31, 0.55)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 1000,
        padding: 16
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget && !busy) onClose?.();
      }}
    >
      <div
        style={{
          background: '#fff',
          borderRadius: 20,
          padding: 20,
          width: '100%',
          maxWidth: 720,
          maxHeight: '92vh',
          overflowY: 'auto',
          boxShadow: '0 30px 60px rgba(33, 26, 56, 0.35)'
        }}
      >
        <div className="row-between" style={{ marginBottom: 10 }}>
          <h3 style={{ margin: 0 }}>Sign on customer&apos;s behalf</h3>
          <button
            type="button"
            className="button-subtle"
            onClick={onClose}
            disabled={busy}
            aria-label="Close"
          >
            Close
          </button>
        </div>

        <div
          style={{
            background: 'rgba(245, 158, 11, 0.10)',
            color: '#92400e',
            padding: '10px 12px',
            borderRadius: 12,
            marginBottom: 12,
            lineHeight: 1.5,
            fontSize: '0.9rem'
          }}
        >
          By signing here you confirm the customer has reviewed the new dates
          below and authorized this signature in person, by phone, or via
          written/electronic communication you have on file. This action is
          recorded with your account and IP for audit.
        </div>

        <div
          style={{
            border: '1px solid rgba(102, 79, 177, 0.18)',
            borderRadius: 16,
            padding: 12,
            marginBottom: 12,
            color: '#3b2a6b',
            lineHeight: 1.5,
            fontSize: '0.92rem'
          }}
        >
          <strong>New rental dates:</strong>{' '}
          {fmtDateTime(addendum.pickupAt)} &nbsp;→&nbsp; {fmtDateTime(addendum.returnAt)}
          {addendum.reason ? (
            <div style={{ marginTop: 4 }}>
              <strong>Reason:</strong> {addendum.reason}
            </div>
          ) : null}
        </div>

        {error ? (
          <div
            style={{
              background: 'rgba(220, 38, 38, 0.08)',
              color: '#991b1b',
              padding: '8px 12px',
              borderRadius: 12,
              marginBottom: 10
            }}
          >
            {error}
          </div>
        ) : null}

        <div className="stack" style={{ marginBottom: 10 }}>
          <label className="label">Signer name (customer)</label>
          <input
            type="text"
            value={signerName}
            onChange={(e) => setSignerName(e.target.value)}
            placeholder="Customer's full legal name"
            disabled={busy}
          />
        </div>

        <div className="stack" style={{ marginBottom: 10 }}>
          <label className="label">Signature</label>
          <canvas
            ref={canvasRef}
            width={680}
            height={200}
            style={{
              width: '100%',
              maxWidth: '100%',
              border: '1px solid rgba(102, 79, 177, 0.18)',
              borderRadius: 16,
              background: '#fff',
              touchAction: 'none'
            }}
            onMouseDown={start}
            onMouseMove={move}
            onMouseUp={end}
            onMouseLeave={end}
            onTouchStart={start}
            onTouchMove={move}
            onTouchEnd={end}
          />
          <div style={{ marginTop: 6 }}>
            <button
              type="button"
              className="button-subtle"
              onClick={clearSig}
              disabled={busy}
            >
              Clear signature
            </button>
          </div>
        </div>

        <label
          style={{
            display: 'flex',
            gap: 8,
            alignItems: 'flex-start',
            color: '#55456f',
            lineHeight: 1.5,
            marginBottom: 14,
            fontSize: '0.9rem'
          }}
        >
          <input
            type="checkbox"
            checked={acknowledged}
            onChange={(e) => setAcknowledged(e.target.checked)}
            disabled={busy}
          />
          <span>
            I confirm the customer authorized this signature and has reviewed
            the new dates above.
          </span>
        </label>

        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button
            type="button"
            className="button-subtle"
            onClick={onClose}
            disabled={busy}
          >
            Cancel
          </button>
          <button type="button" onClick={submit} disabled={busy}>
            {busy ? 'Recording signature...' : 'Record signature'}
          </button>
        </div>
      </div>
    </div>
  );
}
