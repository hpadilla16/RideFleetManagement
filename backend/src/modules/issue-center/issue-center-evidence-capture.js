import { safeParse } from './issue-center-core.js';

function unique(values = []) {
  return [...new Set(values.filter(Boolean))];
}

function attachmentSources(incident) {
  const sources = [];
  const evidence = safeParse(incident?.evidenceJson) || {};
  if (Array.isArray(evidence?.attachments) && evidence.attachments.length) sources.push('MANUAL');
  (incident?.communications || []).forEach((entry) => {
    if (!Array.isArray(entry?.attachments) || !entry.attachments.length) return;
    const recipientType = String(entry?.recipientType || '').toUpperCase();
    if (recipientType === 'GUEST') sources.push('CUSTOMER_REPLY');
    else if (recipientType === 'HOST') sources.push('HOST_REPLY');
    else sources.push('COMMUNICATION');
  });
  const source = String(evidence?.source || '').toUpperCase();
  if (source.includes('TOLL')) sources.push('TOLL_IMPORT');
  return unique(sources);
}

function inspectionSources(incident) {
  const inspection = incident?.operationalContext?.inspection || null;
  const photoCoverage = inspection?.photoCoverage || {};
  return inspection?.latestAt || inspection?.status || Number(photoCoverage.captured || 0) > 0 ? ['INSPECTION'] : [];
}

function telematicsSources(incident) {
  return incident?.operationalContext?.telematics?.status ? ['TELEMATICS'] : [];
}

function labelForSource(source) {
  const current = String(source || '').toUpperCase();
  if (current === 'CUSTOMER_REPLY') return 'Customer Reply';
  if (current === 'HOST_REPLY') return 'Host Reply';
  if (current === 'INSPECTION') return 'Inspection';
  if (current === 'TELEMATICS') return 'Telematics';
  if (current === 'TOLL_IMPORT') return 'Toll Import';
  if (current === 'COMMUNICATION') return 'Communication';
  return 'Manual';
}

function slot(key, label, ready, guidance, sources = [], required = true) {
  const normalizedSources = unique(sources);
  return {
    key,
    label,
    required,
    ready: !!ready,
    status: ready ? 'READY' : 'MISSING',
    guidance: guidance || '-',
    sources: normalizedSources,
    sourceLabels: normalizedSources.map(labelForSource)
  };
}

function summarizeSlots(slots = []) {
  const required = slots.filter((entry) => entry.required !== false);
  const readyCount = required.filter((entry) => entry.ready).length;
  const total = required.length;
  const missing = required.filter((entry) => !entry.ready);
  return {
    slots,
    readyCount,
    totalRequired: total,
    missingCount: missing.length,
    completionPct: total ? Math.round((readyCount / total) * 100) : 100,
    status: missing.length === 0 ? 'READY' : readyCount === 0 ? 'MISSING' : 'PARTIAL',
    summary: missing.length === 0
      ? 'Required evidence slots are covered for this claim.'
      : `${missing.length} required evidence slot(s) still need capture or verification.`
  };
}

export function buildIncidentEvidenceCapture(incident) {
  const type = String(incident?.type || '').toUpperCase();
  const evidence = safeParse(incident?.evidenceJson) || {};
  const operationalContext = incident?.operationalContext || null;
  const inspection = operationalContext?.inspection || null;
  const photoCoverage = inspection?.photoCoverage || {};
  const damageTriage = inspection?.damageTriage || null;
  const telematics = operationalContext?.telematics || null;
  const swapCount = Number(operationalContext?.swapCount || 0);
  const attachmentSourceList = attachmentSources(incident);
  const inspectionSourceList = inspectionSources(incident);
  const telematicsSourceList = telematicsSources(incident);
  const liabilityResolved = String(incident?.liabilityDecision || '').toUpperCase() !== 'PENDING';
  const chargeDecision = String(incident?.chargeDecision || '').toUpperCase();

  if (type === 'DAMAGE') {
    return summarizeSlots([
      slot('inspectionRecord', 'Inspection record', !!inspection?.latestAt, inspection?.summary || 'Capture or attach the latest inspection touching this damage event.', inspectionSourceList),
      slot('damagePhotos', 'Damage photos', Number(photoCoverage.captured || 0) > 0 || attachmentSourceList.length > 0, Number(photoCoverage.captured || 0) > 0 ? `Inspection photo coverage captured ${photoCoverage.captured}.` : 'Attach clear photos showing the affected area and condition.', unique([...inspectionSourceList, ...attachmentSourceList])),
      slot('damageAssessment', 'Damage assessment', String(damageTriage?.severity || '').toUpperCase() !== 'NONE', damageTriage?.recommendedAction || 'Run or review damage triage before finalizing liability.', inspectionSourceList),
      slot('liabilityDecision', 'Liability decision', liabilityResolved, liabilityResolved ? `Liability set to ${incident?.liabilityDecision}.` : 'Set liability before moving the claim to recovery.', ['MANUAL'])
    ]);
  }

  if (type === 'TOLL') {
    return summarizeSlots([
      slot('tollTransaction', 'Toll transaction', !!evidence?.tollTransactionId, evidence?.tollTransactionId ? `Transaction ${evidence.tollTransactionId} is linked.` : 'Link the toll transaction id into evidence.', ['TOLL_IMPORT', 'MANUAL']),
      slot('tollTimestamp', 'Toll timestamp and plaza', !!evidence?.tollTransactionAt && !!evidence?.tollLocation, evidence?.tollLocation ? `Location ${evidence.tollLocation}` : 'Store the toll timestamp and plaza/lane details.', ['TOLL_IMPORT', 'MANUAL']),
      slot('responsibilityWindow', 'Vehicle responsibility window', swapCount === 0 || !!evidence?.responsibilityWindowConfirmedAt || liabilityResolved || chargeDecision !== 'PENDING', swapCount > 0 ? `${swapCount} swap(s) affect this toll claim. Confirm the responsible vehicle window.` : 'No swap affects this toll claim.', ['TOLL_IMPORT', 'MANUAL']),
      slot('customerContext', 'Supporting context or reply', attachmentSourceList.length > 0 || (incident?.communications || []).length > 0, attachmentSourceList.length > 0 ? 'Supporting files or replies are attached.' : 'If the claim is disputed, capture the customer or host explanation.', unique([...attachmentSourceList, 'COMMUNICATION']), false)
    ]);
  }

  if (type === 'LATE_RETURN') {
    return summarizeSlots([
      slot('scheduledReturn', 'Scheduled return window', !!incident?.reservation?.returnAt || !!incident?.trip?.scheduledReturnAt, incident?.reservation?.returnAt || incident?.trip?.scheduledReturnAt || 'No expected return window is attached yet.', ['MANUAL']),
      slot('telematicsTrace', 'Telematics trace', !!telematics?.status && !['NO_DEVICE', 'NO_SIGNAL'].includes(String(telematics.status).toUpperCase()), telematics?.summary || 'Attach telematics location/movement context for the late return window.', telematicsSourceList),
      slot('customerOutreach', 'Customer outreach', (incident?.communications || []).length > 0, (incident?.communications || []).length ? `${incident.communications.length} communication(s) logged.` : 'Log outreach before final charge review.', ['COMMUNICATION']),
      slot('liabilityDecision', 'Liability decision', liabilityResolved, liabilityResolved ? `Liability set to ${incident?.liabilityDecision}.` : 'Set liability before posting a late-return charge.', ['MANUAL'])
    ]);
  }

  if (type === 'CLEANING') {
    return summarizeSlots([
      slot('inspectionRecord', 'Inspection record', !!inspection?.latestAt, inspection?.summary || 'Attach inspection context that shows cleaning condition.', inspectionSourceList),
      slot('supportingPhotos', 'Supporting photos', Number(photoCoverage.captured || 0) > 0 || attachmentSourceList.length > 0, attachmentSourceList.length > 0 ? 'Supporting photos or files are attached.' : 'Capture photos showing the condition that drove the cleaning claim.', unique([...inspectionSourceList, ...attachmentSourceList])),
      slot('claimAmount', 'Claim amount', Number(incident?.amountClaimed || 0) > 0, Number(incident?.amountClaimed || 0) > 0 ? `Claimed ${incident.amountClaimed}` : 'Add the cleaning claim amount before recovery.', ['MANUAL']),
      slot('liabilityDecision', 'Liability decision', liabilityResolved, liabilityResolved ? `Liability set to ${incident?.liabilityDecision}.` : 'Set liability before recovery.', ['MANUAL'])
    ]);
  }

  return summarizeSlots([
    slot('caseDescription', 'Case description', !!String(incident?.description || '').trim(), String(incident?.description || '').trim() || 'Add a clear case description.', ['MANUAL']),
    slot('supportingEvidence', 'Supporting evidence', attachmentSourceList.length > 0, attachmentSourceList.length > 0 ? 'Attachments or replies are logged for this claim.' : 'Attach files or collect a reply that supports this claim.', attachmentSourceList),
    slot('ownerAssigned', 'Assigned owner', !!incident?.ownerUser?.id, incident?.ownerUser?.fullName || 'Assign the case before it ages further.', ['MANUAL']),
    slot('liabilityDecision', 'Liability decision', liabilityResolved, liabilityResolved ? `Liability set to ${incident?.liabilityDecision}.` : 'Set liability before closing or charging the claim.', ['MANUAL'])
  ]);
}
