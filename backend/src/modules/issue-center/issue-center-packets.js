import { money, safeParse, sortHistoryEntriesDesc } from './issue-center-core.js';

function formatMoney(value) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(money(value));
}

function formatDateTime(value) {
  if (!value) return '-';
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return String(value);
  return parsed.toISOString();
}

function packetFilename(incident) {
  const ref = incident?.trip?.tripCode || incident?.reservation?.reservationNumber || incident?.id || 'claim';
  const safeRef = String(ref || 'claim').replace(/[^a-zA-Z0-9_-]+/g, '-');
  return `claims-packet-${safeRef}.txt`;
}

function addSection(lines, title, sectionLines = []) {
  lines.push('');
  lines.push(title);
  lines.push('='.repeat(title.length));
  if (!sectionLines.length) {
    lines.push('-');
    return;
  }
  lines.push(...sectionLines);
}

function addField(lines, label, value) {
  lines.push(`${label}: ${value == null || value === '' ? '-' : value}`);
}

function normalizeAttachment(entry = {}, index = 0) {
  const rawValue = entry?.dataUrl || entry?.url || entry?.href || '';
  const value = String(rawValue || '');
  const looksInline = value.startsWith('data:');
  return {
    name: entry?.name || `Attachment ${index + 1}`,
    mimeType: entry?.type || entry?.mimeType || '',
    size: entry?.size ?? null,
    value: looksInline ? '[inline attachment omitted from packet]' : value,
    inline: looksInline
  };
}

function pushValueLines(lines, prefix, value, depth = 0) {
  if (depth > 3) {
    lines.push(`${prefix}: [depth limit]`);
    return;
  }
  if (value == null || value === '') {
    lines.push(`${prefix}: -`);
    return;
  }
  if (Array.isArray(value)) {
    if (!value.length) {
      lines.push(`${prefix}: []`);
      return;
    }
    value.forEach((entry, index) => {
      if (typeof entry === 'object' && entry && !Array.isArray(entry)) {
        lines.push(`${prefix}[${index + 1}]:`);
        Object.entries(entry).forEach(([key, nested]) => {
          if (key === 'dataUrl') {
            lines.push(`  ${key}: [inline attachment omitted from packet]`);
            return;
          }
          pushValueLines(lines, `  ${key}`, nested, depth + 1);
        });
        return;
      }
      pushValueLines(lines, `${prefix}[${index + 1}]`, entry, depth + 1);
    });
    return;
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value);
    if (!entries.length) {
      lines.push(`${prefix}: {}`);
      return;
    }
    lines.push(`${prefix}:`);
    entries.forEach(([key, nested]) => {
      if (key === 'dataUrl') {
        lines.push(`  ${key}: [inline attachment omitted from packet]`);
        return;
      }
      pushValueLines(lines, `  ${key}`, nested, depth + 1);
    });
    return;
  }
  const rendered = String(value);
  lines.push(`${prefix}: ${rendered.length > 200 ? `${rendered.slice(0, 197)}...` : rendered}`);
}

function evidenceLines(incident) {
  const evidence = safeParse(incident?.evidenceJson) || {};
  const lines = [];
  if (!Object.keys(evidence).length) {
    lines.push('No structured evidence captured yet.');
    return lines;
  }
  pushValueLines(lines, 'Evidence', evidence);
  return lines;
}

function communicationLines(communications = []) {
  if (!communications.length) return ['No communications logged yet.'];
  const lines = [];
  communications.forEach((entry, index) => {
    lines.push(`${index + 1}. ${entry.subject || `${entry.direction} ${entry.channel}`}`);
    lines.push(`   Created: ${formatDateTime(entry.createdAt)}`);
    lines.push(`   Direction: ${entry.direction || '-'}`);
    lines.push(`   Channel: ${entry.channel || '-'}`);
    lines.push(`   Recipient Type: ${entry.recipientType || '-'}`);
    if (entry.publicTokenExpiresAt) lines.push(`   Public Reply Window: ${formatDateTime(entry.publicTokenExpiresAt)}`);
    if (entry.respondedAt) lines.push(`   Responded At: ${formatDateTime(entry.respondedAt)}`);
    lines.push(`   Message: ${String(entry.message || '').trim() || '-'}`);
    const attachments = Array.isArray(entry.attachments) ? entry.attachments.map(normalizeAttachment) : [];
    if (!attachments.length) {
      lines.push('   Attachments: -');
    } else {
      lines.push('   Attachments:');
      attachments.forEach((file) => {
        const parts = [file.name];
        if (file.mimeType) parts.push(file.mimeType);
        if (file.size != null && file.size !== '') parts.push(`${file.size} bytes`);
        if (file.value) parts.push(file.value);
        lines.push(`   - ${parts.join(' | ')}`);
      });
    }
    lines.push('');
  });
  return lines;
}

function historyLines(history = []) {
  const rows = sortHistoryEntriesDesc(history);
  if (!rows.length) return ['No incident history recorded yet.'];
  const lines = [];
  rows.forEach((entry, index) => {
    lines.push(`${index + 1}. ${entry.eventType || 'EVENT'} @ ${formatDateTime(entry.eventAt)}`);
    lines.push(`   Actor: ${entry.actorType || 'SYSTEM'} ${entry.actorRefId ? `(${entry.actorRefId})` : ''}`.trim());
    if (entry.notes) lines.push(`   Notes: ${entry.notes}`);
    const metadataEntries = entry.metadata && typeof entry.metadata === 'object' ? Object.entries(entry.metadata) : [];
    if (metadataEntries.length) {
      lines.push('   Metadata:');
      metadataEntries.forEach(([key, value]) => {
        if (value == null || value === '') return;
        lines.push(`   - ${key}: ${typeof value === 'object' ? JSON.stringify(value) : String(value)}`);
      });
    }
    lines.push('');
  });
  return lines;
}

function operationalContextLines(operationalContext = null) {
  if (!operationalContext) return ['No connected operational context is attached to this claim yet.'];
  const vehicle = operationalContext.vehicle || null;
  const turnReady = operationalContext.turnReady || null;
  const inspection = operationalContext.inspection || null;
  const telematics = operationalContext.telematics || null;
  const lines = [];
  lines.push(`Vehicle: ${vehicle ? [vehicle.internalNumber ? `Unit ${vehicle.internalNumber}` : '', vehicle.year, vehicle.make, vehicle.model, vehicle.plate ? `Plate ${vehicle.plate}` : ''].filter(Boolean).join(' | ') : '-'}`);
  lines.push(`Swap Count: ${operationalContext.swapCount ?? 0}`);
  lines.push(`Turn-Ready Status: ${turnReady?.status || '-'}`);
  lines.push(`Turn-Ready Score: ${turnReady?.score ?? '-'}`);
  lines.push(`Turn-Ready Summary: ${turnReady?.summary || '-'}`);
  lines.push(`Inspection Status: ${inspection?.status || '-'}`);
  lines.push(`Inspection Summary: ${inspection?.summary || '-'}`);
  lines.push(`Damage Severity: ${inspection?.damageTriage?.severity || 'NONE'}`);
  lines.push(`Damage Confidence: ${inspection?.damageTriage?.confidence || '-'}`);
  lines.push(`Damage Action: ${inspection?.damageTriage?.recommendedAction || '-'}`);
  lines.push(`Telematics Status: ${telematics?.status || '-'}`);
  lines.push(`Telematics Summary: ${telematics?.summary || '-'}`);
  lines.push(`Fuel Status: ${telematics?.fuelStatus || '-'}`);
  lines.push(`GPS Status: ${telematics?.gpsStatus || '-'}`);
  lines.push(`Odometer Status: ${telematics?.odometerStatus || '-'}`);
  if (Array.isArray(turnReady?.blockers) && turnReady.blockers.length) {
    lines.push(`Turn-Ready Blockers: ${turnReady.blockers.join(' | ')}`);
  }
  if (Array.isArray(telematics?.alerts) && telematics.alerts.length) {
    lines.push(`Telematics Alerts: ${telematics.alerts.join(' | ')}`);
  }
  return lines;
}

function evidenceChecklistLines(checklist = null) {
  if (!checklist) return ['No evidence checklist has been generated for this claim yet.'];
  const lines = [];
  lines.push(`Checklist Status: ${checklist.status || '-'}`);
  lines.push(`Completion: ${checklist.completionPct ?? 0}%`);
  lines.push(`Summary: ${checklist.summary || '-'}`);
  (Array.isArray(checklist.items) ? checklist.items : []).forEach((entry, index) => {
    lines.push(`${index + 1}. ${entry.label}: ${entry.complete ? 'COMPLETE' : 'MISSING'}`);
    lines.push(`   ${entry.detail || '-'}`);
  });
  return lines;
}

function evidenceCaptureLines(evidenceCapture = null) {
  if (!evidenceCapture) return ['No evidence capture summary has been generated for this claim yet.'];
  const lines = [];
  lines.push(`Capture Status: ${evidenceCapture.status || '-'}`);
  lines.push(`Completion: ${evidenceCapture.completionPct ?? 0}%`);
  lines.push(`Summary: ${evidenceCapture.summary || '-'}`);
  (Array.isArray(evidenceCapture.slots) ? evidenceCapture.slots : []).forEach((entry, index) => {
    lines.push(`${index + 1}. ${entry.label}: ${entry.status || (entry.ready ? 'READY' : 'MISSING')}`);
    lines.push(`   Guidance: ${entry.guidance || '-'}`);
    lines.push(`   Sources: ${Array.isArray(entry.sourceLabels) && entry.sourceLabels.length ? entry.sourceLabels.join(' | ') : '-'}`);
  });
  return lines;
}

function inspectionCompareLines(compare = null) {
  if (!compare) return ['No inspection compare summary is attached to this claim yet.'];
  const lines = [];
  lines.push(`Compare Status: ${compare.status || '-'}`);
  lines.push(`Summary: ${compare.summary || '-'}`);
  lines.push(`Changed Fields: ${compare.changedCount ?? 0}`);
  lines.push(`Photo Coverage: checkout ${compare?.photoCoverage?.checkout ?? 0}, check-in ${compare?.photoCoverage?.checkin ?? 0}, common ${compare?.photoCoverage?.common ?? 0}`);
  (Array.isArray(compare.changes) ? compare.changes : []).filter((entry) => entry.changed).forEach((entry, index) => {
    lines.push(`${index + 1}. ${entry.label}: ${entry.before} -> ${entry.after}`);
  });
  return lines;
}

export function buildIncidentClaimsPacket(incident) {
  const lines = [];
  const reservation = incident?.reservation || null;
  const trip = incident?.trip || null;
  const guest = incident?.guestCustomer || trip?.guestCustomer || null;
  const host = trip?.hostProfile || null;
  const listingVehicle = trip?.listing?.vehicle || null;

  lines.push('Ride Fleet Claims Packet');
  lines.push('========================');
  lines.push(`Generated At: ${formatDateTime(new Date())}`);
  lines.push(`Packet Filename: ${packetFilename(incident)}`);

  addSection(lines, 'Case Summary', []);
  addField(lines, 'Incident ID', incident?.id || '-');
  addField(lines, 'Title', incident?.title || '-');
  addField(lines, 'Type', incident?.type || '-');
  addField(lines, 'Status', incident?.status || '-');
  addField(lines, 'Priority', incident?.priority || '-');
  addField(lines, 'Severity', incident?.severity || '-');
  addField(lines, 'Owner', incident?.ownerUser?.fullName || incident?.ownerUser?.email || '-');
  addField(lines, 'Due At', formatDateTime(incident?.dueAt));
  addField(lines, 'Resolution Code', incident?.resolutionCode || '-');
  addField(lines, 'Liability Decision', incident?.liabilityDecision || '-');
  addField(lines, 'Charge Decision', incident?.chargeDecision || '-');
  addField(lines, 'Recovery Stage', incident?.recoveryStage || '-');
  addField(lines, 'Customer Charge Ready', incident?.customerChargeReady ? 'YES' : 'NO');
  addField(lines, 'Waive Reason', incident?.waiveReason || '-');
  addField(lines, 'Next Best Action', incident?.nextBestAction?.label || '-');
  addField(lines, 'Amount Claimed', formatMoney(incident?.amountClaimed));
  addField(lines, 'Amount Resolved', formatMoney(incident?.amountResolved));
  addField(lines, 'Created At', formatDateTime(incident?.createdAt));
  addField(lines, 'Resolved At', formatDateTime(incident?.resolvedAt));
  addField(lines, 'Description', String(incident?.description || '').trim() || '-');
  addField(lines, 'Next Action Detail', incident?.nextBestAction?.detail || '-');

  addSection(lines, 'Reservation And Trip Context', []);
  addField(lines, 'Subject Type', incident?.subjectType || '-');
  addField(lines, 'Reservation Number', reservation?.reservationNumber || '-');
  addField(lines, 'Reservation Status', reservation?.status || '-');
  addField(lines, 'Pickup At', formatDateTime(reservation?.pickupAt || trip?.scheduledPickupAt));
  addField(lines, 'Return At', formatDateTime(reservation?.returnAt || trip?.scheduledReturnAt));
  addField(lines, 'Pickup Location', reservation?.pickupLocation?.name || trip?.listing?.location?.name || '-');
  addField(lines, 'Return Location', reservation?.returnLocation?.name || '-');
  addField(lines, 'Trip Code', trip?.tripCode || '-');
  addField(lines, 'Trip Status', trip?.status || '-');
  addField(lines, 'Guest', guest ? [guest.firstName, guest.lastName].filter(Boolean).join(' ') || guest.email || '-' : '-');
  addField(lines, 'Guest Email', guest?.email || '-');
  addField(lines, 'Host', host?.displayName || '-');
  addField(lines, 'Vehicle', listingVehicle ? [listingVehicle.year, listingVehicle.make, listingVehicle.model].filter(Boolean).join(' ') : '-');

  addSection(lines, 'Operational Context', operationalContextLines(incident?.operationalContext || null));
  addSection(lines, 'Evidence Checklist', evidenceChecklistLines(incident?.evidenceChecklist || null));
  addSection(lines, 'Evidence Capture', evidenceCaptureLines(incident?.evidenceCapture || null));
  addSection(lines, 'Inspection Compare', inspectionCompareLines(incident?.inspectionCompare || null));
  addSection(lines, 'Evidence Summary', evidenceLines(incident));
  addSection(lines, 'Communications', communicationLines(incident?.communications || []));
  addSection(lines, 'Incident History', historyLines(incident?.history || []));

  return {
    filename: packetFilename(incident),
    contentType: 'text/plain; charset=utf-8',
    body: `${lines.join('\n').trim()}\n`
  };
}
