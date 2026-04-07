# Issue Center Hardening Backlog

Date: 2026-04-07
Branch: `feature/issue-center-hardening`

## Goal

Turn `Issue Center` from a combined support queue into a stronger `claims / disputes workspace` with clearer ownership, safer evidence handling, better workflow lanes, and cleaner separation from host vehicle approval review.

## Why This Matters

Current strengths:
- Public reply workflow already exists
- Trip and reservation incidents already connect to toll disputes
- Host vehicle approval review already lives in one place

Current gaps:
- Claims/disputes and vehicle approvals are mixed in one backend service and one frontend page
- Evidence is still stored inline as JSON/base64 attachments
- Incident model is too thin for serious claims operations
- No dedicated case ownership, SLA, severity, liability, or resolution reason
- Little automated test coverage

## Product Direction

We should evolve the module in this order:

1. Reliability and separation
2. Claims workspace depth
3. Inspection and telematics intelligence inside claims
4. Claims packet / dispute packet exports
5. AI-assisted triage and next-best action

## Competition Read

`Record360` is stronger in guided inspections, dispute-proof evidence capture, and claims-ready photo workflows.

`Rent Centric` is stronger in operational packaging around mobile check-in/out, damage control, GPS, and key-management-adjacent workflows.

`Renthub` is packaging dispute management, GPS tracking, and automatic key exchange more aggressively in sales language.

Our chance to beat them is not by copying a queue. It is by building a connected claims workspace that uses:
- planner context
- toll context
- inspection intelligence
- telematics signals
- self-service handoff history

## Architecture Direction

### Split By Domain

Keep these as separate domains even if they still share one route group at first:

- `Claims / Disputes`
  - trip issues
  - reservation issues
  - toll disputes
  - damage / cleaning / late return

- `Host Vehicle Approvals`
  - pending vehicle submissions
  - request more info
  - approval review

### Target Backend Files

- `backend/src/modules/issue-center/issue-center.routes.js`
- `backend/src/modules/issue-center/issue-center.service.js`
- `backend/src/modules/issue-center/issue-center-claims.service.js`
- `backend/src/modules/issue-center/issue-center-host-submissions.service.js`
- `backend/src/modules/issue-center/issue-center-serializers.js`
- `backend/src/modules/issue-center/issue-center-attachments.js`
- `backend/src/modules/issue-center/issue-center-history.service.js`

### Target Frontend Files

- `frontend/src/app/issues/page.js`
- `frontend/src/app/issues/IssueClaimsQueue.jsx`
- `frontend/src/app/issues/IssueClaimsWorkspace.jsx`
- `frontend/src/app/issues/IssueServiceLanes.jsx`
- `frontend/src/app/issues/HostVehicleApprovalsQueue.jsx`
- `frontend/src/app/issues/HostVehicleApprovalWorkspace.jsx`
- `frontend/src/app/issues/useIssueCenterData.js`
- `frontend/src/app/issues/useIssueCenterActions.js`

## Data Model Backlog

### Current Model To Extend

- `TripIncident`
- `TripIncidentCommunication`
- `HostVehicleSubmissionCommunication`

### Additions Recommended

Phase 2 schema additions:
- `ownerUserId`
- `priority`
- `severity`
- `liabilityDecision`
- `resolutionCode`
- `dueAt`
- `firstResponseAt`
- `closedReason`
- `evidenceChecklistJson`
- `sourceModule`

Later:
- dedicated `TripIncidentEvidence`
- dedicated `TripIncidentEvent`
- dedicated `TripIncidentTask`

## File-By-File Backlog

### 1. `backend/src/modules/issue-center/issue-center.service.js`

Tasks:
- reduce to orchestration layer
- move claims-specific logic to `issue-center-claims.service.js`
- move host-submission logic to `issue-center-host-submissions.service.js`
- stop mixing serialization, notification, persistence, and workflow rules in one file

### 2. `backend/src/modules/issue-center/issue-center.routes.js`

Tasks:
- add stronger request validation
- return structured workflow errors
- keep public guards on reply routes
- prepare route split between claims and host approvals

### 3. `backend/src/modules/issue-center/issue-center-attachments.js`

Tasks:
- validate attachment count
- validate allowed mime families
- validate data URL shape
- enforce max payload size
- normalize attachment metadata

### 4. `backend/src/modules/issue-center/issue-center-history.service.js`

Tasks:
- centralize history building
- sort merged history deterministically
- prepare migration path toward dedicated incident events

### 5. `backend/prisma/schema.prisma`

Tasks:
- phase 2 claim metadata fields
- later move away from string blobs for evidence

### 6. `frontend/src/app/issues/page.js`

Tasks:
- reduce to shell
- split claims queue/workspace from host vehicle approval queue/workspace
- keep service lanes and priority cards separate from case editor

### 7. `frontend/src/app/issue-response/page.js`

Tasks:
- preserve simple public flow
- add safer attachment validation feedback
- add clearer expired-link / invalid-link states

## Phase Plan

### Phase 1

Safe first hardening:
- split vehicle approvals UI out of main issue page
- add server-side attachment validation
- add issue-center tests for public response payloads and history ordering

### Phase 2

Claims workspace depth:
- case owner
- severity
- priority
- SLA / due date
- resolution code
- liability decision
- dedicated claims lanes

### Phase 3

Connected intelligence:
- inspection-intelligence-backed damage triage
- telematics-backed late return / route / movement context
- toll dispute packet
- claim packet export
- AI triage and next-best-action

## Definition Of Done For Phase 1

- `issues/page.js` is no longer carrying host approval render blocks inline
- public issue response rejects invalid attachments cleanly
- issue-center backend has focused tests
- no regressions in current issue/toll/approval flows

## Immediate Next Slice

1. extract host vehicle approval UI components
2. add attachment validation helper
3. add focused tests
