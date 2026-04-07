'use client';

export function HostVehicleApprovalsQueue({
  vehicleSubmissions,
  metrics,
  formatMoney,
  formatDateTime,
  submissionToneClass,
  submissionChecklist,
  submissionReplyState,
  submissionToEdit,
  onSelectSubmission
}) {
  return (
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
          {vehicleSubmissions.map((submission) => {
            const checklist = submissionChecklist(submission);
            const replyState = submissionReplyState(submission);
            return (
              <div key={submission.id} className="surface-note" style={{ display: 'grid', gap: 10 }}>
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
                    onClick={() => onSelectSubmission(submissionToEdit(submission))}
                  >
                    Review Vehicle
                  </button>
                  {submission.listing?.id ? <span className="status-chip good">Active</span> : null}
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        <div className="surface-note">No host vehicle approvals match the current search.</div>
      )}
    </section>
  );
}
