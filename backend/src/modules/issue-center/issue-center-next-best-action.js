function isActiveIncident(incident) {
  return ['OPEN', 'UNDER_REVIEW'].includes(String(incident?.status || '').toUpperCase());
}

function isAwaitingReply(incident) {
  return (incident?.communications || []).some((entry) => entry?.publicTokenExpiresAt && !entry?.respondedAt);
}

function isDueSoon(incident) {
  if (!incident?.dueAt || !isActiveIncident(incident)) return false;
  const dueAt = new Date(incident.dueAt).getTime();
  if (Number.isNaN(dueAt)) return false;
  return dueAt <= (Date.now() + 1000 * 60 * 60 * 24 * 2);
}

export function buildIncidentNextBestAction(incident) {
  const type = String(incident?.type || '').toUpperCase();
  const status = String(incident?.status || '').toUpperCase();
  const liabilityDecision = String(incident?.liabilityDecision || '').toUpperCase();
  const chargeDecision = String(incident?.chargeDecision || '').toUpperCase();
  const recoveryStage = String(incident?.recoveryStage || '').toUpperCase();
  const customerChargeReady = !!incident?.customerChargeReady;
  const operationalContext = incident?.operationalContext || null;
  const evidenceChecklist = incident?.evidenceChecklist || null;
  const evidenceCapture = incident?.evidenceCapture || null;
  const turnReadyStatus = String(operationalContext?.turnReady?.status || '').toUpperCase();
  const damageSeverity = String(operationalContext?.inspection?.damageTriage?.severity || '').toUpperCase();
  const telematicsStatus = String(operationalContext?.telematics?.status || '').toUpperCase();
  const fuelStatus = String(operationalContext?.telematics?.fuelStatus || '').toUpperCase();
  const unassigned = !incident?.ownerUser?.id && isActiveIncident(incident);
  const awaitingReply = isAwaitingReply(incident);
  const dueSoon = isDueSoon(incident);

  if (awaitingReply) {
    return {
      code: 'WAIT_FOR_PUBLIC_REPLY',
      label: 'Wait for public reply',
      tone: 'warn',
      detail: 'Customer service already requested more information. Review the reply before changing liability or charges.'
    };
  }

  if (evidenceChecklist?.status === 'MISSING' || (evidenceChecklist?.status === 'PARTIAL' && Number(evidenceChecklist?.missingCount || 0) >= 2)) {
    return {
      code: 'REQUEST_MORE_EVIDENCE',
      label: 'Request more evidence',
      tone: 'warn',
      detail: evidenceCapture?.summary || evidenceChecklist?.summary || 'This claim still needs more support before liability or billing can be finalized.'
    };
  }

  if (customerChargeReady || recoveryStage === 'READY_TO_CHARGE' || chargeDecision === 'CHARGE_CUSTOMER') {
    return {
      code: 'READY_TO_CHARGE_CUSTOMER',
      label: 'Ready to charge customer',
      tone: 'good',
      detail: 'Liability and recovery workflow indicate this claim is ready to post or collect from the customer.'
    };
  }

  if (chargeDecision === 'WAIVE' || liabilityDecision === 'WAIVED' || recoveryStage === 'WAIVED') {
    return {
      code: 'DOCUMENT_WAIVER',
      label: 'Document waiver and close',
      tone: 'neutral',
      detail: incident?.waiveReason ? `Waive reason: ${incident.waiveReason}` : 'This claim is marked for waiver. Confirm the rationale and close it cleanly.'
    };
  }

  if (liabilityDecision === 'PENDING' && isActiveIncident(incident)) {
    return {
      code: 'DECIDE_LIABILITY',
      label: 'Decide liability',
      tone: 'warn',
      detail: 'This claim still needs a liability decision before recovery and billing can move forward.'
    };
  }

  if (type === 'DAMAGE' && ['HIGH', 'CRITICAL'].includes(damageSeverity)) {
    return {
      code: 'HOLD_AND_REVIEW_DAMAGE',
      label: 'Hold vehicle and review damage',
      tone: 'warn',
      detail: operationalContext?.inspection?.damageTriage?.recommendedAction || 'Damage triage suggests this unit should be reviewed before another dispatch.'
    };
  }

  if (['BLOCKED', 'ATTENTION'].includes(turnReadyStatus) && isActiveIncident(incident)) {
    return {
      code: 'CLEAR_TURN_READY_ISSUES',
      label: 'Clear turn-ready blockers',
      tone: 'warn',
      detail: operationalContext?.turnReady?.summary || 'This claim is tied to a vehicle that still needs operational readiness review.'
    };
  }

  if (['OFFLINE', 'STALE', 'NO_SIGNAL'].includes(telematicsStatus) && type === 'LATE_RETURN') {
    return {
      code: 'VERIFY_LATE_RETURN_WITH_TELEMATICS',
      label: 'Verify late return with telematics',
      tone: 'warn',
      detail: operationalContext?.telematics?.summary || 'Late return review should confirm the latest telematics signal before charging or waiving.'
    };
  }

  if (type === 'TOLL' && Number(operationalContext?.swapCount || 0) > 0) {
    return {
      code: 'REVIEW_TOLL_SWAP_WINDOW',
      label: 'Review tolls against swap window',
      tone: 'neutral',
      detail: 'This toll dispute has vehicle swap history. Confirm the toll belongs to the right vehicle responsibility window before charging.'
    };
  }

  if (fuelStatus === 'CRITICAL' && isActiveIncident(incident)) {
    return {
      code: 'REFUEL_BEFORE_RELEASE',
      label: 'Refuel before release',
      tone: 'warn',
      detail: 'Telematics shows critically low fuel. Resolve fueling before closing the claim if the unit is going back into service.'
    };
  }

  if (unassigned) {
    return {
      code: 'ASSIGN_CASE_OWNER',
      label: 'Assign case owner',
      tone: 'neutral',
      detail: 'This claim is still unassigned. Set an owner before the case ages further.'
    };
  }

  if (dueSoon) {
    return {
      code: 'WORK_DUE_SOON_CLAIM',
      label: 'Work due-soon claim',
      tone: 'warn',
      detail: 'This claim is approaching its due date and should be pushed toward a decision, charge, or closeout.'
    };
  }

  if (status === 'RESOLVED') {
    return {
      code: 'CLOSE_CASE',
      label: 'Close case',
      tone: 'good',
      detail: 'Resolution is logged and no public reply is pending. Review notes and close the claim when ready.'
    };
  }

  if (type === 'TOLL') {
    return {
      code: 'REVIEW_TOLL_EVIDENCE',
      label: 'Review toll evidence',
      tone: 'neutral',
      detail: 'Confirm the toll timing, lane, and contract responsibility before posting or waiving the dispute.'
    };
  }

  return {
    code: 'REVIEW_AND_DECIDE',
    label: 'Review and decide',
    tone: 'neutral',
    detail: 'Review evidence, communications, and claim workflow details, then decide whether to request more info, charge, waive, or close.'
  };
}
