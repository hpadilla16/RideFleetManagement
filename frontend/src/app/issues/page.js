'use client';

import { useEffect, useMemo, useState } from 'react';
import { AuthGate } from '../../components/AuthGate';
import { AppShell } from '../../components/AppShell';
import { API_BASE, api } from '../../lib/client';
import { HostVehicleApprovalsQueue } from './HostVehicleApprovalsQueue';
import { HostVehicleApprovalWorkspace } from './HostVehicleApprovalWorkspace';

const EMPTY_EDIT = {
  id: '',
  status: 'OPEN',
  priority: 'MEDIUM',
  severity: 'LOW',
  ownerUserId: '',
  dueAt: '',
  resolutionCode: '',
  liabilityDecision: 'PENDING',
  chargeDecision: 'PENDING',
  recoveryStage: 'INTAKE',
  waiveReason: '',
  customerChargeReady: false,
  title: '',
  description: '',
  amountResolved: '',
  note: '',
  history: [],
  communications: [],
  operationalContext: null,
  evidenceChecklist: null,
  evidenceCapture: null,
  evidenceRequestDrafts: null,
  recoveryActions: null,
  inspectionCompare: null,
  nextBestAction: null,
  requestNote: ''
};

const EMPTY_CREATE = {
  subjectType: 'TRIP',
  reference: '',
  type: 'OTHER',
  priority: 'MEDIUM',
  severity: 'LOW',
  ownerUserId: '',
  dueAt: '',
  liabilityDecision: 'PENDING',
  chargeDecision: 'PENDING',
  recoveryStage: 'INTAKE',
  waiveReason: '',
  customerChargeReady: false,
  title: '',
  description: '',
  amountClaimed: ''
};

const EMPTY_SUBMISSION_EDIT = {
  id: '',
  status: 'PENDING_REVIEW',
  reviewNotes: '',
  communications: [],
  requestNote: ''
};

const ISSUE_SEARCH_KEY = 'issues.search';
const ISSUE_STATUS_KEY = 'issues.status';
const ISSUE_TYPE_KEY = 'issues.type';
const ISSUE_EDIT_ID_KEY = 'issues.editId';
const ISSUE_SUBMISSION_ID_KEY = 'issues.submissionId';

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

function incidentAwaitingReply(incident) {
  return (incident?.communications || []).some((entry) => entry.publicTokenExpiresAt && !entry.respondedAt);
}

function incidentIsActive(incident) {
  return ['OPEN', 'UNDER_REVIEW'].includes(String(incident?.status || '').toUpperCase());
}

function incidentDueSoon(incident) {
  if (!incident?.dueAt || !incidentIsActive(incident)) return false;
  const dueAt = new Date(incident.dueAt).getTime();
  if (Number.isNaN(dueAt)) return false;
  return dueAt <= (Date.now() + 1000 * 60 * 60 * 24 * 2);
}

function incidentReadyToClose(incident) {
  return String(incident?.status || '').toUpperCase() === 'RESOLVED' && !incidentAwaitingReply(incident);
}

function incidentHeadline(incident) {
  return [
    incident?.trip?.tripCode || incident?.reservation?.reservationNumber || '',
    incident?.title || ''
  ].filter(Boolean).join(' - ') || incident?.title || 'Issue Case';
}

function incidentToEdit(incident) {
  return {
    id: incident.id,
    status: incident.status,
    priority: incident.priority || 'MEDIUM',
    severity: incident.severity || 'LOW',
    ownerUserId: incident.ownerUser?.id || '',
    dueAt: incident.dueAt ? String(incident.dueAt).slice(0, 16) : '',
    resolutionCode: incident.resolutionCode || '',
    liabilityDecision: incident.liabilityDecision || 'PENDING',
    chargeDecision: incident.chargeDecision || 'PENDING',
    recoveryStage: incident.recoveryStage || 'INTAKE',
    waiveReason: incident.waiveReason || '',
    customerChargeReady: !!incident.customerChargeReady,
    title: incident.title,
    description: incident.description || '',
    amountResolved: incident.amountResolved ? String(incident.amountResolved) : '',
    note: '',
    history: incident.history || [],
    communications: incident.communications || [],
    operationalContext: incident.operationalContext || null,
    evidenceChecklist: incident.evidenceChecklist || null,
    evidenceCapture: incident.evidenceCapture || null,
    evidenceRequestDrafts: incident.evidenceRequestDrafts || null,
    recoveryActions: incident.recoveryActions || null,
    inspectionCompare: incident.inspectionCompare || null,
    nextBestAction: incident.nextBestAction || null,
    requestNote: ''
  };
}

function submissionToEdit(submission) {
  return {
    id: submission.id,
    status: submission.status,
    reviewNotes: submission.reviewNotes || '',
    communications: submission.communications || [],
    requestNote: ''
  };
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
  const openFile = (dataUrl, name) => {
    if (!dataUrl) return;
    if (dataUrl.startsWith('data:image/')) {
      const win = window.open('', '_blank');
      if (win) { win.document.write(`<html><head><title>${name}</title></head><body style="margin:0;display:flex;justify-content:center;align-items:center;min-height:100vh;background:#f5f5f5"><img src="${dataUrl}" style="max-width:100%;max-height:100vh;object-fit:contain" /></body></html>`); win.document.close(); }
    } else if (dataUrl.startsWith('data:application/pdf') || dataUrl.startsWith('data:application/octet')) {
      const win = window.open('', '_blank');
      if (win) { win.document.write(`<html><head><title>${name}</title></head><body style="margin:0"><iframe src="${dataUrl}" style="width:100%;height:100vh;border:none"></iframe></body></html>`); win.document.close(); }
    } else {
      window.open(dataUrl, '_blank');
    }
  };
  return (
    <div className="stack">
      {files.map((file, index) => (
        <button
          type="button"
          key={`${file.name || 'file'}-${index}`}
          onClick={() => openFile(file.dataUrl || file, file.name || `Attachment ${index + 1}`)}
          className="surface-note"
          style={{ textDecoration: 'none', color: '#4338ca', cursor: 'pointer', textAlign: 'left', border: 'none', background: 'inherit', font: 'inherit', padding: 'inherit' }}
        >
          {(file.dataUrl || '').startsWith('data:image/') ? (
            <img src={file.dataUrl} alt={file.name} style={{ width: '100%', maxHeight: 200, objectFit: 'contain', borderRadius: 10, marginBottom: 6 }} />
          ) : null}
          Open {file.name || `Attachment ${index + 1}`}
        </button>
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
  const [loading, setLoading] = useState(true);
  const [msg, setMsg] = useState('');
  const [createForm, setCreateForm] = useState(EMPTY_CREATE);
  const [search, setSearch] = useState(() => {
    if (typeof window === 'undefined') return '';
    try { return localStorage.getItem(ISSUE_SEARCH_KEY) || ''; } catch { return ''; }
  });
  const [status, setStatus] = useState(() => {
    if (typeof window === 'undefined') return '';
    try { return localStorage.getItem(ISSUE_STATUS_KEY) || ''; } catch { return ''; }
  });
  const [type, setType] = useState(() => {
    if (typeof window === 'undefined') return '';
    try { return localStorage.getItem(ISSUE_TYPE_KEY) || ''; } catch { return ''; }
  });
  const [claimsLane, setClaimsLane] = useState('ALL');
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
    setLoading(true);
    try {
      const payload = await api(`/api/issue-center/dashboard${scopedQuery}`, {}, token);
      setDashboard(payload);
      if (edit.id) {
        const refreshed = (payload?.incidents || []).find((incident) => incident.id === edit.id);
        if (refreshed) {
          setEdit((current) => ({
            ...current,
            status: refreshed.status,
            priority: refreshed.priority || 'MEDIUM',
            severity: refreshed.severity || 'LOW',
            ownerUserId: refreshed.ownerUser?.id || '',
            dueAt: refreshed.dueAt ? String(refreshed.dueAt).slice(0, 16) : '',
            resolutionCode: refreshed.resolutionCode || '',
            liabilityDecision: refreshed.liabilityDecision || 'PENDING',
            chargeDecision: refreshed.chargeDecision || 'PENDING',
            recoveryStage: refreshed.recoveryStage || 'INTAKE',
            waiveReason: refreshed.waiveReason || '',
            customerChargeReady: !!refreshed.customerChargeReady,
            title: refreshed.title,
            description: refreshed.description || '',
            amountResolved: refreshed.amountResolved ? String(refreshed.amountResolved) : '',
            history: refreshed.history || [],
            communications: refreshed.communications || [],
            operationalContext: refreshed.operationalContext || null,
            evidenceChecklist: refreshed.evidenceChecklist || null,
            evidenceCapture: refreshed.evidenceCapture || null,
            evidenceRequestDrafts: refreshed.evidenceRequestDrafts || null,
            recoveryActions: refreshed.recoveryActions || null,
            inspectionCompare: refreshed.inspectionCompare || null,
            nextBestAction: refreshed.nextBestAction || null
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
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, [scopedQuery, token]);
  useEffect(() => {
    try {
      if (search) localStorage.setItem(ISSUE_SEARCH_KEY, search);
      else localStorage.removeItem(ISSUE_SEARCH_KEY);
    } catch {}
  }, [search]);
  useEffect(() => {
    try {
      if (status) localStorage.setItem(ISSUE_STATUS_KEY, status);
      else localStorage.removeItem(ISSUE_STATUS_KEY);
    } catch {}
  }, [status]);
  useEffect(() => {
    try {
      if (type) localStorage.setItem(ISSUE_TYPE_KEY, type);
      else localStorage.removeItem(ISSUE_TYPE_KEY);
    } catch {}
  }, [type]);
  useEffect(() => {
    try {
      if (edit.id) localStorage.setItem(ISSUE_EDIT_ID_KEY, edit.id);
      else localStorage.removeItem(ISSUE_EDIT_ID_KEY);
    } catch {}
  }, [edit.id]);
  useEffect(() => {
    try {
      if (submissionEdit.id) localStorage.setItem(ISSUE_SUBMISSION_ID_KEY, submissionEdit.id);
      else localStorage.removeItem(ISSUE_SUBMISSION_ID_KEY);
    } catch {}
  }, [submissionEdit.id]);

  async function saveIncident(event) {
    event.preventDefault();
    if (!edit.id) return;
    try {
      await api(`/api/issue-center/incidents/${edit.id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          status: edit.status,
          priority: edit.priority,
          severity: edit.severity,
          ownerUserId: edit.ownerUserId || null,
          dueAt: edit.dueAt || null,
          resolutionCode: edit.resolutionCode || null,
          liabilityDecision: edit.liabilityDecision,
          chargeDecision: edit.chargeDecision,
          recoveryStage: edit.recoveryStage,
          waiveReason: edit.waiveReason || null,
          customerChargeReady: !!edit.customerChargeReady,
          title: edit.title,
          description: edit.description,
          amountResolved: edit.amountResolved === '' ? null : Number(edit.amountResolved),
          note: edit.note
        })
      }, token);
      setMsg('Issue updated');
      setEdit(EMPTY_EDIT);
      try { localStorage.removeItem(ISSUE_EDIT_ID_KEY); } catch {}
      await load();
    } catch (error) {
      setMsg(error.message);
    }
  }

  async function createIncident(event) {
    event.preventDefault();
    try {
      const payload = await api('/api/issue-center/incidents', {
        method: 'POST',
        body: JSON.stringify({
          subjectType: createForm.subjectType,
          reference: createForm.reference,
          type: createForm.type,
          priority: createForm.priority,
          severity: createForm.severity,
          ownerUserId: createForm.ownerUserId || null,
          dueAt: createForm.dueAt || null,
          liabilityDecision: createForm.liabilityDecision,
          chargeDecision: createForm.chargeDecision,
          recoveryStage: createForm.recoveryStage,
          waiveReason: createForm.waiveReason || null,
          customerChargeReady: !!createForm.customerChargeReady,
          title: createForm.title,
          description: createForm.description,
          amountClaimed: createForm.amountClaimed === '' ? null : Number(createForm.amountClaimed)
        })
      }, token);
      setMsg('Issue created');
      setCreateForm(EMPTY_CREATE);
      setEdit(incidentToEdit(payload));
      await load();
    } catch (error) {
      setMsg(error.message);
    }
  }

  async function requestInfo(recipientType, action = null) {
    if (!edit.id) return;
    try {
      const payload = await api(`/api/issue-center/incidents/${edit.id}/request-info`, {
        method: 'POST',
        body: JSON.stringify({
          recipientType,
          note: String(action?.note || edit.requestNote || '').trim() || null,
          requestKey: action?.key || null,
          quickActionLabel: action?.label || null
        })
      }, token);
      setMsg(`${payload.quickActionLabel || 'Request'} sent to ${payload.recipientType.toLowerCase()}`);
      setEdit((current) => ({ ...current, requestNote: '' }));
      await load();
    } catch (error) {
      setMsg(error.message);
    }
  }

  function applySuggestedRequestNote(recipientType) {
    const key = String(recipientType || '').toUpperCase() === 'HOST' ? 'hostNote' : 'guestNote';
    setEdit((current) => ({
      ...current,
      requestNote: current?.evidenceRequestDrafts?.[key] || current.requestNote || ''
    }));
  }

  function applyQuickEvidenceRequest(action) {
    if (!action) return;
    setEdit((current) => ({
      ...current,
      requestNote: action.note || current.requestNote || ''
    }));
  }

  async function sendQuickEvidenceRequest(action) {
    if (!action) return;
    await requestInfo(action.recipientType || 'GUEST', action);
  }

  async function runRecoveryAction(action) {
    if (!action) return;
    if (action.kind === 'workflow' && action.action) {
      await runWorkflowAction(action.action);
      return;
    }
    if (action.kind === 'service' && action.service === 'CREATE_CHARGE_DRAFT') {
      try {
        const out = await api(`/api/issue-center/incidents/${edit.id}/charge-draft`, {
          method: 'POST',
          body: JSON.stringify({})
        }, token);
        setMsg(`Charge draft created: ${formatMoney(out?.amount || 0)}`);
        await load();
      } catch (error) {
        setMsg(error.message);
      }
      return;
    }
    if (action.kind === 'service' && action.service === 'CHARGE_CARD_ON_FILE') {
      try {
        const out = await api(`/api/issue-center/incidents/${edit.id}/charge-card-on-file`, {
          method: 'POST',
          body: JSON.stringify({})
        }, token);
        setMsg(`Card on file charged: ${formatMoney(out?.amount || 0)}`);
        await load();
      } catch (error) {
        setMsg(error.message);
      }
      return;
    }
    if (action.kind === 'link' && action.href) {
      window.open(action.href, '_blank');
    }
  }

  async function runWorkflowAction(action, extra = {}) {
    if (!edit.id) return;
    try {
      await api(`/api/issue-center/incidents/${edit.id}/actions`, {
        method: 'POST',
        body: JSON.stringify({
          action,
          ...extra
        })
      }, token);
      setMsg('Workflow action applied');
      await load();
    } catch (error) {
      setMsg(error.message);
    }
  }

  async function downloadClaimsPacket() {
    if (!edit.id) return;
    try {
      const res = await fetch(`${API_BASE}/api/issue-center/incidents/${encodeURIComponent(edit.id)}/packet.txt`, {
        headers: {
          Authorization: `Bearer ${token}`
        }
      });
      if (!res.ok) {
        let message = `Claims packet failed (${res.status})`;
        try {
          const text = await res.text();
          if (text) {
            try {
              const payload = JSON.parse(text);
              if (payload?.error) message = payload.error;
              else message = `${message}: ${text.slice(0, 200)}`;
            } catch {
              message = `${message}: ${text.slice(0, 200)}`;
            }
          }
        } catch {}
        throw new Error(message);
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `claims-packet-${edit.id}.txt`;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
      setMsg('Claims packet downloaded');
    } catch (error) {
      setMsg(error.message);
    }
  }

  async function printClaimsPacket() {
    if (!edit.id) return;
    const printWindow = window.open('', '_blank');
    if (!printWindow) {
      setMsg('Pop-up blocked. Please allow pop-ups to print the claims packet.');
      return;
    }
    printWindow.opener = null;
    printWindow.document.write('<html><body style="font-family:Inter, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif;padding:32px;text-align:center;background:#0b0a12;color:#fff;">Preparing claims packet...</body></html>');
    printWindow.document.close();
    try {
      const res = await fetch(`${API_BASE}/api/issue-center/incidents/${encodeURIComponent(edit.id)}/packet-print`, {
        headers: {
          Authorization: `Bearer ${token}`
        },
        cache: 'no-store'
      });
      if (!res.ok) {
        let message = `Claims packet print failed (${res.status})`;
        try {
          const text = await res.text();
          if (text) {
            try {
              const payload = JSON.parse(text);
              if (payload?.error) message = payload.error;
              else message = `${message}: ${text.slice(0, 200)}`;
            } catch {
              message = `${message}: ${text.slice(0, 200)}`;
            }
          }
        } catch {}
        throw new Error(message);
      }
      const html = await res.text();
      printWindow.document.open();
      printWindow.document.write(html);
      printWindow.document.close();
      printWindow.focus();
      printWindow.print();
      setMsg('Claims packet opened for printing');
    } catch (error) {
      printWindow.document.open();
      printWindow.document.write(`<p style="font-family: sans-serif; padding: 24px;">${error.message || 'Unable to print claims packet'}</p>`);
      printWindow.document.close();
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
      try { localStorage.removeItem(ISSUE_SUBMISSION_ID_KEY); } catch {}
      await load();
    } catch (error) {
      setMsg(error.message);
    }
  }

  const metrics = dashboard?.metrics || { open: 0, underReview: 0, resolved: 0, closed: 0, total: 0 };
  const incidents = dashboard?.incidents || [];
  const vehicleSubmissions = dashboard?.vehicleSubmissions || [];
  const teamMembers = dashboard?.teamMembers || [];
  const awaitingIncidentReplies = incidents.filter((incident) => incidentAwaitingReply(incident)).length;
  const awaitingVehicleReplies = vehicleSubmissions.filter((submission) =>
    (submission.communications || []).some((entry) => entry.publicTokenExpiresAt && !entry.respondedAt)
  ).length;
  const disputedTrips = incidents.filter((incident) => String(incident?.trip?.status || '').toUpperCase() === 'DISPUTED').length;
  const unassignedIncidents = useMemo(() => incidents.filter((incident) => incidentIsActive(incident) && !incident?.ownerUser?.id), [incidents]);
  const urgentIncidents = useMemo(() => incidents.filter((incident) => incidentIsActive(incident) && String(incident?.priority || '').toUpperCase() === 'URGENT'), [incidents]);
  const dueSoonIncidents = useMemo(() => incidents.filter((incident) => incidentDueSoon(incident)), [incidents]);
  const awaitingReplyIncidents = useMemo(() => incidents.filter((incident) => incidentAwaitingReply(incident)), [incidents]);
  const readyToCloseIncidents = useMemo(() => incidents.filter((incident) => incidentReadyToClose(incident)), [incidents]);
  const visibleIncidents = useMemo(() => {
    if (claimsLane === 'UNASSIGNED') return unassignedIncidents;
    if (claimsLane === 'URGENT') return urgentIncidents;
    if (claimsLane === 'DUE_SOON') return dueSoonIncidents;
    if (claimsLane === 'AWAITING_REPLY') return awaitingReplyIncidents;
    if (claimsLane === 'READY_TO_CLOSE') return readyToCloseIncidents;
    return incidents;
  }, [awaitingReplyIncidents, claimsLane, dueSoonIncidents, incidents, readyToCloseIncidents, unassignedIncidents, urgentIncidents]);
  const selectedSubmission = submissionEdit.id ? vehicleSubmissions.find((row) => row.id === submissionEdit.id) : null;
  const selectedSubmissionChecklist = selectedSubmission ? submissionChecklist(selectedSubmission) : null;
  const selectedSubmissionReply = selectedSubmission ? submissionReplyState(selectedSubmission) : null;
  const submissionPhotos = selectedSubmission?.photos || [];
  const submissionDocuments = [
    selectedSubmission?.insuranceDocumentUrl ? { name: 'Insurance Document', dataUrl: selectedSubmission.insuranceDocumentUrl } : null,
    selectedSubmission?.registrationDocumentUrl ? { name: 'Registration Document', dataUrl: selectedSubmission.registrationDocumentUrl } : null,
    selectedSubmission?.initialInspectionDocumentUrl ? { name: 'Initial Inspection', dataUrl: selectedSubmission.initialInspectionDocumentUrl } : null
  ].filter(Boolean);
  useEffect(() => {
    try {
      const storedIncidentId = localStorage.getItem(ISSUE_EDIT_ID_KEY) || '';
      if (storedIncidentId && !edit.id) {
        const incident = incidents.find((row) => row.id === storedIncidentId);
        if (incident) setEdit(incidentToEdit(incident));
      }
      const storedSubmissionId = localStorage.getItem(ISSUE_SUBMISSION_ID_KEY) || '';
      if (storedSubmissionId && !submissionEdit.id) {
        const submission = vehicleSubmissions.find((row) => row.id === storedSubmissionId);
        if (submission) setSubmissionEdit(submissionToEdit(submission));
      }
    } catch {}
  }, [edit.id, incidents, submissionEdit.id, vehicleSubmissions]);
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
        onClick: () => setEdit(incidentToEdit(awaitingIncident)),
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
        onClick: () => setEdit(incidentToEdit(openIncident)),
        tone: 'neutral'
      } : null,
      awaitingSubmission ? {
        key: `submission-reply-${awaitingSubmission.id}`,
        label: 'Host Approval Reply',
        title: [awaitingSubmission.year, awaitingSubmission.make, awaitingSubmission.model].filter(Boolean).join(' ') || 'Vehicle Approval',
        detail: 'Host replied to an approval request. Review docs and communications before approving.',
        cta: 'Review Vehicle',
        onClick: () => setSubmissionEdit(submissionToEdit(awaitingSubmission)),
        tone: 'warn'
      } : null,
      pendingSubmission ? {
        key: `submission-pending-${pendingSubmission.id}`,
        label: 'Pending Vehicle Approval',
        title: [pendingSubmission.year, pendingSubmission.make, pendingSubmission.model].filter(Boolean).join(' ') || 'Vehicle Submission',
        detail: 'A new host vehicle submission is still waiting on initial review.',
        cta: 'Review Vehicle',
        onClick: () => setSubmissionEdit(submissionToEdit(pendingSubmission)),
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
              <div className="metric-card"><span className="label">Urgent</span><strong>{metrics.urgent || 0}</strong></div>
              <div className="metric-card"><span className="label">Due Soon</span><strong>{metrics.dueSoon || 0}</strong></div>
              <div className="metric-card"><span className="label">Vehicle Approvals</span><strong>{metrics.vehicleApprovalsPending || 0}</strong></div>
            </div>
          </div>
        </div>
      </section>

      {loading ? (
        <div className="surface-note" style={{ marginBottom: 18, textAlign: 'center', color: '#6b7280' }}>Loading issue center…</div>
      ) : null}

      {!loading && msg ? (
        <div className="surface-note" style={{ color: /updated|saved|sent/i.test(msg) ? '#166534' : '#991b1b', marginBottom: 18 }}>
          {msg}
          <button onClick={() => setMsg('')} style={{ marginLeft: 12, background: 'none', border: 'none', cursor: 'pointer', color: 'inherit', fontWeight: 700 }}>✕</button>
        </div>
      ) : null}

      {dashboard ? (
      <>
      <section className="app-section-grid" style={{ marginBottom: 18 }}>
        <div className="app-banner">
          <div className="section-title">Customer Service Hub</div>
          <div className="app-banner-list">
            <span className="app-banner-pill">Open cases {metrics.open}</span>
            <span className="app-banner-pill">Under review {metrics.underReview}</span>
            <span className="app-banner-pill">Guest or host replies {awaitingIncidentReplies + awaitingVehicleReplies}</span>
            <span className="app-banner-pill">Vehicle approvals {metrics.vehicleApprovalsPending || 0}</span>
            <span className="app-banner-pill">Disputed trips {disputedTrips}</span>
            <span className="app-banner-pill">Urgent claims {metrics.urgent || 0}</span>
            <span className="app-banner-pill">Due soon {metrics.dueSoon || 0}</span>
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
              label="Urgent Claims"
              count={metrics.urgent || 0}
              note="Claims tagged urgent and still open or under review."
              tone={(metrics.urgent || 0) > 0 ? 'warn' : 'neutral'}
            />
            <ServiceLaneCard
              label="Due Soon"
              count={metrics.dueSoon || 0}
              note="Claims due in the next 48 hours that should be actively worked."
              tone={(metrics.dueSoon || 0) > 0 ? 'warn' : 'neutral'}
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

        <section className="glass card-lg section-card">
          <div className="row-between">
            <div>
              <div className="section-title">Claims Lanes</div>
              <p className="ui-muted">Work the queue by ownership, urgency, due date, reply dependency, or closeout readiness.</p>
            </div>
            <span className="status-chip neutral">{visibleIncidents.length} visible</span>
          </div>
          <div className="inline-actions" style={{ gap: 8, flexWrap: 'wrap' }}>
            <button type="button" className={claimsLane === 'ALL' ? '' : 'button-subtle'} onClick={() => setClaimsLane('ALL')}>All {incidents.length}</button>
            <button type="button" className={claimsLane === 'UNASSIGNED' ? '' : 'button-subtle'} onClick={() => setClaimsLane('UNASSIGNED')}>Unassigned {unassignedIncidents.length}</button>
            <button type="button" className={claimsLane === 'URGENT' ? '' : 'button-subtle'} onClick={() => setClaimsLane('URGENT')}>Urgent {urgentIncidents.length}</button>
            <button type="button" className={claimsLane === 'DUE_SOON' ? '' : 'button-subtle'} onClick={() => setClaimsLane('DUE_SOON')}>Due Soon {dueSoonIncidents.length}</button>
            <button type="button" className={claimsLane === 'AWAITING_REPLY' ? '' : 'button-subtle'} onClick={() => setClaimsLane('AWAITING_REPLY')}>Awaiting Reply {awaitingReplyIncidents.length}</button>
            <button type="button" className={claimsLane === 'READY_TO_CLOSE' ? '' : 'button-subtle'} onClick={() => setClaimsLane('READY_TO_CLOSE')}>Ready To Close {readyToCloseIncidents.length}</button>
          </div>
          <div className="surface-note">
            Suggested order: `Unassigned`, then `Urgent`, then `Due Soon`, then `Awaiting Reply`, then `Ready To Close`.
          </div>
        </section>
      </section>

      <section className="split-panel">
        <section className="glass card-lg section-card">
          <div className="row-between">
            <div>
              <div className="section-title">Open Queue</div>
              <p className="ui-muted">Search by trip code, reservation, guest, host, or incident title.</p>
            </div>
            <span className="status-chip neutral">{visibleIncidents.length} in lane</span>
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
          {visibleIncidents.length ? (
            <div className="stack">
              {visibleIncidents.map((incident) => (
                <div key={incident.id} className="surface-note" style={{ display: 'grid', gap: 10 }}>
                  {(() => {
                    const reservation = incident.reservation || incident.trip?.reservation || null;
                    const operationalContext = incident.operationalContext || null;
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
                          incident.priority,
                          incident.severity,
                          guestName,
                          incident.trip?.hostProfile?.displayName || ''
                        ].filter(Boolean).join(' - ')}
                      </div>
                      <div className="inline-actions" style={{ gap: 8, marginTop: 6, flexWrap: 'wrap' }}>
                        <span className={incident.priority === 'URGENT' ? 'status-chip warn' : incident.priority === 'HIGH' ? 'status-chip neutral' : 'status-chip neutral'}>{incident.priority || 'MEDIUM'}</span>
                        <span className={['HIGH', 'CRITICAL'].includes(String(incident.severity || '').toUpperCase()) ? 'status-chip warn' : 'status-chip neutral'}>{incident.severity || 'LOW'}</span>
                        <span className="status-chip neutral">Liability {incident.liabilityDecision || 'PENDING'}</span>
                        <span className="status-chip neutral">Recovery {incident.recoveryStage || 'INTAKE'}</span>
                        <span className={String(incident.chargeDecision || '').toUpperCase() === 'CHARGE_CUSTOMER' ? 'status-chip good' : 'status-chip neutral'}>{incident.chargeDecision || 'PENDING'}</span>
                        {incident.ownerUser?.fullName ? <span className="status-chip neutral">{incident.ownerUser.fullName}</span> : null}
                        {incident.dueAt ? <span className="status-chip neutral">Due {formatDateTime(incident.dueAt)}</span> : null}
                        {incident.customerChargeReady ? <span className="status-chip good">Charge Ready</span> : null}
                        {operationalContext?.turnReady?.status ? <span className={['BLOCKED', 'ATTENTION'].includes(String(operationalContext.turnReady.status || '').toUpperCase()) ? 'status-chip warn' : 'status-chip neutral'}>Turn-Ready {operationalContext.turnReady.status}</span> : null}
                        {operationalContext?.inspection?.damageTriage?.severity && String(operationalContext.inspection.damageTriage.severity).toUpperCase() !== 'NONE' ? <span className={['HIGH', 'CRITICAL'].includes(String(operationalContext.inspection.damageTriage.severity || '').toUpperCase()) ? 'status-chip warn' : 'status-chip neutral'}>Damage {operationalContext.inspection.damageTriage.severity}</span> : null}
                        {operationalContext?.telematics?.status ? <span className={['OFFLINE', 'STALE', 'NO_SIGNAL'].includes(String(operationalContext.telematics.status || '').toUpperCase()) ? 'status-chip warn' : 'status-chip neutral'}>Telematics {operationalContext.telematics.status}</span> : null}
                        {Number(operationalContext?.swapCount || 0) > 0 ? <span className="status-chip neutral">{operationalContext.swapCount} swap{Number(operationalContext.swapCount) === 1 ? '' : 's'}</span> : null}
                      </div>
                      {String(incident.type || '').toUpperCase() === 'TOLL' ? (
                        <div style={{ marginTop: 6 }}>
                          <span className="status-chip warn">Toll Dispute</span>
                        </div>
                      ) : null}
                      {incident.nextBestAction?.label ? (
                        <div className="surface-note" style={{ marginTop: 10 }}>
                          <strong>Next:</strong> {incident.nextBestAction.label}
                          {incident.nextBestAction.detail ? <div style={{ marginTop: 6 }}>{incident.nextBestAction.detail}</div> : null}
                        </div>
                      ) : null}
                      {incident.evidenceChecklist ? (
                        <div className="surface-note" style={{ marginTop: 10 }}>
                          <strong>Evidence Checklist:</strong> {incident.evidenceChecklist.status} ({incident.evidenceChecklist.completionPct ?? 0}%)
                          {incident.evidenceChecklist.summary ? <div style={{ marginTop: 6 }}>{incident.evidenceChecklist.summary}</div> : null}
                        </div>
                      ) : null}
                      {incident.evidenceCapture ? (
                        <div className="surface-note" style={{ marginTop: 10 }}>
                          <strong>Evidence Capture:</strong> {incident.evidenceCapture.status} ({incident.evidenceCapture.completionPct ?? 0}%)
                          {incident.evidenceCapture.summary ? <div style={{ marginTop: 6 }}>{incident.evidenceCapture.summary}</div> : null}
                        </div>
                      ) : null}
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
                  {operationalContext ? (
                    <div className="surface-note">
                      {[operationalContext.turnReady?.summary, operationalContext.inspection?.damageTriage?.summary, operationalContext.telematics?.summary]
                        .filter(Boolean)
                        .slice(0, 2)
                        .join(' | ') || 'Connected operational context is attached to this claim.'}
                    </div>
                  ) : null}
                  <details>
                    <summary style={{ cursor: 'pointer', fontWeight: 600 }}>Issue History</summary>
                    <div style={{ marginTop: 10 }}>
                      <HistoryList rows={incident.history || []} />
                    </div>
                  </details>
                  <div className="inline-actions">
                    <button
                      type="button"
                      onClick={() => setEdit(incidentToEdit(incident))}
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
            <div className="surface-note">No issues match the current filters and lane selection.</div>
          )}
        </section>

        <section className="glass card-lg section-card">
          <div className="row-between">
            <div>
              <div className="section-title">Create / Handle Case</div>
              <p className="ui-muted">Open a new issue from a trip code or reservation number, then move it through review and resolution.</p>
            </div>
            {edit.id ? <button type="button" className="button-subtle" onClick={() => setEdit(EMPTY_EDIT)}>Clear</button> : null}
          </div>
          <form className="stack" onSubmit={createIncident} style={{ marginBottom: 18 }}>
            <div className="form-grid-2">
              <div className="stack">
                <div className="label">Issue Subject</div>
                <select value={createForm.subjectType} onChange={(e) => setCreateForm((current) => ({ ...current, subjectType: e.target.value }))}>
                  <option value="TRIP">Trip</option>
                  <option value="RESERVATION">Reservation</option>
                </select>
              </div>
              <div className="stack">
                <div className="label">{createForm.subjectType === 'TRIP' ? 'Trip Code' : 'Reservation Number'}</div>
                <input
                  value={createForm.reference}
                  onChange={(e) => setCreateForm((current) => ({ ...current, reference: e.target.value }))}
                  placeholder={createForm.subjectType === 'TRIP' ? 'Trip code' : 'Reservation number'}
                />
              </div>
            </div>
            <div className="form-grid-2">
              <div className="stack">
                <div className="label">Issue Type</div>
                <select value={createForm.type} onChange={(e) => setCreateForm((current) => ({ ...current, type: e.target.value }))}>
                  <option value="DAMAGE">DAMAGE</option>
                  <option value="TOLL">TOLL</option>
                  <option value="CLEANING">CLEANING</option>
                  <option value="LATE_RETURN">LATE_RETURN</option>
                  <option value="OTHER">OTHER</option>
                </select>
              </div>
              <div className="stack">
                <div className="label">Amount Claimed</div>
                <input
                  type="number"
                  min="0"
                  step="0.01"
                  value={createForm.amountClaimed}
                  onChange={(e) => setCreateForm((current) => ({ ...current, amountClaimed: e.target.value }))}
                  placeholder="Optional"
                />
              </div>
            </div>
            <div className="form-grid-2">
              <div className="stack">
                <div className="label">Priority</div>
                <select value={createForm.priority} onChange={(e) => setCreateForm((current) => ({ ...current, priority: e.target.value }))}>
                  <option value="LOW">LOW</option>
                  <option value="MEDIUM">MEDIUM</option>
                  <option value="HIGH">HIGH</option>
                  <option value="URGENT">URGENT</option>
                </select>
              </div>
              <div className="stack">
                <div className="label">Severity</div>
                <select value={createForm.severity} onChange={(e) => setCreateForm((current) => ({ ...current, severity: e.target.value }))}>
                  <option value="LOW">LOW</option>
                  <option value="MEDIUM">MEDIUM</option>
                  <option value="HIGH">HIGH</option>
                  <option value="CRITICAL">CRITICAL</option>
                </select>
              </div>
            </div>
            <div className="form-grid-2">
              <div className="stack">
                <div className="label">Owner</div>
                <select value={createForm.ownerUserId} onChange={(e) => setCreateForm((current) => ({ ...current, ownerUserId: e.target.value }))}>
                  <option value="">Unassigned</option>
                  {teamMembers.map((member) => (
                    <option key={member.id} value={member.id}>{member.fullName}</option>
                  ))}
                </select>
              </div>
              <div className="stack">
                <div className="label">Due At</div>
                <input type="datetime-local" value={createForm.dueAt} onChange={(e) => setCreateForm((current) => ({ ...current, dueAt: e.target.value }))} />
              </div>
            </div>
            <div className="form-grid-3">
              <div className="stack">
                <div className="label">Liability</div>
                <select value={createForm.liabilityDecision} onChange={(e) => setCreateForm((current) => ({ ...current, liabilityDecision: e.target.value }))}>
                  <option value="PENDING">PENDING</option>
                  <option value="CUSTOMER">CUSTOMER</option>
                  <option value="TENANT">TENANT</option>
                  <option value="HOST">HOST</option>
                  <option value="SHARED">SHARED</option>
                  <option value="WAIVED">WAIVED</option>
                </select>
              </div>
              <div className="stack">
                <div className="label">Charge Decision</div>
                <select value={createForm.chargeDecision} onChange={(e) => setCreateForm((current) => ({ ...current, chargeDecision: e.target.value }))}>
                  <option value="PENDING">PENDING</option>
                  <option value="CHARGE_CUSTOMER">CHARGE_CUSTOMER</option>
                  <option value="CHARGE_HOST">CHARGE_HOST</option>
                  <option value="CHARGE_TENANT">CHARGE_TENANT</option>
                  <option value="WAIVE">WAIVE</option>
                </select>
              </div>
              <div className="stack">
                <div className="label">Recovery Stage</div>
                <select value={createForm.recoveryStage} onChange={(e) => setCreateForm((current) => ({ ...current, recoveryStage: e.target.value }))}>
                  <option value="INTAKE">INTAKE</option>
                  <option value="EVIDENCE">EVIDENCE</option>
                  <option value="LIABILITY_REVIEW">LIABILITY_REVIEW</option>
                  <option value="READY_TO_CHARGE">READY_TO_CHARGE</option>
                  <option value="CHARGED">CHARGED</option>
                  <option value="WAIVED">WAIVED</option>
                  <option value="CLOSED">CLOSED</option>
                </select>
              </div>
            </div>
            <div className="form-grid-2">
              <div className="stack">
                <div className="label">Waive Reason</div>
                <input value={createForm.waiveReason} onChange={(e) => setCreateForm((current) => ({ ...current, waiveReason: e.target.value }))} placeholder="Optional waiver note" />
              </div>
              <label className="surface-note" style={{ display: 'flex', gap: 10, alignItems: 'center', alignSelf: 'end' }}>
                <input type="checkbox" checked={!!createForm.customerChargeReady} onChange={(e) => setCreateForm((current) => ({ ...current, customerChargeReady: e.target.checked }))} />
                <span>Customer charge ready</span>
              </label>
            </div>
            <div className="stack">
              <div className="label">Title</div>
              <input value={createForm.title} onChange={(e) => setCreateForm((current) => ({ ...current, title: e.target.value }))} placeholder="Short case title" />
            </div>
            <div className="stack">
              <div className="label">Description</div>
              <textarea rows={4} value={createForm.description} onChange={(e) => setCreateForm((current) => ({ ...current, description: e.target.value }))} placeholder="What happened and what support review is needed?" />
            </div>
            <div className="inline-actions">
              <button type="submit">Create Ticket</button>
            </div>
          </form>
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
              <div className="form-grid-2">
                <div className="stack">
                  <div className="label">Priority</div>
                  <select value={edit.priority} onChange={(e) => setEdit((current) => ({ ...current, priority: e.target.value }))}>
                    <option value="LOW">LOW</option>
                    <option value="MEDIUM">MEDIUM</option>
                    <option value="HIGH">HIGH</option>
                    <option value="URGENT">URGENT</option>
                  </select>
                </div>
                <div className="stack">
                  <div className="label">Severity</div>
                  <select value={edit.severity} onChange={(e) => setEdit((current) => ({ ...current, severity: e.target.value }))}>
                    <option value="LOW">LOW</option>
                    <option value="MEDIUM">MEDIUM</option>
                    <option value="HIGH">HIGH</option>
                    <option value="CRITICAL">CRITICAL</option>
                  </select>
                </div>
              </div>
              <div className="form-grid-2">
                <div className="stack">
                  <div className="label">Owner</div>
                  <select value={edit.ownerUserId} onChange={(e) => setEdit((current) => ({ ...current, ownerUserId: e.target.value }))}>
                    <option value="">Unassigned</option>
                    {teamMembers.map((member) => (
                      <option key={member.id} value={member.id}>{member.fullName}</option>
                    ))}
                  </select>
                </div>
                <div className="stack">
                  <div className="label">Due At</div>
                  <input type="datetime-local" value={edit.dueAt} onChange={(e) => setEdit((current) => ({ ...current, dueAt: e.target.value }))} />
                </div>
              </div>
              <div className="stack">
                <div className="label">Amount Resolved</div>
                <input type="number" min="0" step="0.01" value={edit.amountResolved} onChange={(e) => setEdit((current) => ({ ...current, amountResolved: e.target.value }))} />
              </div>
              <div className="stack">
                <div className="label">Resolution Code</div>
                <select value={edit.resolutionCode} onChange={(e) => setEdit((current) => ({ ...current, resolutionCode: e.target.value }))}>
                  <option value="">None</option>
                  <option value="CUSTOMER_CHARGED">CUSTOMER_CHARGED</option>
                  <option value="WAIVED">WAIVED</option>
                  <option value="INVALID_REPORT">INVALID_REPORT</option>
                  <option value="DUPLICATE">DUPLICATE</option>
                  <option value="GOODWILL">GOODWILL</option>
                  <option value="OTHER">OTHER</option>
                </select>
              </div>
              <div className="form-grid-3">
                <div className="stack">
                  <div className="label">Liability</div>
                  <select value={edit.liabilityDecision} onChange={(e) => setEdit((current) => ({ ...current, liabilityDecision: e.target.value }))}>
                    <option value="PENDING">PENDING</option>
                    <option value="CUSTOMER">CUSTOMER</option>
                    <option value="TENANT">TENANT</option>
                    <option value="HOST">HOST</option>
                    <option value="SHARED">SHARED</option>
                    <option value="WAIVED">WAIVED</option>
                  </select>
                </div>
                <div className="stack">
                  <div className="label">Charge Decision</div>
                  <select value={edit.chargeDecision} onChange={(e) => setEdit((current) => ({ ...current, chargeDecision: e.target.value }))}>
                    <option value="PENDING">PENDING</option>
                    <option value="CHARGE_CUSTOMER">CHARGE_CUSTOMER</option>
                    <option value="CHARGE_HOST">CHARGE_HOST</option>
                    <option value="CHARGE_TENANT">CHARGE_TENANT</option>
                    <option value="WAIVE">WAIVE</option>
                  </select>
                </div>
                <div className="stack">
                  <div className="label">Recovery Stage</div>
                  <select value={edit.recoveryStage} onChange={(e) => setEdit((current) => ({ ...current, recoveryStage: e.target.value }))}>
                    <option value="INTAKE">INTAKE</option>
                    <option value="EVIDENCE">EVIDENCE</option>
                    <option value="LIABILITY_REVIEW">LIABILITY_REVIEW</option>
                    <option value="READY_TO_CHARGE">READY_TO_CHARGE</option>
                    <option value="CHARGED">CHARGED</option>
                    <option value="WAIVED">WAIVED</option>
                    <option value="CLOSED">CLOSED</option>
                  </select>
                </div>
              </div>
              <div className="form-grid-2">
                <div className="stack">
                  <div className="label">Waive Reason</div>
                  <input value={edit.waiveReason} onChange={(e) => setEdit((current) => ({ ...current, waiveReason: e.target.value }))} placeholder="Optional waiver note" />
                </div>
                <label className="surface-note" style={{ display: 'flex', gap: 10, alignItems: 'center', alignSelf: 'end' }}>
                  <input type="checkbox" checked={!!edit.customerChargeReady} onChange={(e) => setEdit((current) => ({ ...current, customerChargeReady: e.target.checked }))} />
                  <span>Customer charge ready</span>
                </label>
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
                <button type="button" className="button-subtle" onClick={downloadClaimsPacket}>Download Claims Packet</button>
                <button type="button" className="button-subtle" onClick={printClaimsPacket}>Print / Save PDF</button>
              </div>
              {edit.nextBestAction ? (
                <div className="glass card section-card" style={{ padding: 14 }}>
                  <div className="row-between">
                    <div className="section-title" style={{ marginBottom: 0 }}>Next Best Action</div>
                    <span className={edit.nextBestAction.tone === 'good' ? 'status-chip good' : edit.nextBestAction.tone === 'warn' ? 'status-chip warn' : 'status-chip neutral'}>
                      {edit.nextBestAction.label}
                    </span>
                  </div>
                  <div className="surface-note" style={{ marginTop: 12 }}>{edit.nextBestAction.detail || 'Review this case and decide the next move.'}</div>
                  <div className="inline-actions" style={{ marginTop: 12 }}>
                    <button type="button" className="button-subtle" onClick={() => runWorkflowAction('SET_LIABILITY_CUSTOMER')}>Set Liability To Customer</button>
                    <button type="button" className="button-subtle" onClick={() => runWorkflowAction('MARK_READY_TO_CHARGE')}>Mark Ready To Charge</button>
                    <button type="button" className="button-subtle" onClick={() => runWorkflowAction('WAIVE_CLAIM', { waiveReason: edit.waiveReason || null })}>Waive Claim</button>
                    <button type="button" className="button-subtle" onClick={() => runWorkflowAction('CLOSE_CLAIM')}>Close Claim</button>
                  </div>
                </div>
              ) : null}
              {edit.evidenceChecklist ? (
                <div className="glass card section-card" style={{ padding: 14 }}>
                  <div className="row-between">
                    <div className="section-title" style={{ marginBottom: 0 }}>Evidence Checklist</div>
                    <span className={edit.evidenceChecklist.status === 'READY' ? 'status-chip good' : edit.evidenceChecklist.status === 'PARTIAL' ? 'status-chip warn' : 'status-chip neutral'}>
                      {edit.evidenceChecklist.status} {edit.evidenceChecklist.completionPct != null ? `(${edit.evidenceChecklist.completionPct}%)` : ''}
                    </span>
                  </div>
                  <div className="surface-note" style={{ marginTop: 12 }}>{edit.evidenceChecklist.summary || 'No checklist summary available.'}</div>
                  <div className="timeline-list" style={{ marginTop: 12 }}>
                    {(edit.evidenceChecklist.items || []).map((item) => (
                      <div key={item.key || item.label} className="surface-note" style={item.complete ? undefined : { background: '#fff7ed', borderColor: '#fed7aa', color: '#9a3412' }}>
                        <strong>{item.label}</strong>: {item.complete ? 'Complete' : 'Missing'}
                        <div style={{ marginTop: 6 }}>{item.detail || '-'}</div>
                      </div>
                    ))}
                  </div>
                </div>
              ) : null}
              {edit.evidenceCapture ? (
                <div className="glass card section-card" style={{ padding: 14 }}>
                  <div className="row-between">
                    <div className="section-title" style={{ marginBottom: 0 }}>Evidence Capture</div>
                    <span className={edit.evidenceCapture.status === 'READY' ? 'status-chip good' : edit.evidenceCapture.status === 'PARTIAL' ? 'status-chip warn' : 'status-chip neutral'}>
                      {edit.evidenceCapture.status} {edit.evidenceCapture.completionPct != null ? `(${edit.evidenceCapture.completionPct}%)` : ''}
                    </span>
                  </div>
                  <div className="surface-note" style={{ marginTop: 12 }}>{edit.evidenceCapture.summary || 'No evidence capture summary available.'}</div>
                  <div className="timeline-list" style={{ marginTop: 12 }}>
                    {(edit.evidenceCapture.slots || []).map((entry) => (
                      <div key={entry.key || entry.label} className="surface-note" style={entry.ready ? undefined : { background: '#fff7ed', borderColor: '#fed7aa', color: '#9a3412' }}>
                        <strong>{entry.label}</strong>: {entry.status || (entry.ready ? 'READY' : 'MISSING')}
                        <div style={{ marginTop: 6 }}>{entry.guidance || '-'}</div>
                        <div className="label" style={{ textTransform: 'none', letterSpacing: 0, fontSize: 12, marginTop: 6 }}>
                          Sources: {entry.sourceLabels?.length ? entry.sourceLabels.join(' - ') : 'None yet'}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              ) : null}
              {edit.recoveryActions?.length ? (
                <div className="glass card section-card" style={{ padding: 14 }}>
                  <div className="row-between">
                    <div className="section-title" style={{ marginBottom: 0 }}>Recovery Quick Actions</div>
                    <span className="status-chip neutral">{edit.recoveryActions.length} action{edit.recoveryActions.length === 1 ? '' : 's'}</span>
                  </div>
                  <div className="inline-actions" style={{ marginTop: 12 }}>
                    {edit.recoveryActions.map((action) => (
                      <button key={action.key} type="button" className="button-subtle" onClick={() => runRecoveryAction(action)}>
                        {action.label}
                      </button>
                    ))}
                  </div>
                </div>
              ) : null}
              {edit.inspectionCompare ? (
                <div className="glass card section-card" style={{ padding: 14 }}>
                  <div className="row-between">
                    <div className="section-title" style={{ marginBottom: 0 }}>Inspection Compare</div>
                    <span className={edit.inspectionCompare.status === 'COMPARE_READY' ? 'status-chip good' : 'status-chip neutral'}>
                      {edit.inspectionCompare.status || 'NO DATA'}
                    </span>
                  </div>
                  <div className="surface-note" style={{ marginTop: 12 }}>{edit.inspectionCompare.summary || 'No inspection compare summary attached.'}</div>
                  <div className="app-card-grid compact" style={{ marginTop: 12 }}>
                    <div className="info-tile">
                      <span className="label">Changed Fields</span>
                      <strong>{edit.inspectionCompare.changedCount ?? 0}</strong>
                      <span className="ui-muted">Checkout vs check-in differences detected.</span>
                    </div>
                    <div className="info-tile">
                      <span className="label">Photo Coverage</span>
                      <strong>{edit.inspectionCompare?.photoCoverage?.checkout ?? 0}/{edit.inspectionCompare?.photoCoverage?.checkin ?? 0}</strong>
                      <span className="ui-muted">Comparable photos: {edit.inspectionCompare?.photoCoverage?.common ?? 0}</span>
                    </div>
                  </div>
                  {edit.inspectionCompare?.previews?.length ? (
                    <div className="timeline-list" style={{ marginTop: 12 }}>
                      {edit.inspectionCompare.previews.map((preview) => (
                        <div key={preview.key} className="surface-note">
                          <div style={{ fontWeight: 700, marginBottom: 8 }}>{preview.label}</div>
                          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                            <div>
                              <div className="label" style={{ textTransform: 'none', letterSpacing: 0, fontSize: 12, marginBottom: 6 }}>Checkout</div>
                              {preview.checkoutSrc ? <img src={preview.checkoutSrc} alt={`${preview.label} checkout`} style={{ width: '100%', maxHeight: 160, objectFit: 'cover', borderRadius: 10, border: '1px solid #d7d2e4' }} /> : <div className="ui-muted">No checkout photo</div>}
                            </div>
                            <div>
                              <div className="label" style={{ textTransform: 'none', letterSpacing: 0, fontSize: 12, marginBottom: 6 }}>Check-In</div>
                              {preview.checkinSrc ? <img src={preview.checkinSrc} alt={`${preview.label} checkin`} style={{ width: '100%', maxHeight: 160, objectFit: 'cover', borderRadius: 10, border: '1px solid #d7d2e4' }} /> : <div className="ui-muted">No check-in photo</div>}
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : null}
                  {edit.inspectionCompare?.changes?.filter((entry) => entry.changed).length ? (
                    <div className="timeline-list" style={{ marginTop: 12 }}>
                      {edit.inspectionCompare.changes.filter((entry) => entry.changed).map((entry) => (
                        <div key={entry.key} className="surface-note" style={{ background: '#fff7ed', borderColor: '#fed7aa', color: '#9a3412' }}>
                          <strong>{entry.label}</strong>
                          <div style={{ marginTop: 6 }}>{entry.before}{' -> '}{entry.after}</div>
                        </div>
                      ))}
                    </div>
                  ) : null}
                  {edit.inspectionCompare?.links?.inspectionReportHref ? (
                    <div className="inline-actions" style={{ marginTop: 12 }}>
                      <button type="button" className="button-subtle" onClick={() => window.open(edit.inspectionCompare.links.inspectionReportHref, '_blank')}>Open Inspection Report</button>
                    </div>
                  ) : null}
                </div>
              ) : null}
              {edit.operationalContext ? (
                <div className="glass card section-card" style={{ padding: 14 }}>
                  <div className="row-between">
                    <div className="section-title" style={{ marginBottom: 0 }}>Connected Ops Context</div>
                    <span className={['BLOCKED', 'ATTENTION'].includes(String(edit.operationalContext?.turnReady?.status || '').toUpperCase()) ? 'status-chip warn' : 'status-chip neutral'}>
                      {edit.operationalContext?.turnReady?.status || 'NO DATA'}
                    </span>
                  </div>
                  <div className="app-card-grid compact" style={{ marginTop: 12 }}>
                    <div className="info-tile">
                      <span className="label">Vehicle</span>
                      <strong>{edit.operationalContext?.vehicle ? [edit.operationalContext.vehicle.internalNumber ? `Unit ${edit.operationalContext.vehicle.internalNumber}` : '', edit.operationalContext.vehicle.year, edit.operationalContext.vehicle.make, edit.operationalContext.vehicle.model].filter(Boolean).join(' ') : '-'}</strong>
                      <span className="ui-muted">{edit.operationalContext?.vehicle?.plate || 'No assigned plate on this case context.'}</span>
                    </div>
                    <div className="info-tile">
                      <span className="label">Turn-Ready</span>
                      <strong>{edit.operationalContext?.turnReady?.score ?? '-'}</strong>
                      <span className="ui-muted">{edit.operationalContext?.turnReady?.summary || 'No turn-ready summary yet.'}</span>
                    </div>
                    <div className="info-tile">
                      <span className="label">Damage Triage</span>
                      <strong>{edit.operationalContext?.inspection?.damageTriage?.severity || 'NONE'}</strong>
                      <span className="ui-muted">{edit.operationalContext?.inspection?.damageTriage?.recommendedAction || edit.operationalContext?.inspection?.summary || 'No damage triage signal attached.'}</span>
                    </div>
                    <div className="info-tile">
                      <span className="label">Telematics</span>
                      <strong>{edit.operationalContext?.telematics?.status || 'NO DATA'}</strong>
                      <span className="ui-muted">{edit.operationalContext?.telematics?.summary || 'No telematics summary attached.'}</span>
                    </div>
                  </div>
                  {edit.operationalContext?.attentionReasons?.length ? (
                    <div className="timeline-list" style={{ marginTop: 12 }}>
                      {edit.operationalContext.attentionReasons.map((reason) => (
                        <div key={reason} className="surface-note" style={{ background: '#fff7ed', borderColor: '#fed7aa', color: '#9a3412' }}>{reason}</div>
                      ))}
                    </div>
                  ) : null}
                  {edit.operationalContext?.telematics?.alerts?.length ? (
                    <div className="timeline-list" style={{ marginTop: 12 }}>
                      {edit.operationalContext.telematics.alerts.map((reason) => (
                        <div key={reason} className="surface-note">{reason}</div>
                      ))}
                    </div>
                  ) : null}
                </div>
              ) : null}
              <div className="glass card section-card" style={{ padding: 14 }}>
                <div className="section-title" style={{ marginBottom: 10 }}>Request More Information</div>
                <div className="stack">
                  {edit.evidenceRequestDrafts?.actions?.length ? (
                    <div className="stack">
                      <div className="label">Quick Evidence Requests</div>
                      <div className="inline-actions">
                        {edit.evidenceRequestDrafts.actions.map((action) => (
                          <span key={`${action.key}-${action.recipientType}`} style={{ display: 'inline-flex', gap: 8, flexWrap: 'wrap' }}>
                            <button type="button" className="button-subtle" onClick={() => applyQuickEvidenceRequest(action)}>
                              {action.label}
                            </button>
                            <button type="button" className="button-subtle" onClick={() => sendQuickEvidenceRequest(action)}>
                              Send Now
                            </button>
                          </span>
                        ))}
                      </div>
                    </div>
                  ) : null}
                  {edit.evidenceRequestDrafts ? (
                    <div className="inline-actions">
                      <button type="button" className="button-subtle" onClick={() => applySuggestedRequestNote('GUEST')}>Use Suggested Guest Note</button>
                      <button type="button" className="button-subtle" onClick={() => applySuggestedRequestNote('HOST')}>Use Suggested Host Note</button>
                    </div>
                  ) : null}
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
        <HostVehicleApprovalsQueue
          vehicleSubmissions={vehicleSubmissions}
          metrics={metrics}
          formatMoney={formatMoney}
          formatDateTime={formatDateTime}
          submissionToneClass={submissionToneClass}
          submissionChecklist={submissionChecklist}
          submissionReplyState={submissionReplyState}
          submissionToEdit={submissionToEdit}
          onSelectSubmission={setSubmissionEdit}
        />

        <HostVehicleApprovalWorkspace
          submissionEdit={submissionEdit}
          setSubmissionEdit={setSubmissionEdit}
          selectedSubmission={selectedSubmission}
          selectedSubmissionChecklist={selectedSubmissionChecklist}
          selectedSubmissionReply={selectedSubmissionReply}
          submissionPhotos={submissionPhotos}
          submissionDocuments={submissionDocuments}
          formatMoney={formatMoney}
          formatDateTime={formatDateTime}
          submissionToneClass={submissionToneClass}
          FileLinks={FileLinks}
          CommunicationList={CommunicationList}
          requestSubmissionInfo={requestSubmissionInfo}
          approveSubmission={approveSubmission}
          emptySubmissionEdit={EMPTY_SUBMISSION_EDIT}
        />
      </section>
      </>
      ) : null}
    </AppShell>
  );
}
