'use client';

import { useEffect, useMemo, useState } from 'react';
import { api } from '../lib/client';

/**
 * Admin-facing card for managing rental agreement addendums (BUG-001 / Option C).
 *
 * Renders the list of addendums for a given rental agreement, an admin-only
 * "Create Addendum" form, and per-row actions (void, view print).
 *
 * Customer-side signature flow is deferred to a follow-up — the existing
 * /customer/sign-agreement public page is token-based and would need a
 * parallel public endpoint for addendums.
 *
 * @param {object} props
 * @param {string} props.rentalAgreementId - parent agreement id (required to render)
 * @param {string} props.role - the current user's role (used for admin gating)
 * @param {object} [props.reservation] - parent reservation, optional; used to
 *   prefill the new-pickup / new-return inputs on the create form.
 */
export function AgreementAddendumsCard({ rentalAgreementId, role, reservation = null }) {
  const isAdmin = ['SUPER_ADMIN', 'ADMIN'].includes(String(role || '').toUpperCase());

  const [addendums, setAddendums] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [busyId, setBusyId] = useState(null);

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
