const ACTIONS = [
  'SET_LIABILITY_CUSTOMER',
  'SET_LIABILITY_HOST',
  'SET_LIABILITY_TENANT',
  'MARK_READY_TO_CHARGE',
  'WAIVE_CLAIM',
  'CLOSE_CLAIM'
];

export function buildIncidentWorkflowActionUpdate(action, payload = {}) {
  const normalized = String(action || '').trim().toUpperCase();
  if (!ACTIONS.includes(normalized)) {
    throw new Error(`action must be one of ${ACTIONS.join(', ')}`);
  }

  const note = String(payload?.note || '').trim();
  const waiveReason = String(payload?.waiveReason || '').trim();

  if (normalized === 'SET_LIABILITY_CUSTOMER') {
    return {
      updates: {
        liabilityDecision: 'CUSTOMER',
        recoveryStage: 'LIABILITY_REVIEW'
      },
      note: note || 'Liability set to customer'
    };
  }
  if (normalized === 'SET_LIABILITY_HOST') {
    return {
      updates: {
        liabilityDecision: 'HOST',
        recoveryStage: 'LIABILITY_REVIEW'
      },
      note: note || 'Liability set to host'
    };
  }
  if (normalized === 'SET_LIABILITY_TENANT') {
    return {
      updates: {
        liabilityDecision: 'TENANT',
        recoveryStage: 'LIABILITY_REVIEW'
      },
      note: note || 'Liability set to tenant'
    };
  }
  if (normalized === 'MARK_READY_TO_CHARGE') {
    return {
      updates: {
        customerChargeReady: true,
        recoveryStage: 'READY_TO_CHARGE',
        chargeDecision: payload?.chargeDecision ? String(payload.chargeDecision).trim().toUpperCase() : 'CHARGE_CUSTOMER',
        resolutionCode: payload?.resolutionCode ? String(payload.resolutionCode).trim().toUpperCase() : 'CUSTOMER_CHARGED'
      },
      note: note || 'Claim marked ready to charge'
    };
  }
  if (normalized === 'WAIVE_CLAIM') {
    return {
      updates: {
        liabilityDecision: 'WAIVED',
        chargeDecision: 'WAIVE',
        recoveryStage: 'WAIVED',
        customerChargeReady: false,
        resolutionCode: payload?.resolutionCode ? String(payload.resolutionCode).trim().toUpperCase() : 'WAIVED',
        waiveReason: waiveReason || null
      },
      note: note || 'Claim waived'
    };
  }
  return {
    updates: {
      status: 'CLOSED',
      recoveryStage: 'CLOSED'
    },
    note: note || 'Claim closed from workflow action'
  };
}

export const INCIDENT_WORKFLOW_ACTIONS = ACTIONS;
