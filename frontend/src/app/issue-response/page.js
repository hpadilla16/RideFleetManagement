'use client';

import { useEffect, useMemo, useState } from 'react';
import { api } from '../../lib/client';

function formatDateTime(value) {
  if (!value) return '-';
  try {
    return new Date(value).toLocaleString();
  } catch {
    return String(value);
  }
}

function money(value) {
  return `$${Number(value || 0).toFixed(2)}`;
}

function statusTone(status) {
  const value = String(status || '').toLowerCase();
  if (['resolved', 'closed'].includes(value)) return { color: '#166534', background: 'rgba(34, 197, 94, 0.14)' };
  if (['open', 'under_review'].includes(value)) return { color: '#92400e', background: 'rgba(245, 158, 11, 0.16)' };
  return { color: '#55456f', background: 'rgba(85, 69, 111, 0.1)' };
}

function StatusPill({ status }) {
  const tone = statusTone(status);
  return (
    <span style={{ display: 'inline-flex', padding: '6px 12px', borderRadius: 999, background: tone.background, color: tone.color, fontWeight: 700, fontSize: 12 }}>
      {status}
    </span>
  );
}

function parseToken() {
  if (typeof window === 'undefined') return '';
  try {
    return new URL(window.location.href).searchParams.get('token') || '';
  } catch {
    return '';
  }
}

export default function IssueResponsePage() {
  const [token, setToken] = useState('');
  const [model, setModel] = useState(null);
  const [form, setForm] = useState({ message: '', attachments: [] });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    const currentToken = parseToken();
    setToken(currentToken);
  }, []);

  useEffect(() => {
    if (!token) return;
    let ignore = false;
    async function load() {
      try {
        setLoading(true);
        setError('');
        const payload = await api(`/api/public/issues/respond/${encodeURIComponent(token)}`);
        if (!ignore) setModel(payload);
      } catch (err) {
        if (!ignore) {
          setModel(null);
          setError(err.message);
        }
      } finally {
        if (!ignore) setLoading(false);
      }
    }
    load();
    return () => { ignore = true; };
  }, [token]);

  async function uploadAttachments(files) {
    const selected = Array.from(files || []).slice(0, 6);
    const rows = await Promise.all(selected.map((file) => new Promise((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve({ name: file.name, dataUrl: String(reader.result || '') });
      reader.readAsDataURL(file);
    })));
    setForm((current) => ({
      ...current,
      attachments: [...current.attachments, ...rows.filter((row) => row.dataUrl)].slice(0, 6)
    }));
  }

  async function submit(event) {
    event.preventDefault();
    try {
      setSaving(true);
      setError('');
      const payload = await api(`/api/public/issues/respond/${encodeURIComponent(token)}`, {
        method: 'POST',
        body: JSON.stringify({
          message: form.message,
          attachments: form.attachments
        })
      });
      setModel((current) => {
        if (!current) return current;
        if (current.caseType === 'HOST_VEHICLE_SUBMISSION') {
          return { ...current, submission: payload };
        }
        return { ...current, incident: payload };
      });
      setForm({ message: '', attachments: [] });
      setMsg('Your reply was sent to customer service successfully.');
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  const communications = useMemo(() => {
    if (model?.caseType === 'HOST_VEHICLE_SUBMISSION') return model?.submission?.communications || [];
    return model?.incident?.communications || [];
  }, [model]);
  const isVehicleSubmission = model?.caseType === 'HOST_VEHICLE_SUBMISSION';
  const vehicleSummary = model?.submission || null;
  const incidentSummary = model?.incident || null;

  return (
    <main style={{ minHeight: '100vh', padding: '22px clamp(14px, 3vw, 34px) 44px' }}>
      <div style={{ maxWidth: 1120, margin: '0 auto', display: 'grid', gap: 18 }}>
        <section className="glass card-lg page-hero">
          <div className="hero-grid">
            <div className="hero-copy">
              <span className="eyebrow">Issue Response Portal</span>
              <h1 className="page-title" style={{ fontSize: 'clamp(30px, 5vw, 52px)', lineHeight: 1.04 }}>
                Send documents or answer customer service without calling the counter.
              </h1>
              <p>
                Use this secure link to reply to an issue or dispute request, share more context, and upload any supporting
                documents or photos the representative asked for.
              </p>
            </div>
            <div className="glass card section-card">
              <div className="section-title">What You Can Send</div>
              <div className="stack">
                <div className="surface-note">Written explanation or clarification.</div>
                <div className="surface-note">Photos, screenshots, invoices, or supporting documents.</div>
                <div className="surface-note">Everything will be visible to customer service in the Issue Center.</div>
              </div>
            </div>
          </div>
        </section>

        {loading ? <div className="surface-note">Loading your issue response request...</div> : null}
        {error ? <div className="surface-note" style={{ color: '#991b1b' }}>{error}</div> : null}
        {msg ? <div className="surface-note" style={{ color: '#166534' }}>{msg}</div> : null}

        {model?.incident || model?.submission ? (
          <section className="split-panel">
            <section className="glass card-lg section-card">
              <div className="row-between">
                <div>
                  <div className="section-title">{isVehicleSubmission ? 'Vehicle Review Summary' : 'Issue Summary'}</div>
                  <p className="ui-muted">
                    {isVehicleSubmission
                      ? 'The vehicle approval request your reply will be attached to.'
                      : 'The support request your reply will be attached to.'}
                  </p>
                </div>
                <StatusPill status={isVehicleSubmission ? vehicleSummary?.status : incidentSummary?.status} />
              </div>
              {isVehicleSubmission ? (
                <>
                  <div className="info-grid-tight">
                    <div className="info-tile"><span className="label">Vehicle</span><strong>{[vehicleSummary?.year, vehicleSummary?.make, vehicleSummary?.model].filter(Boolean).join(' ') || '-'}</strong></div>
                    <div className="info-tile"><span className="label">Vehicle Type</span><strong>{vehicleSummary?.vehicleType?.name || '-'}</strong></div>
                    <div className="info-tile"><span className="label">Location</span><strong>{vehicleSummary?.preferredLocation?.name || '-'}</strong></div>
                    <div className="info-tile"><span className="label">Plate</span><strong>{vehicleSummary?.plate || '-'}</strong></div>
                    <div className="info-tile"><span className="label">VIN</span><strong>{vehicleSummary?.vin || '-'}</strong></div>
                    <div className="info-tile"><span className="label">Submitted</span><strong>{formatDateTime(vehicleSummary?.createdAt)}</strong></div>
                  </div>
                  <div className="surface-note" style={{ color: '#55456f', lineHeight: 1.6 }}>
                    {vehicleSummary?.description || vehicleSummary?.shortDescription || 'No extra vehicle description was provided.'}
                  </div>
                </>
              ) : (
                <>
                  <div className="info-grid-tight">
                    <div className="info-tile"><span className="label">Issue</span><strong>{incidentSummary?.title}</strong></div>
                    <div className="info-tile"><span className="label">Type</span><strong>{incidentSummary?.type}</strong></div>
                    <div className="info-tile"><span className="label">Trip</span><strong>{incidentSummary?.trip?.tripCode || '-'}</strong></div>
                    <div className="info-tile"><span className="label">Reservation</span><strong>{incidentSummary?.trip?.reservation?.reservationNumber || '-'}</strong></div>
                    <div className="info-tile"><span className="label">Claimed</span><strong>{money(incidentSummary?.amountClaimed)}</strong></div>
                    <div className="info-tile"><span className="label">Opened</span><strong>{formatDateTime(incidentSummary?.createdAt)}</strong></div>
                  </div>
                  <div className="surface-note" style={{ color: '#55456f', lineHeight: 1.6 }}>
                    {incidentSummary?.description || 'No extra description was provided with the issue.'}
                  </div>
                </>
              )}
              {model.request ? (
                <div className="surface-note" style={{ display: 'grid', gap: 8 }}>
                  <div style={{ fontWeight: 700 }}>Representative Request</div>
                  <div style={{ color: '#55456f', lineHeight: 1.6 }}>{model.request.message || 'Customer service requested more information.'}</div>
                  <div className="label" style={{ textTransform: 'none', letterSpacing: 0, fontSize: 12 }}>
                    Sent {formatDateTime(model.request.createdAt)} - expires {formatDateTime(model.request.publicTokenExpiresAt)}
                  </div>
                </div>
              ) : null}
              {isVehicleSubmission && vehicleSummary?.photos?.length ? (
                <div className="metric-grid">
                  {vehicleSummary.photos.slice(0, 6).map((photo, index) => (
                    <a key={`vehicle-photo-${index}`} href={photo} target="_blank" rel="noreferrer" className="surface-note" style={{ textDecoration: 'none', display: 'grid', gap: 8 }}>
                      <img src={photo} alt={`Vehicle ${index + 1}`} style={{ width: '100%', aspectRatio: '16 / 10', objectFit: 'cover', borderRadius: 14 }} />
                      <span style={{ color: '#4338ca', fontWeight: 600 }}>Open Photo {index + 1}</span>
                    </a>
                  ))}
                </div>
              ) : null}
            </section>

            <section className="glass card-lg section-card">
              <div className="row-between">
                <div>
                  <div className="section-title">Reply To Customer Service</div>
                  <p className="ui-muted">Send your note and attach any files the representative asked for.</p>
                </div>
                <span className="status-chip neutral">{communications.length} messages</span>
              </div>
              <form className="stack" onSubmit={submit}>
                <div>
                  <div className="label">Reply</div>
                  <textarea
                    rows={5}
                    value={form.message}
                    onChange={(event) => setForm((current) => ({ ...current, message: event.target.value }))}
                    placeholder="Write your explanation, clarification, or answer here"
                  />
                </div>
                <div className="stack">
                  <div className="label">Documents Or Photos</div>
                  <input type="file" accept="image/*,.pdf,.doc,.docx,.txt" multiple onChange={(event) => uploadAttachments(event.target.files)} />
                  {form.attachments.length ? (
                    <div className="stack">
                      {form.attachments.map((row, index) => (
                        <div key={`${row.name}-${index}`} className="surface-note row-between" style={{ gap: 12 }}>
                          <div>{row.name}</div>
                          <button type="button" className="button-subtle" onClick={() => setForm((current) => ({ ...current, attachments: current.attachments.filter((_, idx) => idx !== index) }))}>Remove</button>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="surface-note">No documents selected yet.</div>
                  )}
                </div>
                <div className="inline-actions">
                  <button type="submit" disabled={saving}>{saving ? 'Sending Reply...' : 'Send Reply'}</button>
                </div>
              </form>
            </section>
          </section>
        ) : null}

        {communications.length ? (
          <section className="glass card-lg section-card">
            <div className="row-between">
              <div>
                <div className="section-title">Communication History</div>
                <p className="ui-muted">A running thread of what customer service asked for and what has already been sent back.</p>
              </div>
            </div>
            <div className="timeline-list">
              {communications.map((entry) => (
                <div key={entry.id} className="timeline-item">
                  <div className="row-between" style={{ gap: 12 }}>
                    <strong>{entry.subject || `${entry.direction} ${entry.channel}`}</strong>
                    <span className="status-chip neutral">{entry.direction}</span>
                  </div>
                  <div className="label" style={{ textTransform: 'none', letterSpacing: 0, fontSize: 12 }}>
                    {[entry.recipientType || '-', entry.senderType || '-', formatDateTime(entry.createdAt)].join(' - ')}
                  </div>
                  <div style={{ color: '#55456f', lineHeight: 1.6 }}>{entry.message || 'No message body.'}</div>
                  {entry.attachments?.length ? (
                    <div className="stack">
                      {entry.attachments.map((file, index) => (
                        <a key={`${entry.id}-${index}`} href={file.dataUrl} target="_blank" rel="noreferrer" className="surface-note" style={{ textDecoration: 'none', color: '#4338ca' }}>
                          Open {file.name || `Attachment ${index + 1}`}
                        </a>
                      ))}
                    </div>
                  ) : null}
                </div>
              ))}
            </div>
          </section>
        ) : null}
      </div>
    </main>
  );
}
