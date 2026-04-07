'use client';

export function HostVehicleApprovalWorkspace({
  submissionEdit,
  setSubmissionEdit,
  selectedSubmission,
  selectedSubmissionChecklist,
  selectedSubmissionReply,
  submissionPhotos,
  submissionDocuments,
  formatMoney,
  formatDateTime,
  submissionToneClass,
  FileLinks,
  CommunicationList,
  requestSubmissionInfo,
  approveSubmission,
  emptySubmissionEdit
}) {
  return (
    <section className="glass card-lg section-card">
      <div className="row-between">
        <div>
          <div className="section-title">Vehicle Approval Review</div>
          <p className="ui-muted">Inspect photos, docs, host add-ons, and communications before approving the vehicle.</p>
        </div>
        {submissionEdit.id ? <button type="button" className="button-subtle" onClick={() => setSubmissionEdit(emptySubmissionEdit)}>Clear</button> : null}
      </div>
      {selectedSubmission ? (
        <div className="stack">
          <div className="row-between" style={{ gap: 12, alignItems: 'start' }}>
            <div>
              <div style={{ fontWeight: 700, fontSize: 20 }}>{[selectedSubmission.year, selectedSubmission.make, selectedSubmission.model].filter(Boolean).join(' ') || 'Vehicle Submission'}</div>
              <div className="label" style={{ textTransform: 'none', letterSpacing: 0, fontSize: 12 }}>
                {[selectedSubmission.hostProfile?.displayName || 'Host', selectedSubmission.hostProfile?.email || '', selectedSubmission.hostProfile?.phone || ''].filter(Boolean).join(' - ')}
              </div>
            </div>
            <span className={submissionToneClass(selectedSubmission.status)}>{selectedSubmission.status}</span>
          </div>
          <div className="info-grid-tight">
            <div className="info-tile"><span className="label">Vehicle Type</span><strong>{selectedSubmission.vehicleType?.name || '-'}</strong></div>
            <div className="info-tile"><span className="label">Location</span><strong>{selectedSubmission.preferredLocation?.name || '-'}</strong></div>
            <div className="info-tile"><span className="label">Mileage</span><strong>{selectedSubmission.mileage || 0}</strong></div>
            <div className="info-tile"><span className="label">Trip Days</span><strong>{`${selectedSubmission.minTripDays || 1} - ${selectedSubmission.maxTripDays || '-'}`}</strong></div>
            <div className="info-tile"><span className="label">Daily Rate</span><strong>{formatMoney(selectedSubmission.baseDailyRate)}</strong></div>
            <div className="info-tile"><span className="label">Security Deposit</span><strong>{formatMoney(selectedSubmission.securityDeposit)}</strong></div>
          </div>
          <div className="metric-grid">
            <div className="metric-card"><span className="label">Photos Ready</span><strong>{selectedSubmissionChecklist?.photoCount || 0}</strong></div>
            <div className="metric-card"><span className="label">Docs Ready</span><strong>{`${selectedSubmissionChecklist?.docCount || 0}/3`}</strong></div>
            <div className="metric-card"><span className="label">Host Add-Ons</span><strong>{selectedSubmissionChecklist?.addOnCount || 0}</strong></div>
            <div className="metric-card"><span className="label">Reply State</span><strong>{selectedSubmissionReply?.awaitingReply ? 'Waiting' : selectedSubmissionReply?.responded ? 'Replied' : 'No Request'}</strong></div>
          </div>
          <div className="inline-actions" style={{ gap: 8, flexWrap: 'wrap' }}>
            <span className={selectedSubmissionChecklist?.docsReady ? 'status-chip good' : 'status-chip warn'}>{selectedSubmissionChecklist?.docsReady ? 'Documents Ready' : 'Documents Missing'}</span>
            <span className={selectedSubmissionChecklist?.photoReady ? 'status-chip good' : 'status-chip warn'}>{selectedSubmissionChecklist?.photoReady ? 'Photos Ready' : 'Photos Missing'}</span>
            <span className={selectedSubmissionChecklist?.hasInspectionNotes ? 'status-chip good' : 'status-chip neutral'}>{selectedSubmissionChecklist?.hasInspectionNotes ? 'Inspection Notes Included' : 'Inspection Notes Missing'}</span>
            {selectedSubmissionReply?.awaitingReply ? <span className="status-chip warn">Waiting On Host Reply</span> : null}
            {!selectedSubmissionReply?.awaitingReply && selectedSubmissionReply?.responded ? <span className="status-chip good">Host Replied</span> : null}
          </div>
          <div className="split-panel" style={{ alignItems: 'start' }}>
            <div className="surface-note">
              <strong style={{ display: 'block', marginBottom: 6 }}>Host Contact</strong>
              {[selectedSubmission.hostProfile?.displayName || 'Host', selectedSubmission.hostProfile?.email || 'No email', selectedSubmission.hostProfile?.phone || 'No phone'].join(' · ')}
            </div>
            <div className="surface-note">
              <strong style={{ display: 'block', marginBottom: 6 }}>Review Guidance</strong>
              {selectedSubmissionReply?.awaitingReply
                ? `More info was requested on ${formatDateTime(selectedSubmissionReply.pending?.createdAt)}. Review the new reply or attachments before approving.`
                : 'Verify photos, ownership docs, inspection notes, and pricing before approving the vehicle.'}
            </div>
          </div>
          {selectedSubmission.shortDescription || selectedSubmission.description ? (
            <div className="surface-note" style={{ color: '#55456f', lineHeight: 1.6 }}>
              <strong style={{ display: 'block', color: '#1f1637', marginBottom: 6 }}>{selectedSubmission.shortDescription || 'Vehicle Summary'}</strong>
              {selectedSubmission.description || 'No extra description provided.'}
            </div>
          ) : null}
          <div>
            <div className="section-title" style={{ marginBottom: 10 }}>Vehicle Photos</div>
            {submissionPhotos.length ? (
              <div className="metric-grid">
                {submissionPhotos.map((photo, index) => (
                  <a key={`${selectedSubmission.id}-photo-${index}`} href={photo} target="_blank" rel="noreferrer" className="surface-note" style={{ textDecoration: 'none', display: 'grid', gap: 8 }}>
                    <img src={photo} alt={`Submission ${index + 1}`} style={{ width: '100%', aspectRatio: '16 / 10', objectFit: 'cover', borderRadius: 14 }} />
                    <span style={{ color: '#4338ca', fontWeight: 600 }}>Open Photo {index + 1}</span>
                  </a>
                ))}
              </div>
            ) : <div className="surface-note">No host photos uploaded.</div>}
          </div>
          <div>
            <div className="section-title" style={{ marginBottom: 10 }}>Documents</div>
            <FileLinks files={submissionDocuments} />
          </div>
          <div className="split-panel" style={{ alignItems: 'start' }}>
            <div className="stack">
              <div className="section-title">Host Add-Ons</div>
              {(selectedSubmission.addOns || []).length ? (
                <div className="stack">
                  {selectedSubmission.addOns.map((row, index) => (
                    <div key={`${selectedSubmission.id}-addon-${index}`} className="surface-note" style={{ display: 'grid', gap: 6 }}>
                      <strong>{row.name || `Service ${index + 1}`}</strong>
                      <div className="label" style={{ textTransform: 'none', letterSpacing: 0, fontSize: 12 }}>{formatMoney(row.price)}</div>
                      <div style={{ color: '#55456f', lineHeight: 1.5 }}>{row.description || 'No description.'}</div>
                    </div>
                  ))}
                </div>
              ) : <div className="surface-note">No host-specific add-ons submitted.</div>}
            </div>
            <div className="stack">
              <div className="section-title">Inspection Notes</div>
              <div className="surface-note" style={{ color: '#55456f', lineHeight: 1.6 }}>
                {selectedSubmission.initialInspectionNotes || 'No initial inspection notes were included.'}
              </div>
            </div>
          </div>
          <div className="stack">
            <div className="label">Review Notes</div>
            <textarea rows={4} value={submissionEdit.reviewNotes} onChange={(e) => setSubmissionEdit((current) => ({ ...current, reviewNotes: e.target.value }))} placeholder="Internal review notes or approval comments" />
          </div>
          <div className="glass card section-card" style={{ padding: 14 }}>
            <div className="section-title" style={{ marginBottom: 10 }}>Request More Information</div>
            <div className="stack">
              <div className="label">Representative Request Note</div>
              <textarea rows={4} value={submissionEdit.requestNote} onChange={(e) => setSubmissionEdit((current) => ({ ...current, requestNote: e.target.value }))} placeholder="Explain what documents, photos, or corrections the host needs to send back." />
              <div className="inline-actions">
                <button type="button" className="button-subtle" onClick={requestSubmissionInfo}>Email Host For Info</button>
                <button type="button" onClick={approveSubmission}>Approve Vehicle</button>
              </div>
            </div>
          </div>
          <div>
            <div className="section-title" style={{ marginBottom: 10 }}>Communications</div>
            <CommunicationList rows={submissionEdit.communications || []} />
          </div>
        </div>
      ) : (
        <div className="surface-note">Choose a host vehicle submission from the queue to review it here.</div>
      )}
    </section>
  );
}
