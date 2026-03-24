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
  history: [],
  communications: [],
  requestNote: ''
};

const EMPTY_SUBMISSION_EDIT = {
  id: '',
  status: 'PENDING_REVIEW',
  reviewNotes: '',
  communications: [],
  requestNote: ''
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

function submissionToneClass(status) {
  const current = String(status || '').toUpperCase();
  if (current === 'APPROVED') return 'status-chip good';
  if (['PENDING_REVIEW', 'PENDING_INFO'].includes(current)) return 'status-chip warn';
  if (current === 'REJECTED') return 'status-chip neutral';
  return 'status-chip neutral';
}

function eventLabel(entry) {
  const current = String(entry?.eventType || '').toUpperCase();
  if (current === 'TRIP_INCIDENT_OPENED') return 'Issue Opened';
  if (current === 'TRIP_INCIDENT_UPDATED') return 'Issue Updated';
  if (current === 'TRIP_INCIDENT_STATUS_NOTIFIED') return 'Status Notification Sent';
  if (current === 'TRIP_INCIDENT_INFO_REQUESTED') return 'More Information Requested';
  if (current === 'TRIP_INCIDENT_REPLY_SUBMITTED') return 'Public Reply Submitted';
  return current || 'Timeline Event';
}

function actorLabel(entry) {
  const current = String(entry?.actorType || '').toUpperCase();
  if (current === 'HOST') return 'Host';
  if (current === 'GUEST') return 'Guest';
  if (current === 'TENANT_USER') return 'Customer Service / Ops';
  return current || 'System';
}

function submissionChecklist(submission) {
  const photoCount = Array.isArray(submission?.photos) ? submission.photos.length : 0;
  const docs = [
    !!submission?.insuranceDocumentUrl,
    !!submission?.registrationDocumentUrl,
    !!submission?.initialInspectionDocumentUrl
  ];
  return {
    photoCount,
    photoReady: photoCount > 0,
    docCount: docs.filter(Boolean).length,
    docsReady: docs.every(Boolean),
    addOnCount: Array.isArray(submission?.addOns) ? submission.addOns.length : 0,
    hasInspectionNotes: !!String(submission?.initialInspectionNotes || '').trim()
  };
}

function submissionReplyState(submission) {
  const pending = (submission?.communications || []).find((entry) => entry.publicTokenExpiresAt && !entry.respondedAt);
  const responded = (submission?.communications || []).find((entry) => !!entry.respondedAt);
  return {
    awaitingReply: !!pending,
    pending,
    responded
  };
}

function incidentHeadline(incident) {
  return [
    incident?.trip?.tripCode || incident?.reservation?.reservationNumber || '',
    incident?.title || ''
  ].filter(Boolean).join(' - ') || incident?.title || 'Issue Case';
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

function CommunicationList({ rows }) {
  if (!rows?.length) {
    return <div className="surface-note">No issue communications yet.</div>;
  }

  return (
    <div className="stack">
      {rows.map((entry) => (
        <div key={entry.id} className="surface-note" style={{ display: 'grid', gap: 8 }}>
          <div className="row-between" style={{ gap: 12, alignItems: 'start' }}>
            <div>
              <div style={{ fontWeight: 700 }}>{entry.subject || `${entry.direction} ${entry.channel}`}</div>
              <div className="label" style={{ textTransform: 'none', letterSpacing: 0, fontSize: 12 }}>
                {[entry.direction, entry.channel, entry.recipientType || '-', formatDateTime(entry.createdAt)].join(' - ')}
              </div>
            </div>
            {entry.respondedAt ? <span className="status-chip good">Responded</span> : entry.publicTokenExpiresAt ? <span className="status-chip warn">Awaiting Reply</span> : <span className="status-chip neutral">Logged</span>}
          </div>
          <div style={{ color: '#55456f', lineHeight: 1.5 }}>{entry.message || 'No message body.'}</div>
          {entry.publicTokenExpiresAt ? (
            <div className="label" style={{ textTransform: 'none', letterSpacing: 0, fontSize: 12 }}>
              Link expires {formatDateTime(entry.publicTokenExpiresAt)}
            </div>
          ) : null}
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
  );
}

function FileLinks({ files }) {
  if (!files?.length) return <div className="surface-note">No files attached yet.</div>;
  return (
    <div className="stack">
      {files.map((file, index) => (
        <a
          key={`${file.name || 'file'}-${index}`}
          href={file.dataUrl || file}
          target="_blank"
          rel="noreferrer"
          className="surface-note"
          style={{ textDecoration: 'none', color: '#4338ca' }}
        >
          Open {file.name || `Attachment ${index + 1}`}
        </a>
      ))}
    </div>
  );
}

function ServiceLaneCard({ label, count, note, tone = 'neutral' }) {
  const chipClass = tone === 'warn' ? 'status-chip warn' : tone === 'good' ? 'status-chip good' : 'status-chip neutral';
  return (
    <div className="doc-card">
      <div className="row-between" style={{ marginBottom: 0, alignItems: 'start' }}>
        <div style={{ display: 'grid', gap: 6 }}>
          <span className="label">{label}</span>
          <strong style={{ fontSize: 28, color: '#241b41' }}>{count}</strong>
        </div>
        <span className={chipClass}>{tone === 'warn' ? 'Needs Action' : tone === 'good' ? 'Ready' : 'Live'}</span>
      </div>
      <div className="doc-meta">{note}</div>
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
  const [submissionEdit, setSubmissionEdit] = useState(EMPTY_SUBMISSION_EDIT);

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
      if (edit.id) {
        const refreshed = (payload?.incidents || []).find((incident) => incident.id === edit.id);
        if (refreshed) {
          setEdit((current) => ({
            ...current,
            status: refreshed.status,
            title: refreshed.title,
            description: refreshed.description || '',
            amountResolved: refreshed.amountResolved ? String(refreshed.amountResolved) : '',
            history: refreshed.history || [],
            communications: refreshed.communications || []
          }));
        }
      }
      if (submissionEdit.id) {
        const refreshedSubmission = (payload?.vehicleSubmissions || []).find((submission) => submission.id === submissionEdit.id);
        if (refreshedSubmission) {
          setSubmissionEdit((current) => ({
            ...current,
            status: refreshedSubmission.status,
            reviewNotes: refreshedSubmission.reviewNotes || '',
            communications: refreshedSubmission.communications || []
          }));
        }
      }
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

  async function requestInfo(recipientType) {
    if (!edit.id) return;
    try {
      const payload = await api(`/api/issue-center/incidents/${edit.id}/request-info`, {
        method: 'POST',
        body: JSON.stringify({
          recipientType,
          note: edit.requestNote
        })
      }, token);
      setMsg(`Request sent to ${payload.recipientType.toLowerCase()}`);
      setEdit((current) => ({ ...current, requestNote: '' }));
      await load();
    } catch (error) {
      setMsg(error.message);
    }
  }

  async function requestSubmissionInfo() {
    if (!submissionEdit.id) return;
    try {
      await api(`/api/issue-center/vehicle-submissions/${submissionEdit.id}/request-info`, {
        method: 'POST',
        body: JSON.stringify({
          note: submissionEdit.requestNote
        })
      }, token);
      setMsg('Vehicle info request sent to host');
      setSubmissionEdit((current) => ({ ...current, requestNote: '' }));
      await load();
    } catch (error) {
      setMsg(error.message);
    }
  }

  async function approveSubmission() {
    if (!submissionEdit.id) return;
    try {
      await api(`/api/issue-center/vehicle-submissions/${submissionEdit.id}/approve`, {
        method: 'POST',
        body: JSON.stringify({
          reviewNotes: submissionEdit.reviewNotes
        })
      }, token);
      setMsg('Vehicle approved and activated for host');
      setSubmissionEdit(EMPTY_SUBMISSION_EDIT);
      await load();
    } catch (error) {
      setMsg(error.message);
    }
  }

  const metrics = dashboard?.metrics || { open: 0, underReview: 0, resolved: 0, closed: 0, total: 0 };
  const incidents = dashboard?.incidents || [];
  const vehicleSubmissions = dashboard?.vehicleSubmissions || [];
  const awaitingIncidentReplies = incidents.filter((incident) =>
    (incident.communications || []).some((entry) => entry.publicTokenExpiresAt && !entry.respondedAt)
  ).length;
  const awaitingVehicleReplies = vehicleSubmissions.filter((submission) =>
    (submission.communications || []).some((entry) => entry.publicTokenExpiresAt && !entry.respondedAt)
  ).length;
  const disputedTrips = incidents.filter((incident) => String(incident?.trip?.status || '').toUpperCase() === 'DISPUTED').length;
  const selectedSubmission = submissionEdit.id ? vehicleSubmissions.find((row) => row.id === submissionEdit.id) : null;
  const selectedSubmissionChecklist = selectedSubmission ? submissionChecklist(selectedSubmission) : null;
  const selectedSubmissionReply = selectedSubmission ? submissionReplyState(selectedSubmission) : null;
  const submissionPhotos = selectedSubmission?.photos || [];
  const submissionDocuments = [
    selectedSubmission?.insuranceDocumentUrl ? { name: 'Insurance Document', dataUrl: selectedSubmission.insuranceDocumentUrl } : null,
    selectedSubmission?.registrationDocumentUrl ? { name: 'Registration Document', dataUrl: selectedSubmission.registrationDocumentUrl } : null,
    selectedSubmission?.initialInspectionDocumentUrl ? { name: 'Initial Inspection', dataUrl: selectedSubmission.initialInspectionDocumentUrl } : null
  ].filter(Boolean);
  const nextCaseItems = useMemo(() => {
    const awaitingIncident = incidents.find((incident) =>
      (incident.communications || []).some((entry) => entry.publicTokenExpiresAt && !entry.respondedAt)
    );
    const disputedIncident = incidents.find((incident) => String(incident?.trip?.status || '').toUpperCase() === 'DISPUTED');
    const openIncident = incidents.find((incident) => String(incident.status || '').toUpperCase() === 'OPEN');
    const awaitingSubmission = vehicleSubmissions.find((submission) =>
      (submission.communications || []).some((entry) => entry.publicTokenExpiresAt && !entry.respondedAt)
    );
    const pendingSubmission = vehicleSubmissions.find((submission) => String(submission.status || '').toUpperCase() === 'PENDING_REVIEW');

    return [
      awaitingIncident ? {
        key: `incident-reply-${awaitingIncident.id}`,
        label: 'Awaiting Guest / Host Reply',
        title: incidentHeadline(awaitingIncident),
        detail: 'Support already requested more information. Review the reply window first.',
        cta: 'Handle Case',
        onClick: () => setEdit({
          id: awaitingIncident.id,
          status: awaitingIncident.status,
          title: awaitingIncident.title,
          description: awaitingIncident.description || '',
          amountResolved: awaitingIncident.amountResolved ? String(awaitingIncident.amountResolved) : '',
          note: '',
          history: awaitingIncident.history || [],
          communications: awaitingIncident.communications || [],
          requestNote: ''
        }),
        tone: 'warn'
      } : null,
      disputedIncident ? {
        key: `incident-dispute-${disputedIncident.id}`,
        label: 'Disputed Trip',
        title: incidentHeadline(disputedIncident),
        detail: 'Trip is still marked disputed and should be actively worked.',
        cta: 'Open Workflow',
        href: disputedIncident.trip?.reservation?.id ? `/reservations/${disputedIncident.trip.reservation.id}` : '/issues',
        tone: 'warn'
      } : null,
      openIncident ? {
        key: `incident-open-${openIncident.id}`,
        label: 'Newest Open Case',
        title: incidentHeadline(openIncident),
        detail: 'Fresh issue that should be triaged into review or resolution.',
        cta: 'Review Case',
        onClick: () => setEdit({
          id: openIncident.id,
          status: openIncident.status,
          title: openIncident.title,
          description: openIncident.description || '',
          amountResolved: openIncident.amountResolved ? String(openIncident.amountResolved) : '',
          note: '',
          history: openIncident.history || [],
          communications: openIncident.communications || [],
          requestNote: ''
        }),
        tone: 'neutral'
      } : null,
      awaitingSubmission ? {
        key: `submission-reply-${awaitingSubmission.id}`,
        label: 'Host Approval Reply',
        title: [awaitingSubmission.year, awaitingSubmission.make, awaitingSubmission.model].filter(Boolean).join(' ') || 'Vehicle Approval',
        detail: 'Host replied to an approval request. Review docs and communications before approving.',
        cta: 'Review Vehicle',
        onClick: () => setSubmissionEdit({
          id: awaitingSubmission.id,
          status: awaitingSubmission.status,
          reviewNotes: awaitingSubmission.reviewNotes || '',
          communications: awaitingSubmission.communications || [],
          requestNote: ''
        }),
        tone: 'warn'
      } : null,
      pendingSubmission ? {
        key: `submission-pending-${pendingSubmission.id}`,
        label: 'Pending Vehicle Approval',
        title: [pendingSubmission.year, pendingSubmission.make, pendingSubmission.model].filter(Boolean).join(' ') || 'Vehicle Submission',
        detail: 'A new host vehicle submission is still waiting on initial review.',
        cta: 'Review Vehicle',
        onClick: () => setSubmissionEdit({
          id: pendingSubmission.id,
          status: pendingSubmission.status,
          reviewNotes: pendingSubmission.reviewNotes || '',
          communications: pendingSubmission.communications || [],
          requestNote: ''
        }),
        tone: 'neutral'
      } : null
    ].filter(Boolean).slice(0, 4);
  }, [incidents, vehicleSubmissions]);

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
              Hosts and guests can raise issues, and hosts can also submit new vehicles for approval. This center now gives
              ops and customer service a triage surface plus a full communication trail before taking action.
            </p>
            <div className="hero-meta">
              <span className="hero-pill">Customer service queue</span>
              <span className="hero-pill">Open and review states</span>
              <span className="hero-pill">Trip-linked cases</span>
              <span className="hero-pill">Issue history</span>
              <span className="hero-pill">Vehicle approvals</span>
            </div>
          </div>
          <div className="glass card section-card">
            <div className="section-title">Issue Snapshot</div>
            <div className="metric-grid">
              <div className="metric-card"><span className="label">Open</span><strong>{metrics.open}</strong></div>
              <div className="metric-card"><span className="label">Under Review</span><strong>{metrics.underReview}</strong></div>
              <div className="metric-card"><span className="label">Resolved</span><strong>{metrics.resolved}</strong></div>
              <div className="metric-card"><span className="label">Closed</span><strong>{metrics.closed}</strong></div>
              <div className="metric-card"><span className="label">Vehicle Approvals</span><strong>{metrics.vehicleApprovalsPending || 0}</strong></div>
            </div>
          </div>
        </div>
      </section>

      {msg ? <div className="surface-note" style={{ color: /updated|saved/i.test(msg) ? '#166534' : '#991b1b', marginBottom: 18 }}>{msg}</div> : null}

      <section className="app-section-grid" style={{ marginBottom: 18 }}>
        <div className="app-banner">
          <div className="section-title">Customer Service Hub</div>
          <div className="app-banner-list">
            <span className="app-banner-pill">Open cases {metrics.open}</span>
            <span className="app-banner-pill">Under review {metrics.underReview}</span>
            <span className="app-banner-pill">Guest or host replies {awaitingIncidentReplies + awaitingVehicleReplies}</span>
            <span className="app-banner-pill">Vehicle approvals {metrics.vehicleApprovalsPending || 0}</span>
            <span className="app-banner-pill">Disputed trips {disputedTrips}</span>
          </div>
        </div>

        <section className="glass card-lg section-card">
          <div className="row-between">
            <div>
              <div className="section-title">Service Lanes</div>
              <p className="ui-muted">Triage faster from phone or tablet: know what needs action first, then open the queue or workflow only when needed.</p>
            </div>
            <span className="status-chip neutral">Support Ready</span>
          </div>
          <div className="app-card-grid compact">
            <ServiceLaneCard
              label="Open Issues"
              count={metrics.open}
              note="Fresh host or guest cases that should be triaged and moved into review."
              tone={metrics.open > 0 ? 'warn' : 'neutral'}
            />
            <ServiceLaneCard
              label="Awaiting Public Reply"
              count={awaitingIncidentReplies + awaitingVehicleReplies}
              note="Cases where support already asked for more info and is waiting on guest or host response."
              tone={(awaitingIncidentReplies + awaitingVehicleReplies) > 0 ? 'warn' : 'neutral'}
            />
            <ServiceLaneCard
              label="Vehicle Approvals"
              count={metrics.vehicleApprovalsPending || 0}
              note="Host fleet submissions waiting on document, photo, pricing, or inspection review."
              tone={(metrics.vehicleApprovalsPending || 0) > 0 ? 'warn' : 'neutral'}
            />
            <ServiceLaneCard
              label="Resolved And Closed"
              count={(metrics.resolved || 0) + (metrics.closed || 0)}
              note="Completed support work that can be audited from issue history and communications."
              tone={((metrics.resolved || 0) + (metrics.closed || 0)) > 0 ? 'good' : 'neutral'}
            />
          </div>
          <div className="surface-note">
            Best support order: grab open issues first, check waiting public replies second, clear vehicle approvals, then finish resolution notes before closeout.
          </div>
        </section>

        <section className="glass card-lg section-card">
          <div className="row-between">
            <div>
              <div className="section-title">Next Cases To Handle</div>
              <p className="ui-muted">A compact priority board for phone and tablet so the next support move is obvious.</p>
            </div>
            <span className="status-chip neutral">{nextCaseItems.length} live priorities</span>
          </div>
          {nextCaseItems.length ? (
            <div className="app-card-grid compact">
              {nextCaseItems.map((item) => (
                <div key={item.key} className="doc-card">
                  <div className="row-between" style={{ marginBottom: 0, alignItems: 'start' }}>
                    <div style={{ display: 'grid', gap: 6 }}>
                      <span className="label">{item.label}</span>
                      <strong>{item.title}</strong>
                    </div>
                    <span className={item.tone === 'warn' ? 'status-chip warn' : 'status-chip neutral'}>
                      {item.tone === 'warn' ? 'Attention' : 'Queue'}
                    </span>
                  </div>
                  <div className="doc-meta">{item.detail}</div>
                  <div className="inline-actions">
                    {item.href ? (
                      <a href={item.href}>
                        <button type="button">{item.cta}</button>
                      </a>
                    ) : (
                      <button type="button" onClick={item.onClick}>{item.cta}</button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="surface-note">No urgent support priorities are open right now. You can work from the queues below.</div>
          )}
        </section>
      </section>

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
                  {(() => {
                    const reservation = incident.reservation || incident.trip?.reservation || null;
                    const guestName = incident.trip?.guestCustomer
                      ? [incident.trip.guestCustomer.firstName, incident.trip.guestCustomer.lastName].filter(Boolean).join(' ')
                      : incident.guestCustomer
                        ? [incident.guestCustomer.firstName, incident.guestCustomer.lastName].filter(Boolean).join(' ')
                        : '';
                    const subjectRef = incident.trip?.tripCode || reservation?.reservationNumber || '-';
                    const workflowLabel = incident.subjectType === 'RESERVATION' ? 'Reservation Issue' : 'Trip Issue';
                    return (
                      <>
                  <div className="row-between" style={{ gap: 12, alignItems: 'start' }}>
                    <div>
                      <div style={{ fontWeight: 700 }}>{incident.title}</div>
                      <div className="label" style={{ textTransform: 'none', letterSpacing: 0, fontSize: 12 }}>
                        {[
                          subjectRef,
                          workflowLabel,
                          incident.type,
                          guestName,
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
                    <div className="info-tile"><span className="label">{incident.subjectType === 'RESERVATION' ? 'Reservation' : 'Trip'}</span><strong>{incident.subjectType === 'RESERVATION' ? (reservation?.status || '-') : (incident.trip?.status || '-')}</strong></div>
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
                        history: incident.history || [],
                        communications: incident.communications || [],
                        requestNote: ''
                      })}
                    >
                      Handle Case
                    </button>
                    {reservation?.id ? <a href={`/reservations/${reservation.id}`}><button type="button" className="button-subtle">Open Workflow</button></a> : null}
                  </div>
                      </>
                    );
                  })()}
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
              <div className="glass card section-card" style={{ padding: 14 }}>
                <div className="section-title" style={{ marginBottom: 10 }}>Request More Information</div>
                <div className="stack">
                  <div className="label">Representative Request Note</div>
                  <textarea rows={4} value={edit.requestNote} onChange={(e) => setEdit((current) => ({ ...current, requestNote: e.target.value }))} placeholder="Explain what support or documents are needed to continue processing this issue." />
                  <div className="inline-actions">
                    <button type="button" className="button-subtle" onClick={() => requestInfo('GUEST')}>Email Guest For Info</button>
                    <button type="button" className="button-subtle" onClick={() => requestInfo('HOST')}>Email Host For Info</button>
                  </div>
                </div>
              </div>
              <div>
                <div className="section-title" style={{ marginBottom: 10 }}>Issue History</div>
                <HistoryList rows={edit.history || []} />
              </div>
              <div>
                <div className="section-title" style={{ marginBottom: 10 }}>Communications</div>
                <CommunicationList rows={edit.communications || []} />
              </div>
            </form>
          ) : (
            <div className="surface-note">Choose a case from the queue to handle it here.</div>
          )}
        </section>
      </section>

      <section className="split-panel" style={{ marginTop: 18 }}>
        <section className="glass card-lg section-card">
          <div className="row-between">
            <div>
              <div className="section-title">Host Vehicle Approvals</div>
              <p className="ui-muted">Review new host fleet submissions, request more info, and approve vehicles when everything checks out.</p>
            </div>
            <span className="status-chip warn">{metrics.vehicleApprovalsPending || 0} pending</span>
          </div>
          {vehicleSubmissions.length ? (
            <div className="stack">
              {vehicleSubmissions.map((submission) => (
                <div key={submission.id} className="surface-note" style={{ display: 'grid', gap: 10 }}>
                  {(() => {
                    const checklist = submissionChecklist(submission);
                    const replyState = submissionReplyState(submission);
                    return (
                      <>
                  <div className="row-between" style={{ gap: 12, alignItems: 'start' }}>
                    <div>
                      <div style={{ fontWeight: 700 }}>{[submission.year, submission.make, submission.model].filter(Boolean).join(' ') || 'Vehicle Submission'}</div>
                      <div className="label" style={{ textTransform: 'none', letterSpacing: 0, fontSize: 12 }}>
                        {[
                          submission.hostProfile?.displayName || 'Host',
                          submission.vehicleType?.name || '-',
                          submission.preferredLocation?.name || '-'
                        ].filter(Boolean).join(' - ')}
                      </div>
                    </div>
                    <span className={submissionToneClass(submission.status)}>{submission.status}</span>
                  </div>
                  <div className="info-grid-tight">
                    <div className="info-tile"><span className="label">Daily Rate</span><strong>{formatMoney(submission.baseDailyRate)}</strong></div>
                    <div className="info-tile"><span className="label">Docs</span><strong>{`${checklist.docCount}/3`}</strong></div>
                    <div className="info-tile"><span className="label">Photos</span><strong>{checklist.photoCount}</strong></div>
                    <div className="info-tile"><span className="label">Submitted</span><strong>{formatDateTime(submission.createdAt)}</strong></div>
                  </div>
                  <div className="inline-actions" style={{ gap: 8, flexWrap: 'wrap' }}>
                    <span className={checklist.docsReady ? 'status-chip good' : 'status-chip warn'}>{checklist.docsReady ? 'Docs Ready' : 'Docs Missing'}</span>
                    <span className={checklist.photoReady ? 'status-chip good' : 'status-chip warn'}>{checklist.photoReady ? 'Photos Ready' : 'No Photos'}</span>
                    <span className={checklist.hasInspectionNotes ? 'status-chip good' : 'status-chip neutral'}>{checklist.hasInspectionNotes ? 'Inspection Notes' : 'No Inspection Notes'}</span>
                    {checklist.addOnCount ? <span className="status-chip neutral">{`${checklist.addOnCount} Host Add-On${checklist.addOnCount > 1 ? 's' : ''}`}</span> : null}
                  </div>
                  <div style={{ color: '#55456f', lineHeight: 1.5 }}>
                    {[
                      submission.plate ? `Plate ${submission.plate}` : '',
                      submission.vin ? `VIN ${submission.vin}` : '',
                      submission.reviewNotes || 'Awaiting review.'
                    ].filter(Boolean).join(' - ')}
                  </div>
                  {replyState.awaitingReply ? (
                    <div className="surface-note" style={{ padding: '10px 12px' }}>
                      Waiting on host reply since {formatDateTime(replyState.pending?.createdAt)}.
                    </div>
                  ) : null}
                  <div className="inline-actions">
                    {replyState.awaitingReply ? <span className="status-chip warn">Info Requested</span> : replyState.responded ? <span className="status-chip good">Host Replied</span> : null}
                    <button
                      type="button"
                      onClick={() => setSubmissionEdit({
                        id: submission.id,
                        status: submission.status,
                        reviewNotes: submission.reviewNotes || '',
                        communications: submission.communications || [],
                        requestNote: ''
                      })}
                    >
                      Review Vehicle
                    </button>
                    {submission.listing?.id ? <span className="status-chip good">Active</span> : null}
                  </div>
                      </>
                    );
                  })()}
                </div>
              ))}
            </div>
          ) : (
            <div className="surface-note">No host vehicle approvals match the current search.</div>
          )}
        </section>

        <section className="glass card-lg section-card">
          <div className="row-between">
            <div>
              <div className="section-title">Vehicle Approval Review</div>
              <p className="ui-muted">Inspect photos, docs, host add-ons, and communications before approving the vehicle.</p>
            </div>
            {submissionEdit.id ? <button type="button" className="button-subtle" onClick={() => setSubmissionEdit(EMPTY_SUBMISSION_EDIT)}>Clear</button> : null}
          </div>
          {selectedSubmission ? (
            <div className="stack">
              <div className="row-between" style={{ gap: 12, alignItems: 'start' }}>
                <div>
                  <div style={{ fontWeight: 700, fontSize: 20 }}>{[selectedSubmission.year, selectedSubmission.make, selectedSubmission.model].filter(Boolean).join(' ') || 'Vehicle Submission'}</div>
                  <div className="label" style={{ textTransform: 'none', letterSpacing: 0, fontSize: 12 }}>
                    {[selectedSubmission.hostProfile?.displayName || 'Host', selectedSubmission.hostProfile?.email || '', selectedSubmission.hostProfile?.phone || ''].filter(Boolean).join(' - ')}
                  </div>
                </div>
                <span className={submissionToneClass(selectedSubmission.status)}>{selectedSubmission.status}</span>
              </div>
              <div className="info-grid-tight">
                <div className="info-tile"><span className="label">Vehicle Type</span><strong>{selectedSubmission.vehicleType?.name || '-'}</strong></div>
                <div className="info-tile"><span className="label">Location</span><strong>{selectedSubmission.preferredLocation?.name || '-'}</strong></div>
                <div className="info-tile"><span className="label">Mileage</span><strong>{selectedSubmission.mileage || 0}</strong></div>
                <div className="info-tile"><span className="label">Trip Days</span><strong>{`${selectedSubmission.minTripDays || 1} - ${selectedSubmission.maxTripDays || '-'}`}</strong></div>
                <div className="info-tile"><span className="label">Daily Rate</span><strong>{formatMoney(selectedSubmission.baseDailyRate)}</strong></div>
                <div className="info-tile"><span className="label">Security Deposit</span><strong>{formatMoney(selectedSubmission.securityDeposit)}</strong></div>
              </div>
              <div className="metric-grid">
                <div className="metric-card"><span className="label">Photos Ready</span><strong>{selectedSubmissionChecklist?.photoCount || 0}</strong></div>
                <div className="metric-card"><span className="label">Docs Ready</span><strong>{`${selectedSubmissionChecklist?.docCount || 0}/3`}</strong></div>
                <div className="metric-card"><span className="label">Host Add-Ons</span><strong>{selectedSubmissionChecklist?.addOnCount || 0}</strong></div>
                <div className="metric-card"><span className="label">Reply State</span><strong>{selectedSubmissionReply?.awaitingReply ? 'Waiting' : selectedSubmissionReply?.responded ? 'Replied' : 'No Request'}</strong></div>
              </div>
              <div className="inline-actions" style={{ gap: 8, flexWrap: 'wrap' }}>
                <span className={selectedSubmissionChecklist?.docsReady ? 'status-chip good' : 'status-chip warn'}>{selectedSubmissionChecklist?.docsReady ? 'Documents Ready' : 'Documents Missing'}</span>
                <span className={selectedSubmissionChecklist?.photoReady ? 'status-chip good' : 'status-chip warn'}>{selectedSubmissionChecklist?.photoReady ? 'Photos Ready' : 'Photos Missing'}</span>
                <span className={selectedSubmissionChecklist?.hasInspectionNotes ? 'status-chip good' : 'status-chip neutral'}>{selectedSubmissionChecklist?.hasInspectionNotes ? 'Inspection Notes Included' : 'Inspection Notes Missing'}</span>
                {selectedSubmissionReply?.awaitingReply ? <span className="status-chip warn">Waiting On Host Reply</span> : null}
                {!selectedSubmissionReply?.awaitingReply && selectedSubmissionReply?.responded ? <span className="status-chip good">Host Replied</span> : null}
              </div>
              <div className="split-panel" style={{ alignItems: 'start' }}>
                <div className="surface-note">
                  <strong style={{ display: 'block', marginBottom: 6 }}>Host Contact</strong>
                  {[selectedSubmission.hostProfile?.displayName || 'Host', selectedSubmission.hostProfile?.email || 'No email', selectedSubmission.hostProfile?.phone || 'No phone'].join(' · ')}
                </div>
                <div className="surface-note">
                  <strong style={{ display: 'block', marginBottom: 6 }}>Review Guidance</strong>
                  {selectedSubmissionReply?.awaitingReply
                    ? `More info was requested on ${formatDateTime(selectedSubmissionReply.pending?.createdAt)}. Review the new reply or attachments before approving.`
                    : 'Verify photos, ownership docs, inspection notes, and pricing before approving the vehicle.'}
                </div>
              </div>
              {selectedSubmission.shortDescription || selectedSubmission.description ? (
                <div className="surface-note" style={{ color: '#55456f', lineHeight: 1.6 }}>
                  <strong style={{ display: 'block', color: '#1f1637', marginBottom: 6 }}>{selectedSubmission.shortDescription || 'Vehicle Summary'}</strong>
                  {selectedSubmission.description || 'No extra description provided.'}
                </div>
              ) : null}
              <div>
                <div className="section-title" style={{ marginBottom: 10 }}>Vehicle Photos</div>
                {submissionPhotos.length ? (
                  <div className="metric-grid">
                    {submissionPhotos.map((photo, index) => (
                      <a key={`${selectedSubmission.id}-photo-${index}`} href={photo} target="_blank" rel="noreferrer" className="surface-note" style={{ textDecoration: 'none', display: 'grid', gap: 8 }}>
                        <img src={photo} alt={`Submission ${index + 1}`} style={{ width: '100%', aspectRatio: '16 / 10', objectFit: 'cover', borderRadius: 14 }} />
                        <span style={{ color: '#4338ca', fontWeight: 600 }}>Open Photo {index + 1}</span>
                      </a>
                    ))}
                  </div>
                ) : <div className="surface-note">No host photos uploaded.</div>}
              </div>
              <div>
                <div className="section-title" style={{ marginBottom: 10 }}>Documents</div>
                <FileLinks files={submissionDocuments} />
              </div>
              <div className="split-panel" style={{ alignItems: 'start' }}>
                <div className="stack">
                  <div className="section-title">Host Add-Ons</div>
                  {(selectedSubmission.addOns || []).length ? (
                    <div className="stack">
                      {selectedSubmission.addOns.map((row, index) => (
                        <div key={`${selectedSubmission.id}-addon-${index}`} className="surface-note" style={{ display: 'grid', gap: 6 }}>
                          <strong>{row.name || `Service ${index + 1}`}</strong>
                          <div className="label" style={{ textTransform: 'none', letterSpacing: 0, fontSize: 12 }}>{formatMoney(row.price)}</div>
                          <div style={{ color: '#55456f', lineHeight: 1.5 }}>{row.description || 'No description.'}</div>
                        </div>
                      ))}
                    </div>
                  ) : <div className="surface-note">No host-specific add-ons submitted.</div>}
                </div>
                <div className="stack">
                  <div className="section-title">Inspection Notes</div>
                  <div className="surface-note" style={{ color: '#55456f', lineHeight: 1.6 }}>
                    {selectedSubmission.initialInspectionNotes || 'No initial inspection notes were included.'}
                  </div>
                </div>
              </div>
              <div className="stack">
                <div className="label">Review Notes</div>
                <textarea rows={4} value={submissionEdit.reviewNotes} onChange={(e) => setSubmissionEdit((current) => ({ ...current, reviewNotes: e.target.value }))} placeholder="Internal review notes or approval comments" />
              </div>
              <div className="glass card section-card" style={{ padding: 14 }}>
                <div className="section-title" style={{ marginBottom: 10 }}>Request More Information</div>
                <div className="stack">
                  <div className="label">Representative Request Note</div>
                  <textarea rows={4} value={submissionEdit.requestNote} onChange={(e) => setSubmissionEdit((current) => ({ ...current, requestNote: e.target.value }))} placeholder="Explain what documents, photos, or corrections the host needs to send back." />
                  <div className="inline-actions">
                    <button type="button" className="button-subtle" onClick={requestSubmissionInfo}>Email Host For Info</button>
                    <button type="button" onClick={approveSubmission}>Approve Vehicle</button>
                  </div>
                </div>
              </div>
              <div>
                <div className="section-title" style={{ marginBottom: 10 }}>Communications</div>
                <CommunicationList rows={submissionEdit.communications || []} />
              </div>
            </div>
          ) : (
            <div className="surface-note">Choose a host vehicle submission from the queue to review it here.</div>
          )}
        </section>
      </section>
    </AppShell>
  );
}
