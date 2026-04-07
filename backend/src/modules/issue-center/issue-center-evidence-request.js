function recipientLabel(recipientType) {
  return String(recipientType || '').toUpperCase() === 'HOST' ? 'host' : 'customer';
}

function missingRequiredSlots(incident) {
  return (incident?.evidenceCapture?.slots || []).filter((entry) => entry?.required !== false && !entry?.ready);
}

const REQUESTABLE_SLOT_CONFIG = {
  damagePhotos: { actionLabel: 'Request Damage Photos', recipientType: 'GUEST' },
  supportingPhotos: { actionLabel: 'Request Supporting Photos', recipientType: 'GUEST' },
  tollTransaction: { actionLabel: 'Request Toll Confirmation', recipientType: 'GUEST' },
  tollTimestamp: { actionLabel: 'Request Toll Location Details', recipientType: 'GUEST' },
  responsibilityWindow: { actionLabel: 'Request Swap / Dispatch Context', recipientType: 'GUEST' },
  customerContext: { actionLabel: 'Request Customer Context', recipientType: 'GUEST' },
  scheduledReturn: { actionLabel: 'Request Return Timeline', recipientType: 'GUEST' },
  customerOutreach: { actionLabel: 'Request Late Return Explanation', recipientType: 'GUEST' },
  caseDescription: { actionLabel: 'Request Case Details', recipientType: 'GUEST' },
  supportingEvidence: { actionLabel: 'Request Supporting Evidence', recipientType: 'GUEST' }
};

export function buildIncidentEvidenceRequestNote(incident, recipientType = 'GUEST') {
  const audience = recipientLabel(recipientType);
  const slots = missingRequiredSlots(incident).slice(0, 3);
  if (!slots.length) {
    return `Please reply with any additional details or supporting documents that can help us complete review of this issue.`;
  }

  const lines = [
    `To keep this issue moving, please help us with the following ${audience}-side support items:`,
    ''
  ];
  slots.forEach((entry, index) => {
    lines.push(`${index + 1}. ${entry.label}: ${entry.guidance || 'Please provide the missing support for this item.'}`);
  });
  lines.push('');
  lines.push('You can reply directly through the issue link with notes, photos, documents, or any context that helps confirm what happened.');
  return lines.join('\n');
}

export function buildIncidentEvidenceRequestActions(incident) {
  const requestableSlots = missingRequiredSlots(incident)
    .map((entry) => {
      const config = REQUESTABLE_SLOT_CONFIG[entry?.key];
      if (!config) return null;
      const recipientType = config.recipientType || 'GUEST';
      return {
        key: entry.key,
        label: config.actionLabel,
        recipientType,
        note: buildIncidentEvidenceRequestNote({
          ...incident,
          evidenceCapture: {
            ...(incident?.evidenceCapture || {}),
            slots: [entry]
          }
        }, recipientType)
      };
    })
    .filter(Boolean);

  return requestableSlots.slice(0, 4);
}

export function buildIncidentEvidenceRequestDrafts(incident) {
  return {
    guestNote: buildIncidentEvidenceRequestNote(incident, 'GUEST'),
    hostNote: buildIncidentEvidenceRequestNote(incident, 'HOST'),
    actions: buildIncidentEvidenceRequestActions(incident)
  };
}
