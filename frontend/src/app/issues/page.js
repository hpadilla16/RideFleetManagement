'use client';

import { useEffect, useMemo, useState } from 'react';
import { AuthGate } from '../../components/AuthGate';
import { AppShell } from '../../components/AppShell';
import { api } from '../../lib/client';

const EMPTY_EDIT = {
  id: '',
  status: 'OPEN',
  title: '',
  description: '',
  amountResolved: '',
  note: '',
  history: []
};

function formatMoney(value) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(Number(value || 0));
}

function formatDateTime(value) {
  if (!value) return '-';
  try {
    return new Date(value).toLocaleString();
  } catch {
    return String(value);
  }
}

function toneClass(status) {
  const current = String(status || '').toUpperCase();
  if (['RESOLVED', 'CLOSED'].includes(current)) return 'status-chip good';
  if (['OPEN', 'UNDER_REVIEW'].includes(current)) return 'status-chip warn';
  return 'status-chip neutral';
}

function eventLabel(entry) {
  const current = String(entry?.eventType || '').toUpperCase();
  if (current === 'TRIP_INCIDENT_OPENED') return 'Issue Opened';
  if (current === 'TRIP_INCIDENT_UPDATED') return 'Issue Updated';
  return current || 'Timeline Event';
}

function actorLabel(entry) {
  const current = String(entry?.actorType || '').toUpperCase();
  if (current === 'HOST') return 'Host';
  if (current === 'GUEST') return 'Guest';
  if (current === 'TENANT_USER') return 'Customer Service / Ops';
  return current || 'System';
}

function HistoryList({ rows }) {
  if (!rows?.length) {
    return <div className="surface-note">No history yet beyond the current case snapshot.</div>;
  }

  return (
    <div className="stack">
      {rows.map((entry) => (
        <div key={entry.id} className="surface-note" style={{ display: 'grid', gap: 8 }}>
          <div className="row-between" style={{ gap: 12, alignItems: 'start' }}>
            <div>
              <div style={{ fontWeight: 700 }}>{eventLabel(entry)}</div>
              <div className="label" style={{ textTransform: 'none', letterSpacing: 0, fontSize: 12 }}>
                {[actorLabel(entry), formatDateTime(entry.eventAt)].filter(Boolean).join(' - ')}
              </div>
            </div>
            {entry.metadata?.nextStatus ? <span className={toneClass(entry.metadata.nextStatus)}>{entry.metadata.nextStatus}</span> : null}
          </div>
          {entry.notes ? <div style={{ color: '#55456f', lineHeight: 1.5 }}>{entry.notes}</div> : null}
          {(entry.metadata?.previousStatus || entry.metadata?.amountResolved != null) ? (
            <div className="label" style={{ textTransform: 'none', letterSpacing: 0, fontSize: 12 }}>
              {[
                entry.metadata?.previousStatus ? `From ${entry.metadata.previousStatus}` : '',
                entry.metadata?.nextStatus ? `To ${entry.metadata.nextStatus}` : '',
                entry.metadata?.amountResolved != null ? `Resolved ${formatMoney(entry.metadata.amountResolved)}` : ''
              ].filter(Boolean).join(' - ')}
            </div>
          ) : null}
        </div>
      ))}
    </div>
  );
}

export default function IssueCenterPage() {
  return <AuthGate>{({ token, me, logout }) => <IssueCenterInner token={token} me={me} logout={logout} />}</AuthGate>;
}

function IssueCenterInner({ token, me, logout }) {
  const [dashboard, setDashboard] = useState(null);
  const [msg, setMsg] = useState('');
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('');
  const [type, setType] = useState('');
  const [edit, setEdit] = useState(EMPTY_EDIT);

  const scopedQuery = useMemo(() => {
    const params = new URLSearchParams();
    if (search) params.set('q', search);
    if (status) params.set('status', status);
    if (type) params.set('type', type);
    const value = params.toString();
    return value ? `?${value}` : '';
  }, [search, status, type]);

  async function load() {
    try {
      const payload = await api(`/api/issue-center/dashboard${scopedQuery}`, {}, token);
      setDashboard(payload);
      setMsg('');
    } catch (error) {
      setDashboard(null);
      setMsg(error.message);
    }
  }

  useEffect(() => {
    load();
  }, [scopedQuery, token]);

  async function saveIncident(event) {
    event.preventDefault();
    if (!edit.id) return;
    try {
      await api(`/api/issue-center/incidents/${edit.id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          status: edit.status,
          title: edit.title,
          description: edit.description,
          amountResolved: edit.amountResolved === '' ? null : Number(edit.amountResolved),
          note: edit.note
        })
      }, token);
      setMsg('Issue updated');
      setEdit(EMPTY_EDIT);
      await load();
    } catch (error) {
      setMsg(error.message);
    }
  }

  const metrics = dashboard?.metrics || { open: 0, underReview: 0, resolved: 0, closed: 0, total: 0 };
  const incidents = dashboard?.incidents || [];

  return (
    <AppShell me={me} logout={logout}>
      <section className="glass card-lg page-hero">
        <div className="hero-grid">
          <div className="hero-copy">
            <span className="eyebrow">Issue And Dispute Center</span>
            <h1 className="page-title" style={{ fontSize: 'clamp(30px, 5vw, 54px)', lineHeight: 1.02 }}>
              Give customer service one place to review, resolve, close, and audit trip issues.
            </h1>
            <p>
              Hosts and guests can raise issues. This center now gives ops and customer service a triage surface
              plus a full case history so the team can understand everything that happened before taking action.
            </p>
            <div className="hero-meta">
              <span className="hero-pill">Customer service queue</span>
              <span className="hero-pill">Open and review states</span>
              <span className="hero-pill">Trip-linked cases</span>
              <span className="hero-pill">Issue history</span>
            </div>
          </div>
          <div className="glass card section-card">
            <div className="section-title">Issue Snapshot</div>
            <div className="metric-grid">
              <div className="metric-card"><span className="label">Open</span><strong>{metrics.open}</strong></div>
              <div className="metric-card"><span className="label">Under Review</span><strong>{metrics.underReview}</strong></div>
              <div className="metric-card"><span className="label">Resolved</span><strong>{metrics.resolved}</strong></div>
              <div className="metric-card"><span className="label">Closed</span><strong>{metrics.closed}</strong></div>
            </div>
          </div>
        </div>
      </section>

      {msg ? <div className="surface-note" style={{ color: /updated|saved/i.test(msg) ? '#166534' : '#991b1b', marginBottom: 18 }}>{msg}</div> : null}

      <section className="split-panel">
        <section className="glass card-lg section-card">
          <div className="row-between">
            <div>
              <div className="section-title">Open Queue</div>
              <p className="ui-muted">Search by trip code, reservation, guest, host, or incident title.</p>
            </div>
            <span className="status-chip neutral">{metrics.total} total</span>
          </div>
          <div className="form-grid-3">
            <div>
              <div className="label">Search</div>
              <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Trip, reservation, guest, host" />
            </div>
            <div>
              <div className="label">Status</div>
              <select value={status} onChange={(e) => setStatus(e.target.value)}>
                <option value="">All</option>
                <option value="OPEN">OPEN</option>
                <option value="UNDER_REVIEW">UNDER_REVIEW</option>
                <option value="RESOLVED">RESOLVED</option>
                <option value="CLOSED">CLOSED</option>
              </select>
            </div>
            <div>
              <div className="label">Type</div>
              <select value={type} onChange={(e) => setType(e.target.value)}>
                <option value="">All</option>
                <option value="DAMAGE">DAMAGE</option>
                <option value="TOLL">TOLL</option>
                <option value="CLEANING">CLEANING</option>
                <option value="LATE_RETURN">LATE_RETURN</option>
                <option value="OTHER">OTHER</option>
              </select>
            </div>
          </div>
          {incidents.length ? (
            <div className="stack">
              {incidents.map((incident) => (
                <div key={incident.id} className="surface-note" style={{ display: 'grid', gap: 10 }}>
                  <div className="row-between" style={{ gap: 12, alignItems: 'start' }}>
                    <div>
                      <div style={{ fontWeight: 700 }}>{incident.title}</div>
                      <div className="label" style={{ textTransform: 'none', letterSpacing: 0, fontSize: 12 }}>
                        {[
                          incident.trip?.tripCode || '-',
                          incident.type,
                          incident.trip?.guestCustomer ? [incident.trip.guestCustomer.firstName, incident.trip.guestCustomer.lastName].filter(Boolean).join(' ') : '',
                          incident.trip?.hostProfile?.displayName || ''
                        ].filter(Boolean).join(' - ')}
                      </div>
                    </div>
                    <span className={toneClass(incident.status)}>{incident.status}</span>
                  </div>
                  <div className="info-grid-tight">
                    <div className="info-tile"><span className="label">Claimed</span><strong>{formatMoney(incident.amountClaimed)}</strong></div>
                    <div className="info-tile"><span className="label">Resolved</span><strong>{formatMoney(incident.amountResolved)}</strong></div>
                    <div className="info-tile"><span className="label">Created</span><strong>{formatDateTime(incident.createdAt)}</strong></div>
                    <div className="info-tile"><span className="label">Trip</span><strong>{incident.trip?.status || '-'}</strong></div>
                  </div>
                  <div style={{ color: '#55456f', lineHeight: 1.5 }}>{incident.description || 'No description provided.'}</div>
                  <details>
                    <summary style={{ cursor: 'pointer', fontWeight: 600 }}>Issue History</summary>
                    <div style={{ marginTop: 10 }}>
                      <HistoryList rows={incident.history || []} />
                    </div>
                  </details>
                  <div className="inline-actions">
                    <button
                      type="button"
                      onClick={() => setEdit({
                        id: incident.id,
                        status: incident.status,
                        title: incident.title,
                        description: incident.description || '',
                        amountResolved: incident.amountResolved ? String(incident.amountResolved) : '',
                        note: '',
                        history: incident.history || []
                      })}
                    >
                      Handle Case
                    </button>
                    {incident.trip?.reservation?.id ? <a href={`/reservations/${incident.trip.reservation.id}`}><button type="button" className="button-subtle">Open Workflow</button></a> : null}
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="surface-note">No issues match the current filters.</div>
          )}
        </section>

        <section className="glass card-lg section-card">
          <div className="row-between">
            <div>
              <div className="section-title">Case Handling</div>
              <p className="ui-muted">Move a case through review and resolution while keeping the trip workflow in sync.</p>
            </div>
            {edit.id ? <button type="button" className="button-subtle" onClick={() => setEdit(EMPTY_EDIT)}>Clear</button> : null}
          </div>
          {edit.id ? (
            <form className="stack" onSubmit={saveIncident}>
              <div className="stack">
                <div className="label">Title</div>
                <input value={edit.title} onChange={(e) => setEdit((current) => ({ ...current, title: e.target.value }))} />
              </div>
              <div className="stack">
                <div className="label">Status</div>
                <select value={edit.status} onChange={(e) => setEdit((current) => ({ ...current, status: e.target.value }))}>
                  <option value="OPEN">OPEN</option>
                  <option value="UNDER_REVIEW">UNDER_REVIEW</option>
                  <option value="RESOLVED">RESOLVED</option>
                  <option value="CLOSED">CLOSED</option>
                </select>
              </div>
              <div className="stack">
                <div className="label">Amount Resolved</div>
                <input type="number" min="0" step="0.01" value={edit.amountResolved} onChange={(e) => setEdit((current) => ({ ...current, amountResolved: e.target.value }))} />
              </div>
              <div className="stack">
                <div className="label">Description</div>
                <textarea rows={4} value={edit.description} onChange={(e) => setEdit((current) => ({ ...current, description: e.target.value }))} />
              </div>
              <div className="stack">
                <div className="label">Internal Note</div>
                <textarea rows={3} value={edit.note} onChange={(e) => setEdit((current) => ({ ...current, note: e.target.value }))} placeholder="Customer service note for the trip timeline" />
              </div>
              <div className="inline-actions">
                <button type="submit">Save Case</button>
              </div>
              <div>
                <div className="section-title" style={{ marginBottom: 10 }}>Issue History</div>
                <HistoryList rows={edit.history || []} />
              </div>
            </form>
          ) : (
            <div className="surface-note">Choose a case from the queue to handle it here.</div>
          )}
        </section>
      </section>
    </AppShell>
  );
}
