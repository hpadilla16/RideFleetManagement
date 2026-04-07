function uniqueByKey(items = [], key = 'key') {
  const seen = new Set();
  return items.filter((entry) => {
    const value = entry?.[key];
    if (!value || seen.has(value)) return false;
    seen.add(value);
    return true;
  });
}

export function buildIncidentRecoveryActions(incident) {
  const actions = [];
  const type = String(incident?.type || '').toUpperCase();
  const liabilityDecision = String(incident?.liabilityDecision || '').toUpperCase();
  const chargeDecision = String(incident?.chargeDecision || '').toUpperCase();
  const recoveryStage = String(incident?.recoveryStage || '').toUpperCase();
  const evidenceStatus = String(incident?.evidenceCapture?.status || incident?.evidenceChecklist?.status || '').toUpperCase();
  const reservationId = incident?.reservation?.id || incident?.trip?.reservation?.id || '';
  const vehicleId = incident?.operationalContext?.vehicle?.id || '';
  const damageSeverity = String(incident?.operationalContext?.inspection?.damageTriage?.severity || '').toUpperCase();

  if (liabilityDecision && liabilityDecision !== 'PENDING' && evidenceStatus === 'READY' && chargeDecision !== 'WAIVE') {
    actions.push({
      key: 'mark-ready-to-charge',
      kind: 'workflow',
      label: 'Mark Ready To Charge',
      action: 'MARK_READY_TO_CHARGE'
    });
    actions.push({
      key: 'create-charge-draft',
      kind: 'service',
      label: 'Create Charge Draft',
      service: 'CREATE_CHARGE_DRAFT'
    });
  }

  if (reservationId) {
    actions.push({
      key: 'open-reservation-payments',
      kind: 'link',
      label: 'Open Reservation Payments',
      href: `/reservations/${reservationId}/payments`
    });
    actions.push({
      key: 'open-reservation-workflow',
      kind: 'link',
      label: 'Open Reservation Workflow',
      href: `/reservations/${reservationId}`
    });
  }

  if (type === 'TOLL') {
    actions.push({
      key: 'open-toll-review',
      kind: 'link',
      label: 'Open Toll Review',
      href: '/tolls'
    });
  }

  if (reservationId && type === 'DAMAGE') {
    actions.push({
      key: 'open-inspection-report',
      kind: 'link',
      label: 'Open Inspection Report',
      href: `/reservations/${reservationId}/inspection-report`
    });
  }

  if (vehicleId) {
    actions.push({
      key: 'open-vehicle-profile',
      kind: 'link',
      label: 'Open Vehicle Profile',
      href: `/vehicles/${vehicleId}`
    });
  }

  if (type === 'DAMAGE' && ['HIGH', 'CRITICAL'].includes(damageSeverity)) {
    actions.push({
      key: 'review-vehicle-readiness',
      kind: 'link',
      label: 'Review Vehicle Readiness',
      href: vehicleId ? `/vehicles/${vehicleId}` : '/vehicles'
    });
  }

  if (recoveryStage === 'READY_TO_CHARGE' && reservationId) {
    actions.push({
      key: 'post-charge-context',
      kind: 'link',
      label: 'Review Charge Context',
      href: `/reservations/${reservationId}/payments`
    });
    actions.push({
      key: 'charge-card-on-file',
      kind: 'service',
      label: 'Charge Card On File',
      service: 'CHARGE_CARD_ON_FILE'
    });
  }

  return uniqueByKey(actions);
}
