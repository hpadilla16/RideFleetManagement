export function buildIssueRequestWorkflowUpdate(incident) {
  const status = String(incident?.status || '').toUpperCase();
  const recoveryStage = String(incident?.recoveryStage || '').toUpperCase();
  return {
    status: status === 'OPEN' ? 'UNDER_REVIEW' : status,
    recoveryStage: ['INTAKE', 'LIABILITY_REVIEW'].includes(recoveryStage) ? 'EVIDENCE' : recoveryStage || 'EVIDENCE'
  };
}
