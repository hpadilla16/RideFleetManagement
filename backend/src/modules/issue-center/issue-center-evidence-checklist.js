import { safeParse } from './issue-center-core.js';

function attachmentCount(incident) {
  const evidence = safeParse(incident?.evidenceJson) || {};
  const evidenceAttachments = Array.isArray(evidence?.attachments) ? evidence.attachments.length : 0;
  const communicationAttachments = Array.isArray(incident?.communications)
    ? incident.communications.reduce((sum, entry) => sum + (Array.isArray(entry?.attachments) ? entry.attachments.length : 0), 0)
    : 0;
  return evidenceAttachments + communicationAttachments;
}

function item(key, label, complete, detail, required = true) {
  return { key, label, complete: !!complete, detail: detail || '-', required };
}

function summarize(items = []) {
  const required = items.filter((entry) => entry.required !== false);
  const completed = required.filter((entry) => entry.complete).length;
  const total = required.length;
  const completionPct = total ? Math.round((completed / total) * 100) : 100;
  const missing = required.filter((entry) => !entry.complete);
  return {
    items,
    completionPct,
    missingCount: missing.length,
    status: missing.length === 0 ? 'READY' : completed === 0 ? 'MISSING' : 'PARTIAL',
    summary: missing.length === 0
      ? 'Evidence checklist is complete for this claim type.'
      : missing.length === total
        ? 'Evidence checklist is still largely missing required items.'
        : `${missing.length} checklist item(s) still need evidence or review.`
  };
}

export function buildIncidentEvidenceChecklist(incident) {
  const type = String(incident?.type || '').toUpperCase();
  const evidence = safeParse(incident?.evidenceJson) || {};
  const operationalContext = incident?.operationalContext || null;
  const attachments = attachmentCount(incident);
  const inspection = operationalContext?.inspection || null;
  const telematics = operationalContext?.telematics || null;
  const photoCoverage = inspection?.photoCoverage || {};
  const swapCount = Number(operationalContext?.swapCount || 0);
  const liabilityResolved = String(incident?.liabilityDecision || '').toUpperCase() !== 'PENDING';

  if (type === 'DAMAGE') {
    return summarize([
      item('inspection', 'Inspection on file', !!inspection?.latestAt, inspection?.summary || 'Capture or review the latest inspection.'),
      item('photoEvidence', 'Photo evidence', attachments > 0 || Number(photoCoverage.captured || 0) > 0, attachments > 0 ? `${attachments} attachment(s) logged.` : `Inspection photos captured: ${photoCoverage.captured || 0}`),
      item('damageTriage', 'Damage triage', String(inspection?.damageTriage?.severity || '').toUpperCase() !== 'NONE', inspection?.damageTriage?.summary || 'No damage triage signal attached yet.'),
      item('liability', 'Liability decision', liabilityResolved, liabilityResolved ? `Liability set to ${incident.liabilityDecision}.` : 'Claim still needs a liability decision.')
    ]);
  }

  if (type === 'TOLL') {
    return summarize([
      item('transaction', 'Toll transaction linked', !!evidence?.tollTransactionId, evidence?.tollTransactionId || 'No toll transaction id linked in evidence.'),
      item('timestamp', 'Toll timestamp', !!evidence?.tollTransactionAt, evidence?.tollTransactionAt || 'No toll timestamp stored yet.'),
      item('location', 'Toll location', !!evidence?.tollLocation, evidence?.tollLocation || 'No toll location saved yet.'),
      item('swapReview', 'Swap review', swapCount === 0 || liabilityResolved || String(incident?.chargeDecision || '').toUpperCase() !== 'PENDING', swapCount > 0 ? `${swapCount} swap(s) tied to this case.` : 'No swaps affect this toll claim.')
    ]);
  }

  if (type === 'LATE_RETURN') {
    return summarize([
      item('returnWindow', 'Return window', !!incident?.reservation?.returnAt || !!incident?.trip?.scheduledReturnAt, incident?.reservation?.returnAt || incident?.trip?.scheduledReturnAt || 'No return window attached.'),
      item('telematics', 'Telematics signal', !!telematics?.status && !['NO_DEVICE', 'NO_SIGNAL'].includes(String(telematics.status).toUpperCase()), telematics?.summary || 'No usable telematics signal attached.'),
      item('outreach', 'Customer outreach', Array.isArray(incident?.communications) && incident.communications.length > 0, attachments > 0 ? `${incident.communications.length} communication(s) logged.` : 'No communication logged yet.'),
      item('liability', 'Liability decision', liabilityResolved, liabilityResolved ? `Liability set to ${incident.liabilityDecision}.` : 'Claim still needs a liability decision.')
    ]);
  }

  if (type === 'CLEANING') {
    return summarize([
      item('inspection', 'Inspection on file', !!inspection?.latestAt, inspection?.summary || 'Capture or review the latest inspection.'),
      item('supportingPhotos', 'Supporting photos', attachments > 0 || Number(photoCoverage.captured || 0) > 0, attachments > 0 ? `${attachments} attachment(s) logged.` : `Inspection photos captured: ${photoCoverage.captured || 0}`),
      item('claimedAmount', 'Claimed amount', Number(incident?.amountClaimed || 0) > 0, Number(incident?.amountClaimed || 0) > 0 ? `Claimed ${incident.amountClaimed}` : 'No claimed amount logged yet.'),
      item('liability', 'Liability decision', liabilityResolved, liabilityResolved ? `Liability set to ${incident.liabilityDecision}.` : 'Claim still needs a liability decision.')
    ]);
  }

  return summarize([
    item('description', 'Case description', !!String(incident?.description || '').trim(), String(incident?.description || '').trim() || 'No description logged yet.'),
    item('attachments', 'Supporting evidence', attachments > 0, attachments > 0 ? `${attachments} attachment(s) logged.` : 'No supporting attachments logged yet.'),
    item('owner', 'Case owner', !!incident?.ownerUser?.id, incident?.ownerUser?.fullName || 'Case is unassigned.'),
    item('liability', 'Liability decision', liabilityResolved, liabilityResolved ? `Liability set to ${incident.liabilityDecision}.` : 'Claim still needs a liability decision.')
  ]);
}
